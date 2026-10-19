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
import { saveEntry, updateEntry, forgetEntry, supersedeEntry, loadAll, gcMemories, type MemoryType } from './store.js';
import {
  addTriple,
  ensurePrimaryPerson,
  invalidateProfileEdges,
  voteEdge,
  loadScopeGraph,
  PRIMARY_PERSON_ID,
} from './graph.js';
import { isInternalizedEdge } from './persona.js';
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
  /** 用户纠正桶应用条数(失效旧画像边 / 落新画像边)。 */
  corrections?: number;
  /** 本次反思是否因用户显式纠正改动了 L2 内化画像(行为自动转正/降级走 promotions/demotions)。 */
  profileChanged?: boolean;
  /** 进入 L2 的新画像事实(供摘要提示用户 /profile 复核)。 */
  profileChangedFacts?: string[];
  /** 经多轮行为印证自动转正(候选→内化)的条数。 */
  promotions?: number;
  promotionFacts?: string[];
  /** 因强反证自动降级(内化→候选)的条数。 */
  demotions?: number;
  demotionFacts?: string[];
  /** 本轮实际采纳的行为证据票数。 */
  evidenceVotes?: number;
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

interface ProfileEvidenceSnapshot {
  /** prompt 用清单文本(含 id、内化态、当前计数、陈述)。 */
  text: string;
  /** 本轮反思开始前可投票的 active 画像边 id 白名单(本轮新建边不在其中)。 */
  votable: Set<string>;
  /** id → 人类可读陈述(转正/降级摘要展示用)。 */
  statements: Map<string, string>;
}

/**
 * 待投票的画像边快照(反思 prompt 用):当前 global 图里 person-primary 的 active 边,
 * 连同当前证据计数/后验,让模型只对"本轮对话行为确实印证或相悖"的边投票。
 * 关键:这是**本轮反思开始前**拍的快照,本轮新建的 profile/corrections 边不在白名单——
 * 防止模型给自己刚推断出的信念投票一次转正(自我强化)。
 */
function buildProfileEvidenceSnapshot(): ProfileEvidenceSnapshot {
  const g = loadScopeGraph('global');
  const byId = new Map(g.entities.map((e) => [e.id, e]));
  const edges = g.edges
    .filter((e) => !e.invalidAt && e.src === PRIMARY_PERSON_ID && e.dst !== PRIMARY_PERSON_ID)
    .slice(0, 20);
  const votable = new Set<string>();
  const statements = new Map<string, string>();
  const text = edges
    .map((e) => {
      const dst = byId.get(e.dst);
      const target = dst?.name ?? e.dst;
      const statement = e.fact?.trim() || `${e.relation}:${target}`;
      votable.add(e.id);
      statements.set(e.id, statement);
      const c = e.evidence?.confirmed ?? 0;
      const x = e.evidence?.contradicted ?? 0;
      const state = isInternalizedEdge(e) ? 'internalized' : 'candidate';
      return `[${e.id}] (${state}, evidence confirm=${c} contradict=${x}) ${statement}`;
    })
    .join('\n');
  return { text: edges.length === 0 ? '(无)' : text, votable, statements };
}

const TYPES = 'decision | fact | pitfall | reference | feedback';

/** 后台反思整体超时:卡住的请求不能拖过退出 drain,也不该长期占用在飞槽位。 */
const REFLECT_TIMEOUT_MS = 60_000;
/**
 * 后台任务的重试预算:只要 3 次尝试(连接类首败零等待,其后退避 ~1s、~2s)。
 * 不能用交互式 chat 默认的 10 次——指数退避累计 0+1+2+4+8+16+30≈61s,恰好打满
 * 上面的 60s 超时:后端持续失败时超时会落在退避 sleep 里,最后只剩一条含义不明的
 * 'AbortError: This operation was aborted'(实测 2026-10 多次出现在状态行)。
 */
const REFLECT_MAX_ATTEMPTS = 3;

const REFLECT_SYS = `You are mocode's memory reflector. Review the recent session and existing memories, producing **only** updates worth remembering long-term.
Output strictly JSON (no markdown code blocks, no explanatory text): {"saves":[{"type":"...","name":"...","summary":"...","body":"...","supersedes":"old-id-or-empty"}],"updates":[{"id":"...","reason":"...","summary":"...","body":"..."}],"forgets":[{"id":"...","reason":"..."}],"triples":[{"src":"...","relation":"...","dst":"...","fact":"..."}],"profile":[{"relation":"...","dst":"...","fact":"..."}],"corrections":[{"relation":"...","dst":"...","fact":"...","old":"..."}],"evidence":[{"edgeId":"...","vote":"confirm|contradict","reason":"..."}]}
Empty arrays are valid (if nothing is worth saving, all arrays are empty).
Rules:
① Only store non-obvious, cross-session-useful facts/decisions/pitfalls; do not store current bugs, temp files, undecided TODOs, or volatile items;
② Better to store less than to store trivially correct info (e.g. "keep it concise");
③ ids in updates/forgets/supersedes must come from the "existing memories" list below; do not fabricate ids not listed there;
④ names in saves must be concise and not collide with existing ones; type ∈ {${TYPES}};
⑤ If an existing memory contradicts new facts or is outdated, update the old entry (modify summary/body) rather than creating a duplicate; if a NEW entry fully replaces an old one whose title/scope differs, put the old id in that save's "supersedes" field (the old entry is marked superseded, not deleted);
⑥ forgets are for memories clearly stale / superseded by a new entry (archive, not hard-delete);
⑦ triples are PROJECT knowledge-graph facts about THIS CODEBASE distilled from this session: concise entity names (lowercase snake_case or proper nouns) plus a one-line fact. Prioritize the high-reuse structural relations in this order — dependency/ownership (depends_on, uses, used_by, calls, part_of), location (implemented_in, reads, writes, configured_by, runs_on, listens_on), verification (tests, documented_in), rationale/risk (decided_by, conflicts_with); full list: ${relationCheatSheet('project')}. Favor facts that would help a future session navigate or avoid re-deriving (which module implements X, what depends on Y, what conflicts with Z). A relation outside this list is allowed only when none fits (it gets flagged for review). Only emit triples that are stable, non-obvious and reusable in this repo (2-6 at most).
⑧ profile is for facts about THE USER (the human), which must apply across ALL projects — identity, role, expertise, language/communication style, stable preferences, current goals, constraints. They are attached to the single canonical person entity. Each item: dst is a short atomic value/entity, fact is one neutral Chinese sentence stating it. Prefer these relations: ${relationCheatSheet('global')}. A relation outside this list is allowed only when none fits. NEVER put repo paths, commands, file names, ports, secrets or one-task details in profile — those belong in triples. Only emit profile when the user explicitly revealed something durable about themselves (0-3 items); when unsure, omit. Profile items from your own inference are stored as LOW confidence and will NOT be internalized until the user confirms them — do not inflate them.
⑨ corrections is the HIGHEST signal channel: use it ONLY when the user explicitly corrects a prior belief about themselves ("不对/别这样/我已经不在 X 了/我更喜欢…"). Each correction invalidates the previous value for that relation and installs the new one as user-confirmed. "relation" is the profile relation being corrected, "dst"/"fact" are the NEW value (same shape as profile), "old" is the old value being withdrawn (short hint, may be empty). Do not put repo/code corrections here — those use updates/forgets.
⑩ evidence is the ONLY channel that adjusts confidence of an EXISTING profile belief from observed behavior — it never creates facts. You are given "Profile beliefs under review" containing only votable edge ids with their current counts. Rules: vote only on ids from that list, at most one vote per id, and only when THIS session genuinely bears on the belief — "confirm" when the user acts/chooses/agrees consistently with it, "contradict" when they act against it or state something incompatible; mere non-mention is NEITHER (omit). NEVER vote on beliefs you are newly creating in profile/corrections this same turn. Be conservative: a few independent confirms (with zero contradicts) auto-internalize a candidate; repeated contradicts demote an internalized belief back to candidate, and every such move is surfaced to the user. When unsure, cast no vote.`;

const REFLECT_USER = (transcript: string, sample: string, profileEdges: string) =>
  `## Recent session\n${transcript}\n\n## Existing memories\n${sample}\n\n## Profile beliefs under review (evidence votes may only target these ids)\n${profileEdges}\n\nProduce JSON:`;

interface ReflectPlan {
  saves?: { type?: string; name?: string; summary?: string; body?: string; supersedes?: string }[];
  updates?: { id?: string; reason?: string; summary?: string; body?: string }[];
  forgets?: { id?: string; reason?: string }[];
  triples?: { src?: string; relation?: string; dst?: string; fact?: string }[];
  /**
   * 全局用户画像(跨项目):关于"用户这个人"的稳定事实,自动挂到规范实体
   * person-primary、写入 global 图;与项目 triples(默认 project)分流。
   * 反思推断的画像以 prov=reflection/confidence=0.4 落库(L1 观察,不进 About you)。
   */
  profile?: { relation?: string; dst?: string; fact?: string }[];
  /**
   * 用户显式纠正桶(最高信号):失效同关系旧画像值,以 user_confirmed 安装新值
   * (直接 L2 内化)。只用于"关于用户这个人"的自我纠正,不用于代码/仓库修正。
   */
  corrections?: { relation?: string; dst?: string; fact?: string; old?: string }[];
  /**
   * 环境证据投票(行为印证通道):只对"本轮开始前已存在"且 prompt 清单里列出的画像边
   * 投票。confirm 累积到阈值候选自动转正;contradict 累积到阈值内化边自动降回候选。
   * 给本轮新建边投票会被白名单拒绝(防自我强化一次转正)。
   */
  evidence?: { edgeId?: string; vote?: string; reason?: string }[];
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
  const r = await chat(messages, {}, signal, undefined, {
    reasoningEffort: 'low',
    maxAttempts: REFLECT_MAX_ATTEMPTS,
  });
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
 * REFLECT_TIMEOUT_MS 超时(AbortSignal.timeout)防 exit 时 drain 挂死;重试预算收紧到
 * REFLECT_MAX_ATTEMPTS 次,避免交互式 10 次退避打满超时后只剩含义不明的 AbortError。
 */
export async function runReflection(transcript: string, signal?: AbortSignal): Promise<ReflectResult> {
  const ts = new Date().toISOString();
  const sample = buildMemorySample();
  // 本轮开始前的画像边快照:evidence 票只能投给这些 id(本轮新建边无法自我投票)。
  const evidenceSnap = buildProfileEvidenceSnapshot();
  const beforeInternalized = new Set(
    loadScopeGraph('global')
      .edges.filter((e) => evidenceSnap.votable.has(e.id) && isInternalizedEdge(e))
      .map((e) => e.id),
  );
  const sys = { role: 'system' as const, content: REFLECT_SYS } as ChatMessage;
  const user = {
    role: 'user' as const,
    content: REFLECT_USER(transcript, sample, evidenceSnap.text),
  } as ChatMessage;

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

  const timeoutSignal = signal ?? AbortSignal.timeout(REFLECT_TIMEOUT_MS);
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
    // 超时到期时 fetch/退避 sleep 抛的是 AbortError/DOMException,文案 'This operation
    // was aborted' 完全无法区分原因;统一归类成可读的超时提示(秒数按实际信号预算)。
    if (timeoutSignal.aborted) {
      // 内部自建信号的预算由本模块常量决定,可给出准确秒数;外部传入的信号(retention
      // 巩固)预算在调用方,不臆测数字。
      result.error = signal
        ? '反思超时(后端持续失败或无响应)'
        : `反思超时(${REFLECT_TIMEOUT_MS / 1000}s,后端持续失败或无响应)`;
    } else {
      result.error = e instanceof Error ? e.name + ': ' + e.message : String(e);
    }
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
      if (r.ok) {
        saves++;
        // 新条目显式取代旧条目(标题/范围不同,不适合原地 update):回填取代链,
        // 旧条目转 superseded(从默认索引隐藏但不删除,可审计)。
        const oldId = typeof s.supersedes === 'string' ? s.supersedes.trim() : '';
        if (oldId && oldId !== r.id) {
          supersedeEntry(oldId, r.id, 'superseded by new entry from reflection');
        }
      }
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
  // M2 信念分级:反思**推断**的画像以 prov=reflection / confidence=0.4 落库——
  // 不进 About you(L2),只进候选(L1),等用户确认或多会话佐证后晋升。
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
        prov: 'reflection',
        confidence: 0.4,
      });
      if (r.ok && !r.duplicate) profiles++;
    }
  }
  // 用户纠正桶(最高信号):失效同关系旧画像值,以 user_confirmed(1.0,直接 L2)安装新值。
  // 单值关系即便不显式失效旧边,addTriple 也会按 (src,relation) 时序取代;这里多做一步
  // 是为了 old 指向的非单值旧值(prefers/constraint 等多值关系)也能被精准撤回。
  let corrections = 0;
  const profileChangedFacts: string[] = [];
  if (Array.isArray(plan.corrections)) {
    let personId = PRIMARY_PERSON_ID;
    try {
      personId = ensurePrimaryPerson().id;
    } catch {
      personId = PRIMARY_PERSON_ID;
    }
    for (const c of plan.corrections.slice(0, 6)) {
      if (!c?.relation || !c.dst) continue;
      const relation = normalizeRelation(String(c.relation));
      if (!isKnownRelation(relation, 'global')) relViolations++;
      const oldHint = typeof c.old === 'string' ? c.old.trim() : '';
      invalidateProfileEdges(relation, oldHint || undefined);
      const r = addTriple({
        src: personId,
        relation,
        dst: String(c.dst),
        fact: c.fact ? String(c.fact) : undefined,
        scope: 'global',
        prov: 'user_confirmed',
        confidence: 1,
      });
      if (r.ok && !r.duplicate) {
        corrections++;
        const factText = c.fact ? String(c.fact) : String(c.dst);
        profileChangedFacts.push(factText);
      }
    }
  }
  // 环境证据投票:只能投本轮开始前快照里的边;同 id 一轮一票;不存在/本轮新建的 id 一律
  // 丢弃(防自我强化)。以投票前后的内化态变化识别自动转正/降级。
  let promotions = 0;
  let demotions = 0;
  let evidenceVotes = 0;
  const promotionFacts: string[] = [];
  const demotionFacts: string[] = [];
  if (Array.isArray(plan.evidence)) {
    const seen = new Set<string>();
    for (const v of plan.evidence.slice(0, 20)) {
      const id = typeof v?.edgeId === 'string' ? v.edgeId.trim() : '';
      if (!id || seen.has(id)) continue;
      if (!evidenceSnap.votable.has(id)) continue;
      const vote = typeof v.vote === 'string' ? v.vote.trim().toLowerCase() : '';
      if (vote !== 'confirm' && vote !== 'contradict') continue;
      seen.add(id);
      const was = beforeInternalized.has(id);
      const vr = voteEdge(id, vote);
      if (!vr.ok) continue;
      evidenceVotes++;
      const eNow = loadScopeGraph('global').edges.find((x) => x.id === id);
      const now = eNow ? isInternalizedEdge(eNow) : false;
      const fact = evidenceSnap.statements.get(id) ?? id;
      if (!was && now) {
        promotions++;
        promotionFacts.push(fact);
      } else if (was && !now) {
        demotions++;
        demotionFacts.push(fact);
      }
    }
  }

  const gc = gcMemories();

  result.saves = saves;
  result.updates = updates;
  result.forgets = forgets;
  result.triples = triples;
  result.profiles = profiles;
  result.relViolations = relViolations;
  result.corrections = corrections;
  result.profileChanged = corrections > 0;
  result.profileChangedFacts = profileChangedFacts.slice(0, 3);
  result.promotions = promotions;
  result.promotionFacts = promotionFacts.slice(0, 3);
  result.demotions = demotions;
  result.demotionFacts = demotionFacts.slice(0, 3);
  if (evidenceVotes) result.evidenceVotes = evidenceVotes;
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

/**
 * 自动反思节流(默认开启后必须配成本闸,否则每 reflectEveryN 轮一个后台 LLM 请求):
 *  - 每进程至多 N 次自动反思(/reflect 手动不受限);
 *  - 转录里 user 实质内容低于阈值不触发(纯工具轮/空轮没有可记的东西)。
 * env:MOCODE_REFLECT_MAX_PER_SESSION 覆盖次数。
 */
const MAX_AUTO_REFLECTS = Math.max(1, Number(process.env.MOCODE_REFLECT_MAX_PER_SESSION) || 3);
const MIN_USER_CHARS = 40;
let autoReflectCount = 0;

/** 转录里是否有足够的"用户原话"值得反思(tool_call/assistant 行不计)。 */
export function hasSubstantialUserContent(transcript: string): boolean {
  const userText = transcript
    .split('\n')
    .filter((line) => line.startsWith('user:'))
    .map((line) => line.slice(5).trim())
    .join(' ')
    .trim();
  return userText.length >= MIN_USER_CHARS;
}

/** 测试专用:重置自动反思计数。 */
export function __resetReflectThrottleForTests(): void {
  autoReflectCount = 0;
}

/** 摘要串(供 repl flush):存N 改N 忘N 图N [画像N 纠N 违N];有错误附上。 */
export function formatReflectResult(r: ReflectResult): string {
  const parts = [`存${r.saves}`, `改${r.updates}`, `忘${r.forgets}`, `图${r.triples}`];
  if (r.profiles) parts.push(`画像候选${r.profiles}`);
  if (r.corrections) parts.push(`纠正${r.corrections}`);
  if (r.promotions) parts.push(`印证转正${r.promotions}`);
  if (r.demotions) parts.push(`反证降级${r.demotions}`);
  if (r.relViolations) parts.push(`违${r.relViolations}`);
  if (r.gcDecayed || r.gcCapped || r.gcGced) {
    parts.push(`遗忘(衰减${r.gcDecayed}/封顶${r.gcCapped}/清除${r.gcGced})`);
  }
  let line = `记忆反思:${parts.join(' ')}${r.error ? ` [${r.error}]` : ''}`;
  // 关于人的信念被改动必须让用户有机会否决(区别于仓库事实的静默写入)。
  // 不加 ANSI:repl flush 时整串已包 ui.gray。
  if (r.profileChanged && r.profileChangedFacts?.length) {
    line += `\n  ↳ 已按你的纠正更新长期画像:${r.profileChangedFacts.join(';')}(/memory profile 可查看或撤销)`;
  }
  // 信念分级的自动升降级同样必须透明:它们改了常驻画像却没经过显式批准,要给用户否决机会。
  if (r.promotions && r.promotionFacts?.length) {
    line += `\n  ↳ 多次行为印证,已自动内化:${r.promotionFacts.join(';')}(/memory drop 可撤销)`;
  }
  if (r.demotions && r.demotionFacts?.length) {
    line += `\n  ↳ 与近期行为反复相悖,已退回候选:${r.demotionFacts.join(';')}(/memory confirm 可恢复)`;
  }
  return line;
}

/**
 * fire-and-forget 触发反思。已有在飞任务 / 记忆子系统总开关关闭 → 跳过。
 * 自动触发(manual=false)还受两道成本闸:config.autoReflect 开关、每进程次数上限、
 * 转录需含足够用户原话;手动 /reflect(manual=true)绕过前两道(仍要求记忆开关开)。
 * 记忆关闭时反思毫无意义(没有可存的地方),且会误打日志、误弹摘要,故一并短路。
 * repl 轮末调:与下一轮 agent 并发跑,不阻塞。
 */
export function kickoffReflection(transcript: string, manual: boolean = false): void {
  if (inflight) return;
  if (!isMemoryEnabled()) return;
  if (!manual) {
    if (!config.autoReflect) return;
    if (autoReflectCount >= MAX_AUTO_REFLECTS) return;
    if (!hasSubstantialUserContent(transcript)) return;
    autoReflectCount++;
  }
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
