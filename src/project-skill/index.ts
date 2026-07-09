/**
 * 项目专属 Skill — 跨 session 持久化的项目开发知识。
 *
 * 每个项目可维护一个专属 skill 文件(.mocode/project-skill.md)，
 * 记录开发约定、架构决策、常见坑点等。开关启用后:
 *   1. 每次启动时内容注入系统提示词(buildProjectSkillSection)
 *   2. Agent 可通过 project_skill_update 工具动态更新
 *   3. 随着项目开发，skill 越来越了解项目，开发效率越来越高
 *
 * 存储位置: <cwd>/.mocode/project-skill.md
 * 开关: MOCODE_PROJECT_SKILL 环境变量，默认 false(零侵入)
 *
 * 与现有功能的关系:
 *   - 通用 skill(SKILLS_DIRS): 按需加载(use_skill);项目 skill: 始终注入
 *   - memory: 碎片化 fact/decision; 项目 skill: 结构化知识总结
 *   - snapshot: 静态文件缓存(只读); 项目 skill: 动态知识(可写)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';

/** 项目 skill 文件路径 */
function skillPath(): string {
  return path.join(process.cwd(), '.mocode', 'project-skill.md');
}

/** 备份文件路径 */
function backupPath(): string {
  return path.join(process.cwd(), '.mocode', 'project-skill.md.bak');
}

/** 读取项目 skill 内容。不存在/读失败 → null */
export function readProjectSkill(): string | null {
  const p = skillPath();
  if (!existsSync(p)) return null;
  try {
    const content = readFileSync(p, 'utf8').trim();
    return content || null;
  } catch {
    return null;
  }
}

/** 内容硬上限(字符数)。超限拒绝写入，防止系统提示词膨胀 */
const MAX_SKILL_CHARS = 6000;

/**
 * 写入/更新项目 skill。先备份旧内容再写新内容。
 * 返回 { ok, error? }: ok=false 时 error 说明原因(超限/IO 失败)。
 */
export function writeProjectSkill(content: string): { ok: boolean; error?: string } {
  const trimmed = content.trim();
  if (trimmed.length > MAX_SKILL_CHARS) {
    return {
      ok: false,
      error: `内容超过上限(${trimmed.length}/${MAX_SKILL_CHARS} 字符)。请精简后重试。`,
    };
  }

  const p = skillPath();
  const dir = path.dirname(p);

  try {
    // 备份旧内容(如果有)
    if (existsSync(p)) {
      copyFileSync(p, backupPath());
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(p, trimmed + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `写入失败: ${(e as Error).message}` };
  }
}

/**
 * 追加内容到项目 skill 末尾(以 \n\n 分隔)。
 * 同样受 MAX_SKILL_CHARS 限制。
 */
export function appendProjectSkill(addition: string): { ok: boolean; error?: string } {
  const existing = readProjectSkill() ?? '';
  const trimmed = addition.trim();
  if (!trimmed) return { ok: false, error: '追加内容为空' };

  const separator = existing ? '\n\n' : '';
  const merged = existing + separator + trimmed;
  return writeProjectSkill(merged);
}

/**
 * 生成系统提示词注入段。
 * 开关关闭或文件不存在 → 空串(零行为变化)。
 */
export function buildProjectSkillSection(): string {
  const content = readProjectSkill();
  if (!content) return '';

  return [
    '',
    '',
    '## Project Skill (project-specific knowledge)',
    'The following is project-specific knowledge maintained across sessions. Use it as context for all tasks in this project.',
    '',
    '<project-skill>',
    content,
    '</project-skill>',
    '',
    '### Project Skill 维护指南',
    '你可以（也应该）在开发过程中持续更新这个 skill，让它越来越了解项目：',
    '',
    '**何时更新**：',
    '- 发现项目特有的架构模式、设计决策或数据流',
    '- 踩坑后总结出避坑指南（命名冲突、API 行为、构建陷阱等）',
    '- 学到新的命名约定、测试规范、代码风格',
    '- 完成重要重构或引入新模块后',
    '- 用户纠正了你对项目的错误理解',
    '',
    '**更新什么**：',
    '- 项目概述、技术栈、核心模块职责',
    '- 常见坑点和解决方案',
    '- 开发流程（构建、测试、部署命令）',
    '- 关键 API 的使用方式和限制',
    '- 设计决策的 why（不只是 what）',
    '',
    '**如何更新**：',
    '- `project_skill_update(action="read")` — 查看当前内容',
    '- `project_skill_update(action="update", content="...")` — 全量替换（适合大改）',
    '- `project_skill_update(action="append", content="...")` — 追加到末尾（适合加新发现）',
    '',
    '**注意事项**：',
    '- 保持精简，硬上限 6000 字符（约 1500 token）',
    '- 写可操作的内容，避免空泛描述',
    '- 定期整理，删除过时信息',
    '- 更新前建议先 `read` 看一下现有内容，避免重复',
  ].join('\n');
}
