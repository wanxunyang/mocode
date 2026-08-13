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

- Windows 上 \`codegraph\` 是 .cmd,必须走 cmd.exe /c 包装(run_command 内部已处理,直接传 \`codegraph ...\` 即可)。
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
];

/** 内置 skill 名字集,供 discoverSkills 跳过/覆盖时使用。 */
export const builtinSkillNames: Set<string> = new Set(builtinSkills.map((s) => s.name));
