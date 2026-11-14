// adoption.ts —— R19 记忆送达/采纳观测账本。
//
// 这不是记忆库，也不参与检索、注入或排序。它只回答一件事：某条已送达的记忆，
// 后续是否真的影响了 agent 的决策。评估是既有反思/压缩调用的副产物；无评估时保留
// pending，绝不因为“没被提及”就把它判成未采纳。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getCurrentSessionId } from '../session/state.js';
import { memoryWriteBlockReason } from './write-gate.js';

const RETAIN_DAYS = 90;
const MAX_REASON_CHARS = 120;
const MAX_PENDING_FOR_EVALUATION = 12;

export type AdoptionChannel = 'proactive_trigger' | 'proactive_anchor' | 'anchor_read' | 'turn_recall' | 'memory_tail';
export type AdoptionEventKind = 'delivered' | 'suppressed' | 'evaluated';
export type AdoptionVerdict = 'adopted' | 'not_applicable' | 'unclear';
export type AdoptionSuppressionReason = 'already_fired' | 'per_turn_limit' | 'per_call_limit' | 'read_file_dedup';

export interface AdoptionEvent {
  id: string;
  at: string;
  sessionId?: string;
  memoryId: string;
  channel: AdoptionChannel;
  kind: AdoptionEventKind;
  /** delivered/evaluated 关联的送达事件 id；evaluated 必填。 */
  deliveryId?: string;
  reason?: string;
  verdict?: AdoptionVerdict;
  /**
   * 抑制事件的聚合次数。抑制按 (session, memoryId, channel, reason) 合并成一行，
   * 缺省 1（历史逐条行与 delivered/evaluated 都没有这个字段）。
   */
  count?: number;
}

export interface AdoptionStats {
  delivered: number;
  suppressed: number;
  evaluated: number;
  adopted: number;
  notApplicable: number;
  unclear: number;
  /**
   * **当前会话**尚未评估的送达数——唯一还能被裁决的那部分。
   *
   * 口径必须按会话切：`pendingAdoptionDeliveries()` 只把本会话的 delivered 交给模型，
   * 所以旧会话的未评估永远等不到裁决。把两者合在一个数里会让这个指标永远降不下去，
   * health 的「待评估过多」告警于是恒亮，成了狼来了（实测 460 里 298 条属这种情况）。
   */
  pending: number;
  /**
   * 已结束会话留下的未评估送达：不会再被裁决，只会随 90 天 prune 消失。
   *
   * 与 `pending` 分开报，因为它们要求的动作不同：pending 该去跑 `/reflect`，
   * stranded 做什么都没用——把它计入积压只会制造一个无法消除的假告警。
   */
  stranded: number;
  byChannel: Record<AdoptionChannel, number>;
  suppressedByReason: Partial<Record<AdoptionSuppressionReason, number>>;
}

interface AdoptionSummary {
  schemaVersion: 1;
  updatedAt: string;
  totals: Omit<AdoptionStats, 'pending' | 'stranded'>;
}

const CHANNELS: AdoptionChannel[] = [
  'proactive_trigger',
  'proactive_anchor',
  'anchor_read',
  'turn_recall',
  'memory_tail',
];
let serial = 0;

/**
 * 抑制事件的**内存聚合桶**。
 *
 * 写放大是实测出来的：抑制在每次工具调用里逐个候选触发，一个 20 步的轮次就能
 * 产生上千条 `already_fired`／`per_turn_limit`，而其中绝大多数永远不会被读——
 * 真实账本一周 14 MB、61k 行里 99% 是这种重复行。抑制是纯计数信号，没有单条
 * 审计价值（不像 delivered 需要 id 供评估回填），所以按
 * (session, memoryId, channel, reason) 累加，由 `flushAdoptionSuppressions()` 在
 * 轮末/退出时落**一行**带 `count` 的记录。
 *
 * 代价与 proactive 计数一致：进程硬崩会丢掉当轮未落盘的抑制次数。观测数据不该
 * 拖垮主流程，这个损失可接受。
 *
 * 桶的 key 必须带**账本路径**：`/cd` 换工作区后账本是另一个文件，且测试会
 * 反复 chdir 到临时目录——不带路径的话，上一个工作区的未落盘次数会被写进
 * 新工作区的账本（同进程内统计也会互相污染）。
 */
interface SuppressionBucket {
  id: string;
  ledger: string;
  sessionId?: string;
  memoryId: string;
  channel: AdoptionChannel;
  reason: AdoptionSuppressionReason;
  count: number;
  lastAt: string;
}
let suppressionBuckets = new Map<string, SuppressionBucket>();

function ledgerPath(): string {
  return path.join(process.cwd(), '.mocode', 'memory-adoption.jsonl');
}

function summaryPath(): string {
  return path.join(process.cwd(), '.mocode', 'memory-adoption-summary.json');
}

function emptyStats(): AdoptionStats {
  return {
    delivered: 0,
    suppressed: 0,
    evaluated: 0,
    adopted: 0,
    notApplicable: 0,
    unclear: 0,
    pending: 0,
    stranded: 0,
    byChannel: {
      proactive_trigger: 0,
      proactive_anchor: 0,
      anchor_read: 0,
      turn_recall: 0,
      memory_tail: 0,
    },
    suppressedByReason: {},
  };
}

function isChannel(value: unknown): value is AdoptionChannel {
  return typeof value === 'string' && CHANNELS.includes(value as AdoptionChannel);
}

function isVerdict(value: unknown): value is AdoptionVerdict {
  return value === 'adopted' || value === 'not_applicable' || value === 'unclear';
}

function readLedger(): AdoptionEvent[] {
  try {
    if (!existsSync(ledgerPath())) return [];
    const out: AdoptionEvent[] = [];
    for (const line of readFileSync(ledgerPath(), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Partial<AdoptionEvent>;
        if (
          !e ||
          typeof e.id !== 'string' ||
          typeof e.at !== 'string' ||
          typeof e.memoryId !== 'string' ||
          !isChannel(e.channel)
        )
          continue;
        if (e.kind !== 'delivered' && e.kind !== 'suppressed' && e.kind !== 'evaluated') continue;
        if (e.kind === 'evaluated' && (!e.deliveryId || !isVerdict(e.verdict))) continue;
        out.push(e as AdoptionEvent);
      } catch {
        // 单行损坏不应让健康报告和反思都失效。
      }
    }
    return out;
  } catch {
    return [];
  }
}

function readSummary(): AdoptionSummary | null {
  try {
    const raw = JSON.parse(readFileSync(summaryPath(), 'utf8')) as Partial<AdoptionSummary>;
    if (!raw || raw.schemaVersion !== 1 || !raw.totals) return null;
    const totals = emptyStats();
    for (const key of ['delivered', 'suppressed', 'evaluated', 'adopted', 'notApplicable', 'unclear'] as const) {
      const n = (raw.totals as Partial<AdoptionStats>)[key];
      totals[key] = typeof n === 'number' && n >= 0 ? Math.floor(n) : 0;
    }
    for (const channel of CHANNELS) {
      const n = raw.totals.byChannel?.[channel];
      totals.byChannel[channel] = typeof n === 'number' && n >= 0 ? Math.floor(n) : 0;
    }
    for (const [reason, n] of Object.entries(raw.totals.suppressedByReason ?? {})) {
      if (typeof n === 'number' && n >= 0)
        totals.suppressedByReason[reason as AdoptionSuppressionReason] = Math.floor(n);
    }
    return { schemaVersion: 1, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '', totals };
  } catch {
    return null;
  }
}

function summarize(events: readonly AdoptionEvent[], currentSessionId = getCurrentSessionId()): AdoptionStats {
  const out = emptyStats();
  const delivered = new Map<string, AdoptionEvent>();
  const evaluated = new Set<string>();
  for (const e of events) {
    if (e.kind === 'delivered') {
      delivered.set(e.id, e);
      out.delivered++;
      out.byChannel[e.channel]++;
    } else if (e.kind === 'suppressed') {
      // 聚合行带 count;历史逐条行缺省 1,两种形态必须给出同一组数字。
      const n = e.count && e.count > 0 ? e.count : 1;
      out.suppressed += n;
      if (e.reason)
        out.suppressedByReason[e.reason as AdoptionSuppressionReason] =
          (out.suppressedByReason[e.reason as AdoptionSuppressionReason] ?? 0) + n;
    } else {
      evaluated.add(e.deliveryId!);
      out.evaluated++;
      if (e.verdict === 'adopted') out.adopted++;
      else if (e.verdict === 'not_applicable') out.notApplicable++;
      else out.unclear++;
    }
  }
  // 未评估的送达分两类:本会话的(还能裁决)与旧会话的(永远等不到)。
  // 缺 sessionId 的历史事件按「可评估」算——宁可让告警偏亮,也不要把真能处理的一批藏起来。
  for (const [id, e] of delivered) {
    if (evaluated.has(id)) continue;
    if (!currentSessionId || !e.sessionId || e.sessionId === currentSessionId) out.pending++;
    else out.stranded++;
  }
  return out;
}

function mergeStats(target: AdoptionStats, add: Omit<AdoptionStats, 'pending' | 'stranded'>): void {
  for (const key of ['delivered', 'suppressed', 'evaluated', 'adopted', 'notApplicable', 'unclear'] as const)
    target[key] += add[key];
  for (const channel of CHANNELS) target.byChannel[channel] += add.byChannel[channel];
  for (const [reason, count] of Object.entries(add.suppressedByReason)) {
    target.suppressedByReason[reason as AdoptionSuppressionReason] =
      (target.suppressedByReason[reason as AdoptionSuppressionReason] ?? 0) + count;
  }
}

function newEventId(now: string): string {
  return `adopt-${now.replace(/[-:.TZ]/g, '')}-${++serial}`;
}

function append(event: Omit<AdoptionEvent, 'id' | 'at' | 'sessionId'>): string | null {
  if (memoryWriteBlockReason()) return null;
  const now = new Date().toISOString();
  const record: AdoptionEvent = {
    id: newEventId(now),
    at: now,
    ...(getCurrentSessionId() ? { sessionId: getCurrentSessionId() } : {}),
    ...event,
  };
  try {
    const p = ledgerPath();
    mkdirSync(path.dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(record) + '\n', 'utf8');
    return record.id;
  } catch {
    return null;
  }
}

/** 把内存聚合桶转成对外可读的事件形态(与落盘行同构,便于统计与展示共用一套代码)。
 * 只取**当前**账本路径的桶:`/cd` 换工作区后账本是另一个文件,统计与落盘都必须各算各的。
 */
function bucketEvents(): AdoptionEvent[] {
  const current = ledgerPath();
  return [...suppressionBuckets.values()]
    .filter((b) => b.ledger === current)
    .map((b) => ({
      id: b.id,
      at: b.lastAt,
      ...(b.sessionId ? { sessionId: b.sessionId } : {}),
      memoryId: b.memoryId,
      channel: b.channel,
      kind: 'suppressed' as const,
      reason: b.reason,
      count: b.count,
    }));
}

/**
 * 落盘聚合后的抑制计数。调用时机与 `flushProactiveStats()` / `flushTurnRecallStats()` 一致:
 * 轮末、退出、`/memory adoption`、`/memory health`。
 *
 * 失败(含 `/memory pause` 或总开关关闭)**不清桶**:抑制次数是可观测性数据,
 * 下次 flush 再试即可,不该因为一次写盘失败就静默丢掉。桶的规模由
 * (session, memoryId, channel, reason) 去重决定,不会无限增长。
 */
export function flushAdoptionSuppressions(): void {
  if (suppressionBuckets.size === 0) return;
  if (memoryWriteBlockReason()) return;
  const rows = bucketEvents();
  if (rows.length === 0) return;
  const p = ledgerPath();
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    appendFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    // 只清当前账本的桶:其它工作区的未落盘次数要在它自己的目录里落盘。
    for (const [key, bucket] of suppressionBuckets) if (bucket.ledger === p) suppressionBuckets.delete(key);
  } catch {
    // 保守失败:桶保留,下次 flush 重试(重复落盘风险低于丢数据)。
  }
}

/** 记录一条真正进入模型上下文或工具结果的记忆。 */
export function recordMemoryDelivery(memoryId: string, channel: AdoptionChannel): string | null {
  if (!memoryId) return null;
  return append({ memoryId, channel, kind: 'delivered' });
}

/** 记录命中但被限流/去重治理挡住的记忆；它从未进入采纳分母。
 *
 * 只在内存里累加,由 `flushAdoptionSuppressions()` 落成一行带 `count` 的聚合记录。
 * 抑制是纯计数信号:没有单条审计价值(不像 delivered 需要 id 供评估回填),而逐条
 * 落盘会让账本按工具调用次数膨胀(实测一周 14 MB / 61k 行,99% 是重复抑制)。
 */
export function recordMemorySuppression(
  memoryId: string,
  channel: AdoptionChannel,
  reason: AdoptionSuppressionReason,
): void {
  if (!memoryId) return;
  if (memoryWriteBlockReason()) return;
  const sessionId = getCurrentSessionId();
  const ledger = ledgerPath();
  const key = `${ledger}|${sessionId}|${memoryId}|${channel}|${reason}`;
  const now = new Date().toISOString();
  const bucket = suppressionBuckets.get(key);
  if (bucket) {
    bucket.count++;
    bucket.lastAt = now;
    return;
  }
  suppressionBuckets.set(key, {
    id: newEventId(now),
    ledger,
    ...(sessionId ? { sessionId } : {}),
    memoryId,
    channel,
    reason,
    count: 1,
    lastAt: now,
  });
}

/** 当前会话里等待既有反思/压缩调用判定的送达事件。 */
export function pendingAdoptionDeliveries(limit = MAX_PENDING_FOR_EVALUATION): AdoptionEvent[] {
  const sessionId = getCurrentSessionId();
  const events = readLedger();
  const evaluated = new Set(events.filter((e) => e.kind === 'evaluated').map((e) => e.deliveryId));
  return events
    .filter((e) => e.kind === 'delivered' && !evaluated.has(e.id) && (!sessionId || e.sessionId === sessionId))
    .slice(-Math.max(1, limit));
}

/** 给既有模型调用的紧凑评估任务；无待评估送达时为空，绝不要求模型凑数。 */
export function adoptionEvaluationInstruction(target: 'reflection' | 'compact' = 'compact'): string {
  const pending = pendingAdoptionDeliveries();
  if (pending.length === 0) return '';
  const rows = pending.map((e) => `- deliveryId=${e.id}; memoryId=${e.memoryId}; channel=${e.channel}`).join('\n');
  const rule =
    'Evaluate only the deliveryId values listed below. adopted means a later decision/tool action clearly used the memory; not_applicable means later context clearly made it irrelevant; unclear is the correct default when evidence is insufficient. Do not evaluate a memory merely because it was mentioned.';
  if (target === 'reflection') {
    return (
      '\n## Memory adoption evaluation\n' +
      'The following memories were delivered during this session. Based ONLY on the transcript, add an "adoptions" array to your normal JSON output. Each item is {"deliveryId":"...","verdict":"adopted|not_applicable|unclear","reason":"≤120 chars"}. ' +
      `${rule} Use an empty array when no verdict is defensible.\n` +
      rows
    );
  }
  return (
    '\n## Memory adoption evaluation\n' +
    'The following memories were delivered during this session. Based ONLY on the transcript above, append this JSON-only section after your normal output:\n' +
    '## Memory Adoptions\n' +
    '- {"deliveryId":"...","verdict":"adopted|not_applicable|unclear","reason":"≤120 chars"}\n' +
    `${rule} Omit the heading when no verdict is defensible.\n` +
    rows
  );
}

/** 从模型输出中切走采纳评估段；容错且不影响原输出。 */
export function extractAdoptionEvaluations(raw: string): {
  text: string;
  evaluations: Array<{ deliveryId: string; verdict: AdoptionVerdict; reason?: string }>;
} {
  const lines = String(raw ?? '').split('\n');
  const head = /^ {0,3}##\s+memory\s+adoptions\b/i;
  const start = lines.findIndex((line) => head.test(line));
  if (start < 0) return { text: String(raw ?? ''), evaluations: [] };
  const heading = /^ {0,3}##\s+\S/;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++)
    if (heading.test(lines[i])) {
      end = i;
      break;
    }
  const evaluations: Array<{ deliveryId: string; verdict: AdoptionVerdict; reason?: string }> = [];
  const seen = new Set<string>();
  for (const line of lines.slice(start + 1, end)) {
    const text = line.replace(/^\s*[-*•]\s*/, '').trim();
    if (!text) continue;
    try {
      const e = JSON.parse(text) as { deliveryId?: unknown; verdict?: unknown; reason?: unknown };
      const deliveryId = typeof e.deliveryId === 'string' ? e.deliveryId.trim() : '';
      if (!deliveryId || seen.has(deliveryId) || !isVerdict(e.verdict)) continue;
      seen.add(deliveryId);
      evaluations.push({
        deliveryId,
        verdict: e.verdict,
        ...(typeof e.reason === 'string' && e.reason.trim()
          ? { reason: e.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS) }
          : {}),
      });
    } catch {
      // 某一行坏 JSON 不影响其余有效评估。
    }
  }
  return {
    text: [...lines.slice(0, start), ...lines.slice(end)]
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd(),
    evaluations,
  };
}

/** 应用模型评估。白名单只允许当前尚未评估的真实送达，不能伪造/覆盖历史。 */
export function applyAdoptionEvaluations(
  evaluations: ReadonlyArray<{ deliveryId?: string; verdict?: string; reason?: string }>,
): number {
  const pending = new Map(pendingAdoptionDeliveries(200).map((e) => [e.id, e]));
  let count = 0;
  for (const item of evaluations.slice(0, 20)) {
    const delivery = typeof item.deliveryId === 'string' ? pending.get(item.deliveryId) : undefined;
    const verdict = item.verdict;
    if (!delivery || !isVerdict(verdict)) continue;
    const reason =
      typeof item.reason === 'string' ? item.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS) : '';
    if (
      append({
        memoryId: delivery.memoryId,
        channel: delivery.channel,
        kind: 'evaluated',
        deliveryId: delivery.id,
        verdict,
        ...(reason ? { reason } : {}),
      })
    ) {
      pending.delete(delivery.id);
      count++;
    }
  }
  return count;
}

/** 当前 90 天明细 + 已压缩历史的总统计。
 *
 * 内存里尚未 flush 的抑制桶要一并计入:否则 `/memory adoption` 上看不到本轮刚发生的抑制
 * (它只在轮末落盘),而这两处本来就在 flush 之后调用,多数情况下桶是空的。
 */
export function adoptionStats(): AdoptionStats {
  const current = summarize([...readLedger(), ...bucketEvents()]);
  const summary = readSummary();
  if (summary) mergeStats(current, summary.totals);
  return current;
}

/** 只读详情，按条目过滤时用于 `/memory adoption <memory-id>`。 */
export function adoptionEvents(memoryId?: string, limit = 30): AdoptionEvent[] {
  const all = [...readLedger(), ...bucketEvents()].filter((e) => !memoryId || e.memoryId === memoryId);
  return all.slice(-Math.max(1, limit));
}

/**
 * 把同一 (session, memoryId, channel, reason) 的抑制行合并成一条 count 累加行。
 * 历史逐条行与新的聚合行都是这个 key,所以老账本也能被同一套逻辑收缩。
 * 其它事件原序不动——delivered 的 id 必须保留给评估回填。
 */
function compactSuppressions(events: readonly AdoptionEvent[]): AdoptionEvent[] {
  const merged = new Map<string, AdoptionEvent>();
  const out: AdoptionEvent[] = [];
  for (const e of events) {
    if (e.kind !== 'suppressed') {
      out.push(e);
      continue;
    }
    const key = `${e.sessionId ?? ''}|${e.memoryId}|${e.channel}|${e.reason ?? ''}`;
    const prev = merged.get(key);
    if (!prev) {
      const copy: AdoptionEvent = { ...e, count: e.count && e.count > 0 ? e.count : 1 };
      merged.set(key, copy);
      out.push(copy);
      continue;
    }
    prev.count = (prev.count ?? 1) + (e.count && e.count > 0 ? e.count : 1);
    // 保留较晚的时间戳:id 用首次出现的,at 用最后一次——语义是「这条聚合覆盖到何时」。
    if (Date.parse(e.at) > Date.parse(prev.at)) {
      prev.at = e.at;
      prev.id = e.id;
    }
  }
  return out;
}

/** 将超过 90 天的原始事件压为聚合统计，保留最近明细以便审计。
 *
 * 同时做一次去重压缩:旧版本逐条落盘的抑制行会在这里被合并成 count 聚合行,所以
 * 升级后第一次 `/memory health` 或退出就会把历史账本从几十 MB 降到 KB 级,不需要手工清理。
 */
export function pruneAdoptionLedger(now = Date.now()): void {
  const all = readLedger();
  if (all.length === 0) return;
  const cutoff = now - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  const old = all.filter((e) => Date.parse(e.at) < cutoff);
  const retained = compactSuppressions(all.filter((e) => Date.parse(e.at) >= cutoff));
  // 没有过期事件也可能需要收缩(升级后第一次),所以不能因 old 为空而早退;
  // 真正无事可做时(行数没变且有 summary 在)直接返回,避免每次命中都重写文件。
  const needsCompaction = retained.length !== all.length - old.length;
  if (old.length === 0 && !needsCompaction) return;
  try {
    if (old.length > 0) {
      const existing = readSummary();
      const totals = emptyStats();
      if (existing) mergeStats(totals, existing.totals);
      mergeStats(totals, summarize(old));
      const p = summaryPath();
      mkdirSync(path.dirname(p), { recursive: true });
      const tmp = p + '.tmp';
      writeFileSync(
        tmp,
        JSON.stringify({ schemaVersion: 1, updatedAt: new Date(now).toISOString(), totals }, null, 2) + '\n',
        'utf8',
      );
      renameSync(tmp, p);
    }
    const ledger = ledgerPath();
    const ledgerTmp = ledger + '.tmp';
    writeFileSync(ledgerTmp, retained.map((e) => JSON.stringify(e)).join('\n') + (retained.length ? '\n' : ''), 'utf8');
    renameSync(ledgerTmp, ledger);
  } catch {
    // 保守失败：原账本还在，最多下次再尝试压缩。
  }
}

/** 测试隔离用。 */
export function __resetAdoptionForTests(): void {
  serial = 0;
  suppressionBuckets = new Map();
}
