# Agent Coding Benchmark 使用说明

EVAL-01 会让 Mocode 在一次性临时仓库中执行完整的编码任务，实际经过“模型分析 → 调用工具 → 修改文件 → 自动验证”的完整链路。它不是普通的函数单元测试。

固定测试集包含 20 个任务，覆盖：

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
npm run eval:coding -- -- --task single-01
```

其他任务 ID 可以通过 `npm run eval:coding:list` 查看。

## 运行一个任务组

例如运行两个 monorepo 任务：

```powershell
npm run eval:coding -- -- --group monorepo
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

## 一次运行多个指定任务

任务 ID 使用英文逗号分隔：

```powershell
npm run eval:coding -- -- --task single-01,multi-01,types-01
```

## 运行全部 20 个任务

```powershell
npm run eval:coding -- -- --task all
```

全量运行会连续调用当前模型 20 次或更多次，耗时和 token 消耗取决于模型表现。

## 运行快速回归测试

下面的 smoke 只检查 benchmark runner、fixture 和指标汇总等基础逻辑，不会执行 20 个真实 Agent 任务：

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

- `.json`：机器可读报告，适合脚本分析和不同版本对比。
- `.md`：人类可读汇总，适合直接查看任务结果。

报告包含以下核心指标：

- Final verified success：最终验证成功率
- First-patch pass：首次修改通过率
- Regression：是否产生回归
- Tool recovery：工具失败后是否恢复
- Tool calls：工具调用次数
- Tokens：模型 token 消耗
- Duration：任务耗时
- Unverified completion：Agent 声称完成但最终验证失败

也可以用 `--out` 指定报告目录：

```powershell
npm run eval:coding -- -- --task single-01 --out F:\mocode\tmp\eval-report
```

## 固化当前 baseline

确认当前模型和 Prompt 是你想作为对照的版本后，运行完整测试并更新 baseline：

```powershell
npm run eval:coding -- -- --task all --update-baseline
```

成功运行后会更新：

```text
F:\mocode\evals\baseline.json
```

`--update-baseline` 只允许用于完整的 `all` 测试，避免用单题或部分任务意外覆盖正式基线。

## 推荐的首次测试顺序

```powershell
cd F:\mocode
npm run eval:smoke
npm run eval:coding:list
npm run eval:coding -- -- --task single-01
npm run eval:coding -- -- --group types
```

确认单题和小组结果正常后，再决定是否运行全部 20 题并更新 baseline。
