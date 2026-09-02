//! 助手正文的 markdown 渲染 —— `src/ui/markdown.ts` 的 Rust 移植。
//!
//! ## 与 TS 版的关键差异
//! TS 版的产物是**内嵌 ANSI 转义的字符串**(因为它直出 stdout),于是不得不额外实现
//! 「ANSI 感知的宽度计算 / 折行 / 截断」三件套(`wrapAnsiString` / `clipAnsiLine`)。
//! 这里产物是 ratatui 的 `Line<'static>`(样式是结构化的 `Style`,不在字符串里),
//! 所以:
//!   - **不需要** ANSI 折行:折行交给 `wrap.rs`,样式自动随 `Span` 保留;
//!   - **不需要** reset 兜底:样式不会跨行泄漏,这类 bug 在类型层面就不存在。
//!
//! 因此本模块只负责「markdown → 带样式的逻辑行」,宽度不变量仍由 `wrap.rs` 统一保证。
//!
//! ## 未移植的部分
//! 代码块的**语法高亮**没有移植:TS 侧靠 `cli-highlight`(hljs 的 JS 实现),Rust 侧
//! 对等物(syntect)会带上一套语法定义资源,与「单文件小体积二进制」的取向冲突。
//! 这里代码块走统一的 code 配色 + 语言标签 + 2 空格 gutter,结构信息完整保留。

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::ui::theme;
use crate::wrap::display_width;

/// 行内代码的配色(对齐 TS 的 `ui.yellow`)。
fn code_style() -> Style {
    Style::default().fg(theme::AMBER)
}

/// 链接文字的配色(对齐 TS 的 `ui.cyan`)。
fn link_style() -> Style {
    Style::default().fg(theme::INFO)
}

/// 标题配色:1 级最亮,2 级次之,3 级以下弱化 —— 与 TS 的
/// `brightCyan / cyan / gray` 分档一一对应。
fn heading_style(level: usize) -> Style {
    let color = match level {
        0 | 1 => theme::ACCENT,
        2 => theme::AMBER,
        _ => theme::DIM,
    };
    Style::default().fg(color).add_modifier(Modifier::BOLD)
}

/// 把一段 markdown 文本渲染成带样式的**逻辑行**(不折行 —— 交给 `wrap.rs`)。
///
/// `cols` 只用于水平分隔线这类需要铺满宽度的元素;其余元素的宽度约束由折行层负责。
pub fn render(text: &str, cols: usize) -> Vec<Line<'static>> {
    let src: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<Line<'static>> = Vec::new();

    let mut i = 0usize;
    let mut in_fence = false;
    let mut fence_char = ' ';
    let mut lang = String::new();
    let mut code_buf: Vec<String> = Vec::new();
    let mut para: Vec<&str> = Vec::new();
    let mut prev_blank = false;

    while i < src.len() {
        let line = src[i];

        // ── 代码围栏(``` 或 ~~~,≥3 个)──
        if let Some((fc, info)) = match_fence(line) {
            if !in_fence {
                flush_para(&mut para, &mut out, &mut prev_blank);
                in_fence = true;
                fence_char = fc;
                lang = info;
                code_buf.clear();
            } else if fc == fence_char {
                flush_code(&mut code_buf, &lang, &mut out, &mut prev_blank);
                in_fence = false;
                fence_char = ' ';
                lang.clear();
            } else {
                // 不同围栏字符:属于代码内容,不收口。
                code_buf.push(line.to_string());
            }
            i += 1;
            continue;
        }
        if in_fence {
            code_buf.push(line.to_string());
            i += 1;
            continue;
        }

        // ── 空行(折叠连续空行)──
        if line.trim().is_empty() {
            flush_para(&mut para, &mut out, &mut prev_blank);
            if !prev_blank {
                out.push(Line::from(""));
            }
            prev_blank = true;
            i += 1;
            continue;
        }

        // ── 水平分隔线:--- / *** / ___ / - - - ──
        if is_thematic_break(line) {
            flush_para(&mut para, &mut out, &mut prev_blank);
            out.push(Line::from(Span::styled(
                "─".repeat(cols.max(1)),
                theme::dim(),
            )));
            out.push(Line::from(""));
            prev_blank = true;
            i += 1;
            continue;
        }

        // ── ATX 标题 #(1-6 级)──
        if let Some((level, body)) = match_heading(line) {
            flush_para(&mut para, &mut out, &mut prev_blank);
            out.push(Line::from(inline_with_base(&body, heading_style(level))));
            out.push(Line::from(""));
            prev_blank = true;
            i += 1;
            continue;
        }

        // ── 引用块 > ──
        if let Some(body) = line.strip_prefix('>') {
            flush_para(&mut para, &mut out, &mut prev_blank);
            let body = body.strip_prefix(' ').unwrap_or(body);
            let mut spans = vec![
                Span::styled("  ", Style::default()),
                Span::styled("│ ", theme::dim()),
            ];
            spans.extend(inline(body));
            out.push(Line::from(spans));
            prev_blank = false;
            i += 1;
            continue;
        }

        // ── 无序列表 - * + ──
        if let Some((indent, body)) = match_bullet(line) {
            flush_para(&mut para, &mut out, &mut prev_blank);
            // 缩进 ≥2 视为次级条目,换用空心圆点(与 TS 同规则)。
            let bullet = if indent >= 2 { "◦ " } else { "• " };
            let mut spans = vec![
                Span::styled(" ".repeat(indent), Style::default()),
                Span::styled(bullet, Style::default().fg(theme::ACCENT)),
            ];
            spans.extend(inline(&body));
            out.push(Line::from(spans));
            prev_blank = false;
            i += 1;
            continue;
        }

        // ── 有序列表 1. ──
        if let Some((indent, num, body)) = match_ordered(line) {
            flush_para(&mut para, &mut out, &mut prev_blank);
            let mut spans = vec![
                Span::styled(" ".repeat(indent), Style::default()),
                Span::styled(format!("{num}. "), Style::default().fg(theme::ACCENT)),
            ];
            spans.extend(inline(&body));
            out.push(Line::from(spans));
            prev_blank = false;
            i += 1;
            continue;
        }

        // ── GFM 表格:表头(≥2 列)+ 紧跟 |---| 分隔行 ──
        if line.contains('|') {
            let header = parse_table_row(line);
            if header.len() >= 2 && i + 1 < src.len() {
                let sep = parse_table_row(src[i + 1]);
                if sep.len() == header.len() && sep.iter().all(|c| is_align_cell(c)) {
                    flush_para(&mut para, &mut out, &mut prev_blank);
                    i += 2;
                    let mut rows: Vec<Vec<String>> = Vec::new();
                    while i < src.len() {
                        let r = src[i];
                        if r.trim().is_empty() || !r.contains('|') {
                            break;
                        }
                        rows.push(parse_table_row(r));
                        i += 1;
                    }
                    out.extend(render_table(&header, &rows));
                    out.push(Line::from(""));
                    prev_blank = true;
                    continue;
                }
            }
        }

        // ── 段落:连续非空行累积,flush 时按空格拼接 ──
        para.push(line);
        prev_blank = false;
        i += 1;
    }

    flush_para(&mut para, &mut out, &mut prev_blank);
    // EOF 仍在围栏内 —— 流式输出停在未闭合的 ``` 中段,把已累积的代码照常渲染出来
    // (边生成边显,与 TS 同策略)。
    if in_fence {
        flush_code(&mut code_buf, &lang, &mut out, &mut prev_blank);
    }

    // 首尾空行由调用方(批边界 / 轮次边界)统一管理,这里不自带。
    while out.first().is_some_and(is_blank_line) {
        out.remove(0);
    }
    while out.last().is_some_and(is_blank_line) {
        out.pop();
    }
    out
}

fn is_blank_line(line: &Line<'static>) -> bool {
    line.spans.iter().all(|s| s.content.trim().is_empty())
}

fn flush_para(para: &mut Vec<&str>, out: &mut Vec<Line<'static>>, prev_blank: &mut bool) {
    if para.is_empty() {
        return;
    }
    let joined = para.join(" ");
    out.push(Line::from(inline(&joined)));
    out.push(Line::from(""));
    para.clear();
    *prev_blank = true;
}

fn flush_code(
    code_buf: &mut Vec<String>,
    lang: &str,
    out: &mut Vec<Line<'static>>,
    prev_blank: &mut bool,
) {
    if !lang.is_empty() {
        out.push(Line::from(vec![
            Span::styled("  ", Style::default()),
            Span::styled(lang.to_string(), theme::dim()),
        ]));
    }
    for l in code_buf.iter() {
        out.push(Line::from(vec![
            Span::styled("  ", Style::default()),
            Span::styled(l.clone(), Style::default().fg(theme::TEXT)),
        ]));
    }
    out.push(Line::from(""));
    code_buf.clear();
    *prev_blank = true;
}

// ────────────────────────────── 块级模式匹配 ──────────────────────────────
// TS 侧用正则;这里手写扫描,避免为几个模式引入 regex 依赖(编译期与体积都更划算)。

/// 反引号或波浪号围栏(≥3 个)。返回 (围栏字符, info 串即语言名)。
///
/// 注意别在这行文档注释里裸写三个反引号 —— rustdoc 会把它当成代码块起始,
/// 把后面的中文当作代码块属性并报 `invalid_codeblock_attributes` 警告。
fn match_fence(line: &str) -> Option<(char, String)> {
    let trimmed = line.trim_start();
    for fc in ['`', '~'] {
        let run = trimmed.chars().take_while(|c| *c == fc).count();
        if run >= 3 {
            return Some((fc, trimmed[run..].trim().to_string()));
        }
    }
    None
}

/// `#{1,6} 正文` 标题。返回 (级别, 正文)。
fn match_heading(line: &str) -> Option<(usize, String)> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &line[hashes..];
    // `#foo` 不是标题,`# foo` 才是(与 CommonMark 一致)。
    let body = rest.strip_prefix(' ')?;
    Some((hashes, body.trim_start().to_string()))
}

/// `---` / `***` / `___` / `- - -` 水平分隔线(同字符 ≥3 个,其余只能是空白)。
fn is_thematic_break(line: &str) -> bool {
    let t = line.trim();
    let Some(first) = t.chars().next() else {
        return false;
    };
    if !matches!(first, '-' | '*' | '_') {
        return false;
    }
    let count = t.chars().filter(|c| *c == first).count();
    count >= 3 && t.chars().all(|c| c == first || c.is_whitespace())
}

/// `- ` / `* ` / `+ ` 无序列表项。返回 (缩进列数, 正文)。
fn match_bullet(line: &str) -> Option<(usize, String)> {
    let indent = line.chars().take_while(|c| *c == ' ').count();
    let rest = &line[indent..];
    let mut chars = rest.chars();
    let marker = chars.next()?;
    if !matches!(marker, '-' | '*' | '+') {
        return None;
    }
    if chars.next()? != ' ' {
        return None;
    }
    Some((indent, rest[2..].to_string()))
}

/// `1. ` 有序列表项。返回 (缩进列数, 序号串, 正文)。
fn match_ordered(line: &str) -> Option<(usize, String, String)> {
    let indent = line.chars().take_while(|c| *c == ' ').count();
    let rest = &line[indent..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let after = &rest[digits.len()..];
    let body = after.strip_prefix(". ")?;
    Some((indent, digits, body.to_string()))
}

// ────────────────────────────── GFM 表格 ──────────────────────────────

/// 拆表格行:去掉首尾 `|` 后按 `|` 切分,每格 trim。
fn parse_table_row(line: &str) -> Vec<String> {
    let mut s = line.trim();
    s = s.strip_prefix('|').unwrap_or(s);
    s = s.strip_suffix('|').unwrap_or(s);
    s.split('|').map(|c| c.trim().to_string()).collect()
}

/// 分隔行的单格是否形如 `---` / `:--` / `--:` / `:-:`。
fn is_align_cell(cell: &str) -> bool {
    let t = cell.trim();
    let core = t.trim_start_matches(':').trim_end_matches(':');
    !core.is_empty() && core.chars().all(|c| c == '-')
}

/// 渲染表格:按各列最大显示宽度对齐,表头加粗,分隔线走 dim。
///
/// 不做「超宽等分 + 单元格内折行」(TS 版有):Rust 侧折行发生在 `wrap.rs`,
/// 表格过宽时会被软折,结构仍可读 —— 换取实现复杂度大幅下降。
fn render_table(header: &[String], rows: &[Vec<String>]) -> Vec<Line<'static>> {
    let cols = header.len();
    let mut widths: Vec<usize> = header.iter().map(|c| display_width(c)).collect();
    for row in rows {
        for (i, cell) in row.iter().enumerate().take(cols) {
            widths[i] = widths[i].max(display_width(cell));
        }
    }

    let pad = |text: &str, w: usize| -> String {
        let cw = display_width(text);
        format!("{}{}", text, " ".repeat(w.saturating_sub(cw)))
    };

    let mut out: Vec<Line<'static>> = Vec::new();

    // 表头
    let mut spans = vec![Span::styled("  ", Style::default())];
    for (i, cell) in header.iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled(" │ ", theme::dim()));
        }
        spans.push(Span::styled(
            pad(cell, widths[i]),
            Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
        ));
    }
    out.push(Line::from(spans));

    // 分隔线
    let rule: Vec<String> = widths.iter().map(|w| "─".repeat(*w)).collect();
    out.push(Line::from(vec![
        Span::styled("  ", Style::default()),
        Span::styled(rule.join("─┼─"), theme::dim()),
    ]));

    // 数据行
    for row in rows {
        let mut spans = vec![Span::styled("  ", Style::default())];
        for i in 0..cols {
            if i > 0 {
                spans.push(Span::styled(" │ ", theme::dim()));
            }
            let cell = row.get(i).map(String::as_str).unwrap_or("");
            // 单元格内容本身可带内联样式(如 `code`),但要先补齐宽度再解析会破坏对齐,
            // 故这里按纯文本对齐 —— 表格里的强调标记按字面量显示。
            spans.push(Span::styled(
                pad(cell, widths[i]),
                Style::default().fg(theme::TEXT),
            ));
        }
        out.push(Line::from(spans));
    }
    out
}

// ────────────────────────────── 内联解析 ──────────────────────────────

/// 内联 markdown → 带样式 span 序列(默认样式)。
pub fn inline(text: &str) -> Vec<Span<'static>> {
    inline_with_base(text, Style::default())
}

/// 内联解析,所有产物叠加 `base` 样式(标题把 bold+色 传进来即可)。
fn inline_with_base(text: &str, base: Style) -> Vec<Span<'static>> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<Span<'static>> = Vec::new();
    parse_inline(&chars, base, &mut out);
    out
}

/// 递归下降的内联解析。
///
/// 支持:转义、行内 code、`[text](url)`、`~~strike~~`、`**bold**`/`__bold__`、
/// `*italic*`、`_italic_`(带词边界检查)。未配对的标记按字面量透传 —— 这点很重要:
/// 模型输出里常有孤立的 `*` 或 `_`(如 `snake_case`),吞掉它们会改变语义。
fn parse_inline(chars: &[char], base: Style, out: &mut Vec<Span<'static>>) {
    let n = chars.len();
    let mut buf = String::new();
    let mut i = 0usize;

    macro_rules! flush {
        () => {
            if !buf.is_empty() {
                out.push(Span::styled(std::mem::take(&mut buf), base));
            }
        };
    }

    while i < n {
        let ch = chars[i];

        // 反斜杠转义:下一个字符按字面量。
        if ch == '\\' && i + 1 < n {
            buf.push(chars[i + 1]);
            i += 2;
            continue;
        }

        // 行内 code:`n 个反引号` 配对同长度运行,内部不再递归。
        if ch == '`' {
            let run = chars[i..].iter().take_while(|c| **c == '`').count();
            if let Some(close) = find_run(chars, '`', i + run, run) {
                flush!();
                let content: String = chars[i + run..close].iter().collect();
                out.push(Span::styled(content, merge(base, code_style())));
                i = close + run;
                continue;
            }
            buf.push(ch);
            i += 1;
            continue;
        }

        // 链接 [text](url):只显示 text,URL 不占屏(终端里点不了)。
        if ch == '[' {
            if let Some((text, end)) = match_link(chars, i) {
                flush!();
                out.push(Span::styled(text, merge(base, link_style())));
                i = end;
                continue;
            }
            buf.push(ch);
            i += 1;
            continue;
        }

        // ~~删除线~~
        if ch == '~' && i + 1 < n && chars[i + 1] == '~' {
            if let Some(close) = find_str(chars, &['~', '~'], i + 2) {
                flush!();
                parse_inline(
                    &chars[i + 2..close],
                    base.add_modifier(Modifier::CROSSED_OUT),
                    out,
                );
                i = close + 2;
                continue;
            }
            buf.push_str("~~");
            i += 2;
            continue;
        }

        // **粗体** / __粗体__
        if (ch == '*' || ch == '_') && i + 1 < n && chars[i + 1] == ch {
            if let Some(close) = find_str(chars, &[ch, ch], i + 2) {
                flush!();
                parse_inline(&chars[i + 2..close], base.add_modifier(Modifier::BOLD), out);
                i = close + 2;
                continue;
            }
            buf.push(ch);
            buf.push(ch);
            i += 2;
            continue;
        }

        // *斜体*
        if ch == '*' {
            if let Some(close) = find_char(chars, '*', i + 1) {
                if close > i + 1 {
                    flush!();
                    parse_inline(&chars[i + 1..close], base.add_modifier(Modifier::ITALIC), out);
                    i = close + 1;
                    continue;
                }
            }
            buf.push(ch);
            i += 1;
            continue;
        }

        // _斜体_ —— 必须做词边界检查,否则 `snake_case_name` 会被吃成斜体。
        if ch == '_' {
            let prev_is_word = i > 0 && is_word(chars[i - 1]);
            if !prev_is_word {
                let mut j = i + 1;
                while j < n {
                    if chars[j] == '_' {
                        let next = if j + 1 < n { chars[j + 1] } else { ' ' };
                        if !is_word(next) {
                            break;
                        }
                    }
                    j += 1;
                }
                if j < n && j > i + 1 {
                    flush!();
                    parse_inline(&chars[i + 1..j], base.add_modifier(Modifier::ITALIC), out);
                    i = j + 1;
                    continue;
                }
            }
            buf.push(ch);
            i += 1;
            continue;
        }

        buf.push(ch);
        i += 1;
    }
    flush!();
}

/// 叠加样式:`extra` 的前景色覆盖 `base`,修饰符取并集。
fn merge(base: Style, extra: Style) -> Style {
    let mut s = base;
    if let Some(fg) = extra.fg {
        s = s.fg(fg);
    }
    s.add_modifier(extra.add_modifier)
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// 从 `from` 起找连续 `ch` 长度 ≥ `run` 的运行起点。
fn find_run(chars: &[char], ch: char, from: usize, run: usize) -> Option<usize> {
    let mut i = from;
    while i < chars.len() {
        if chars[i] == ch {
            let c = chars[i..].iter().take_while(|x| **x == ch).count();
            if c >= run {
                return Some(i);
            }
            i += c;
        } else {
            i += 1;
        }
    }
    None
}

fn find_char(chars: &[char], ch: char, from: usize) -> Option<usize> {
    (from..chars.len()).find(|&i| chars[i] == ch)
}

fn find_str(chars: &[char], pat: &[char], from: usize) -> Option<usize> {
    if pat.is_empty() || chars.len() < pat.len() {
        return None;
    }
    (from..=chars.len() - pat.len()).find(|&i| &chars[i..i + pat.len()] == pat)
}

/// 在 `from`(`[` 处)尝试匹配 `[text](url)`。返回 (显示文本, `)` 之后的下标)。
fn match_link(chars: &[char], from: usize) -> Option<(String, usize)> {
    let n = chars.len();
    let mut i = from + 1;
    while i < n && chars[i] != ']' {
        i += 1;
    }
    if i >= n {
        return None;
    }
    let text: String = chars[from + 1..i].iter().collect();
    i += 1; // 跳过 ]
    if i >= n || chars[i] != '(' {
        return None;
    }
    i += 1;
    while i < n && chars[i] != ')' {
        i += 1;
    }
    if i >= n {
        return None;
    }
    Some((text, i + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 取一行的可见文本(丢弃样式),便于断言结构。
    fn text_of(line: &Line<'static>) -> String {
        line.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    fn texts(lines: &[Line<'static>]) -> Vec<String> {
        lines.iter().map(text_of).collect()
    }

    #[test]
    fn heading_is_bold_and_colored() {
        let out = render("# 标题", 40);
        assert_eq!(texts(&out), vec!["标题"]);
        assert!(out[0].spans[0].style.add_modifier.contains(Modifier::BOLD));
        assert_eq!(out[0].spans[0].style.fg, Some(theme::ACCENT));
    }

    #[test]
    fn hash_without_space_is_not_a_heading() {
        // `#foo` 不是标题(CommonMark 要求 # 后有空格);井号必须原样保留。
        let out = render("#foo", 40);
        assert_eq!(texts(&out), vec!["#foo"]);
    }

    #[test]
    fn inline_code_gets_code_color() {
        let spans = inline("跑 `cargo test` 看看");
        let code = spans
            .iter()
            .find(|s| s.content == "cargo test")
            .expect("行内 code 应被单独切成一个 span");
        assert_eq!(code.style.fg, Some(theme::AMBER));
    }

    #[test]
    fn bold_and_italic_nest() {
        let spans = inline("**粗 *斜* 粗**");
        // 粗体范围内的所有 span 都必须带 BOLD;嵌套的斜体额外带 ITALIC。
        assert!(spans
            .iter()
            .all(|s| s.style.add_modifier.contains(Modifier::BOLD)));
        assert!(spans
            .iter()
            .any(|s| s.style.add_modifier.contains(Modifier::ITALIC)));
    }

    #[test]
    fn snake_case_is_not_italicized() {
        // 这是移植时最容易丢的规则:标识符里的下划线不能被当强调标记。
        let spans = inline("调用 snake_case_name 即可");
        let joined: String = spans.iter().map(|s| s.content.as_ref()).collect::<String>();
        assert_eq!(joined, "调用 snake_case_name 即可");
        assert!(spans
            .iter()
            .all(|s| !s.style.add_modifier.contains(Modifier::ITALIC)));
    }

    #[test]
    fn unpaired_marker_is_literal() {
        // 模型常输出孤立的 * / ` —— 吞掉它们会改变语义。
        assert_eq!(
            inline("2 * 3 = 6")
                .iter()
                .map(|s| s.content.as_ref())
                .collect::<String>(),
            "2 * 3 = 6"
        );
        assert_eq!(
            inline("未闭合 `code")
                .iter()
                .map(|s| s.content.as_ref())
                .collect::<String>(),
            "未闭合 `code"
        );
    }

    #[test]
    fn escape_is_honored() {
        let spans = inline(r"\*不是斜体\*");
        let joined: String = spans.iter().map(|s| s.content.as_ref()).collect();
        assert_eq!(joined, "*不是斜体*");
        assert!(spans
            .iter()
            .all(|s| !s.style.add_modifier.contains(Modifier::ITALIC)));
    }

    #[test]
    fn link_shows_text_only() {
        let spans = inline("见 [文档](https://example.com/very/long/url)");
        let joined: String = spans.iter().map(|s| s.content.as_ref()).collect();
        assert_eq!(joined, "见 文档");
    }

    #[test]
    fn fenced_code_keeps_lines_and_lang_label() {
        let out = render("```rust\nfn main() {}\nlet x = 1;\n```", 40);
        let t = texts(&out);
        assert_eq!(t[0].trim(), "rust");
        assert_eq!(t[1].trim(), "fn main() {}");
        assert_eq!(t[2].trim(), "let x = 1;");
    }

    #[test]
    fn unclosed_fence_is_still_rendered() {
        // 流式输出会停在围栏中段,此时必须照常显示已收到的代码,而不是整块消失。
        let out = render("```ts\nconst a = 1;", 40);
        let t = texts(&out);
        assert!(t.iter().any(|l| l.contains("const a = 1;")), "得到 {t:?}");
    }

    #[test]
    fn markdown_inside_fence_is_not_parsed() {
        // 围栏内的 # 和 - 是代码,不是标题/列表。
        let out = render("```\n# not a heading\n- not a list\n```", 40);
        let t = texts(&out);
        assert_eq!(t[0].trim(), "# not a heading");
        assert_eq!(t[1].trim(), "- not a list");
    }

    #[test]
    fn lists_get_bullets() {
        let out = render("- 一\n- 二\n  - 嵌套", 40);
        let t = texts(&out);
        assert!(t[0].starts_with("• "), "得到 {:?}", t[0]);
        assert!(t[2].contains('◦'), "次级条目应换用空心点:{:?}", t[2]);
    }

    #[test]
    fn ordered_list_keeps_numbers() {
        let out = render("1. 首项\n2. 次项", 40);
        let t = texts(&out);
        assert!(t[0].starts_with("1. "));
        assert!(t[1].starts_with("2. "));
    }

    #[test]
    fn blockquote_gets_bar() {
        let out = render("> 引用内容", 40);
        assert!(text_of(&out[0]).contains('│'));
        assert!(text_of(&out[0]).contains("引用内容"));
    }

    #[test]
    fn thematic_break_fills_width() {
        let out = render("---", 12);
        assert_eq!(text_of(&out[0]), "─".repeat(12));
    }

    #[test]
    fn paragraph_lines_are_joined() {
        // 段落内的软换行应拼成一行,由折行层按终端宽度重新断开。
        let out = render("第一行\n第二行", 40);
        assert_eq!(texts(&out), vec!["第一行 第二行"]);
    }

    #[test]
    fn table_is_aligned() {
        let out = render("| a | bbb |\n| --- | --- |\n| 1 | 2 |", 40);
        let t = texts(&out);
        assert!(t[0].contains('│'), "表头应有列分隔:{:?}", t[0]);
        assert!(t[1].contains('┼'), "应有分隔线:{:?}", t[1]);
        assert!(t[2].contains('1') && t[2].contains('2'));
        // 列宽对齐:表头与数据行的分隔符落在同一列。
        assert_eq!(
            t[0].find('│').map(|_| display_width(&t[0][..t[0].find('│').unwrap()])),
            t[2].find('│').map(|_| display_width(&t[2][..t[2].find('│').unwrap()])),
        );
    }

    #[test]
    fn leading_and_trailing_blanks_are_trimmed() {
        // 正文段绝不自带前后空行 —— 批边界/轮次边界统一补,否则会叠成双空行。
        let out = render("\n\n正文\n\n", 40);
        assert_eq!(texts(&out), vec!["正文"]);
    }

    #[test]
    fn spans_never_contain_newlines() {
        // 逻辑行内不允许残留 '\n':wrap 层会把它当硬换行,行标签就与视觉行错位了。
        let out = render("# 标题\n\n段落 `code`\n\n```rs\nfn f() {}\n```\n\n- 项", 40);
        for line in &out {
            for span in &line.spans {
                assert!(!span.content.contains('\n'), "span 里出现换行:{span:?}");
            }
        }
    }
}
