# Coding Eval Runbook

参数和 fixture 的详细事实源是 [`evals/README.md`](../../evals/README.md)。本页说明成本分层、失败分类和 baseline 治理。

## 1. 免费路径

以下命令不调用模型：

```powershell
npm run eval:smoke
npm run eval:coding:list
npm run eval:coding
```

无 selection 的 `eval:coding` 只列任务并提示选择。先让 smoke 和 list 成功，再考虑真实任务。

## 2. 付费路径与成本

真实 task 使用当前配置中的 provider/base URL/API key/model，没有 `--model` 参数。按成本逐级扩大：

```powershell
# 单题
npm run eval:coding -- -- --task single-01

# 多题或一个分组
npm run eval:coding -- -- --task single-01,multi-01,types-01
npm run eval:coding -- -- --group types

# 全量：明确付费，普通 PR 不运行
npm run eval:coding -- -- --task all
```

额外的 `--` 是 npm 参数分隔符，runner 会忽略。支持 `--out <dir>`、`--baseline <path>`、`--timeout <positive-ms>`、`--keep-workspaces` 和 `--list`；selection 优先级为 task > group > positional。默认任务超时 120000ms，fixture 可覆盖；独立 verifier 默认 15000ms。

普通贡献者不应为“证明更绿”而运行全量或改 baseline。PR 模板必须标明 eval 层级和成本理由。

## 3. 推荐诊断顺序

1. `npm run eval:smoke`
2. `npm run eval:coding:list`
3. 确认当前 model/provider 和配置优先级，不输出 key
4. 只跑一个相关 task，并使用临时报告目录：

```powershell
npm run eval:coding -- -- --task <id> --keep-workspaces --out "$env:TEMP\mocode-eval-report"
```

5. 在保留的 `$env:TEMP\mocode-eval-<fixture>-*` workspace 手工执行 fixture 的 `node verify.mjs`
6. 检查 JSON 的 `status`、`error`、`changedFiles`、`firstPatchPass`、`regression`、`toolRecovery`、duration/tokens
7. 单题稳定后才扩大到 group/all

POSIX 使用 `$TMPDIR` 或 `mktemp -d`。

## 4. 失败分类

- `timeout`：Agent controller 超时；即使残留代码能过 verifier仍失败。
- `error`：Agent/Runtime/provider/tool 抛错。
- `failed`：Agent结束，但 final verifier、expected changed files 或 verifier 完整性至少一项失败。
- `regression=true`：独立 regression command 失败，与主 status 分开判断。
- baseline preflight/comparison：模型、prompt hash、task identity 或指标退化，不等同单题代码失败。
- runner/报告/临时目录/Node 权限错误：基础设施失败，先修环境，不计为模型能力。

默认报告写到被忽略的 `evals/results/<timestamp>.json/.md`；报告中的路径和后端错误仍需脱敏，不提交真实 workspace、session 或用户数据。

## 5. Baseline 更新

只有 maintainer 在完整任务、固定模型、固定 prompt、全量结果经评审后执行：

```powershell
npm run eval:coding -- -- --task all --update-baseline
```

runner 会拒绝其它 selection 搭配 `--update-baseline`。更新 PR 必须审查 schema、task IDs、model、prompt hash、各项阈值和完整报告，不能只看总通过数。普通修复 PR 不更新 baseline。
