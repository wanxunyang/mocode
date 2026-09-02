# rust/ — mocode 的 Rust TUI 前端(增量重构路径 A)

> 本目录**已被 `.gitignore` 忽略**,是独立于 TS 主工程的实验区。
> 目标是验证「用 Rust 重写 TUI 前端」的可行性,**TS 侧代码零改动**。

## 它是什么

一个独立的 Rust 二进制 `mocode-tui`。它**不实现任何 agent 逻辑**,只做三件事:

1. spawn 现有的 TS `bin/mocode-agent-host.js` 子进程
2. 经 stdin 写命令、stdout 读事件,说 `src/host/protocol.ts` 定义的 NDJSON 协议
3. 用 ratatui 渲染事件流

```text
┌─────────────────────┐   JSON commands    ┌──────────────────────────┐
│  Rust TUI           │ ──────────────────→│  TS agent-host           │
│  (ratatui, 本目录)   │   (stdin)          │  agent core + LLM + tools │
│                     │ ←──────────────────│  原封不动,零改动          │
│  渲染事件流          │   JSON events      │                          │
└─────────────────────┘   (stdout)         └──────────────────────────┘
```

## 构建与运行

前置:本机需装 Rust(https://rustup.rs)。**未装时本目录不参与 TS 构建,完全不影响主工程。**

```bash
# 1. 先让 TS 侧产出 dist/(agent-host 跑的是编译产物)
npm run build

# 2. 编译 Rust TUI
cd rust
cargo build --release

# 3. 运行(须在项目根目录启动,沙箱 root 取 cwd)
cd ..
./rust/target/release/mocode-tui

# 或直接
cargo run --release --manifest-path rust/Cargo.toml
```

产物:`target/release/mocode-tui.exe`,**849 KB 单文件**,`strip` 过,无外部 DLL 依赖
(除系统库)。

### Windows + 无 MSVC / 无 MinGW 的环境(本机实测)

本机是一台**既没有 Visual Studio Build Tools、也没有 MinGW** 的 Windows,属于 rustup
默认路径(`x86_64-pc-windows-msvc`)必然失败的场景。完整搭建记录如下,踩了 4 个坑:

| # | 坑 | 解法 |
|---|-----|------|
| 1 | `winget install Rustlang.Rustup` 退出码 1 | 它默认装 **msvc** 工具链,而本机无 `link.exe`。改用 GNU:`rustup toolchain install stable-x86_64-pc-windows-gnu` |
| 2 | `cargo` / `rustc` 是 **0 字节空文件** | rustup 建硬链接时被已存在的 `rustfmt.exe` 撞了一下(`os error 183`),整个链接步骤中断,留下一堆 0 字节代理。删掉它们后用 `New-Item -ItemType HardLink` 手动重建 |
| 3 | `linker 'link.exe' not found` | 没有 gcc。用工具链自带的 rust-lld:`.cargo/config.toml` 里 `-C link-self-contained=yes`。注意 `+linker` 是不稳定值,只有 `yes`/`no`/`on`/`off` 稳定 |
| 4 | `error calling dlltool 'dlltool.exe': program not found` | `parking_lot_core`(crossterm 间接依赖)用 raw-dylib 链接,gnu target 上**必须**有 dlltool 才能生成 import lib——光有 rust-lld 不够。装 MinGW binutils 解决 |

最终可行组合:**rustup(GNU 工具链) + MSYS2 的 `mingw-w64-x86_64-binutils`(仅 dlltool) + rust-lld 链接**。
注意不需要完整 gcc —— rustc 用自带 lld 链接,binutils 只提供 dlltool 一个程序。

```powershell
# 1) Rust GNU 工具链(官方源实测 0.43s 即达,不需要换镜像)
winget install -e --id Rustlang.Rustup
rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal
rustup default stable-x86_64-pc-windows-gnu

# 2) 若 cargo/rustc 是 0 字节 —— 删空壳后手动建硬链接
#    (PowerShell 5.1)
$bin = "$env:USERPROFILE\.cargo\bin"
Get-ChildItem $bin -File | Where-Object { $_.Length -eq 0 } | ForEach-Object { [System.IO.File]::Delete($_.FullName) }
foreach ($t in 'cargo','rustc','rustfmt','rustdoc') {
    New-Item -ItemType HardLink -Path "$bin\$t.exe" -Target "$bin\rustup.exe" -Force
}

# 3) MinGW binutils(只要 dlltool.exe)
winget install -e --id MSYS2.MSYS2
# MSYS2 的 installer 会卡在交互步骤 —— 直接杀掉,文件已落在 C:\msys64,自己往下走
# 若 pacman 报 "Public keyring not found":gpg 在本机会陷入 lockfile 死循环,
# 编辑 C:\msys64\etc\pacman.conf,把 SigLevel 改成 Never
& "C:\msys64\usr\bin\bash.exe" -lc "pacman -Sy --noconfirm"
& "C:\msys64\usr\bin\bash.exe" -lc "pacman -S --noconfirm --needed mingw-w64-x86_64-binutils"

# 4) PATH(新开终端后生效)
#    C:\Users\<you>\.cargo\bin
#    C:\msys64\mingw64\bin
```

国内镜像不必配:`index.crates.io` 实测 0.33s,比 rsproxy(1.22s)/ ustc(0.93s)都快。

若 agent-host 路径定位失败,用环境变量显式指定:

```bash
MOCODE_HOST=/abs/path/to/mocode/bin/mocode-agent-host.js ./rust/target/release/mocode-tui
```

## 键位

| 按键 | 行为 |
|------|------|
| `Enter` | 发送输入 |
| `Ctrl+J` / `Alt+Enter` / `Shift+Enter` | 插入换行(多行输入) |
| `Ctrl+C` | 运行中→软取消 agent;有内容→清空(可 `Ctrl+Z` 恢复);空输入→退出 |
| `Ctrl+D` | 输入为空时退出 |
| `Ctrl+A` / `Home` | 行首 |
| `Ctrl+E` / `End` | 行尾 |
| `Ctrl+U` / `Ctrl+K` | 删到行首 / 行尾 |
| `Ctrl+Z` | 恢复被 `Ctrl+C` 清空的输入(单次) |
| `Backspace` / `Delete` | 删光标左侧 / 右侧字符 |
| `Esc` | 关菜单或回父级 / 清输入 / 关诊断浮层 / 回到底部 |
| `↑` `↓` | 菜单导航 → 多行内移动光标 → 翻输入历史 |
| `PageUp` `PageDown` | 滚动十行 |
| 鼠标滚轮 | 滚动三行 |
| 鼠标左键 | 点批摘要行展开明细,点明细行展开完整输出 / diff |
| `Tab` | 菜单打开时补全,否则展开/折叠最近一个工具批 |
| `Shift+Tab` | 切换 Auto / Plan 模式标识 |
| `F1` | 开关 agent-host stderr 诊断浮层 |
| `/` | 打开斜杠命令菜单(输入即过滤) |

粘贴走 bracketed paste:整段一次插入,多行内容不会被逐行当成 Enter 提交。

审批浮层打开时:`↑↓` 选、`Enter` 确认、`Esc`/`Ctrl+C` 取消。默认高亮**最后一项**
(TS 侧惯例把「拒绝」放最后,避免误批准)。

## 目录结构

```text
rust/
├── Cargo.toml
├── examples/
│   └── smoke.rs    零成本冒烟测试:spawn agent-host 验证协议对接(不调 LLM)
├── tests/
│   └── render.rs   端到端渲染回归:TestBackend 跑真实 draw 管线
└── src/
    ├── lib.rs        库入口 —— 让 examples/ 与 tests/ 能复用协议层
    ├── main.rs       终端生命周期 + 主循环 + 键鼠/粘贴输入
    ├── protocol.rs   NDJSON 协议类型(与 src/host/protocol.ts 一一对应)
    ├── ipc.rs        子进程 spawn / 三线程读写 / 进程树杀 / 路径定位
    ├── app.rs        状态机:条目、输入、斜杠命令、状态栏、滚动、工具摘要
    ├── commands.rs   斜杠命令菜单树 + 过滤/补全/渲染
    ├── markdown.rs   正文 markdown → ratatui Line(标题/代码块/列表/表格/行内样式)
    ├── diff.rs       mutation 的 LCS 行 diff → 带行号与 +/- gutter 的块
    ├── wrap.rs       显示宽度感知的折行 + 硬换行 + 光标定位(含单测)
    └── ui/
        ├── mod.rs    三段布局 + 内容区/状态栏/输入框 + 三个浮层
        └── theme.rs  配色
```


## 与 TS 实现的对应关系

| Rust | TS | 说明 |
|------|-----|------|
| `protocol.rs` | `src/host/protocol.ts` | 同一份协议的两侧定义,**改一侧必须同步另一侧** |
| `ipc.rs` | `src/host/stdio.ts` 的读写两端 | TS 是协议生产者,Rust 是消费者 |
| `app.rs::on_event` | `src/agent/core.ts` 的 `AgentHooks` 调用点 | TS 把 hooks 转译成事件,Rust 消费事件 |
| `app.rs::summarize_tool_call` | `src/ui/render.ts:312` | 逐工具复刻,保持视觉一致便于 A/B 对照 |
| `wrap.rs` | `src/ui/layout.ts` + `batch.ts` 的行宽维护 | 见下 |
| `ui/mod.rs` | `src/repl/index.ts` + `src/ui/layout.ts` | 布局与交互 |

## 设计要点

### 1. 折行:不变量由构造保证,而非事后修补

TS 侧 `layout.ts` / `batch.ts` 手工维护「每条物理行可见宽 ≤ 终端 cols」。一旦某行超宽被终端
auto-wrap,物理行与 buffer 行错位,CUP 定位全错 → 整屏乱码。这是 TS 实现中最难缠的一类 bug
(见 `.workbuddy/memory/MEMORY.md` 的「content buffer 行宽不变量」条目)。

Rust 侧把这个不变量前移:**交给 ratatui 的每一行,在交出去之前就已经保证不超宽**。
运行时不可能出现「终端自己折行」,因为根本不会产出超宽行。

为什么不用 `Paragraph::wrap`:配套的 `line_count`(算折行后总行数,滚动区间必需)在
ratatui 0.29 属于 `unstable-rendered-line-info` feature,不受 semver 保护。自己折行则
总行数 = `Vec::len()`,精确且无依赖。代价是不按词边界断行(与终端原生行为一致)。

`wrap.rs` 里有对应的回归测试,包括逐宽度扫描的不变量断言和光标定位一致性断言。

### 2. 三线程 IPC:UI 线程不等任何 I/O

TS 侧 spinner 冻屏的根因是事件循环被阻塞。这里:

- stdout 读线程:按行解析 JSON → channel
- stderr 读线程:收集诊断 → channel
- stdin 写线程:命令队列 → 子进程

主线程只做「渲染 + `try_recv` 抽干队列」,**从不调用阻塞的 `recv()`**。
任何一端慢都拖不住 UI,单帧最坏延迟是一次非阻塞 `try_recv`。

### 3. 宽松解析:协议漂移不白屏

`payload` 一律保留为 `serde_json::Value`,取值走 `str_at` / `num_at` / `bool_at`
这类带默认值的 helper,而不是严格 derive 反序列化。TS 侧新增字段或某个字段类型漂移时,
Rust 侧缺字段走默认值、未知事件落到 `HostEvent::Unknown` 进诊断浮层,不会崩。

### 4. 进程树杀

`host/stdio.ts` 的注释指出 Windows 无 job object,子进程拉起的后台进程(如 dev_server)
不随父进程退出。Rust 侧退出时:Windows 走 `taskkill /F /T /PID`,Unix 走 `killpg`
(spawn 时用 `process_group(0)` 让子进程自成一组)。`Drop` 里再兜一次,任
何退出路径都不留孤儿。

## 单测

```bash
cd rust && cargo test
```

覆盖 `wrap.rs`(折行宽度不变量、逐宽度扫描 + 中日韩宽字符 + 样式保持、光标定位一致性)
与 `ipc.rs`(verbatim 前缀剥离)。**12 个测试全绿。**

## 冒烟测试:验证协议真的通

编译通过 ≠ 连得上。`examples/smoke.rs` 会真的 spawn agent-host、等 `runtime_ready`、
校验字段,**但不发 `run` 命令** —— 不消耗 LLM token、不需要 API key。

```bash
cd rust && cargo run --example smoke
```

正常输出:

```text
host script : F:\mocode\bin\mocode-agent-host.js
workdir     : F:\mocode
spawned     : pid=16068

[runtime_ready] 收到于 +0.6s
  project_root : F:\mocode
  provider     : openai
  prompt_cache : false
  warnings     : []

OK — 协议对接正常。子进程由 Drop 自动回收。
```

它会断言三件事:子进程能起来、`projectRoot` 等于传入的 workdir(sandbox root 的来源,
对不上说明 cwd 传错,后续所有文件操作都会越界)、stdout 上没有非 JSON 行。

### `--full`:跑一轮真实对话

```bash
cargo run --release --example smoke -- --full
```

会真的发一条 `run` 命令(几百 token,成本可忽略),验证握手测不到的三件事:
`HostCommand::Run` 的字段契约是否被 TS `parseCommand` 接受、`text_delta` 能否被正确累积、
`run_finished` / `run_completed` 的 usage 解析是否正确。实测输出:

```text
  [run_started] session=20260830-041410 resumed=false provider=openai
  [status] thinking

  session      : 20260830-041410
  completed    : true
  termination  : completed
  changed_files: []
  context      : 0% of 100000

  正文(2 字): OK
  事件统计: run_completed=1 run_finished=1 run_started=1 status=1 text_delta=1
  耗时        : 3997ms
  tokens      : prompt=7631 completion=26 total=7657

OK — 端到端链路正常。
```

prompt 里明确禁止工具调用 —— 既省 token,也避免撞上权限审批卡住流程。
真收到 `approval_requested` 时会自动回 `cancelled`,不会悬挂。

> 观察:首轮 `usage_percent` 报 0%(实际已用 7657/100000 ≈ 7.6%)。这是 TS 侧
> `run_completed` 里该字段的口径问题(像是 run 开始前的快照),不是 Rust 侧解析错。
> 会影响状态栏的上下文用量显示,待路径 C 时再核。

**这个测试第一次跑就抓出两个真 bug**,都是编译期发现不了的:

1. **`\\?\` verbatim 前缀** —— Rust 的 `fs::canonicalize()` 在 Windows 上返回
   `\\?\F:\mocode\bin\...`,而 node 的 fs 处理不了这种路径,会在 `binding.lstat`
   处直接抛异常退出。已加 `strip_verbatim_prefix()` 修复(含 `\\?\UNC\` 还原)。
2. **握手超时写成了 3 秒** —— 实测 `runtime_ready` 需要 0.6~5.3 秒(时间花在
   `initializeAllMcp()`),3 秒会稳定握手失败。已放宽到 30 秒。

### 为什么要有 lib

`src/lib.rs` 把协议层与 IPC 层对外暴露 —— 纯 `[[bin]]` crate 的模块对 `examples/`
和 `tests/` 是不可见的。拆出 lib 后协议才能被自动化测试覆盖,路径 B/C 也才有立足点。

## 已知未实现 / 与 TS 版的差距

已补齐(本轮):markdown 渲染、diff 视图、多行输入、bracketed paste、输入历史、
`/resume <id>`、`/compact <focus>`。

仍有差距的部分,按**根因**分两类。

### 一、协议缺口(不改 `src/host/protocol.ts` 就做不到)

`HostCommand` 目前只有 `run` / `cancel` / `compact` / `approval` 四种。以下命令在 TS REPL
里是改**运行时状态**的,Rust 侧只能给提示,因为协议里没有对应的命令:

| 命令 | 缺什么 | 现状 |
|------|--------|------|
| `/clear` | 清空 agent-host 侧 `history` | 只清 Rust 侧显示,模型仍记得上文 —— **这是当前最容易误导用户的一条** |
| `/plan` `/auto`(Shift+Tab) | 调 `setAgentMode()` | 只改状态栏 `modeTag`,工具集没真的切成只读 |
| `/rollback` | 轮次快照列表 + 应用回滚 | 提示去用 TS 版 |
| `/memory on/off`、`/reflect` | 记忆子系统开关与手动反思 | 提示改 `.env` 重启 |
| `/model switch/use` | 运行时换模型并 `reconfigureClient()` | 提示改 `.env` 重启 |
| `/theme` `/language` | 这两项纯属前端,Rust 侧自己实现即可 | 固定 orange + 中文 |

`/clear` 与模式切换这两条建议优先补(见下方方案的第 1 阶段)。

### 二、TS 协议本身的限制

- **审批的自由文本提交**:`protocol.ts` 的 `action` 只接受 `selected` / `cancelled`,
  没有 `submitted`,所以 `ask_human` 的自由文本回答无法经协议回传。改这条要同时动 TS 侧。
- **`usage_percent` 口径**:smoke 实测首轮报 0%(实际已用约 7.6%),像是 run 开始前的快照。
  影响状态栏用量条,根因在 TS 侧 `run_completed` 的取值时机。

### 三、纯前端待办(不涉及协议)

- **多模态附件**:`/image attach` 已能读文件转 data URL 并随 `Run` 发出,但没有终端图片预览。
- **剪贴板**:`src/ui/clipboard.ts` 未移植(粘贴已由 bracketed paste 覆盖,少的是"复制走")。
- **代码块语法高亮**:`markdown.rs` / `diff.rs` 的代码区目前是单色。TS 侧用 `cli-highlight`,
  Rust 侧可接 `syntect`,但会显著增大二进制体积,建议按需再定。

## 下一步重构方案

### 阶段 1:补协议缺口(收益最高,改动最小)

给 `HostCommand` 加三条命令,TS 侧 `stdio.ts` 各加一个 handler:

```ts
| { id: string; type: 'clear' }                        // history = [system]
| { id: string; type: 'mode'; value: 'auto' | 'plan' } // setAgentMode + refreshChatTools
| { id: string; type: 'session'; sessionId: string }   // 显式 restoreSession,不必等下一条 run
```

`clear` 与 `mode` 是三行 handler 的量级,却能让 `/clear`、Shift+Tab、`/plan`、`/auto`
从"假动作"变成真生效。这一步做完,Rust TUI 才算与 TS REPL 行为等价。

### 阶段 2:路径 B —— 计算密集工具 Rust 化

把 `grep` / `glob` 用 Rust 写成独立二进制(`ripgrep` 的 `grep-searcher` + `ignore` crate),
TS 侧 `src/tools/builtins/grep.ts` 改为 spawn 它。`Tool.execute` 契约不变,
`CAPABILITIES` 与注册表无感,可单独回退。适合先做 `grep`:它最常被调用、
且当前是纯 JS 遍历,大仓库上收益最直观。

### 阶段 3:路径 C —— agent core 迁移

用 Rust 实现同一份协议的**生产者端**(现在 Rust 是消费者端),逐步替换
`agent/core.ts` + `llm/index.ts` + `session/compact.ts`。

关键在于顺序:`protocol.rs` 已经是双向契约的单一事实源,所以可以让 Rust 侧
先只接管 `llm` 的流式请求(最独立、最容易对照验证),再是 session 压缩,
最后才是 tool-call 循环本身 —— 每一步都能用现有的 `examples/smoke.rs --full`
做端到端回归,不需要一次性切换。
