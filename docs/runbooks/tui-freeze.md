# TUI 卡死与终端恢复 Runbook

目标是安全取消当前会话、恢复终端并保留可诊断证据，而不是无差别结束所有 Node/Electron 进程。

## 1. 先判断是不是正常等待

记录最后状态、spinner 是否仍动，并检查：

- 是否有权限或 `ask_human` 审批面板；
- 是否等待模型首 token；
- 是否在执行外部命令（`run_command` 默认超时 120 秒）；
- 是否在等待 `dev_server` readiness；
- 输入框是否只是 typeahead，Agent 实际仍在运行。

等待模型或外部进程不等于 UI 事件循环卡死。先记下时间和最后可见文本。

## 2. 安全取消

运行中按一次 `Ctrl+C`。正常路径会 abort 当前轮、终止受控命令并恢复本轮前 history。不要连续猛按：第二次按键可能落在输入态并退出程序。

若退出后终端仍停在备用屏、鼠标模式或光标隐藏，先新开一个终端保留现场，再在受影响终端执行：

```powershell
node -e "process.stdout.write('\x1b[r\x1b[?25h\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1007h\x1b[?1049l')"
```

Unix 还可执行 `stty sane` 或 `reset`；Windows Terminal/conhost 没有 `stty`，使用上面的 ANSI 复位或关闭该 tab。

## 3. 只结束确认过的进程树

Windows 先核对 PID、父进程和命令行：

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match 'node|electron|mocode' } |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine
```

确认属于本次会话后：

```powershell
taskkill /PID <ROOT_PID> /T /F
```

禁止 `taskkill /IM node.exe /F`。POSIX 先用 `ps -ef` / `ps -o pid,ppid,command` 查父子关系，再只向目标 PID/进程组发 TERM；禁止 `killall node`。

## 4. 采集环境与证据

```powershell
node --version
npm --version
npm list -g mocode-ai --depth=0
mocode --resume
```

记录：mocode 版本/安装方式、OS build、终端和 Shell、窗口行列、是否 SSH/VS Code 集成终端、provider/模型名（不含 key）、启动 cwd、sandbox root、session ID、最后状态、Ctrl+C 是否生效、最小复现。

源码复现可从项目根运行 `npm start`，把 stderr 重定向到仅本地的临时文件。项目没有统一的 `~/.mocode/tui.log`。

### 可检查路径

- 全局配置：`~/.mocode/config`
- 项目配置：`<cwd>/.env`、`<cwd>/.mocode/config`
- session：`<cwd>/.mocode/sessions/<id>/session.json`（旧格式可能是 `<id>.json`）
- trace：同 session 目录的 `trace.jsonl`
- 工作笔记/回滚：`notes.md`、`snapshots.json`
- dev server：`<sandbox-root>/.mocode/dev-servers/srv-*.log`
- 主动升级：`~/.mocode/upgrade.log`
- memory（启用时）：项目或全局 `.mocode/memory.jsonl`，反思日志为项目 `.mocode/memory.log`

session/trace 可能包含完整对话、路径、工具参数和后端错误；配置通常含 API key。提交 issue 前删除 Authorization、key、URL query、个人路径、私有源码和用户数据，绝不上传整份配置/session。

## 5. 故障分类

- **spinner/全部输入冻结**：检查同步 CPU/文件循环、事件循环阻塞。
- **整屏错位/乱码**：检查窗口 resize、Unicode 双宽字符、终端自动折行和物理行映射。
- **按键无效**：检查 composer、picker、审批模态是否未退出。
- **一直 thinking**：区分 provider 无首 token、网络半开和 Host 退出。
- **工具一直 running**：检查子进程树、锁等待和命令超时。
- **桌面端失败**：检查 `host_log`、公开 Host 定位和 Node 版本，不直接改内部 `dist` 路径。

Windows 注意：Agent 的 `run_command` 使用 `cmd.exe /d /s /c`，不是 PowerShell；需要 PowerShell 时显式调用 `powershell -NoProfile ...`。`SKILLS_DIRS` 在 Windows 用 `;`，POSIX 用 `:`。

## 6. 修复后验证矩阵

至少覆盖 Windows Terminal 和一个集成终端、窄/宽窗口、中文/emoji、运行中 resize、Ctrl+C、审批面板、长输出、一次外部命令和一次正常退出。PR 中记录没覆盖的平台，不要声称“跨平台已验证”。
