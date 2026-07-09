/**
 * 内容物理行缓冲(Phase 2 滚动回滚用)。
 *
 * 存折行后的物理行,每行自洽带色,供 layout.repaintViewport 单行直出、无需继承 SGR 状态。
 * contentWrite 逐字符喂入(feedChar / feedSgr / breakRow);setLines 替换当前段(md 流式渲染用)。
 *
 * **SGR 自洽模型**:每行存 `rowStartSgr + curRaw + \x1B[0m`:
 *  - rowStartSgr:本行起始时继承的活跃 SGR 前缀(来自上一行末状态);
 *  - curRaw:本行原始字节——可见字符 + 行内出现的 SGR 码(保留行内开合,如 `${dim}ab${reset}cd`);
 *  - 末尾 reset:使单行渲染不依赖后续。
 * 这样行内 SGR 变化与跨行继承都正确——简单"前缀+可见文本"模型会丢行内开合的色。
 *
 * **当前行**:任何 feedChar/feedSgr/breakRow 后 hasCurrent=true;breakRow(\n/折行)提交本行并开新空行
 * (hasCurrent 仍 true,代表光标所在的新空行)。这让 offset=0 的 viewport 重画与实时屏严格一致
 * (含 \n 后的光标空行),避免回尾时内容错位。
 *
 * 主题(theme.ts)只用单参数 SGR 码,故 curSgr 状态机简单:遇 \x1B[0m / \x1B[m 清空,其余累加。
 * 上限 20000 行防无限增长(超限丢头部,批量 trim)。
 */
const MAX_ROWS = 20000;

let rows: string[] = [];
let curSgr = ''; // 当前活跃 SGR 状态(行内演进;行末值 = 下行继承值)
let rowStartSgr = ''; // 当前行起始继承的 SGR 前缀
let curRaw = ''; // 当前行原始字节(可见 + 行内 SGR 码)
let hasCurrent = false; // 是否有当前行(feed/breakRow 后;新空行也算)
let segMark: {
  rowIdx: number;
  rowStartSgr: string;
  curSgr: string;
  curRaw: string;
  hasCurrent: boolean;
} | null = null; // 段起点快照(md 段:setLines 截断用,commitSegment 清)

export function reset(): void {
  rows = [];
  curSgr = '';
  rowStartSgr = '';
  curRaw = '';
  hasCurrent = false;
  segMark = null;
}

/** 喂一个 SGR 码(\\x1B[...m):入 curRaw,并更新活跃状态(遇 reset 清空)。 */
export function feedSgr(code: string): void {
  curRaw += code;
  if (code === '\x1B[0m' || code === '\x1B[m') curSgr = '';
  else curSgr += code;
  hasCurrent = true;
}

/** 喂一个可见字符(已按码点取出)。 */
export function feedChar(ch: string): void {
  curRaw += ch;
  hasCurrent = true;
}

/** 提交当前行为自洽物理行,开新空行(SGR 状态继承到下行)。在 \\n / 折行 / tab 换行时调。 */
export function breakRow(): void {
  rows.push(rowStartSgr + curRaw + '\x1B[0m');
  if (rows.length > MAX_ROWS + 512) rows.splice(0, rows.length - MAX_ROWS);
  curRaw = '';
  rowStartSgr = curSgr; // 下行继承本行末状态
  hasCurrent = true; // 新空行即当前行
}

/**
 * 弹出 buffer 末尾 n 物理行(供 layout.rewindContent 撤回刚写入段用)。
 * 当前行先 commit 再裁剪(消除 hasCurrent 边界);n ≥ totalRows 则全清,
 * 但**不动 segMark** —— recall 走普通 contentWrite、不撞 md 段;
 * segMark 由 reset() / commitSegment() 清,recall 不掺和。
 */
export function rewind(n: number): void {
  if (n <= 0) return;
  const cur = totalRows();
  if (n >= cur) {
    rows = [];
    curSgr = '';
    rowStartSgr = '';
    curRaw = '';
    hasCurrent = false;
    return;
  }
  // 当前行先 commit 再裁剪(否则 hasCurrent 边界会被打穿)
  if (hasCurrent) {
    rows.push(rowStartSgr + curRaw + '\x1B[0m');
    curRaw = '';
    rowStartSgr = curSgr;
    hasCurrent = false;
  }
  rows.splice(rows.length - n);
}

/** 标记段起点:快照当前缓冲状态,供 setLines 截断定位段头(md 流式渲染每 chunk 截断重渲)。 */
export function beginSegment(): void {
  segMark = { rowIdx: rows.length, rowStartSgr, curSgr, curRaw, hasCurrent };
}

/**
 * 用预渲染的自洽 ANSI 行替换当前段(从 segMark 起),供 markdown 流式渲染:
 * layout.contentWriteMd 每 chunk 把累积 text 经 renderMarkdown 渲成自洽行,调此替换缓冲段。
 * 截断 rows 到 segMark.rowIdx(擦上次渲染)+ push 新行;curSgr 复位为默认(行末 reset);
 * **保留 segMark**(下次 setLines 还要截断),由 commitSegment 清除。
 * 行须各自自洽(行内 SGR 自带、行末 reset)——不经 feedChar/feedSgr,直接入 rows,
 * 故 setLines 后 hasCurrent=false(snapshot 只返 rows;续写位由 layout 跟踪)。
 */
export function setLines(lines: string[]): void {
  if (segMark) {
    rows.length = segMark.rowIdx;
  }
  for (const line of lines) {
    rows.push(line);
  }
  if (rows.length > MAX_ROWS + 512) rows.splice(0, rows.length - MAX_ROWS);
  curSgr = '';
  rowStartSgr = '';
  curRaw = '';
  hasCurrent = false;
}

/** 提交段:清 segMark,后续写入不再被 setLines 截断(md 段结束、非 md 内容接续时调)。 */
export function commitSegment(): void {
  segMark = null;
}

/** 快照(已提交行 + 当前行若有)。viewport 取行窗用。 */
function snapshot(): string[] {
  return hasCurrent
    ? [...rows, rowStartSgr + curRaw + '\x1B[0m']
    : rows;
}
/** 距尾 offset 行、取 count 行的窗口(映射到屏 1..count)。offset=0 即尾窗。 */
export function sliceFromEnd(offset: number, count: number): string[] {
  const all = snapshot();
  const end = all.length - offset;
  if (end <= 0) return [];
  const start = Math.max(0, end - count);
  return all.slice(start, end);
}

/** 快照总行数(含当前行),供 scrollBy 钳位。 */
export function totalRows(): number {
  return rows.length + (hasCurrent ? 1 : 0);
}

/** 取绝对行索引(0-based,含当前行)的原始自洽行;越界返 null。供鼠标选区文本提取。 */
export function lineAt(abs: number): string | null {
  const all = snapshot();
  return abs >= 0 && abs < all.length ? all[abs] : null;
}

/**
 * 在绝对行索引 after(0-based,已 commit)之后插入 N 条自洽行。
 * 用于「折叠摘要行下展开明细」——把详情行在已写入摘要行后面塞入缓冲,
 * 不重写尾部已有内容;且不影响更早的 buffer 行(hasCurrent 先 commit 再 splice)。
 *
 * 行须自洽(每行带行末 \x1B[0m),不经 feedChar/feedSgr,直接入 rows。
 * after < 0 视为在所有已 commit 行之前插入;after ≥ 已 commit 行数则追加到末尾。
 * 若 segMark 活跃且插入点在 segMark.rowIdx 之前,则 segMark.rowIdx 跟着平移(否则
 * 流式 md 段活跃期间展开/折叠 batch 后,下一个 md chunk 的 setLines 截断到错误位置)。
 *
 * 后置条件:插入后 hasCurrent=false(新空行不由本函数建立);调用方须自行决定续写位
 * (BatchRenderer 在插入后调 layout.contentWrite 续写,新 \n 自然在详情块后建新行)。
 */
export function insertAfter(after: number, lines: string[]): void {
  if (lines.length === 0) return;
  if (hasCurrent) {
    rows.push(rowStartSgr + curRaw + '\x1B[0m');
    curRaw = '';
    rowStartSgr = curSgr;
    hasCurrent = false;
  }
  const committed = rows.length;
  // after 是绝对行索引;若超过 committed(例如快照时 hasCurrent=true),钳到末尾
  const target = after < 0 ? 0 : Math.min(after + 1, committed);
  rows.splice(target, 0, ...lines);
  // 流式 md 段活跃期间:插入点在段起点之前 → segMark.rowIdx 平移,
  // 否则下一个 md chunk 的 setLines 截断到旧位置,展开行被砍掉。
  if (segMark && target <= segMark.rowIdx) {
    segMark.rowIdx += lines.length;
  }
  if (rows.length > MAX_ROWS + 512) rows.splice(0, rows.length - MAX_ROWS);
}

/**
 * 从绝对行索引 startIdx(0-based,已 commit)起删 n 行。
 * 用于「已展开明细折回摘要」——把详情行从中段裁掉,保留摘要行和后续内容。
 * startIdx 越界或 n <= 0 直接 no-op。hasCurrent 时先 commit(同 insertAfter)。
 *
 * 后置条件:删除后 hasCurrent=false。后续 layout.contentWrite 自然续写。
 */
export function deleteFrom(startIdx: number, n: number): void {
  if (n <= 0) return;
  if (hasCurrent) {
    rows.push(rowStartSgr + curRaw + '\x1B[0m');
    curRaw = '';
    rowStartSgr = curSgr;
    hasCurrent = false;
  }
  const committed = rows.length;
  if (startIdx >= committed) return;
  const end = Math.min(startIdx + n, committed);
  const actual = end - startIdx;
  rows.splice(startIdx, actual);
  // 流式 md 段活跃期间:删除区间全部在段起点之前 → segMark.rowIdx 回退,
  // 否则下一个 md chunk 的 setLines 截断到旧位置,段内容错位。
  if (segMark && startIdx + actual <= segMark.rowIdx) {
    segMark.rowIdx -= actual;
  }
}
