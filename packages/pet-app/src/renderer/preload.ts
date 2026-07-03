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
  /** 主进程推来的皮肤切换通知(托盘菜单选择 或 CLI set_skin 消息触发)。 */
  onSkin: (callback: (assetPath: string) => void) => {
    ipcRenderer.on('pet:skin', (_event, payload: { assetPath: string }) => {
      callback(payload.assetPath);
    });
  },
  /** 转发鼠标穿透状态请求(拖拽放置功能:悬停时取消穿透,离开后恢复穿透)。 */
  setIgnoreMouseEvents: (ignore: boolean) => {
    ipcRenderer.send('pet:set-ignore-mouse-events', ignore);
  },
});
