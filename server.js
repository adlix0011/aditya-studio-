/*
  Aditya Studio — Data Server (Local + Render/Production ready)
  -----------------------------------------------------------------
  LOCAL chalane ka tarika:
    node server.js
    -> http://localhost:4000        (customer page)
    -> http://localhost:4000/admin  (admin — password maangega)

  RENDER pe deploy karte waqt:
    - PORT apne aap Render se milta hai (process.env.PORT)
    - Environment Variables me ye set karo (Render dashboard -> Environment):
        ADMIN_PASSWORD = <apna admin password>
        PIN_SALT       = <koi bhi random lambi string>
    - .env file sirf LOCAL testing ke liye hai, usko kabhi GitHub pe push mat karo
      (isiliye .gitignore me daala gaya hai)

  Data kaha save hota hai:
    - accounts.json  -> har customer ka account (PIN hashed, plain text kabhi nahi)
    - customers.csv  -> Excel me kholne layak, har spin/work-entry ki ek row

  ⚠️ IMPORTANT (Render free tier): iska filesystem "ephemeral" hota hai — matlab
  jab bhi service restart/redeploy hoti hai (free tier sleep ke baad bhi), ye
  accounts.json file DELETE ho jaati hai aur sara data khatam ho jaata hai.
  Real customer data permanently save karna hai to:
    (a) Render ka paid "Persistent Disk" add karo, YA
    (b) Isko ek real database (Postgres/MongoDB) me shift karo.
  Abhi ke liye ye JSON-file wala tarika sirf demo/testing ke liye theek hai.
*/

/*
  FLOW (customer page):
    1) Landing: logo + 3D title + wheel + SPIN only
    2) Spin ~5s → then Sign Up / Login card
    3) Forgot PIN → /api/request-pin-reset → green success on page
  Admin: /admin (ADMIN_PASSWORD required)
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4000;
const PIN_SALT = process.env.PIN_SALT || 'aditya-studio-local-salt';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null; // null = admin panel band (locked) rahega jab tak set na ho
// DATA_DIR: sirf tab use karo jab Render pe Persistent Disk mount ho.
// Bina disk ke /var/data likhne se write fail hota hai — auto fallback __dirname.
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
const HTML_FILE = path.join(__dirname, 'aditya-studio-discount-wheel.html');
console.log('[boot] Using data dir:', DATA_DIR);

function generateOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}
function otpFilePath() {
  return path.join(DATA_DIR, 'otp-requests.json');
}
function loadOtpRequests() {
  try {
    const f = otpFilePath();
    if (!fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { return []; }
}
function saveOtpRequests(list) {
  const f = otpFilePath();
  try {
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, f);
  } catch (e) {
    try { fs.writeFileSync(f, JSON.stringify(list, null, 2), 'utf8'); } catch (e2) {}
  }
}



function loadAccounts() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    // ensure pin always string
    return (Array.isArray(data) ? data : []).map(a => ({
      ...a,
      mobile: String(a.mobile || ''),
      pin: String(a.pin || '')
    }));
  } catch (e) {
    console.error('accounts.json padhne me error:', e.message);
    return [];
  }
}

function hashPin(pin, mobile) {
  return crypto.createHash('sha256').update(PIN_SALT + ':' + mobile + ':' + pin).digest('hex');
}

function csvEscape(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return '"' + s.replace(/"/g, '""') + '"';
}

function writeCSV(accounts) {
  const header = ['Customer ID', 'Name', 'Mobile', 'Village', 'Visits', 'Last Visit', 'Entry ID', 'Amount', 'Tier', 'Discount(%)', 'Timestamp'];
  const rows = [];
  accounts.forEach(acc => {
    const visits = acc.visitCount || 1;
    const lastVisit = acc.lastVisitAt || acc.createdAt;
    if (!acc.history || acc.history.length === 0) {
      rows.push([acc.id, acc.name, acc.mobile, acc.village, visits, lastVisit, '', '', '', '', acc.createdAt].map(csvEscape).join(','));
    } else {
      acc.history.forEach(h => {
        rows.push([acc.id, acc.name, acc.mobile, acc.village, visits, lastVisit, h.entryId, h.amount, h.tier, h.discount ?? '', h.timestamp].map(csvEscape).join(','));
      });
    }
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
    // fallback direct write
    console.error('atomic save fail, trying direct:', e.message);
    fs.writeFileSync(DATA_FILE, json, 'utf8');
  }
  try { writeCSV(accounts); } catch (e) { console.error('CSV write error:', e.message); }
}

const CODES_FILE = path.join(DATA_DIR, 'codes.json');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0, I/1 confusion

function loadCodes() {
  if (!fs.existsSync(CODES_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8')); }
  catch (e) { console.error('codes.json padhne me error:', e.message); return []; }
}

function saveCodes(codes) {
  fs.writeFileSync(CODES_FILE, JSON.stringify(codes, null, 2), 'utf8');
}

function generateCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}


function nextCustomerId(accounts) {
  return 'AS-' + String(accounts.length + 1).padStart(4, '0');
}

function publicHistory(acc) {
  return (acc.history || []).map(h => ({ amount: h.amount, tier: h.tier, discount: h.discount, timestamp: h.timestamp }));
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
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

// Simple HTTP Basic Auth check for admin routes
function isAdminAuthed(req) {
  if (!ADMIN_PASSWORD) return false; // password set hi nahi hai -> admin panel band
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); // "user:pass"
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('aditya-studio-discount-wheel.html nahi mili — isi folder me honi chahiye.'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }



  // ---- Spin mobile verify: request OTP (admin sends via WhatsApp) ----
  if (req.method === 'POST' && req.url === '/api/request-spin-otp') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile)) {
        return sendJSON(res, 400, { ok: false, error: 'invalid-mobile' });
      }
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'not-found' });
      if (acc.mobileVerified) {
        return sendJSON(res, 200, { ok: true, alreadyVerified: true });
      }
      let list = loadOtpRequests();
      // reuse active pending OTP for same mobile
      let row = list.find(r => r.mobile === mobile && !r.verified);
      if (!row) {
        row = {
          mobile,
          name: acc.name || '',
          id: acc.id || '',
          otp: generateOtp(),
          createdAt: new Date().toISOString(),
          verified: false,
          purpose: 'spin'
        };
        list.unshift(row);
        // keep last 100
        list = list.slice(0, 100);
        saveOtpRequests(list);
      }
      console.log('Spin OTP request:', mobile, 'otp=', row.otp);
      sendJSON(res, 200, {
        ok: true,
        alreadyVerified: false,
        message: 'Admin ko request chali — WhatsApp se OTP aayega'
      });
    } catch (e) {
      console.error('request-spin-otp error:', e);
      sendJSON(res, 500, { ok: false, error: 'server-error', detail: String(e.message || e) });
    }
    return;
  }

  // ---- Verify spin OTP (customer enters code admin sent on WA) ----
  if (req.method === 'POST' && req.url === '/api/verify-spin-otp') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const otp = String(body.otp || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile) || !/^\d{4,8}$/.test(otp)) {
        return sendJSON(res, 400, { ok: false, error: 'invalid' });
      }
      const list = loadOtpRequests();
      const row = list.find(r => r.mobile === mobile && !r.verified);
      if (!row) {
        return sendJSON(res, 400, { ok: false, error: 'no-request' });
      }
      if (String(row.otp) !== String(otp)) {
        return sendJSON(res, 401, { ok: false, error: 'wrong-otp' });
      }
      row.verified = true;
      row.verifiedAt = new Date().toISOString();
      saveOtpRequests(list);
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (acc) {
        acc.mobileVerified = true;
        saveAccounts(accounts);
      }
      console.log('Spin OTP verified:', mobile);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
    return;
  }

  // ---- Check if mobile already verified ----
  if (req.method === 'POST' && req.url === '/api/check-verified') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      sendJSON(res, 200, { ok: true, verified: !!(acc && acc.mobileVerified) });
    } catch (e) {
      sendJSON(res, 400, { ok: false });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/register') {
    try {
      const body = await readBody(req);
      const mobile = (body.mobile || '').toString().trim();
      const pin = (body.pin || '').toString().trim();
      if (!/^[6-9]\d{9}$/.test(mobile) || !/^\d{4}$/.test(pin)) {
        return sendJSON(res, 400, { ok: false, error: 'invalid' });
      }
      const accounts = loadAccounts();
      if (accounts.find(a => a.mobile === mobile)) {
        return sendJSON(res, 409, { ok: false, error: 'exists' });
      }
      const id = nextCustomerId(accounts);
      accounts.push({
        id,
        name: (body.name || '').toString().trim(),
        mobile: String(mobile),
        village: (body.village || '').toString().trim(),
        pin: String(pin),
        createdAt: new Date().toISOString(),
        visitCount: 1,
        lastVisitAt: new Date().toISOString(),
        pinResetRequested: false,
        pinResetRequestedAt: null,
        freeSpinUsed: false,
        history: []
      });
      saveAccounts(accounts);
      console.log('Naya account bana:', id, mobile);
      sendJSON(res, 200, { ok: true, id });
    } catch (e) {
      console.error('Register error:', e.message);
      sendJSON(res, 500, { ok: false, error: 'save-failed', detail: e.message });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/login') {
    try {
      const body = await readBody(req);
      const mobile = (body.mobile || '').toString().trim();
      const pin = (body.pin || '').toString().trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === String(mobile));
      if (!acc) {
        return sendJSON(res, 401, { ok: false, error: 'not-found' });
      }
      if (String(acc.pin) !== String(pin)) {
        return sendJSON(res, 401, { ok: false, error: 'wrong-pin' });
      }
      acc.visitCount = (acc.visitCount || 0) + 1;
      acc.lastVisitAt = new Date().toISOString();
      saveAccounts(accounts);
      console.log('Login hua:', acc.id, mobile);
      sendJSON(res, 200, { ok: true, id: acc.id, name: acc.name, village: acc.village, mobile: acc.mobile, history: publicHistory(acc), mobileVerified: !!acc.mobileVerified });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: 'bad-request' });
    }
    return;
  }


  if (req.method === 'POST' && req.url === '/api/restore-session') {
    try {
      const body = await readBody(req);
      const mobile = String((body.mobile || '')).trim();
      const pin = String((body.pin || '')).trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc) {
        return sendJSON(res, 401, { ok: false, error: 'not-found' });
      }
      if (String(acc.pin) !== String(pin)) {
        return sendJSON(res, 401, { ok: false, error: 'wrong-pin' });
      }
      // visit count mat badhao — silent restore
      sendJSON(res, 200, {
        ok: true,
        id: acc.id,
        name: acc.name,
        village: acc.village,
        mobile: acc.mobile,
        history: publicHistory(acc),
        mobileVerified: !!acc.mobileVerified
      });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: 'bad-request' });
    }
    return;
  }


  if (req.method === 'POST' && req.url === '/api/free-spin-result') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'no-account' });
      acc.freeSpinUsed = true;
      acc.history = acc.history || [];
      acc.history.push({
        entryId: acc.id + '-FREE',
        amount: 0,
        tier: 'Free',
        discount: body.discount != null ? body.discount : null,
        prize: body.prize || '',
        freeSpin: true,
        timestamp: new Date().toISOString()
      });
      saveAccounts(accounts);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 400, { ok: false });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/work-entry') {
    try {
      const body = await readBody(req);
      const mobile = (body.mobile || '').toString().trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => a.mobile === mobile);
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'no-account' });
      const entryId = acc.id + '-E' + (acc.history.length + 1);
      acc.history.push({
        entryId,
        amount: Number(body.amount) || 0,
        tier: (body.tier || '').toString(),
        discount: null,
        timestamp: new Date().toISOString()
      });
      saveAccounts(accounts);
      sendJSON(res, 200, { ok: true, entryId });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: 'bad-request' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/spin-result') {
    try {
      const body = await readBody(req);
      const mobile = (body.mobile || '').toString().trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => a.mobile === mobile);
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'no-account' });
      const entry = acc.history.find(h => h.entryId === body.entryId) || acc.history[acc.history.length - 1];
      if (!entry) return sendJSON(res, 404, { ok: false, error: 'no-entry' });
      entry.discount = body.discount;
      saveAccounts(accounts);
      console.log('Discount save hua:', acc.id, entry.entryId, '->', body.discount + '%');
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: 'bad-request' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/redeem-code') {
    try {
      const body = await readBody(req);
      const mobile = (body.mobile || '').toString().trim();
      const code = (body.code || '').toString().trim().toUpperCase();
      const codes = loadCodes();
      const found = codes.find(c => c.code === code);
      if (!found) return sendJSON(res, 404, { ok: false, error: 'invalid' });
      if (found.used) return sendJSON(res, 409, { ok: false, error: 'used' });
      found.used = true;
      found.usedBy = mobile;
      found.usedAt = new Date().toISOString();
      saveCodes(codes);
      console.log('Code redeem hua:', code, 'by', mobile);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: 'bad-request' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/request-pin-reset') {
    try {
      const body = await readBody(req);
      const mobile = (body.mobile || '').toString().trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => a.mobile === mobile);
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'no-account' });
      acc.pinResetRequested = true;
      acc.pinResetRequestedAt = new Date().toISOString();
      saveAccounts(accounts);
      console.log('PIN reset request:', acc.id, mobile);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: 'bad-request' });
    }
    return;
  }

  // Admin-only from here on
  if (req.url === '/api/customers' || req.url === '/admin' || req.url.startsWith('/admin/')) {
    if (!isAdminAuthed(req)) return requireAdminAuth(req, res);
  }


  // ---- BACKUP: PC me download ----
  if (req.method === 'GET' && req.url === '/admin/backup') {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      accounts: loadAccounts(),
      codes: loadCodes()
    };
    const body = JSON.stringify(payload, null, 2);
    const fname = 'aditya-studio-backup-' + new Date().toISOString().slice(0,10) + '.json';
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + fname + '"'
    });
    res.end(body);
    console.log('Backup download:', fname, 'accounts=', payload.accounts.length, 'codes=', payload.codes.length);
    return;
  }

  // ---- RESTORE: PC se upload ----
  if (req.method === 'POST' && req.url === '/admin/restore') {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      // multipart or raw JSON both support
      let jsonStr = raw;
      const ct = (req.headers['content-type'] || '');
      if (ct.includes('multipart/form-data')) {
        // very simple extract of file content between boundaries
        const m = raw.match(/\{[\s\S]*"accounts"[\s\S]*\}/);
        if (!m) {
          res.writeHead(302, { Location: '/admin?restore=fail' });
          return res.end();
        }
        jsonStr = m[0];
      }
      const data = JSON.parse(jsonStr);
      if (!data || !Array.isArray(data.accounts)) {
        res.writeHead(302, { Location: '/admin?restore=fail' });
        return res.end();
      }
      saveAccounts(data.accounts);
      if (Array.isArray(data.codes)) saveCodes(data.codes);
      console.log('Restore OK — accounts:', data.accounts.length, 'codes:', (data.codes || []).length);
      res.writeHead(302, { Location: '/admin?restore=ok' });
      return res.end();
    } catch (e) {
      console.error('Restore error:', e.message);
      res.writeHead(302, { Location: '/admin?restore=fail' });
      return res.end();
    }
  }

  if (req.method === 'POST' && req.url === '/admin/generate-code') {
    const codes = loadCodes();
    const newCode = generateCode();
    codes.push({ code: newCode, used: false, usedBy: null, createdAt: new Date().toISOString(), usedAt: null });
    saveCodes(codes);
    console.log('Naya spin code bana:', newCode);
    res.writeHead(302, { Location: '/admin' });
    return res.end();
  }

  if (req.method === 'POST' && req.url === '/admin/reset-pin') {
    try {
      const body = await readFormBody(req);
      const mobile = (body.mobile || '').toString().trim();
      const newPin = (body.newPin || '').toString().trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => a.mobile === mobile);
      if (acc && /^\d{4}$/.test(newPin)) {
        acc.pin = newPin;
        acc.pinResetRequested = false;
        acc.pinResetRequestedAt = null;
        saveAccounts(accounts);
        console.log('Admin ne PIN reset kiya:', acc.id, mobile);
        const msg = 'Hi ' + acc.name + ', aapka Aditya Studio ka naya PIN hai: ' + newPin + '. Isse login karke discount wheel spin kar sakte hain.';
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

  if (req.method === 'GET' && req.url === '/api/customers') {
    const accounts = loadAccounts().map(a => ({ id: a.id, name: a.name, mobile: a.mobile, village: a.village, history: a.history }));
    sendJSON(res, 200, accounts);
    return;
  }

  if (req.method === 'GET' && req.url === '/admin') {
    function esc(t) {
      return String(t == null ? '' : t)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function fmtDate(d) {
      try { return d ? new Date(d).toLocaleString('en-IN') : '—'; } catch(e) { return '—'; }
    }
    function lastPrize(acc) {
      const h = (acc.history || []).slice().reverse();
      for (const x of h) {
        if (x.prize) return x.prize;
        if (x.discount != null && x.discount !== '') return x.discount + '%';
        if (x.freeSpin) return 'Free spin';
      }
      return '—';
    }

    const accounts = loadAccounts().slice().reverse();
    const pendingResets = accounts.filter(a => a.pinResetRequested);
    const pendingOtps = loadOtpRequests().filter(r => !r.verified);
    const codes = loadCodes().slice().reverse();
    const today = new Date().toDateString();
    const newToday = accounts.filter(a => a.createdAt && new Date(a.createdAt).toDateString() === today).length;
    const verifiedCount = accounts.filter(a => a.mobileVerified).length;
    const freeUsed = accounts.filter(a => a.freeSpinUsed || (a.history || []).some(h => h.freeSpin)).length;

    const otpCards = pendingOtps.map(r => {
      const msg = encodeURIComponent(
        'Namaste ' + (r.name || '') + '!\nAditya Studio Spin OTP: *' + r.otp + '*\nYe code daal kar apni spin complete karein.\n— Aditya Studio'
      );
      return '<div class="msg-card">'
        + '<div class="msg-text">🎡 <b>' + esc(r.name || 'Customer') + '</b> (' + esc(r.mobile) + ') — ' + esc(r.id || '')
        + '<br>OTP: <span class="otp-big">' + esc(r.otp) + '</span>'
        + '<br><span class="muted">' + esc(fmtDate(r.createdAt)) + '</span></div>'
        + '<div class="msg-actions">'
        + '<a class="gen-btn wa-link" href="https://wa.me/91' + esc(r.mobile) + '?text=' + msg + '" target="_blank" rel="noopener">💬 WhatsApp pe OTP bhejo</a>'
        + '</div></div>';
    }).join('') || '<div class="muted">Koi pending spin OTP nahi</div>';

    const resetCards = pendingResets.map(acc => {
      const existingMsg = encodeURIComponent('Hi ' + acc.name + ', aapka Aditya Studio PIN hai: ' + (acc.pin || '') + '. Login karke spin karein.');
      return '<div class="msg-card">'
        + '<div class="msg-text">🔔 <b>' + esc(acc.name) + '</b> (' + esc(acc.mobile) + ') — PIN reset request — ' + esc(fmtDate(acc.pinResetRequestedAt)) + '</div>'
        + '<div class="msg-actions">'
        + '<a class="gen-btn wa-link" href="https://wa.me/91' + esc(acc.mobile) + '?text=' + existingMsg + '" target="_blank" rel="noopener">💬 PIN bhejo</a>'
        + '<form method="POST" action="/admin/reset-pin" style="display:flex;gap:6px;flex-wrap:wrap">'
        + '<input type="hidden" name="mobile" value="' + esc(acc.mobile) + '">'
        + '<input name="newPin" placeholder="Naya PIN" maxlength="4" class="inp">'
        + '<button class="gen-btn" type="submit">Naya PIN → WA</button></form>'
        + '</div></div>';
    }).join('') || '<div class="muted">Koi PIN reset request nahi</div>';

    const codeRows = codes.map(c =>
      '<tr><td class="mono">' + esc(c.code) + '</td>'
      + '<td>' + (c.used ? '<span class="bad">Used</span>' : '<span class="ok">Unused</span>') + '</td>'
      + '<td>' + esc(c.usedBy || '—') + '</td>'
      + '<td>' + esc(fmtDate(c.createdAt)) + '</td></tr>'
    ).join('') || '<tr><td colspan="4">Abhi koi code nahi</td></tr>';

    const rows = accounts.map(acc => {
      const hist = (acc.history || []).slice().reverse();
      const histRows = hist.map(h =>
        '<tr><td>' + esc(h.entryId || '—') + '</td><td>₹' + esc(h.amount != null ? h.amount : 0) + '</td>'
        + '<td>' + esc(h.tier || (h.freeSpin ? 'Free' : '—')) + '</td>'
        + '<td>' + esc(h.prize || (h.discount != null ? h.discount + '%' : '—')) + '</td>'
        + '<td>' + esc(fmtDate(h.timestamp)) + '</td></tr>'
      ).join('') || '<tr><td colspan="5" class="muted">Koi history nahi</td></tr>';
      const wa = encodeURIComponent('Namaste ' + (acc.name || '') + ', Aditya Studio se message.');
      return '<details class="acc">'
        + '<summary>'
        + '<span class="c-id">' + esc(acc.id) + '</span> '
        + '<b>' + esc(acc.name) + '</b> '
        + '<span class="muted">' + esc(acc.mobile) + '</span> '
        + (acc.mobileVerified ? '<span class="ok">✓ Verified</span>' : '<span class="bad">✗ Unverified</span>') + ' '
        + ((acc.freeSpinUsed || hist.some(h => h.freeSpin)) ? '<span class="tag">Free spin used</span>' : '<span class="tag tag2">Free spin pending</span>')
        + '</summary>'
        + '<div class="acc-body">'
        + '<div class="grid">'
        + '<div><span class="lbl">PIN</span><div class="mono gold">' + esc(acc.pin || '—') + '</div></div>'
        + '<div><span class="lbl">Village</span><div>' + esc(acc.village || '—') + '</div></div>'
        + '<div><span class="lbl">Visits</span><div>' + esc(acc.visitCount || 1) + '</div></div>'
        + '<div><span class="lbl">Joined</span><div>' + esc(fmtDate(acc.createdAt)) + '</div></div>'
        + '<div><span class="lbl">Last visit</span><div>' + esc(fmtDate(acc.lastVisitAt)) + '</div></div>'
        + '<div><span class="lbl">Last prize</span><div>' + esc(lastPrize(acc)) + '</div></div>'
        + '</div>'
        + '<div class="msg-actions" style="margin:10px 0">'
        + '<a class="gen-btn wa-link" href="https://wa.me/91' + esc(acc.mobile) + '?text=' + wa + '" target="_blank" rel="noopener">💬 WhatsApp</a>'
        + '<form method="POST" action="/admin/reset-pin" style="display:flex;gap:6px;flex-wrap:wrap">'
        + '<input type="hidden" name="mobile" value="' + esc(acc.mobile) + '">'
        + '<input name="newPin" placeholder="Naya PIN" maxlength="4" class="inp">'
        + '<button class="gen-btn" type="submit">PIN reset → WA</button></form>'
        + '</div>'
        + '<table><thead><tr><th>Entry</th><th>Amount</th><th>Tier</th><th>Prize/Discount</th><th>Time</th></tr></thead>'
        + '<tbody>' + histRows + '</tbody></table>'
        + '</div></details>';
    }).join('') || '<p class="muted">Abhi koi customer nahi — jab register hoga yahan dikhega.</p>';

    const html = `<!DOCTYPE html>
<html lang="hi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aditya Studio — Admin</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0F0C09;color:#F4EAD6;padding:20px;margin:0;line-height:1.4}
h1{color:#D4AF37;font-size:1.4rem;margin:0 0 6px}
h2{color:#D4AF37;font-size:1.05rem;margin:28px 0 12px}
.sub{color:#B7A480;font-size:13px;margin-bottom:16px}
.sub a{color:#D4AF37}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:16px 0 8px}
.card{background:#1B140F;border:1px solid rgba(212,175,55,0.2);border-radius:12px;padding:14px}
.card .n{font-size:1.6rem;font-weight:800;color:#FFD700}
.card .l{font-size:11px;color:#B7A480;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px}
.codes-block,.msg-card,.acc{border:1px solid rgba(212,175,55,0.15);border-radius:12px;padding:14px;margin-bottom:12px;background:#150f0b}
.gen-btn{background:linear-gradient(180deg,#F3DE9A,#D4AF37 60%,#8C6E2F);color:#241804;border:none;padding:9px 14px;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;text-decoration:none;display:inline-block}
.wa-link{background:linear-gradient(180deg,#3ee06b,#25D366 60%,#128C4A);color:#062}
.msg-text{margin-bottom:10px}
.msg-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.otp-big{color:#FFD700;font-size:1.4rem;letter-spacing:4px;font-family:monospace;font-weight:700}
.muted{color:#B7A480}
.ok{color:#8fd19e;font-weight:600;font-size:12px}
.bad{color:#e08a8a;font-weight:600;font-size:12px}
.tag{background:rgba(143,209,158,0.15);color:#8fd19e;padding:2px 8px;border-radius:99px;font-size:11px}
.tag2{background:rgba(255,215,0,0.12);color:#FFD700}
.mono{font-family:monospace;letter-spacing:1px}
.gold{color:#FFD700;font-size:1.1rem}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
th,td{padding:8px;border-bottom:1px solid #2a2018;text-align:left}
th{color:#D4AF37;font-size:11px;text-transform:uppercase}
.inp{background:#0C0906;border:1px solid rgba(212,175,55,0.3);border-radius:6px;padding:6px 8px;color:#F4EAD6;width:90px}
.acc summary{cursor:pointer;list-style:none;padding:4px 0}
.acc summary::-webkit-details-marker{display:none}
.acc summary .c-id{color:#D4AF37;font-family:monospace}
.acc-body{margin-top:12px;padding-top:12px;border-top:1px solid rgba(212,175,55,0.12)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:8px}
.lbl{font-size:10px;color:#B7A480;text-transform:uppercase;letter-spacing:0.4px}
#search{width:100%;max-width:360px;padding:10px 12px;border-radius:8px;border:1px solid rgba(212,175,55,0.3);background:#0C0906;color:#F4EAD6;margin-bottom:12px}
</style></head><body>
<h1>Aditya Studio — Admin</h1>
<div class="sub">Live panel | <a href="/">Customer page</a></div>

<div class="cards">
  <div class="card"><div class="n">${accounts.length}</div><div class="l">Total customers</div></div>
  <div class="card"><div class="n">${newToday}</div><div class="l">Aaj naye</div></div>
  <div class="card"><div class="n">${pendingOtps.length}</div><div class="l">Pending OTP</div></div>
  <div class="card"><div class="n">${verifiedCount}</div><div class="l">Mobile verified</div></div>
  <div class="card"><div class="n">${freeUsed}</div><div class="l">Free spin used</div></div>
  <div class="card"><div class="n">${codes.filter(c=>!c.used).length}</div><div class="l">Unused codes</div></div>
</div>

<h2>💾 Backup</h2>
<div class="codes-block">
<p class="sub">Har 2–3 din backup lo. Render free pe data wipe ho sakta hai.</p>
<div class="msg-actions">
<a class="gen-btn" href="/admin/backup">⬇️ Backup Download</a>
<form method="POST" action="/admin/restore" enctype="multipart/form-data" class="msg-actions">
<input type="file" name="backup" accept=".json,application/json" required style="color:#F4EAD6;font-size:13px">
<button class="gen-btn" type="submit" style="background:linear-gradient(180deg,#8fd19e,#3E7A4C)">⬆️ Restore</button>
</form>
</div>
</div>

<h2>📱 Spin OTP Requests (${pendingOtps.length})</h2>
${otpCards}

<h2>⚠️ PIN Reset (${pendingResets.length})</h2>
${resetCards}

<h2>🎫 Spin Codes</h2>
<div class="codes-block">
<form method="POST" action="/admin/generate-code"><button class="gen-btn" type="submit">+ Naya spin code</button></form>
<table><thead><tr><th>Code</th><th>Status</th><th>Used By</th><th>Created</th></tr></thead>
<tbody>${codeRows}</tbody></table>
</div>

<h2>👥 Customers (${accounts.length})</h2>
<input id="search" type="search" placeholder="Search name / mobile / ID..." oninput="filterAcc(this.value)">
<div id="accList">${rows}</div>
<script>
function filterAcc(q){
  q=(q||'').toLowerCase();
  document.querySelectorAll('#accList .acc').forEach(function(el){
    el.style.display = !q || el.textContent.toLowerCase().indexOf(q)>=0 ? '' : 'none';
  });
}
</script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Aditya Studio server chalu ho gaya, port:', PORT);
  console.log('Data folder:', DATA_DIR);
  console.log('Accounts file:', DATA_FILE);
  console.log('Admin panel:', ADMIN_PASSWORD ? '/admin (password protected)' : '/admin (LOCKED — ADMIN_PASSWORD env var set nahi hai)');
  console.log('Spin OTP: admin WhatsApp mode');
});
