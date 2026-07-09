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
const SKILL_INIT_SUFFIX = `You are a project exploration agent. Your task is to deeply understand this project and generate a concise, actionable "Project Skill" document.

## Your Mission
Explore the project thoroughly using available tools, then produce a structured skill document that will help future AI agents work efficiently on this project.

## Exploration Strategy
1. **Start broad**: Use \`glob\` to understand the project structure
2. **Read key files**: package.json, README.md, tsconfig.json, any config files
3. **Understand architecture**: Use \`codegraph\` or \`grep\` to find main entry points, core modules, key interfaces
4. **Identify patterns**: Look for naming conventions, directory structure patterns, common abstractions
5. **Find pitfalls**: Check for complex configs, unusual dependencies, build quirks

## Output Format
When you're done exploring, output the skill document between these exact delimiters:

\`\`\`skill-start
(your skill content here)
\`\`\`skill-end

The skill content should follow this structure (use Chinese for headings, adapt sections based on what you find):

## 项目概述
- 一句话描述项目是什么、做什么
- 核心目标用户/场景

## 技术栈
- 主要语言、框架、工具（附版本号）
- 关键技术选型理由（如果能从文档/代码推断）

## 架构要点
- 核心模块及其职责（用 path/to/module 格式）
- 数据流向或调用链（如果有明显模式）
- 设计模式或架构模式（如果有）

## 项目结构
- 关键目录及其用途
- 重要文件的位置

## 开发流程
- 构建、测试、lint、部署命令
- 开发环境配置要点

## 项目约定
- 命名规范（如果有明显模式）
- 代码风格（如果有 .eslintrc, .prettierrc 等）
- 测试策略（如果有测试）

## 常见坑点
- 复杂的配置或构建步骤
- 容易踩坑的 API 或行为
- 需要特别注意的依赖版本问题

## Guidelines
- 保持精简，总长度控制在 4000-5000 字符（硬上限 6000）
- 写可操作的内容，避免空泛描述（不要写"代码质量高"这种废话）
- 用具体路径和例子（不要写"有多个模块"，要写"src/agent 负责 agent 循环"）
- 如果某个 section 没有明显内容，可以省略或写"待补充"
- 重点是：让未来的 agent 能立即理解项目并开始有效工作
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
