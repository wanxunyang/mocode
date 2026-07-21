# MoCode 使用指南

> 面向首次使用和日常开发的菜单式帮助。命令在全屏 TUI 中输入；输入 `/` 可打开并筛选命令菜单。

## 帮助菜单

| 入口 | 适用场景 |
| --- | --- |
| [01 快速开始](#快速开始) | 安装、配置并启动第一个会话 |
| [02 日常对话](#日常对话) | 把需求交给 Agent，控制执行范围 |
| [03 命令行](#命令行) | 新建、恢复会话和设置沙箱根目录 |
| [04 TUI 命令菜单](#tui-命令菜单) | 在会话内管理配置、上下文、文件与界面 |
| [05 PLAN / AUTO](#plan--auto-模式) | 先调研规划，或直接执行 |
| [06 会话与回滚](#会话与回滚) | 恢复历史、中断任务、撤销文件变更 |
| [07 项目上下文](#项目上下文) | `MOCODE.md` 与 Skills |
| [08 配置参考](#配置参考) | 配置优先级和常用环境变量 |
| [09 常见问题](#常见问题) | 连不上模型、工具不调用、上下文过长等 |

---

## 快速开始

**1. 安装 Node.js 18 或更高版本，然后安装 MoCode：**

```bash
npm install -g mocode-ai
```

不想全局安装时，直接运行 `npx mocode-ai`。

**2. 配置一个支持 OpenAI 风格 function calling 的模型：**

```bash
mocode config
```

向导会写入全局配置 `~/.mocode/config`。也可以先运行 `mocode`，再在 TUI 输入 `/model` 配置。

**3. 在目标项目目录启动：**

```bash
mocode
```

例如：`cd your-project` 后再运行 `mocode`。Agent 的默认文件操作范围就是启动目录。

**4. 用一个可验证的目标开始：**

```text
请先阅读 README 和 package.json，告诉我如何启动项目；不要修改文件。
```

确认连通后，再给出明确的开发目标，例如“为登录接口补充参数校验，并运行相关验证”。

[↑ 返回帮助菜单](#帮助菜单)

## 日常对话

MoCode 会在“思考 → 调用工具 → 观察结果 → 再思考”的循环中自主推进任务。把**目标、约束和验证要求**放在一条消息里，效果最好：

```text
检查支付模块的重试逻辑，找出可能重复扣款的路径；先给我一个只读分析和修复计划，未经确认不要改文件。
```

实用提示：

- 先说明是否允许修改、是否允许执行命令，以及希望运行的验证。
- 对陌生项目，可先用 `/plan`，或直接要求“只读分析，不修改文件”。
- 任务运行中可按 `Ctrl+C` 打断当前轮次；不会留下半完成的工具调用。
- 在复杂任务中，Agent 可能维护 `.mocode/sessions/<session-id>/notes.md` 记录计划、发现与未决问题。

[↑ 返回帮助菜单](#帮助菜单)

## 命令行

| 命令 | 说明 |
| --- | --- |
| `mocode` | 在当前目录开启新会话。 |
| `mocode config` | 运行模型配置向导，写入 `~/.mocode/config`。 |
| `mocode --resume` | 列出已保存会话。 |
| `mocode --resume <id>` | 恢复指定会话。 |
| `mocode --sandbox-root <path>` | 覆盖本次运行的文件操作沙箱根目录。 |
| `npx mocode-ai` | 无需全局安装，直接运行。 |

从源码开发时使用 `npm start`；它直接通过 `tsx` 运行源码，不会执行发布版的后台更新检查。修改 TypeScript 后请重启该命令。

> `--sandbox-root` 的优先级高于 `SANDBOX_ROOT`；没有设置时，沙箱根目录为当前工作目录。

[↑ 返回帮助菜单](#帮助菜单)

## TUI 命令菜单

输入 `/` 打开下拉菜单，继续输入可筛选，`Esc` 取消。以下命令均在 TUI 中执行。

### 会话、上下文与界面

| 命令 | 作用 |
| --- | --- |
| `/exit`、`/quit` | 退出 MoCode。 |
| `/clear` | 清空会话历史并清屏，保留系统提示。 |
| `/context` | 查看 token 与消息数的上下文使用情况。 |
| `/compact [focus]` | 压缩旧历史；可附焦点，例如 `/compact 保留接口约定`。 |
| `/compact --force [focus]` | 即使可压缩内容很少也强制压缩早期对话。 |
| `/resume` | 在最近会话中选择并恢复。 |
| `/sessions` | 浏览全部已保存会话。 |
| `/rollback` | 选择一个轮次，按文件决定保留或撤销其快照中的改动。 |
| `/theme [name]` | 选择或直接切换颜色主题。 |

### 模型、输入与工具能力

| 命令 | 作用 |
| --- | --- |
| `/model` | 交互设置 Base URL、API Key、模型和上下文窗口；立即生效并持久化。 |
| `/skills` | 列出已发现的 Skills。 |
| `/image <path>` | 将本地图片附加到下一条消息。 |
| `/image list` | 查看待发送图片。 |
| `/image clear` | 清除待发送图片。 |
| `/pet` | 打开或断开可选桌宠窗口。 |
| `/pet skin` | 为已运行的桌宠选择皮肤。 |
| `/pet quit` | 完全关闭桌宠进程。 |

### 记忆与项目上下文

| 命令 | 作用 |
| --- | --- |
| `/init` | 让 Agent 扫描项目，生成或刷新 `MOCODE.md` 项目记忆。 |
| `/memory` | 查看跨会话长期记忆的索引。 |
| `/memory_switch [on|off]` | 开关长期记忆；更改后需重启 REPL 才能完整刷新工具集。 |
| `/memory_status` | 查看长期记忆开关状态。 |
| `/reflect` | 手动触发一次后台记忆反思。 |

[↑ 返回帮助菜单](#帮助菜单)

## PLAN / AUTO 模式

| 模式 | 适用情况 | 能力 |
| --- | --- | --- |
| **PLAN** | 先理解代码、评估风险、产出可审阅方案 | 只读调研与规划；不写文件、不执行命令、不派生子 Agent。 |
| **AUTO** | 需求明确，允许自主完成实现与验证 | 完整工具集，可读写文件、执行命令并派生子 Agent。 |

- `/plan` 切换到 PLAN 模式。它适合“先分析、不要改动”的任务。
- `/auto` 切回 AUTO 模式，允许执行方案。
- 在支持的终端中，`Shift+Tab` 也可切换到 PLAN；若输入法或终端吞掉该按键，使用 `/plan` 即可。

[↑ 返回帮助菜单](#帮助菜单)

## 会话与回滚

每轮对话会自动保存。启动时可用 `mocode --resume` 查找会话，或在 TUI 用 `/resume` 选择最近会话；需要浏览更久以前的历史时使用 `/sessions`。

文件修改前会按轮次创建快照。使用 `/rollback` 选中目标轮次后，可逐文件决定**保留**或**撤销**。从旧会话恢复但没有相应快照的改动无法通过该功能撤销；重要改动仍建议放在 Git 版本控制下。

[↑ 返回帮助菜单](#帮助菜单)

## 项目上下文

MoCode 通过 `MOCODE.md` 与 Skills 理解项目：

| 功能 | 默认状态 | 内容与操作 |
| --- | --- | --- |
| **`MOCODE.md`** | 按文件存在情况加载 | 每轮自动加载的 Markdown 项目记忆（同时覆盖静态文件结构、命令清单与项目约定/坑点）。用 `/init` 生成初稿，随后可手工维护。 |
| **Skills** | 按需加载 | 通过 `use_skill` 工具按需加载的额外能力。详见 `~/.mocode/skills/` 与 `.mocode/skills/`。 |

Skills 则是可复用的任务说明。MoCode 默认扫描：

- `~/.claude/skills/`
- `~/.mocode/skills/`
- `<项目目录>/.mocode/skills/`

每个 Skill 是带 frontmatter 的 `<名称>/SKILL.md`。系统先加载其 `description`，任务相关时再加载完整内容。用 `SKILLS_DIRS` 可覆盖默认扫描目录；Windows 用 `;` 分隔多个路径，macOS/Linux 用 `:`。

[↑ 返回帮助菜单](#帮助菜单)

## 配置参考

### 配置加载优先级

以下来源从低到高覆盖；已在 shell 中设置的环境变量始终最高优先级：

1. `<当前目录>/.env`（兼容旧用法）
2. `~/.mocode/config`（`mocode config` 与 `/model` 写入的位置）
3. `<当前目录>/.mocode/config`（项目级覆盖）
4. Shell 环境变量

最小配置：

```env
LLM_BASE_URL=https://api.example.com/v1
LLM_API_KEY=your-api-key
LLM_MODEL=your-model-name
```

模型必须支持 **OpenAI 风格的 function calling**，否则 MoCode 无法可靠调用工具。

### 常用环境变量

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `CONTEXT_WINDOW_TOKENS` | 模型实际上下文窗口大小。 | `128000` |
| `MAX_TOKENS` | 单次回复最大 token 数。 | 不限制 |
| `AUTO_COMPACT` | 上下文自动压缩开关。 | `true` |
| `MOCODE_AUTO_VALIDATE` | 代码变更后自动发现并运行 `typecheck` / `test` / `build`；失败会回灌 Agent 修复。 | `true` |
| `COMPACT_THRESHOLD` | 自动压缩阈值，占窗口比例。 | `0.85` |
| `MAX_STEPS` | 每轮 Agent 工具循环的最大步数。 | `200` |
| `SUB_AGENT_MAX_STEPS` | 子 Agent 默认最大步数。 | `50` |
| `SANDBOX_ROOT` | 文件操作与命令工作目录的沙箱根。 | 当前工作目录 |
| `MEMORY_ENABLED` | 跨会话长期记忆开关。 | `false` |
| `MOCODE_THEME` | TUI 颜色主题。 | `default` |
| `ANYSEARCH_API_KEY` | 可选联网搜索 API Key。 | 未设置时使用匿名免费额度 |

完整注释示例见仓库根目录的 [`.env.example`](../.env.example)。

[↑ 返回帮助菜单](#帮助菜单)

## 常见问题

**启动后无法回复，或提示未配置模型**  
运行 `mocode config` 或 TUI 中的 `/model`，检查 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 三项。若 shell 中设置了同名变量，它会覆盖配置文件值。

**Agent 不调用工具**  
确认模型和后端支持 OpenAI 风格 function calling；纯文本聊天模型无法可靠执行工具调用。

**Agent 操作了错误目录，或文件被沙箱拒绝**  
在正确项目目录启动 `mocode`，或明确设置 `--sandbox-root <path>` / `SANDBOX_ROOT`。沙箱会拒绝越界相对路径、沙箱外绝对路径和符号链接逃逸。

**上下文快满了**  
使用 `/context` 查看用量，使用 `/compact` 压缩；也可以缩小任务、明确焦点，或将 `CONTEXT_WINDOW_TOKENS` 设置为模型真实窗口。

**联网搜索失败或限流**  
可设置 `ANYSEARCH_API_KEY` 使用自己的额度；不设置时会使用匿名免费额度并受 IP 限流。

---

还需要定位具体能力时，可从 [帮助菜单](#帮助菜单) 返回，或在 TUI 输入 `/` 查看当前版本实际提供的命令。
