# `runAgentCore` Stage 化设计与迁移计划

> 状态：实施中  
> 目标版本：Mocode 2.0  
> 原则：先冻结协议与测量，再用兼容适配器逐段替换；任何阶段都可独立回退。

## 1. 背景与目标

`src/agent/core.ts` 的 `runAgentCore` 同时承担 history 协议、模型调用、上下文压缩、工具策略与调度、权限预检、hooks、usage/trace、abort 恢复和终止判断。问题不只是文件较长，而是多个状态机共享可变闭包，导致职责难以独立测试和替换。

本计划把它收缩为显式编排器：

1. 构造一次 run 的 stage 实例；
2. 按固定顺序执行 trim → model → tool batch → history commit → termination；
3. 串联兼容 hooks 与 runtime events；
4. 不再内联各 stage 的业务规则。

本计划遵循 `mocode-2.0-design.md` 的 protocol-first、state-explicit 和渐进兼容原则，也遵循 `rust-refactor-roadmap.md` 中“没有兼容测试、回滚路径和真实 eval baseline，不得重写 Agent loop”的限制。Stage 化仍在 TypeScript Runtime 内完成，不代表迁移到 Rust。

## 2. 非目标

本计划不做：

- 一次性重写 `runAgentCore`；
- 一次性搬目录、拆 npm package 或翻译成 Rust；
- 在结构重构中顺手改变 completion、abort、permission、compact 或子 Agent 语义；
- 让所有 stage 共享一个可任意修改的巨型 `AgentContext`；
- 在线同时执行 legacy/staged 两套 pipeline（会重复模型成本和工具副作用）；
- 把 `executeToolOutcome()` 直接改名为完整 `ToolDispatcher`；
- 把 `TurnTraceState` 整体改名为 `TraceSink`。

## 3. 必须保持的协议不变量

任何迁移 PR 都必须保持：

1. 每个 model step 只捕获一次 immutable tool-policy snapshot。
2. 模型 schema、执行 backstop 和后代 allow-list 来自同一份 snapshot。
3. `add_tool_groups` 独占一个 step；混用时普通工具不执行，但所有 provider tool call 都有配对 tool result。
4. assistant `tool_calls` 先进入 history；tool results 完整、相邻并按 provider 原序回灌。
5. safe parallel 先展示全部 headers 再启动执行。
6. resource-locked mutation 先按 provider 原序完成 permission preflight，再并发执行。
7. attachment user message 只在整批 tool results 后追加。
8. abort checkpoint 只在完整工具批次后刷新。
9. compact 替换 history 后重建 lifecycle/artifact 索引。
10. model retry 和 context-overflow retry 是同一 step 的 attempt，不伪造成新 step。

## 4. Stage 边界

不引入统一的 `AgentStage.run(ctx, next)`。每个 port 只获得完成自身职责所需的输入。

### 4.1 `HistoryManager`

它是协议账本和提交边界，不只是数组 wrapper：

```ts
interface HistoryManager {
  snapshot(): ReadonlyHistorySnapshot;
  appendAssistantTurn(turn: AssistantTurn): void;
  commitToolBatch(batch: OrderedToolBatch): void;
  replaceAfterCompaction(result: CompactedHistory): void;
  createCheckpoint(): HistoryCheckpoint;
  restore(checkpoint: HistoryCheckpoint): void;
}
```

`commitToolBatch` 原子表达“全部 tool results + 可选 attachment message”。调用方不能逐条任意写入内部 history。

### 4.2 `ModelRunner`

只执行 immutable model request，不修改 history：

```ts
interface ModelRunner {
  run(request: ModelRequest, signal: AbortSignal): Promise<ModelResult>;
}
```

context overflow 的“一次强制 compact 后重试”仍由 coordinator 编排，因为它跨 `ModelRunner` 与 `ContextTrimmer`。

### 4.3 `ToolDispatcher`

完整 dispatcher 位于 `executeToolOutcome()` 之上，负责 policy backstop、permission preflight、调度分组、屏障和原序聚合：

```ts
interface ToolDispatcher {
  dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult>;
}

interface ToolDispatchResult {
  orderedResults: readonly ToolCallResult[];
  changedFiles: readonly string[];
  events: readonly ToolDispatchEvent[];
}
```

它是最后迁移的高风险 stage。

### 4.4 `ContextTrimmer`

返回结构化结果，不直接操作 spinner、layout、notes 或 rollback UI：

```ts
interface ContextTrimmer {
  trim(request: ContextTrimRequest): Promise<ContextTrimResult>;
}

type ContextTrimResult =
  | { kind: 'unchanged' }
  | { kind: 'trimmed'; history: CompactedHistory; stats: TrimStats }
  | { kind: 'aborted' };
```

### 4.5 `TraceSink`、`UsageMeter` 与恢复状态

- `TraceSink`：best-effort 记录事件，失败不能改变主流程；
- `UsageMeter`：只聚合 model/tool usage；
- cancellation checkpoint：由 run lifecycle/coordinator 持有；
- mode restore：由 run lifecycle 持有。

这四项不能继续混装在名为 trace 的对象里。

### 4.6 `TerminationPolicy` 与 `CapabilityResolver`

`TerminationPolicy` 是纯决策器：

```ts
interface TerminationPolicy {
  decide(input: TerminationInput): TerminationDecision;
}
```

模式和工具能力先由 `CapabilityResolver` 解析为 immutable `RunPolicySnapshot`，不能藏进终止策略。

## 5. 装配与回滚

最终装配接口：

```ts
interface AgentStages {
  createHistoryManager(input: HistoryInit): HistoryManager;
  modelRunner: ModelRunner;
  toolDispatcher: ToolDispatcher;
  contextTrimmer: ContextTrimmer;
  traceSink: TraceSink;
  terminationPolicy: TerminationPolicy;
  capabilityResolver: CapabilityResolver;
}
```

所有有可变状态的对象按 run 创建，不能作为跨 run 单例。

迁移期保留 `legacy | staged` pipeline 开关。初期默认 `legacy`；每个 stage 有 legacy adapter，可单独切回，而不是只能整体回退。对照使用记录好的 model responses/tool outcomes 做 deterministic replay，不在线 shadow 双跑。

## 6. 阶段 0：Behavior Freeze + Baseline Contract

阶段 0 不移动 `runAgentCore` 控制流，只建立后续重构的可信测量和协议安全网。

### 6.1 Coding eval schema v3

当前报告和历史报告在相同 `schemaVersion: 2` 下字段不兼容，因此新契约升级为 v3。Baseline 使用显式判别联合：

```ts
type BenchmarkBaseline = UnrecordedBaseline | RecordedBaseline;

interface UnrecordedBaseline {
  schemaVersion: 3;
  status: 'not-recorded';
  suiteSize: number;
  description: string;
}

interface RecordedBaseline {
  schemaVersion: 3;
  status: 'recorded';
  suiteSize: number;
  thresholds: BenchmarkThresholds;
  report: BenchmarkReport;
}
```

不把 placeholder 伪装成 `BenchmarkReport`，也不静默猜测 v2 字段。

### 6.2 首补丁通过率

旧 `firstPatchPass` 来自已移除的 auto-validation。v3 不恢复产品内自动验证，而由 eval harness 观察：

1. 在第一个产生 workspace mutation 的**完整 tool batch**结束后复制临时 fixture；
2. Agent 继续在原 workspace 工作，不受 verifier 影响；
3. run 结束后在快照上执行独立 verifier；
4. verifier 通过且 `verify.mjs` 未被修改，记为 `firstPatchPass: true`；
5. 没有产生 mutation 或快照失败，记为 `false`。

这里的“patch”明确指首个完整变更批次，不是首个单工具调用，也不是最终工作区。

### 6.3 工具恢复率

旧指标“任意失败后出现任意成功”会把无关工具成功误判为恢复。v3 定义：

- recovery attempt：某个工具名至少出现一次非 success 的 `tool_call_end`；
- recovered tool：该工具名在失败后的**后续 model step** 中出现 success；同一批并发调用的完成顺序不算恢复；
- task 记录 distinct `toolRecoveryAttempts` 和 `toolRecoveries`；
- 汇总率为 `sum(toolRecoveries) / sum(toolRecoveryAttempts)`；没有恢复机会时为 `null`，不伪报 0%。

参数可在修复时变化，因此关联键使用 tool name，而不是 argument hash。

### 6.4 Baseline 比较与门禁

完整 `--task all` 运行读取 recorded baseline，并检查：

- schema、suite size 和 task ID 集合兼容；
- model、prompt hash 相同；
- passed task 数下降不超过阈值；
- first-patch pass rate 下降不超过阈值；
- tool-recovery rate下降不超过阈值（双方有恢复机会时）；
- regression rate 上升不超过阈值。

默认阈值为零退化，并随 baseline 显式保存。时间和 token 只报告，不作为阶段 0 的 correctness gate。

`--update-baseline` 必须在任何付费任务启动前验证为 `--task all`，并使用同目录临时文件 + rename 原子覆盖。允许记录包含失败任务的真实现状，但 runner 仍保持非零退出码。

### 6.5 Core 协议测试

阶段 0 优先冻结：

- `max_steps` 在完整工具批次之后终止；
- 空模型回复的既有 completed/onNoReply 语义；
- model stream 中 abort 的 history 恢复；
- 前一工具批次完成、下一 model step abort 时只保留完整批次；
- 普通 model error 的 trace/finalization 语义；
- trace sink 异常不改变主结果。

并发、permission、compact 和 attachment 测试在对应 stage 迁移前补齐，不为了数量一次性构造脆弱 fixture。

## 7. 渐进迁移阶段

| 阶段 | 交付物 | 验收 | 回滚 |
|---|---|---|---|
| 0 | eval v3、真实 baseline 契约、core 协议测试 | deterministic tests；真实 baseline 待显式付费运行 | 不改 core，无运行时回滚 |
| 1 | stage contracts + legacy adapters | legacy 路径 history/trace/replay 完全一致 | 删除装配层 |
| 2 | `HistoryManager` | tool-call/result golden、checkpoint/compact 索引一致 | 切回 history legacy adapter |
| 3 | `TraceSink` / `UsageMeter` / cancellation lifecycle | trace golden、sink failure isolation、abort restore | 分别切回 legacy adapter |
| 4 | `ModelRunner` | streaming、usage、abort、单次 overflow retry | 切回 model legacy adapter |
| 5 | `ContextTrimmer` | trim result、compact rebuild、abort 行为一致 | 切回 trim legacy adapter |
| 6 | `ToolDispatcher` | permission 顺序、四路调度、原序回灌、屏障 | 切回 dispatcher legacy adapter |
| 7 | `TerminationPolicy` + coordinator 收缩 | 所有 termination golden 与 coding eval 不退化 | 整体切回 legacy pipeline |

每个阶段只做行为保持型重构。已发现的 compact AbortError 路径、hook 抛错和 `onDone` 覆盖成功结果等问题，必须单列语义修复 PR。

## 8. 验证矩阵

每个实现 PR 至少运行：

```text
npm run typecheck
npm run lint:check
npm test
npm run eval:smoke
npm run format:check
git diff --check
```

分层验证：

1. 单元/协议测试：history、hooks、trace 和 termination 精确匹配；
2. deterministic replay：legacy/staged 消费相同 model/tool 记录，稳定字段完全一致；
3. coding eval：固定 model、promptHash、timeout，61 题建议至少 3 trials；
4. safety suite：permission、sandbox、rollback、resource lock 独立全量通过。

真实全量 eval 会产生费用，不能由普通 CI 自动更新 baseline。CI 负责无付费 smoke、schema、比较器和协议 fixture；baseline 录制由维护者显式执行。

## 9. 实施进度

- [x] 完成只读风险评估和边界设计。
- [x] 确认当前 suite 为 61 题、baseline 为 60 题占位、v2 schema 已漂移。
- [x] 阶段 0A：实现 eval schema v3、指标和 baseline compare/update。
- [x] 阶段 0B：补充首批 `runAgentCore` 协议测试。
- [ ] 阶段 0C：通过全量无付费验证（236/236、typecheck、build、eval smoke、lint 0 errors 和本次文件格式已通过；全仓 format 仍有 4 个既存文件告警）。
- [ ] 阶段 0D：维护者确认模型配置后，显式运行 61 题并录制真实 baseline。
- [ ] 阶段 1：定义 stage contracts 和 legacy adapters。
- [ ] 阶段 2-7：按上表逐阶段迁移。

## 10. 阶段 0 完成条件

阶段 0 只有在以下条件全部满足后才允许进入 stage 抽取：

- `evals/baseline.json` 是合法 v3 baseline，suite size 为 61；
- compare/update guard 有无付费测试；
- first-patch 和 tool-recovery 指标语义由测试固定；
- 本文列出的首批 core 协议测试通过；
- 现有全量测试、typecheck、lint、format 和 eval smoke 通过；
- 真实 baseline 已由维护者在固定模型配置下显式录制。
