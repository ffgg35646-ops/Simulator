'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

function deriveKey(sharedKey) {
  return crypto.createHash('sha256').update(String(sharedKey)).digest();
}

function seal(sharedKey, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(sharedKey), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}

function unseal(sharedKey, envelope) {
  if (!envelope || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.data !== 'string') {
    throw new Error('رسالة الاتصال المركزي غير صالحة.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(sharedKey), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function loadNetworkConfig(configPath) {
  const defaults = { mode: 'standalone', bindAddress: '0.0.0.0', port: 3210, serverUrl: '', sharedKey: '' };
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2) + '\n', 'utf8');
    return defaults;
  }

  let config;
  try {
    config = { ...defaults, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch {
    throw new Error('ملف إعداد الشبكة network.json غير صالح. أصلح صيغة JSON ثم أعد تشغيل البرنامج.');
  }

  if (!['standalone', 'host', 'client'].includes(config.mode)) {
    throw new Error('وضع الشبكة في network.json يجب أن يكون standalone أو host أو client.');
  }
  if (config.mode === 'host' || config.mode === 'client') {
    if (typeof config.sharedKey !== 'string' || config.sharedKey.length < 32) {
      throw new Error('مفتاح الشبكة sharedKey يجب أن يكون 32 حرفًا على الأقل، ويجب استخدام المفتاح نفسه على كل الأجهزة.');
    }
  }
  if (config.mode === 'host') {
    config.port = Number(config.port);
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new Error('منفذ الخادم المركزي غير صحيح.');
    }
    config.bindAddress = String(config.bindAddress || '0.0.0.0');
  }
  if (config.mode === 'client') {
    try {
      const url = new URL(String(config.serverUrl || ''));
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      config.serverUrl = url.origin;
    } catch {
      throw new Error('عنوان serverUrl في network.json غير صحيح. استخدم عنوان الخادم مثل http://192.168.1.20:3210.');
    }
  }
  return config;
}

async function createCentralAuthRequest(config, action, payload = {}, token = '') {
  const endpoint = String(config.serverUrl).replace(/\/+$/, '') + '/api/v1/auth';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(seal(config.sharedKey, { action, payload, token })),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('انتهت مهلة الاتصال بالخادم المركزي. تأكد أن جهاز المركز يعمل وأن الشبكة متصلة.');
    }
    throw new Error('تعذر الاتصال بالخادم المركزي. تأكد من عنوان IP والشبكة والسماح بالمنفذ 3210 في جدار الحماية.');
  } finally {
    clearTimeout(timeout);
  }

  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new Error('الخادم المركزي لم يُرجع استجابة صحيحة.');
  }
  let result;
  try {
    result = unseal(config.sharedKey, envelope);
  } catch {
    throw new Error('تعذر التحقق من اتصال الخادم المركزي. تأكد أن sharedKey متطابق على كل الأجهزة.');
  }
  if (!response.ok || !result.ok) throw new Error(result.error || 'تعذر تنفيذ الطلب على الخادم المركزي.');
  return result.data;
}

function startCentralAuthServer({ db, config }) {
  const sessions = new Map();
  const loginFailures = new Map();
  const passwordHash = (password, salt) => crypto.scryptSync(String(password), String(salt), 64).toString('hex');

  function publicUser(row) {
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

  function getAuthenticatedUser(token) {
    const session = sessions.get(String(token || ''));
    if (!session || session.expiresAt <= Date.now()) {
      if (token) sessions.delete(String(token));
      throw new Error('انتهت جلسة الدخول. سجّل الدخول مرة أخرى.');
    }
    const row = db.prepare('SELECT * FROM app_users WHERE id=?').get(session.userId);
    if (!row || row.is_active === 0) {
      sessions.delete(String(token));
      throw new Error('الحساب غير موجود أو موقوف. سجّل الدخول مرة أخرى.');
    }
    return row;
  }

  function requireSupervisor(row) {
    if (!row || row.role !== 'supervisor') throw new Error('هذه العملية متاحة للمشرف فقط.');
  }

  function dispatch(action, payload, token, remoteAddress) {
    if (action === 'status') return { configured: true, central: true };
    if (action === 'login') {
      const identifier = String(payload?.identifier || '').trim();
      const password = String(payload?.password || '');
      const attemptKey = remoteAddress + '|' + identifier.toLowerCase();
      const attempts = loginFailures.get(attemptKey);
      if (attempts && attempts.lockedUntil > Date.now()) {
        const seconds = Math.ceil((attempts.lockedUntil - Date.now()) / 1000);
        throw new Error('محاولات كثيرة غير صحيحة. حاول بعد ' + seconds + ' ثانية.');
      }

      let account = db.prepare('SELECT * FROM app_users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE').get(identifier, identifier);
      if (!account) {
        const matches = db.prepare('SELECT * FROM app_users WHERE display_name = ? COLLATE NOCASE LIMIT 2').all(identifier);
        if (matches.length === 1) account = matches[0];
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

      const sessionToken = crypto.randomBytes(32).toString('hex');
      sessions.set(sessionToken, { userId: account.id, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
      return { token: sessionToken, user: publicUser(account) };
    }

    if (action === 'logout') {
      sessions.delete(String(token || ''));
      return { success: true };
    }

    const account = getAuthenticatedUser(token);
    if (action === 'change-password') {
      const password = String(payload?.password || '');
      if (password.length < 3 || password.length > 128) throw new Error('كلمة المرور الجديدة يجب أن تكون من 3 إلى 128 حرفًا.');
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare('UPDATE app_users SET password_salt=?, password_hash=?, must_change_password=0 WHERE id=?')
        .run(salt, passwordHash(password, salt), account.id);
      return publicUser(db.prepare('SELECT * FROM app_users WHERE id=?').get(account.id));
    }

    if (action === 'update-account') {
      const displayName = String(payload?.displayName || '').trim();
      const password = String(payload?.password || '');
      if (displayName.length < 2 || displayName.length > 80) throw new Error('اكتب اسمًا صحيحًا من حرفين إلى 80 حرفًا.');
      if (password && password.length < 3) throw new Error('كلمة المرور الجديدة يجب ألا تقل عن 3 أحرف.');
      const conflicting = db.prepare('SELECT id FROM app_users WHERE id <> ? AND (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE) LIMIT 1')
        .get(account.id, displayName, displayName);
      if (conflicting) throw new Error('اسم الدخول الجديد مستخدم بالفعل. اختر اسمًا آخر.');
      if (password) {
        const salt = crypto.randomBytes(16).toString('hex');
        db.prepare('UPDATE app_users SET username=?, display_name=?, password_salt=?, password_hash=?, must_change_password=0 WHERE id=?')
          .run(displayName, displayName, salt, passwordHash(password, salt), account.id);
      } else {
        db.prepare('UPDATE app_users SET username=?, display_name=? WHERE id=?').run(displayName, displayName, account.id);
      }
      return publicUser(db.prepare('SELECT * FROM app_users WHERE id=?').get(account.id));
    }

    if (action === 'users') {
      requireSupervisor(account);
      return db.prepare("SELECT id,username,display_name,is_active,must_change_password FROM app_users WHERE role='operator' ORDER BY created_at,id")
        .all().map(row => ({
          id: row.id, username: row.username, displayName: row.display_name,
          isActive: Boolean(row.is_active), mustChangePassword: Boolean(row.must_change_password)
        }));
    }

    if (action === 'add-user') {
      requireSupervisor(account);
      const displayName = String(payload?.displayName || '').trim();
      const password = String(payload?.password || '');
      if (displayName.length < 2 || displayName.length > 80) throw new Error('الاسم يجب أن يكون من حرفين إلى 80 حرفًا.');
      if (password.length < 3 || password.length > 128) throw new Error('كلمة المرور يجب أن تكون من 3 إلى 128 حرفًا.');
      const existing = db.prepare('SELECT id FROM app_users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE OR display_name = ? COLLATE NOCASE')
        .get(displayName, displayName, displayName);
      if (existing) throw new Error('هذا الاسم مسجل بالفعل. اختر اسمًا آخر.');
      const id = crypto.randomUUID();
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare("INSERT INTO app_users(id,username,email,display_name,role,password_salt,password_hash,must_change_password) VALUES(?,?,NULL,?,'operator',?,?,0)")
        .run(id, displayName, displayName, salt, passwordHash(password, salt));
      return publicUser(db.prepare('SELECT * FROM app_users WHERE id=?').get(id));
    }

    if (action === 'reset-user-password') {
      requireSupervisor(account);
      const userId = String(payload?.userId || '');
      const password = String(payload?.password || '');
      if (password.length < 3 || password.length > 128) throw new Error('كلمة المرور يجب أن تكون من 3 إلى 128 حرفًا.');
      const target = db.prepare("SELECT id FROM app_users WHERE id=? AND role='operator'").get(userId);
      if (!target) throw new Error('المستخدم غير موجود.');
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare('UPDATE app_users SET password_salt=?, password_hash=?, must_change_password=0 WHERE id=?')
        .run(salt, passwordHash(password, salt), userId);
      return { success: true, mustChangePassword: false };
    }

    if (action === 'set-user-active') {
      requireSupervisor(account);
      const userId = String(payload?.userId || '');
      const active = Boolean(payload?.active);
      const result = db.prepare('UPDATE app_users SET is_active=? WHERE id=? AND role=?').run(active ? 1 : 0, userId, 'operator');
      if (!result.changes) throw new Error('المستخدم غير موجود.');
      return { success: true, isActive: active };
    }

    if (action === 'delete-user') {
      requireSupervisor(account);
      const userId = String(payload?.userId || '');
      if (!userId || userId === account.id) throw new Error('لا يمكن حذف هذا الحساب.');
      const result = db.prepare("DELETE FROM app_users WHERE id=? AND role='operator'").run(userId);
      if (!result.changes) throw new Error('المستخدم غير موجود.');
      return { success: true };
    }
    throw new Error('طلب غير معروف إلى الخادم المركزي.');
  }

  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/v1/auth') {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 256 * 1024) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      let requestData;
      try {
        requestData = unseal(config.sharedKey, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Invalid encrypted request' }));
        return;
      }
      try {
        const data = dispatch(
          String(requestData.action || ''),
          requestData.payload || {},
          String(requestData.token || ''),
          request.socket.remoteAddress || 'unknown'
        );
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(seal(config.sharedKey, { ok: true, data })));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(seal(config.sharedKey, { ok: false, error: error?.message || 'تعذر تنفيذ الطلب.' })));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bindAddress, () => {
      server.removeListener('error', reject);
      resolve({
        port: config.port,
        address: config.bindAddress,
        close: () => new Promise(done => server.close(done))
      });
    });
  });
}

module.exports = { loadNetworkConfig, startCentralAuthServer, createCentralAuthRequest };
