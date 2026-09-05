# Agent Coding Benchmark 使用说明

EVAL-01 会让 Mocode 在一次性临时仓库中执行完整的编码任务，经过“模型分析 → 调用工具 → 修改文件 → agent 自主决定是否验证”的链路；任务结束后由 benchmark harness 独立运行 verifier 评分。它不是普通的函数单元测试。

固定测试集包含 61 个任务，分为三个难度层级：

- `basic`：21 道基础题，验证常见编辑、工具链和多文件边界能力。
- `hard`：20 道困难题，验证并发、事务、安全、缓存、流式处理和跨文件修复。
- `advanced`：20 道高级题，验证状态机、原子性、协议解析、调度、增量构建和隔离语义。

题目覆盖：

- 单文件修复和多文件功能开发
- TypeScript 类型错误和测试失败
- CRLF 换行符保持和编辑冲突恢复
- timeout、abort 和 rollback 安全性
- 长上下文、monorepo 和无测试框架项目

## 运行前准备

先在项目根目录打开 PowerShell：

```powershell
cd F:\mocode
```

确保 Mocode 已配置可用的模型。Benchmark 使用当前的 `LLM_MODEL`、`LLM_BASE_URL` 和 `LLM_API_KEY` 配置。

注意：真正执行任务会调用模型并消耗 API token。仅列出任务和运行 smoke 不会调用模型。

## 查看全部任务

```powershell
npm run eval:coding:list
```

也可以直接运行下面的命令。没有指定任务时只显示任务列表，不会开始全量评测：

```powershell
npm run eval:coding
```

## 运行单个任务

建议先用单题确认模型和环境配置正常：

```powershell
npm run eval:coding -- --task single-01
```

其他任务 ID 可以通过 `npm run eval:coding:list` 查看。

## 运行一个任务组

例如运行 monorepo 任务：

```powershell
npm run eval:coding -- --group monorepo
```

可用分组包括：

- `single-file`
- `multi-file`
- `types`
- `tests`
- `resilience`
- `context`
- `monorepo`
- `no-tests`

## 按难度运行

运行 21 道基础题：

```powershell
npm run eval:coding -- --group basic
```

运行 20 道困难题：

```powershell
npm run eval:coding -- --group hard
```

运行 20 道高级题：

```powershell
npm run eval:coding -- --group advanced
```

建议分开运行三个难度，避免一次评测消耗过多 token，也便于分别比较各难度成功率。

复杂题默认单题超时为 120 秒。需要给困难题更多时间时，可以覆盖为 300 秒（单位是毫秒）：

```powershell
npm run eval:coding -- --group hard --timeout 300000
```

超时任务即使留下的代码能够通过 verifier，也仍按超时失败计算，因为它没有在规定预算内完成 Agent 回合。

## 一次运行多个指定任务

任务 ID 使用英文逗号分隔：

```powershell
npm run eval:coding -- --task single-01,multi-01,types-01
```

## 运行全部 61 个任务

```powershell
npm run eval:coding -- --task all
```

全量运行会执行 61 个真实 Agent 任务，可能产生较高的耗时和 token 消耗。建议先分别运行 `basic`、`hard` 和 `advanced`。

完整运行会在执行前读取 `evals/baseline.json`。如果 baseline 已录制，runner 会校验 task 集合、模型和 Prompt，并对通过数、首补丁通过率、同工具恢复率及回归率执行退化门禁。

## 运行快速回归测试

下面的 smoke 会检查 runner 参数、schema v3、baseline 比较器、指标汇总、61 个 verifier 的语法以及所有初始仓库是否确实无法通过，但不会调用模型执行真实 Agent 任务：

```powershell
npm run eval:smoke
```

提交代码前建议一起运行：

```powershell
npm run eval:smoke
npm run typecheck
npm run build
```

## 查看评测报告

每次真实评测完成后会在下面的目录生成两份报告：

```text
F:\mocode\evals\results\
```

- `.json`：机器可读的 schema v3 报告，适合脚本分析和 baseline 对比。
- `.md`：人类可读汇总，适合直接查看任务结果。

核心指标：

- Final verified success：最终 verifier 通过、预期文件被追踪、verifier 未被篡改且未超时。
- First-patch pass：首个产生 workspace mutation 的完整工具批次结束后，对快照运行 verifier 的结果。
- Regression：独立 regression command 是否失败。
- Tool recovery：同一个工具名失败后是否在后续 model step 中成功；同批并发调用的完成顺序不计恢复，汇总分母是出现失败的 distinct tool name 数。
- Tool calls / retries：工具调用和模型请求重试次数。
- Tokens / Duration：模型 token 消耗和任务耗时，只报告，不作为阶段 0 门禁。

也可以用 `--out` 指定报告目录：

```powershell
npm run eval:coding -- --task single-01 --out F:\mocode\tmp\eval-report
```

## 固化当前 baseline

确认当前模型和 Prompt 是你想作为对照的版本后，运行完整测试并更新 baseline：

```powershell
npm run eval:coding -- --task all --update-baseline
```

`--update-baseline` 必须与 `--task all` 同时使用；runner 会在任何付费任务开始前校验这一点。Baseline 通过同目录临时文件原子替换，并显式保存 schema、61 个任务、模型、Prompt hash 和退化阈值。

成功运行后会更新：

```text
F:\mocode\evals\baseline.json
```

可以用 `--baseline <path>` 对临时 baseline 进行录制或比较。

## 推荐的首次测试顺序

```powershell
cd F:\mocode
npm run eval:smoke
npm run eval:coding:list
npm run eval:coding -- --task single-01
npm run eval:coding -- --group types
```

确认单题和各难度结果正常后，再决定是否运行全部 61 题并更新 baseline。
