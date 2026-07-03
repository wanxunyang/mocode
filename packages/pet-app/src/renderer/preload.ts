// Electron preload:通过 contextBridge 把主进程 IPC 推送的状态安全暴露给渲染进程(contextIsolation=true,
// 不给渲染进程任何 Node/Electron API 访问权限,只转发一个只读回调注册接口)。

import { contextBridge, ipcRenderer } from 'electron';
import type { PetState, PetStateMeta } from '../protocol.js';

contextBridge.exposeInMainWorld('petBridge', {
  onState: (callback: (state: PetState, meta?: PetStateMeta) => void) => {
    ipcRenderer.on('pet:state', (_event, payload: { state: PetState; meta?: PetStateMeta }) => {
      callback(payload.state, payload.meta);
    });
  },
  /** 主进程推来的皮肤切换通知(运行期切换:托盘菜单选择 或 CLI set_skin 消息触发)。 */
  onSkin: (callback: (assetPath: string) => void) => {
    ipcRenderer.on('pet:skin', (_event, payload: { assetPath: string }) => {
      callback(payload.assetPath);
    });
  },
  /** 启动时主动拉取当前皮肤(避免 did-finish-load 推送与监听器注册之间的时序竞争)。 */
  getInitialSkin: (): Promise<{ assetPath: string }> => ipcRenderer.invoke('pet:get-skin'),
  /** 转发鼠标穿透状态请求(拖拽放置功能:悬停/拖拽时取消穿透,离开后恢复穿透)。 */
  setIgnoreMouseEvents: (ignore: boolean) => {
    ipcRenderer.send('pet:set-ignore-mouse-events', ignore);
  },
  /** 手动拖拽:把鼠标位移量(屏幕坐标差)转发给主进程,由主进程调用 win.setPosition 移动窗口。
   *  不使用 -webkit-app-region:drag——该 CSS 属性在 Windows 上会导致覆盖区域的所有指针事件被吞掉,
   *  使 mouseenter/mouseleave 永远不触发,从而 setIgnoreMouseEvents(false) 也永远不会被调用。 */
  moveWindow: (dx: number, dy: number) => {
    ipcRenderer.send('pet:move-window', dx, dy);
  },
});
