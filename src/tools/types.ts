/** 工具执行时收到的运行时上下文(可选)。不用的工具可忽略。 */
export interface ToolContext {
  /** agent 循环的 abort signal(用户 Ctrl+C 中断当前轮)。长任务工具(run_command/web_fetch)
   * 挂监听:abort 即取消(杀子进程 / 取消 fetch),让中断跟手而非等命令跑完或超时。
   * 子 agent 透传主 signal:主 Ctrl+C 树杀子 agent(经 task→spawnAgent→runAgentCore→executeTool)。 */
  signal?: AbortSignal;
  /** 本次调用的 tool_call id(编排型工具用,如 sub-agent 把主侧批次与子 agent 关联渲染)。 */
  callId?: string;
  /**
   * 产生本次 tool_call 时的 effective allow-list（step policy/父上限/skill deny 的交集）。
   * 编排器/skill 只能据此缩小子执行面，不能读取后来扩容后的全局状态。未由 Agent 调用时缺省 undefined。
   */
  allowedToolNames?: readonly string[];
}

/** 工具风险等级(权限系统用)。 */
export type ToolRisk = 'safe' | 'confirm' | 'dangerous';

/** 工具对外部状态的主要影响；unknown 必须按最保守策略调度。 */
export type ToolEffect = 'read' | 'write' | 'process' | 'network' | 'unknown';
export type ToolConcurrency = 'parallel' | 'serial' | 'resource-locked';

/** Agent scheduling, rollback capture, and resource coordination metadata. */
export interface ToolCapabilities {
  effect: ToolEffect;
  concurrency: ToolConcurrency;
  /** 返回该调用会访问的逻辑资源键；用于细粒度锁与冲突诊断。 */
  resources?: (args: Record<string, unknown>) => string[];
  /** 编排器本身不持锁；其嵌套工具调用负责获取真实资源锁，避免父子自锁。 */
  delegatesResourceLocks?: boolean;
  supportsAbort?: boolean;
}

export type ToolOutcomeStatus = 'success' | 'error' | 'denied' | 'aborted';
export type ToolOutcomeCode =
  | 'OK'
  | 'UNKNOWN_TOOL'
  | 'INVALID_JSON'
  | 'INVALID_ARGUMENTS'
  | 'INVALID_TOOL_SCHEMA'
  | 'SANDBOX_DENIED'
  | 'PERMISSION_DENIED'
  | 'TOOL_DISABLED'
  | 'MODE_DENIED'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'PROCESS_FAILED'
  | 'EXECUTION_ERROR'
  | 'EDIT_CONFLICT'
  | 'CHANGE_CONFLICT'
  | 'PATCH_INVALID'
  | 'POSTCONDITION_FAILED'
  | 'MCP_ERROR';

/** 可由工具私下回灌给模型的多模态附件；不得拼进 output、日志或 TUI。 */
export interface ModelImageAttachment {
  type: 'image';
  name: string;
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  dataUrl: string;
  detail?: 'auto' | 'low' | 'high';
}

/** 框架内部的结构化工具结果；LLM/TUI 边界仍使用 output 文本。 */
export interface ToolOutcome {
  status: ToolOutcomeStatus;
  code: ToolOutcomeCode;
  retryable: boolean;
  output: string;
  /** 仅供下一轮模型请求使用，不进入文本 history / trace。 */
  modelAttachments?: ModelImageAttachment[];
  changedFiles?: string[];
  /** Paths whose previously observed content is known stale after a conflict. */
  staleFiles?: string[];
  /** The committed transaction; diff, rollback, tracing and freshness share this identity. */
  changeSet?: import('../changeset/types.js').ChangeSetSummary;
  durationMs?: number;
  /** LLM usage incurred inside an orchestrating tool (for example sub-agent). */
  usage?: import('../llm/index.js').ChatUsage;
}

export type ToolExecuteResult = string | ToolOutcome;

/** 工具统一接口。旧工具可继续返回字符串，由 registry 兼容包装。 */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk?: ToolRisk;
  /**
   * 在 JSON Schema 校验前就地规范化模型参数。仅用于无损兼容已知的模型输出偏差；
   * 不应补造业务值或放宽必填参数。
   */
  normalizeArguments?: (args: Record<string, unknown>) => void;
  /** 缺省时按 unknown + serial + never 保守处理。 */
  capabilities?: ToolCapabilities;
  execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolExecuteResult>;
}
