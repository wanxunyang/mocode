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
