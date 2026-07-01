/** 工具执行时收到的运行时上下文(可选)。不用的工具可忽略。 */
export interface ToolContext {
  /** agent 循环的 abort signal(用户 Ctrl+C 中断当前轮)。长任务工具(run_command/web_fetch)
   * 挂监听:abort 即取消(杀子进程 / 取消 fetch),让中断跟手而非等命令跑完或超时。 */
  signal?: AbortSignal;
}

/** 工具统一接口。每个工具是一个 name + JSON Schema + execute。 */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  /** ctx 可选:不关心的工具签名写 execute(args) 即可(TS 允许少参赋多参类型,向后兼容)。 */
  execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<string>;
}
