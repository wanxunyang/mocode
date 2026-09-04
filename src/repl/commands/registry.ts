/**
 * 斜杠命令路由表:有序 handler 列表 + 首个非 unhandled 胜出。
 *
 * 为什么是有序数组而不是 `Map<name, handler>`:
 * 1. **子命令顺序**。`/pet quit`、`/pet skin` 必须排在 `/pet` 之前;`/image list`、
 *    `/image clear` 与 `/image <path>` 靠完整 line 匹配区分。名字映射无法表达前缀关系。
 * 2. **顺序即优先级**。handler 自己判断 `ctx.line` 是否归它管,不匹配返回 `unhandled`,
 *    registry 继续往下问。这样每个命令文件可以独立演进,不需要中心化的名字注册表。
 *
 * 顺序约定:
 * 分支之间唯一的条件重叠发生在同一命令组内部(`/pet quit` ⊂ `/pet`、`/image list` ⊂ `/image`),
 * 跨组条件互斥。所以组内必须保持相对顺序(更具体的在前),组间顺序则无关紧要。
 * 反过来说:绝不能把一个命令组拆到两个文件——那会打破组内前缀优先级。
 *
 * /exit /quit 不在这里:它们在 runtime.ts 主循环的 dispatch 点之前 break
 * (早于 dismissWelcomeBlock / echoInput / enterRunningMode),搬进来会改变收尾行为。
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
import { modelCommands } from './model.js';
import { toolGroupCommands } from './tool-group.js';

/**
 * 命令注册表。顺序即匹配优先级 —— 更具体的分支放前面。
 * 组内顺序由各文件自己保证(见文件头注释);组间顺序互不影响(条件互斥)。
 *
 * dispatch 返回 unhandled = 没有这条命令,runtime.ts 据此走未知命令兜底。
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
  ...modelCommands,
  ...toolGroupCommands,
];

/**
 * 依次询问 handler,返回第一个非 unhandled 的结果。
 * 全部 unhandled 时返回 unhandled —— 调用方(runtime.ts)据此走未知命令兜底
 * (isCommandShape + suggestCommand),或把非命令输入当普通消息发给 agent。
 */
export async function dispatchCommand(ctx: CommandContext): Promise<CommandOutcome> {
  for (const handler of commandHandlers) {
    const outcome = await handler(ctx);
    if (outcome.kind !== 'unhandled') return outcome;
  }
  return unhandled();
}
