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
}

export interface AdoptionStats {
  delivered: number;
  suppressed: number;
  evaluated: number;
  adopted: number;
  notApplicable: number;
  unclear: number;
  /** 仅近期账本可知；被压缩进历史汇总的事件不可能再被评估。 */
  pending: number;
  byChannel: Record<AdoptionChannel, number>;
  suppressedByReason: Partial<Record<AdoptionSuppressionReason, number>>;
}

interface AdoptionSummary {
  schemaVersion: 1;
  updatedAt: string;
  totals: Omit<AdoptionStats, 'pending'>;
}

const CHANNELS: AdoptionChannel[] = [
  'proactive_trigger',
  'proactive_anchor',
  'anchor_read',
  'turn_recall',
  'memory_tail',
];
let serial = 0;

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

function summarize(events: readonly AdoptionEvent[]): AdoptionStats {
  const out = emptyStats();
  const delivered = new Set<string>();
  const evaluated = new Set<string>();
  for (const e of events) {
    if (e.kind === 'delivered') {
      delivered.add(e.id);
      out.delivered++;
      out.byChannel[e.channel]++;
    } else if (e.kind === 'suppressed') {
      out.suppressed++;
      if (e.reason)
        out.suppressedByReason[e.reason as AdoptionSuppressionReason] =
          (out.suppressedByReason[e.reason as AdoptionSuppressionReason] ?? 0) + 1;
    } else {
      evaluated.add(e.deliveryId!);
      out.evaluated++;
      if (e.verdict === 'adopted') out.adopted++;
      else if (e.verdict === 'not_applicable') out.notApplicable++;
      else out.unclear++;
    }
  }
  out.pending = [...delivered].filter((id) => !evaluated.has(id)).length;
  return out;
}

function mergeStats(target: AdoptionStats, add: Omit<AdoptionStats, 'pending'>): void {
  for (const key of ['delivered', 'suppressed', 'evaluated', 'adopted', 'notApplicable', 'unclear'] as const)
    target[key] += add[key];
  for (const channel of CHANNELS) target.byChannel[channel] += add.byChannel[channel];
  for (const [reason, count] of Object.entries(add.suppressedByReason)) {
    target.suppressedByReason[reason as AdoptionSuppressionReason] =
      (target.suppressedByReason[reason as AdoptionSuppressionReason] ?? 0) + count;
  }
}

function append(event: Omit<AdoptionEvent, 'id' | 'at' | 'sessionId'>): string | null {
  if (memoryWriteBlockReason()) return null;
  const now = new Date().toISOString();
  const id = `adopt-${now.replace(/[-:.TZ]/g, '')}-${++serial}`;
  const record: AdoptionEvent = {
    id,
    at: now,
    ...(getCurrentSessionId() ? { sessionId: getCurrentSessionId() } : {}),
    ...event,
  };
  try {
    const p = ledgerPath();
    mkdirSync(path.dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(record) + '\n', 'utf8');
    return id;
  } catch {
    return null;
  }
}

/** 记录一条真正进入模型上下文或工具结果的记忆。 */
export function recordMemoryDelivery(memoryId: string, channel: AdoptionChannel): string | null {
  if (!memoryId) return null;
  return append({ memoryId, channel, kind: 'delivered' });
}

/** 记录命中但被限流/去重治理挡住的记忆；它从未进入采纳分母。 */
export function recordMemorySuppression(
  memoryId: string,
  channel: AdoptionChannel,
  reason: AdoptionSuppressionReason,
): void {
  if (!memoryId) return;
  append({ memoryId, channel, kind: 'suppressed', reason });
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

/** 当前 90 天明细 + 已压缩历史的总统计。 */
export function adoptionStats(): AdoptionStats {
  const current = summarize(readLedger());
  const summary = readSummary();
  if (summary) mergeStats(current, summary.totals);
  return current;
}

/** 只读详情，按条目过滤时用于 `/memory adoption <memory-id>`。 */
export function adoptionEvents(memoryId?: string, limit = 30): AdoptionEvent[] {
  const all = readLedger().filter((e) => !memoryId || e.memoryId === memoryId);
  return all.slice(-Math.max(1, limit));
}

/** 将超过 90 天的原始事件压为聚合统计，保留最近明细以便审计。 */
export function pruneAdoptionLedger(now = Date.now()): void {
  const all = readLedger();
  if (all.length === 0) return;
  const cutoff = now - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  const old = all.filter((e) => Date.parse(e.at) < cutoff);
  if (old.length === 0) return;
  const retained = all.filter((e) => !old.includes(e));
  try {
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
}
