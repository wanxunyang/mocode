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

开工前的需求澄清流程:当需求可能被理解错、或信息不足以决定交付物时,先用对话把需求问清楚,再动手。

## 何时进入

- 用户的需求存在两种以上实质不同的理解,会导致不同交付物;
- 缺少关键信息(目标、范围、约束、输入输出、验收标准),且靠仓库证据无法补全;
- 改动涉及不可逆操作 / 公共 API / 多个会实质改变产品行为的方案;
- 用户只给了粗略想法(如「帮我做个 X」),期望先讨论。

## 何时不要进入

- 任务清晰且存在合理默认做法 → 直接干,在最终回复中披露假设;
- 只是命名或实现细节 → 遵循仓库惯例自主决定;
- 用户已明确表示「直接做 / 别问我」。

## 流程

1. **最小探查**:只读取提出好问题所必需的代码和上下文(有 .codegraph/ 时优先 codegraph skill),不要在澄清阶段做大范围调研。
2. **复述理解**:用一两句向用户复述你对需求的理解,并点出关键分歧或未知点。
3. **一次只问一个问题**:每轮 \`ask_human\` 只问当前最关键的一个问题,自由文本优先(\`options: []\`);仅当答案能收敛为少量明确选项时才给 2-4 个选项。不要一次甩多个问题。
4. **据回答继续**:必要时追问下一个最关键的问题;回答引出新歧义时先澄清新歧义。不要重复问已回答的内容。
5. **收敛确认**:需求清晰后,用一次 \`ask_human\` 分节呈现方案——目标 / 范围 / 做法与受影响文件 / 不做什么 / 验证方式,选项固定为「确认,开始做」「再调整」「取消」。
6. **转入执行**:用户确认后再开始改动。

## 边界

- 澄清阶段的 \`ask_human\` 不计入「执行阶段每轮最多 2 次」的预算,但仍要克制:每个问题都必须实质推进理解。用户表现出不耐烦或说「你决定」时,采用最安全的可逆默认做法并说明。
- 用户取消:停止,不要按自己的猜测继续。
- 问题与方案用用户的语言表述。
- 澄清期间保持只读:不改文件、不跑有副作用的命令。
`;

const DEBUGGING_BODY = `# Systematic Debugging(系统化调试)

遇到 bug、测试失败或报错时,用「先理解再修」的流程,禁止靠猜测随机改动。

## 核心原则

- 没有找到根因之前,不要改代码。症状不是原因。
- 一次只改一处;改完无法解释为什么有效,就不算修好。
- 不要用「删掉重试 / 换个写法试试 / 加个 await 碰碰运气」这类无假设的尝试。

## 流程

1. **复现**:先稳定复现问题。复现不了,先弄清楚触发条件(输入、环境、顺序),必要时向用户索取复现步骤或报错全文。
2. **收集证据**:读完整报错和堆栈,定位到具体文件/行;用日志或最小用例确认数据在**哪一步**开始出错。有 .codegraph/ 时用它追调用链。
3. **形成根因假设**:用一句话说明「为什么当前行为会必然产生这个症状」,并指出能证伪它的检查点。
4. **验证假设**:先做最小检查确认假设成立,再动手。如果证据与假设矛盾,回到第 2 步,不要硬修。
5. **最小修复**:只改根因,不动无关代码;避免为绕过症状而加补丁、吞异常、放宽校验。
6. **验证修复**:复现用例通过;补一个能覆盖该 bug 的回归测试(成本合理时);检查同类路径是否也受影响。
7. **复盘**:说明根因、改动、验证方式;仍有不确定就如实说。

## 反模式

- 报错还没看完就开始改;
- 同一处反复改了 3 次仍失败却不换思路;
- 修复让错误「消失」但说不清机制(往往只是被掩盖);
- 顺手重构与 bug 无关的代码。
`;

const CODE_REVIEW_BODY = `# Code Review(自审 diff)

提交/收尾前,对**自己本次的改动**做一遍审查。改动越多越要做;几行的机械改动可快速过。

## 流程

1. **拿到完整 diff**:只审本次相关改动(\`git diff\` / 未提交改动),不要凭记忆。
2. **意图对齐**:每处改动是否都服务于任务?有没有夹带无关重构、调试残留(console.log、注释掉的代码、临时文件)?
3. **正确性**:逻辑分支是否完整;边界(空值、空数组、并发/重复调用、错误路径);条件取反、off-by-one;异步是否有未 await 或未处理的 rejection。
4. **错误处理**:失败时是否给出有用信息而非静默吞掉;资源(文件句柄、锁、子进程)是否正确释放。
5. **兼容与契约**:公共 API、类型、配置键、默认值是否保持兼容;是否违背仓库既有约定(如纯 ESM 的 .js 扩展名、工具契约)。
6. **安全与副作用**:是否引入不可逆操作、权限绕过、注入面;写入/执行是否走了既有护栏。
7. **完整性**:文档、调用方、测试是否需要同步;用户要求的场景是否都覆盖。
8. **修复后复审**:发现问题就改,改完重新看那部分 diff,确认没有引入新问题。

## 输出

如实质问题:直接修复,最终回复中列出发现并修复了什么。
如无问题:简要说明审过哪些点。不要为了凑数报无关紧要的风格问题——格式交给 Prettier。
`;

const VERIFICATION_BODY = `# Verification Before Completion(完成前证据验证)

宣布任务「完成」之前,必须用实际运行的证据确认改动真的生效。禁止把「代码看起来对 / 应该能跑」当作完成。

## 硬性规则

1. **先验证,再宣称完成**:任何「已修复 / 已完成 / 能用了」的结论,前面必须有一次实际执行及其真实输出。
2. **验证必须对得上声称**:改了行为就跑能体现该行为的场景;修了 bug 就用能复现该 bug 的输入确认;不能用「编译通过」代替「功能正确」。
3. **看完整结果**:确认退出码、断言/测试通过数、关键输出行;有 warning 或失败项要逐条判断,不能只看最后一行没报错。
4. **验证不了就如实说**:环境缺失、需要用户凭据/设备、或验证成本明显不合理时,说明已验证到哪一步、什么没验证、用户可以怎么验证。不要假称已验证。

## 怎么选验证(按成本,够小即可)

- 优先最小相关检查:拥有该改动的包的 typecheck / 一个针对性测试 / 直接运行受影响入口;
- 不要为了「保险」默认跑全量 test/build;
- UI/交互类改动:能自动化就自动化(浏览器工具/webapp 测试),否则明确告知未做可视化验证;
- 纯文档、注释等零行为改动:可不跑验证。

## 反模式

- 「理论上没问题」「逻辑上应该可以」——没有运行证据就不算完成;
- 测试其实失败/被跳过,却报告成功;
- 跑了一个与改动无关的检查,用它冒充验证;
- 改完代码不重新运行,沿用改动前的旧结果。
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
      '系统化调试:遇到 bug、测试失败或报错时,先稳定复现并定位根因(读完堆栈、用证据验证假设),再做最小修复并回归验证。' +
      '禁止没找到根因就靠猜测反复改代码。',
    body: DEBUGGING_BODY,
    dir: 'builtin',
    skillMdPath: 'builtin',
    context: 'inline',
    modelInvocable: true,
    origin: 'builtin',
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
