<p align="center">
  <img src="./assets/banner.svg" alt="mocode" width="480">
</p>

# mocode

一个终端编码 agent:**LLM + tool-call 循环 + 流式输出 + 思考可见**。

接任意 OpenAI 兼容接口(GLM、DeepSeek、Qwen、本地 Ollama / vLLM 等),全屏 TUI 交互式 REPL。agent 自主探索代码、读写文件、执行命令、联网搜索,以「思考 → 调用工具 → 观察结果 → 再思考」的循环完成编程任务。

## 特性

- **流式输出** — 回复边生成边显示,模型支持 reasoning 时思考过程实时可见,思考段自动折叠(不占屏),`/think N` 按需展开
- **全屏 TUI** — 备用屏(alt screen)+ 固定底栏状态行 + 滚动回看(PgUp/PgDn),运行中可打字(typeahead),下一轮自动预填
- **9 个内置工具** — 读 / 写 / 改文件、执行命令、glob 找路径、grep 搜内容、联网搜索、抓取网页、加载 skill
- **会话持久化** — 每轮自动落盘,`--resume` / `/resume` 续接历史会话
- **轮次回滚** — `/rollback` 菜单选轮次,删该轮及之后 + 逐个文件「保留/撤销」(快照恢复,不依赖 git)
- **上下文工程** — 接近窗口上限时自动三层压缩,`/context` 实时显示 token 用量条,`/compact` 手动压缩(可带焦点)
- **Skills 系统** — 自动扫描 `~/.mocode/skills/` 等目录,description 注入系统提示,模型按需调 `use_skill` 加载完整指令
- **斜杠命令** — `/exit` `/clear` `/context` `/skills` `/compact` `/resume` `/think` `/rollback`,输入时下拉过滤
- **Ctrl+C 中断** — 运行中随时中断当前 agent 轮次(不退进程)

## 安装

```bash
cd mocode
npm install
```

> 依赖:`openai`、`dotenv`、`fast-glob`(运行时);`tsx`、`typescript`、`@types/node`(开发)。

## 配置

复制 `.env.example` 为 `.env`,填三个必填项:

```bash
cp .env.example .env
```

```env
LLM_BASE_URL=https://open.bigmodel.cn/api/v3   # 换成你的后端
LLM_API_KEY=your-key-here
LLM_MODEL=glm-4.6                              # 换成你的模型名
```

常见后端 `base_url`:

| 后端 | base_url |
|------|----------|
| GLM(智谱) | `https://open.bigmodel.cn/api/v3` |
| DeepSeek | `https://api.deepseek.com` |
| Qwen(阿里) | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 本地 Ollama | `http://localhost:11434/v1` |
| 本地 vLLM | `http://localhost:8000/v1` |

> 模型必须支持 OpenAI 风格的 function calling,否则工具不会触发。

### 可选配置

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `MAX_TOKENS` | 单次回复最大 token | 不限 |
| `CONTEXT_WINDOW_TOKENS` | 模型上下文窗口,须对齐真实模型 | `128000` |
| `COMPACT_THRESHOLD` | 自动压缩触发阈值(占窗口比例) | `0.85` |
| `LLM_STREAM_USAGE` | 流式请求带 `stream_options.include_usage` 拿真实用量 | `true` |
| `AUTO_COMPACT` | 自动压缩总开关 | `true` |
| `ANYSEARCH_API_KEY` | 联网搜索 API key(不配走匿名免费额度) | 无 |
| `ANYSEARCH_BASE_URL` | 搜索 API 端点 | `https://api.anysearch.com` |
| `SKILLS_DIRS` | 覆盖默认 skill 扫描目录(平台分隔符) | 三目录自动扫描 |

## 运行

```bash
npm start                          # 新会话
npm start -- --resume              # 列出已保存会话
npm start -- --resume <id>         # 续接指定会话
```

进入 REPL 后直接对话。启动即进全屏 TUI,显示横幅(模型 / 后端 / 工作目录 / 工具列表)。回复流式打印,思考段实时可见后折叠。

agent 工作在**启动时所在的工作目录**——想让它操作某个项目,就 `cd` 到那个项目再 `npm start`。

## 工具

| 工具 | 作用 |
|------|------|
| `read_file` | 读文件,带行号,支持 `offset` / `limit` |
| `write_file` | 创建/覆盖文件,自动建父目录 |
| `edit_file` | 精确字符串替换(`old_string` 须唯一匹配) |
| `run_command` | 执行 shell 命令,合并 stdout+stderr,默认 120s 超时 |
| `glob` | 按 glob 模式找文件(排除 node_modules/.git) |
| `grep` | 内容正则搜索,纯 JS 实现,不依赖 `rg` |
| `web_search` | 联网搜索(AnySearch),返回标题/URL/摘要/正文 |
| `web_fetch` | 抓取指定 URL,HTML 清洗成纯文本 |
| `use_skill` | 加载某 skill 的完整 SKILL.md 指令 |

## 斜杠命令

| 命令 | 作用 |
|------|------|
| `/exit` `/quit` | 退出 mocode |
| `/clear` | 清空历史(保留系统提示)+ 清屏 |
| `/context` | 显示上下文用量条(token / 消息数 / 估算或实测) |
| `/skills` | 列出已发现的 skill |
| `/compact` | 压缩历史(可带焦点 `/compact …`) |
| `/resume` | 续接已保存的会话 |
| `/think` | 展开折叠思考段(`/think N`) |
| `/rollback` | 菜单选轮次回滚(↑↓ · Enter) |

输入 `/` 触发下拉菜单,继续打字过滤;Esc 取消。

## 快速验证(配好 key 后)

```
> 你好,你是谁                       # 验证 LLM 连通
> 读一下 sample.txt                 # 触发 read_file
> 把 sample.txt 里的 foo 改成 bar    # 触发 read_file + edit_file
> 列出当前目录所有 .txt 文件         # 触发 glob
> 搜一下代码里出现 runAgent 的地方   # 触发 grep
> 跑一下 node -e "console.log(1+1)"  # 触发 run_command
> 搜一下 TypeScript 5.5 有什么新特性  # 触发 web_search
```

每步终端会打印 `● 工具名 + 参数摘要` 与 `↳ 结果预览`,agent 在循环里自己决定下一步;回复流式打印,边生成边显示。

## Skills

mocode 自动扫描以下目录的 skill(每个 skill 是 `<name>/SKILL.md`,带 frontmatter):

- `~/.claude/skills/`
- `~/.mocode/skills/`
- `<cwd>/.mocode/skills/`

skill 的 `description` 注入系统提示(渐进式披露第①层),模型只在任务相关时调 `use_skill` 加载完整正文(第②层)。用 `/skills` 查看已发现的 skill。

## 结构

```
src/
├── index.ts              # 入口:装配 + 启动 REPL + --resume 续接
├── repl/index.ts         # 全屏 TUI、斜杠命令、运行态交互、Ctrl+C 中断
├── agent/index.ts        # tool-call 循环(调 LLM→执行工具→回灌→再调,≤25 步)
├── llm/index.ts          # OpenAI 兼容客户端 + 工具格式转换 + chat() 流式
├── tools/                # types / constants / registry + builtins/(一工具一文件)
│   └── builtins/         # read-file write-file edit-file run-command glob grep
│                          # web-search web-fetch use-skill
├── config/index.ts       # 读 .env、校验必填项、系统提示词
├── skills/               # discover(扫描)+ index(缓存/拼系统提示)
├── session/              # 落盘/续接 + compact(三层压缩)+ token 估算
├── rollback/             # 轮次快照 + /rollback 菜单 + 文件撤销
├── ui/                   # theme(颜色)render(横幅/摘要)layout(全屏布局)spinner prompt
└── agents/ commands/ mcp/ memory/ permissions/   # 未来子系统(空骨架)
```

## 类型检查

```bash
npm run typecheck   # tsc --noEmit
```

## 可后续扩展

子 agent / 并行任务、MCP 工具集成、权限确认 UI、代码图谱(CodeGraph)。当前版本是一个流式、思考可见、可回滚的终端编码 agent。
