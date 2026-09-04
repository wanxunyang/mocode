/**
 * AgentRuntimeContext:runAgentCore 的运行时依赖注入接缝。
 *
 * 2.0 框架化第一步(Context 参数化):把 core.ts 直读的模块级单例(config / agentMode /
 * sessionId / sandboxRoot / token 校准 / notes mtime)收敛成一个显式接口。默认实现
 * defaultAgentRuntimeContext 原样绑定全局单例,行为与改造前完全一致;宿主(TUI / stdio host /
 * 子 agent / 未来多 runtime)可注入自定义实现,在同一进程内获得互不干扰的运行时视图。
 *
 * 本模块是叶子:只依赖各单例所在模块,不反向 import core.ts,依赖方向无环。
 *
 * 取舍说明:
 *  - 用方法(getter)而非裸值字段:config.model 等会被 /model 热切,方法保证每次读取取最新值,
 *    与改造前「每次直读全局」的语义一致。
 *  - jailResolve / getCurrentTurnMutationState 等涉及真实 I/O 或可变返回,保持函数形态原样透传。
 *  - 暂未覆盖 executeToolOutcome / findTool(tools registry 单例)与 checkPermission:它们属
 *    工具系统(步骤 4 抽包时处理),本轮只收敛 agent 运行时自身的单例。
 */

import { config, getActiveModel, extractActivePlanSection, buildSessionStateReminder } from '../config/index.js';
import type { Config } from '../config/index.js';
import { getAgentMode, setAgentMode, type AgentMode } from './mode.js';
import { getCurrentSessionId } from '../session/state.js';
import { getCurrentTurnId, getCurrentTurnMutationState } from '../rollback/index.js';
import { getNotesMtime } from '../session/notes.js';
import { jailResolve } from '../sandbox/index.js';
import { getTokenCalibration, updateTokenCalibration } from '../context/token-calibration.js';
import { safeProviderId } from '../session/trace-sanitize.js';

/** runAgentCore 观察到的当前轮文件 mutation 状态(getCurrentTurnMutationState 的返回形状)。 */
export type TurnMutationState = ReturnType<typeof getCurrentTurnMutationState>;

/** token 校准样本(token-calibration.ts 的两个函数签名)。 */
export type TokenCalibrationResult = ReturnType<typeof getTokenCalibration>;

/**
 * agent 运行时的全部外部可变依赖。每个成员对应 core.ts 改造前的一处模块级单例直读。
 * 全部可选读取集中在构造点之后、循环之中——实现必须保证每次调用返回当前最新值。
 */
export interface AgentRuntimeContext {
  // ── config(只读快照 + 热切模型)──
  /** 完整配置对象引用(与全局 config 同一引用,字段仍可读;改造前行为不变)。 */
  readonly config: Config;
  /** 当前活跃模型(钉死会话模型优先,见 config/index.ts getActiveModel)。 */
  getActiveModel(): string;

  // ── agent 模式(auto / plan)──
  getAgentMode(): AgentMode;
  /** 设置模式并返回之前的值(abort 还原用)。同模式 no-op。 */
  setAgentMode(mode: AgentMode): AgentMode;

  // ── 会话 / 轮次身份(trace 埋点用)──
  getCurrentSessionId(): string | undefined;
  getCurrentTurnId(): number;
  /** 当前轮真实磁盘 mutation 观察(changedFiles 列表来源)。 */
  getCurrentTurnMutationState(): TurnMutationState;

  // ── 会话状态提醒 / plan 摘要(system prompt 尾部动态段)──
  buildSessionStateReminder(): string;
  extractActivePlanSection(): string | null;

  // ── notes.md mtime(plan nag 计数器用)──
  getNotesMtime(): number | null;

  // ── 沙箱路径解析(工具 diff 预读取用;越界抛错由调用方 catch)──
  jailResolve(path: string): string;

  // ── token 估算自校准(provider/model/tool-set 维度持久化)──
  getTokenCalibration(baseURL: string, model: string, tools: readonly unknown[]): TokenCalibrationResult;
  updateTokenCalibration(
    baseURL: string,
    model: string,
    tools: readonly unknown[],
    rawEstimate: number,
    actualPromptTokens: number,
  ): TokenCalibrationResult;

  // ── trace 辅助(把 baseURL 归一成稳定 provider 标识)──
  safeProviderId(baseURL: string): string;
}

/**
 * 默认运行时上下文:原样绑定全局单例,与改造前 runAgentCore 的直读行为完全一致。
 * 每个方法都是对应单例函数的透传;config 是同一对象引用(字段读取热生效)。
 */
export const defaultAgentRuntimeContext: AgentRuntimeContext = {
  config,
  getActiveModel,
  getAgentMode,
  setAgentMode,
  getCurrentSessionId,
  getCurrentTurnId,
  getCurrentTurnMutationState,
  buildSessionStateReminder,
  extractActivePlanSection,
  getNotesMtime,
  jailResolve,
  getTokenCalibration,
  updateTokenCalibration,
  safeProviderId,
};
