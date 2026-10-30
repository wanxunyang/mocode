/**
 * 记忆命令组:/memory · /reflect · /memory profile|confirm|drop|show|pause|export|import|forget
 *
 * 只读概览 + 后台反思触发 + 长期画像检视/纠错 + **用户主权面**(R8:导出/导入/批量遗忘/暂停)。
 * /memory_switch /memory_status 是**配置写入**命令,与 /subagent /fe /mcp 同属 tool-group,
 * 放 tool-group.ts,不在这里。
 * 注意:顶层 /profile 被刻意禁用(见 tests/tool-profiles.test.ts),画像命令并入 /memory 组。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { isMemoryEnabled } from '../../config/index.js';
import { getAgentMode } from '../../agent/mode.js';
import {
  kickoffReflection,
  snapshotTranscript,
  loadAll,
  loadAllGraph,
  loadStalenessMap,
  listInternalizedProfile,
  listProfileCandidates,
  promoteEdge,
  invalidateEdge,
  writeMemoryHealth,
  formatMemoryHealth,
  flushProactiveStats,
  // R8 用户主权面
  purgeEntries,
  buildPack,
  writePack,
  importPackFile,
  memoryWriteBlockedMessage,
  setMemoryWritesPaused,
  isMemoryWritesPaused,
  appendAudit,
  type MemoryEntry,
} from '../../memory/index.js';
import { evaluateAnchors, evaluateAnchor } from '../../memory/anchor.js';
import { unhandled, next, type CommandHandler } from './types.js';

/** /profile 改动画像后,让 About you 段(history[0])立刻反映,不用等重启。 */
function refreshSystemPrompt(ctx: Parameters<CommandHandler>[0]): void {
  ctx.history[0] = { role: 'system', content: ctx.buildSystemMessage(getAgentMode() === 'plan') };
  ctx.refreshStatusBase(ctx.history);
}

/** 渲染 /profile:已内化(L2)与待确认候选(L1)两段。 */
function renderProfile(): string {
  const internalized = listInternalizedProfile();
  const candidates = listProfileCandidates();
  const ev = (e: { confirmed?: number; contradicted?: number } | undefined): string => {
    const c = e?.confirmed ?? 0;
    const x = e?.contradicted ?? 0;
    return c || x ? ` [印证${c}/相悖${x}]` : '';
  };
  const lines: string[] = [];
  lines.push(`${ui.accent}长期画像(已内化,每轮常驻 About you)${ui.reset}`);
  if (internalized.length === 0) {
    lines.push(`${ui.dim}  (暂无;用户亲述/确认,或多次行为印证零反驳的稳定事实才会进这里)${ui.reset}`);
  } else {
    for (const c of internalized) {
      lines.push(`  ${ui.accent}${c.edge.id}${ui.reset}  ${c.text}${ui.dim}${ev(c.edge.evidence)}${ui.reset}`);
    }
  }
  lines.push('');
  lines.push(`${ui.accent}待确认候选(反思推断,未内化、不常驻)${ui.reset}`);
  if (candidates.length === 0) {
    lines.push(`${ui.dim}  (暂无)${ui.reset}`);
  } else {
    for (const c of candidates) {
      lines.push(
        `  ${ui.dim}${c.edge.id}${ui.reset}  ${c.text} ${ui.dim}[conf ${c.edge.confidence ?? '?'}${ev(c.edge.evidence)}]${ui.reset}`,
      );
    }
  }
  lines.push('');
  lines.push(`${ui.dim}/memory confirm <edge-id> 确认候选并内化 · /memory drop <edge-id> 撤销某条${ui.reset}`);
  return lines.join('\n') + '\n';
}

/**
 * R8.4 来源标记(概览单行用)。
 *
 * 只有两种可得信息:有条目级 `source.session` 说明它由**后台**产生(反思/情节),
 * 否则就是会话里 `memory_save` 亲手写的。刻意不猜更细的 prov——条目结构里没有置信字段,
 * 编一个出来比不显示更糟;要看得更细用 `/memory show <id>` 看图谱边的 prov/confidence。
 */
export function sourceMark(e: MemoryEntry): string {
  return e.source?.session ? '[reflection]' : '[tool]';
}

/** `/memory show <id>`:一条记忆的全部出处。导出仅供测试断言渲染结果。 */
export function renderEntryDetail(e: MemoryEntry): string {
  const lines: string[] = [];
  const kv = (k: string, v: string): void => {
    lines.push(`  ${ui.dim}${k.padEnd(12)}${ui.reset}${v}`);
  };
  lines.push(`${ui.accent}${e.id}${ui.reset}  ${e.name}`);
  kv('类型/状态', `${e.type} · ${e.status}${e.pinned ? ' · pinned(不受自动衰减)' : ''}`);
  kv('作用域', e.scope === 'global' ? 'global(跨项目)' : 'project(本仓库)');
  kv('创建/更新', `${e.createdAt} → ${e.updatedAt}`);
  kv('召回', `${e.recallCount} 次${e.lastRecalledAt ? ` · 最近 ${e.lastRecalledAt}` : ''}`);
  // R8.4 的核心一行:凭什么信它。
  kv(
    '来源',
    e.source?.session
      ? `后台产生(反思/情节),会话 ${e.source.session.slice(0, 8)}${e.source.turn !== undefined ? ` 第 ${e.source.turn} 轮` : ''}`
      : '会话内工具写入(memory_save)',
  );
  if (e.lastUpdateReason) kv('最近变更', e.lastUpdateReason);
  if (e.trigger) kv('trigger', e.trigger);
  if (e.action) kv('action', e.action);
  if (e.supersededBy) kv('被取代于', e.supersededBy);
  if (e.derivedFrom?.length) kv('派生自', e.derivedFrom.join(', '));
  if (e.derivedInto) kv('已巩固到', e.derivedInto);

  // 图谱边:条目自身没有置信字段,真正的 prov/confidence 挂在边上。
  const edges = loadAllGraph().edges.filter((ed) => ed.sourceEntry === e.id);
  if (edges.length > 0) {
    lines.push(`${ui.dim}  关联断言(${edges.length} 条):${ui.reset}`);
    for (const ed of edges.slice(0, 8)) {
      const prov = ed.prov ?? '未标注';
      const conf = typeof ed.confidence === 'number' ? ` conf ${ed.confidence}` : '';
      const dead = ed.invalidAt ? ` ${ui.dim}(已失效 ${ed.invalidReason ?? ''})${ui.reset}` : '';
      lines.push(`    ${ui.dim}${ed.src} --${ed.relation}--> ${ed.dst} [${prov}${conf}]${ui.reset}${dead}`);
    }
  }

  if (e.anchors?.length) {
    const st = evaluateAnchors(e.anchors);
    lines.push(
      `${ui.dim}  代码锚点(${e.anchors.length}):${st.stale ? `已变动 ${st.changed.length}/缺失 ${st.missing.length}` : '全部 fresh'}${ui.reset}`,
    );
    for (const a of e.anchors) {
      const r = evaluateAnchor(a);
      const label = a.symbol ? `${a.path}#${a.symbol}` : a.path;
      const flag = r.status === 'fresh' ? '' : ` ${ui.dim}[${r.status}${r.detail ? `: ${r.detail}` : ''}]${ui.reset}`;
      lines.push(`    ${ui.dim}${label}${ui.reset}${flag}`);
    }
  }

  lines.push('');
  lines.push(`${ui.dim}${e.summary}${ui.reset}`);
  lines.push(`${ui.dim}${e.body}${ui.reset}`);
  return lines.join('\n') + '\n';
}

/** 解析 `/memory forget` 的参数。返回 null 表示使用错误(调用方打用法)。 */
function parseForgetArgs(
  rest: string,
): { all: boolean; scope?: 'global' | 'project'; since?: string; match?: string; dryRun: boolean } | null {
  const toks = rest.split(/\s+/).filter(Boolean);
  const out: { all: boolean; scope?: 'global' | 'project'; since?: string; match?: string; dryRun: boolean } = {
    all: false,
    dryRun: false,
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '--all') out.all = true;
    else if (t === '--dry-run') out.dryRun = true;
    else if (t === '--scope') {
      const v = toks[++i];
      if (v !== 'global' && v !== 'project') return null;
      out.scope = v;
    } else if (t === '--since') {
      const v = toks[++i];
      if (!v || !Number.isFinite(Date.parse(v))) return null;
      out.since = v;
    } else if (t === '--match') {
      const v = toks[++i];
      if (!v) return null;
      out.match = v;
    } else return null;
  }
  return out;
}

const FORGET_USAGE =
  '用法:/memory forget --all | --match <关键词> | --since <YYYY-MM-DD> [--scope global|project] [--dry-run]';

export const memoryCommands: CommandHandler[] = [
  (ctx) => {
    if (ctx.line !== '/memory') return unhandled();
    // 记忆库概览:计数 + 近期 active 索引(详情用 memory_search)。
    const all = loadAll();
    const active = all.filter((e) => e.status === 'active');
    const archived = all.filter((e) => e.status === 'archived').length;
    const byType: Record<string, number> = {};
    for (const e of active) byType[e.type] = (byType[e.type] || 0) + 1;
    // R14:派生条目里有多少条已经该复核了。这一项是「级联失效」唯一的观测口——
    // 只有数字会涨(或恒为 0)时,才知道源失效有没有真的传导到派生结论上。
    // 恒为 0 有两种可能:没有派生条目,或派生链条根本没建立,两者都必须看得见。
    const staleMap = loadStalenessMap(all);
    const staleCount = active.filter((e) => staleMap.get(e.id)?.stale).length;
    const derivedCount = active.filter((e) => (e.derivedFrom?.length ?? 0) > 0).length;
    layout.contentWrite(
      `${ui.dim}记忆库:active ${active.length}${archived ? ` · archived ${archived}` : ''}${
        derivedCount ? ` · 派生 ${derivedCount}(其中 ${staleCount} 条待复核)` : ''
      }${ui.reset}\n`,
    );
    if (Object.keys(byType).length) {
      layout.contentWrite(
        `${ui.dim}按类:${Object.entries(byType)
          .map(([t, n]) => `${t} ${n}`)
          .join('  ')}${ui.reset}\n`,
      );
    }
    const recent = [...active].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 10);
    for (const e of recent) {
      // R8.4:每行带来源标记。用户判断「要不要信这条」的第一步是知道它是**谁写的**——
      // 模型在会话里主动存(tool)与后台反思/情节自动产生(session)的可信度完全不同。
      layout.contentWrite(
        `  ${ui.accent}${e.id}${ui.reset}  ${ui.dim}${e.name} — ${e.summary} ${ui.reset}${ui.dim}${sourceMark(e)}${ui.reset}\n`,
      );
    }
    if (active.length === 0)
      layout.contentWrite(`${ui.dim}(无 active 记忆;用 memory_save 存,或 /init 生成 AGENTS.md)${ui.reset}\n`);
    // R8.3:暂停状态必须在概览里可见——否则用户以为在记,其实一条都没落盘。
    if (isMemoryWritesPaused()) {
      layout.contentWrite(`${ui.dim}(写入已暂停:本会话不再新增/修改记忆;用 /memory pause off 恢复)${ui.reset}\n`);
    }
    layout.contentWrite(`${ui.dim}(详情用 memory_search;启动索引已注入 systemPrompt)${ui.reset}\n`);
    return next();
  },
  (ctx) => {
    if (ctx.line !== '/memory health') return unhandled();
    // R4.1:先落一次盘再读,让本次会话的前摄计数也进快照(计数器是内存累计的)。
    if (!isMemoryEnabled()) {
      layout.contentWrite(`${ui.dim}(记忆子系统已关闭,/memory health 无效。用 /memory_switch 打开)${ui.reset}\n`);
      return next();
    }
    flushProactiveStats();
    const health = writeMemoryHealth(true);
    if (!health) {
      layout.contentWrite(`${ui.dim}(健康快照生成失败,详见 .mocode/memory-health.json)${ui.reset}\n`);
      return next();
    }
    for (const line of formatMemoryHealth(health)) layout.contentWrite(`${ui.dim}${line}${ui.reset}\n`);
    layout.contentWrite(`${ui.dim}(快照已写入 .mocode/memory-health.json)${ui.reset}\n`);
    return next();
  },
  (ctx) => {
    if (ctx.line !== '/reflect') return unhandled();
    // 记忆子系统总开关关闭时反思无意义(kickoffReflection 内部也会短路),直接提示,不误导用户"已触发"。
    if (!isMemoryEnabled()) {
      layout.contentWrite(`${ui.dim}(记忆子系统已关闭,/reflect 无效。用 /memory_switch 打开后再试)${ui.reset}\n`);
      return next();
    }
    // 手动触发后台反思 pass(不等;完成后下次 INPUT 态显摘要)。
    // manual=true:绕过自动节流(次数/转录闸门),但记忆总开关关闭时仍短路。
    kickoffReflection(snapshotTranscript(ctx.history, 20), true);
    layout.contentWrite(
      `${ui.dim}(反思已触发,后台进行;完成后下次输入态显示摘要。日志见 .mocode/memory.log)${ui.reset}\n`,
    );
    return next();
  },
  (ctx) => {
    if (ctx.line !== '/memory profile') return unhandled();
    if (!isMemoryEnabled()) {
      layout.contentWrite(`${ui.dim}(记忆子系统已关闭,/memory profile 无效。用 /memory_switch 打开)${ui.reset}\n`);
      return next();
    }
    layout.contentWrite(renderProfile());
    return next();
  },
  (ctx) => {
    if (!ctx.line.startsWith('/memory confirm')) return unhandled();
    const edgeId = ctx.line.slice('/memory confirm'.length).trim();
    if (!edgeId) {
      layout.contentWrite(`${ui.dim}用法:/memory confirm <edge-id>(先 /memory profile 看候选)${ui.reset}\n`);
      return next();
    }
    const r = promoteEdge(edgeId);
    if (!r.ok) {
      layout.contentWrite(`${ui.dim}(确认失败:${r.reason})${ui.reset}\n`);
      return next();
    }
    refreshSystemPrompt(ctx);
    layout.contentWrite(`${ui.dim}(已确认并内化 [${edgeId}],下一轮起常驻 About you)${ui.reset}\n`);
    return next();
  },
  (ctx) => {
    if (!ctx.line.startsWith('/memory drop')) return unhandled();
    const edgeId = ctx.line.slice('/memory drop'.length).trim();
    if (!edgeId) {
      layout.contentWrite(`${ui.dim}用法:/memory drop <edge-id>(先 /memory profile 看列表)${ui.reset}\n`);
      return next();
    }
    const r = invalidateEdge(edgeId, 'profile-dropped');
    if (!r.ok) {
      layout.contentWrite(`${ui.dim}(撤销失败:${r.reason})${ui.reset}\n`);
      return next();
    }
    refreshSystemPrompt(ctx);
    layout.contentWrite(`${ui.dim}(已撤销画像 [${edgeId}],时序失效、可审计;下一轮 About you 不再含它)${ui.reset}\n`);
    return next();
  },
  // ── R8.4 单条详情 ──────────────────────────────────────────────────────
  (ctx) => {
    if (!ctx.line.startsWith('/memory show')) return unhandled();
    const id = ctx.line.slice('/memory show'.length).trim();
    if (!id) {
      layout.contentWrite(`${ui.dim}用法:/memory show <id>(id 见 /memory 概览或 memory_list)${ui.reset}\n`);
      return next();
    }
    // 允许前缀:概览里 id 很长,用户常只记得前几个字符。
    const all = loadAll();
    const hit = all.find((e) => e.id === id) ?? all.find((e) => e.id.startsWith(id));
    if (!hit) {
      layout.contentWrite(`${ui.dim}(找不到记忆 [${id}])${ui.reset}\n`);
      return next();
    }
    layout.contentWrite(renderEntryDetail(hit) + '\n');
    return next();
  },
  // ── R8.3 暂停写入 ──────────────────────────────────────────────────────
  (ctx) => {
    if (ctx.line !== '/memory pause' && !ctx.line.startsWith('/memory pause ')) return unhandled();
    const arg = ctx.line.slice('/memory pause'.length).trim().toLowerCase();
    if (arg && arg !== 'off' && arg !== 'on') {
      layout.contentWrite(`${ui.dim}用法:/memory pause(暂停写入) · /memory pause off(恢复)${ui.reset}\n`);
      return next();
    }
    const pause = arg !== 'off';
    setMemoryWritesPaused(pause);
    appendAudit({
      at: new Date().toISOString(),
      action: pause ? 'pause' : 'resume',
      detail: pause ? '本会话暂停记忆写入' : '本会话恢复记忆写入',
    });
    layout.contentWrite(
      pause
        ? `${ui.dim}(已暂停记忆写入:本轮不会新增/修改任何记忆,反思与情节也停止落盘;` +
            `检索、注入、画像读取照常。退出后自动恢复。用 /memory pause off 手动恢复)${ui.reset}\n`
        : `${ui.dim}(已恢复记忆写入)${ui.reset}\n`,
    );
    return next();
  },
  // ── R8.1 导出 ──────────────────────────────────────────────────────────
  (ctx) => {
    if (ctx.line !== '/memory export' && !ctx.line.startsWith('/memory export ')) return unhandled();
    const target = ctx.line.slice('/memory export'.length).trim() || undefined;
    try {
      const pack = buildPack();
      const p = writePack(pack, target);
      layout.contentWrite(
        `${ui.dim}(已导出 ${pack.entries.length} 条记忆 + ${pack.graph.entities.length} 实体/` +
          `${pack.graph.edges.length} 边 → ${p};schemaVersion ${pack.schemaVersion})${ui.reset}\n`,
      );
    } catch (e) {
      layout.contentWrite(`${ui.dim}(导出失败:${e instanceof Error ? e.message : String(e)})${ui.reset}\n`);
    }
    return next();
  },
  // ── R9.2 导入 ──────────────────────────────────────────────────────────
  (ctx) => {
    if (!ctx.line.startsWith('/memory import')) return unhandled();
    const file = ctx.line.slice('/memory import'.length).trim();
    if (!file) {
      layout.contentWrite(`${ui.dim}用法:/memory import <包路径>(由 /memory export 生成)${ui.reset}\n`);
      return next();
    }
    const r = importPackFile(file);
    if (!r.ok) {
      const why = 'blocked' in r ? memoryWriteBlockedMessage(r.blocked) : r.reason;
      layout.contentWrite(`${ui.dim}(导入失败:${why})${ui.reset}\n`);
      return next();
    }
    refreshSystemPrompt(ctx); // 新条目要进索引,下一轮就该看得见
    layout.contentWrite(
      `${ui.dim}(导入完成:新增 ${r.added} · 更新 ${r.updated} · 跳过 ${r.skipped}(同 id 且更新时刻不更晚);` +
        `图谱 +${r.addedEntities} 实体/+${r.addedEdges} 边)${ui.reset}\n`,
    );
    return next();
  },
  // ── R8.2 批量遗忘 ──────────────────────────────────────────────────────
  (ctx) => {
    if (!ctx.line.startsWith('/memory forget')) return unhandled();
    const rest = ctx.line.slice('/memory forget'.length).trim();
    const parsed = parseForgetArgs(rest);
    if (!parsed) {
      layout.contentWrite(`${ui.dim}${FORGET_USAGE}${ui.reset}\n`);
      return next();
    }
    if (!parsed.all && !parsed.match && !parsed.since) {
      layout.contentWrite(`${ui.dim}${FORGET_USAGE}${ui.reset}\n`);
      return next();
    }
    const r = purgeEntries(parsed);
    if ('blocked' in r) {
      layout.contentWrite(`${ui.dim}(${memoryWriteBlockedMessage(r.blocked)})${ui.reset}\n`);
      return next();
    }
    if (r.ids.length === 0) {
      layout.contentWrite(`${ui.dim}(没有匹配的条目${r.pinned ? `;${r.pinned} 条 pinned 已跳过` : ''})${ui.reset}\n`);
      return next();
    }
    const label = r.dryRun ? '将删除' : '已删除';
    layout.contentWrite(
      `${ui.dim}${label} ${r.ids.length} 条${r.pinned ? `(pinned 跳过 ${r.pinned} 条)` : ''}:${ui.reset}\n`,
    );
    for (const id of r.ids.slice(0, 20)) layout.contentWrite(`  ${ui.dim}${id}${ui.reset}\n`);
    if (r.ids.length > 20) layout.contentWrite(`  ${ui.dim}… 其余 ${r.ids.length - 20} 条${ui.reset}\n`);
    if (r.dryRun) {
      layout.contentWrite(`${ui.dim}(这是预览;去掉 --dry-run 才会真删。删除不可撤销)${ui.reset}\n`);
    } else {
      refreshSystemPrompt(ctx);
      layout.contentWrite(
        `${ui.dim}(audit 已记录到 .mocode/memory-audit.jsonl。注意:知识图谱里由这些条目派生的边不会自动清理,` +
          `需要时用 /memory drop <edge-id>)${ui.reset}\n`,
      );
    }
    return next();
  },
];
