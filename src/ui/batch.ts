/**
 * 工具调用批量折叠渲染(仿 Claude Code):
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
}

/** 一个 LLM 步的工具调用 batch 记录。 */
interface BatchRecord {
  id: string;
  summaryAbsIdx: number; // 摘要行在 content buffer 中的绝对索引
  entries: BatchEntry[];
  /** 第二层中已展开完整输出的 entry 下标。 */
  expandedEntries: Set<number>;
}

const batches = new Map<string, BatchRecord>();
/** 绝对行索引 → 所属 batch id(仅记录 summary 行;用于鼠标点击反查)。
 *  buffer 行数变化时本表可能漂移——但只在 insertAfter/deleteFrom 后由本模块同步更新,
 *  并保持 buffer 当前状态对应。 */
const absLineToBatchId = new Map<number, string>();
/** 第一层展开后，工具概要行的绝对索引 → 对应 entry。 */
const absLineToEntry = new Map<number, { batchId: string; entryIndex: number }>();
/** 已展开第一层工具列表的 batch id。 */
const expandedBatches = new Set<string>();

/** 展开时完整输出的最大行数;超出截断,避免巨型输出撑爆 viewport。 */
const MAX_EXPAND_LINES = 200;

export function isMutationToolName(name: string): boolean {
  return name === 'write_file' || name === 'edit_file';
}

/** 通知 buffer 整体清空(clearContent / exitAltScreen / 新一轮 turn)——本模块状态同步归零。 */
export function reset(): void {
  batches.clear();
  absLineToBatchId.clear();
  absLineToEntry.clear();
  expandedBatches.clear();
}

/** 新建一个 batch(在 agent 拿到第一条 onToolHeader 时调)。返回 id。 */
export function beginBatch(): string {
  const id = `b${++_idCounter}`;
  batches.set(id, { id, summaryAbsIdx: -1, entries: [], expandedEntries: new Set() });
  return id;
}

/** 记一条工具调用(在 onToolHeader 时调,与 setEntryResult 配对;entries 顺序 = agent 调用顺序)。 */
export function recordCall(id: string, name: string, callSummary: string): void {
  const b = batches.get(id);
  if (!b) return;
  b.entries.push({ name, callSummary, resultSummary: '', diffBlock: null });
}

/** 记一条工具结果(diff 块或单行 preview);agent 在 onToolResult 时调,匹配最后一条未填的 entry。
 *  fullOutput:工具原始完整输出(纯文本),展开时显示;mutation 工具的 diff 块已自含无需传。 */
export function recordResult(
  id: string,
  name: string,
  resultSummary: string,
  diffBlock: string | null,
  fullOutput?: string,
): void {
  const b = batches.get(id);
  if (!b || b.entries.length === 0) return;
  // 反向找最后一条同名的 entry 填结果;同名工具一批多次调用时正向遍历更安全——用 lastIndexOf 同名回退
  for (let i = b.entries.length - 1; i >= 0; i--) {
    if (b.entries[i].name === name && !b.entries[i].resultSummary) {
      b.entries[i].resultSummary = resultSummary;
      b.entries[i].diffBlock = diffBlock;
      b.entries[i].fullOutput = fullOutput;
      return;
    }
  }
  // 兜底:无匹配则填最后一条
  const last = b.entries[b.entries.length - 1];
  if (!last.resultSummary) {
    last.resultSummary = resultSummary;
    last.diffBlock = diffBlock;
    last.fullOutput = fullOutput;
  }
}

// ── 摘要行文本生成 ──

/** 把 entry 列表压缩成一行摘要(Claude Code 风格)。 */
function buildSummaryLine(entries: BatchEntry[]): string {
  if (entries.length === 0) {
    return `  ${ui.bold}${ui.accent}●${ui.reset} ${ui.dim}No tools${ui.reset}`;
  }
  if (entries.length === 1) {
    const e = entries[0];
    // 实时摘要必须稳定保持单行；完整参数放在第一层工具概要中，避免长 JSON 自动折行后
    // 原地刷新只能覆盖最后一条物理行、残留旧摘要前半段。
    return `  ${ui.bold}${ui.accent}●${ui.reset} ${ui.dim}Ran 1 tool · ${e.name} 1${ui.reset}`;
  }
  // N>1:同类合并 "read_file 3, glob 1, grep 1"
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const parts: string[] = [];
  for (const [n, c] of counts) parts.push(`${n} ${c}`);
  return `  ${ui.bold}${ui.accent}●${ui.reset} ${ui.dim}Ran ${entries.length} tools · ${parts.join(', ')}${ui.reset}`;
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
        lines.push(line.endsWith('\x1B[0m') ? line : line + '\x1B[0m');
      }
  } else if (e.fullOutput) {
      // 完整工具输出(纯文本):按行展开,每行缩进 + dim 样式;长输出截断到 MAX_EXPAND_LINES 行
      const rawLines = e.fullOutput.split('\n');
      const truncated = rawLines.length > MAX_EXPAND_LINES;
      const displayLines = truncated ? rawLines.slice(0, MAX_EXPAND_LINES) : rawLines;
      for (const line of displayLines) {
        lines.push(`${indent}${ui.gray}${line}${ui.reset}\x1B[0m`);
      }
      if (truncated) {
        lines.push(`${indent}${ui.dim}… (${rawLines.length - MAX_EXPAND_LINES} more lines)${ui.reset}\x1B[0m`);
      }
  } else if (e.resultSummary) {
    lines.push(`${indent}${ui.gray}↳ ${e.resultSummary}${ui.reset}\x1B[0m`);
  }
  return lines;
}

/** 第一层只展示有哪些调用及其简短结果，不展开完整输出。 */
function buildExpandedLines(entries: BatchEntry[], indent = '    '): string[] {
  return entries.map((e) => {
    const result = e.resultSummary ? `  ${ui.gray}↳ ${e.resultSummary}${ui.reset}` : '';
    return `${indent}${ui.bold}${ui.accent}●${ui.reset} ${ui.accent}${e.name}${ui.reset}  ${ui.dim}${e.callSummary}${ui.reset}${result}\x1B[0m`;
  });
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
  if (b.summaryAbsIdx >= 0) {
    layout.contentReplaceLine?.(b.summaryAbsIdx, buildSummaryLine(b.entries));
    // 执行阶段只展示实时摘要；到 endBatch 才开放点击，避免未完成 batch 的第一层列表失步。
    absLineToBatchId.set(b.summaryAbsIdx, b.id);
    return;
  }
  const summary = buildSummaryLine(b.entries);
  // 写摘要行(以 \n 收尾;contentWrite 会 breakRow 让其成为完整物理行)
  layout.contentWrite(summary + '\n');
  // 摘要行绝对索引 = totalRows - 2(hasCurrent 那行是新空行)
  b.summaryAbsIdx = Math.max(0, layout.totalRows() - 2);
  absLineToBatchId.set(b.summaryAbsIdx, b.id);
}

/**
 * 工具执行中立即显示/刷新摘要，但暂不登记点击命中；endBatch 收尾后才开放两层展开。
 */
export function showLiveBatch(
  id: string,
  layout: {
    contentWrite(s: string): void;
    contentReplaceLine(absIdx: number, line: string): void;
    totalRows(): number;
    repaintViewport?(): void;
  },
): void {
  const b = batches.get(id);
  if (!b) return;
  const summary = buildSummaryLine(b.entries);
  if (b.summaryAbsIdx < 0) {
    layout.contentWrite(summary + '\n');
    b.summaryAbsIdx = Math.max(0, layout.totalRows() - 2);
    // 首条摘要通过增量 contentWrite 落屏时，markdown→普通内容的边界可能只更新了
    // buffer/续写位；直到第二个 header 的 contentReplaceLine 或后续正文重绘才完全可见。
    // 立即按 buffer 原子重画，确保慢工具执行期间摘要前的空行已经显示。
    layout.repaintViewport?.();
  } else {
    layout.contentReplaceLine(b.summaryAbsIdx, summary);
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
    contentInsertAfter(after: number, lines: string[]): void;
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
    contentInsertAfter(after: number, lines: string[]): void;
  },
): void {
  const lines = buildExpandedLines(b.entries);
  layout.contentInsertAfter(b.summaryAbsIdx, lines);
  expandedBatches.add(b.id);
  for (let i = 0; i < b.entries.length; i++) {
    absLineToEntry.set(b.summaryAbsIdx + 1 + i, { batchId: b.id, entryIndex: i });
  }
}

/** mutation 独占 batch 收尾后立即展示其调用概要和 diff。 */
export function expandSingleEntryFully(
  id: string,
  layout: { contentInsertAfter(after: number, lines: string[]): void },
): void {
  const b = batches.get(id);
  if (!b || b.entries.length !== 1 || expandedBatches.has(id)) return;
  const lines = [
    ...buildExpandedLines(b.entries),
    ...buildEntryDetailLines(b.entries[0]),
  ];
  layout.contentInsertAfter(b.summaryAbsIdx, lines);
  expandedBatches.add(id);
  b.expandedEntries.add(0);
  absLineToEntry.set(b.summaryAbsIdx + 1, { batchId: id, entryIndex: 0 });
}

function collapse(
  b: BatchRecord,
  layout: {
    contentDeleteFrom(startIdx: number, n: number): void;
  },
): void {
  let lineCount = b.entries.length;
  for (const i of b.expandedEntries) lineCount += buildEntryDetailLines(b.entries[i]).length;
  layout.contentDeleteFrom(b.summaryAbsIdx + 1, lineCount);
  expandedBatches.delete(b.id);
  b.expandedEntries.clear();
  for (const [idx, target] of absLineToEntry) {
    if (target.batchId === b.id) absLineToEntry.delete(idx);
  }
}

/** 绝对行索引 → 第一层中的具体工具调用。 */
export function findEntryByAbsLine(absLine: number): { batchId: string; entryIndex: number } | null {
  return absLineToEntry.get(absLine) ?? null;
}

/** 第二层：只展开/折叠某一个工具的完整输出。 */
export function toggleEntry(
  batchId: string,
  entryIndex: number,
  layout: {
    contentInsertAfter(after: number, lines: string[]): void;
    contentDeleteFrom(startIdx: number, n: number): void;
  },
): void {
  const b = batches.get(batchId);
  if (!b || !expandedBatches.has(batchId)) return;
  let headerIdx = -1;
  for (const [idx, target] of absLineToEntry) {
    if (target.batchId === batchId && target.entryIndex === entryIndex) headerIdx = idx;
  }
  if (headerIdx < 0) return;
  const details = buildEntryDetailLines(b.entries[entryIndex]);
  if (details.length === 0) return;
  if (b.expandedEntries.has(entryIndex)) {
    layout.contentDeleteFrom(headerIdx + 1, details.length);
    b.expandedEntries.delete(entryIndex);
  } else {
    layout.contentInsertAfter(headerIdx, details);
    b.expandedEntries.add(entryIndex);
  }
}

/**
 * 当 buffer 中段插/删 N 行后,所有受影响 batch 的 summaryAbsIdx 需平移。
 * 由 layout.contentInsertAfter / contentDeleteFrom 在每次变动后调一次,
 * 参数 afterIdx 是被插入/删除点的绝对索引(插入点之前索引不变;之后索引 += delta)。
 */
export function shiftBatchesAfter(absIdx: number, delta: number): void {
  if (delta === 0) return;
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
  const insertedOverviewBatch = delta > 0
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

// ── history 回放支持 ──

/** 把已构造好的 BatchEntry[] 直接落成摘要行(用于 renderHistory 回放;不记录 id 也不需可切换)。
 *  含 mutation(write_file/edit_file)时整批展开——与实时 endBatch 行为一致。 */
export function writeSummaryOnly(
  entries: BatchEntry[],
  layout: {
    contentWrite(s: string): void;
    contentInsertAfter(after: number, lines: string[]): void;
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
  }
}

let _idCounter = 0;
