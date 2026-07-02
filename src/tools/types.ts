/** 工具执行时收到的运行时上下文(可选)。不用的工具可忽略。 */
export interface ToolContext {
  /** agent 循环的 abort signal(用户 Ctrl+C 中断当前轮)。长任务工具(run_command/web_fetch)
   * 挂监听:abort 即取消(杀子进程 / 取消 fetch),让中断跟手而非等命令跑完或超时。
   * 子 agent 透传主 signal:主 Ctrl+C 树杀子 agent(经 task→spawnAgent→runAgentCore→executeTool)。 */
  signal?: AbortSignal;
  /** 跳过回滚快照记录。子 agent(logical-isolation 模式)的 write_file/edit_file 改动不进主回滚链——
   * 主 /rollback 不撤销子 agent 改动(靠 git 兜底)。主 agent 永远不设此 flag。 */
  skipRollback?: boolean;
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

/** 工具统一接口。每个工具是一个 name + JSON Schema + execute。 */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  /** ctx 可选:不关心的工具签名写 execute(args) 即可(TS 允许少参赋多参类型,向后兼容)。 */
  execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<string>;
}
