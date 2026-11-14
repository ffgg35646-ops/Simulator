const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', {
  isDesktop: true,
  getItem: key => ipcRenderer.sendSync('local-store:get', key),
  setItem: (key, value) => ipcRenderer.sendSync('local-store:set', key, value),
  tcpConnect: config => ipcRenderer.invoke('tcp:connect', config),
  tcpWrite: data => ipcRenderer.invoke('tcp:write', data),
  tcpDisconnect: () => ipcRenderer.invoke('tcp:disconnect'),
  onTcpData: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('tcp:data', listener);
    return () => ipcRenderer.removeListener('tcp:data', listener);
  },
  onTcpClosed: callback => {
    const listener = () => callback();
    ipcRenderer.on('tcp:closed', listener);
    return () => ipcRenderer.removeListener('tcp:closed', listener);
  }
});
