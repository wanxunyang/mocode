//! 配色与样式。对齐 TS `src/ui/theme.ts` 的观感。
//!
//! 默认采用 TS 侧 `orange` 主题:深暖棕黑底 + 南瓜橙强调色,
//! 与现有截图(大写 mocode logo、橙色标题、暖灰文字)保持一致。
//! 后续若需支持多主题切换,可把本模块改成 `Theme` 结构体 + 全局当前主题。

use ratatui::style::{Color, Modifier, Style};

/// 主题主色(accent):承载 logo、标题 ●、输入框顶线、状态栏 ● 等关键锚点。
pub const ACCENT: Color = Color::Rgb(0xff, 0xaa, 0x3c); // 南瓜橙 #ffaa3c

/// 次级强调色(偏金黄),用于点亮但不抢主色的元素。
pub const AMBER: Color = Color::Rgb(0xff, 0xc4, 0x3c);

/// 正文色:柔和白,避免纯白刺眼。
pub const TEXT: Color = Color::Rgb(0xe8, 0xe0, 0xd8);

/// 弱色/辅助说明文字。
pub const DIM: Color = Color::Rgb(0x96, 0x82, 0x6e);

/// 应用画布填充色(内容区/侧边的整片底色,ratatui 需显式填充空格背景)。
///
/// 注意:这只是**我们画出的区域**的底色,不是终端窗口背景 —— 我们不下发 OSC 11,
/// 终端窗口底色保持用户终端原色(见 `main.rs` 的注释)。
pub const TERMINAL_BG: Color = Color::Rgb(0x23, 0x1c, 0x16);

/// 状态栏/浮层底色:比终端背景稍亮的深棕,形成面板感。
pub const STATUS_BG: Color = Color::Rgb(0x2e, 0x24, 0x1c);

/// 用户消息满宽底色。与 TS `theme.ts` 各主题的 `userBg` 同值(灰蓝底,黑底下可辨)。
pub const USER_BG: Color = Color::Rgb(0x48, 0x4e, 0x5a);

/// 工具批明细的树枝线 `├─` / `└─` 与结果预览 `↳` 的颜色。
pub const BRANCH: Color = Color::Rgb(0x6e, 0x60, 0x50);

pub const SUCCESS: Color = Color::Rgb(0x96, 0xc8, 0x73);
pub const WARN: Color = Color::Rgb(0xff, 0xaa, 0x3c);
pub const ERROR: Color = Color::Rgb(0xff, 0x69, 0x5a);
pub const INFO: Color = Color::Rgb(0x78, 0xaa, 0xe6);

/// diff 新增行的代码区底色(对齐 TS `theme.ts` 的 `addBg`)。
/// 只铺在代码区,行号与 gutter 不着底色 —— 与 GitHub / VSCode 的观感一致。
pub const ADD_BG: Color = Color::Rgb(0x1e, 0x3a, 0x24);

/// diff 删除行的代码区底色(对齐 TS `theme.ts` 的 `delBg`)。
pub const DEL_BG: Color = Color::Rgb(0x45, 0x1e, 0x1e);

pub fn prompt() -> Style {
    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
}

pub fn input_text() -> Style {
    Style::default().fg(TEXT)
}

pub fn dim() -> Style {
    Style::default().fg(DIM)
}

pub fn status_bar() -> Style {
    Style::default().fg(TEXT).bg(STATUS_BG)
}

/// 上下文用量条:按百分比取色(低=绿 / 中=黄 / 高=红)。
pub fn usage_color(percent: u32) -> Color {
    match percent {
        0..=49 => SUCCESS,
        50..=79 => WARN,
        _ => ERROR,
    }
}

/// 工具名前缀 `●` / `◐` 的颜色:运行中=黄,完成=绿。
pub fn tool_marker(running: bool) -> Style {
    if running {
        Style::default().fg(WARN)
    } else {
        Style::default().fg(SUCCESS)
    }
}

/// 工具批摘要行的状态配色。对齐 TS `ui/batch.ts:buildSummaryLine`。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BatchTone {
    /// 还有 item 未拿到结果(或批尚无 item)。
    Running,
    /// 全部失败。
    Failed,
    /// 部分失败。
    Partial,
    /// 全部成功。
    Done,
}

impl BatchTone {
    /// 摘要行符号:`◇` 进行中 / `×` 全失败 / `!` 部分失败 / `●` 完成。
    pub fn symbol(&self) -> &'static str {
        match self {
            Self::Running => "◇",
            Self::Failed => "×",
            Self::Partial => "!",
            Self::Done => "●",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Running => "正在探索",
            Self::Failed => "探索失败",
            Self::Partial | Self::Done => "探索",
        }
    }
}

pub fn batch_tone_color(tone: BatchTone) -> Color {
    match tone {
        BatchTone::Running => ACCENT,
        BatchTone::Failed => ERROR,
        BatchTone::Partial => WARN,
        BatchTone::Done => SUCCESS,
    }
}

/// banner 标题样式:粗体 + 强调色。
pub fn banner_title() -> Style {
    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
}

/// banner 标签(模型/目录/记忆)样式。
pub fn banner_label() -> Style {
    Style::default().fg(DIM)
}

/// banner 值样式。
pub fn banner_value() -> Style {
    Style::default().fg(TEXT)
}

/// 状态标记 `●` 的强调色样式。
pub fn status_dot() -> Style {
    Style::default().fg(ACCENT)
}
