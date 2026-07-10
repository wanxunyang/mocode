import { spawnAgent } from '../agent/spawn.js';

/**
 * 子 agent 系统提示：让 agent 自主探索项目并生成 markdown 快照
 */
const SNAPSHOT_LLM_SUFFIX = `You are a project analysis agent. Your task is to explore this project and generate a concise markdown snapshot for an AI coding assistant.

## Your Mission
Explore the project using available tools (read_file, glob, grep) and generate a structured markdown snapshot that captures:
- WHAT exists (project description, tech stack, commands, modules, directory structure)
- WHERE it is (paths, locations)

Do NOT explain WHY or HOW (that's Project Skill's job).

## Exploration Strategy
1. Read package.json, README.md, tsconfig.json (or equivalent for other languages)
2. List top-level directories to identify modules
3. Scan src/ directory structure (depth ≤3, directories only)
4. Extract key commands from package.json scripts
5. Identify tech stack from dependencies

## Output Format
Output a markdown document between these exact delimiters:

\`\`\`snapshot-md
# Project Snapshot

## Description
(一句话描述项目，≤80字，中文)

## Tech Stack
(关键技术栈，逗号分隔，含版本，≤15项)

## Commands
| Command | Description |
|---------|-------------|
| \`npm run build\` | 构建项目 |
| \`npm test\` | 运行测试 |
| ... | ... |

## Modules
- **module-name** — 一句话职责描述（≤20字）
- **module-name** — 一句话职责描述
- ...

## Source Tree
\`\`\`
src/
  agent/
  tools/
  ui/
\`\`\`
\`\`\`snapshot-md

## Rules
1. **Description**: ≤80字，中文，从 README 和 package.json description 提炼。不要"一个..."开头。
2. **Tech Stack**: ≤15项，逗号分隔，含版本。格式如 "TypeScript 5.x, Node.js ≥18, openai@^4"。
3. **Commands**: 5-8个最重要的命令，从 package.json scripts 提取。Description ≤15字。用表格格式。
4. **Modules**: 每个顶层模块目录一条。职责≤20字，只写 WHAT（做什么）。
5. **Source Tree**: 只列目录（不列文件），深度≤3，用缩进表示层级，放在代码块中。
6. 不要包含：设计决策、注意事项、坑点、约定 → 这些是 Skill 的职责。
7. 总 markdown ≤ 2500 字符。
8. 使用中文。
`;

export interface LLMGenerateResult {
  ok: boolean;
  content?: string;
  error?: string;
  transcript?: string;
}

/**
 * 生成 LLM 快照（markdown 格式）
 * @param root 项目根目录
 * @param signal AbortSignal
 */
export async function generateLLMSnapshot(
  root: string,
  signal?: AbortSignal,
): Promise<LLMGenerateResult> {
  const prompt = `请探索项目 ${root}，生成项目快照（markdown 格式）。

## 探索步骤
1. 读取 package.json（或等效配置文件）
2. 读取 README.md
3. 列出顶层目录，识别模块
4. 扫描 src/ 目录结构（深度≤3，只列目录）
5. 从 package.json scripts 提取关键命令
6. 从 dependencies 识别技术栈

## 输出
严格按照系统提示的 markdown 格式输出，不要添加额外解释。`;

  try {
    const result = await spawnAgent({
      prompt,
      systemPromptSuffix: SNAPSHOT_LLM_SUFFIX,
      tools: ['read_file', 'glob', 'grep'], // 允许探索工具
      maxSteps: 15, // 给足够的探索步数
      signal,
    });

    if (!result.completed) {
      return {
        ok: false,
        error: '子 agent 未完成（可能中断或超时）',
        transcript: result.transcript,
      };
    }

    if (!result.summary) {
      return {
        ok: false,
        error: '子 agent 未返回内容',
        transcript: result.transcript,
      };
    }

    // 从 summary 中提取 markdown
    const mdMatch = result.summary.match(/```snapshot-md\n([\s\S]*?)\n```snapshot-md/);
    if (!mdMatch || !mdMatch[1]) {
      // fallback: 尝试普通 markdown 代码块
      const fallbackMatch = result.summary.match(/```markdown\n([\s\S]*?)\n```/);
      if (!fallbackMatch || !fallbackMatch[1]) {
        return {
          ok: false,
          error: '无法从子 agent 输出中提取 markdown',
          transcript: result.transcript,
        };
      }
      return { ok: true, content: fallbackMatch[1].trim(), transcript: result.transcript };
    }

    return { ok: true, content: mdMatch[1].trim(), transcript: result.transcript };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : '未知错误',
      transcript: '',
    };
  }
}
