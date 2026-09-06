//! ratatui 渲染层 —— 可滚动 banner / 内容区 / 两段式脚栏(状态行+输入区+model 行) + 浮层。
//!
//! 布局对齐 TS `src/ui/layout.ts` 的两段式底栏:
//! ```text
//! ┌──────────────────────────────┐
//! │ banner + 内容区(共同滚动)     │
//! ├──────────────────────────────┤
//! │ ● 空闲                       │  <- spinner 行
//! │ ──────────────────────────── │  <- 输入框顶线
//! │ ❯ 输入...                    │  <- 输入框(可多行)
//! │ ──────────────────────────── │  <- 输入框底线
//! │ Auto Shift+Tab 切换 [bar] cwd│  <- model 行
//! └──────────────────────────────┘
//! ```
//! 与 TS 不同,ratatui 自动处理滚动区域,不需要手工维护 DECSTBM。

pub mod theme;

use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;

use crate::app::{App, RunStatus};
use crate::wrap::{display_width, pad_end, truncate_width};

/// 输入框最大占行数,超过则内容区被压缩而非无限撑高。
const MAX_INPUT_ROWS: usize = 6;

/// banner 高度:4 行 logo+信息 + 1 行空分隔。
const BANNER_ROWS: u16 = 5;
/// 显示 banner 所需的最小终端高度(留足内容区 + 脚栏)。
const BANNER_MIN_HEIGHT: u16 = 16;
/// 显示 banner 所需的最小终端宽度(logo 35 + 信息区)。
const BANNER_MIN_WIDTH: u16 = 50;

/// logo 区显示宽度,与 TS `src/ui/render.ts` 一致。
const LOGO_W: usize = 35;

pub fn draw(f: &mut Frame, app: &mut App) {
    let area = f.area();
    if area.width == 0 || area.height == 0 {
        return;
    }

    // 每帧先显式重置整块缓冲区，清除上一帧遗留的主题背景色。
    // 不指定背景色会让终端使用自身默认背景。
    f.buffer_mut().set_style(area, Style::reset());

    // 运行态推进 spinner 帧(每帧一步;渲染频率由主循环的 tick 控制)。
    if app.running {
        app.spinner_tick = app.spinner_tick.wrapping_add(1);
    }

    let input_rows = input_row_count(app, area.width);
    let footer_h = footer_height(input_rows, area.height);
    let content_h = area.height.saturating_sub(footer_h);
    let banner = if banner_visible(area.height, area.width, footer_h) {
        banner_lines(app, area.width as usize)
    } else {
        Vec::new()
    };

    // 保留三个 chunk 的形状，避免浮层依赖的 footer 下标变化；中间零高块不渲染。
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(content_h),
            Constraint::Length(0),
            Constraint::Length(footer_h),
        ])
        .split(area);

    draw_content(f, app, chunks[0], banner);
    draw_footer(f, app, chunks[2], input_rows);

    // 斜杠菜单浮层:向上覆盖内容区底部,不受输入框高度限制。
    // 对齐 TS `promptWithSlashMenu`:菜单行画在内容区底部、输入框上方的区域。
    if app.slash_menu.open {
        draw_slash_menu_overlay(f, app, area, &chunks);
    }

    // 浮层按优先级:审批 > 诊断(审批阻塞 agent,必须最上层)。
    if app.pending_approval.is_some() {
        draw_approval(f, app, area);
    } else if app.show_diagnostics {
        draw_diagnostics(f, app, area);
    }
}

// ────────────────────────────── banner ──────────────────────────────

fn banner_visible(total_h: u16, total_w: u16, footer_h: u16) -> bool {
    // 终端太矮或太窄时隐藏 banner,把空间留给内容和脚栏。
    total_h >= BANNER_MIN_HEIGHT
        && total_w >= BANNER_MIN_WIDTH
        && total_h > footer_h + BANNER_ROWS + 4
}

/// 生成内容区最前面的 banner 行。它不再单独占据固定矩形，而是和聊天记录共用滚动偏移。
fn banner_lines(app: &App, width: usize) -> Vec<Line<'static>> {
    let logo = [
        "                        ▄     ",
        "█▀█▀█ █▀▀█ ▄▄▄▄ ▄▄▄▄ ▄▄▄█ ▄▄▄▄",
        "█ █ █ █  █ █  ▀ █  █ █  █ █▄▄█",
        "▀ ▀ ▀ ▀▀▀▀ █▄▄█ █▄▄█ █▄▄█ █▄▄▄",
    ];

    let labels = ["模型", "目录", "记忆"];
    let label_w = labels.iter().map(|l| display_width(l)).max().unwrap_or(4) + 2;
    let value_w = width.saturating_sub(LOGO_W + label_w);

    let memory_label = if app.memory_enabled {
        "开启"
    } else {
        "关闭"
    };
    let memory_style = if app.memory_enabled {
        Style::default().fg(theme::ACCENT)
    } else {
        theme::dim()
    };

    let title = Line::from(vec![
        Span::styled("●  ", theme::status_dot()),
        Span::styled("MoCode", theme::banner_title()),
        Span::styled(format!("  v{}", env!("CARGO_PKG_VERSION")), theme::dim()),
    ]);

    let info_rows: Vec<Line<'static>> = vec![
        title,
        Line::from(vec![
            Span::styled(pad_end(labels[0], label_w), theme::banner_label()),
            Span::styled(
                truncate_width(app.display_model(), value_w),
                theme::banner_value(),
            ),
        ]),
        Line::from(vec![
            Span::styled(pad_end(labels[1], label_w), theme::banner_label()),
            Span::styled(
                truncate_width(&app.project_root, value_w),
                theme::banner_value(),
            ),
        ]),
        Line::from(vec![
            Span::styled(pad_end(labels[2], label_w), theme::banner_label()),
            Span::styled(memory_label.to_string(), memory_style),
        ]),
    ];

    let mut lines: Vec<Line<'static>> = Vec::with_capacity(BANNER_ROWS as usize);
    for (i, logo_line) in logo.into_iter().enumerate() {
        let mut spans = vec![Span::styled(pad_end(logo_line, LOGO_W), accent_style())];
        spans.extend(info_rows[i].spans.iter().cloned());
        lines.push(Line::from(spans));
    }
    // 保留 banner 与第一条聊天内容之间的一行呼吸感。
    lines.push(Line::from(""));
    lines
}

// accent 的纯样式版本(不加粗),用于 logo 块字符。
fn accent_style() -> Style {
    Style::default().fg(theme::ACCENT)
}

// ────────────────────────────── 内容区 ──────────────────────────────

fn draw_content(f: &mut Frame, app: &mut App, area: Rect, prefix: Vec<Line<'static>>) {
    let width = area.width as usize;
    let height = area.height as usize;
    app.content_prefix_lines = prefix.len();
    if width == 0 || height == 0 {
        app.content_area = None;
        return;
    }

    // 回填内容区矩形:鼠标点击要把它换算成内容行号(展开/折叠工具批)。
    app.content_area = Some(area);

    // banner 和聊天记录共享一份滚动偏移；贴底时新内容会把 banner 一同顶出视口。
    let total = prefix.len() + app.content(width).lines.len();
    app.clamp_scroll(total, height);
    let scroll = app.scroll;

    let visible: Vec<Line<'static>> = prefix
        .into_iter()
        .chain(app.content(width).lines.iter().cloned())
        .skip(scroll)
        .take(height)
        .collect();

    // 不再让 ratatui 折行:每个元素已经是宽度合规的视觉行(见 wrap.rs 注释)。
    // 不设段落背景,未显式着色的区域使用用户终端的默认背景。
    f.render_widget(Paragraph::new(visible), area);

    // 右侧滚动指示:内容溢出且未贴底时给个提示。
    if total > height && scroll + height < total {
        let hint = format!("↓ 还有 {} 行", total - scroll - height);
        let hint_w = display_width(&hint) as u16;
        if area.width > hint_w + 2 {
            let hint_area = Rect {
                x: area.x + area.width - hint_w - 1,
                y: area.y,
                width: hint_w + 1,
                height: 1,
            };
            f.render_widget(
                Paragraph::new(Line::from(Span::styled(hint, theme::dim()))),
                hint_area,
            );
        }
    }
}

// ────────────────────────────── 脚栏 ──────────────────────────────

fn footer_height(input_rows: u16, total_h: u16) -> u16 {
    // 脚栏 = 状态行 + 上分隔线 + 输入行 + 下分隔线 + model 行。
    let h = 4 + input_rows;
    h.min(total_h)
}

fn draw_footer(f: &mut Frame, app: &mut App, area: Rect, input_rows: u16) {
    if area.height == 0 || area.width == 0 {
        return;
    }
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),          // spinner 行
            Constraint::Length(1),          // 上分隔线
            Constraint::Length(input_rows), // 输入框
            Constraint::Length(1),          // 下分隔线
            Constraint::Length(1),          // model 行
        ])
        .split(area);

    draw_status_line(f, app, chunks[0]);
    draw_separator(f, chunks[1]);
    draw_input(f, app, chunks[2]);
    draw_separator(f, chunks[3]);
    draw_model_line(f, app, chunks[4]);
}

// ── spinner / 状态行 ──

fn draw_status_line(f: &mut Frame, app: &mut App, area: Rect) {
    let width = area.width as usize;
    if width == 0 {
        return;
    }

    let scrolled = !app.stick_to_bottom && app.scroll > 0;
    let status_label = if app.running && app.status == RunStatus::Idle {
        "生成中".to_string()
    } else {
        app.status.label().to_string()
    };

    let elapsed = app
        .turn_start
        .map(|t| format_elapsed(t.elapsed().as_millis() as u64))
        .unwrap_or_default();

    // 左段:帧/点 + 状态 + 走时
    let symbol = if app.running {
        app.spinner_char().to_string()
    } else {
        "●".to_string()
    };
    let symbol_style = if app.running {
        Style::default()
            .fg(theme::ACCENT)
            .add_modifier(Modifier::BOLD)
    } else {
        theme::status_dot()
    };

    let mut left_spans: Vec<Span<'static>> = vec![
        Span::styled(symbol, symbol_style),
        Span::styled(" ", Style::default()),
        Span::styled(status_label.clone(), theme::dim()),
    ];
    if !elapsed.is_empty() {
        left_spans.push(Span::styled(format!(" {}", elapsed), theme::dim()));
    }

    // 右段:仅滚动回看时显历史指示
    let right = if scrolled {
        let count = app.scroll;
        let text = format!("历史 ↑{} (PgDn 回底)", count);
        Span::styled(text, Style::default().fg(theme::WARN))
    } else {
        Span::styled("", Style::default())
    };

    let left_w: usize = left_spans.iter().map(|s| display_width(&s.content)).sum();
    let right_w = display_width(&right.content);

    let mut spans = left_spans;
    if left_w + right_w < width {
        let gap = width - left_w - right_w;
        spans.push(Span::styled(" ".repeat(gap), theme::status_bar()));
    }
    spans.push(right);

    f.render_widget(
        Paragraph::new(Line::from(spans)).style(theme::status_bar()),
        area,
    );
}

fn format_elapsed(ms: u64) -> String {
    if ms < 60_000 {
        format!("{}.{:.1}s", ms / 1000, (ms % 1000) / 100)
    } else {
        format!("{}:{:02}", ms / 60_000, (ms % 60_000) / 1000)
    }
}

// ── model 行 ──

fn draw_model_line(f: &mut Frame, app: &mut App, area: Rect) {
    let width = area.width as usize;
    if width == 0 {
        return;
    }

    // 左段:模式标识 + 切换提示 + 本轮 token chip
    let mut left_spans: Vec<Span<'static>> = Vec::new();
    let mut left_w = 0usize;

    if !app.mode_tag.is_empty() {
        let tag = app.mode_tag.clone();
        left_spans.push(Span::styled(
            tag.clone(),
            Style::default().fg(theme::ACCENT),
        ));
        left_w += display_width(&tag);

        let hint = " Shift+Tab 切换";
        left_spans.push(Span::styled(hint.to_string(), theme::dim()));
        left_w += display_width(hint);
    }

    let tok_chip = token_chip(app.last_usage.as_ref());
    if !tok_chip.is_empty() {
        if !left_spans.is_empty() {
            left_spans.push(Span::styled("  ", Style::default()));
            left_w += 2;
        }
        left_spans.push(Span::styled(tok_chip.clone(), theme::dim()));
        left_w += display_width(&tok_chip);
    }

    // 右段:context 用量条 + cwd
    let ctx_bar = context_bar(app.usage_percent, app.context_window);
    let cwd = truncate_width(&app.project_root, 40);
    let right_spans: Vec<Span<'static>> = vec![
        Span::styled(
            ctx_bar.clone(),
            Style::default().fg(usage_color(app.usage_percent)),
        ),
        Span::styled("  ", Style::default()),
        Span::styled(cwd, theme::dim()),
    ];
    let right_w: usize = right_spans.iter().map(|s| display_width(&s.content)).sum();

    let min_gap = 2usize;
    let mut spans = left_spans;
    if left_w + right_w + min_gap <= width {
        spans.push(Span::styled(
            " ".repeat(width - left_w - right_w),
            Style::default(),
        ));
        spans.extend(right_spans);
    } else {
        // 太窄:优先保留右段(context/cwd),左段截断。
        let budget = width.saturating_sub(right_w + min_gap);
        let mut acc = 0usize;
        let mut trimmed: Vec<Span<'static>> = Vec::new();
        for s in spans {
            let w = display_width(&s.content);
            if acc + w > budget {
                let room = budget.saturating_sub(acc);
                if room > 1 {
                    trimmed.push(Span::styled(truncate_width(&s.content, room), s.style));
                }
                break;
            }
            acc += w;
            trimmed.push(s);
        }
        let used: usize = trimmed.iter().map(|s| display_width(&s.content)).sum();
        if used + right_w < width {
            trimmed.push(Span::styled(
                " ".repeat(width - used - right_w),
                Style::default(),
            ));
        }
        trimmed.extend(right_spans);
        spans = trimmed;
    }

    f.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn context_bar(percent: u32, window: u64) -> String {
    let pct = percent.min(100) as usize;
    let filled = (pct * 10 / 100).min(10);
    let bar = format!(
        "[{}{}] {}%",
        "█".repeat(filled),
        "░".repeat(10 - filled),
        pct
    );
    if window == 0 {
        return bar;
    }
    let current = window * percent as u64 / 100;
    let fmt = |n: u64| -> String {
        if n >= 1_000_000 {
            format!("{:.1}M", n as f64 / 1_000_000.0)
        } else if n >= 1_000 {
            format!("{:.1}k", n as f64 / 1_000.0)
        } else {
            format!("{}", n)
        }
    };
    format!("{} {}/{}", bar, fmt(current), fmt(window))
}

fn token_chip(usage: Option<&crate::protocol::Usage>) -> String {
    let u = match usage {
        Some(u) if u.total_tokens > 0 => u,
        _ => return String::new(),
    };
    let n = u.total_tokens;
    let text = if n < 1000 {
        format!("{}", n)
    } else {
        format!("{:.1}k", n as f64 / 1000.0)
    };
    let cached = u.cached_tokens;
    if cached > 0 {
        let c = if cached < 1000 {
            format!("{}", cached)
        } else {
            format!("{:.1}k", cached as f64 / 1000.0)
        };
        format!("{} tokens ↻ {}", text, c)
    } else {
        format!("{} tokens", text)
    }
}

fn usage_color(percent: u32) -> ratatui::style::Color {
    theme::usage_color(percent)
}

// ── 分隔线 ──

fn draw_separator(f: &mut Frame, area: Rect) {
    if area.width == 0 {
        return;
    }
    let line = "─".repeat(area.width as usize);
    f.render_widget(
        Paragraph::new(Line::from(Span::styled(
            line,
            Style::default().fg(theme::ACCENT),
        ))),
        area,
    );
}

// ────────────────────────────── 斜杠菜单浮层 ──────────────────────────────

/// 斜杠菜单作为浮层向上展开到内容区底部,不受输入框高度限制。
/// 对齐 TS `promptWithSlashMenu`:菜单行覆盖在内容区上、输入框上方。
fn draw_slash_menu_overlay(f: &mut Frame, app: &mut App, _full_area: Rect, chunks: &[Rect]) {
    let term_w = f.area().width as usize;
    if term_w == 0 {
        return;
    }
    let menu_lines = app.slash_menu.render_lines(term_w);
    if menu_lines.is_empty() {
        return;
    }

    // footer 顶线(spinner 行)的位置 —— 菜单底贴着它上方。
    let footer_top = chunks[2].y;
    // 菜单最多可见行数。
    let max_vis = crate::commands::MENU_MAX_VISIBLE.min(menu_lines.len());
    let menu_h = max_vis as u16;

    // 向上展开:菜单底部 = footer 顶部 - 1(留一行给上分隔线)。
    let menu_bottom = footer_top.saturating_sub(1);
    let menu_top = menu_bottom.saturating_sub(menu_h);

    let menu_area = Rect {
        x: 0,
        y: menu_top,
        width: f.area().width,
        height: menu_h,
    };

    // 先 Clear 再画:菜单行覆盖内容区,不留残影。
    f.render_widget(Clear, menu_area);
    f.render_widget(
        Paragraph::new(menu_lines.into_iter().take(max_vis).collect::<Vec<_>>()),
        menu_area,
    );
}

// ────────────────────────────── 输入框 ──────────────────────────────

/// 输入区提示符 `❯ ` 的显示宽度 —— 高度预算与光标定位共用同一常量,
/// 两处一旦不一致,光标就会与文字错位(这是早期 bug 的成因之一)。
const PROMPT_W: usize = 2;

/// 输入框需要占几行。
///
/// 必须走 `wrap::count_rows` 而不是 `display_width(整串) / 宽度`:后者算不出
/// `\n` 硬换行(多行输入的高度会被算成 1 行,文字被裁掉)。
fn input_row_count(app: &App, term_width: u16) -> u16 {
    if term_width < PROMPT_W as u16 + 8 {
        return 1;
    }
    let rows = crate::wrap::count_rows(&app.input, term_width as usize, PROMPT_W);
    rows.clamp(1, MAX_INPUT_ROWS) as u16
}

fn draw_input(f: &mut Frame, app: &mut App, area: Rect) {
    // 斜杠菜单已作为浮层在 draw() 里单独渲染(draw_slash_menu_overlay),
    // 这里只画输入框本身。
    draw_input_body(f, app, area);
}

fn draw_input_body(f: &mut Frame, app: &mut App, area: Rect) {
    let usable = area.width as usize;
    if usable == 0 || area.height == 0 {
        return;
    }

    // 空输入时显示占位提示(不进 app.input,故不会被提交)。
    let (body, body_style) = if app.input.is_empty() {
        (
            "输入消息 · / 命令 · ↑ 历史 · Shift+Tab 切模式 · F1 诊断",
            theme::dim(),
        )
    } else {
        (&app.input[..], theme::input_text())
    };

    // 必须用 `Span::styled` 承载正文:`Line::from(String)` 在 ratatui 0.29 里走
    // `s.lines()`,会**静默丢掉 `\n`** —— 多行输入会被拼成一行。
    let logical = Line::from(vec![
        Span::styled("❯ ", theme::prompt()),
        Span::styled(body.to_string(), body_style),
    ]);

    // 用自己的折行(而非 ratatui Wrap),光标位置才能与之严格一致。
    let visual = crate::wrap::wrap_lines(&[logical], usable);

    // 光标只在非占位态定位(占位文本不是真实内容,光标应停在 "❯ " 右侧)。
    if app.input.is_empty() {
        let visible: Vec<Line<'static>> = visual.into_iter().take(area.height as usize).collect();
        f.render_widget(Paragraph::new(visible), area);
        f.set_cursor_position((area.x + PROMPT_W as u16, area.y));
        return;
    }

    let (row, col) = crate::wrap::locate_cursor(&app.input, app.cursor, usable, PROMPT_W);

    // 内容行数超过输入框高度(MAX_INPUT_ROWS 上限)时按光标滚动:
    // 始终保证光标所在行可见,否则用户在长文本里编辑会"看不见自己在打什么"。
    let height = area.height as usize;
    let top = row.saturating_sub(height.saturating_sub(1));
    let visible: Vec<Line<'static>> = visual.into_iter().skip(top).take(height).collect();
    f.render_widget(Paragraph::new(visible), area);

    let view_row = row - top;
    if view_row < height {
        f.set_cursor_position((area.x + col as u16, area.y + view_row as u16));
    }
}

// ────────────────────────────── 审批浮层 ──────────────────────────────

fn draw_approval(f: &mut Frame, app: &mut App, area: Rect) {
    let Some(pa) = app.pending_approval.as_ref() else {
        return;
    };
    let title = pa.title.clone();
    let detail = pa.detail.clone();
    let options = pa.options.clone();
    let selected = pa.selected;

    let box_w = 64.min(area.width.saturating_sub(4)).max(20);
    let box_h = (6 + options.len() as u16).min(area.height.saturating_sub(2));
    let popup = centered_rect(box_w, box_h, area);

    f.render_widget(Clear, popup);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(Span::styled(
            format!(" {title} "),
            Style::default()
                .fg(theme::WARN)
                .add_modifier(Modifier::BOLD),
        ))
        .style(Style::default().bg(theme::STATUS_BG));
    let inner = block.inner(popup);
    f.render_widget(block, popup);

    let mut lines: Vec<Line<'static>> = Vec::new();
    if !detail.is_empty() {
        for l in detail.lines().take(4) {
            lines.push(Line::from(Span::styled(
                truncate_width(l, inner.width as usize),
                theme::dim(),
            )));
        }
        lines.push(Line::from(""));
    }
    for (i, opt) in options.iter().enumerate() {
        let marker = if i == selected { "▸" } else { " " };
        let style = if i == selected {
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD)
        } else {
            theme::dim()
        };
        lines.push(Line::from(Span::styled(format!("{marker} {opt}"), style)));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "↑↓ 选择 · Enter 确认 · Esc 取消",
        theme::dim(),
    )));

    f.render_widget(Paragraph::new(lines).alignment(Alignment::Left), inner);
}

// ────────────────────────────── 诊断浮层 ──────────────────────────────

fn draw_diagnostics(f: &mut Frame, app: &mut App, area: Rect) {
    let box_h = (area.height * 40 / 100)
        .max(5)
        .min(area.height.saturating_sub(2));
    let box_w = area.width.saturating_sub(4).max(20);
    let popup = centered_rect(box_w, box_h, area);

    f.render_widget(Clear, popup);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(Span::styled(
            " agent-host 诊断(stderr) ",
            Style::default()
                .fg(theme::WARN)
                .add_modifier(Modifier::BOLD),
        ))
        .style(Style::default().bg(theme::STATUS_BG));
    let inner = block.inner(popup);
    f.render_widget(block, popup);

    let capacity = inner.height as usize;
    let lines: Vec<Line<'static>> = app
        .diagnostics
        .iter()
        .rev()
        .take(capacity)
        .rev()
        .map(|l| {
            Line::from(Span::styled(
                truncate_width(l, inner.width as usize),
                theme::dim(),
            ))
        })
        .collect();

    f.render_widget(Paragraph::new(lines), inner);
}

// ────────────────────────────── 工具 ──────────────────────────────

/// 居中的浮层矩形(ratatui 官方 recipe)。
fn centered_rect(width: u16, height: u16, area: Rect) -> Rect {
    Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + (area.height.saturating_sub(height)) / 2,
        width: width.min(area.width),
        height: height.min(area.height),
    }
}
