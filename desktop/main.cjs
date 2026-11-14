const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('node:path');
const net = require('node:net');
const Database = require('better-sqlite3');
const { SerialPort } = require('serialport');

let db;
let tcpSocket = null;
let serialDevice = null;
let mainWindow;

function openDatabase() {
  const dbPath = path.join(app.getPath('userData'), 'weighbridge.sqlite');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS weight_records (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const get = db.prepare('SELECT value FROM app_kv WHERE key = ?');
  const put = db.prepare(`INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`);
  ipcMain.on('local-store:get', (event, key) => { event.returnValue = get.get(String(key))?.value ?? null; });
  ipcMain.on('local-store:set', (event, key, value) => {
    put.run(String(key), String(value));
    if (String(key).includes('records')) {
      try {
        const rows = JSON.parse(String(value));
        const insert = db.prepare('INSERT OR REPLACE INTO weight_records(id,payload,created_at) VALUES(?,?,?)');
        const tx = db.transaction(items => {
          db.prepare('DELETE FROM weight_records').run();
          for (const item of items) insert.run(String(item.id), JSON.stringify(item), String(item.createdAt || new Date().toISOString()));
        });
        if (Array.isArray(rows)) tx(rows);
      } catch (error) { console.error('Record index update failed:', error); }
    }
    event.returnValue = true;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 980, minHeight: 680,
    backgroundColor: '#101820',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

ipcMain.handle('serial:list', async () => SerialPort.list());
ipcMain.handle('serial:open', async (_event, config) => {
  if (serialDevice?.isOpen) await new Promise(resolve => serialDevice.close(() => resolve()));
  const portPath = String(config?.path || '');
  if (!portPath) throw new Error('اختر منفذ COM أولاً.');
  const port = new SerialPort({
    path: portPath,
    baudRate: Number(config.baudRate),
    dataBits: Number(config.dataBits),
    stopBits: Number(config.stopBits),
    parity: String(config.parity),
    rtscts: config.flowControl === 'hardware',
    autoOpen: false
  });
  await new Promise((resolve, reject) => port.open(error => error ? reject(error) : resolve()));
  serialDevice = port;
  port.on('data', chunk => mainWindow?.webContents.send('serial:data', chunk.toString('utf8')));
  port.on('error', error => mainWindow?.webContents.send('serial:error', error.message));
  port.on('close', () => { mainWindow?.webContents.send('serial:closed'); if (serialDevice === port) serialDevice = null; });
  return { connected: true, path: portPath };
});
ipcMain.handle('serial:close', async () => {
  if (serialDevice?.isOpen) await new Promise(resolve => serialDevice.close(() => resolve()));
  serialDevice = null;
  return true;
});

ipcMain.handle('tcp:connect', async (_event, config) => {
  if (tcpSocket) { tcpSocket.destroy(); tcpSocket = null; }
  const host = String(config?.host || '').trim();
  const port = Number(config?.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('عنوان IP أو المنفذ غير صحيح.');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => socket.destroy(new Error('انتهت مهلة الاتصال')), 8000);
    socket.once('connect', () => { clearTimeout(timeout); tcpSocket = socket; resolve({ connected: true }); });
    socket.once('error', error => { clearTimeout(timeout); reject(error); });
    socket.on('data', chunk => mainWindow?.webContents.send('tcp:data', chunk.toString('utf8')));
    socket.on('close', () => { mainWindow?.webContents.send('tcp:closed'); if (tcpSocket === socket) tcpSocket = null; });
  });
});
ipcMain.handle('tcp:write', (_event, data) => {
  if (!tcpSocket || tcpSocket.destroyed) throw new Error('لا يوجد اتصال TCP نشط.');
  tcpSocket.write(String(data));
  return true;
});
ipcMain.handle('tcp:disconnect', () => { tcpSocket?.destroy(); tcpSocket = null; return true; });

app.whenReady().then(() => {
  openDatabase();
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'serial' || permission === 'hid');
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'serial' || permission === 'hid'));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => { tcpSocket?.destroy(); if (serialDevice?.isOpen) serialDevice.close(); db?.close(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
