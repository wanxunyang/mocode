# agents/

子 agent:派生独立 history + 可受限工具集 + 低步数上限的子任务执行,最终摘要回灌主 history。

**状态**:已实现(阶段二:中断透传 + 并行 fan-out + 逻辑隔离)。

## 现状

`src/agent/` 三层:
- `core.ts` — `runAgentCore`(纯逻辑:流式 chat → 工具分组执行 → 回灌 / abort 还原 / maybeCompact)。所有展示副作用经 `AgentHooks` 注入,自身不依赖 ui/layout。工具分组三类:只读组(并发)、task 组(并发)、mutation/命令(串行)。
- `index.ts` — `runAgent`(主 agent):`runAgentCore` + TUI 渲染 hooks(layout + Spinner + diff + 回滚轮次)。行为与重构前一致。
- `spawn.ts` — `spawnAgent`(子 agent):`runAgentCore` + 静默 hooks(中间过程缓冲到 transcript,不写主屏)。独立 history,返回 `{ summary, completed, transcript }`。

`task` 工具(`src/tools/builtins/task.ts`)让主 agent 通过工具调用派生子 agent。子 agent 摘要作为 tool 结果回灌主 history。

## 设计要点

- **独立 history**:子 agent 不共享主对话,避免子任务的工具噪声污染主上下文 / 撑爆窗口。
- **工具子集**:`SpawnOptions.tools` 白名单过滤 `chatTools`;始终剔除 `task`(防递归派生)。无白名单 = 全量(除 task)。
- **步数上限**:默认 `config.subAgentMaxSteps`(50),低于主 agent(200),防子任务失控。
- **系统提示**:复用主 agent 组装链(`config.systemPrompt` + memory 段 + skills 段)+ `SUBAGENT_SUFFIX`(子 agent 角色约束)。
- **中断透传**:`SpawnOptions.signal`(主 agent 的 abort signal)透传给子 `runAgentCore` → `chat`/`executeTool`。主 Ctrl+C 树杀子 agent(chat 流式 abort + run_command/web_fetch 即时取消)。`task` 工具经 `ctx.signal` 拿到主 signal 传给 `spawnAgent`。
- **并行 fan-out**:一轮里多个 `task` tool_call 成组并发执行(core 的 task 并发组)——一次性启动全部子 agent,再按序 await + 渲染。总耗时 ≈ 最慢一个子 agent。task 与 mutation/run_command 之间仍串行屏障(子 agent 可能有文件改动,不能和 write_file 乱序)。
- **逻辑隔离(回滚)**:子 agent `skipRollback=true`,其 `write_file`/`edit_file` 改动不进主回滚快照链(`executeTool` 跳过 `recordMutation`)。主 `/rollback` 不撤销子 agent 改动(靠 git 兜底)。子 agent 与主 agent 共享 cwd(文件改动可见)。子 agent 不调 `beginTurn`(不进主回滚轮次链)。
- **plan 模式**:`task` 在 `PLAN_DISABLED_TOOLS` 里,plan 模式下主 agent 看不到此工具(子 agent 可能有 mutation,违反只读)。

## 限制(后续可扩展)

- **上下文压缩**:子 agent 用独立 history,内部也调 `maybeCompact`(作用于子 history,复用 core 逻辑),长子任务不会溢出。
- **并发写竞态**:多个子 agent 并发跑时若都改同一文件会竞态。子 agent 通常做探查/独立子任务,并发写同文件概率低;task 工具描述已提示"独立子任务"。
- **真 worktree 隔离未实现**:当前是逻辑隔离(共享 cwd + 回滚隔离)。真 worktree 需给所有工具注入 per-agent cwd(全仓库 17 处 `process.cwd()` 要改)+ git worktree add/remove/merge + 中断清理,成本高。
