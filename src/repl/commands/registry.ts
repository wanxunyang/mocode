/**
 * 斜杠命令路由表:有序 handler 列表 + 首个非 unhandled 胜出。
 *
 * 为什么是有序数组而不是 `Map<name, handler>`:
 * 1. **子命令顺序**。`/pet quit`、`/pet skin` 必须排在 `/pet` 之前;`/image list`、
 *    `/image clear` 与 `/image <path>` 靠完整 line 匹配区分。名字映射无法表达前缀关系。
 * 2. **增量迁移**。handler 自己判断 `ctx.line` 是否归它管,不匹配返回 `unhandled`,
 *    registry 继续往下问。迁移期间未搬的命令仍由 runtime.ts 的遗留 if 链处理
 *    (dispatch 返回 unhandled 时 fall through),两条路径语义完全一致。
 *
 * 迁移安全性依据:
 * 原 if 链是**从上到下顺序匹配**,分支之间唯一的条件重叠发生在同一命令组内部
 * (`/pet quit` ⊂ `/pet`、`/image list` ⊂ `/image`),跨组条件互斥。
 * 所以只要**整组一起搬、保持组内相对顺序**,跨组的排列顺序就无关紧要。
 * 反过来说:绝不能把一个命令组拆开搬到不同文件——那会打破组内前缀优先级。
 *
 * 全部搬完后,runtime.ts 的 if 链消失,dispatch 返回 unhandled 即等价于"未知命令",
 * 直接走 suggestCommand 兜底。
 */
import type { CommandContext, CommandHandler, CommandOutcome } from './types.js';
import { unhandled } from './types.js';
import { systemCommands } from './system.js';
import { modeCommands } from './mode.js';
import { petCommands } from './pet.js';
import { imageCommands } from './image.js';
import { contextCommands } from './context.js';
import { sessionCommands } from './session.js';
import { memoryCommands } from './memory.js';
import { skillCommands } from './skill.js';
import { compactCommands } from './compact.js';
import { appearanceCommands } from './appearance.js';

/**
 * 命令注册表。顺序即匹配优先级 —— 更具体的分支放前面。
 * 组内顺序由各文件自己保证(见文件头注释);组间顺序互不影响(条件互斥)。
 *
 * 迁移进度:已搬 system / mode / pet / image / context / session / memory / skill /
 * compact / appearance;其余仍在 runtime.ts 的遗留 if 链里,dispatch 返回 unhandled 后
 * 由遗留链接手。搬完一组往这里加一行。
 */
export const commandHandlers: CommandHandler[] = [
  ...systemCommands,
  ...modeCommands,
  ...petCommands,
  ...imageCommands,
  ...contextCommands,
  ...sessionCommands,
  ...memoryCommands,
  ...skillCommands,
  ...compactCommands,
  ...appearanceCommands,
];

/**
 * 依次询问 handler,返回第一个非 unhandled 的结果。
 * 全部 unhandled 时返回 unhandled —— 调用方(runtime.ts)据此走遗留分支或未知命令兜底。
 */
export async function dispatchCommand(ctx: CommandContext): Promise<CommandOutcome> {
  for (const handler of commandHandlers) {
    const outcome = await handler(ctx);
    if (outcome.kind !== 'unhandled') return outcome;
  }
  return unhandled();
}
