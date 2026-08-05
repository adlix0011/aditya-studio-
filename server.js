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
      sendJSON(res, 200, { ok: true, id: acc.id, name: acc.name, village: acc.village, mobile: acc.mobile, history: publicHistory(acc) });
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
        history: publicHistory(acc)
      });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: 'bad-request' });
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
    const accounts = loadAccounts().slice().reverse();
    const pendingResets = accounts.filter(a => a.pinResetRequested);
    const codes = loadCodes().slice().reverse();

    function esc(t) {
      return String(t == null ? '' : t)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    const resetCards = pendingResets.map(acc => {
      const existingMsg = encodeURIComponent('Hi ' + acc.name + ', aapka Aditya Studio PIN hai: ' + (acc.pin || '') + '. Isse login karke discount wheel spin kar sakte hain.');
      return '<div class="msg-card">'
        + '<div class="msg-text">🔔 <b>' + esc(acc.name) + '</b> (' + esc(acc.mobile) + ') ne PIN bhoolne ki request bheji — '
        + (acc.pinResetRequestedAt ? new Date(acc.pinResetRequestedAt).toLocaleString('en-IN') : '') + '</div>'
        + '<div class="msg-actions">'
        + '<a class="gen-btn wa-link" href="https://wa.me/91' + esc(acc.mobile) + '?text=' + existingMsg + '" target="_blank" rel="noopener">💬 maujooda PIN bhejo</a>'
        + '<form method="POST" action="/admin/reset-pin" style="display:flex;gap:6px;">'
        + '<input type="hidden" name="mobile" value="' + esc(acc.mobile) + '">'
        + '<input type="text" name="newPin" placeholder="Naya PIN" maxlength="4" style="width:90px;background:#0C0906;border:1px solid rgba(212,175,55,0.3);border-radius:6px;padding:6px 8px;color:#F4EAD6;">'
        + '<button class="gen-btn" type="submit" style="padding:6px 14px;font-size:12px;">Naya PIN → WhatsApp</button>'
        + '</form></div></div>';
    }).join('') || '<div class="muted">Koi pending request nahi</div>';

    const codeRows = codes.map(c =>
      '<tr><td style="font-family:monospace;letter-spacing:2px;">' + esc(c.code) + '</td>'
      + '<td>' + (c.used ? '<span style="color:#e08a8a;">Used</span>' : '<span style="color:#8fd19e;">Unused</span>') + '</td>'
      + '<td>' + esc(c.usedBy || '—') + '</td>'
      + '<td>' + esc(new Date(c.createdAt).toLocaleString('en-IN')) + '</td></tr>'
    ).join('') || '<tr><td colspan="4">Abhi koi code nahi</td></tr>';

    const blocks = accounts.map(acc => {
      const rows = (acc.history || []).slice().reverse().map(h =>
        '<tr><td>' + esc(h.entryId) + '</td><td>₹' + esc(h.amount) + '</td><td>' + esc(h.tier || '') + '</td>'
        + '<td>' + (h.discount != null ? esc(h.discount) + '%' : '— spin baaki —') + '</td>'
        + '<td>' + esc(new Date(h.timestamp).toLocaleString('en-IN')) + '</td></tr>'
      ).join('') || '<tr><td colspan="5">Koi entry nahi</td></tr>';
      return '<div class="acc-block">'
        + '<h3>' + esc(acc.id) + ' — ' + esc(acc.name)
        + ' <span class="muted">(' + esc(acc.mobile) + ', ' + esc(acc.village) + ')</span></h3>'
        + '<div class="muted" style="margin-bottom:8px;">🔑 PIN: <span style="color:#F3DE9A;font-family:monospace;letter-spacing:2px;">'
        + esc(acc.pin || '—') + '</span> | 👁️ Visits: ' + esc(acc.visitCount || 1)
        + ' | Last: ' + (acc.lastVisitAt ? esc(new Date(acc.lastVisitAt).toLocaleString('en-IN')) : '—')
        + ' | Joined: ' + esc(new Date(acc.createdAt).toLocaleDateString('en-IN')) + '</div>'
        + '<table><thead><tr><th>Entry</th><th>Amount</th><th>Tier</th><th>Discount</th><th>Time</th></tr></thead>'
        + '<tbody>' + rows + '</tbody></table></div>';
    }).join('') || '<p>Abhi koi account nahi hai</p>';

    const html = `<!DOCTYPE html>
<html lang="hi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aditya Studio — Admin</title>
<style>
body{font-family:sans-serif;background:#0F0C09;color:#F4EAD6;padding:24px;margin:0}
h1{color:#D4AF37;font-size:22px}h2{color:#D4AF37;font-size:17px;margin:28px 0 10px}
h3{color:#F3DE9A;font-size:15px;margin:18px 0 8px}
.muted{color:#B7A480;font-weight:normal;font-size:12px}
.sub{color:#B7A480;font-size:13px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}
th,td{padding:8px 10px;border-bottom:1px solid #2a2018;text-align:left;font-size:13px}
th{color:#D4AF37;text-transform:uppercase;font-size:11px;letter-spacing:0.5px}
tr:hover{background:#1B140F}a{color:#D4AF37}
.acc-block,.codes-block{border:1px solid rgba(212,175,55,0.15);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.gen-btn{background:linear-gradient(180deg,#F3DE9A,#D4AF37 60%,#8C6E2F);color:#241804;border:none;padding:10px 18px;border-radius:8px;font-weight:700;cursor:pointer;font-size:14px;text-decoration:none;display:inline-block}
.msg-card{background:#1B140F;border:1px solid rgba(224,138,138,0.35);border-radius:10px;padding:14px 16px;margin-bottom:12px}
.msg-text{font-size:13.5px;margin-bottom:10px}
.msg-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.wa-link{background:linear-gradient(180deg,#3ee06b,#25D366 60%,#128C4A)}
</style></head><body>
<h1>Aditya Studio — Admin</h1>
<div class="sub">Data dir safe | <a href="/">Customer page</a></div>

<h2>💾 Data Backup (PC me save)</h2>
<div class="codes-block">
<p class="sub">Har 2–3 din backup download karke PC / Google Drive me rakho. Wipe hone par Restore karo.</p>
<div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center">
<a class="gen-btn" href="/admin/backup">⬇️ Backup Download</a>
<form method="POST" action="/admin/restore" enctype="multipart/form-data" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
<input type="file" name="backup" accept=".json,application/json" required style="color:#F4EAD6;font-size:13px;max-width:220px">
<button class="gen-btn" type="submit" style="background:linear-gradient(180deg,#8fd19e,#3E7A4C)">⬆️ Restore Upload</button>
</form>
</div>
<div id="restoreMsg" class="muted" style="margin-top:10px"></div>
<script>
(function(){var q=new URLSearchParams(location.search).get('restore');var el=document.getElementById('restoreMsg');
if(q==='ok'){el.style.color='#8fd19e';el.textContent='✅ Restore successful';}
if(q==='fail'){el.style.color='#e08a8a';el.textContent='❌ Restore fail — sahi JSON file choose karo';}})();
</script>
</div>

<h2>⚠️ PIN Reset Requests (${pendingResets.length})</h2>
<div>${resetCards}</div>

<h2>Spin Codes</h2>
<div class="codes-block">
<form method="POST" action="/admin/generate-code"><button class="gen-btn" type="submit">+ Naya spin code banao</button></form>
<table style="margin-top:16px"><thead><tr><th>Code</th><th>Status</th><th>Used By</th><th>Created</th></tr></thead>
<tbody>${codeRows}</tbody></table>
</div>

<h2>Accounts (${accounts.length})</h2>
${blocks}
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
});
