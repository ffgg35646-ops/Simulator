const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');
const Database = require('better-sqlite3');
const { SerialPort } = require('serialport');
const XLSX = require('xlsx');
const { checkTrialLicense } = require('./license.cjs');

let db;
let authSession = null;
const loginFailures = new Map();
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
    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      username TEXT COLLATE NOCASE UNIQUE,
      email TEXT COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('operator','supervisor')),
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const userColumns = db.prepare('PRAGMA table_info(app_users)').all();
  if (!userColumns.some(column => column.name === 'must_change_password')) {
    db.exec('ALTER TABLE app_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  }
  if (!userColumns.some(column => column.name === 'is_active')) {
    db.exec('ALTER TABLE app_users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
  }
  const get = db.prepare('SELECT value FROM app_kv WHERE key = ?');
  const put = db.prepare(`INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`);
  ipcMain.on('local-store:get', (event, key) => {
    const storeKey = String(key);
    if (storeKey === RECORDS_KEY) {
      if (!authSession) { event.returnValue = '[]'; return; }
      const all = getStoredRecords();
      const visible = authSession.role === 'supervisor'
        ? all
        : all.filter(record => record.createdByUserId === authSession.id);
      event.returnValue = JSON.stringify(visible);
      return;
    }
    event.returnValue = get.get(storeKey)?.value ?? null;
  });
  ipcMain.on('local-store:set', (event, key, value) => {
    const storeKey = String(key);
    if (storeKey === RECORDS_KEY) {
      if (!authSession || authSession.role !== 'operator') { event.returnValue = false; return; }
      try {
        const requested = JSON.parse(String(value));
        if (!Array.isArray(requested)) { event.returnValue = false; return; }
        const ownRows = requested.map(item => ({
          ...item,
          createdByUserId: authSession.id,
          createdByUserName: authSession.displayName,
          createdByUsername: authSession.username
        }));
        const allRows = getStoredRecords();
        const otherRows = allRows.filter(item => item.createdByUserId !== authSession.id);
        const merged = [...ownRows, ...otherRows].sort((a, b) =>
          new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
        );
        put.run(RECORDS_KEY, JSON.stringify(merged));
        const insert = db.prepare('INSERT OR REPLACE INTO weight_records(id,payload,created_at) VALUES(?,?,?)');
        const tx = db.transaction(items => {
          db.prepare('DELETE FROM weight_records').run();
          for (const item of items) insert.run(String(item.id), JSON.stringify(item), String(item.createdAt || new Date().toISOString()));
        });
        tx(merged);
        syncExcelRecords(merged);
        event.returnValue = true;
      } catch (error) {
        console.error('Record save failed:', error);
        event.returnValue = false;
      }
      return;
    }
    put.run(storeKey, String(value));
    event.returnValue = true;
  });
  ipcMain.on('tickets:next-id', event => {
    if (!authSession || authSession.role !== 'operator') { event.returnValue = null; return; }
    const existing = new Set(getStoredRecords().map(record => String(record.id)));
    let candidate = '';
    for (let attempt = 0; attempt < 20000; attempt++) {
      candidate = String(crypto.randomInt(100, 10000));
      if (!existing.has(candidate)) break;
      candidate = '';
    }
    event.returnValue = candidate || String(Date.now()).slice(-4);
  });
}

function passwordHash(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username || '',
    email: row.email || '',
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: Boolean(row.must_change_password),
    isActive: row.is_active === undefined ? true : Boolean(row.is_active)
  };
}

function seedDefaultAccounts() {
  const definitions = [
    ...Array.from({ length: 10 }, (_, index) => ({
      username: 'user' + (index + 1),
      displayName: 'المستخدم ' + (index + 1),
      role: 'operator',
      password: 'User@12345'
    })),
    { email: 'admin@weighbridge.com', displayName: 'مشرف النظام', role: 'supervisor', password: 'Admin@12345' },
    { username: 'محمد صلاح', displayName: 'محمد صلاح', role: 'operator', password: '1966', mustChangePassword: false },
    { username: 'مصطفى', displayName: 'مصطفى', role: 'supervisor', password: '1980', mustChangePassword: false },
    { username: 'محمد حسين', displayName: 'محمد حسين', role: 'operator', password: '1988', mustChangePassword: false }
  ];

  // Migrate only untouched built-in accounts from earlier app versions.
  // Accounts whose owners already changed their passwords are never overwritten.
  const legacyDefaults = [
    { oldIdentifier: 'scale01', next: definitions[0] },
    { oldIdentifier: 'scale02', next: definitions[1] },
    { oldIdentifier: 'supervisor@weighbridge.local', next: definitions[2] }
  ];
  for (const legacy of legacyDefaults) {
    const row = db.prepare('SELECT * FROM app_users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE')
      .get(legacy.oldIdentifier, legacy.oldIdentifier);
    if (!row || !row.must_change_password) continue;
    const salt = crypto.randomBytes(16).toString('hex');
    const next = legacy.next;
    db.prepare('UPDATE app_users SET username=?, email=?, display_name=?, role=?, password_salt=?, password_hash=?, must_change_password=1 WHERE id=?')
      .run(next.username || null, next.email || null, next.displayName, next.role, salt, passwordHash(next.password, salt), row.id);
  }

  if (db.prepare('SELECT COUNT(*) AS count FROM app_users').get().count > 0) {
    const insertMissing = db.prepare('INSERT INTO app_users(id,username,email,display_name,role,password_salt,password_hash,must_change_password) VALUES(?,?,?,?,?,?,?,?)');
    for (const definition of definitions) {
      const identifier = definition.username || definition.email;
      const existing = db.prepare('SELECT id FROM app_users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE').get(identifier, identifier);
      if (existing) continue;
      const salt = crypto.randomBytes(16).toString('hex');
      insertMissing.run(crypto.randomUUID(), definition.username || null, definition.email || null, definition.displayName, definition.role, salt, passwordHash(definition.password, salt), definition.mustChangePassword === false ? 0 : 1);
    }
    return true;
  }
  const accounts = definitions.map(definition => {
    const salt = crypto.randomBytes(16).toString('hex');
    return {
      id: crypto.randomUUID(),
      username: definition.username || null,
      email: definition.email || null,
      display_name: definition.displayName,
      role: definition.role,
      password_salt: salt,
      password_hash: passwordHash(definition.password, salt),
      must_change_password: definition.mustChangePassword === false ? 0 : 1
    };
  });

  const oldRecords = getStoredRecords();
  const migrated = oldRecords.map(record => record.createdByUserId ? record : ({
    ...record,
    createdByUserId: accounts[0].id,
    createdByUserName: accounts[0].display_name,
    createdByUsername: accounts[0].username,
    importedBeforeLogin: true
  }));
  const insertAccount = db.prepare('INSERT INTO app_users(id,username,email,display_name,role,password_salt,password_hash,must_change_password) VALUES(?,?,?,?,?,?,?,?)');
  const saveRecords = db.prepare(`INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`);
  const insertRecord = db.prepare('INSERT OR REPLACE INTO weight_records(id,payload,created_at) VALUES(?,?,?)');
  const tx = db.transaction(() => {
    for (const account of accounts) {
      insertAccount.run(account.id, account.username, account.email, account.display_name, account.role, account.password_salt, account.password_hash, account.must_change_password);
    }
    saveRecords.run(RECORDS_KEY, JSON.stringify(migrated));
    db.prepare('DELETE FROM weight_records').run();
    for (const record of migrated) insertRecord.run(String(record.id), JSON.stringify(record), String(record.createdAt || new Date().toISOString()));
  });
  tx();
  syncExcelRecords(migrated);
  return true;
}

function registerAuthHandlers() {
  ipcMain.handle('auth:status', async () => {
    authSession = null;
    if (serialDevice?.isOpen) {
      await new Promise(resolve => serialDevice.close(() => resolve()));
      serialDevice = null;
    }
    if (tcpSocket) { tcpSocket.destroy(); tcpSocket = null; }
    return { configured: true };
  });

  ipcMain.handle('auth:setup', (_event, input = {}) => {
    const accountCount = db.prepare('SELECT COUNT(*) AS count FROM app_users').get().count;
    if (accountCount > 0) throw new Error('تم إعداد الحسابات بالفعل. سجّل الدخول.');
    const user1 = {
      username: String(input.user1?.username || '').trim(),
      displayName: String(input.user1?.displayName || '').trim() || 'المستخدم الأول',
      password: String(input.user1?.password || '')
    };
    const user2 = {
      username: String(input.user2?.username || '').trim(),
      displayName: String(input.user2?.displayName || '').trim() || 'المستخدم الثاني',
      password: String(input.user2?.password || '')
    };
    const supervisor = {
      email: String(input.supervisor?.email || '').trim().toLowerCase(),
      displayName: String(input.supervisor?.displayName || '').trim() || 'المشرف',
      password: String(input.supervisor?.password || '')
    };
    if (user1.username.length < 3 || user2.username.length < 3) throw new Error('اسم المستخدم يجب أن يتكون من 3 أحرف على الأقل.');
    if (user1.password.length < 3 || user2.password.length < 3 || supervisor.password.length < 3) throw new Error('كل كلمة مرور يجب أن تكون 3 أحرف على الأقل.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supervisor.email)) throw new Error('أدخل بريدًا إلكترونيًا صحيحًا للمشرف.');
    const identifiers = [user1.username.toLowerCase(), user2.username.toLowerCase(), supervisor.email];
    if (new Set(identifiers).size !== identifiers.length) throw new Error('أسماء المستخدمين والبريد الإلكتروني يجب أن تكون مختلفة.');
    const createAccount = (account, role) => {
      const salt = crypto.randomBytes(16).toString('hex');
      return {
        id: crypto.randomUUID(),
        username: account.username || null,
        email: account.email || null,
        display_name: account.displayName,
        role,
        password_salt: salt,
        password_hash: passwordHash(account.password, salt)
      };
    };
    const accounts = [
      createAccount(user1, 'operator'),
      createAccount(user2, 'operator'),
      createAccount(supervisor, 'supervisor')
    ];
    const oldRecords = getStoredRecords();
    const migrated = oldRecords.map(record => record.createdByUserId ? record : ({
      ...record,
      createdByUserId: accounts[0].id,
      createdByUserName: accounts[0].display_name,
      createdByUsername: accounts[0].username,
      importedBeforeLogin: true
    }));
    const insertAccount = db.prepare('INSERT INTO app_users(id,username,email,display_name,role,password_salt,password_hash) VALUES(?,?,?,?,?,?,?)');
    const saveRecords = db.prepare(`INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`);
    const insertRecord = db.prepare('INSERT OR REPLACE INTO weight_records(id,payload,created_at) VALUES(?,?,?)');
    const tx = db.transaction(() => {
      for (const account of accounts) {
        insertAccount.run(account.id, account.username, account.email, account.display_name, account.role, account.password_salt, account.password_hash);
      }
      saveRecords.run(RECORDS_KEY, JSON.stringify(migrated));
      db.prepare('DELETE FROM weight_records').run();
      for (const record of migrated) insertRecord.run(String(record.id), JSON.stringify(record), String(record.createdAt || new Date().toISOString()));
    });
    tx();
    syncExcelRecords(migrated);
    return { configured: true, accountsCreated: 3 };
  });

  ipcMain.handle('auth:login', (_event, input = {}) => {
    const identifier = String(input.identifier || '').trim();
    const password = String(input.password || '');
    const attemptKey = identifier.toLowerCase();
    const attempts = loginFailures.get(attemptKey);
    if (attempts && attempts.lockedUntil > Date.now()) {
      const seconds = Math.ceil((attempts.lockedUntil - Date.now()) / 1000);
      throw new Error('محاولات كثيرة غير صحيحة. حاول بعد ' + seconds + ' ثانية.');
    }
    let account = db.prepare('SELECT * FROM app_users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE').get(identifier, identifier);
    if (!account) {
      // Backward compatibility: older versions changed display_name but left username untouched.
      // Accept a display name for login only when it resolves to exactly one account.
      const displayNameMatches = db.prepare('SELECT * FROM app_users WHERE display_name = ? COLLATE NOCASE LIMIT 2').all(identifier);
      if (displayNameMatches.length === 1) account = displayNameMatches[0];
    }
    const supplied = passwordHash(password, account?.password_salt || 'unknown-account-salt');
    const expected = account?.password_hash || '0'.repeat(128);
    const valid = Boolean(account) && crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'));
    if (!valid) {
      const next = { count: (attempts?.count || 0) + 1, lockedUntil: 0 };
      if (next.count >= 5) { next.count = 0; next.lockedUntil = Date.now() + 60000; }
      loginFailures.set(attemptKey, next);
      throw new Error('بياناتك غلط. راجع اسم المستخدم وكلمة المرور.');
    }
    if (account.is_active === 0) throw new Error('هذا الحساب موقوف. راجع المشرف.');
    loginFailures.delete(attemptKey);
    authSession = publicUser(account);
    return authSession;
  });

  ipcMain.handle('auth:change-password', (_event, input = {}) => {
    if (!authSession) throw new Error('سجّل الدخول أولًا.');
    const password = String(input.password || '');
    if (password.length < 3) throw new Error('كلمة المرور الجديدة يجب ألا تقل عن 3 أحرف.');
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE app_users SET password_salt=?, password_hash=?, must_change_password=0 WHERE id=?')
      .run(salt, passwordHash(password, salt), authSession.id);
    const row = db.prepare('SELECT * FROM app_users WHERE id=?').get(authSession.id);
    authSession = publicUser(row);
    return authSession;
  });

  ipcMain.handle('auth:update-account', (_event, input = {}) => {
    if (!authSession) throw new Error('سجّل الدخول أولًا.');
    const displayName = String(input.displayName || '').trim();
    const password = String(input.password || '');
    if (displayName.length < 2 || displayName.length > 80) throw new Error('اكتب اسمًا صحيحًا من حرفين إلى 80 حرفًا.');
    if (password && password.length < 3) throw new Error('كلمة المرور الجديدة يجب ألا تقل عن 3 أحرف.');

    // The editable account name is also the login username. Keep the email
    // untouched as an additional sign-in option, and reject another account's identifier.
    const conflictingAccount = db.prepare(`
      SELECT id FROM app_users
      WHERE id <> ?
        AND (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE)
      LIMIT 1
    `).get(authSession.id, displayName, displayName);
    if (conflictingAccount) throw new Error('اسم الدخول الجديد مستخدم بالفعل. اختر اسمًا آخر.');

    if (password) {
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare('UPDATE app_users SET username=?, display_name=?, password_salt=?, password_hash=?, must_change_password=0 WHERE id=?')
        .run(displayName, displayName, salt, passwordHash(password, salt), authSession.id);
    } else {
      db.prepare('UPDATE app_users SET username=?, display_name=? WHERE id=?')
        .run(displayName, displayName, authSession.id);
    }
    const row = db.prepare('SELECT * FROM app_users WHERE id=?').get(authSession.id);
    authSession = publicUser(row);
    return authSession;
  });

  ipcMain.handle('auth:users', () => {
    if (!authSession || authSession.role !== 'supervisor') throw new Error('هذه القائمة متاحة للمشرف فقط.');
    return db.prepare("SELECT id,username,display_name,is_active,must_change_password FROM app_users WHERE role='operator' ORDER BY created_at,id")
      .all().map(row => ({ id: row.id, username: row.username, displayName: row.display_name, isActive: Boolean(row.is_active), mustChangePassword: Boolean(row.must_change_password) }));
  });

  ipcMain.handle('auth:add-user', (_event, input = {}) => {
    if (!authSession || authSession.role !== 'supervisor') throw new Error('إضافة المستخدمين متاحة للمشرف فقط.');

    const displayName = String(input.displayName || '').trim();
    const username = displayName;
    const password = String(input.password || '');

    if (displayName.length < 2 || displayName.length > 80) {
      throw new Error('الاسم يجب أن يكون من حرفين إلى 80 حرفًا.');
    }
    if (password.length < 3 || password.length > 128) {
      throw new Error('كلمة المرور يجب أن تكون من 3 إلى 128 حرفًا.');
    }

    const existing = db.prepare('SELECT id FROM app_users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE OR display_name = ? COLLATE NOCASE')
      .get(username, username, displayName);
    if (existing) throw new Error('هذا الاسم مسجل بالفعل. اختر اسمًا آخر.');

    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare(`INSERT INTO app_users(id,username,email,display_name,role,password_salt,password_hash,must_change_password)
      VALUES(?,?,NULL,?,'operator',?,?,0)`)
      .run(id, username, displayName, salt, passwordHash(password, salt));

    const created = db.prepare('SELECT * FROM app_users WHERE id=?').get(id);
    return publicUser(created);
  });


  ipcMain.handle('auth:reset-user-password', (_event, input = {}) => {
    if (!authSession || authSession.role !== 'supervisor') throw new Error('تغيير كلمات مرور المستخدمين متاح للمشرف فقط.');
    const userId = String(input.userId || '');
    const password = String(input.password || '');
    if (password.length < 3 || password.length > 128) throw new Error('كلمة المرور يجب أن تكون من 3 إلى 128 حرفًا.');
    const target = db.prepare("SELECT id FROM app_users WHERE id=? AND role='operator'").get(userId);
    if (!target) throw new Error('المستخدم غير موجود.');
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE app_users SET password_salt=?, password_hash=?, must_change_password=0 WHERE id=?')
      .run(salt, passwordHash(password, salt), userId);
    return { success: true, mustChangePassword: false };
  });

  ipcMain.handle('auth:set-user-active', (_event, input = {}) => {
    if (!authSession || authSession.role !== 'supervisor') throw new Error('إدارة حالة المستخدمين متاحة للمشرف فقط.');
    const userId = String(input.userId || '');
    const active = Boolean(input.active);
    const result = db.prepare("UPDATE app_users SET is_active=? WHERE id=? AND role='operator'").run(active ? 1 : 0, userId);
    if (!result.changes) throw new Error('المستخدم غير موجود.');
    return { success: true, isActive: active };
  });

  ipcMain.handle('auth:delete-user', (_event, input = {}) => {
    if (!authSession || authSession.role !== 'supervisor') throw new Error('حذف المستخدمين متاح للمشرف فقط.');
    const userId = String(input.userId || '');
    if (!userId || userId === authSession.id) throw new Error('لا يمكن حذف هذا الحساب.');
    const result = db.prepare("DELETE FROM app_users WHERE id=? AND role='operator'").run(userId);
    if (!result.changes) throw new Error('المستخدم غير موجود.');
    return { success: true };
  });

  ipcMain.handle('tickets:add-supervisor-record', (_event, input = {}) => {
    if (!authSession || authSession.role !== 'supervisor') throw new Error('إضافة العمليات اليدوية متاحة للمشرف فقط.');
    const id = String(input.id || '').trim();
    const plate = String(input.plate || '').trim();
    const createdAt = String(input.createdAt || '');
    const firstWeight = Number(input.firstWeight);
    const secondWeight = Number(input.secondWeight);
    if (!id || !plate) throw new Error('بيانات التذكرة غير مكتملة.');
    if (!Number.isFinite(Date.parse(createdAt))) throw new Error('تاريخ ووقت العملية غير صحيحين.');
    if (![firstWeight, secondWeight].every(value => Number.isFinite(value) && value >= 0 && value <= 500000)) {
      throw new Error('قيم الوزن يجب أن تكون من 0 إلى 500,000 كجم.');
    }
    const allRecords = getStoredRecords();
    if (allRecords.some(record => String(record.id) === id)) throw new Error('رقم التذكرة مستخدم بالفعل. حاول الحفظ مرة أخرى.');
    const acceptedFirstWeight = Math.round(firstWeight * 100) / 100;
    const acceptedSecondWeight = Math.round(secondWeight * 100) / 100;
    const record = {
      ...input,
      id,
      plate,
      firstWeight: acceptedFirstWeight,
      secondWeight: acceptedSecondWeight,
      netWeight: Math.round(Math.abs(acceptedFirstWeight - acceptedSecondWeight) * 100) / 100,
      firstTime: createdAt,
      secondTime: createdAt,
      createdAt,
      createdByUserId: authSession.id,
      createdByUserName: authSession.displayName,
      createdByUsername: authSession.username || authSession.email || '',
      firstSource: 'manual',
      secondSource: 'manual',
      firstAdjusted: false,
      secondAdjusted: false,
      source: 'إضافة المشرف'
    };
    allRecords.push(record);
    allRecords.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    const saveRecords = db.prepare(`INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`);
    const insertRecord = db.prepare('INSERT OR REPLACE INTO weight_records(id,payload,created_at) VALUES(?,?,?)');
    const tx = db.transaction(rows => {
      saveRecords.run(RECORDS_KEY, JSON.stringify(rows));
      db.prepare('DELETE FROM weight_records').run();
      for (const item of rows) insertRecord.run(String(item.id), JSON.stringify(item), String(item.createdAt || new Date().toISOString()));
    });
    tx(allRecords);
    syncExcelRecords(allRecords);
    return record;
  });

  ipcMain.handle('tickets:update-supervisor-record', (_event, recordId, input = {}) => {
    if (!authSession || authSession.role !== 'supervisor') throw new Error('تعديل السجلات متاح للمشرف فقط.');
    const id = String(recordId || '').trim();
    const plate = String(input.plate || '').trim();
    const createdAt = String(input.createdAt || '');
    const firstWeight = Number(input.firstWeight);
    const secondWeight = Number(input.secondWeight);
    if (!id || !plate) throw new Error('رقم السجل ورقم السيارة مطلوبان.');
    if (!Number.isFinite(Date.parse(createdAt))) throw new Error('تاريخ ووقت العملية غير صحيحين.');
    if (![firstWeight, secondWeight].every(value => Number.isFinite(value) && value >= 0 && value <= 500000)) {
      throw new Error('قيم الوزن يجب أن تكون من 0 إلى 500,000 كجم.');
    }
    const allRecords = getStoredRecords();
    const existingIndex = allRecords.findIndex(record => String(record.id) === id);
    if (existingIndex < 0) throw new Error('السجل المطلوب تعديله غير موجود.');
    const existing = allRecords[existingIndex];
    const acceptedFirstWeight = Math.round(firstWeight * 100) / 100;
    const acceptedSecondWeight = Math.round(secondWeight * 100) / 100;
    const firstChanged = Number(existing.firstWeight) !== acceptedFirstWeight;
    const secondChanged = Number(existing.secondWeight) !== acceptedSecondWeight;
    const updatedRecord = {
      ...existing,
      plate: plate.slice(0, 80),
      trailer: String(input.trailer || '—').trim().slice(0, 80) || '—',
      driver: String(input.driver || '—').trim().slice(0, 120) || '—',
      customer: String(input.customer || '—').trim().slice(0, 120) || '—',
      customerType: ['customer', 'company'].includes(String(input.customerType || '')) ? String(input.customerType) : existing.customerType || 'customer',
      shipment: String(input.shipment || '—').trim().slice(0, 160) || '—',
      governorate: String(input.governorate || '—').trim().slice(0, 80) || '—',
      movementType: ['وارد', 'صادر'].includes(String(input.movementType || '')) ? String(input.movementType) : existing.movementType || 'وارد',
      firstWeight: acceptedFirstWeight,
      secondWeight: acceptedSecondWeight,
      firstOriginalWeight: firstChanged
        ? (existing.firstOriginalWeight ?? existing.firstWeight)
        : (existing.firstOriginalWeight ?? null),
      secondOriginalWeight: secondChanged
        ? (existing.secondOriginalWeight ?? existing.secondWeight)
        : (existing.secondOriginalWeight ?? null),
      firstAdjusted: Boolean(existing.firstAdjusted || firstChanged),
      secondAdjusted: Boolean(existing.secondAdjusted || secondChanged),
      netWeight: Math.round(Math.abs(acceptedFirstWeight - acceptedSecondWeight) * 100) / 100,
      firstTime: createdAt,
      secondTime: createdAt,
      createdAt,
      updatedAt: new Date().toISOString(),
      lastEditedByUserId: authSession.id,
      lastEditedByUserName: authSession.displayName
    };
    const updatedRows = allRecords.map((record, index) => index === existingIndex ? updatedRecord : record)
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    const saveRecords = db.prepare(`INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`);
    const insertRecord = db.prepare('INSERT OR REPLACE INTO weight_records(id,payload,created_at) VALUES(?,?,?)');
    const tx = db.transaction(rows => {
      saveRecords.run(RECORDS_KEY, JSON.stringify(rows));
      db.prepare('DELETE FROM weight_records').run();
      for (const item of rows) insertRecord.run(String(item.id), JSON.stringify(item), String(item.createdAt || new Date().toISOString()));
    });
    tx(updatedRows);
    const excelSync = syncExcelRecords(updatedRows);
    return { record: updatedRecord, excelSync };
  });

  ipcMain.handle('auth:logout', async () => {
    authSession = null;
    if (serialDevice?.isOpen) {
      await new Promise(resolve => serialDevice.close(() => resolve()));
      serialDevice = null;
    }
    if (tcpSocket) { tcpSocket.destroy(); tcpSocket = null; }
    return true;
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
    'السيارة', 'المقطورة', 'الوزنة الأولى', 'الوزنة الثانية',
    'الصافي', 'التاريخ', 'صادر / وارد'
  ];
  const rows = records.slice().reverse().map(record => {
    const date = record.createdAt ? new Date(record.createdAt) : null;
    const operationDate = date && !Number.isNaN(date.getTime())
      ? date.toLocaleString('ar-EG')
      : '—';
    return [
      record.plate || '—',
      record.trailer || '—',
      record.firstWeight ?? '',
      record.secondWeight ?? '',
      record.netWeight ?? '',
      operationDate,
      record.movementType || '—'
    ];
  });
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  sheet['!cols'] = [20, 20, 17, 17, 17, 25, 17].map(wch => ({ wch }));
  sheet['!autofilter'] = { ref: `A1:G${Math.max(1, rows.length + 1)}` };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'قاعدة البيانات');
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    const visibleStatus = authSession?.role === 'supervisor'
      ? excelSyncState
      : { ...excelSyncState, path: '', count: getStoredRecords().filter(record => record.createdByUserId === authSession?.id).length };
    mainWindow.webContents.send('excel:sync-status', visibleStatus);
  }
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

ipcMain.handle('excel:status', () => {
  if (!authSession) throw new Error('سجّل الدخول أولًا.');
  if (authSession.role !== 'supervisor') {
    return { ok: excelSyncState.ok, path: '', count: getStoredRecords().filter(record => record.createdByUserId === authSession.id).length };
  }
  return { ...excelSyncState, path: currentExcelPath() };
});
ipcMain.handle('excel:choose-file', async () => {
  if (!authSession || authSession.role !== 'supervisor') throw new Error('تغيير ملف Excel متاح للمشرف فقط.');
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
  if (!authSession || authSession.role !== 'supervisor') throw new Error('فتح ملف Excel الشامل متاح للمشرف فقط.');
  const status = syncExcelRecords(getStoredRecords());
  if (!status.ok) throw new Error(status.error || 'تعذر تحديث ملف Excel.');
  const openError = await shell.openPath(status.path);
  if (openError) throw new Error(openError);
  return { path: status.path };
});
ipcMain.handle('excel:export', async (_event, rendererRecords, options = {}) => {
  if (!authSession) throw new Error('سجّل الدخول أولًا.');
  const allRecords = getStoredRecords();
  const allowedRecords = authSession.role === 'supervisor'
    ? allRecords
    : allRecords.filter(record => record.createdByUserId === authSession.id);
  const requestedIds = Array.isArray(rendererRecords) && rendererRecords.length
    ? new Set(rendererRecords.map(record => String(record.id)))
    : null;
  const safeRecords = requestedIds ? allowedRecords.filter(record => requestedIds.has(String(record.id))) : allowedRecords;
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
  const rows = safeRecords;
  if (!rows.length) throw new Error('لا توجد سجلات مسموح بتصديرها لهذا الحساب.');
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
  port.on('data', chunk => mainWindow?.webContents.send('serial:data', { text: chunk.toString('utf8'), hex: chunk.toString('hex'), base64: chunk.toString('base64'), byteLength: chunk.length }));
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
  const license = checkTrialLicense(app.getPath('appData'));
  if (!license.allowed) {
    dialog.showErrorBox(
      'ترخيص البرنامج مطلوب',
      'انتهت صلاحية هذه النسخة التجريبية أو تعذر التحقق من صلاحيتها.\n\nلابد من ترخيص البرنامج لمتابعة الاستخدام.'
    );
    app.quit();
    return;
  }

  openDatabase();
  seedDefaultAccounts();
  // Operator accounts use the password assigned by the supervisor immediately; no forced first-login reset.
  db.prepare("UPDATE app_users SET must_change_password=0 WHERE role='operator' AND must_change_password<>0").run();
  registerAuthHandlers();

  // Avoid rebuilding the entire Excel workbook before the window appears.
  const initialRecords = getStoredRecords();
  const linkedExcelPath = currentExcelPath();
  if (fs.existsSync(linkedExcelPath)) {
    let updatedAt;
    try { updatedAt = fs.statSync(linkedExcelPath).mtime.toISOString(); } catch {}
    excelSyncState = { ok: true, path: linkedExcelPath, count: initialRecords.length, updatedAt };
  } else {
    excelSyncState = {
      ok: initialRecords.length === 0,
      path: linkedExcelPath,
      count: initialRecords.length,
      ...(initialRecords.length ? { error: 'سيتم إنشاء ملف Excel بعد فتح البرنامج.' } : {})
    };
  }

  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'serial' || permission === 'hid');
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'serial' || permission === 'hid'));
  createWindow();

  if (initialRecords.length && !fs.existsSync(linkedExcelPath)) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => syncExcelRecords(initialRecords), 350);
    });
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => { tcpSocket?.destroy(); if (serialDevice?.isOpen) serialDevice.close(); db?.close(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
