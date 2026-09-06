/**
 * AgentRuntimeContext:runAgentCore 的运行时依赖注入接缝。
 *
 * 独立 runtime 通过 createAgentRuntimeContext 装配自己的 config、工具表、模型 transport、
 * mode 与 sandbox scope；默认上下文则继续显式绑定进程级单例，保持现有 TUI/host 行为。
 * 本模块不 import builtins：默认工具包只从 defaultToolRuntime.builtinTools 复制，避免
 * registry → builtins → core → runtime-context 的模块循环。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import {
  buildSessionStateReminder,
  config,
  createConfigSnapshot,
  extractActivePlanSection,
  getActiveModel,
} from '../config/index.js';
import type { Config } from '../config/index.js';
import { getTokenCalibration, updateTokenCalibration } from '../context/token-calibration.js';
import {
  chat,
  createChatClientState,
  createChatTransport,
  type ChatClientOverrides,
  type ChatTransport,
} from '../llm/index.js';
import { checkPermission, createPermissionChecker, type PermissionCheckOptions } from '../permissions/index.js';
import type { Tool } from '../tools/types.js';
import {
  defaultRollbackStore,
  RollbackStore,
  withRollbackStore,
  type CurrentTurnMutationState,
} from '../rollback/index.js';
import { getSandboxRoot, jailResolve, withSandboxRoot } from '../sandbox/index.js';
import { getNotesMtime } from '../session/notes.js';
import { defaultSessionStore, SessionStore, withSessionStore } from '../session/store.js';
import { safeProviderId } from '../session/trace-sanitize.js';
import { defaultToolRuntime, ToolRuntime } from '../tools/registry.js';
import { getAgentMode, setAgentMode, type AgentMode } from './mode.js';

/** runAgentCore 观察到的当前轮文件 mutation 状态。 */
export type TurnMutationState = CurrentTurnMutationState;

/** token 校准样本(token-calibration.ts 的两个函数签名)。 */
export type TokenCalibrationResult = ReturnType<typeof getTokenCalibration>;

/** Agent 一次运行所需的完整、显式 runtime 视图。 */
export interface AgentRuntimeContext {
  // ── runtime-owned infrastructure ──
  readonly config: Config;
  readonly toolRuntime: ToolRuntime;
  readonly modelTransport: ChatTransport;
  readonly sessionStore: SessionStore;
  readonly rollbackStore: RollbackStore;
  readonly sandboxRoot: string;
  /** 在本 runtime 的 AsyncLocalStorage 沙箱根中执行，支持并发 runtime 互不串根。 */
  runInScope<T>(fn: () => Promise<T>): Promise<T>;
  /** 使用本 runtime 配置和 sandbox root 进行权限判定。 */
  checkPermission(
    tool: Tool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    options?: PermissionCheckOptions,
  ): Promise<'allow' | 'deny'>;

  // ── config / mode ──
  getActiveModel(): string;
  getAgentMode(): AgentMode;
  /** 设置模式并返回之前的值(abort 还原用)。同模式 no-op。 */
  setAgentMode(mode: AgentMode): AgentMode;

  // ── 会话 / 轮次身份(trace 与 rollback 用)──
  beginTurn(firstLine: string): number;
  getCurrentSessionId(): string | undefined;
  getCurrentTurnId(): number;
  getCurrentTurnMutationState(): TurnMutationState;

  // ── 会话状态提醒 / plan 摘要 ──
  buildSessionStateReminder(): string;
  extractActivePlanSection(): string | null;
  getNotesMtime(): number | null;

  // ── 沙箱路径解析 ──
  jailResolve(path: string): string;

  // ── token 估算自校准 ──
  getTokenCalibration(baseURL: string, model: string, tools: readonly unknown[]): TokenCalibrationResult;
  updateTokenCalibration(
    baseURL: string,
    model: string,
    tools: readonly unknown[],
    rawEstimate: number,
    actualPromptTokens: number,
  ): TokenCalibrationResult;

  // ── trace 辅助 ──
  safeProviderId(baseURL: string): string;
}

const activeRuntimeContexts = new AsyncLocalStorage<AgentRuntimeContext>();

/** 当前异步 agent 树绑定的 RuntimeContext；编排工具据此让子 agent 继承父 runtime。 */
export function getActiveAgentRuntimeContext(): AgentRuntimeContext | undefined {
  return activeRuntimeContexts.getStore();
}

/** 仅由 agent composition root 调用；嵌套异步任务自动继承且并发树互不污染。 */
export function withAgentRuntimeContext<T>(runtimeContext: AgentRuntimeContext, run: () => Promise<T>): Promise<T> {
  return activeRuntimeContexts.run(runtimeContext, run);
}

export type AgentRuntimeServiceOverrides = Partial<
  Pick<
    AgentRuntimeContext,
    | 'getActiveModel'
    | 'checkPermission'
    | 'getAgentMode'
    | 'setAgentMode'
    | 'beginTurn'
    | 'getCurrentSessionId'
    | 'getCurrentTurnId'
    | 'getCurrentTurnMutationState'
    | 'buildSessionStateReminder'
    | 'extractActivePlanSection'
    | 'getNotesMtime'
    | 'jailResolve'
    | 'getTokenCalibration'
    | 'updateTokenCalibration'
    | 'safeProviderId'
  >
>;

export interface AgentRuntimeContextInit {
  /** 完整源配置；工厂仍会快照它，避免调用方随后修改原对象。缺省使用全局 config 作为源。 */
  config?: Config;
  /** 应用在源配置之上的字段覆盖。 */
  configOverrides?: Partial<Config>;
  /** 直接采用已有工具 runtime；与 tools 二选一。 */
  toolRuntime?: ToolRuntime;
  /** runtime-local session persistence and identity store. */
  sessionStore?: SessionStore;
  /** runtime-local rollback journal and checkpoint store. */
  rollbackStore?: RollbackStore;
  /** 独立 runtime 的 builtin 工具列表；缺省复制 defaultToolRuntime 当前已安装的 builtins。 */
  tools?: readonly Tool[];
  /** 独立模型客户端的底层实现覆盖，常用于嵌入宿主和测试。 */
  modelClientOverrides?: ChatClientOverrides;
  /** 完全替换模型 transport；提供时不创建默认 client state。 */
  modelTransport?: ChatTransport;
  /** 独立沙箱根；缺省依次取快照配置、当前全局根、process.cwd()。 */
  sandboxRoot?: string;
  /** runtime-local mode 初值。 */
  initialMode?: AgentMode;
  /** session/rollback/token/notes 等既有服务的定向覆写。 */
  services?: AgentRuntimeServiceOverrides;
}

/**
 * 创建一个基础独立 runtime。构造过程不读取 env/config 文件，不加载 builtins 模块，
 * 也不修改全局 mode、sandbox root、工具表或模型客户端。
 */
export function createAgentRuntimeContext(init: AgentRuntimeContextInit = {}): AgentRuntimeContext {
  if (init.toolRuntime && init.tools) {
    throw new TypeError('toolRuntime and tools are mutually exclusive');
  }

  const runtimeConfig = createConfigSnapshot(init.configOverrides, init.config ?? config);
  const runtimeSandboxRoot = resolve(
    init.sandboxRoot ?? runtimeConfig.sandboxRoot ?? getSandboxRoot() ?? process.cwd(),
  );
  const hasExplicitSessionsRoot = init.config !== undefined || init.configOverrides?.sessionDir !== undefined;
  const runtimeSessionsRoot = hasExplicitSessionsRoot
    ? runtimeConfig.sessionDir
    : resolve(runtimeSandboxRoot, '.mocode', 'sessions');
  if (!hasExplicitSessionsRoot) runtimeConfig.sessionDir = runtimeSessionsRoot;
  const services = init.services ?? {};
  const runtimeGetActiveModel = services.getActiveModel ?? (() => runtimeConfig.model);
  const runtimeSessionStore =
    init.sessionStore ??
    new SessionStore({
      sessionsRoot: runtimeSessionsRoot,
      workspaceRoot: runtimeSandboxRoot,
      getModel: runtimeGetActiveModel,
    });
  const runtimeRollbackStore =
    init.rollbackStore ?? new RollbackStore(runtimeSandboxRoot, runtimeSessionStore.sessionsRoot);
  const runtimeToolRuntime =
    init.toolRuntime ??
    new ToolRuntime({
      beginPathMutation: runtimeRollbackStore.beginPathMutation.bind(runtimeRollbackStore),
      endPathMutation: runtimeRollbackStore.endPathMutation.bind(runtimeRollbackStore),
      beginWorkspaceMutation: runtimeRollbackStore.beginWorkspaceMutation.bind(runtimeRollbackStore),
      endWorkspaceMutation: runtimeRollbackStore.endWorkspaceMutation.bind(runtimeRollbackStore),
      getCurrentTurnMutationState: runtimeRollbackStore.getCurrentTurnMutationState.bind(runtimeRollbackStore),
    });
  if (!init.toolRuntime) {
    runtimeToolRuntime.installBuiltinTools([...(init.tools ?? defaultToolRuntime.builtinTools)]);
  }

  let runtimeMode = init.initialMode ?? 'auto';
  const localGetAgentMode = (): AgentMode => runtimeMode;
  const localSetAgentMode = (mode: AgentMode): AgentMode => {
    const previous = runtimeMode;
    runtimeMode = mode;
    return previous;
  };

  const runtimeModelTransport =
    init.modelTransport ??
    createChatTransport({
      config: runtimeConfig,
      getModel: runtimeGetActiveModel,
      clientState: createChatClientState(runtimeConfig, init.modelClientOverrides),
    });

  return {
    config: runtimeConfig,
    toolRuntime: runtimeToolRuntime,
    modelTransport: runtimeModelTransport,
    sessionStore: runtimeSessionStore,
    rollbackStore: runtimeRollbackStore,
    sandboxRoot: runtimeSandboxRoot,
    runInScope: <T>(fn: () => Promise<T>): Promise<T> =>
      withSessionStore(runtimeSessionStore, () =>
        withRollbackStore(runtimeRollbackStore, () => withSandboxRoot(runtimeSandboxRoot, fn)),
      ),
    checkPermission: services.checkPermission ?? createPermissionChecker(runtimeConfig, runtimeSandboxRoot),
    getActiveModel: runtimeGetActiveModel,
    getAgentMode: services.getAgentMode ?? localGetAgentMode,
    setAgentMode: services.setAgentMode ?? localSetAgentMode,
    beginTurn: services.beginTurn ?? runtimeRollbackStore.beginTurn.bind(runtimeRollbackStore),
    getCurrentSessionId:
      services.getCurrentSessionId ?? runtimeSessionStore.getCurrentSessionId.bind(runtimeSessionStore),
    getCurrentTurnId: services.getCurrentTurnId ?? runtimeRollbackStore.getCurrentTurnId.bind(runtimeRollbackStore),
    getCurrentTurnMutationState:
      services.getCurrentTurnMutationState ??
      runtimeRollbackStore.getCurrentTurnMutationState.bind(runtimeRollbackStore),
    buildSessionStateReminder:
      services.buildSessionStateReminder ??
      (() => buildSessionStateReminder(runtimeSessionStore.getCurrentSessionId())),
    extractActivePlanSection:
      services.extractActivePlanSection ?? (() => extractActivePlanSection(runtimeSessionStore.getCurrentSessionId())),
    getNotesMtime: services.getNotesMtime ?? (() => getNotesMtime(runtimeSessionStore.getCurrentSessionId())),
    jailResolve: services.jailResolve ?? jailResolve,
    getTokenCalibration: services.getTokenCalibration ?? getTokenCalibration,
    updateTokenCalibration: services.updateTokenCalibration ?? updateTokenCalibration,
    safeProviderId: services.safeProviderId ?? safeProviderId,
  };
}

function currentGlobalSandboxRoot(): string {
  return resolve(getSandboxRoot() ?? config.sandboxRoot ?? process.cwd());
}

/**
 * 默认运行时上下文：显式绑定全部旧全局单例。sandboxRoot 使用 getter，确保 REPL 在模块加载后
 * 调用 setSandboxRoot 仍能即时生效；runInScope 在每次调用时捕获当前全局根。
 */
export const defaultAgentRuntimeContext: AgentRuntimeContext = {
  config,
  toolRuntime: defaultToolRuntime,
  modelTransport: chat,
  sessionStore: defaultSessionStore,
  rollbackStore: defaultRollbackStore,
  get sandboxRoot(): string {
    return currentGlobalSandboxRoot();
  },
  runInScope: <T>(fn: () => Promise<T>): Promise<T> =>
    withSessionStore(defaultSessionStore, () =>
      withRollbackStore(defaultRollbackStore, () => withSandboxRoot(currentGlobalSandboxRoot(), fn)),
    ),
  checkPermission,
  getActiveModel,
  getAgentMode,
  setAgentMode,
  beginTurn: defaultRollbackStore.beginTurn.bind(defaultRollbackStore),
  getCurrentSessionId: defaultSessionStore.getCurrentSessionId.bind(defaultSessionStore),
  getCurrentTurnId: defaultRollbackStore.getCurrentTurnId.bind(defaultRollbackStore),
  getCurrentTurnMutationState: defaultRollbackStore.getCurrentTurnMutationState.bind(defaultRollbackStore),
  buildSessionStateReminder,
  extractActivePlanSection,
  getNotesMtime,
  jailResolve,
  getTokenCalibration,
  updateTokenCalibration,
  safeProviderId,
};
