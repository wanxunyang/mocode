//! 零成本冒烟测试:验证 Rust 侧能定位、spawn 并**正确解析** TS agent-host 的真实事件。
//!
//! 只等 `runtime_ready`,**不发 `run` 命令** —— 不消耗 LLM token、不需要 API key。
//! 这一步能挡住三类问题:路径定位错、spawn 参数错、协议字段名漂移。
//!
//! ```bash
//! cargo run --example smoke
//! ```
//!
//! 真要验证「跑起来连不连得上」,再手动跑 TUI:
//! ```bash
//! cargo run --release    # 须在项目根目录启动
//! ```

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::bail;
use mocode_tui::ipc::{self, IpcMessage};
use mocode_tui::protocol::{HostCommand, HostEvent, Usage};

/// agent-host 启动慢在 MCP 初始化(实测 ~5s),给足 40s 上限。
const READY_TIMEOUT: Duration = Duration::from_secs(40);

fn main() -> anyhow::Result<()> {
    // `--full` 会真跑一轮对话(消耗少量 token),默认只做零成本握手验证。
    let full = std::env::args().skip(1).any(|a| a == "--full");

    // 不依赖 cwd:CARGO_MANIFEST_DIR 恒为 <项目根>/rust,取其父目录即项目根。
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("rust/ 必须有父目录")
        .to_path_buf();

    let script = ipc::locate_host_script()?;
    println!("host script : {}", script.display());
    println!("workdir     : {}", root.display());

    let t0 = Instant::now();
    let host = ipc::AgentHost::spawn(&script, &root)?;
    println!("spawned     : pid={}", host.pid());

    // 收到的事件分两类统计,便于一眼看出协议是否漂移。
    let mut ready: Option<HostEvent> = None;
    let mut diagnostics = 0usize;
    let mut malformed = 0usize;

    while ready.is_none() {
        if t0.elapsed() > READY_TIMEOUT {
            bail!(
                "{}s 内未收到 runtime_ready(诊断 {} 条,畸形行 {malformed} 条)",
                READY_TIMEOUT.as_secs(),
                diagnostics
            );
        }
        match host.recv_timeout(Duration::from_millis(500)) {
            Some(IpcMessage::Event { event, .. }) => {
                if matches!(event, HostEvent::RuntimeReady { .. }) {
                    ready = Some(event);
                } else {
                    println!("[event] {event:?}");
                }
            }
            Some(IpcMessage::Error { message, .. }) => bail!("agent-host 报错: {message}"),
            Some(IpcMessage::Diagnostics(line)) => {
                diagnostics += 1;
                if diagnostics <= 3 {
                    println!("[diag] {}", line.trim());
                }
            }
            Some(IpcMessage::Malformed(line)) => {
                malformed += 1;
                println!("[malformed] {}", line.trim());
            }
            Some(IpcMessage::StdoutClosed) => bail!("agent-host stdout 已关闭(进程提前退出)"),
            None => {}
        }
    }

    let HostEvent::RuntimeReady {
        project_root,
        provider,
        prompt_cache,
        warnings,
    } = ready.expect("上面循环保证有值")
    else {
        unreachable!("已用 matches! 过滤")
    };

    println!(
        "\n[runtime_ready] 收到于 +{:.1}s",
        t0.elapsed().as_secs_f32()
    );
    println!("  project_root : {project_root}");
    println!("  provider     : {provider}");
    println!("  prompt_cache : {prompt_cache}");
    println!("  warnings     : {warnings:?}");

    // projectRoot 必须等于我们传入的 workdir —— 这是 sandbox root 的来源,
    // 对不上说明子进程 cwd 传错了,后面所有文件操作都会越界。
    if project_root != root.to_string_lossy() {
        bail!(
            "projectRoot 与 workdir 不一致:\n  agent-host: {project_root}\n  期望:      {}",
            root.display()
        );
    }
    if malformed > 0 {
        bail!("stdout 出现 {malformed} 条非 JSON 行,协议解析有漏洞");
    }

    println!("\nOK — 协议对接正常(runtime_ready 握手通过)。");

    if full {
        run_one_turn(&host)?;
    } else {
        println!("(加 --full 可再跑一轮真实对话,验证命令下发与流式事件)");
    }

    println!("\n完成。子进程由 AgentHost::drop 自动回收。");
    Ok(())
}

/// 跑一轮真实对话,验证「命令下发 → 流式事件 → 完成事件」整条链路。
///
/// 与握手测试不同,这一步会真的调用 LLM(几百 token,成本可忽略),
/// 但它能覆盖握手测不到的三件事:
///   1. `HostCommand::Run` 的序列化是否被 TS `parseCommand` 接受(字段契约)
///   2. `text_delta` 流式增量能否被正确累积
///   3. `run_finished` / `run_completed` 的 usage 解析是否正确
fn run_one_turn(host: &ipc::AgentHost) -> anyhow::Result<()> {
    println!("\n=== 端到端:跑一轮真实对话 ===");

    // 明确禁止工具调用:既省 token,也避免撞上权限审批把流程卡住。
    let prompt = "请只回复两个字:OK。不要调用任何工具,不要解释。";
    println!("prompt : {prompt}");

    host.send(HostCommand::Run {
        id: host.next_id(),
        prompt: prompt.to_string(),
        session_id: None,
        attachments: None,
    })?;

    let mut counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut text = String::new();
    let mut finished: Option<(u64, Option<Usage>)> = None;
    let mut done = false;
    let deadline = Instant::now() + Duration::from_secs(150);

    while !done {
        if Instant::now() > deadline {
            bail!(
                "150s 内未收到 run_completed(已收到正文 {} 字)",
                text.chars().count()
            );
        }
        let Some(msg) = host.recv_timeout(Duration::from_millis(500)) else {
            continue;
        };
        match msg {
            IpcMessage::Event { event, .. } => match event {
                HostEvent::RunStarted {
                    session_id,
                    resumed,
                    provider,
                    ..
                } => {
                    *counts.entry("run_started").or_default() += 1;
                    println!("  [run_started] session={session_id} resumed={resumed} provider={provider}");
                }
                HostEvent::Status { value, .. } => {
                    *counts.entry("status").or_default() += 1;
                    println!("  [status] {value}");
                }
                HostEvent::TextDelta { text: delta } => {
                    *counts.entry("text_delta").or_default() += 1;
                    text.push_str(&delta);
                }
                HostEvent::ToolStarted { name, .. } => {
                    *counts.entry("tool_started").or_default() += 1;
                    println!("  [tool] {name} 开始");
                }
                HostEvent::ToolCompleted { name, .. } => {
                    *counts.entry("tool_completed").or_default() += 1;
                    println!("  [tool] {name} 完成");
                }
                HostEvent::RunFinished { elapsed_ms, usage } => {
                    *counts.entry("run_finished").or_default() += 1;
                    finished = Some((elapsed_ms, usage));
                }
                HostEvent::RunCompleted {
                    session_id,
                    completed,
                    termination_reason,
                    changed_files,
                    usage_percent,
                    context_window,
                    ..
                } => {
                    *counts.entry("run_completed").or_default() += 1;
                    done = true;
                    println!("\n  session      : {session_id}");
                    println!("  completed    : {completed}");
                    println!("  termination  : {termination_reason}");
                    println!("  changed_files: {changed_files:?}");
                    println!("  context      : {usage_percent}% of {context_window}");
                }
                HostEvent::RunFailed { message } => bail!("run_failed: {message}"),
                // 权限审批:本 prompt 不该触发,真触发就取消掉,避免流程悬挂。
                HostEvent::ApprovalRequested {
                    approval_id, title, ..
                } => {
                    println!("  [approval] {title} → 自动取消");
                    host.send(HostCommand::Approval {
                        id: host.next_id(),
                        approval_id,
                        action: mocode_tui::protocol::ApprovalAction::Cancelled,
                        value: None,
                    })?;
                }
                HostEvent::Unknown { name, payload } => {
                    *counts.entry("unknown").or_default() += 1;
                    println!("  [unknown] {name}: {payload}");
                }
                other => {
                    *counts.entry("other").or_default() += 1;
                    println!("  [event] {other:?}");
                }
            },
            IpcMessage::Error { message, .. } => bail!("agent-host 报错: {message}"),
            IpcMessage::Diagnostics(line) => println!("  [diag] {}", line.trim()),
            IpcMessage::Malformed(line) => println!("  [malformed] {}", line.trim()),
            IpcMessage::StdoutClosed => bail!("agent-host 提前退出"),
        }
    }

    println!("\n  正文({} 字): {}", text.chars().count(), text.trim());
    print!("  事件统计:");
    for (k, v) in &counts {
        print!(" {k}={v}");
    }
    println!();

    if let Some((elapsed_ms, usage)) = finished {
        println!("  耗时        : {elapsed_ms}ms");
        if let Some(u) = usage {
            println!(
                "  tokens      : prompt={} completion={} total={}",
                u.prompt_tokens, u.completion_tokens, u.total_tokens
            );
        }
    }

    // 判据:至少要有流式正文,否则说明 text_delta 解析有问题。
    if text.trim().is_empty() {
        bail!("收到了 run_completed,但正文为空 —— text_delta 解析有问题");
    }
    println!("\nOK — 端到端链路正常。");
    Ok(())
}
