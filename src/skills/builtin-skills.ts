// 内置 Skill:随 mocode 一起发布的 skill,不依赖用户目录,作为最低优先级兜底。
// 用户在 ~/.mocode/skills/<name>/SKILL.md 放置同名 skill 时覆盖内置版（更具体的优先）。
//
// 设计动机:把 "可被 use_skill 加载、按需激活" 的领域知识从「核心工具」剥离出来。
// 典型用例:codegraph 工具原本是薄壳 CLI 包装,现改成 skill,模型按需加载说明后
// 用 run_command 调用 codegraph CLI,核心工具集更瘦,无 codegraph 索引的项目零负担。

import type { Skill } from './discover.js';

/**
 * 内置 skill 注册表（仅元数据,正文 body 嵌入此处避免 tsconfig rootDir 外置资源文件
 * 带来构建/打包负担）。新增内置 skill:在本数组加一条,builder 注入到 listSkills。
 */
export interface BuiltinSkill extends Skill {
  /** 内置 skill 的正文(纯函数:运行时直接读,无文件系统依赖)。 */
  body: string;
  /** 内置 skill 路径标记(目录与 file 路径均设为 'builtin',仅占位、不会被读)。 */
  dir: 'builtin';
  skillMdPath: 'builtin';
}

const CODEGRAPH_BODY = `# Code Graph Query

Pre-built \`.codegraph/\` 索引查询技能。**当 \`.codegraph/\` 存在时**,用它代替逐文件 grep+read,
能一次拿到相关源码 + 调用链 + 影响面;不存在时**不要**使用本 skill（用 read_file / glob / grep）。

## 调用方式（用 run_command 工具）

codegraph 不再是核心工具,而是 skill 化后的 CLI 调用。模型在 REPL 中这样调:

\`\`\`
run_command({ command: "codegraph explore <query...>" })
run_command({ command: "codegraph node <symbol-or-path>" })
\`\`\`

注意:

- Windows 上 \`codegraph\` 是 .cmd:cmd 默认下直接传 \`codegraph ...\` 即可;若默认 shell 是 bash(MOCODE_SHELL=bash),Git Bash 同样能按裸名解析 .cmd(\`bash -c "codegraph --version"\` 实测可用),解析不到就显式 \`shell: "cmd"\`。
- 单次查询 ≤ 60s 超时,模型按需重试/换 query。

## 何时用

- **理解架构/入口模块** → \`codegraph explore "<模块名或入口符号>"\`,一次拿相关源码 + 调用路径,别再逐文件读。
- **定位单个符号** → \`codegraph node <symbol>\`(返回该符号源码 + callers + callees)。
- **读一个文件 + 依赖** → \`codegraph node <file-path> --file <file>\`(file 模式)。
- **评估改动影响面** → 先 \`explore\` 看 callers,再 \`node\` 单点深挖。

## 何时不用

- 没建过 \`.codegraph/\` 索引(运行 \`codegraph init\` 即可,需先 \`npm i -g @colbymchenry/codegraph\`)→ 用 read_file / glob / grep。
- 单个已知小文件/刚编辑过的文件 → 直接 read_file / edit_file。
- 同一会话内已经查过同一区域 → 复用历史结果,不要重复调。

## 输出格式

CLI dump 一般是 \`path/to/file.ts:line:col  symbol\` 形式,与 grep 一样可被 read_file 消费。
`;

const BRAINSTORM_BODY = `# Brainstorming(需求澄清)

开工前的需求澄清:当需求可能被理解错、信息不足或只给了粗略想法时,先用对话把需求收敛成用户认可的设计,再动手。

## 铁律

开始写产品代码之前,必须完成所选路径对应的确认门。**批准是分阶段的**:用户认可想法 ≠ 批准写代码;对方案的口头认可只推进到下一步,不越级。

## 第一步:分级(说出来,让用户可纠正)

对需求先分类并明说——「这个需求看起来是有界改动,我会先在聊天里给短设计」:

- **探针(Spike)**:可行性问题(「能不能…」「先快速试试」),产出是结论不是保留的代码。2-3 句说清要验证什么,口头确认即可动手;产出物明确标注一次性。
- **有界(Bounded)**:改动仓库里**已存在**的流程(新 flag、小端点、单文件修复)。问关键问题后,在聊天里给出几段短设计,停下等确认;不写 spec 文件。
- **架构级(Architectural)**:新项目、新子系统、改变组件间接口。走完整流程:澄清问题 → 分节设计 → 落盘 spec 文档 → 用户审阅 spec → 再谈实施计划。

判断不了时取更重的级别。**棘轮单向**:任务中途发现隐藏复杂度 → 停下明说,升级路径;永不中途降级。

## 澄清阶段怎么问

1. **最小探查**:只读提出好问题所必需的代码(有 .codegraph/ 时优先 codegraph skill),不做大范围调研。
2. **复述理解**:一两句复述你对需求的理解,区分「用户说的」和「我假设的」,邀请纠正。
3. **一次一个问题**:每轮 ask_human 只问当前最关键的一个,自由文本优先(options: []);仅当答案能收敛为少量明确选项时才给 2-4 项。回答引出新歧义时先澄清新歧义,不重复问已回答的。

## 收敛确认

需求清晰后,用一次 ask_human 分节呈现方案——目标 / 范围 / 做法与受影响文件 / 不做什么 / 验证方式,选项固定为「确认,开始做」「再调整」「取消」。

**呈现前自查一遍(静默)**:有没有 TBD 或模糊措辞?各节是否互相矛盾?有没有可双解的需求点(有则当场选定并写明)?修完再呈现,自查过程不必展示。

## 边界

- 澄清期 ask_human 不计入「执行阶段每轮最多 2 次」的预算,但每个问题必须实质推进理解;用户不耐烦或说「你决定」时,取最安全的可逆默认并说明。
- 用户取消:停止,不要按自己的猜测继续。
- 问题与方案用用户的语言。
- 澄清期间保持只读:不改文件、不跑有副作用的命令。
`;

const DEBUGGING_BODY = `# Systematic Debugging(系统化调试)

遇到 bug、测试失败或报错时,用「先理解再修」的流程。**违反本流程的字面,就是违反调试的精神。**

## 铁律

> 未定位根因,不得提出修复。

症状不是原因。「让报错消失」和「修好」是两回事——说不清为什么有效,就只是掩盖。

## 最容易跳过的时刻(恰恰必须用本流程)

- 时间紧、线上着急、「就改一行」;
- 已经连试 2 次以上修复仍失败——这不是「再试一次」的信号,是前提或架构有问题的信号,回到第 1 步质疑假设;
- 感觉「我大概知道问题在哪」;
- 报错看起来很简单——简单 bug 也有根因。

## 流程

1. **复现**:先稳定复现。复现不了就先弄清触发条件(输入、环境、顺序),必要时向用户索取复现步骤或报错全文。
2. **收集证据**:读完整报错和堆栈,定位到具体文件/行;用日志或最小用例确认数据在**哪一步**开始出错。多组件系统(如 CI→构建→签名、API→DB)先在组件边界加诊断输出,跑一次看断在哪一层,再深入该层。有 .codegraph/ 时用它追调用链。
3. **形成单一假设**:一句话说清「X 是根因,因为 Y」,并指出能证伪它的检查点。同时只验证这一个假设,不许一次改多处。
4. **最小验证**:先做最小检查确认假设成立;证据与假设矛盾 → 回到第 2 步,不要硬修。承认「我没看懂这段」比假装看懂更好。
5. **最小修复**:只改根因,不动无关代码;不加吞异常、放宽校验这类绕症状的补丁。
6. **回归验证**:复现用例通过;按红绿法补回归测试(见 verification-before-completion skill);检查同类路径是否同样受影响。
7. **复盘**:说明根因、改动、验证方式;仍有不确定就如实说。

## 合理化借口对照

| 借口 | 现实 |
|------|------|
| 「问题很简单,不用走流程」 | 简单问题也有根因;流程对简单问题很快 |
| 「紧急,没时间走流程」 | 系统化比反复乱改快 |
| 「先随手修一下再查原因」 | 第一次随手修会定下错误方向 |
| 「多改几处一起试,省时间」 | 无法隔离哪个改动起效,还引入新变量 |
| 「我知道问题在哪,直接修」 | 看到症状 ≠ 理解根因 |
| 「再试一次就好了」 | 3+ 次失败说明该质疑前提,不是再试 |

如果系统化调查后确认问题确实源于环境/时序/外部依赖、没有代码层根因:记录调查过程,实现恰当处理(重试、超时、报错信息)——这本身是完成流程,不是失败。
`;

const CODE_REVIEW_BODY = `# Code Review(自审 diff)

提交/收尾前,对**自己本次的改动**做一遍审查。改动越多越要做;几行的机械改动可快速过。

## 独立视角优先

自审最大的敌人是实现思维惯性——评估和实现在同一个上下文里互相污染。**若工具面可用 sub-agent,优先派子代理审查**:给它精心构造的上下文(任务目标、验收要求、diff 范围),不要给它你的会话历史;只收回结论。sub-agent 不可用或改动很小时自查,按清单逐项过,不要凭整体印象。

## 清单

1. **意图对齐**:每处改动是否都服务于任务?有没有夹带无关重构、调试残留(console.log、注释掉的代码、临时文件)?
2. **正确性**:逻辑分支是否完整;边界(空值、空数组、并发/重复调用、错误路径);条件取反、off-by-one;异步是否有未 await 或未处理的 rejection。
3. **错误处理**:失败时是否给出有用信息而非静默吞掉;资源(文件句柄、锁、子进程)是否正确释放。
4. **兼容与契约**:公共 API、类型、配置键、默认值是否保持兼容;是否违背仓库既有约定(如纯 ESM 的 .js 扩展名、工具契约)。
5. **安全与副作用**:是否引入不可逆操作、权限绕过、注入面;写入/执行是否走了既有护栏。
6. **完整性**:文档、调用方、测试是否需要同步;用户要求的场景是否都覆盖。

## 处理与输出

- 重要问题:立即修复,修完重看那部分 diff,确认没有引入新问题;
- 次要问题:记录,不阻塞收尾;
- 无实质问题:简要说明审过哪些点。
- 不要为了凑数报风格问题——格式交给 Prettier。
`;

const VERIFICATION_BODY = `# Verification Before Completion(完成前证据验证)

宣布任务「完成」之前,必须用实际运行的证据确认改动真的生效。禁止把「代码看起来对 / 应该能跑」当作完成。

## 铁律

**没有本次修改之后产生的运行证据,不得做任何完成/成功/通过类声称。**上一次运行的旧结果、部分检查、别的检查碰巧通过,都不算证据。

## 声称 → 必须的证据 → 不算数

| 声称 | 必须有 | 不算数 |
|------|--------|--------|
| 测试通过 | 测试命令输出 0 failures | 上次运行、「应该通过」 |
| 构建成功 | build 命令 exit 0 | lint 通过、日志看着没报错 |
| bug 已修 | 用能复现该 bug 的输入跑过且通过 | 改完代码就当修好 |
| 回归测试有效 | 红绿循环验证过(见下) | 测试只绿过一次 |
| 子 agent 完成 | 核查其落盘的改动 | 子 agent 自报 success |
| 需求全部满足 | 逐条对照用户的验收要求 | 相关测试都绿 |

## 红绿回归验证

补回归测试时,只绿过一次不算数:写测试 → 确认它在修复前的代码上会红(临时回滚修复,或注入原触发输入) → 恢复修复 → 确认转绿。这样才能证明测试测的就是这个 bug,而不是碰巧通过。

## 红旗(出现即停)

- 「应该没问题」「大概可以」「看起来对」;
- 还没跑验证就表达满意(「搞定」「完美」);
- 引用改动前的旧运行结果;
- 拿与改动无关的检查冒充验证;
- 测试失败或被跳过,却报告成功。

## 怎么选验证(按成本,够小即可)

- 优先最小相关检查:拥有该改动的包的 typecheck / 一个针对性测试 / 直接运行受影响入口;
- 不要为了「保险」默认跑全量 test/build;
- UI/交互类改动:能自动化就自动化(浏览器工具/webapp 测试),否则明确告知未做可视化验证;
- 纯文档、注释等零行为改动:可不跑验证。

## 验证不了就如实说

环境缺失、需要用户凭据/设备、或验证成本明显不合理时:说明已验证到哪一步、什么没验证、用户可以怎么验证。如实报告未验证项不是失败;假称验证才是。
`;

/** 单一事实源:加新内置 skill 在此数组加一条。 */
export const builtinSkills: BuiltinSkill[] = [
  {
    name: 'codegraph',
    description:
      'Query a pre-built .codegraph/ index for symbol lookup, call chains, and impact analysis. ' +
      'First choice over read_file/grep when the .codegraph/ index exists. ' +
      'Invoke via run_command("codegraph explore …" | "codegraph node …").',
    body: CODEGRAPH_BODY,
    dir: 'builtin',
    skillMdPath: 'builtin',
    // 内置 skill:恒信任、内联、模型可自动触发。
    context: 'inline',
    modelInvocable: true,
    origin: 'builtin',
    warnings: [],
  },
  {
    name: 'brainstorming',
    description:
      '需求澄清(开工前对话):当用户需求可能被误解、信息不足、存在多种实质不同方案,或只给了粗略想法时,' +
      '先用「一次一个问题」的对话澄清需求,分节呈现方案并获得确认,再开始写代码。任务清晰时不要使用。',
    body: BRAINSTORM_BODY,
    dir: 'builtin',
    skillMdPath: 'builtin',
    context: 'inline',
    modelInvocable: true,
    origin: 'builtin',
    warnings: [],
  },
  {
    name: 'systematic-debugging',
    description:
      '系统化调试:遇到 bug、测试失败或报错时,在提出任何修复之前先稳定复现并定位根因(读完堆栈、用证据验证假设),' +
      '再做最小修复并回归验证。禁止没找到根因就靠猜测反复改代码。',
    body: DEBUGGING_BODY,
    dir: 'builtin',
    skillMdPath: 'builtin',
    context: 'inline',
    modelInvocable: true,
    origin: 'builtin',
    // debug 需要深度推理:激活期把 effort 提到 high(仅未显式设置时生效)。
    effort: 'high',
    warnings: [],
  },
  {
    name: 'code-review',
    description:
      '收尾前自审本次 diff:意图对齐、正确性与边界、错误处理、API/约定兼容性、安全副作用、文档与测试完整性,' +
      '发现问题直接修复后复审。改动较多或涉及核心逻辑时使用;纯机械小改可快速过。',
    body: CODE_REVIEW_BODY,
    dir: 'builtin',
    skillMdPath: 'builtin',
    context: 'inline',
    modelInvocable: true,
    origin: 'builtin',
    warnings: [],
  },
  {
    name: 'verification-before-completion',
    description:
      '完成前证据验证:宣布「已修复/已完成」前必须实际运行过相关检查并看到真实输出(退出码、测试通过数、关键输出),' +
      '验证内容要对得上声称;无法验证时如实说明。适用于一切有行为改动的收尾,纯文档改动除外。',
    body: VERIFICATION_BODY,
    dir: 'builtin',
    skillMdPath: 'builtin',
    context: 'inline',
    modelInvocable: true,
    origin: 'builtin',
    warnings: [],
  },
];

/** 内置 skill 名字集,供 discoverSkills 跳过/覆盖时使用。 */
export const builtinSkillNames: Set<string> = new Set(builtinSkills.map((s) => s.name));
