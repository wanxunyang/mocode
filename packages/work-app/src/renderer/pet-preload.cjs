const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pet', {
  snapshot: () => ipcRenderer.invoke('pet:snapshot'),
  character: () => ipcRenderer.invoke('pet:character'),
  nextNotice: () => ipcRenderer.invoke('pet:notice'),
  cursor: () => ipcRenderer.invoke('pet:cursor'),
  move: (x, y) => ipcRenderer.send('pet:move', [x, y]),
  open: (id) => ipcRenderer.send('pet:open', id),
});
