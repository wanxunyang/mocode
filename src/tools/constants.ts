/** 工具共享的截断 / 上限 / 忽略规则。 */
import { isMemoryEnabled } from '../config/index.js';

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

/**
 * 按当前 isMemoryEnabled() 现算 plan 模式应屏蔽的工具。
 * memoryEnabled=false 时记忆工具整体不在 builtinTools 里,plan 屏蔽集里也无须再列 ——
 * 反之留着只是死名字。统一过滤,避免 Set 里残留与已下架工具不一致的概念性冗余。
 * 调用方(agent/core 串行分支、llm/planChatTools)每次 chat 时调本函数拿当前值。
 */
export function getPlanDisabledTools(): Set<string> {
  if (isMemoryEnabled()) return PLAN_DISABLED_TOOLS;
  const next = new Set<string>(PLAN_DISABLED_TOOLS);
  next.delete('memory_save');
  next.delete('memory_update');
  next.delete('memory_forget');
  return next;
}
