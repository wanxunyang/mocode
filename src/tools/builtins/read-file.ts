import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { contentHash } from '../../changeset/index.js';
import { IMAGE_READ_MARKER, MAX_FILE_LINES } from '../constants.js';
import {
  MAX_INLINE_BYTES_DEFAULT,
  isProbablyBinary,
  loadImageAttachmentWithDownscale,
  sniffImageMime,
  type ImageMime,
} from '../../attachments/image.js';
import type { Tool, ToolOutcome } from '../types.js';

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
    'Text — read before editing. For files >500 lines: grep first to locate regions, then call read_file ' +
    'multiple times with offset+limit (e.g. offset=350, limit=120). Do NOT read an entire large file in one call.\n' +
    'When you need several regions of the SAME file, issue those read_file calls together in one ' +
    'response (they run concurrently) instead of paging through it one page after another — ' +
    'avoid sequential offset+=limit walks of the same file.\n' +
    'For files ≤500 lines you may read the whole file in one call. Independent region reads ' +
    'may be issued in the same response — they run concurrently, saving a round-trip each.\n' +
    'Images — PNG/JPEG/GIF/WebP are detected by MAGIC BYTES (the extension does not matter) and attached as ' +
    'visual model input; pass detail=low|high to control resolution, and oversized PNGs are downscaled automatically.\n' +
    'Other binary files are REJECTED with an explanation instead of being dumped as garbled text. ' +
    'If you truly need their content, use run_command with a proper tool (e.g. `file`, `strings`, a disassembler).\n' +
    'For architecture or call-chain questions, prefer loading the `codegraph` skill (use_skill) over reading files one at a time.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the working directory' },
      offset: { type: 'integer', description: 'Start line, 1-based (default 1). Text files only; ignored for images.' },
      limit: {
        type: 'integer',
        description:
          'Max lines to read (default 300, hard cap 2000). Keep ranges modest (e.g. 80-300); for files ≤500 lines you may read the whole file in one call. Text only; ignored for images.',
      },
      detail: {
        type: 'string',
        enum: ['auto', 'low', 'high'],
        description: 'Vision detail level when the path is an image (default: auto). Ignored for text.',
      },
    },
    required: ['path'],
  },
  async execute(args): Promise<ToolOutcome> {
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
    const output =
      end < lines.length
        ? `${artifactHeader}\n${body}\n\n... (${lines.length - end} 行未显示,共 ${lines.length} 行)`
        : `${artifactHeader}\n${body}`;
    return { status: 'success', code: 'OK', retryable: false, output };
  },
};

/**
 * 图片分支:走视觉通道(modelAttachments),文本 output 只留一句可读摘要。
 *
 * 复用 attachments/image.ts 的加载 + 超限 PNG 降采样逻辑,与 view_image / screenshot 同口径
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
