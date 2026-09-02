//! JSON-over-stdio 协议定义 —— 与 TS 侧 `src/host/protocol.ts` 一一对应。
//!
//! 这是路径 A 的核心契约:Rust TUI 只实现协议的另一端,TS 侧 `src/host/stdio.ts`
//! 完全不需要改动。任何字段新增/改名都必须在两侧同步,故本文件是本项目的"单一事实源"之一。
//!
//! 对应 TS 源文件:
//!   - `src/host/protocol.ts`  —— 命令解析 + 信封结构
//!   - `src/host/stdio.ts`     —— 事件产出(emit 调用点)

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ────────────────────────────── 出向命令(TUI → agent-host)──────────────────────────────

/// 多模态附件(图片)。对应 TS `HostAttachment`。
#[derive(Debug, Clone, Serialize)]
pub struct HostAttachment {
    pub name: String,
    #[serde(rename = "dataUrl")]
    pub data_url: String,
}

/// 审批动作。对应 TS `'selected' | 'cancelled'`。
#[derive(Debug, Clone, Copy, Serialize)]
pub enum ApprovalAction {
    #[serde(rename = "selected")]
    Selected,
    #[serde(rename = "cancelled")]
    Cancelled,
}

/// TUI → agent-host 的命令。内部标签 `type`,与 TS `HostCommand` 联合类型同形。
///
/// 注意 TS 侧 `parseCommand` 要求 `id` 必须是字符串、`type` 必须是已知字面量,
/// 否则整条命令被丢弃并回 `Invalid Mocode Work host command.`。故这里不要省略 id。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum HostCommand {
    /// 发起一轮 agent 对话。
    #[serde(rename = "run")]
    Run {
        id: String,
        prompt: String,
        #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attachments: Option<Vec<HostAttachment>>,
    },
    /// 取消当前运行(对应 Ctrl+C 的软取消:agent 会在步边界还原 history)。
    #[serde(rename = "cancel")]
    Cancel { id: String },
    /// 手动压缩上下文。
    #[serde(rename = "compact")]
    Compact {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        focus: Option<String>,
    },
    /// 回复 `approval_requested`(权限确认 / 用户选择)。
    #[serde(rename = "approval")]
    Approval {
        id: String,
        #[serde(rename = "approvalId")]
        approval_id: String,
        action: ApprovalAction,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<String>,
    },
}

impl HostCommand {
    /// 序列化为单行 NDJSON(末尾带 `\n`)。
    ///
    /// TS 侧用 `readline` 按行读取,故一条命令必须恰好占一行 —— serde_json 默认
    /// 不会转义换行以外的字符,但为防 LLM 粘贴内容里有裸换行,这里丢弃格式化直接紧凑输出。
    pub fn to_ndjson(&self) -> String {
        // serde_json::to_string 对 String 内的 \n 会转义成 \\n,保证不跨行,安全。
        let mut s = serde_json::to_string(self).expect("HostCommand 序列化不应失败");
        s.push('\n');
        s
    }
}

// ────────────────────────────── 入向信封(agent-host → TUI)──────────────────────────────

/// 信封类型标签。对应 TS `HostEnvelope['type']`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvelopeKind {
    Event,
    Error,
}

/// 原始信封。对应 TS `HostEnvelope`。
///
/// payload 保持 `Value`:协议演进时未知字段不会让解析失败,
/// 由 `HostEvent::parse` 按需取字段,缺字段走默认值而非报错。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEnvelope {
    /// TS 字段名为 `type`,Rust 中是关键字,故改名 `kind` 并显式 rename。
    #[serde(rename = "type")]
    pub kind: EnvelopeKind,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub event: Option<String>,
    #[serde(default)]
    pub payload: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
}

/// 一次 chat 的真实 token 用量。对应 TS `ChatUsage`(src/llm/index.ts:248)。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub cached_tokens: u64,
    pub cache_creation_tokens: Option<u64>,
    pub reasoning_tokens: u64,
}

/// 解析后的事件。未识别的事件保留为 `Unknown`,便于协议演进时前端不崩。
#[derive(Debug, Clone)]
pub enum HostEvent {
    RuntimeReady {
        project_root: String,
        provider: String,
        prompt_cache: bool,
        warnings: Vec<String>,
    },
    RunStarted {
        session_id: String,
        project_root: String,
        resumed: bool,
        provider: String,
        attachments: Vec<String>,
    },
    /// 状态迁移。value: 'thinking' | 'preparing_tool' | 'running_tool' | 'compacting'
    Status {
        value: String,
        tool: Option<String>,
    },
    /// 流式正文增量 —— 高频事件,渲染侧必须廉价处理。
    TextDelta {
        text: String,
    },
    ToolStarted {
        id: String,
        name: String,
        /// 原始 JSON 字符串(TS `ToolCallRef.arguments`),渲染时按工具名做摘要。
        arguments: String,
    },
    ToolCompleted {
        id: String,
        name: String,
        output: String,
    },
    RunFinished {
        elapsed_ms: u64,
        usage: Option<Usage>,
    },
    RunCompleted {
        session_id: String,
        completed: bool,
        termination_reason: String,
        changed_files: Vec<String>,
        usage: Option<Usage>,
        usage_percent: u32,
        context_window: u64,
    },
    RunFailed {
        message: String,
    },
    RunAborted,
    Cancelling,
    /// `cancel` 到达但无活跃运行时由 TS 回的事件(非错误)。
    RunIdle,
    CompactDone {
        compacted: bool,
        before_tokens: Option<u64>,
        after_tokens: Option<u64>,
        usage_percent: u32,
        context_window: u64,
    },
    ApprovalRequested {
        approval_id: String,
        title: String,
        detail: String,
        options: Vec<String>,
    },
    /// 协议新增了本文件尚未建模的事件。保留原始内容,避免静默吞掉。
    Unknown {
        name: String,
        payload: Value,
    },
}

impl HostEvent {
    /// 从信封解析。返回 `None` 表示这是 error 信封或缺少 event 名。
    pub fn parse(env: &HostEnvelope) -> Option<Self> {
        let name = env.event.as_deref()?;
        let p = env.payload.clone().unwrap_or(Value::Null);
        Some(match name {
            "runtime_ready" => Self::RuntimeReady {
                project_root: str_at(&p, "projectRoot"),
                provider: str_at(&p, "provider"),
                prompt_cache: bool_at(&p, "promptCache"),
                warnings: str_vec_at(&p, "warnings"),
            },
            "run_started" => Self::RunStarted {
                session_id: str_at(&p, "sessionId"),
                project_root: str_at(&p, "projectRoot"),
                resumed: bool_at(&p, "resumed"),
                provider: str_at(&p, "provider"),
                attachments: str_vec_at(&p, "attachments"),
            },
            "status" => Self::Status {
                value: str_at(&p, "value"),
                tool: p.get("tool").and_then(Value::as_str).map(str::to_string),
            },
            "text_delta" => Self::TextDelta {
                text: str_at(&p, "text"),
            },
            "tool_started" => Self::ToolStarted {
                id: str_at(&p, "id"),
                name: str_at(&p, "name"),
                arguments: str_at(&p, "arguments"),
            },
            "tool_completed" => Self::ToolCompleted {
                id: str_at(&p, "id"),
                name: str_at(&p, "name"),
                output: str_at(&p, "output"),
            },
            "run_finished" => Self::RunFinished {
                elapsed_ms: num_at(&p, "elapsedMs"),
                usage: usage_at(&p),
            },
            "run_completed" => Self::RunCompleted {
                session_id: str_at(&p, "sessionId"),
                completed: bool_at(&p, "completed"),
                termination_reason: str_at(&p, "terminationReason"),
                changed_files: str_vec_at(&p, "changedFiles"),
                usage: usage_at(&p),
                usage_percent: num_at(&p, "usagePercent") as u32,
                context_window: num_at(&p, "contextWindow"),
            },
            "run_failed" => Self::RunFailed {
                message: str_at(&p, "message"),
            },
            "run_aborted" => Self::RunAborted,
            "cancelling" => Self::Cancelling,
            "run_idle" => Self::RunIdle,
            "compact_done" => Self::CompactDone {
                compacted: bool_at(&p, "compacted"),
                before_tokens: p.get("beforeTokens").and_then(Value::as_u64),
                after_tokens: p.get("afterTokens").and_then(Value::as_u64),
                usage_percent: num_at(&p, "usagePercent") as u32,
                context_window: num_at(&p, "contextWindow"),
            },
            "approval_requested" => Self::ApprovalRequested {
                approval_id: str_at(&p, "approvalId"),
                title: str_at(&p, "title"),
                detail: str_at(&p, "detail"),
                options: str_vec_at(&p, "options"),
            },
            other => Self::Unknown {
                name: other.to_string(),
                payload: p,
            },
        })
    }
}

// ────────────────────────────── 宽松取值 helper ─────────────────────────────
// 协议字段缺失/类型漂移时返回默认值而非 panic —— TUI 绝不能因为一个字段就白屏。

fn str_at(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn bool_at(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn num_at(v: &Value, key: &str) -> u64 {
    v.get(key)
        .and_then(Value::as_u64)
        .or_else(|| v.get(key).and_then(Value::as_f64).map(|f| f as u64))
        .unwrap_or(0)
}

fn str_vec_at(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn usage_at(v: &Value) -> Option<Usage> {
    // usage 可能是 null(后端未开 include_usage)或整个键缺失,两者都视作 None。
    match v.get("usage") {
        Some(Value::Null) | None => None,
        Some(raw) => serde_json::from_value(raw.clone()).ok(),
    }
}
