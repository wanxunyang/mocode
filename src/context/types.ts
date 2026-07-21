// Context Optimization Pipeline 的类型契约。
//
// 设计原则:
//  - Tool Calling 的 JSON schema 与 executeTool 不动;本层只接管"工具结果进 LLM 前"的表示。
//  - 不设计统一 DSL,针对不同数据类型各做最优 encoder。
//  - 所有 encoder 是纯函数(无 LLM 调用 / 无 IO / 无副作用),永不抛错(pipeline 层 try/catch,
//    失败回落原 output + capToolResultForHistory,对齐 tools/registry.ts「调度器永不抛错」契约)。
//  - 兜底 encoder = passthrough(identity):未注册 encoder 时行为与改造前逐字节一致。
//
// 依赖方向:context 是叶子(仅 stdlib + tools/constants + session/compact 的 cap + config 开关),
// 不反向依赖 llm / agent / tools 业务,无环。

/** Context 的数据类型。classifier 据工具名 + 输出形状判定,选 encoder。 */
export type ContextKind =
  | 'tree' // File Tree     ← glob(路径列表→缩进树)
  | 'search' // Search Result ← grep / web_search(file:line 分组)
  | 'log' // Logs           ← run_command(分级/折叠/尾偏置)
  | 'code' // Code          ← read_file(保行号!edit_file 依赖)
  | 'table' // Table         ← memory_list(列对齐)
  | 'memory' // Memory        ← memory_search(紧凑卡片)
  | 'doc' // Doc           ← web_fetch / use_skill(去噪音保正文)
  | 'status' // Status        ← edit_file/write_file/ask_human/memory 增删改(一行状态,identity)
  | 'summary' // Summary      ← task(子 agent 摘要,轻量)
  | 'diff' // Provenance   ← 历史 tool_calls.arguments(Phase 3,在 compact 调用)
  | 'ast' // AST          ← 未来(需解析器,可选依赖,默认关)
  | 'repo' // Repo        ← 未来(多文件聚合视图)
  | 'passthrough'; // identity 兜底

/** encoder 的输入。pipeline 解析 argsRaw 后传入。 */
export interface EncoderInput {
  /** 工具名(强先验信号)。 */
  toolName: string;
  /** 工具原始输出字符串(executeTool 的返回值,未经任何编码)。 */
  output: string;
  /** 已解析的工具参数;非法或空返 null。encoder 可据此做上下文感知编码(如 read_file 的 offset/limit)。 */
  args: Record<string, unknown> | null;
  /** 软目标字符数(来自 tools/constants.ts 的 cap 常量,按工具名取)。encoder 应尽量压到 budget 内,
   *  但最终长度裁剪仍由 pipeline 末尾的 capToolResultForHistory 兜底(保 head+标记+tail)。 */
  budget?: number;
  /** 当前结果之后发生的 tool-result push 数;初次 push 为 0。 */
  age?: number;
  /** 是否已进入 Hot/Cold 划分的 Cold 区。与 age 分开,避免把两种语义混为一谈。 */
  isCold?: boolean;
  /** 是否为 canonical path 的首次成功 read_file;非 read 工具为 undefined。 */
  isFirstRead?: boolean;
  /** push=初次保守编码;sweep=发送给模型前对旧 Cold 内容二次编码。 */
  phase?: 'push' | 'sweep';
}

/** pipeline 调用方可注入的运行时老化上下文。 */
export type EncoderRuntimeContext = Pick<
  EncoderInput,
  'age' | 'isCold' | 'isFirstRead' | 'phase'
>;

/** encoder 的输出。 */
export interface EncoderOutput {
  /** 编码后文本(喂给 LLM 的 tool 消息 content)。 */
  text: string;
  /** 编码元数据(调试 / 未来 /context 统计用;不影响喂给 LLM 的内容)。 */
  meta?: {
    kind: ContextKind;
    originalLen: number;
    encodedLen: number;
    /** 给调试者的备注(如"12 files · tree-encoded")。 */
    note?: string;
  };
}

/**
 * Encoder 统一接口:一类型一 encoder,纯函数,不抛错(失败由 pipeline 兜底)。
 * 扩展:在 encoders/ 加 xxx.ts 导出 ContextEncoder,在 encoders/index.ts 的 builtinEncoders 加一行。
 * 无需动 agent / llm / core。
 */
export interface ContextEncoder {
  kind: ContextKind;
  encode(input: EncoderInput): EncoderOutput;
}
