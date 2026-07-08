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
}

/** 一个 LLM 步的工具调用 batch 记录。 */
interface BatchRecord {
  id: string;
  summaryAbsIdx: number; // 摘要行在 content buffer 中的绝对索引
  entries: BatchEntry[];
  /**
   * 强制展开:batch 含 write_file/edit_file 时为 true(用户改盘动作必须看到 diff,不能折叠)。
   * true 时收尾自动展开详情行,toggleBatch 拒绝折叠(写盘操作保留可视)。
   */
  forceExpanded: boolean;
}

const batches = new Map<string, BatchRecord>();
/** 绝对行索引 → 所属 batch id(仅记录 summary 行;用于鼠标点击反查)。
 *  buffer 行数变化时本表可能漂移——但只在 insertAfter/deleteFrom 后由本模块同步更新,
 *  并保持 buffer 当前状态对应。 */
const absLineToBatchId = new Map<number, string>();
/** 已展开的 batch id;默认空(全折叠);layout.mouse release 点击摘要行时切。
 *  含 mutation 的 batch 不在此 set——它们走 forceExpanded 永远展开,与 toggle 隔离。 */
const expandedBatches = new Set<string>();

/** mutation 工具名集合(写盘操作);与 src/agent/core.ts 的 isMutationTool 同步,本模块独立持有
 *  避免 ui → agent 反向依赖。 */
const MUTATION_TOOLS = new Set(['write_file', 'edit_file']);
function isMutationTool(name: string): boolean {
  return MUTATION_TOOLS.has(name);
}

/** 通知 buffer 整体清空(clearContent / exitAltScreen / 新一轮 turn)——本模块状态同步归零。 */
export function reset(): void {
  batches.clear();
  absLineToBatchId.clear();
  expandedBatches.clear();
}

/** 新建一个 batch(在 agent 拿到第一条 onToolHeader 时调)。返回 id。 */
export function beginBatch(): string {
  const id = `b${++_idCounter}`;
  batches.set(id, { id, summaryAbsIdx: -1, entries: [], forceExpanded: false });
  return id;
}

/** 记一条工具调用(在 onToolHeader 时调,与 setEntryResult 配对;entries 顺序 = agent 调用顺序)。 */
export function recordCall(id: string, name: string, callSummary: string): void {
  const b = batches.get(id);
  if (!b) return;
  b.entries.push({ name, callSummary, resultSummary: '', diffBlock: null });
}

/** 记一条工具结果(diff 块或单行 preview);agent 在 onToolResult 时调,匹配最后一条未填的 entry。 */
export function recordResult(
  id: string,
  name: string,
  resultSummary: string,
  diffBlock: string | null,
): void {
  const b = batches.get(id);
  if (!b || b.entries.length === 0) return;
  // 反向找最后一条同名的 entry 填结果;同名工具一批多次调用时正向遍历更安全——用 lastIndexOf 同名回退
  for (let i = b.entries.length - 1; i >= 0; i--) {
    if (b.entries[i].name === name && !b.entries[i].resultSummary) {
      b.entries[i].resultSummary = resultSummary;
      b.entries[i].diffBlock = diffBlock;
      return;
    }
  }
  // 兜底:无匹配则填最后一条
  const last = b.entries[b.entries.length - 1];
  if (!last.resultSummary) {
    last.resultSummary = resultSummary;
    last.diffBlock = diffBlock;
  }
}

// ── 摘要行文本生成 ──

/** 把 entry 列表压缩成一行摘要(Claude Code 风格)。 */
function buildSummaryLine(entries: BatchEntry[]): string {
  if (entries.length === 0) {
    return `  ${ui.brightMagenta}●${ui.reset} ${ui.dim}No tools${ui.reset}`;
  }
  if (entries.length === 1) {
    const e = entries[0];
    return `  ${ui.brightMagenta}●${ui.reset} ${ui.cyan}${e.name}${ui.reset}  ${ui.dim}${e.callSummary}${ui.reset}`;
  }
  // N>1:同类合并 "read_file 3, glob 1, grep 1"
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const parts: string[] = [];
  for (const [n, c] of counts) parts.push(`${n} ${c}`);
  return `  ${ui.brightMagenta}●${ui.reset} ${ui.dim}Ran ${entries.length} tools · ${parts.join(', ')}${ui.reset}`;
}

// ── 展开/折叠 ──

/** 把 batch 的详情行展开成自洽行数组(供 layout.contentInsertAfter 走 mid-buffer 插入)。
 *  每行末尾必须以 \x1B[0m 收尾(SGR 自洽模型),行内允许含 SGR(行末 reset 不影响行内样式),
 *  但**绝不**带 \n——rows[] 是行数组,不是流输出。 */
function buildExpandedLines(entries: BatchEntry[], indent = '    '): string[] {
  const lines: string[] = [];
  for (const e of entries) {
    lines.push(
      `${indent}${ui.brightMagenta}●${ui.reset} ${ui.cyan}${e.name}${ui.reset}  ${ui.dim}${e.callSummary}${ui.reset}\x1B[0m`,
    );
    if (e.diffBlock) {
      // diff 块多行文本(由 renderFileChange 渲染);按 \n 拆成物理行,
      // 每行单独入 rows[]。行末 reset 由本函数统一追加(若原行已带 reset,终端合并即可)。
      const block = e.diffBlock.endsWith('\n') ? e.diffBlock : e.diffBlock + '\n';
      for (const line of block.split('\n')) {
        if (line === '' && lines.length > 0 && lines[lines.length - 1] === '') continue; // 折叠连续空行
        if (line === '' && lines.length > 0) continue; // 跳过首尾空行(diff 头/尾换行)
        lines.push(line.endsWith('\x1B[0m') ? line : line + '\x1B[0m');
      }
    } else if (e.resultSummary) {
      lines.push(`${indent}${ui.gray}↳ ${e.resultSummary}${ui.reset}\x1B[0m`);
    }
  }
  return lines;
}

/** 在 batch 收尾时(onToolBatchEnd):写摘要行 + 登记 summaryAbsIdx;若已展开(回放场景)立即插详情。 */
export function endBatch(
  id: string,
  layout: {
    contentWrite(s: string): void;
    contentInsertAfter(after: number, lines: string[]): void;
    totalRows(): number;
  },
): void {
  const b = batches.get(id);
  if (!b || b.summaryAbsIdx >= 0) return; // 幂等
  // 含 mutation(write_file/edit_file)时强制展开——写盘操作必须让用户看到 diff
  b.forceExpanded = b.entries.some((e) => isMutationTool(e.name));
  // 单条 mutation 调用:摘要行("● edit_file path")与展开详情头逐字重复,跳过摘要行、只写详情
  // (N>1 时摘要行是聚合信息 "Ran N tools · ...",与详情不重复,两者照常都写)。
  if (b.forceExpanded && b.entries.length === 1) {
    // 无摘要行可当父行,详情头改用顶层 2 空格缩进(与 buildSummaryLine/diff head 对齐,而非嵌套的 4 空格)
    const lines = buildExpandedLines(b.entries, '  ');
    layout.contentWrite(lines.join('\n') + '\n');
    b.summaryAbsIdx = Math.max(0, layout.totalRows() - 1 - lines.length);
    absLineToBatchId.set(b.summaryAbsIdx, b.id);
    expandedBatches.add(b.id); // 已展开;防止 toggleBatch 再次 expand() 造成重复插入
    return;
  }
  const summary = buildSummaryLine(b.entries);
  // 写摘要行(以 \n 收尾;contentWrite 会 breakRow 让其成为完整物理行)
  layout.contentWrite(summary + '\n');
  // 摘要行绝对索引 = totalRows - 2(hasCurrent 那行是新空行)
  b.summaryAbsIdx = Math.max(0, layout.totalRows() - 2);
  absLineToBatchId.set(b.summaryAbsIdx, b.id);
  // forceExpanded 时立刻展开(让 diff 在收尾后立即可见,无需点击)
  if (b.forceExpanded) {
    expand(b, layout);
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
 * 含 mutation(write_file/edit_file)的 batch 强制展开——不允许折叠(写盘操作必须始终可见)。
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
  if (b.forceExpanded) {
    // 写盘操作的 batch 强制展开,toggle 拒绝折叠(用户能看到完整 diff 即用)
    if (!expandedBatches.has(id)) expand(b, layout);
    return;
  }
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
}

function collapse(
  b: BatchRecord,
  layout: {
    contentDeleteFrom(startIdx: number, n: number): void;
  },
): void {
  const lines = buildExpandedLines(b.entries);
  layout.contentDeleteFrom(b.summaryAbsIdx + 1, lines.length);
  expandedBatches.delete(b.id);
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
  const hasMutation = entries.some((e) => isMutationTool(e.name));
  // 单条 mutation:同 endBatch,摘要行与展开详情头重复,跳过摘要行只写详情
  if (hasMutation && entries.length === 1) {
    const lines = buildExpandedLines(entries, '  ');
    layout.contentWrite(lines.join('\n') + '\n');
    return;
  }
  layout.contentWrite(buildSummaryLine(entries) + '\n');
  if (hasMutation) {
    // 回放时同步展开:重新调 expand 路径需要 BatchRecord,此处直接拼 line 插入
    const summaryIdx = Math.max(0, layout.totalRows() - 2);
    const lines = buildExpandedLines(entries);
    layout.contentInsertAfter(summaryIdx, lines);
    // 不入 batches/absLineToBatchId/expandedBatches——回放行不支持点击 toggle(设计取舍:
    // 简化模型;若需要支持回放也可展开/折叠,可在 alt-screen 启动时建一张临时映射)
  }
}

let _idCounter = 0;