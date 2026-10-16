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
import { config, isMemoryEnabled } from '../config/index.js';
import { saveEntry, updateEntry, forgetEntry, loadAll, gcMemories, type MemoryType } from './store.js';
import { addTriple, ensurePrimaryPerson, PRIMARY_PERSON_ID } from './graph.js';
import { normalizeRelation, isKnownRelation, relationCheatSheet } from './relation-vocab.js';

export interface ReflectResult {
  ts: string;
  saves: number;
  updates: number;
  forgets: number;
  triples: number;
  gcDecayed: number;
  gcCapped: number;
  gcGced: number;
  /** 全局用户画像三元组(挂 person-primary)落条数。 */
  profiles?: number;
  /** 词表外关系条数(软策略仍写入,仅观测)。 */
  relViolations?: number;
  error?: string;
  /** parse-failed 时的原始返回片段(供 kickoff 落 memory.log 排查);成功不设。 */
  rawParseFailure?: string;
  /** 首轮解析失败后是否触发过一次「修复式重试」。 */
  repairAttempted?: boolean;
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
    return c.map((p) => (typeof p === 'string' ? p : ((p as { text?: string })?.text ?? ''))).join('');
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
    const tcs = (m as { tool_calls?: { function?: { name?: string; arguments?: string } }[] }).tool_calls;
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
  const byCreated = [...all].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const byRecall = [...all].sort((a, b) => a.recallCount - b.recallCount);
  const picked = new Map<string, (typeof all)[number]>();
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
Output strictly JSON (no markdown code blocks, no explanatory text): {"saves":[{"type":"...","name":"...","summary":"...","body":"..."}],"updates":[{"id":"...","reason":"...","summary":"...","body":"..."}],"forgets":[{"id":"...","reason":"..."}],"triples":[{"src":"...","relation":"...","dst":"...","fact":"..."}],"profile":[{"relation":"...","dst":"...","fact":"..."}]}
Empty arrays are valid (if nothing is worth saving, all arrays are empty).
Rules:
① Only store non-obvious, cross-session-useful facts/decisions/pitfalls; do not store current bugs, temp files, undecided TODOs, or volatile items;
② Better to store less than to store trivially correct info (e.g. "keep it concise");
③ ids in updates/forgets must come from the "existing memories" list below; do not fabricate ids not listed there;
④ names in saves must be concise and not collide with existing ones; type ∈ {${TYPES}};
⑤ If an existing memory contradicts new facts or is outdated, update the old entry (modify summary/body) rather than creating a duplicate;
⑥ forgets are for memories clearly stale / superseded by a new entry (archive, not hard-delete);
⑦ triples are PROJECT knowledge-graph facts about THIS CODEBASE distilled from this session: concise entity names (lowercase snake_case or proper nouns) plus a one-line fact. Prioritize the high-reuse structural relations in this order — dependency/ownership (depends_on, uses, used_by, calls, part_of), location (implemented_in, reads, writes, configured_by, runs_on, listens_on), verification (tests, documented_in), rationale/risk (decided_by, conflicts_with); full list: ${relationCheatSheet('project')}. Favor facts that would help a future session navigate or avoid re-deriving (which module implements X, what depends on Y, what conflicts with Z). A relation outside this list is allowed only when none fits (it gets flagged for review). Only emit triples that are stable, non-obvious and reusable in this repo (2-6 at most).
⑧ profile is for facts about THE USER (the human), which must apply across ALL projects — identity, role, expertise, language/communication style, stable preferences, current goals, constraints. They are attached to the single canonical person entity. Each item: dst is a short atomic value/entity, fact is one neutral Chinese sentence stating it. Prefer these relations: ${relationCheatSheet('global')}. A relation outside this list is allowed only when none fits. NEVER put repo paths, commands, file names, ports, secrets or one-task details in profile — those belong in triples. Only emit profile when the user explicitly revealed something durable about themselves (0-3 items); when unsure, omit.`;

const REFLECT_USER = (transcript: string, sample: string) =>
  `## Recent session\n${transcript}\n\n## Existing memories\n${sample}\n\nProduce JSON:`;

interface ReflectPlan {
  saves?: { type?: string; name?: string; summary?: string; body?: string }[];
  updates?: { id?: string; reason?: string; summary?: string; body?: string }[];
  forgets?: { id?: string; reason?: string }[];
  triples?: { src?: string; relation?: string; dst?: string; fact?: string }[];
  /**
   * 全局用户画像(跨项目):关于"用户这个人"的稳定事实,自动挂到规范实体
   * person-primary、写入 global 图;与项目 triples(默认 project)分流。
   */
  profile?: { relation?: string; dst?: string; fact?: string }[];
}

export function parsePlan(content: string | null): ReflectPlan | null {
  if (!content) return null;
  let s = content.trim();
  // 去 ```json … ``` 代码块(模型偶发包裹);取最后一个块(前面可能有解释文字)。
  const fences = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (fences.length) s = fences[fences.length - 1]![1].trim();
  // 容错:截到首个 { 到末个 }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try {
    const p = JSON.parse(s) as ReflectPlan;
    if (!p || typeof p !== 'object') return null;
    return p;
  } catch {
    // 再试一次:去掉对象/数组尾逗号(模型常见的非法 JSON)。
    try {
      const p = JSON.parse(s.replace(/,\s*([}\]])/g, '$1')) as ReflectPlan;
      if (p && typeof p === 'object') return p;
    } catch {
      // 落到 null
    }
    return null;
  }
}

/** 取一次反思 LLM 返回的可解析文本(content 优先;tool_calls 的 JSON 串参数兜底)。 */
async function fetchReflection(
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<{ content: string | null; raw: string | null }> {
  const r = await chat(messages, {}, signal, undefined, { reasoningEffort: 'low' });
  if (!r.toolCalls.length && r.content) return { content: r.content, raw: null };
  // 推理模型偶发只把 JSON 塞进 tool_calls 参数、或 content 为 null:从工具调用里捞 JSON 串。
  for (const tc of r.toolCalls) {
    const args = (tc as { function?: { arguments?: string } }).function?.arguments;
    if (typeof args === 'string' && args.includes('{')) return { content: args, raw: null };
  }
  // 无可用正文(典型:只吐 reasoning_content):保留简短指纹供日志排查。
  const fingerprint = r.content
    ? `content=${r.content.slice(0, 200)}`
    : `content=null, toolCalls=${r.toolCalls.length}`;
  return { content: null, raw: fingerprint };
}

/**
 * 跑一次反思:chat() 空 handlers(静默)→ 解析 JSON → 经 store 落地 → gcMemories。
 * 首轮解析失败时做**一次修复式重试**(明确要求"只输出 JSON、不要思考过程"),
 * 重试仍失败才报 parse-failed——此时 rawParseFailure 带原始返回指纹,由 kickoff 落
 * memory.log,不再像旧版那样无声丢掉一整轮且无从排查。store 调用全同步。
 * 60s 超时(AbortSignal.timeout)防 exit 时 drain 挂死。
 */
export async function runReflection(transcript: string, signal?: AbortSignal): Promise<ReflectResult> {
  const ts = new Date().toISOString();
  const sample = buildMemorySample();
  const sys = { role: 'system' as const, content: REFLECT_SYS } as ChatMessage;
  const user = { role: 'user' as const, content: REFLECT_USER(transcript, sample) } as ChatMessage;

  const result: ReflectResult = {
    ts,
    saves: 0,
    updates: 0,
    forgets: 0,
    triples: 0,
    gcDecayed: 0,
    gcCapped: 0,
    gcGced: 0,
  };

  const timeoutSignal = signal ?? AbortSignal.timeout(60000);
  let content: string | null = null;
  try {
    const first = await fetchReflection([sys, user], timeoutSignal);
    content = first.content;
    // 首轮拿不到可解析正文 → 一次修复式重试(同一超时信号的剩余预算)。
    if (parsePlan(content) === null) {
      result.repairAttempted = true;
      const repairUser = {
        role: 'user' as const,
        content:
          '你的上一条回复无法被解析为目标 JSON。现在只输出一个 JSON 对象,不要 markdown 围栏、不要解释、不要思考过程,' +
          '形状严格为 {"saves":[],"updates":[],"forgets":[],"triples":[]};没有值得长期记住的内容就全部给空数组。',
      } as ChatMessage;
      const second = await fetchReflection(
        [sys, user, { role: 'assistant', content: content ?? '' } as ChatMessage, repairUser],
        timeoutSignal,
      );
      if (second.content) content = second.content;
      if (!content && first.raw) result.rawParseFailure = first.raw;
      else if (second.raw && parsePlan(content) === null) result.rawParseFailure = second.raw;
    }
  } catch (e) {
    result.error = e instanceof Error ? e.name + ': ' + e.message : String(e);
    return result;
  }

  const plan = parsePlan(content);
  if (!plan) {
    result.error = 'parse-failed';
    if (!result.rawParseFailure) result.rawParseFailure = (content ?? '').slice(0, 300);
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
  // 知识图谱三元组:容错——单项失败跳过,不影响 saves/updates/forgets 已落地的结果。
  // 关系名先归一(别名/拼写);词表外关系仍允许写(软封闭世界),但计 relViolations 供观测。
  let triples = 0;
  let relViolations = 0;
  if (Array.isArray(plan.triples)) {
    for (const t of plan.triples.slice(0, 10)) {
      if (!t?.src || !t?.relation || !t?.dst) continue;
      const relation = normalizeRelation(String(t.relation));
      if (!isKnownRelation(relation, 'project')) relViolations++;
      const r = addTriple({
        src: String(t.src),
        relation,
        dst: String(t.dst),
        fact: t.fact ? String(t.fact) : undefined,
      });
      if (r.ok && !r.duplicate) triples++;
    }
  }
  // 全局用户画像:挂到规范 person-primary、写 global 图(与项目 triples 分流)。
  let profiles = 0;
  if (Array.isArray(plan.profile) && plan.profile.length > 0) {
    let personId = PRIMARY_PERSON_ID;
    try {
      personId = ensurePrimaryPerson().id;
    } catch {
      personId = PRIMARY_PERSON_ID;
    }
    for (const p of plan.profile.slice(0, 6)) {
      if (!p?.relation || !p.dst) continue;
      const relation = normalizeRelation(String(p.relation));
      if (!isKnownRelation(relation, 'global')) relViolations++;
      const r = addTriple({
        src: personId,
        relation,
        dst: String(p.dst),
        fact: p.fact ? String(p.fact) : undefined,
        scope: 'global',
      });
      if (r.ok && !r.duplicate) profiles++;
    }
  }
  const gc = gcMemories();

  result.saves = saves;
  result.updates = updates;
  result.forgets = forgets;
  result.triples = triples;
  result.profiles = profiles;
  result.relViolations = relViolations;
  result.gcDecayed = gc.decayed;
  result.gcCapped = gc.capped;
  result.gcGced = gc.gced;
  return result;
}

function normalizeType(t: unknown): MemoryType | undefined {
  if (typeof t !== 'string') return undefined;
  const v = t.trim().toLowerCase();
  if (v === 'decision' || v === 'fact' || v === 'pitfall' || v === 'reference' || v === 'feedback') return v;
  return undefined;
}

// ── 后台编排:kickoff / drain / 缓存 ─────────────────────────────────────────
let inflight: Promise<void> | null = null;
let lastReflectResult: ReflectResult | null = null;

/** 摘要串(供 repl flush):存N 改N 忘N 图N [画像N 违N];有错误附上。 */
export function formatReflectResult(r: ReflectResult): string {
  const parts = [`存${r.saves}`, `改${r.updates}`, `忘${r.forgets}`, `图${r.triples}`];
  if (r.profiles) parts.push(`画像${r.profiles}`);
  if (r.relViolations) parts.push(`违${r.relViolations}`);
  if (r.gcDecayed || r.gcCapped || r.gcGced) {
    parts.push(`遗忘(衰减${r.gcDecayed}/封顶${r.gcCapped}/清除${r.gcGced})`);
  }
  return `记忆反思:${parts.join(' ')}${r.error ? ` [${r.error}]` : ''}`;
}

/**
 * fire-and-forget 触发反思。已有在飞任务 / autoReflect 关闭 / 记忆子系统总开关关闭 → 跳过。
 * 记忆关闭时反思毫无意义(没有可存的地方),且会误打日志、误弹摘要,故一并短路。
 * repl 轮末调:与下一轮 agent 并发跑,不阻塞。
 */
export function kickoffReflection(transcript: string): void {
  if (inflight) return;
  if (!config.autoReflect) return;
  if (!isMemoryEnabled()) return;
  inflight = (async () => {
    try {
      const r = await runReflection(transcript);
      lastReflectResult = r;
      appendLog(`[${r.ts}] ${formatReflectResult(r)}`);
      if (r.error === 'parse-failed' && r.rawParseFailure) {
        // 留证:旧版 parse-failed 无声丢弃,无法排查(实测约三成反思命中)。
        appendLog(`  ↳ parse-failed 原始返回: ${r.rawParseFailure.replace(/\s+/g, ' ').slice(0, 500)}`);
      }
    } catch (e) {
      appendLog(`[${new Date().toISOString()}] 反思异常: ${e instanceof Error ? e.message : String(e)}`);
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
