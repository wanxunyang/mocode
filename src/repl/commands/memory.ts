/**
 * 记忆命令组:/memory · /reflect · /memory profile|confirm|drop
 *
 * 只读概览 + 后台反思触发 + 长期画像检视/纠错。/memory_switch /memory_status 是
 * **配置写入**命令,与 /subagent /fe /mcp 同属 tool-group,放 tool-group.ts,不在这里。
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
  listInternalizedProfile,
  listProfileCandidates,
  promoteEdge,
  invalidateEdge,
} from '../../memory/index.js';
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

export const memoryCommands: CommandHandler[] = [
  (ctx) => {
    if (ctx.line !== '/memory') return unhandled();
    // 记忆库概览:计数 + 近期 active 索引(详情用 memory_search)。
    const all = loadAll();
    const active = all.filter((e) => e.status === 'active');
    const archived = all.filter((e) => e.status === 'archived').length;
    const byType: Record<string, number> = {};
    for (const e of active) byType[e.type] = (byType[e.type] || 0) + 1;
    layout.contentWrite(
      `${ui.dim}记忆库:active ${active.length}${archived ? ` · archived ${archived}` : ''}${ui.reset}\n`,
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
      layout.contentWrite(`  ${ui.accent}${e.id}${ui.reset}  ${ui.dim}${e.name} — ${e.summary}${ui.reset}\n`);
    }
    if (active.length === 0)
      layout.contentWrite(`${ui.dim}(无 active 记忆;用 memory_save 存,或 /init 生成 AGENTS.md)${ui.reset}\n`);
    layout.contentWrite(`${ui.dim}(详情用 memory_search;启动索引已注入 systemPrompt)${ui.reset}\n`);
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
];
