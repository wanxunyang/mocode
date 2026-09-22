/**
 * 工作区命令组:/cd
 *
 * `/cd <path>` 切换工作空间(等同 shell 的 cd,但同步移动沙箱边界与会话落盘目录),
 * `/cd` 无参显示当前工作区,`/cd -` 回到上一个工作区。
 *
 * 切换的语义按用户拍板的结果:**等同 /clear**——旧会话先落盘到原工作区,再在新工作区开新会话,
 * 屏幕历史清空、重新回到空会话状态。理由:跨项目的对话上下文混在一条 history 里会让
 * compaction 与 rollback 快照互相污染(旧项目的文件快照对新项目毫无意义),不如干净切开。
 * 与 /clear 的差异只有两点:① 切换前先 save(旧会话完整留在原工作区,不丢最后一轮);
 * ② history[0] 用新工作区重算(AGENTS.md 等按新工作区重新导入)。
 *
 * 底层改写集中在 src/workspace/index.ts(chdir + 沙箱根 + sessionDir 三处一起改),
 * 本文件只负责解析输入、提示、重置 REPL 状态。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { bannerLines } from '../../ui/render.js';
import { t } from '../../i18n/index.js';
import { getAgentMode } from '../../agent/mode.js';
import { getWorkspaceRoot, resolveWorkspaceTarget, switchWorkspaceRoot } from '../../workspace/index.js';
import { unhandled, next, type CommandHandler } from './types.js';

/** 解析失败原因 → 提示文案的 i18n 键。 */
const ERROR_KEYS = {
  missing: 'workspace.missing',
  'not-dir': 'workspace.notDir',
  'no-previous': 'workspace.noPrevious',
  empty: 'workspace.usage',
} as const;

export const workspaceCommands: CommandHandler[] = [
  (ctx) => {
    if (ctx.line !== '/cd' && !ctx.line.startsWith('/cd ')) return unhandled();
    const arg = ctx.line === '/cd' ? '' : ctx.line.slice('/cd '.length).trim();

    // 无参:只报当前工作区(沙箱根 == 工作区根),不改任何状态。
    if (!arg) {
      layout.contentWrite(`${ui.dim}${t('workspace.current', { root: getWorkspaceRoot() })}${ui.reset}\n`);
      layout.contentWrite(`${ui.dim}${t('workspace.usage')}${ui.reset}\n\n`);
      return next();
    }

    const target = resolveWorkspaceTarget(arg);
    if (!target.ok) {
      const key = ERROR_KEYS[target.error];
      layout.contentWrite(`${ui.yellow}${t(key, { root: target.root })}${ui.reset}\n\n`);
      return next();
    }
    // 已经是当前工作区:什么都不用做(不触发 /clear,避免误清历史)。
    if (pathEqual(target.root, getWorkspaceRoot())) {
      layout.contentWrite(`${ui.dim}${t('workspace.same', { root: target.root })}${ui.reset}\n\n`);
      return next();
    }

    // ① 切前落盘:旧会话完整留在原工作区(/clear 不保存,切换必须保存,否则最后一轮丢失)。
    //    无 user 消息时 save 内部会跳过空会话,不会产生垃圾 session 文件。
    if (ctx.state.currentSessionId) {
      try {
        ctx.runtime.session.save(
          ctx.history,
          ctx.state.currentSessionId,
          ctx.state.queryHistory,
          ctx.state.lastToolGroups,
        );
      } catch {
        // 落盘失败不阻断切换:会话是附加价值,工作区本身必须切过去。
      }
    }

    // ② 改进程级状态(cwd + 沙箱根 + sessionDir)。
    const result = switchWorkspaceRoot(target.root);

    // ③ 重置 REPL 状态(与 /clear 对齐)——新工作区 = 新会话。
    ctx.history.length = 1;
    ctx.history[0] = { role: 'system', content: ctx.buildSystemMessage(getAgentMode() === 'plan') };
    ctx.state.currentSessionId = ctx.runtime.session.clear();
    ctx.state.turnCount = 0;
    ctx.state.lastTurnUsage = undefined;
    ctx.state.queryHistory = [];
    ctx.state.lastToolGroups = [];
    ctx.contextState.lastUsage = undefined;
    ctx.contextState.lifecycleStats = undefined;
    ctx.contextState.ephemeralText = undefined;
    ctx.contextState.activeTools = undefined;
    ctx.contextState.promptAnchor = undefined; // 新工作区不得沿用旧会话的实测锚点
    ctx.attachments.clear();

    // ④ 重画:banner 里的 cwd 已随 chdir 变新值;状态行基线同步刷新(底栏目录显示)。
    layout.clearContent();
    layout.writeBanner(bannerLines(ctx.banner()));
    ctx.refreshStatusBase(ctx.history);
    layout.contentWrite(`${ui.cyan}${t('workspace.switched', { root: result.root })}${ui.reset}\n`);
    layout.contentWrite(`${ui.dim}${t('workspace.cleared', { root: result.previous })}${ui.reset}\n`);
    layout.contentWrite(`${ui.dim}${t('workspace.projectConfigHint')}${ui.reset}\n\n`);
    layout.writeWelcomeBlock(ctx.welcomeLines());
    return next();
  },
];

/** 同目录判定:Windows 大小写不敏感 + 尾部分隔符差异(path.resolve 已归一,故只比大小写)。 */
function pathEqual(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
