// relation-vocab.ts —— 受控关系词表(轻量,不含实体类型/domain-range)。
//
// 这是 memory-2.2 本体方案里"软封闭世界"的最小落地:只约束**关系名**,不引入实体类型
// 体系或推理。反思抽取 triples/profile 时优先用词表内关系;词表外关系**仍允许写入**
// (软策略,不阻断长尾),但会被计数为 relViolation 供观测。等真实数据证明需要,再升级
// 为完整 ontology.ts(实体 type + domain/range + 逆/传递)。
//
// 纯常量 + 纯函数,叶子模块,无 IO。

import type { MemoryScope } from './store.js';

/** 项目轨(懂仓库)首选关系:高复用、可结构化的连接。 */
export const PROJECT_RELATIONS = [
  'depends_on',
  'uses',
  'used_by',
  'calls',
  'part_of',
  'implemented_in',
  'reads',
  'writes',
  'configured_by',
  'runs_on',
  'listens_on',
  'tests',
  'documented_in',
  'decided_by',
  'conflicts_with',
  'related_to',
] as const;

/** 用户轨(懂用户)画像关系:挂 person-primary。 */
export const PROFILE_RELATIONS = [
  'named',
  'has_role',
  'works_at',
  'located_in',
  'speaks',
  'verbosity',
  'communication_style',
  'prefers',
  'avoid',
  'avoids',
  'current_goal',
  'constraint',
  'has_hobby',
  'skill_level',
  'related_to',
] as const;

/** 常见同义/拼写漂移 → 规范关系(反思落库前归范)。 */
export const RELATION_ALIASES: Record<string, string> = {
  employed_by: 'works_at',
  employer: 'works_at',
  lives_in: 'located_in',
  based_in: 'located_in',
  location: 'located_in',
  hobby: 'has_hobby',
  role: 'has_role',
  is_a: 'related_to',
  uses_port: 'listens_on',
  port: 'listens_on',
  depends: 'depends_on',
  dependency: 'depends_on',
  implements: 'implemented_in',
  impl: 'implemented_in',
  decides: 'decided_by',
  conflict: 'conflicts_with',
  configure: 'configured_by',
};

const PROJECT_SET = new Set<string>(PROJECT_RELATIONS);
const PROFILE_SET = new Set<string>(PROFILE_RELATIONS);

/**
 * 画像轨的**单值关系**(Wikidata single-value 约束的最小落地):同一主语在该关系上
 * 只允许一条 active 边——写入新值(哪怕 dst 不同,如换城市/换工作)时,同 src+relation
 * 的旧边一律时序失效。多值关系(prefers / has_hobby / constraint…)不在此列。
 */
const PROFILE_SINGLE_VALUE = new Set<string>([
  'named',
  'has_role',
  'works_at',
  'located_in',
  'speaks',
  'verbosity',
  'communication_style',
  'current_goal',
]);

/** 关系名归一:lowercase + 空白转下划线 + 别名映射。 */
export function normalizeRelation(raw: string): string {
  const base = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  return RELATION_ALIASES[base] ?? base;
}

/** 关系是否在对应 scope 的首选词表内(先归一再判定)。 */
export function isKnownRelation(relation: string, scope: MemoryScope): boolean {
  const r = normalizeRelation(relation);
  return scope === 'global' ? PROFILE_SET.has(r) : PROJECT_SET.has(r);
}

/** 画像关系是否单值(换值即作废旧边;先归一再判定)。 */
export function isSingleValueProfile(relation: string): boolean {
  return PROFILE_SINGLE_VALUE.has(normalizeRelation(relation));
}

/** 注入反思提示词的紧凑词表(按 scope)。 */
export function relationCheatSheet(scope: MemoryScope): string {
  return scope === 'global' ? PROFILE_RELATIONS.join(', ') : PROJECT_RELATIONS.join(', ');
}
