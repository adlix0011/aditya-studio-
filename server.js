/*
  Aditya Studio — Data Server
  LOCAL: node server.js -> http://localhost:4000
  RENDER: set ADMIN_PASSWORD, optional PIN_SALT
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4000;
const PIN_SALT = process.env.PIN_SALT || 'aditya-studio-local-salt';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

function resolveDataDir() {
  const preferred = process.env.DATA_DIR || __dirname;
  const candidates = [preferred, __dirname, '/tmp'];
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const testFile = path.join(dir, '.write-test');
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
      return dir;
    } catch (e) {
      console.warn('Data dir not writable:', dir, e.message);
    }
  }
  return __dirname;
}
const DATA_DIR = resolveDataDir();
const DATA_FILE = path.join(DATA_DIR, 'accounts.json');
const CSV_FILE = path.join(DATA_DIR, 'customers.csv');
const CODES_FILE = path.join(DATA_DIR, 'codes.json');
const OTP_FILE = path.join(DATA_DIR, 'otp-requests.json');
const NOTIF_FILE = path.join(DATA_DIR, 'notifications.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const HTML_FILE = path.join(__dirname, 'aditya-studio-discount-wheel.html');
console.log('[boot] Using data dir:', DATA_DIR);

function loadAccounts() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return (Array.isArray(data) ? data : []).map(a => ({
      ...a,
      mobile: String(a.mobile || ''),
      pin: String(a.pin || '')
    }));
  } catch (e) {
    console.error('accounts read error:', e.message);
    return [];
  }
}

function writeCSV(accounts) {
  const header = ['id', 'name', 'mobile', 'village', 'entryId', 'amount', 'tier', 'discount', 'prize', 'timestamp'];
  const rows = [];
  accounts.forEach(a => {
    (a.history || []).forEach(h => {
      rows.push([a.id, a.name, a.mobile, a.village, h.entryId || '', h.amount, h.tier, h.discount, h.prize || '', h.timestamp].map(v => {
        const s = String(v == null ? '' : v);
        return '"' + s.replace(/"/g, '""') + '"';
      }).join(','));
    });
  });
  fs.writeFileSync(CSV_FILE, [header.join(','), ...rows].join('\n'), 'utf8');
}

function saveAccounts(accounts) {
  accounts.forEach(a => { a.pin = String(a.pin || ''); a.mobile = String(a.mobile || ''); });
  const json = JSON.stringify(accounts, null, 2);
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    fs.writeFileSync(DATA_FILE, json, 'utf8');
  }
  try { writeCSV(accounts); } catch (e) { console.error('CSV error:', e.message); }
}

function loadCodes() {
  if (!fs.existsSync(CODES_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8')); }
  catch (e) { return []; }
}
function saveCodes(codes) {
  fs.writeFileSync(CODES_FILE, JSON.stringify(codes, null, 2), 'utf8');
}
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}
function generateOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}
function loadOtpRequests() {
  try {
    if (!fs.existsSync(OTP_FILE)) return [];
    return JSON.parse(fs.readFileSync(OTP_FILE, 'utf8'));
  } catch (e) { return []; }
}
function saveOtpRequests(list) {
  try {
    const tmp = OTP_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, OTP_FILE);
  } catch (e) {
    try { fs.writeFileSync(OTP_FILE, JSON.stringify(list, null, 2), 'utf8'); } catch (e2) {}
  }
}
function loadNotifs() {
  try {
    if (!fs.existsSync(NOTIF_FILE)) return [];
    return JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8'));
  } catch (e) { return []; }
}
function saveNotifs(list) {
  try { fs.writeFileSync(NOTIF_FILE, JSON.stringify(list.slice(0, 50), null, 2)); }
  catch (e) { console.error('saveNotifs', e.message); }
}
function defaultSettings() {
  return {
    bookImages: {
      wedding: 'https://images.unsplash.com/photo-1519741497674-611481863552?w=400&q=80',
      birthday: 'https://images.unsplash.com/photo-1530103862676-de8c9debad1d?w=400&q=80',
      personal: 'https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=400&q=80',
      reel: 'https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?w=400&q=80',
      event: 'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=400&q=80',
      other: 'https://images.unsplash.com/photo-1478144592103-25e218a04891?w=400&q=80'
    },
    offerImages: [
      { url: 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=800&q=80', title: '🎡 स्पिन ऑफ़र चल रहा है!', sub: 'कोड डालो → व्हील → डिस्काउंट' },
      { url: 'https://images.unsplash.com/photo-1519741497674-611481863552?w=800&q=80', title: '📸 Book Your Day', sub: 'Wedding · Birthday · Event' }
    ]
  };
}
function loadSettings() {
  const defaults = defaultSettings();
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return defaults;
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return {
      ...defaults,
      ...data,
      bookImages: { ...defaults.bookImages, ...(data.bookImages || {}) }
    };
  } catch (e) { return defaults; }
}
function saveSettings(obj) {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2)); }
  catch (e) { console.error('saveSettings', e.message); }
}

function nextCustomerId(accounts) {
  return 'AS-' + String(accounts.length + 1).padStart(4, '0');
}
function publicHistory(acc) {
  return (acc.history || []).map(h => ({
    amount: h.amount, tier: h.tier, discount: h.discount,
    prize: h.prize, freeSpin: h.freeSpin, timestamp: h.timestamp, entryId: h.entryId
  }));
}
function tierName(amt) {
  amt = Number(amt) || 0;
  if (amt >= 10000) return 'Diamond';
  if (amt >= 5000) return 'Gold+';
  if (amt >= 1000) return 'Gold';
  return 'Silver';
}
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) reject(new Error('too large')); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}
function readFormBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const obj = {};
      for (const [k, v] of params) obj[k] = v;
      resolve(obj);
    });
    req.on('error', reject);
  });
}
function isAdminAuthed(req) {
  if (!ADMIN_PASSWORD) return false;
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const pass = decoded.split(':').slice(1).join(':');
  return pass === ADMIN_PASSWORD;
}
function requireAdminAuth(req, res) {
  res.writeHead(401, {
    'Content-Type': 'text/plain; charset=utf-8',
    'WWW-Authenticate': 'Basic realm="Aditya Studio Admin"'
  });
  res.end('Admin password chahiye.');
}
function esc(t) {
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtDate(d) {
  try { return d ? new Date(d).toLocaleString('en-IN') : '—'; } catch (e) { return '—'; }
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    fs.readFile(HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('HTML file missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ---- Public APIs ----
  if (req.method === 'GET' && urlPath === '/api/settings') {
    return sendJSON(res, 200, { ok: true, settings: loadSettings() });
  }
  if (req.method === 'GET' && urlPath === '/api/notifications') {
    return sendJSON(res, 200, { ok: true, items: loadNotifs() });
  }

  if (req.method === 'POST' && urlPath === '/api/request-spin-otp') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile)) return sendJSON(res, 400, { ok: false, error: 'invalid-mobile' });
      const accounts = loadAccounts();
      let acc = accounts.find(a => String(a.mobile) === mobile);
      // Session se aaya data — account server pe nahi to soft create
      if (!acc && body.name) {
        acc = {
          id: body.id || nextCustomerId(accounts),
          name: String(body.name || '').trim(),
          mobile,
          village: String(body.village || '').trim(),
          pin: String(body.pin || '0000'),
          createdAt: new Date().toISOString(),
          history: [],
          mobileVerified: false,
          freeSpinUsed: !!body.freeSpinUsed,
          totalSpend: 0
        };
        accounts.push(acc);
        saveAccounts(accounts);
        console.log('OTP: soft account create', acc.id, mobile);
      }
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'not-found', message: 'Account server pe nahi mila' });
      if (acc.mobileVerified) return sendJSON(res, 200, { ok: true, alreadyVerified: true });
      let list = loadOtpRequests();
      let row = list.find(r => r.mobile === mobile && !r.verified);
      if (!row) {
        row = { mobile, name: acc.name || '', id: acc.id || '', otp: generateOtp(), createdAt: new Date().toISOString(), verified: false, purpose: 'spin' };
        list.unshift(row);
        list = list.slice(0, 100);
        saveOtpRequests(list);
      }
      console.log('Spin OTP request:', mobile, 'otp=', row.otp);
      return sendJSON(res, 200, { ok: true, alreadyVerified: false, otpHint: 'admin-panel' });
    } catch (e) {
      console.error('request-spin-otp', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error', detail: String(e.message || e) });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/verify-spin-otp') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const otp = String(body.otp || '').trim();
      const list = loadOtpRequests();
      const row = list.find(r => r.mobile === mobile && !r.verified);
      if (!row) return sendJSON(res, 400, { ok: false, error: 'no-request' });
      if (String(row.otp) !== String(otp)) return sendJSON(res, 401, { ok: false, error: 'wrong-otp' });
      row.verified = true;
      row.verifiedAt = new Date().toISOString();
      saveOtpRequests(list);
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (acc) { acc.mobileVerified = true; saveAccounts(accounts); }
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/check-verified') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      return sendJSON(res, 200, { ok: true, verified: !!(acc && acc.mobileVerified) });
    } catch (e) {
      return sendJSON(res, 400, { ok: false });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/register') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const pin = String(body.pin || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile) || !/^\d{4}$/.test(pin)) return sendJSON(res, 400, { ok: false, error: 'invalid' });
      const accounts = loadAccounts();
      if (accounts.find(a => a.mobile === mobile)) return sendJSON(res, 409, { ok: false, error: 'exists' });
      const id = nextCustomerId(accounts);
      accounts.push({
        id, name: String(body.name || '').trim(), mobile, village: String(body.village || '').trim(),
        pin, createdAt: new Date().toISOString(), visitCount: 1, lastVisitAt: new Date().toISOString(),
        pinResetRequested: false, freeSpinUsed: false, mobileVerified: false, history: [], totalSpend: 0
      });
      saveAccounts(accounts);
      return sendJSON(res, 200, { ok: true, id });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'save-failed' });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/login') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const pin = String(body.pin || '').trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc) return sendJSON(res, 401, { ok: false, error: 'not-found' });
      if (String(acc.pin) !== pin) return sendJSON(res, 401, { ok: false, error: 'wrong-pin' });
      acc.visitCount = (acc.visitCount || 0) + 1;
      acc.lastVisitAt = new Date().toISOString();
      saveAccounts(accounts);
      return sendJSON(res, 200, {
        ok: true, id: acc.id, name: acc.name, village: acc.village, mobile: acc.mobile,
        history: publicHistory(acc), mobileVerified: !!acc.mobileVerified,
        badge: acc.badge || null, totalSpend: acc.totalSpend || 0, freeSpinUsed: !!acc.freeSpinUsed
      });
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad-request' });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/restore-session') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const pin = String(body.pin || '').trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc || String(acc.pin) !== pin) return sendJSON(res, 401, { ok: false, error: 'not-found' });
      return sendJSON(res, 200, {
        ok: true, id: acc.id, name: acc.name, village: acc.village, mobile: acc.mobile,
        history: publicHistory(acc), mobileVerified: !!acc.mobileVerified,
        badge: acc.badge || null, totalSpend: acc.totalSpend || 0, freeSpinUsed: !!acc.freeSpinUsed
      });
    } catch (e) {
      return sendJSON(res, 400, { ok: false });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/free-spin-result') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc) return sendJSON(res, 404, { ok: false });
      acc.freeSpinUsed = true;
      acc.history = acc.history || [];
      acc.history.push({
        entryId: acc.id + '-FREE', amount: 0, tier: 'Free',
        discount: body.discount != null ? body.discount : null,
        prize: body.prize || '', freeSpin: true, timestamp: new Date().toISOString()
      });
      saveAccounts(accounts);
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 400, { ok: false });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/work-entry') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const amount = Number(body.amount) || 0;
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc) return sendJSON(res, 404, { ok: false });
      const entryId = acc.id + '-E' + String((acc.history || []).length + 1);
      acc.history = acc.history || [];
      acc.history.push({ entryId, amount, tier: body.tier || tierName(amount), timestamp: new Date().toISOString() });
      acc.totalSpend = acc.history.reduce((s, h) => s + (Number(h.amount) || 0), 0);
      acc.badge = tierName(acc.totalSpend);
      saveAccounts(accounts);
      return sendJSON(res, 200, { ok: true, entryId });
    } catch (e) {
      return sendJSON(res, 400, { ok: false });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/spin-result') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc) return sendJSON(res, 404, { ok: false });
      const entry = (acc.history || []).find(h => h.entryId === body.entryId);
      if (entry) {
        entry.discount = body.discount;
        entry.prize = body.prize || entry.prize || (body.discount != null ? body.discount + '%' : '');
        saveAccounts(accounts);
        // link prize to spin code history
        if (entry.code) {
          const codes = loadCodes();
          const crow = codes.find(c => String(c.code).toUpperCase() === String(entry.code).toUpperCase());
          if (crow) {
            crow.prize = entry.prize;
            crow.discount = entry.discount;
            crow.prizeAt = new Date().toISOString();
            saveCodes(codes);
          }
        }
      }
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 400, { ok: false });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/redeem-code') {
    try {
      const body = await readBody(req);
      const code = String(body.code || '').trim().toUpperCase();
      const mobile = String(body.mobile || '').trim();
      const codes = loadCodes();
      const row = codes.find(c => String(c.code).toUpperCase() === code);
      if (!row) return sendJSON(res, 404, { ok: false, error: 'not-found' });
      if (row.used) return sendJSON(res, 409, { ok: false, error: 'used' });
      const accounts = loadAccounts();
      let acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc && body.name) {
        acc = {
          id: body.id || nextCustomerId(accounts),
          name: String(body.name || '').trim(),
          mobile,
          village: String(body.village || '').trim(),
          pin: String(body.pin || '0000'),
          createdAt: new Date().toISOString(),
          history: [],
          mobileVerified: false,
          totalSpend: 0
        };
        accounts.push(acc);
        console.log('Redeem: soft account', acc.id, mobile);
      }
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'no-account', message: 'Account server pe nahi — dubara login/register karein' });
      const amount = Number(row.amount) || 0;
      row.used = true;
      row.usedBy = acc.id + ' / ' + mobile;
      row.usedAt = new Date().toISOString();
      saveCodes(codes);
      const tier = tierName(amount);
      const entryId = acc.id + '-E' + String((acc.history || []).length + 1);
      acc.history = acc.history || [];
      acc.history.push({ entryId, amount, tier, code: row.code, timestamp: new Date().toISOString() });
      acc.totalSpend = acc.history.reduce((s, h) => s + (Number(h.amount) || 0), 0);
      acc.badge = tierName(acc.totalSpend);
      saveAccounts(accounts);
      return sendJSON(res, 200, {
        ok: true, amount, tier, entryId, badge: acc.badge, totalSpend: acc.totalSpend, code: row.code
      });
    } catch (e) {
      console.error('redeem', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/request-pin-reset') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => a.mobile === mobile);
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'no-account' });
      acc.pinResetRequested = true;
      acc.pinResetRequestedAt = new Date().toISOString();
      saveAccounts(accounts);
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 400, { ok: false });
    }
  }

  // ---- Admin auth ----
  if (urlPath === '/api/customers' || urlPath === '/admin' || urlPath.startsWith('/admin/')) {
    if (!isAdminAuthed(req)) return requireAdminAuth(req, res);
  }

  if (req.method === 'GET' && urlPath === '/admin/backup') {
    const payload = { version: 1, exportedAt: new Date().toISOString(), accounts: loadAccounts(), codes: loadCodes(), settings: loadSettings() };
    const body = JSON.stringify(payload, null, 2);
    const fname = 'aditya-studio-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + fname + '"'
    });
    return res.end(body);
  }

  if (req.method === 'POST' && urlPath === '/admin/restore') {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      const boundary = (req.headers['content-type'] || '').split('boundary=')[1];
      let jsonStr = raw;
      if (boundary) {
        const parts = raw.split('--' + boundary);
        for (const p of parts) {
          if (p.includes('filename=')) {
            const i = p.indexOf('\r\n\r\n');
            if (i >= 0) jsonStr = p.slice(i + 4).replace(/\r\n--\s*$/, '').trim();
          }
        }
      }
      const data = JSON.parse(jsonStr);
      if (!data || !Array.isArray(data.accounts)) {
        res.writeHead(302, { Location: '/admin?restore=fail' });
        return res.end();
      }
      saveAccounts(data.accounts);
      if (Array.isArray(data.codes)) saveCodes(data.codes);
      if (data.settings) saveSettings(data.settings);
      res.writeHead(302, { Location: '/admin?restore=ok' });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: '/admin?restore=fail' });
      return res.end();
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/generate-code') {
    try {
      const body = await readFormBody(req);
      let amount = parseInt(String(body.amount || '0').replace(/[^0-9]/g, ''), 10) || 0;
      const note = String(body.note || '').trim();
      const codes = loadCodes();
      const newCode = generateCode();
      codes.push({ code: newCode, amount, note, used: false, usedBy: null, createdAt: new Date().toISOString(), usedAt: null });
      saveCodes(codes);
      console.log('Code:', newCode, '₹' + amount);
      res.writeHead(302, { Location: '/admin?code=' + encodeURIComponent(newCode) });
      return res.end();
    } catch (e) {
      console.error('generate-code', e);
      res.writeHead(302, { Location: '/admin?code=fail' });
      return res.end();
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/send-notification') {
    try {
      const body = await readFormBody(req);
      const title = String(body.title || '').trim() || 'Aditya Studio';
      const bodyText = String(body.body || body.message || '').trim();
      if (!bodyText) {
        res.writeHead(302, { Location: '/admin?notif=empty' });
        return res.end();
      }
      const list = loadNotifs();
      list.unshift({ title, body: bodyText, at: new Date().toISOString() });
      saveNotifs(list);
      console.log('Notif saved:', title);
      res.writeHead(302, { Location: '/admin?notif=ok' });
      return res.end();
    } catch (e) {
      console.error('notif', e);
      res.writeHead(302, { Location: '/admin?notif=fail' });
      return res.end();
    }
  }


  if (req.method === 'POST' && urlPath === '/admin/save-offer-images') {
    try {
      const body = await readFormBody(req);
      const cur = loadSettings();
      const urls = String(body.urls || '').split('\n').map(u => u.trim()).filter(Boolean);
      const titles = String(body.titles || '').split('\n').map(t => t.trim());
      const subs = String(body.subs || '').split('\n').map(t => t.trim());
      if (urls.length) {
        cur.offerImages = urls.map((url, i) => ({
          url,
          title: titles[i] || ('✨ Offer ' + (i + 1)),
          sub: subs[i] || ''
        }));
        saveSettings(cur);
      }
      res.writeHead(302, { Location: '/admin?offers=ok' });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: '/admin?offers=fail' });
      return res.end();
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/save-book-images') {
    try {
      const body = await readFormBody(req);
      const cur = loadSettings();
      cur.bookImages = cur.bookImages || {};
      ['wedding', 'birthday', 'personal', 'reel', 'event', 'other'].forEach(k => {
        if (body[k] != null && String(body[k]).trim()) cur.bookImages[k] = String(body[k]).trim();
      });
      saveSettings(cur);
      res.writeHead(302, { Location: '/admin?books=ok' });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: '/admin?books=fail' });
      return res.end();
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/reset-pin') {
    try {
      const body = await readFormBody(req);
      const mobile = String(body.mobile || '').trim();
      const newPin = String(body.newPin || '').trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => a.mobile === mobile);
      if (acc && /^\d{4}$/.test(newPin)) {
        acc.pin = newPin;
        acc.pinResetRequested = false;
        acc.pinResetRequestedAt = null;
        saveAccounts(accounts);
        const msg = 'Hi ' + acc.name + ', aapka Aditya Studio ka naya PIN hai: ' + newPin;
        res.writeHead(302, { Location: 'https://wa.me/91' + mobile + '?text=' + encodeURIComponent(msg) });
        return res.end();
      }
      res.writeHead(302, { Location: '/admin' });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: '/admin' });
      return res.end();
    }
  }

  if (req.method === 'GET' && urlPath === '/api/customers') {
    const accounts = loadAccounts().map(a => ({
      id: a.id, name: a.name, mobile: a.mobile, village: a.village, history: a.history
    }));
    return sendJSON(res, 200, accounts);
  }

  if (req.method === 'GET' && urlPath === '/admin') {
    const accounts = loadAccounts().slice().reverse();
    const settings = loadSettings();
    const bi = settings.bookImages || {};
    const pendingResets = accounts.filter(a => a.pinResetRequested);
    const pendingOtps = loadOtpRequests().filter(r => !r.verified);
    const codes = loadCodes().slice().reverse();
    const today = new Date().toDateString();
    const newToday = accounts.filter(a => a.createdAt && new Date(a.createdAt).toDateString() === today).length;
    const verifiedCount = accounts.filter(a => a.mobileVerified).length;
    const freeUsed = accounts.filter(a => a.freeSpinUsed).length;

    const otpCards = pendingOtps.map(r => {
      const msg = encodeURIComponent('Namaste ' + (r.name || '') + '!\nAditya Studio Spin OTP: *' + r.otp + '*\n— Aditya Studio');
      return '<div class="msg-card"><div class="msg-text">🎡 <b>' + esc(r.name || '') + '</b> (' + esc(r.mobile) + ')<br>OTP: <span class="otp-big">' + esc(r.otp) + '</span><br><span class="muted">' + esc(fmtDate(r.createdAt)) + '</span></div><div class="msg-actions"><a class="gen-btn wa-link" href="https://wa.me/91' + esc(r.mobile) + '?text=' + msg + '" target="_blank">💬 WhatsApp OTP</a></div></div>';
    }).join('') || '<div class="muted">No pending OTP</div>';

    const resetCards = pendingResets.map(acc => {
      return '<div class="msg-card"><div class="msg-text">🔔 <b>' + esc(acc.name) + '</b> (' + esc(acc.mobile) + ')</div><div class="msg-actions"><form method="POST" action="/admin/reset-pin" style="display:flex;gap:6px"><input type="hidden" name="mobile" value="' + esc(acc.mobile) + '"><input class="inp" name="newPin" placeholder="Naya PIN" maxlength="4"><button class="gen-btn" type="submit">Reset → WA</button></form></div></div>';
    }).join('') || '<div class="muted">No PIN resets</div>';

    const codeRows = codes.map(c =>
      '<tr><td class="mono">' + esc(c.code) + '</td>'
      + '<td>₹' + esc(c.amount != null ? c.amount : '—') + '</td>'
      + '<td>' + (c.used ? '<span class="bad">Used</span>' : '<span class="ok">Unused</span>') + '</td>'
      + '<td>' + esc(c.usedBy || '—') + '</td>'
      + '<td>' + esc(c.prize || (c.discount != null ? c.discount + '%' : (c.used ? 'Spin pending/unknown' : '—'))) + '</td>'
      + '<td>' + esc(fmtDate(c.createdAt)) + '</td>'
      + '<td>' + esc(c.usedAt ? fmtDate(c.usedAt) : '—') + '</td></tr>'
    ).join('') || '<tr><td colspan="7">No codes yet</td></tr>';

    function lastPrize(acc) {
      const h = (acc.history || []).slice().reverse();
      for (const x of h) {
        if (x.prize) return x.prize;
        if (x.discount != null) return x.discount + '%';
      }
      return '—';
    }

    const rows = accounts.map(acc => {
      const hist = (acc.history || []).slice().reverse();
      const histRows = hist.map(h =>
        '<tr><td>' + esc(h.entryId || '—') + '</td><td>₹' + esc(h.amount || 0) + '</td><td>' + esc(h.tier || '—') + '</td><td>' + esc(h.prize || (h.discount != null ? h.discount + '%' : '—')) + '</td><td>' + esc(fmtDate(h.timestamp)) + '</td></tr>'
      ).join('') || '<tr><td colspan="5" class="muted">No history</td></tr>';
      return '<details class="acc"><summary><span class="c-id">' + esc(acc.id) + '</span> <b>' + esc(acc.name) + '</b> <span class="muted">' + esc(acc.mobile) + '</span> ' +
        (acc.mobileVerified ? '<span class="ok">✓ Verified</span>' : '<span class="bad">✗ Unverified</span>') +
        ' <span class="tag">' + esc(acc.badge || tierName(acc.totalSpend || 0)) + '</span></summary><div class="acc-body"><div class="grid">' +
        '<div><span class="lbl">PIN</span><div class="mono gold">' + esc(acc.pin) + '</div></div>' +
        '<div><span class="lbl">Village</span><div>' + esc(acc.village || '—') + '</div></div>' +
        '<div><span class="lbl">Total spend</span><div>₹' + esc(acc.totalSpend || 0) + '</div></div>' +
        '<div><span class="lbl">Last prize</span><div>' + esc(lastPrize(acc)) + '</div></div></div>' +
        '<table><thead><tr><th>Entry</th><th>Amount</th><th>Tier</th><th>Prize</th><th>Time</th></tr></thead><tbody>' + histRows + '</tbody></table></div></details>';
    }).join('') || '<p class="muted">No customers yet</p>';

    const html = `<!DOCTYPE html><html lang="hi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aditya Studio Admin</title>
<style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0F0C09;color:#F4EAD6;padding:20px;margin:0}
h1{color:#D4AF37;font-size:1.4rem}h2{color:#D4AF37;font-size:1.05rem;margin:28px 0 12px}
.sub{color:#B7A480;font-size:13px;margin-bottom:16px}.sub a{color:#D4AF37}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:16px 0}
.card{background:#1B140F;border:1px solid rgba(212,175,55,0.2);border-radius:12px;padding:14px}
.card .n{font-size:1.5rem;font-weight:800;color:#FFD700}.card .l{font-size:11px;color:#B7A480;text-transform:uppercase}
.codes-block,.msg-card,.acc{border:1px solid rgba(212,175,55,0.15);border-radius:12px;padding:14px;margin-bottom:12px;background:#150f0b}
.gen-btn{background:linear-gradient(180deg,#F3DE9A,#D4AF37);color:#241804;border:none;padding:9px 14px;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;text-decoration:none;display:inline-block}
.wa-link{background:linear-gradient(180deg,#3ee06b,#25D366);color:#062}
.msg-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
.otp-big{color:#FFD700;font-size:1.3rem;letter-spacing:3px;font-family:monospace}
.muted{color:#B7A480}.ok{color:#8fd19e;font-weight:600;font-size:12px}.bad{color:#e08a8a;font-weight:600;font-size:12px}
.tag{background:rgba(255,215,0,0.12);color:#FFD700;padding:2px 8px;border-radius:99px;font-size:11px}
.mono{font-family:monospace}.gold{color:#FFD700}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
th,td{padding:8px;border-bottom:1px solid #2a2018;text-align:left}th{color:#D4AF37;font-size:11px;text-transform:uppercase}
.inp{background:#0C0906;border:1px solid rgba(212,175,55,0.3);border-radius:6px;padding:6px 8px;color:#F4EAD6;width:100px}
.acc summary{cursor:pointer}.c-id{color:#D4AF37;font-family:monospace}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin:10px 0}
.lbl{font-size:10px;color:#B7A480;text-transform:uppercase}
#search{width:100%;max-width:360px;padding:10px;border-radius:8px;border:1px solid rgba(212,175,55,0.3);background:#0C0906;color:#F4EAD6;margin-bottom:12px}
label.muted{display:block;font-size:12px}
</style></head><body>
<h1>Aditya Studio — Admin</h1>
<div class="sub"><a href="/">Customer page</a></div>
<div class="cards">
<div class="card"><div class="n">${accounts.length}</div><div class="l">Customers</div></div>
<div class="card"><div class="n">${newToday}</div><div class="l">Aaj naye</div></div>
<div class="card"><div class="n">${pendingOtps.length}</div><div class="l">Pending OTP</div></div>
<div class="card"><div class="n">${verifiedCount}</div><div class="l">Verified</div></div>
<div class="card"><div class="n">${freeUsed}</div><div class="l">Free spin used</div></div>
<div class="card"><div class="n">${codes.filter(c=>!c.used).length}</div><div class="l">Unused codes</div></div>
</div>

<h2>💾 Backup</h2>
<div class="codes-block">
<a class="gen-btn" href="/admin/backup">⬇️ Backup</a>
<form method="POST" action="/admin/restore" enctype="multipart/form-data" style="display:inline-flex;gap:8px;margin-left:8px;flex-wrap:wrap">
<input type="file" name="backup" accept=".json" required style="color:#F4EAD6;font-size:12px">
<button class="gen-btn" type="submit">⬆️ Restore</button>
</form>
</div>

<h2>🔔 Send Notification</h2>
<div class="codes-block">
<form method="POST" action="/admin/send-notification" style="display:flex;flex-direction:column;gap:8px;max-width:480px">
<input class="inp" name="title" placeholder="Title" style="width:100%">
<textarea name="body" rows="3" placeholder="Message..." required style="width:100%;background:#0C0906;border:1px solid rgba(212,175,55,0.3);border-radius:8px;color:#F4EAD6;padding:8px"></textarea>
<button class="gen-btn" type="submit">📢 Send to all</button>
</form>
</div>

<h2>📱 Spin OTP (${pendingOtps.length})</h2>
${otpCards}

<h2>⚠️ PIN Reset (${pendingResets.length})</h2>
${resetCards}

<h2>🖼️ Book card photos</h2>
<div class="codes-block">
<form method="POST" action="/admin/save-book-images" style="display:grid;gap:8px;max-width:560px">
<label class="muted">Wedding URL<input class="inp" name="wedding" value="${esc(bi.wedding||'')}" style="width:100%"></label>
<label class="muted">Birthday URL<input class="inp" name="birthday" value="${esc(bi.birthday||'')}" style="width:100%"></label>
<label class="muted">Personal URL<input class="inp" name="personal" value="${esc(bi.personal||'')}" style="width:100%"></label>
<label class="muted">Reel URL<input class="inp" name="reel" value="${esc(bi.reel||'')}" style="width:100%"></label>
<label class="muted">Event URL<input class="inp" name="event" value="${esc(bi.event||'')}" style="width:100%"></label>
<label class="muted">Other URL<input class="inp" name="other" value="${esc(bi.other||'')}" style="width:100%"></label>
<button class="gen-btn" type="submit">💾 Save photos</button>
</form>
</div>

<h2>🎬 Home Offer photos (animated)</h2>
<div class="codes-block">
<p class="sub">Har line ek photo URL. Titles/subs optional (same order). Save ke baad home offer carousel me animation chalega.</p>
<form method="POST" action="/admin/save-offer-images" style="display:grid;gap:8px;max-width:560px">
<label class="muted">Image URLs (one per line)
<textarea name="urls" rows="4" style="width:100%;background:#0C0906;border:1px solid rgba(212,175,55,0.3);border-radius:8px;color:#F4EAD6;padding:8px">${esc((settings.offerImages||[]).map(o=>o.url||o).join('\n'))}</textarea></label>
<label class="muted">Titles (one per line)
<textarea name="titles" rows="3" style="width:100%;background:#0C0906;border:1px solid rgba(212,175,55,0.3);border-radius:8px;color:#F4EAD6;padding:8px">${esc((settings.offerImages||[]).map(o=>o.title||'').join('\n'))}</textarea></label>
<label class="muted">Subtitles (one per line)
<textarea name="subs" rows="3" style="width:100%;background:#0C0906;border:1px solid rgba(212,175,55,0.3);border-radius:8px;color:#F4EAD6;padding:8px">${esc((settings.offerImages||[]).map(o=>o.sub||'').join('\n'))}</textarea></label>
<button class="gen-btn" type="submit">💾 Save offer photos</button>
</form>
</div>

<h2>🎫 Spin Codes History</h2>
<div class="codes-block">
<form method="POST" action="/admin/generate-code" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
<input class="inp" name="amount" type="number" min="1" placeholder="Amount ₹" required style="width:120px">
<input class="inp" name="note" placeholder="Note" style="width:140px">
<button class="gen-btn" type="submit">+ Naya spin code</button>
</form>
<table><thead><tr><th>Code</th><th>Amount</th><th>Status</th><th>Used By</th><th>Coupon/Prize</th><th>Created</th><th>Used At</th></tr></thead>
<tbody>${codeRows}</tbody></table>
</div>

<h2>👥 Customers (${accounts.length})</h2>
<input id="search" type="search" placeholder="Search..." oninput="filterAcc(this.value)">
<div id="accList">${rows}</div>
<script>
function filterAcc(q){q=(q||'').toLowerCase();document.querySelectorAll('#accList .acc').forEach(function(el){el.style.display=!q||el.textContent.toLowerCase().indexOf(q)>=0?'':'none';});}
</script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  console.warn('404', req.method, urlPath);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found: ' + req.method + ' ' + urlPath);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Aditya Studio server port:', PORT);
  console.log('Data folder:', DATA_DIR);
  console.log('Admin:', ADMIN_PASSWORD ? 'password protected' : 'LOCKED — set ADMIN_PASSWORD');
});
