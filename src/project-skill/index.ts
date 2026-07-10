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
import type { ChatMessage } from '../llm/index.js';

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

/** 内容硬上限(字符数)。超限拒绝写入，防止系统提示词膨胀。从 6000 降至 4000，与快照互补后内容更精简。 */
const MAX_SKILL_CHARS = 4000;

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
 * 调用 LLM 压缩内容。超限时自动精简，保留关键信息。
 * 返回压缩后的内容，失败返回 null。
 */
export async function compressContent(
  content: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    // 动态导入避免循环依赖
    const { chat } = await import('../llm/index.js');
    
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a technical writer. Compress the following project skill content to fit within ' +
          `${MAX_SKILL_CHARS} characters while preserving the most important information. ` +
          'Keep concrete examples, paths, and actionable insights. Remove redundancy and verbose explanations. ' +
          'Output ONLY the compressed content, no explanations.',
      },
      { role: 'user', content },
    ];

    const result = await chat(messages, {}, signal);
    const compressed = result.content?.trim();
    if (!compressed) return null;
    return compressed;
  } catch {
    return null;
  }
}

/**
 * 写入时自动压缩：超限则调用 LLM 压缩，最多尝试 maxAttempts 次。
 * 返回 { ok, error?, compressed? }，compressed 标记是否经过压缩。
 */
export async function writeProjectSkillWithCompression(
  content: string,
  maxAttempts = 3,
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string; compressed?: boolean }> {
  let current = content;
  let compressed = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = writeProjectSkill(current);
    if (result.ok) {
      return { ok: true, compressed };
    }

    // 非超限错误直接返回
    if (!result.error?.includes('内容超过上限')) {
      return result;
    }

    // 超限时调用 LLM 压缩
    const compressedContent = await compressContent(current, signal);
    if (!compressedContent) {
      return {
        ok: false,
        error: `压缩失败: ${result.error}`,
      };
    }

    current = compressedContent;
    compressed = true;
  }

  // 多次压缩后仍超限
  const finalCheck = writeProjectSkill(current);
  if (finalCheck.ok) {
    return { ok: true, compressed: true };
  }

  return {
    ok: false,
    error: `经过 ${maxAttempts} 次压缩仍超限: ${finalCheck.error}`,
  };
}

/**
 * 追加时自动压缩：合并后超限则调用 LLM 压缩，最多尝试 maxAttempts 次。
 */
export async function appendProjectSkillWithCompression(
  addition: string,
  maxAttempts = 3,
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string; compressed?: boolean }> {
  const existing = readProjectSkill() ?? '';
  const trimmed = addition.trim();
  if (!trimmed) return { ok: false, error: '追加内容为空' };

  const separator = existing ? '\n\n' : '';
  const merged = existing + separator + trimmed;
  return writeProjectSkillWithCompression(merged, maxAttempts, signal);
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
