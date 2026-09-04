/**
 * 记忆命令组:/memory · /reflect
 *
 * 只读概览 + 后台反思触发。/memory_switch /memory_status 是**配置写入**命令,
 * 与 /subagent /fe /mcp 同属 tool-group,放 tool-group.ts(见该文件),不在这里。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { isMemoryEnabled } from '../../config/index.js';
import { kickoffReflection, snapshotTranscript, loadAll } from '../../memory/index.js';
import { unhandled, next, type CommandHandler } from './types.js';

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
    kickoffReflection(snapshotTranscript(ctx.history, 20));
    layout.contentWrite(
      `${ui.dim}(反思已触发,后台进行;完成后下次输入态显示摘要。日志见 .mocode/memory.log)${ui.reset}\n`,
    );
    return next();
  },
];
