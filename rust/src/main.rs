//! mocode-tui —— 用 Rust 重写的 TUI 前端(增量重构路径 A)。
//!
//! 它**不实现任何 agent 逻辑**:只 spawn 现有的 TS `bin/mocode-agent-host.js`,
//! 经 stdin/stdout 说 `src/host/protocol.ts` 定义的 NDJSON 协议,再用 ratatui 渲染。
//! TS 侧代码零改动。

use std::io::{self, Stdout, Write};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, Event,
    KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use crossterm::execute;
use crossterm::style::{Attribute, ResetColor, SetAttribute};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use mocode_tui::app::App;
use mocode_tui::ipc;
use mocode_tui::protocol;
use mocode_tui::ui;

/// 主循环 tick:运行中用较短间隔(喂 spinner 动画),空闲时放宽省电。
const TICK_RUNNING: Duration = Duration::from_millis(80);
const TICK_IDLE: Duration = Duration::from_millis(250);

/// 启动握手等待上限:等 agent-host 的 `runtime_ready`(它要初始化 MCP、注册工具)。
///
/// 实测(本机,2026-08-30):从 spawn 到 `runtime_ready` 约 **5.3 秒** —— 时间几乎全花在
/// `initializeAllMcp()`。原先写 3s 会稳定握手失败,这里给 30s 留足余量
/// (冷启动 / MCP 服务器多 / 网络慢时还会更久)。
const READY_TIMEOUT: Duration = Duration::from_millis(30_000);

fn main() -> Result<()> {
    // 1. 定位并启动 agent-host —— 必须在进 alt screen 之前,否则 spawn 报错会被 TUI 吞掉。
    let host_script = ipc::locate_host_script()?;
    let project_root: PathBuf = host_script
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .context("从 agent-host 路径反推项目根失败")?;

    let host = ipc::AgentHost::spawn(&host_script, &project_root)?;

    // 2. 接管终端。panic 也要还原 —— TS 侧 index.ts 的 exit/SIGINT/uncaught 钩子是同一件事,
    //    这里用 panic hook 覆盖 unwind 路径。
    install_panic_hook();
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    // 不设终端背景(OSC 11):底色保持用户终端原色,配色只作用于我们画出的内容。
    // EnableBracketedPaste:粘贴内容作为一个 `Event::Paste` 整体到达,而不是被拆成
    // 逐字符的 key press。没有它,粘贴多行文本会被当成多次 Enter —— 一段代码会被
    // 拆成好几条消息连续提交出去,是很难受的失败模式。
    // 先复位 SGR 再清空备用屏，避免继承启动终端残留的主题背景色。
    // Clear 使用当前 SGR 背景填充，因此必须位于 ResetColor 之后。
    execute!(
        stdout,
        ResetColor,
        SetAttribute(Attribute::Reset),
        EnterAlternateScreen,
        Clear(ClearType::All),
        EnableMouseCapture,
        EnableBracketedPaste
    )?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let result = run_loop(&mut terminal, host, project_root);

    // 3. 还原终端(无论上面成功还是出错)。
    let _ = disable_raw_mode();
    let _ = execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture,
        DisableBracketedPaste
    );
    let _ = terminal.show_cursor();
    let mut stdout = io::stdout();
    let _ = reset_terminal_background(&mut stdout);

    result
}

fn run_loop(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    host: ipc::AgentHost,
    project_root: PathBuf,
) -> Result<()> {
    let mut app = App::new(host, project_root.display().to_string());

    // 等 runtime_ready:拿到 provider 与 MCP 警告后再进场,避免首帧信息不全。
    // 超时不阻塞启动 —— agent-host 慢不该让用户对着黑屏。
    wait_for_ready(&mut app);

    loop {
        // 每帧都重绘:draw 内部按需推进 spinner,折行结果带缓存不会重复计算。
        terminal.draw(|f| ui::draw(f, &mut app))?;

        if app.should_quit {
            return Ok(());
        }

        // 非阻塞抽干 IPC 队列。这里绝不用 recv() 阻塞 —— 那正是 TS 侧 spinner
        // 冻屏的成因:UI 线程不该等任何 I/O。
        while let Some(msg) = app.host.try_recv() {
            app.on_ipc(msg);
        }

        let tick = if app.running { TICK_RUNNING } else { TICK_IDLE };
        if crossterm::event::poll(tick).context("读取终端事件失败")? {
            match crossterm::event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => handle_key(&mut app, key),
                Event::Mouse(m) => handle_mouse(&mut app, m),
                // 粘贴:整段一次插入。绝不能逐字符走 handle_key —— 那样内容里的换行
                // 会被当成 Enter 逐条提交出去。
                Event::Paste(text) => app.insert_str(&text),
                // Resize 不需要显式处理:下一帧 area.width 变了,折行缓存按宽度自动失效。
                Event::Resize(..) => {}
                _ => {}
            }
        }
    }
}

/// 等待 `runtime_ready`,期间把其它事件一并灌进 app(启动警告等)。
fn wait_for_ready(app: &mut App) {
    let deadline = std::time::Instant::now() + READY_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        // 收到任意事件就继续抽;runtime_ready 通常是最早的一批之一。
        match app.host.recv_timeout(remaining) {
            Some(msg) => {
                let is_ready = matches!(
                    &msg,
                    ipc::IpcMessage::Event {
                        event: protocol::HostEvent::RuntimeReady { .. },
                        ..
                    }
                );
                app.on_ipc(msg);
                if is_ready {
                    break;
                }
            }
            None => break, // 超时或通道关闭
        }
    }
}

// ────────────────────────────── 输入处理 ──────────────────────────────

fn handle_key(app: &mut App, key: crossterm::event::KeyEvent) {
    // 审批浮层打开时,键盘全部归它(避免误触发输入框或取消)。
    if app.pending_approval.is_some() {
        handle_approval_key(app, key);
        return;
    }

    // Shift+Tab:切换 agent 模式(auto ↔ plan)。对齐 TS prompt.ts。
    if key.code == KeyCode::Tab && key.modifiers.contains(KeyModifiers::SHIFT) {
        app.cycle_mode();
        return;
    }

    // Ctrl+C:有运行则软取消;有内容/菜单打开则清空;空输入再按一次退出(仿 fish)。
    // 置顶,使粘贴中也能被截到。
    if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
        if app.running {
            // 运行中:软取消(发 Cancel 给 agent-host)
            app.interrupt();
        } else if !app.input.is_empty() || app.slash_menu.open {
            // 有内容或菜单打开:清空(留快照供 Ctrl+Z 恢复)
            app.interrupt();
        } else {
            // 空输入且无菜单:退出 TUI(与 TS prompt.ts onCtrlC 的 SIGINT 路径一致)
            app.should_quit = true;
        }
        return;
    }

    // Ctrl+D:空输入时退出(沿用 shell 惯例)。
    if key.code == KeyCode::Char('d') && key.modifiers.contains(KeyModifiers::CONTROL) {
        if app.input.is_empty() && !app.slash_menu.open {
            app.should_quit = true;
        }
        return;
    }

    // Ctrl+A / Ctrl+Q:行首(对齐 TS:Ctrl+A 和 Ctrl+Q 都跳行首)。
    if (key.code == KeyCode::Char('a') || key.code == KeyCode::Char('q'))
        && key.modifiers.contains(KeyModifiers::CONTROL)
    {
        app.move_cursor_to_line_start();
        return;
    }

    // Ctrl+E:行尾。
    if key.code == KeyCode::Char('e') && key.modifiers.contains(KeyModifiers::CONTROL) {
        app.move_cursor_to_line_end();
        return;
    }

    // Ctrl+U:删到行首。
    if key.code == KeyCode::Char('u') && key.modifiers.contains(KeyModifiers::CONTROL) {
        app.delete_to_line_start();
        return;
    }

    // Ctrl+K:删到行尾。
    if key.code == KeyCode::Char('k') && key.modifiers.contains(KeyModifiers::CONTROL) {
        app.delete_to_line_end();
        return;
    }

    // Ctrl+Z:恢复被 Ctrl+C 清空的输入(单次)。
    if key.code == KeyCode::Char('z') && key.modifiers.contains(KeyModifiers::CONTROL) {
        app.restore_undo();
        return;
    }

    // Ctrl+J:插入换行(对齐 TS:Ctrl+J / Alt+Enter / Shift+Enter)。
    if key.code == KeyCode::Char('j') && key.modifiers.contains(KeyModifiers::CONTROL) {
        app.insert_newline();
        return;
    }

    // Alt+Enter / Shift+Enter:插入换行。
    if key.code == KeyCode::Enter && !key.modifiers.contains(KeyModifiers::CONTROL) {
        if key.modifiers.contains(KeyModifiers::ALT)
            || key.modifiers.contains(KeyModifiers::SHIFT)
        {
            app.insert_newline();
            return;
        }
    }

    // Enter:提交(菜单打开时先应用选中项)。
    if key.code == KeyCode::Enter && key.modifiers.is_empty() {
        app.submit();
        return;
    }

    match (key.code, key.modifiers) {
        (KeyCode::Backspace, _) => app.backspace(),
        // Delete 删光标右侧字符。绝不能写成 move_cursor(1)+backspace():
        // 光标在末尾时右移无效,backspace 会误删左侧字符。
        (KeyCode::Delete, _) => app.delete_forward(),
        (KeyCode::Left, _) => app.move_cursor(-1),
        (KeyCode::Right, _) => app.move_cursor(1),
        (KeyCode::Home, _) => app.move_cursor_to_line_start(),
        (KeyCode::End, _) => app.move_cursor_to_line_end(),
        (KeyCode::Up, _) => app.on_arrow_up(),
        (KeyCode::Down, _) => app.on_arrow_down(),
        (KeyCode::PageUp, _) => app.scroll_by(-10),
        (KeyCode::PageDown, _) => app.scroll_by(10),
        (KeyCode::F(1), _) => app.show_diagnostics = !app.show_diagnostics,
        // Tab:菜单打开时补全,否则展开/折叠最近工具。
        (KeyCode::Tab, _) => app.on_tab(),
        // Esc:菜单打开时关闭/回到父级,否则清空输入或回尾。
        (KeyCode::Esc, _) => app.on_escape(),
        // 可打印字符(>= 空格,非 ctrl/meta/shift)。
        (KeyCode::Char(c), m)
            if !m.contains(KeyModifiers::CONTROL) && !m.contains(KeyModifiers::ALT) =>
        {
            app.insert_char(c)
        }
        _ => {}
    }
}

fn handle_approval_key(app: &mut App, key: crossterm::event::KeyEvent) {
    match key.code {
        KeyCode::Up => {
            if let Some(pa) = app.pending_approval.as_mut() {
                if pa.selected > 0 {
                    pa.selected -= 1;
                }
            }
        }
        KeyCode::Down => {
            if let Some(pa) = app.pending_approval.as_mut() {
                if pa.selected + 1 < pa.options.len() {
                    pa.selected += 1;
                }
            }
        }
        KeyCode::Enter => {
            let Some(pa) = app.pending_approval.as_ref() else {
                return;
            };
            // 选项值即 TS 侧 `options` 数组里的原始字符串(TS host 把 label 直接透传)。
            let value = pa.options.get(pa.selected).cloned();
            app.resolve_approval(protocol::ApprovalAction::Selected, value);
        }
        // Esc 与 Ctrl+C 都是"取消" —— 必须分开写两条,写成
        // `KeyCode::Esc | KeyCode::Char('c') if CONTROL` 会让裸 Esc 失效。
        KeyCode::Esc => app.resolve_approval(protocol::ApprovalAction::Cancelled, None),
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.resolve_approval(protocol::ApprovalAction::Cancelled, None)
        }
        _ => {}
    }
}

fn handle_mouse(app: &mut App, m: MouseEvent) {
    match m.kind {
        MouseEventKind::ScrollUp => app.scroll_by(-3),
        MouseEventKind::ScrollDown => app.scroll_by(3),
        // 左键点击内容区 → 切换对应工具批的展开层级(对齐 TS 的 batch 点击展开)。
        // 只在 release 时触发:拖动选文本不该顺手折叠掉内容。
        MouseEventKind::Up(MouseButton::Left) => {
            let Some(area) = app.content_area else {
                return;
            };
            let inside = m.column >= area.x
                && m.column < area.x + area.width
                && m.row >= area.y
                && m.row < area.y + area.height;
            if inside {
                app.click_content((m.row - area.y) as usize);
            }
        }
        _ => {}
    }
}

// ────────────────────────────── 终端背景 ──────────────────────────────

/// 退出时还原终端默认背景(OSC 111)。
///
/// 我们从不主动设背景(OSC 11),这条只作善后:子进程可能改过窗口底色,
/// 退出时拉回终端默认。不支持 OSC 111 的终端会忽略它。
fn reset_terminal_background(out: &mut Stdout) -> io::Result<()> {
    write!(out, "\x1B]111\x07")?;
    out.flush()
}

// ────────────────────────────── 终端还原 ──────────────────────────────

/// panic 时也要退出 alt screen + raw mode + 还原背景,否则用户被留在坏掉的终端里。
/// 对应 TS `src/index.ts` 里那组 process.on('exit'/'SIGINT'/'uncaughtException') 钩子。
fn install_panic_hook() {
    let original = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let mut out = io::stdout();
        let _ = disable_raw_mode();
        let _ = execute!(
            out,
            LeaveAlternateScreen,
            DisableMouseCapture,
            DisableBracketedPaste
        );
        let _ = reset_terminal_background(&mut out);
        original(info);
    }));
}
