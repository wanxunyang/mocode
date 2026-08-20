# memory/

项目记忆(纯 AGENTS.md)的加载与注入。

**状态**:已落地(v1 基础加载 + 全量注入;相关性筛选留 TODO)。

**命名**:纯 AGENTS.md(mocode 是独立工具,有自己的工具集与约定)。

**查找顺序**(远→近,合并时近的在后更突出):
- 全局:`~/.mocode/AGENTS.md`
- 项目级:从 `cwd` 向上逐级到根,每级 `AGENTS.md`

**注入**:`repl startRepl` 调 `buildMemorySection()` 拼进 `config.systemPrompt`(在 skills 段前),作为 `history[0]` 的 system 消息。`loadMemory()` 懒缓存(启动扫一次)。

**截断**:超 `MAX_MEMORY_CHARS=20000` 截断 + 末尾提示(system 在 `history[0]`,`compactHistory` 不压缩 system,故需截断防占窗口)。

**叶子**:仅依赖 node:fs/path/os,不反向依赖 config/agent/llm/tools/skills。

**与 session/ 区分**:memory 是跨会话长期事实(项目级文件,启动加载),session 是单次对话记录(落盘/resume)。

## TODO
- 相关性筛选:按需召回(embedding / 关键词索引),避免超大 AGENTS.md 全量塞满上下文。当前全量塞 + 截断。
