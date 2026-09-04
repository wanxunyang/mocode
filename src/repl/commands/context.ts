/**
 * 上下文命令组:/context
 *
 * dialog-only:打印一条 renderContextBar 摘要行。
 * 设计意图是"我说了多少"(见 status-bar.ts 的注释),不进状态栏 inline。
 */
import * as layout from '../../ui/layout.js';
import { renderContextBar } from '../status-bar.js';
import { unhandled, next, type CommandHandler } from './types.js';

export const contextCommands: CommandHandler[] = [
  (ctx) => {
    if (ctx.line !== '/context') return unhandled();
    layout.contentWrite(`  ${renderContextBar(ctx.history)}\n`);
    return next();
  },
];
