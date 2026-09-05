/**
 * 工具调用批量折叠渲染:
 *   agent 一轮返回 N 个 tool_calls 时,不逐个打印 `● name ↳ result`,
 *   改输出一行摘要 `● Ran N tools · read 3, grep 1, glob 1`;
 *   鼠标点击该摘要行 → 展开完整明细(● 头 + ↳ preview / diff 块),再点折回。
 *
 * 设计要点:
 *  - 实时执行 + renderHistory 回放共用本渲染器;
 *  - 仅 buffer 写一行,详情行展开时才插入(mid-buffer insert via layout.contentInsertAfter);
 *  - 默认折叠;展开/折叠不影响历史回放的 history 结构(history 仍存完整 tool_calls+tool 消息)。
 *
 * 状态全模块级(单实例)——一次 REPL 内所有 batch 共享,清内容区 / 退 alt 屏时统一重置。
 */

import { ui } from './theme.js';
import { t } from '../i18n/index.js';
import { truncateAnsi } from './render.js';

/** 一条工具调用在批内的展示数据(由 agent 的 hooks 累积,endBatch 时收尾)。 */
export interface BatchEntry {
  name: string;
  /** summarizeToolCall(name, args):单行参数摘要(路径/模式/命令)。 */
  callSummary: string;
  /** summarizeToolResult(name, output):单行结果预览(行数/匹配数/首行)。mutation 工具为 ''。 */
  resultSummary: string;
  /** mutation 工具的成功 diff 块全文(由 renderFileChange 渲染出的多行 ANSI);非 mutation 为 null。
   *  错误或非 mutation 走 resultSummary 的灰字 preview 行。 */
  diffBlock: string | null;
  /** 工具完整原始输出(纯文本,无 ANSI)。展开时显示完整内容;缺省时退化为 resultSummary 单行。 */
  fullOutput?: string;
  failed?: boolean;
  /** 结果已回填。不能只看 resultSummary 是否非空——sub-agent 等工具的 preview 可能为空串,
   *  那样摘要行会永远停在 ◇「正在探索」(用户实测:子 agent 跑完主侧菱形不变实心圆)。 */
  done?: boolean;
  /** 该 entry 明细行上次渲染时的结果摘要指纹(运行态原位刷新用):
   *  结果晚于渲染到达时,据此判定需 contentReplaceLine 更新明细行,避免展开视图停留在「无结果」。 */
  renderedDigest?: string;
}

/** entry 是否已拿到结果。历史回放构造的 entry 无 done 字段,退化按内容判定。 */
function isEntryDone(e: BatchEntry): boolean {
  return e.done === true || !!e.resultSummary || !!e.diffBlock || !!e.failed;
}

/** 一个 LLM 步的工具调用 batch 记录。 */
interface BatchRecord {
  id: string;
  summaryAbsIdx: number; // 摘要行在 content buffer 中的绝对索引
  entries: BatchEntry[];
  /** 第二层中已展开完整输出的 entry 下标。 */
  expandedEntries: Set<number>;
  /** 已渲染明细的 entry 数量(第一层,每 entry 恰好 1 行)。
   *  运行态(子 agent 逐条追加)下 < entries.length;折叠/重建时按它删除,避免多删并行批。 */
  renderedCount: number;
  startedAt: number;
  finishedAt?: number;
  /** 自定义摘要行标签(子 agent 批用);缺省按完成态取 agent.tools*。 */
  label?: string;
  /** 摘要行额外缩进(子批嵌套在父行下,视觉体现从属)。 */
  indent?: string;
  /** 父批 id(子 agent 批 → 主侧 sub-agent 组容器批)。
   *  有父批时摘要行不追加到 buffer 末尾,而是插到父批已渲染块的正下方——
   *  并行派发多个子 agent 时,每个子 agent 的工具明细才会各归各的父行。 */
  parentId?: string;
  /** 组容器批(sub-agent 组):entries 都是 sub-agent 调用,展开后逐行显示 └─ sub-agent {...}。
   *  组容器批本身不记录工具,只为并行派发的子 agent 提供一个共享顶层摘要行
   *  (● 探索 N ... sub-agent N) 与嵌套层级。 */
  groupParent?: boolean;
  /** 本批作为组子批(groupParent 的子层)时,在父组 entries 中的序号;
   *  决定子批摘要行插入锚点(插到对应 └─ sub-agent 行下方)。 */
  groupChildIndex?: number;
  /** 运行态标志(子 agent 批用):即便已记录的 entry 全部完成,只要子 agent 还在跑,
   *  摘要行就用「运行中」专属图标(而非 ●),与真正完成态区分。finishLiveBatch 收尾时清掉。 */
  running?: boolean;
}

/** 子 agent 运行中的专属图标:与完成态的实心 ● 区分,也区别于父层「探索」运行态的 ◇。 */
const RUNNING_GLYPH = '◐';

const batches = new Map<string, BatchRecord>();
/** 绝对行索引 → 所属 batch id(仅记录 summary 行;用于鼠标点击反查)。
 *  buffer 行数变化时本表可能漂移——但只在 insertAfter/deleteFrom 后由本模块同步更新,
 *  并保持 buffer 当前状态对应。 */
const absLineToBatchId = new Map<number, string>();
/** 第一层展开后，工具概要行的绝对索引 → 对应 entry。 */
const absLineToEntry = new Map<number, { batchId: string; entryIndex: number }>();
/** 已展开第一层工具列表的 batch id。 */
const expandedBatches = new Set<string>();
/** tool_call id → 所属 batch(主侧每次 onToolHeader 都登记)。
 *  结果按 id 归位(并行时 currentBatchId 会漂移,按 id 查才不串批);
 *  子 agent 建批时据此反查父批,把子批摘要行插到父批正下方。reset() 统一清理。 */
const callToBatch = new Map<string, string>();
/** sub-agent 组:tool_call id → 在组容器批 entries 中的序号。
 *  spawn.ts 建子批时据此把子批摘要行插到正确的 └─ sub-agent 行下方。reset() 统一清理。 */
const groupChildIndexByCall = new Map<string, number>();

/** 展开时完整输出的最大行数;超出截断,避免巨型输出撑爆 viewport。 */
const MAX_EXPAND_LINES = 200;

/** 自洽行允许的最大显示宽(= 终端 cols)。buffer 行超 cols 会被终端 auto-wrap,
 *  物理行与缓冲行失配 → repaintViewport 的 CUP 寻址全错(屏幕错乱)。 */
let maxCols = 200;

/** layout 在进 alt 屏 / SIGWINCH 时调,同步当前终端列宽供行宽钳制。 */
export function setMaxCols(n: number): void {
  if (Number.isFinite(n) && n >= 8) maxCols = Math.floor(n);
}

/** 行内控制字符(NUL/BEL/TAB 等,常见于 grep 扫到二进制)替换为可见替代符。
 *  必须保护 SGR 序列:行已带 ui.* 颜色码,裸 replace 会把 \x1B 一并替换、
 *  毁掉转义序列(显示成字面 "[90m")。按 SGR 切分后只清洗文本段。 */
function visibleControl(s: string): string {
  return s
    .split(/(\x1b\[[0-9;]*m)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/[\x00-\x1f\x7f]/g, '·')))
    .join('');
}

/** 自洽行统一收尾:行宽钳到 cols + 行末补 reset。
 *  纯函数导出供行宽/控制字符不变量测试；生产渲染默认传模块当前 maxCols。 */
export function sanitizeRow(s: string, cols = maxCols): string {
  const cleaned = visibleControl(s);
  return truncateAnsi(cleaned, cols) + '\x1B[0m';
}

export function isMutationToolName(name: string): boolean {
  return name === 'write_file' || name === 'edit_file';
}

/** 通知 buffer 整体清空(clearContent / exitAltScreen / 新一轮 turn)——本模块状态同步归零。 */
export function reset(): void {
  batches.clear();
  absLineToBatchId.clear();
  absLineToEntry.clear();
  expandedBatches.clear();
  callToBatch.clear();
  groupChildIndexByCall.clear();
}

/** 新建一个 batch(在 agent 拿到第一条 onToolHeader 时调)。返回 id。
 *  label 可选:自定义摘要行标签(子 agent 批用),缺省按完成态取 agent.tools*。
 *  opts.indent/parentId:子批嵌套渲染(摘要行缩进 + 插到父批下方)。
 *  opts.groupParent:组容器批(并行 sub-agent 共享顶层摘要行)。
 *  opts.groupChildIndex:本批作为组子批时在父 entries 中的序号(插入锚点用)。 */
export function beginBatch(
  label?: string,
  opts?: {
    indent?: string;
    parentId?: string;
    groupParent?: boolean;
    groupChildIndex?: number;
    running?: boolean;
  },
): string {
  const id = `b${++_idCounter}`;
  batches.set(id, {
    id,
    summaryAbsIdx: -1,
    entries: [],
    expandedEntries: new Set(),
    renderedCount: 0,
    startedAt: Date.now(),
    label,
    indent: opts?.indent,
    parentId: opts?.parentId && batches.has(opts.parentId) ? opts.parentId : undefined,
    groupParent: opts?.groupParent ?? false,
    groupChildIndex: opts?.groupChildIndex,
    running: opts?.running ?? false,
  });
  return id;
}

/** 登记 tool_call id → 所属 batch。结果回填按 id 归位(并行时 currentBatchId 会漂移),
 *  子 agent 也据此反查父批。 */
export function bindCall(callId: string, batchId: string): void {
  if (callId) callToBatch.set(callId, batchId);
}

/** tool_call id → 所属 batch id;未登记返 null。 */
export function batchIdForCall(callId: string | undefined): string | null {
  if (!callId) return null;
  const id = callToBatch.get(callId);
  return id && batches.has(id) ? id : null;
}

/** 记一条工具调用(在 onToolHeader 时调,与 setEntryResult 配对;entries 顺序 = agent 调用顺序)。
 *  callId 可选:组容器批据此把 sub-agent 调用归到 entries 的固定序号(供子批插入锚点反查)。 */
export function recordCall(id: string, name: string, callSummary: string, callId?: string): void {
  const b = batches.get(id);
  if (!b) return;
  // 已完成的累计探索后又追加工具：恢复进行中，待新结果返回再完成。
  b.finishedAt = undefined;
  b.entries.push({ name, callSummary, resultSummary: '', diffBlock: null });
  if (callId && b.groupParent) groupChildIndexByCall.set(callId, b.entries.length - 1);
}

/** 查询某 sub-agent 调用在所属组容器批 entries 中的序号(供 spawn.ts 建子批时定锚点)。 */
export function getGroupChildIndex(callId: string | undefined): number {
  if (!callId) return 0;
  const v = groupChildIndexByCall.get(callId);
  return v == null ? 0 : v;
}

/** 批是否所有 entry 都已拿到结果(空批视为完成)。 */
export function isBatchComplete(id: string): boolean {
  const b = batches.get(id);
  if (!b) return false;
  return b.entries.length > 0 && b.entries.every(isEntryDone);
}

/** 记一条工具结果(diff 块或单行 preview);agent 在 onToolResult 时调,匹配最后一条未填的 entry。
 *  fullOutput:工具原始完整输出(纯文本),展开时显示;mutation 工具的 diff 块已自含无需传。
 *  callId:组容器批用,直接把结果填到对应 entry(避免多个 sub-agent 同名时反向匹配错位)。 */
export function recordResult(
  id: string,
  name: string,
  resultSummary: string,
  diffBlock: string | null,
  fullOutput?: string,
  failed = false,
  callId?: string,
): void {
  const b = batches.get(id);
  if (!b || b.entries.length === 0) return;
  // 组容器批:优先按 callId 定位 entry,防止多个同名 sub-agent 结果互相填错位置。
  if (callId && b.groupParent) {
    const idx = groupChildIndexByCall.get(callId);
    if (idx != null && idx < b.entries.length && !isEntryDone(b.entries[idx])) {
      const e = b.entries[idx];
      e.resultSummary = resultSummary;
      e.diffBlock = diffBlock;
      e.fullOutput = fullOutput;
      e.failed = failed;
      e.done = true;
      if (b.entries.every(isEntryDone)) b.finishedAt = Date.now();
      return;
    }
  }
  // 反向找最后一条同名的 entry 填结果;同名工具一批多次调用时正向遍历更安全——用 lastIndexOf 同名回退
  for (let i = b.entries.length - 1; i >= 0; i--) {
    if (b.entries[i].name === name && !isEntryDone(b.entries[i])) {
      b.entries[i].resultSummary = resultSummary;
      b.entries[i].diffBlock = diffBlock;
      b.entries[i].fullOutput = fullOutput;
      b.entries[i].failed = failed;
      b.entries[i].done = true;
      if (b.entries.every(isEntryDone)) b.finishedAt = Date.now();
      return;
    }
  }
  // 兜底:无匹配则填最后一条
  const last = b.entries[b.entries.length - 1];
  if (!isEntryDone(last)) {
    last.resultSummary = resultSummary;
    last.diffBlock = diffBlock;
    last.fullOutput = fullOutput;
    last.failed = failed;
    last.done = true;
    if (b.entries.every(isEntryDone)) b.finishedAt = Date.now();
  }
}

// ── 摘要行文本生成 ──

/** 把 entry 列表压缩成一行摘要。 */
function buildSummaryLine(record: BatchRecord, live = false): string {
  const prefix = record.indent ?? '';
  const entries = record.entries;
  if (entries.length === 0) {
    return `${prefix}  ${ui.dim}│${ui.reset} ${ui.bold}${ui.accent}◇${ui.reset} ${ui.dim}No tools${ui.reset}`;
  }
  // N>1:同类合并 "read_file 3, glob 1, grep 1"
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const parts: string[] = [];
  for (const [n, c] of counts) parts.push(`${n} ${c}`);
  const completed = entries.filter(isEntryDone).length;
  const failedCount = entries.filter((e) => e.failed).length;
  // 工具本身完成就立即显示完成态，不等待整轮正文流完/onDone。
  // 单项失败不代表整批失败：执行中优先展示进度；完成后区分部分失败与全部失败。
  const finished = completed >= entries.length;
  const allFailed = finished && failedCount === entries.length;
  const partiallyFailed = finished && failedCount > 0 && !allFailed;
  const symbol = record.running ? RUNNING_GLYPH : !finished ? '◇' : allFailed ? '×' : partiallyFailed ? '!' : '●';
  const color = record.running
    ? ui.accent
    : !finished
      ? ui.accent
      : allFailed
        ? ui.red
        : partiallyFailed
          ? ui.yellow
          : ui.green;
  const label = !finished ? t('agent.toolsRunning') : allFailed ? t('agent.toolsFailed') : t('agent.toolsComplete');
  const progress = live && !finished ? `  ${completed}/${entries.length}` : `  ${entries.length}`;
  const elapsedMs = record.finishedAt ? record.finishedAt - record.startedAt : 0;
  const elapsed = record.finishedAt ? `  ${elapsedMs < 100 ? '<0.1s' : `${(elapsedMs / 1000).toFixed(1)}s`}` : '';
  const displayLabel = record.label ?? label;
  return `${prefix}  ${ui.bold}${color}${symbol}${ui.reset} ${displayLabel}${progress}${elapsed}  ${ui.dim}${parts.join('  ')}${ui.reset}`;
}

// ── 展开/折叠 ──

/** 把 batch 的详情行展开成自洽行数组(供 layout.contentInsertAfter 走 mid-buffer 插入)。
 *  每行末尾必须以 \x1B[0m 收尾(SGR 自洽模型),行内允许含 SGR(行末 reset 不影响行内样式),
 *  但**绝不**带 \n——rows[] 是行数组,不是流输出。 */
function buildEntryDetailLines(e: BatchEntry, indent = '      '): string[] {
  const lines: string[] = [];
  if (e.diffBlock) {
    // diff 块多行文本(由 renderFileChange 渲染);按 \n 拆成物理行,
    // 每行单独入 rows[]。行末 reset 由本函数统一追加(若原行已带 reset,终端合并即可)。
    const block = e.diffBlock.endsWith('\n') ? e.diffBlock : e.diffBlock + '\n';
    for (const line of block.split('\n')) {
      if (line === '' && lines.length > 0 && lines[lines.length - 1] === '') continue; // 折叠连续空行
      if (line === '' && lines.length > 0) continue; // 跳过首尾空行(diff 头/尾换行)
      const prefixed = `${ui.dim}${indent}${ui.reset}${line}`;
      lines.push(sanitizeRow(prefixed));
    }
  } else if (e.fullOutput) {
    // 完整工具输出(纯文本):按行展开,每行缩进 + dim 样式;长输出截断到 MAX_EXPAND_LINES 行。
    // 每行经 sanitizeRow 钳宽:fullOutput 可能含 grep 扫二进制(db/压缩文件)得到的
    // 超长行 + 控制字符,不钳会让终端 auto-wrap 打乱屏位。
    const rawLines = e.fullOutput.split('\n');
    const truncated = rawLines.length > MAX_EXPAND_LINES;
    const displayLines = truncated ? rawLines.slice(0, MAX_EXPAND_LINES) : rawLines;
    for (const line of displayLines) {
      lines.push(sanitizeRow(`${indent}${ui.gray}${line}${ui.reset}`));
    }
    if (truncated) {
      lines.push(sanitizeRow(`${indent}${ui.dim}… (${rawLines.length - MAX_EXPAND_LINES} more lines)${ui.reset}`));
    }
  } else if (e.resultSummary) {
    // 用 · 而非 ↳:entry 行尾已内联同一串,详情区再画一遍箭头会被读成「又一条子结果」;
    // · 只表达「这是结论文本」,与 diff 块、fullOutput 原始输出行在视觉上分属三档。
    lines.push(
      sanitizeRow(`${indent}${ui.dim}${DETAIL_RESULT_MARK}${ui.reset}${ui.gray}${e.resultSummary}${ui.reset}`),
    );
  }
  return lines;
}

/**
 * entry 第一层明细行的渲染指纹:指纹变则原位重画该行(驱动运行态结果回填)。
 * 纳入 fullOutput **有无**(而非内容):hasEntryDetail 看它来决定画不画三角——
 * 缺了它,「调用时无结果(空白占位)→ 结果回填」这一步不会重画,三角永远不出现。
 * 只取有无不取内容:完整输出可能上万字符,拼进指纹是浪费,且其内容不影响 entry 行渲染。
 */
function entryLineDigest(e: BatchEntry): string {
  return `${e.resultSummary}\u0001${e.diffBlock ? '1' : '0'}\u0001${e.fullOutput ? '1' : '0'}\u0001${e.failed ? '1' : '0'}`;
}

/**
 * 第二层展开三角:折叠 ▸ / 展开 ▾。替代原先的 ├─ / └─。
 *
 * 根因是**字体实现差异,不是 Unicode 分类差异**——两者 East Asian Width 同为
 * Ambiguous(U+2500–257F Box Drawing 与 U+25A0–25FF Geometric Shapes 整块都是 A):
 *  `render.ts: charWidth()` 对 Ambiguous 一律按 1 列算,但部分等宽字体为让竖线连续,
 *  常把 Box Drawing 做成占 2 格的字形(尤其中文字体里 box drawing 取自全角字库)。
 *  → sanitizeRow/truncateAnsi 钳宽失准 → 物理行超 cols → 终端 auto-wrap
 *  → repaintViewport 的 CUP 寻址全错(整屏错位)。
 *
 * 换 Geometric Shapes 的依据是**实测**:同一终端下 `●`(U+25CF) 与 `◇`(U+25C7)
 * 长期渲染正常,而 `├─`/`└─` 错位——即本机字体对 Geometric Shapes 按 1 列、
 * 对 Box Drawing 按 2 列。故与 `●` 同族的 ▸/▾ 是安全选择。
 *
 * 注:Ambiguous 终究依赖字体。若要零风险,用 Latin-1 的 `·`(U+00B7, EAW=Na)。
 */
const CARET_COLLAPSED = '▸';
const CARET_EXPANDED = '▾';
/** 无详情可展开时占位,保持与 "▸ " 同宽,让工具名列对齐。 */
const CARET_NONE = '  ';

/** 详情行缩进:统一 7 空格(对齐 entry 行的 "    ▸ " 之后再右移一列,形成层次)。 */
const DETAIL_INDENT = '       ';

/**
 * 详情行结果标记:·(U+00B7 MIDDLE DOT, Latin-1 Supplement, **EAW = Narrow**)。
 * 比 ▸/▾ 更稳——Narrow 是 Unicode 层面的硬保证,不依赖字体对 Ambiguous 的取舍。
 *
 * 不用 entry 行尾那个 `↳`:①entry 行已内联同一串结果,详情区再原样输出一遍纯属重复;
 * ②`↳`(U+21B3) 属 Arrows 块、EAW 同样是 Ambiguous。
 */
const DETAIL_RESULT_MARK = '· ';

/** entry 是否有可展开的详情行。须与 buildEntryDetailLines 的分支一致,
 *  否则会画出点了没反应的三角(toggleEntry 对空 details 直接 return)。 */
function hasEntryDetail(e: BatchEntry): boolean {
  return Boolean(e.diffBlock || e.fullOutput || e.resultSummary);
}

/** entry 行的展开三角(含尾随空格与配色)。折叠 dim、展开 accent,一眼区分当前态。 */
function entryCaret(e: BatchEntry, expanded: boolean): string {
  if (!hasEntryDetail(e)) return CARET_NONE;
  return expanded ? `${ui.accent}${CARET_EXPANDED}${ui.reset} ` : `${ui.dim}${CARET_COLLAPSED}${ui.reset} `;
}

/**
 * 单条第一层明细行。三角由 entry 自身的详情展开态决定(▸ 可展开 / ▾ 已展开 / 空白占位),
 * 不再依赖 isLast —— 兄弟条目间没有嵌套语义,画分支符(├─/└─)纯属误导且引入宽度歧义。
 */
export interface BatchExpandedRenderInput {
  entries: readonly BatchEntry[];
  expandedEntries: ReadonlySet<number>;
}

function buildEntryLine(b: BatchExpandedRenderInput, index: number, extraIndent = '', cols = maxCols): string {
  const e = b.entries[index];
  const result = e.resultSummary ? `  ${ui.gray}↳ ${e.resultSummary}${ui.reset}` : '';
  const caret = entryCaret(e, b.expandedEntries.has(index));
  const failure = e.failed ? `${ui.red}×${ui.reset} ` : '';
  return sanitizeRow(
    `${extraIndent}    ${caret}${failure}${ui.accent}${e.name}${ui.reset}  ${ui.dim}${e.callSummary}${ui.reset}${result}`,
    cols,
  );
}

/** 第一层只展示有哪些调用及其简短结果，不展开完整输出。extraIndent 供子批嵌套加深缩进。
 *  fromIndex:运行态追加渲染时只产出 entries[fromIndex, ...) 的行(已渲染的不能重复输出)。 */
export function buildExpandedLines(
  b: BatchExpandedRenderInput,
  extraIndent = '',
  fromIndex = 0,
  cols = maxCols,
): string[] {
  const out: string[] = [];
  const start = Math.max(0, Math.min(b.entries.length, Math.floor(fromIndex)));
  for (let i = start; i < b.entries.length; i++) out.push(buildEntryLine(b, i, extraIndent, cols));
  return out;
}

/** 详情行缩进(现在与 index 无关,统一常量;保留签名以免调用点全改)。 */
function entryDetailIndent(_entries: BatchEntry[], _index: number): string {
  return DETAIL_INDENT;
}

/** 在 batch 收尾时(onToolBatchEnd):写摘要行 + 登记 summaryAbsIdx;若已展开(回放场景)立即插详情。 */
export function endBatch(
  id: string,
  layout: {
    contentWrite(s: string): void;
    contentReplaceLine?(absIdx: number, line: string): void;
    contentInsertAfter(after: number, lines: string[]): void;
    totalRows(): number;
  },
): void {
  const b = batches.get(id);
  if (!b) return;
  b.finishedAt ??= Date.now();
  if (b.summaryAbsIdx >= 0) {
    layout.contentReplaceLine?.(b.summaryAbsIdx, buildSummaryLine(b));
    // 点击命中在 showLiveBatch 首次落盘时即已登记(运行态可展开);这里幂等重登,
    // 并把摘要行刷成最终完成态文案。
    absLineToBatchId.set(b.summaryAbsIdx, b.id);
    return;
  }
  // 子批尚未落盘(组容器折叠期间被隐藏 / 折叠后才新建)。绝不能 contentWrite 到 buffer 末尾:
  // 那会在正文区留下一条游离的子 agent 摘要行,父批再展开时就变成「多出来的第三条」。
  if (b.parentId) {
    const parent = batches.get(b.parentId);
    if (parent?.groupParent) {
      // 父批折叠中:不渲染,等 expand() 统一恢复(那时会用最新状态重建摘要行)。
      if (!expandedBatches.has(parent.id) || parent.summaryAbsIdx < 0) return;
      // 父批已展开:插到自己的 └─ sub-agent 行下方。
      const anchor = findParentEntryAbsLine(parent.id, b.groupChildIndex ?? 0) ?? parent.summaryAbsIdx;
      layout.contentInsertAfter(anchor, [sanitizeRow(buildSummaryLine(b))]);
      b.summaryAbsIdx = anchor + 1;
      absLineToBatchId.set(b.summaryAbsIdx, b.id);
      return;
    }
  }
  const summary = buildSummaryLine(b);
  // 写摘要行(以 \n 收尾;contentWrite 会 breakRow 让其成为完整物理行)
  layout.contentWrite(summary + '\n');
  // 摘要行绝对索引 = totalRows - 2(hasCurrent 那行是新空行)
  b.summaryAbsIdx = Math.max(0, layout.totalRows() - 2);
  absLineToBatchId.set(b.summaryAbsIdx, b.id);
}

/**
 * 工具执行中立即显示/刷新摘要,并登记点击命中——运行态即可展开/折叠(此前只在
 * endBatch 收尾后开放,导致「连续无正文的工具链」在整轮结束前无法展开,用户报告痛点)。
 * 展开态下由 syncLiveExpanded 保持明细视图与新 entry/结果同步。
 */
export function showLiveBatch(
  id: string,
  layout: {
    contentWrite(s: string): void;
    contentReplaceLine(absIdx: number, line: string): void;
    contentInsertAfter?(after: number, lines: string[], keepViewport?: boolean): void;
    totalRows(): number;
    repaintViewport?(): void;
    /** 查询当前是否处于滚动回看状态(scrollOffset > 0)，用于避免冻结视口下无效重画 */
    isScrolled?(): boolean;
  },
): void {
  const b = batches.get(id);
  if (!b) return;
  const summary = buildSummaryLine(b, true);
  if (b.summaryAbsIdx < 0) {
    // 子批:摘要行插到父批已渲染块的正下方(而非 buffer 末尾),
    // 让「子 agent 的工具明细」始终跟在自己的父调用行下——并行派发时才不串行。
    const parent = b.parentId ? batches.get(b.parentId) : undefined;
    if (parent && parent.summaryAbsIdx >= 0 && layout.contentInsertAfter) {
      // 组容器父批处于折叠态时,子批摘要行先不渲染;等父批展开时由 expand 统一恢复,
      // 避免子批摘要残留在父批明细区、再次展开后出现重复行。
      if (parent.groupParent && !expandedBatches.has(parent.id)) {
        b.summaryAbsIdx = -1;
        return;
      }
      let anchor: number;
      if (parent.groupParent && b.groupChildIndex != null && expandedBatches.has(parent.id)) {
        // 组容器已展开:子 agent 工具批插到第 groupChildIndex 个 └─ sub-agent 行下方。
        // 不能用固定偏移 summaryAbsIdx+1+childIndex——前面兄弟子批的内容会把它后面的
        // entry 行整体下移,固定偏移会错位;用 absLineToEntry 登记的真实绝对索引。
        let entryAbs = parent.summaryAbsIdx + 1 + b.groupChildIndex;
        for (const [idx, target] of absLineToEntry) {
          if (target.batchId === parent.id && target.entryIndex === b.groupChildIndex) {
            entryAbs = idx;
            break;
          }
        }
        anchor = entryAbs;
      } else {
        anchor = parent.summaryAbsIdx + (expandedBatches.has(parent.id) ? parent.renderedCount : 0);
      }
      layout.contentInsertAfter(anchor, [sanitizeRow(summary)], false);
      b.summaryAbsIdx = anchor + 1;
      absLineToBatchId.set(b.summaryAbsIdx, b.id); // 运行态同样开放点击(endBatch 幂等重登)
      return;
    }
    layout.contentWrite(summary + '\n');
    b.summaryAbsIdx = Math.max(0, layout.totalRows() - 2);
    absLineToBatchId.set(b.summaryAbsIdx, b.id); // 运行态同样开放点击
    // 首条摘要通过增量 contentWrite 落屏时，markdown→普通内容的边界可能只更新了
    // buffer/续写位；直到第二个 header 的 contentReplaceLine 或后续正文重绘才完全可见。
    // 立即按 buffer 原子重画，确保慢工具执行期间摘要前的空行已经显示。
    // 但滚动回看时(scrollOffset>0) contentWrite 只喂缓冲+冻结视口，此时 repaintViewport
    // 会画出不含新摘要的冻结窗口（新摘要在窗口之下），造成闪烁；跳过重画，
    // 等用户回底(scrollOffset=0)时自然可见。修复 rollback 后工具信息滚动消失问题。
    if (!layout.isScrolled?.()) {
      layout.repaintViewport?.();
    }
  } else {
    layout.contentReplaceLine(b.summaryAbsIdx, summary);
  }
  // 展开态的运行态同步:已渲染 entry 的结果回填原位替换 + 新 entry 追加。
  syncLiveExpanded(b, layout);
}

/** 展开态 batch 的运行态同步(每次 showLiveBatch 后调):不展开/未落盘时 no-op。 */
function syncLiveExpanded(
  b: BatchRecord,
  layout: {
    contentReplaceLine(absIdx: number, line: string): void;
    contentInsertAfter?(after: number, lines: string[], keepViewport?: boolean): void;
  },
): void {
  if (!expandedBatches.has(b.id) || b.summaryAbsIdx < 0) return;
  // ① 已渲染 entry 的结果晚于渲染到达 → 原位替换该明细行(否则展开视图永远停在「无结果」)。
  for (let i = 0; i < b.renderedCount && i < b.entries.length; i++) {
    const e = b.entries[i];
    const digest = entryLineDigest(e);
    if (e.renderedDigest === digest) continue;
    const abs = findParentEntryAbsLine(b.id, i);
    if (abs == null) continue;
    layout.contentReplaceLine(abs, buildEntryLine(b, i, b.indent ?? ''));
    e.renderedDigest = digest;
  }
  // ② 新 entry(运行态 recordCall 后)追加到明细区末尾。
  const ins = layout.contentInsertAfter;
  if (ins && b.entries.length > b.renderedCount) {
    refreshBatchExpanded(b.id, { contentInsertAfter: ins });
  }
}

/** 绝对行索引 → 命中 batch id(用于鼠标 release 反查);非摘要行返 null。 */
export function findBatchByAbsLine(absLine: number): string | null {
  return absLineToBatchId.get(absLine) ?? null;
}

/** 当前 batch 是否已展开。 */
export function isExpanded(id: string): boolean {
  return expandedBatches.has(id);
}

/** 展开 batch 第一层(逐条工具调用)。供子 agent 实时运行态:执行中逐条展示。
 *  live=true 时不锚定视口(实时输出跟随底部),区别于鼠标点击展开(保持视口不跳)。 */
export function expandBatch(
  id: string,
  layout: { contentInsertAfter(after: number, lines: string[], keepViewport?: boolean): void },
  live = false,
): void {
  const b = batches.get(id);
  if (b && !expandedBatches.has(id)) expand(b, layout, live);
}

/**
 * 展开态下**追加渲染**新增的明细行(子 agent 逐条追加工具时用)。
 * 只插入 entries[renderedCount, ...) 中尚未渲染的条目,绝不重建——运行态下
 * 并行多个批时,重建会按 entries.length 删除,误删其它子 agent 的批行。
 * 未展开则 no-op。
 */
export function refreshBatchExpanded(
  id: string,
  layout: {
    contentInsertAfter(after: number, lines: string[], keepViewport?: boolean): void;
  },
): void {
  const b = batches.get(id);
  if (!b || !expandedBatches.has(id)) return;
  if (b.summaryAbsIdx < 0) return; // 摘要行未落盘(父组容器折叠中):无处可挂,等展开时统一渲染
  if (b.entries.length <= b.renderedCount) return;
  const newEntries = b.entries.slice(b.renderedCount);
  const lines = buildExpandedLines(b, b.indent ?? '', b.renderedCount);
  // 实时追加:不锚定视口,让新明细行自然出现在屏底。
  // 组容器批的 entry 与子批摘要行交错,新 entry 必须插在当前块末尾,
  // 不能简单用 summaryAbsIdx+renderedCount(否则 entry 会插到前一个子批摘要行之前)。
  // 块末还必须计入已渲染 entry 的二层展开明细行(toggleEntry 把明细插在 entry 行下方,
  // 会把后续 entry 行整体下移;运行态可交互后这条路径高频,漏算会插错位)。
  let anchor = b.summaryAbsIdx + b.renderedCount;
  for (const j of b.expandedEntries) {
    if (j < b.renderedCount) {
      anchor += buildEntryDetailLines(b.entries[j], entryDetailIndent(b.entries, j)).length;
    }
  }
  if (b.groupParent) {
    let maxIdx = anchor;
    for (const [idx, target] of absLineToEntry) {
      if (target.batchId !== b.id) continue;
      // entry 行自身(含其二层明细)的块末位置
      const end = b.expandedEntries.has(target.entryIndex)
        ? idx +
          buildEntryDetailLines(b.entries[target.entryIndex], entryDetailIndent(b.entries, target.entryIndex)).length
        : idx;
      if (end > maxIdx) maxIdx = end;
    }
    for (const child of batches.values()) {
      if (child.parentId === b.id && child.summaryAbsIdx >= 0) {
        let childEnd = child.summaryAbsIdx;
        if (expandedBatches.has(child.id)) {
          childEnd += child.renderedCount;
          for (const j of child.expandedEntries) {
            childEnd += buildEntryDetailLines(child.entries[j], entryDetailIndent(child.entries, j)).length;
          }
        }
        if (childEnd > maxIdx) maxIdx = childEnd;
      }
    }
    anchor = maxIdx;
  }
  layout.contentInsertAfter(anchor, lines, false);
  // 登记新增明细行的点击命中(按实际插入位置)
  for (let i = 0; i < newEntries.length; i++) {
    absLineToEntry.set(anchor + 1 + i, { batchId: b.id, entryIndex: b.renderedCount + i });
    newEntries[i].renderedDigest = entryLineDigest(newEntries[i]);
  }
  b.renderedCount = b.entries.length;
}

/**
 * 切换 batch 展开/折叠;无变化时 no-op。
 * 折叠:从 buffer 删详情行(mid-buffer delete);
 * 展开:把详情行插入摘要行下方(mid-buffer insert)。
 * 同步更新 absLineToBatchId 中所有受影响的索引:
 *   - 删除/插入点之后的 batch 摘要行索引相应平移。
 */
export function toggleBatch(
  id: string,
  layout: {
    contentInsertAfter(after: number, lines: string[], keepViewport?: boolean): void;
    contentDeleteFrom(startIdx: number, n: number): void;
  },
): void {
  const b = batches.get(id);
  if (!b) return;
  if (expandedBatches.has(id)) {
    collapse(b, layout);
  } else {
    expand(b, layout);
  }
}

function expand(
  b: BatchRecord,
  layout: {
    contentInsertAfter(after: number, lines: string[], keepViewport?: boolean): void;
  },
  live = false,
): void {
  if (b.summaryAbsIdx < 0) return; // 摘要行未落盘时展开会把明细插到 buffer 头部
  const lines = buildExpandedLines(b, b.indent ?? '');
  layout.contentInsertAfter(b.summaryAbsIdx, lines, !live);
  expandedBatches.add(b.id);
  b.renderedCount = b.entries.length;
  for (let i = 0; i < b.entries.length; i++) {
    absLineToEntry.set(b.summaryAbsIdx + 1 + i, { batchId: b.id, entryIndex: i });
    b.entries[i].renderedDigest = entryLineDigest(b.entries[i]); // 记指纹,供运行态结果回填原位刷新
  }
  // 组容器批展开时:把之前被折叠隐藏的子批摘要行重新插回对应 entry 下方,
  // 否则子批摘要行会留在父批摘要行之后、造成明细重复/错位。
  if (b.groupParent) {
    const children = [...batches.values()]
      .filter((x) => x.parentId === b.id)
      .sort((a, b) => (a.groupChildIndex ?? 0) - (b.groupChildIndex ?? 0));
    for (const child of children) {
      const entryAbs = findParentEntryAbsLine(b.id, child.groupChildIndex ?? 0);
      const anchor = entryAbs ?? b.summaryAbsIdx + b.renderedCount;
      const summary = buildSummaryLine(child, true);
      layout.contentInsertAfter(anchor, [sanitizeRow(summary)], !live);
      child.summaryAbsIdx = anchor + 1;
      absLineToBatchId.set(child.summaryAbsIdx, child.id);
    }
  }
}

function findParentEntryAbsLine(parentId: string, entryIndex: number): number | null {
  for (const [idx, target] of absLineToEntry) {
    if (target.batchId === parentId && target.entryIndex === entryIndex) return idx;
  }
  return null;
}

/** mutation 独占 batch 收尾后立即展示其调用概要和 diff。 */
export function expandSingleEntryFully(
  id: string,
  layout: {
    contentInsertAfter(after: number, lines: string[], keepViewport?: boolean): void;
    contentWrite(s: string): void;
  },
): void {
  const b = batches.get(id);
  if (!b || b.entries.length !== 1 || expandedBatches.has(id)) return;
  const lines = [...buildExpandedLines(b), ...buildEntryDetailLines(b.entries[0], entryDetailIndent(b.entries, 0))];
  // keepViewport=false:这是 agent 产出后的**自动**展开,属于「新内容」而非用户点击的回看式展开,
  // 视口必须跟随屏底(同其它工具输出 / 子 agent 实时嵌套)。传 true 会让视口锚定在摘要行、
  // 把 scrollOffset 顶到插入行数(diff 常几百行),此后 contentWriteMd 见 offset>0 就只喂缓冲
  // 不物理写 → 后续所有输出停在视口上方,表现为「edit_file 后不自动滚动,得手动拉到底」。
  layout.contentInsertAfter(b.summaryAbsIdx, lines, false);
  // 修复：contentInsertAfter 不再 commit was-current（避免 collapse 后留孤儿空行）；
  // mutation 路径不再由 flushToolBatch 写 \n separator，所以这里手动补一个 \n。
  layout.contentWrite('\n');
  expandedBatches.add(id);
  b.expandedEntries.add(0);
  b.entries[0].renderedDigest = entryLineDigest(b.entries[0]);
  // 修复：与 expand() 一致设置 renderedCount=entries.length，否则 collapse 计算 lineCount
  // 时漏算第一层 entry 行 → 折叠后 entry 行残留在屏上，下次展开时再插一遍，
  // 多出来的 entry 行下面的 details 截断提示就出现两行（用户报告：mutation 工具块
  // 「关闭又打开后…(还有 N 行未显示)重复两行」）。
  b.renderedCount = b.entries.length;
  absLineToEntry.set(b.summaryAbsIdx + 1, { batchId: id, entryIndex: 0 });
}

function collapse(
  b: BatchRecord,
  layout: {
    contentDeleteFrom(startIdx: number, n: number): void;
  },
): void {
  // 只删除实际渲染的明细行(renderedCount),而非 entries.length——运行态下
  // entries 可能多于已渲染行,按 entries.length 会多删并行批量子 agent 的行。
  let lineCount = b.renderedCount;
  for (const i of b.expandedEntries) {
    lineCount += buildEntryDetailLines(b.entries[i], entryDetailIndent(b.entries, i)).length;
  }
  // 组容器批折叠时:一并移除嵌套子批的摘要行(及其已展开详情),
  // 否则父批再次展开后子批摘要仍残留在明细区,出现重复行。
  if (b.groupParent) {
    const children = [...batches.values()].filter((x) => x.parentId === b.id);
    for (const child of children) {
      // 未落盘的子批(父批折叠期间新建)在 buffer 里没有对应行,计进 lineCount 会多删相邻正文。
      if (child.summaryAbsIdx < 0) {
        child.renderedCount = 0;
        child.expandedEntries.clear();
        expandedBatches.delete(child.id);
        continue;
      }
      lineCount += 1; // 子批摘要行本身
      if (expandedBatches.has(child.id)) {
        // 子批自身展开时,它的第一层明细行(renderedCount)也在父批块内,必须一并计入,
        // 否则删少了会留下孤儿明细行。
        lineCount += child.renderedCount;
        for (const j of child.expandedEntries) {
          lineCount += buildEntryDetailLines(child.entries[j], entryDetailIndent(child.entries, j)).length;
        }
        child.expandedEntries.clear();
        expandedBatches.delete(child.id);
      }
      child.renderedCount = 0;
      absLineToBatchId.delete(child.summaryAbsIdx);
      child.summaryAbsIdx = -1;
      for (const [idx, target] of absLineToEntry) {
        if (target.batchId === child.id) absLineToEntry.delete(idx);
      }
    }
  }
  layout.contentDeleteFrom(b.summaryAbsIdx + 1, lineCount);
  expandedBatches.delete(b.id);
  b.renderedCount = 0;
  b.expandedEntries.clear();
  for (const [idx, target] of absLineToEntry) {
    if (target.batchId === b.id) absLineToEntry.delete(idx);
  }
}

/** 绝对行索引 → 第一层中的具体工具调用。 */
export function findEntryByAbsLine(absLine: number): { batchId: string; entryIndex: number } | null {
  return absLineToEntry.get(absLine) ?? null;
}

/** 第二层：只展开/折叠某一个工具的完整输出。
 *  特殊地，组容器批(groupParent)下的 sub-agent entry 行点击时，
 *  切换的是对应子 Agent 批(child batch)的展开/折叠，而不是 entry 自身详情。 */
export function toggleEntry(
  batchId: string,
  entryIndex: number,
  layout: {
    contentInsertAfter(after: number, lines: string[], keepViewport?: boolean): void;
    contentDeleteFrom(startIdx: number, n: number): void;
    /** 翻转 entry 行的展开三角(▸→▾ / ▾→▸)。行内容换、行数不变,故不触发索引平移。 */
    contentReplaceLine(absIdx: number, line: string): void;
  },
): void {
  const b = batches.get(batchId);
  if (!b || !expandedBatches.has(batchId)) return;

  // 组容器批的 entry 对应一个子 Agent 批；点击 entry 行应展开/折叠该 entry
  // 自身的详情（即子 agent 返回的完整文本输出）。子 agent 的工具调用列表由点击
  // 子批自己的摘要行（● 子 Agent 完成 ...）来控制。
  if (b.groupParent) {
    // 如果该 sub-agent entry 没有可展开的详情，fallback 到 toggle 子批工具列表。
    const details = buildEntryDetailLines(b.entries[entryIndex], entryDetailIndent(b.entries, entryIndex));
    if (details.length === 0) {
      const child = [...batches.values()].find((x) => x.parentId === batchId && x.groupChildIndex === entryIndex);
      if (child) {
        toggleBatch(child.id, layout);
      }
      return;
    }
  }

  let headerIdx = -1;
  for (const [idx, target] of absLineToEntry) {
    if (target.batchId === batchId && target.entryIndex === entryIndex) headerIdx = idx;
  }
  if (headerIdx < 0) return;
  const details = buildEntryDetailLines(b.entries[entryIndex], entryDetailIndent(b.entries, entryIndex));
  if (details.length === 0) return;
  const wasExpanded = b.expandedEntries.has(entryIndex);
  // 先翻状态再重画三角:buildEntryLine 读 b.expandedEntries 决定 ▸/▾。
  // 替换 entry 行本身(行数不变)不会触发 shiftBatchesAfter,故可在插/删详情前做。
  if (wasExpanded) b.expandedEntries.delete(entryIndex);
  else b.expandedEntries.add(entryIndex);
  layout.contentReplaceLine(headerIdx, buildEntryLine(b, entryIndex, b.indent ?? ''));
  if (wasExpanded) {
    layout.contentDeleteFrom(headerIdx + 1, details.length);
  } else {
    layout.contentInsertAfter(headerIdx, details);
  }
}

/**
 * 当 buffer 中段插/删 N 行后,所有受影响 batch 的 summaryAbsIdx 需平移。
 * 由 layout.contentInsertAfter / contentDeleteFrom 在每次变动后调一次,
 * 参数 afterIdx 是被插入/删除点的绝对索引(插入点之前索引不变;之后索引 += delta)。
 * resize 导致整段物理行被替换时改走 shiftBatchesForReflow。
 */
export function shiftBatchesAfter(absIdx: number, delta: number): void {
  if (delta === 0) return;
  shiftBatchIndicesAfter(absIdx, delta);
}

/**
 * resize reflow 专用索引平移：物理区间 [start, start+oldCount) 被替换成 newCount 行。
 * 位于区间后的 batch/entry 整体平移；理论上 markdown 正文区间内不应存在工具命中行，
 * 若存在则钳到新区间首行，避免留下越界索引。
 */
export function shiftBatchesForReflow(start: number, oldCount: number, newCount: number): void {
  const delta = newCount - oldCount;
  if (delta === 0) return;
  const oldEnd = start + oldCount;
  const remap = (idx: number): number | null => {
    if (idx < start) return idx;
    if (idx >= oldEnd) return Math.max(0, idx + delta);
    // 头部裁剪等 newCount=0 场景中，区间内命中已从 buffer 消失，不能伪装成第 0 行。
    if (newCount === 0) return null;
    return Math.max(0, start);
  };
  const next = new Map<number, string>();
  for (const [idx, id] of absLineToBatchId) {
    const mapped = remap(idx);
    if (mapped !== null) next.set(mapped, id);
  }
  absLineToBatchId.clear();
  for (const [idx, id] of next) absLineToBatchId.set(idx, id);
  const nextEntries = new Map<number, { batchId: string; entryIndex: number }>();
  for (const [idx, target] of absLineToEntry) {
    const mapped = remap(idx);
    if (mapped !== null) nextEntries.set(mapped, target);
  }
  absLineToEntry.clear();
  for (const [idx, target] of nextEntries) absLineToEntry.set(idx, target);
  for (const record of batches.values()) {
    const mapped = remap(record.summaryAbsIdx);
    record.summaryAbsIdx = mapped ?? -1;
  }
}

function shiftBatchIndicesAfter(absIdx: number, delta: number): void {
  // 重建 absLineToBatchId:删除所有 <= absIdx 的项,把 > absIdx 的项按 delta 平移
  const next = new Map<number, string>();
  for (const [idx, id] of absLineToBatchId) {
    if (idx <= absIdx) {
      next.set(idx, id);
    } else {
      const newIdx = idx + delta;
      if (newIdx >= 0) next.set(newIdx, id);
    }
  }
  absLineToBatchId.clear();
  for (const [k, v] of next) absLineToBatchId.set(k, v);
  const nextEntries = new Map<number, { batchId: string; entryIndex: number }>();
  // expand() 先插入整组概要行、再登记其命中位置；layout 随后的异步 shift 通知不应把
  // 这批“刚插入”的概要行再次平移。插入单个工具详情时 absIdx 不是 summary，仍正常平移。
  const insertedOverviewBatch =
    delta > 0
      ? [...batches.values()].find((b) => b.summaryAbsIdx === absIdx && expandedBatches.has(b.id))?.id
      : undefined;
  for (const [idx, target] of absLineToEntry) {
    const isNewOverviewLine = target.batchId === insertedOverviewBatch;
    const newIdx = idx > absIdx && !isNewOverviewLine ? idx + delta : idx;
    if (newIdx >= 0) nextEntries.set(newIdx, target);
  }
  absLineToEntry.clear();
  for (const [k, v] of nextEntries) absLineToEntry.set(k, v);
  // 同步每个 batch 的 summaryAbsIdx
  for (const b of batches.values()) {
    if (b.summaryAbsIdx > absIdx) b.summaryAbsIdx = Math.max(0, b.summaryAbsIdx + delta);
  }
}

/** 更新 batch 摘要行标签(子 agent 批:运行中→完成/失败)。 */
export function setBatchLabel(id: string, label: string): void {
  const b = batches.get(id);
  if (b) b.label = label;
}

/** 设置/清除运行态标志:running=true 时摘要行用「运行中」专属图标,收尾时置 false。 */
export function setBatchRunning(id: string, running: boolean): void {
  const b = batches.get(id);
  if (b) b.running = running;
}

/** history 回放支持 ── */

/** 把已构造好的 BatchEntry[] 落成可切换摘要行(用于 renderHistory 回放)。
 *  含 mutation(write_file/edit_file)时整批展开；普通批次保留与实时 flushToolBatch 相同的空行边界。 */
export function writeSummaryOnly(
  entries: BatchEntry[],
  layout: {
    contentWrite(s: string): void;
    contentInsertAfter(after: number, lines: string[], keepViewport?: boolean): void;
    totalRows(): number;
  },
): void {
  const id = beginBatch();
  const b = batches.get(id);
  if (!b) return;
  b.entries = entries;
  endBatch(id, layout);
  if (entries.length === 1 && isMutationToolName(entries[0].name)) {
    expandSingleEntryFully(id, layout);
  } else {
    // endBatch 已用一个换行结束摘要；再提交当前空行，避免下一段 assistant 正文紧贴工具结果。
    layout.contentWrite('\n');
  }
}

let _idCounter = 0;
