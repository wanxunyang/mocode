/**
 * git 统一 diff（unified diff）的人读渲染。
 *
 * 为什么需要它：源代码管理面板以前把 `git diff` 原文塞进 <pre>，整块同色等宽文字 ——
 * 添加行和删除行只差首字符，扫一眼完全看不出改了什么，等于没有可视化。
 *
 * 形态对齐 VS Code / GitHub 的行内 diff：
 *   · 旧行号 + 新行号两列（添加行只有新行号、删除行只有旧行号，一眼看出「插在哪」）；
 *   · `+` 行绿底绿栏、`−` 行红底红栏 —— 底色比工具块的 diff 更实，这里是主视图，
 *     不是折叠卡片里的次要信息；
 *   · `@@ … @@` 渲染成分隔带，`diff --git` / `index` / `---` / `+++` 收敛成灰色元信息，
 *     不跟代码抢注意力；
 *   · 代码按文件后缀做语法高亮（复用 markdown.ts 的单行高亮器，不另起一套配色）。
 *
 * 纯字符串渲染：无 DOM、无 fs，便于单测。返回 null 表示「这不是一份可解析的 diff」
 * （二进制 / 无文本差异 / 冲突提示），调用方回退到原文 <pre>。
 */
import { highlightCodeLine, langForPath } from './markdown.js';

export interface UnifiedDiffLabels {
  /** 行数超上限时的尾注（不传就不显示尾注行）。 */
  moreLines?: (n: number) => string;
}

/**
 * 最多渲染的行数。
 *
 * 主进程给的单文件 diff 上限是 200KB（git.ts 的 DIFF_PREVIEW_LIMIT），整份改写的文件
 * 动辄几千行；逐行做语法高亮在这个量级上开始有感（实测 2000 行 ≈ 15ms）。
 * 超出的部分给一条尾注 —— 比让面板卡住好，也比静默截断诚实。
 */
const MAX_ROWS = 2000;

type RowKind = 'file' | 'meta' | 'hunk' | 'add' | 'del' | 'ctx';

interface Row {
  kind: RowKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]!);
}

/** `@@ -12,7 +12,9 @@ 上下文`；合并冲突的 `@@@` 也认。 */
const HUNK_HEADER = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * 从文件头行里取路径（`+++ b/src/a.ts` / `diff --git a/x b/y`），用于语法高亮。
 * 取不到就退回 'text' —— 宁可不染色，也不要按错误的语言分词。
 */
function pathFromLine(line: string): string | null {
  const plus = /^\+\+\+ b?\/?(.+)$/.exec(line);
  if (plus) {
    const found = plus[1]!.replace(/\t.*$/, '').trim();
    // 删除文件时是 `+++ /dev/null`：保持上一个文件的语言，别切到 'text'。
    return !found || found === 'dev/null' ? null : found;
  }
  const git = /^diff --git a\/.+ b\/(.+)$/.exec(line);
  if (git) return git[1]!.trim() || null;
  return null;
}

/**
 * 解析统一 diff 成行模型。行号追踪依赖 `@@` 头的起始位置：
 * 没有 hunk 头的行（文件头、二进制提示）不参与行号。
 */
function parse(text: string): { rows: Row[]; sawHunk: boolean } {
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  let sawHunk = false;
  /**
   * 是否还在「文件头区」（`diff --git` 之后、第一个 `@@` 之前）。
   *
   * 只有头区里的 `--- ` / `+++ ` 才是文件路径行。删除一行内容本身就是 `--- x` 时
   * （比如删掉 SQL 注释 `-- x`、Markdown 的 `+++ title`），若不做这个区分会被
   * 误判成文件头，整行变成灰底元信息，红绿高亮就丢了。
   */
  let inHeader = true;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (raw === '') continue;
    if (raw.startsWith('diff --git')) {
      rows.push({ kind: 'file', text: raw });
      oldNo = 0;
      newNo = 0;
      inHeader = true;
      continue;
    }
    if (raw.startsWith('@@')) {
      sawHunk = true;
      inHeader = false;
      const match = HUNK_HEADER.exec(raw);
      if (match) {
        oldNo = Number(match[1]);
        newNo = Number(match[2]);
      } else {
        oldNo = 0;
        newNo = 0;
      }
      rows.push({ kind: 'hunk', text: raw });
      continue;
    }
    // 元信息：索引、模式、相似度、重命名、二进制、\ No newline 之类。
    if (/^(index |new file mode |deleted file mode |old mode |new mode |similarity index |rename (from|to) |copy (from|to) |Binary files |\\ No newline)/.test(raw)) {
      rows.push({ kind: 'meta', text: raw });
      continue;
    }
    if (inHeader && (raw.startsWith('--- ') || raw.startsWith('+++ '))) {
      rows.push({ kind: 'file', text: raw });
      continue;
    }
    const sign = raw[0];
    if (sign === '+') {
      rows.push({ kind: 'add', text: raw.slice(1), newNo: newNo || undefined });
      if (newNo) newNo++;
      continue;
    }
    if (sign === '-') {
      rows.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo || undefined });
      if (oldNo) oldNo++;
      continue;
    }
    // 上下文行（前导空格）以及任何无法识别的内容都按 ctx 展示，不丢信息。
    rows.push({ kind: 'ctx', text: sign === ' ' ? raw.slice(1) : raw, oldNo: oldNo || undefined, newNo: newNo || undefined });
    if (oldNo) oldNo++;
    if (newNo) newNo++;
  }
  return { rows, sawHunk };
}

function renderRow(row: Row, lang: string): string {
  if (row.kind === 'file') {
    return `<div class="udiff-row file"><span class="ln"></span><span class="ln"></span><span class="gut"></span><code>${escapeHtml(row.text)}</code></div>`;
  }
  if (row.kind === 'hunk') {
    return `<div class="udiff-row hunk"><span class="ln"></span><span class="ln"></span><span class="gut"></span><code>${escapeHtml(row.text)}</code></div>`;
  }
  if (row.kind === 'meta') {
    return `<div class="udiff-row meta"><span class="ln"></span><span class="ln"></span><span class="gut"></span><code>${escapeHtml(row.text)}</code></div>`;
  }
  const oldCell = row.oldNo === undefined ? '' : String(row.oldNo);
  const newCell = row.newNo === undefined ? '' : String(row.newNo);
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : '';
  const code = row.text === '' ? '&nbsp;' : highlightCodeLine(row.text, lang);
  return `<div class="udiff-row ${row.kind}"><span class="ln">${oldCell}</span><span class="ln">${newCell}</span><span class="gut">${sign}</span><code>${code}</code></div>`;
}

/**
 * 渲染一份统一 diff。返回 null 表示这份文本不该走 diff 视图（调用方用原来的 <pre>）。
 */
export function renderUnifiedDiff(text: string, labels: UnifiedDiffLabels = {}): string | null {
  if (!text.trim()) return null;
  const { rows, sawHunk } = parse(text);
  // 没有任何 hunk 头 = 这不是 git 的 diff 输出（可能是 "Binary files differ"、
  // "Unresolved merge conflict." 或一段普通文本）—— 交给原文展示，别硬套颜色。
  if (!sawHunk) return null;
  let lang = 'text';
  const html: string[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (index >= MAX_ROWS) {
      const hidden = rows.length - MAX_ROWS;
      if (labels.moreLines) html.push(`<div class="udiff-row more"><span class="ln"></span><span class="ln"></span><span class="gut"></span><code>${escapeHtml(labels.moreLines(hidden))}</code></div>`);
      break;
    }
    // 路径来自 `+++` / `diff --git`；同一份 diff 里换文件时更新高亮语言。
    if (row.kind === 'file') {
      const found = pathFromLine(row.text);
      if (found) lang = langForPath(found);
    }
    html.push(renderRow(row, lang));
  }
  return `<div class="udiff">${html.join('')}</div>`;
}