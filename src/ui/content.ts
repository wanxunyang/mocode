/**
 * 内容物理行缓冲(Phase 2 滚动回滚用)。
 *
 * 存折行后的物理行,每行自洽带色,供 layout.repaintViewport 单行直出、无需继承 SGR 状态。
 * contentWrite 逐字符喂入(feedChar / feedSgr / breakRow);eraseSegmentBack 用 popRows 同步删段。
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
} | null = null; // 段起点快照(供 eraseSegment 恢复)

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

/** 标记段(思考段)起点:快照当前缓冲状态,供 eraseSegment 恢复。 */
export function beginSegment(): void {
  segMark = { rowIdx: rows.length, rowStartSgr, curSgr, curRaw, hasCurrent };
}

/**
 * 删段并恢复到 beginSegment 时的状态;返回段物理行数(= segLines + 末行部分,与屏幕擦除行数一致)。
 * 段足迹 = 自 mark 后提交的行(committedErased)+ 当前行若有内容(currentErased)。
 * 恢复后当前行 = 段起点的那一行(折叠标题将写入此处),保证滚动回看只看到标题、不看到原文。
 */
export function eraseSegment(): number {
  if (!segMark) return 0;
  const committedErased = rows.length - segMark.rowIdx;
  const currentErased = hasCurrent && curRaw.length > 0 ? 1 : 0;
  rows.length = segMark.rowIdx;
  rowStartSgr = segMark.rowStartSgr;
  curSgr = segMark.curSgr;
  curRaw = segMark.curRaw;
  hasCurrent = segMark.hasCurrent;
  segMark = null;
  return committedErased + currentErased;
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
