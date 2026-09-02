//! 斜杠命令菜单 —— 与 TS `src/ui/prompt.ts` 的 `promptWithSlashMenu` + `src/repl/index.ts` 的 `buildSlashCommands()` 完全对齐。
//!
//! 输入以 `/` 开头时自动弹出过滤菜单；↑↓ 导航、Tab 补全、Enter 提交、Esc 回到父级。
//! 分支节点（如 `/model`）选中后进入子菜单，叶子节点选中后补全并提交。

use crate::ui::theme;

/// 一棵斜杠命令菜单树。对齐 TS `SlashCommand` 接口。
#[derive(Debug, Clone)]
pub struct SlashCommand {
    /// 当前层显示的名称。根节点以 `/` 开头。
    pub name: &'static str,
    /// 描述。
    pub desc: &'static str,
    /// 叶子节点的实际命令文本；None 时用菜单路径。
    pub value: Option<&'static str>,
    /// false = 补全后留在输入态（需要继续输入参数）。
    pub submit: bool,
    /// 子菜单。
    pub children: &'static [SlashCommand],
}

impl SlashCommand {
    const fn leaf(name: &'static str, desc: &'static str) -> Self {
        Self {
            name,
            desc,
            value: None,
            submit: true,
            children: &[],
        }
    }
    const fn leaf_val(name: &'static str, value: &'static str, desc: &'static str) -> Self {
        Self {
            name,
            desc,
            value: Some(value),
            submit: true,
            children: &[],
        }
    }
    const fn leaf_no_submit(name: &'static str, value: &'static str, desc: &'static str) -> Self {
        Self {
            name,
            desc,
            value: Some(value),
            submit: false,
            children: &[],
        }
    }
    const fn branch(name: &'static str, desc: &'static str, children: &'static [SlashCommand]) -> Self {
        Self {
            name,
            desc,
            value: None,
            submit: true,
            children,
        }
    }
}

// ── /memory 子菜单 ──
static MEMORY_CHILDREN: &[SlashCommand] = &[
    SlashCommand::leaf_val("overview", "/memory", "条目计数与近期索引"),
    SlashCommand::leaf_val("toggle", "/memory_switch", "切换记忆子系统开关"),
    SlashCommand::leaf_val("on", "/memory_switch on", "开启记忆子系统"),
    SlashCommand::leaf_val("off", "/memory_switch off", "关闭记忆子系统"),
    SlashCommand::leaf_val("status", "/memory_status", "查看当前开关与原理"),
    SlashCommand::leaf_val("reflect", "/reflect", "手动触发后台记忆反思"),
];

// ── /subagent 子菜单 ──
static SUBAGENT_CHILDREN: &[SlashCommand] = &[
    SlashCommand::leaf_val("on", "/subagent on", "开启子 Agent"),
    SlashCommand::leaf_val("off", "/subagent off", "关闭子 Agent"),
    SlashCommand::leaf_val("status", "/subagent status", "查看子 Agent 状态"),
];

// ── /fe 子菜单 ──
static FE_CHILDREN: &[SlashCommand] = &[
    SlashCommand::leaf_val("on", "/fe on", "开启前端工具簇"),
    SlashCommand::leaf_val("off", "/fe off", "关闭前端工具簇"),
    SlashCommand::leaf_val("status", "/fe status", "查看前端工具簇状态"),
];

// ── /model 子菜单 ──
static MODEL_CHILDREN: &[SlashCommand] = &[
    SlashCommand::leaf_val("configure", "/model", "配置新模型（向导）"),
    SlashCommand::leaf_val("switch", "/model switch", "切换已配置预设"),
    SlashCommand::leaf_val("list", "/model list", "列出已配置模型"),
    SlashCommand::leaf_val("show", "/model show", "显示当前模型配置"),
    SlashCommand::leaf_no_submit("use <name>", "/model use ", "按名称应用预设"),
    SlashCommand::leaf_no_submit("delete <name>", "/model delete ", "删除指定预设"),
];

// ── /mode 子菜单 ──
static MODE_CHILDREN: &[SlashCommand] = &[
    SlashCommand::leaf_val("plan", "/plan", "只读探查并产出计划"),
    SlashCommand::leaf_val("auto", "/auto", "全工具自动执行"),
];

// ── /pet 子菜单 ──
static PET_CHILDREN: &[SlashCommand] = &[
    SlashCommand::leaf_val("toggle", "/pet", "显示或隐藏桌宠"),
    SlashCommand::leaf_val("skin", "/pet skin", "选择桌宠皮肤"),
    SlashCommand::leaf_val("quit", "/pet quit", "完全关闭桌宠进程"),
];

// ── /image 子菜单 ──
static IMAGE_CHILDREN: &[SlashCommand] = &[
    SlashCommand::leaf_no_submit("attach <path>", "/image ", "附加本地图片"),
    SlashCommand::leaf_val("list", "/image list", "列出待发送图片"),
    SlashCommand::leaf_val("clear", "/image clear", "清空待发送图片"),
];

// ── /language 子菜单 ──
static LANGUAGE_CHILDREN: &[SlashCommand] = &[
    SlashCommand::leaf_val("zh-CN", "/language zh-CN", "切换到中文"),
    SlashCommand::leaf_val("en", "/language en", "Switch to English"),
];

// ── /upgrade 子菜单 ──
static UPGRADE_CHILDREN: &[SlashCommand] = &[
    SlashCommand::leaf_val("now", "/upgrade", "立即升级"),
    SlashCommand::leaf_val("check", "/upgrade check", "检查当前版本与最新版本差异"),
    SlashCommand::leaf_val("status", "/upgrade status", "显示当前本地版本"),
];

/// 全部斜杠命令。与 TS `buildSlashCommands()` 逐条对齐。
///
/// Rust TUI 目前能**直接执行**的命令（/help /exit /clear /context /compact /diag 等）会本地处理；
/// 需要通过 agent-host 协议交互但尚不支持的（如 /resume /rollback /model switch 等）也**列在菜单里**，
/// 用户选中后会在内容区给出提示——与 TS 行为一致：菜单完整，不隐藏命令。
pub static COMMANDS: &[SlashCommand] = &[
    SlashCommand::leaf("/help", "查看所有命令"),
    SlashCommand::leaf("/exit", "退出 mocode（同 /quit）"),
    SlashCommand::leaf("/quit", "退出 mocode"),
    SlashCommand::leaf("/clear", "清空历史（保留系统提示）"),
    SlashCommand::leaf("/context", "显示上下文用量条"),
    SlashCommand::leaf("/skills", "列出已发现的 skill"),
    SlashCommand::leaf("/skill", "执行某个 skill (/skill <name> [args-json])"),
    SlashCommand::leaf("/compact", "压缩历史（可带焦点 /compact …）"),
    SlashCommand::leaf("/resume", "列出最近 10 个会话（/resume <id> 直接续接）"),
    SlashCommand::leaf("/sessions", "浏览全部已保存会话"),
    SlashCommand::leaf("/rollback", "菜单选轮次回滚（↑↓·Enter）"),
    SlashCommand::branch("/memory", "记忆库、开关与反思", MEMORY_CHILDREN),
    SlashCommand::leaf("/init", "扫描项目生成 AGENTS.md 项目记忆"),
    SlashCommand::branch("/subagent", "子 Agent 开关（默认关闭）", SUBAGENT_CHILDREN),
    SlashCommand::branch("/fe", "前端工具簇开关（默认关闭）", FE_CHILDREN),
    SlashCommand::leaf("/theme", "切换颜色主题（↑↓·Enter）"),
    SlashCommand::branch("/model", "模型配置与预设管理", MODEL_CHILDREN),
    SlashCommand::branch("/mode", "切换 Agent 工作模式", MODE_CHILDREN),
    SlashCommand::branch("/pet", "桌宠控制", PET_CHILDREN),
    SlashCommand::branch("/image", "管理下一条消息的图片", IMAGE_CHILDREN),
    SlashCommand::branch("/language", "切换界面与回复语言", LANGUAGE_CHILDREN),
    SlashCommand::branch("/upgrade", "升级 mocode 到最新版本", UPGRADE_CHILDREN),
    SlashCommand::leaf("/frontend", "前端工具簇快捷开关"),
];

/// 菜单项：节点 + 从根拼出的完整路径。
#[derive(Clone)]
pub struct MenuItem {
    pub node: &'static SlashCommand,
    pub input: String,
}

/// 菜单状态。由 `App` 持有，渲染层据此画向上展开的菜单行。
#[derive(Clone)]
pub struct SlashMenu {
    pub open: bool,
    pub filtered: Vec<MenuItem>,
    pub selected: usize,
    /// 菜单窗口顶部在 filtered 中的索引。
    pub top: usize,
}

impl Default for SlashMenu {
    fn default() -> Self {
        Self {
            open: false,
            filtered: Vec::new(),
            selected: 0,
            top: 0,
        }
    }
}

/// 菜单最多可见行数（向上展开进内容区底）。
pub const MENU_MAX_VISIBLE: usize = 7;

impl SlashMenu {
    pub fn close(&mut self) {
        self.open = false;
        self.filtered.clear();
        self.selected = 0;
        self.top = 0;
    }

    /// 根据输入文本更新过滤结果。只处理以 `/` 开头的首行。
    pub fn recompute(&mut self, input: &str) {
        let first_line = input.lines().next().unwrap_or(input);
        if !first_line.starts_with('/') {
            self.close();
            return;
        }

        let (nodes, prefix) = Self::menu_context(first_line);
        let prefix = prefix.as_str();

        self.filtered = nodes
            .iter()
            .map(|node| MenuItem {
                node,
                input: format!("{prefix}{}", node.name),
            })
            .filter(|item| item.input.starts_with(first_line))
            .collect();

        self.open = !self.filtered.is_empty();
        if self.selected >= self.filtered.len() {
            self.selected = 0;
            self.top = 0;
        }
        // 保 selected 在窗口内
        self.clamp_window();
    }

    /// 从输入文本找到当前菜单层（节点列表 + 已进入的分支前缀）。
    fn menu_context(input: &str) -> (Vec<&'static SlashCommand>, String) {
        let mut nodes: Vec<&'static SlashCommand> = COMMANDS.iter().collect();
        let mut prefix = String::new();
        loop {
            let branch = nodes.iter().find(|n| {
                !n.children.is_empty() && input.starts_with(&format!("{}{} ", prefix, n.name))
            });
            if let Some(b) = branch {
                prefix = format!("{}{} ", prefix, b.name);
                nodes = b.children.iter().collect();
            } else {
                return (nodes, prefix);
            }
        }
    }

    fn clamp_window(&mut self) {
        let vis = MENU_MAX_VISIBLE.min(self.filtered.len());
        if vis == 0 {
            self.top = 0;
            return;
        }
        if self.selected < self.top {
            self.top = self.selected;
        } else if self.selected >= self.top + vis {
            self.top = self.selected - vis + 1;
        }
    }

    pub fn move_up(&mut self) {
        if self.filtered.is_empty() {
            return;
        }
        let n = self.filtered.len();
        self.selected = (self.selected + n - 1) % n;
        self.clamp_window();
    }

    pub fn move_down(&mut self) {
        if self.filtered.is_empty() {
            return;
        }
        let n = self.filtered.len();
        self.selected = (self.selected + 1) % n;
        self.clamp_window();
    }

    /// Tab：补全选中项（不提交）。分支进入子菜单，叶子补全文本。
    /// 返回补全后的输入文本。
    pub fn complete_tab(&self) -> Option<String> {
        let item = self.filtered.get(self.selected)?;
        let value = item.node.value.unwrap_or(item.input.as_str());
        Some(value.to_string())
    }

    /// Enter：尝试提交选中项。
    /// 返回 `Some((text, should_submit))`：`should_submit=false` 表示只补全不提交。
    pub fn apply_selected(&self) -> Option<(String, bool)> {
        let item = self.filtered.get(self.selected)?;
        // 分支节点：补全 `path ` 进入子菜单（不提交）。
        if !item.node.children.is_empty() {
            return Some((format!("{} ", item.input), false));
        }
        let value = item.node.value.unwrap_or(item.input.as_str()).to_string();
        Some((value, item.node.submit))
    }

    /// Esc：有分支前缀时回到父级，否则关闭菜单。
    /// 返回 Some(text) 表示需要替换输入文本。
    pub fn escape(&self, input: &str) -> Option<String> {
        let (nodes, prefix) = Self::menu_context(input);
        let _ = nodes;
        if prefix.is_empty() {
            return None;
        }
        // 回到父级：去掉末尾的 ` name `
        let trimmed = prefix.trim_end();
        // 去掉最后一个 name 段
        let parent = trimmed.rsplit_once(' ').map(|(p, _)| p).unwrap_or("").to_string();
        Some(parent)
    }

    /// 渲染菜单行（预计算带色文本，由调用方贴入内容区底）。
    /// 对齐 TS `menuLines()`：选中项 cyan+bold + ▸，未选中项 dim。
    pub fn render_lines(&self, cols: usize) -> Vec<ratatui::text::Line<'static>> {
        use ratatui::style::{Modifier, Style};
        use ratatui::text::{Line, Span};
        use crate::wrap::{display_width, truncate_width};

        if !self.open || self.filtered.is_empty() {
            return Vec::new();
        }
        let visible_count = MENU_MAX_VISIBLE.min(self.filtered.len());
        let has_more_above = self.top > 0;
        let has_more_below = self.top + visible_count < self.filtered.len();
        let window = &self.filtered[self.top..self.top + visible_count];

        let max_name = window
            .iter()
            .map(|item| display_width(item.node.name) + if item.node.children.is_empty() { 0 } else { 2 })
            .max()
            .unwrap_or(0);

        window
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let global_idx = self.top + i;
                let is_sel = global_idx == self.selected;
                let branch_suffix = if item.node.children.is_empty() { "" } else { " ›" };
                let name_str = format!("{}{}", item.node.name, branch_suffix);
                let padded = {
                    let w = display_width(&name_str);
                    if w < max_name {
                        format!("{}{}", name_str, " ".repeat(max_name - w))
                    } else {
                        name_str
                    }
                };
                let mut scroll_hint = "";
                if i == 0 && has_more_above {
                    scroll_hint = " ▲";
                }
                if i == visible_count - 1 && has_more_below {
                    scroll_hint = " ▼";
                }
                let hint_w = display_width(scroll_hint);
                let desc_w = cols.saturating_sub(max_name + 5 + hint_w);
                let desc_str = if desc_w > 0 {
                    truncate_width(item.node.desc, desc_w)
                } else {
                    String::new()
                };

                let marker_str = if is_sel { "▸" } else { " " };
                let style = if is_sel {
                    Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)
                } else {
                    theme::dim()
                };
                let marker_style = if is_sel {
                    Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)
                } else {
                    Style::default()
                };

                Line::from(vec![
                    Span::styled(marker_str.to_string(), marker_style),
                    Span::styled(" ", Style::default()),
                    Span::styled(padded, style),
                    Span::styled("  ", Style::default()),
                    Span::styled(desc_str, style),
                    Span::styled(scroll_hint.to_string(), theme::dim()),
                ])
            })
            .collect()
    }
}
