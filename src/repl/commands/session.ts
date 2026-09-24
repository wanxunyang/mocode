/**
 * 会话命令组:/clear · /sessions · /resume · /rollback
 *
 * /clear 是这批里唯一**写**闭包状态的命令(currentSessionId / turnCount / lastTurnUsage),
 * 全部经 ctx.state 访问器写回 startRepl 的 `let`。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { bannerLines } from '../../ui/render.js';
import { t } from '../../i18n/index.js';
import { promptSessionPicker, type SessionPickerItem } from '../../ui/prompt.js';
import { unhandled, next, type CommandHandler } from './types.js';

export const sessionCommands: CommandHandler[] = [
  (ctx) => {
    if (ctx.line !== '/clear') return unhandled();
    ctx.history.length = 1; // 保留 system 提示
    ctx.state.currentSessionId = ctx.runtime.session.clear();
    ctx.state.turnCount = 0; // 反思 cadence 重新计数
    ctx.contextState.lastUsage = undefined;
    ctx.contextState.lifecycleStats = undefined;
    ctx.contextState.ephemeralText = undefined;
    ctx.contextState.activeTools = undefined;
    ctx.contextState.promptAnchor = undefined; // 新会话不得用旧会话的实测锚点外推
    ctx.state.lastTurnUsage = undefined; // 清空旧轮的 token 累计
    ctx.state.lastToolGroups = []; // 新会话不得继承旧会话的路由回退
    ctx.attachments.clear(); // 一并清空待发图片
    layout.clearContent();
    layout.writeBanner(bannerLines(ctx.banner()));
    layout.contentWrite(`${ui.dim}${t('repl.historyCleared')}${ui.reset}\n`);
    layout.writeWelcomeBlock(ctx.welcomeLines()); // 回到空会话状态,欢迎引导重新出现
    return next();
  },
  // /sessions:浏览全部已保存会话(慢路径,readdir+全量 JSON.parse,目录 N 大时会有可感知卡顿)。
  // 默认走 /resume(仅最近 10 条,瞬开);要翻历史续接更早的会话才用这条。
  // picker 走全显(cap=items.length,无 a 展开提示),靠 picker 自身开窗(以选中为中心分屏)。
  async (ctx) => {
    if (ctx.line !== '/sessions') return unhandled();
    const sessions = ctx.runtime.session.list(); // 不传 limit = 全量
    if (sessions.length === 0) {
      layout.contentWrite(`${ui.dim}(没有已保存的会话)${ui.reset}\n`);
      return next();
    }
    const items: SessionPickerItem[] = sessions.map((s) => ({
      id: s.id,
      title: s.firstUser || '(无)',
      subtitle: `${s.id}  ${s.model}`,
    }));
    let pick: SessionPickerItem | null;
    try {
      pick = await promptSessionPicker(items, items.length);
    } catch {
      return next(); // Ctrl+C(SIGINT)→ 取消
    }
    await ctx.resumeFromPick(pick);
    return next();
  },
  // /resume:打开会话菜单(↑/↓ 选,Enter 续接,Esc 取消)。只加载最近 10 条,
  // 避免 sessions 目录堆了几百个会话时 readdir+全量 JSON.parse 卡顿。
  // 仿 /rollback 菜单化(promptSessionPicker);选中项 cyan+bold + ▸ 高亮。
  // 要续接更早的会话请用 /sessions 翻全表,或 CLI `mocode --resume <id>`。
  async (ctx) => {
    if (ctx.line !== '/resume') return unhandled();
    const sessions = ctx.runtime.session.list(10);
    if (sessions.length === 0) {
      layout.contentWrite(`${ui.dim}(没有已保存的会话)${ui.reset}\n`);
      return next();
    }
    const items: SessionPickerItem[] = sessions.map((s) => ({
      id: s.id,
      title: s.firstUser || '(无)',
      subtitle: `${s.id}  ${s.model}`,
    }));
    let pick: SessionPickerItem | null;
    try {
      pick = await promptSessionPicker(items);
    } catch {
      return next(); // Ctrl+C(SIGINT)→ 取消
    }
    await ctx.resumeFromPick(pick);
    return next();
  },
  // /session gc [--yes]:老会话垃圾回收。30 天未活动→gzip 归档(archive/),90 天→清正文。
  // 默认(及 --dry-run)只列计划不写盘;--yes 才执行——删除不可逆,用显式参数而非交互确认。
  async (ctx) => {
    const m = /^\/sessions?\s+gc\b(.*)$/.exec(ctx.line);
    if (!m) return unhandled();
    const args = (m[1] ?? '').trim();
    const execute = args === '--yes';
    if (args && args !== '--yes' && args !== '--dry-run') {
      layout.contentWrite(`${ui.yellow}用法: /session gc [--dry-run|--yes]${ui.reset}\n`);
      return next();
    }
    const fmtKb = (n: number): string => `${(n / 1024).toFixed(0)}KB`;
    if (execute) {
      const result = await ctx.runtime.session.gc({ dryRun: false });
      layout.contentWrite(
        `${ui.accent}已归档 ${result.archived}、清除 ${result.purged},回收 ${fmtKb(result.bytesReclaimed)}${ui.reset}\n`,
      );
      return next();
    }
    const plan = ctx.runtime.session.gc({ dryRun: true });
    if (plan.items.length === 0) {
      layout.contentWrite(`${ui.dim}(没有需要归档或清除的会话)${ui.reset}\n`);
      return next();
    }
    for (const it of plan.items) {
      const label = it.action === 'archive' ? `${ui.cyan}归档` : `${ui.yellow}清除`;
      layout.contentWrite(
        `  ${label}${ui.reset}  ${it.id}  ${it.ageDays.toFixed(0)}天  ${fmtKb(it.sizeBytes)}  ${it.firstUser}\n`,
      );
    }
    layout.contentWrite(`  ${ui.dim}共 ${plan.items.length} 项,可回收 ${fmtKb(plan.bytesReclaimable)}${ui.reset}\n`);
    layout.contentWrite(`${ui.dim}(dry-run;加 --yes 执行,归档/清除不可逆)${ui.reset}\n`);
    return next();
  },
  // /ssearch <关键词>:跨会话搜索归档(episodic),命中显示 id/日期/摘要。
  // 未 purge 的会话可直接 /resume <id> 取回;已 purge 仅可检索摘要。
  (ctx) => {
    if (!ctx.line.startsWith('/ssearch')) return unhandled();
    const query = ctx.line.replace(/^\/ssearch\s*/, '').trim();
    if (!query) {
      layout.contentWrite(`${ui.yellow}用法: /ssearch <关键词>${ui.reset}\n`);
      return next();
    }
    const hits = ctx.runtime.session.searchArchive(query, 10);
    if (hits.length === 0) {
      layout.contentWrite(`${ui.dim}(无匹配归档会话)${ui.reset}\n`);
      return next();
    }
    for (const h of hits) {
      const tag = h.purgedAt ? ` ${ui.yellow}[仅摘要]${ui.reset}` : ` ${ui.dim}[可 resume]${ui.reset}`;
      layout.contentWrite(`  ${ui.cyan}${h.id}${ui.reset}  ${h.createdAt}${tag}\n`);
      const body = (h.summary || h.firstUser).split('\n').slice(0, 4).join('\n');
      layout.contentWrite(`  ${ui.dim}${body}${ui.reset}\n\n`);
    }
    return next();
  },
  // /rollback:打开轮次菜单(↑/↓ 选,Enter 回滚到该轮并预填其输入,再 Enter 重新跑)。
  // 忽略任何数字参数(原「输数字选回滚」已删,统一走菜单)。无快照的旧轮次(/resume 重建)文件改动不可撤销。
  async (ctx) => {
    if (ctx.line !== '/rollback' && !ctx.line.startsWith('/rollback ')) return unhandled();
    await ctx.rollbackFlow();
    return next();
  },
];
