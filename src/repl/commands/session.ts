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
  // /rollback:打开轮次菜单(↑/↓ 选,Enter 回滚到该轮并预填其输入,再 Enter 重新跑)。
  // 忽略任何数字参数(原「输数字选回滚」已删,统一走菜单)。无快照的旧轮次(/resume 重建)文件改动不可撤销。
  async (ctx) => {
    if (ctx.line !== '/rollback' && !ctx.line.startsWith('/rollback ')) return unhandled();
    await ctx.rollbackFlow();
    return next();
  },
];
