// AgentHooks → PetState 映射(mocode 主包侧)。
// createPetHooks 产出的 hooks 只在 src/agent/index.ts(主 agent hooks 组装处)使用,
// 与既有 TUI hooks 并列注入——两组 hooks 各自独立触发,互不干扰,不修改 core.ts 的任何行为。
// 子 agent(src/agent/spawn.ts 的 spawnAgent)不引用本模块,故子 agent 永不广播桌宠状态。

import type { ToolCallRef } from '../llm/index.js';
import type { AgentHooks } from '../agent/core.js';
import type { PetState } from './protocol.js';
import * as bridge from './bridge.js';

/** AgentHooks 方法名(供 deriveState 的 event 参数类型与穷举测试)。 */
export type AgentHookEventName =
  | 'onStepStart'
  | 'onText'
  | 'onToolCall'
  | 'onToolStart'
  | 'onToolResult'
  | 'onDone'
  | 'onAbort'
  | 'onMaxSteps'
  | 'onChatDone'
  | 'onToolBatchEnd'
  | 'onNoReply';

/** deriveState 的可选参数(按事件类型而异)。 */
export interface DeriveStateArgs {
  /** onToolCall / onToolStart 的工具名。 */
  toolName?: string;
  /** onToolResult 的输出(用于判断是否报错:以"错误"开头,参考 agent/index.ts writeToolResult)。 */
  toolOutput?: string;
}

/**
 * 纯函数:给定当前 hook 事件与其参数,推导下一个 PetState。
 * 前置条件:event 是 AgentHooks 定义的方法名之一。
 * 后置条件:返回值 ∈ PetState 枚举;对同一 (event, args) 输入,任意调用时刻返回值相同(确定性,可测)。
 * 不依赖调用历史之外的隐藏状态——纯函数式转移表。
 */
export function deriveState(event: AgentHookEventName, args?: DeriveStateArgs): PetState {
  switch (event) {
    case 'onStepStart':
      return 'thinking';
    case 'onText':
      return 'speaking';
    case 'onToolCall':
    case 'onToolStart':
      return 'tool_call';
    case 'onToolResult':
      if (args?.toolOutput && args.toolOutput.startsWith('错误')) return 'error';
      return 'tool_call';
    case 'onDone':
      return 'done';
    case 'onAbort':
      return 'aborted';
    case 'onMaxSteps':
      return 'error';
    case 'onChatDone':
    case 'onToolBatchEnd':
      return 'thinking';
    case 'onNoReply':
      return 'idle';
    default:
      return 'idle';
  }
}

/**
 * 把 AgentHooks 事件流映射为 PetState 变化并调用 bridge.sendState。
 * 前置条件:传入的 sender 已存在(可能尚未连接,sendState 内部自行处理未连接情形——no-op)。
 * 后置条件:返回的 AgentHooks 对象的每个方法都是纯粹的"状态推导 + 转发",
 *   不修改 core.ts 的任何行为、不影响现有 TUI hooks 的调用结果。
 */
export function createPetHooks(
  sender: { sendState: typeof bridge.sendState } = bridge,
): AgentHooks {
  return {
    onStepStart: () => sender.sendState(deriveState('onStepStart')),
    onText: () => sender.sendState(deriveState('onText')),
    onToolCall: (name) =>
      sender.sendState(deriveState('onToolCall', { toolName: name }), { toolName: name }),
    onToolStart: (name) =>
      sender.sendState(deriveState('onToolStart', { toolName: name }), { toolName: name }),
    onToolResult: (tc: ToolCallRef, output: string) => {
      const state = deriveState('onToolResult', { toolOutput: output });
      if (state === 'error') {
        sender.sendState(state, { errorMessage: output.slice(0, 200) });
      } else {
        sender.sendState(state, { toolName: tc.name });
      }
    },
    onToolBatchEnd: () => sender.sendState(deriveState('onToolBatchEnd')),
    onDone: () => sender.sendState(deriveState('onDone')),
    onAbort: () => sender.sendState(deriveState('onAbort')),
    onMaxSteps: () => sender.sendState(deriveState('onMaxSteps')),
    onNoReply: () => sender.sendState(deriveState('onNoReply')),
  };
}
