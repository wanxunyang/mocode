/**
 * git 统一 diff（unified diff）的人读渲染 —— **并排两列**版本。
 *
 * 为什么需要它：源代码管理面板以前把 `git diff` 原文塞进 <pre>，整块同色等宽文字 ——
 * 添加行和删除行只差首字符，扫一眼完全看不出改了什么，等于没有可视化。
 *
 * 为什么是两列而不是单列：单列里删除与新增是**上下相邻**的，中间还夹着 hunk 头与上下文行，
 * 读者要在脑内把「上面那几行」和「下面那几行」对上才知道改了什么；改动块一长，就只能逐字比对。
 * 两列把「原始」和「改动后」摆成同一行的左右两半，差异变成水平方向的一次扫视。
 *
 * 形态要点：
 *   · 左半 = 原文件（旧行号 + `−` 红底），右半 = 改动后（新行号 + `+` 绿底）；
 *   · 一段「删 N 行 + 加 M 行」按行对齐成 max(N, M) 行，少的那侧留空占位
 *     （`.udiff-side.empty`），左右行号不会因为行数不等而整体错位；
 *   · 上下文行两侧是同一行文字、各带自己的行号；窄容器下 CSS 只保留左侧那份
 *     （右侧带 `dup` 类），视觉上退化成传统 unified diff；
 *   · `@@ … @@` 渲染成分隔带，`diff --git` / `index` / `---` / `+++` 收敛成灰色元信息；
 *   · 代码按文件后缀做语法高亮（复用 markdown.ts 的单行高亮器，不另起一套配色）。
 *
 * 用 `<table>` 而不是每行各自 grid：表格的 `table-layout: auto` 让所有行共享同一组列宽，
 * 长行不会把某几行的分栏位置推歪（这点是并排 diff 可读性的前提）。
 *
 * 纯字符串渲染：无 DOM、无 fs，便于单测。返回 null 表示「这不是一份可解析的 diff」
 * （二进制 / 无文本差异 / 冲突提示），调用方回退到原文 <pre>。
 */
import { highlightCodeLine, langForPath } from './markdown.js';

export interface UnifiedDiffLabels {
  /** 行数超上限时的尾注（不传就不显示尾注行）。 */
  moreLines?: (n: number) => string;
  /** 左列表头（与 newSide 同时给才画表头）。 */
  oldSide?: string;
  /** 右列表头。 */
  newSide?: string;
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
type CellKind = 'add' | 'del' | 'ctx';

interface Row {
  kind: RowKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** 并排的一行：两侧各一格，缺的那格为 undefined（渲染成空占位）。 */
interface SideCell {
  kind: CellKind;
  text: string;
  no?: number;
}

interface PairUnit {
  /** pair = 左右两格；其余是整行铺满的元信息。 */
  kind: 'pair' | 'file' | 'meta' | 'hunk' | 'more';
  /** 这个单元吃掉了源 diff 的几行（用于算「还有 N 行」）。 */
  sourceRows: number;
  text?: string;
  old?: SideCell;
  new?: SideCell;
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

/**
 * 把行序列折成并排单元。
 *
 * git 在同一个 hunk 里总是**先列完所有删除、再列所有新增**，所以「一个 del 段 + 紧跟的
 * add 段」就是一处改动，按行 zip 起来即是左右对齐的改法；段长不等时余下的行另一侧留空。
 */
function toPairs(rows: readonly Row[]): PairUnit[] {
  const units: PairUnit[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (row.kind === 'del') {
      const dels: Row[] = [];
      while (index < rows.length && rows[index]!.kind === 'del') dels.push(rows[index++]!);
      const adds: Row[] = [];
      while (index < rows.length && rows[index]!.kind === 'add') adds.push(rows[index++]!);
      const sourceRows = dels.length + adds.length;
      const pairs = Math.max(dels.length, adds.length);
      for (let k = 0; k < pairs; k++) {
        const del = dels[k];
        const add = adds[k];
        units.push({
          kind: 'pair',
          // 源行数记在这一组的最后一个单元上：算尾注时只需累加。
          sourceRows: k === pairs - 1 ? sourceRows : 0,
          ...(del ? { old: { kind: 'del' as const, text: del.text, no: del.oldNo } } : {}),
          ...(add ? { new: { kind: 'add' as const, text: add.text, no: add.newNo } } : {}),
        });
      }
      continue;
    }
    if (row.kind === 'add') {
      units.push({ kind: 'pair', sourceRows: 1, new: { kind: 'add', text: row.text, no: row.newNo } });
      index++;
      continue;
    }
    if (row.kind === 'ctx') {
      // 上下文行两侧是同一行文字、各带自己的行号：左旧右新，对齐关系一目了然。
      units.push({
        kind: 'pair',
        sourceRows: 1,
        old: { kind: 'ctx', text: row.text, no: row.oldNo },
        new: { kind: 'ctx', text: row.text, no: row.newNo },
      });
      index++;
      continue;
    }
    units.push({ kind: row.kind, sourceRows: 1, text: row.text });
    index++;
  }
  return units;
}

function renderCell(cell: SideCell | undefined, side: 'old' | 'new', lang: string): string {
  if (!cell) return `<td class="udiff-side ${side} empty"></td>`;
  const no = cell.no === undefined ? '' : String(cell.no);
  const gut = cell.kind === 'add' ? '+' : cell.kind === 'del' ? '-' : '';
  const code = cell.text === '' ? '&nbsp;' : highlightCodeLine(cell.text, lang);
  // ctx 的右侧是左侧的副本：窄容器下由 CSS 隐藏，退化成传统单列 diff。
  const dup = side === 'new' && cell.kind === 'ctx' ? ' dup' : '';
  return `<td class="udiff-side ${side} ${cell.kind}${dup}"><span class="ln">${no}</span><span class="gut">${gut}</span><code>${code}</code></td>`;
}

function renderUnit(unit: PairUnit, lang: string): string {
  if (unit.kind === 'pair') {
    const cls = unit.old?.kind === 'ctx' ? 'pair ctx' : 'pair change';
    return `<tr class="udiff-row ${cls}">${renderCell(unit.old, 'old', lang)}${renderCell(unit.new, 'new', lang)}</tr>`;
  }
  return `<tr class="udiff-row ${unit.kind}"><td class="udiff-full" colspan="2"><code>${escapeHtml(unit.text ?? '')}</code></td></tr>`;
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
  const units = toPairs(rows);
  let lang = 'text';
  const html: string[] = [];
  if (labels.oldSide && labels.newSide) {
    html.push(`<tr class="udiff-row head"><td class="udiff-side old"><span class="udiff-head-label">${escapeHtml(labels.oldSide)}</span></td><td class="udiff-side new"><span class="udiff-head-label">${escapeHtml(labels.newSide)}</span></td></tr>`);
  }
  let consumed = 0;
  for (const unit of units) {
    if (consumed >= MAX_ROWS) {
      const hidden = rows.length - consumed;
      if (labels.moreLines) html.push(`<tr class="udiff-row more"><td class="udiff-full" colspan="2"><code>${escapeHtml(labels.moreLines(hidden))}</code></td></tr>`);
      break;
    }
    // 路径来自 `+++` / `diff --git`；同一份 diff 里换文件时更新高亮语言。
    if (unit.kind === 'file') {
      const found = pathFromLine(unit.text ?? '');
      if (found) lang = langForPath(found);
    }
    html.push(renderUnit(unit, lang));
    consumed += unit.sourceRows;
  }
  return `<div class="udiff"><table class="udiff-table"><tbody>${html.join('')}</tbody></table></div>`;
}