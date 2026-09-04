/**
 * 模式命令组:/plan · /auto · /mode
 *
 * 三者条件互斥(都是完整 line 精确匹配),组内顺序无关。
 * setAgentMode 触发 runtime 注册的 onModeChange listener,由它统一重写 history[0] +
 * 刷状态行 modeTag;这里只负责切状态和回显文案,不碰 history。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { t } from '../../i18n/index.js';
import { getAgentMode, setAgentMode } from '../../agent/mode.js';
import { unhandled, next, type CommandHandler } from './types.js';

export const modeCommands: CommandHandler[] = [
  // /plan:切到 plan 模式(只读探查 + 产出计划)。
  (ctx) => {
    if (ctx.line !== '/plan') return unhandled();
    if (getAgentMode() === 'plan') {
      layout.contentWrite(`${ui.dim}${t('repl.planAlready')}${ui.reset}\n`);
    } else {
      setAgentMode('plan');
      layout.contentWrite(`${ui.dim}${t('repl.planChanged')}${ui.reset}\n`);
    }
    return next();
  },
  (ctx) => {
    if (ctx.line !== '/auto') return unhandled();
    if (getAgentMode() === 'auto') {
      layout.contentWrite(`${ui.dim}${t('repl.autoAlready')}${ui.reset}\n`);
    } else {
      setAgentMode('auto');
      layout.contentWrite(`${ui.dim}${t('repl.autoChanged')}${ui.reset}\n`);
    }
    return next();
  },
  // /mode:菜单里的分支节点(本身不切换,只挂 /plan 与 /auto)。/help 会把它列出来,
  // 所以直接敲它必须给点有用的东西——打印当前模式与两个子命令,而不是报未知命令。
  (ctx) => {
    if (ctx.line !== '/mode') return unhandled();
    layout.contentWrite(`${ui.dim}${t('repl.modeCurrent', { mode: getAgentMode() })}${ui.reset}\n`);
    return next();
  },
];
