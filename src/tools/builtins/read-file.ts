import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { contentHash } from '../../changeset/index.js';
import { entriesAnchoredTo } from '../../memory/store.js';
import { evaluateAnchorsAgainst, toAnchorPath } from '../../memory/anchor.js';
import { IMAGE_READ_MARKER, MAX_FILE_LINES, MAX_HISTORY_RESULT } from '../constants.js';
import {
  MAX_INLINE_BYTES_DEFAULT,
  isProbablyBinary,
  loadImageAttachmentWithDownscale,
  sniffImageMime,
  type ImageMime,
} from '../../attachments/image.js';
import type { Tool, ToolOutcome } from '../types.js';
import { config, isMemoryEnabled } from '../../config/index.js';

/** 默认单次 read_file 拉取的行数。刻意压低,逼 LLM 分块读大文件,
 * 配合 description 中的 PAGINATION IS MANDATORY 引导。
 * 300 行 ≈ 一个屏幕的源码量,够定位一段逻辑而不至于吃光上下文。 */
const DEFAULT_READ_LIMIT = 300;

/** 魔数嗅探只需文件头:16KB 足够覆盖 WebP(12 字节)/PNG(8)/GIF(6)/JPEG(SOF 位置不定)
 *  与二进制探测的 4KB 控制字符窗口。 */
const SNIFF_BYTES = 16 * 1024;

/** 再导出单一事实源(tools/constants.ts):ui/render.ts 与测试都按此判定图片分支摘要。 */
export { IMAGE_READ_MARKER };

/**
 * 单文件体积上限(32 MiB)。
 *
 * 行号分页的实现是「整文件载入内存再按行切片」,所以体积直接等于内存占用:一个 2GB 的
 * 数据 dump / 压缩包能把进程顶死,而模型其实只需要其中一段。上限取得足够高,只拦真正
 * 病态的输入;拦下时明确指路(grep 定位 + run_command 按段取),不给模型留猜谜空间。
 */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 结构化失败:status=error 让上层不当成「成功读取」;output 以 `错误:` 开头对齐既有约定
 *  (context/utils.isToolResultSuccess 靠该前缀判定,artifacts/relevance 据此排除失败结果)。 */
function failure(code: ToolOutcome['code'], message: string): ToolOutcome {
  return { status: 'error', code, retryable: false, output: `错误:${message}` };
}

// ---------- read_file ----------
export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a file: text with line numbers, images as visual model input.\n' +
    'Text — read before editing. For files >500 lines, grep first to locate, then read_file with offset+limit (e.g. offset=350, limit=120); never read a whole large file in one call. ' +
    'Images — PNG/JPEG/GIF/WebP detected by MAGIC BYTES (extension ignored), attached as visual input; detail=low|high controls resolution, oversized PNGs downscale automatically. ' +
    'Other binaries are REJECTED with an explanation — use run_command with a proper tool (`file`, `strings`, disassembler) if you need their content.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the working directory' },
      offset: { type: 'integer', description: 'Start line, 1-based (default 1). Text files only; ignored for images.' },
      limit: {
        type: 'integer',
        description:
          'Max lines to read (default 300, hard cap 2000). Size by OUTPUT, not lines: outputs are capped at ~32k chars per call, so a dense (CJK) file fits ~200-400 lines in one call while sparse code fits 1000+. If a range exceeds that, split it; the output tail always reports how many lines remain. Text only; ignored for images.',
      },
      detail: {
        type: 'string',
        enum: ['auto', 'low', 'high'],
        description: 'Vision detail level when the path is an image (default: auto). Ignored for text.',
      },
    },
    required: ['path'],
  },
  async execute(args, toolCtx): Promise<ToolOutcome> {
    const path = String(args.path);
    const offset = Number(args.offset ?? 1);
    // 无论 LLM 传多大,单次硬钳到 MAX_FILE_LINES,杜绝「绕过分页引导一把全拿」。
    const limit = Math.min(Number(args.limit ?? DEFAULT_READ_LIMIT), MAX_FILE_LINES);
    // enforceSandbox 已把 args.path 重写为牢内绝对路径(sandbox/policy.ts SANDBOX_PATH_TOOLS),
    // resolve 对绝对路径原样返回。
    const absolute = resolve(path);

    // ── 1. stat:目录 / 不存在 / 超大文件在这里分流,不把字节读进来再说 ────────
    let info;
    try {
      info = await stat(absolute);
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      if (e?.code === 'ENOENT') return failure('EXECUTION_ERROR', `文件不存在: ${path}`);
      return failure('EXECUTION_ERROR', `无法访问文件 ${path}: ${e?.message ?? String(error)}`);
    }
    if (info.isDirectory()) {
      return failure(
        'INVALID_ARGUMENTS',
        `${path} 是目录,不是文件。用 glob(pattern="${path}/**") 列目录内容,或用 grep 在目录下搜内容。`,
      );
    }
    if (!info.isFile()) {
      return failure('INVALID_ARGUMENTS', `${path} 不是普通文件(设备/套接字/特殊文件),无法读取。`);
    }
    if (info.size > MAX_FILE_BYTES) {
      return failure(
        'INVALID_ARGUMENTS',
        `${path} 有 ${formatBytes(info.size)},超过 read_file 的 ${formatBytes(MAX_FILE_BYTES)} 上限` +
          '(行号分页需整文件载入内存)。先用 grep 定位行号,再用 run_command 配合系统工具按段取。',
      );
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(absolute);
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      return failure(
        e?.code === 'EACCES' || e?.code === 'EPERM' ? 'SANDBOX_DENIED' : 'EXECUTION_ERROR',
        `读取 ${path} 失败: ${e?.message ?? String(error)}`,
      );
    }

    // ── 2. 魔数嗅探:图片走视觉通道,其余二进制明确拒绝 ──────────────────────
    // 为什么必须嗅探而不看扩展名:扩展名会说谎(截图缓存 / 构建产物常无扩展名或错扩展名),
    // 而把二进制当 UTF-8 解码的代价是实测一张 42KB PNG 产出 17862 个 U+FFFD(占 45%),
    // 经 history 上限中截后仍有数千字符纯乱码进上下文 —— 既烧 token 又误导模型。
    const head = buffer.subarray(0, SNIFF_BYTES);
    const sniffed: ImageMime | null = sniffImageMime(head);
    if (sniffed) return await readAsImage(path, sniffed, args.detail, info.size);
    if (isProbablyBinary(head)) {
      return failure(
        'INVALID_ARGUMENTS',
        `${path} 是二进制文件(头部含控制字符),不能按文本读取 —— 强行解码只会得到乱码。` +
          '若它其实是图片,支持的格式为 png/jpg/jpeg/gif/webp;否则用 run_command 配合专用工具' +
          '(如 file / strings / 反汇编器)查看。',
      );
    }

    // ── 3. 文本:沿用既有 artifact header + 行号分页 ────────────────────────
    // hash 仍取「UTF-8 解码后字符串」的摘要(与改动前逐字节一致):会话里已持久化的
    // expected_hash 与 context/artifacts 的 parseReadHash 都依赖这个口径,不能顺手换。
    const data = buffer.toString('utf8');
    const artifactHeader = `[artifact source=read_file path=${path} hash=${contentHash(data)}]`;
    const lines = data.split(/\r?\n/);
    const start = Math.max(0, offset - 1);
    const end = Math.min(lines.length, start + limit);
    const body = lines
      .slice(start, end)
      .map((l, i) => `${String(start + i + 1).padStart(6, ' ')}\t${l}`)
      .join('\n');
    // 空文件(0 字节)显式报「(空文件)」:''.split 得到 [''],行号分页会渲染成 `     1\t`,
    // 让模型误以为读到了带一行空白的文件。data.length===0 才是真·空的判据。
    if (data.length === 0)
      return { status: 'success', code: 'OK', retryable: false, output: `${artifactHeader}\n(空文件)` };
    // P2 重复读短路:同区间 + hash 未变 + 内容仍在 context → 短指针。
    const reqStart = start + 1;
    const reqEnd = end;
    const dedup = toolCtx?.readDedup;
    if (config.readDedup && dedup) {
      const hit = dedup.findUnchanged(path, reqStart, reqEnd, contentHash(data));
      if (hit) {
        return {
          status: 'success',
          code: 'OK',
          retryable: false,
          output:
            `${artifactHeader}\n[unchanged since step ${hit.step}, hash=${hit.hash}] ` +
            '该区间内容已在上方上下文中,未重复返回;若已被压缩或确需重读,请忽略本提示再读一次。',
        };
      }
    }
    const baseOutput =
      end < lines.length
        ? `${artifactHeader}\n${body}\n\n... (${lines.length - end} 行未显示,共 ${lines.length} 行)`
        : `${artifactHeader}\n${body}`;
    // R2.4:回注锚定本文件的记忆(最多 3 条,只回 fresh)。
    // 为什么放在 read_file 而不是 system prompt:prompt 每轮注入会撞 cache,而且
    // 「正在看这个文件」这一刻才是这条记忆最有用的时机;读到不相关的文件时零成本。
    // 判定用**刚读到的这份 data**,不会再碰磁盘。
    const output = baseOutput + memoryHintFor(path, data);
    // dedup 只登记「确实会进 context 的区间」。pushToolResult 会把超长输出经
    // capToolResultForHistory 中截到 MAX_HISTORY_RESULT(丢中段)——若此处仍登记
    // 完整 [reqStart, reqEnd],后续对「被截掉的中段」的重读会被 findUnchanged 命中,
    // 模型拿到 unchanged 短指针却找不到内容,只能反复缩小区间撞墙、最终用 shell 绕过
    // (实测事故:会话 20261012-033757)。故输出超 cap 时只登记头/尾两段实际保留的行。
    // 用 output(含回注段)判长度:最终进 history 的就是它,回注把长度顶过 cap 时
    // 必须按截断口径登记,否则会记成"完整保留"而制造幽灵命中。
    if (dedup && config.readDedup && output.length > MAX_HISTORY_RESULT) {
      const fileHash = contentHash(data);
      const truncated = truncatedOutputRanges(lines, start, end, output.length, MAX_HISTORY_RESULT);
      for (const r of truncated) dedup.record(path, r.start, r.end, fileHash);
    } else {
      dedup?.record(path, reqStart, reqEnd, contentHash(data));
    }
    return { status: 'success', code: 'OK', retryable: false, output };
  },
};

/** 回注条数上限。再多就变成噪音,模型会学会跳过这一段。 */
const MEMORY_HINT_LIMIT = 3;
/**
 * 参与 fresh 判定的候选条数上限。
 *
 * 必须**先过滤 fresh、再截 3 条**:锚定同一个文件的记忆里,靠前的可能已经过期。
 * 若先按 3 条截断再过滤,前 3 条恰好都 stale 时整段回注会静默消失,而第 4 条
 * 明明仍然有效。这个上限只为防止上百条锚点时白跑一遍 hash 判定。
 */
const MEMORY_HINT_SCAN = 20;

/**
 * R2.4:本文件被哪些**仍然对得上**的记忆锚定。
 *
 * 只回 fresh 的:内容已经变了说明这条记忆过期,此刻提示它等于把旧事实塞进上下文;
 * 它会在 `memory_search` 结果里带 `STALE-CODE` 标记出现,那里的语境更合适。
 *
 * 失败静默:记忆是增强通道,读文件本身的成功不能被它拖坏。
 */
function memoryHintFor(path: string, data: string): string {
  try {
    if (!isMemoryEnabled()) return '';
    const anchorPath = toAnchorPath(path);
    const hits = entriesAnchoredTo(anchorPath, { limit: MEMORY_HINT_SCAN });
    if (hits.length === 0) return '';
    // 只判**本文件**的锚点:一条记忆可能同时锚定多个文件,拿本文件的文本去判别的文件
    // 必然判 missing,整条记忆会被误当过期(见 evaluateAnchorsAgainst 的 anchorPath 说明)。
    const fresh = hits
      .filter((e) => !evaluateAnchorsAgainst(e.anchors, data, anchorPath).stale)
      .slice(0, MEMORY_HINT_LIMIT);
    if (fresh.length === 0) return '';
    const lines = fresh.map((e) => `- [${e.id}] ${e.name} — ${e.summary}`);
    return `\n\n## Memory anchored to this file\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

/**
 * 输出将被中截(头 60% / 尾 40%)时,反推真正保留进 context 的行区间。
 * 输出长度按行聚合估算:行号前缀(≤7 字符 + tab)与换行在各行间均摊,误差 ≤1 行,
 * 对 dedup 区间判定足够保守(宁可少记、不可多记——漏记只会多一次全量返回,多记会造成幽灵命中)。
 */
function truncatedOutputRanges(
  lines: string[],
  start: number,
  end: number,
  outputLen: number,
  cap: number,
): Array<{ start: number; end: number }> {
  const marker = `…[已截断 ${outputLen - cap} 字符]…`;
  const remain = cap - marker.length;
  const headChars = Math.ceil(remain * 0.6);
  const tailChars = remain - headChars;
  // 头段:从 start 起累加行,直至耗尽 headChars(含 artifact header 的固定开销,按保守处理:header 不占行预算)。
  const lineLen = (i: number): number => `${String(i + 1).padStart(6, ' ')}\t${lines[i]}`.length + 1;
  const ranges: Array<{ start: number; end: number }> = [];
  let acc = 0;
  let headEnd = start - 1;
  for (let i = start; i < end; i++) {
    const l = lineLen(i);
    if (acc + l > headChars) break;
    acc += l;
    headEnd = i;
  }
  if (headEnd >= start) ranges.push({ start: start + 1, end: headEnd + 1 });
  // 尾段:从 end-1 反向累加,直至耗尽 tailChars。区间下限不得超过头段结尾(头尾重叠说明整体保留)。
  acc = 0;
  let tailStart = end;
  for (let i = end - 1; i >= start; i--) {
    const l = lineLen(i);
    if (acc + l > tailChars) break;
    acc += l;
    tailStart = i;
  }
  if (tailStart < end && tailStart > headEnd) ranges.push({ start: tailStart + 1, end });
  return ranges;
}

/**
 * 图片分支:走视觉通道(modelAttachments),文本 output 只留一句可读摘要。
 *
 * 复用 attachments/image.ts 的加载 + 超限 PNG 降采样逻辑,与 screenshot 同口径
 * (4 MiB 内联上限、detail 语义、越界拒绝)。offset/limit 对图片无意义,显式说明而非静默忽略。
 */
async function readAsImage(path: string, mime: ImageMime, detailArg: unknown, bytes: number): Promise<ToolOutcome> {
  const loaded = await loadImageAttachmentWithDownscale(path, {
    maxBytes: MAX_INLINE_BYTES_DEFAULT,
    sniffedMime: mime,
  });
  if (!loaded.ok) {
    return failure(
      loaded.reason.startsWith('outside sandbox') ? 'SANDBOX_DENIED' : 'EXECUTION_ERROR',
      `无法把图片 ${path} 作为视觉输入加载: ${loaded.reason}`,
    );
  }
  const detail = detailArg === 'low' || detailArg === 'high' ? detailArg : 'auto';
  const { att, downscaledFrom } = loaded;
  const resizedNote = downscaledFrom
    ? ` Original ${downscaledFrom.width}×${downscaledFrom.height} exceeded the inline limit; the attached copy was downscaled.`
    : '';
  return {
    status: 'success',
    code: 'OK',
    retryable: false,
    output:
      `${IMAGE_READ_MARKER} Detected an image by magic bytes (${mime}, ${formatBytes(bytes)} on disk) and attached it ` +
      `as visual model input.${resizedNote} Attached ${att.bytes} bytes. ` +
      'offset/limit do not apply to images; pass detail=low to save tokens on the next one.',
    modelAttachments: [
      {
        type: 'image',
        name: att.name,
        mime: att.mime,
        dataUrl: att.dataUrl,
        detail,
      },
    ],
  };
}
