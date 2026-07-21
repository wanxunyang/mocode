// skills barrel:缓存已发现的 skill、按需读正文、拼系统提示段。
// 被 repl(注入 systemPrompt)与 tools/builtins/use-skill(加载正文)依赖;
// 自身仅依赖 discover.ts + builtin-skills.ts + node:fs,是叶子级业务模块。
//
// 优先级:内置 skill < 用户/系统 skill < 项目级 skill(后注册覆盖先注册,
// 项目级最后扫描,自然在 Map 中胜出)。同名用户 skill 完全替换内置版。

import { existsSync, readFileSync } from 'node:fs';
import { discoverSkills, parseFrontmatter, type Skill } from './discover.js';
import { builtinSkills } from './builtin-skills.js';

export type { Skill };

let cache: Skill[] | null = null;

/** 已发现的 skill 列表(懒加载,首次调用触发扫描;启动期 repl 调一次)。
 * 合并策略:内置 skill 作兜底,discoverSkills 的输出(按目录优先级后写覆盖)优先生效。 */
export function listSkills(): Skill[] {
  if (cache !== null) return cache;
  const discovered = discoverSkills();
  const byName = new Map<string, Skill>();
  // 先放内置(最低优先级)
  for (const skill of builtinSkills) byName.set(skill.name, skill);
  // 后放用户/项目级(覆盖内置)
  for (const skill of discovered) byName.set(skill.name, skill);
  cache = Array.from(byName.values());
  return cache;
}

/**
 * 读取某 skill 的 SKILL.md 正文(去掉 frontmatter)。
 * 纯函数:找不到 / 读失败返 null(错误字符串交给调用方工具层生成)。
 * 内置 skill 直接返回 body 字段(无 fs 依赖)。
 */
export function getSkillBody(name: string): string | null {
  const skill = listSkills().find((s) => s.name === name);
  if (!skill) return null;
  if (skill.body) {
    const trimmed = skill.body.trim();
    return trimmed || '(skill 正文为空)';
  }
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
    '## Skills (load on demand)',
    'The following skills are available. Call the use_skill tool (passing the skill name) only when relevant to the current task, to load its full instructions and act on them; do not load them all blindly.',
    ...lines,
  ].join('\n');
}

/** base 系统提示 + skill 段;无 skill 时 === base。 */
export function effectiveSystemPrompt(base: string): string {
  return base + buildSkillsSection();
}
