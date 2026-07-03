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
  /** 手动拖拽(替代不可靠的 -webkit-app-region:drag,见 style.css 顶部注释):
   *  dragStart 在 mousedown 时调用一次,让主进程记住窗口起始 bounds;
   *  dragMove 在 mousemove 时传"相对起点的累计位移"(不是相对上一帧的增量)——
   *  这样主进程永远从固定的起始尺寸算新位置,不会因反复读取可能已被 Windows DPI 舍入误差
   *  放大的当前尺寸而越拖越大(见 main.ts dragStartBounds 注释);
   *  dragEnd 在 mouseup 时调用,清空起始记录。 */
  dragStart: () => {
    ipcRenderer.send('pet:drag-start');
  },
  dragMove: (totalDx: number, totalDy: number) => {
    ipcRenderer.send('pet:drag-move', totalDx, totalDy);
  },
  dragEnd: () => {
    ipcRenderer.send('pet:drag-end');
  },
});
