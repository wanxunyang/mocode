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

/** 写入/更新项目 skill。内容不设字符上限；写入前备份旧内容。 */
export function writeProjectSkill(content: string): { ok: boolean; error?: string } {
  const trimmed = content.trim();
  const p = skillPath();
  const dir = path.dirname(p);

  try {
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

/** 追加内容到项目 skill 末尾(以 \n\n 分隔)，内容不设字符上限。 */
export function appendProjectSkill(addition: string): { ok: boolean; error?: string } {
  const existing = readProjectSkill() ?? '';
  const trimmed = addition.trim();
  if (!trimmed) return { ok: false, error: '追加内容为空' };

  const separator = existing ? '\n\n' : '';
  return writeProjectSkill(existing + separator + trimmed);
}

/** 兼容旧调用名：字数限制取消后直接写入，不再调用 LLM 压缩。 */
export async function writeProjectSkillWithCompression(
  content: string,
  _maxAttempts = 3,
  _signal?: AbortSignal
): Promise<{ ok: boolean; error?: string; compressed?: boolean }> {
  return { ...writeProjectSkill(content), compressed: false };
}

/** 兼容旧调用名：字数限制取消后直接追加，不再调用 LLM 压缩。 */
export async function appendProjectSkillWithCompression(
  addition: string,
  _maxAttempts = 3,
  _signal?: AbortSignal
): Promise<{ ok: boolean; error?: string; compressed?: boolean }> {
  return { ...appendProjectSkill(addition), compressed: false };
}

/**
 * 生成系统提示词注入段。
 * 开关关闭或文件不存在 → 空串(零行为变化)。
 * 
 * 精简版：只注入 skill 内容本身，维护指南移到 project_skill_update 工具描述中。
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
  ].join('\n');
}
