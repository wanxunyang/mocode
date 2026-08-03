/** 工具执行时收到的运行时上下文(可选)。不用的工具可忽略。 */
export interface ToolContext {
  /** agent 循环的 abort signal(用户 Ctrl+C 中断当前轮)。长任务工具(run_command/web_fetch)
   * 挂监听:abort 即取消(杀子进程 / 取消 fetch),让中断跟手而非等命令跑完或超时。
   * 子 agent 透传主 signal:主 Ctrl+C 树杀子 agent(经 task→spawnAgent→runAgentCore→executeTool)。 */
  signal?: AbortSignal;
  /** 上下文剔除回调(drop_context 工具用):把历史里命中的无关 tool 结果替换为存根(保
   * tool_call_id 配对不变量,只改 content),原地修改 history。由 runAgentCore 闭包注入。
   * 永不动 history[0](system)与当前轮(最后一个 user 消息及之后)的 tool 结果——agent 还在用。
   * 返回剔除统计(条数 / 释放 token / 命中项),供 agent 确认。 */
  dropContext?: (filter: DropContextFilter) => DropContextResult;
}

/** drop_context 的筛选条件(各字段 AND 组合,空/缺省 = 该维度不限)。 */
export interface DropContextFilter {
  /** 只剔除这些工具名的结果(如 ["grep","read_file"]);空/缺省 = 不限工具名。 */
  toolNames?: string[];
  /** 只剔除内容包含所有这些词(AND、大小写不敏感)的结果;空/缺省 = 不限内容。 */
  contains?: string[];
}

/** drop_context 的剔除结果(回灌给 agent 供确认)。 */
export interface DropContextResult {
  /** 实际替换为存根的 tool 消息条数 */
  dropped: number;
  /** 估算释放的 token 数(剔除前后该区段 token 差) */
  freedTokens: number;
  /** 被剔除的 tool 消息(工具名 + tool_call_id 末 6 位)摘要 */
  items: { toolName: string; toolCallId: string }[];
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

/** 框架内部的结构化工具结果；LLM/TUI 边界仍使用 output 文本。 */
export interface ToolOutcome {
  status: ToolOutcomeStatus;
  code: ToolOutcomeCode;
  retryable: boolean;
  output: string;
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
