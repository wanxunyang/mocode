// skills barrel:缓存已发现的 skill、按需读正文、拼系统提示段。
// 被 repl(注入 systemPrompt)与 tools/builtins/use-skill(加载正文)依赖;
// 自身仅依赖 discover.ts + node:fs,是叶子级业务模块。

import { existsSync, readFileSync } from 'node:fs';
import { discoverSkills, parseFrontmatter, type Skill } from './discover.js';

export type { Skill };

let cache: Skill[] | null = null;

/** 已发现的 skill 列表(懒加载,首次调用触发扫描;启动期 repl 调一次)。 */
export function listSkills(): Skill[] {
  if (cache === null) cache = discoverSkills();
  return cache;
}

/**
 * 读取某 skill 的 SKILL.md 正文(去掉 frontmatter)。
 * 纯函数:找不到 / 读失败返 null(错误字符串交给调用方工具层生成)。
 */
export function getSkillBody(name: string): string | null {
  const skill = listSkills().find((s) => s.name === name);
  if (!skill) return null;
  try {
    if (!existsSync(skill.skillMdPath)) return null;
    const content = readFileSync(skill.skillMdPath, 'utf8');
    const { body } = parseFrontmatter(content);
    const trimmed = body.trim();
    return trimmed || '(skill 正文为空)';
  } catch {
    return null;
  }
}

/** 拼进系统提示的 skill 段;无 skill 返空串(零行为变化)。 */
export function buildSkillsSection(): string {
  const skills = listSkills();
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    '',
    '',
    '## Skills(按需加载)',
    '以下 skill 可用。只在任务相关时调用 use_skill 工具(传 skill 的 name)加载其完整指令,据此行动;不要无脑批量加载。',
    ...lines,
  ].join('\n');
}

/** base 系统提示 + skill 段;无 skill 时 === base。 */
export function effectiveSystemPrompt(base: string): string {
  return base + buildSkillsSection();
}
