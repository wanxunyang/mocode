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
];

/** 内置 skill 名字集,供 discoverSkills 跳过/覆盖时使用。 */
export const builtinSkillNames: Set<string> = new Set(builtinSkills.map((s) => s.name));
