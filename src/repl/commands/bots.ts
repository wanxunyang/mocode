/**
 * 具名 Bot 命令:/bots
 * 只读列出 bots；增删改/查看详情走 CLI `mocode bots …`，按名运行用 --bot <name>。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { listBots } from '../../bots/store.js';
import { unhandled, next, type CommandHandler } from './types.js';

function oneLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > 50 ? `${line.slice(0, 50)}…` : line;
}

export const botsCommands: CommandHandler[] = [
  (ctx) => {
    if (ctx.line !== '/bots') return unhandled();
    const all = listBots();
    if (all.length === 0) {
      layout.contentWrite(`${ui.dim}(no bots; mocode bots add --name <n> --prompt "…")${ui.reset}\n`);
      return next();
    }
    for (const b of all) {
      const scopeTag = b.scope === 'global' ? `${ui.dim}g${ui.reset}` : `${ui.cyan}p${ui.reset}`;
      layout.contentWrite(
        `  ${scopeTag} ${ui.bold}${b.name}${ui.reset}` +
          `${b.tools && b.tools.length ? ` ${ui.dim}tools:${b.tools.length}${ui.reset}` : ''}` +
          `  ${ui.dim}${b.description}${ui.reset}\n` +
          `      ${ui.dim}${oneLine(b.systemPrompt)}${ui.reset}\n`,
      );
    }
    layout.contentWrite(
      `${ui.dim}  run: mocode run --bot ${all[0]?.name ?? '<name>'} "task" · details: mocode bots show <name>${ui.reset}\n`,
    );
    return next();
  },
];
