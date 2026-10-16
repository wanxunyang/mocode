// persona.ts —— 全局「用户画像」内化层(Memory 2.1 双轨的 global 轨)。
//
// 与 buildMemoryIndexSection(条目摘要、按需召回、会衰减)不同,这里产出的
// `## About you` 是**高等级(L2)画像**:锚定在全局规范实体 person-primary 的
// active 图谱边上,每个会话无条件常驻 system prompt,体量硬封顶以保护 prompt cache。
// 身份类事实用图谱时序边表达(换工作/搬家时旧边 invalidAt),天然不受 memory 条目
// 30 天衰减影响——这是"越用越懂用户"那条易失通道之外的确定性内化通道。
//
// 纯读、不建实体(建实体/归一走 graph.canonicalizePrimaryPerson,在启动期显式做)。

import {
  loadScopeGraph,
  canonicalizePrimaryPerson,
  PRIMARY_PERSON_ID,
  type GraphEdge,
  type GraphEntity,
} from './graph.js';

/** About you 段硬预算(字符):只放高等级画像,超了按置信/顺序截断。 */
export const ABOUT_YOU_MAX_CHARS = 800;

/** 关系 → 人类可读标签(画像白名单;不在表内的关系用 fact 原文,仍可展示)。 */
const RELATION_LABEL: Record<string, string> = {
  named: '称呼',
  has_role: '角色',
  works_at: '就职于',
  located_in: '所在地',
  speaks: '语言',
  verbosity: '回复详略',
  communication_style: '沟通风格',
  current_goal: '当前目标',
  constraint: '约束',
  prefers: '偏好',
  avoids: '避免',
  travel_preference: '旅行偏好',
  has_hobby: '兴趣',
  skill_level: '擅长',
  related_to: '相关',
};

function displayName(name: string): string {
  // 图谱里部分历史实体名是 snake_case(leisure_travel / hangzhou),展示时松绑。
  if (/[\u4e00-\u9fff]/.test(name)) return name;
  return name.replace(/[_-]+/g, ' ').trim();
}

interface FactLine {
  text: string;
  relation: string;
}

/**
 * 渲染全局 L2 画像段。无 person-primary / 无 active 画像边 → 空串(零注入)。
 * 优先用边上的中文 fact 原文;没有 fact 时用「关系标签 + 目标实体名」。
 * 同名去重;has_hobby 合并为一行;整体截断到 ABOUT_YOU_MAX_CHARS。
 */
export function buildAboutYouSection(memoryEnabled: boolean = true): string {
  if (!memoryEnabled) return '';
  const g = loadScopeGraph('global');
  const me = g.entities.find((e) => e.id === PRIMARY_PERSON_ID);
  if (!me) return '';
  const byId = new Map(g.entities.map((e) => [e.id, e]));

  const outgoing = g.edges.filter((e) => !e.invalidAt && e.src === PRIMARY_PERSON_ID && e.dst !== PRIMARY_PERSON_ID);
  if (outgoing.length === 0) return '';

  const hobbies: string[] = [];
  const lines: FactLine[] = [];
  const seen = new Set<string>();
  const push = (text: string, relation: string) => {
    const key = text.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    lines.push({ text: key, relation });
  };

  for (const e of outgoing) {
    const dst = byId.get(e.dst);
    const target = dst ? displayName(dst.name) : displayName(e.dst);
    if (e.relation === 'has_hobby') {
      if (target && !hobbies.includes(target)) hobbies.push(target);
      continue;
    }
    if (e.fact && e.fact.trim()) {
      push(e.fact.trim(), e.relation);
    } else {
      const label = RELATION_LABEL[e.relation] ?? e.relation.replace(/_/g, ' ');
      push(`${label}:${target}`, e.relation);
    }
  }
  if (hobbies.length) push(`兴趣:${hobbies.join('、')}`, 'has_hobby');

  if (lines.length === 0) return '';

  // 稳定排序:白名单关系按预定义优先级,其余按文本;让输出跨会话稳定(护 cache)。
  const order = Object.keys(RELATION_LABEL);
  lines.sort((a, b) => {
    const ia = order.indexOf(a.relation);
    const ib = order.indexOf(b.relation);
    if (ia !== ib) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.text.localeCompare(b.text);
  });

  const header = `## About you(长期用户画像,跨项目始终生效)`;
  // 内部 slug 实体名(mocode user / user-name-* 归一后留下的别名)不作为"又称"展示。
  const visibleAliases = me.aliases
    .map(displayName)
    .filter((a) => a && a !== displayName(me.name) && !/^(mocode user|user name)\b/i.test(a));
  const nameLine = `- 用户:${displayName(me.name)}${visibleAliases.length ? `(又称 ${visibleAliases.join('、')})` : ''}`;
  const body = ['', header, nameLine, ...lines.map((l) => `- ${l.text}`)].join('\n');

  if (body.length <= ABOUT_YOU_MAX_CHARS) return body;
  // 截断:从低优先级行往前丢,保住身份/地点/目标等高等级项。
  const kept: string[] = [header, nameLine];
  let budget = ABOUT_YOU_MAX_CHARS - kept.join('\n').length;
  for (const l of lines) {
    const piece = `- ${l.text}`;
    if (piece.length + 1 > budget) continue;
    kept.push(piece);
    budget -= piece.length + 1;
  }
  return kept.join('\n');
}

/** 仅供测试/调试:列出 person-primary 当前 active 画像边(原始结构)。 */
export function inspectPrimaryProfile(): { me: GraphEntity | null; edges: GraphEdge[] } {
  const g = loadScopeGraph('global');
  const me = g.entities.find((e) => e.id === PRIMARY_PERSON_ID) ?? null;
  const edges = g.edges.filter((e) => !e.invalidAt && (e.src === PRIMARY_PERSON_ID || e.dst === PRIMARY_PERSON_ID));
  return { me, edges };
}

let personaInitialized = false;

/**
 * 启动期幂等初始化:做一次全局身份归一(把 mocode-user / user-name-* / 自称等碎片
 * 并入 person-primary)。每进程至多一次;记忆开关关闭时不碰图谱。best-effort——
 * 归一失败不应影响 REPL 启动(调用方自行 catch)。
 */
export function initPersona(memoryEnabled: boolean = true): void {
  if (personaInitialized) return;
  personaInitialized = true;
  if (!memoryEnabled) return;
  try {
    canonicalizePrimaryPerson();
  } catch {
    // 归一只是增强(图谱损坏/IO 异常),绝不能拖垮 REPL 启动。
  }
}

/** 测试专用:重置进程内初始化标记。 */
export function __resetPersonaInitForTests(): void {
  personaInitialized = false;
}
