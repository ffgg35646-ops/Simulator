const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// تاريخ إصدار هذه النسخة: 21 نوفمبر 2026.
const RELEASED_AT = Date.parse('2026-11-21T14:55:00Z');
const TRIAL_DAYS = 15;
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
const STATE_FILE = '.weighbridge120t-license.json';

// هذه البصمة مخصصة لمنع إعادة استخدام ملف الحالة على جهاز آخر.
function getMachineFingerprint() {
  let machineId = '';
  if (process.platform === 'win32') {
    try {
      const output = execFileSync('reg', [
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
        '/v',
        'MachineGuid'
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      machineId = output.match(/MachineGuid\s+REG_SZ\s+(.+)/i)?.[1]?.trim() || '';
    } catch {}
  }
  const source = [machineId, os.hostname(), process.platform, os.arch()].join('|');
  return crypto.createHash('sha256').update(source).digest('hex');
}

function signState(state, machine) {
  // توقيع محلي لاكتشاف العبث العرضي أو التعديل البسيط للملف.
  const payload = [machine, state.firstSeen, state.lastSeen].join('|');
  return crypto.createHash('sha256').update('WB120T-local-state-v1|' + payload).digest('hex');
}

function writeState(filePath, state, machine) {
  const complete = { ...state, machine, signature: signState(state, machine) };
  const tempPath = filePath + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(complete), { encoding: 'utf8' });
  fs.renameSync(tempPath, filePath);
}

function checkTrialLicense(appDataPath) {
  const now = Date.now();
  const expiresAt = RELEASED_AT + TRIAL_DAYS * 24 * 60 * 60 * 1000;
  const machine = getMachineFingerprint();
  const filePath = path.join(appDataPath, STATE_FILE);

  if (now >= expiresAt || now < RELEASED_AT) {
    return { allowed: false, reason: 'expired' };
  }

  let state;
  if (fs.existsSync(filePath)) {
    try {
      state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const expectedSignature = signState(state, state.machine);
      if (
        state.machine !== machine ||
        state.signature !== expectedSignature ||
        !Number.isFinite(state.firstSeen) ||
        !Number.isFinite(state.lastSeen) ||
        now < state.lastSeen - CLOCK_TOLERANCE_MS
      ) {
        return { allowed: false, reason: 'invalid' };
      }
    } catch {
      return { allowed: false, reason: 'invalid' };
    }
  } else {
    state = { firstSeen: now, lastSeen: now };
  }

  state.lastSeen = Math.max(now, state.lastSeen || now);
  try {
    fs.mkdirSync(appDataPath, { recursive: true });
    writeState(filePath, state, machine);
  } catch {
    return { allowed: false, reason: 'storage' };
  }

  return { allowed: true, expiresAt };
}

module.exports = { checkTrialLicense };
