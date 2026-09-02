//! 显示宽度感知的折行 —— TS 侧「content buffer 行宽不变量」的 Rust 版本。
//!
//! ## 为什么要自己折行
//! TS 侧 `src/ui/layout.ts` + `batch.ts` 手工维护「每条物理行可见宽 ≤ 终端 cols」,
//! 一旦某行超宽被终端 auto-wrap,物理行就与 buffer 行错位,CUP 定位全错 → 整屏乱码。
//! 这是 TS 实现中最难缠的一类 bug。
//!
//! 这里把不变量前移:**ratatui 渲染的每一行,在交给它之前就已经保证不超宽**。
//! 于是运行时不可能出现"终端自己折行"的情况 —— 不变量由构造保证,而非靠事后修补。
//!
//! ## 为什么不用 `Paragraph::wrap`
//! ratatui 0.29 的 `Paragraph` 自带 `Wrap`,但配套的 `line_count`(算折行后总行数,
//! 滚动区间必需)属于 `unstable-rendered-line-info` feature,不接受 semver 保证。
//! 自己折行则总行数 = `Vec::len()`,精确且无依赖。
//! 代价:不按词边界断行,长英文单词会在中间断开(与终端原生行为一致,可接受)。

use ratatui::style::Style;
use ratatui::text::{Line, Span};

/// 内容区的一行 + 它的渲染类别。
///
/// `bubble`(用户消息)在渲染阶段按终端宽度补满底色 —— 对应 TS
/// `src/repl/index.ts:formatUserMessage` 的 `padEndDisplay(full, cols)`。
/// 满宽底色让上滑回看时用户消息是连续色块,与 assistant 正文一眼区分。
#[derive(Clone)]
pub struct Row {
    pub line: Line<'static>,
    pub bubble: bool,
}

impl Row {
    pub fn plain(line: Line<'static>) -> Self {
        Self { line, bubble: false }
    }
    pub fn bubble(line: Line<'static>) -> Self {
        Self { line, bubble: true }
    }
}

/// 把 `Row` 序列折成视觉行序列(每条显示宽度 ≤ `width`)。
///
/// 在 `wrap_lines` 之上多做一件事:`bubble` 行按 `width` 补满底色。这与 TS 的顺序一致
/// —— TS 先把整行 pad 到 cols 再交给 content buffer 折行,所以气泡的**每一条**视觉行
/// 都是满宽底色,而不是只有最后一行。
pub fn wrap_rows(rows: &[Row], width: usize, bubble_bg: ratatui::style::Color) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::with_capacity(rows.len());
    for row in rows {
        if !row.bubble {
            out.extend(wrap_lines(std::slice::from_ref(&row.line), width));
            continue;
        }
        // 气泡:整行先铺底色,再折行,折出的每一行尾部补满余量。
        // 文本长于 width 时,折出的每一行都带着底色(不需要额外补空格)。
        let mut styled = row.line.clone();
        for span in &mut styled.spans {
            span.style = span.style.bg(bubble_bg);
        }
        let base = styled.width();
        if base < width {
            styled.spans.push(Span::styled(
                " ".repeat(width - base),
                Style::default().bg(bubble_bg),
            ));
        }
        let visual = wrap_lines(std::slice::from_ref(&styled), width);
        for mut line in visual {
            let w: usize = line.spans.iter().map(|s| display_width(&s.content)).sum();
            if w < width {
                line.spans.push(Span::styled(
                    " ".repeat(width - w),
                    Style::default().bg(bubble_bg),
                ));
            }
            out.push(line);
        }
    }
    out
}

/// 把逻辑行序列折成视觉行序列(每条显示宽度 ≤ `width`)。
///
/// 宽度按**显示宽度**计算:东亚宽字符(汉字、全角标点)= 2 列,组合字符 = 0 列。
/// 短行走快速路径(整行复用,不做逐字符扫描)。
///
/// **`\n` 是硬换行**:span 内容里的换行先把逻辑行切成多条,再各自按宽度软折。
/// 这是多行输入(Ctrl+J / 粘贴多行)能正确显示的前提 —— 早期版本把 `\n` 当控制字符
/// 直接跳过,结果多行输入被挤成一行、光标定位跟着全错。
pub fn wrap_lines(lines: &[Line<'static>], width: usize) -> Vec<Line<'static>> {
    // 宽度为 0(窗口过窄 / 尚未测量):折行无意义,原样返回由渲染层裁剪。
    if width == 0 {
        return lines.to_vec();
    }
    let mut out: Vec<Line<'static>> = Vec::with_capacity(lines.len());
    for line in lines {
        for hard in split_hard_lines(line) {
            if line_display_width(&hard) <= width {
                // 快速路径:绝大多数行都走这里,零分配。
                out.push(hard);
            } else {
                wrap_single(&hard, width, &mut out);
            }
        }
    }
    out
}

/// 按 `\n` 把一条逻辑行切成多条硬行(样式随 span 保留)。
///
/// 不含 `\n` 时直接返回原行的克隆,避免为绝大多数行付出额外分配。
fn split_hard_lines(line: &Line<'static>) -> Vec<Line<'static>> {
    if !line.spans.iter().any(|s| s.content.contains('\n')) {
        return vec![line.clone()];
    }
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut cur: Vec<Span<'static>> = Vec::new();
    for span in &line.spans {
        let style = span.style;
        // split('\n') 对 "a\nb" 得 ["a","b"],对 "a\n" 得 ["a",""] —— 末尾空段
        // 正好表示"这里断行,下一行从空开始",语义与终端一致。
        let mut parts = span.content.split('\n');
        if let Some(first) = parts.next() {
            if !first.is_empty() {
                cur.push(Span::styled(first.to_string(), style));
            }
        }
        for part in parts {
            out.push(Line::from(std::mem::take(&mut cur)));
            if !part.is_empty() {
                cur.push(Span::styled(part.to_string(), style));
            }
        }
    }
    out.push(Line::from(cur));
    out
}

/// 一条 `Line` 的显示宽度。
///
/// 不用 `Line::width()`:它经 `UnicodeWidthStr` 计算,对含控制字符的串结果不可靠
/// (`\n` 会被算成 1 列),而这里的宽度必须与 `wrap_single` 的逐字符判定一致。
fn line_display_width(line: &Line<'static>) -> usize {
    line.spans.iter().map(|s| display_width(&s.content)).sum()
}

/// 一段文本在给定宽度下折出的视觉行数(`leading` 为首行已占用列数)。
///
/// 与 `wrap_lines` + `locate_cursor` 同一套断行判定,供渲染层预留输入框高度。
pub fn count_rows(text: &str, width: usize, leading: usize) -> usize {
    use unicode_width::UnicodeWidthChar;
    if width == 0 {
        return 1;
    }
    let mut rows = 1usize;
    let mut col = leading;
    for ch in text.chars() {
        if ch == '\n' {
            rows += 1;
            col = 0;
            continue;
        }
        if ch.is_control() {
            continue;
        }
        let cw = ch.width().unwrap_or(0);
        if col + cw > width && col > 0 {
            rows += 1;
            col = 0;
        }
        col += cw;
    }
    rows
}

fn wrap_single(line: &Line<'static>, width: usize, out: &mut Vec<Line<'static>>) {
    use unicode_width::UnicodeWidthChar;

    let mut cur_spans: Vec<Span<'static>> = Vec::new();
    let mut cur_text = String::new();
    let mut cur_style = Style::default();
    let mut cur_w = 0usize;

    for span in &line.spans {
        let style = span.style;
        for ch in span.content.chars() {
            // 控制字符(含裸 \n —— 逻辑行内部不应出现,但防御性跳过)不计宽度。
            if ch.is_control() {
                continue;
            }
            let cw = ch.width().unwrap_or(0);

            // 放不下就断行。`cur_w > 0` 守卫保证极窄屏下单字符独占一行,不会死循环。
            if cur_w + cw > width && cur_w > 0 {
                flush(&mut cur_spans, &mut cur_text, cur_style);
                out.push(Line::from(std::mem::take(&mut cur_spans)));
                cur_w = 0;
            }

            // 样式切换点也必须切开,否则后半段会沿用前半段的颜色。
            if style != cur_style {
                flush(&mut cur_spans, &mut cur_text, cur_style);
                cur_style = style;
            }
            cur_text.push(ch);
            cur_w += cw;
        }
    }

    flush(&mut cur_spans, &mut cur_text, cur_style);
    // 至少产出一行:全空内容也要占位,否则条目会在视觉上凭空消失。
    if cur_spans.is_empty() {
        out.push(Line::from(""));
    } else {
        out.push(Line::from(std::mem::take(&mut cur_spans)));
    }
}

/// 把累积的字符落成一个 Span。样式不同的相邻字符必须分成不同 Span。
fn flush(spans: &mut Vec<Span<'static>>, text: &mut String, style: Style) {
    if !text.is_empty() {
        spans.push(Span::styled(std::mem::take(text), style));
    }
}

/// 求某个字符下标在折行后的 (行, 列) 位置。
///
/// 必须与 `wrap_lines` 的断行判定**逐字一致**(含 `\n` 硬换行),否则多行输入时
/// 光标会与文字错位。`leading` 是该逻辑行前面已被其它 span 占用的列数
/// (输入框的 "❯ " 占 2 列)。
pub fn locate_cursor(input: &str, cursor: usize, width: usize, leading: usize) -> (usize, usize) {
    use unicode_width::UnicodeWidthChar;
    if width == 0 {
        return (0, leading);
    }
    let mut row = 0usize;
    let mut col = leading;
    for (i, ch) in input.chars().enumerate() {
        if i >= cursor {
            break;
        }
        // 硬换行:换行符本身不占列,光标落到下一行行首。
        if ch == '\n' {
            row += 1;
            col = 0;
            continue;
        }
        if ch.is_control() {
            continue;
        }
        let cw = ch.width().unwrap_or(0);
        // 与 wrap_single 同款守卫:行首(cw 之前的 col==0)不触发断行。
        if col + cw > width && col > 0 {
            row += 1;
            col = 0;
        }
        col += cw;
    }
    (row, col)
}

/// 按显示宽度截断,超出补 `…`。用于状态栏等单行固定宽度区域。
///
/// 与 `app::truncate_display` 同逻辑,放在这里是因为它同样属于"宽度不变量"范畴。
pub fn truncate_width(s: &str, limit: usize) -> String {
    use unicode_width::UnicodeWidthChar;
    let mut width = 0usize;
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch.is_control() {
            continue;
        }
        let w = ch.width().unwrap_or(0);
        if width + w > limit {
            out.push('…');
            return out;
        }
        width += w;
        out.push(ch);
    }
    out
}

/// 计算字符串的显示宽度(不含控制字符)。
pub fn display_width(s: &str) -> usize {
    use unicode_width::UnicodeWidthStr;
    // UnicodeWidthStr::width 对含控制字符的串结果不可靠,先滤掉。
    let cleaned: String = s.chars().filter(|c| !c.is_control()).collect();
    cleaned.width()
}

/// 用空格把字符串填充/截断到指定显示宽度。
///
/// 用于 banner 等需要左右两栏严格对齐的场景。
pub fn pad_end(s: &str, width: usize) -> String {
    let w = display_width(s);
    if w >= width {
        truncate_width(s, width)
    } else {
        format!("{}{}", s, " ".repeat(width - w))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Color;

    fn plain(s: &str) -> Line<'static> {
        Line::from(s.to_string())
    }

    #[test]
    fn short_line_passthrough() {
        let lines = vec![plain("hello")];
        assert_eq!(wrap_lines(&lines, 10).len(), 1);
    }

    #[test]
    fn ascii_wraps_at_width() {
        let lines = vec![plain("abcdefghij")];
        let out = wrap_lines(&lines, 4);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].spans[0].content, "abcd");
        assert_eq!(out[1].spans[0].content, "efgh");
        assert_eq!(out[2].spans[0].content, "ij");
    }

    #[test]
    fn east_asian_width_counts_two_columns() {
        // 4 个汉字 = 8 列,宽度 6 → 每行最多 3 个汉字
        let lines = vec![plain("一二三四")];
        let out = wrap_lines(&lines, 6);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].spans[0].content, "一二三");
        assert_eq!(out[1].spans[0].content, "四");
    }

    use unicode_width::UnicodeWidthChar;

    fn line_width_of(l: &Line<'static>) -> usize {
        l.spans
            .iter()
            .map(|s| display_width(&s.content))
            .sum::<usize>()
    }

    #[test]
    fn every_visual_line_respects_width() {
        // 核心不变量:混合宽字符 + 样式,任意宽度下每行都必须 ≤ width。
        // 这条测试正是 TS 侧反复踩坑的那件事 —— 这里由构造保证,不靠事后修补。
        let line = Line::from(vec![
            Span::styled("路径:", Style::default().fg(Color::Cyan)),
            Span::styled("中文目录/abc", Style::default().fg(Color::White)),
        ]);
        // 从 2 开始:东亚宽字符单字符占 2 列,width=1 时物理上无法容纳
        // (要么截断字符丢内容,要么接受超宽 —— 后者是唯一不丢信息的选择)。
        // 真实终端宽度恒 ≥ 2,故不变量的有效域就是 [2, +∞)。
        for width in 2..=20usize {
            let out = wrap_lines(&[line.clone()], width);
            for l in &out {
                assert!(
                    line_width_of(l) <= width,
                    "width={width} 时产出超宽行(宽 {})",
                    line_width_of(l)
                );
            }
        }
    }

    #[test]
    fn single_wide_char_on_narrow_row_does_not_loop_or_lose_it() {
        // width=1 的退化情形:宽字符必须独占一行(宁可超宽也不截断),
        // 且绝不能死循环或丢字符 —— 内容守恒比宽度约束优先。
        let line = Line::from("中a文");
        let out = wrap_lines(&[line], 1);
        let joined: String = out.iter().map(|l| l.to_string()).collect();
        assert_eq!(joined, "中a文", "退化宽度下不得丢字符");
        assert!(out.len() >= 3, "每个宽字符应各自独占一行");
    }

    #[test]
    fn cursor_location_matches_wrapping() {
        // locate_cursor 必须与 wrap_lines 的断行结果一致,否则多行输入光标会漂。
        let input = "中文目录abcdefghij";
        for width in 4..=20usize {
            let line = Line::from(input.to_string());
            let out = wrap_lines(&[line], width);
            // 对每个可能的 cursor 位置,校验它落在 locate_cursor 算出的同行同列
            for cursor in 0..=input.chars().count() {
                let (row, col) = locate_cursor(input, cursor, width, 0);
                assert!(row < out.len(), "cursor={cursor} width={width} 行号越界");
                // 该行在 col 之前的内容宽度,应等于前 cursor 个字符的累计宽度
                let prefix: String = input.chars().take(cursor).collect();
                let mut expect_row = 0usize;
                let mut expect_col = 0usize;
                for ch in prefix.chars() {
                    let cw = ch.width().unwrap_or(0);
                    if expect_col + cw > width && expect_col > 0 {
                        expect_row += 1;
                        expect_col = 0;
                    }
                    expect_col += cw;
                }
                assert_eq!(
                    (row, col),
                    (expect_row, expect_col),
                    "cursor={cursor} width={width}"
                );
            }
        }
    }

    #[test]
    fn style_is_preserved_across_break() {
        let line = Line::from(vec![Span::styled(
            "aaaaaaaaaa",
            Style::default().fg(Color::Red),
        )]);
        let out = wrap_lines(&[line], 4);
        assert_eq!(out.len(), 3);
        for l in &out {
            assert_eq!(l.spans[0].style.fg, Some(Color::Red));
        }
    }

    #[test]
    fn zero_width_returns_input() {
        let lines = vec![plain("hello")];
        assert_eq!(wrap_lines(&lines, 0).len(), 1);
    }

    #[test]
    fn empty_line_occupies_one_row() {
        let lines = vec![Line::from("")];
        assert_eq!(wrap_lines(&lines, 10).len(), 1);
    }

    /// 造一条**保留 `\n`** 的逻辑行。
    ///
    /// 不能用 `Line::from("a\nb".to_string())`:ratatui 0.29 的 `From<String>` 走
    /// `cow_to_spans` → `s.lines().map(Span::raw)`,会把 `\n` 直接丢掉并拆成多个 span
    /// (line.rs:221-226)。只有 `Span` 里的内容才原样保留换行 —— 输入框走的正是
    /// `Span::styled(app.input)`,故这才是真实数据形态。
    fn hard(s: &str) -> Line<'static> {
        Line::from(vec![Span::from(s.to_string())])
    }

    #[test]
    fn newline_is_a_hard_break() {
        // 早期 bug:'\n' 被当控制字符跳过,三行输入渲染成一行。
        let out = wrap_lines(&[hard("a\nbb\nccc")], 40);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].spans[0].content, "a");
        assert_eq!(out[1].spans[0].content, "bb");
        assert_eq!(out[2].spans[0].content, "ccc");
    }

    #[test]
    fn trailing_newline_opens_an_empty_row() {
        // 末尾换行必须留出空行,否则用户按 Ctrl+J 后光标"没地方去"。
        let out = wrap_lines(&[hard("a\n")], 40);
        assert_eq!(out.len(), 2);
        assert_eq!(line_width_of(&out[1]), 0);
    }

    #[test]
    fn hard_break_then_soft_wrap() {
        // 硬行内部仍要按宽度软折:第二段 6 列宽度下折成 2 行 → 总 3 行。
        let out = wrap_lines(&[hard("ab\ncdefghij")], 6);
        assert_eq!(out.len(), 3);
        for l in &out {
            assert!(line_width_of(l) <= 6);
        }
    }


    #[test]
    fn hard_break_preserves_span_styles() {
        let line = Line::from(vec![
            Span::styled("❯ ", Style::default().fg(Color::Yellow)),
            Span::styled("a\nb", Style::default().fg(Color::Red)),
        ]);
        let out = wrap_lines(&[line], 40);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].spans[0].style.fg, Some(Color::Yellow));
        assert_eq!(out[0].spans[1].style.fg, Some(Color::Red));
        assert_eq!(out[1].spans[0].style.fg, Some(Color::Red));
    }

    #[test]
    fn cursor_follows_hard_breaks() {
        // "ab\ncd":光标在 'c' 之前(索引 3)应落在第 2 行第 0 列。
        let input = "ab\ncd";
        assert_eq!(locate_cursor(input, 0, 40, 2), (0, 2));
        assert_eq!(locate_cursor(input, 2, 40, 2), (0, 4));
        assert_eq!(locate_cursor(input, 3, 40, 2), (1, 0));
        assert_eq!(locate_cursor(input, 5, 40, 2), (1, 2));
    }

    #[test]
    fn count_rows_matches_wrap_lines() {
        // count_rows 用于预留输入框高度,必须与真实折行行数逐例一致。
        for text in ["", "a", "a\nb", "a\n", "中文中文中文", "abc\n中文abc", "a\n\n\nb"] {
            for width in 3..=12usize {
                let logical = Line::from(vec![
                    Span::from("❯ "),
                    Span::from(text.to_string()),
                ]);
                let expect = wrap_lines(&[logical], width).len();
                assert_eq!(
                    count_rows(text, width, 2),
                    expect,
                    "text={text:?} width={width}"
                );
            }
        }
    }
}
