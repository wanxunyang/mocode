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

export const IGNORE = ['**/node_modules/**', '**/.git/**'];
