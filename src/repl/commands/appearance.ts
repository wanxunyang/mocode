/**
 * 外观命令组:/theme [name|list]
 *
 * 无参开菜单(↑↓ 选,Enter 切换,Esc 取消);/theme <name> 直切;/theme list 或未知名 → 列出。
 *
 * 切换路径:setTheme → 重算状态行(新色)→ 清内容重绘(历史 / 横幅,镜像启动 + /resume)→
 * 确认 → 持久化。markdown MEMO 按 themeVersion 自动失效,故 renderHistory 取新色;
 * 状态栏 / 输入框由 next 回 INPUT 态时读 getter 刷。
 */
import * as layout from '../../ui/layout.js';
import { ui, setTheme, getTheme, listThemes, themeExists } from '../../ui/theme.js';
import { bannerLines } from '../../ui/render.js';
import { t } from '../../i18n/index.js';
import { config } from '../../config/index.js';
import { updateConfigKey } from '../../config/file.js';
import { promptThemePicker, type SessionPickerItem } from '../../ui/prompt.js';
import { themeDescription } from '../commands.js';
import { renderHistory } from '../message-format.js';
import { unhandled, next, type CommandHandler } from './types.js';

export const appearanceCommands: CommandHandler[] = [
  async (ctx) => {
    const { line } = ctx;
    if (line !== '/theme' && !line.startsWith('/theme ')) return unhandled();
    const arg = line.startsWith('/theme ') ? line.slice('/theme '.length).trim() : '';
    let name: string | null;
    if (arg === '') {
      // 无参:菜单选(仿 /resume /rollback 的 picker)
      const items: SessionPickerItem[] = listThemes().map((th) => ({
        id: th,
        title: th,
        subtitle: themeDescription(th),
      }));
      let pick: SessionPickerItem | null;
      try {
        pick = await promptThemePicker(items);
      } catch {
        return next(); // Ctrl+C(SIGINT)→ 取消
      }
      name = pick?.id ?? null;
    } else if (arg === 'list' || !themeExists(arg)) {
      layout.contentWrite(`${ui.dim}${t('repl.themeList')}${ui.reset}\n`);
      for (const theme of listThemes()) {
        layout.contentWrite(`  ${ui.accent}${theme}${ui.reset}  ${ui.dim}${themeDescription(theme)}${ui.reset}\n`);
      }
      layout.contentWrite(`${ui.dim}${t('repl.themeCurrent', { theme: getTheme() })}${ui.reset}\n`);
      return next();
    } else {
      name = arg;
    }
    if (name === null) return next(); // Esc / Ctrl+D 取消
    setTheme(name);
    ctx.refreshStatusBase(ctx.history);
    layout.clearContent();
    if (ctx.history.some((m) => m.role === 'user')) {
      renderHistory(ctx.history);
    } else {
      layout.writeBanner(bannerLines(ctx.banner()));
    }
    layout.contentWrite(`${ui.dim}${t('repl.themeChanged', { theme: name })}${ui.reset}\n`);
    updateConfigKey('MOCODE_THEME', name);
    if (config.themeFromShell) {
      layout.contentWrite(
        `${ui.dim}(shell 环境变量 MOCODE_THEME 已设,文件写入下次启动被其覆盖;取消该 shell 设置后生效)${ui.reset}\n`,
      );
    }
    return next();
  },
];
