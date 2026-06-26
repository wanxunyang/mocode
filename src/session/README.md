# session/

会话历史持久化、恢复(resume)、上下文压缩(auto-compact)。

**状态**:已实现。

**组成**:
- `compact.ts` — 三层压缩(push-time 单条上限 / 旧工具结果微压缩 / 旧消息摘要)+ `maybeCompact` 自动门槛 + `capToolResultForHistory` + `contextState`。
- `persist.ts` — `saveSession` / `loadSession` / `listSessions` / `newSessionId`,落盘到 `<cwd>/.mocode/sessions/`。
- `index.ts` — barrel 重导出。

**设计**:见 [`docs/context-engineering.md`](../../docs/context-engineering.md)。

**不变量**:`compactHistory` 原地改 history(`length=0; push`);按完整 group(assistant + 其后连续 tool)切,永不破坏 `tool_call_id` 配对;`history[0]` 永远是当前 `config.systemPrompt`,摘要插 index 1。

**与 `memory/` 区分**:session 是「这次对话说了啥」,memory 是「跨会话的项目长期事实」(待实现)。
