/*
  Aditya Studio — Local Data Server (Accounts + Discount History)
  -----------------------------------------------------------------
  Chalane ka tarika:
    1) Terminal isi folder me kholo
    2) node server.js
    3) Browser me kholo: http://localhost:4000       (customer page)
                          http://localhost:4000/admin (sab accounts + history)

  Data kaha save hota hai:
    - accounts.json  -> har customer ka account (PIN hashed hota hai, plain text nahi)
    - customers.csv  -> Excel me kholne layak, har spin/work-entry ki ek row

  Har naye customer ko unique ID milta hai: AS-0001, AS-0002, ...
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 4000;
const DATA_FILE = path.join(__dirname, 'accounts.json');
const CSV_FILE = path.join(__dirname, 'customers.csv');
const HTML_FILE = path.join(__dirname, 'aditya-studio-discount-wheel.html');

function loadAccounts() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { console.error('accounts.json padhne me error:', e.message); return []; }
}

function hashPin(pin, mobile) {
  // Basic local protection — plain PIN kabhi file me save nahi hota
  return crypto.createHash('sha256').update(mobile + ':' + pin).digest('hex');
}

function csvEscape(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return '"' + s.replace(/"/g, '""') + '"';
}

function writeCSV(accounts) {
  const header = ['Customer ID', 'Name', 'Mobile', 'Village', 'Entry ID', 'Amount', 'Tier', 'Discount(%)', 'Timestamp'];
  const rows = [];
  accounts.forEach(acc => {
    if (!acc.history || acc.history.length === 0) {
      rows.push([acc.id, acc.name, acc.mobile, acc.village, '', '', '', '', acc.createdAt].map(csvEscape).join(','));
    } else {
      acc.history.forEach(h => {
        rows.push([acc.id, acc.name, acc.mobile, acc.village, h.entryId, h.amount, h.tier, h.discount ?? '', h.timestamp].map(csvEscape).join(','));
      });
    }
  });
  fs.writeFileSync(CSV_FILE, [header.join(','), ...rows].join('\n'), 'utf8');
}

function saveAccounts(accounts) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2), 'utf8');
  writeCSV(accounts);
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

  // Register a new customer account
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
        mobile,
        village: (body.village || '').toString().trim(),
        pinHash: hashPin(pin, mobile),
        createdAt: new Date().toISOString(),
        history: []
      });
      saveAccounts(accounts);
      console.log('Naya account bana:', id, mobile);
      sendJSON(res, 200, { ok: true, id });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: 'bad-request' });
    }
    return;
  }

  // Login with mobile + PIN
  if (req.method === 'POST' && req.url === '/api/login') {
    try {
      const body = await readBody(req);
      const mobile = (body.mobile || '').toString().trim();
      const pin = (body.pin || '').toString().trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => a.mobile === mobile);
      if (!acc || acc.pinHash !== hashPin(pin, mobile)) {
        return sendJSON(res, 401, { ok: false, error: 'invalid-credentials' });
      }
      console.log('Login hua:', acc.id, mobile);
      sendJSON(res, 200, { ok: true, id: acc.id, name: acc.name, village: acc.village, history: publicHistory(acc) });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: 'bad-request' });
    }
    return;
  }

  // Add a new work-amount entry for a logged-in customer -> returns entryId
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

  // Attach spin discount result to an entry
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

  // Raw JSON of all accounts (PIN hash excluded)
  if (req.method === 'GET' && req.url === '/api/customers') {
    const accounts = loadAccounts().map(a => ({ id: a.id, name: a.name, mobile: a.mobile, village: a.village, history: a.history }));
    sendJSON(res, 200, accounts);
    return;
  }

  // Admin table view
  if (req.method === 'GET' && req.url === '/admin') {
    const accounts = loadAccounts().slice().reverse();
    const blocks = accounts.map(acc => {
      const rows = (acc.history || []).slice().reverse().map(h => `
        <tr>
          <td>${h.entryId}</td>
          <td>₹${h.amount}</td>
          <td>${h.tier}</td>
          <td>${h.discount != null ? h.discount + '%' : '— स्पिन बाकी —'}</td>
          <td>${new Date(h.timestamp).toLocaleString('en-IN')}</td>
        </tr>`).join('');
      return `
        <div class="acc-block">
          <h3>${acc.id} — ${acc.name} <span class="muted">(${acc.mobile}, ${acc.village})</span></h3>
          <table>
            <thead><tr><th>Entry</th><th>Amount</th><th>Tier</th><th>Discount</th><th>Time</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5">कोई काम एंट्री नहीं</td></tr>'}</tbody>
          </table>
        </div>`;
    }).join('');
    const html = `<!DOCTYPE html><html lang="hi"><head><meta charset="UTF-8">
      <title>Aditya Studio — Admin</title>
      <style>
        body{font-family:sans-serif; background:#0F0C09; color:#F4EAD6; padding:24px;}
        h1{color:#D4AF37; font-size:22px;}
        h3{color:#F3DE9A; font-size:15px; margin:22px 0 8px;}
        .muted{color:#B7A480; font-weight:normal; font-size:12px;}
        .sub{color:#B7A480; font-size:13px; margin-bottom:16px;}
        table{width:100%; border-collapse:collapse;}
        th,td{padding:8px 10px; border-bottom:1px solid #2a2018; text-align:left; font-size:13px;}
        th{color:#D4AF37; text-transform:uppercase; font-size:11px; letter-spacing:0.5px;}
        tr:hover{background:#1B140F;}
        a{color:#D4AF37;}
        .acc-block{border:1px solid rgba(212,175,55,0.15); border-radius:10px; padding:12px 16px; margin-bottom:14px;}
      </style></head><body>
      <h1>Aditya Studio — Accounts (${accounts.length})</h1>
      <div class="sub">CSV file: customers.csv (isi folder me) | <a href="/">customer page</a></div>
      ${blocks || '<p>Abhi koi account nahi hai</p>'}
      </body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('Aditya Studio server chalu ho gaya: http://localhost:' + PORT);
  console.log('Admin panel:                       http://localhost:' + PORT + '/admin');
  console.log('Band karne ke liye Ctrl+C dabayein.');
});
