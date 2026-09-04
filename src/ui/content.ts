/**
 * 内容物理行缓冲(Phase 2 滚动回滚用)。
 *
 * 存折行后的物理行,每行自洽带色,供 layout.repaintViewport 单行直出、无需继承 SGR 状态。
 * contentWrite 逐字符喂入(feedChar / feedSgr / breakRow);setLines 替换当前段(md 流式渲染用)。
 * markdown 段额外保留未折行 source，终端列宽变化时可重新渲染对应物理行；普通行仍沿用原模型。
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
interface ReflowSegment {
  id: number;
  start: number;
  rowCount: number;
  source: string;
}

export interface ReflowChange {
  /** 本次替换发生时的绝对物理行起点（已包含前面 change 的位移）。 */
  start: number;
  oldCount: number;
  newCount: number;
  delta: number;
  /** 重排前后的自洽物理行。即使行数相同，断行边界也可能变化，选区据此做字符级迁移。 */
  oldLines: string[];
  newLines: string[];
}

let nextSegmentId = 1;
let reflowSegments: ReflowSegment[] = [];
let segMark: {
  rowIdx: number;
  rowStartSgr: string;
  curSgr: string;
  curRaw: string;
  hasCurrent: boolean;
  reflowId: number;
} | null = null; // 段起点快照(md 段:setLines 截断用,commitSegment 清；逻辑源保留供 resize reflow)

/** rows 头部裁剪后同步修正可重排段；被裁掉一部分的段失去完整逻辑边界，直接作废。 */
function shiftReflowSegmentsAfterHeadTrim(removed: number): void {
  if (removed <= 0) return;
  reflowSegments = reflowSegments
    .filter((segment) => segment.start >= removed)
    .map((segment) => ({ ...segment, start: segment.start - removed }));
  if (segMark) {
    if (segMark.rowIdx < removed) {
      reflowSegments = reflowSegments.filter((segment) => segment.id !== segMark?.reflowId);
      segMark.rowIdx = 0;
    } else {
      segMark.rowIdx -= removed;
    }
  }
}

function trimRows(): number {
  if (rows.length <= MAX_ROWS + 512) return 0;
  const removed = rows.length - MAX_ROWS;
  rows.splice(0, removed);
  shiftReflowSegmentsAfterHeadTrim(removed);
  return removed;
}

/** 中段插入物理行：段前插入只平移；插进段内部会破坏逻辑源与物理行的一一关系，作废该段。 */
function noteRowsInserted(target: number, count: number): void {
  if (count <= 0) return;
  reflowSegments = reflowSegments.filter((segment) => {
    const end = segment.start + segment.rowCount;
    if (target <= segment.start) {
      segment.start += count;
      return true;
    }
    return target >= end;
  });
}

/** 中段删除物理行：段前删除只平移；与段相交则作废该段。 */
function noteRowsDeleted(start: number, count: number): void {
  if (count <= 0) return;
  const end = start + count;
  reflowSegments = reflowSegments.filter((segment) => {
    const segmentEnd = segment.start + segment.rowCount;
    if (end <= segment.start) {
      segment.start -= count;
      return true;
    }
    return start >= segmentEnd;
  });
}

/** 物理行区间被外部改写后，与其相交的逻辑段不再可安全重排。 */
function invalidateReflowRange(start: number, count: number): void {
  if (count <= 0) return;
  const end = start + count;
  reflowSegments = reflowSegments.filter(
    (segment) => end <= segment.start || start >= segment.start + segment.rowCount,
  );
}

function invalidateReflowAt(abs: number): void {
  invalidateReflowRange(abs, 1);
}

export function reset(): void {
  rows = [];
  curSgr = '';
  rowStartSgr = '';
  curRaw = '';
  hasCurrent = false;
  segMark = null;
  reflowSegments = [];
  nextSegmentId = 1;
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
  trimRows();
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
    reflowSegments = [];
    return;
  }
  // 当前行先 commit 再裁剪(否则 hasCurrent 边界会被打穿)
  if (hasCurrent) {
    rows.push(rowStartSgr + curRaw + '\x1B[0m');
    curRaw = '';
    rowStartSgr = curSgr;
    hasCurrent = false;
  }
  const start = rows.length - n;
  rows.splice(start);
  noteRowsDeleted(start, n);
}

/** 标记段起点:快照当前缓冲状态,供 setLines 截断定位段头(md 流式渲染每 chunk 截断重渲)。 */
export function beginSegment(): void {
  const reflowId = nextSegmentId++;
  segMark = { rowIdx: rows.length, rowStartSgr, curSgr, curRaw, hasCurrent, reflowId };
  reflowSegments.push({ id: reflowId, start: rows.length, rowCount: 0, source: '' });
}

/**
 * 用预渲染的自洽 ANSI 行替换当前段(从 segMark 起),供 markdown 流式渲染:
 * layout.contentWriteMd 每 chunk 把累积 text 经 renderMarkdown 渲成自洽行,调此替换缓冲段。
 * 截断 rows 到 segMark.rowIdx(擦上次渲染)+ push 新行;curSgr 复位为默认(行末 reset);
 * **保留 segMark**(下次 setLines 还要截断),由 commitSegment 清除。
 * 行须各自自洽(行内 SGR 自带、行末 reset)——不经 feedChar/feedSgr,直接入 rows,
 * 故 setLines 后 hasCurrent=false(snapshot 只返 rows;续写位由 layout 跟踪)。
 */
export function setLines(lines: string[], source?: string): void {
  if (segMark) {
    rows.length = segMark.rowIdx;
  }
  for (const line of lines) {
    rows.push(line);
  }
  if (segMark) {
    const segment = reflowSegments.find((item) => item.id === segMark?.reflowId);
    if (segment) {
      segment.start = segMark.rowIdx;
      segment.rowCount = lines.length;
      if (source !== undefined) segment.source = source;
    }
  }
  trimRows();
  curSgr = '';
  rowStartSgr = '';
  curRaw = '';
  hasCurrent = false;
}

/**
 * 按新列宽重排所有仍保有完整 markdown 源的段。
 *
 * 每个 change 的 start 都是应用前面 change 后的当前绝对行坐标，调用方可据此逐段修正
 * batch/选区等物理行索引。普通 contentWrite 行仍保持原物理行语义，不参与重排。
 */
export function reflowMarkdown(cols: number, render: (source: string, cols: number) => string[]): ReflowChange[] {
  const width = Math.max(1, Math.floor(cols));
  const changes: ReflowChange[] = [];
  for (const segment of [...reflowSegments].sort((a, b) => a.start - b.start)) {
    if (!segment.source) continue;
    const start = Math.max(0, Math.min(rows.length, segment.start));
    const oldCount = Math.max(0, Math.min(segment.rowCount, rows.length - start));
    const oldLines = rows.slice(start, start + oldCount);
    const next = render(segment.source, width);
    rows.splice(start, oldCount, ...next);
    const delta = next.length - oldCount;
    segment.start = start;
    segment.rowCount = next.length;
    if (delta !== 0 || oldLines.some((line, index) => line !== next[index])) {
      changes.push({
        start,
        oldCount,
        newCount: next.length,
        delta,
        oldLines,
        newLines: [...next],
      });
    }
    if (delta !== 0) {
      for (const later of reflowSegments) {
        if (later.id !== segment.id && later.start >= start + oldCount) later.start += delta;
      }
      if (segMark && segMark.reflowId !== segment.id && segMark.rowIdx >= start + oldCount) {
        segMark.rowIdx += delta;
      }
    }
  }
  const headTrim = trimRows();
  if (headTrim > 0) {
    // 头裁剪发生在所有段重排之后，调用方也必须按同一顺序更新绝对行索引。
    changes.push({
      start: 0,
      oldCount: headTrim,
      newCount: 0,
      delta: -headTrim,
      oldLines: [],
      newLines: [],
    });
  }
  // reflow 只替换已提交物理行；当前待写行必须原样保留。特别是正文后由 breakRow
  // 建出的 hasCurrent 空行，若在 resize 时被清掉，会让下一条工具摘要覆盖正文末行。
  return changes;
}

/** 提交段:清 segMark,后续写入不再被 setLines 截断(md 段结束、非 md 内容接续时调)。 */
export function commitSegment(): void {
  segMark = null;
}

/** 快照(已提交行 + 当前行若有)。viewport 取行窗用。 */
function snapshot(): string[] {
  return hasCurrent ? [...rows, rowStartSgr + curRaw + '\x1B[0m'] : rows;
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

/** 已提交行数(不含 hasCurrent 空行)。供续写位校正:breakRow 后 hasCurrent=true 时光标已在
 *  rows.length+1 位,若用 totalRows()+1 会多跳 1 行(2 空行 bug)。 */
export function committedRows(): number {
  return rows.length;
}

/** 当前流式 markdown 段在物理缓冲中的起点；无活跃段时返回 null。 */
export function activeSegmentStart(): number | null {
  return segMark?.rowIdx ?? null;
}

/** 当前待写物理行（含继承/行内 SGR，不含行末 reset）；无当前行时返回 null。 */
export function currentRowRaw(): string | null {
  return hasCurrent ? rowStartSgr + curRaw : null;
}

/** 确保存在一个空的当前待写行，但不新增已提交物理行。
 * 用于 one-shot markdown 直接灌入 rows 后恢复“下一次写入从正文下一行开始”的光标语义。 */
export function ensureCurrentRow(): void {
  if (hasCurrent) return;
  curSgr = '';
  rowStartSgr = '';
  curRaw = '';
  hasCurrent = true;
}

/** 把缓冲尾部的视觉空白行归一化为恰好 count 条，并结束在“无当前行”状态。
 * 供 markdown→mutation 边界使用；ANSI reset/颜色码和空格均按视觉空白处理。 */
export function normalizeTrailingBlankRows(count: number): void {
  if (hasCurrent) {
    rows.push(rowStartSgr + curRaw + '\x1B[0m');
  }
  const isBlank = (line: string): boolean => line.replace(/\x1b\[[0-9;]*m/g, '').trim().length === 0;
  while (rows.length > 0 && isBlank(rows[rows.length - 1])) rows.pop();
  for (let i = 0; i < Math.max(0, count); i++) rows.push('\x1B[0m');
  curSgr = '';
  rowStartSgr = '';
  curRaw = '';
  hasCurrent = false;
}

/** 取绝对行索引(0-based,含当前行)的原始自洽行;越界返 null。供鼠标选区文本提取。 */
export function lineAt(abs: number): string | null {
  const all = snapshot();
  return abs >= 0 && abs < all.length ? all[abs] : null;
}

/** 等长替换一条已提交物理行，供运行中的工具 batch 原地刷新摘要。 */
export function replaceLine(abs: number, line: string): void {
  if (abs < 0 || abs >= rows.length) return;
  rows[abs] = line.endsWith('\x1B[0m') ? line : line + '\x1B[0m';
  invalidateReflowAt(abs);
}

/**
 * 找「绝对行索引 < absStart 的最近一条用户消息」的文本(用于滚动回看时的「我刚发的
 * 请求」sticky banner)。算法:从 absStart - 1 往上扫,识别「用户气泡行」(由 repl
 * formatUserMessage 写入,剥 SGR 后首字符 = ❯);再从此行往下吞连续的同类行
 * 收集多行消息,join('\n')。
 *
 * 检测 user-bubble 行靠「剥 SGR 后以 ❯ 开头」而非 userBg SGR 前缀:rowStartSgr 继承自
 * 上一行末(可能残留 dim/cyan),且 bubble 起手有 userBg 包裹,直接 startsWith(userBg)
 * 在残留 rowStartSgr 场景会漏判。剥光所有 SGR 后 → 首字符稳定为 ❯ (repl.PROMPT)。
 *
 * 返回的文本已经剥离 ANSI + 提示符,可直接给 banner 渲染(再做截断 / 折叠)。
 * absStart ≤ 0 返 null(没东西在视口上方)。
 */
export function lastUserMessageBefore(absStart: number): string | null {
  if (absStart <= 0) return null;
  const all = snapshot();
  const SGR = /\x1B\[[0-9;]*m/g;
  const isUserBubbleRow = (row: string): boolean => {
    // 剥光 SGR 后首字符 = ❯(repl.PROMPT 首字)→ 是 user bubble;
    // agent 行首字符可能是 ● / ╭ / │ / 数字 / 字母,绝不会撞 ❯。
    const visible = row.replace(SGR, '');
    return visible.startsWith('❯');
  };
  // 1) 从 absStart - 1 往上扫,找第一条 user bubble 行(最近的 user-bubble 的最后一行)
  let bubbleEnd = -1;
  for (let i = Math.min(absStart, all.length) - 1; i >= 0; i--) {
    if (isUserBubbleRow(all[i])) {
      bubbleEnd = i;
      break;
    }
  }
  if (bubbleEnd < 0) return null;
  // 2) 往上找气泡起点(连续 user-bubble 行块 = 同一条 user 消息)
  let bubbleStart = bubbleEnd;
  while (bubbleStart - 1 >= 0 && isUserBubbleRow(all[bubbleStart - 1])) {
    bubbleStart--;
  }
  // 3) 收文本:按显示字符剥 SGR + 续行/末填充空格 + 首行 prompt
  //    首行剥前导 '❯ ' 序列 → banner 自己再加回 [banner_prompt] + <text>;
  //    一次剥光所有重复的 ❯(防止用户手敲 prompt / 多重回显 → 出现 '❯ ❯ ...' 双提示符)。
  const joinedText = all
    .slice(bubbleStart, bubbleEnd + 1)
    .map((raw, idx) => {
      let stripped = raw.replace(SGR, '');
      if (idx === 0) stripped = stripped.replace(/^(?:❯\s*)+/, ''); // 剥光所有前导 ❯(含每个后面的可选空格)
      return stripped.trimEnd();
    })
    .join('\n')
    .replace(/\n+$/, '');
  return joinedText || null;
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
 * 后置条件:插入后 hasCurrent 保持不变(若进来时 hasCurrent=true，则仍为 true),
 * curRaw 也保持不变 —— cursor 概念上跟到 inserted block 末尾,后续 contentWrite 自然续写。
 * 关键:不再"先 commit 当前行到 rows 末尾再 splice",那样会在 rows 末尾留下
 * 一条 was-current 孤儿空行,在后续 collapse 删除 inserted lines 时无法被对称清掉,
 * 导致下一段文本与该批之间多出 1 行视觉空白(用户报告:「展开又关闭工具信息后
 * 下面空两行」)。现在 leave cursor 不动，由调用方按需补 separator。
 * 例外：expandSingleEntryFully (mutation 自动展开) 在调用本函数后
 * 主动 layout.contentWrite('\n') 写 separator blank,
 * 因为 mutation 不走 flushToolBatch 的 \n。
 */
export function insertAfter(after: number, lines: string[]): void {
  if (lines.length === 0) return;
  // 修复:不再提交 was-current 行到 rows 末尾(避免后续 collapse 后留孤儿空白)。
  // cursor 留在原位置(指向 spliced block 之后);调用方按需显式 contentWrite('\n') 补 separator。
  const committed = rows.length;
  // after 是绝对行索引;若超过 committed(例如快照时 hasCurrent=true),钳到末尾
  const target = after < 0 ? 0 : Math.min(after + 1, committed);
  rows.splice(target, 0, ...lines);
  noteRowsInserted(target, lines.length);
  // 流式 md 段活跃期间:插入点在段起点之前 → segMark.rowIdx 平移,
  // 否则下一个 md chunk 的 setLines 截断到旧位置,展开行被砍掉。
  if (segMark && target <= segMark.rowIdx) {
    segMark.rowIdx += lines.length;
  }
  trimRows();
}

/**
 * 从绝对行索引 startIdx(0-based,已 commit)起删 n 行。
 * 用于「已展开明细折回摘要」——把详情行从中段裁掉,保留摘要行和后续内容。
 * startIdx 越界或 n <= 0 直接 no-op。
 *
 * 不动当前行(同 insertAfter 修复后的语义):cursor 概念上仍指向 spliced
 * 区间后的同一绝对位置(若 startIdx+1+lines 数 ≥ 新 rows.length,curRaw
 * 代表的就是 spliced 区间内的逻辑行,内容保留)。
 * 后置条件:hasCurrent 与 curRaw 与调用前一致。
 */
export function deleteFrom(startIdx: number, n: number): void {
  if (n <= 0) return;
  // 修复：保持与 insertAfter 对称——不动 hasCurrent/curRaw，避免 splice 后
  // 把 was-current 空行当成普通行 commit 变成孤儿（与 insertAfter 的孤儿
  // bug 是同一个根因的两个对称面）。
  const committed = rows.length;
  if (startIdx >= committed) return;
  const end = Math.min(startIdx + n, committed);
  const actual = end - startIdx;
  rows.splice(startIdx, actual);
  noteRowsDeleted(startIdx, actual);
  // 流式 md 段活跃期间:删除区间全部在段起点之前 → segMark.rowIdx 回退,
  // 否则下一个 md chunk 的 setLines 截断到旧位置,段内容错位。
  if (segMark && startIdx + actual <= segMark.rowIdx) {
    segMark.rowIdx -= actual;
  }
}

/**
 * 在绝对行索引 startIdx(0-based,已 commit)起**等长替换**为新行(lines.length 必须等于
 * 原区间行数;调用方负责等长,以维持 banner 等「顶部固定行」语义不变)。
 *
 * 用途:layout.writeBanner / rewriteBanner 把 buffer [0, bannerH) 替换为新的自洽行,
 * repaintViewport 自然从 rows[] 头部读出新版 banner,无需 layout 介入。
 *
 * 不动 hasCurrent(行已 commit);若 segMark 在替换区间内,segMark.rowIdx 减至 startIdx
 * (段起点被覆盖)。segMark 在区间前方不动(不在此类用法出现)。
 *
 * 长度不一致直接报错并 no-op(避免静默错位):允许调用方传不同长度时改用 insertAfter + deleteFrom。
 */
export function replaceHead(startIdx: number, lines: string[]): void {
  if (!Number.isInteger(startIdx) || startIdx < 0) {
    throw new Error(`replaceHead: startIdx 必须 ≥ 0 整数,实得 ${startIdx}`);
  }
  if (lines.length === 0) return; // 空替换 = no-op(0 行删 0 行)
  if (hasCurrent) {
    rows.push(rowStartSgr + curRaw + '\x1B[0m');
    curRaw = '';
    rowStartSgr = curSgr;
    hasCurrent = false;
  }
  const committed = rows.length;
  if (startIdx >= committed) {
    throw new Error(
      `replaceHead: startIdx=${startIdx} 超出已 commit 行数 ${committed}(调用方必须保证等长替换且 startIdx 在 buffer 内)`,
    );
  }
  const end = Math.min(startIdx + lines.length, committed);
  const actualOld = end - startIdx;
  if (actualOld !== lines.length) {
    throw new Error(`replaceHead: 行数不匹配(startIdx=${startIdx},新区间 ${actualOld} 行 ≠ 新行 ${lines.length} 行)`);
  }
  // splice 等长替换:rows.length 不变,segMark 若在区间前方不受影响,区间内被覆盖时平移到 startIdx
  rows.splice(startIdx, lines.length, ...lines);
  if (segMark) {
    const m = segMark.rowIdx;
    if (m >= startIdx && m < end) {
      segMark.rowIdx = startIdx; // 段起点被覆盖 → 重锚到区间头
    }
  }
}
