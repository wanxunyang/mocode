//! mocode-tui 的库入口。
//!
//! 拆出 lib 是为了让 `examples/` 与 `tests/` 能直接复用协议层与 IPC 层 ——
//! 一个纯 `[[bin]]` crate 的模块对外部是不可见的,而「Rust 侧能否正确解析
//! agent-host 的真实事件」这件事必须能被自动化测试覆盖(见 `examples/smoke.rs`)。
//!
//! 二进制入口 `src/main.rs` 只负责终端生命周期与主循环。

pub mod app;
pub mod commands;
pub mod diff;
pub mod ipc;
pub mod markdown;
pub mod protocol;
pub mod ui;
pub mod wrap;
