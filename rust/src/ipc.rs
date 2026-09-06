//! agent-host 子进程管理 —— spawn TS `bin/mocode-agent-host.js`,经 stdin/stdout 说 NDJSON。
//!
//! 设计要点(针对 TS 侧的已知痛点):
//!  1. **读写都走独立线程**。TS 侧 spinner 冻屏的根因是事件循环被阻塞;这里 stdout 解析、
//!     stderr 收集、stdin 写入各占一个 OS 线程,主线程只做"渲染 + 非阻塞收事件",
//!     任何一端慢都不会拖住 UI(单帧最坏延迟 = 一次 try_recv,不阻塞)。
//!  2. **进程树杀**。TS 侧 `shutdownRuntimeSync` 注释指出 Windows 无 job object,
//!     子进程拉起的后台进程(如 dev_server)不随父进程退出 —— 退出时必须 taskkill /T。
//!  3. **宽松解析**。stdout 里混入非 JSON 行(第三方库的裸 console.log)不 panic,
//!     转成 `Malformed` 交给 UI 决定是否展示,而不是让整个 TUI 崩掉。

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;

use crate::protocol::{HostCommand, HostEnvelope, HostEvent};

/// 从 IPC 线程汇入主线程的消息。
#[derive(Debug)]
pub enum IpcMessage {
    /// 成功解析的协议事件。
    Event {
        event: HostEvent,
        request_id: Option<String>,
    },
    /// TS 侧 `error()` 发出的信封(如 "An agent run is already active")。
    Error {
        message: String,
        request_id: Option<String>,
    },
    /// agent-host 写往 stderr 的诊断输出(stdout 只走协议,诊断不污染协议流)。
    Diagnostics(String),
    /// stdout 上出现的非 JSON 行 —— 第三方库裸打印,或 JSON 解析失败。
    Malformed(String),
    /// 子进程 stdout 已 EOF(通常意味着进程退出)。
    StdoutClosed,
}

/// agent-host 子进程句柄。
pub struct AgentHost {
    child: Option<Child>,
    /// stdout 线程 → 主线程的汇聚通道(stderr 线程也复用它)。
    rx: Receiver<IpcMessage>,
    /// 主线程 → stdin 线程。写命令不阻塞主线程(长 prompt 也不会卡 UI)。
    tx_cmd: Sender<String>,
    next_id: AtomicU64,
    pid: u32,
}

impl AgentHost {
    /// 启动 agent-host。
    ///
    /// `host_script` 为 `bin/mocode-agent-host.js` 的绝对路径;
    /// `workdir` 作为子进程 cwd(TS 的 sandbox root 取 `process.cwd()`,故必须传对项目根)。
    pub fn spawn(host_script: &Path, workdir: &Path) -> Result<Self> {
        anyhow::ensure!(
            host_script.exists(),
            "找不到 agent-host 脚本: {}\n请先执行 `npm run build` 产出 dist/",
            host_script.display()
        );

        let mut command = Command::new("node");
        command
            .arg(host_script)
            .current_dir(workdir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Unix:放进独立进程组,退出时可整组 kill(避免孙进程泄漏)。
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        // Windows:隐藏控制台窗口,避免 spawn 时闪一下黑框。
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .with_context(|| format!("spawn agent-host 失败: node {}", host_script.display()))?;

        let pid = child.id();
        let stdout = child.stdout.take().context("agent-host stdout 未 piped")?;
        let stderr = child.stderr.take().context("agent-host stderr 未 piped")?;
        let mut stdin = child.stdin.take().context("agent-host stdin 未 piped")?;

        let (tx, rx) = mpsc::channel::<IpcMessage>();
        let (tx_cmd, rx_cmd) = mpsc::channel::<String>();

        spawn_stdout_reader(stdout, tx.clone());
        spawn_stderr_reader(stderr, tx.clone());

        // stdin 写线程:收到一串 NDJSON 就写。通道关闭(主线程退出)时线程自然结束。
        std::thread::Builder::new()
            .name("agent-stdin".into())
            .spawn(move || {
                for line in rx_cmd {
                    if stdin.write_all(line.as_bytes()).is_err() {
                        break; // 子进程已死,静默退出线程
                    }
                    if stdin.flush().is_err() {
                        break;
                    }
                }
            })
            .context("spawn stdin 线程失败")?;

        Ok(Self {
            child: Some(child),
            rx,
            tx_cmd,
            next_id: AtomicU64::new(1),
            pid,
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// 测试/预览专用:**不 spawn 任何进程**的空壳句柄。
    ///
    /// `App` 的批处理 / 渲染逻辑是纯状态机,不该为了测它而拉起 node。
    /// 通道立即断开 → `try_recv()` 恒返回 None,`send()` 恒失败(测试不依赖它们)。
    pub fn hollow() -> Self {
        let (tx, rx) = mpsc::channel::<IpcMessage>();
        drop(tx); // 断开接收端:try_recv 立刻返回 None
        let (tx_cmd, rx_cmd) = mpsc::channel::<String>();
        drop(rx_cmd); // 断开发送端:send 立刻报错(测试中不该走到)
        Self {
            child: None,
            rx,
            tx_cmd,
            next_id: AtomicU64::new(1),
            pid: 0,
        }
    }

    /// 发送一条命令,自动分配唯一 id。
    pub fn send(&self, cmd: HostCommand) -> Result<()> {
        let line = cmd.to_ndjson();
        self.send_raw(line)
    }

    /// 发送已序列化的单行 NDJSON。
    pub fn send_raw(&self, line: String) -> Result<()> {
        self.tx_cmd
            .send(line)
            .context("stdin 写线程已退出(子进程可能已终止)")
    }

    /// 生成下一个命令 id。TS 侧 `parseCommand` 要求 id 为字符串,内容任意。
    pub fn next_id(&self) -> String {
        format!("tui-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }

    /// 非阻塞取一条消息 —— 渲染循环每帧调用,绝不阻塞 UI。
    pub fn try_recv(&self) -> Option<IpcMessage> {
        self.rx.try_recv().ok()
    }

    /// 带超时取一条消息。用于"等待 runtime_ready"这类启动握手。
    pub fn recv_timeout(&self, timeout: Duration) -> Option<IpcMessage> {
        self.rx.recv_timeout(timeout).ok()
    }

    /// 终止子进程树。幂等。
    pub fn kill(&mut self) {
        if let Some(mut child) = self.child.take() {
            kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for AgentHost {
    fn drop(&mut self) {
        // 兜底:TUI 任何退出路径(正常 / panic unwind)都不留孤儿 agent-host。
        self.kill();
    }
}

// ────────────────────────────── 读取线程 ─────────────────────────────

fn spawn_stdout_reader(stdout: ChildStdout, tx: Sender<IpcMessage>) {
    std::thread::Builder::new()
        .name("agent-stdout".into())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        let _ = tx.send(IpcMessage::StdoutClosed);
                        break;
                    }
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let msg = match serde_json::from_str::<HostEnvelope>(trimmed) {
                            Ok(env) => match HostEvent::parse(&env) {
                                Some(event) => IpcMessage::Event {
                                    event,
                                    request_id: env.request_id,
                                },
                                // 是 event 信封但 event 名缺失 → 仍按 error 通道处理
                                None => IpcMessage::Error {
                                    message: env.error.unwrap_or_else(|| "空事件".to_string()),
                                    request_id: env.request_id,
                                },
                            },
                            // 可能是 error 信封(TS 的 error() 也走同一 stdout),再试一次裸 Value
                            Err(_) => match serde_json::from_str::<Value>(trimmed) {
                                Ok(v) if v.get("type").and_then(Value::as_str) == Some("error") => {
                                    IpcMessage::Error {
                                        message: v
                                            .get("error")
                                            .and_then(Value::as_str)
                                            .unwrap_or_default()
                                            .to_string(),
                                        request_id: v
                                            .get("requestId")
                                            .and_then(Value::as_str)
                                            .map(str::to_string),
                                    }
                                }
                                _ => IpcMessage::Malformed(trimmed.to_string()),
                            },
                        };
                        if tx.send(msg).is_err() {
                            break; // 主线程已退出
                        }
                    }
                    Err(_) => break,
                }
            }
        })
        .expect("spawn stdout 读线程失败");
}

fn spawn_stderr_reader(stderr: ChildStderr, tx: Sender<IpcMessage>) {
    std::thread::Builder::new()
        .name("agent-stderr".into())
        .spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let trimmed = line.trim_end().to_string();
                        if !trimmed.is_empty() && tx.send(IpcMessage::Diagnostics(trimmed)).is_err()
                        {
                            break;
                        }
                    }
                }
            }
        })
        .expect("spawn stderr 读线程失败");
}

// ────────────────────────────── 进程树杀 ─────────────────────────────

/// 整树终止。Windows 无 job object,孙进程(dev_server 等)不会随父进程退出,
/// 必须显式 /T;Unix 走进程组 killpg(正数 pgid,与 process_group(0) 配套)。
pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        // pgid == pid(spawn 时 process_group(0) 让子进程自成一组),整组 SIGKILL。
        const SIGKILL: i32 = 9;
        unsafe {
            extern "C" {
                fn killpg(pgrp: i32, sig: i32) -> i32;
            }
            killpg(pid as i32, SIGKILL);
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
    }
}

// ────────────────────────────── 路径定位 ─────────────────────────────

/// 定位 `bin/mocode-agent-host.js`。
///
/// 优先级:环境变量 `MOCODE_HOST`(显式覆盖)> 可执行文件位置反推项目根 > cwd 反推。
/// 反推逻辑:`<root>/rust/target/<profile>/mocode-tui(.exe)` → 上溯 4 层 = 项目根。
pub fn locate_host_script() -> Result<PathBuf> {
    if let Ok(explicit) = std::env::var("MOCODE_HOST") {
        let p = PathBuf::from(explicit);
        anyhow::ensure!(p.exists(), "MOCODE_HOST 指向的文件不存在: {}", p.display());
        return Ok(p);
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        // exe → target/<profile> → target → rust → <root>
        let mut dir = exe.parent().map(Path::to_path_buf);
        for _ in 0..4 {
            if let Some(d) = dir.take() {
                dir = d.parent().map(Path::to_path_buf);
            }
        }
        if let Some(root) = dir {
            candidates.push(root.join("bin").join("mocode-agent-host.js"));
        }
    }
    // 兜底:直接以 cwd 为项目根(mocode 通常在项目根启动)
    candidates.push(PathBuf::from("bin/mocode-agent-host.js"));

    candidates
        .into_iter()
        .find(|p| p.exists())
        .context("定位 agent-host 失败:请设置 MOCODE_HOST=<path>/bin/mocode-agent-host.js")
        // 绝对路径化:调用方要从脚本位置反推项目根(sandbox root),相对路径会算错。
        .and_then(|p| p.canonicalize().context("canonicalize agent-host 路径失败"))
        .map(strip_verbatim_prefix)
}

/// 剥掉 Windows `canonicalize()` 加上的 `\\?\` verbatim 前缀。
///
/// **这是真 bug,不是洁癖**:`std::fs::canonicalize` 在 Windows 上返回
/// `\\?\F:\mocode\bin\...` 这种 verbatim 路径,而 node 的 fs 无法处理它 ——
/// 把这种路径交给 `node xxx.js`,node 会在 `binding.lstat` 处直接抛异常退出。
/// 冒烟测试 `examples/smoke.rs` 第一次跑就撞上了这个。
///
/// 非 Windows 上原样返回。
pub fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => {
            // `\\?\UNC\server\share` 要还原成 `\\server\share`,不能简单去掉前缀。
            match rest.strip_prefix("UNC\\") {
                Some(unc) => PathBuf::from(format!(r"\\{unc}")),
                None => PathBuf::from(rest),
            }
        }
        None => p,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_prefix_is_stripped() {
        // Windows 的典型形态:canonicalize 返回 `\\?\F:\...`
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\F:\mocode\bin\mocode-agent-host.js")),
            PathBuf::from(r"F:\mocode\bin\mocode-agent-host.js")
        );
    }

    #[test]
    fn verbatim_unc_is_restored() {
        // `\\?\UNC\host\share\x` 必须还原成 `\\host\share\x`,否则网络路径会失效。
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\host\share\x.js")),
            PathBuf::from(r"\\host\share\x.js")
        );
    }

    #[test]
    fn plain_path_is_untouched() {
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"F:\mocode\bin\x.js")),
            PathBuf::from(r"F:\mocode\bin\x.js")
        );
    }
}
