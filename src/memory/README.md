# memory/

记忆子系统的实现目录。**设计、决策、路线图只在 [`design-notes/memory/memory.md`](../../design-notes/memory/memory.md) 维护**(唯一事实源);本文件只做代码导航。

## 两条轨道

| 轨道 | 文件 | 职责 |
|---|---|---|
| 用户级(global,懂人) | `~/.mocode/memory.jsonl`、`~/.mocode/memory-graph.json` | `person-primary` 画像边 + `persona.ts` 的 `## About you` 常驻注入 |
| 代码级(project,懂仓库) | `<cwd>/.mocode/memory.jsonl`、`<cwd>/.mocode/memory-graph.json` | 条目库 + 图谱 + `recall.ts` 的图谱地图 |

## 模块

| 文件 | 职责 |
|---|---|
| `store.ts` | JSONL 条目库:CRUD、BM25 检索、衰减 GC、启动索引段;条目含 `trigger`/`action` 条件-动作字段(R1.5)、`derivedFrom` 派生来源(R14)与 `anchors` 代码锚点(R2);`stale`/`anchorStale` 都不落盘,分别由 `loadStalenessMap()`(按源条目当前状态)与 `loadAnchorStaleMap()`(读文件重算 hash)现算 |
| `anchor.ts` | 代码锚点通道(R2):`{path, symbol?, contentHash, normHash?}` 的构建与判定。写入时用 `changeset/hash.ts` 的 `contentHash` 现算(与 `read_file` 的 artifact hash 同口径);判定分 fresh/stale/missing/unknown,`normHash` 兜住「只改了缩进与注释」;`extractSymbolFragment` 用大括号配平 + 同缩进声明 + 分号截断圈出符号片段 |
| `graph.ts` | 时序属性图:实体/边、双时间轴失效、边级 `prov/confidence/evidence`、身份归一 |
| `persona.ts` | 全局画像:β 后验、L2 内化判定、`## About you` 渲染、启动归一 |
| `relation-vocab.ts` | 软关系词表(项目轨/画像轨)+ 画像单值关系约束 |
| `recall.ts` | 项目图谱常驻"地图"提示(pull 召回触发器) |
| `proactive.ts` | 前摄通道(push):按 `trigger` 建 token 倒排,在工具调用时匹配 `工具名+参数+当前轮文本`,命中则把 `when/do` 附到结果尾部;每轮 3 次、同条进程内只弹一次。R3.6 另建**锚点索引**(`anchors[].path → 条目`):路径相等匹配、不要求 trigger(锚定代码的多是 `reference` 型),`read_file` 不弹以避免与 R2.4 回注重复,stale 锚点带 `[STALE-CODE]`。R4.1 起同时累计 `ProactiveCounters`(可匹配调用/注入/trigger 命中/锚点命中/stale 命中),**只在内存累加**,`flushProactiveStats()` 在轮末与退出落 `.mocode/memory-proactive-stats.json` —— 每次工具调用都写盘会变成写放大热点 |
| `episodic.ts` | 情节记忆(R6):`buildEpisode`/`recordSessionEpisode`(确定性、零 LLM;幂等靠 `name = session <id>`)、`buildEpisodeSection`(启动注入最近 3 条,独立小节)。episode 走自己的 7 天衰减 / 30 天清除,且**不占** `MAX_ACTIVE` 封顶。会话结束的组装(`history` + `notes.md` → 输入)在 `repl/episode-finalize.ts`,避免 memory → session 成环。R11 巩固的**确定性那一半**也在这里:`episodeFactsOf`(从 body 反解文件与请求 bigram,不新增存储字段)、`findConsolidationGroups`(星形聚类、显著文件过滤、≥3 条且跨 ≥2 会话、≤8 成员)、`applyConsolidation`(先写语义条目再标成员,标记 `derivedInto`) |
| `pending.ts` | 压缩→记忆交接(R13):定义摘要器顺带产出的 `## Memory Candidates` 段协议(切段/容错解析)、落 `<cwd>/.mocode/memory-pending.jsonl` 的未裁决队列(去重/上限 40/只切已裁决部分),供 `reflect.ts` 按既有六桶规则裁决 |
| `recall-stats.ts` | 召回埋点(`memory_search` 次数与图谱命中率) |
| `write-gate.ts` | 写入总闸(R8.3/R8.5):`memoryWriteBlockReason()` 返回 `'paused' \| 'disabled' \| null`,`setMemoryWritesPaused()` 管进程内暂停。**抽成独立叶子是硬约束**——`store`/`graph`/`pending` 三处写出口共用同一份状态,而 `graph` 已 `import type` 自 `store`;`store.ts` 再 re-export 一份保调用方兼容 |
| `audit.ts` | 审计日志(R8):`.mocode/memory-audit.jsonl`,`{at, action, detail, ids?, scope?}`。**不记正文**;`appendAudit` 静默失败 |
| `portable.ts` | 记忆包(R8.1/R9.2):`buildPack`/`writePack`/`parsePack`/`applyPack`/`importPackFile`,`MEMORY_PACK_SCHEMA_VERSION`。单文件 JSON(不引压缩依赖、用户能直接看);版本高于当前支持时拒收,低于时放行(缺字段按既有惰性约定) |
| `tail.ts` | 会话内记忆尾注(R17):`captureMemoryBaseline()` 在**会话边界**(启动 GC 后、`/clear`、`/resume`)拍 `id → updatedAt` 快照;`buildMemoryTailSection(enabled)` 每用户轮现算差分,只带本会话内新增/更新的 active 条目(≤3 条、body 截 400 字、`episode` 不计入)。注入走 `agent/model-turn.ts` 的 ephemeral 尾部 system 段——**绝不重建 `history[0]`**,否则整段对话的 KV 前缀缓存每轮失效。基线是模块级会话状态,故需 `__resetMemoryBaselineForTests` |
| `health.ts` | R4.1 健康快照:纯读汇总七组数字(条目分型 / trigger 覆盖率 / 锚点 stale 率 / 派生 stale 率 / 情节巩固率 / 检索 / 前摄)+ `warnings`(把异常翻译成可执行动作)。`writeMemoryHealth()` 原子写 `<cwd>/.mocode/memory-health.json`,只在 `/memory health` 与退出时写(要读全库 + 两次 stat,不该每轮付);`enabled=false` 时一个文件都不建 |
| `reflect.ts` | 后台反思:六桶产出(saves/updates/forgets/triples/profile/corrections/evidence) |
| `index.ts` | barrel |

## 注入链

`repl/runtime.ts` 与 `headless.ts` 在拼装 system message 时依次拼接:

```
buildAboutYouSection()      → ## About you(global L2)
buildMemoryIndexSection()   → Memory Index(条目摘要,已排除 episode)
buildEpisodeSection()       → Recent sessions(最近 3 条情节,独立小节)
buildProjectGraphHint()     → Project knowledge graph(主题实体地图)
```

四者都受 `MEMORY_ENABLED` veto,会话启动拍快照以护 prompt cache。正文走按需 `memory_search` / `memory_graph`。

情节(R6)刻意独立成小节且不进 `About you`:后者是知识图谱内化的用户画像,情节是事件流,混进去会让「你是谁」被「你昨天改了 3 个文件」污染。它也不进 Memory Index——主索引是长期知识的稳定清单,而情节每天变、生命周期差一个数量级。

## 约定

- **叶子依赖**:`store.ts` / `recall.ts` 不反向依赖 `agent` / `llm` / `tools` / `config` / `ui`;需要调 LLM 的反思单独放 `reflect.ts`。
- **同步原子写**:整文件读改写 + tmp/rename;单进程单 tick 内无并发。
- **旧数据惰性迁移**:新增字段一律可选,读入缺省,首次写入时补算。
- **检索质量有基线,改动必须复跑**:`npm run eval:memory-retrieval`(冻结语料,秒级,零 LLM)与 `:live`(真实库漂移)。改 `text-search.ts` 的分词或 `store.ts` 的字段权重后,必须附前后对照数字——这是 R15 存在的唯一理由。评测脚本刻意不复用 `searchEntries()`(它会 bump `recallCount`),改在内存建索引;两边权重因此是重复的,漂移时数字会立刻变化。
- **检索有相关性下限,它不是分数阈值**(R15.5):`searchEntries` 传 `MEMORY_SEARCH_MIN_EVIDENCE=2`,要求命中至少 2 个"证据词元"(长度 ≥ 2 的 token,即 ASCII 词或 CJK bigram;单个汉字不算),否则该条不进结果。**别改成分数阈值**:BM25 分数随语料规模与 idf 漂移,同一份探针在 17 条语料的最优阈值是 31.94、31 条真实库是 40.60,写死哪个都会在另一套数据上失效。两个必须保留的边界:查询自身的证据词元不足 2 个时按实际数量降级(否则「pruner」「压」这类短查询全废),过滤发生在 `limit` 截断**之前**(否则被滤掉的条目会白占名额)。- **写入只有一个总闸,且它在独立叶子里**(R8.3/R8.5):所有写入出口(`store.ts` 的 6 个写函数、`graph.ts` 的 7 个变更函数 + `writeGraphForScope`、`pending.ts` 的 `appendPendingCandidates`)在入口就判 `memoryWriteBlockReason()`。两个判据:**暂停**(`/memory pause`,进程内变量,退出即失效)与**关闭**(`MEMORY_ENABLED=false`,配置)。闸门放在 `write-gate.ts` 而不是 `store.ts` 是硬约束——`graph.ts` 已 `import type` 自 `store.ts`,闸门留在 store 会让运行时成环;`store.ts` 再 re-export 一份以保调用方兼容。`/memory pause` 只停写,检索/注入/画像读取全部照常。`flushRecallStats` 被拦时**不落盘也不清脏集**(清掉就丢召回计数,而计数不是用户可见内容)。
- **写入被拦必须与"已存在/未找到"分开报**(R8.3):`SaveResult`/`UpdateResult`/`ForgetResult`/`PurgeResult` 都有 `{ok:false, blocked:'paused'|'disabled'}` 分支。别把它并进 `exists`——`memory_save` 会把"被拦"报成"已存在同名记忆",模型于是换个名字无限重试一条永远写不进去的路径。
- **审计只记 id,不记正文**(R8):`memory-audit.jsonl` 里存 `{at, action, detail, ids?, scope?}`,`detail` 也严禁复制记忆摘要或正文。审计文件同样在磁盘上,把刚删掉的隐私换个文件继续存等于没删(测试直接断言正文不出现在 audit 里)。`appendAudit` **静默失败**:观测是可观测性产物,不该因为磁盘满就变成"删不掉"。
- **批量删除的三条护栏**(R8.2):pinned 永不删(pinned 的语义就是"用户要长期留着");**无任何条件时返回空名单而不是清库**(要清就 `--all`);`--dry-run` 与真删走同一段筛选,且 dry-run **不受暂停闸限制**(被封口时更需要先看看会删什么)。审计行写在落盘**之后**——先记后删会让日志撒谎。
- **导入按"更近的事实胜",不是"最后写入者胜"**(R8.1/R9.2):同 id 比 `updatedAt`,新的胜出;相等时保留本地。图谱侧刻意**按 id 直接跳过**:边的 `validAt/invalidAt` 本身承载时间语义,覆盖会抹掉 `invalidAt` 等于把一段历史"复活",因此重复导入两次是幂等的。
- **记忆状态文件不接受写文件工具的直接修改**(R16.5):`sandbox/policy.ts` 的 `MEMORY_STATE_FILES` 拦 `memory.jsonl`/`memory-graph.json`/`memory-pending.jsonl`/`memory-audit.jsonl`/`memory-health.json`/`memory-recall-stats.json`(含 `.tmp`),校验在 `jailResolve` **之后**按**路径分量**判(否则 `./.mocode/../.mocode/memory.jsonl` 可绕过)。`read_file` **明确放行**:诊断、导出、自查都依赖它,而读不会污染状态。要改内容走 `memory_*` 工具或 `/memory` 命令。