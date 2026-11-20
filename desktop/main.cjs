const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const Database = require('better-sqlite3');
const { SerialPort } = require('serialport');
const XLSX = require('xlsx');

let db;
let tcpSocket = null;
let serialDevice = null;
let mainWindow;
let excelSyncState = { ok: false, path: '', count: 0, error: 'لم تتم المزامنة بعد' };
const RECORDS_KEY = 'weighbridge120t.records.v1';
const EXCEL_PATH_KEY = 'weighbridge120t.excelPath';

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
        if (Array.isArray(rows)) {
          tx(rows);
          if (String(key) === RECORDS_KEY) syncExcelRecords(rows);
        }
      } catch (error) { console.error('Record index update failed:', error); }
    }
    event.returnValue = true;
  });
}

function currentExcelPath() {
  const saved = db.prepare('SELECT value FROM app_kv WHERE key = ?').get(EXCEL_PATH_KEY)?.value;
  return saved || path.join(app.getPath('documents'), 'Weighbridge 120T', 'Weighbridge-120T-Records.xlsx');
}

function getStoredRecords() {
  try {
    const stored = db.prepare('SELECT value FROM app_kv WHERE key = ?').get(RECORDS_KEY)?.value;
    const parsed = JSON.parse(stored || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function makeExcelWorkbook(records) {
  const headers = [
    'رقم التذكرة', 'نوع الحركة', 'رقم السيارة', 'رقم المقطورة', 'اسم السائق', 'اسم العميل', 'اسم الشحنة', 'المحافظة',
    'قراءة الميزان الأصلية الأولى (كجم)', 'الوزن المعتمد الأول (كجم)', 'فرق تعديل الأولى (كجم)',
    'قراءة الميزان الأصلية الثانية (كجم)', 'الوزن المعتمد الثاني (كجم)', 'فرق تعديل الثانية (كجم)',
    'صافي الحمولة المعتمد (كجم)', 'مصدر الوزنة الأولى', 'مصدر الوزنة الثانية',
    'وقت الوزنة الأولى', 'وقت الوزنة الثانية', 'تاريخ إنشاء التذكرة'
  ];
  const detailHeaders = [
    'رقم التذكرة', 'نوع الحركة', 'رقم السيارة', 'رقم المقطورة', 'اسم السائق', 'اسم العميل', 'اسم الشحنة', 'المحافظة',
    'الوزنة', 'القراءة الأصلية (كجم)', 'الوزن المعتمد (كجم)', 'فرق التعديل (كجم)', 'مصدر الوزن', 'وقت التسجيل'
  ];
  const valueOf = (record, originalKey, approvedKey) => {
    if (Object.prototype.hasOwnProperty.call(record, originalKey)) return record[originalKey];
    return record[approvedKey] ?? null;
  };
  const original1 = r => valueOf(r, 'firstOriginalWeight', 'firstWeight');
  const original2 = r => valueOf(r, 'secondOriginalWeight', 'secondWeight');
  const adjustment = (original, approved) => original == null ? '—' : Number((Number(approved) - Number(original)).toFixed(2));
  const ticketRows = records.slice().reverse().map(r => {
    const firstRaw = original1(r);
    const secondRaw = original2(r);
    return [
      r.id || '', r.movementType || '—', r.plate || '', r.trailer || '—', r.driver || '', r.customer || '', r.shipment || '—', r.governorate || '—',
      firstRaw == null ? 'إدخال يدوي' : firstRaw, r.firstWeight ?? '', adjustment(firstRaw, r.firstWeight),
      secondRaw == null ? 'إدخال يدوي' : secondRaw, r.secondWeight ?? '', adjustment(secondRaw, r.secondWeight),
      r.netWeight ?? '', r.firstSource || r.source || '', r.secondSource || r.source || '',
      r.firstTime || '', r.secondTime || '', r.createdAt || ''
    ];
  });
  const detailRows = [];
  for (const r of records.slice().reverse()) {
    for (const item of [
      { label: 'الأولى', raw: original1(r), approved: r.firstWeight, source: r.firstSource || r.source, time: r.firstTime },
      { label: 'الثانية', raw: original2(r), approved: r.secondWeight, source: r.secondSource || r.source, time: r.secondTime }
    ]) {
      detailRows.push([
        r.id || '', r.movementType || '—', r.plate || '', r.trailer || '—', r.driver || '', r.customer || '', r.shipment || '—', r.governorate || '—',
        item.label, item.raw == null ? 'إدخال يدوي' : item.raw,
        item.approved ?? '', adjustment(item.raw, item.approved),
        item.source || '', item.time || ''
      ]);
    }
  }
  const tickets = XLSX.utils.aoa_to_sheet([headers, ...ticketRows]);
  tickets['!cols'] = [22,14,18,18,20,24,22,18,25,22,20,25,22,20,23,24,24,24,24,24].map(wch => ({ wch }));
  tickets['!autofilter'] = { ref: `A1:T${Math.max(1, ticketRows.length + 1)}` };
  const details = XLSX.utils.aoa_to_sheet([detailHeaders, ...detailRows]);
  details['!cols'] = [22,14,18,18,20,24,22,18,14,23,22,20,24,24].map(wch => ({ wch }));
  details['!autofilter'] = { ref: `A1:N${Math.max(1, detailRows.length + 1)}` };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, tickets, 'سجل الوزن');
  XLSX.utils.book_append_sheet(workbook, details, 'تفاصيل الوزنتين');
  return workbook;
}

function writeExcelFile(records, targetPath) {
  const destination = path.resolve(String(targetPath));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tempPath = `${destination}.${process.pid}.${Date.now()}.tmp.xlsx`;
  try {
    XLSX.writeFile(makeExcelWorkbook(records), tempPath);
    fs.copyFileSync(tempPath, destination);
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
  }
  return destination;
}

function syncExcelRecords(records) {
  try {
    const targetPath = writeExcelFile(Array.isArray(records) ? records : [], currentExcelPath());
    excelSyncState = { ok: true, path: targetPath, count: Array.isArray(records) ? records.length : 0, updatedAt: new Date().toISOString() };
  } catch (error) {
    excelSyncState = { ok: false, path: currentExcelPath(), count: Array.isArray(records) ? records.length : 0, error: error?.message || String(error) };
    console.error('Excel sync failed:', error);
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('excel:sync-status', excelSyncState);
  return { ...excelSyncState };
}

function saveExcelPath(targetPath) {
  db.prepare(`INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).run(EXCEL_PATH_KEY, targetPath);
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

ipcMain.handle('excel:status', () => ({ ...excelSyncState, path: currentExcelPath() }));
ipcMain.handle('excel:choose-file', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'اختيار ملف Excel المرتبط',
    buttonLabel: 'ربط ملف Excel',
    defaultPath: currentExcelPath(),
    filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const targetPath = result.filePath.toLowerCase().endsWith('.xlsx') ? result.filePath : result.filePath + '.xlsx';
  saveExcelPath(targetPath);
  return { canceled: false, ...syncExcelRecords(getStoredRecords()) };
});
ipcMain.handle('excel:open-file', async () => {
  const status = syncExcelRecords(getStoredRecords());
  if (!status.ok) throw new Error(status.error || 'تعذر تحديث ملف Excel.');
  const openError = await shell.openPath(status.path);
  if (openError) throw new Error(openError);
  return { path: status.path };
});
ipcMain.handle('excel:export', async (_event, rendererRecords, options = {}) => {
  const requestedName = String(options?.fileName || '').trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\.xlsx$/i, '');
  const defaultName = requestedName || 'Weighbridge-120T-Export-' + new Date().toISOString().slice(0,10);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'تصدير ملف Excel',
    buttonLabel: 'حفظ ملف Excel',
    defaultPath: path.join(app.getPath('documents'), defaultName + '.xlsx'),
    filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const targetPath = result.filePath.toLowerCase().endsWith('.xlsx') ? result.filePath : result.filePath + '.xlsx';
  const rows = Array.isArray(rendererRecords) ? rendererRecords : getStoredRecords();
  const savedPath = writeExcelFile(rows, targetPath);
  if (options?.openAfterExport) {
    const openError = await shell.openPath(savedPath);
    if (openError) throw new Error(openError);
  }
  return { canceled: false, ok: true, path: savedPath, count: rows.length };
});

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
  syncExcelRecords(getStoredRecords());
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'serial' || permission === 'hid');
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'serial' || permission === 'hid'));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => { tcpSocket?.destroy(); if (serialDevice?.isOpen) serialDevice.close(); db?.close(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
