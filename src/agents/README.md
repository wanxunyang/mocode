# agents/

子 Agent 使用独立 history、可受限工具集和较低步数上限执行子任务，最终只把摘要回灌主 history。

**状态**：已实现独立上下文、中断透传、共享回滚与 capability-aware 串行调度。

## 结构

- `src/agent/core.ts`：纯 Agent loop；按 `Tool.capabilities` 将显式安全并行工具分组，其余工具串行执行。
- `src/agent/index.ts`：主 Agent 的 TUI hooks、diff、spinner 和 trace。
- `src/agent/spawn.ts`：子 Agent 的独立 history/context state 与静默 hooks。
- `src/tools/builtins/task.ts`：创建子 Agent，并将最终摘要作为 tool result 返回。

## 设计要点

- **独立 history**：子任务工具噪声不会进入主对话。
- **工具子集**：`SpawnOptions.tools` 可限制白名单；始终移除 `task`，禁止递归派生。
- **步数上限**：默认 `config.subAgentMaxSteps`，避免子任务失控。
- **中断透传**：主 AbortSignal 贯穿子 Agent 的 LLM、命令和网络工具。
- **共享工作区与回滚**：子 Agent 与主 Agent 使用同一沙箱和当前 turn mutation transaction，实际文件写入可被主轮观察与回滚。
- **串行安全**：`task` 声明为 write + serial；多个 task 不再并行写共享工作区。
- **PLAN 防线**：plan 模式不会向模型暴露 `task`，core 仍保留防幻觉调用检查。

## 后续扩展

只有在满足以下任一条件后才重新开放子 Agent 并行：

1. task 能可靠声明 read/write set，并由 scheduler 获取资源锁；
2. 每个写子任务运行在独立 worktree、overlay filesystem 或虚拟工作区，最终由 coordinator 合并 ChangeSet。

只读 task 的动态并行可作为中间阶段，但必须由框架验证其工具白名单全部为只读，不能只依赖 Prompt 承诺。
