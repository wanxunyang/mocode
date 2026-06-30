// memory 反思 pass:后台异步复盘近期会话 + 现有记忆,产出 saves/updates/forgets 落地。
// 依赖 llm(chat)——同 session/compact.ts 模式,非环(llm 不反向依赖 memory)。
// store.ts 仍是叶子;本模块是 memory 子系统里唯一调 LLM 的部分。
//
// 异步与静默:kickoffReflection fire-and-forget(repl 轮末调),与下一轮 agent 并发跑;
// 期间不碰 contentWrite / 状态行(否则与 RUNNING 态 agent 争屏)。结果缓存到 lastReflectResult,
// repl 在下次进 INPUT 态的安全点 flush 一行 dim 摘要。错误写 <cwd>/.mocode/memory.log。
//
// 并发安全:store 读写全同步(单 tick 原子),本模块里唯一让出事件循环的是 await chat();
// 其前后的 store 调用不会与 agent 的 store 调用交错(单线程 + await 间不重叠)→ 无竞态。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chat, type ChatMessage } from '../llm/index.js';
import { config } from '../config/index.js';
import {
  saveEntry,
  updateEntry,
  forgetEntry,
  loadAll,
  gcMemories,
  type MemoryType,
} from './store.js';

export interface ReflectResult {
  ts: string;
  saves: number;
  updates: number;
  forgets: number;
  gcDecayed: number;
  gcCapped: number;
  gcGced: number;
  error?: string;
}

// ── 日志(静默容错,裁尾保最近)─────────────────────────────────────────────
function logPath(): string {
  return path.join(process.cwd(), '.mocode', 'memory.log');
}
function appendLog(line: string): void {
  try {
    const p = logPath();
    const dir = path.dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let content = '';
    if (existsSync(p)) content = readFileSync(p, 'utf8');
    content = (content + '\n' + line).slice(-20000);
    writeFileSync(p, content, 'utf8');
  } catch {
    // 静默:日志失败不阻断
  }
}

// ── 转录快照(同步,避免下一轮 mutate history 的竞态)─────────────────────────
function textOf(c: unknown): string {
  if (typeof c === 'string') return c;
  if (c == null) return '';
  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === 'string' ? p : (p as { text?: string })?.text ?? ''))
      .join('');
  }
  return String(c);
}

/**
 * 同步拍平最近 K 条对话(跳过 history[0] 大系统提示)。每条裁到 600 字符、总体裁到 6000,
 * 控制反思 prompt 体积。在 kickoff 调用前同步取快照,异步 pass 用这份文本,不再读 history。
 */
export function snapshotTranscript(history: ChatMessage[], K: number): string {
  const convo = history.slice(1).slice(-K);
  const lines = convo.map((m) => {
    const role = (m as { role?: string }).role ?? '?';
    let line = `${role}: ${textOf((m as { content?: unknown }).content)}`;
    const tcs = (m as { tool_calls?: { function?: { name?: string; arguments?: string } }[] })
      .tool_calls;
    if (Array.isArray(tcs)) {
      for (const tc of tcs) {
        line += `\n  [tool_call ${tc?.function?.name ?? ''}] ${tc?.function?.arguments ?? ''}`;
      }
    }
    if (line.length > 600) line = line.slice(0, 586) + '…[截断]';
    return line;
  });
  const joined = lines.join('\n');
  if (joined.length <= 6000) return joined;
  return joined.slice(0, 5980) + '\n…[转录已截断]';
}

// ── 记忆样本(供 LLM 判断 update/forget)──────────────────────────────────────
function buildMemorySample(): string {
  const all = loadAll().filter((e) => e.status === 'active');
  if (all.length === 0) return '(无)';
  const byCreated = [...all].sort(
    (a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''),
  );
  const byRecall = [...all].sort((a, b) => a.recallCount - b.recallCount);
  const picked = new Map<string, typeof all[number]>();
  for (const e of byCreated.slice(0, 10)) picked.set(e.id, e);
  for (const e of byRecall.slice(0, 10)) picked.set(e.id, e);
  const list = [...picked.values()].slice(0, 20);
  return list
    .map((e) => {
      const body = e.body.length > 600 ? e.body.slice(0, 586) + '…[截断]' : e.body;
      return `[${e.id}] ${e.name} (${e.type}, recalled ${e.recallCount})\nsummary: ${e.summary}\nbody: ${body}`;
    })
    .join('\n---\n');
}

const TYPES = 'decision | fact | pitfall | reference | feedback';

const REFLECT_SYS = `You are mocode's memory reflector. Review the recent session and existing memories, producing **only** updates worth remembering long-term.
Output strictly JSON (no markdown code blocks, no explanatory text): {"saves":[{"type":"...","name":"...","summary":"...","body":"..."}],"updates":[{"id":"...","reason":"...","summary":"...","body":"..."}],"forgets":[{"id":"...","reason":"..."}]}
Empty arrays are valid (if nothing is worth saving, all three arrays are empty).
Rules:
① Only store non-obvious, cross-session-useful facts/decisions/pitfalls; do not store current bugs, temp files, undecided TODOs, or volatile items;
② Better to store less than to store trivially correct info (e.g. "keep it concise");
③ ids in updates/forgets must come from the "existing memories" list below; do not fabricate ids not listed there;
④ names in saves must be concise and not collide with existing ones; type ∈ {${TYPES}};
⑤ If an existing memory contradicts new facts or is outdated, update the old entry (modify summary/body) rather than creating a duplicate;
⑥ forgets are for memories clearly stale / superseded by a new entry (archive, not hard-delete).`;

const REFLECT_USER = (transcript: string, sample: string) =>
  `## Recent session\n${transcript}\n\n## Existing memories\n${sample}\n\nProduce JSON:`;

interface ReflectPlan {
  saves?: { type?: string; name?: string; summary?: string; body?: string }[];
  updates?: { id?: string; reason?: string; summary?: string; body?: string }[];
  forgets?: { id?: string; reason?: string }[];
}

function parsePlan(content: string | null): ReflectPlan | null {
  if (!content) return null;
  let s = content.trim();
  // 去 ```json … ``` 代码块(模型偶发包裹)
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 容错:截到首个 { 到末个 }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try {
    const p = JSON.parse(s) as ReflectPlan;
    if (!p || typeof p !== 'object') return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * 跑一次反思:chat() 空 handlers(静默)→ 解析 JSON → 经 store 落地 → gcMemories。
 * 解析失败整 pass 放弃(不部分落地)。store 调用全同步,落地是一个原子块。
 * 60s 超时(AbortSignal.timeout)防 exit 时 drain 挂死。
 */
export async function runReflection(
  transcript: string,
  signal?: AbortSignal,
): Promise<ReflectResult> {
  const ts = new Date().toISOString();
  const sample = buildMemorySample();
  const sys = { role: 'system' as const, content: REFLECT_SYS } as ChatMessage;
  const user = { role: 'user' as const, content: REFLECT_USER(transcript, sample) } as ChatMessage;

  let result: ReflectResult = {
    ts,
    saves: 0,
    updates: 0,
    forgets: 0,
    gcDecayed: 0,
    gcCapped: 0,
    gcGced: 0,
  };

  let content: string | null = null;
  try {
    const r = await chat([sys, user], {}, signal ?? AbortSignal.timeout(60000));
    // 推理模型偶发只返 reasoning_content(content null)或幻觉 tool_calls → 视为无产出
    if (!r.toolCalls.length && r.content) content = r.content;
  } catch (e) {
    result.error = e instanceof Error ? e.name + ': ' + e.message : String(e);
    return result;
  }

  const plan = parsePlan(content);
  if (!plan) {
    result.error = 'parse-failed';
    return result;
  }

  let saves = 0;
  let updates = 0;
  let forgets = 0;
  if (Array.isArray(plan.saves)) {
    for (const s of plan.saves) {
      if (!s?.name || !s?.summary) continue;
      const r = saveEntry({
        name: String(s.name),
        summary: String(s.summary),
        body: String(s.body ?? s.summary),
        type: normalizeType(s.type),
      });
      if (r.ok) saves++;
    }
  }
  if (Array.isArray(plan.updates)) {
    for (const u of plan.updates) {
      if (!u?.id) continue;
      const r = updateEntry(String(u.id), {
        summary: u.summary ? String(u.summary) : undefined,
        body: u.body ? String(u.body) : undefined,
        reason: u.reason ? String(u.reason) : undefined,
      });
      if (r.ok) updates++;
    }
  }
  if (Array.isArray(plan.forgets)) {
    for (const f of plan.forgets) {
      if (!f?.id) continue;
      const r = forgetEntry(String(f.id), 'archive');
      if (r.ok) forgets++;
    }
  }
  const gc = gcMemories();

  result = { ...result, saves, updates, forgets, gcDecayed: gc.decayed, gcCapped: gc.capped, gcGced: gc.gced };
  return result;
}

function normalizeType(t: unknown): MemoryType | undefined {
  if (typeof t !== 'string') return undefined;
  const v = t.trim().toLowerCase();
  if (v === 'decision' || v === 'fact' || v === 'pitfall' || v === 'reference' || v === 'feedback')
    return v;
  return undefined;
}

// ── 后台编排:kickoff / drain / 缓存 ─────────────────────────────────────────
let inflight: Promise<void> | null = null;
let lastReflectResult: ReflectResult | null = null;

/** 摘要串(供 repl flush):存N 改N 忘N;有错误附上。 */
export function formatReflectResult(r: ReflectResult): string {
  const parts = [`存${r.saves}`, `改${r.updates}`, `忘${r.forgets}`];
  if (r.gcDecayed || r.gcCapped || r.gcGced) {
    parts.push(`遗忘(衰减${r.gcDecayed}/封顶${r.gcCapped}/清除${r.gcGced})`);
  }
  return `记忆反思:${parts.join(' ')}${r.error ? ` [${r.error}]` : ''}`;
}

/**
 * fire-and-forget 触发反思。已有在飞任务 / autoReflect 关闭 → 跳过。
 * repl 轮末调:与下一轮 agent 并发跑,不阻塞。
 */
export function kickoffReflection(transcript: string): void {
  if (inflight) return;
  if (!config.autoReflect) return;
  inflight = (async () => {
    try {
      const r = await runReflection(transcript);
      lastReflectResult = r;
      appendLog(`[${r.ts}] ${formatReflectResult(r)}`);
    } catch (e) {
      appendLog(
        `[${new Date().toISOString()}] 反思异常: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      inflight = null;
    }
  })();
}

/** 退出前等在飞反思收尾(startRepl 尾调;Ctrl+C 走 SIGINT 直退不等)。 */
export async function drainMemoryBackground(): Promise<void> {
  if (inflight) {
    try {
      await inflight;
    } catch {
      // 已在 kickoff 内 log
    }
  }
}

export function getLastReflectResult(): ReflectResult | null {
  return lastReflectResult;
}
export function clearLastReflectResult(): void {
  lastReflectResult = null;
}
