/**
 * 本地语音识别（ASR）服务 —— 主进程侧。
 *
 * 设计要点（都是踩过的坑，别随手改）：
 *
 *  1. **模型不进安装包**。SenseVoice small int8 是 226MB，塞进 NSIS 会让安装包翻倍，
 *     而绝大多数用户不开语音输入。改成「用户开关打开后在设置页里显式下载」，落到
 *     `app.getPath('userData')/models/sense-voice/`。首次下载是一次性成本，之后完全离线。
 *
 *  2. **不引入 ffmpeg / 不做编解码**。渲染层用 WebAudio 以 16kHz 直接取 Float32 单声道，
 *     经 IPC 传过来就是模型要的格式。任何采样率/声道转换都在 `transcribe` 里兜底重采样，
 *     但正常路径不该走到那里。
 *
 *  3. **sherpa-onnx-node 是 CJS + NAPI 原生模块**，本项目是 ESM，所以用 createRequire 惰性加载。
 *     惰性有两个好处：没开语音的用户永远不付 47MB dll 的映射成本；加载失败也只在这一条路径上
 *     报错，不会把主进程起不来。
 *
 *  4. **下载走 .part 原子改名**。226MB 传到一半断网/关窗口，留下半个文件会被误判成「已就绪」，
 *     之后每次识别都崩。所以只在完整校验通过后才 rename 成正式文件名。
 */

import { app } from 'electron';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, createWriteStream } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** 模型来源。主站优先，国内镜像兜底（实测镜像对 tokens.txt 可用，对 226MB 的 onnx 时有不稳）。 */
const MODEL_HOSTS = ['https://huggingface.co', 'https://hf-mirror.com'];
const MODEL_REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09';

/** 必需文件 + 期望最小体积（用于识别「下了一半的残file」）。 */
const MODEL_FILES = [
  { name: 'model.int8.onnx', minBytes: 200 * 1024 * 1024 },
  { name: 'tokens.txt', minBytes: 100 * 1024 },
] as const;

/** 模型总大小，仅供参考/展示。 */
export const MODEL_TOTAL_BYTES = 226 * 1024 * 1024 + 316 * 1024;

export interface VoiceModelStatus {
  /** 两个文件都在且体积达标。 */
  ready: boolean;
  /** 目录里已有文件的累计字节数（下载中断后可用于续传展示）。 */
  bytes: number;
  /** 模型目录的绝对路径，设置页展示给用户看「装在哪」。 */
  dir: string;
}

export interface VoiceDownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  /** 0–100 的整数，给 UI 直接用。 */
  percent: number;
  /** 当前正在下哪个文件（文件名），便于「model.int8.onnx 35%」这种文案。 */
  file: string;
}

export function voiceModelDir(): string {
  return path.join(app.getPath('userData'), 'models', 'sense-voice');
}

function requiredFilePath(name: string): string {
  return path.join(voiceModelDir(), name);
}

/** 逐个文件校验：存在 + 体积达标（体积是最便宜的一致性检查，不需要读 226MB 算 hash）。 */
export function voiceModelStatus(): VoiceModelStatus {
  const dir = voiceModelDir();
  let bytes = 0;
  try {
    for (const entry of readdirSync(dir)) {
      try { bytes += statSync(path.join(dir, entry)).size; } catch { /* 竞态删除，忽略 */ }
    }
  } catch { /* 目录不存在 */ }
  const ready = MODEL_FILES.every(({ name, minBytes }) => {
    try { return statSync(requiredFilePath(name)).size >= minBytes; } catch { return false; }
  });
  return { ready, bytes, dir };
}

/** 删除模型（含下载残留）。返回删除后状态。 */
export function removeVoiceModel(): VoiceModelStatus {
  rmSync(voiceModelDir(), { recursive: true, force: true });
  return voiceModelStatus();
}

// ── 下载 ──────────────────────────────────────────────────────────

interface DownloadAbort {
  cancelled: boolean;
}

let activeDownload: DownloadAbort | null = null;

export function isDownloading(): boolean {
  return activeDownload !== null;
}

export function cancelVoiceDownload(): void {
  if (activeDownload) activeDownload.cancelled = true;
}

/**
 * 单次 HTTPS GET，手动跟随重定向（Node 的 https 不会自动跟随，而 HF 的 resolve 链接
 * 必然 302 到 CDN，不跟随就只会下到一个空响应）。
 *
 * ⚠ `location` 可能是**相对路径**：hf-mirror.com 会回
 * `Location: /api/resolve-cache/models/.../tokens.txt?...`，直接把它塞给 httpsRequest
 * 会抛 ERR_INVALID_URL。必须用 `new URL(location, 当前 url)` 补全（实测踩过）。
 */
function resolveDownload(url: string, hostIndex: number, redirects = 0): Promise<{ url: string; hostIndex: number }> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('too many redirects'));
      return;
    }
    const req = httpsRequest(url, { method: 'GET', headers: { range: 'bytes=0-0' } }, (res) => {
      res.resume();
      const location = res.headers.location;
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && location) {
        // 镜像 302 到主站 CDN 时，hostIndex 保持不变（CDN 已经是快路径）
        const next = new URL(location, url).href;
        resolve(resolveDownload(next, hostIndex, redirects + 1));
        return;
      }
      if (code !== 200 && code !== 206) {
        reject(new Error(`HTTP ${code}`));
        return;
      }
      resolve({ url, hostIndex });
    });
    req.on('error', reject);
    req.end();
  });
}

async function downloadFile(
  name: string,
  onProgress: (progress: VoiceDownloadProgress) => void,
  abort: DownloadAbort,
): Promise<void> {
  const target = requiredFilePath(name);
  const partPath = `${target}.part`;
  const encodedRepo = MODEL_REPO;
  let lastError: unknown = null;

  for (let hostIndex = 0; hostIndex < MODEL_HOSTS.length; hostIndex += 1) {
    if (abort.cancelled) throw new Error('cancelled');
    const sourceUrl = `${MODEL_HOSTS[hostIndex]}/${encodedRepo}/resolve/main/${name}`;
    try {
      const resolved = await resolveDownload(sourceUrl, hostIndex);
      await new Promise<void>((resolve, reject) => {
        const req = httpsRequest(resolved.url, { method: 'GET' }, (res) => {
          const code = res.statusCode ?? 0;
          if (code !== 200) {
            res.resume();
            reject(new Error(`HTTP ${code}`));
            return;
          }
          const totalBytes = Number(res.headers['content-length'] ?? 0);
          let receivedBytes = 0;
          res.on('data', (chunk: Buffer) => {
            receivedBytes += chunk.length;
            if (abort.cancelled) return;
            onProgress({
              receivedBytes,
              totalBytes: totalBytes || 0,
              percent: totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0,
              file: name,
            });
          });
          pipeline(res, createWriteStream(partPath))
            .then(() => {
              if (abort.cancelled) {
                reject(new Error('cancelled'));
                return;
              }
              resolve();
            })
            .catch(reject);
        });
        req.on('error', reject);
        req.end();
      });
      // 体积复核：CDN 偶尔回 200 但给的是错误页（几百字节的 HTML）
      const expected = MODEL_FILES.find((file) => file.name === name)?.minBytes ?? 1;
      if (statSync(partPath).size < expected) throw new Error(`incomplete download (${statSync(partPath).size} bytes)`);
      renameSync(partPath, target);
      return;
    } catch (error) {
      lastError = error;
      if (abort.cancelled) throw new Error('cancelled');
      try { unlinkSync(partPath); } catch { /* 不存在就算了 */ }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('download failed');
}

/**
 * 下载模型。可重复调用——已就绪的会跳过。
 * 返回值只在「全部完成」时为 ready；被取消时抛出的 Error message 是 'cancelled'。
 */
export async function downloadVoiceModel(
  onProgress: (progress: VoiceDownloadProgress) => void,
): Promise<VoiceModelStatus> {
  if (activeDownload) throw new Error('already downloading');
  const abort: DownloadAbort = { cancelled: false };
  activeDownload = abort;
  try {
    mkdirSync(voiceModelDir(), { recursive: true });
    for (const { name } of MODEL_FILES) {
      if (existsSync(requiredFilePath(name)) && voiceModelStatus().ready) break;
      await downloadFile(name, onProgress, abort);
    }
    return voiceModelStatus();
  } finally {
    activeDownload = null;
  }
}

// ── 推理 ──────────────────────────────────────────────────────────

interface RecognizerLike {
  createStream: () => { acceptWaveform: (wave: { sampleRate: number; samples: Float32Array }) => void };
  decode: (stream: unknown) => void;
  getResult: (stream: unknown) => { text?: string };
}

let recognizer: RecognizerLike | null = null;

/** SenseVoice 输出带语言/情绪/事件标签，例如 `<|zh|><|NEUTRAL|><|Speech|><|woitn|>你好`。 */
const TAG_RE = /<\|[^|]*\|>/g;

function stripTags(raw: string): string {
  return raw.replace(TAG_RE, '').trim();
}

function ensureRecognizer(): RecognizerLike {
  if (recognizer) return recognizer;
  const status = voiceModelStatus();
  if (!status.ready) throw new Error('model not ready');
  const sherpa = require('sherpa-onnx-node') as { OfflineRecognizer: new (config: unknown) => RecognizerLike };
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      // useInverseTextNormalization=1 把「二零二五年」折成「2025 年」，编码场景更需要这种。
      senseVoice: { model: requiredFilePath('model.int8.onnx'), useInverseTextNormalization: 1 },
      tokens: requiredFilePath('tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  });
  return recognizer;
}

/** 预热：用户开面板时提前建 recognizer，避免第一句话多等 1–2s。 */
export function warmUpRecognizer(): boolean {
  try { ensureRecognizer(); return true; } catch { return false; }
}

/** 释放原生 recognizer（关模型/改配置后调用，下次用到再惰性重建）。 */
export function disposeRecognizer(): void {
  recognizer = null;
}

/**
 * 线性插值重采样。WebAudio 通常能直接给 16kHz，但部分设备/浏览器会忽略 sampleRate 选项，
 * 这时必须兜底，否则识别结果是一堆乱码而不是明显报错——比崩了更难查。
 */
function resampleTo16k(samples: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 16000) return samples;
  const ratio = 16000 / fromRate;
  const length = Math.max(1, Math.floor(samples.length * ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = (samples[i0] ?? 0) * (1 - frac) + (samples[i1] ?? 0) * frac;
  }
  return out;
}

/** 同步解码。调用方（main.ts 的 IPC handler）负责把它丢到微任务外，避免卡 UI。 */
export function transcribe(samples: Float32Array, sampleRate: number): string {
  const engine = ensureRecognizer();
  const prepared = resampleTo16k(samples, sampleRate);
  const stream = engine.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples: prepared });
  engine.decode(stream);
  const result = engine.getResult(stream);
  return stripTags(result.text ?? '');
}