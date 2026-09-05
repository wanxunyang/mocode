//! 应用状态机 —— 消费 IPC 事件,维护内容区条目、输入、状态栏与滚动。
//!
//! 与 TS 侧的映射关系:
//!   - `entries`        ≈ TS `content.ts` 的行缓冲(这里是"逻辑条目",折行在 `wrap.rs`)
//!   - `Entry::ToolBatch`≈ TS `src/ui/batch.ts` 的 batch(一个 LLM 步的 N 个 tool_calls 聚合成一条摘要行)
//!   - `RunStatus`      ≈ TS `StatusBarData['status']`
//!   - `submit()`       ≈ TS repl 里组装 `HostCommand{type:'run'}` 的那段
//!
//! ## 内容区的排版契约(与 TS 逐条对齐)
//! 每个条目渲染完自带分隔空行,避免出现 TS 侧早期"工具调用黏成一坨"的观感:
//! ```text
//! ❯ 用户消息                       <- 满宽底色气泡
//!                                  <- 空行
//! 助手正文……
//!                                  <- 空行
//!   ● 探索  3  1.2s   read_file 1  glob 1  grep 1     <- 批摘要行(点击展开)
//!     ├─ read_file  src/a.ts  ↳ 42 行
//!     └─ glob  *.rs  ↳ 3 个文件
//!                                  <- 空行
//!   ● 文件变更  1 个文件
//!     · src/a.ts
//!                                  <- 空行
//!   ● 完成  3.2s
//!                                  <- 轮次之间空行
//! ```

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::time::Instant;

use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::commands::SlashMenu;
use crate::ipc::{AgentHost, IpcMessage};
use crate::protocol::{ApprovalAction, HostAttachment, HostCommand, HostEvent, Usage};
use crate::ui::theme;
use crate::wrap::Row;

/// 从项目根 `.env` 读几个展示用配置项(模型名、记忆开关)。
/// 与 TS 侧 config 单例不同,这里只读用于 UI 展示,不参与业务。
#[derive(Debug, Clone)]
pub struct UiConfig {
    pub model: String,
    pub memory_enabled: bool,
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            model: String::new(),
            memory_enabled: false,
        }
    }
}

impl UiConfig {
    /// 读取 `<project_root>/.env` 里的 `LLM_MODEL` / `MEMORY_ENABLED`。
    /// 读不到或解析失败均回退默认值,绝不因配置问题影响启动。
    pub fn load(project_root: &str) -> Self {
        let path = PathBuf::from(project_root).join(".env");
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => return Self::default(),
        };

        let mut model = String::new();
        let mut memory_enabled = false;
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                let k = k.trim();
                let v = v.trim();
                match k {
                    "LLM_MODEL" => model = v.to_string(),
                    "MEMORY_ENABLED" => memory_enabled = v.eq_ignore_ascii_case("true"),
                    _ => {}
                }
            }
        }
        Self {
            model,
            memory_enabled,
        }
    }
}

// ────────────────────────────── 内容条目模型 ──────────────────────────────

/// 内容区的一条逻辑条目。折行在渲染阶段(`wrap.rs`),这里只存语义。
pub enum Entry {
    /// 用户输入(渲染成满宽底色气泡)。
    User { text: String },
    /// 助手正文 —— `TextDelta` 事件持续追加。
    Assistant { text: String },
    /// 一批工具调用。对齐 TS `src/ui/batch.ts`:一个 LLM 步里的 N 个 tool_calls
    /// 合成一条摘要行,点击再逐条展开 —— 而不是每个调用各占一行刷屏。
    ToolBatch(ToolBatch),
    /// 轮末文件变更概览(对齐 TS `src/agent/index.ts:writeChangeOverview`)。
    ChangeOverview { files: Vec<String> },
    /// 系统提示行(压缩结果、取消、轮末完成行等)。
    System { text: String, tone: Tone },
    /// 显式空行 —— 条目之间 / 轮次之间的分隔,TS 靠 `contentWrite('\n')` 达到同样效果。
    Blank,
}

/// 一条工具调用在批内的展示数据。对齐 TS `ui/batch.ts` 的 `BatchEntry`。
pub struct ToolItem {
    /// tool_call id —— 结果回填时按 id 归位(并行执行时顺序会漂移)。
    pub id: String,
    pub name: String,
    /// `summarize_tool_call` 的单行参数摘要(路径 / 模式 / 命令)。
    pub summary: String,
    /// `summarize_tool_result` 的单行结果预览。
    pub result_summary: String,
    /// 工具完整原始输出(纯文本),第二层展开时显示。
    pub output: Option<String>,
    pub failed: bool,
    /// 结果已回填。不能只看 `result_summary` 非空 —— 部分工具的预览本就是空串。
    pub done: bool,
    /// `tool_started` 带来的原始 JSON 参数串。
    ///
    /// 必须留着:`edit_file` / `write_file` 的 diff 要用 `old_string` / `new_string` /
    /// `content` 现算,而 `tool_completed` 事件里只有 output,没有参数
    /// (TS 侧是在 agent 进程内同时持有两者的,Rust 侧只能自己缓存)。
    pub arguments: String,
    /// mutation 工具渲染好的 diff 块;非 mutation 或渲染失败为 None。
    /// 对齐 TS `ui/batch.ts:BatchEntry.diffBlock`。
    pub diff_block: Option<Vec<Line<'static>>>,
}

/// 一个 LLM 步的工具调用批。对齐 TS `ui/batch.ts` 的 `BatchRecord`。
///
/// 聚合规则与 TS `src/agent/index.ts:writeToolHeader` 一致:
///   - 普通工具持续并入当前开放批,共用一个摘要行;
///   - mutation(`write_file` / `edit_file`)独占一批,结果一回来立即收口并展开完整输出;
///   - 出现正文(`text_delta`)或轮次收尾时把开放批收口。
pub struct ToolBatch {
    pub items: Vec<ToolItem>,
    /// 第一层(逐条调用明细)是否展开。
    pub expanded: bool,
    /// 第二层已展开完整输出的 item 下标。
    pub detail_expanded: Vec<usize>,
    /// mutation 独占批:收尾时自动展开唯一那条(TS `expandSingleEntryFully`)。
    pub standalone: bool,
    pub started_at: Instant,
    /// 全部 item 拿到结果的时刻(相对 `started_at` 的毫秒);未完成 = None。
    pub finished_ms: Option<u64>,
}

impl ToolBatch {
    pub fn new(standalone: bool) -> Self {
        Self {
            items: Vec::new(),
            expanded: false,
            detail_expanded: Vec::new(),
            standalone,
            started_at: Instant::now(),
            finished_ms: None,
        }
    }

    pub fn is_finished(&self) -> bool {
        !self.items.is_empty() && self.items.iter().all(|i| i.done)
    }

    pub fn finished_count(&self) -> usize {
        self.items.iter().filter(|i| i.done).count()
    }

    pub fn failed_count(&self) -> usize {
        self.items.iter().filter(|i| i.failed).count()
    }

    /// 摘要行的状态配色分档(与 TS `buildSummaryLine` 同判定)。
    pub fn tone(&self) -> theme::BatchTone {
        if !self.is_finished() {
            return theme::BatchTone::Running;
        }
        let failed = self.failed_count();
        if failed == self.items.len() {
            theme::BatchTone::Failed
        } else if failed > 0 {
            theme::BatchTone::Partial
        } else {
            theme::BatchTone::Done
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Info,
    Warn,
    Error,
    Success,
    Dim,
    /// 轮末完成行:TS 用 `● 完成  3.2s`,是强调色的标记行而非普通提示。
    Accent,
}

impl Tone {
    fn color(&self) -> ratatui::style::Color {
        match self {
            Self::Info => theme::INFO,
            Self::Warn => theme::WARN,
            Self::Error => theme::ERROR,
            Self::Success => theme::SUCCESS,
            Self::Dim => theme::DIM,
            Self::Accent => theme::ACCENT,
        }
    }
}

/// 状态机当前阶段。对应 TS `status` 事件的 value 字段。
#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub enum RunStatus {
    #[default]
    Idle,
    Thinking,
    /// 模型正在生成 tool_call 参数;具体工具名在 `App::active_tool`。
    PreparingTool,
    RunningTool,
    Compacting,
}

impl RunStatus {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Idle => "空闲",
            Self::Thinking => "思考中",
            Self::PreparingTool => "准备工具",
            Self::RunningTool => "执行工具",
            Self::Compacting => "压缩上下文",
        }
    }
}

/// 待用户确认的审批请求(权限确认 / 选项选择)。
pub struct PendingApproval {
    pub approval_id: String,
    pub title: String,
    pub detail: String,
    pub options: Vec<String>,
    /// 当前高亮项。
    pub selected: usize,
}

/// 视觉行的语义标签 —— 鼠标点击反查命中用(对齐 TS `ui/batch.ts` 的 absLineTo* 表)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowTag {
    /// 普通文本行:点击无行为。
    Plain,
    /// 工具批摘要行:点击切第一层明细。`usize` = `entries` 下标。
    BatchSummary(usize),
    /// 工具批第 `item` 条明细行:点击切该条的完整输出。
    BatchItem(usize, usize),
}

/// 折行后的内容区快照(带缓存)。
pub struct Content {
    pub lines: Vec<Line<'static>>,
    /// 与 `lines` 一一对应的行标签。
    pub tags: Vec<RowTag>,
}

pub struct App {
    pub host: AgentHost,
    pub entries: Vec<Entry>,
    /// tool_call id → 所属批在 `entries` 的下标。结果回填按 id 归位,
    /// 不能靠"最后一条"——并行执行时顺序会漂移(TS `callToBatch` 同款设计)。
    tool_index: HashMap<String, usize>,
    /// 当前仍在累积(尚未收口)的工具批下标。`text_delta` / 轮次收尾时置 None。
    pending_batch: Option<usize>,

    pub input: String,
    /// 输入光标(按 char 计,非字节)。
    pub cursor: usize,

    /// 斜杠命令菜单状态。
    pub slash_menu: SlashMenu,
    /// 输入历史(↑/↓ 翻阅)。空串也算一条(供回到空输入)。
    input_history: Vec<String>,
    /// 历史浏览指针:None=不在浏览态,Some(i)=当前指向 history[i]。
    history_ptr: Option<usize>,
    /// Ctrl+C 清空前保存的输入快照(供 Ctrl+Z 恢复,单次)。
    undo_snapshot: Option<String>,

    /// 手动滚动偏移(0 = 贴底自动跟随)。
    pub scroll: usize,
    /// 用户是否手动滚离了底部;贴底时新内容自动跟随。
    pub stick_to_bottom: bool,
    /// 上一帧内容区矩形 —— 鼠标点击换算成内容行需要它。由 `ui::draw` 回填。
    pub content_area: Option<Rect>,
    /// 内容视口前置的非交互行数（当前为随内容滚动的 banner）。
    /// 鼠标点击换算到 entries 的 RowTag 时须跳过这些行。
    pub content_prefix_lines: usize,

    pub status: RunStatus,
    /// 当前正在执行的工具名(状态栏显示)。
    pub active_tool: Option<String>,
    pub spinner_tick: usize,

    pub session_id: Option<String>,
    pub project_root: String,
    pub provider: String,
    /// 从 `.env` 读到的模型名;若为空则回退显示 provider。
    pub model_name: String,
    /// 记忆子系统开关,仅用于 banner 展示。
    pub memory_enabled: bool,
    /// 模式标识,对应 TS `StatusBarData.modeTag`(如 "Auto"/"Plan")。
    pub mode_tag: String,
    pub context_window: u64,
    pub usage_percent: u32,
    pub last_usage: Option<Usage>,
    /// 本轮已用秒数(由 run_finished 的 elapsedMs 更新)。
    pub last_elapsed_ms: u64,
    /// 本轮开始时刻,用于状态栏走时。
    pub turn_start: Option<Instant>,

    pub running: bool,
    pub pending_approval: Option<PendingApproval>,
    /// agent-host stderr 诊断(环形缓冲,默认 200 行)。
    pub diagnostics: VecDeque<String>,
    pub show_diagnostics: bool,
    pub should_quit: bool,

    /// /image attach 的待发送图片,下次 submit() 时随 Run 命令一起发出。
    pub pending_images: Vec<HostAttachment>,

    /// 折行结果缓存:`(折行宽度, 内容快照)`.
    ///
    /// 缓存失效条件:宽度变化 或 `content_dirty`。流式输出每个 delta 都会置脏,
    /// 但一帧只重折一次(渲染前统一算),不会每帧重复 O(n) 折行。
    wrap_cache: Option<(usize, Content)>,
    content_dirty: bool,
}

impl App {
    pub fn new(host: AgentHost, project_root: String) -> Self {
        let project_root = crate::ipc::strip_verbatim_prefix(PathBuf::from(project_root))
            .to_string_lossy()
            .to_string();
        let cfg = UiConfig::load(&project_root);
        Self {
            host,
            entries: Vec::new(),
            tool_index: HashMap::new(),
            pending_batch: None,
            input: String::new(),
            cursor: 0,
            slash_menu: SlashMenu::default(),
            input_history: Vec::new(),
            history_ptr: None,
            undo_snapshot: None,
            scroll: 0,
            stick_to_bottom: true,
            content_area: None,
            content_prefix_lines: 0,
            status: RunStatus::Idle,
            active_tool: None,
            spinner_tick: 0,
            session_id: None,
            project_root,
            provider: String::new(),
            model_name: cfg.model,
            memory_enabled: cfg.memory_enabled,
            mode_tag: "Auto".to_string(),
            context_window: 0,
            usage_percent: 0,
            last_usage: None,
            last_elapsed_ms: 0,
            turn_start: None,
            running: false,
            pending_approval: None,
            diagnostics: VecDeque::with_capacity(256),
            show_diagnostics: false,
            should_quit: false,
            pending_images: Vec::new(),
            wrap_cache: None,
            content_dirty: true,
        }
    }

    /// 测试/预览专用:不 spawn agent-host 的空壳 App(验证批处理 / 渲染这类纯状态逻辑)。
    pub fn hollow() -> Self {
        Self::new(AgentHost::hollow(), "F:\\mocode".to_string())
    }

    /// 展示用模型名:`.env` 里配了 `LLM_MODEL` 就显它,否则显 provider。
    pub fn display_model(&self) -> &str {
        if self.model_name.is_empty() {
            &self.provider
        } else {
            &self.model_name
        }
    }

    // ────────────────────────── 输入编辑 ──────────────────────────

    pub fn insert_char(&mut self, c: char) {
        // cursor 是 char 下标,用 char_indices 换算字节位置。
        let byte_idx = self
            .input
            .char_indices()
            .nth(self.cursor)
            .map(|(i, _)| i)
            .unwrap_or(self.input.len());
        self.input.insert(byte_idx, c);
        self.cursor += 1;
        self.recompute_menu();
    }

    /// 在光标处整段插入(bracketed paste 的落点)。
    ///
    /// 逐字符 `insert_char` 也能得到同样的文本,但每个字符都会重算一次斜杠菜单 ——
    /// 粘贴几百行时那是几百次 O(菜单) 扫描,肉眼可见卡顿。这里一次性插入、只重算一次。
    ///
    /// `\r\n` / `\r` 统一成 `\n`:Windows 剪贴板给的是 CRLF,裸 `\r` 会被折行层当控制
    /// 字符跳过,导致粘进来的多行内容在视觉上黏成一行。
    pub fn insert_str(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        let byte_idx = self.byte_at(self.cursor);
        self.input.insert_str(byte_idx, &normalized);
        self.cursor += normalized.chars().count();
        self.recompute_menu();
    }

    pub fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let byte_idx = self
            .input
            .char_indices()
            .nth(self.cursor - 1)
            .map(|(i, _)| i)
            .unwrap_or(self.input.len());
        self.input.remove(byte_idx);
        self.cursor -= 1;
        self.recompute_menu();
    }

    /// Delete 键:删掉光标**右侧**那个字符,光标不动。
    ///
    /// 不能实现成 `move_cursor(1) + backspace()`:光标已在末尾时右移无效,
    /// backspace 会转而删掉左侧字符 —— 按 Delete 反而吃掉前一个字,是明确的错。
    pub fn delete_forward(&mut self) {
        let Some((byte_idx, _)) = self.input.char_indices().nth(self.cursor) else {
            return; // 光标在末尾,右侧无字符可删
        };
        self.input.remove(byte_idx);
        self.recompute_menu();
    }

    pub fn move_cursor(&mut self, delta: isize) {
        let len = self.input.chars().count();
        let next = self.cursor as isize + delta;
        self.cursor = next.clamp(0, len as isize) as usize;
    }

    /// Ctrl+U:删到行首(不跨行)。
    pub fn delete_to_line_start(&mut self) {
        // 当前行的起始位置(上一个 \n 之后)
        let line_start = self.input[..self.byte_at(self.cursor)]
            .rfind('\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        let remove_bytes = self.byte_at(self.cursor) - line_start;
        let remove_chars = self.input[line_start..line_start + remove_bytes].chars().count();
        self.input.replace_range(line_start..line_start + remove_bytes, "");
        self.cursor -= remove_chars;
        self.recompute_menu();
    }

    /// Ctrl+K:删到行尾(不跨行)。
    pub fn delete_to_line_end(&mut self) {
        let byte_pos = self.byte_at(self.cursor);
        let line_end = self.input[byte_pos..]
            .find('\n')
            .map(|i| byte_pos + i)
            .unwrap_or(self.input.len());
        self.input.replace_range(byte_pos..line_end, "");
        self.recompute_menu();
    }

    /// Ctrl+Z:恢复被 Ctrl+C 清空的输入(单次)。
    pub fn restore_undo(&mut self) {
        if let Some(snap) = self.undo_snapshot.take() {
            self.input = snap;
            self.cursor = self.input.chars().count();
            self.recompute_menu();
        }
    }

    /// 插入换行(Ctrl+J)。
    pub fn insert_newline(&mut self) {
        let byte_idx = self.byte_at(self.cursor);
        self.input.insert(byte_idx, '\n');
        self.cursor += 1;
        self.recompute_menu();
    }

    /// Shift+Tab:切换模式(auto ↔ plan)。
    pub fn cycle_mode(&mut self) {
        if self.mode_tag == "Auto" {
            self.mode_tag = "Plan".to_string();
        } else {
            self.mode_tag = "Auto".to_string();
        }
    }

    /// ↑ 键:菜单打开时导航菜单,关闭时翻阅输入历史。
    pub fn on_arrow_up(&mut self) {
        if self.slash_menu.open && !self.slash_menu.filtered.is_empty() {
            self.slash_menu.move_up();
            return;
        }
        // 多行输入:光标不在第一行时上移
        let (row, _) = self.cursor_row_col();
        if row > 0 {
            self.move_cursor(-1);
            return;
        }
        // 翻阅历史
        if self.input_history.is_empty() {
            return;
        }
        let next = match self.history_ptr {
            None => self.input_history.len() - 1,
            Some(i) if i > 0 => i - 1,
            Some(0) => return, // 已经是最早
            Some(i) => i,
        };
        self.history_ptr = Some(next);
        self.input = self.input_history[next].clone();
        self.cursor = self.input.chars().count();
        self.recompute_menu();
    }

    /// ↓ 键:菜单打开时导航菜单,关闭时翻阅输入历史。
    pub fn on_arrow_down(&mut self) {
        if self.slash_menu.open && !self.slash_menu.filtered.is_empty() {
            self.slash_menu.move_down();
            return;
        }
        // 多行输入:光标不在最后一行时下移
        let (row, total_rows) = self.cursor_row_col();
        if row < total_rows - 1 {
            self.move_cursor(1);
            return;
        }
        // 翻阅历史
        let Some(ptr) = self.history_ptr else {
            return;
        };
        if ptr + 1 >= self.input_history.len() {
            // 回到空输入
            self.history_ptr = None;
            self.input.clear();
            self.cursor = 0;
        } else {
            self.history_ptr = Some(ptr + 1);
            self.input = self.input_history[ptr + 1].clone();
            self.cursor = self.input.chars().count();
        }
        self.recompute_menu();
    }

    /// Tab:菜单打开时补全选中项(不提交)。
    pub fn on_tab(&mut self) {
        if self.slash_menu.open {
            if let Some(text) = self.slash_menu.complete_tab() {
                self.input = text;
                self.cursor = self.input.chars().count();
                self.recompute_menu();
            }
        } else {
            self.toggle_last_tool();
        }
    }

    /// Esc:菜单打开时关闭/回到父级,否则清空输入或回尾。
    pub fn on_escape(&mut self) {
        if self.slash_menu.open {
            if let Some(parent) = self.slash_menu.escape(&self.input) {
                self.input = parent;
                self.cursor = self.input.chars().count();
            } else {
                self.slash_menu.close();
            }
            self.recompute_menu();
            return;
        }
        if !self.input.is_empty() {
            self.input.clear();
            self.cursor = 0;
        } else if self.show_diagnostics {
            self.show_diagnostics = false;
        } else {
            self.scroll_to_bottom();
        }
    }

    /// 重新计算斜杠菜单过滤结果。
    fn recompute_menu(&mut self) {
        self.slash_menu.recompute(&self.input);
    }

    /// 光标的当前行号和总行数(用于 ↑/↓ 多行导航)。
    fn cursor_row_col(&self) -> (usize, usize) {
        let before: &str = &self.input[..self.byte_at(self.cursor)];
        let row = before.matches('\n').count();
        let total = self.input.matches('\n').count() + 1;
        (row, total)
    }

    /// 字符下标 → 字节偏移。
    fn byte_at(&self, char_idx: usize) -> usize {
        self.input
            .char_indices()
            .nth(char_idx)
            .map(|(i, _)| i)
            .unwrap_or(self.input.len())
    }

    /// Home / Ctrl+A:移到行首(当前行的第一个字符)。
    pub fn move_cursor_to_line_start(&mut self) {
        let byte_pos = self.byte_at(self.cursor);
        let line_start = self.input[..byte_pos]
            .rfind('\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        self.cursor = self.input[..line_start].chars().count()
            + self.input[line_start..byte_pos]
                .char_indices()
                .count();
    }

    /// End / Ctrl+E:移到行尾。
    pub fn move_cursor_to_line_end(&mut self) {
        let byte_pos = self.byte_at(self.cursor);
        let line_end = self.input[byte_pos..]
            .find('\n')
            .map(|i| byte_pos + i)
            .unwrap_or(self.input.len());
        self.cursor = self.input[..line_end].chars().count();
    }

    // ────────────────────────── 命令下发 ──────────────────────────

    /// 提交输入。以 `/` 开头按内部命令处理,否则发 `run` 给 agent-host。
    pub fn submit(&mut self) {
        let raw = self.input.trim().to_string();
        if raw.is_empty() {
            return;
        }

        // 菜单打开时:Enter 先应用选中项(分支进入子菜单,叶子补全+提交)。
        if self.slash_menu.open {
            if let Some((text, should_submit)) = self.slash_menu.apply_selected() {
                if !should_submit {
                    // 分支节点或需要继续输入参数:只补全不提交。
                    self.input = text;
                    self.cursor = self.input.chars().count();
                    self.recompute_menu();
                    return;
                }
            }
            // 叶子:用补全后的命令文本替换输入,继续走下方斜杠命令处理。
            self.input = self.slash_menu.apply_selected().map(|(t, _)| t).unwrap_or(raw.clone());
            self.slash_menu.close();
        }

        let raw = self.input.trim().to_string();
        if raw.is_empty() {
            return;
        }

        // 记入历史(去重:与最后一条相同则不重复)
        if self.input_history.last().map(|s| s.as_str()) != Some(raw.as_str()) {
            self.input_history.push(raw.clone());
            if self.input_history.len() > 200 {
                self.input_history.remove(0);
            }
        }
        self.history_ptr = None;

        // 回尾(若滚动回看)再发送。
        self.scroll_to_bottom();

        // 斜杠命令:本地处理,不下发给 agent(与 TS repl 的 slash 命令语义一致)。
        if let Some(cmd) = raw.strip_prefix('/') {
            self.input.clear();
            self.cursor = 0;
            self.content_dirty = true;
            self.execute_slash_command(cmd.trim());
            return;
        }

        // 运行中的输入被忽略(agent-host 侧也会拒:同一时刻只允许一个活跃 run)。
        if self.running {
            return;
        }

        let prompt = raw;
        let id = self.host.next_id();
        let session = self.session_id.clone();

        self.entries.push(Entry::User { text: prompt.clone() });
        self.entries.push(Entry::Blank);
        self.content_dirty = true;
        self.input.clear();
        self.cursor = 0;
        self.running = true;
        self.status = RunStatus::Thinking;
        self.turn_start = Some(Instant::now());
        self.stick_to_bottom = true;

        let attachments = if self.pending_images.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.pending_images))
        };

        let cmd = HostCommand::Run {
            id,
            prompt,
            session_id: session,
            attachments,
        };
        if let Err(e) = self.host.send(cmd) {
            self.entries.push(Entry::System {
                text: format!("发送失败: {e}"),
                tone: Tone::Error,
            });
            self.running = false;
            self.status = RunStatus::Idle;
        }
    }

    /// 执行斜杠命令。对齐 TS `src/repl/index.ts` 的命令派发。
    ///
    /// 分类:
    /// - **本地处理**(/help /exit /clear /context /compact /mode /skills /sessions /resume /memory /fe /subagent …):
    ///   直接读文件系统或改 App 状态。
    /// - **转发给 agent-host**(/init /skill /image attach):
    ///   转成正常 prompt 或带附件的 Run 发给 agent-host。
    /// - **明确不支持**(/theme /model /pet /language /upgrade /rollback):
    ///   给出清晰提示,不静默吞掉。
    fn execute_slash_command(&mut self, cmd: &str) {
        let full_cmd = format!("/{cmd}");

        // ── /help ──
        if cmd == "help" || cmd == "h" || cmd == "?" {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.show_help();
            self.content_dirty = true;
            return;
        }

        // ── /exit /quit ──
        if cmd == "exit" || cmd == "quit" || cmd == "q" {
            self.should_quit = true;
            return;
        }

        // ── /clear ──
        if cmd == "clear" {
            self.entries.clear();
            self.tool_index.clear();
            self.pending_batch = None;
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.entries.push(Entry::System {
                text: "历史已清空".to_string(),
                tone: Tone::Dim,
            });
            self.entries.push(Entry::Blank);
            self.content_dirty = true;
            return;
        }

        // ── /context ──
        if cmd == "context" {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.show_context();
            self.content_dirty = true;
            return;
        }

        // ── /compact [focus] ──
        if cmd == "compact" || cmd.starts_with("compact ") {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            // `/compact 保留接口约定` 的焦点要透传给 agent-host,不能丢。
            let focus = cmd
                .strip_prefix("compact")
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            self.compact(focus);
            self.content_dirty = true;
            return;
        }

        // ── /diag ──
        if cmd == "diag" {
            self.show_diagnostics = !self.show_diagnostics;
            return;
        }

        // ── /plan /auto /mode ──
        if cmd == "plan" {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.mode_tag = "Plan".to_string();
            self.entries.push(Entry::System {
                text: "已切换到 Plan 模式（只读探查并产出计划）".to_string(),
                tone: Tone::Accent,
            });
            self.entries.push(Entry::Blank);
            self.content_dirty = true;
            return;
        }
        if cmd == "auto" {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.mode_tag = "Auto".to_string();
            self.entries.push(Entry::System {
                text: "已切换到 Auto 模式（按任务能力自动执行）".to_string(),
                tone: Tone::Accent,
            });
            self.entries.push(Entry::Blank);
            self.content_dirty = true;
            return;
        }
        if cmd == "mode" || cmd == "mode plan" {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.mode_tag = "Plan".to_string();
            self.entries.push(Entry::System {
                text: "已切换到 Plan 模式".to_string(),
                tone: Tone::Accent,
            });
            self.entries.push(Entry::Blank);
            self.content_dirty = true;
            return;
        }
        if cmd == "mode auto" {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.mode_tag = "Auto".to_string();
            self.entries.push(Entry::System {
                text: "已切换到 Auto 模式".to_string(),
                tone: Tone::Accent,
            });
            self.entries.push(Entry::Blank);
            self.content_dirty = true;
            return;
        }

        // ── /skills ── 列出已发现的 skill 目录
        if cmd == "skills" {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.list_skills();
            self.content_dirty = true;
            return;
        }

        // ── /skill <name> [args] ── 转发给 agent-host 作为普通 prompt
        if cmd == "skill" || cmd.starts_with("skill ") {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.forward_to_agent(&full_cmd);
            return;
        }

        // ── /resume <id> ── 续接指定会话
        // 不需要新协议:`HostCommand::Run` 带上 sessionId,agent-host 的 prepareSession
        // 就会 restoreSession(loadSession + 重建 history)。这里只记住 id,
        // 下一条消息发出去时随 Run 一起带上。
        if let Some(rest) = cmd.strip_prefix("resume ") {
            let id = rest.trim();
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.resume_session(id);
            self.content_dirty = true;
            return;
        }

        // ── /sessions /resume ── 列出已保存会话
        if cmd == "sessions" || cmd == "resume" {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.list_sessions(cmd == "sessions");
            self.content_dirty = true;
            return;
        }

        // ── /memory [overview|toggle|on|off|status|reflect] ──
        if cmd == "memory" || cmd.starts_with("memory ") {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.handle_memory(cmd);
            self.content_dirty = true;
            return;
        }

        // ── /fe [on|off|status] / /frontend ──
        if cmd == "fe" || cmd.starts_with("fe ") || cmd == "frontend" {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.handle_feature_toggle("fe", cmd);
            self.content_dirty = true;
            return;
        }

        // ── /subagent [on|off|status] ──
        if cmd == "subagent" || cmd.starts_with("subagent ") {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.handle_feature_toggle("subagent", cmd);
            self.content_dirty = true;
            return;
        }

        // ── /model [configure|switch|list|show|use|delete] ──
        if cmd == "model" || cmd.starts_with("model ") {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.handle_model(cmd);
            self.content_dirty = true;
            return;
        }

        // ── /init ── 转发 init prompt 给 agent（TS 同款 fall-through）
        if cmd == "init" {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.forward_to_agent("你是一个专业代码助手。请扫描当前项目目录，生成 AGENTS.md 项目记忆文件，包含：项目概述、构建/测试命令、目录结构、代码约定、扩展点。");
            return;
        }

        // ── /image [attach <path>|list|clear] ──
        if cmd == "image" || cmd.starts_with("image ") {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.handle_image(cmd);
            self.content_dirty = true;
            return;
        }

        // ── /theme ──
        if cmd == "theme" || cmd.starts_with("theme ") {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.entries.push(Entry::System {
                text: "Rust TUI 暂不支持运行时切换主题。当前固定使用 orange 主题（深暖棕黑底 + 南瓜橙）。".to_string(),
                tone: Tone::Warn,
            });
            self.entries.push(Entry::Blank);
            self.content_dirty = true;
            return;
        }

        // ── /pet [toggle|skin|quit] ──
        if cmd == "pet" || cmd.starts_with("pet ") {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.entries.push(Entry::System {
                text: "Rust TUI 不支持桌宠。请使用 TS 版 mocode (`npm start`) 使用桌宠功能。".to_string(),
                tone: Tone::Warn,
            });
            self.entries.push(Entry::Blank);
            self.content_dirty = true;
            return;
        }

        // ── /language [zh-CN|en] ──
        if cmd == "language" || cmd.starts_with("language ") {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.entries.push(Entry::System {
                text: "Rust TUI 固定使用中文界面。如需英文，请使用 TS 版 mocode (`npm start`)。".to_string(),
                tone: Tone::Warn,
            });
            self.entries.push(Entry::Blank);
            self.content_dirty = true;
            return;
        }

        // ── /upgrade [now|check|status] ──
        if cmd == "upgrade" || cmd.starts_with("upgrade ") {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.entries.push(Entry::System {
                text: "升级请使用 npm: `npm update -g mocode-ai` 或 `npm run build`。Rust TUI 不支持自动升级。".to_string(),
                tone: Tone::Info,
            });
            self.entries.push(Entry::Blank);
            self.content_dirty = true;
            return;
        }

        // ── /rollback ──
        if cmd == "rollback" || cmd.starts_with("rollback ") {
            self.entries.push(Entry::User { text: full_cmd.clone() });
            self.entries.push(Entry::Blank);
            self.entries.push(Entry::System {
                text: "回滚轮次需要交互式菜单选择，Rust TUI 暂不支持。请使用 TS 版 mocode (`npm start`) 使用 /rollback。".to_string(),
                tone: Tone::Warn,
            });
            self.entries.push(Entry::Blank);
            self.content_dirty = true;
            return;
        }

        // ── 未知命令 ──
        self.entries.push(Entry::User { text: full_cmd.clone() });
        self.entries.push(Entry::Blank);
        self.entries.push(Entry::System {
            text: format!("未知命令 /{cmd}"),
            tone: Tone::Warn,
        });
        self.show_help();
        self.content_dirty = true;
    }

    /// 把 prompt 作为普通 Run 命令发给 agent-host。
    fn forward_to_agent(&mut self, prompt: &str) {
        if self.running {
            self.entries.push(Entry::System {
                text: "有正在运行的任务,请先取消".to_string(),
                tone: Tone::Warn,
            });
            self.entries.push(Entry::Blank);
            self.content_dirty = true;
            return;
        }
        let id = self.host.next_id();
        let session = self.session_id.clone();
        let attachments = if self.pending_images.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.pending_images))
        };
        self.running = true;
        self.status = RunStatus::Thinking;
        self.turn_start = Some(Instant::now());
        self.stick_to_bottom = true;
        let cmd = HostCommand::Run {
            id,
            prompt: prompt.to_string(),
            session_id: session,
            attachments,
        };
        if let Err(e) = self.host.send(cmd) {
            self.entries.push(Entry::System {
                text: format!("发送失败: {e}"),
                tone: Tone::Error,
            });
            self.running = false;
            self.status = RunStatus::Idle;
        }
        self.content_dirty = true;
    }

    /// /skills:扫描 skill 目录,列出已发现的 skill。
    fn list_skills(&mut self) {
        let dirs = self.skills_dirs();
        let mut found: Vec<(String, String)> = Vec::new(); // (name, origin)

        for dir in &dirs {
            let origin = if dir.contains(".claude") { "user(claude)" }
                else if dir.ends_with(".mocode/skills") || dir.ends_with(".mocode\\skills") { "project" }
                else { "user" };
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let skill_md = path.join("SKILL.md");
                    if skill_md.exists() {
                        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                            found.push((name.to_string(), origin.to_string()));
                        }
                    }
                }
            }
        }

        if found.is_empty() {
            self.entries.push(Entry::System {
                text: "(没有已发现的 skill)".to_string(),
                tone: Tone::Dim,
            });
            self.entries.push(Entry::System {
                text: format!("扫描目录: {}", dirs.join(", ")),
                tone: Tone::Dim,
            });
        } else {
            self.entries.push(Entry::System {
                text: format!("已发现 {} 个 skill:", found.len()),
                tone: Tone::Accent,
            });
            for (name, origin) in &found {
                self.entries.push(Entry::System {
                    text: format!("  {} ({})", name, origin),
                    tone: Tone::Info,
                });
            }
        }
        self.entries.push(Entry::Blank);
    }

    /// skill 扫描目录,对齐 TS `resolveSkillsDirs()`。
    fn skills_dirs(&self) -> Vec<String> {
        let mut dirs = Vec::new();

        // 1. env SKILLS_DIRS 覆盖
        if let Ok(env) = std::env::var("SKILLS_DIRS") {
            if !env.trim().is_empty() {
                let delim = if cfg!(windows) { ';' } else { ':' };
                return env.split(delim)
                    .map(|d| d.trim().to_string())
                    .filter(|d| !d.is_empty())
                    .collect();
            }
        }

        // 2. 默认三目录:~/.claude/skills → ~/.mocode/skills → <cwd>/.mocode/skills
        if let Some(home) = std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok()) {
            dirs.push(format!("{}/.claude/skills", home.replace('\\', "/")));
            dirs.push(format!("{}/.mocode/skills", home.replace('\\', "/")));
        }
        dirs.push(format!("{}/.mocode/skills", self.project_root.replace('\\', "/")));

        dirs
    }

    /// /sessions /resume:列出已保存会话。
    fn list_sessions(&mut self, all: bool) {
        let session_dir = format!("{}/.mocode/sessions", self.project_root.replace('\\', "/"));
        let mut sessions: Vec<(String, String)> = Vec::new(); // (id, preview)

        if let Ok(entries) = std::fs::read_dir(&session_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = match name.to_str() {
                    Some(s) => s,
                    None => continue,
                };
                // 新式目录: YYYYMMDD-HHMMSS
                let is_dir = entry.path().is_dir();
                let is_file = name_str.ends_with(".json");
                if !is_dir && !is_file {
                    continue;
                }

                let id = if is_file { name_str.trim_end_matches(".json") } else { name_str };
                // 会话 id 形如 `YYYYMMDD-HHMMSS`:只含数字与 `-`,且至少 8 位。
                // 目录里的其它内容(notes.md、临时文件等)据此排除。
                let digits = id.chars().filter(char::is_ascii_digit).count();
                if digits < 8 || !id.chars().all(|c| c.is_ascii_digit() || c == '-') {
                    continue;
                }

                // 读 session.json(目录式) 或 .json(扁平式)
                let json_path = if is_dir {
                    entry.path().join("session.json")
                } else {
                    entry.path()
                };

                let preview = if let Ok(raw) = std::fs::read_to_string(&json_path) {
                    // 解析 queryHistory[0] 或 history[1].content
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                        let qh = v.get("queryHistory").and_then(|q| q.as_array());
                        if let Some(arr) = qh {
                            arr.first()
                                .and_then(|s| s.as_str())
                                .map(|s| s.chars().take(60).collect::<String>())
                                .unwrap_or_default()
                        } else {
                            let hist = v.get("history").and_then(|h| h.as_array());
                            hist.and_then(|arr| {
                                arr.iter().find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
                                    .and_then(|m| m.get("content"))
                                    .and_then(|c| c.as_str())
                                    .map(|s| s.chars().take(60).collect::<String>())
                            }).unwrap_or_default()
                        }
                    } else {
                        String::new()
                    }
                } else {
                    String::new()
                };

                sessions.push((id.to_string(), preview));
            }
        }

        sessions.sort_by(|a, b| b.0.cmp(&a.0));

        if !all {
            sessions.truncate(10);
        }

        if sessions.is_empty() {
            self.entries.push(Entry::System {
                text: format!("(没有已保存的会话)  目录: {}", session_dir),
                tone: Tone::Dim,
            });
        } else {
            self.entries.push(Entry::System {
                text: format!("已保存会话 ({}{}):", sessions.len(), if !all && sessions.len() == 10 { ", 仅最近 10 条" } else { "" }),
                tone: Tone::Accent,
            });
            for (id, preview) in &sessions {
                let text = if preview.is_empty() {
                    format!("  {}", id)
                } else {
                    format!("  {}  {}", id, preview)
                };
                self.entries.push(Entry::System {
                    text,
                    tone: Tone::Info,
                });
            }
            self.entries.push(Entry::System {
                text: "续接:/resume <id>(下一条消息会带上该会话继续)".to_string(),
                tone: Tone::Dim,
            });
        }
        self.entries.push(Entry::Blank);
    }

    /// 会话存放目录。目录式(`<id>/session.json`)与扁平式(`<id>.json`)都支持 ——
    /// TS 侧历史上两种都写过,恢复时不能只认一种。
    fn session_dir(&self) -> String {
        format!("{}/.mocode/sessions", self.project_root.replace('\\', "/"))
    }

    /// 某个会话 id 是否真的有落盘数据。
    fn session_exists(&self, id: &str) -> bool {
        let dir = self.session_dir();
        PathBuf::from(format!("{dir}/{id}/session.json")).exists()
            || PathBuf::from(format!("{dir}/{id}.json")).exists()
    }

    /// `/resume <id>`:切到指定会话。
    ///
    /// **不需要新协议**:`HostCommand::Run` 的 `sessionId` 字段一带上,agent-host 的
    /// `prepareSession` 就会走 `restoreSession`(loadSession + 重建 history)。所以这里
    /// 只把 id 记进 `self.session_id`,真正的恢复发生在下一条消息发出时。
    ///
    /// 先做存在性校验:id 打错时立刻告诉用户,而不是等下一条消息被 agent-host 拒掉
    /// (那时错误信息会混在正常对话里,难以归因)。
    fn resume_session(&mut self, id: &str) {
        if id.is_empty() {
            self.entries.push(Entry::System {
                text: "用法: /resume <会话 id>。先用 /sessions 查看可用 id。".to_string(),
                tone: Tone::Dim,
            });
            self.entries.push(Entry::Blank);
            return;
        }
        if !self.session_exists(id) {
            self.entries.push(Entry::System {
                text: format!("找不到会话 {id}。用 /sessions 查看可用 id。"),
                tone: Tone::Warn,
            });
            self.entries.push(Entry::Blank);
            return;
        }
        self.session_id = Some(id.to_string());
        self.entries.push(Entry::System {
            text: format!("已切换到会话 {id},下一条消息将在该会话中继续。"),
            tone: Tone::Success,
        });
        self.entries.push(Entry::Blank);
    }

    /// /memory [overview|toggle|on|off|status|reflect]
    fn handle_memory(&mut self, cmd: &str) {
        let sub = cmd.strip_prefix("memory ").unwrap_or("").trim();
        match sub {
            "" | "overview" => {
                let mem_dir = format!("{}/.mocode/memory", self.project_root.replace('\\', "/"));
                let mut count = 0;
                if let Ok(entries) = std::fs::read_dir(&mem_dir) {
                    count = entries.filter(|e| {
                        e.as_ref().ok()
                            .and_then(|e| e.file_name().to_str().map(|s| s.to_string()))
                            .map(|s| s.ends_with(".md"))
                            .unwrap_or(false)
                    }).count();
                }
                self.entries.push(Entry::System {
                    text: format!("记忆库: {} 个文件  目录: {}", count, mem_dir),
                    tone: Tone::Info,
                });
                self.entries.push(Entry::System {
                    text: format!("记忆子系统: {}", if self.memory_enabled { "已开启" } else { "已关闭" }),
                    tone: if self.memory_enabled { Tone::Success } else { Tone::Dim },
                });
            }
            "status" => {
                self.entries.push(Entry::System {
                    text: format!("记忆子系统: {}", if self.memory_enabled { "已开启" } else { "已关闭" }),
                    tone: Tone::Info,
                });
                self.entries.push(Entry::System {
                    text: "说明: MEMORY_ENABLED 在 .env 中配置,切换需重启 mocode".to_string(),
                    tone: Tone::Dim,
                });
            }
            "on" | "off" | "toggle" => {
                self.entries.push(Entry::System {
                    text: "记忆开关需修改 .env 的 MEMORY_ENABLED=true/false 并重启 mocode,Rust TUI 无法运行时切换。".to_string(),
                    tone: Tone::Warn,
                });
            }
            "reflect" => {
                self.entries.push(Entry::System {
                    text: "手动触发记忆反思需要 agent-host 支持,Rust TUI 暂不支持。请使用 TS 版 mocode。".to_string(),
                    tone: Tone::Warn,
                });
            }
            other => {
                self.entries.push(Entry::System {
                    text: format!("未知子命令 /memory {}", other),
                    tone: Tone::Warn,
                });
            }
        }
        self.entries.push(Entry::Blank);
    }

    /// /fe [on|off|status] / /subagent [on|off|status] / /frontend
    fn handle_feature_toggle(&mut self, feature: &str, cmd: &str) {
        let sub = cmd.split_once(' ').map(|(_, s)| s.trim()).unwrap_or("");
        let env_key = match feature {
            "fe" => "MOCODE_FRONTEND_TOOLS_ENABLED",
            "subagent" => "MOCODE_SUBAGENT_ENABLED",
            _ => "",
        };
        let label = match feature {
            "fe" => "前端工具簇(view_image/screenshot/dev_server/browser)",
            "subagent" => "子 Agent",
            _ => feature,
        };

        let enabled = std::env::var(env_key)
            .map(|v| v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        match sub {
            "" | "status" => {
                self.entries.push(Entry::System {
                    text: format!("{}: {}", label, if enabled { "已开启" } else { "已关闭" }),
                    tone: if enabled { Tone::Success } else { Tone::Dim },
                });
                self.entries.push(Entry::System {
                    text: format!("配置: .env 的 {}=true/false,切换需重启 mocode", env_key),
                    tone: Tone::Dim,
                });
            }
            "on" | "off" => {
                self.entries.push(Entry::System {
                    text: format!("{}开关需修改 .env 的 {}={} 并重启 mocode", label, env_key, if sub == "on" { "true" } else { "false" }),
                    tone: Tone::Warn,
                });
            }
            _ => {
                self.entries.push(Entry::System {
                    text: format!("未知子命令 /{} {}", feature, sub),
                    tone: Tone::Warn,
                });
            }
        }
        self.entries.push(Entry::Blank);
    }

    /// /model [configure|switch|list|show|use <name>|delete <name>]
    fn handle_model(&mut self, cmd: &str) {
        let sub = cmd.split_once(' ').map(|(_, s)| s.trim()).unwrap_or("");
        match sub {
            "" | "configure" => {
                self.entries.push(Entry::System {
                    text: "当前模型配置:".to_string(),
                    tone: Tone::Accent,
                });
                self.entries.push(Entry::System {
                    text: format!("  模型: {}", self.display_model()),
                    tone: Tone::Info,
                });
                self.entries.push(Entry::System {
                    text: format!("  Provider: {}", if self.provider.is_empty() { "(未知)" } else { &self.provider }),
                    tone: Tone::Info,
                });
                self.entries.push(Entry::System {
                    text: "切换模型请修改 .env 的 LLM_MODEL / LLM_BASE_URL / LLM_API_KEY 并重启 mocode。".to_string(),
                    tone: Tone::Dim,
                });
            }
            "show" => {
                self.entries.push(Entry::System {
                    text: format!("模型: {}  Provider: {}", self.display_model(), if self.provider.is_empty() { "(未知)" } else { &self.provider }),
                    tone: Tone::Info,
                });
            }
            "list" => {
                self.entries.push(Entry::System {
                    text: "模型预设管理需要 TS 版 mocode 的 ~/.mocode/config 配置系统,Rust TUI 暂不支持。".to_string(),
                    tone: Tone::Warn,
                });
                self.entries.push(Entry::System {
                    text: format!("当前模型: {}", self.display_model()),
                    tone: Tone::Info,
                });
            }
            "switch" | "use" | "delete" => {
                self.entries.push(Entry::System {
                    text: "模型预设切换需要 TS 版 mocode 的配置系统,Rust TUI 暂不支持。请修改 .env 后重启。".to_string(),
                    tone: Tone::Warn,
                });
            }
            _ => {
                self.entries.push(Entry::System {
                    text: format!("未知子命令 /model {}", sub),
                    tone: Tone::Warn,
                });
            }
        }
        self.entries.push(Entry::Blank);
    }

    /// /image [attach <path>|list|clear]
    fn handle_image(&mut self, cmd: &str) {
        let sub = cmd.split_once(' ').map(|(_, s)| s.trim()).unwrap_or("");
        match sub {
            "" | "list" => {
                if self.pending_images.is_empty() {
                    self.entries.push(Entry::System {
                        text: "(没有待发送图片)".to_string(),
                        tone: Tone::Dim,
                    });
                } else {
                    self.entries.push(Entry::System {
                        text: format!("待发送图片 ({}):", self.pending_images.len()),
                        tone: Tone::Accent,
                    });
                    for img in &self.pending_images {
                        self.entries.push(Entry::System {
                            text: format!("  {}", img.name),
                            tone: Tone::Info,
                        });
                    }
                    self.entries.push(Entry::System {
                        text: "下次发送消息时将随消息一起提交".to_string(),
                        tone: Tone::Dim,
                    });
                }
            }
            "clear" => {
                let n = self.pending_images.len();
                self.pending_images.clear();
                self.entries.push(Entry::System {
                    text: format!("已清除 {} 张待发送图片", n),
                    tone: Tone::Dim,
                });
            }
            other if other.starts_with("attach ") => {
                let path = other.strip_prefix("attach ").unwrap_or("").trim();
                if path.is_empty() {
                    self.entries.push(Entry::System {
                        text: "用法: /image attach <文件路径>".to_string(),
                        tone: Tone::Warn,
                    });
                } else {
                    match self.attach_image(path) {
                        Ok(name) => {
                            self.entries.push(Entry::System {
                                text: format!("已附加: {}", name),
                                tone: Tone::Success,
                            });
                        }
                        Err(e) => {
                            self.entries.push(Entry::System {
                                text: format!("附加失败: {}", e),
                                tone: Tone::Error,
                            });
                        }
                    }
                }
            }
            _ => {
                self.entries.push(Entry::System {
                    text: format!("用法: /image attach <路径> | /image list | /image clear"),
                    tone: Tone::Dim,
                });
            }
        }
        self.entries.push(Entry::Blank);
    }

    /// 读取图片文件并转成 data URL 附件。
    fn attach_image(&mut self, path: &str) -> Result<String, String> {
        let p = PathBuf::from(path);
        if !p.exists() {
            return Err(format!("文件不存在: {}", path));
        }
        let data = std::fs::read(&p).map_err(|e| format!("读取失败: {}", e))?;
        let name = p.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("image")
            .to_string();

        // 检测 MIME
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            _ => "application/octet-stream",
        };

        // base64 编码
        const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut encoded = String::with_capacity((data.len() + 2) / 3 * 4);
        for chunk in data.chunks(3) {
            let b0 = chunk[0] as usize;
            let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
            let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
            encoded.push(CHARS[b0 >> 2] as char);
            encoded.push(CHARS[((b0 & 0x03) << 4) | (b1 >> 4)] as char);
            if chunk.len() > 1 {
                encoded.push(CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] as char);
            } else {
                encoded.push('=');
            }
            if chunk.len() > 2 {
                encoded.push(CHARS[b2 & 0x3f] as char);
            } else {
                encoded.push('=');
            }
        }

        let data_url = format!("data:{};base64,{}", mime, encoded);
        self.pending_images.push(HostAttachment {
            name: name.clone(),
            data_url,
        });
        Ok(name)
    }

    /// /help:列出所有可用命令(递归展示分支子命令)。
    fn show_help(&mut self) {
        use crate::commands::COMMANDS;
        self.entries.push(Entry::System {
            text: "可用命令:".to_string(),
            tone: Tone::Accent,
        });

        fn walk(entries: &mut Vec<Entry>, nodes: &[crate::commands::SlashCommand], depth: usize) {
            for node in nodes {
                let indent = "  ".repeat(depth);
                let marker = if node.children.is_empty() { "" } else { " ›" };
                let text = format!("  {indent}{}{marker}  {}", node.name, node.desc);
                entries.push(Entry::System {
                    text,
                    tone: Tone::Info,
                });
                if !node.children.is_empty() {
                    walk(entries, node.children, depth + 1);
                }
            }
        }
        walk(&mut self.entries, COMMANDS, 0);
        self.entries.push(Entry::Blank);
    }

    /// /context:显示当前上下文用量。
    fn show_context(&mut self) {
        let pct = self.usage_percent;
        let window = self.context_window;
        let current = window * pct as u64 / 100;
        let text = format!(
            "上下文: {} / {} tokens ({}%)",
            current, window, pct
        );
        self.entries.push(Entry::System {
            text,
            tone: Tone::Info,
        });
        self.entries.push(Entry::Blank);
    }

    /// Ctrl+C:有运行则软取消,空闲时清空输入(有内容时先存快照供 Ctrl+Z 恢复)。
    pub fn interrupt(&mut self) {
        if self.running {
            let id = self.host.next_id();
            let _ = self.host.send(HostCommand::Cancel { id });
            self.status = RunStatus::Idle;
        } else if !self.input.is_empty() || self.slash_menu.open {
            self.undo_snapshot = Some(self.input.clone());
            self.input.clear();
            self.cursor = 0;
            self.slash_menu.close();
        }
    }

    /// `/compact [focus]` 命令。
    ///
    /// `focus` 是可选的压缩焦点(如 `/compact 保留接口约定`),会原样透传给
    /// agent-host 的 `manualCompact(history, focus)` —— 协议本就支持该字段,
    /// 早期实现硬编码 `None`,用户敲的焦点被静默丢弃。
    pub fn compact(&mut self, focus: Option<String>) {
        if self.running {
            self.entries.push(Entry::System {
                text: "有正在运行的任务,请先取消后再压缩。".into(),
                tone: Tone::Warn,
            });
            return;
        }
        let id = self.host.next_id();
        if self.host.send(HostCommand::Compact { id, focus }).is_ok() {
            self.status = RunStatus::Compacting;
            self.entries.push(Entry::System {
                text: "正在压缩上下文…".into(),
                tone: Tone::Info,
            });
        }
    }

    /// 回复审批。
    pub fn resolve_approval(&mut self, action: ApprovalAction, value: Option<String>) {
        let Some(pending) = self.pending_approval.take() else {
            return;
        };
        let id = self.host.next_id();
        let _ = self.host.send(HostCommand::Approval {
            id,
            approval_id: pending.approval_id,
            action,
            value,
        });
    }

    // ────────────────────────── 事件消费 ──────────────────────────

    /// 处理一条 IPC 消息。返回 true 表示内容有变化(渲染层可据此标脏)。
    pub fn on_ipc(&mut self, msg: IpcMessage) -> bool {
        let changed = match msg {
            IpcMessage::Event { event, .. } => self.on_event(event),
            IpcMessage::Error { message, .. } => {
                self.flush_tool_batch();
                self.entries.push(Entry::System {
                    text: message,
                    tone: Tone::Error,
                });
                self.running = false;
                self.status = RunStatus::Idle;
                true
            }
            IpcMessage::Diagnostics(line) => {
                if self.diagnostics.len() >= 200 {
                    self.diagnostics.pop_front();
                }
                self.diagnostics.push_back(line);
                false
            }
            IpcMessage::Malformed(line) => {
                // stdout 上的非协议输出 —— 记进诊断,不污染内容区。
                if self.diagnostics.len() >= 200 {
                    self.diagnostics.pop_front();
                }
                self.diagnostics.push_back(format!("[stdout] {line}"));
                false
            }
            IpcMessage::StdoutClosed => {
                self.flush_tool_batch();
                self.entries.push(Entry::System {
                    text: "agent-host 已退出。".into(),
                    tone: Tone::Error,
                });
                self.running = false;
                self.status = RunStatus::Idle;
                true
            }
        };
        if changed {
            self.content_dirty = true;
        }
        changed
    }

    fn on_event(&mut self, event: HostEvent) -> bool {
        match event {
            HostEvent::RuntimeReady { provider, warnings, .. } => {
                self.provider = provider;
                for w in warnings {
                    self.entries.push(Entry::System { text: w, tone: Tone::Warn });
                }
                true
            }
            HostEvent::RunStarted { session_id, .. } => {
                self.session_id = Some(session_id);
                true
            }
            HostEvent::Status { value, tool } => {
                self.status = match value.as_str() {
                    "thinking" => RunStatus::Thinking,
                    "preparing_tool" => RunStatus::PreparingTool,
                    "running_tool" => RunStatus::RunningTool,
                    "compacting" => RunStatus::Compacting,
                    _ => RunStatus::Idle,
                };
                self.active_tool = tool;
                false
            }
            HostEvent::TextDelta { text } => {
                // 正文出现说明上一个工具批结束了 —— 先收口,中间留一条空行
                // (TS `agent/index.ts:flushToolBatch` 的同款边界)。
                self.flush_tool_batch();
                // 追加到最后一条 Assistant;没有就新建(模型可能不带 tool 直接出正文)。
                match self.entries.last_mut() {
                    Some(Entry::Assistant { text: buf }) => buf.push_str(&text),
                    _ => self.entries.push(Entry::Assistant { text }),
                }
                true
            }
            HostEvent::ToolStarted { id, name, arguments } => {
                self.on_tool_started(id, name, arguments);
                true
            }
            HostEvent::ToolCompleted { id, name, output } => {
                self.on_tool_completed(&id, &name, &output);
                true
            }
            HostEvent::RunFinished { elapsed_ms, usage } => {
                self.last_elapsed_ms = elapsed_ms;
                if usage.is_some() {
                    self.last_usage = usage;
                }
                false
            }
            HostEvent::RunCompleted {
                session_id,
                completed,
                termination_reason,
                changed_files,
                usage,
                usage_percent,
                context_window,
            } => {
                // 轮次收尾:先收口残留的开放批,再出变更概览 + 完成行。
                self.flush_tool_batch();
                self.session_id = Some(session_id);
                self.usage_percent = usage_percent;
                self.context_window = context_window;
                if usage.is_some() {
                    self.last_usage = usage;
                }
                self.running = false;
                self.status = RunStatus::Idle;
                self.turn_start = None;

                // 文件变更概览 —— TS `writeChangeOverview`(带尾部空行)。
                if !changed_files.is_empty() {
                    self.entries.push(Entry::ChangeOverview { files: changed_files });
                    self.entries.push(Entry::Blank);
                }

                // 完成行 —— TS `onDone` 的 `● 完成  3.2s`;非正常终止走各自的提示。
                let text = match (completed, termination_reason.as_str()) {
                    (_, "aborted") => "已中断".to_string(),
                    (false, "max_steps") => "达到最大步数,本轮停止。".to_string(),
                    (true, _) => format!("完成  {}", format_elapsed_ms(self.last_elapsed_ms)),
                    _ => "结束".to_string(),
                };
                let tone = if completed && termination_reason != "aborted" {
                    Tone::Accent
                } else {
                    Tone::Warn
                };
                self.entries.push(Entry::System { text, tone });
                // 轮次之间空行 —— TS `runTurn` finally 的 `contentWrite('\n')`。
                self.entries.push(Entry::Blank);
                true
            }
            HostEvent::RunFailed { message } => {
                self.flush_tool_batch();
                self.running = false;
                self.status = RunStatus::Idle;
                self.turn_start = None;
                self.entries.push(Entry::System { text: message, tone: Tone::Error });
                self.entries.push(Entry::Blank);
                true
            }
            HostEvent::RunAborted => {
                self.flush_tool_batch();
                self.running = false;
                self.status = RunStatus::Idle;
                self.turn_start = None;
                self.entries.push(Entry::System {
                    text: "(已中断)".into(),
                    tone: Tone::Warn,
                });
                self.entries.push(Entry::Blank);
                true
            }
            HostEvent::Cancelling => {
                self.entries.push(Entry::System {
                    text: "正在取消…".into(),
                    tone: Tone::Info,
                });
                true
            }
            HostEvent::RunIdle => false,
            HostEvent::CompactDone {
                compacted,
                before_tokens,
                after_tokens,
                usage_percent,
                context_window,
            } => {
                self.usage_percent = usage_percent;
                self.context_window = context_window;
                self.status = RunStatus::Idle;
                let text = match (before_tokens, after_tokens) {
                    (Some(b), Some(a)) => format!("压缩完成: {b} → {a} tokens"),
                    _ if compacted => "压缩完成".to_string(),
                    _ => "无需压缩".to_string(),
                };
                self.entries.push(Entry::System { text, tone: Tone::Success });
                self.entries.push(Entry::Blank);
                true
            }
            HostEvent::ApprovalRequested { approval_id, title, detail, options } => {
                // 默认落最后一项 —— TS 侧惯例是把"拒绝/取消"放最后,避免误批准。
                let selected = options.len().saturating_sub(1);
                self.pending_approval = Some(PendingApproval {
                    approval_id,
                    title,
                    detail,
                    options,
                    selected,
                });
                true
            }
            HostEvent::Unknown { name, .. } => {
                if self.diagnostics.len() >= 200 {
                    self.diagnostics.pop_front();
                }
                self.diagnostics.push_back(format!("[未识别事件] {name}"));
                false
            }
        }
    }

    // ────────────────────────── 工具批聚拢 ──────────────────────────

    /// mutation 工具:`write_file` / `edit_file` 独占一批(diff 要紧跟调用行)。
    /// 与 TS `ui/batch.ts:isMutationToolName` 同定义。
    fn is_mutation(name: &str) -> bool {
        matches!(name, "write_file" | "edit_file")
    }

    fn on_tool_started(&mut self, id: String, name: String, arguments: String) {
        let mutation = Self::is_mutation(&name);
        // mutation 独占一批:先收口当前普通批,再开新批。
        if mutation {
            self.flush_tool_batch();
        }

        let idx = match self.pending_batch {
            // 开放批存在且未被收口 → 并入(同轮并行/连续无正文的工具共用一个摘要行)。
            // **但 mutation 独占批不能并入普通工具**:上一个 mutation 已在 flush 里收口,
            // pending_batch 应为 None;若仍非 None 说明是未完成的 mutation 批(结果还没回来),
            // 普通工具必须另开新批,不能合并到 mutation 批(否则 diff 会被普通工具的结果行遮盖)。
            Some(i) if self.batch_at(i).is_some() && !self.batch_at(i).unwrap().standalone => i,
            // standalone 批(未完成的 mutation)来了普通工具:先 flush standalone 批,
            // 再开新普通批。
            Some(i) if self.batch_at(i).is_some() => {
                self.flush_tool_batch();
                self.begin_tool_batch(false)
            }
            _ => self.begin_tool_batch(mutation),
        };

        let summary = summarize_tool_call(&name, &arguments);
        if let Some(Entry::ToolBatch(b)) = self.entries.get_mut(idx) {
            // 又来一条 → 批重新进入未完成态,耗时清零重算。
            b.finished_ms = None;
            b.items.push(ToolItem {
                id: id.clone(),
                name,
                summary,
                result_summary: String::new(),
                output: None,
                failed: false,
                done: false,
                // 参数在这里留档:tool_completed 事件不带参数,mutation 的 diff 只能靠它现算。
                arguments,
                diff_block: None,
            });
        }
        // 结果按 id 归位:并行执行时"最后一条"不是它。
        self.tool_index.insert(id, idx);
        self.pending_batch = Some(idx);
    }

    fn on_tool_completed(&mut self, id: &str, name: &str, output: &str) {
        let Some(&idx) = self.tool_index.get(id) else {
            return;
        };
        let failed = is_tool_error_output(output);
        let preview = summarize_tool_result(name, output);
        if let Some(Entry::ToolBatch(b)) = self.entries.get_mut(idx) {
            if let Some(item) = b.items.iter_mut().find(|i| i.id == id) {
                item.output = Some(output.to_string());
                item.failed = failed;
                item.done = true;
                // mutation 成功 → 渲染 diff 块,并让预览留空(diff 已经说明了一切,
                // 再叠一行 "N 行" 是噪音)。对齐 TS `writeToolResult`:`preview = diff ? '' : …`。
                item.diff_block = if failed {
                    None
                } else {
                    render_mutation_diff(name, &item.arguments)
                };
                item.result_summary = if item.diff_block.is_some() {
                    String::new()
                } else {
                    preview
                };
            } else {
                return;
            }
            if b.is_finished() && b.finished_ms.is_none() {
                b.finished_ms = Some(b.started_at.elapsed().as_millis() as u64);
            }
        }
        // mutation 独占批:结果一到立即收口并展开完整输出(TS `finishStandaloneBatch`)。
        if Self::is_mutation(name) {
            self.flush_tool_batch();
        }
    }

    fn batch_at(&self, idx: usize) -> Option<&ToolBatch> {
        match self.entries.get(idx) {
            Some(Entry::ToolBatch(b)) => Some(b),
            _ => None,
        }
    }

    fn begin_tool_batch(&mut self, standalone: bool) -> usize {
        self.entries.push(Entry::ToolBatch(ToolBatch::new(standalone)));
        self.content_dirty = true;
        self.entries.len() - 1
    }

    /// 收口当前开放的工具批。此后新工具会另起一批。
    ///
    /// 收口时:记完成时刻(摘要行显示耗时);mutation 独占批自动展开到完整输出
    /// —— 对应 TS `flushToolBatch` + `expandSingleEntryFully`。
    pub fn flush_tool_batch(&mut self) {
        let Some(idx) = self.pending_batch.take() else {
            return;
        };
        if let Some(Entry::ToolBatch(b)) = self.entries.get_mut(idx) {
            if b.finished_ms.is_none() {
                b.finished_ms = Some(b.started_at.elapsed().as_millis() as u64);
            }
            // mutation 独占批:展开第一层 + 该条完整输出,让 diff/内容立刻可见。
            if b.standalone && b.items.len() == 1 {
                b.expanded = true;
                if !b.detail_expanded.contains(&0) {
                    b.detail_expanded.push(0);
                }
            }
        }
        self.content_dirty = true;
    }

    // ────────────────────────── 展开 / 折叠 ──────────────────────────

    /// 内容区第 `view_row` 行(相对视口顶部)被点击:切换对应批的展开层级。
    /// 返回是否命中了可切换的行。
    pub fn click_content(&mut self, view_row: usize) -> bool {
        let Some(area) = self.content_area else {
            return false;
        };
        let width = area.width as usize;
        let content_row = (self.scroll + view_row).saturating_sub(self.content_prefix_lines);
        let tag = self
            .content(width)
            .tags
            .get(content_row)
            .copied()
            .unwrap_or(RowTag::Plain);
        match tag {
            RowTag::BatchSummary(idx) => {
                if let Some(Entry::ToolBatch(b)) = self.entries.get_mut(idx) {
                    b.expanded = !b.expanded;
                    if !b.expanded {
                        b.detail_expanded.clear();
                    }
                }
            }
            RowTag::BatchItem(idx, item) => {
                if let Some(Entry::ToolBatch(b)) = self.entries.get_mut(idx) {
                    if b.detail_expanded.contains(&item) {
                        b.detail_expanded.retain(|&i| i != item);
                    } else {
                        b.detail_expanded.push(item);
                    }
                }
            }
            RowTag::Plain => return false,
        }
        self.content_dirty = true;
        true
    }

    /// Tab 键:切换最后一个工具批的第一层展开(无鼠标时的等价操作)。
    pub fn toggle_last_tool(&mut self) {
        for idx in (0..self.entries.len()).rev() {
            if let Some(Entry::ToolBatch(b)) = self.entries.get_mut(idx) {
                if b.items.is_empty() {
                    continue;
                }
                b.expanded = !b.expanded;
                if !b.expanded {
                    b.detail_expanded.clear();
                }
                self.content_dirty = true;
                return;
            }
        }
    }

    // ────────────────────────── 滚动 ──────────────────────────

    /// 手动滚动。`delta` 为负(向上)时解除贴底跟随;滚回底部会自动恢复跟随。
    pub fn scroll_by(&mut self, delta: isize) {
        self.scroll = (self.scroll as isize + delta).max(0) as usize;
        if delta < 0 {
            self.stick_to_bottom = false;
        }
    }

    pub fn scroll_to_bottom(&mut self) {
        self.stick_to_bottom = true;
    }

    /// 每帧渲染前调用:把 scroll 夹到合法区间,并维护贴底跟随状态。
    pub fn clamp_scroll(&mut self, total_lines: usize, view_height: usize) {
        let max = total_lines.saturating_sub(view_height);
        if self.stick_to_bottom || self.scroll > max {
            self.scroll = max;
        }
        self.stick_to_bottom = self.scroll >= max;
    }

    // ────────────────────────── 渲染数据 ──────────────────────────

    /// 取当前宽度下的内容快照(已折行 + 行标签),带缓存。
    ///
    /// 渲染层据此得到精确总行数(用于滚动区间),再切片渲染 —— 不依赖
    /// `Paragraph::line_count`(ratatui 0.29 里它属于 unstable feature,不能引用)。
    pub fn content(&mut self, width: usize) -> &Content {
        let dirty = self.content_dirty;
        let hit = self
            .wrap_cache
            .as_ref()
            .is_some_and(|(w, _)| *w == width && !dirty);
        if !hit {
            let rows = self.build_rows(width);
            let mut tags = Vec::with_capacity(rows.len());
            let mut lines: Vec<Line<'static>> = Vec::with_capacity(rows.len() * 2);

            for row in &rows {
                let tag = row.1;
                let visual = crate::wrap::wrap_rows(
                    std::slice::from_ref(&row.0),
                    width,
                    theme::USER_BG,
                );
                for _ in 0..visual.len() {
                    tags.push(tag);
                }
                lines.extend(visual);
            }

            self.wrap_cache = Some((width, Content { lines, tags }));
            self.content_dirty = false;
        }
        // 上面已保证 Some
        &self.wrap_cache.as_ref().unwrap().1
    }

    /// 把 entries 展开成 `(行, 行标签)` 序列(未折行)。
    ///
    /// 布局与 TS 侧逐条对齐:用户消息是满宽气泡;工具调用先出一条批摘要行,
    /// 展开后才逐条列 `├─ name  summary  ↳ 预览`,再深一层是完整输出。
    ///
    /// `width` 供 markdown 渲染用(表格列宽、分隔线长度需要知道可用宽度)。
    fn build_rows(&self, width: usize) -> Vec<(Row, RowTag)> {
        let mut out: Vec<(Row, RowTag)> = Vec::with_capacity(self.entries.len() * 2);
        for (idx, entry) in self.entries.iter().enumerate() {
            match entry {
                Entry::User { text } => {
                    // 满宽气泡:首行 `❯ `,续行按 prompt 宽度缩进(TS formatUserMessage)。
                    for (i, line) in text.lines().enumerate() {
                        let prefix = if i == 0 { "❯ " } else { "  " };
                        out.push((
                            Row::bubble(Line::from(vec![
                                Span::styled(prefix, theme::prompt()),
                                Span::styled(line.to_string(), theme::input_text()),
                            ])),
                            RowTag::Plain,
                        ));
                    }
                    // 空文本也要占一行,否则用户敲个空行就"消失"了。
                    if text.lines().count() == 0 {
                        out.push((Row::bubble(Line::from("❯ ")), RowTag::Plain));
                    }
                    // submit() 已在用户消息后加入 Blank；只有没有显式分隔时才补一行，
                    // 避免用户消息与 assistant 正文之间出现两条空行。
                    if !matches!(self.entries.get(idx + 1), Some(Entry::Blank)) {
                        out.push((Row::plain(Line::from("")), RowTag::Plain));
                    }
                }
                Entry::Assistant { text } => {
                    // 正文走 markdown 渲染(标题/代码块/列表/行内样式着色)。
                    // 流式安全:每次重渲染整段,未闭合的 ``` fence 也照常显示。
                    for line in crate::markdown::render(text, width) {
                        out.push((Row::plain(line), RowTag::Plain));
                    }
                    out.push((Row::plain(Line::from("")), RowTag::Plain));
                }
                Entry::ToolBatch(b) => {
                    out.push((Row::plain(batch_summary_line(b, self.running)), RowTag::BatchSummary(idx)));
                    if b.expanded {
                        for (i, item) in b.items.iter().enumerate() {
                            out.push((
                                Row::plain(batch_item_line(b, item, i)),
                                RowTag::BatchItem(idx, i),
                            ));
                            if b.detail_expanded.contains(&i) {
                                for l in batch_detail_lines(b, item, i) {
                                    out.push((Row::plain(l), RowTag::Plain));
                                }
                            }
                        }
                    }
                    out.push((Row::plain(Line::from("")), RowTag::Plain));
                }
                Entry::ChangeOverview { files } => {
                    out.push((
                        Row::plain(Line::from(vec![
                            Span::styled("  ● ", theme::status_dot()),
                            Span::styled("文件变更", Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)),
                            Span::styled(format!("  {} 个文件", files.len()), theme::dim()),
                        ])),
                        RowTag::Plain,
                    ));
                    for f in files {
                        out.push((
                            Row::plain(Line::from(Span::styled(
                                format!("    · {f}"),
                                theme::dim(),
                            ))),
                            RowTag::Plain,
                        ));
                    }
                    out.push((Row::plain(Line::from("")), RowTag::Plain));
                }
                Entry::System { text, tone } => {
                    let color = tone.color();
                    let marker = match tone {
                        Tone::Accent | Tone::Success => "● ",
                        Tone::Error | Tone::Warn => "● ",
                        Tone::Info | Tone::Dim => "",
                    };
                    let mut spans = Vec::new();
                    if !marker.is_empty() {
                        spans.push(Span::styled(
                            format!("  {marker}"),
                            Style::default().fg(color).add_modifier(Modifier::BOLD),
                        ));
                        spans.push(Span::styled(text.clone(), Style::default().fg(color)));
                    } else {
                        spans.push(Span::styled(text.clone(), Style::default().fg(color)));
                    }
                    out.push((Row::plain(Line::from(spans)), RowTag::Plain));
                }
                Entry::Blank => {
                    out.push((Row::plain(Line::from("")), RowTag::Plain));
                }
            }
        }
        out
    }

    pub fn spinner_char(&self) -> &'static str {
        const FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        FRAMES[self.spinner_tick % FRAMES.len()]
    }
}

// ────────────────────────────── 工具批渲染 ──────────────────────────────
// 逐行对齐 TS `src/ui/batch.ts` 的 buildSummaryLine / buildExpandedLines /
// buildEntryDetailLines —— 缩进、树枝线、配色全部照搬,便于 A/B 对照。

/// 工具明细的树枝线:`├─` 中间 / `└─` 最后一条。
const BRANCH_MID: &str = "├─";
const BRANCH_LAST: &str = "└─";

/// 第二层详情的缩进:非末条对齐树枝线下方,末条落到 `└─` 之后。
fn detail_indent(is_last: bool) -> &'static str {
    if is_last {
        "       "
    } else {
        "    │  "
    }
}

/// 展开态完整输出的最大行数;超出截断,避免巨型输出撑爆视口。
const MAX_EXPAND_LINES: usize = 200;

/// 批摘要行:`  ● 探索  3  1.2s   read_file 1  glob 1`。
fn batch_summary_line(b: &ToolBatch, running: bool) -> Line<'static> {
    if b.items.is_empty() {
        return Line::from(vec![
            Span::styled("  ", Style::default()),
            Span::styled("◇", Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)),
            Span::styled(" 正在探索", Style::default().fg(theme::DIM)),
        ]);
    }

    // 同类工具合并计数,按首次出现顺序(TS 用 Map 插入序,这里等价)。
    let mut order: Vec<&str> = Vec::new();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for item in &b.items {
        let e = counts.entry(item.name.as_str()).or_insert(0);
        if *e == 0 {
            order.push(item.name.as_str());
        }
        *e += 1;
    }
    let parts: Vec<String> = order
        .iter()
        .map(|n| format!("{} {}", n, counts[n]))
        .collect();

    let tone = b.tone();
    let finished = b.is_finished();
    let done_count = b.finished_count();
    let total = b.items.len();

    let symbol = tone.symbol();
    let color = theme::batch_tone_color(tone);
    let label = tone.label();

    // 运行中实时显示进度 `1/3`;完成后显示总数 `3`。
    let progress = if running && !finished {
        format!("  {done_count}/{total}")
    } else {
        format!("  {total}")
    };
    // 耗时只在完成后显示。
    let elapsed = match b.finished_ms {
        Some(ms) => format!("  {}", format_elapsed_ms(ms)),
        None => String::new(),
    };

    Line::from(vec![
        Span::styled("  ", Style::default()),
        Span::styled(symbol, Style::default().fg(color).add_modifier(Modifier::BOLD)),
        Span::styled(format!(" {label}"), Style::default().fg(color)),
        Span::styled(progress, theme::dim()),
        Span::styled(elapsed, theme::dim()),
        Span::styled("  ", Style::default()),
        Span::styled(parts.join("  "), theme::dim()),
    ])
}

/// 第一层明细行:`    ├─ read_file  src/a.ts  ↳ 42 行`。
fn batch_item_line(b: &ToolBatch, item: &ToolItem, index: usize) -> Line<'static> {
    let branch = if index + 1 >= b.items.len() {
        BRANCH_LAST
    } else {
        BRANCH_MID
    };
    let mut spans = vec![
        Span::styled("    ", Style::default()),
        Span::styled(branch, Style::default().fg(theme::BRANCH)),
        Span::styled(" ", Style::default()),
    ];
    if item.failed {
        spans.push(Span::styled("× ", Style::default().fg(theme::ERROR)));
    }
    spans.push(Span::styled(
        item.name.clone(),
        Style::default().fg(theme::ACCENT),
    ));
    spans.push(Span::styled("  ", Style::default()));
    spans.push(Span::styled(item.summary.clone(), theme::dim()));
    if item.done && !item.result_summary.is_empty() {
        spans.push(Span::styled(
            format!("  ↳ {}", item.result_summary),
            Style::default().fg(theme::BRANCH),
        ));
    }
    Line::from(spans)
}

/// 第二层:mutation 的 diff 块,或工具完整输出(缩进 + 截断)。
fn batch_detail_lines(b: &ToolBatch, item: &ToolItem, index: usize) -> Vec<Line<'static>> {
    let indent = detail_indent(index + 1 >= b.items.len());
    let style = Style::default().fg(theme::DIM);

    // mutation 成功:显 diff 块而不是工具的纯文本回执 —— 后者只有一句
    // "已事务化写入 …",信息量远低于带行号的增删对照(对齐 TS `ui/batch.ts` 的 diffBlock 优先)。
    if let Some(diff) = item.diff_block.as_ref() {
        return diff
            .iter()
            .map(|line| {
                // 给 diff 的每一行套上批缩进:diff 自身只带块内缩进,
                // 外层的树枝对齐要在这里补,否则展开后会贴着左边缘。
                let mut spans = vec![Span::styled(indent.to_string(), style)];
                spans.extend(line.spans.iter().cloned());
                Line::from(spans)
            })
            .collect();
    }

    let Some(output) = item.output.as_ref() else {
        return Vec::new();
    };
    if output.trim().is_empty() {
        return Vec::new();
    }
    let raw: Vec<&str> = output.lines().collect();
    let truncated = raw.len() > MAX_EXPAND_LINES;
    let shown = if truncated { &raw[..MAX_EXPAND_LINES] } else { &raw[..] };
    let mut out: Vec<Line<'static>> = shown
        .iter()
        .map(|l| Line::from(Span::styled(format!("{indent}{l}"), style)))
        .collect();
    if truncated {
        out.push(Line::from(Span::styled(
            format!("{indent}… 还有 {} 行", raw.len() - MAX_EXPAND_LINES),
            style,
        )));
    }
    out
}

/// 毫秒 → 耗时串。与 TS `render.ts:fmtElapsed` 同规则(<10s 一位小数)。
pub fn format_elapsed_ms(ms: u64) -> String {
    let s = ms as f64 / 1000.0;
    if s < 10.0 {
        format!("{s:.1}s")
    } else if s < 60.0 {
        format!("{}s", s.round() as u64)
    } else {
        let m = (s / 60.0).floor() as u64;
        let rs = (s % 60.0).round() as u64;
        format!("{m}m {rs}s")
    }
}

/// 工具输出是否代表失败。与 TS `src/tools/result.ts:isToolErrorOutput` 同正则。
fn is_tool_error_output(output: &str) -> bool {
    let t = output.trim_start();
    t.starts_with("错误:") || t.starts_with("Error:")
}

/// 由 `tool_started` 缓存的参数渲染 mutation 工具的 diff 块。
///
/// 与 TS 的差别(协议决定的,不是偷工减料):
///  - **`write_file` 拿不到旧内容**。TS 在 agent 进程内读了写前快照(`preWriteOld`),
///    Rust 侧只有事件流,没有这个快照 —— 故 write_file 一律按"新建"渲染(全 `+` 行)。
///    这不会误报删除,是保守且诚实的展示。
///  - **`edit_file` 的行号从 1 起**。真实起始行要在文件里定位 `old_string`,
///    协议没给;行号在此仅作块内相对参考。
///
/// 参数缺失 / 非 mutation / JSON 解析失败 → None(调用方回落到普通结果预览)。
fn render_mutation_diff(name: &str, arguments: &str) -> Option<Vec<Line<'static>>> {
    let args: serde_json::Value = serde_json::from_str(arguments).ok()?;
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or_default();
    let path = s("path");
    if path.is_empty() {
        return None;
    }
    match name {
        "edit_file" => Some(crate::diff::render_file_change(
            path,
            crate::diff::Kind::Edit,
            Some(s("old_string")),
            s("new_string"),
            1,
        )),
        "write_file" => Some(crate::diff::render_file_change(
            path,
            crate::diff::Kind::Write,
            None, // 旧内容不可得(见上方说明),按新建渲染
            s("content"),
            1,
        )),
        _ => None,
    }
}

// ────────────────────────────── 工具摘要 ──────────────────────────────
// 对应 TS `src/ui/render.ts:312 summarizeToolCall` / `:348 summarizeToolResult`。
// 保持视觉一致,便于与 TS REPL 做 A/B 对照。

/// 按工具名挑出最能标识这次调用的参数,截断到 `limit` 个显示宽度。
pub fn summarize_tool_call(name: &str, args_raw: &str) -> String {
    let args: Option<serde_json::Value> = serde_json::from_str(args_raw).ok();
    let Some(args) = args else {
        return truncate_display(args_raw, 80);
    };
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();

    let raw = match name {
        "read_file" | "write_file" | "edit_file" => {
            if !s("path").is_empty() {
                s("path")
            } else {
                truncate_display(args_raw, 80)
            }
        }
        "run_command" => truncate_display(&if s("command").is_empty() { args_raw.to_string() } else { s("command") }, 100),
        "dev_server" => {
            let action = s("action");
            let detail = if !s("command").is_empty() {
                s("command")
            } else if !s("id").is_empty() {
                s("id")
            } else {
                s("readyUrl")
            };
            if !detail.is_empty() {
                format!("{action}  ·  {detail}")
            } else if !action.is_empty() {
                action
            } else {
                args_raw.to_string()
            }
        }
        // 刻意不显示 browser 的 fill value:可能是密码等敏感输入。
        "browser" => {
            let action = s("action");
            let detail = if !s("url").is_empty() {
                s("url")
            } else if !s("selector").is_empty() {
                s("selector")
            } else if !s("key").is_empty() {
                s("key")
            } else {
                s("sessionId")
            };
            if !detail.is_empty() {
                format!("{action}  ·  {detail}")
            } else if !action.is_empty() {
                action
            } else {
                args_raw.to_string()
            }
        }
        "glob" => s("pattern"),
        "grep" => {
            let p = s("pattern");
            let path = s("path");
            if !path.is_empty() {
                format!("{p}  ·  {path}")
            } else {
                p
            }
        }
        _ => truncate_display(args_raw, 80),
    };
    truncate_display(&raw, 100)
}

/// 工具结果的一行预览。喂给模型的全文不受影响,这里只控制屏显。
pub fn summarize_tool_result(name: &str, output: &str) -> String {
    let non_empty: Vec<&str> = output.lines().filter(|l| !l.trim().is_empty()).collect();
    let first = non_empty.first().copied().unwrap_or("");
    match name {
        "read_file" => {
            if non_empty.is_empty() {
                "(空文件)".to_string()
            } else {
                format!("{} 行", non_empty.len())
            }
        }
        "glob" => {
            if non_empty.is_empty() {
                "(无匹配)".to_string()
            } else {
                format!("{} 个文件", non_empty.len())
            }
        }
        "grep" => {
            if non_empty.is_empty() {
                "(无匹配)".to_string()
            } else {
                format!("{} 处匹配", non_empty.len())
            }
        }
        "run_command" => {
            let t = truncate_display(first, 100);
            if t.is_empty() {
                "(无输出)".to_string()
            } else {
                t
            }
        }
        _ => truncate_display(first, 100),
    }
}

/// 按**显示宽度**截断(东亚宽字符占 2 列),超出补 `…`。
///
/// 这是 TS 侧 `truncateDisplay` 的移植,实现在 `wrap::truncate_width` —— 与折行同属
/// "宽度不变量"范畴,集中一处维护。
#[inline]
pub fn truncate_display(s: &str, limit: usize) -> String {
    crate::wrap::truncate_width(s, limit)
}
