# Agent Coding Benchmark 使用说明

EVAL-01 会让 MoCode 在一次性临时仓库中执行完整的编码任务，经过“模型分析 → 调用工具 → 修改文件 → agent 自主决定是否验证”的链路；任务结束后由 benchmark harness 独立运行 verifier 评分。它不是普通的函数单元测试。

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

确保 MoCode 已配置可用的模型。Benchmark 使用当前的 `LLM_MODEL`、`LLM_BASE_URL` 和 `LLM_API_KEY` 配置。

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

例如运行 monorepo 任务：

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

## 按难度运行

运行 21 道基础题：

```powershell
npm run eval:coding -- -- --group basic
```

运行 20 道困难题：

```powershell
npm run eval:coding -- -- --group hard
```

运行 20 道高级题：

```powershell
npm run eval:coding -- -- --group advanced
```

建议分开运行三个难度，避免一次评测消耗过多 token，也便于分别比较各难度成功率。

复杂题默认单题超时为 120 秒。需要给困难题更多时间时，可以覆盖为 300 秒（单位是毫秒）：

```powershell
npm run eval:coding -- -- --group hard --timeout 300000
```

超时任务即使留下的代码能够通过 verifier，也仍按超时失败计算，因为它没有在规定预算内完成 Agent 回合。

## 一次运行多个指定任务

任务 ID 使用英文逗号分隔：

```powershell
npm run eval:coding -- -- --task single-01,multi-01,types-01
```

## 运行全部 61 个任务

```powershell
npm run eval:coding -- -- --task all
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
npm run eval:coding -- -- --task single-01 --out F:\mocode\tmp\eval-report
```

## 固化当前 baseline

确认当前模型和 Prompt 是你想作为对照的版本后，运行完整测试并更新 baseline：

```powershell
npm run eval:coding -- -- --task all --update-baseline
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
npm run eval:coding -- -- --task single-01
npm run eval:coding -- -- --group types
```

确认单题和各难度结果正常后，再决定是否运行全部 61 题并更新 baseline。
## 记忆检索基线（R15）

`evals/memory-retrieval.ts` 测的是记忆检索的**纯排序质量**，与上面的编码 benchmark 无关：零 LLM、零网络、零写盘，秒级完成。它回答「记忆库里的东西，用户这么问能不能被找出来」。

```powershell
npm run eval:memory-retrieval        # 冻结语料（fixture），确定可复现，可进 CI
npm run eval:memory-retrieval:live   # 同一组探针直读本机真实记忆库，看漂移
```

两份数据：

- `evals/memory-retrieval/corpus.json`：17 条脱敏冻结语料（本仓库 project 15 条 + 可公开的 2 条 global 结构类）。**个人向条目一律不进**（职业、雇主、器材、所在地），`tests/memory/memory-retrieval.test.ts` 有硬断言守这条边界。
- `evals/memory-retrieval/queries.json`：57 条探针（51 有效 + 6 负例），按 `kind` 分为 `cjk` / `english` / `exact` / `cross-field` / `mixed` / `negative`。期望值写的是**正确答案**，不是当前实现的答案——跑出来不达标也是结论。

输出三块：分词消融表（`both` / `bigram` / `unigram` 三档的 recall@1/3/5 + MRR + 负例误报）、生产配置的分项与未命中名单（recall@1 与 @3 分开列，因为「答案不在」和「答案在但没排第一」是两种问题）、相关性下限的分数分布与阈值扫描。

评测**不走** `store.ts` 的 `searchEntries()`：那个函数会 bump `recallCount` 并往脏集写入，等于评测顺手改了被评测的数据。脚本改为在内存里直接建 `TextSearchIndex`，字段权重与生产抄一致（这份重复是刻意的——两边漂移时数字会立刻变化，而不是悄悄测成另一个系统）。

`corpus.json` 需要扩语料时，从真实库导出后必须重新跑 `tests/memory/memory-retrieval.test.ts`，隐私断言会把不该进来的条目挡下来。

`evals/memory-compact-handoff.ts`（`npm run eval:memory-handoff`）是另一条记忆评测：压缩→记忆交接的真实验收，**需要 LLM 配置**，无密钥时打印 skip 并 exit 0。

## 短路径效率基准（short-path）

`evals/short-path/` 回答另一个维度的问题：**coding benchmark 测「能不能做到」，这里测「做到了但绕了多远」。** 针对「简单任务走长路径」「已有上下文还重新探索」两类浪费给出可量化的标尺。指标定义借鉴 SWE-Effi（资源约束下的有效性）与 HAL（cost-of-pass）的思路，任务与指标全部本地计算。

### 复杂度分级（L1-L10，对标 SWE-bench / Terminal-Bench / METR time-horizon 口径）

| 级别 | 定义 | 覆盖 |
|---|---|---|
| L1 | 机械单点：单文件单处修改，无需理解逻辑（常量/拼写/导出缺失/文案/风格） | 12 题 |
| L2 | 单文件逻辑修复：需理解函数内行为（边界/异步/正则/算法小错） | 12 题 |
| L3 | 多文件局部修复：2-3 文件调用链，带精确提示（路径/堆栈/复现） | 16 题 |
| L4 | 会话内上下文延续：先建上下文再追加小改动 | 16 题 |
| L5 | 真实仓库定位 + 增量修改：陌生仓库定位 leaf 模块做增量任务 | 12 题 |
| L6 | 多文件功能开发：只给新文件名+导出签名+行为契约，无实现模板 | 16 题 |
| L7 | 测试驱动修复/重构：按测试补实现或重构，含 CRLF/事务等边界语义 | 预留 |
| L8 | 跨模块重构：API 变更跨包传导、monorepo 边界、契约同步 | 预留 |
| L9 | 系统级任务：并发/事务/缓存/流式等横切语义，性能与正确性双约束 | 预留 |
| L10 | 长程工程：架构级、多阶段规格演进的长 horizon 任务 | 预留 |

level 与 scenario（运行形态）正交：L1/L2 跑 micro 形态、L3 hinted、L4 warm、L5 repo、L6 复用 hinted 形态（spec 驱动的功能开发）。`--level N` 按级选题；报告自动输出按级小计。基线按运行组分文件（`baseline-<group>.json`，L6 为 `baseline-l6.json`）。

四个场景层（共 84 题，按任务形态保持多样性）：

- `micro`（24 题 = L1×12 + L2×12）：单文件小修，gold 路径 ≈ read → edit（→ verify）。测会不会直奔目标。形态覆盖：常量/类型、导出缺失、拼写、文案、风格、边界条件、默认参数、比较器、正则/格式化、异步 await、空值保护、命名转换等。
- `hinted`（16 题）：多文件迷你仓库，任务文本自带精确路径/报错。测会不会利用提示省掉全树搜索。形态覆盖：堆栈定位、遍历优先级、URL 编码、大小写归一、二分边界、监听器泄漏、Promise 部分失败、LRU 淘汰、TTL 边界、引号解析等。
- `warm`（16 题）：**两段式会话**——第一轮只读预热建立上下文（不计分），第二轮在同一段 history 上追加小改动任务（计分）。测会不会复用上下文而不是重新探索。预热形态覆盖：双文件对比（含干扰项）、跨文件调用链、诊断后再修、测试优先（verifier 即测试，防篡改布局）、配置 schema、枚举扩展、文案变更等。预热轮发生任何改动直接判失败。
- `repo`（12 题）：**self-host 真实仓库**——把 `git archive HEAD` 解包到临时目录、junction 共享主仓库 node_modules，在 mocode 自己的代码上做增量任务（新增导出函数），verifier 用 tsx 对真实 TS 模块做运行时断言。目标模块覆盖 12 个纯叶子文件：changeset（hash/unified-diff）、tools/result、session（trace-sanitize）、jobs/dir-snapshot、context/request-limit、i18n、attachments/image、llm（token 估算）、models/catalog、permissions、sandbox/command。测 AGENTS.md 目录指引的真实利用效率。
- `l6`（16 题）：**功能开发**——迷你仓库（事件总线/DI 容器/限流器/求值器/插件系统等），只给新文件名+导出签名+行为契约，不给实现模板；agent 自行设计内部结构。verifier 静态 import 新导出，未实现必失败。gold ≤ 10 次调用。

核心指标（全部由 trace 事件归约，见 `src/session/short-path-metrics.ts`）：

- **path ratio** = 实际工具调用数 / gold 上限。micro 目标 < 2.0x，repo < 3.0x。
- **首改前模型请求数 / 只读调用数**：首个 workspace mutation 之前烧掉多少探索成本。
- **重复相同只读调用**：相同（工具， 参数指纹）的重复 read/grep/glob，除首次外全部计冗余。
- **改后再探索**：首个 mutation 之后的只读调用数。
- **分阶段开销**：预路由、主模型请求和重试、改后命令，以及最后一次工具调用之后的模型收尾。报告展示通过题的端到端 P50/P95 和未命中缓存的输入 token。端到端耗时含路由和 warm 预热，独立判分脚本在其后执行。

运行：

```powershell
npm run eval:short:list
npm run eval:short -- --task micro-01
npm run eval:short -- --group micro        # 单场景组运行(混合场景会被拒绝:AGENTS.md 注入随场景变化)
npm run eval:short -- --group repo         # 真实仓库层,单题预算 300s
npm run eval:short -- --group micro --update-baseline   # 录制基线(按场景分文件:baseline-<scenario>.json)
npm run eval:short -- --group micro --efficiency-gate   # 效率劣化从告警升级为阻断
```

用 `--group locate` 对照首次成功编辑前的探索成本。该组包含已知路径、只知符号和同名歧义三类任务，每类两题。使用相同模型、思考强度和路由配置执行两组命令。

```bash
npm run eval:short -- --group locate --without-grep-edit-context --out evals/results/short-path/locate/control
npm run eval:short -- --group locate --out evals/results/short-path/locate/optimized
```

报告列出首次文件编辑尝试是否实际应用、首次成功编辑前已完成的模型请求数、工具文本输出 token 估算和未缓存输入 token。工具文本按历史上限计量，失败编辑返回的文本也计入重试成本。未缓存输入包含生成首次成功编辑调用的请求，要求 provider 完整提供缓存用量。独立 verifier 另外检查最终结果与同名候选是否保持预期内容。

验证证据实验默认关闭。设 `MOCODE_VERIFICATION_EVIDENCE=true` 后，改动后的常见验证命令通过时，下一次模型请求会收到该命令的结果提示。对照时比较末改后的模型请求数、验证命令数和独立 verifier 通过率。命令仍走原有执行流程。

基线按运行组分文件。新基线记录模型、系统提示词、题集内容指纹、思考档和路由模式。比较前会检查这些条件是否一致。旧基线仍可读取，比较时按已有字段检查。

确定性收尾实验默认关闭，可用 `MOCODE_SHORT_PATH_COMPLETION=true` 启用。比如提交“将 `config.js` 中的 `MAX_RETRIES = 2` 替换为 `MAX_RETRIES = 3`。然后运行 `node verify.mjs`。”，正常开场、改动和检查均有证据时，runtime 直接给出结果。明确写“无需运行检查。”也可以使用此路径。验证要求未明确时，继续由模型决定如何验证与收尾。报告会记录开关、自动收尾次数和回退原因。

门禁语义（`--group` 完整场景组运行时与对应的 `baseline-<scenario>.json` 比较）：

- **质量是硬门禁**：通过数回落即失败（与 coding baseline 同语义，任务集/模型/提示词漂移直接拒绝比较）。
- **效率默认只告警**：均值劣化超过基线 +20% 打 `[warn]`；这是刻意设计——先观察分布再收紧，等效率基线稳定后用 `--efficiency-gate` 升级为阻断。

结构自检（零模型调用）：`evals/short-path/smoke.ts` 已并入 `npm run eval:smoke`，校验 fixture 不变量与「初始状态 verifier 必须失败」铁律；repo 层的执行检查需要解包真实快照，用 `tsx evals/short-path/smoke.ts --with-repo` 单独跑。

repo 题目失效时的校准流程：仓库演进让「新增导出函数」类任务失去前提时，对应 verifier 会持续失败——修改题目或目标模块，然后 `--group repo --update-baseline` 重录。
