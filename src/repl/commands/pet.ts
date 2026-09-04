/**
 * 桌宠命令组:/pet quit · /pet skin · /pet
 *
 * 顺序敏感:`/pet quit`、`/pet skin` 必须排在裸 `/pet` 之前(后者是完整匹配,
 * 前两者也是完整匹配,但语义上前者更具体)。保持原 if 链的相对顺序。
 */
import * as layout from '../../ui/layout.js';
import { ui } from '../../ui/theme.js';
import { togglePet, killPetProcess, listSkins, setSkin } from '../../pet/bridge.js';
import { promptThemePicker, type SessionPickerItem } from '../../ui/prompt.js';
import { unhandled, next, type CommandHandler } from './types.js';

export const petCommands: CommandHandler[] = [
  // /pet quit:完全关闭桌宠进程(区别于 /pet 的仅断开本连接)。方案C的 CLI 侧退出入口,
  // 另一入口是桌宠托盘菜单"退出桌宠"(见 packages/pet-app/src/main.ts)。
  async (ctx) => {
    if (ctx.line !== '/pet quit') return unhandled();
    const { ok, reason } = await killPetProcess();
    layout.contentWrite(`${ui.dim}(${ok ? '已关闭桌宠进程' : (reason ?? '关闭失败')})${ui.reset}\n`);
    return next();
  },
  // /pet skin:菜单选皮(↑↓ 选,Enter 切换,Esc 取消),仿 /theme 的交互。要求桌宠已在运行
  // (未运行则先提示 /pet 打开;不在此处自动 spawn,避免选皮命令产生"顺带开桌宠"的意外副作用)。
  async (ctx) => {
    if (ctx.line !== '/pet skin') return unhandled();
    let skinList: { skins: { id: string; name: string }[]; currentSkinId: string };
    try {
      skinList = await listSkins();
    } catch (e) {
      layout.contentWrite(`${ui.dim}(${e instanceof Error ? e.message : '获取皮肤列表失败'})${ui.reset}\n`);
      return next();
    }
    const items: SessionPickerItem[] = [
      { id: 'default', title: '默认(mascot)', subtitle: skinList.currentSkinId === 'default' ? '当前' : '' },
      ...skinList.skins.map((s) => ({
        id: s.id,
        title: s.name,
        subtitle: skinList.currentSkinId === s.id ? '当前' : '',
      })),
    ];
    let pick: SessionPickerItem | null;
    try {
      pick = await promptThemePicker(items);
    } catch {
      return next(); // Ctrl+C(SIGINT)→ 取消
    }
    if (pick === null) return next(); // Esc / Ctrl+D 取消
    setSkin(pick.id);
    layout.contentWrite(`${ui.dim}(已切换桌宠皮肤:${pick.title})${ui.reset}\n`);
    return next();
  },
  // /pet:开关桌宠。已连接→断开;未连接→探测端口(已有实例则直连)或 spawn 拉起 + 退避重试连接。
  // togglePet 不抛异常,所有失败路径转为返回值——桌宠是可选增强,任何异常都不能影响 REPL 主流程。
  async (ctx) => {
    if (ctx.line !== '/pet') return unhandled();
    const { connected, reason } = await togglePet();
    if (connected) {
      layout.contentWrite(`${ui.dim}(桌宠已连接)${ui.reset}\n`);
    } else {
      layout.contentWrite(`${ui.dim}(${reason ?? '桌宠已断开'})${ui.reset}\n`);
    }
    return next();
  },
];
