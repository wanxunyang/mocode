// health.ts —— R4.1 记忆健康快照。
//
// 存在的理由:在此之前,"记忆到底有没有用"只能靠手感。文档 §2.1 早就写着
// 「先有尺子再造家具」,但尺子一直是缺的 —— R3 前摄、R6 情节、R11 巩固都实现完了,
// 却没有任何一个数字能回答"它在真实使用中命中过吗"。
//
// 只做**汇总**,不做采集:
//  - 条目/锚点/派生来自 `store.ts` 的读时判定(不新增埋点,零写放大);
//  - 检索来自 `recall-stats.ts`(已有);
//  - 前摄来自 `proactive.ts` 的计数器(R4.1 新增,内存累计 + 退出落盘);
//  - 画像来自 `persona.ts` 的两张清单。
//
// 叶子依赖:只读 memory 模块内部状态与 node 标准库,不依赖 config/agent/repl。
// 开关由调用方判定后经 `enabled` 传入(同 store.ts 的既有约定),这样 health 本身
// 可测试、也不会在"记忆已关闭"时偷偷建文件。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  loadAll,
  loadAnchorStaleMap,
  loadStalenessMap,
  wantsTrigger,
  type MemoryScope,
  type MemoryType,
} from './store.js';
import { readRecallStats } from './recall-stats.js';
import { proactiveCounters } from './proactive.js';
import { listInternalizedProfile, listProfileCandidates } from './persona.js';
import { MAX_ACTIVE } from '../tools/constants.js';

/** 快照结构版本。字段增删时自增,让读旧文件的人能立刻发现口径变了。 */
export const MEMORY_HEALTH_SCHEMA_VERSION = 1;

export interface MemoryHealth {
  schemaVersion: number;
  generatedAt: string;
  entries: {
    total: number;
    active: number;
    archived: number;
    superseded: number;
    byType: Partial<Record<MemoryType, number>>;
    byScope: Partial<Record<MemoryScope, number>>;
    /** active 条目占 `MAX_ACTIVE` 封顶的比例,提前预警"要挤出去了"。 */
    activeCapUsage: number;
  };
  /**
   * trigger 覆盖率。分母只算**建议带 trigger 的类型**(pitfall/decision/feedback),
   * 而不是全部条目 —— `fact`/`reference` 是纯陈述,没有 trigger 是正常的,
   * 把它们算进分母会让覆盖率永远停在低位,看起来像"通道坏了"。
   */
  trigger: { required: number; withTrigger: number; coverage: number };
  /** R2 锚点失效情况。stale 率高说明符号片段切得太粗,或代码在快速重构。 */
  anchors: { anchored: number; stale: number; staleRate: number };
  /** R14 派生失效情况。恒为 0 有两种含义(没有派生条目 / 源都没失效),要连 anchored 一起看。 */
  derived: { total: number; stale: number; staleRate: number };
  /** R6/R11 情节:产出量与巩固量。consolidated 长期为 0 说明 R11 没真跑起来。 */
  episodes: { active: number; consolidated: number; consolidationRate: number };
  retrieval: {
    searches: number;
    graphHits: number;
    /** 图谱段命中率(有命中 / 搜索次数)。 */
    graphHitRate: number;
    lastSearchedAt: string | null;
    /** 从未被召回过的 active 条目数 —— "只写不读"的直接度量。 */
    neverRecalled: number;
  };
  proactive: {
    toolCalls: number;
    injections: number;
    triggerHits: number;
    anchorHits: number;
    staleAnchorHits: number;
    distinctEntries: number;
    /** 注入次数 / 可匹配工具调用次数。过低说明 trigger 或索引有问题。 */
    injectRate: number;
    /** 锚点注入里已失效的比例。高 = 锚点噪音大,该考虑降权或重写锚点。 */
    staleAnchorRate: number;
  };
  profile: { internalized: number; candidates: number };
  /** 人可读的观测提示(按严重性排序,最多 6 条)。空数组 = 没有值得说的异常。 */
  warnings: string[];
}

function rate(num: number, den: number): number {
  if (den <= 0) return 0;
  // 保留三位小数:这个文件会被 diff 比较,浮点评比点好看。
  return Math.round((num / den) * 1000) / 1000;
}

/** 汇总一份快照。纯读,不写盘、不改任何条目。 */
export function buildMemoryHealth(): MemoryHealth {
  const all = loadAll();
  const active = all.filter((e) => e.status === 'active');

  const byType: Partial<Record<MemoryType, number>> = {};
  const byScope: Partial<Record<MemoryScope, number>> = {};
  for (const e of active) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    byScope[e.scope] = (byScope[e.scope] ?? 0) + 1;
  }

  // trigger 覆盖:分母只含建议带 trigger 的类型(理由见 MemoryHealth.trigger)
  const triggerRequired = active.filter((e) => e.type !== 'episode' && wantsTrigger(e.type));
  const withTrigger = triggerRequired.filter((e) => !!e.trigger?.trim());

  const staleness = loadStalenessMap(all);
  const anchorStale = loadAnchorStaleMap(all);
  const derivedEntries = active.filter((e) => (e.derivedFrom?.length ?? 0) > 0);
  const anchorEntries = active.filter((e) => (e.anchors?.length ?? 0) > 0);

  const episodes = active.filter((e) => e.type === 'episode');
  const consolidated = episodes.filter((e) => !!e.derivedInto);

  const recall = readRecallStats();
  const pc = proactiveCounters();

  let internalized = 0;
  let candidates = 0;
  try {
    internalized = listInternalizedProfile().length;
    candidates = listProfileCandidates().length;
  } catch {
    // 图谱读失败只是少两项画像数字,不该让整个快照失败
  }

  const health: MemoryHealth = {
    schemaVersion: MEMORY_HEALTH_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    entries: {
      total: all.length,
      active: active.length,
      archived: all.filter((e) => e.status === 'archived').length,
      superseded: all.filter((e) => e.status === 'superseded').length,
      byType,
      byScope,
      activeCapUsage: rate(active.filter((e) => e.type !== 'episode').length, MAX_ACTIVE),
    },
    trigger: {
      required: triggerRequired.length,
      withTrigger: withTrigger.length,
      coverage: rate(withTrigger.length, triggerRequired.length),
    },
    anchors: {
      anchored: anchorEntries.length,
      stale: anchorEntries.filter((e) => anchorStale.get(e.id)?.stale).length,
      staleRate: rate(anchorEntries.filter((e) => anchorStale.get(e.id)?.stale).length, anchorEntries.length),
    },
    derived: {
      total: derivedEntries.length,
      stale: derivedEntries.filter((e) => staleness.get(e.id)?.stale).length,
      staleRate: rate(derivedEntries.filter((e) => staleness.get(e.id)?.stale).length, derivedEntries.length),
    },
    episodes: {
      active: episodes.length,
      consolidated: consolidated.length,
      consolidationRate: rate(consolidated.length, episodes.length),
    },
    retrieval: {
      searches: recall.searches,
      graphHits: recall.graphHits,
      graphHitRate: rate(recall.graphHits, recall.searches),
      lastSearchedAt: recall.lastSearchedAt,
      neverRecalled: active.filter((e) => e.type !== 'episode' && e.recallCount === 0).length,
    },
    proactive: {
      ...pc,
      injectRate: rate(pc.injections, pc.toolCalls),
      staleAnchorRate: rate(pc.staleAnchorHits, pc.anchorHits),
    },
    profile: { internalized, candidates },
    warnings: [],
  };

  health.warnings = collectWarnings(health);
  return health;
}

/**
 * 把"数字异常"翻译成人话。
 *
 * 为什么值得写:纯数字文件没人看。每条 warning 都指向一个**可执行**的动作,
 * 而不是复述指标本身 —— 否则它只是把同一组数字换个说法。
 */
function collectWarnings(h: MemoryHealth): string[] {
  const out: string[] = [];
  if (h.retrieval.searches === 0 && h.entries.active > 0) {
    out.push('memory_search 从未被调用:记忆只写不读,pull 侧优化全部无效,优先看 push(R3/R3.6)是否命中');
  }
  if (h.trigger.required >= 5 && h.trigger.coverage < 0.5) {
    out.push(
      `trigger 覆盖率仅 ${Math.round(h.trigger.coverage * 100)}%(${h.trigger.withTrigger}/${h.trigger.required}),前摄索引会命中不到东西`,
    );
  }
  if (h.proactive.toolCalls >= 50 && h.proactive.injections === 0) {
    out.push(`前摄 ${h.proactive.toolCalls} 次可匹配调用零注入:检查 trigger 用词是否与真实任务文本重合`);
  }
  if (h.proactive.staleAnchorRate > 0.3 && h.proactive.anchorHits >= 5) {
    out.push(
      `锚点注入里 ${Math.round(h.proactive.staleAnchorRate * 100)}% 已失效:考虑加固符号片段或降低 stale 注入优先级`,
    );
  }
  if (h.episodes.active >= 6 && h.episodes.consolidated === 0) {
    out.push(`已有 ${h.episodes.active} 条情节但零巩固:检查 R11 分组阈值是否过严,或巩固任务是否被开关关掉`);
  }
  if (h.entries.activeCapUsage > 0.8) {
    out.push(`active 已占封顶 ${Math.round(h.entries.activeCapUsage * 100)}%:即将开始淘汰低召回条目`);
  }
  if (h.derived.total > 0 && h.derived.staleRate > 0.5) {
    out.push(`派生条目 ${Math.round(h.derived.staleRate * 100)}% 已因源失效待复核:需要一轮反思去重写结论`);
  }
  return out.slice(0, 6);
}

function healthPath(): string {
  return path.join(process.cwd(), '.mocode', 'memory-health.json');
}

/**
 * 写快照。`enabled=false` 时不落盘(关闭记忆就不该留下任何记忆文件,R8.5 同一口径)。
 * 原子写(tmp+rename),失败静默:健康快照是可观测性产物,绝不能拖垮主流程。
 */
export function writeMemoryHealth(enabled: boolean = true): MemoryHealth | null {
  if (!enabled) return null;
  let health: MemoryHealth;
  try {
    health = buildMemoryHealth();
  } catch {
    return null;
  }
  try {
    const p = healthPath();
    mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(health, null, 2) + '\n', 'utf8');
    renameSync(tmp, p);
  } catch {
    // 静默:观测失败不影响功能
  }
  return health;
}

/** 读回既有快照(供 `/memory health --last` 之类场景);缺失/损坏返 null。 */
export function readMemoryHealth(): MemoryHealth | null {
  try {
    const p = healthPath();
    if (!existsSync(p)) return null;
    const o = JSON.parse(readFileSync(p, 'utf8')) as MemoryHealth;
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** 供 `/memory health` 渲染的多行文本(无 UI 依赖,命令层自己上色)。 */
export function formatMemoryHealth(h: MemoryHealth = buildMemoryHealth()): string[] {
  const lines: string[] = [];
  lines.push(
    `条目:active ${h.entries.active} / total ${h.entries.total}` +
      `(archived ${h.entries.archived}${h.entries.superseded ? `, superseded ${h.entries.superseded}` : ''})` +
      ` · 封顶占用 ${pct(h.entries.activeCapUsage)}`,
  );
  const types = Object.entries(h.entries.byType)
    .map(([t, n]) => `${t} ${n}`)
    .join('  ');
  if (types) lines.push(`按类:${types}`);
  lines.push(`trigger 覆盖:${h.trigger.withTrigger}/${h.trigger.required}(${pct(h.trigger.coverage)})`);
  lines.push(
    `锚点:${h.anchors.anchored} 条已锚 · stale ${h.anchors.stale}(${pct(h.anchors.staleRate)})` +
      `  |  派生:${h.derived.total} 条 · 待复核 ${h.derived.stale}(${pct(h.derived.staleRate)})`,
  );
  lines.push(
    `情节:active ${h.episodes.active} · 已巩固 ${h.episodes.consolidated}(${pct(h.episodes.consolidationRate)})`,
  );
  lines.push(
    `检索:memory_search ${h.retrieval.searches} 次 · 图谱命中 ${h.retrieval.graphHits}(${pct(h.retrieval.graphHitRate)})` +
      ` · 从未被召回的 active ${h.retrieval.neverRecalled} 条`,
  );
  lines.push(
    `前摄:可匹配调用 ${h.proactive.toolCalls} · 注入 ${h.proactive.injections}(${pct(h.proactive.injectRate)})` +
      ` · trigger ${h.proactive.triggerHits} / 锚点 ${h.proactive.anchorHits}(其中失效 ${h.proactive.staleAnchorHits},${pct(h.proactive.staleAnchorRate)})`,
  );
  lines.push(`画像:内化 ${h.profile.internalized} · 候选 ${h.profile.candidates}`);
  for (const w of h.warnings) lines.push(`⚠ ${w}`);
  return lines;
}
