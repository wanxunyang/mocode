/**
 * 文件改动的 diff 视图（渲染层）。
 *
 * 为什么需要它：工具块以前把 edit_file / write_file 的**入参 JSON 原样**塞进 <pre>，
 * 用户看到的是一整坨 `{"path":…,"replacements":[{"new_string":"…"}]}` —— 转义后的
 * `\n` / `\"` 混在长行里，完全看不出改了哪几行。终端 mocode 用的是 src/ui/diff.ts 的
 * `Update(path)` + 行号 + `+`/`-` gutter + 语法高亮，这里按同一形态复刻 DOM 版。
 *
 * 与终端实现的两点差异（都是渲染层信息量所限，不是偷懒）：
 *  1. **拿不到执行前快照**：GUI 只有工具入参。edit_file 的 old_string/new_string 足够还原
 *     改动片段；write_file 只有新内容，所以一律按 Create 展示（与终端 replay 路径同策略，
 *     见 src/repl/message-format.ts 的 buildReplayDiff）。
 *  2. **拿不到绝对行号**：终端靠读盘定位 old_string 的起始行。这里不读盘（异步 + 依赖
 *     项目根解析，失败模式多），hunk 行号从 1 相对起算 —— 与终端「定位不到退回 1」一致。
 *
 * 纯渲染叶子模块：不依赖 i18n 运行时（文案由调用方注入，同 markdown.ts 的做法）。
 */
import { highlightCodeLine, langForPath } from './markdown.js';

export type DiffOp = 'ctx' | 'add' | 'del';
export interface DiffLine {
  op: DiffOp;
  text: string;
}

/** 任一边超此行数就不做 O(n·m) 的 LCS（与终端 MAX_FULL_DIFF_LINES 同值）。 */
const MAX_FULL_DIFF_LINES = 800;
/** 单个 hunk 最多展示的行数，超出给尾注。 */
const MAX_BODY_LINES = 24;
/** 连续未改动行超过这个数就折叠成一句「…(n 行不变)」。 */
const CTX_RUN_KEEP = 3;

export interface FileChangeLabels {
  update: string;
  create: string;
  unchanged: (n: number) => string;
  noChanges: string;
  tooLarge: string;
  truncated: (n: number) => string;
}

export interface FileHunk {
  oldStr: string;
  newStr: string;
  /** oldStr 在原文件里的起始行号（1 基）。缺省按 1 相对起算（与终端「定位不到退回 1」一致）。 */
  startLine?: number;
}

/** host 转发的真实改动上下文（见 src/host/stdio.ts 的 tool_completed）。 */
export interface FileChangeContext {
  editStartLine?: number;
  preWriteOld?: string | null;
  multiHunks?: ReadonlyArray<{ oldStr: string; newStr: string; startLine: number }>;
}

export interface FileChange {
  path: string;
  /** create = 全是新增行（write_file 新建 / 内容未知的覆盖写）；update = 有 old/new 可比。 */
  kind: 'create' | 'update';
  hunks: FileHunk[];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]!);
}

const toLf = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/** 按行切分；去掉末尾单个空行（由末尾 \n 产生）。 */
function splitLines(text: string): string[] {
  const lines = toLf(text).split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 行级 LCS。任一边超上限返回 null（调用方降级为「diff 过大」提示）。 */
export function lineDiff(oldStr: string, newStr: string): DiffLine[] | null {
  const a = splitLines(oldStr);
  const b = splitLines(newStr);
  if (a.length > MAX_FULL_DIFF_LINES || b.length > MAX_FULL_DIFF_LINES) return null;
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'ctx', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ op: 'del', text: a[i]! });
      i++;
    } else {
      out.push({ op: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ op: 'del', text: a[i++]! });
  while (j < m) out.push({ op: 'add', text: b[j++]! });
  return out;
}

type Item = DiffLine | { op: 'ellipsis'; count: number };

/** 连续 ctx 折叠：≤3 行全显，超过则保留首尾、中间收成一条省略。 */
function compactCtx(ops: DiffLine[]): Item[] {
  const items: Item[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.op !== 'ctx') {
      items.push(ops[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j]!.op === 'ctx') j++;
    const run = ops.slice(i, j);
    if (run.length <= CTX_RUN_KEEP) {
      items.push(...run);
    } else {
      items.push(run[0]!);
      items.push({ op: 'ellipsis', count: run.length - 2 });
      items.push(run[run.length - 1]!);
    }
    i = j;
  }
  return items;
}

/**
 * 由工具名 + 入参解析出可渲染的改动模型。解析不了返回 null（调用方回退到原始参数视图）。
 * 走的是与终端 replay 一致的口径，见 src/repl/message-format.ts:buildReplayDiff。
 *
 * `context` 是 host 转发的执行前快照（真实起始行号 / write_file 的旧内容）。有它：
 *   · 行号是文件里的真实行号，不是「相对本次改动的 1」；
 *   · write_file 覆盖写能展示删除侧，而不是一律当新建。
 * 没有它就退回纯入参推断（历史会话回放、旧版 host）。
 */
export function buildFileChange(
  name: string,
  rawArguments: string,
  context: FileChangeContext = {},
): FileChange | null {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(rawArguments) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const filePath = typeof parsed.path === 'string' ? parsed.path : '';
  if (!filePath) return null;

  if (name === 'write_file') {
    const content = parsed.content;
    // append 模式的 content 只是追加片段，拿它整篇对比会得到假的「删掉了一大半」。
    if (parsed.append === true) return null;
    // 有执行前快照 → 覆盖写能算出真实的增删；否则按 Create 展示（终端 replay 同策略）。
    if (typeof context.preWriteOld === 'string') {
      const oldStr = context.preWriteOld;
      const newStr = typeof content === 'string' ? content : '';
      if (oldStr === newStr) return null;
      return { path: filePath, kind: 'update', hunks: [{ oldStr, newStr, startLine: 1 }] };
    }
    if (typeof content !== 'string') return null;
    return { path: filePath, kind: 'create', hunks: [{ oldStr: '', newStr: content }] };
  }
  if (name !== 'edit_file') return null;

  // 多替换模式：每段一个 hunk。起始行号优先用 host 定位出的真实行号。
  if (Array.isArray(parsed.replacements) && parsed.replacements.length > 0) {
    const hunks: FileHunk[] = [];
    const located = context.multiHunks;
    for (let index = 0; index < parsed.replacements.length; index++) {
      const item = parsed.replacements[index];
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      if (typeof record.old_string !== 'string' || typeof record.new_string !== 'string') return null;
      // multiHunks 与 replacements 一一对应；长度对不上说明定位失败，宁可不带行号。
      const startLine = located && located.length === parsed.replacements.length ? located[index]?.startLine : undefined;
      hunks.push({ oldStr: record.old_string, newStr: record.new_string, ...(startLine ? { startLine } : {}) });
    }
    return { path: filePath, kind: 'update', hunks };
  }

  // 单替换：old_string → new_string。
  if (typeof parsed.old_string === 'string' && typeof parsed.new_string === 'string') {
    return {
      path: filePath,
      kind: 'update',
      hunks: [{ oldStr: parsed.old_string, newStr: parsed.new_string, startLine: context.editStartLine ?? 1 }],
    };
  }

  // 行区间模式：没有旧文本，只能把新内容按新增展示。
  if (typeof parsed.new_string === 'string' && parsed.line_start != null) {
    return { path: filePath, kind: 'create', hunks: [{ oldStr: '', newStr: parsed.new_string }] };
  }
  return null;
}

interface HunkStats {
  added: number;
  removed: number;
}

function hunkStats(hunk: FileHunk): HunkStats | null {
  if (hunk.oldStr === '') return { added: splitLines(hunk.newStr).length, removed: 0 };
  const ops = lineDiff(hunk.oldStr, hunk.newStr);
  if (!ops) return null;
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.op === 'add') added++;
    else if (op.op === 'del') removed++;
  }
  return { added, removed };
}

function renderRows(
  hunk: FileHunk,
  lang: string,
  labels: FileChangeLabels,
): { html: string; truncated: number | null } {
  const items: Item[] = hunk.oldStr === ''
    ? splitLines(hunk.newStr).map((text) => ({ op: 'add' as const, text }))
    : (() => {
        const ops = lineDiff(hunk.oldStr, hunk.newStr);
        return ops ? compactCtx(ops) : [];
      })();

  const rows: string[] = [];
  // 起始行号来自执行前快照（host 转发的 editStartLine / multiHunks[].startLine）。
  // 拿不到时才退回 1（相对行号）——终端同样以 1 兜底，但那条路径只有回放才走。
  let oldLine = hunk.startLine ?? 1;
  let newLine = hunk.startLine ?? 1;
  let shown = 0;
  let hidden = 0;

  for (const item of items) {
    if (shown >= MAX_BODY_LINES) {
      hidden += item.op === 'ellipsis' ? item.count : 1;
      continue;
    }
    if (item.op === 'ellipsis') {
      oldLine += item.count;
      newLine += item.count;
      rows.push(
        `<div class="tool-diff-row ellipsis"><span class="ln"></span><span class="gut"></span><code>${escapeHtml(labels.unchanged(item.count))}</code></div>`,
      );
      shown++;
      continue;
    }
    const text = item.text;
    const code = text === '' ? '&nbsp;' : highlightCodeLine(text, lang);
    if (item.op === 'del') {
      rows.push(`<div class="tool-diff-row del"><span class="ln">${oldLine}</span><span class="gut">-</span><code>${code}</code></div>`);
      oldLine++;
    } else if (item.op === 'add') {
      rows.push(`<div class="tool-diff-row add"><span class="ln">${newLine}</span><span class="gut">+</span><code>${code}</code></div>`);
      newLine++;
    } else {
      rows.push(`<div class="tool-diff-row ctx"><span class="ln">${newLine}</span><span class="gut"></span><code>${code}</code></div>`);
      oldLine++;
      newLine++;
    }
    shown++;
  }

  return { html: rows.join(''), truncated: hidden > 0 ? hidden : null };
}

/**
 * 改动量统计（+N -M）。返回 null 表示某个 hunk 过大无法做 LCS。
 */
export function summarizeFileChange(change: FileChange): HunkStats | null {
  let added = 0;
  let removed = 0;
  for (const hunk of change.hunks) {
    const stats = hunkStats(hunk);
    if (!stats) return null;
    added += stats.added;
    removed += stats.removed;
  }
  return { added, removed };
}

/**
 * 渲染成工具块展开区里的一段 HTML。返回 '' 表示没有可展示的改动（调用方回退原视图）。
 */
export function renderFileChangeHtml(change: FileChange, labels: FileChangeLabels): string {
  const lang = langForPath(change.path);
  const stats = change.hunks.map(hunkStats);
  if (stats.some((s) => s === null)) {
    return `<div class="tool-diff"><div class="tool-diff-head"><span class="tool-diff-path">${escapeHtml(change.path)}</span><span class="tool-diff-sub">${escapeHtml(labels.tooLarge)}</span></div></div>`;
  }
  // 已确认无 null（上面提前返回），这里显式收窄给 TS。
  const total = (stats as HunkStats[]).reduce(
    (acc, s) => ({ added: acc.added + s.added, removed: acc.removed + s.removed }),
    { added: 0, removed: 0 },
  );

  const verb = change.kind === 'create' ? labels.create : labels.update;
  const statParts: string[] = [];
  if (total.added > 0) statParts.push(`<span class="diff-add">+${total.added}</span>`);
  if (total.removed > 0) statParts.push(`<span class="diff-del">-${total.removed}</span>`);

  const bodies: string[] = [];
  change.hunks.forEach((hunk, index) => {
    const { html, truncated } = renderRows(hunk, lang, labels);
    if (!html) return;
    // 多 hunk 之间必须有 @@ 分隔：各 hunk 行号都从 1 相对起算，不分隔会让用户
    // 以为行号连续、误读成一处改动（终端 renderMultiFileChange 同样插 @@）。
    const separator = index > 0
      ? `<div class="tool-diff-row hunk-sep"><span class="ln"></span><span class="gut"></span><code>@@</code></div>`
      : '';
    bodies.push(
      `${separator}${html}` +
        (truncated === null
          ? ''
          : `<div class="tool-diff-row ellipsis"><span class="ln"></span><span class="gut"></span><code>${escapeHtml(labels.truncated(truncated))}</code></div>`),
    );
  });
  if (!bodies.length) {
    return `<div class="tool-diff"><div class="tool-diff-head"><span class="tool-diff-verb">${escapeHtml(verb)}</span><span class="tool-diff-path">${escapeHtml(change.path)}</span><span class="tool-diff-sub">${escapeHtml(labels.noChanges)}</span></div></div>`;
  }

  return `<div class="tool-diff">
  <div class="tool-diff-head"><span class="tool-diff-verb">${escapeHtml(verb)}</span><span class="tool-diff-path" title="${escapeHtml(change.path)}">${escapeHtml(change.path)}</span><span class="tool-diff-stat">${statParts.join('')}</span></div>
  <div class="tool-diff-body">${bodies.join('')}</div>
</div>`;
}