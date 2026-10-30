// tail.ts —— 会话内记忆尾注(每用户轮刷新的 ephemeral 段)。
//
// 为什么需要它:记忆原本只在**启动时**拼进 history[0](repl/runtime.ts 的 buildSystemMessage),
// 整场会话不再刷新。于是这一轮刚由反思写下、或模型自己 memory_save 的条目,下一轮永远到不了
// 模型——用户看到的是「它明明记下来了,却还是不懂我在说什么」。
//
// 为什么不能重建 history[0]:那是整段对话的前缀,重建会让每一轮的 KV 前缀缓存全部失效
// (每轮按全价重算 prompt)。所以走 model-turn.ts 的 ephemeral 尾部 system 段——与
// sessionStateText 同一手法,只追加在末尾,前缀逐字节不变。
//
// 为什么是「差分」而不是「每轮重发索引」:
//   ① token:真实库索引段已 6010 字符,每轮重发等于每轮白烧;
//   ② 注意力:一直以相同权重存在的信息等于不存在。只有「刚刚变了什么」才有信号。
//
// 叶子模块:只依赖 store(读),不依赖 config/agent/ui。开关由调用方传入布尔值。
//
// 基线是模块级状态(与 proactive.ts 的 fired 一致),因为它的生命周期是**会话**而不是
// 调用点:三处会话边界(启动 / /clear / /resume)各拍一次,期间所有用户轮共用同一份。

import { loadAll, type MemoryEntry } from './store.js';

/** 基线:会话开始时的 id → updatedAt 快照。 */
export type MemoryBaseline = Map<string, string>;

/** 尾注最多带几条。3 与 R2.4 锚点回注同口径——宁可少说,也不要把上下文变成公告栏。 */
const MAX_TAIL_ENTRIES = 3;
/** 单条 body 截断。留够「结论 + 理由」,砍掉长表格与代码块。 */
const MAX_BODY_CHARS = 400;

let baseline: MemoryBaseline | null = null;

/**
 * 拍一份基线。在**会话边界**调用:启动、`/clear`、`/resume`。
 *
 * 拍在启动而非首次构建 prompt 之后:启动到首轮之间反思可能已经跑过一轮,
 * 那些条目属于「上一个会话的成果」,不该被当成「本轮新学到的」再讲一遍。
 *
 * 幂等:重复调用只是把「现在」当成新的起点。
 */
export function captureMemoryBaseline(): void {
  const next: MemoryBaseline = new Map();
  for (const e of loadAll()) next.set(e.id, e.updatedAt);
  baseline = next;
}

/**
 * 生成尾注段。无基线 / 无变化 / 开关关闭 → 空串(零注入,零行为变化)。
 *
 * 只认 active:归档与取代说的是历史,不该以「本轮须知」的姿态出现。
 * 只看 updatedAt 变化,不看 body 内容——reason 改一个字的编辑也算更新,
 * 这是刻意的:能更新说明模型认为它值得改,那下一轮就该知道改了什么。
 */
export function buildMemoryTailSection(enabled: boolean = true): string {
  if (!enabled) return '';
  if (!baseline) return ''; // 没拍过基线 = 调用方没接线,静默不猜

  const changed: MemoryEntry[] = [];
  for (const e of loadAll()) {
    if (e.status !== 'active') continue;
    // episode 在会话**结束**时才写,天然不可能是「在飞的新知识」;把它算进来只会
    // 让上一次会话的摘要冒充本轮成果。
    if (e.type === 'episode') continue;
    const before = baseline.get(e.id);
    if (before === undefined || before !== e.updatedAt) changed.push(e);
  }
  if (changed.length === 0) return '';

  changed.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const shown = changed.slice(0, MAX_TAIL_ENTRIES);
  const lines = shown.map((e) => {
    const head = `- [${e.type}] ${e.id}: ${e.name} — ${e.summary}`;
    const body = (e.body ?? '').replace(/\s+/g, ' ').trim();
    if (!body) return head;
    const clipped = body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}…` : body;
    return `${head}\n  ${clipped}`;
  });
  const omitted = changed.length - shown.length;
  return [
    '## Memory updated during this session',
    'These entries were created or updated after this session started — by background reflection, an earlier turn, or a save you made. They are NOT in the Memory Index at the top (that is a startup snapshot). Treat them as current context; if one contradicts what the code now says, the code wins.',
    ...lines,
    omitted > 0 ? `…(${omitted} more changed; use memory_list to see all)` : '',
  ]
    .filter((s) => s.length > 0)
    .join('\n');
}

/** 仅供测试:清掉基线,避免共享进程里上一个测试的基线串味。 */
export function __resetMemoryBaselineForTests(): void {
  baseline = null;
}
