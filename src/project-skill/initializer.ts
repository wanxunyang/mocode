/**
 * 项目 Skill 初始化器 - 派生子 agent 带工具深度探索项目，生成高质量的初始 skill
 */

import { spawnAgent } from '../agent/spawn.js';

export interface InitResult {
  ok: boolean;
  content?: string;
  error?: string;
  /** 子 agent 的探索日志（用于展示进度） */
  transcript?: string;
}

/**
 * 子 agent 的系统提示后缀：角色与输出格式约束
 */
const SKILL_INIT_SUFFIX = `You are a project exploration agent. Your task is to deeply understand this project and generate a concise "Project Skill" document.

## ⚠️ Complementary to Snapshot — CRITICAL
The following information is ALREADY provided by Project Snapshot — **do NOT repeat**:
- ✗ Project one-liner description (快照已有)
- ✗ Module names and file locations (快照 srcTree 已有)
- ✗ Tech stack names and versions (快照 techStack 已有)
- ✗ Build/test commands (快照 keyCommands 已有)
- ✗ File lists and directory structure (快照 srcTree 已有)

**Your job is to capture INSIGHTS only:**
- **WHY** — design decisions, trade-offs, reasons for choosing X over Y
- **HOW** — module behaviors, data flows, call chains, non-obvious interactions
- **GOTCHAS** — pitfalls, edge cases, non-intuitive behaviors
- **CONVENTIONS** — naming patterns, code style, unwritten rules

## Exploration Strategy
1. Use \`codegraph\` to trace call chains and understand module interactions
2. Read core modules to understand **behaviors** (not just names)
3. Look for complex logic, error handling patterns, unusual configs
4. Identify naming conventions, common abstractions

## Output Format
Output the skill document between these exact delimiters:

\`\`\`skill-start
## 架构要点
### 核心模块及职责
- **\`path/to/module\`** — 行为描述（做什么 + 怎么做）
...

### 关键设计决策
- 决策：原因
...

## 项目约定
- 约定（具体的，有例子的）
...

## 开发流程
- 命令 + 注意事项/坑点（命令本身快照已有，这里只写注意什么）
...

## 常见坑点
- 坑：解法
...
\`\`\`skill-end

## Rules — MUST FOLLOW
1. 禁止列出文件名清单或目录结构
2. 禁止列出依赖名和版本
3. 禁止写项目概述/一句话描述
4. 禁止只写命令本身（快照已有），只写注意事项
5. 每个模块描述必须包含行为（做什么 + 怎么协作），不只是名称
6. **总长度目标 3000-4000 字符，硬上限 4000**
7. 写可操作的内容，用具体路径和例子
8. 如果某个 section 没有实质内容，省略它
`;

/**
 * 生成初始项目 Skill（使用子 agent 深度探索）
 * @param existingSkill 已有的 skill 内容（如果有，子 agent 会在其基础上优化）
 * @param signal AbortSignal
 */
export async function generateInitialSkill(existingSkill?: string, signal?: AbortSignal): Promise<InitResult> {
  const hasExisting = !!existingSkill;
  
  let prompt: string;
  if (hasExisting) {
    prompt = `以下是当前的项目 Skill 内容，请深度探索项目并优化/完善它：

\`\`\`markdown
${existingSkill}
\`\`\`

## 优化方向
1. 补充缺失的信息（架构要点、设计决策、调用链等）
2. 修正过时或不准确的内容
3. 让描述更具体（用实际路径和例子）
4. 删除冗余或空泛的描述
5. 如果发现新的坑点或约定，添加进去

记住：保持精简，总长度控制在 4000-5000 字符。输出完整的优化后版本。`;
  } else {
    prompt = `请深度探索当前项目，生成一份项目专属 Skill 文档。

## 探索步骤
1. 先用 glob 扫描项目结构（**/*.ts, **/*.json 等）
2. 读取 package.json、README.md、tsconfig.json 等关键文件
3. 用 codegraph 或 grep 找到主入口、核心模块、关键接口
4. 理解架构模式、数据流向、调用关系
5. 识别命名约定、代码风格、测试策略
6. 找出可能的坑点（复杂配置、特殊依赖、构建陷阱）

## 输出
探索完成后，将完整的 skill 文档输出在 \`\`\`skill-start 和 \`\`\`skill-end 之间。

记住：内容要精简、可操作、有具体路径和例子。总长度控制在 4000-5000 字符。`;
  }

  try {
    const result = await spawnAgent({
      prompt,
      systemPromptSuffix: SKILL_INIT_SUFFIX,
      tools: ['read_file', 'glob', 'grep', 'codegraph'],
      maxSteps: 30,
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

    // 从 summary 中提取 skill 内容
    const skillMatch = result.summary.match(/```skill-start\n([\s\S]*?)\n```skill-end/);
    if (!skillMatch || !skillMatch[1]) {
      // 如果没有找到 delimiters，尝试从最后一段 markdown 代码块提取
      const codeBlockMatch = result.summary.match(/```(?:markdown|md)?\n([\s\S]*?)\n```/);
      if (codeBlockMatch && codeBlockMatch[1]) {
        return {
          ok: true,
          content: codeBlockMatch[1].trim(),
          transcript: result.transcript,
        };
      }

      // 如果连代码块都没有，直接用 summary（但去掉开头的探索日志）
      const lines = result.summary.split('\n');
      const skillStartIdx = lines.findIndex((l) => l.startsWith('## '));
      if (skillStartIdx > 0) {
        return {
          ok: true,
          content: lines.slice(skillStartIdx).join('\n').trim(),
          transcript: result.transcript,
        };
      }

      return {
        ok: false,
        error: '无法从子 agent 输出中提取 skill 内容',
        transcript: result.transcript,
      };
    }

    const content = skillMatch[1].trim();

    // 检查长度
    if (content.length > 6000) {
      return {
        ok: false,
        error: `生成内容过长 (${content.length} 字符)，请手动精简后重试`,
        transcript: result.transcript,
      };
    }

    return {
      ok: true,
      content,
      transcript: result.transcript,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : '未知错误',
      transcript: '',
    };
  }
}
