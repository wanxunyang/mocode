// skills 发现子系统。
// 仅依赖 node 标准库,是叶子模块:不依赖 config/agent/llm/tools,避免环。
//
// 约定:每个 skill 是一个目录 <skill-name>/SKILL.md,顶部 YAML frontmatter
// (name / description 必需,version / license 可选)。元数据始终注入系统提示,
// 正文由 use_skill 工具按需加载(渐进式披露)。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinSkillNames } from './builtin-skills.js';

export interface Skill {
  name: string;
  description: string;
  version?: string;
  license?: string;
  dir: string;
  skillMdPath: string;
  /** 内置 skill 的正文内联在此(避免文件系统依赖);用户/项目 skill 留空,getSkillBody 走文件读取。 */
  body?: string;
}

/** 把开头的 ~/ 或 ~ 展开为 home 目录(Windows 与 POSIX 通用)。 */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~' + path.sep)) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * 解析 skill 目录列表。
 * env SKILLS_DIRS 设则覆盖默认(用 path.delimiter 切分,与 PATH 同语义:
 * win32 用 ';',POSIX 用 ':',规避盘符冒号问题);未设则默认三目录,
 * 按优先级升序(低→高):~/.claude/skills → ~/.mocode/skills → <cwd>/.mocode/skills。
 */
export function resolveSkillsDirs(): string[] {
  const env = process.env.SKILLS_DIRS;
  if (env && env.trim()) {
    return env
      .split(path.delimiter)
      .map((d) => d.trim())
      .filter((d) => d.length > 0)
      .map(expandHome);
  }
  const home = os.homedir();
  return [
    path.join(home, '.claude', 'skills'),
    path.join(home, '.mocode', 'skills'),
    path.join(process.cwd(), '.mocode', 'skills'),
  ];
}

/**
 * 极简 YAML frontmatter 解析(不引入 yaml 依赖)。
 * 仅支持单行键值:按首个冒号切 key/value,trim,去首尾配对引号。
 * 不支持块标量(| / >)与多行值——v1 限制(skill 的 description 实际多为单行)。
 *
 * 返回 { meta, body }:无 frontmatter 时 meta 为空、body 为原文。
 */
export function parseFrontmatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  const meta: Record<string, string> = {};
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  // 跳过前导空行,首行须是 ---
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || lines[i].trim() !== '---') {
    return { meta, body: content };
  }
  i++; // 跳过开 ---

  const fmLines: string[] = [];
  let closed = false;
  while (i < lines.length) {
    if (lines[i].trim() === '---') {
      closed = true;
      break;
    }
    fmLines.push(lines[i]);
    i++;
  }
  if (!closed) return { meta, body: content }; // 无闭合:视为无 frontmatter
  i++; // 跳过闭 ---

  for (const line of fmLines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // 去首尾配对引号(" 或 ')
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }

  const body = lines.slice(i).join('\n').replace(/^\n+/, '');
  return { meta, body };
}

/**
 * 扫描所有 skill 目录,解析 frontmatter,按目录优先级去重。
 * 同步 fs + 全程静默容错(目录不存在 / 读失败 / 解析失败 → 跳过,不抛),
 * 风格对齐 src/session/persist.ts。按 resolveSkillsDirs 升序遍历,
 * Map.set 后设覆盖先设 → 项目级优先。
 */
export function discoverSkills(): Skill[] {
  const dirs = resolveSkillsDirs();
  const byName = new Map<string, Skill>();

  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue; // 目录不存在或无权限,静默跳过
    }

    for (const name of entries) {
      // 跳过内置 skill 同名目录(项目级用户版可放在 ~/.mocode/skills/<name>/
      // 覆盖内置版;cwd/.mocode/skills/<name>/ 也算项目级覆盖)。discoverSkills 按
      // 优先级升序遍历、项目级 Map.set 后写覆盖先写,所以这里只是「不重复登记内置」,
      // 真实覆盖逻辑在 listSkills 的合并步骤。
      if (builtinSkillNames.has(name)) continue;
      const skillDir = path.join(dir, name);
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      try {
        if (!existsSync(skillMdPath)) continue;
        const content = readFileSync(skillMdPath, 'utf8');
        const { meta } = parseFrontmatter(content);
        const skillName = (meta.name || name).trim();
        const description = (meta.description || '').trim();
        if (!description) continue; // 缺 description 跳过(它是最触发机制)
        byName.set(skillName, {
          name: skillName,
          description,
          version: meta.version?.trim() || undefined,
          license: meta.license?.trim() || undefined,
          dir: skillDir,
          skillMdPath,
        });
      } catch {
        continue; // 读 / 解析失败静默跳过
      }
    }
  }

  return Array.from(byName.values());
}
