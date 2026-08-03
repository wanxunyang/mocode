# agents/

子 Agent 使用独立 history、可受限工具集和较低步数上限执行子任务，最终只把摘要回灌主 history。

**状态**：已实现结构化结果、只读并发、overlay 写隔离与 ChangeSet coordinator 合并；验证由 agent 自主决定。

## 结构

- `src/agent/core.ts`：纯 Agent loop；按 `Tool.capabilities` 将显式安全并行工具分组，其余工具串行执行。
- `src/agent/index.ts`：主 Agent 的 TUI hooks、diff、spinner 和 trace。
- `src/agent/spawn.ts`：子 Agent 的独立 history/context state 与静默 hooks。
- `src/tools/builtins/task.ts`：创建子 Agent，并将最终摘要作为 tool result 返回。

## 设计要点

- **独立 history**：子任务工具噪声不会进入主对话。
- **工具子集**：`SpawnOptions.tools` 可限制白名单；始终移除 `sub-agent`，禁止递归派生。
- **紧凑提示**：不复制主 Agent 的完整 system prompt、memory、skills；只发送窄 worker 约束和最多 4K 的主 Agent 事实摘要。
- **能力不截断**：写任务默认继承主 Agent 的完整工具能力，仅禁止递归创建 `sub-agent`；不设置硬 token/completion 上限。
- **成本可见**：每个结果返回 prompt/completion/cached/total token，用真实数据衡量优化，不靠提前杀死任务制造低消耗。
- **中断透传**：主 AbortSignal 贯穿子 Agent 的 LLM、命令和网络工具。
- **只读并发**：框架强制裁剪为只读工具集，不能仅靠 prompt 承诺；多个只读 task 可同批并发。
- **写隔离**：写 task 在临时 overlay 中运行，不直接触碰主工作区；二进制变更会被保守拒绝。
- **安全合并**：coordinator 把 overlay diff 转为带 expected hash 的 ChangeSet；提交使用 canonical resource lock，冲突不覆盖。
- **调度**：未知 write set 保持串行；已知 write set 的任务可并发生成 ChangeSet，并在真实写路径上持锁合并。
- **验证自主**：主/子 Agent 都可按任务需要显式运行检查；合并后没有框架强制检查。
- **PLAN 防线**：plan 模式不会向模型暴露 `sub-agent`，core 仍保留防幻觉调用检查。

`SubAgentResult` 暴露 `status/findings/readSet/changeSet/summary/usage`，不携带框架生成的验证状态。
