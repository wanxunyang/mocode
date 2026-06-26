# memory/

项目记忆(主要是 CLAUDE.md)的加载与召回。

**状态**:未实现(空骨架)。

**接入点**:启动时读取,拼进 `src/config/index.ts` 的 `systemPrompt`,或作为独立系统消息注入 `history`。

**计划**:
- 读取工作目录及其上级的 `CLAUDE.md`、全局 `~/.claude/CLAUDE.md`。
- 召回时按相关性筛选(避免全量塞满上下文)。
- 与 `session/` 区分:memory 是跨会话的长期事实,session 是单次对话记录。
