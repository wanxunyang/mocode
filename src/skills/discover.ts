// skills 发现子系统。
// 仅依赖 node 标准库,是叶子模块:不依赖 config/agent/llm/tools,避免环。
//
// 约定:每个 skill 是一个目录 <skill-name>/SKILL.md,顶部 YAML frontmatter。
// 元数据始终注入系统提示,正文由 use_skill 工具按需加载(渐进式披露)。
// frontmatter 兼容 Agent Skills 开放标准(name/description/allowed-tools/context/agent…),
// 解析器是受限 YAML 子集(自写,不引 yaml 依赖),越界字段一律忽略 + 记 warning。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinSkillNames } from './builtin-skills.js';

export type SkillOrigin = 'builtin' | 'user' | 'project';
export type SkillContext = 'inline' | 'fork';

export interface Skill {
  name: string;
  description: string;
  version?: string;
  license?: string;
  dir: string;
  skillMdPath: string;
  /** 内置 skill 的正文内联在此(避免文件系统依赖);用户/项目 skill 留空,getSkillBody 走文件读取。 */
  body?: string;
  // ── 执行面 / 封装控制(开放标准字段;缺省保守)──
  /** `context: fork` 或兼容别名 `mode: fork` → 'fork';其余 'inline'。 */
  context: SkillContext;

  /** 归一化后的工具名列表(数组 / 方括号 / 空格分隔串统一于此)。 */
  allowedTools?: string[];
  /** 禁用工具名列表(语义同 allowed-tools 的对立面)。 */
  disallowedTools?: string[];
  /** `disable-model-invocation: true` 取反;缺省 true(模型可自动触发)。 */
  modelInvocable: boolean;
  /** `max-steps:` 子 agent 步数上限;缺省取 config.subAgentMaxSteps。 */
  maxSteps?: number;
  /** `argument-hint:` 补全提示。 */
  argumentHint?: string;
  /** 触发场景补充(与 description 合并用于路由)。 */
  whenToUse?: string;
  /** 来源:builtin 恒信任;user(~/.*)免门禁;project(<cwd>/.mocode)走信任门禁。 */
  origin: SkillOrigin;
  /** 解析期收集的告警(未知字段 / 未知 agent 值…),/skills 展示。 */
  warnings: string[];
}

/** frontmatter 单值:标量字符串或数组(allowed-tools 等)。 */
export type FrontmatterValue = string | string[];

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

/** 数组型 frontmatter 键(这些键的整行值按空白切分为 token 列表)。 */
const ARRAY_KEYS = new Set(['allowed-tools', 'disallowed-tools']);

/** 行内数组 / 方括号数组:按空白或逗号切分,去空。 */
function splitList(s: string): string[] {
  return s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 取标量值(数组值返回 undefined)。 */
function scalar(meta: Record<string, FrontmatterValue>, key: string): string | undefined {
  const v = meta[key];
  return typeof v === 'string' ? v : undefined;
}

/** 取可能为数组的值,统一成 string[] | undefined。 */
function asArray(meta: Record<string, FrontmatterValue>, key: string): string[] | undefined {
  const v = meta[key];
  if (Array.isArray(v)) return v.length ? v : undefined;
  if (typeof v === 'string' && v) return splitList(v);
  return undefined;
}

function truthy(meta: Record<string, FrontmatterValue>, key: string): boolean {
  const v = scalar(meta, key);
  return v != null && (v.toLowerCase() === 'true' || v === '1');
}

function num(meta: Record<string, FrontmatterValue>, key: string): number | undefined {
  const v = scalar(meta, key);
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 去掉首尾配对引号(YAML 标量基本语义;`"use when: foo"` → `use when: foo`)。 */
function unquote(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

/** `context: fork` 或兼容别名 `mode: fork` → 'fork';其余 'inline'。 */
function resolveContext(meta: Record<string, FrontmatterValue>): SkillContext {
  if (scalar(meta, 'context') === 'fork') return 'fork';
  if (scalar(meta, 'mode') === 'fork') return 'fork'; // 旧内部别名
  return 'inline';
}

/** 收集本轮不支持、已忽略的字段,用于 /skills 提示(不阻断加载)。
 *  `agent:` 曾在旧 read/write 双模式下决定子 agent 工具面;子 agent 现与主 agent 同权,
 *  该字段不再产生任何效果,按"已忽略"提示作者,避免其误以为仍有限权语义。 */
function collectWarnings(meta: Record<string, FrontmatterValue>): string[] {
  const warnings: string[] = [];
  for (const k of ['hooks', 'model', 'effort', 'paths', 'agent']) {
    if (k in meta) warnings.push(`字段 "${k}" 当前不支持,已忽略`);
  }
  return warnings;
}

/**
 * 受限 YAML 子集解析(不引入 yaml 依赖)。
 * 支持四种值形态:
 *  - 标量 `key: value`
 *  - 行内数组 `allowed-tools: a, b` / 方括号 `allowed-tools: [a, b]`
 *  - 块序列(下一行起 `  - item`)
 *  - 空格分隔字符串(标准形态 `allowed-tools: Read grep run_command`,仅数组型键)
 * 其余(嵌套 map / 块标量)一律忽略,保持攻击面与维护成本可控。
 *
 * 返回 { meta, body }:无 frontmatter 时 meta 为空、body 为原文。
 */
export function parseFrontmatter(content: string): {
  meta: Record<string, FrontmatterValue>;
  body: string;
} {
  const meta: Record<string, FrontmatterValue> = {};
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

  const isListItem = (l: string): boolean => {
    const t = l.trim();
    return t === '-' || t.startsWith('- ');
  };
  const itemText = (l: string): string => {
    const t = l.trim();
    return t === '-' ? '' : t.slice(2).trim();
  };

  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    // 块序列:当前值为空且下一行是列表项
    if (value === '' && k + 1 < fmLines.length && isListItem(fmLines[k + 1])) {
      const arr: string[] = [];
      let j = k + 1;
      while (j < fmLines.length && isListItem(fmLines[j])) {
        arr.push(itemText(fmLines[j]));
        j++;
      }
      meta[key] = arr;
      k = j - 1; // for 循环会再 +1
      continue;
    }
    // 方括号数组
    if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = splitList(value.slice(1, -1));
      continue;
    }
    // 数组型键:整行按空白切分为 token(标准形态 Bash(git:*) Read)
    if (ARRAY_KEYS.has(key)) {
      meta[key] = value ? splitList(value) : [];
      continue;
    }
    meta[key] = unquote(value);
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
  // 记录本次发现的所有 SKILL.md 路径,供 skillsScanSignature 做廉价热重载探测
  // (只 stat 已知文件,不每次全量重扫)。新增 skill 目录会改目录 mtime → 触发全量重扫。
  const seenMdPaths: string[] = [];
  const projDir = path.join(process.cwd(), '.mocode', 'skills');
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

    // SKILLS_DIRS 自定义目录无法归类 project,统一按 user(免门禁)处理。
    const origin: SkillOrigin = dir === projDir ? 'project' : 'user';

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
        seenMdPaths.push(skillMdPath);
        const content = readFileSync(skillMdPath, 'utf8');
        const { meta } = parseFrontmatter(content);
        const skillName = (scalar(meta, 'name') || name).trim();
        const description = (scalar(meta, 'description') || '').trim();
        if (!description) continue; // 缺 description 跳过(它是最触发机制)
        const warnings = collectWarnings(meta);
        byName.set(skillName, {
          name: skillName,
          description,
          version: scalar(meta, 'version')?.trim() || undefined,
          license: scalar(meta, 'license')?.trim() || undefined,
          dir: skillDir,
          skillMdPath,
          // body 留空:用户/项目 skill 由 getSkillBody 走文件读取(保留热重载语义)。
          context: resolveContext(meta),
          allowedTools: asArray(meta, 'allowed-tools'),
          disallowedTools: asArray(meta, 'disallowed-tools'),
          modelInvocable: !truthy(meta, 'disable-model-invocation'),
          maxSteps: num(meta, 'max-steps'),
          argumentHint: scalar(meta, 'argument-hint')?.trim() || undefined,
          whenToUse: scalar(meta, 'when_to_use')?.trim() || undefined,
          origin,
          warnings,
        });
      } catch {
        continue; // 读 / 解析失败静默跳过
      }
    }
  }

  // 首次全量扫描后,把发现的 SKILL.md 路径交给热重载探测器,后续只 stat 这些已知文件。
  lastKnownMdPaths = seenMdPaths;
  return Array.from(byName.values());
}

/** 上一次 discoverSkills 发现的 SKILL.md 路径;skillsScanSignature 复用,避免每次全量重扫。 */
let lastKnownMdPaths: string[] = [];

/** 供热重载签名计算:各 skills 目录 mtime + 已知 SKILL.md 的 mtime。
 * 目录 mtime 变化(新增/删除 skill 目录)或任一已知文件变动 → 签名变更 → 重扫。
 * 首轮 lastKnownMdPaths 为空时退化为只测目录 mtime(首轮 listSkills 后即填充)。 */
export function skillsScanSignature(): string {
  const parts: string[] = [];
  for (const dir of resolveSkillsDirs()) {
    try {
      parts.push('D' + dir + statSync(dir).mtimeMs);
    } catch {
      parts.push('D' + dir + 'x');
    }
  }
  for (const p of lastKnownMdPaths) {
    try {
      parts.push('F' + p + statSync(p).mtimeMs);
    } catch {
      parts.push('F' + p + 'x');
    }
  }
  return parts.join('\0');
}
