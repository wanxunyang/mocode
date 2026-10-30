/**
 * R13 压缩 → 记忆交接:压缩候选的暂存区。
 *
 * 为什么需要这一层(而不是压缩时直接写记忆库):
 *  压缩是**高频路径**——一轮里可能压好几次,每次都由一次摘要 LLM 调用顺带产出候选。
 *  这些候选**未经任何闸门**:模型在压上下文时顺手写的一句话,可能只是"当前这个 bug 还没修好"
 *  这类一次性状态。直接进正式库等于绕过了反思的全部规则(①只收跨会话有用的、②宁少勿多、
 *  ⑤先改旧的别新建重复)。所以候选先落这里,等下一次反思按既有六桶规则裁决。
 *
 * 为什么落在 `<cwd>/.mocode/` 而不是 session 目录:
 *  候选是**项目级**的(压缩掉的是本项目的会话),且反思进程与 REPL 是同一个;放 session 目录
 *  会让跨会话的候选随会话 id 散成一堆,反思还得去猜读哪个。
 *
 * 叶子依赖约定:本模块只依赖 node 内置。不能 import config(= 有环)或 agent/llm/tools,
 * 开关由调用方算好布尔值传进来(与 store.ts 的 memory 开关同一套约定)。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// R8.3/R8.5:暂停或关闭时这条交接通道也要闭嘴——否则用户在 /memory pause 之后
// 仍然会在 .mocode/ 里看到新文件被建出来,那正是「暂停」最不该有的行为。
import { memoryWriteBlockReason } from './write-gate.js';

/**
 * 队列上限。压缩是高频路径,无上限会让文件无限增长,也让反思 prompt 被候选挤爆。
 * 40 条约等于十几次压缩的量;超过就丢最旧的——最近压掉的推理链才是还有救的。
 */
const MAX_PENDING = 40;

/** 单条候选正文上限(字符)。候选是"一句话提示",不是正文;长了说明模型在抄摘要。 */
const MAX_TEXT_CHARS = 300;

/** 一条待裁决的候选。 */
export interface MemoryCandidate {
  /** 模型建议的类型。**仅作提示**——反思会按自己的规则重新判定,给错也不会污染库。 */
  kind: string;
  /** 一句话:什么情况下 + 该记住什么。 */
  text: string;
  /** 落队时刻(ISO),用于排查与排序。 */
  at: string;
  /** 来源通道。目前只有压缩交接;留字段是为了将来 episode 巩固等复用同一队列。 */
  source: string;
}

/**
 * R13 交接开关。默认开启,`MOCODE_MEMORY_COMPACT_HANDOFF=0/false/off/no` 关闭。
 * 与 R3 的 `MOCODE_MEMORY_PROACTIVE` 同一套写法:env-only,不新增 config 字段。
 * **不代替** memory 总开关——调用方仍需先判 `isMemoryEnabled()`,两者是与关系。
 */
export function isCompactHandoffEnabled(): boolean {
  const raw = process.env.MOCODE_MEMORY_COMPACT_HANDOFF;
  if (raw === undefined) return true;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

function pendingPath(): string {
  return path.join(process.cwd(), '.mocode', 'memory-pending.jsonl');
}

function ensureParent(p: string): void {
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 读队列(静默容错:不存在 / 读失败 / 坏行 → 跳过,永不抛)。 */
export function loadPendingCandidates(): MemoryCandidate[] {
  const p = pendingPath();
  if (!existsSync(p)) return [];
  let content: string;
  try {
    content = readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  if (!content.trim()) return [];
  const out: MemoryCandidate[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line) as MemoryCandidate;
      if (c && typeof c.text === 'string' && c.text.trim()) out.push(c);
    } catch {
      /* 坏行跳过:队列是 best-effort 通道,不值得为一行坏数据中断 */
    }
  }
  return out;
}

function writeAll(items: MemoryCandidate[]): void {
  const p = pendingPath();
  ensureParent(p);
  const body = items.map((c) => JSON.stringify(c)).join('\n');
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, p);
}

/** 归一一行文本用于去重:去标点/空白差异后小写,避免同一条被反复压进队列。 */
function textKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[。.,;；:：!！?？]+$/g, '')
    .trim();
}

/**
 * 追加候选。返回**实际新增**的条数(已存在的、空的、超长的被滤掉)。
 *
 * 幂等性:同一句话只会进队一次。压缩可能对同一段旧区压两次(先失败后成功、
 * 或手动 /compact 重跑),没有这层去重队列会被同一批候选灌满。
 */
export function appendPendingCandidates(items: ReadonlyArray<{ kind?: string; text?: string }>): number {
  if (items.length === 0) return 0;
  // R8.3/R8.5:暂停写入时连队列都不该涨。这里返回 0 而不是抛错——压缩是后台路径,
  // 它的调用方只关心「进了几条」。
  if (memoryWriteBlockReason()) return 0;
  const existing = loadPendingCandidates();
  const seen = new Set(existing.map((c) => textKey(c.text)));
  const now = new Date().toISOString();
  const fresh: MemoryCandidate[] = [];
  for (const raw of items) {
    const text = String(raw.text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const key = textKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fresh.push({
      kind:
        String(raw.kind ?? '')
          .trim()
          .toLowerCase() || 'unknown',
      text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + '…' : text,
      at: now,
      source: 'compact',
    });
  }
  if (fresh.length === 0) return 0;
  // 超上限丢最旧的:队列按时间追加,slice(-MAX_PENDING) 即保最新。
  const merged = [...existing, ...fresh].slice(-MAX_PENDING);
  writeAll(merged);
  return fresh.length;
}

/**
 * 丢弃**反思已裁决过的那批候选**,保留其余。
 *
 * 为什么不是"清空":反思是几十秒的后台请求,期间主 agent 完全可能又压了一次上下文、
 * 又追加了候选。无脑清空会把**这一轮根本没被看过**的新候选一起删掉。
 *
 * 为什么按**身份**而不是"前 N 条":队列有 40 条上限,满队时新增候选会把最旧的挤出去,
 * 队列长度仍是 40。此时"切掉前 40 条"= 整队清空,反思期间刚追加的候选一条不剩——
 * 正是上面那句论证要防的事,却因为 cap 让「长度不变」而绕过。改为传入已裁决的那批
 * 候选本身,按 `textKey` 身份删除:被 cap 挤掉的条目删不到(已不在队列里,无害),
 * 期间新增的条目身份不匹配,必然保留。
 *
 * **只在反思成功裁决后调用**——反思失败(超时/解析失败)时一条都不能丢,
 * 否则一次网络抖动就把压缩捞出来的推理链永久扔掉,而那正是这条通道唯一的价值。
 */
export function trimPendingCandidates(consumed: ReadonlyArray<{ text: string }>): void {
  if (consumed.length === 0) return;
  const p = pendingPath();
  if (!existsSync(p)) return;
  try {
    const drop = new Set(consumed.map((c) => textKey(String(c?.text ?? ''))).filter(Boolean));
    if (drop.size === 0) return;
    const all = loadPendingCandidates();
    const kept = all.filter((c) => !drop.has(textKey(c.text)));
    if (kept.length !== all.length) writeAll(kept);
  } catch {
    /* best-effort:清不掉只会让下一轮多看到几条已裁决的候选,不致命 */
  }
}

/** 待裁决条数(观测/测试用)。 */
export function pendingCandidateCount(): number {
  return loadPendingCandidates().length;
} // ── 与压缩摘要器共享的协议 ──────────────────────────────────────────────────
//
// 摘要器是压缩路径上**已有**的那次 LLM 调用,不能再加一次(R13.1 的硬约束)。
// 所以候选只能作为「摘要正文之后的附加段」被顺带产出,再由确定性代码切走。
// 三条硬要求:
//   1. 候选段必须在存进 history 之前被剥掉——否则摘要里会混进一段"给反思看的草稿",
//      白白占上下文,还会被下一代摘要当成叙述再压一遍。
//   2. 段标题必须与 `## Key Facts` 同级且唯一,否则 splitSummaryText 的分段会错位。
//   3. 措辞由本模块统一产出:legacy 与 fork 两条路径若各写一份,迟早漂移成两种格式,
//      而解析端只有一套。

/** 候选段标题。解析端与提示词端共用;改动即破坏跨版本兼容(旧摘要里可能还有旧标题)。 */
export const MEMORY_CANDIDATES_HEADING = '## Memory Candidates';

/** 单次压缩最多收几条。压上下文时模型的注意力在"总结"上,多要只会换来凑数。 */
const MAX_CANDIDATES_PER_COMPACTION = 3;

/**
 * 追加到摘要提示词末尾的要求。
 *
 * 为什么强调「空白是正常结果」:不写这句,模型会为了填满字段而编出"改代码时要小心"
 * 这类零信息量的候选,把队列挤满,再让反思白读一遍——这比没有候选更糟。
 */
export function memoryCandidatesInstruction(): string {
  return (
    `\nAFTER the summary, if and only if the transcript above contains something a FUTURE session would need ` +
    `and that is about to be lost with this context, append this section (it is NOT part of the 400-word limit):\n` +
    `${MEMORY_CANDIDATES_HEADING}\n` +
    `- [pitfall|decision|feedback|fact|reference] <one line: the situation it applies to + what to remember, ≤120 chars>\n` +
    `At most ${MAX_CANDIDATES_PER_COMPACTION} items. Report ONLY things that compaction is about to destroy: ` +
    `a dead end that cost real time and must not be retried, a constraint the user stated once and will not repeat, ` +
    `a non-obvious cause discovered by experiment, a decision with its reason. ` +
    `Do NOT report task progress, files changed, next steps (the summary already carries those), ` +
    `anything re-derivable by re-reading the repo, or generic advice. ` +
    `An EMPTY section is the normal and expected outcome — omit the heading entirely when nothing qualifies.`
  );
}

/**
 * 从摘要正文里切走候选段。返回「干净的摘要」+「候选列表」。
 *
 * 容错优先:模型可能写成 `## memory candidates`、可能在段内用 `*` 而非 `-`、
 * 也可能压根不输出这一段(常态)。任何一种都不能让压缩本身失败——所以这里
 * 全程不抛,认不出就原样返回。
 */
export function extractMemoryCandidates(raw: string): {
  summary: string;
  candidates: Array<{ kind: string; text: string }>;
} {
  const text = String(raw ?? '');
  const lines = text.split('\n');
  const headRe = /^ {0,3}##\s+memory\s+candidates\b/i;
  const start = lines.findIndex((l) => headRe.test(l));
  if (start < 0) return { summary: text, candidates: [] };

  // 段尾 = 下一个 `## ` 级标题(若模型把候选段放在中间),否则到文末。
  const anyHeading = /^ {0,3}##\s+\S/;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (anyHeading.test(lines[i])) {
      end = i;
      break;
    }
  }

  const candidates: Array<{ kind: string; text: string }> = [];
  for (const line of lines.slice(start + 1, end)) {
    const m = /^\s*[-*•]\s*(?:\[([^\]]*)\]\s*)?(.+?)\s*$/.exec(line);
    if (!m) continue;
    const body = m[2].trim();
    if (!body) continue;
    // 占位符式回答("无"/"none")不该变成候选。
    if (/^(无|没有|none|n\/a|-)$/i.test(body)) continue;
    candidates.push({
      kind: (m[1] ?? '').trim().toLowerCase() || 'unknown',
      text: body,
    });
    if (candidates.length >= MAX_CANDIDATES_PER_COMPACTION) break;
  }

  // 剥段:连同它前面的空行一起去掉,避免摘要尾部留一串空行。
  const kept = [...lines.slice(0, start), ...lines.slice(end)];
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return { summary: kept.join('\n'), candidates };
}

/**
 * 把待裁决候选渲染成反思 prompt 的一节。空队列返回空串(调用方据此不加这一节)。
 *
 * 措辞上必须把它们降级成「未经验证的提示」:它们出自压缩器,而压缩器的任务是
 * 总结不是记忆裁决,它不知道库里有哪条旧记忆、也不知道①/②/⑨/⑪ 这些规则。
 */
export function formatPendingForReflect(items: readonly MemoryCandidate[]): string {
  if (items.length === 0) return '';
  const lines = items.map((c) => `- [${c.kind}] ${c.text}`).join('\n');
  return (
    `\n## Candidates salvaged from context compaction\n` +
    `These one-liners were pulled out of reasoning that compaction was about to discard. ` +
    `They are UNVERIFIED hints produced by a summarizer, NOT memories: it never saw your rules and never saw the library. ` +
    `Judge each under the normal rules and turn it into saves/updates only when it genuinely passes them; ` +
    `prefer updating an existing entry over adding a near-duplicate. ` +
    `Dropping all of them is a normal and correct outcome — one-off task state, restated progress and generic advice must all be dropped.\n` +
    `${lines}`
  );
}
