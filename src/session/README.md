# session/

会话历史持久化、恢复(resume)、上下文压缩。

**状态**:未实现(空骨架)。

**现状**:`src/repl/index.ts` 在内存里持有 `history`,退出即丢失。

**计划**:
- 把 `history` 序列化到磁盘(`.terminal-agent/sessions/`),支持 `--resume` 续接。
- 消息超长时自动压缩 / 摘要(需要 `llm/` 的 token 计数落地后接入)。
- 与 `memory/` 区分:session 是「这次对话说了啥」,memory 是「跨会话的项目长期事实」。
