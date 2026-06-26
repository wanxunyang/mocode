# agents/

子 agent:并行 / 隔离的子任务执行。

**状态**:未实现(空骨架)。

**现状**:`src/agent/index.ts` 的 `runAgent` 是单循环、共享主 history。

**计划**:
- 把 `runAgent` 泛化为可嵌套的子 agent,支持独立 history、工具子集、独立步数上限。
- 并行多 agent(fan-out)与隔离(worktree)两种模式。
- 参考 Claude Code 的 subagents / workflows。
- 子 agent 的最终输出回灌主 history,中间过程可选不展示。
