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
import {
  saveEntry,
  updateEntry,
  forgetEntry,
  supersedeEntry,
  loadAll,
  loadStalenessMap,
  gcMemories,
  wantsTrigger,
  type MemoryType,
} from './store.js';
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
import { formatPendingForReflect, loadPendingCandidates, trimPendingCandidates } from './pending.js';
import {
  applyConsolidation,
  findConsolidationGroups,
  isConsolidationEnabled,
  type ConsolidationDraft,
  type ConsolidationGroup,
} from './episodic.js';

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
  /**
   * 作用域守卫改判条数:请求写 global、但目标形如本仓库源码路径而被改判到 project。
   * 非零说明模型把源码结构事实误归了画像轨,是提示词质量的观测信号。
   */
  scopeEscalated?: number;
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
  /** R13:本轮消化掉的压缩候选条数(压缩→记忆交接通道的观测值)。 */
  pendingConsumed?: number;
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
  // R14:派生条目要带上失效标记。反思看到"这条的根据已经变了"才会去复核或改写,
  // 否则它会拿一条 stale 的抽象结论去跟新事实较劲(甚至因"不矛盾"而继续保留它)。
  const stale = loadStalenessMap();
  const byCreated = [...all].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const byRecall = [...all].sort((a, b) => a.recallCount - b.recallCount);
  const picked = new Map<string, (typeof all)[number]>();
  for (const e of byCreated.slice(0, 10)) picked.set(e.id, e);
  for (const e of byRecall.slice(0, 10)) picked.set(e.id, e);
  const list = [...picked.values()].slice(0, 20);
  return list
    .map((e) => {
      const body = e.body.length > 600 ? e.body.slice(0, 586) + '…[截断]' : e.body;
      // R3:把 trigger 现状一并给模型看。缺 trigger 的条件式条目在反思样本里显式标出,
      // 模型才知道有机会借 updates 补上(否则 propmpt 里那条"可事后补 trigger"永远无从触发)。
      const when = e.trigger ? `trigger: ${e.trigger}` : '';
      const gap = !e.trigger && wantsTrigger(e.type) ? 'trigger: (缺,可借 updates 补)' : '';
      const st = stale.get(e.id);
      const staleNote = st?.stale
        ? `derivedFrom: ${(e.derivedFrom ?? []).join(', ')} — 其中已失效: ${[
            ...st.inactive,
            ...st.missing.map((m: string) => `${m}(已删)`),
          ].join(', ')} [此条可能已过期,请复核后 update 或 forget]`
        : '';
      const tail = [when, gap, e.action ? `action: ${e.action}` : '', staleNote].filter(Boolean).join('\n');
      return `[${e.id}] ${e.name} (${e.type}, recalled ${e.recallCount})\nsummary: ${e.summary}\n${tail ? tail + '\n' : ''}body: ${body}`;
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
Output strictly JSON (no markdown code blocks, no explanatory text): {"saves":[{"type":"...","name":"...","summary":"...","body":"...","trigger":"...","action":"...","supersedes":"old-id-or-empty","derivedFrom":["existing-id"]}],"updates":[{"id":"...","reason":"...","summary":"...","body":"..."}],"forgets":[{"id":"...","reason":"..."}],"triples":[{"src":"...","relation":"...","dst":"...","fact":"..."}],"profile":[{"relation":"...","dst":"...","fact":"..."}],"corrections":[{"relation":"...","dst":"...","fact":"...","old":"..."}],"evidence":[{"edgeId":"...","vote":"confirm|contradict","reason":"..."}]}
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
⑩ evidence is the ONLY channel that adjusts confidence of an EXISTING profile belief from observed behavior — it never creates facts. You are given "Profile beliefs under review" containing only votable edge ids with their current counts. Rules: vote only on ids from that list, at most one vote per id, and only when THIS session genuinely bears on the belief — "confirm" when the user acts/chooses/agrees consistently with it, "contradict" when they act against it or state something incompatible; mere non-mention is NEITHER (omit). NEVER vote on beliefs you are newly creating in profile/corrections this same turn. Be conservative: a few independent confirms (with zero contradicts) auto-internalize a candidate; repeated contradicts demote an internalized belief back to candidate, and every such move is surfaced to the user. When unsure, cast no vote.
⑪ trigger/action — memory entries are CONDITION→ACTION, not just description. For pitfall / decision / feedback saves, write "trigger" = the SITUATION in which this will matter again, phrased as a condition a future session can recognise from its current task (e.g. "constructing a tool schema for kimi-k3 via dashscope compatible-mode", not "when editing code"), and "action" = what to DO once it holds. A vague trigger is WORSE than none — it pollutes proactive matching. Leaving trigger empty is correct when you genuinely cannot predict the situation: it will be filled in later, once the situation actually recurs. fact/reference usually need no trigger. You MAY also fill a missing trigger on an EXISTING entry via updates (just pass "trigger") when this session showed the real situation and the entry currently has none — that is the expected way to complete R1.5 after the fact; do not rewrite an entry's trigger merely to make it prettier.
⑫ derivedFrom — when a save GENERALIZES several existing memories into one abstraction (the same lesson learned in 3 different places), put their ids in that save's "derivedFrom". Do NOT use it for a save that merely cites or supersedes a single entry (that is what "supersedes" is for). Only ids from the "existing memories" list are accepted; self-references and unknowns are dropped. Rationale: the derived entry then carries a live link back to its sources, so the system can tell a future session "the evidence behind this has changed" without deleting an abstraction that may still be true. Most saves should leave it empty.
⑬ anchors — when a save describes HOW a specific piece of code works (a function's contract, a file's structure, a const's meaning, a call-order invariant), attach "anchors": [{"path":"src/foo/bar.ts","symbol":"functionOrConstName"}]. Paths are workspace-relative with forward slashes. Add a symbol whenever the fact is about one function/class/const — that keeps unrelated edits in the same file from marking it stale. Leave anchors empty for anything that is not about specific code (user preferences, process decisions, external services, tool-usage pitfalls). You do NOT write hashes: the content hash is captured at write time, and a later edit to that code makes the memory surface as STALE-CODE instead of silently serving an outdated fact. Paths/symbols that cannot be resolved are dropped. Anchors are the ONE channel that makes memory notice the code moved underneath it — use them whenever the memory would be wrong or misleading after a refactor.`;

const REFLECT_USER = (transcript: string, sample: string, profileEdges: string, pending = '') =>
  `## Recent session\n${transcript}\n\n## Existing memories\n${sample}\n\n## Profile beliefs under review (evidence votes may only target these ids)\n${profileEdges}\n${pending}\n\nProduce JSON:`;

interface ReflectPlan {
  saves?: {
    type?: string;
    name?: string;
    summary?: string;
    body?: string;
    /** R1.5:适用条件。可空;允许事后经 updates 补。 */
    trigger?: string;
    /** R1.5:条件成立时的动作。 */
    action?: string;
    supersedes?: string;
    /** R14:本条由哪些既有条目归纳而来(源条目 id)。只用 existing memories 里出现过的 id。 */
    derivedFrom?: string[];
    /** R2:本条讨论的代码位置。只给 path/symbol,内容哈希由写入时现算。 */
    anchors?: { path?: string; symbol?: string }[];
  }[];
  updates?: { id?: string; reason?: string; summary?: string; body?: string; trigger?: string; action?: string }[];
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
  // R14:本轮开始前已存在的条目 id 集合。derivedFrom 只接受其中真实存在的 id——
  // 模型偶尔会编 id,而编出来的 id 在 computeStaleness 里恒判 missing,
  // 等于让这条新记忆天生就带 stale 标记。
  const knownIds = new Set(loadAll().map((e) => e.id));
  // 本轮开始前的画像边快照:evidence 票只能投给这些 id(本轮新建边无法自我投票)。
  const evidenceSnap = buildProfileEvidenceSnapshot();
  const beforeInternalized = new Set(
    loadScopeGraph('global')
      .edges.filter((e) => evidenceSnap.votable.has(e.id) && isInternalizedEdge(e))
      .map((e) => e.id),
  );
  const sys = { role: 'system' as const, content: REFLECT_SYS } as ChatMessage;
  // R13.3:压缩交接过来的候选。**读一次、只在成功裁决后清空**——反思失败(超时/解析失败)
  // 时保留队列,下一轮还能再试;否则一次网络抖动就把压缩捞出的推理链永久丢掉。
  const pending = loadPendingCandidates();
  const user = {
    role: 'user' as const,
    content: REFLECT_USER(transcript, sample, evidenceSnap.text, formatPendingForReflect(pending)),
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
        trigger: s.trigger ? String(s.trigger) : undefined,
        action: s.action ? String(s.action) : undefined,
        // R14:归纳来源。只接受 existing memories 里真实存在的 id——模型偶尔会编 id,
        // 而编出来的 id 在 computeStaleness 里恒判 missing,等于让这条记忆天生 stale。
        // 这里不静默吞掉,而是过滤掉未知项(saveEntry 内部再滤自引用与重复)。
        derivedFrom: Array.isArray(s.derivedFrom)
          ? s.derivedFrom.map((x) => String(x ?? '').trim()).filter((x) => x && knownIds.has(x))
          : undefined,
        // R2:代码锚点。与 derivedFrom 同理只做**形状过滤**——path/symbol 指向不存在的
        // 文件或符号时由 buildAnchors 丢弃(saveEntry 内),这里不预先校验:多一次
        // 文件系统遍历,而且"文件暂时不存在"不该让整条记忆保存失败。
        anchors: Array.isArray(s.anchors)
          ? s.anchors
              .map((a) => ({
                path: String(a?.path ?? '').trim(),
                symbol: a?.symbol ? String(a.symbol).trim() : undefined,
              }))
              .filter((a) => a.path)
          : undefined,
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
        // R1.5.5 存量兼容:老条目按 updates 逐批补 trigger,不阻断读取。
        trigger: typeof u.trigger === 'string' ? u.trigger : undefined,
        action: typeof u.action === 'string' ? u.action : undefined,
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
  let scopeEscalated = 0;
  if (Array.isArray(plan.triples)) {
    for (const t of plan.triples.slice(0, 10)) {
      if (!t?.src || !t?.relation || !t?.dst) continue;
      const relation = normalizeRelation(String(t.relation));
      if (!isKnownRelation(relation, 'project')) relViolations++;
      // 溯源:项目三元组同样由反思**推断**而来,与 global 画像一致地落 prov/confidence。
      // 此前漏传导致项目图全部边 prov 为空,两轴模型(declared/inferred)在项目格无法生效。
      // sourceEntry 保持 null:三元组源自会话转录,不对应任何内存条目的 id,伪造会污染溯源链。
      const r = addTriple({
        src: String(t.src),
        relation,
        dst: String(t.dst),
        fact: t.fact ? String(t.fact) : undefined,
        scope: 'project',
        prov: 'reflection',
        confidence: 0.4,
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
      // 目标形如本仓库源码路径 → addTriple 已确定性改判到 project(画像轨收不下它)。
      if (r.ok && r.scopeEscalated) scopeEscalated++;
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

  // R13.3:本轮成功裁决了这批候选 → 从队列里删掉**这一批**。传候选本身而不是条数:
  // 队列有 40 条上限,满队时反思期间新增的候选把最旧的挤出去、长度不变,
  // 按条数切会把整队清空并连带删掉这一轮没看过的新候选。失败路径早已 return,队列原样保留。
  if (pending.length > 0) {
    trimPendingCandidates(pending);
    result.pendingConsumed = pending.length;
  }

  const gc = gcMemories();

  result.saves = saves;
  result.updates = updates;
  result.forgets = forgets;
  result.triples = triples;
  result.profiles = profiles;
  result.relViolations = relViolations;
  if (scopeEscalated) result.scopeEscalated = scopeEscalated;
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

// ── R11 情节巩固(episode → 语义)────────────────────────────────────────────
//
// 分工:分组是确定性的(见 episodic.ts 的 findConsolidationGroups),本段只负责
// 「把一组成员说成一句可复用的话」。这是 memory 子系统里第二个调 LLM 的地方,
// 但与反思共用同一个在飞槽位与 drain —— 不新开后台进程(R11.4)。

export interface ConsolidationResult {
  ts: string;
  /** 本轮找到的候选组数。 */
  groups: number;
  /** 成功落库(新建或命中既有)的组数。 */
  consolidated: number;
  /** 模型判定「这几条只是凑巧」而跳过的组数。 */
  skipped: number;
  error?: string;
  rawParseFailure?: string;
}

const CONSOLIDATE_SYS = `You are mocode's sleep-time consolidator. You are given SEVERAL past working sessions from the same workspace that appear to share a theme. Your job: decide whether they really share a reusable lesson, and if so, state it ONCE as a durable memory.

Output strictly JSON (no markdown fences, no explanation):
{"skip":false,"type":"...","name":"...","summary":"...","body":"...","trigger":"...","action":"..."}
or, when these sessions share no real lesson:
{"skip":true,"reason":"..."}

Rules:
① **Generalize only what actually recurs.** These episodes came from different sessions; the value is the pattern a future session can reuse. Do NOT just restate what each session did.
② **If they merely touched the same files for unrelated reasons, output {"skip":true}.** A false generalization is worse than no memory: it turns coincidence into a rule. The "shared signals" section lists why they were grouped — use it as a hint, not as proof.
③ Keep every concrete detail that would make the conclusion wrong when omitted (the actual constraint, the actual cause, the actual command/path). Drop the story: which session, in what order, how many times.
④ type ∈ {${TYPES}}. Choose by nature: a repeatable approach → decision; something that bites → pitfall; a stable structural fact → fact; a preference/expectation of the user → feedback; external knowledge → reference.
⑤ name: short, lowercase-kebab or a concise phrase, distinct from existing memories.
⑥ summary: one line (< 120 chars) — the reusable claim itself.
⑦ body: 3-6 lines. State the pattern, then the evidence in one line (e.g. "seen in 3 sessions across 2 weeks"), then the boundary (when it does NOT hold).
⑧ trigger/action: for pitfall/decision/feedback, trigger = the SITUATION a future session can recognise from its current task; action = what to do then. Vague triggers ("when editing code") are worse than empty — omit them instead.
⑨ Never mention memory ids, session ids, or that this came from consolidation. The entry must read as knowledge, not as a bookkeeping artifact.`;

function consolidatePrompt(group: {
  input: string;
  sharedFiles: readonly string[];
  sharedTokens: readonly string[];
  sessions: number;
  members: readonly unknown[];
}): ChatMessage {
  const signals: string[] = [`sessions: ${group.sessions}`, `episodes: ${group.members.length}`];
  if (group.sharedFiles.length > 0) signals.push(`shared files: ${group.sharedFiles.join(', ')}`);
  if (group.sharedTokens.length > 0) signals.push(`shared terms: ${group.sharedTokens.join(', ')}`);
  return {
    role: 'user',
    content: `## Sessions that appear to share a theme\n${group.input}\n\n## Shared signals\n${signals.join('\n')}\n\nProduce JSON:`,
  } as ChatMessage;
}

/** 解析巩固产物。`skip` 与残缺 JSON 都返回 null 之外的可判别结果。 */
export function parseConsolidationPlan(
  content: string | null,
): { skip: true; reason?: string } | { skip: false; draft: ConsolidationDraft } | null {
  if (!content) return null;
  let s = content.trim();
  const fences = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (fences.length) s = fences[fences.length - 1]![1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(s.replace(/,\s*([}\]])/g, '$1')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!p || typeof p !== 'object') return null;
  if (p.skip === true) return { skip: true, reason: typeof p.reason === 'string' ? p.reason : undefined };
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const draft: ConsolidationDraft = {
    type: normalizeType(p.type),
    name: str(p.name),
    summary: str(p.summary),
    body: str(p.body),
    trigger: str(p.trigger) || undefined,
    action: str(p.action) || undefined,
  };
  // name/summary/body 缺一不可:残缺的产物写进库就是一条没有标题或没有内容的记忆,
  // 而它还挂着 derivedFrom/derivedInto 双向链,比不巩固更糟。
  if (!draft.name || !draft.summary || !draft.body) return null;
  return { skip: false, draft };
}

/**
 * 跑一轮巩固。`groups` 省略时现算候选(调用方通常省略)。
 * 任一组失败不影响其它组:一组解析失败只损失那一组的归纳机会,不该连坐。
 */
export async function runConsolidation(
  groups?: readonly ConsolidationGroup[],
  signal?: AbortSignal,
): Promise<ConsolidationResult> {
  const ts = new Date().toISOString();
  const list = groups ?? findConsolidationGroups();
  const result: ConsolidationResult = { ts, groups: list.length, consolidated: 0, skipped: 0 };
  if (list.length === 0) return result;
  const timeoutSignal = signal ?? AbortSignal.timeout(REFLECT_TIMEOUT_MS);
  for (const group of list) {
    try {
      const first = await fetchReflection(
        [{ role: 'system' as const, content: CONSOLIDATE_SYS } as ChatMessage, consolidatePrompt(group)],
        timeoutSignal,
      );
      let plan = parseConsolidationPlan(first.content);
      if (plan === null) {
        // 与反思同一套「修复式重试」:推理模型偶发把 JSON 混进说明文字。
        const repair = await fetchReflection(
          [
            { role: 'system' as const, content: CONSOLIDATE_SYS } as ChatMessage,
            consolidatePrompt(group),
            { role: 'assistant' as const, content: first.content ?? '' } as ChatMessage,
            {
              role: 'user' as const,
              content: '上一条无法解析。只输出一个 JSON 对象,不要围栏不要解释。无共同规律就输出 {"skip":true}。',
            } as ChatMessage,
          ],
          timeoutSignal,
        );
        plan = parseConsolidationPlan(repair.content);
        if (plan === null) {
          result.error ??= 'parse-failed';
          result.rawParseFailure ??= repair.raw ?? first.raw ?? undefined;
          continue;
        }
      }
      if (plan.skip) {
        result.skipped++;
        continue;
      }
      const applied = applyConsolidation(group, plan.draft);
      if (applied.ok) result.consolidated++;
      else result.error ??= applied.reason;
    } catch (e) {
      if (timeoutSignal.aborted) {
        result.error = '巩固超时(后端持续失败或无响应)';
        break; // 超时说明后端已不可用,继续下一组只会再等一次
      }
      result.error ??= e instanceof Error ? e.message : String(e);
    }
  }
  return result;
}

/**
 * fire-and-forget 触发巩固。与 kickoffReflection 共用 `inflight`:
 * 后台 LLM 任务串行执行,不会同时压两条请求给后端(drain 也只需等一个槽位)。
 *
 * **无候选时零成本返回**:分组是纯本地计算,先算再看要不要发请求——
 * 这是这条通道与反思的关键成本差异(反思每 N 轮必发一次,巩固只在真有材料时才发)。
 */
export function kickoffConsolidation(manual: boolean = false): void {
  if (inflight) return;
  if (!isMemoryEnabled()) return;
  if (!isConsolidationEnabled()) return;
  const groups = findConsolidationGroups();
  if (groups.length === 0) return;
  if (!manual) {
    if (autoConsolidateCount >= MAX_AUTO_CONSOLIDATIONS) return;
    autoConsolidateCount++;
  }
  inflight = (async () => {
    try {
      const r = await runConsolidation(groups);
      lastConsolidationResult = r;
      appendLog(`[${r.ts}] ${formatConsolidationResult(r)}`);
      if (r.rawParseFailure) {
        appendLog(`  ↳ 巩固 parse-failed 原始返回: ${r.rawParseFailure.replace(/\s+/g, ' ').slice(0, 500)}`);
      }
    } catch (e) {
      appendLog(`[${new Date().toISOString()}] 巩固异常: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inflight = null;
    }
  })();
}

/**
 * 自动巩固的每进程次数上限。比反思的 3 次更紧:巩固一次最多两组请求,
 * 而它的收益只在"情节攒够了"时才兑现,高频跑只会把同一批数据反复归纳。
 * env:MOCODE_CONSOLIDATE_MAX_PER_SESSION 覆盖。
 */
const MAX_AUTO_CONSOLIDATIONS = Math.max(1, Number(process.env.MOCODE_CONSOLIDATE_MAX_PER_SESSION) || 2);
let autoConsolidateCount = 0;
let lastConsolidationResult: ConsolidationResult | null = null;

export function getLastConsolidationResult(): ConsolidationResult | null {
  return lastConsolidationResult;
}
export function clearLastConsolidationResult(): void {
  lastConsolidationResult = null;
}

/** 测试用:清零自动巩固计数(模块级状态,共享进程里必须清)。 */
export function __resetConsolidateThrottleForTests(): void {
  autoConsolidateCount = 0;
  lastConsolidationResult = null;
}

/** 摘要串(供 repl flush):巩固 N 组(跳过 M 条)。 */
export function formatConsolidationResult(r: ConsolidationResult): string {
  const parts = [`巩固 ${r.consolidated}/${r.groups} 组`];
  if (r.skipped > 0) parts.push(`跳过 ${r.skipped}`);
  if (r.error) parts.push(`错误 ${r.error}`);
  return parts.join(' ');
}
