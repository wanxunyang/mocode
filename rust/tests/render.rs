//! 渲染层回归测试:用 ratatui 的 `TestBackend` 在**无终端**环境下跑真实 draw 管线。
//!
//! 为什么值得单独写:`wrap.rs` 的单测只验证了折行函数本身,而这里验证的是
//! 「`App` → `build_lines` → `wrap_lines` → `ui::draw` → Buffer」整条真实路径。
//! 断言的核心是 TS 侧反复踩坑的那条不变量:**每一行可见宽 ≤ 终端宽度**。
//! 一旦某行超宽被终端 auto-wrap,物理行与 buffer 行错位 → 整屏乱码。
//!
//! 前置:需先 `npm run build` 产出 dist/(测试会 spawn 真实 agent-host)。
//! 无法启动时打印提示并跳过,不误报失败。

use std::path::PathBuf;

use mocode_tui::app::{App, Entry, RunStatus, Tone, ToolBatch, ToolItem};
use mocode_tui::ipc::{self, IpcMessage};
use mocode_tui::protocol::HostEvent;
use mocode_tui::ui;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::Terminal;

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("rust/ 必须有父目录")
        .to_path_buf()
}

/// `App::new` 需要真实 AgentHost(它持有子进程句柄与命令 id 计数器),
/// 替身会牵扯大改。smoke 已证明 spawn→ready 约 0.6s,测试里直接起真的。
/// 返回 None 表示环境不具备(dist 未构建 / 无 node),调用方跳过。
fn make_app() -> Option<App> {
    let root = project_root();
    let script = ipc::locate_host_script().ok()?;
    let host = ipc::AgentHost::spawn(&script, &root).ok()?;
    Some(App::new(host, root.to_string_lossy().to_string()))
}

/// 塞入一份"刁钻"内容:中文宽字符、超长单行、展开的工具输出、运行中态、
/// 长错误行 —— 覆盖折行的各种边界。
fn fill(app: &mut App) {
    app.entries.push(Entry::User {
        text: "帮我看看这个渲染管线在窄屏下会不会炸".into(),
    });
    app.entries.push(Entry::Assistant {
        text: "这是一段很长的助手回复,用来触发折行:".to_string()
            + &"中文与 English mixed content ".repeat(12),
    });
    // 已完成并完全展开的批:摘要行 + ├─/└─ 明细 + 第二层完整输出(超长行触发折行)。
    app.entries.push(Entry::ToolBatch(ToolBatch {
        items: vec![
            ToolItem {
                id: "c1".into(),
                name: "grep".into(),
                summary: "src/**/*.ts 中搜索 repaintViewport".into(),
                result_summary: "40 处匹配".into(),
                output: Some("src/ui/layout.ts:914:  fn repaintViewport(&mut self) {\n".repeat(40)),
                failed: false,
                done: true,
                arguments: r#"{"pattern":"repaintViewport"}"#.into(),
                diff_block: None,
            },
            ToolItem {
                id: "c2".into(),
                name: "read_file".into(),
                summary: "src/ui/batch.ts".into(),
                result_summary: "812 行".into(),
                output: Some("第一行\n第二行".into()),
                failed: false,
                done: true,
                arguments: r#"{"path":"src/ui/batch.ts"}"#.into(),
                diff_block: None,
            },
        ],
        expanded: true,
        detail_expanded: vec![0],
        standalone: false,
        started_at: std::time::Instant::now(),
        finished_ms: Some(1_234),
    }));
    // 运行中的批:还有一条没拿到结果,摘要行应停在"正在探索"。
    app.entries.push(Entry::ToolBatch(ToolBatch {
        items: vec![ToolItem {
            id: "c3".into(),
            name: "run_command".into(),
            summary: "npm test".into(),
            result_summary: String::new(),
            output: None,
            failed: false,
            done: false,
            arguments: r#"{"command":"npm test"}"#.into(),
            diff_block: None,
        }],
        expanded: false,
        detail_expanded: Vec::new(),
        standalone: false,
        started_at: std::time::Instant::now(),
        finished_ms: None,
    }));
    app.entries.push(Entry::ChangeOverview {
        files: vec!["src/ui/layout.ts".into(), "src/ui/batch.ts".into()],
    });
    app.entries.push(Entry::System {
        text: "会话已恢复".into(),
        tone: Tone::Success,
    });
    app.entries.push(Entry::System {
        text: "这是一条很长的错误提示:".to_string() + &"错误细节 ".repeat(30),
        tone: Tone::Error,
    });

    app.status = RunStatus::RunningTool;
    app.active_tool = Some("grep".into());
    app.input = "输入框里也有中文内容".into();
    app.cursor = app.input.chars().count();
}

/// 把 Buffer 按行还原成可见文本。用 `content.chunks(width)` 而非索引取值,
/// 避免任何越界 panic 掩盖真正的渲染问题。
fn rendered_rows(buf: &Buffer) -> Vec<String> {
    let w = buf.area.width as usize;
    if w == 0 {
        return Vec::new();
    }
    buf.content
        .chunks(w)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect()
}

/// 计算 TestBackend 一行的真实显示宽度。
///
/// ratatui 对宽字符(如中文)会用两个 cell 表示:第一个存字符本身,第二个存空格作为
/// continuation。直接把 cell symbol 拼成字符串再量宽度会把 continuation 空格算进去,
/// 导致测量值虚高。这里跳过紧跟在宽字符后的 continuation 空格。
fn row_display_width(row: &str) -> usize {
    use unicode_width::UnicodeWidthChar;
    let mut width = 0usize;
    let mut skip_next_space = false;
    for ch in row.chars() {
        if skip_next_space && ch == ' ' {
            skip_next_space = false;
            continue;
        }
        let w = ch.width().unwrap_or(0);
        skip_next_space = w == 2;
        width += w;
    }
    width
}

#[test]
fn every_rendered_row_respects_terminal_width() {
    // 核心不变量:真实 draw 路径产出的每一行都不超宽。
    let Some(mut app) = make_app() else {
        eprintln!("跳过:无法启动 agent-host(先跑 npm run build 产出 dist/)");
        return;
    };
    fill(&mut app);

    for width in [40usize, 60, 80, 120, 200] {
        let mut term = Terminal::new(TestBackend::new(width as u16, 30)).unwrap();
        term.draw(|f| ui::draw(f, &mut app)).unwrap();

        for (y, row) in rendered_rows(term.backend().buffer()).iter().enumerate() {
            // 用 row_display_width 扣除 ratatui 为宽字符补的 continuation 空格。
            let visible = row_display_width(row);
            assert!(
                visible <= width,
                "width={width} 时第 {y} 行超宽({visible} 列): {row:?}"
            );
        }
    }
}

#[test]
fn content_is_actually_rendered() {
    // 空屏同样满足"不超宽",所以必须单独断言内容真的画出来了。
    let Some(mut app) = make_app() else {
        eprintln!("跳过:无法启动 agent-host");
        return;
    };
    fill(&mut app);

    let mut term = Terminal::new(TestBackend::new(80, 30)).unwrap();
    term.draw(|f| ui::draw(f, &mut app)).unwrap();

    let rows = rendered_rows(term.backend().buffer());
    let non_blank: Vec<&String> = rows.iter().filter(|r| !r.trim().is_empty()).collect();
    assert!(
        non_blank.len() > 5,
        "渲染内容过少,疑似空屏(非空行 {} 条)",
        non_blank.len()
    );

    let all = rows.join("\n");
    assert!(all.contains('❯'), "输入框提示符缺失:\n{all}");
}

#[test]
fn banner_scrolls_away_with_chat_history() {
    // 空历史时 banner 位于滚动内容开头。
    let mut fresh = App::hollow();
    let mut fresh_term = Terminal::new(TestBackend::new(80, 24)).unwrap();
    fresh_term.draw(|f| ui::draw(f, &mut fresh)).unwrap();
    let fresh_rows = rendered_rows(fresh_term.backend().buffer()).join("\n");
    assert!(
        fresh_rows.contains("MoCode"),
        "初始视图缺少 banner:\n{fresh_rows}"
    );

    // 贴底时，足够多的历史应把 banner 一起顶出内容视口；它不应再固定在屏幕顶部。
    let mut app = App::hollow();
    for i in 0..24 {
        app.entries.push(Entry::System {
            text: format!("历史行 {i}"),
            tone: Tone::Info,
        });
    }
    let mut term = Terminal::new(TestBackend::new(80, 24)).unwrap();
    term.draw(|f| ui::draw(f, &mut app)).unwrap();
    let rows = rendered_rows(term.backend().buffer()).join("\n");

    assert!(
        !rows.contains("MoCode"),
        "贴底时 banner 仍被固定显示:\n{rows}"
    );
    let rows_without_spaces = rows.replace(' ', "");
    assert!(
        rows_without_spaces.contains("历史行23"),
        "贴底时未显示最新聊天记录:\n{rows}"
    );
}

#[test]
fn user_message_has_one_blank_row_before_assistant_reply() {
    // submit() 已追加 Entry::Blank；build_rows 不应再额外补一条空行。
    let mut app = App::hollow();
    app.entries.push(Entry::User {
        text: "用户消息".into(),
    });
    app.entries.push(Entry::Blank);
    app.entries.push(Entry::Assistant {
        text: "助手回复".into(),
    });

    let lines = &app.content(80).lines;
    let user_row = lines
        .iter()
        .position(|line| {
            line.spans
                .iter()
                .any(|span| span.content.contains("用户消息"))
        })
        .expect("用户消息未渲染");
    let assistant_row = lines
        .iter()
        .position(|line| {
            line.spans
                .iter()
                .any(|span| span.content.contains("助手回复"))
        })
        .expect("助手回复未渲染");

    assert_eq!(
        assistant_row - user_row,
        2,
        "用户消息与助手回复之间应恰好有一条空行"
    );
}

#[test]
fn tool_calls_are_grouped_into_one_batch_with_blank_separators() {
    // 用户反馈的核心回归:工具调用必须「聚成一条 + 逐条缩进 + 块间空行」,
    // 而不是每个调用各占一行黏成一坨。这里断言渲染缓冲里的真实视觉结构。
    let Some(mut app) = make_app() else {
        eprintln!("跳过:无法启动 agent-host");
        return;
    };
    fill(&mut app);
    // 从头看 —— 默认贴底会把前面的内容滚出视口。
    app.stick_to_bottom = false;
    app.scroll = 0;

    let mut term = Terminal::new(TestBackend::new(90, 80)).unwrap();
    term.draw(|f| ui::draw(f, &mut app)).unwrap();
    let rows = rendered_rows(term.backend().buffer());
    // TestBackend 对 CJK 字符插空格做 continuation,断言时去掉所有空格再比对。
    let all_squeezed: String = rows
        .iter()
        .map(|r| r.replace(' ', ""))
        .collect::<Vec<_>>()
        .join("\n");

    // 1. 用户消息存在(气泡行)。
    assert!(
        all_squeezed.contains('❯'),
        "用户气泡行缺失:\n{all_squeezed}"
    );

    // 2. 多条工具调用聚成一条摘要行,而不是各占一行。
    //    TestBackend 把 CJK 拆成 char+space,所以"探索"变成"探 索";
    //    去掉空格后应能匹配。
    assert!(
        all_squeezed.contains("探索"),
        "工具批摘要行缺失:\n{all_squeezed}"
    );
    assert!(
        all_squeezed.contains("grep") && all_squeezed.contains("read_file"),
        "摘要行未合并工具:\n{all_squeezed}"
    );

    // 3. 展开后逐条用树枝线缩进,且末条用 └─(视觉上是一个整体块)。
    assert!(
        all_squeezed.contains("├─"),
        "明细行缺少 ├─ 树枝线:\n{all_squeezed}"
    );
    assert!(
        all_squeezed.contains("└─"),
        "明细行缺少 └─ 树枝线:\n{all_squeezed}"
    );

    // 4. 助手正文与工具块之间有空行(不能紧贴)。
    let has_blank = rows.iter().any(|r| r.trim().is_empty());
    assert!(has_blank, "内容区完全没有空行分隔:\n{all_squeezed}");

    // 5. 文件变更概览:概览行 + 缩进的条目行。
    assert!(
        all_squeezed.contains("文件变更"),
        "文件变更概览缺失:\n{all_squeezed}"
    );
}

#[test]
fn empty_app_renders_without_panic() {
    // 刚启动、还没有任何条目时的空状态。
    let Some(mut app) = make_app() else {
        eprintln!("跳过:无法启动 agent-host");
        return;
    };
    let mut term = Terminal::new(TestBackend::new(80, 24)).unwrap();
    term.draw(|f| ui::draw(f, &mut app)).unwrap();
}

#[test]
fn unstyled_content_uses_terminal_default_background() {
    // 内容区右侧空白格没有局部组件覆盖，必须保持终端默认背景，而非主题画布色。
    let mut app = App::hollow();
    let mut term = Terminal::new(TestBackend::new(80, 24)).unwrap();
    term.draw(|f| ui::draw(f, &mut app)).unwrap();

    assert_eq!(
        term.backend().buffer()[(79, 10)].bg,
        ratatui::style::Color::Reset,
        "内容区未着色单元格不应写入主题背景色"
    );
}

#[test]
fn degenerate_terminal_size_does_not_panic() {
    // 极端尺寸:用户把终端拖到 1 列 / 1 行时不能崩。
    // 只要求不 panic —— 这种尺寸下内容必然被裁掉,不校验宽度。
    let Some(mut app) = make_app() else {
        eprintln!("跳过:无法启动 agent-host");
        return;
    };
    fill(&mut app);

    for (w, h) in [(1u16, 1u16), (2, 1), (1, 20), (3, 2)] {
        let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
        term.draw(|f| ui::draw(f, &mut app)).unwrap();
    }
}

#[test]
fn long_input_wraps_without_exceeding_width() {
    // 输入框是唯一可编辑区,超长输入必须折行而不是撑破边界。
    let Some(mut app) = make_app() else {
        eprintln!("跳过:无法启动 agent-host");
        return;
    };
    app.input = "很长的输入".repeat(60);
    app.cursor = app.input.chars().count();

    for width in [40usize, 80, 120] {
        let mut term = Terminal::new(TestBackend::new(width as u16, 24)).unwrap();
        term.draw(|f| ui::draw(f, &mut app)).unwrap();
        for (y, row) in rendered_rows(term.backend().buffer()).iter().enumerate() {
            let visible = row_display_width(row);
            assert!(
                visible <= width,
                "width={width} 时第 {y} 行超宽({visible} 列): {row:?}"
            );
        }
    }
}

// ─────────────────── 运行时事件流测试 ───────────────────
// 模拟 agent-host 在真实执行一轮对话时发来的事件序列,
// 验证 App 状态机把工具调用正确聚拢成批。

fn ev(e: HostEvent) -> IpcMessage {
    IpcMessage::Event {
        event: e,
        request_id: None,
    }
}

#[test]
fn parallel_tools_are_grouped_into_one_batch() {
    // 模拟 agent-host 发来的事件流:3 个只读工具在同一 LLM 步并发执行。
    // TS 侧 core.ts 会先发 3 个 tool_started,再逐个发 tool_completed。
    // Rust 侧必须把它们聚到同一个 ToolBatch,而不是各开一批。
    let mut app = App::hollow();
    app.project_root = "F:\\mocode".into();
    app.provider = "openai".into();

    // 模拟用户提交
    app.submit(); // 空输入不会发命令,手动塞一条
    app.entries.push(Entry::User {
        text: "搜索代码".into(),
    });

    // 3 个 tool_started(并发只读工具,同一步)
    app.on_ipc(ev(HostEvent::ToolStarted {
        id: "t1".into(),
        name: "grep".into(),
        arguments: r#"{"pattern":"foo","path":"src"}"#.into(),
    }));
    app.on_ipc(ev(HostEvent::ToolStarted {
        id: "t2".into(),
        name: "glob".into(),
        arguments: r#"{"pattern":"**/*.ts"}"#.into(),
    }));
    app.on_ipc(ev(HostEvent::ToolStarted {
        id: "t3".into(),
        name: "read_file".into(),
        arguments: r#"{"path":"src/app.ts"}"#.into(),
    }));

    // 3 个 tool_completed(按任意顺序回来)
    app.on_ipc(ev(HostEvent::ToolCompleted {
        id: "t2".into(),
        name: "glob".into(),
        output: "file1.ts\nfile2.ts".into(),
    }));
    app.on_ipc(ev(HostEvent::ToolCompleted {
        id: "t1".into(),
        name: "grep".into(),
        output: "src/app.ts:10:foo".into(),
    }));
    app.on_ipc(ev(HostEvent::ToolCompleted {
        id: "t3".into(),
        name: "read_file".into(),
        output: "line1\nline2\nline3".into(),
    }));

    // 核心断言:3 个工具必须在一个 ToolBatch 里(摘要行 1 条,不是 3 条)
    let batch_count = app
        .entries
        .iter()
        .filter(|e| matches!(e, Entry::ToolBatch(_)))
        .count();
    assert_eq!(
        batch_count, 1,
        "3 个并发工具应聚成 1 个 batch,实际 {} 个",
        batch_count
    );

    // 验证 batch 里有 3 个 items
    let batch = app
        .entries
        .iter()
        .find_map(|e| match e {
            Entry::ToolBatch(b) => Some(b),
            _ => None,
        })
        .expect("batch 不存在");
    assert_eq!(batch.items.len(), 3, "batch 应含 3 个工具");
    assert!(batch.is_finished(), "3 个结果都回来了,batch 应已完成");

    // 验证结果按 id 归位(不是按"最后一条")
    let grep_item = batch
        .items
        .iter()
        .find(|i| i.name == "grep")
        .expect("grep item 不在");
    assert!(grep_item.done, "grep 应已完成");
    assert_eq!(
        grep_item.result_summary, "1 处匹配",
        "grep 结果预览不对: {}",
        grep_item.result_summary
    );
}

#[test]
fn mutation_tool_gets_own_batch_and_auto_expands() {
    // mutation(write_file/edit_file)独占一批,结果一回来就自动展开。
    let mut app = App::hollow();
    app.project_root = "F:\\mocode".into();
    app.provider = "openai".into();

    // 先来一个普通工具,再 mutation,再一个普通工具 —— 验证批边界
    app.on_ipc(ev(HostEvent::ToolStarted {
        id: "r1".into(),
        name: "read_file".into(),
        arguments: r#"{"path":"src/a.ts"}"#.into(),
    }));
    app.on_ipc(ev(HostEvent::ToolStarted {
        id: "w1".into(),
        name: "write_file".into(),
        arguments: r#"{"path":"src/b.ts","content":"hello"}"#.into(),
    }));
    app.on_ipc(ev(HostEvent::ToolStarted {
        id: "r2".into(),
        name: "grep".into(),
        arguments: r#"{"pattern":"bar"}"#.into(),
    }));

    // 结果回来
    app.on_ipc(ev(HostEvent::ToolCompleted {
        id: "r1".into(),
        name: "read_file".into(),
        output: "content".into(),
    }));
    app.on_ipc(ev(HostEvent::ToolCompleted {
        id: "w1".into(),
        name: "write_file".into(),
        output: "已写入 src/b.ts".into(),
    }));
    app.on_ipc(ev(HostEvent::ToolCompleted {
        id: "r2".into(),
        name: "grep".into(),
        output: "no match".into(),
    }));

    // 应有 3 个 batch:普通批(1个) + mutation独占批(1个) + 普通批(1个)
    let batches: Vec<&ToolBatch> = app
        .entries
        .iter()
        .filter_map(|e| match e {
            Entry::ToolBatch(b) => Some(b),
            _ => None,
        })
        .collect();
    assert_eq!(batches.len(), 3, "应 3 个 batch:普通/mutation/普通");

    // mutation 批应该 standalone=true 且自动展开
    let mutation_batch = batches
        .iter()
        .find(|b| b.standalone)
        .expect("没找到 mutation 独占批");
    assert!(mutation_batch.expanded, "mutation 批应自动展开第一层");
    assert!(
        mutation_batch.detail_expanded.contains(&0),
        "mutation 批应自动展开完整输出"
    );
    assert_eq!(mutation_batch.items.len(), 1, "mutation 批应只有 1 个工具");
    assert!(mutation_batch.items[0].name == "write_file");
}

#[test]
fn edit_file_renders_a_diff_block_end_to_end() {
    // 端到端:tool_started 带 old_string/new_string → tool_completed 后,
    // 渲染结果里必须出现 `Update(path)` 头行与 +/- gutter。
    //
    // 这条覆盖的是 Rust 侧特有的约束:`tool_completed` 事件**不带参数**,
    // diff 只能靠 `tool_started` 缓存下来的 arguments 现算(TS 侧在 agent
    // 进程内同时持有两者)。缓存一旦丢,diff 会静默变成纯文本输出。
    let mut app = App::hollow();
    app.project_root = "F:\\mocode".into();
    app.provider = "openai".into();

    let args = serde_json::json!({
        "path": "src/wrap.rs",
        "old_string": "let a = 1;\nlet b = 2;\nlet c = 3;",
        "new_string": "let a = 1;\nlet b = 20;\nlet c = 3;",
    })
    .to_string();

    app.on_ipc(ev(HostEvent::ToolStarted {
        id: "e1".into(),
        name: "edit_file".into(),
        arguments: args,
    }));
    app.on_ipc(ev(HostEvent::ToolCompleted {
        id: "e1".into(),
        name: "edit_file".into(),
        output: "已事务化编辑 src/wrap.rs".into(),
    }));

    let batch = app
        .entries
        .iter()
        .find_map(|e| match e {
            Entry::ToolBatch(b) if b.standalone => Some(b),
            _ => None,
        })
        .expect("edit_file 应独占一个 batch");
    let item = &batch.items[0];
    assert!(
        item.diff_block.is_some(),
        "mutation 成功后应渲染出 diff 块,实际为 None"
    );
    assert!(
        item.result_summary.is_empty(),
        "有 diff 时单行预览应留空,避免与 diff 重复:{:?}",
        item.result_summary
    );

    // 走真实 draw 管线,断言 diff 真的落到了屏幕上。
    let mut term = Terminal::new(TestBackend::new(100, 40)).unwrap();
    term.draw(|f| ui::draw(f, &mut app)).unwrap();
    let screen = rendered_rows(term.backend().buffer()).join("\n");

    assert!(
        screen.contains("Update(") && screen.contains("src/wrap.rs"),
        "渲染结果缺少 Update(path) 头行:\n{screen}"
    );
    assert!(
        screen.contains("let b = 20;"),
        "渲染结果缺少新增行内容:\n{screen}"
    );
    // gutter:删除行 `-` 与新增行 `+` 各至少一条。
    assert!(
        screen.contains("- let b = 2;") || screen.contains("-  let b = 2;"),
        "渲染结果缺少 `-` 删除行:\n{screen}"
    );
    assert!(
        screen.contains("+ let b = 20;") || screen.contains("+  let b = 20;"),
        "渲染结果缺少 `+` 新增行:\n{screen}"
    );
}

#[test]
fn failed_mutation_falls_back_to_plain_output() {
    // 失败的 mutation 不该渲染 diff(参数没生效,画出来是假的),
    // 必须回落到普通结果预览。
    let mut app = App::hollow();
    app.project_root = "F:\\mocode".into();

    let args = serde_json::json!({
        "path": "src/x.rs",
        "old_string": "a",
        "new_string": "b",
    })
    .to_string();

    app.on_ipc(ev(HostEvent::ToolStarted {
        id: "e2".into(),
        name: "edit_file".into(),
        arguments: args,
    }));
    app.on_ipc(ev(HostEvent::ToolCompleted {
        id: "e2".into(),
        name: "edit_file".into(),
        output: "错误: CHANGE_CONFLICT: src/x.rs was not changed.".into(),
    }));

    let batch = app
        .entries
        .iter()
        .find_map(|e| match e {
            Entry::ToolBatch(b) if b.standalone => Some(b),
            _ => None,
        })
        .expect("edit_file 应独占一个 batch");
    let item = &batch.items[0];
    assert!(item.failed, "错误输出应被判定为失败");
    assert!(item.diff_block.is_none(), "失败的 mutation 不应渲染 diff");
    assert!(
        !item.result_summary.is_empty(),
        "失败时应保留结果预览供用户看到原因"
    );
}

#[test]
fn text_delta_flushes_open_tool_batch() {
    // 正文出现说明工具批结束了 —— 先收口。
    // 空行由 build_rows 在 batch 尾部自动追加(不落 entries)。
    let mut app = App::hollow();
    app.project_root = "F:\\mocode".into();
    app.provider = "openai".into();

    // 工具开始
    app.on_ipc(ev(HostEvent::ToolStarted {
        id: "g1".into(),
        name: "grep".into(),
        arguments: r#"{"pattern":"foo"}"#.into(),
    }));
    app.on_ipc(ev(HostEvent::ToolCompleted {
        id: "g1".into(),
        name: "grep".into(),
        output: "match1".into(),
    }));

    // 正文 delta 到达 → 应触发 flush_tool_batch(批收口)
    app.on_ipc(ev(HostEvent::TextDelta {
        text: "根据搜索结果".into(),
    }));

    // 验证:batch 已完成(finished_ms 非 None),且后面跟着 assistant 正文
    let batch = app
        .entries
        .iter()
        .find_map(|e| match e {
            Entry::ToolBatch(b) => Some(b),
            _ => None,
        })
        .expect("batch 不存在");
    assert!(
        batch.finished_ms.is_some(),
        "text_delta 后 batch 应已收口(finished_ms 非 None)"
    );

    let has_assistant = app
        .entries
        .iter()
        .any(|e| matches!(e, Entry::Assistant { text } if text.contains("根据搜索结果")));
    assert!(has_assistant, "缺少 assistant 正文");

    // 验证渲染后的输出里有空行分隔(batch 尾部自带空行)
    let mut term = Terminal::new(TestBackend::new(80, 30)).unwrap();
    term.draw(|f| ui::draw(f, &mut app)).unwrap();
    let rows: Vec<String> = term
        .backend()
        .buffer()
        .content
        .chunks(80)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect();
    let has_blank = rows.iter().any(|r| r.trim().is_empty());
    assert!(has_blank, "渲染输出缺少空行分隔");
}

#[test]
fn run_completed_adds_change_overview_and_done_line() {
    let mut app = App::hollow();
    app.project_root = "F:\\mocode".into();
    app.provider = "openai".into();
    app.running = true;

    app.on_ipc(ev(HostEvent::RunCompleted {
        session_id: "s1".into(),
        completed: true,
        termination_reason: "stop".into(),
        changed_files: vec!["src/a.ts".into(), "src/b.rs".into()],
        usage: None,
        usage_percent: 15,
        context_window: 131072,
    }));

    // 应有 ChangeOverview + Blank + System(完成) + Blank
    let has_change = app
        .entries
        .iter()
        .any(|e| matches!(e, Entry::ChangeOverview { .. }));
    assert!(has_change, "缺少文件变更概览");

    let has_done = app
        .entries
        .iter()
        .any(|e| matches!(e, Entry::System { text, tone: Tone::Accent } if text.contains("完成")));
    assert!(has_done, "缺少完成行");

    assert!(!app.running, "run_completed 后应 running=false");
}
