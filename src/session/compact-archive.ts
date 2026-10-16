// compact-archive.ts — 压缩旧区原文的归档渲染器。
//
// 目的:compactHistory 成功摘要后旧区消息会被整体丢弃(连 session.json 也被
// 压缩后的 history 覆盖)。这里把旧区渲染成 grep 友好的 Markdown 段文件,落盘到
// `<session>/compacted/seg-NNN.md`,模型事后可用现有 grep/read_file 回捞精确原文,
// 不新增任何工具。
//
// 设计约束:
//  - 纯函数,不碰文件系统(落盘/编号/淘汰在 SessionStore)。
//  - 每个 seg 文件首行是单行 HTML 注释元数据(自描述,index.md 可随时重建)。
//  - 图片不归档(base64 无检索价值且体积爆炸),只留占位,与 stripImagesForSummary 同口径。
//  - 消息按 history 原时序;turn 序号按非空 user 消息递增,方便模型按回合定位。

import type { ChatMessage } from '../llm/index.js';

/** 压缩归档子目录名(相对会话目录)。 */
export const COMPACTED_DIRNAME = 'compacted';
/** 段索引文件名。 */
export const ARCHIVE_INDEX_FILE = 'index.md';

/** seg 文件名:seg-001.md … seg-999.md(超出也不报错,只是不补零)。 */
export function segmentFileName(seq: number): string {
  return `seg-${String(seq).padStart(3, '0')}.md`;
}

export const SEGMENT_FILE_RE = /^seg-(\d+)\.md$/;

/** push-time 被 capToolResultForHistory 截断的工具完整结果,按 tool_call_id 单存。 */
export function resultBlobFileName(toolCallId: string): string {
  // call id 理论上安全(toolu_xxx / call-N),仍做一次白名单清洗防路径穿越。
  const safe = toolCallId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
  return `result-${safe}.txt`;
}

export const RESULT_BLOB_FILE_RE = /^result-.+\.txt$/;

/** retention 归档时打包进 gz 的 compacted/ 资产白名单(其余临时文件不带走)。 */
export function isCompactedAssetName(name: string): boolean {
  return SEGMENT_FILE_RE.test(name) || RESULT_BLOB_FILE_RE.test(name) || name === ARCHIVE_INDEX_FILE;
}

/** 段元数据:同时写进 seg 首行 HTML 注释与 index.md。 */
export interface CompactedSegmentMeta {
  seq: number;
  file: string;
  archivedAt: string;
  /** 段内消息条数。 */
  messages: number;
  /** 段内非空 user 回合数。 */
  turns: number;
  /** 段内出现过的工具名(按首次出现去重)。 */
  tools: string[];
  /** 段内工具参数涉及的路径(去重、封顶)。 */
  files: string[];
  /** 首条非空 user 消息的单行摘要。 */
  firstUser: string;
  /** 渲染后字符数(供淘汰策略参考)。 */
  chars: number;
}

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

function asToolCalls(m: ChatMessage): RawToolCall[] {
  const tcs = (m as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(tcs)) return [];
  return tcs as RawToolCall[];
}

/** 多模态 content 拍平:text 拼接;image_url 留占位;其余形状 JSON 化(与摘要器同口径)。 */
function messageText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (p && typeof p === 'object') {
        const part = p as { type?: string; text?: string; image_url?: { url?: string } };
        if (part.type === 'text') parts.push(part.text ?? '');
        else if (part.type === 'image_url') {
          const url = part.image_url?.url ?? '';
          const mime = url.startsWith('data:') ? url.slice(5, url.indexOf(';')) : 'image';
          parts.push(`[图片已剥离: ${mime}]`);
        } else {
          parts.push(`[${part.type ?? 'content'} part]`);
        }
      } else {
        parts.push(String(p ?? ''));
      }
    }
    return parts.join('');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

const PATH_KEYS = new Set(['path', 'file', 'filePath', 'filename', 'dir', 'directory']);
const MAX_META_FILES = 8;
const MAX_FIRST_USER_CHARS = 60;

function collectFilesFromArgs(argsRaw: string | undefined, sink: string[]): void {
  if (!argsRaw || sink.length >= MAX_META_FILES) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsRaw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string' || !PATH_KEYS.has(k)) continue;
    const norm = v.replace(/\\/g, '/').replace(/^\.\//, '');
    if (norm && !sink.includes(norm)) sink.push(norm);
    if (sink.length >= MAX_META_FILES) break;
  }
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * 把一段旧区消息渲染成 Markdown 段。输出同时包含文件全文与元数据,
 * 调用方负责把返回的 { markdown, meta } 一起落盘。
 */
export function renderCompactedSegment(
  seq: number,
  messages: readonly ChatMessage[],
  archivedAt = new Date().toISOString(),
): { markdown: string; meta: CompactedSegmentMeta } {
  const file = segmentFileName(seq);
  const tools: string[] = [];
  const files: string[] = [];
  let turns = 0;
  let firstUser = '';

  // tool_call_id → tool 名(tool 消息自身不带工具名,靠前导 assistant 配对)。
  const callNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const tc of asToolCalls(m)) {
      const name = tc.function?.name;
      if (tc.id && name) callNames.set(tc.id, name);
      if (name && !tools.includes(name)) tools.push(name);
      collectFilesFromArgs(tc.function?.arguments, files);
    }
  }

  const blocks: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const text = messageText((m as { content?: unknown }).content);
      if (text.trim()) {
        turns++;
        if (!firstUser) firstUser = oneLine(text, MAX_FIRST_USER_CHARS);
      }
      blocks.push(`### [turn ${turns}] user\n${text.trim()}`);
      continue;
    }
    if (m.role === 'system') {
      // 上一代摘要的叙述段(pin 除外):内容会随本代重新压缩,归档里标记出处。
      blocks.push(`### [prior-summary] system\n${messageText((m as { content?: unknown }).content).trim()}`);
      continue;
    }
    if (m.role === 'tool') {
      const id = (m as { tool_call_id?: string }).tool_call_id ?? '';
      const name = (id && callNames.get(id)) || '';
      const label = [`### [turn ${turns}] tool_result`, id && `call=${id}`, name && `tool=${name}`]
        .filter(Boolean)
        .join(' ');
      blocks.push(`${label}\n${messageText((m as { content?: unknown }).content).trim()}`);
      continue;
    }
    // assistant:正文一个块,每个 tool_call 一个块(参数是 grep 的高频目标,独立成块)。
    const text = messageText((m as { content?: unknown }).content).trim();
    if (text) blocks.push(`### [turn ${turns}] assistant\n${text}`);
    for (const tc of asToolCalls(m)) {
      const name = tc.function?.name;
      const label = [`### [turn ${turns}] assistant call`, tc.id && `call=${tc.id}`, name && `tool=${name}`]
        .filter(Boolean)
        .join(' ');
      const args = (tc.function?.arguments ?? '').trim();
      blocks.push(`${label}\n${args ? `args: ${args}` : '(no args)'}`);
    }
  }

  const body = blocks.join('\n\n') + '\n';
  const baseMeta: Omit<CompactedSegmentMeta, 'chars'> = {
    seq,
    file,
    archivedAt,
    messages: messages.length,
    turns,
    tools,
    files,
    firstUser,
  };
  const heading = `# 已压缩历史段 ${file}\n\n`;
  // chars 是淘汰策略的依据,需含 header 自身:先估后定(header 只差 chars 一个数字位)。
  const measure = (chars: number): string => `<!-- mocode-archive ${JSON.stringify({ ...baseMeta, chars })} -->\n\n`;
  let chars = measure(0).length + heading.length + body.length;
  let header = measure(chars);
  if (header.length !== measure(0).length) {
    // 数字位数变化(9→10)的罕见情况,再定标一次即收敛。
    chars = header.length + heading.length + body.length;
    header = measure(chars);
  }
  const meta: CompactedSegmentMeta = { ...baseMeta, chars };
  return { markdown: `${header}${heading}${body}`, meta };
}

/** 从 seg 文件内容解析首行元数据;损坏/旧格式返 null。 */
export function parseSegmentMeta(markdown: string): CompactedSegmentMeta | null {
  const nl = markdown.indexOf('\n');
  const first = (nl >= 0 ? markdown.slice(0, nl) : markdown).trim();
  const m = /^<!-- mocode-archive (\{.*\}) -->$/.exec(first);
  if (!m) return null;
  try {
    const meta = JSON.parse(m[1]) as CompactedSegmentMeta;
    if (typeof meta.seq === 'number' && typeof meta.file === 'string') return meta;
    return null;
  } catch {
    return null;
  }
}

/**
 * 由全部段元数据重建 index.md。模型读它决定去哪段 grep;确定性输出,
 * 不经过摘要器(避免漏写)。relativeDir 是相对 cwd 的 POSIX 路径,
 * 直接写给模型/grep 用。
 */
export function renderArchiveIndex(metas: CompactedSegmentMeta[], relativeDir: string): string {
  const sorted = [...metas].sort((a, b) => a.seq - b.seq);
  const lines: string[] = [
    '# 已压缩历史索引(compacted history index)',
    '',
    '本目录是历次上下文压缩前的原始消息(用户原话、assistant 决策、工具参数与完整结果)。',
    `路径:\`${relativeDir}/\``,
    '需要精确原文(报错、命令/测试输出、旧决策)时,不要凭摘要猜也不要急着重跑:',
    `1. 用 grep 搜索并把 glob 限定在 \`${relativeDir}/**\`(.mocode 在 .gitignore 里,必须 glob 限定才搜得到);`,
    '2. 按命中行号用 read_file 的 offset/limit 精读对应 seg 文件。',
    '',
  ];
  for (const m of sorted) {
    const tools = m.tools.length ? m.tools.join(', ') : '-';
    const files = m.files.length ? m.files.join(', ') : '-';
    const first = m.firstUser ? m.firstUser.replace(/\|/g, '/') : '(无 user 消息)';
    lines.push(
      `- [${m.file}](${m.file}) · ${m.archivedAt} · ${m.turns} turns · ${m.messages} msgs · 工具 ${tools} · 文件 ${files} · 首句:${first}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
