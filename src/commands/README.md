# commands/

斜杠命令(slash commands):`/exit` `/clear` 之外的扩展命令。

**状态**:未实现(空骨架)。

**现状**:`/exit` `/quit` `/clear` 硬编码在 `src/repl/index.ts`。

**计划**:
- 在 `repl/index.ts` 的输入分支加命令分发器,以 `/` 开头走分发、否则当用户消息。
- 命令以「配置 + 提示模板」形式注册(参考 Claude Code 的 slash commands / skills)。
- 内置命令(`exit`/`clear`/`help`/`model` ...)与项目 / 用户自定义命令分层。

**CLI 子命令**(由 `bin/mocode.js` → `dist/index.js` 的 `main()` 路由,非 REPL 内分发):
- `mocode config` — 首跑配置向导,交互写 `~/.mocode/config`(`src/commands/config.ts`)。独立模块,不引入 `config/index.ts`,故缺配置时也能跑。
