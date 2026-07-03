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
});
