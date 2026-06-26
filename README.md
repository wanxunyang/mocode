# 终端编码 Agent

一个最小可用的终端编码 agent:**LLM + tool-call 循环 + {读文件 / 写改文件 / 执行命令 / 搜索}**。
接任意 OpenAI 兼容接口(GLM、DeepSeek、Qwen、本地 Ollama/vLLM 等),交互式 REPL。

## 安装

```bash
cd terminal-agent
npm install
```

> `npm install` 后依赖会写进 `package.json`(运行时:`openai`、`dotenv`、`fast-glob`;开发:`tsx`、`typescript`、`@types/node`)。

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

> ⚠️ 模型必须支持 OpenAI 风格的 function calling(工具调用),否则工具不会触发。

## 运行

```bash
npm start
```

进入 REPL 后直接对话。启动即清屏,只留本次会话。内置命令:`/exit`(或 `/quit`)退出,`/clear` 清空历史并清屏。

agent 工作在**启动时所在的工作目录**——想让它操作某个项目,就 `cd` 到那个项目再 `npm start`(或把本目录加进 PATH)。

## 工具

| 工具 | 作用 |
|------|------|
| `read_file` | 读文件,带行号,支持 `offset`/`limit` |
| `write_file` | 创建/覆盖文件,自动建父目录 |
| `edit_file` | 精确字符串替换(`old_string` 须唯一匹配) |
| `run_command` | 执行 shell 命令,合并 stdout+stderr,默认 120s 超时 |
| `glob` | 按 glob 模式找文件(排除 node_modules/.git) |
| `grep` | 内容正则搜索,纯 JS 实现,不依赖 `rg` |

## 端到端冒烟(配好 key 后)

```
> 你好,你是谁                       # 验证 LLM 连通
> 读一下 sample.txt                 # 触发 read_file
> 把 sample.txt 里的 foo 改成 bar    # 触发 read_file + edit_file
> 列出当前目录所有 .txt 文件         # 触发 glob
> 搜一下代码里出现 runAgent 的地方   # 触发 grep
> 跑一下 node -e "console.log(1+1)"  # 触发 run_command
```

每步终端会打印 `[tool] 工具名  参数`,agent 在循环里自己决定下一步,最后给出文本回复。

## 结构

```
src/
├── index.ts   # REPL 入口(清屏 + 横幅 + readline 循环 + /exit /clear)
├── agent.ts   # tool-call 循环(调 LLM→执行工具→回灌→再调,最多 25 步)
├── llm.ts     # OpenAI 兼容客户端 + 工具格式转换 + chat()
├── config.ts  # 读 .env、校验必填项、系统提示词
├── tools.ts   # 6 个工具 + JSON Schema + 调度器(统一 try/catch)
└── ui.ts      # TTY 感知的 ANSI 颜色 + 清屏
```

## 类型检查

```bash
npm run typecheck   # tsc --noEmit
```

## 可后续扩展

子 agent / 并行任务、流式输出、上下文自动压缩、权限确认 UI、代码图谱(CodeGraph)。当前版本是「最小可用的终端编码 agent」。
