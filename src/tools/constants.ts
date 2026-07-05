/** 工具共享的截断 / 上限 / 忽略规则。 */
export const MAX_FILE_LINES = 2000;
export const MAX_OUTPUT = 20000;
export const MAX_RESULTS = 100;

/** 进 history 的单条工具结果上限(字符)。push-time 第一层裁剪,保 head + 标记 + tail。 */
export const MAX_HISTORY_RESULT = 8000;
/** use_skill 结果(SKILL.md 正文)的放宽上限:指令须完整,中截会破坏语义。 */
export const MAX_SKILL_RESULT = 64000;
/** 微压缩时旧工具结果截到的存根长度(字符)。 */
export const MAX_OLD_TOOL_STUB = 600;

// ── 记忆(Tier-2 JSONL 工具库)──────────────────────────────────────────────
/** 单条记忆 body 上限(字符)。进 history 前 memory_search 结果另有 MAX_MEMORY_RESULT 兜底。 */
export const MAX_MEMORY_ENTRY = 4000;
/** 启动注入 systemPrompt 的索引条目上限(遗忘封顶后 active 条目 ≤ MAX_ACTIVE,索引再封一层)。 */
export const MAX_INDEX_ENTRIES = 50;
/** active 记忆封顶:超则按 recallCount 低 × lastRecalledAt 老 淘汰到 archived。 */
export const MAX_ACTIVE = 100;
/** 衰减:active + !pinned + (lastRecalledAt|createdAt) 早于 DECAY_DAYS → archived。 */
export const DECAY_DAYS = 30;
/** GC:archived 超 GC_DAYS → 硬删。 */
export const GC_DAYS = 90;
/** memory_search 结果(召回的记忆正文)的放宽上限:指令性内容,中截破坏语义,对齐 use_skill。 */
export const MAX_MEMORY_RESULT = 64000;

export const IGNORE = ['**/node_modules/**', '**/.git/**'];

// ── Context Budget Scheduler(五区分账)────────────────────────────────────
/** Hot/Cold 划分:当前 step 起往前 N 个 user turn 之内的工具结果视为 Hot(绝对不压),
 * 之外的视为 Cold(可调度器压)。默认 4 = 跨过 4 个用户问题仍生效。 */
export const HOT_TURN_WINDOW = 4;
/** Cold 区内可被就地 stub 的 tool 消息最低 age(经过的消费者 push 数)。默认 2,
 * 与 lifecycle.ts DEFAULT_AGE_THRESHOLD 对齐。 */
export const TOOL_OLD_AGE = 2;
/** 五区预算占比(总和 0.95,留 5% 给 Reserve)。对齐 user 修正版:
 * System 15 / History 20 / Hot Tool 25 / Cold Tool 25 / Summary 10。 */
export const BUDGET_RATIO = {
  system: 0.15,
  history: 0.20,
  toolRecent: 0.25,
  toolOld: 0.25,
  summary: 0.10,
  reserve: 0.05,
} as const;
// ── plan 模式(只读规划,不执行)──────────────────────────────────────────────
/**
 * plan 模式下从工具 schema 里剔除的工具(模型根本看不到 → 调不到):
 * 写盘 / 命令 / 记忆写入类 + task(派生子 agent,plan 模式只读不可有副作用)。单一事实源,
 * 被 llm(planChatTools)与 agent(防御 backstop)共用。
 * 只读工具(read_file/glob/grep/codegraph/web_search/web_fetch/use_skill/ask_human/memory_search/memory_list)保留。
 */
export const PLAN_DISABLED_TOOLS = new Set([
  'write_file',
  'edit_file',
  'run_command',
  'memory_save',
  'memory_update',
  'memory_forget',
  'task',
]);
