//! 文件改动 diff 渲染 —— TS `src/ui/diff.ts:renderFileChange` 的 Rust 版本。
//!
//! 输出直接是 ratatui `Line`(而非 TS 那样的 ANSI 串):渲染层已经是 span 模型,
//! 不需要"拼 SGR → 再解析 SGR"这道中间态。TS 侧 `renderBody` 里那一大段
//! "在每个 reset 后重发背景色"的补丁,在 span 模型下天然不存在。
//!
//! ## 视觉契约(与 TS 逐行对齐)
//! ```text
//!   Update(src/a.ts)
//!     +2 lines, -1 line
//!      12   ctx 行
//!      13 - 删除的行
//!      13 + 新增的行
//!     …(5 行不变)
//!     …(还有 3 行未显示)
//! ```
//!
//! ## 与 TS 的已知差异
//! **不做语法高亮**。TS 侧走 `cli-highlight`,Rust 侧要等价实现得引入
//! syntect/tree-sitter 这类重依赖(体积 + 编译时间),与"单文件小二进制"的取向冲突。
//! 行号 / gutter / 增删着色这些**结构性**信息都在,代码正文按普通文本色显示。

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::ui::theme;
use crate::wrap::{display_width, truncate_width};

/// 任一边超此行数则跳过全量 LCS —— 避免大文件上 O(n·m) 的 DP 卡住 UI 线程。
/// 与 TS `MAX_FULL_DIFF_LINES` 同值。
const MAX_FULL_DIFF_LINES: usize = 800;
/// 正文最多展示行数,超出走"还有 N 行未显示"尾注。
const MAX_BODY_LINES: usize = 24;
/// 单行代码的最大显示宽度,超出截断补 `…`。
const MAX_LINE_DISPLAY: usize = 120;

/// 行级 diff 操作。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Op {
    /// 上下文(两边相同)。
    Ctx,
    /// 新增。
    Add,
    /// 删除。
    Del,
}

#[derive(Clone, Debug)]
pub struct DiffLine {
    pub op: Op,
    pub text: String,
}

/// 折叠后的正文单元:连续不变行会被压成一条 `Ellipsis`。
#[derive(Clone, Debug)]
enum Item {
    Line { op: Op, text: String },
    /// `count` 行不变被折叠。
    Ellipsis { count: usize },
}

/// 文件改动的种类。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `edit_file`:局部替换。
    Edit,
    /// `write_file`:整文件覆盖或新建。
    Write,
}

/// 渲染一次文件改动。
///
/// - `old_text` 为 `None` 表示**新建**(头行用 `Create`,正文只有 `+` 行)。
/// - `start_line` 是 diff 首行对应的文件行号(`edit_file` 无法本地得知 old_string
///   在文件中的位置时传 1,行号仅作相对参考)。
/// - diff 规模超限时只出头行 + 省略提示,绝不阻塞渲染。
pub fn render_file_change(
    path: &str,
    kind: Kind,
    old_text: Option<&str>,
    new_text: &str,
    start_line: usize,
) -> Vec<Line<'static>> {
    let verb = if old_text.is_none() { "Create" } else { "Update" };
    let mut out = vec![head_line(verb, path)];

    // 新建:整个文件都是新增行,不需要跑 LCS。
    let Some(old_text) = old_text else {
        let added: Vec<&str> = split_lines(new_text);
        out.push(counts_line(added.len(), 0));
        let items: Vec<Item> = added
            .iter()
            .map(|l| Item::Line {
                op: Op::Add,
                text: (*l).to_string(),
            })
            .collect();
        out.extend(body_lines(&items, start_line, kind));
        return out;
    };

    let Some(ops) = line_diff(old_text, new_text) else {
        // 超大文件:给出明确原因,而不是静默什么都不显示。
        out.push(Line::from(Span::styled(
            "    …(文件过大,已省略 diff)".to_string(),
            theme::dim(),
        )));
        return out;
    };

    let added = ops.iter().filter(|d| d.op == Op::Add).count();
    let removed = ops.iter().filter(|d| d.op == Op::Del).count();
    out.push(counts_line(added, removed));
    out.extend(body_lines(&compact_ctx(&ops), start_line, kind));
    out
}

/// 头行:`  Update(src/a.ts)`。
fn head_line(verb: &str, path: &str) -> Line<'static> {
    Line::from(vec![
        Span::styled("  ", Style::default()),
        Span::styled(
            verb.to_string(),
            Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
        ),
        Span::styled("(", theme::dim()),
        Span::styled(path.to_string(), Style::default().fg(theme::ACCENT)),
        Span::styled(")", theme::dim()),
    ])
}

/// 计数行:`    +2 lines, -1 line`。
fn counts_line(added: usize, removed: usize) -> Line<'static> {
    let mut spans = vec![Span::styled("    ", Style::default())];
    if added > 0 {
        spans.push(Span::styled(
            format!("+{added} {}", line_word(added)),
            Style::default().fg(theme::SUCCESS),
        ));
    }
    if removed > 0 {
        if added > 0 {
            spans.push(Span::styled(", ", theme::dim()));
        }
        spans.push(Span::styled(
            format!("-{removed} {}", line_word(removed)),
            Style::default().fg(theme::ERROR),
        ));
    }
    if added == 0 && removed == 0 {
        spans.push(Span::styled("无有效改动".to_string(), theme::dim()));
    }
    Line::from(spans)
}

fn line_word(n: usize) -> &'static str {
    if n == 1 {
        "line"
    } else {
        "lines"
    }
}

/// 正文行:`     12 + 代码`。行号右对齐,gutter 着色,代码区按 op 上底色。
fn body_lines(items: &[Item], start_line: usize, _kind: Kind) -> Vec<Line<'static>> {
    // 行号列宽:按可能出现的最大行号定,避免正文左右抖动。
    let max_line = start_line + items.len() + items.iter().map(ellipsis_count).sum::<usize>();
    let pad_w = max_line.to_string().len();

    let mut out: Vec<Line<'static>> = Vec::new();
    let mut old_line = start_line;
    let mut new_line = start_line;
    let mut shown = 0usize;
    let mut overflow = 0usize;

    for item in items {
        if shown >= MAX_BODY_LINES {
            // 超限后仍要把行号推进(否则尾注之后若还有内容,行号会错),但不再产出行。
            match item {
                Item::Ellipsis { count } => {
                    old_line += count;
                    new_line += count;
                }
                Item::Line { op, .. } => match op {
                    Op::Del => old_line += 1,
                    Op::Add => new_line += 1,
                    Op::Ctx => {
                        old_line += 1;
                        new_line += 1;
                    }
                },
            }
            overflow += 1;
            continue;
        }
        match item {
            Item::Ellipsis { count } => {
                old_line += count;
                new_line += count;
                out.push(Line::from(Span::styled(
                    format!("    …({count} 行不变)"),
                    theme::dim(),
                )));
            }
            Item::Line { op, text } => {
                let num = match op {
                    Op::Del => old_line,
                    _ => new_line,
                };
                out.push(body_line(num, pad_w, *op, text));
                match op {
                    Op::Del => old_line += 1,
                    Op::Add => new_line += 1,
                    Op::Ctx => {
                        old_line += 1;
                        new_line += 1;
                    }
                }
            }
        }
        shown += 1;
    }

    if overflow > 0 {
        out.push(Line::from(Span::styled(
            format!("    …(还有 {overflow} 行未显示)"),
            theme::dim(),
        )));
    }
    out
}

fn ellipsis_count(item: &Item) -> usize {
    match item {
        Item::Ellipsis { count } => *count,
        Item::Line { .. } => 0,
    }
}

/// 单条正文行。行号与 gutter 不带底色,只有代码区带 —— 与 GitHub / VSCode 一致。
fn body_line(num: usize, pad_w: usize, op: Op, text: &str) -> Line<'static> {
    let (gutter, gutter_style, code_style) = match op {
        Op::Del => (
            "-",
            Style::default().fg(theme::ERROR),
            Style::default().fg(theme::TEXT).bg(theme::DEL_BG),
        ),
        Op::Add => (
            "+",
            Style::default().fg(theme::SUCCESS),
            Style::default().fg(theme::TEXT).bg(theme::ADD_BG),
        ),
        Op::Ctx => (" ", theme::dim(), Style::default().fg(theme::DIM)),
    };

    let mut code = text.to_string();
    let mut cut = false;
    if display_width(&code) > MAX_LINE_DISPLAY {
        code = truncate_width(&code, MAX_LINE_DISPLAY - 1);
        cut = true;
    }

    let mut spans = vec![
        Span::styled("    ", Style::default()),
        Span::styled(format!("{num:>pad_w$}"), theme::dim()),
        Span::styled(" ", Style::default()),
        Span::styled(gutter.to_string(), gutter_style),
        Span::styled(" ", Style::default()),
        Span::styled(code, code_style),
    ];
    if cut {
        spans.push(Span::styled("…".to_string(), theme::dim()));
    }
    Line::from(spans)
}

/// 连续不变行折叠:≤3 行全显,>3 行显首 + `…(n)` + 尾。
///
/// 保留紧邻改动的那一行上下文 —— 只看 `+`/`-` 行往往判断不了改动位置。
fn compact_ctx(ops: &[DiffLine]) -> Vec<Item> {
    let mut items: Vec<Item> = Vec::new();
    let mut i = 0usize;
    while i < ops.len() {
        if ops[i].op != Op::Ctx {
            items.push(Item::Line {
                op: ops[i].op,
                text: ops[i].text.clone(),
            });
            i += 1;
            continue;
        }
        let mut j = i;
        while j < ops.len() && ops[j].op == Op::Ctx {
            j += 1;
        }
        let run = &ops[i..j];
        if run.len() <= 3 {
            for r in run {
                items.push(Item::Line {
                    op: Op::Ctx,
                    text: r.text.clone(),
                });
            }
        } else {
            items.push(Item::Line {
                op: Op::Ctx,
                text: run[0].text.clone(),
            });
            items.push(Item::Ellipsis {
                count: run.len() - 2,
            });
            items.push(Item::Line {
                op: Op::Ctx,
                text: run[run.len() - 1].text.clone(),
            });
        }
        i = j;
    }
    items
}

/// 行级 LCS diff。任一边超 `MAX_FULL_DIFF_LINES` 返回 `None`(调用方降级)。
///
/// DP 表是 `(n+1) × (m+1)` 的 u16 矩阵,与 TS 侧同款自后向前填表 + 自前向后回溯。
pub fn line_diff(old_s: &str, new_s: &str) -> Option<Vec<DiffLine>> {
    let a = split_lines(old_s);
    let b = split_lines(new_s);
    if a.len() > MAX_FULL_DIFF_LINES || b.len() > MAX_FULL_DIFF_LINES {
        return None;
    }
    let n = a.len();
    let m = b.len();

    // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度。扁平化成一维,少一层间接。
    let stride = m + 1;
    let mut dp = vec![0u16; (n + 1) * stride];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i * stride + j] = if a[i] == b[j] {
                dp[(i + 1) * stride + (j + 1)] + 1
            } else {
                dp[(i + 1) * stride + j].max(dp[i * stride + (j + 1)])
            };
        }
    }

    let mut out: Vec<DiffLine> = Vec::new();
    let mut i = 0usize;
    let mut j = 0usize;
    while i < n && j < m {
        if a[i] == b[j] {
            out.push(DiffLine {
                op: Op::Ctx,
                text: a[i].to_string(),
            });
            i += 1;
            j += 1;
        } else if dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)] {
            out.push(DiffLine {
                op: Op::Del,
                text: a[i].to_string(),
            });
            i += 1;
        } else {
            out.push(DiffLine {
                op: Op::Add,
                text: b[j].to_string(),
            });
            j += 1;
        }
    }
    while i < n {
        out.push(DiffLine {
            op: Op::Del,
            text: a[i].to_string(),
        });
        i += 1;
    }
    while j < m {
        out.push(DiffLine {
            op: Op::Add,
            text: b[j].to_string(),
        });
        j += 1;
    }
    Some(out)
}

/// 按行切分:去掉末尾 `\n` 产生的空行,并剥掉行尾 `\r`(CRLF 兼容)。
///
/// 不做 CRLF 归一化会让整个文件被判成"全部改动" —— Windows 上这是常态。
fn split_lines(s: &str) -> Vec<&str> {
    let mut parts: Vec<&str> = s.split('\n').collect();
    if parts.len() > 1 && parts.last() == Some(&"") {
        parts.pop();
    }
    parts
        .into_iter()
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_of(line: &Line<'static>) -> String {
        line.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    fn texts(lines: &[Line<'static>]) -> Vec<String> {
        lines.iter().map(text_of).collect()
    }

    #[test]
    fn identical_text_yields_only_ctx() {
        let ops = line_diff("a\nb", "a\nb").unwrap();
        assert!(ops.iter().all(|d| d.op == Op::Ctx));
    }

    #[test]
    fn pure_insertion_is_detected() {
        let ops = line_diff("a\nc", "a\nb\nc").unwrap();
        let adds: Vec<&str> = ops
            .iter()
            .filter(|d| d.op == Op::Add)
            .map(|d| d.text.as_str())
            .collect();
        assert_eq!(adds, vec!["b"]);
        assert_eq!(ops.iter().filter(|d| d.op == Op::Del).count(), 0);
    }

    #[test]
    fn pure_deletion_is_detected() {
        let ops = line_diff("a\nb\nc", "a\nc").unwrap();
        let dels: Vec<&str> = ops
            .iter()
            .filter(|d| d.op == Op::Del)
            .map(|d| d.text.as_str())
            .collect();
        assert_eq!(dels, vec!["b"]);
    }

    #[test]
    fn replacement_shows_both_sides() {
        let ops = line_diff("a\nold\nc", "a\nnew\nc").unwrap();
        assert!(ops.iter().any(|d| d.op == Op::Del && d.text == "old"));
        assert!(ops.iter().any(|d| d.op == Op::Add && d.text == "new"));
    }

    #[test]
    fn crlf_does_not_look_like_a_full_rewrite() {
        // 关键:Windows 上 CRLF 若不剥掉,整个文件会被判成全量改动。
        let ops = line_diff("a\r\nb\r\n", "a\nb\n").unwrap();
        assert!(
            ops.iter().all(|d| d.op == Op::Ctx),
            "CRLF 与 LF 的同内容文件不应产生任何增删"
        );
    }

    #[test]
    fn trailing_newline_does_not_add_phantom_line() {
        assert_eq!(split_lines("a\nb\n"), vec!["a", "b"]);
        assert_eq!(split_lines("a\nb"), vec!["a", "b"]);
        // 空串是一行空行,不是零行 —— 否则新建空文件会显示"无改动"。
        assert_eq!(split_lines(""), vec![""]);
    }

    #[test]
    fn create_marks_every_line_as_added() {
        let out = render_file_change("a.rs", Kind::Write, None, "x\ny", 1);
        let t = texts(&out);
        assert!(t[0].contains("Create"), "新建应用 Create 而非 Update");
        assert!(t[1].contains("+2 lines"));
        assert!(t[2].contains('+') && t[2].contains('x'));
        assert!(t[3].contains('+') && t[3].contains('y'));
    }

    #[test]
    fn edit_uses_update_verb() {
        let out = render_file_change("a.rs", Kind::Edit, Some("x"), "y", 1);
        assert!(texts(&out)[0].contains("Update"));
    }

    #[test]
    fn singular_line_word() {
        let out = render_file_change("a.rs", Kind::Write, None, "only", 1);
        assert!(
            texts(&out)[1].contains("+1 line") && !texts(&out)[1].contains("+1 lines"),
            "1 行要用单数 line"
        );
    }

    #[test]
    fn long_context_run_is_collapsed() {
        // 10 行不变 + 1 行改动:中间的不变行应折成一条 …(n 行不变)。
        let old: String = (0..10).map(|i| format!("l{i}\n")).collect::<String>() + "tail";
        let new: String = (0..10).map(|i| format!("l{i}\n")).collect::<String>() + "TAIL";
        let out = render_file_change("a.rs", Kind::Edit, Some(&old), &new, 1);
        let joined = texts(&out).join("\n");
        assert!(joined.contains("行不变"), "长上下文应被折叠:\n{joined}");
    }

    #[test]
    fn short_context_run_is_kept_verbatim() {
        // 只有 2 行不变时不应折叠(折叠反而更长)。
        let out = render_file_change("a.rs", Kind::Edit, Some("a\nb\nx"), "a\nb\ny", 1);
        let joined = texts(&out).join("\n");
        assert!(!joined.contains("行不变"), "短上下文不该被折叠");
    }

    #[test]
    fn body_is_capped_and_reports_overflow() {
        let old = String::new();
        let new: String = (0..100).map(|i| format!("line{i}\n")).collect();
        let out = render_file_change("a.rs", Kind::Edit, Some(&old), &new, 1);
        let joined = texts(&out).join("\n");
        assert!(joined.contains("未显示"), "超长 diff 应给出未显示提示");
        // 头行 + 计数行 + MAX_BODY_LINES + 尾注
        assert!(out.len() <= MAX_BODY_LINES + 3, "正文行数必须被截断");
    }

    #[test]
    fn oversized_diff_is_skipped_not_hung() {
        // 超过 MAX_FULL_DIFF_LINES 时不跑 LCS(否则 O(n·m) 会卡住 UI)。
        let big: String = (0..MAX_FULL_DIFF_LINES + 10)
            .map(|i| format!("l{i}\n"))
            .collect();
        assert!(line_diff(&big, "x").is_none());
        let out = render_file_change("a.rs", Kind::Edit, Some(&big), "x", 1);
        assert!(texts(&out).join("\n").contains("省略 diff"));
    }

    #[test]
    fn long_line_is_truncated_with_ellipsis() {
        let long = "x".repeat(MAX_LINE_DISPLAY + 50);
        let out = render_file_change("a.rs", Kind::Write, None, &long, 1);
        let body = &texts(&out)[2];
        assert!(body.contains('…'), "超长行应补 …");
        assert!(
            display_width(body) <= MAX_LINE_DISPLAY + 12,
            "截断后仍然过宽: {}",
            display_width(body)
        );
    }

    #[test]
    fn line_numbers_start_at_given_offset() {
        let out = render_file_change("a.rs", Kind::Edit, Some("a"), "b", 42);
        let joined = texts(&out).join("\n");
        assert!(joined.contains("42"), "行号应从 start_line 起算:\n{joined}");
    }

    #[test]
    fn add_and_del_get_distinct_gutter_colors() {
        let out = render_file_change("a.rs", Kind::Edit, Some("old"), "new", 1);
        // 找到 gutter span(单字符 "-" / "+")并校验配色。
        let mut seen_del = false;
        let mut seen_add = false;
        for line in &out {
            for span in &line.spans {
                if span.content == "-" && span.style.fg == Some(theme::ERROR) {
                    seen_del = true;
                }
                if span.content == "+" && span.style.fg == Some(theme::SUCCESS) {
                    seen_add = true;
                }
            }
        }
        assert!(seen_del && seen_add, "增删 gutter 必须分别着绿/红");
    }

    #[test]
    fn spans_never_contain_newlines() {
        // 契约:交给 wrap 的行内不能含裸 '\n'(否则折行与光标定位会错位)。
        let out = render_file_change("a.rs", Kind::Edit, Some("a\nb\nc"), "a\nX\nc", 1);
        for line in &out {
            for span in &line.spans {
                assert!(!span.content.contains('\n'));
            }
        }
    }
}
