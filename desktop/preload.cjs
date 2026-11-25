const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', {
  isDesktop: true,
  getAuthStatus: () => ipcRenderer.invoke('auth:status'),
  login: input => ipcRenderer.invoke('auth:login', input),
  changePassword: input => ipcRenderer.invoke('auth:change-password', input),
  updateAccount: input => ipcRenderer.invoke('auth:update-account', input),
  listUsers: () => ipcRenderer.invoke('auth:users'),
  addSupervisorRecord: record => ipcRenderer.invoke('tickets:add-supervisor-record', record),
  updateSupervisorRecord: (recordId, record) => ipcRenderer.invoke('tickets:update-supervisor-record', recordId, record),
  logout: () => ipcRenderer.invoke('auth:logout'),
  nextTicketId: () => ipcRenderer.sendSync('tickets:next-id'),
  getItem: key => ipcRenderer.sendSync('local-store:get', key),
  setItem: (key, value) => ipcRenderer.sendSync('local-store:set', key, value),
  getExcelStatus: () => ipcRenderer.invoke('excel:status'),
  chooseExcelFile: () => ipcRenderer.invoke('excel:choose-file'),
  openExcelFile: () => ipcRenderer.invoke('excel:open-file'),
  exportExcel: (records, options) => ipcRenderer.invoke('excel:export', records, options),
  onExcelSyncStatus: callback => { const listener = (_event, status) => callback(status); ipcRenderer.on('excel:sync-status', listener); return () => ipcRenderer.removeListener('excel:sync-status', listener); },
  listSerialPorts: () => ipcRenderer.invoke('serial:list'),
  openSerialPort: config => ipcRenderer.invoke('serial:open', config),
  closeSerialPort: () => ipcRenderer.invoke('serial:close'),
  onSerialData: callback => { const listener = (_event, data) => callback(data); ipcRenderer.on('serial:data', listener); return () => ipcRenderer.removeListener('serial:data', listener); },
  onSerialError: callback => { const listener = (_event, error) => callback(error); ipcRenderer.on('serial:error', listener); return () => ipcRenderer.removeListener('serial:error', listener); },
  onSerialClosed: callback => { const listener = () => callback(); ipcRenderer.on('serial:closed', listener); return () => ipcRenderer.removeListener('serial:closed', listener); },
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
