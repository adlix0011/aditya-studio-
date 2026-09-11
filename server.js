/*
  Aditya Studio — Data Server
  LOCAL: node server.js -> http://localhost:8000
  RENDER: set ADMIN_PASSWORD, optional PIN_SALT
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8000;
// PINs are hashed individually; this is only retained for legacy deployments.
const PIN_SALT = process.env.PIN_SALT || '';
// Never ship an admin password inside source code. run.bat asks for it locally.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// SMS gateway secrets stay only in process environment, never in source/data files.
const SMS_GATEWAY_URL = String(process.env.SMS_GATEWAY_URL || '').replace(/\/+$/, '');
const SMS_GATEWAY_API_KEY = String(process.env.SMS_GATEWAY_API_KEY || '');
// Telegram credentials live only in local/Render environment variables.
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
// Cloudflare R2 is optional. These private values live only in the local
// environment / Render dashboard — never in this source file or browser code.
const R2_BUCKET = String(process.env.R2_BUCKET || '').trim();
const R2_ACCESS_KEY_ID = String(process.env.R2_ACCESS_KEY_ID || '').trim();
const R2_SECRET_ACCESS_KEY = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_ENDPOINT = String(process.env.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
const OTP_TTL_MS = 5 * 60 * 1000;
// Mobile verification OTP admin panel me user verify karne tak pending rahega.
// PIN-reset OTP alag se sirf 5 minute ke liye valid hota hai.
const MOBILE_VERIFY_OTP_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_PEPPER = process.env.OTP_SECRET || SMS_GATEWAY_API_KEY || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const authAttempts = new Map();

function r2Ready() {
  return !!(R2_BUCKET && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && /^https:\/\//i.test(R2_ENDPOINT));
}
function telegramReady() { return !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID); }
let telegramAlertStatus = { configured: telegramReady(), ok: null, at: null, error: '' };
async function sendTelegramAlert(title, details) {
  if (!telegramReady()) {
    telegramAlertStatus = { configured: false, ok: false, at: new Date().toISOString(), error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing in this server environment' };
    return false;
  }
  const text = '🔔 *Aditya Studio Alert*\n\n*' + String(title || 'Update').replace(/[\\*_`]/g, '') + '*\n' + String(details || '').replace(/[\\*_`]/g, '').slice(0, 3500);
  try {
    const response = await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ chat_id:TELEGRAM_CHAT_ID, text, parse_mode:'Markdown' })
    });
    const ok = response.ok;
    telegramAlertStatus = { configured: true, ok, at: new Date().toISOString(), error: ok ? '' : ('Telegram HTTP ' + response.status) };
    return ok;
  } catch (e) { telegramAlertStatus = { configured: true, ok: false, at: new Date().toISOString(), error: e.message || 'Network error' }; console.error('telegram alert failed:', e.message); return false; }
}
function awsEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function hmacSha256(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}
function r2PresignedUrl(method, objectKey, expiresSeconds) {
  if (!r2Ready()) throw new Error('R2 is not configured');
  const endpoint = new URL(R2_ENDPOINT);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = 'auto', service = 's3';
  const credentialScope = dateStamp + '/' + region + '/' + service + '/aws4_request';
  const canonicalUri = '/' + [R2_BUCKET].concat(String(objectKey).split('/')).map(awsEncode).join('/');
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': R2_ACCESS_KEY_ID + '/' + credentialScope,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.max(60, Math.min(Number(expiresSeconds) || 600, 900))),
    'X-Amz-SignedHeaders': 'host'
  };
  const canonicalQuery = Object.keys(query).sort().map(k => awsEncode(k) + '=' + awsEncode(query[k])).join('&');
  const canonicalHeaders = 'host:' + endpoint.host + '\n';
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n');
  const dateKey = hmacSha256('AWS4' + R2_SECRET_ACCESS_KEY, dateStamp);
  const regionKey = hmacSha256(dateKey, region);
  const serviceKey = hmacSha256(regionKey, service);
  const signingKey = hmacSha256(serviceKey, 'aws4_request');
  const signature = hmacSha256(signingKey, stringToSign, 'hex');
  return endpoint.origin + canonicalUri + '?' + canonicalQuery + '&X-Amz-Signature=' + signature;
}
function isSafeR2PhotoKey(key, mobile) {
  const safeMobile = String(mobile || '').replace(/\D/g, '');
  return new RegExp('^customer-photos/' + safeMobile + '/[a-zA-Z0-9._-]+\\.(jpg|jpeg|png|webp)$', 'i').test(String(key || ''));
}

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
const FRAMES_FILE = path.join(DATA_DIR, 'photo-frames.json');
const FRAME_ORDERS_FILE = path.join(DATA_DIR, 'frame-orders.json');
const EDIT_REQUESTS_FILE = path.join(DATA_DIR, 'edit-requests.json');
const WALLET_TOPUPS_FILE = path.join(DATA_DIR, 'wallet-topups.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'user-activity.json');
// Browser login ko server restart ke baad bhi valid rakhne ke liye (7 days).
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const INDEX_HTML_FILE = path.join(__dirname, 'index.html');
const MY_ORDERS_HTML_FILE = path.join(__dirname, 'my-orders.html');
const SPIN_ROLLER_HTML_FILE = path.join(__dirname, 'spin-roller.html');
const LEGAL_HTML_FILE = path.join(__dirname, 'legal.html');
// Local project me legacy Book Now file kabhi backup folder me hoti hai; dono locations support karo.
const BOOK_NOW_PRIMARY_FILE = path.join(__dirname, 'aditya-studio-discount-wheel.html');
const BOOK_NOW_BACKUP_FILE = path.join(__dirname, '_repo_inspect', 'aditya-studio-discount-wheel.html');
const BOOK_NOW_HTML_FILE = fs.existsSync(BOOK_NOW_PRIMARY_FILE) ? BOOK_NOW_PRIMARY_FILE : BOOK_NOW_BACKUP_FILE;
const VERIFY_MOBILE_HTML_FILE = path.join(__dirname, 'verify-mobile.html');
const FRAMES_HTML_FILE = path.join(__dirname, 'frames-home.html'); // 3D frames shop + order
const PLACE_ORDER_HTML_FILE = path.join(__dirname, 'place-order.html');
const FRAME_DETAIL_HTML_FILE = path.join(__dirname, 'frame-detail.html');
const BOOK_SERVICE_HTML_FILE = path.join(__dirname, 'book-service-sample.html');
const ADD_MONEY_HTML_FILE = path.join(__dirname, 'add-money.html');
const PHOTO_ADJUST_HTML_FILE = path.join(__dirname, 'photo-adjust.html');
const PAYMENT_QR_FILE = path.join(__dirname, 'payment-qr.png');
const HTML_FILE = BOOK_NOW_HTML_FILE; // legacy alias
console.log('[boot] Using data dir:', DATA_DIR);

/* ========== MongoDB Atlas (optional) ==========
   Render Environment:
     MONGODB_URI = mongodb+srv://USER:PASS@cluster.../aditya?retryWrites=true&w=majority
   Agar MONGODB_URI set hai to saara data Atlas pe save hoga (Render wipe se safe).
   Agar nahi hai to pehle jaisa JSON files (local/demo).
*/
const MONGODB_URI = process.env.MONGODB_URI || '';
let mongoClient = null;
let mongoDb = null;
let useMongo = false;

async function initMongo() {
  let uri = (MONGODB_URI || '').trim().replace(/^["']|["']$/g, '');
  if (!uri) {
    console.log('[db] JSON file mode (MONGODB_URI nahi set)');
    return;
  }
  if (uri.includes('<') || uri.includes('db_password')) {
    console.error('[db] MONGODB_URI me placeholder password hai — real password lagao');
    return;
  }
  // ensure db name in path
  if (uri.includes('mongodb.net/?') && !uri.includes('mongodb.net/aditya_studio')) {
    uri = uri.replace('mongodb.net/?', 'mongodb.net/aditya_studio?');
    console.log('[db] URI me /aditya_studio auto-add kiya');
  }
  let hostPart = '(unknown)';
  try {
    hostPart = uri.split('@')[1].split('/')[0];
  } catch (e) {}
  console.log('[db] Connecting Atlas host:', hostPart);

  const { MongoClient } = require('mongodb');
  const attempts = [
    {
      name: 'ipv4+tls',
      opts: {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        tls: true,
        family: 4,
        retryWrites: true
      }
    },
    {
      name: 'ipv4-default',
      opts: {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        family: 4
      }
    },
    {
      name: 'default',
      opts: {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000
      }
    }
  ];

  let lastErr = null;
  for (const attempt of attempts) {
    try {
      console.log('[db] Try connect:', attempt.name);
      const client = new MongoClient(uri, attempt.opts);
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || 'aditya_studio');
      await db.command({ ping: 1 });
      mongoClient = client;
      mongoDb = db;
      useMongo = true;
      await mongoDb.collection('accounts').createIndex({ mobile: 1 }, { unique: true }).catch(() => {});
      await mongoDb.collection('codes').createIndex({ code: 1 }, { unique: true }).catch(() => {});
      console.log('[db] MongoDB Atlas CONNECTED ✅ database:', mongoDb.databaseName, 'via', attempt.name);
      return;
    } catch (e) {
      lastErr = e;
      console.error('[db] Attempt', attempt.name, 'fail:', e.message);
      try { /* ignore */ } catch (e2) {}
    }
  }

  console.error('[db] MongoDB connect FAIL — JSON fallback:', lastErr && lastErr.message);
  console.error('[db] FIX: Atlas → Network Access → Add IP → Allow Access from Anywhere (0.0.0.0/0)');
  console.error('[db] FIX: Database Access → user password reset → naya simple password (sirf a-z 0-9)');
  console.error('[db] FIX: Render MONGODB_URI = mongodb+srv://USER:PASS@HOST/aditya_studio?retryWrites=true&w=majority');
  useMongo = false;
}




/* In-memory cache — Mongo ya JSON se load, har save pe dono me write */
let _cache = {
  accounts: null,
  codes: null,
  otps: null,
  notifs: null,
  settings: null,
  frames: null,
  frameOrders: null
};

function normalizeAccount(a) {
  return {
    ...a,
    mobile: String(a.mobile || ''),
    pin: String(a.pin || '')
  };
}

function isPinHash(value) { return /^scrypt\$[a-f0-9]+\$[a-f0-9]+$/i.test(String(value || '')); }
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt + PIN_SALT, 32).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}
function verifyPin(acc, pin) {
  const saved = String(acc && acc.pin || '');
  if (!/^[0-9]{4}$/.test(String(pin || ''))) return false;
  if (!isPinHash(saved)) {
    const ok = crypto.timingSafeEqual(Buffer.from(saved.padEnd(4, '\0')), Buffer.from(String(pin).padEnd(4, '\0')));
    if (ok) acc.pin = hashPin(pin); // migrate a legacy account at its next correct login
    return ok;
  }
  const parts = saved.split('$');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(pin), parts[1] + PIN_SALT, 32);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function setPin(acc, pin) { acc.pin = hashPin(pin); }
function restoreSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const rows = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    if (!Array.isArray(rows)) return;
    rows.forEach(row => {
      if (row && row.token && row.mobile && Number(row.expiresAt) > now) {
        sessions.set(String(row.token), { mobile: String(row.mobile), expiresAt: Number(row.expiresAt) });
      }
    });
  } catch (e) { console.warn('session restore failed:', e.message); }
}
function saveSessions() {
  try {
    const now = Date.now();
    const rows = [];
    sessions.forEach((row, token) => {
      if (row && Number(row.expiresAt) > now) rows.push({ token, mobile: String(row.mobile), expiresAt: Number(row.expiresAt) });
    });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(rows), 'utf8');
  } catch (e) { console.warn('session save failed:', e.message); }
}
function issueSession(acc) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { mobile: String(acc.mobile), expiresAt: Date.now() + SESSION_TTL_MS });
  saveSessions();
  return token;
}
function sessionAccount(req, body, accounts) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = String((body && body.sessionToken) || bearer || '');
  const row = sessions.get(token);
  if (!row || row.expiresAt < Date.now()) { if (row) { sessions.delete(token); saveSessions(); } return null; }
  return accounts.find(a => String(a.mobile) === row.mobile) || null;
}
restoreSessions();
function requestNetworkKey(req) {
  // Render/Cloudflare proxy ka real visitor IP prefer karo; local mode me socket IP.
  const forwarded = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = (forwarded || String(req.socket.remoteAddress || 'unknown')).replace(/^::ffff:/, '');
  // Plain IP store nahi karte — sirf one-way comparison key store hoti hai.
  return crypto.createHash('sha256').update('aditya-studio-registration-network:v1:' + ip).digest('hex');
}
function clientKey(req, mobile) { return String(req.socket.remoteAddress || 'unknown') + ':' + String(mobile || ''); }
function rateLimited(req, mobile, limit, windowMs) {
  const key = clientKey(req, mobile), now = Date.now();
  const row = authAttempts.get(key);
  return !!(row && row.count >= limit && now - row.startedAt < windowMs);
}
function recordAuthFailure(req, mobile) {
  const key = clientKey(req, mobile), now = Date.now(), row = authAttempts.get(key);
  if (!row || now - row.startedAt > 15 * 60 * 1000) authAttempts.set(key, { count: 1, startedAt: now });
  else row.count++;
}
function clearAuthFailures(req, mobile) { authAttempts.delete(clientKey(req, mobile)); }

async function mongoLoadAccounts() {
  const rows = await mongoDb.collection('accounts').find({}).project({ _id: 0 }).toArray();
  return rows.map(normalizeAccount);
}
async function mongoSaveAccounts(accounts) {
  const col = mongoDb.collection('accounts');
  const ops = accounts.map(a => {
    const doc = normalizeAccount(a);
    return {
      updateOne: {
        filter: { mobile: doc.mobile },
        update: { $set: doc },
        upsert: true
      }
    };
  });
  if (ops.length) await col.bulkWrite(ops, { ordered: false });
  // remove deleted mobiles
  const mobiles = accounts.map(a => String(a.mobile));
  if (mobiles.length) {
    await col.deleteMany({ mobile: { $nin: mobiles } });
  } else {
    await col.deleteMany({});
  }
}

async function mongoLoadCodes() {
  return await mongoDb.collection('codes').find({}).project({ _id: 0 }).toArray();
}
async function mongoSaveCodes(codes) {
  const col = mongoDb.collection('codes');
  const ops = codes.map(c => ({
    updateOne: {
      filter: { code: String(c.code) },
      update: { $set: { ...c, code: String(c.code) } },
      upsert: true
    }
  }));
  if (ops.length) await col.bulkWrite(ops, { ordered: false });
  const list = codes.map(c => String(c.code));
  if (list.length) await col.deleteMany({ code: { $nin: list } });
  else await col.deleteMany({});
}

async function mongoLoadOtps() {
  return await mongoDb.collection('otp_requests').find({}).project({ _id: 0 }).toArray();
}
async function mongoSaveOtps(list) {
  const col = mongoDb.collection('otp_requests');
  await col.deleteMany({});
  if (list.length) await col.insertMany(list.map(r => ({ ...r })));
}

async function mongoLoadNotifs() {
  const doc = await mongoDb.collection('meta').findOne({ _id: 'notifications' });
  return (doc && Array.isArray(doc.items)) ? doc.items : [];
}
async function mongoSaveNotifs(list) {
  await mongoDb.collection('meta').updateOne(
    { _id: 'notifications' },
    { $set: { items: list.slice(0, 50) } },
    { upsert: true }
  );
}

async function mongoLoadSettings() {
  const doc = await mongoDb.collection('meta').findOne({ _id: 'settings' });
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}
async function mongoSaveSettings(obj) {
  await mongoDb.collection('meta').updateOne(
    { _id: 'settings' },
    { $set: { ...obj } },
    { upsert: true }
  );
}

function loadAccounts() {
  if (_cache.accounts) return _cache.accounts.map(normalizeAccount);
  if (!fs.existsSync(DATA_FILE)) { _cache.accounts = []; return []; }
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    _cache.accounts = (Array.isArray(data) ? data : []).map(normalizeAccount);
    return _cache.accounts.slice();
  } catch (e) {
    console.error('accounts read error:', e.message);
    _cache.accounts = [];
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
  _cache.accounts = accounts.map(normalizeAccount);
  const json = JSON.stringify(accounts, null, 2);
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    try { fs.writeFileSync(DATA_FILE, json, 'utf8'); } catch (e2) {}
  }
  try { writeCSV(accounts); } catch (e) { console.error('CSV error:', e.message); }
  if (useMongo) {
    mongoSaveAccounts(_cache.accounts).catch(e => console.error('mongo save accounts:', e.message));
  }
}

function loadCodes() {
  if (_cache.codes) return _cache.codes.slice();
  if (!fs.existsSync(CODES_FILE)) { _cache.codes = []; return []; }
  try {
    _cache.codes = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
    return _cache.codes.slice();
  } catch (e) { _cache.codes = []; return []; }
}
function saveCodes(codes) {
  _cache.codes = codes.slice();
  try { fs.writeFileSync(CODES_FILE, JSON.stringify(codes, null, 2), 'utf8'); } catch (e) {}
  if (useMongo) {
    mongoSaveCodes(codes).catch(e => console.error('mongo save codes:', e.message));
  }
}
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}
function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}
function hashOtp(otp) {
  return crypto.createHash('sha256').update(OTP_PEPPER + ':' + String(otp)).digest('hex');
}
function otpMatches(row, otp) {
  // Mobile-verification ka manual WhatsApp OTP admin queue me pehle se safely
  // pending rehta hai. Server restart par temporary hash pepper badal sakta tha,
  // jisse wahi correct OTP galat lag raha tha. Manual row me exact pending code
  // ko constant-time compare karo; OTP verify hote hi record close ho jayega.
  const manual = String(row && row.manualOtp || '');
  const supplied = String(otp || '');
  if (/^\d{6}$/.test(manual) && /^\d{6}$/.test(supplied)) {
    return crypto.timingSafeEqual(Buffer.from(manual), Buffer.from(supplied));
  }
  const expected = Buffer.from(String(row.otpHash || ''), 'hex');
  const actual = Buffer.from(hashOtp(otp), 'hex');
  return expected.length === actual.length && expected.length > 0 && crypto.timingSafeEqual(expected, actual);
}
async function sendOtpSms(mobile, otp, requestId) {
  if (!SMS_GATEWAY_URL || !SMS_GATEWAY_API_KEY) {
    const err = new Error('SMS gateway configured nahi hai');
    err.code = 'sms-not-configured';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(SMS_GATEWAY_URL + '/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': SMS_GATEWAY_API_KEY },
      body: JSON.stringify({
        phone_number: '+91' + mobile,
        message: 'Aditya Studio OTP: ' + otp + '. Yeh 5 minute tak valid hai. Kisi ke saath share na karein.',
        request_id: requestId
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false || data.success === false) {
      const err = new Error(data.error || data.message || ('SMS gateway HTTP ' + response.status));
      err.code = 'sms-send-failed';
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}
function loadOtpRequests() {
  if (_cache.otps) return _cache.otps.slice();
  try {
    if (!fs.existsSync(OTP_FILE)) { _cache.otps = []; return []; }
    _cache.otps = JSON.parse(fs.readFileSync(OTP_FILE, 'utf8'));
    return _cache.otps.slice();
  } catch (e) { _cache.otps = []; return []; }
}
function saveOtpRequests(list) {
  _cache.otps = list.slice();
  try {
    const tmp = OTP_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, OTP_FILE);
  } catch (e) {
    try { fs.writeFileSync(OTP_FILE, JSON.stringify(list, null, 2), 'utf8'); } catch (e2) {}
  }
  if (useMongo) {
    mongoSaveOtps(list).catch(e => console.error('mongo save otp:', e.message));
  }
}

function keepPendingOtpForAdmin(row, now) {
  if (!row || !row.otpHash) return false;
  if (row.verified) return true;
  // Mobile verification request ko kisi naye registration ke time delete mat karo.
  if (row.purpose === 'mobile_verify') return true;
  return !!(row.expiresAt && new Date(row.expiresAt).getTime() > now);
}

// Registration ke waqt ya purane account ke agle login par admin ke liye
// ek hi pending WhatsApp OTP rakho. User ko OTP kabhi response me nahi bheja jata.
function ensureAdminWhatsAppOtp(acc) {
  if (!acc || acc.mobileVerified || !/^[6-9]\d{9}$/.test(String(acc.mobile || ''))) return false;
  const now = Date.now();
  let list = loadOtpRequests().filter(r => keepPendingOtpForAdmin(r, now));
  const pending = list.find(r => r.mobile === acc.mobile && !r.verified && r.purpose === 'mobile_verify');
  if (pending) return false;
  const otp = generateOtp();
  list.unshift({
    mobile: acc.mobile, name: acc.name || '', id: acc.id || '', otpHash: hashOtp(otp),
    requestId: 'otp-' + acc.mobile + '-' + now, smsId: '', createdAt: new Date().toISOString(),
    expiresAt: new Date(now + MOBILE_VERIFY_OTP_TTL_MS).toISOString(), attempts: 0, verified: false,
    purpose: 'mobile_verify', manualOtp: otp, delivery: 'whatsapp_manual'
  });
  saveOtpRequests(list.slice(0, 100));
  return true;
}

/* ===== Free-spin fair bag (register users only) =====
   Har 100 spins:
     5  × Photo Frame
    10  × ₹30
    36  × ₹20
    49  × ₹10
   Bade prizes (₹50/100/500/1000) register free-spin me NAHI.
*/
function buildFreeSpinBag() {
  const items = [];
  // Har 100: 5 Frame, 10×₹30, 36×₹20, 49×₹10
  for (let i = 0; i < 5; i++) items.push({ key: 'frame', type: 'frame', value: 0, val: 'Photo', label: 'फ्री फोटो फ्रेम' });
  for (let i = 0; i < 10; i++) items.push({ key: '30', type: 'rupee', value: 30, val: '₹30', label: '₹30 डिस्काउंट' });
  for (let i = 0; i < 36; i++) items.push({ key: '20', type: 'rupee', value: 20, val: '₹20', label: '₹20 डिस्काउंट' });
  for (let i = 0; i < 49; i++) items.push({ key: '10', type: 'rupee', value: 10, val: '₹10', label: '₹10 डिस्काउंट' });
  // Fisher-Yates shuffle
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = items[i]; items[i] = items[j]; items[j] = t;
  }
  return items;
}

function loadFreeSpinBag() {
  if (useMongo && mongoDb) {
    // sync path uses cache file too
  }
  const file = path.join(DATA_DIR, 'free-spin-bag.json');
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && Array.isArray(data.remaining)) return data;
    }
  } catch (e) {}
  return { remaining: buildFreeSpinBag(), given: 0, batches: 1 };
}

function saveFreeSpinBag(bag) {
  const file = path.join(DATA_DIR, 'free-spin-bag.json');
  try {
    fs.writeFileSync(file, JSON.stringify(bag, null, 2));
  } catch (e) {}
  if (useMongo) {
    mongoDb.collection('meta').updateOne(
      { _id: 'freeSpinBag' },
      { $set: { remaining: bag.remaining, given: bag.given, batches: bag.batches } },
      { upsert: true }
    ).catch(() => {});
  }
}

async function hydrateFreeSpinBag() {
  if (!useMongo || !mongoDb) return;
  try {
    const doc = await mongoDb.collection('meta').findOne({ _id: 'freeSpinBag' });
    if (doc && Array.isArray(doc.remaining)) {
      saveFreeSpinBag({ remaining: doc.remaining, given: doc.given || 0, batches: doc.batches || 1 });
    }
  } catch (e) {}
}

function assignNextFreePrize() {
  let bag = loadFreeSpinBag();
  if (!bag.remaining || bag.remaining.length === 0) {
    bag.remaining = buildFreeSpinBag();
    bag.batches = (bag.batches || 0) + 1;
  }
  const prize = bag.remaining.shift();
  bag.given = (bag.given || 0) + 1;
  saveFreeSpinBag(bag);
  return { prize, stats: { given: bag.given, leftInBatch: bag.remaining.length, batch: bag.batches || 1 } };
}



/* ===== Work-spin fair bags (amount based) =====
   ₹500–₹1000 (100 spins):
     70 × ₹50 coupon
     10 × ₹100 coupon
      5 × Photo frame
      5 × Good luck
     10 × ₹30 coupon
*/
function buildWorkBag500_1000() {
  const items = [];
  for (let i = 0; i < 70; i++) items.push({ key: '50', type: 'coupon', value: 50, val: '₹50', label: '₹50 COUPON', sub: 'COUPON CODE' });
  for (let i = 0; i < 10; i++) items.push({ key: '100', type: 'coupon', value: 100, val: '₹100', label: '₹100 COUPON', sub: 'COUPON CODE' });
  for (let i = 0; i < 5; i++) items.push({ key: 'frame', type: 'frame', value: 0, val: 'Photo', label: 'फ्री फोटो फ्रेम', sub: 'FRAME' });
  for (let i = 0; i < 5; i++) items.push({ key: 'luck', type: 'luck', value: 0, val: 'Good', label: 'Good Luck', sub: 'LUCK' });
  for (let i = 0; i < 10; i++) items.push({ key: '30', type: 'coupon', value: 30, val: '₹30', label: '₹30 COUPON', sub: 'COUPON CODE' });
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = items[i]; items[i] = items[j]; items[j] = t;
  }
  return items;
}

function workBagKey(amount) {
  const a = Number(amount) || 0;
  if (a >= 500 && a <= 1000) return 'work_500_1000';
  if (a < 500) return 'work_under_500';
  return 'work_over_1000';
}

function buildWorkBagDefault() {
  // temporary defaults for other amounts — mostly small coupons
  const items = [];
  for (let i = 0; i < 50; i++) items.push({ key: '20', type: 'coupon', value: 20, val: '₹20', label: '₹20 COUPON', sub: 'COUPON CODE' });
  for (let i = 0; i < 30; i++) items.push({ key: '30', type: 'coupon', value: 30, val: '₹30', label: '₹30 COUPON', sub: 'COUPON CODE' });
  for (let i = 0; i < 15; i++) items.push({ key: '50', type: 'coupon', value: 50, val: '₹50', label: '₹50 COUPON', sub: 'COUPON CODE' });
  for (let i = 0; i < 5; i++) items.push({ key: 'luck', type: 'luck', value: 0, val: 'Good', label: 'Good Luck', sub: 'LUCK' });
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = items[i]; items[i] = items[j]; items[j] = t;
  }
  return items;
}

function loadWorkBag(key) {
  const file = path.join(DATA_DIR, 'work-spin-bags.json');
  let all = {};
  try {
    if (fs.existsSync(file)) all = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (e) {}
  if (!all[key] || !Array.isArray(all[key].remaining) || all[key].remaining.length === 0) {
    const remaining = key === 'work_500_1000' ? buildWorkBag500_1000() : buildWorkBagDefault();
    all[key] = { remaining, given: all[key] ? (all[key].given || 0) : 0, batches: (all[key] && all[key].batches) ? all[key].batches + 1 : 1 };
  }
  return { all, bag: all[key] };
}

function saveWorkBags(all) {
  const file = path.join(DATA_DIR, 'work-spin-bags.json');
  try { fs.writeFileSync(file, JSON.stringify(all, null, 2)); } catch (e) {}
  if (useMongo && mongoDb) {
    mongoDb.collection('meta').updateOne(
      { _id: 'workSpinBags' },
      { $set: { bags: all } },
      { upsert: true }
    ).catch(() => {});
  }
}

function assignWorkPrize(amount) {
  const key = workBagKey(amount);
  const { all, bag } = loadWorkBag(key);
  if (!bag.remaining.length) {
    bag.remaining = key === 'work_500_1000' ? buildWorkBag500_1000() : buildWorkBagDefault();
    bag.batches = (bag.batches || 0) + 1;
  }
  const prize = bag.remaining.shift();
  bag.given = (bag.given || 0) + 1;
  all[key] = bag;
  saveWorkBags(all);
  return { prize, stats: { key, given: bag.given, left: bag.remaining.length, batch: bag.batches || 1 } };
}


function pruneNotifs(list) {
  const now = Date.now();
  return (list || []).filter(n => {
    if (!n) return false;
    if (n.expiresAt && new Date(n.expiresAt).getTime() < now) return false;
    return true;
  });
}
function loadNotifs() {
  let list = [];
  if (_cache.notifs) list = _cache.notifs.slice();
  else {
    try {
      if (!fs.existsSync(NOTIF_FILE)) { _cache.notifs = []; return []; }
      list = JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8')) || [];
    } catch (e) { list = []; }
  }
  const pruned = pruneNotifs(list);
  // auto-save if expired removed
  if (pruned.length !== list.length) {
    _cache.notifs = pruned;
    try { fs.writeFileSync(NOTIF_FILE, JSON.stringify(pruned, null, 2)); } catch (e) {}
    if (useMongo) mongoSaveNotifs(pruned).catch(() => {});
  } else {
    _cache.notifs = pruned;
  }
  return pruned.slice();
}
function saveNotifs(list) {
  _cache.notifs = pruneNotifs(list).slice(0, 50);
  try { fs.writeFileSync(NOTIF_FILE, JSON.stringify(_cache.notifs, null, 2)); }
  catch (e) { console.error('saveNotifs', e.message); }
  if (useMongo) {
    mongoSaveNotifs(_cache.notifs).catch(e => console.error('mongo save notifs:', e.message));
  }
}
function loadUserActivity() {
  try { return fs.existsSync(ACTIVITY_FILE) ? (JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')) || []) : []; }
  catch (e) { return []; }
}
function saveUserActivity(list) {
  try { fs.writeFileSync(ACTIVITY_FILE, JSON.stringify((list || []).slice(0, 1200), null, 2)); } catch (e) { console.error('save activity', e.message); }
}
function defaultSettings() {
  return {
    // Default payment details. The QR image is kept with the project so it works
    // on localhost as well as after deployment.
    upiId: 'BHARATPE.9J0B0S0Y6I253580@unitype',
    upiQr: '/payment-qr.png',
    // Add the studio's 10-digit WhatsApp number here when available.
    helpWhatsapp: '',
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
    ],
    // Current Deals carousel: admin enables this after saving custom cards.
    homeDealsEnabled: false,
    homeDealsDurationSec: 20,
    // Colorful CTA button on the Register/Login landing page.
    loginPromo: {
      text: '🎀 Premium Photo Frames देखें / Order करें →',
      link: '/#sizes',
      colorA: '#8E2A38',
      colorB: '#D4AF37',
      textColor: '#FFF4C8'
    },
    // Home hero intro animation (sparkly text → then premium block)
    heroIntro: {
      welcomeText: 'Aditya Studio me aapka swagat hai',
      welcomeDurationSec: 5,
      eyebrow: 'Premium Photography',
      headline: 'Preserving Memories in',
      headlineGold: 'Aurelian Noir',
      headlineRest: 'Excellence',
      subtext: 'Exclusive bookings for Weddings, Birthdays, and Special Events. Experience high-end digital craftsmanship.',
      btnPrimary: 'Book a Session',
      btnSecondary: 'View Portfolio'
    },
    // 3D frames shop rotating sample photos (admin upload)
    frames3dPhotos: [],
    // Home page floating hero frame photos (max 5)
    homeHeroFramePhotos: [],
    // Hero SECTION background slideshow (sides visible) — admin 4–6 photos + duration
    heroSideBgPhotos: [],
    heroSideBgDurationSec: 5,
    fees: {
      platformFee: 10,
      deliveryFee: 40,
      platformMode: 'always',
      platformMinAmount: 0,
      deliveryMode: 'always',
      deliveryMinAmount: 0,
      deliveryFreeAbove: 500
    },
    qualityOptions: [
      { id: 'normal', label: 'Normal', sub: 'Standard print', extra: 0 },
      { id: 'lamination', label: 'Lamination', sub: 'Gloss protect', extra: 80 },
      { id: 'ntr', label: 'NTR Print', sub: 'Premium NTR', extra: 150 }
    ],
    adminUi: {
      // section id -> false means hidden
      hidden: {}
    }
  };
}
function loadSettings() {
  const defaults = defaultSettings();
  let data = null;
  if (_cache.settings) data = _cache.settings;
  else {
    try {
      if (fs.existsSync(SETTINGS_FILE)) data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) {}
  }
  if (!data) return defaults;
  _cache.settings = data;
  return {
    ...defaults,
    ...data,
    bookImages: { ...defaults.bookImages, ...(data.bookImages || {}) },
    offerImages: data.offerImages || defaults.offerImages,
    homeDealsEnabled: data.homeDealsEnabled === true,
    homeDealsDurationSec: Math.max(8, Math.min(60, Number(data.homeDealsDurationSec) || defaults.homeDealsDurationSec)),
    loginPromo: { ...defaults.loginPromo, ...(data.loginPromo || {}) },
    heroIntro: { ...defaults.heroIntro, ...(data.heroIntro || {}) },
    frames3dPhotos: Array.isArray(data.frames3dPhotos) ? data.frames3dPhotos : defaults.frames3dPhotos,
    homeHeroFramePhotos: Array.isArray(data.homeHeroFramePhotos) ? data.homeHeroFramePhotos : defaults.homeHeroFramePhotos,
    heroSideBgPhotos: Array.isArray(data.heroSideBgPhotos) ? data.heroSideBgPhotos : defaults.heroSideBgPhotos,
    heroSideBgDurationSec: Math.max(2, Math.min(20, Number(data.heroSideBgDurationSec) || defaults.heroSideBgDurationSec)),
    fees: { ...defaults.fees, ...(data.fees || {}) },
    qualityOptions: Array.isArray(data.qualityOptions) && data.qualityOptions.length
      ? data.qualityOptions.map((q, i) => ({
          id: String(q.id || ('q' + i)).slice(0, 40),
          label: String(q.label || 'Quality').slice(0, 60),
          sub: String(q.sub || '').slice(0, 80),
          extra: Math.max(0, Number(q.extra) || 0)
        }))
      : defaults.qualityOptions,
    adminUi: {
      hidden: Object.assign({}, (defaults.adminUi && defaults.adminUi.hidden) || {}, (data.adminUi && data.adminUi.hidden) || {})
    },
  };
}
function saveSettings(obj) {
  _cache.settings = obj;
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2)); }
  catch (e) { console.error('saveSettings', e.message); }
  if (useMongo) {
    mongoSaveSettings(obj).catch(e => console.error('mongo save settings:', e.message));
  }
}

/* ========== Photo Frames + Orders ========== */
const DEMO_FRAME_PRICES = {
  '8x12': 299, '10x12': 349, '10x15': 399, '12x15': 449, '12x18': 499, '12x36': 899,
  '16x20': 599, '16x24': 699, '20x24': 799, '20x30': 999, '20x40': 1299, '20x50': 1499,
  '24x36': 1399, '24x40': 1599, '24x50': 1899
};
function seedDemoFrames() {
  const list = Object.keys(DEMO_FRAME_PRICES).map((size, i) => ({
    id: 'demo-' + size,
    size,
    title: size + ' Frame',
    price: DEMO_FRAME_PRICES[size],
    discountPercent: 15,
    active: true,
    imageUrl: '',
    imageData: '',
    createdAt: new Date().toISOString()
  }));
  saveFrames(list);
  console.log('[frames] Seeded', list.length, 'demo frames with 15% discount');
  return list;
}
function loadFrames() {
  function stripDemos(list) {
    return (list || []).filter(f => {
      if (!f) return false;
      const id = String(f.id || '');
      if (id.startsWith('demo-')) return false;
      if (f.demo === true) return false;
      return true;
    });
  }
  if (_cache.frames) return stripDemos(_cache.frames).slice();
  try {
    if (fs.existsSync(FRAMES_FILE)) {
      _cache.frames = stripDemos(JSON.parse(fs.readFileSync(FRAMES_FILE, 'utf8')) || []);
      return _cache.frames.slice();
    }
  } catch (e) {}
  // No auto-seed dummy frames — only admin-uploaded frames show on site
  _cache.frames = [];
  return [];
}
function saveFrames(list) {
  _cache.frames = (list || []).slice();
  try { fs.writeFileSync(FRAMES_FILE, JSON.stringify(_cache.frames, null, 2)); } catch (e) {}
  if (useMongo && mongoDb) {
    mongoDb.collection('meta').updateOne(
      { _id: 'photoFrames' },
      { $set: { items: _cache.frames } },
      { upsert: true }
    ).catch(() => {});
  }
}
function loadFrameOrders() {
  if (_cache.frameOrders) return _cache.frameOrders.slice();
  try {
    if (fs.existsSync(FRAME_ORDERS_FILE)) {
      _cache.frameOrders = JSON.parse(fs.readFileSync(FRAME_ORDERS_FILE, 'utf8')) || [];
      return _cache.frameOrders.slice();
    }
  } catch (e) {}
  _cache.frameOrders = [];
  return [];
}
function saveFrameOrders(list) {
  _cache.frameOrders = (list || []).slice();
  try { fs.writeFileSync(FRAME_ORDERS_FILE, JSON.stringify(_cache.frameOrders, null, 2)); } catch (e) {}
  if (useMongo && mongoDb) {
    mongoDb.collection('meta').updateOne(
      { _id: 'frameOrders' },
      { $set: { items: _cache.frameOrders } },
      { upsert: true }
    ).catch(() => {});
  }
}
function nextFrameOrderId(orders) {
  return 'FO-' + String((orders.length || 0) + 1).padStart(4, '0') + '-' + Date.now().toString(36).slice(-4).toUpperCase();
}
function loadEditRequests() {
  if (_cache.editRequests) return _cache.editRequests.slice();
  try {
    if (fs.existsSync(EDIT_REQUESTS_FILE)) {
      _cache.editRequests = JSON.parse(fs.readFileSync(EDIT_REQUESTS_FILE, 'utf8')) || [];
      return _cache.editRequests.slice();
    }
  } catch (e) {}
  _cache.editRequests = [];
  return [];
}
function saveEditRequests(list) {
  _cache.editRequests = (list || []).slice();
  try { fs.writeFileSync(EDIT_REQUESTS_FILE, JSON.stringify(_cache.editRequests, null, 2)); } catch (e) {}
}
function nextEditRequestId(list) {
  return 'ER-' + String((list.length || 0) + 1).padStart(4, '0') + '-' + Date.now().toString(36).slice(-4).toUpperCase();
}
function loadWalletTopups() {
  try { return fs.existsSync(WALLET_TOPUPS_FILE) ? (JSON.parse(fs.readFileSync(WALLET_TOPUPS_FILE, 'utf8')) || []) : []; }
  catch (e) { return []; }
}
function saveWalletTopups(list) {
  fs.writeFileSync(WALLET_TOPUPS_FILE, JSON.stringify(list || [], null, 2));
}

function nextCustomerId(accounts) {
  return 'AS-' + String(accounts.length + 1).padStart(4, '0');
}
function todayIST() {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}
function publicTokenFields(acc) {
  const adTokens = Math.max(0, Number(acc.adTokens) || 0);
  const spinBalance = Math.max(0, Number(acc.spinBalance) || 0);
  const lastAdTokenClaim = acc.lastAdTokenClaim || '';
  const canClaimAdToken = lastAdTokenClaim !== todayIST();
  return { adTokens, spinBalance, canClaimAdToken, lastAdTokenClaim };
}

/* ===== Wallet helpers ===== */
function ensureWallet(acc) {
  if (typeof acc.walletBalance !== 'number' || isNaN(acc.walletBalance)) acc.walletBalance = 0;
  if (typeof acc.walletPendingBalance !== 'number' || isNaN(acc.walletPendingBalance)) acc.walletPendingBalance = 0;
  if (!Array.isArray(acc.walletHistory)) acc.walletHistory = [];
  return acc;
}
// Promo/coupon money is valid for 30 days. Recharge money is deliberately
// never included here, so it can never disappear due to this expiry rule.
function expireWalletPromos(acc) {
  ensureWallet(acc);
  let changed = false;
  const now = Date.now();
  for (const item of acc.walletHistory) {
    const left = Math.max(0, Number(item.promoRemaining) || 0);
    if (!left || !item.expiresAt || new Date(item.expiresAt).getTime() > now) continue;
    const removed = Math.min(Math.max(0, Number(acc.walletBalance) || 0), left);
    acc.walletBalance = Math.max(0, Number(acc.walletBalance) - removed);
    item.promoRemaining = 0;
    item.expiredAt = new Date().toISOString();
    acc.walletHistory.unshift({ id: walletHistoryId(), type: 'expired', amount: left, balanceAfter: acc.walletBalance, reason: 'Promo wallet credit expired after 30 days', source: 'coupon_expiry', ref: item.ref || item.couponId || '', timestamp: item.expiredAt });
    changed = true;
  }
  return changed;
}
function activePromoWallet(acc) {
  expireWalletPromos(acc);
  return (acc.walletHistory || []).filter(item => item.expiresAt && Number(item.promoRemaining) > 0 && new Date(item.expiresAt).getTime() > Date.now()).map(item => ({ amount: Number(item.promoRemaining), expiresAt: item.expiresAt, reason: item.reason || 'Promo credit' }));
}
function walletHistoryId() {
  return 'WH-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}
/** Credit/debit wallet. amount > 0. Returns entry or null if debit fails. */
function walletTxn(acc, type, amount, meta) {
  ensureWallet(acc);
  expireWalletPromos(acc);
  amount = Math.round(Number(amount) || 0);
  if (amount <= 0) return null;
  if (type === 'debit' && acc.walletBalance < amount) return null;
  if (type === 'credit') acc.walletBalance += amount;
  else {
    let left = amount;
    for (const promo of acc.walletHistory.filter(item => item.expiresAt && Number(item.promoRemaining) > 0 && new Date(item.expiresAt).getTime() > Date.now())) {
      const used = Math.min(left, Number(promo.promoRemaining) || 0);
      promo.promoRemaining -= used;
      left -= used;
      if (!left) break;
    }
    acc.walletBalance -= amount;
  }
  const entry = {
    id: walletHistoryId(),
    type: type === 'debit' ? 'debit' : 'credit',
    amount,
    balanceAfter: acc.walletBalance,
    reason: (meta && meta.reason) || (type === 'credit' ? 'Credit' : 'Debit'),
    source: (meta && meta.source) || 'system',
    ref: (meta && meta.ref) || '',
    couponId: (meta && meta.couponId) || null,
    orderId: (meta && meta.orderId) || null,
    byAdmin: !!(meta && meta.byAdmin),
    timestamp: new Date().toISOString()
  };
  if (type === 'credit' && meta && meta.expiresAt) { entry.expiresAt = meta.expiresAt; entry.promoRemaining = amount; }
  acc.walletHistory.unshift(entry);
  if (acc.walletHistory.length > 200) acc.walletHistory = acc.walletHistory.slice(0, 200);
  return entry;
}
/** Extract ₹ value from a spin/coupon history entry */
function couponRupeeValue(h) {
  if (!h) return 0;
  const d = Number(h.discount);
  if (!isNaN(d) && d > 0) return Math.round(d);
  const v = Number(h.value);
  if (!isNaN(v) && v > 0) return Math.round(v);
  const m = String(h.prize || h.label || h.val || '').match(/₹\s*(\d+)/);
  if (m) return Math.round(Number(m[1]));
  return 0;
}

function accountPublicPayload(acc) {
  ensureWallet(acc);
  expireWalletPromos(acc);
  return {
    ok: true,
    id: acc.id,
    name: acc.name,
    village: acc.village,
    mobile: acc.mobile,
    history: publicHistory(acc),
    mobileVerified: !!acc.mobileVerified,
    verificationOtpSentAt: acc.verificationOtpSentAt || '',
    badge: acc.badge || null,
    totalSpend: acc.totalSpend || 0,
    freeSpinUsed: !!acc.freeSpinUsed,
    walletBalance: acc.walletBalance || 0,
    walletPendingBalance: acc.walletPendingBalance || 0,
    walletHistory: (acc.walletHistory || []).slice(0, 30),
    promoWalletCredits: activePromoWallet(acc),
    ...publicTokenFields(acc)
  };
}

function publicHistory(acc) {
  return (acc.history || [])
    .filter(h => h.couponStatus !== 'deleted')
    .map(h => ({
      amount: h.amount, tier: h.tier, discount: h.discount,
      prize: h.prize, freeSpin: h.freeSpin, timestamp: h.timestamp, entryId: h.entryId,
      couponId: h.couponId || h.entryId || null,
      couponStatus: h.couponStatus || 'active',
      expiresAt: h.expiresAt || null,
      acceptedAt: h.acceptedAt || null,
      walletValue: couponRupeeValue(h)
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
function readBody(req, maxBytes) {
  const limit = maxBytes || 2e6;
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit) reject(new Error('too large')); });
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
function adminCookieToken() {
  return crypto.createHmac('sha256', ADMIN_PASSWORD || 'disabled').update('aditya-studio-admin-local').digest('hex');
}
function hasAdminCookie(req) {
  const cookies = String(req.headers.cookie || '').split(';').map(v => v.trim());
  const row = cookies.find(v => v.startsWith('aditya_admin_session='));
  if (!row || !ADMIN_PASSWORD) return false;
  const token = row.slice('aditya_admin_session='.length);
  const expected = adminCookieToken();
  const given = Buffer.from(token, 'utf8'), wanted = Buffer.from(expected, 'utf8');
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}
function hasAdminBasicAuth(req) {
  if (!ADMIN_PASSWORD) return false;
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const pass = decoded.split(':').slice(1).join(':');
  const expected = Buffer.from(ADMIN_PASSWORD, 'utf8');
  const provided = Buffer.from(pass, 'utf8');
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}
function isAdminAuthed(req) { return hasAdminCookie(req) || hasAdminBasicAuth(req); }
function establishAdminSession(req, res) {
  if (hasAdminBasicAuth(req)) {
    res.setHeader('Set-Cookie', 'aditya_admin_session=' + adminCookieToken() + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800');
  }
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
// Har customer page me add hone wala lightweight live-sync. Page tabhi reload hota
// hai jab server data sach me badla ho; typing/select ke waqt reload hold rehta hai.
const LIVE_SYNC_SNIPPET = `<script>(function(){
  var revision='', queued=false, timer=null;
  var scrollKey='aditya_live_scroll:'+location.pathname+location.search;
  try{var saved=Number(sessionStorage.getItem(scrollKey)||0);if(saved){setTimeout(function(){window.scrollTo(0,saved);sessionStorage.removeItem(scrollKey);},60)}}catch(e){}
  function editing(){var el=document.activeElement;return !!(el&&/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));}
  function apply(){if(editing()){queued=true;return;}try{sessionStorage.setItem(scrollKey,String(window.scrollY||0))}catch(e){}window.dispatchEvent(new CustomEvent('aditya:live-update'));setTimeout(function(){location.reload()},120);}
  function check(){fetch('/api/live-revision',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){if(!d||!d.ok)return;if(!revision){revision=d.revision;return;}if(revision!==d.revision){revision=d.revision;apply();}}).catch(function(){});}
  document.addEventListener('focusout',function(){if(queued){queued=false;setTimeout(check,300)}});
  setTimeout(check,1200);timer=setInterval(check,12000);
})();</script>`;
function serveLiveHtml(res, data) {
  const html = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
  res.end(html.replace(/<\/body>/i, LIVE_SYNC_SNIPPET + '</body>'));
}
function liveRevision() {
  // Activity heartbeat ko jaanbujhkar include nahi karte, warna har visitor ke
  // normal page-view se sabke pages repeatedly reload ho jayenge.
  const files = [DATA_FILE, SETTINGS_FILE, FRAME_ORDERS_FILE, NOTIF_FILE, WALLET_TOPUPS_FILE, CODES_FILE, FRAMES_FILE, EDIT_REQUESTS_FILE];
  return files.map(file => { try { return path.basename(file) + ':' + Math.floor(fs.statSync(file).mtimeMs); } catch (e) { return path.basename(file) + ':0'; } }).join('|');
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  // Relative "admin" link kisi bhi page (jaise /place-order.html) se khulne par
  // browser /place-order.html/admin bana deta hai. Use hamesha root admin par bhejo.
  if (req.method === 'GET' && urlPath !== '/admin' && /\/admin\/?$/.test(urlPath)) {
    res.writeHead(302, { Location: '/admin' });
    return res.end();
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // New luxury homepage (Artisan Collection)
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    fs.readFile(INDEX_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('index.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
      serveLiveHtml(res, data);
    });
    return;
  }

  if (req.method === 'GET' && (urlPath === '/my-orders' || urlPath === '/my-orders.html')) {
    fs.readFile(MY_ORDERS_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('My Orders page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
      serveLiveHtml(res, data);
    });
    return;
  }

  if (req.method === 'GET' && (urlPath === '/spin' || urlPath === '/spin-roller')) {
    // `/spin` is the one real, customized roller.  The small standalone
    // spin-roller.html was only a temporary/demo wheel and must not be shown.
    fs.readFile(BOOK_NOW_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Main spin roller page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
      serveLiveHtml(res, data);
    });
    return;
  }

  // Footer information pages use one local template with the appropriate content.
  if (req.method === 'GET' && ['/privacy-policy', '/terms-of-service', '/careers', '/contact-us'].includes(urlPath)) {
    fs.readFile(LEGAL_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Information page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
      serveLiveHtml(res, data);
    });
    return;
  }

  // Old home page — BOOK NOW
  if (req.method === 'GET' && (urlPath === '/book-now' || urlPath === '/book-now.html' || urlPath === '/aditya-studio-discount-wheel.html')) {
    fs.readFile(BOOK_NOW_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Book Now page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
      serveLiveHtml(res, data);
    });
    return;
  }

  if (req.method === 'GET' && (urlPath === '/verify-mobile' || urlPath === '/verify-mobile.html')) {
    fs.readFile(VERIFY_MOBILE_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Verify page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      serveLiveHtml(res, data);
    });
    return;
  }

  if (req.method === 'GET' && (urlPath === '/photo-frames.html' || urlPath === '/photo-frames' || urlPath === '/frames')) {
    fs.readFile(FRAMES_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Photo Frames page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      serveLiveHtml(res, data);
    });
    return;
  }

  if (req.method === 'GET' && (urlPath === '/place-order.html' || urlPath === '/place-order')) {
    fs.readFile(PLACE_ORDER_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Place order page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      serveLiveHtml(res, data);
    });
    return;
  }

  if (req.method === 'GET' && (urlPath === '/add-money' || urlPath === '/add-money.html')) {
    fs.readFile(ADD_MONEY_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('add-money.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); serveLiveHtml(res, data);
    });
    return;
  }

  if (req.method === 'GET' && (urlPath === '/photo-adjust' || urlPath === '/photo-adjust.html')) {
    fs.readFile(PHOTO_ADJUST_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('photo-adjust.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); serveLiveHtml(res, data);
    });
    return;
  }

  if (req.method === 'GET' && (urlPath === '/frame-detail.html' || urlPath === '/frame-detail')) {
    fs.readFile(FRAME_DETAIL_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Frame detail page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      serveLiveHtml(res, data);
    });
    return;
  }

  // Service booking form (?service=wedding|birthday|event|baby|studio|pvt|reel|other)
  if (req.method === 'GET' && (urlPath === '/book' || urlPath === '/book-service' || urlPath === '/book-service-sample.html')) {
    fs.readFile(BOOK_SERVICE_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Book service page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      serveLiveHtml(res, data);
    });
    return;
  }

  // Studio payment QR supplied by the owner.
  if (req.method === 'GET' && urlPath === '/payment-qr.png') {
    return fs.readFile(PAYMENT_QR_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Payment QR missing'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
      res.end(data);
    });
  }

  // ---- Public APIs ----
  if (req.method === 'GET' && urlPath === '/api/live-revision') {
    return sendJSON(res, 200, { ok: true, revision: liveRevision() });
  }
  if (req.method === 'GET' && urlPath === '/api/settings') {
    return sendJSON(res, 200, { ok: true, settings: loadSettings() });
  }
  if (req.method === 'GET' && urlPath === '/api/notifications') {
    return sendJSON(res, 200, { ok: true, items: loadNotifs() });
  }
  // Customer notifications are private: a logged-in user can receive only
  // their own order updates plus messages sent to every customer.
  if (req.method === 'POST' && urlPath === '/api/my-notifications') {
    try {
      const body = await readBody(req, 30000);
      const accounts = loadAccounts();
      const account = sessionAccount(req, body, accounts);
      if (!account) return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Login required' });
      const mobile = String(account.mobile || '');
      const items = loadNotifs().filter(n => !n.mobile || String(n.mobile) === mobile).slice(0, 30);
      return sendJSON(res, 200, { ok: true, items });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  /* ---- Photo Frames public APIs ---- */
  if (req.method === 'GET' && urlPath === '/api/frames') {
    const frames = loadFrames().map(f => ({
      id: f.id, size: f.size, availableSizes: Array.isArray(f.availableSizes) && f.availableSizes.length ? f.availableSizes : [f.size], title: f.title, price: f.price,
      discountPercent: f.discountPercent || 0, active: f.active !== false,
      imageUrl: f.imageUrl || '', imageData: f.imageData || '', createdAt: f.createdAt
    }));
    return sendJSON(res, 200, { ok: true, frames });
  }
  if (req.method === 'GET' && urlPath === '/api/fees') {
    const f = loadSettings().fees || {};
    return sendJSON(res, 200, {
      ok: true,
      platformFee: f.platformFee, deliveryFee: f.deliveryFee,
      platformMode: f.platformMode, deliveryMode: f.deliveryMode,
      platformMin: f.platformMinAmount, deliveryMin: f.deliveryMinAmount,
      deliveryFreeAbove: f.deliveryFreeAbove,
      platform: f.platformFee, delivery: f.deliveryFee
    });
  }

  // Browser uploads customer photos straight to the private R2 bucket. The
  // server returns only a short-lived, single-object upload URL, so large
  // images never travel through or get stored in this Node server.
  if (req.method === 'POST' && urlPath === '/api/r2/frame-photo-upload') {
    try {
      if (!r2Ready()) return sendJSON(res, 503, { ok: false, error: 'r2-not-configured', message: 'Photo storage abhi configured nahi hai' });
      const body = await readBody(req, 20000);
      const mobile = String(body.mobile || '').replace(/\D/g, '');
      const account = sessionAccount(req, body, loadAccounts());
      if (!account || String(account.mobile) !== mobile) {
        return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Photo upload ke liye account login zaroori hai' });
      }
      const type = String(body.contentType || '').toLowerCase();
      const ext = ({ 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[type];
      if (!ext) return sendJSON(res, 400, { ok: false, error: 'invalid-image', message: 'Sirf JPG, PNG ya WEBP photo upload karein' });
      const objectKey = 'customer-photos/' + mobile + '/' + Date.now() + '-' + crypto.randomBytes(10).toString('hex') + '.' + ext;
      return sendJSON(res, 200, {
        ok: true,
        key: objectKey,
        uploadUrl: r2PresignedUrl('PUT', objectKey, 600),
        expiresIn: 600
      });
    } catch (e) {
      console.error('r2 photo presign', e.message);
      return sendJSON(res, 500, { ok: false, error: 'r2-upload-error', message: 'Photo upload link nahi ban saka' });
    }
  }

  // Fallback for a bucket whose CORS policy has not propagated yet. The photo
  // is forwarded to R2 immediately and is never written to this server disk.
  if (req.method === 'POST' && urlPath === '/api/r2/frame-photo-proxy') {
    try {
      if (!r2Ready()) return sendJSON(res, 503, { ok: false, error: 'r2-not-configured' });
      const body = await readBody(req, 6e6);
      const mobile = String(body.mobile || '').replace(/\D/g, '');
      const account = sessionAccount(req, body, loadAccounts());
      if (!account || String(account.mobile) !== mobile) return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Login session valid nahi hai' });
      const dataUrl = String(body.dataUrl || '');
      const match = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
      if (!match) return sendJSON(res, 400, { ok: false, error: 'invalid-image', message: 'Photo format sahi nahi hai' });
      const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) return sendJSON(res, 400, { ok: false, error: 'photo-too-large', message: 'Photo 4 MB se chhoti honi chahiye' });
      const type = match[1].toLowerCase();
      const ext = ({ 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[type];
      const key = 'customer-photos/' + mobile + '/' + Date.now() + '-' + crypto.randomBytes(10).toString('hex') + '.' + ext;
      const put = await fetch(r2PresignedUrl('PUT', key, 600), { method: 'PUT', headers: { 'Content-Type': type }, body: bytes });
      if (!put.ok) {
        const detail = (await put.text().catch(() => '')).match(/<Code>([^<]+)<\/Code>/i);
        const safeCode = detail ? detail[1] : ('HTTP ' + put.status);
        console.error('r2 proxy put failed:', put.status, safeCode);
        return sendJSON(res, 502, { ok: false, error: 'r2-upload-failed', message: 'Cloud storage rejected upload: ' + safeCode });
      }
      return sendJSON(res, 200, { ok: true, key });
    } catch (e) {
      console.error('r2 photo proxy', e.message);
      return sendJSON(res, 500, { ok: false, error: 'r2-upload-error', message: 'Photo upload fail hua' });
    }
  }


function computeOrderFees(subtotal, settingsFees) {
  const f = Object.assign({
    platformFee: 10, deliveryFee: 40,
    platformMode: 'always', platformMinAmount: 0,
    deliveryMode: 'always', deliveryMinAmount: 0, deliveryFreeAbove: 500
  }, settingsFees || {});
  const sub = Math.max(0, Number(subtotal) || 0);
  let platform = Math.max(0, Number(f.platformFee) || 0);
  let delivery = Math.max(0, Number(f.deliveryFee) || 0);
  const pMode = String(f.platformMode || 'always');
  const dMode = String(f.deliveryMode || 'always');
  if (pMode === 'never') platform = 0;
  else if (pMode === 'above_amount' && sub < (Number(f.platformMinAmount) || 0)) platform = 0;
  if (dMode === 'never') delivery = 0;
  else if (dMode === 'free_above' && sub >= (Number(f.deliveryFreeAbove) || 0)) delivery = 0;
  else if (dMode === 'above_amount' && sub < (Number(f.deliveryMinAmount) || 0)) delivery = 0;
  return { platformFee: platform, deliveryFee: delivery, rules: f };
}

  if (req.method === 'POST' && (urlPath === '/api/frame-order' || urlPath === '/api/orders')) {
    try {
      const body = await readBody(req, 9e6);
      const name = String(body.name || '').trim();
      const mobile = String(body.mobile || '').trim();
      const village = String(body.village || '').trim();
      const address = String(body.address || '').trim();
      const pincode = String(body.pincode || '').trim();
      const district = String(body.district || '').trim();
      const state = String(body.state || '').trim();
      const note = String(body.note || '').trim();
      const frameId = String(body.frameId || '').trim();
      if (!name || !/^[6-9]\d{9}$/.test(mobile) || address.length < 5) {
        return sendJSON(res, 400, { ok: false, error: 'invalid', message: 'Name, mobile, address zaroori hai' });
      }
      const accounts = loadAccounts();
      const account = sessionAccount(req, body, accounts);
      if (!account || String(account.mobile) !== mobile) {
        return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Apne account se login karke order submit karein' });
      }
      if (pincode && !/^\d{6}$/.test(pincode)) {
        return sendJSON(res, 400, { ok: false, error: 'invalid', message: 'Pincode 6 digit hona chahiye' });
      }
      const frames = loadFrames();
      let frame = frames.find(f => f.id === frameId && f.active !== false)
        || frames.find(f => f.id === frameId);
      if (!frame) {
        const title = String(body.frameName || body.frameTitle || body.title || '').trim();
        const size = String(body.size || '').trim();
        if (!title && !size) {
          return sendJSON(res, 404, { ok: false, error: 'frame-not-found', message: 'Frame nahi mila' });
        }
        frame = {
          id: frameId || ('FR-custom-' + Date.now()),
          title: title || 'Photo Frame',
          size: size || '—',
          price: Number(body.mrp || body.price || body.framePrice) || 0,
          discountPercent: Number(body.discount) || 0,
          active: true
        };
      }
      const price = Number(frame.price) || 0;
      const disc = Number(frame.discountPercent) || 0;
      const qualityExtra = Math.max(0, Number(body.qualityExtra) || 0);
      const frameAfterDisc = Math.round(price * (1 - disc / 100));
      const subtotal = frameAfterDisc + qualityExtra;
      const feeCalc = computeOrderFees(subtotal, (loadSettings().fees || {}));
      const platformFee = feeCalc.platformFee;
      const deliveryFee = feeCalc.deliveryFee;
      let finalAmount = subtotal + platformFee + deliveryFee;
      const orders = loadFrameOrders();
      const orderId = nextFrameOrderId(orders);
      const useWallet = body.useWallet === true || body.useWallet === 'true';
      const utr = String(body.utr || '').trim().slice(0, 40);
      const paymentScreenshotRaw = String(body.paymentScreenshot || '');
      const paymentScreenshot = paymentScreenshotRaw.slice(0, 3e6);
      // UTR and screenshot are customer payment proof. They are not payment
      // confirmation — only an admin can set paymentStatus to confirmed.
      if (utr && !/^[A-Za-z0-9-]{6,40}$/.test(utr)) {
        return sendJSON(res, 400, { ok: false, error: 'invalid-utr', message: 'UTR / transaction ID sahi format mein daalein' });
      }
      if (paymentScreenshot && !/^data:image\/(png|jpe?g|webp);base64,/i.test(paymentScreenshot)) {
        return sendJSON(res, 400, { ok: false, error: 'invalid-screenshot', message: 'Sirf PNG, JPG ya WEBP payment screenshot upload karein' });
      }
      if (paymentScreenshotRaw.length > 3e6) {
        return sendJSON(res, 400, { ok: false, error: 'screenshot-too-large', message: 'Payment screenshot 2 MB se chhota upload karein' });
      }
      if (!utr && !paymentScreenshot && !useWallet) {
        return sendJSON(res, 400, { ok: false, error: 'payment-proof-required', message: 'Order submit karne se pehle UTR ya payment screenshot zaroori hai' });
      }
      const paymentClaimed = !!(utr || paymentScreenshot);
      // Customer uploaded photo for the frame (base64) — admin can download
      const customerPhotoRaw = String(body.customerPhoto || body.userPhoto || '');
      const customerPhotoKey = String(body.customerPhotoKey || '').trim();
      if (customerPhotoRaw.length > 5e6 || (customerPhotoRaw && !/^data:image\/(png|jpe?g|webp);base64,/i.test(customerPhotoRaw))) {
        return sendJSON(res, 400, { ok: false, error: 'invalid-photo', message: 'Customer photo PNG, JPG ya WEBP format mein 3 MB se chhoti honi chahiye' });
      }
      if (customerPhotoKey && !isSafeR2PhotoKey(customerPhotoKey, mobile)) {
        return sendJSON(res, 400, { ok: false, error: 'invalid-photo-key', message: 'Photo upload verify nahi hua' });
      }
      // r2: prefix keeps old base64 orders compatible while new orders contain
      // only a tiny private object key in the database.
      const customerPhoto = customerPhotoKey ? ('r2:' + customerPhotoKey) : customerPhotoRaw;
      let walletPaid = 0;
      let paymentStatus = paymentClaimed ? 'paid_claimed' : 'unpaid';
      // Wallet pay (partial or full)
      if (useWallet) {
        ensureWallet(account);
        const want = Math.min(account.walletBalance, finalAmount);
        if (want > 0) {
          const txn = walletTxn(account, 'debit', want, {
              reason: 'Frame order ' + orderId + ' — ' + (frame.title || frame.size),
              source: 'frame_order',
              orderId,
              ref: orderId
            });
          if (txn) {
            walletPaid = want;
            finalAmount = finalAmount - walletPaid;
            saveAccounts(accounts);
            if (finalAmount <= 0) {
              finalAmount = 0;
              paymentStatus = 'confirmed';
            } else if (walletPaid > 0) {
              paymentStatus = paymentClaimed ? 'paid_claimed' : 'partial_wallet';
            }
          }
        }
      }
      const trackingNumber = 'TRK-' + orderId.replace(/^FO-/, '');
      const order = {
        orderId, trackingNumber, frameId: frame.id, frameTitle: frame.title || '', size: frame.size,
        price, discountPercent: disc,
        qualityExtra, qualityLabel: String(body.qualityLabel || '').slice(0, 40),
        platformFee, deliveryFee,
        colourName: String(body.colourName || '').slice(0, 40),
        orientation: String(body.orientation || '').slice(0, 20),
        finalAmount: finalAmount + walletPaid,
        amountDue: finalAmount,
        walletPaid,
        name, mobile, village, address, pincode, district, state, note,
        status: 'processing',
        paymentStatus,
        paymentSubmittedAt: paymentClaimed ? new Date().toISOString() : '',
        utr: utr || '',
        paymentScreenshot: paymentScreenshot || '',
        customerPhoto: customerPhoto || '',
        adminAlert: true,
        deliveryDate: '', deliveryTime: '', adminNote: '',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      orders.unshift(order);
      saveFrameOrders(orders);
      // customer notification
      const notifs = loadNotifs();
      notifs.unshift({
        id: 'n-' + Date.now(),
        title: '📦 Order Received — ' + orderId,
        body: (frame.title || 'Photo Frame') + ' (' + frame.size + ') · Total ₹' + (finalAmount + walletPaid)
          + (walletPaid ? (' · Wallet −₹' + walletPaid) : '')
          + (finalAmount > 0 ? (' · Due ₹' + finalAmount) : ' · Paid via Wallet')
          + ' · Status: Processing · Payment: ' + paymentStatus,
        at: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        mobile: mobile
      });
      saveNotifs(notifs.slice(0, 50));
      void sendTelegramAlert('New Frame Order', 'Order: ' + orderId + '\nCustomer: ' + (order.name || mobile) + ' · ' + mobile + '\nFrame: ' + (frame.title || frame.size) + '\nTotal: ₹' + order.finalAmount + '\nPayment: ' + paymentStatus);
      console.log('Frame order:', orderId, mobile, frame.size, 'total', order.finalAmount, 'wallet', walletPaid, 'due', finalAmount, paymentStatus);
      return sendJSON(res, 200, {
        ok: true, orderId, trackingNumber: order.trackingNumber,
        finalAmount: order.finalAmount,
        amountDue: finalAmount,
        walletPaid,
        status: order.status,
        paymentStatus: order.paymentStatus
      });
    } catch (e) {
      console.error('frame-order', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/my-frame-orders') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile)) return sendJSON(res, 400, { ok: false, error: 'invalid-mobile' });
      const account = sessionAccount(req, body, loadAccounts());
      if (!account || String(account.mobile) !== mobile) return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Login required' });
      const orders = loadFrameOrders().filter(o => String(o.mobile) === mobile);
      return sendJSON(res, 200, { ok: true, orders });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  // Lightweight customer analytics. Only page/action labels are stored; never form text, PIN, UTR or payment data.
  if (req.method === 'POST' && urlPath === '/api/activity') {
    try {
      const body = await readBody(req, 20000);
      const accounts = loadAccounts();
      const acc = sessionAccount(req, body, accounts);
      if (!acc) return sendJSON(res, 401, { ok:false, error:'auth' });
      const page = String(body.page || '/').slice(0, 80).replace(/[^a-zA-Z0-9_\-/.?=]/g, '');
      const action = String(body.action || 'page_view').slice(0, 80).replace(/[^a-zA-Z0-9_\-/. ]/g, '');
      const list = loadUserActivity();
      const now = new Date().toISOString();
      let row = list.find(x => String(x.mobile) === String(acc.mobile));
      if (!row) { row = { mobile:acc.mobile, name:acc.name||'', totalSeconds:0, lastSeenAt:now, lastPage:page, events:[] }; list.unshift(row); }
      const prev = new Date(row.lastSeenAt || 0).getTime();
      const gap = Date.now() - prev;
      if (gap > 0 && gap < 90000) row.totalSeconds = Number(row.totalSeconds || 0) + Math.round(gap / 1000);
      row.name = acc.name || row.name || ''; row.lastSeenAt = now; row.lastPage = page;
      if (action !== 'heartbeat') row.events = [{ at:now, page, action }].concat(row.events || []).slice(0, 80);
      saveUserActivity(list);
      return sendJSON(res, 200, { ok:true });
    } catch (e) { return sendJSON(res, 500, { ok:false }); }
  }

  // Photo editing request — up to 10 photos
  if (req.method === 'POST' && urlPath === '/api/edit-request') {
    try {
      const body = await readBody(req, 25e6);
      const name = String(body.name || '').trim();
      const mobile = String(body.mobile || '').trim();
      const note = String(body.note || '').trim();
      const photosIn = Array.isArray(body.photos) ? body.photos : [];
      if (!name || !/^[6-9]\d{9}$/.test(mobile)) {
        return sendJSON(res, 400, { ok: false, error: 'invalid', message: 'Name aur valid mobile zaroori hai' });
      }
      if (!photosIn.length || photosIn.length > 10) {
        return sendJSON(res, 400, { ok: false, error: 'invalid', message: '1 se 10 photos allowed' });
      }
      const photos = photosIn.slice(0, 10).map((p, i) => ({
        name: String(p.name || ('photo-' + (i + 1) + '.jpg')).slice(0, 120),
        dataUrl: String(p.dataUrl || '').slice(0, 5e6) // safety cap per image
      })).filter(p => p.dataUrl.indexOf('data:image') === 0);
      if (!photos.length) {
        return sendJSON(res, 400, { ok: false, error: 'invalid', message: 'Valid photos chahiye' });
      }
      const list = loadEditRequests();
      const requestId = nextEditRequestId(list);
      const row = {
        requestId, name, mobile, note,
        photoCount: photos.length,
        photos,
        status: 'pending',
        createdAt: new Date().toISOString()
      };
      list.unshift(row);
      saveEditRequests(list.slice(0, 100));
      const notifs = loadNotifs();
      notifs.unshift({
        id: 'n-' + Date.now(),
        title: '✏️ Editing Request — ' + requestId,
        body: photos.length + ' photo(s) · Status: Pending',
        at: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        mobile
      });
      saveNotifs(notifs.slice(0, 50));
      console.log('Edit request:', requestId, mobile, photos.length);
      return sendJSON(res, 200, { ok: true, requestId, photoCount: photos.length });
    } catch (e) {
      console.error('edit-request', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error', message: e.message || 'fail' });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/request-spin-otp') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile)) return sendJSON(res, 400, { ok: false, error: 'invalid-mobile' });
      if (rateLimited(req, mobile + ':otp', 3, 15 * 60 * 1000)) return sendJSON(res, 429, { ok: false, error: 'too-many-attempts', message: 'OTP requests limit ho gaye. 15 minute baad try karein.' });
      const accounts = loadAccounts();
      // Registration ke baad browser session miss ho sakta hai. Registered mobile
      // ko direct OTP request karne dein; verification par naya session milta hai.
      const loggedIn = sessionAccount(req, body, accounts);
      const acc = (loggedIn && String(loggedIn.mobile) === mobile) ? loggedIn : accounts.find(a => String(a.mobile) === mobile);
      if (!acc) return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Yeh mobile register nahi hai. Pehle account banayein.' });
      if (acc.mobileVerified) return sendJSON(res, 200, { ok: true, alreadyVerified: true });
      let list = loadOtpRequests();
      const now = Date.now();
      // Dusre user ka pending mobile OTP kabhi delete nahi hoga.
      list = list.filter(r => keepPendingOtpForAdmin(r, now));
      const existing = list.find(r => r.mobile === mobile && !r.verified && r.purpose === 'mobile_verify');
      // Admin WhatsApp OTP ko baar-baar request karne par naya OTP mat banao.
      // Wahi pending 6-digit OTP 5 minute tak admin panel me rahega.
      if (existing && existing.manualOtp) {
        void sendTelegramAlert('WhatsApp OTP Requested Again', 'Customer: ' + (acc.name || 'Customer') + '\nUser ID: ' + (acc.id || '—') + '\nMobile: ' + mobile + '\nAction: OTP admin panel me available hai; wahin se WhatsApp par bhejein.');
        return sendJSON(res, 200, { ok: true, alreadyVerified: false, delivery: 'whatsapp_manual', alreadyPending: true, expiresInSeconds: Math.max(0, Math.floor((new Date(existing.expiresAt).getTime() - now) / 1000)) });
      }
      if (existing && now - new Date(existing.createdAt || 0).getTime() < OTP_RESEND_COOLDOWN_MS) {
        return sendJSON(res, 429, { ok: false, error: 'resend-too-soon', message: 'OTP dobara bhejne ke liye 1 minute rukhein.' });
      }
      const otp = generateOtp();
      const requestId = 'otp-' + mobile + '-' + now;
      // This button specifically asks the studio admin to send OTP on WhatsApp.
      // Do not silently switch to SMS: the request must stay visible in admin.
      const sms = {}, delivery = 'whatsapp_manual';
      if (existing) list = list.filter(r => r !== existing);
      list.unshift({
        mobile, name: acc.name || '', id: acc.id || '', otpHash: hashOtp(otp), requestId,
        smsId: sms.sms_id || sms.id || '', createdAt: new Date().toISOString(),
        expiresAt: new Date(now + MOBILE_VERIFY_OTP_TTL_MS).toISOString(), attempts: 0, verified: false, purpose: 'mobile_verify',
        // Sirf password-protected admin panel me manual WhatsApp send ke liye.
        manualOtp: otp, delivery
      });
      saveOtpRequests(list.slice(0, 100));
      recordAuthFailure(req, mobile + ':otp');
      console.log('OTP request created for:', mobile, requestId, delivery);
      void sendTelegramAlert('WhatsApp OTP Request', 'Customer: ' + (acc.name || 'Customer') + '\nUser ID: ' + (acc.id || '—') + '\nMobile: ' + mobile + '\nAction: OTP admin panel me available hai; wahin se WhatsApp par bhejein.');
      return sendJSON(res, 200, { ok: true, alreadyVerified: false, delivery, expiresInSeconds: Math.floor(OTP_TTL_MS / 1000) });
    } catch (e) {
      console.error('request-spin-otp', e);
      const status = e && e.code === 'sms-not-configured' ? 503 : 502;
      return sendJSON(res, status, { ok: false, error: e && e.code || 'sms-send-failed', message: e && e.message || 'OTP SMS nahi bhej paaye' });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/verify-spin-otp') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const otp = String(body.otp || '').trim();
      if (!/^[0-9]{6}$/.test(otp)) return sendJSON(res, 400, { ok: false, error: 'invalid-otp' });
      if (rateLimited(req, mobile + ':verify-otp', 5, 15 * 60 * 1000)) return sendJSON(res, 429, { ok: false, error: 'too-many-attempts', message: 'OTP attempts limit ho gaye. 15 minute baad try karein.' });
      const accounts = loadAccounts();
      const acc = sessionAccount(req, body, accounts);
      const list = loadOtpRequests();
      const row = list.find(r => r.mobile === mobile && !r.verified && r.purpose === 'mobile_verify');
      // Naye registration me session kabhi browser se miss ho jaye to bhi wahi
      // one-time OTP ownership prove karta hai. Isliye valid OTP ko direct verify
      // karne dein aur naya session return karein; request/resend phir bhi login-only hai.
      if ((!acc || String(acc.mobile) !== mobile) && !row) return sendJSON(res, 401, { ok: false, error: 'auth', message: 'OTP request nahi mila. Pehle login karke OTP request karein.' });
      if (!row) return sendJSON(res, 400, { ok: false, error: 'no-request' });
      // Admin-panel mobile verification OTP user verify kare tabhi close hoga.
      // Isliye is flow me time ke basis par OTP ko reject/delete nahi karte.
      row.attempts = Number(row.attempts || 0) + 1;
      if (row.attempts > OTP_MAX_ATTEMPTS) { row.lockedAt = new Date().toISOString(); saveOtpRequests(list); return sendJSON(res, 429, { ok: false, error: 'too-many-attempts' }); }
      if (!otpMatches(row, otp)) { saveOtpRequests(list); recordAuthFailure(req, mobile + ':verify-otp'); return sendJSON(res, 401, { ok: false, error: 'wrong-otp' }); }
      clearAuthFailures(req, mobile + ':verify-otp');
      row.verified = true;
      row.verifiedAt = new Date().toISOString();
      saveOtpRequests(list);
      const verifiedAccount = acc && String(acc.mobile) === mobile ? acc : accounts.find(a => String(a.mobile) === mobile);
      if (!verifiedAccount) return sendJSON(res, 404, { ok: false, error: 'not-found' });
      verifiedAccount.mobileVerified = true; saveAccounts(accounts);
      return sendJSON(res, 200, { ok: true, ...accountPublicPayload(verifiedAccount), sessionToken: issueSession(verifiedAccount) });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/request-pin-reset-otp') {
    try {
      const body = await readBody(req), mobile = String(body.mobile || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile)) return sendJSON(res, 400, { ok: false, error: 'invalid-mobile' });
      if (rateLimited(req, mobile + ':pin-reset-otp', 3, 15 * 60 * 1000)) return sendJSON(res, 429, { ok: false, error: 'too-many-attempts', message: 'बहुत बार OTP माँगा गया है। 15 मिनट बाद try करें।' });
      const accounts = loadAccounts(), acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'not-found', message: 'यह mobile number register नहीं है।' });
      let list = loadOtpRequests(), now = Date.now();
      list = list.filter(r => r.verified || (r.expiresAt && new Date(r.expiresAt).getTime() > now && r.otpHash));
      const existing = list.find(r => r.mobile === mobile && !r.verified && r.purpose === 'pin_reset');
      if (existing && now - new Date(existing.createdAt || 0).getTime() < OTP_RESEND_COOLDOWN_MS) return sendJSON(res, 429, { ok: false, error: 'resend-too-soon', message: 'नया OTP माँगने से पहले 1 मिनट रुकें।' });
      const otp = generateOtp(), requestId = 'pin-reset-' + mobile + '-' + now, sms = await sendOtpSms(mobile, otp, requestId);
      if (existing) list = list.filter(r => r !== existing);
      list.unshift({ mobile, name: acc.name || '', id: acc.id || '', otpHash: hashOtp(otp), requestId, smsId: sms.sms_id || sms.id || '', createdAt: new Date().toISOString(), expiresAt: new Date(now + OTP_TTL_MS).toISOString(), attempts: 0, verified: false, purpose: 'pin_reset' });
      saveOtpRequests(list.slice(0, 100));
      return sendJSON(res, 200, { ok: true, expiresInSeconds: Math.floor(OTP_TTL_MS / 1000) });
    } catch (e) {
      const status = e && e.code === 'sms-not-configured' ? 503 : 502;
      return sendJSON(res, status, { ok: false, error: e && e.code || 'sms-send-failed', message: e && e.message || 'OTP नहीं भेज पाए।' });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/reset-pin-with-otp') {
    try {
      const body = await readBody(req), mobile = String(body.mobile || '').trim(), otp = String(body.otp || '').trim(), newPin = String(body.newPin || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile) || !/^\d{6}$/.test(otp) || !/^\d{4}$/.test(newPin)) return sendJSON(res, 400, { ok: false, error: 'invalid' });
      if (rateLimited(req, mobile + ':pin-reset-verify', 5, 15 * 60 * 1000)) return sendJSON(res, 429, { ok: false, error: 'too-many-attempts', message: 'बहुत गलत प्रयास हुए हैं। 15 मिनट बाद try करें।' });
      const accounts = loadAccounts(), acc = accounts.find(a => String(a.mobile) === mobile), list = loadOtpRequests();
      const row = list.find(r => r.mobile === mobile && !r.verified && r.purpose === 'pin_reset');
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'not-found' });
      if (!row) return sendJSON(res, 400, { ok: false, error: 'no-request', message: 'पहले PIN reset OTP भेजें।' });
      if (!row.expiresAt || new Date(row.expiresAt).getTime() <= Date.now()) return sendJSON(res, 410, { ok: false, error: 'otp-expired', message: 'OTP expire हो गया है।' });
      row.attempts = Number(row.attempts || 0) + 1;
      if (row.attempts > OTP_MAX_ATTEMPTS) { row.lockedAt = new Date().toISOString(); saveOtpRequests(list); return sendJSON(res, 429, { ok: false, error: 'too-many-attempts' }); }
      if (!otpMatches(row, otp)) { saveOtpRequests(list); recordAuthFailure(req, mobile + ':pin-reset-verify'); return sendJSON(res, 401, { ok: false, error: 'wrong-otp', message: 'OTP गलत है।' }); }
      row.verified = true; row.verifiedAt = new Date().toISOString(); setPin(acc, newPin); acc.pinResetRequested = false;
      saveOtpRequests(list); saveAccounts(accounts); clearAuthFailures(req, mobile + ':pin-reset-verify');
      return sendJSON(res, 200, { ok: true, message: 'नया PIN बन गया है। अब login करें।' });
    } catch (e) { return sendJSON(res, 500, { ok: false, error: 'server-error' }); }
  }

  if (req.method === 'POST' && urlPath === '/api/change-pin-with-old-pin') {
    try {
      const body = await readBody(req), mobile = String(body.mobile || '').trim(), oldPin = String(body.oldPin || '').trim(), newPin = String(body.newPin || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile) || !/^\d{4}$/.test(oldPin) || !/^\d{4}$/.test(newPin)) return sendJSON(res, 400, { ok: false, error: 'invalid' });
      if (rateLimited(req, mobile + ':old-pin-change', 5, 15 * 60 * 1000)) return sendJSON(res, 429, { ok: false, error: 'too-many-attempts', message: 'बहुत गलत प्रयास हुए हैं। 15 मिनट बाद try करें।' });
      const accounts = loadAccounts(), acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc || !verifyPin(acc, oldPin)) { recordAuthFailure(req, mobile + ':old-pin-change'); return sendJSON(res, 401, { ok: false, error: 'wrong-pin', message: 'पुराना PIN गलत है।' }); }
      setPin(acc, newPin); saveAccounts(accounts); clearAuthFailures(req, mobile + ':old-pin-change');
      return sendJSON(res, 200, { ok: true, message: 'नया PIN बन गया है। अब login करें।' });
    } catch (e) { return sendJSON(res, 500, { ok: false, error: 'server-error' }); }
  }

  if (req.method === 'POST' && urlPath === '/api/check-verified') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const accounts = loadAccounts();
      const acc = sessionAccount(req, body, accounts);
      if (!acc || String(acc.mobile) !== mobile) return sendJSON(res, 401, { ok: false, error: 'auth' });
      return sendJSON(res, 200, { ok: true, verified: !!(acc && acc.mobileVerified) });
    } catch (e) {
      return sendJSON(res, 400, { ok: false });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/register') {
    try {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const mobile = String(body.mobile || '').trim();
      const pin = String(body.pin || '').trim();
      if (!/^[A-Za-z ]{2,}$/.test(name) || !/^[6-9]\d{9}$/.test(mobile) || !/^\d{4}$/.test(pin)) return sendJSON(res, 400, { ok: false, error: 'invalid' });
      const accounts = loadAccounts();
      if (accounts.find(a => a.mobile === mobile)) return sendJSON(res, 409, { ok: false, error: 'exists' });
      const registrationNetworkKey = requestNetworkKey(req);
      const registrationsFromNetwork = accounts.filter(a => a.registrationNetworkKey === registrationNetworkKey).length;
      if (registrationsFromNetwork >= 2) {
        const settings = loadSettings();
        return sendJSON(res, 429, {
          ok: false,
          error: 'network-registration-limit',
          message: 'Is network se 2 registrations ho chuke hain. Naya account banwane ke liye WhatsApp Help par baat karein.',
          helpWhatsapp: String(settings.helpWhatsapp || '').replace(/\D/g, '')
        });
      }
      const id = nextCustomerId(accounts);
      const acc = {
        id, name, mobile, village: String(body.village || '').trim(),
        registrationNetworkKey,
        pin: hashPin(pin), createdAt: new Date().toISOString(), visitCount: 1, lastVisitAt: new Date().toISOString(),
        pinResetRequested: false, freeSpinUsed: false, mobileVerified: false, history: [], totalSpend: 0,
        adTokens: 0, spinBalance: 1, lastAdTokenClaim: '',
        walletBalance: 0, walletHistory: []
      };
      accounts.push(acc);
      saveAccounts(accounts);
      // Naye register user ki verification request admin WhatsApp OTP list me seedha aaye.
      const now = Date.now(), otp = generateOtp(), requestId = 'otp-' + mobile + '-' + now;
      let otpList = loadOtpRequests().filter(r => keepPendingOtpForAdmin(r, now));
      otpList.unshift({ mobile, name: acc.name || '', id: acc.id || '', otpHash: hashOtp(otp), requestId, smsId:'', createdAt:new Date().toISOString(), expiresAt:new Date(now + MOBILE_VERIFY_OTP_TTL_MS).toISOString(), attempts:0, verified:false, purpose:'mobile_verify', manualOtp:otp, delivery:'whatsapp_manual' });
      saveOtpRequests(otpList.slice(0,100));
      void sendTelegramAlert('New User Registered', 'Customer: ' + (acc.name || 'Customer') + '\nUser ID: ' + id + '\nMobile: ' + mobile + (acc.village ? ('\nVillage: ' + acc.village) : '') + '\nVerification: Pending');
      return sendJSON(res, 200, { ...accountPublicPayload(acc), sessionToken: issueSession(acc), otpRequested:true });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'save-failed' });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/login') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const pin = String(body.pin || '').trim();
      if (rateLimited(req, mobile, 5, 15 * 60 * 1000)) return sendJSON(res, 429, { ok: false, error: 'too-many-attempts', message: 'Bahut login attempts hue. 15 minute baad try karein.' });
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc) { recordAuthFailure(req, mobile); return sendJSON(res, 401, { ok: false, error: 'not-found' }); }
      if (!verifyPin(acc, pin)) { recordAuthFailure(req, mobile); return sendJSON(res, 401, { ok: false, error: 'wrong-pin' }); }
      clearAuthFailures(req, mobile);
      acc.visitCount = (acc.visitCount || 0) + 1;
      acc.lastVisitAt = new Date().toISOString();
      saveAccounts(accounts);
      // Legacy registrations ke liye bhi OTP queue recover ho jaye.
      ensureAdminWhatsAppOtp(acc);
      // PIN aur OTP kabhi alert me nahi jaate; sirf successful login ki detail bhejte hain.
      void sendTelegramAlert('Customer Login', 'Customer: ' + (acc.name || 'Customer') + '\nUser ID: ' + (acc.id || '—') + '\nMobile: ' + acc.mobile + '\nVisits: ' + acc.visitCount + '\nTime: ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
      return sendJSON(res, 200, { ...accountPublicPayload(acc), sessionToken: issueSession(acc) });
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad-request' });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/restore-session') {
    try {
      const body = await readBody(req);
      const accounts = loadAccounts();
      const acc = sessionAccount(req, body, accounts);
      if (!acc) return sendJSON(res, 401, { ok: false, error: 'not-found' });
      return sendJSON(res, 200, accountPublicPayload(acc));
    } catch (e) {
      return sendJSON(res, 400, { ok: false });
    }
  }

  // Daily AD token — 1 per day; 10 AD tokens → 1 spin
  if (req.method === 'POST' && urlPath === '/api/claim-ad-token') {
    try {
      const body = await readBody(req);
      const accounts = loadAccounts();
      const acc = sessionAccount(req, body, accounts);
      if (!acc) return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Login required' });
      const today = todayIST();
      if ((acc.lastAdTokenClaim || '') === today) {
        return sendJSON(res, 400, {
          ok: false,
          error: 'already-claimed',
          message: 'Aaj ka AD Token already claim ho chuka hai',
          ...publicTokenFields(acc)
        });
      }
      acc.adTokens = (Number(acc.adTokens) || 0) + 1;
      acc.lastAdTokenClaim = today;
      saveAccounts(accounts);
      return sendJSON(res, 200, {
        ok: true,
        message: '1 AD Token mil gaya!',
        ...publicTokenFields(acc)
      });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/exchange-ad-tokens') {
    try {
      const body = await readBody(req);
      const accounts = loadAccounts();
      const acc = sessionAccount(req, body, accounts);
      if (!acc) return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Login required' });
      const tokens = Number(acc.adTokens) || 0;
      if (tokens < 10) {
        return sendJSON(res, 400, {
          ok: false,
          error: 'not-enough',
          message: '10 AD Tokens chahiye 1 spin ke liye (abhi: ' + tokens + ')',
          ...publicTokenFields(acc)
        });
      }
      acc.adTokens = tokens - 10;
      acc.spinBalance = (Number(acc.spinBalance) || 0) + 1;
      saveAccounts(accounts);
      return sendJSON(res, 200, {
        ok: true,
        message: '10 AD Tokens → 1 Spin convert!',
        ...publicTokenFields(acc)
      });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  /* ===== Wallet APIs ===== */
  // A winning promo coupon can be converted once into wallet credit.
  // It remains spendable for 30 days, after which only that unused promo
  // portion is removed automatically.
  if (req.method === 'POST' && urlPath === '/api/wallet/apply-coupon') {
    try {
      const body = await readBody(req);
      const couponId = String(body.couponId || '').trim();
      if (!couponId) {
        return sendJSON(res, 400, { ok: false, error: 'invalid', message: 'Coupon zaroori hai' });
      }
      const accounts = loadAccounts();
      const acc = sessionAccount(req, body, accounts);
      if (!acc) return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Login required' });
      ensureWallet(acc);
      acc.history = acc.history || [];
      const entry = acc.history.find(h => String(h.couponId || h.entryId || '') === couponId);
      if (!entry) return sendJSON(res, 404, { ok: false, error: 'coupon-not-found', message: 'Coupon nahi mila' });
      const st = entry.couponStatus || 'active';
      if (st === 'used' || st === 'wallet_credited' || st === 'accepted' || st === 'deleted') {
        return sendJSON(res, 400, { ok: false, error: 'already-used', message: 'Coupon pehle use / credit ho chuka hai' });
      }
      if (entry.expiresAt && new Date(entry.expiresAt).getTime() < Date.now()) {
        return sendJSON(res, 400, { ok: false, error: 'expired', message: 'Coupon expire ho gaya' });
      }
      const rupees = couponRupeeValue(entry);
      if (rupees <= 0) {
        return sendJSON(res, 400, { ok: false, error: 'no-value', message: 'Is coupon me wallet credit value nahi (frame/luck)' });
      }
      const txn = walletTxn(acc, 'credit', rupees, {
        reason: 'Coupon → Wallet: ' + (entry.prize || ('₹' + rupees)),
        source: 'coupon',
        ref: couponId,
        couponId,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      });
      entry.couponStatus = 'wallet_credited';
      entry.walletCreditedAt = new Date().toISOString();
      entry.walletCreditedAmount = rupees;
      saveAccounts(accounts);
      return sendJSON(res, 200, {
        ok: true,
        message: '₹' + rupees + ' wallet me add ho gaya!',
        credited: rupees,
        walletBalance: acc.walletBalance,
        walletHistory: (acc.walletHistory || []).slice(0, 30),
        history: publicHistory(acc),
        promoWalletCredits: activePromoWallet(acc)
      });
    } catch (e) {
      console.error('wallet/apply-coupon', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  // Redeem admin-issued wallet code (codes.json with type wallet / walletAmount)
  if (req.method === 'POST' && urlPath === '/api/wallet/redeem-code') {
    try {
      const body = await readBody(req);
      const code = String(body.code || '').trim().toUpperCase();
      if (!code) {
        return sendJSON(res, 400, { ok: false, error: 'invalid', message: 'Code zaroori hai' });
      }
      const accounts = loadAccounts();
      const acc = sessionAccount(req, body, accounts);
      if (!acc) return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Login required' });
      const codes = loadCodes();
      const row = codes.find(c => String(c.code).toUpperCase() === code);
      if (!row) return sendJSON(res, 404, { ok: false, error: 'invalid-code', message: 'Code galat hai' });
      if (row.used) return sendJSON(res, 400, { ok: false, error: 'used', message: 'Code pehle use ho chuka' });
      const walletAmt = Number(row.walletAmount || row.amount || 0);
      const isWallet = row.type === 'wallet' || row.walletAmount > 0;
      if (!isWallet || walletAmt <= 0) {
        return sendJSON(res, 400, { ok: false, error: 'not-wallet-code', message: 'Ye spin code hai, wallet code nahi. /book-now pe use karo.' });
      }
      ensureWallet(acc);
      walletTxn(acc, 'credit', walletAmt, {
        reason: 'Wallet code: ' + code,
        source: 'wallet_code',
        ref: code
      });
      row.used = true;
      row.usedBy = acc.mobile;
      row.usedAt = new Date().toISOString();
      saveCodes(codes);
      saveAccounts(accounts);
      return sendJSON(res, 200, {
        ok: true,
        message: '₹' + walletAmt + ' wallet me add!',
        credited: walletAmt,
        walletBalance: acc.walletBalance,
        walletHistory: (acc.walletHistory || []).slice(0, 30)
      });
    } catch (e) {
      console.error('wallet/redeem-code', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  // Wallet top-up: amount is pending until the admin verifies UTR/proof.
  if (req.method === 'POST' && urlPath === '/api/wallet/topup') {
    try {
      const body = await readBody(req, 2e6);
      const amount = Math.round(Number(body.amount) || 0);
      const utr = String(body.utr || '').trim().toUpperCase();
      const proof = String(body.proof || '');
      if (amount < 1 || amount > 100000) return sendJSON(res, 400, { ok:false, message:'₹1 से ₹1,00,000 तक amount डालें' });
      if (!/^[A-Z0-9_-]{6,40}$/.test(utr) && !/^data:image\/(png|jpeg|webp);base64,/i.test(proof)) {
        return sendJSON(res, 400, { ok:false, message:'UTR (कम से कम 6 characters) या payment screenshot जरूरी है' });
      }
      if (proof && (!/^data:image\/(png|jpeg|webp);base64,/i.test(proof) || proof.length > 1500000)) {
        return sendJSON(res, 400, { ok:false, message:'Screenshot PNG, JPG या WEBP और 1MB से छोटा रखें' });
      }
      const accounts = loadAccounts();
      const acc = sessionAccount(req, body, accounts);
      if (!acc) return sendJSON(res, 401, { ok:false, message:'Login required' });
      ensureWallet(acc);
      const topups = loadWalletTopups();
      const topupId = 'WT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,5).toUpperCase();
      topups.unshift({ id:topupId, mobile:acc.mobile, customerId:acc.id, name:acc.name || '', amount, utr, proof, status:'pending', createdAt:new Date().toISOString() });
      acc.walletPendingBalance += amount;
      acc.walletHistory.unshift({ id:walletHistoryId(), type:'pending', amount, balanceAfter:acc.walletBalance, reason:'Top-up pending admin verification', source:'wallet_topup', ref:topupId, timestamp:new Date().toISOString() });
      saveWalletTopups(topups); saveAccounts(accounts);
      void sendTelegramAlert('Wallet Recharge Pending', 'Customer: ' + (acc.name || acc.mobile) + ' · ' + acc.mobile + '\nAmount: ₹' + amount + '\nUTR: ' + (utr || 'Screenshot submitted') + '\nTop-up ID: ' + topupId);
      return sendJSON(res, 200, { ok:true, topupId, message:'Payment proof submit हो गया। Admin verify करने के बाद ₹'+amount+' wallet में usable होगा।', walletPendingBalance:acc.walletPendingBalance });
    } catch (e) {
      console.error('wallet/topup', e); return sendJSON(res, 500, { ok:false, message:'Top-up save नहीं हो पाया' });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/wallet/history') {
    try {
      const body = await readBody(req);
      const accounts = loadAccounts();
      const acc = sessionAccount(req, body, accounts);
      if (!acc) return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Login required' });
      ensureWallet(acc);
      return sendJSON(res, 200, {
        ok: true,
        walletBalance: acc.walletBalance,
        walletHistory: acc.walletHistory || []
      });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  // Admin verifies wallet recharge after checking UTR / payment screenshot.
  if (req.method === 'POST' && urlPath === '/admin/wallet-topup-action') {
    try {
      const body = await readFormBody(req);
      const id = String(body.id || '').trim();
      const action = String(body.action || '').trim();
      const topups = loadWalletTopups();
      const topup = topups.find(t => String(t.id) === id);
      if (!topup || topup.status !== 'pending') { res.writeHead(302, { Location: '/admin?topup=missing' }); return res.end(); }
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === String(topup.mobile));
      if (!acc) { res.writeHead(302, { Location: '/admin?topup=customer-missing' }); return res.end(); }
      ensureWallet(acc);
      const amount = Math.max(0, Number(topup.amount) || 0);
      acc.walletPendingBalance = Math.max(0, Number(acc.walletPendingBalance || 0) - amount);
      if (action === 'approve') {
        topup.status = 'approved'; topup.verifiedAt = new Date().toISOString();
        walletTxn(acc, 'credit', amount, { reason: 'Recharge approved · ' + id, source: 'wallet_topup', ref: id });
      } else if (action === 'reject') {
        topup.status = 'rejected'; topup.verifiedAt = new Date().toISOString();
        acc.walletHistory.unshift({ id: walletHistoryId(), type: 'rejected', amount, balanceAfter: acc.walletBalance, reason: 'Recharge rejected · ' + id, source: 'wallet_topup', ref: id, timestamp: new Date().toISOString() });
      } else { res.writeHead(302, { Location: '/admin?topup=invalid-action' }); return res.end(); }
      saveWalletTopups(topups); saveAccounts(accounts);
      const notifs = loadNotifs();
      notifs.unshift({ id:'n-'+Date.now(), title: action === 'approve' ? '💰 Wallet Recharge Approved' : '⚠️ Wallet Recharge Rejected', body: action === 'approve' ? '₹'+amount+' aapke wallet me add ho gaya hai.' : '₹'+amount+' recharge verify nahi hua. Studio se sampark karein.', at:new Date().toISOString(), expiresAt:new Date(Date.now()+30*24*60*60*1000).toISOString(), mobile:acc.mobile });
      saveNotifs(notifs.slice(0,50));
      void sendTelegramAlert(action === 'approve' ? 'Wallet Recharge Approved' : 'Wallet Recharge Rejected', 'Customer: ' + (acc.name || acc.mobile) + ' · ' + acc.mobile + '\nAmount: ₹' + amount + '\nTop-up ID: ' + id);
      res.writeHead(302, { Location: '/admin?topup='+action }); return res.end();
    } catch (e) { console.error('wallet topup admin', e); res.writeHead(302, { Location: '/admin?topup=fail' }); return res.end(); }
  }

  if (req.method === 'POST' && urlPath === '/api/assign-work-spin') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const amount = Number(body.amount) || 0;
      if (!/^[6-9]\d{9}$/.test(mobile)) return sendJSON(res, 400, { ok: false, error: 'invalid-mobile' });
      if (amount < 50) return sendJSON(res, 400, { ok: false, error: 'invalid-amount' });
      const accounts = loadAccounts();
      const acc = sessionAccount(req, body, accounts);
      if (!acc || String(acc.mobile) !== mobile) return sendJSON(res, 401, { ok: false, error: 'auth' });
      const { prize, stats } = assignWorkPrize(amount);
      console.log('Work-spin assign', mobile, '₹' + amount, prize.val, stats.key, 'left', stats.left);
      return sendJSON(res, 200, { ok: true, prize, stats });
    } catch (e) {
      console.error('assign-work-spin', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/assign-free-spin') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile)) return sendJSON(res, 400, { ok: false, error: 'invalid-mobile' });
      const accounts = loadAccounts();
      const acc = sessionAccount(req, body, accounts);
      if (!acc || String(acc.mobile) !== mobile) return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Login required' });
      if (acc.freeSpinUsed) return sendJSON(res, 409, { ok: false, error: 'already-used', message: 'Free spin pehle use ho chuki hai' });
      // Mobile OTP profile se optional verification ke liye hai. Welcome free spin
      // register/login ke turant baad bhi milna chahiye.
      const { prize, stats } = assignNextFreePrize();
      // Spin शुरू होते ही इसे consume करें. इससे refresh, slow network या multiple
      // tabs की वजह से वही free spin फिर से popup में नहीं आएगी.
      acc.freeSpinUsed = true;
      acc.freeSpinAssignedAt = new Date().toISOString();
      saveAccounts(accounts);
      console.log('Free-spin assign', mobile, prize.val, 'batch left', stats.leftInBatch);
      return sendJSON(res, 200, { ok: true, prize, stats });
    } catch (e) {
      console.error('assign-free-spin', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error', message: String(e.message || e) });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/free-spin-result') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const accounts = loadAccounts();
      const acc = sessionAccount(req, body, accounts);
      if (!acc || String(acc.mobile) !== mobile) return sendJSON(res, 401, { ok: false, error: 'auth' });
      acc.freeSpinUsed = true;
      acc.history = acc.history || [];
      const couponId = 'C-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      acc.history.push({
        entryId: acc.id + '-FREE', amount: 0, tier: 'Free',
        discount: body.discount != null ? body.discount : null,
        prize: body.prize || '', freeSpin: true, timestamp: new Date().toISOString(),
        couponId, couponStatus: 'active', expiresAt
      });
      saveAccounts(accounts);
      return sendJSON(res, 200, { ok: true, couponId, expiresAt });
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
      const acc = sessionAccount(req, body, accounts);
      if (!acc || String(acc.mobile) !== mobile) return sendJSON(res, 401, { ok: false, error: 'auth' });
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
      const acc = sessionAccount(req, body, accounts);
      if (!acc || String(acc.mobile) !== mobile) return sendJSON(res, 401, { ok: false, error: 'auth' });
      const entry = (acc.history || []).find(h => h.entryId === body.entryId);
      if (entry) {
        entry.discount = body.discount;
        entry.prize = body.prize || entry.prize || (body.discount != null ? body.discount + '%' : '');
        if (!entry.couponId) entry.couponId = 'C-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        if (!entry.couponStatus) entry.couponStatus = 'active';
        if (!entry.expiresAt) entry.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        saveAccounts(accounts);
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
      } else if (body.prize) {
        // fallback push
        acc.history = acc.history || [];
        acc.history.push({
          entryId: body.entryId || ('E-' + Date.now()),
          amount: body.amount || 0,
          prize: body.prize,
          discount: body.discount,
          timestamp: new Date().toISOString(),
          couponId: 'C-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
          couponStatus: 'active',
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        });
        saveAccounts(accounts);
      }
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 400, { ok: false });
    }
  }

  // The homepage roller consumes one earned spin and creates a usable coupon.
  // Prize selection happens on the server so browser refreshes cannot reuse a spin.
  if (req.method === 'POST' && urlPath === '/api/use-spin') {
    try {
      const body = await readBody(req);
      const accounts = loadAccounts();
      const acc = sessionAccount(req, body, accounts);
      if (!acc) return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Login required' });
      const available = Math.max(0, Number(acc.spinBalance) || 0);
      if (available < 1) return sendJSON(res, 409, { ok: false, error: 'no-spin', message: 'Pehle spin code claim karein ya AD tokens se spin add karein.' });
      const options = [
        { label: '₹10 Discount', discount: 10 }, { label: '₹20 Discount', discount: 20 },
        { label: '₹30 Discount', discount: 30 }, { label: '₹50 Discount', discount: 50 },
        { label: '₹100 Discount', discount: 100 }, { label: 'Good Luck', discount: 0 }
      ];
      const prize = options[crypto.randomInt(options.length)];
      const now = new Date();
      const couponCode = 'AS' + String(Date.now()).slice(-6) + crypto.randomBytes(2).toString('hex').toUpperCase();
      acc.spinBalance = available - 1;
      acc.history = acc.history || [];
      acc.history.unshift({
        entryId: (acc.id || 'AS') + '-SPIN-' + Date.now(), amount: 0,
        prize: prize.label, discount: prize.discount, couponId: couponCode,
        couponStatus: prize.discount > 0 ? 'active' : 'not_winner',
        timestamp: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
      });
      saveAccounts(accounts);
      return sendJSON(res, 200, { ok: true, prize, couponCode: prize.discount > 0 ? couponCode : '', spinBalance: acc.spinBalance });
    } catch (e) {
      console.error('use-spin', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error', message: 'Spin save nahi ho paya' });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/redeem-code') {
    try {
      const body = await readBody(req);
      const code = String(body.code || '').trim().toUpperCase();
      const codes = loadCodes();
      const row = codes.find(c => String(c.code).toUpperCase() === code);
      if (!row) return sendJSON(res, 404, { ok: false, error: 'not-found' });
      if (row.used) return sendJSON(res, 409, { ok: false, error: 'used' });
      const accounts = loadAccounts();
      const acc = sessionAccount(req, body, accounts);
      if (!acc) return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Login required' });
      if (row.type === 'wallet' || Number(row.walletAmount) > 0) {
        return sendJSON(res, 400, { ok: false, error: 'wallet-code', message: 'Ye wallet code hai, spin code nahi.' });
      }
      const amount = Number(row.amount) || 0;
      row.used = true;
      row.usedBy = acc.id + ' / ' + acc.mobile;
      row.usedAt = new Date().toISOString();
      saveCodes(codes);
      const tier = tierName(amount);
      const entryId = acc.id + '-E' + String((acc.history || []).length + 1);
      acc.history = acc.history || [];
      acc.history.push({ entryId, amount, tier, code: row.code, timestamp: new Date().toISOString() });
      acc.totalSpend = acc.history.reduce((s, h) => s + (Number(h.amount) || 0), 0);
      acc.badge = tierName(acc.totalSpend);
      acc.spinBalance = (Number(acc.spinBalance) || 0) + 1;
      saveAccounts(accounts);
      return sendJSON(res, 200, {
        ok: true, amount, tier, entryId, badge: acc.badge, totalSpend: acc.totalSpend, code: row.code,
        spinBalance: acc.spinBalance, message: 'Spin code claim ho gaya — ab roller ghumayein!'
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
      if (!/^[6-9]\d{9}$/.test(mobile)) return sendJSON(res, 400, { ok: false, error: 'invalid-mobile' });
      if (rateLimited(req, mobile + ':pin-reset', 3, 15 * 60 * 1000)) {
        return sendJSON(res, 429, { ok: false, error: 'too-many-requests', message: 'Thodi der baad phir try karein' });
      }
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
    establishAdminSession(req, res);
  }

  if (req.method === 'GET' && urlPath === '/admin/activity-json') {
    const now = Date.now();
    const users = loadUserActivity().map(x => ({ ...x, online: now - new Date(x.lastSeenAt || 0).getTime() < 90000 })).sort((a,b) => Number(b.totalSeconds||0)-Number(a.totalSeconds||0));
    return sendJSON(res, 200, { ok:true, users });
  }

  if (req.method === 'GET' && urlPath === '/admin/activity') {
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>User Activity — Aditya Studio</title><style>body{margin:0;background:#0b0908;color:#f7f1e7;font:14px system-ui;padding:18px;max-width:980px;margin:auto}a{color:#f5d45d}.top{display:flex;justify-content:space-between;align-items:center;gap:12px}h1{color:#f5d45d}.sub{color:#a89c91}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:20px 0}.card,.user{background:#1b1511;border:1px solid rgba(245,212,93,.22);border-radius:15px;padding:15px}.num{font-size:28px;color:#f5d45d;font-weight:900}.online{color:#86efac}.offline{color:#aaa}.user{margin:12px 0}.head{display:flex;justify-content:space-between;gap:8px}.event{padding:8px;border-left:3px solid #22d3ee;background:#101c20;margin-top:7px;border-radius:0 8px 8px 0;font-size:12px}.tag{padding:4px 8px;border-radius:99px;background:#123d29;color:#bbf7d0;font-weight:800;font-size:11px}</style></head><body><div class="top"><div><h1>📊 User Activity Tracker</h1><p class="sub">Online users, time spent aur safe activity history. Refresh har 20 seconds me.</p></div><a href="/admin">← Admin Home</a></div><div class="grid" id="stats"></div><div id="list">Loading…</div><script>function e(x){return String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function tm(s){let m=Math.floor((+s||0)/60),q=(+s||0)%60;return m+'m '+q+'s'}function dt(x){try{return new Date(x).toLocaleString('en-IN')}catch(_){return '—'}}async function load(){try{let d=await (await fetch('/admin/activity-json')).json(),u=d.users||[],on=u.filter(x=>x.online).length;document.getElementById('stats').innerHTML='<div class="card"><div class="num">'+on+'</div><div class="online">● Online now</div></div><div class="card"><div class="num">'+u.length+'</div><div>Total tracked users</div></div><div class="card"><div class="num">'+(u[0]?tm(u[0].totalSeconds):'0m')+'</div><div>Most active: '+e(u[0]?.name||'—')+'</div></div>';document.getElementById('list').innerHTML=u.length?u.map(x=>'<article class="user"><div class="head"><div><b>'+e(x.name||'Customer')+'</b> · '+e(x.mobile)+'<div class="sub">Last page: '+e(x.lastPage||'—')+' · Last active: '+dt(x.lastSeenAt)+'</div></div><div><span class="tag '+(x.online?'online':'offline')+'">'+(x.online?'● ONLINE':'○ Offline')+'</span><div class="sub" style="margin-top:8px;text-align:right">⏱ '+tm(x.totalSeconds)+'</div></div></div><div>'+((x.events||[]).slice(0,8).map(a=>'<div class="event">📍 '+e(a.page)+' &nbsp; → &nbsp; '+e(a.action)+' <span class="sub">('+dt(a.at)+')</span></div>').join('')||'<p class="sub">No actions yet</p>')+'</div></article>').join(''):'<p class="sub">Abhi tracking data nahi hai.</p>'}catch(e){document.getElementById('list').textContent='Load fail'}}load();setInterval(load,20000)</script></body></html>`;
    res.writeHead(200,{ 'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store' }); return res.end(html);
  }

  if (req.method === 'POST' && urlPath === '/admin/otp-mark-sent') {
    try {
      const body = await readBody(req), mobile = String(body.mobile || '').replace(/\D/g, '');
      const accounts = loadAccounts(), acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc) return sendJSON(res, 404, { ok:false });
      acc.verificationOtpSentAt = new Date().toISOString(); saveAccounts(accounts);
      return sendJSON(res, 200, { ok:true });
    } catch (e) { return sendJSON(res, 400, { ok:false }); }
  }

  if (req.method === 'POST' && urlPath === '/admin/otp-delete') {
    if (!isAdminAuthed(req)) return requireAdminAuth(req, res);
    try {
      const body = await readBody(req);
      const id = String(body.id || '').trim(), mobile = String(body.mobile || '').replace(/\D/g, '');
      const before = loadOtpRequests();
      const after = before.filter(r => !((id && String(r.id || '') === id) || (mobile && String(r.mobile || '') === mobile)));
      saveOtpRequests(after);
      return sendJSON(res, 200, { ok: true, removed: before.length - after.length });
    } catch (e) { return sendJSON(res, 400, { ok: false }); }
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
      const codeType = String(body.codeType || 'spin').trim(); // spin | wallet
      const codes = loadCodes();
      const newCode = generateCode();
      const row = {
        code: newCode,
        amount: codeType === 'wallet' ? 0 : amount,
        walletAmount: codeType === 'wallet' ? amount : 0,
        type: codeType === 'wallet' ? 'wallet' : 'spin',
        note,
        used: false,
        usedBy: null,
        createdAt: new Date().toISOString(),
        usedAt: null
      };
      codes.push(row);
      saveCodes(codes);
      console.log('Code:', newCode, codeType, '₹' + amount);
      res.writeHead(302, { Location: '/admin?code=' + encodeURIComponent(newCode) + (codeType === 'wallet' ? '&w=1' : '') });
      return res.end();
    } catch (e) {
      console.error('generate-code', e);
      res.writeHead(302, { Location: '/admin?code=fail' });
      return res.end();
    }
  }

  // Admin: credit / debit customer wallet
  if (req.method === 'POST' && urlPath === '/admin/wallet-adjust') {
    try {
      const body = await readFormBody(req);
      const mobile = String(body.mobile || '').trim();
      const type = String(body.type || 'credit').trim() === 'debit' ? 'debit' : 'credit';
      const amount = Math.round(Number(body.amount) || 0);
      const reason = String(body.reason || '').trim() || ('Admin ' + type);
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc || amount <= 0) {
        res.writeHead(302, { Location: '/admin?wallet=fail#accList' });
        return res.end();
      }
      ensureWallet(acc);
      const txn = walletTxn(acc, type, amount, {
        reason,
        source: 'admin',
        byAdmin: true,
        ref: 'admin'
      });
      if (!txn) {
        res.writeHead(302, { Location: '/admin?wallet=insufficient#accList' });
        return res.end();
      }
      saveAccounts(accounts);
      console.log('Admin wallet', type, mobile, amount, '→', acc.walletBalance);
      res.writeHead(302, { Location: '/admin?wallet=ok#accList' });
      return res.end();
    } catch (e) {
      console.error('wallet-adjust', e);
      res.writeHead(302, { Location: '/admin?wallet=fail' });
      return res.end();
    }
  }

  /* ---- Admin: Photo Frames CRUD ---- */
  if (req.method === 'GET' && urlPath === '/admin/frames-json') {
    const orders = loadFrameOrders().map(order => {
      const copy = Object.assign({}, order);
      if (String(copy.customerPhoto || '').startsWith('r2:') && r2Ready()) {
        const key = String(copy.customerPhoto).slice(3);
        try { copy.customerPhoto = r2PresignedUrl('GET', key, 600); } catch (e) { copy.customerPhoto = ''; }
      }
      return copy;
    });
    return sendJSON(res, 200, { ok: true, frames: loadFrames(), orders });
  }

  if (req.method === 'POST' && urlPath === '/admin/frame-save') {
    try {
      // Base64 images need larger body (up to ~5MB)
      const body = await readBody(req, 6e6);
      const frames = loadFrames();
      const id = String(body.id || '').trim() || ('FR-' + Date.now().toString(36));
      const size = String(body.size || '').trim();
      const requestedSizes = Array.isArray(body.availableSizes) ? body.availableSizes : [];
      const availableSizes = [...new Set(requestedSizes.map(v => String(v || '').trim()).filter(Boolean))].slice(0, 20);
      if (size && !availableSizes.includes(size)) availableSizes.unshift(size);
      const title = String(body.title || '').trim() || size + ' Frame';
      const price = Number(body.price) || 0;
      const discountPercent = Math.min(90, Math.max(0, Number(body.discountPercent != null ? body.discountPercent : body.discount) || 0));
      const active = body.active !== false && body.active !== 'false';
      const imageData = String(body.imageData || '').slice(0, 4e6); // ~4MB base64 cap
      const imageUrl = String(body.imageUrl || '').trim();
      if (!size) return sendJSON(res, 400, { ok: false, error: 'size-required', message: 'Size required' });
      const idx = frames.findIndex(f => f.id === id);
      const row = {
        id, size, availableSizes: availableSizes.length ? availableSizes : [size], title, price, discountPercent, active,
        imageData: imageData || (idx >= 0 ? frames[idx].imageData : '') || '',
        imageUrl: imageUrl || (idx >= 0 ? frames[idx].imageUrl : '') || '',
        createdAt: idx >= 0 ? frames[idx].createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      if (idx >= 0) frames[idx] = row; else frames.unshift(row);
      saveFrames(frames);
      console.log('[frame-save]', row.id, row.size, row.title, 'img', (row.imageData || '').length, 'bytes');
      return sendJSON(res, 200, { ok: true, frame: { id: row.id, size: row.size, availableSizes: row.availableSizes, title: row.title, price: row.price, discountPercent: row.discountPercent, active: row.active, hasImage: !!(row.imageData || row.imageUrl) } });
    } catch (e) {
      console.error('frame-save', e);
      const msg = (e && e.message === 'too large') ? 'Image too large — 2MB se chhoti photo choose karo' : 'server-error';
      return sendJSON(res, 500, { ok: false, error: msg, message: msg });
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/frame-delete') {
    try {
      const body = await readBody(req);
      const id = String(body.id || '').trim();
      let frames = loadFrames().filter(f => f.id !== id);
      saveFrames(frames);
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 500, { ok: false });
    }
  }



  if (req.method === 'POST' && urlPath === '/admin/quality-save') {
    try {
      const body = await readBody(req);
      const cur = loadSettings();
      let list = Array.isArray(body.options) ? body.options : [];
      list = list.map((q, i) => ({
        id: String(q.id || ('q' + (i + 1))).trim().slice(0, 40) || ('q' + (i + 1)),
        label: String(q.label || '').trim().slice(0, 60) || ('Option ' + (i + 1)),
        sub: String(q.sub || '').trim().slice(0, 80),
        extra: Math.max(0, Number(q.extra) || 0)
      })).filter(q => q.label);
      if (!list.length) {
        list = (defaultSettings().qualityOptions || []).slice();
      }
      cur.qualityOptions = list;
      saveSettings(cur);
      return sendJSON(res, 200, { ok: true, qualityOptions: list });
    } catch (e) {
      console.error('quality-save', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }


  if (req.method === 'POST' && urlPath === '/admin/ui-save') {
    try {
      const body = await readBody(req);
      const cur = loadSettings();
      cur.adminUi = cur.adminUi || { hidden: {} };
      if (body.hidden && typeof body.hidden === 'object') {
        cur.adminUi.hidden = body.hidden;
      }
      if (body.sectionId && typeof body.visible === 'boolean') {
        cur.adminUi.hidden = cur.adminUi.hidden || {};
        if (body.visible) delete cur.adminUi.hidden[body.sectionId];
        else cur.adminUi.hidden[body.sectionId] = true;
      }
      saveSettings(cur);
      return sendJSON(res, 200, { ok: true, adminUi: cur.adminUi });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/fees-save') {
    try {
      const body = await readBody(req);
      const cur = loadSettings();
      const fees = Object.assign({}, cur.fees || {}, {
        platformFee: Math.max(0, Number(body.platformFee) || 0),
        deliveryFee: Math.max(0, Number(body.deliveryFee) || 0),
        platformMode: ['always','never','above_amount'].includes(String(body.platformMode)) ? String(body.platformMode) : 'always',
        platformMinAmount: Math.max(0, Number(body.platformMinAmount) || 0),
        deliveryMode: ['always','never','free_above','above_amount'].includes(String(body.deliveryMode)) ? String(body.deliveryMode) : 'always',
        deliveryMinAmount: Math.max(0, Number(body.deliveryMinAmount) || 0),
        deliveryFreeAbove: Math.max(0, Number(body.deliveryFreeAbove) || 0)
      });
      cur.fees = fees;
      saveSettings(cur);
      return sendJSON(res, 200, { ok: true, fees });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/frame-order-update') {
    try {
      const body = await readBody(req);
      const orderId = String(body.orderId || '').trim();
      const orders = loadFrameOrders();
      const ord = orders.find(o => o.orderId === orderId);
      if (!ord) return sendJSON(res, 404, { ok: false, error: 'not-found' });
      if (body.status) ord.status = String(body.status);
      if (body.paymentStatus) ord.paymentStatus = String(body.paymentStatus);
      if (body.deliveryDate !== undefined) ord.deliveryDate = String(body.deliveryDate || '');
      if (body.deliveryTime !== undefined) ord.deliveryTime = String(body.deliveryTime || '');
      if (body.adminNote !== undefined) ord.adminNote = String(body.adminNote || '');
      // Opening/updating an order acknowledges the new-order alert in admin.
      ord.adminAlert = false;
      // Admin payment confirm shortcut
      if (body.confirmPayment === true || body.confirmPayment === 'true') {
        ord.paymentStatus = 'confirmed';
        if (!ord.status || ord.status === 'processing' || ord.status === 'pending') {
          ord.status = 'confirmed';
        }
      }
      if (body.reject === true || body.reject === 'true') {
        ord.status = 'rejected';
        const reason = String(body.rejectReason || body.adminNote || '').trim().slice(0, 300);
        if (reason) ord.adminNote = reason;
        ord.rejectedAt = new Date().toISOString();
      }
      ord.updatedAt = new Date().toISOString();
      saveFrameOrders(orders);
      // notify customer
      const notifs = loadNotifs();
      const stLabel = ord.status || 'updated';
      const payLabel = ord.paymentStatus || '';
      notifs.unshift({
        id: 'n-' + Date.now(),
        title: '📦 Order Update — ' + orderId,
        body: (ord.frameTitle || 'Frame') + ' · Status: ' + stLabel
          + (payLabel ? ' · Payment: ' + payLabel : '')
          + (ord.deliveryDate ? ' · Delivery: ' + ord.deliveryDate + ' ' + (ord.deliveryTime || '') : '')
          + (ord.adminNote ? ' · Note: ' + ord.adminNote : ''),
        at: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        mobile: ord.mobile
      });
      saveNotifs(notifs.slice(0, 50));
      void sendTelegramAlert('Order Status Updated', 'Order: ' + orderId + '\nCustomer: ' + (ord.name || ord.mobile) + '\nStatus: ' + stLabel + '\nPayment: ' + (payLabel || '—') + (ord.deliveryDate ? '\nDelivery: ' + ord.deliveryDate + ' ' + (ord.deliveryTime || '') : ''));
      return sendJSON(res, 200, { ok: true, order: ord });
    } catch (e) {
      console.error('frame-order-update', e);
      return sendJSON(res, 500, { ok: false });
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/telegram-test') {
    const ok = await sendTelegramAlert('Telegram Test सफल', 'Aditya Studio bot connected hai. Ab new order, wallet recharge aur important admin alerts yahan aayenge.');
    res.writeHead(302, { Location: '/admin?telegram=' + (ok ? 'ok' : 'fail') }); return res.end();
  }

  if (req.method === 'POST' && urlPath === '/admin/send-notification') {
    try {
      const body = await readFormBody(req);
      const title = String(body.title || '').trim() || 'Aditya Studio';
      const bodyText = String(body.body || body.message || '').trim();
      const mobile = String(body.mobile || '').replace(/\D/g, '');
      if (!bodyText) {
        res.writeHead(302, { Location: '/admin?notif=empty' });
        return res.end();
      }
      if (mobile && !/^[6-9]\d{9}$/.test(mobile)) {
        res.writeHead(302, { Location: '/admin?notif=invalid-mobile' });
        return res.end();
      }
      // expiresIn: hours (0 = never)
      let hours = parseInt(String(body.expiresIn || '24'), 10);
      if (isNaN(hours) || hours < 0) hours = 24;
      const id = 'N-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      const item = {
        id,
        title,
        body: bodyText,
        at: new Date().toISOString(),
        expiresAt: hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null,
        mobile: mobile || ''
      };
      const list = loadNotifs();
      list.unshift(item);
      saveNotifs(list);
      void sendTelegramAlert('Admin Notification Sent', (mobile ? 'Personal alert to: ' + mobile : 'Studio alert to all customers') + '\nTitle: ' + title + '\nMessage: ' + bodyText);
      console.log('Notif saved:', title, 'expires', item.expiresAt || 'never');
      res.writeHead(302, { Location: '/admin?notif=ok' });
      return res.end();
    } catch (e) {
      console.error('notif', e);
      res.writeHead(302, { Location: '/admin?notif=fail' });
      return res.end();
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/delete-notification') {
    try {
      const body = await readFormBody(req);
      const id = String(body.id || '').trim();
      let list = loadNotifs();
      list = list.filter(n => String(n.id || n.at) !== id);
      saveNotifs(list);
      console.log('Notif deleted:', id);
      res.writeHead(302, { Location: '/admin?notif=deleted' });
      return res.end();
    } catch (e) {
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

  // Banner photos — multi upload (base64) from admin — unlimited list (cap 30)
  if (req.method === 'POST' && urlPath === '/admin/banner-upload') {
    try {
      const body = await readBody(req, 40e6);
      const cur = loadSettings();
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return sendJSON(res, 400, { ok: false, error: 'no-items' });
      const mapped = items.slice(0, 30).map((it, i) => ({
        url: String(it.url || it.dataUrl || '').slice(0, 2.5e6),
        title: String(it.title || ('Banner ' + (i + 1))).slice(0, 120),
        sub: String(it.sub || '').slice(0, 200)
      })).filter(x => x.url);
      if (!mapped.length) return sendJSON(res, 400, { ok: false, error: 'invalid' });
      if (body.replace === true || body.replace === 'true') {
        cur.offerImages = mapped;
      } else {
        cur.offerImages = (cur.offerImages || []).concat(mapped).slice(0, 30);
      }
      saveSettings(cur);
      return sendJSON(res, 200, { ok: true, count: cur.offerImages.length });
    } catch (e) {
      console.error('banner-upload', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  // Current Deals cards shown on the home page. Each card has its own photo/text/link.
  if (req.method === 'POST' && urlPath === '/admin/home-deals-save') {
    try {
      const body = await readBody(req, 28e6);
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 12).map((it, i) => ({
        url: String(it.url || '').slice(0, 2.5e6),
        title: String(it.title || ('Deal ' + (i + 1))).trim().slice(0, 80),
        sub: String(it.sub || '').trim().slice(0, 160),
        link: String(it.link || '').trim().slice(0, 300),
        active: it.active !== false
      })).filter(it => it.url);
      if (!items.length) return sendJSON(res, 400, { ok: false, error: 'no-deals', message: 'Kam se kam ek photo wala deal card zaroori hai.' });
      const cur = loadSettings();
      cur.offerImages = items;
      cur.homeDealsEnabled = true;
      cur.homeDealsDurationSec = Math.max(8, Math.min(60, Number(body.durationSec) || 20));
      saveSettings(cur);
      return sendJSON(res, 200, { ok: true, count: items.length, durationSec: cur.homeDealsDurationSec });
    } catch (e) {
      console.error('home-deals-save', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  // Colorful CTA on the Login/Register page (admin editable).
  if (req.method === 'POST' && urlPath === '/admin/save-login-promo') {
    try {
      const body = await readFormBody(req);
      const defaults = defaultSettings().loginPromo;
      const color = function(v, fallback) { return /^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : fallback; };
      const cur = loadSettings();
      cur.loginPromo = {
        text: String(body.text || defaults.text).trim().slice(0, 140),
        link: String(body.link || defaults.link).trim().slice(0, 300),
        colorA: color(body.colorA, defaults.colorA),
        colorB: color(body.colorB, defaults.colorB),
        textColor: color(body.textColor, defaults.textColor)
      };
      saveSettings(cur);
      res.writeHead(302, { Location: '/admin?loginPromo=ok#sec-login-promo' });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: '/admin?loginPromo=fail#sec-login-promo' });
      return res.end();
    }
  }

  // Home hero intro text (admin editable)
  if (req.method === 'POST' && urlPath === '/admin/save-hero-intro') {
    try {
      const body = await readFormBody(req);
      const cur = loadSettings();
      const d = defaultSettings().heroIntro;
      cur.heroIntro = {
        welcomeText: String(body.welcomeText || d.welcomeText).slice(0, 200),
        welcomeDurationSec: Math.max(2, Math.min(20, Number(body.welcomeDurationSec) || d.welcomeDurationSec)),
        eyebrow: String(body.eyebrow || d.eyebrow).slice(0, 80),
        headline: String(body.headline || d.headline).slice(0, 120),
        headlineGold: String(body.headlineGold || d.headlineGold).slice(0, 80),
        headlineRest: String(body.headlineRest || d.headlineRest).slice(0, 80),
        subtext: String(body.subtext || d.subtext).slice(0, 400),
        btnPrimary: String(body.btnPrimary || d.btnPrimary).slice(0, 60),
        btnSecondary: String(body.btnSecondary || d.btnSecondary).slice(0, 60)
      };
      saveSettings(cur);
      res.writeHead(302, { Location: '/admin?hero=ok#sec-hero' });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: '/admin?hero=fail#sec-hero' });
      return res.end();
    }
  }

  // 3D frames shop sample photos (rotate in viewer)
  if (req.method === 'POST' && urlPath === '/admin/frames3d-upload') {
    try {
      const body = await readBody(req, 40e6);
      const cur = loadSettings();
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return sendJSON(res, 400, { ok: false, error: 'no-items' });
      const mapped = items.slice(0, 20).map((it, i) => ({
        url: String(it.url || it.dataUrl || '').slice(0, 2.5e6),
        title: String(it.title || ('Photo ' + (i + 1))).slice(0, 80)
      })).filter(x => x.url);
      if (!mapped.length) return sendJSON(res, 400, { ok: false, error: 'invalid' });
      if (body.replace === true || body.replace === 'true') {
        cur.frames3dPhotos = mapped;
      } else {
        cur.frames3dPhotos = (cur.frames3dPhotos || []).concat(mapped).slice(0, 30);
      }
      saveSettings(cur);
      return sendJSON(res, 200, { ok: true, count: (cur.frames3dPhotos || []).length });
    } catch (e) {
      console.error('frames3d-upload', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }
  if (req.method === 'POST' && urlPath === '/admin/frames3d-clear') {
    try {
      const cur = loadSettings();
      cur.frames3dPhotos = [];
      saveSettings(cur);
      return sendJSON(res, 200, { ok: true, count: 0 });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  // Home page hero floating-frame photos (max 5)
  if (req.method === 'POST' && urlPath === '/admin/home-hero-frame-upload') {
    try {
      const body = await readBody(req, 25e6);
      const cur = loadSettings();
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return sendJSON(res, 400, { ok: false, error: 'no-items' });
      const mapped = items.slice(0, 5).map((it, i) => ({
        url: String(it.url || it.dataUrl || '').slice(0, 2.5e6),
        title: String(it.title || ('Hero ' + (i + 1))).slice(0, 80)
      })).filter(x => x.url);
      if (!mapped.length) return sendJSON(res, 400, { ok: false, error: 'invalid' });
      if (body.replace === true || body.replace === 'true') {
        cur.homeHeroFramePhotos = mapped.slice(0, 5);
      } else {
        cur.homeHeroFramePhotos = (cur.homeHeroFramePhotos || []).concat(mapped).slice(0, 5);
      }
      saveSettings(cur);
      return sendJSON(res, 200, { ok: true, count: (cur.homeHeroFramePhotos || []).length });
    } catch (e) {
      console.error('home-hero-frame-upload', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }
  if (req.method === 'POST' && urlPath === '/admin/home-hero-frame-clear') {
    try {
      const cur = loadSettings();
      cur.homeHeroFramePhotos = [];
      saveSettings(cur);
      return sendJSON(res, 200, { ok: true, count: 0 });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }

  // Hero section SIDE background photos (4–6) + duration
  if (req.method === 'POST' && urlPath === '/admin/hero-side-bg-upload') {
    try {
      const body = await readBody(req, 30e6);
      const cur = loadSettings();
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return sendJSON(res, 400, { ok: false, error: 'no-items' });
      const mapped = items.slice(0, 6).map((it, i) => ({
        url: String(it.url || it.dataUrl || '').slice(0, 2.5e6),
        title: String(it.title || ('BG ' + (i + 1))).slice(0, 80)
      })).filter(x => x.url);
      if (!mapped.length) return sendJSON(res, 400, { ok: false, error: 'invalid' });
      if (body.replace === true || body.replace === 'true') {
        cur.heroSideBgPhotos = mapped.slice(0, 6);
      } else {
        cur.heroSideBgPhotos = (cur.heroSideBgPhotos || []).concat(mapped).slice(0, 6);
      }
      if (body.durationSec != null) {
        cur.heroSideBgDurationSec = Math.max(2, Math.min(20, Number(body.durationSec) || 5));
      }
      saveSettings(cur);
      return sendJSON(res, 200, {
        ok: true,
        count: (cur.heroSideBgPhotos || []).length,
        durationSec: cur.heroSideBgDurationSec
      });
    } catch (e) {
      console.error('hero-side-bg-upload', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }
  if (req.method === 'POST' && urlPath === '/admin/hero-side-bg-duration') {
    try {
      const body = await readBody(req, 1e5);
      const cur = loadSettings();
      cur.heroSideBgDurationSec = Math.max(2, Math.min(20, Number(body.durationSec) || 5));
      saveSettings(cur);
      return sendJSON(res, 200, { ok: true, durationSec: cur.heroSideBgDurationSec });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }
  if (req.method === 'POST' && urlPath === '/admin/hero-side-bg-clear') {
    try {
      const cur = loadSettings();
      cur.heroSideBgPhotos = [];
      saveSettings(cur);
      return sendJSON(res, 200, { ok: true, count: 0 });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
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
      res.writeHead(302, { Location: '/admin?books=ok#sec-book' });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: '/admin?books=fail#sec-book' });
      return res.end();
    }
  }

  // Book card photo — direct file upload (base64 JSON)
  if (req.method === 'POST' && urlPath === '/admin/book-image-upload') {
    try {
      const body = await readBody(req, 8e6);
      const key = String(body.key || '').trim().toLowerCase();
      const allowed = ['wedding', 'birthday', 'personal', 'reel', 'event', 'other'];
      if (!allowed.includes(key)) return sendJSON(res, 400, { ok: false, error: 'invalid-key' });
      const url = String(body.url || body.dataUrl || '').slice(0, 2.5e6);
      if (!url || !url.startsWith('data:image/')) return sendJSON(res, 400, { ok: false, error: 'invalid-image' });
      const cur = loadSettings();
      cur.bookImages = cur.bookImages || {};
      cur.bookImages[key] = url;
      saveSettings(cur);
      return sendJSON(res, 200, { ok: true, key, preview: url.slice(0, 80) + '…' });
    } catch (e) {
      console.error('book-image-upload', e);
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
  }


  if (req.method === 'POST' && urlPath === '/admin/coupon-action') {
    try {
      const body = await readFormBody(req);
      const mobile = String(body.mobile || '').trim();
      const couponId = String(body.couponId || '').trim();
      const action = String(body.action || '').trim(); // accept | delete
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (acc && couponId && (action === 'accept' || action === 'delete')) {
        let linkedCode = null;
        acc.history = (acc.history || []).map(h => {
          const id = String(h.couponId || h.entryId || '');
          if (id !== couponId) return h;
          linkedCode = h.code || null;
          if (action === 'delete') return { ...h, couponStatus: 'deleted', deletedAt: new Date().toISOString() };
          return { ...h, couponStatus: 'accepted', acceptedAt: new Date().toISOString() };
        });
        saveAccounts(accounts);
        // Accept → spin code history se prize "redeemed at shop" mark; hide from active coupon lists
        if (action === 'accept') {
          const codes = loadCodes();
          let changed = false;
          codes.forEach(c => {
            const matchUser = c.usedBy && (String(c.usedBy).includes(mobile) || String(c.usedBy).includes(acc.id));
            const matchCode = linkedCode && String(c.code).toUpperCase() === String(linkedCode).toUpperCase();
            if (matchUser || matchCode) {
              c.couponAccepted = true;
              c.couponAcceptedAt = new Date().toISOString();
              c.prize = (c.prize || '') + ' (Redeemed)';
              changed = true;
            }
          });
          if (changed) saveCodes(codes);
        }
        console.log('Coupon', action, mobile, couponId);
      }
      res.writeHead(302, { Location: '/admin#accList' });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: '/admin' });
      return res.end();
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/delete-account') {
    try {
      const body = await readFormBody(req);
      const mobile = String(body.mobile || '').trim();
      let accounts = loadAccounts();
      const before = accounts.length;
      accounts = accounts.filter(a => String(a.mobile) !== mobile);
      if (accounts.length < before) {
        saveAccounts(accounts);
        console.log('Account deleted:', mobile);
      }
      res.writeHead(302, { Location: '/admin?del=ok#accList' });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: '/admin' });
      return res.end();
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/verify-account') {
    try {
      const body = await readFormBody(req);
      const mobile = String(body.mobile || '').trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (acc) {
        acc.mobileVerified = true;
        saveAccounts(accounts);
        console.log('Account verified by admin:', mobile);
      }
      res.writeHead(302, { Location: '/admin?ver=ok#accList' });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: '/admin' });
      return res.end();
    }
  }

  if (req.method === 'POST' && urlPath === '/admin/delete-spin-code') {
    try {
      const body = await readFormBody(req);
      const code = String(body.code || '').trim().toUpperCase();
      let codes = loadCodes();
      codes = codes.filter(c => String(c.code).toUpperCase() !== code);
      saveCodes(codes);
      console.log('Spin code deleted:', code);
      res.writeHead(302, { Location: '/admin?codeel=ok#codes' });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: '/admin' });
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
      setPin(acc, newPin);
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


  if (req.method === 'GET' && urlPath === '/admin/live-json') {
    const accounts = loadAccounts();
    const pendingResets = accounts.filter(a => a.pinResetRequested).map(a => ({
      id: a.id, name: a.name, mobile: a.mobile,
      at: a.pinResetRequestedAt || null
    }));
    const pendingOtps = loadOtpRequests().filter(r => !r.verified).map(r => ({
      mobile: r.mobile, name: r.name || '', id: r.id || '',
      at: r.createdAt || null, expiresAt: r.expiresAt || null,
      manualOtp: r.manualOtp || '', delivery: r.delivery || 'sms'
    }));
    const codes = loadCodes();
    const notifs = loadNotifs().slice(0, 10);
    const latestOrder = (loadFrameOrders()[0]) || null;
    return sendJSON(res, 200, {
      ok: true,
      at: new Date().toISOString(),
      counts: {
        customers: accounts.length,
        pendingOtp: pendingOtps.length,
        pendingPin: pendingResets.length,
        unusedCodes: codes.filter(c => !c.used).length,
        notifs: notifs.length,
        orders: loadFrameOrders().length
      },
      pendingOtps,
      pendingResets,
      notifications: notifs,
      latestOrder: latestOrder ? {
        orderId: latestOrder.orderId,
        name: latestOrder.name || '',
        mobile: latestOrder.mobile || '',
        createdAt: latestOrder.createdAt || '',
        paymentStatus: latestOrder.paymentStatus || ''
      } : null
    });
  }

  if (req.method === 'GET' && urlPath === '/admin/orders-csv') {
    const u = new URL(req.url, 'http://x');
    const range = String(u.searchParams.get('range') || 'all').toLowerCase();
    const now = new Date();
    const start = new Date(now);
    if (range === 'today') start.setHours(0, 0, 0, 0);
    else if (range === 'week') start.setDate(start.getDate() - 7);
    else if (range === 'month') start.setMonth(start.getMonth() - 1);
    const rows = loadFrameOrders().filter(o => {
      if (range === 'all') return true;
      const created = new Date(o.createdAt || 0);
      return !isNaN(created) && created >= start;
    });
    const csvCell = value => '"' + String(value == null ? '' : value).replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"';
    const headings = ['Order No', 'Order Date', 'Customer', 'Mobile', 'Frame', 'Size', 'Total', 'Due', 'UTR', 'Payment Status', 'Order Status', 'Address', 'Admin Note'];
    const csv = [headings, ...rows.map(o => [
      o.orderId, o.createdAt, o.name, o.mobile, o.frameTitle, o.size, o.finalAmount, o.amountDue,
      o.utr, o.paymentStatus, o.status, [o.address, o.village, o.district, o.state, o.pincode].filter(Boolean).join(', '), o.adminNote
    ])].map(row => row.map(csvCell).join(',')).join('\r\n');
    const stamp = now.toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="aditya-studio-orders-' + range + '-' + stamp + '.csv"'
    });
    return res.end('\ufeff' + csv);
  }


  if (req.method === 'GET' && urlPath === '/admin/orders') {
    const html = `<!DOCTYPE html>
<html lang="hi"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Orders — Aditya Studio</title>
<script>window.alert=function(m){function s(){var o=document.getElementById('adityaPageAlert');if(o)o.remove();var t=String(m||''),bad=/(fail|error|wrong|network|nahi|नहीं|गलत|invalid|missing|expire|chhoti|required|check)/i.test(t),b=document.createElement('div');b.id='adityaPageAlert';b.style.cssText='position:fixed;left:16px;right:16px;top:18px;z-index:99999;max-width:520px;margin:auto;padding:13px 42px 13px 15px;border-radius:13px;font:600 14px Arial,sans-serif;line-height:1.45;color:'+(bad?'#fecaca':'#dcfce7')+';background:'+(bad?'#571b22':'#14532d')+';border:1px solid '+(bad?'#ef4444':'#4ade80')+';box-shadow:0 12px 30px rgba(0,0,0,.42)';b.innerHTML=(bad?'⚠️ ':'✅ ')+t+'<button style="position:absolute;right:10px;top:8px;border:0;background:transparent;color:inherit;font-size:22px">×</button>';b.querySelector('button').onclick=function(){b.remove()};document.body.appendChild(b);setTimeout(function(){b.remove()},5000)}if(document.body)s();else document.addEventListener('DOMContentLoaded',s,{once:true})}</script>
<style>
:root{--bg:#0c0a09;--card:#1c1917;--gold:#D4AF37;--muted:#a8a29e;--text:#f5f5f4}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);padding:16px;max-width:920px;margin-inline:auto}
a{color:var(--gold)}h1{font-size:1.3rem;margin:0 0 6px;color:var(--gold)}.sub{color:var(--muted);font-size:13px;margin:0 0 14px}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.filters a{padding:8px 14px;border-radius:999px;border:1px solid rgba(212,175,55,.35);color:var(--gold);text-decoration:none;font-size:13px}
.filters a.active{background:rgba(212,175,55,.18)}
.toolbar{display:grid;grid-template-columns:1fr auto auto;gap:8px;margin:0 0 14px}.toolbar input,.toolbar select{width:100%;padding:10px;border-radius:9px;border:1px solid rgba(212,175,55,.3);background:#0c0a09;color:var(--text)}.csv-link{padding:10px 12px;border:1px solid rgba(212,175,55,.35);border-radius:9px;color:var(--gold);text-decoration:none;font-size:13px;white-space:nowrap}@media(max-width:600px){.toolbar{grid-template-columns:1fr}.csv-link{text-align:center}}
.msg-card{background:var(--card);border:1px solid rgba(212,175,55,.22);border-radius:14px;padding:14px;margin-top:12px}
.msg-text{font-size:14px;line-height:1.5}.muted{color:var(--muted);font-size:12px}
.inp{width:100%;max-width:240px;padding:8px 10px;border-radius:8px;border:1px solid rgba(212,175,55,.3);background:#0c0a09;color:var(--text)}
.gen-btn{padding:8px 14px;border-radius:8px;border:none;background:linear-gradient(135deg,#D4AF37,#b8860b);color:#1a1200;font-weight:700;cursor:pointer}
.btn-reject{padding:8px 12px;background:#7f1d1d;color:#fecaca;border:1px solid #991b1b;border-radius:8px;cursor:pointer}
.btn-ok{padding:8px 12px;background:#14532d;color:#bbf7d0;border:1px solid #166534;border-radius:8px;cursor:pointer}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
#imgView{display:none;position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9999;align-items:center;justify-content:center;padding:16px;flex-direction:column;gap:12px}
#imgView.show{display:flex}
#imgView img{max-width:94vw;max-height:78vh;border-radius:12px;border:2px solid #D4AF37;background:#111}
</style></head><body>
<div id="imgView" onclick="if(event.target===this)closeImg()"><img alt="view"/><button type="button" class="gen-btn" onclick="closeImg()">Close</button></div>
<div class="topbar"><div><h1>📦 Frame Orders</h1><p class="sub">Alag page — filter, confirm, reject fake orders.</p></div><a href="/admin">← Admin home</a></div>
<div class="filters" id="filters">
<a href="/admin/orders?filter=all" data-f="all">📋 Order Dashboard</a>
<a href="/admin/orders?filter=unread" data-f="unread">🔔 New <span id="unreadCount">0</span></a>
<a href="/admin/orders?filter=new" data-f="new">Pending</a>
<a href="/admin/orders?filter=confirmed" data-f="confirmed">Confirmed</a>
<a href="/admin/orders?filter=pay_pending" data-f="pay_pending">Pay Pending</a>
<a href="/admin/orders?filter=recovery" data-f="recovery">🗃️ Recovery Orders</a>
<a href="/admin/orders?filter=delivered" data-f="delivered">Delivered</a>
</div>
<div class="toolbar">
<input id="orderSearch" type="search" placeholder="Search: Order No., mobile ya customer name" autocomplete="off"/>
<select id="dateRange"><option value="all">All dates</option><option value="today">Today</option><option value="week">Last 7 days</option><option value="month">Last 30 days</option></select>
<a class="csv-link" id="csvDownload" href="/admin/orders-csv?range=all">⬇️ Excel CSV</a>
</div>
<div id="list" class="muted">Loading…</div>
<script>
function esc(t){return String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmt(iso){try{var d=new Date(iso);return isNaN(d)?'—':d.toLocaleString('en-IN');}catch(e){return '—';}}
var FILTER=(new URLSearchParams(location.search).get('filter')||'all').toLowerCase();
var SEARCH=''; var RANGE='all'; var ORDERS_BY_ID={};
document.querySelectorAll('#filters a').forEach(function(a){if(a.getAttribute('data-f')===FILTER)a.classList.add('active');});
function matchFilter(o){
  var st=String(o.status||'processing').toLowerCase();
  var pay=String(o.paymentStatus||'unpaid').toLowerCase();
  // Rejected orders are intentionally kept out of the daily active queue.
  if(FILTER==='all')return st!=='rejected'&&st!=='cancelled';
  if(FILTER==='unread')return !!o.adminAlert;
  if(FILTER==='new'||FILTER==='pending')return st==='processing'||st==='pending'||st==='';
  if(FILTER==='confirmed')return st==='confirmed'||st==='ready';
  if(FILTER==='delivered')return st==='delivered';
  if(FILTER==='recovery'||FILTER==='rejected')return st==='rejected'||st==='cancelled';
  if(FILTER==='pay_pending')return pay==='unpaid'||pay==='paid_claimed';
  return true;
}
function dateMatches(o){if(RANGE==='all')return true;var d=new Date(o.createdAt||0);if(isNaN(d))return false;var now=new Date();if(RANGE==='today')return d.toDateString()===now.toDateString();var days=RANGE==='week'?7:30;return d>=new Date(now.getTime()-days*86400000);}
function searchMatches(o){if(!SEARCH)return true;var hay=[o.orderId,o.mobile,o.name,o.frameTitle,o.utr].join(' ').toLowerCase();return hay.indexOf(SEARCH)>=0;}
document.getElementById('orderSearch').addEventListener('input',function(){SEARCH=this.value.trim().toLowerCase();loadOrdersPage();});
document.getElementById('dateRange').addEventListener('change',function(){RANGE=this.value;document.getElementById('csvDownload').href='/admin/orders-csv?range='+encodeURIComponent(RANGE);loadOrdersPage();});
function viewImg(src){var m=document.getElementById('imgView');if(!m||!src)return;m.querySelector('img').src=src;m.classList.add('show');}
function closeImg(){var m=document.getElementById('imgView');if(!m)return;m.classList.remove('show');m.querySelector('img').src='';}
function dlImg(src,name){if(!src)return;try{var a=document.createElement('a');a.href=src;a.download=name||'photo.jpg';document.body.appendChild(a);a.click();a.remove();}catch(e){window.open(src,'_blank');}}
function waCustomer(mobile,orderId,status,payment){var n=String(mobile||'').replace(/\D/g,'');if(n.length!==10)return alert('Customer mobile invalid');var msg='Namaste, Aditya Studio se aapke order '+orderId+' ka update: Status '+(status||'updated')+(payment?' | Payment '+payment:'')+'. Dhanyavaad.';window.open('https://wa.me/91'+n+'?text='+encodeURIComponent(msg),'_blank');}
var _ordMedia={n:0};
function stashMedia(src){var id='k'+(++_ordMedia.n);_ordMedia[id]=src;return id;}
function mediaBlock(src,label,fname){
  if(!src) return '<div class="muted" style="margin-top:8px">'+label+' nahi mila</div>';
  var id=stashMedia(src);
  return '<div style="margin-top:10px;padding:10px;background:#0c0a09;border:1px solid rgba(212,175,55,.28);border-radius:10px">'
    +'<b style="color:#D4AF37">'+label+'</b>'
    +'<div style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
    +'<img src="'+src+'" alt="" onclick="viewImg(_ordMedia.'+id+')" style="width:110px;height:110px;object-fit:cover;border-radius:10px;border:2px solid #D4AF37;cursor:zoom-in;background:#111" title="Click to view"/>'
    +'<button type="button" class="gen-btn" onclick="viewImg(_ordMedia.'+id+')">View</button>'
    +'<button type="button" class="gen-btn" onclick="dlImg(_ordMedia.'+id+',\\''+esc(fname)+'\\')">Download</button>'
    +'</div></div>';
}
function proofCard(o){return '<div style="margin-top:10px;padding:11px;background:#0c0a09;border:1px solid rgba(212,175,55,.35);border-radius:11px"><b style="color:#D4AF37">💳 Payment & Photos</b><div class="muted" style="margin-top:4px">Payment: '+esc(o.paymentStatus||'unpaid')+(o.utr?' · UTR: '+esc(o.utr):' · UTR nahi mila')+'</div>'+mediaBlock(o.paymentScreenshot,'Payment screenshot','payment-'+o.orderId+'.jpg')+mediaBlock(o.customerPhoto,'Customer photo','customer-photo-'+o.orderId+'.jpg')+'</div>';}
function card(o){
  var rejected=['rejected','cancelled'].indexOf(String(o.status||'').toLowerCase())>=0;
  var accepted=!rejected&&['processing','pending',''].indexOf(String(o.status||'').toLowerCase())<0;
  var name=esc(o.name||'Customer'), pay=esc(o.paymentStatus||'unpaid'), status=esc(o.status||'processing');
  return '<div class="msg-card" style="padding:15px;'+(rejected?'border-color:rgba(239,68,68,.65);background:linear-gradient(135deg,#291014,#170c0e)':'background:linear-gradient(135deg,#201b16,#120f0d)')+'">'
    +'<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;border-bottom:1px solid rgba(250,204,21,.22);padding-bottom:11px">'
      +'<div style="min-width:0"><div style="font-size:20px;line-height:1.15;font-weight:900;background:linear-gradient(90deg,#fde68a,#f59e0b,#fb7185);-webkit-background-clip:text;background-clip:text;color:transparent;word-break:break-word">👤 '+name+'</div>'
      +'<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap"><span style="padding:4px 8px;border-radius:999px;background:#172554;border:1px solid #38bdf8;color:#bae6fd;font-size:11px;font-weight:800">ID: '+esc(o.orderId)+'</span><span style="padding:4px 8px;border-radius:999px;background:#3f1d2e;border:1px solid #fb7185;color:#fecdd3;font-size:11px;font-weight:800">'+status+'</span></div></div>'
      +(o.adminAlert?'<span style="flex:0 0 auto;padding:6px 8px;border-radius:9px;background:#7f1d1d;color:#fef08a;font-size:10px;font-weight:900;box-shadow:0 0 14px rgba(239,68,68,.35)">🔔 NEW</span>':'')
    +'</div>'
    +'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin-top:11px">'
      +'<div style="padding:9px;border-radius:10px;background:linear-gradient(135deg,#102c3c,#10212f);border:1px solid rgba(34,211,238,.35)"><small style="display:block;color:#67e8f9;font-weight:800">📞 CONTACT</small><b style="color:#e0f2fe">'+esc(o.mobile||'—')+'</b></div>'
      +'<div style="padding:9px;border-radius:10px;background:linear-gradient(135deg,#30240e,#21170a);border:1px solid rgba(250,204,21,.35)"><small style="display:block;color:#fcd34d;font-weight:800">💰 ORDER TOTAL</small><b style="color:#fef3c7">₹'+(o.finalAmount||0)+'</b>'+(o.amountDue!=null?'<span style="font-size:11px;color:#fde68a"> · Due ₹'+o.amountDue+'</span>':'')+'</div>'
      +'<div style="padding:9px;border-radius:10px;background:linear-gradient(135deg,#29143b,#1c1028);border:1px solid rgba(192,132,252,.35)"><small style="display:block;color:#d8b4fe;font-weight:800">🖼️ FRAME</small><b style="color:#f3e8ff">'+esc(o.frameTitle||'Photo Frame')+'</b><span style="display:block;font-size:11px;color:#e9d5ff">'+esc(o.size||'—')+'</span></div>'
      +'<div style="padding:9px;border-radius:10px;background:linear-gradient(135deg,#123523,#102319);border:1px solid rgba(74,222,128,.35)"><small style="display:block;color:#86efac;font-weight:800">💳 PAYMENT</small><b style="color:#dcfce7">'+pay+'</b>'+(o.walletPaid?'<span style="font-size:11px;color:#bbf7d0"> · Wallet ₹'+o.walletPaid+'</span>':'')+'</div>'
    +'</div>'
    +'<div style="margin-top:9px;padding:10px;border-radius:10px;background:#15110e;border-left:3px solid #fb7185"><b style="color:#fda4af;font-size:11px">📍 DELIVERY ADDRESS</b><div style="margin-top:3px;color:#e7e5e4">'+esc(o.address||'—')+(o.village?' · '+esc(o.village):'')+(o.district?' · '+esc(o.district):'')+(o.state?' · '+esc(o.state):'')+(o.pincode?' · PIN '+esc(o.pincode):'')+'</div></div>'
    +'<div style="margin-top:9px;padding:10px;border-radius:10px;background:#13130f;border-left:3px solid #38bdf8"><b style="color:#7dd3fc;font-size:11px">🖼️ FRAME DETAILS</b><div style="margin-top:3px;color:#d6d3d1">'+(o.orientation?'Orientation: '+esc(o.orientation)+' · ':'')+(o.qualityLabel?'Quality: '+esc(o.qualityLabel)+(o.qualityExtra?' (+₹'+o.qualityExtra+')':'')+' · ':'')+(o.colourName?'Colour: '+esc(o.colourName)+' · ':'')+'Display: '+esc(o.size||'—')+'</div></div>'
    +(o.note?'<div style="margin-top:9px;padding:9px;border-radius:9px;background:#2e220b;color:#fde68a">📝 <b>Customer note:</b> '+esc(o.note)+'</div>':'')
    +(o.trackingNumber?'<div style="margin-top:9px;color:#c4b5fd">🔖 Track: <b>'+esc(o.trackingNumber)+'</b></div>':'')+(o.adminNote?'<div style="margin-top:7px;color:#fca5a5">📌 Studio note: '+esc(o.adminNote)+'</div>':'')
    + proofCard(o)
    +'<div style="margin-top:10px;color:#a8a29e;font-size:11px">🕒 '+esc(fmt(o.createdAt))+'</div>'
    +(rejected
      ?'<div style="margin-top:12px;padding:12px;border:1px dashed rgba(212,175,55,.55);border-radius:10px"><b style="color:#D4AF37">🗃️ Recovery Order</b><div class="muted" style="margin:6px 0 10px">Reason: '+esc(o.adminNote||'Not recorded')+'</div><button class="gen-btn" onclick="restoreOrder(\\''+esc(o.orderId)+'\\')">↩️ Recover Order</button></div>'
      :'<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px" id="start-'+esc(o.orderId)+'">'
        +'<button class="btn-ok" onclick="acceptOrder(\\''+esc(o.orderId)+'\\')">✅ Accept Order</button>'
        +'<select class="inp" id="rr-'+esc(o.orderId)+'" style="max-width:220px"><option value="Payment proof invalid">Payment proof invalid</option><option value="Photo is unclear">Photo is unclear</option><option value="Address incomplete">Address incomplete</option><option value="Frame unavailable">Frame unavailable</option><option value="Other">Other reason</option></select>'
        +'<button class="btn-reject" onclick="rejectOrder(\\''+esc(o.orderId)+'\\')">❌ Reject</button>'
      +'</div>'
      +'<div id="accept-'+esc(o.orderId)+'" style="display:'+(accepted?'grid':'none')+';gap:8px;margin-top:12px;padding:12px;border:1px solid rgba(34,197,94,.4);border-radius:10px">'
        +'<b style="color:#bbf7d0">Accepted order — delivery details set karein</b>'
        +'<label class="muted">Delivery date <input class="inp" id="dd-'+esc(o.orderId)+'" type="date" value="'+esc(o.deliveryDate||'')+'"></label>'
        +'<label class="muted">Delivery time <select class="inp" id="dt-'+esc(o.orderId)+'"><option value="">Select time</option>'+['10:00 AM','12:00 PM','5:00 PM','7:00 PM'].map(function(t){return '<option value="'+t+'"'+(o.deliveryTime===t?' selected':'')+'>'+t+'</option>';}).join('')+'</select></label>'
        +'<label class="muted">Order status <select class="inp" id="st-'+esc(o.orderId)+'">'+['confirmed','ready','delivered'].map(function(s){return '<option value="'+s+'"'+(o.status===s?' selected':'')+'>'+s+'</option>';}).join('')+'</select></label>'
        +'<label class="muted">Payment <select class="inp" id="pay-'+esc(o.orderId)+'">'+['unpaid','paid_claimed','confirmed'].map(function(s){return '<option value="'+s+'"'+((o.paymentStatus||'unpaid')===s?' selected':'')+'>'+s+'</option>';}).join('')+'</select></label>'
        +'<label class="muted">Admin note <input class="inp" id="an-'+esc(o.orderId)+'" value="'+esc(o.adminNote||'')+'" style="max-width:100%"></label>'
        +'<label class="muted"><input type="checkbox" id="wa-'+esc(o.orderId)+'"> WhatsApp update kholen</label>'
        +'<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="gen-btn" onclick="updateOrder(\\''+esc(o.orderId)+'\\')">Save + Notify</button><button class="gen-btn" onclick="waCustomer(\\''+esc(o.mobile)+'\\',\\''+esc(o.orderId)+'\\')">💬 WhatsApp Customer</button>'+(o.paymentStatus!=='confirmed'?'<button class="btn-ok" onclick="confirmPay(\\''+esc(o.orderId)+'\\')">✅ Confirm Payment</button>':'')+'</div>'
      +'</div>')
    +'</div>';
}
async function loadOrdersPage(){
  // Typing ke beech auto-refresh se form close/re-render nahi hona chahiye.
  var active=document.activeElement;
  if(active&&/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))return;
  var keepScroll=window.scrollY||window.pageYOffset||0;
  _ordMedia={n:0};
  var box=document.getElementById('list');
  try{
    var res=await fetch('/admin/frames-json',{credentials:'same-origin',cache:'no-store'});
    var data=await res.json();
    var all=(data.orders||[]).slice(); ORDERS_BY_ID={}; all.forEach(function(o){ORDERS_BY_ID[o.orderId]=o;});
    var unread=all.filter(function(o){return !!o.adminAlert;}).length; document.getElementById('unreadCount').textContent=unread;
    var orders=all.reverse().filter(function(o){return matchFilter(o)&&dateMatches(o)&&searchMatches(o);});
    function section(title, icon, list, tone){return '<section style="margin:20px 0 26px"><h2 style="margin:0 0 8px;color:'+(tone||'#D4AF37')+';font-size:17px">'+icon+' '+title+' <span style="font-size:12px;opacity:.75">('+list.length+')</span></h2>'+ (list.length?list.map(card).join(''):'<div class="muted" style="padding:10px 0">Is section me abhi koi order nahi.</div>')+'</section>';}
    if(FILTER==='all'&&!SEARCH&&RANGE==='all'){
      var fresh=orders.filter(function(o){var s=String(o.status||'processing').toLowerCase();return s==='processing'||s==='pending'||s==='';});
      var accepted=orders.filter(function(o){var s=String(o.status||'').toLowerCase();return s==='confirmed'||s==='ready';});
      var delivered=orders.filter(function(o){return String(o.status||'').toLowerCase()==='delivered';});
      var oldHtml=''; var byDate={}; delivered.forEach(function(o){var k=(o.updatedAt||o.createdAt||'').slice(0,10)||'Older';(byDate[k]=byDate[k]||[]).push(o);});
      Object.keys(byDate).sort().reverse().forEach(function(k){oldHtml+=section('Delivered — '+k,'📅',byDate[k],'#a8a29e');});
      box.innerHTML=section('New Orders','🔔',fresh,'#f87171')+section('Accepted / Processing','✅',accepted,'#4ade80')+'<section style="margin:20px 0"><h2 style="margin:0 0 8px;color:#a8a29e;font-size:17px">🗓️ Old Delivered Orders</h2>'+oldHtml+'</section>';
    }else box.innerHTML=orders.length?orders.map(card).join(''):'<div class="muted">Is filter me koi order nahi</div>';
    requestAnimationFrame(function(){window.scrollTo(0,keepScroll);});
  }catch(e){box.innerHTML='<div class="muted">Load fail</div>';requestAnimationFrame(function(){window.scrollTo(0,keepScroll);});}
}
async function updateOrder(id){
  var body={orderId:id,status:(document.getElementById('st-'+id)||{}).value,paymentStatus:(document.getElementById('pay-'+id)||{}).value,deliveryDate:(document.getElementById('dd-'+id)||{}).value,deliveryTime:(document.getElementById('dt-'+id)||{}).value,adminNote:(document.getElementById('an-'+id)||{}).value};
  var res=await fetch('/admin/frame-order-update',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  var data=await res.json();if(data.ok){var o=data.order||ORDERS_BY_ID[id]||{};if((document.getElementById('wa-'+id)||{}).checked)waCustomer(o.mobile,id,o.status,o.paymentStatus);alert('Updated ✅');loadOrdersPage();}else alert('Fail');
}
function acceptOrder(id){var a=document.getElementById('accept-'+id),s=document.getElementById('start-'+id);if(a)a.style.display='grid';if(s)s.style.display='none';}
async function confirmPay(id){
  if(!confirm('Payment confirm?'))return;
  var res=await fetch('/admin/frame-order-update',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId:id,confirmPayment:true,status:'confirmed',deliveryDate:(document.getElementById('dd-'+id)||{}).value,deliveryTime:(document.getElementById('dt-'+id)||{}).value})});
  var data=await res.json();if(data.ok){var o=data.order||ORDERS_BY_ID[id]||{};if((document.getElementById('wa-'+id)||{}).checked)waCustomer(o.mobile,id,o.status,o.paymentStatus);alert('Confirmed');loadOrdersPage();}else alert('Fail');
}
async function rejectOrder(id){
  var reason=(document.getElementById('rr-'+id)||{}).value||'Rejected by studio';
  if(reason==='Other'){reason=prompt('Reject reason likhein:','');if(!reason)return;}
  if(!confirm('Reject '+id+' and move it to Recovery Orders?'))return;
  var res=await fetch('/admin/frame-order-update',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId:id,reject:true,status:'rejected',adminNote:reason,rejectReason:reason})});
  var data=await res.json();if(data.ok){var o=data.order||ORDERS_BY_ID[id]||{};if((document.getElementById('wa-'+id)||{}).checked)waCustomer(o.mobile,id,o.status,o.paymentStatus);alert('Rejected ❌');loadOrdersPage();}else alert('Fail');
}
async function restoreOrder(id){
  if(!confirm('Restore to processing?'))return;
  var res=await fetch('/admin/frame-order-update',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId:id,status:'processing',adminNote:'Recovered from recovery orders'})});
  var data=await res.json();if(data.ok){alert('Restored');loadOrdersPage();}else alert('Fail');
}
loadOrdersPage();setInterval(loadOrdersPage,20000);
</script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
    return res.end(html);
  }

  if (req.method === 'GET' && urlPath === '/admin') {
    const accounts = loadAccounts().slice().reverse();
    const settings = loadSettings();
    const adminHidden = (settings.adminUi && settings.adminUi.hidden) || {};
    const bi = settings.bookImages || {};
    const pendingResets = accounts.filter(a => a.pinResetRequested);
    const pendingOtps = loadOtpRequests().filter(r => !r.verified);
    const codes = loadCodes().slice().reverse();
    const today = new Date().toDateString();
    const newToday = accounts.filter(a => a.createdAt && new Date(a.createdAt).toDateString() === today).length;
    const verifiedCount = accounts.filter(a => a.mobileVerified).length;
    const freeUsed = accounts.filter(a => a.freeSpinUsed).length;
    const frameOrdersAdmin = loadFrameOrders();
    const activeFrameOrdersAdmin = frameOrdersAdmin.filter(o => !['rejected', 'cancelled'].includes(String(o.status || '').toLowerCase()));
    const ordTotal = activeFrameOrdersAdmin.length;
    const ordNew = activeFrameOrdersAdmin.filter(o => {
      if (!o.createdAt) return false;
      try { return new Date(o.createdAt).toDateString() === today; } catch (e) { return false; }
    }).length;
    const ordPending = activeFrameOrdersAdmin.filter(o => {
      const st = String(o.status || 'processing').toLowerCase();
      return st === 'processing' || st === 'pending';
    }).length;
    const ordConfirmed = activeFrameOrdersAdmin.filter(o => {
      const st = String(o.status || '').toLowerCase();
      return st === 'confirmed' || st === 'ready' || st === 'delivered';
    }).length;
    const ordPayPending = activeFrameOrdersAdmin.filter(o => {
      const pay = String(o.paymentStatus || 'unpaid').toLowerCase();
      return pay === 'unpaid' || pay === 'paid_claimed' || pay === 'partial_wallet';
    }).length;
    const ordRejected = frameOrdersAdmin.filter(o => ['rejected', 'cancelled'].includes(String(o.status || '').toLowerCase())).length;
    const pendingWalletTopups = loadWalletTopups().filter(t => String(t.status || 'pending') === 'pending');
    const walletTopupCards = pendingWalletTopups.map(t => {
      const proof = t.proof ? '<a href="'+esc(t.proof)+'" target="_blank"><img src="'+esc(t.proof)+'" style="width:82px;height:82px;object-fit:cover;border-radius:10px;border:2px solid #38bdf8" title="Open payment screenshot"></a>' : '<span class="muted">Screenshot nahi diya</span>';
      return '<div class="msg-card" style="margin-top:10px;border-color:rgba(56,189,248,.7);background:linear-gradient(135deg,#0c2431,#1b1730);box-shadow:0 0 18px rgba(56,189,248,.15)"><div class="msg-text"><b style="color:#67e8f9">💳 Recharge Pending · ₹'+esc(t.amount)+'</b><br>👤 '+esc(t.name||'Customer')+' · '+esc(t.mobile)+'<br>UTR: <b>'+esc(t.utr||'Screenshot upload')+'</b><br><span class="muted">'+esc(fmtDate(t.createdAt))+'</span><div style="margin-top:9px">'+proof+'</div></div><div class="msg-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><form method="POST" action="/admin/wallet-topup-action"><input type="hidden" name="id" value="'+esc(t.id)+'"><button class="gen-btn" type="submit" name="action" value="approve" style="background:linear-gradient(135deg,#22c55e,#0f766e);color:#fff;box-shadow:0 0 15px rgba(34,197,94,.35)">✅ Verify & Add ₹'+esc(t.amount)+'</button></form><form method="POST" action="/admin/wallet-topup-action" onsubmit="return confirm(\'Reject this recharge?\')"><input type="hidden" name="id" value="'+esc(t.id)+'"><button type="submit" name="action" value="reject" style="padding:8px 12px;border:0;border-radius:8px;background:#dc2626;color:#fff;font-weight:800;cursor:pointer">❌ Reject</button></form></div></div>';
    }).join('') || '<div class="muted">Abhi koi wallet recharge verification pending nahi hai.</div>';

    const otpCards = pendingOtps.map(r => {
      const manual = String(r.manualOtp || '');
      const status = manual ? '<span style="color:#facc15;font-weight:700">WhatsApp OTP भेजना बाकी है</span>' : '<span style="color:#8fd19e;font-weight:700">SMS OTP sent</span>';
      const code = manual ? '<div style="margin:9px 0;padding:8px 12px;border-radius:10px;background:#21170a;border:1px dashed #facc15;color:#fff3a6;font-size:22px;font-weight:900;letter-spacing:5px">OTP: '+esc(manual)+'</div>' : '';
      const wa = manual ? '<button type="button" class="gen-btn" style="background:#16a34a;color:#fff;border:1px solid #4ade80" data-omobile="'+esc(r.mobile||'')+'" data-otp="'+esc(manual)+'" onclick="adminWhatsAppOtp(this.dataset.omobile,this.dataset.otp)">💬 WhatsApp OTP भेजें</button>' : '';
      return '<div class="msg-card"><div class="msg-text">📱 <b>' + esc(r.name || '') + '</b> (' + esc(r.mobile) + ')<br>' + status + code + '<span class="muted">Requested: ' + esc(fmtDate(r.createdAt)) + (r.expiresAt ? ' · Expires: ' + esc(fmtDate(r.expiresAt)) : '') + '</span></div><div class="msg-actions">' + wa + '<button type="button" class="gen-btn" style="background:#7f1d1d;color:#fecaca;border:1px solid #991b1b" data-oid="'+esc(r.id||'')+'" data-omobile="'+esc(r.mobile||'')+'" onclick="adminDeleteOtp(this.dataset.oid,this.dataset.omobile)">🗑️ Cancel OTP</button></div></div>';
    }).join('') || '<div class="muted">No pending OTP</div>';

    const resetCards = pendingResets.map(acc => {
      return '<div class="msg-card"><div class="msg-text">🔔 <b>' + esc(acc.name) + '</b> (' + esc(acc.mobile) + ')</div><div class="msg-actions"><form method="POST" action="/admin/reset-pin" style="display:flex;gap:6px"><input type="hidden" name="mobile" value="' + esc(acc.mobile) + '"><input class="inp" name="newPin" placeholder="Naya PIN" maxlength="4"><button class="gen-btn" type="submit">Reset → WA</button></form></div></div>';
    }).join('') || '<div class="muted">No PIN resets</div>';

        const codeRows = codes.filter(c => !c.couponAccepted).map(c => {
      const isW = c.type === 'wallet' || (Number(c.walletAmount) > 0);
      const amtShow = isW ? ('💰 ₹' + (c.walletAmount || c.amount || 0)) : ('₹' + (c.amount != null ? c.amount : '—'));
      const typeLabel = isW ? '<span class="tag">Wallet</span>' : '<span class="muted">Spin</span>';
      return '<tr><td class="mono">' + esc(c.code) + '</td>'
      + '<td>' + amtShow + ' ' + typeLabel + '</td>'
      + '<td>' + (c.used ? '<span class="bad">Used</span>' : '<span class="ok">Unused</span>') + '</td>'
      + '<td>' + esc(c.usedBy || '—') + '</td>'
      + '<td>' + esc(c.prize || (c.discount != null ? c.discount + '%' : (isW ? 'Wallet credit' : (c.used ? 'Spin pending/unknown' : '—')))) + '</td>'
      + '<td>' + esc(fmtDate(c.createdAt)) + '</td>'
      + '<td>' + esc(c.usedAt ? fmtDate(c.usedAt) : '—') + '</td>'
      + '<td><form method="POST" action="/admin/delete-spin-code" style="display:inline" onsubmit="return confirm(\'Delete code '+esc(c.code)+'?\')"><input type="hidden" name="code" value="'+esc(c.code)+'"><button type="submit" style="padding:3px 8px;font-size:11px;background:#5a1a1a;color:#fca5a5;border:1px solid #7f1d1d;border-radius:6px;cursor:pointer">🗑</button></form></td></tr>';
    }).join('') || '<tr><td colspan="8">No codes yet (accepted coupons auto-hidden)</td></tr>';

    function lastPrize(acc) {
      const h = (acc.history || []).slice().reverse();
      for (const x of h) {
        if (x.prize) return x.prize;
        if (x.discount != null) return x.discount + '%';
      }
      return '—';
    }

    const notifAdminCards = (loadNotifs() || []).map(n => {
      const nid = esc(n.id || n.at || '');
      const exp = n.expiresAt ? fmtDate(n.expiresAt) : 'Never';
      const personal = !!n.mobile;
      return '<div class="msg-card" style="margin-top:8px;border-color:'+(personal?'rgba(34,211,238,.65)':'rgba(212,175,55,.35)')+';box-shadow:0 0 16px '+(personal?'rgba(34,211,238,.16)':'rgba(212,175,55,.10)')+'"><div class="msg-text"><b>'+(personal?'👤 Personal alert · ':'📣 Studio alert · ')+esc(n.title || '') + '</b><br>' + esc(n.body || '') +
        (personal?'<br><span style="color:#67e8f9;font-size:12px">To: '+esc(n.mobile)+'</span>':'')+
        '<br><span class="muted">Sent: ' + esc(fmtDate(n.at)) + ' · Exp: ' + esc(exp) + '</span></div>' +
        '<div class="msg-actions"><form method="POST" action="/admin/delete-notification"><input type="hidden" name="id" value="' + nid + '">' +
        '<button type="submit" style="padding:6px 10px;background:#5a1a1a;color:#fca5a5;border:1px solid #7f1d1d;border-radius:6px;cursor:pointer">🗑 Delete</button></form></div></div>';
    }).join('') || '<div class="muted">No active notifications</div>';
    const customerNotificationOptions = accounts.map(acc => '<option value="'+esc(acc.mobile)+'">'+esc(acc.name || 'Customer')+' · '+esc(acc.mobile)+'</option>').join('');

        const rows = accounts.map(acc => {
      const hist = (acc.history || []).slice().reverse();
      const couponRows = hist.filter(h => h.prize || h.discount != null).map(h => {
        const cid = esc(h.couponId || h.entryId || '');
        const st = h.couponStatus || 'active';
        if (st === 'deleted') return '';
        const statusBadge = st === 'accepted'
          ? '<span class="ok">Accepted / Used</span>'
          : (st === 'wallet_credited' ? '<span class="ok">→ Wallet</span>' : (st === 'used' ? '<span class="ok">Used</span>' : '<span class="tag">Active</span>'));
        const actions = st === 'active'
          ? ('<form method="POST" action="/admin/coupon-action" style="display:inline-flex;gap:4px;flex-wrap:wrap">'
            + '<input type="hidden" name="mobile" value="' + esc(acc.mobile) + '">'
            + '<input type="hidden" name="couponId" value="' + cid + '">'
            + '<button class="gen-btn" type="submit" name="action" value="accept" style="padding:4px 8px;font-size:11px">✓ Accept</button>'
            + '<button type="submit" name="action" value="delete" style="padding:4px 8px;font-size:11px;background:#5a1a1a;color:#fca5a5;border:1px solid #7f1d1d;border-radius:6px;cursor:pointer">🗑 Delete</button>'
            + '</form>')
          : '<span class="muted">—</span>';
        const exp = h.expiresAt ? fmtDate(h.expiresAt) : '—';
        const expired = h.expiresAt && new Date(h.expiresAt).getTime() < Date.now() && st === 'active';
        const statusBadge2 = expired ? '<span class="bad">Expired</span>' : statusBadge;
        return '<tr><td>' + esc(h.prize || (h.discount != null ? h.discount : '—')) + '</td>'
          + '<td>' + (h.freeSpin ? 'Free' : ('₹' + esc(h.amount || 0))) + '</td>'
          + '<td>' + statusBadge2 + '</td>'
          + '<td>' + esc(fmtDate(h.timestamp)) + '<br><span class="muted">Exp: ' + esc(exp) + '</span></td>'
          + '<td>' + actions + '</td></tr>';
      }).filter(Boolean).join('') || '<tr><td colspan="5" class="muted">No coupons</td></tr>';
      const wBal = Number(acc.walletBalance) || 0;
      const wHist = (acc.walletHistory || []).slice(0, 12);
      const wHistRows = wHist.map(function(w) {
        const sign = w.type === 'credit' ? '+' : '−';
        const col = w.type === 'credit' ? '#7dcea0' : '#f0a0a0';
        return '<tr><td style="color:' + col + '">' + sign + '₹' + esc(w.amount) + '</td><td>₹' + esc(w.balanceAfter) + '</td><td>' + esc(w.reason || w.source || '') + '</td><td class="muted">' + esc(fmtDate(w.timestamp)) + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="muted">No wallet history</td></tr>';
      const todayStr = new Date().toDateString();
      const isNewToday = acc.createdAt && new Date(acc.createdAt).toDateString() === todayStr;
      const filters = [
        'all',
        acc.mobileVerified ? 'verified' : 'unverified',
        acc.freeSpinUsed ? 'freespin' : 'freespin-left',
        isNewToday ? 'today' : '',
        (acc.pinResetRequested ? 'pinreset' : '')
      ].filter(Boolean).join(' ');
      const adminBtns =
        '<div style="display:flex;flex-wrap:wrap;gap:8px;margin:12px 0">' +
        (!acc.mobileVerified
          ? '<form method="POST" action="/admin/verify-account"><input type="hidden" name="mobile" value="' + esc(acc.mobile) + '"><button class="gen-btn" type="submit" style="padding:6px 12px;font-size:12px">✓ Verify now</button></form>'
          : '<span class="ok">Already verified</span>') +
        '<form method="POST" action="/admin/delete-account" onsubmit="return confirm(\'Delete account ' + esc(acc.name) + ' (' + esc(acc.mobile) + ')? Ye undo nahi hoga.\')">' +
        '<input type="hidden" name="mobile" value="' + esc(acc.mobile) + '">' +
        '<button type="submit" style="padding:6px 12px;font-size:12px;background:#5a1a1a;color:#fca5a5;border:1px solid #7f1d1d;border-radius:6px;cursor:pointer">🗑 Delete account</button></form>' +
        '</div>';
      const walletBox =
        '<div class="lbl" style="margin-top:14px">💰 Wallet · ₹' + esc(wBal) + '</div>' +
        '<form method="POST" action="/admin/wallet-adjust" class="form-row" style="margin:8px 0;flex-wrap:wrap;gap:6px">' +
        '<input type="hidden" name="mobile" value="' + esc(acc.mobile) + '">' +
        '<select name="type" class="inp" style="max-width:110px"><option value="credit">+ Credit</option><option value="debit">− Debit</option></select>' +
        '<input class="inp" name="amount" type="number" min="1" placeholder="₹ Amount" required style="max-width:110px">' +
        '<input class="inp" name="reason" placeholder="Reason" style="max-width:160px">' +
        '<button class="gen-btn" type="submit" style="padding:6px 12px;font-size:12px">Apply</button></form>' +
        '<table style="margin-top:6px"><thead><tr><th>Amt</th><th>Bal</th><th>Reason</th><th>Time</th></tr></thead><tbody>' + wHistRows + '</tbody></table>';
      return '<details class="acc" data-filter="' + filters + '" data-id="' + esc(acc.id) + '"><summary><span class="c-id">' + esc(acc.id) + '</span> <b>' + esc(acc.name) + '</b> <span class="muted">' + esc(acc.mobile) + '</span> ' +
        (acc.mobileVerified ? '<span class="ok">✓ Verified</span>' : '<span class="bad">✗ Unverified</span>') +
        ' <span class="tag">' + esc(acc.badge || tierName(acc.totalSpend || 0)) + '</span>' +
        ' <span class="tag" style="background:rgba(212,175,55,0.2)">💰 ₹' + esc(wBal) + '</span></summary><div class="acc-body"><div class="grid">' +
        '<div><span class="lbl">PIN</span><div class="mono gold">•••• (secured)</div></div>' +
        '<div><span class="lbl">Village</span><div>' + esc(acc.village || '—') + '</div></div>' +
        '<div><span class="lbl">Total spend</span><div>₹' + esc(acc.totalSpend || 0) + '</div></div>' +
        '<div><span class="lbl">Wallet</span><div class="gold">₹' + esc(wBal) + '</div></div></div>' +
        adminBtns +
        walletBox +
        '<div class="lbl" style="margin-top:12px">Coupons</div>' +
        '<table><thead><tr><th>Coupon</th><th>From</th><th>Status</th><th>Time</th><th>Action</th></tr></thead><tbody>' + couponRows + '</tbody></table></div></details>';
    }).join('') || '<p class="muted">No customers yet</p>';

    const html = `<!DOCTYPE html><html lang="hi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.alert=function(m){function s(){var o=document.getElementById('adityaPageAlert');if(o)o.remove();var t=String(m||''),bad=/(fail|error|wrong|network|nahi|नहीं|गलत|invalid|missing|expire|chhoti|required|check)/i.test(t),b=document.createElement('div');b.id='adityaPageAlert';b.style.cssText='position:fixed;left:16px;right:16px;top:18px;z-index:99999;max-width:520px;margin:auto;padding:13px 42px 13px 15px;border-radius:13px;font:600 14px Arial,sans-serif;line-height:1.45;color:'+(bad?'#fecaca':'#dcfce7')+';background:'+(bad?'#571b22':'#14532d')+';border:1px solid '+(bad?'#ef4444':'#4ade80')+';box-shadow:0 12px 30px rgba(0,0,0,.42)';b.innerHTML=(bad?'⚠️ ':'✅ ')+t+'<button style="position:absolute;right:10px;top:8px;border:0;background:transparent;color:inherit;font-size:22px">×</button>';b.querySelector('button').onclick=function(){b.remove()};document.body.appendChild(b);setTimeout(function(){b.remove()},5000)}if(document.body)s();else document.addEventListener('DOMContentLoaded',s,{once:true})}</script>
<title>Aditya Studio Admin</title>
<style>
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{font-family:Inter,system-ui,sans-serif;background:#0a0806;color:#F4EAD6;margin:0;min-height:100vh}
a{color:#D4AF37;text-decoration:none}
.layout{display:flex;min-height:100vh}
.sidebar{width:240px;background:#120e0a;border-right:1px solid rgba(212,175,55,.15);padding:20px 14px;position:fixed;top:0;left:0;bottom:0;overflow-y:auto;z-index:40}
.sidebar .brand{font-size:1.1rem;font-weight:700;color:#D4AF37;margin-bottom:4px;letter-spacing:.02em}
.sidebar .brand-sub{font-size:11px;color:#8a7a62;margin-bottom:20px}
.nav-link{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:8px;color:#c4b496;font-size:13px;margin-bottom:3px;transition:.15s}
.nav-link:hover,.nav-link.active{background:rgba(212,175,55,.12);color:#F3DE9A}
.main{margin-left:240px;flex:1;padding:24px 28px 80px;max-width:1100px}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px;flex-wrap:wrap;gap:12px}
.topbar h1{margin:0;font-size:1.35rem;color:#F4EAD6;font-weight:600}
.topbar .links a{margin-left:12px;font-size:13px;color:#B7A480}
.topbar .links a:hover{color:#D4AF37}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:28px}
.card{background:linear-gradient(160deg,#1a1410,#120e0a);border:1px solid rgba(212,175,55,.18);border-radius:14px;padding:16px}
.card-click{cursor:pointer;transition:transform .15s,border-color .15s}
.card-click:hover{transform:translateY(-2px);border-color:rgba(212,175,55,.45)}
.card-click.active-filter{border-color:#D4AF37;box-shadow:0 0 0 1px #D4AF37}
.card .n{font-size:1.55rem;font-weight:800;color:#FFD700;line-height:1.1}
.card .l{font-size:11px;color:#8a7a62;text-transform:uppercase;margin-top:6px;letter-spacing:.04em}
.panel{background:#120e0a;border:1px solid rgba(212,175,55,.12);border-radius:16px;padding:20px 22px;margin-bottom:22px}
.panel h2{margin:0 0 14px;font-size:1rem;color:#D4AF37;font-weight:600;display:flex;align-items:center;gap:8px}
.panel h2 span.badge{background:rgba(212,175,55,.15);color:#F3DE9A;font-size:11px;padding:2px 8px;border-radius:99px}
.sub{color:#8a7a62;font-size:13px;margin:0 0 14px;line-height:1.45}
.codes-block,.msg-card,.acc{border:1px solid rgba(212,175,55,.1);border-radius:12px;padding:14px;margin-bottom:10px;background:#0d0a08}
.gen-btn{background:linear-gradient(180deg,#F3DE9A,#D4AF37);color:#241804;border:none;padding:9px 16px;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;text-decoration:none;display:inline-block}
.gen-btn:hover{filter:brightness(1.05)}
.wa-link{background:linear-gradient(180deg,#3ee06b,#25D366);color:#062}
.btn-danger{padding:6px 12px;font-size:12px;background:#3a1515;color:#fca5a5;border:1px solid #7f1d1d;border-radius:6px;cursor:pointer}
.msg-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
.otp-big{color:#FFD700;font-size:1.3rem;letter-spacing:3px;font-family:ui-monospace,monospace}
.muted{color:#8a7a62}.ok{color:#8fd19e;font-weight:600;font-size:12px}.bad{color:#e08a8a;font-weight:600;font-size:12px}
.tag{background:rgba(255,215,0,.12);color:#FFD700;padding:2px 8px;border-radius:99px;font-size:11px}
.mono{font-family:ui-monospace,monospace}.gold{color:#FFD700}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
th,td{padding:10px 8px;border-bottom:1px solid #221a14;text-align:left}th{color:#D4AF37;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
.inp,textarea,select.inp{background:#0a0806;border:1px solid rgba(212,175,55,.28);border-radius:8px;padding:8px 10px;color:#F4EAD6;font-size:13px}
.inp{width:100%;max-width:100%}
#imgView{display:none;position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9999;align-items:center;justify-content:center;padding:16px;flex-direction:column;gap:12px}
#imgView.show{display:flex}
#imgView img{max-width:94vw;max-height:78vh;border-radius:12px;border:2px solid #D4AF37;background:#111}
#newOrderBanner{display:none;background:#14532d;border:1px solid #4ade80;color:#bbf7d0;padding:12px 16px;border-radius:12px;margin-bottom:16px;font-weight:700;cursor:pointer}
#newOrderBanner.show{display:block}
.form-grid{display:grid;gap:10px;max-width:520px}
.form-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.acc summary{cursor:pointer;padding:4px 0}.c-id{color:#D4AF37;font-family:ui-monospace,monospace}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin:10px 0}
.lbl{font-size:10px;color:#8a7a62;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
#search{width:100%;max-width:360px;padding:11px 14px;border-radius:10px;border:1px solid rgba(212,175,55,.28);background:#0a0806;color:#F4EAD6;margin-bottom:14px}
label.muted{display:block;font-size:12px;margin-bottom:2px}
.field-file{font-size:12px;color:#B7A480}
#liveBar{position:fixed;bottom:16px;right:16px;background:#1B140F;border:1px solid rgba(212,175,55,.35);border-radius:12px;padding:10px 14px;font-size:12px;color:#B7A480;z-index:99;box-shadow:0 8px 24px rgba(0,0,0,.4)}
@media(max-width:900px){
  .sidebar{width:100%;position:relative;border-right:none;border-bottom:1px solid rgba(212,175,55,.15)}
  .layout{flex-direction:column}
  .main{margin-left:0;padding:16px}
  .nav-link{display:inline-flex;margin:2px}
}

.sec-hidden{display:none!important}
.sec-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.sec-hide-btn{font-size:11px;padding:4px 10px;border-radius:999px;border:1px solid rgba(212,175,55,.35);background:transparent;color:#D4AF37;cursor:pointer}
.sec-hide-btn:hover{background:rgba(212,175,55,.12)}
#sec-ui-panel .ui-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px}
#sec-ui-panel label{display:flex;align-items:center;gap:8px;font-size:13px;color:#e5e2e1;cursor:pointer}
</style></head><body>
<div id="imgView" onclick="if(event.target===this)closeImg()"><img alt="view"/><button type="button" class="gen-btn" onclick="closeImg()">Close</button></div>
<div class="layout">
<aside class="sidebar">
  <div class="brand">Aditya Studio</div>
  <div class="brand-sub">Admin Dashboard</div>
  <a class="nav-link" href="#sec-overview">📊 Overview</a>
  <a class="nav-link" href="#sec-order-stats">📦 Orders Summary</a>
  <a class="nav-link" href="#sec-orders">📋 Order List</a>
  <a class="nav-link" href="/admin/activity" style="color:#67e8f9">📊 User Activity Tracker</a>
  <a class="nav-link" href="#sec-frames">🖼️ Frame Types</a>
  <a class="nav-link" href="#sec-banner">🎬 Home Banner</a>
  <a class="nav-link" href="#sec-hero">✨ Hero Text + BG Photos</a>
  <a class="nav-link" href="#sec-home-frame">🖼️ Home 3D Frame (5 photos)</a>
  <a class="nav-link" href="#sec-book">📷 Book Cards</a>
  <a class="nav-link" href="#sec-otp">📱 OTP / PIN</a>
  <a class="nav-link" href="#sec-codes">🎫 Spin Codes</a>
  <a class="nav-link" href="#sec-customers">👥 Customers</a>
  <a class="nav-link" href="#sec-notif">🔔 Notifications</a>
  <a class="nav-link" href="#sec-backup">💾 Backup</a>
  <div style="margin-top:20px;padding-top:14px;border-top:1px solid rgba(212,175,55,.12)">
    <a class="nav-link" href="/" target="_blank">↗ Open storefront</a>
  </div>
</aside>
<main class="main">
<div class="topbar">
  <h1>Dashboard</h1>
  <div class="links"><a href="/">Home</a><a href="/book-now">Studio page</a></div>
</div>
<div id="newOrderBanner" onclick="location.hash='sec-orders'"></div>

<section class="panel" id="sec-overview">
<h2>Overview</h2>
<div class="cards">
<div class="card card-click" onclick="filterPanel('all')" title="Saare customers"><div class="n" id="cntCust">${accounts.length}</div><div class="l">Customers</div></div>
<div class="card card-click" onclick="filterPanel('today')" title="Aaj naye"><div class="n" id="cntToday">${newToday}</div><div class="l">Aaj naye</div></div>
<div class="card card-click" onclick="filterPanel('otp')" title="Pending OTP"><div class="n" id="cntOtp">${pendingOtps.length}</div><div class="l">Pending OTP</div></div>
<div class="card card-click" onclick="filterPanel('pin')" title="PIN Reset"><div class="n" id="cntPin">${pendingResets.length}</div><div class="l">PIN Reset</div></div>
<div class="card card-click" onclick="filterPanel('verified')" title="Verified"><div class="n" id="cntVer">${verifiedCount}</div><div class="l">Verified</div></div>
<div class="card card-click" onclick="filterPanel('freespin')" title="Free spin used"><div class="n" id="cntFree">${freeUsed}</div><div class="l">Free spin used</div></div>
<div class="card card-click" onclick="filterPanel('codes')" title="Unused codes"><div class="n" id="cntCodes">${codes.filter(c=>!c.used).length}</div><div class="l">Unused codes</div></div>
</div>
<div id="filterBar" style="display:none;margin-top:4px;padding:10px 14px;background:#1B140F;border:1px solid rgba(212,175,55,0.35);border-radius:10px;align-items:center;gap:10px;flex-wrap:wrap">
<span style="color:#D4AF37;font-weight:700" id="filterLabel">Filter:</span>
<button type="button" class="gen-btn" style="padding:6px 12px;font-size:12px" onclick="filterPanel('all')">Show all</button>
</div>
</section>


<section class="panel" id="sec-ui-panel">
<h2>👁️ Admin Sections Show / Hide</h2>
<p class="sub">Jis function ki zaroorat nahi, yahan se hide karo. Dobara show bhi yahi se.</p>
<div class="ui-grid" id="adminUiToggles"></div>
<button type="button" class="gen-btn" style="margin-top:12px" onclick="adminSaveUi()">💾 Save Show/Hide</button>
<button type="button" class="gen-btn" style="margin-top:12px;margin-left:8px;background:#333;color:#D4AF37" onclick="adminShowAllSections()">Show All</button>
<p id="adminUiMsg" class="muted"></p>
</section>
<section class="panel" id="sec-order-stats">
<h2>📦 Frame Orders Summary</h2>
<p class="sub">Orders ka live status — New red me, Confirmed green me.</p>
<div class="cards">
<a class="card" href="/admin/orders?filter=all" style="text-decoration:none;color:inherit;cursor:pointer" title="All orders"><div class="n" id="cntOrdTotal">${ordTotal}</div><div class="l">Total Orders</div></a>
<a class="card" href="/admin/orders?filter=new" style="text-decoration:none;color:inherit;cursor:pointer;border-color:rgba(239,68,68,0.45)" title="New today"><div class="n" id="cntOrdNew" style="color:#f87171">${ordNew}</div><div class="l" style="color:#f87171">New Today</div></a>
<a class="card" href="/admin/orders?filter=pending" style="text-decoration:none;color:inherit;cursor:pointer;border-color:rgba(251,146,60,0.4)" title="Pending"><div class="n" id="cntOrdPending" style="color:#fb923c">${ordPending}</div><div class="l">Pending</div></a>
<a class="card" href="/admin/orders?filter=confirmed" style="text-decoration:none;color:inherit;cursor:pointer;border-color:rgba(74,222,128,0.4)" title="Confirmed"><div class="n" id="cntOrdConfirmed" style="color:#4ade80">${ordConfirmed}</div><div class="l" style="color:#4ade80">Confirmed</div></a>
<a class="card" href="/admin/orders?filter=pay_pending" style="text-decoration:none;color:inherit;cursor:pointer" title="Pay pending"><div class="n" id="cntOrdPayPend" style="color:#fbbf24">${ordPayPending}</div><div class="l">Pay Pending</div></a>
<a class="card" href="/admin/orders?filter=recovery" style="text-decoration:none;color:inherit;cursor:pointer;border-color:rgba(239,68,68,0.55)" title="Recovery orders"><div class="n" id="cntOrdRejected" style="color:#f87171">${ordRejected}</div><div class="l" style="color:#f87171">Recovery Orders</div></a>
</div>
<p class="muted" style="margin-top:10px"><a href="/admin/orders" style="color:#D4AF37;font-weight:700">→ Open full Orders page (alag manage)</a></p>
</section>

<section class="panel" id="sec-wallet-recharges" style="border-color:rgba(56,189,248,.42)">
<h2 style="color:#67e8f9">💳 Wallet Recharge Verification <span class="badge">${pendingWalletTopups.length}</span></h2>
<p class="sub">Customer ne paisa add kiya ho to UTR / screenshot check karke green button se wallet me add karein.</p>
<div id="walletTopupList">${walletTopupCards}</div>
</section>

<section class="panel" id="sec-fees">
<h2>💰 Platform & Delivery Fees</h2>
<p class="sub">Kab fees lage / kab free — Save ke baad place-order pe apply.</p>
<div class="form-grid" style="max-width:520px">
<label class="muted">Platform fee ₹ <input class="inp" id="feePlatformAmt" type="number" min="0" value="10"></label>
<label class="muted">Platform kab?
<select class="inp" id="feePlatformMode">
<option value="always">Hamesha</option>
<option value="never">Kabhi nahi (Off)</option>
<option value="above_amount">Sirf order ≥ ₹X</option>
</select></label>
<label class="muted">Platform min ₹ <input class="inp" id="feePlatformMin" type="number" min="0" value="0"></label>
<label class="muted">Delivery fee ₹ <input class="inp" id="feeDeliveryAmt" type="number" min="0" value="40"></label>
<label class="muted">Delivery kab?
<select class="inp" id="feeDeliveryMode">
<option value="always">Hamesha</option>
<option value="never">Hamesha free</option>
<option value="free_above">Free jab order ≥ ₹X</option>
<option value="above_amount">Sirf order ≥ ₹X</option>
</select></label>
<label class="muted">Delivery free above ₹ <input class="inp" id="feeDeliveryFreeAbove" type="number" min="0" value="500"></label>
<label class="muted">Delivery min ₹ <input class="inp" id="feeDeliveryMin" type="number" min="0" value="0"></label>
<button type="button" class="gen-btn" onclick="adminSaveFees()">💾 Save Fee Rules</button>
<p id="feeSaveMsg" class="muted"></p>
</div>
</section>


<section class="panel" id="sec-quality">
<h2>🖨️ Photo Quality Options</h2>
<p class="sub">Customer frames page pe ye options dikhenge (Normal / Lamination / NTR …). Extra price ₹ me.</p>
<div id="qualityAdminList" style="display:grid;gap:10px;max-width:560px"></div>
<button type="button" class="gen-btn" style="margin-top:10px" onclick="qualityAddRow()">+ Add option</button>
<button type="button" class="gen-btn" style="margin-top:10px;margin-left:8px" onclick="adminSaveQuality()">💾 Save Quality Options</button>
<p id="qualitySaveMsg" class="muted"></p>
</section>

<section class="panel" id="sec-orders">
<h2>📦 Order Manager</h2>
<p class="sub">Orders ka handling sirf separate page par hoga, taki admin home clean rahe.</p>
<a class="gen-btn" href="/admin/orders" style="display:inline-block;text-decoration:none">Open Separate Order Page →</a>
<a href="/admin/orders?filter=recovery" style="display:inline-block;margin-left:9px;color:#67e8f9;font-weight:700">🗃️ Recovery Orders</a>
</section>

<section class="panel" id="sec-frames">
<h2>🖼️ Frame Types</h2>
<p class="sub">Har size ke alag frame types (name + photo). Customer detail mein type select + photo dikhega. <a href="/">Storefront →</a></p>
<div class="form-grid" style="margin-bottom:16px">
<label class="muted">Size
<select id="frSize" class="inp">
<option>8x12</option><option>10x12</option><option>10x15</option><option>12x15</option>
<option>12x18</option><option>12x36</option><option>16x20</option><option>16x24</option>
<option>20x24</option><option>20x30</option><option>20x40</option><option>20x50</option>
<option>24x36</option><option>24x40</option><option>24x50</option>
</select></label>
<label class="muted">Frame Type name<input class="inp" id="frTitle" placeholder="Golden Border / Wooden Classic"></label>
<label class="muted">Price ₹<input class="inp" id="frPrice" type="number" min="0" placeholder="500" style="max-width:140px"></label>
<label class="muted">Discount %<input class="inp" id="frDisc" type="number" min="0" max="90" placeholder="10" style="max-width:140px"></label>
<label class="muted" style="display:flex;gap:8px;align-items:center;cursor:pointer"><input id="frActive" type="checkbox" checked> Order page par yeh frame type dikhayein</label>
<div class="muted" style="grid-column:1/-1;padding:11px;border:1px solid rgba(34,211,238,.38);border-radius:10px;background:linear-gradient(135deg,#102433,#151225)">
  <b style="color:#67e8f9">✅ Available sizes — is frame type ko kin sizes me dikhana hai?</b>
  <div id="frAvailableSizes" style="display:flex;gap:7px;flex-wrap:wrap;margin-top:9px">
    ${['8x12','10x12','10x15','12x15','12x18','12x36','16x20','16x24','20x24','20x30','20x40','20x50','24x36','24x40','24x50'].map(s => '<label style="cursor:pointer;padding:6px 9px;border-radius:999px;background:#0c1720;border:1px solid rgba(103,232,249,.28);color:#cffafe"><input class="fr-size-tick" type="checkbox" value="'+s+'"> '+s+'</label>').join('')}
  </div>
  <small style="display:block;margin-top:8px;color:#a5f3fc">Jitne size tick karoge, customer ko yeh same frame type unhi sizes me show hoga.</small>
</div>
<input type="hidden" id="frId" value="">
<label class="muted">Frame Type photo
<input type="file" id="frFile" accept="image/*" class="field-file">
<span id="frPhotoStatus" class="muted" style="display:block;margin-top:4px;font-size:11px">Nayi photo choose karo (optional on edit)</span>
<img id="frPhotoPreview" alt="" style="display:none;margin-top:8px;width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid rgba(212,175,55,.4);background:#111"/>
</label>
<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
<button class="gen-btn" type="button" onclick="adminSaveFrame()">💾 Save Frame Type</button>
<button type="button" id="frCancelEdit" onclick="adminCancelEditFrame()" style="display:none;padding:9px 14px;background:#2a2418;color:#B7A480;border:1px solid rgba(212,175,55,.35);border-radius:8px;cursor:pointer">Cancel edit</button>
</div>
</div>
<div id="adminFramesList" class="muted">Loading frames…</div>
</section>

<section class="panel" id="sec-banner">
<h2>🎬 Home Banner</h2>
<p class="sub">Ek hi jagah se jitni chahe banners upload karo (max 30). Har photo ~2MB tak. Frames home + offers carousel dono me use hoti hain.</p>
<p class="muted" style="margin-bottom:10px">Abhi banners: <b>${(settings.offerImages||[]).length}</b></p>
<div class="form-grid" style="margin-bottom:16px">
<label class="muted">Photos choose (multiple select)
<input type="file" id="bannerFiles" accept="image/*" multiple class="field-file"></label>
<label class="muted">Default title<input class="inp" id="bannerTitle" placeholder="Aditya Studio" value="Aditya Studio"></label>
<label class="muted">Default subtitle<input class="inp" id="bannerSub" placeholder="Museum-quality frames"></label>
<label class="muted" style="display:flex;align-items:center;gap:8px;cursor:pointer">
<input type="checkbox" id="bannerReplace"> Purani saari hata ke sirf nayi rakho</label>
<button class="gen-btn" type="button" onclick="adminUploadBanners()">📤 Upload (jitni select ki)</button>
<p id="bannerUploadStatus" class="muted"></p>
</div>
</section>

<section class="panel" id="sec-home-deals">
<h2>🎞️ Current Deals — Full Customization</h2>
<p class="sub">Home page ke har deal card ki photo, title, subtitle, link, order aur slide duration yahin se badlo. Save karne par purane fixed cards ki jagah aapke cards dikhenge.</p>
<div class="form-row" style="align-items:end;margin-bottom:10px">
<label class="muted">Carousel duration (seconds)<input id="dealDuration" class="inp" type="number" min="8" max="60" value="${esc(settings.homeDealsDurationSec||20)}" style="max-width:130px"></label>
<button type="button" class="gen-btn" onclick="adminAddDeal()">＋ Deal card add</button>
<button type="button" class="gen-btn" onclick="adminSaveDeals()">💾 Save Current Deals</button>
</div>
<div id="homeDealsEditor"></div>
<p id="homeDealsStatus" class="muted"></p>
<script>window.__HOME_DEALS__=${JSON.stringify(settings.offerImages || []).replace(/</g, '\\u003c')};</script>
</section>

<section class="panel" id="sec-login-promo">
<h2>🌈 Login Page Color Button</h2>
<p class="sub">Register/Login page par dikhne wala colorful offer button. Iska text, link aur colors yahin se badlein.</p>
<form method="POST" action="/admin/save-login-promo" class="form-grid">
<label class="muted">Button text<input class="inp" name="text" maxlength="140" value="${esc((settings.loginPromo||{}).text||'')}"></label>
<label class="muted">Click link<input class="inp" name="link" maxlength="300" value="${esc((settings.loginPromo||{}).link||'/#sizes')}"></label>
<div class="form-row"><label class="muted">Left color <input name="colorA" type="color" value="${esc((settings.loginPromo||{}).colorA||'#8E2A38')}"></label><label class="muted">Right color <input name="colorB" type="color" value="${esc((settings.loginPromo||{}).colorB||'#D4AF37')}"></label><label class="muted">Text color <input name="textColor" type="color" value="${esc((settings.loginPromo||{}).textColor||'#FFF4C8')}"></label></div>
<button class="gen-btn" type="submit">💾 Save Color Button</button>
</form>
</section>

<section class="panel" id="sec-hero">
<h2>✨ Home Hero Text + Side Background</h2>
<p class="sub">Text cycle + hero section ke <b>sides</b> pe background photos (slideshow).</p>

<form method="POST" action="/admin/save-hero-intro" class="form-grid">
<label class="muted">Welcome text (sparkly)
<input class="inp" name="welcomeText" value="${esc((settings.heroIntro||{}).welcomeText||'Aditya Studio me aapka swagat hai')}"></label>
<label class="muted">Text hold duration (seconds)
<input class="inp" name="welcomeDurationSec" type="number" min="2" max="20" value="${esc((settings.heroIntro||{}).welcomeDurationSec||5)}" style="max-width:120px"></label>
<label class="muted">Second text (cycle)
<input class="inp" name="eyebrow" value="${esc((settings.heroIntro||{}).eyebrow||'Premium Photography')}"></label>
<input type="hidden" name="headline" value="${esc((settings.heroIntro||{}).headline||'Preserving Memories in')}"/>
<input type="hidden" name="headlineGold" value="${esc((settings.heroIntro||{}).headlineGold||'Aurelian Noir')}"/>
<input type="hidden" name="headlineRest" value="${esc((settings.heroIntro||{}).headlineRest||'Excellence')}"/>
<input type="hidden" name="subtext" value="${esc((settings.heroIntro||{}).subtext||'')}"/>
<input type="hidden" name="btnPrimary" value="${esc((settings.heroIntro||{}).btnPrimary||'Book a Session')}"/>
<input type="hidden" name="btnSecondary" value="${esc((settings.heroIntro||{}).btnSecondary||'View Portfolio')}"/>
<button class="gen-btn" type="submit">💾 Save Hero Text</button>
</form>

<hr style="border:none;border-top:1px solid rgba(212,175,55,.2);margin:20px 0">

<h3 style="color:#f2ca50;margin:0 0 8px;font-size:1.05rem">🖼️ Hero Side Background Photos</h3>
<p class="sub">Sirf hero block ke peeche / sides pe dikhengi. Max <b>6</b> · duration set kar sakte ho.</p>
<p class="muted">Abhi: <b>${(settings.heroSideBgPhotos||[]).length}</b> / 6 · Duration: <b>${settings.heroSideBgDurationSec||5}</b>s</p>
<div style="display:flex;flex-wrap:wrap;gap:10px;margin:12px 0">
${(function(){
  const list = settings.heroSideBgPhotos || [];
  if (!list.length) return '<span class="muted">Abhi koi photo nahi — neeche se upload karo</span>';
  return list.map((p,i)=>{
    const u = typeof p === 'string' ? p : (p&&p.url)||'';
    if (!u) return '';
    return '<img src="'+esc(u)+'" alt="#'+(i+1)+'" style="width:100px;height:64px;object-fit:cover;border-radius:8px;border:1px solid rgba(212,175,55,.45)"/>';
  }).join('');
})()}
</div>
<div class="form-grid">
<label class="muted">Photos choose (multiple · max 6)
<input type="file" id="heroBgFiles" accept="image/*" multiple class="field-file"></label>
<label class="muted">BG change duration (seconds)
<input class="inp" type="number" id="heroBgDuration" min="2" max="20" value="${esc(settings.heroSideBgDurationSec||5)}" style="max-width:120px"></label>
<label class="muted" style="display:flex;align-items:center;gap:8px;cursor:pointer">
<input type="checkbox" id="heroBgReplace" checked> Purani hata ke nayi</label>
<button class="gen-btn" type="button" onclick="adminUploadHeroSideBg()">📤 Upload Background Photos</button>
<button type="button" onclick="adminSaveHeroBgDuration()" style="padding:8px 12px;background:#2a2418;color:#f2ca50;border:1px solid rgba(212,175,55,.4);border-radius:8px;cursor:pointer">⏱ Only duration save</button>
<button type="button" onclick="adminClearHeroSideBg()" style="padding:8px 12px;background:#5a1a1a;color:#fca5a5;border:1px solid #7f1d1d;border-radius:8px;cursor:pointer">🗑 Clear BG</button>
<p id="heroBgStatus" class="muted"></p>
</div>
</section>

<section class="panel" id="sec-home-frame">
<h2>🖼️ Home Page 3D Frame — 5 Photos</h2>
<p class="sub" style="color:#f2ca50">Sirf <b>HOME PAGE</b> floating frame (Photo Frame · Book Now). Max 5 photos · har 5 second change.</p>
<p class="muted" style="margin-bottom:12px">Abhi saved: <b id="homeFrameCount">${(settings.homeHeroFramePhotos||[]).length}</b> / 5</p>
<div id="homeFramePreview" style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px">
${(function(){
  const list = settings.homeHeroFramePhotos || [];
  if (!list.length) return '<span class="muted">Abhi koi photo nahi — neeche se 5 tak upload karo</span>';
  return list.map((p,i) => {
    const u = (typeof p === 'string' ? p : (p && p.url)) || '';
    if (!u) return '';
    return '<div style="width:100px;text-align:center">'
      + '<img src="'+esc(u)+'" alt="#'+(i+1)+'" style="width:100px;height:130px;object-fit:cover;border-radius:10px;border:2px solid rgba(212,175,55,.45);display:block;background:#111"/>'
      + '<div class="muted" style="font-size:11px;margin-top:4px">#'+(i+1)+'</div></div>';
  }).join('');
})()}
</div>
<div class="form-grid">
<label class="muted">Photos choose (Ctrl/Cmd se multiple · max 5)
<input type="file" id="homeFrameFiles" accept="image/*" multiple class="field-file"></label>
<label class="muted" style="display:flex;align-items:center;gap:8px;cursor:pointer">
<input type="checkbox" id="homeFrameReplace" checked> Purani hata ke sirf nayi rakho</label>
<button class="gen-btn" type="button" onclick="adminUploadHomeFrame()">📤 Upload Home 3D Photos</button>
<button type="button" onclick="adminClearHomeFrame()" style="padding:8px 12px;background:#5a1a1a;color:#fca5a5;border:1px solid #7f1d1d;border-radius:8px;cursor:pointer">🗑 Clear all</button>
<p id="homeFrameStatus" class="muted"></p>
</div>
</section>

<section class="panel" id="sec-book">
<h2>📷 Book card photos</h2>
<p class="sub">Direct photo upload — Wedding / Birthday / Personal / Reel / Event / Other. Har card ke liye alag photo.</p>
<div class="form-grid" id="bookUploadGrid">
${['wedding','birthday','personal','reel','event','other'].map(k => {
  const src = (bi[k] || '');
  const label = k.charAt(0).toUpperCase() + k.slice(1);
  const prev = src
    ? '<img src="'+esc(src)+'" alt="'+label+'" style="width:72px;height:72px;object-fit:cover;border-radius:10px;border:1px solid rgba(212,175,55,.35);display:block"/>'
    : '<div style="width:72px;height:72px;border-radius:10px;background:#1a1510;border:1px dashed rgba(212,175,55,.3);display:flex;align-items:center;justify-content:center;font-size:11px;color:#999">No photo</div>';
  return '<div style="display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)">'
    + prev
    + '<div style="flex:1;min-width:0">'
    + '<div class="muted" style="margin-bottom:6px;font-weight:600;color:#f2ca50">'+label+'</div>'
    + '<input type="file" accept="image/*" class="field-file book-file" data-key="'+k+'" id="bookFile_'+k+'"/>'
    + '<p class="muted" style="font-size:11px;margin-top:4px" id="bookSt_'+k+'"></p>'
    + '</div>'
    + '<button type="button" class="gen-btn book-up-btn" style="max-width:120px;padding:8px 12px" data-key="'+k+'">📤 Upload</button>'
    + '</div>';
}).join('')}
</div>
<script>
document.querySelectorAll('.book-up-btn').forEach(function(btn){
  btn.addEventListener('click', function(){ adminUploadBookImage(btn.getAttribute('data-key')); });
});
</script>
<p class="muted" style="margin-top:12px">Optional — URL se bhi set kar sakte ho:</p>
<form method="POST" action="/admin/save-book-images" class="form-grid">
<label class="muted">Wedding URL<input class="inp" name="wedding" value="${esc((bi.wedding||'').startsWith('data:')?'':(bi.wedding||''))}" placeholder="https://..."></label>
<label class="muted">Birthday URL<input class="inp" name="birthday" value="${esc((bi.birthday||'').startsWith('data:')?'':(bi.birthday||''))}" placeholder="https://..."></label>
<label class="muted">Personal URL<input class="inp" name="personal" value="${esc((bi.personal||'').startsWith('data:')?'':(bi.personal||''))}" placeholder="https://..."></label>
<label class="muted">Reel URL<input class="inp" name="reel" value="${esc((bi.reel||'').startsWith('data:')?'':(bi.reel||''))}" placeholder="https://..."></label>
<label class="muted">Event URL<input class="inp" name="event" value="${esc((bi.event||'').startsWith('data:')?'':(bi.event||''))}" placeholder="https://..."></label>
<label class="muted">Other URL<input class="inp" name="other" value="${esc((bi.other||'').startsWith('data:')?'':(bi.other||''))}" placeholder="https://..."></label>
<button class="gen-btn" type="submit">💾 Save URLs</button>
</form>
</section>

<section class="panel" id="sec-otp">
<h2 id="h2Otp">📱 Spin OTP <span class="badge">${pendingOtps.length}</span></h2>
<div id="otpLiveBox">${otpCards}</div>
<h2 id="h2Pin" style="margin-top:20px">⚠️ PIN Reset <span class="badge">${pendingResets.length}</span></h2>
<div id="pinLiveBox">${resetCards}</div>
</section>

<section class="panel" id="sec-codes">
<h2>🎫 Spin / Wallet Codes</h2>
<form method="POST" action="/admin/generate-code" class="form-row" style="margin-bottom:14px;flex-wrap:wrap">
<select name="codeType" class="inp" style="max-width:140px">
<option value="spin">Spin code (work amount)</option>
<option value="wallet">💰 Wallet credit code</option>
</select>
<input class="inp" name="amount" type="number" min="1" placeholder="Amount ₹" required style="max-width:120px">
<input class="inp" name="note" placeholder="Note / customer" style="max-width:160px">
<button class="gen-btn" type="submit">+ Naya code</button>
</form>
<p class="muted" style="font-size:12px;margin:-6px 0 12px">Wallet code customer profile se redeem karke seedha balance me aata hai. Spin code /book-now pe use hota hai.</p>
<div style="overflow-x:auto">
<table id="codesTable"><thead><tr><th>Code</th><th>Amount</th><th>Status</th><th>Used By</th><th>Coupon/Prize</th><th>Created</th><th>Used At</th><th>Action</th></tr></thead>
<tbody>${codeRows}</tbody></table>
</div>
</section>

<section class="panel" id="sec-customers">
<h2>👥 Customers <span class="badge">${accounts.length}</span></h2>
<input id="search" type="search" placeholder="Search name / mobile / ID…" oninput="filterAcc(this.value)">
<div id="accList">${rows}</div>
</section>

<section class="panel" id="sec-notif">
<h2>🔔 Notification Studio</h2>
<p class="sub">Gold = sab customers · Blue glow = sirf selected customer ka personal alert.</p>
<form method="POST" action="/admin/send-notification" class="form-grid">
<label class="muted">Recipient
<select name="mobile" class="inp" style="max-width:420px"><option value="">📣 All customers (studio announcement)</option>${customerNotificationOptions}</select>
</label>
<input class="inp" name="title" placeholder="Title">
<textarea name="body" rows="3" placeholder="Message..." required class="inp"></textarea>
<label class="muted">Expire after
<select name="expiresIn" class="inp" style="max-width:240px">
<option value="1">1 hour</option>
<option value="6">6 hours</option>
<option value="12">12 hours</option>
<option value="24" selected>24 hours (1 day)</option>
<option value="48">2 days</option>
<option value="72">3 days</option>
<option value="168">7 days</option>
<option value="720">30 days</option>
<option value="0">Never expire</option>
</select>
</label>
<button class="gen-btn" type="submit">✨ Send Notification</button>
</form>
<form method="POST" action="/admin/telegram-test" style="margin-top:10px"><button type="submit" class="gen-btn" style="background:linear-gradient(135deg,#38bdf8,#2563eb);color:white">✈️ Send Telegram Test Alert</button><span class="muted" style="margin-left:8px">Bot token aur chat ID environment settings me set hone chahiye.</span></form>
<div style="margin-top:9px;padding:8px 10px;border-radius:9px;border:1px solid ${telegramAlertStatus.ok === false ? '#ef4444' : (telegramAlertStatus.configured ? '#22c55e' : '#f59e0b')};color:${telegramAlertStatus.ok === false ? '#fecaca' : (telegramAlertStatus.configured ? '#bbf7d0' : '#fde68a')};font-size:12px">Telegram: ${telegramAlertStatus.configured ? (telegramAlertStatus.ok === false ? 'Alert failed' : 'Configured') : 'Not configured'}${telegramAlertStatus.at ? (' · Last check: ' + esc(fmtDate(telegramAlertStatus.at))) : ''}${telegramAlertStatus.error ? (' · ' + esc(telegramAlertStatus.error)) : ''}</div>
<div class="lbl" style="margin-top:16px">Active notifications</div>
<div id="adminNotifList">${notifAdminCards}</div>
</section>

<section class="panel" id="sec-backup">
<h2>💾 Backup & Restore</h2>
<div class="form-row">
<a class="gen-btn" href="/admin/backup">⬇️ Download Backup</a>
<form method="POST" action="/admin/restore" enctype="multipart/form-data" class="form-row">
<input type="file" name="backup" accept=".json" required class="field-file">
<button class="gen-btn" type="submit">⬆️ Restore</button>
</form>
</div>
</section>

</main>
</div>
<div id="liveBar">
🔄 Live: <span id="liveStatus">connecting…</span>
<label style="margin-left:10px;cursor:pointer;color:#D4AF37;"><input type="checkbox" id="soundToggle" checked> Sound</label>
</div>
<script>
function filterAcc(q){q=(q||'').toLowerCase();document.querySelectorAll('#accList .acc').forEach(function(el){el.style.display=!q||el.textContent.toLowerCase().indexOf(q)>=0?'':'none';});}
function filterPanel(kind){
  document.querySelectorAll('.card-click').forEach(function(c){ c.classList.remove('active-filter'); });
  var bar = document.getElementById('filterBar');
  var label = document.getElementById('filterLabel');
  var custH = document.querySelector('h2');
  // scroll targets
  if(kind === 'otp'){
    var el = document.getElementById('h2Otp'); if(el) el.scrollIntoView({behavior:'smooth'});
    if(bar){ bar.style.display='flex'; if(label) label.textContent='Filter: Pending OTP section'; }
    return;
  }
  if(kind === 'pin'){
    var el2 = document.getElementById('h2Pin'); if(el2) el2.scrollIntoView({behavior:'smooth'});
    if(bar){ bar.style.display='flex'; if(label) label.textContent='Filter: PIN Reset section'; }
    return;
  }
  if(kind === 'codes'){
    var el3 = document.getElementById('codesTable'); if(el3) el3.scrollIntoView({behavior:'smooth'});
    if(bar){ bar.style.display='flex'; if(label) label.textContent='Filter: Unused / spin codes'; }
    return;
  }
  // customer list filters
  var map = { all:'all', today:'today', verified:'verified', freespin:'freespin', unverified:'unverified' };
  var f = map[kind] || 'all';
  document.querySelectorAll('#accList .acc').forEach(function(el){
    var df = (el.getAttribute('data-filter')||'');
    el.style.display = (f==='all' || df.indexOf(f)>=0) ? '' : 'none';
  });
  var list = document.getElementById('accList');
  if(list) list.scrollIntoView({behavior:'smooth'});
  if(bar){
    bar.style.display = f==='all' ? 'none' : 'flex';
    if(label) label.textContent = 'Filter: ' + kind;
  }
  // highlight card
  document.querySelectorAll('.card-click').forEach(function(c){
    if((c.getAttribute('onclick')||'').indexOf("'"+kind+"'")>=0) c.classList.add('active-filter');
  });
}

var lastSig = '';
var lastOrderIdSeen = '';
var audioCtx = null;
function viewImg(src) {
  var m = document.getElementById('imgView');
  if (!m || !src) return;
  m.querySelector('img').src = src;
  m.classList.add('show');
}
function closeImg() {
  var m = document.getElementById('imgView');
  if (!m) return;
  m.classList.remove('show');
  m.querySelector('img').src = '';
}
function dlImg(src, name) {
  if (!src) return;
  try {
    var a = document.createElement('a');
    a.href = src;
    a.download = name || 'photo.jpg';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) { window.open(src, '_blank'); }
}
var _ordMedia = { n: 0 };
function stashMedia(src) {
  var id = 'k' + (++_ordMedia.n);
  _ordMedia[id] = src;
  return id;
}
function mediaBlock(src, label, fname) {
  if (!src) return '<div class="muted" style="margin-top:8px">' + label + ' nahi mila</div>';
  var id = stashMedia(src);
  return '<div style="margin-top:10px;padding:10px;background:#0a0806;border:1px solid rgba(212,175,55,.28);border-radius:10px">'
    + '<b style="color:#D4AF37">' + label + '</b>'
    + '<div style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
    + '<img src="' + src + '" alt="" onclick="viewImg(_ordMedia.' + id + ')" style="width:110px;height:110px;object-fit:cover;border-radius:10px;border:2px solid #D4AF37;cursor:zoom-in;background:#111" title="Click to view"/>'
    + '<button type="button" class="gen-btn" onclick="viewImg(_ordMedia.' + id + ')">View</button>'
    + '<button type="button" class="gen-btn" onclick="dlImg(_ordMedia.' + id + ',\\'' + esc(fname) + '\\')">Download</button>'
    + '</div></div>';
}
function playAlert() {
  if (document.getElementById('soundToggle') && !document.getElementById('soundToggle').checked) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    var t = audioCtx.currentTime;
    [880, 1174, 880].forEach(function(freq, i) {
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + i * 0.15);
      g.gain.exponentialRampToValueAtTime(0.2, t + i * 0.15 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.15 + 0.2);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t + i * 0.15); o.stop(t + i * 0.15 + 0.25);
    });
  } catch (e) {}
}

function esc(t) {
  return String(t == null ? '' : t)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(d) {
  try { return d ? new Date(d).toLocaleString('en-IN') : ''; } catch(e) { return ''; }
}
function adminWhatsAppOtp(mobile, otp) {
  var to = String(mobile || '').replace(/\\D/g, '');
  var code = String(otp || '').replace(/\\D/g, '');
  if (!/^[6-9]\\d{9}$/.test(to) || !/^\\d{6}$/.test(code)) { alert('OTP ya mobile invalid hai.'); return; }
  fetch('/admin/otp-mark-sent',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({mobile:to})}).catch(function(){});
  var text = 'Aditya Studio OTP: ' + code + '. Yeh 5 minute tak valid hai. Kisi ke saath share na karein.';
  window.location.href = 'https://wa.me/91' + to + '?text=' + encodeURIComponent(text);
}

function renderOtps(list) {
  var box = document.getElementById('otpLiveBox');
  if (!box) return;
  if (!list.length) { box.innerHTML = '<div class="muted">No pending OTP</div>'; return; }
  box.innerHTML = list.map(function(r) {
    var manual = String(r.manualOtp || '');
    var status = manual ? '<span style="color:#facc15;font-weight:700">WhatsApp OTP भेजना बाकी है</span>' : '<span style="color:#8fd19e;font-weight:700">SMS OTP sent</span>';
    var code = manual ? '<div style="margin:9px 0;padding:8px 12px;border-radius:10px;background:#21170a;border:1px dashed #facc15;color:#fff3a6;font-size:22px;font-weight:900;letter-spacing:5px">OTP: '+esc(manual)+'</div>' : '';
    var wa = manual ? '<button type="button" class="gen-btn" style="background:#16a34a;color:#fff;border:1px solid #4ade80" data-omobile="'+esc(r.mobile||'')+'" data-otp="'+esc(manual)+'" onclick="adminWhatsAppOtp(this.dataset.omobile,this.dataset.otp)">💬 WhatsApp OTP भेजें</button>' : '';
    return '<div class="msg-card" style="border-color:rgba(255,80,80,0.4);box-shadow:0 0 12px rgba(255,80,80,0.15)">'
      + '<div class="msg-text">📱 <b>' + esc(r.name || '') + '</b> (' + esc(r.mobile) + ')<br>' + status + code + '<span class="muted">' + esc(fmt(r.at)) + (r.expiresAt ? ' · Expires: ' + esc(fmt(r.expiresAt)) : '') + '</span></div>'
      + '<div class="msg-actions" style="display:flex;gap:8px;flex-wrap:wrap">'
      + wa + '<button type="button" class="gen-btn" style="background:#7f1d1d;color:#fecaca;border:1px solid #991b1b" data-oid="'+esc(r.id||'')+'" data-omobile="'+esc(r.mobile||'')+'" onclick="adminDeleteOtp(this.dataset.oid,this.dataset.omobile)">🗑️ Delete</button></div></div>';
  }).join('');
}

function renderPins(list) {
  var box = document.getElementById('pinLiveBox');
  if (!box) return;
  if (!list.length) { box.innerHTML = '<div class="muted">No PIN resets</div>'; return; }
  box.innerHTML = list.map(function(a) {
    return '<div class="msg-card" style="border-color:rgba(255,200,0,0.35)">'
      + '<div class="msg-text">🔔 <b>' + esc(a.name) + '</b> (' + esc(a.mobile) + ') ' + esc(fmt(a.at)) + '</div>'
      + '<div class="msg-actions"><form method="POST" action="/admin/reset-pin" style="display:flex;gap:6px"><input type="hidden" name="mobile" value="' + esc(a.mobile) + '"><input class="inp" name="newPin" placeholder="Naya PIN" maxlength="4"><button class="gen-btn" type="submit">Reset → WA</button></form></div></div>';
  }).join('');
}

function renderAdminNotifs(list) {
  var box = document.getElementById('adminNotifList');
  if (!box) return;
  if (!list || !list.length) { box.innerHTML = '<div class="muted">No active notifications</div>'; return; }
  box.innerHTML = list.map(function(n) {
    var nid = esc(n.id || n.at || '');
    var exp = n.expiresAt ? fmt(n.expiresAt) : 'Never';
    var personal = !!n.mobile;
    return '<div class="msg-card" style="margin-top:8px;border-color:'+(personal?'rgba(34,211,238,.65)':'rgba(212,175,55,.35)')+';box-shadow:0 0 16px '+(personal?'rgba(34,211,238,.16)':'rgba(212,175,55,.10)')+'"><div class="msg-text"><b>'+(personal?'👤 Personal alert · ':'📣 Studio alert · ')+esc(n.title||'') + '</b><br>' + esc(n.body||'') +(personal?'<br><span style="color:#67e8f9;font-size:12px">To: '+esc(n.mobile)+'</span>':'')+
      '<br><span class="muted">Sent: ' + esc(fmt(n.at)) + ' · Exp: ' + esc(exp) + '</span></div>' +
      '<div class="msg-actions"><form method="POST" action="/admin/delete-notification"><input type="hidden" name="id" value="' + nid + '">' +
      '<button type="submit" style="padding:6px 10px;background:#5a1a1a;color:#fca5a5;border:1px solid #7f1d1d;border-radius:6px;cursor:pointer">🗑 Delete</button></form></div></div>';
  }).join('');
}
function setCount(id, n) {
  var el = document.getElementById(id);
  if (el) el.textContent = n;
}

async function adminDeleteOtp(id, mobile) {
  if (!confirm('OTP delete karein?\\n' + (mobile || id || ''))) return;
  try {
    var res = await fetch('/admin/otp-delete', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id || '', mobile: mobile || '' })
    });
    var data = await res.json();
    if (data.ok) {
      if (typeof pollLive === 'function') pollLive();
      else location.reload();
    } else alert('Delete fail');
  } catch (e) { alert('Network error'); }
}

async function pollLive() {
  var st = document.getElementById('liveStatus');
  try {
    var res = await fetch('/admin/live-json', { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) {
      if (st) st.textContent = 'login needed';
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    if (!data.ok) throw new Error('bad');
    var sig = JSON.stringify({ o: data.pendingOtps, p: data.pendingResets, n: data.notifications, oid: data.latestOrder && data.latestOrder.orderId });
    if (lastSig && sig !== lastSig) {
      var prev = {};
      try { prev = JSON.parse(lastSig); } catch(e) {}
      var newOtp = (data.pendingOtps || []).length > ((prev.o || []).length || 0);
      var newPin = (data.pendingResets || []).length > ((prev.p || []).length || 0);
      var newNotif = false;
      var prevN0 = (prev.n && prev.n[0]) ? (prev.n[0].at + '|' + prev.n[0].title) : '';
      var curN0 = (data.notifications && data.notifications[0]) ? (data.notifications[0].at + '|' + data.notifications[0].title) : '';
      if (curN0 && curN0 !== prevN0) newNotif = true;
      var prevOtpKeys = (prev.o || []).map(function(x){ return x.mobile + ':' + (x.at || ''); }).join('|');
      (data.pendingOtps || []).forEach(function(r) {
        if (prevOtpKeys && prevOtpKeys.indexOf(r.mobile + ':' + (r.at || '')) < 0) newOtp = true;
      });
      var lo = data.latestOrder || null;
      var newOrd = !!(lo && lo.orderId && prev.oid && lo.orderId !== prev.oid);
      if (!prev.oid && lo && lo.orderId && lastOrderIdSeen && lo.orderId !== lastOrderIdSeen) newOrd = true;
      if (newOrd) {
        playAlert();
        var ban = document.getElementById('newOrderBanner');
        if (ban) {
          ban.textContent = 'Naya order: ' + lo.orderId + ' · ' + (lo.name || '') + ' · ' + (lo.mobile || '') + ' — click karke details dekho';
          ban.classList.add('show');
        }
        alert('Naya order aaya!\\nOrder No: ' + lo.orderId + '\\n' + (lo.name || '') + ' · ' + (lo.mobile || ''));
        try {
          if (Notification && Notification.permission === 'granted') {
            new Notification('Naya Frame Order', { body: lo.orderId + ' · ' + (lo.name || '') });
          }
        } catch(e) {}
        if (typeof loadAdminFrames === 'function') loadAdminFrames();
      }
      if (newOtp || newPin || newNotif) {
        playAlert();
        if (st) st.innerHTML = '<span style="color:#3ee06b">🔔 NEW ' + (newOtp ? 'OTP' : newPin ? 'PIN' : 'Notification') + '!</span>';
        try {
          if (document.hidden && Notification && Notification.permission === 'granted') {
            new Notification('Aditya Studio Admin', { body: newOtp ? 'Naya OTP request' : 'Naya PIN reset request' });
          }
        } catch(e) {}
      } else if (st && !newOrd) {
        st.textContent = 'ok · ' + new Date().toLocaleTimeString('en-IN');
      }
    } else if (st) {
      st.textContent = 'ok · ' + new Date().toLocaleTimeString('en-IN');
    }
    lastSig = sig;
    if (data.latestOrder && data.latestOrder.orderId) lastOrderIdSeen = data.latestOrder.orderId;
    renderOtps(data.pendingOtps || []);
    renderPins(data.pendingResets || []);
    if (typeof renderAdminNotifs === 'function') renderAdminNotifs(data.notifications || []);
    if (data.counts) {
      setCount('cntOtp', data.counts.pendingOtp);
      setCount('cntPin', data.counts.pendingPin);
      setCount('cntCust', data.counts.customers);
      setCount('cntCodes', data.counts.unusedCodes);
      var h2o = document.getElementById('h2Otp');
      var h2p = document.getElementById('h2Pin');
      if (h2o) h2o.textContent = '📱 Spin OTP (' + data.counts.pendingOtp + ')';
      if (h2p) h2p.textContent = '⚠️ PIN Reset (' + data.counts.pendingPin + ')';
    }
  } catch (e) {
    if (st) st.textContent = 'retry…';
  }
}

// Unlock audio on first click (browser policy)
document.addEventListener('click', function once() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch(e) {}
  if (window.Notification && Notification.permission === 'default') {
    Notification.requestPermission().catch(function(){});
  }
  document.removeEventListener('click', once);
});

/* ---- Home banner photo upload ---- */
async function adminUploadBanners() {
  var input = document.getElementById('bannerFiles');
  var status = document.getElementById('bannerUploadStatus');
  var files = input && input.files ? Array.from(input.files) : [];
  if (!files.length) { alert('Pehle photos choose karo'); return; }
  var title = (document.getElementById('bannerTitle') || {}).value || 'Aditya Studio';
  var sub = (document.getElementById('bannerSub') || {}).value || '';
  var replace = !!(document.getElementById('bannerReplace') || {}).checked;
  status.textContent = 'Uploading ' + files.length + ' photo(s)…';
  try {
    var items = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.size > 2.2e6) { alert(f.name + ' 2MB se chhoti rakho'); return; }
      var dataUrl = await new Promise(function(resolve, reject) {
        var r = new FileReader();
        r.onload = function() { resolve(r.result); };
        r.onerror = reject;
        r.readAsDataURL(f);
      });
      items.push({ url: dataUrl, title: title, sub: sub });
    }
    var res = await fetch('/admin/banner-upload', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items, replace: replace })
    });
    var data = await res.json();
    if (!data.ok) { status.textContent = 'Fail'; alert('Upload fail'); return; }
    status.textContent = 'Saved ✅ Total banners: ' + data.count;
    alert('Banner photos saved! Home / Frames page refresh karo.');
    if (input) input.value = '';
  } catch (e) {
    status.textContent = 'Error';
    alert('Network error');
  }
}

/* ---- Current Deals editor (Home page) ---- */
var _homeDeals = Array.isArray(window.__HOME_DEALS__) ? window.__HOME_DEALS__.map(function(item) {
  return (item && typeof item === 'object') ? item : { url: String(item || ''), title: 'Aditya Studio', sub: '', link: '/frames', active: true };
}) : [];

function dealText(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function renderHomeDealsEditor() {
  var root = document.getElementById('homeDealsEditor');
  if (!root) return;
  if (!_homeDeals.length) {
    root.innerHTML = '<p class="muted">Abhi koi custom deal nahi hai. “Deal card add” dabakar photo aur text add karein.</p>';
    return;
  }
  root.innerHTML = _homeDeals.map(function(deal, index) {
    var photo = deal.url ? '<img src="' + dealText(deal.url) + '" style="width:100%;height:110px;object-fit:cover;border-radius:9px;border:1px solid #6b5522">' : '<div style="height:110px;display:grid;place-items:center;border:1px dashed #6b5522;border-radius:9px;color:#a99b7d">Photo choose karein</div>';
    return '<div class="panel" style="padding:14px;margin:10px 0;background:#18130d">'
      + '<div class="form-row" style="justify-content:space-between"><b>Deal ' + (index + 1) + '</b><span><button type="button" class="mini-btn" onclick="adminMoveDeal(' + index + ',-1)">↑</button> <button type="button" class="mini-btn" onclick="adminMoveDeal(' + index + ',1)">↓</button> <button type="button" class="mini-btn" style="color:#fca5a5" onclick="adminRemoveDeal(' + index + ')">Remove</button></span></div>'
      + '<div class="form-grid" style="grid-template-columns:minmax(120px,180px) 1fr;align-items:start">'
      + '<div id="dealPreview' + index + '">' + photo + '</div>'
      + '<div><label class="muted">Deal photo<input type="file" accept="image/*" class="field-file" onchange="adminDealImage(this,' + index + ')"></label>'
      + '<label class="muted">Heading<input class="inp deal-title" maxlength="80" value="' + dealText(deal.title || '') + '"></label>'
      + '<label class="muted">Neeche ka text<input class="inp deal-sub" maxlength="160" value="' + dealText(deal.sub || '') + '"></label>'
      + '<label class="muted">Click karne par link<input class="inp deal-link" maxlength="300" value="' + dealText(deal.link || '/frames') + '" placeholder="/frames ya /book-now"></label>'
      + '<label class="muted" style="display:flex;align-items:center;gap:8px"><input class="deal-active" type="checkbox" ' + (deal.active !== false ? 'checked' : '') + '> Is deal ko show karein</label></div></div></div>';
  }).join('');
}
function adminAddDeal() {
  if (_homeDeals.length >= 12) return alert('Maximum 12 deal cards rakh sakte hain');
  _homeDeals.push({ url: '', title: 'Naya Deal', sub: 'Offer details yahan likhein', link: '/frames', active: true });
  renderHomeDealsEditor();
}
function adminRemoveDeal(index) {
  _homeDeals.splice(index, 1);
  renderHomeDealsEditor();
}
function adminMoveDeal(index, direction) {
  var next = index + direction;
  if (next < 0 || next >= _homeDeals.length) return;
  var temp = _homeDeals[index]; _homeDeals[index] = _homeDeals[next]; _homeDeals[next] = temp;
  renderHomeDealsEditor();
}
async function adminDealImage(input, index) {
  var file = input && input.files && input.files[0];
  if (!file) return;
  if (!/^image\\//.test(file.type) || file.size > 2.2e6) { alert('Sirf image file aur 2MB se chhoti photo choose karein'); input.value = ''; return; }
  try {
    var dataUrl = typeof compressImageFile === 'function' ? await compressImageFile(file, 1100, 0.82) : await new Promise(function(resolve, reject) { var reader = new FileReader(); reader.onload = function(){ resolve(reader.result); }; reader.onerror = reject; reader.readAsDataURL(file); });
    _homeDeals[index].url = dataUrl;
    var preview = document.getElementById('dealPreview' + index);
    if (preview) preview.innerHTML = '<img src="' + dealText(dataUrl) + '" style="width:100%;height:110px;object-fit:cover;border-radius:9px;border:1px solid #6b5522">';
  } catch (e) { alert('Photo process nahi ho paayi — doosri photo try karein'); }
}
async function adminSaveDeals() {
  var cards = Array.from(document.querySelectorAll('#homeDealsEditor .panel'));
  cards.forEach(function(card, index) {
    var deal = _homeDeals[index]; if (!deal) return;
    deal.title = (card.querySelector('.deal-title') || {}).value || 'Deal ' + (index + 1);
    deal.sub = (card.querySelector('.deal-sub') || {}).value || '';
    deal.link = (card.querySelector('.deal-link') || {}).value || '/frames';
    deal.active = !!((card.querySelector('.deal-active') || {}).checked);
  });
  var usable = _homeDeals.filter(function(item) { return item.url; });
  if (!usable.length) return alert('Kam se kam ek deal me photo choose karein');
  var status = document.getElementById('homeDealsStatus'); if (status) status.textContent = 'Saving…';
  try {
    var duration = Number((document.getElementById('dealDuration') || {}).value) || 20;
    var res = await fetch('/admin/home-deals-save', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: _homeDeals, durationSec: duration }) });
    var data = await res.json();
    if (!data.ok) throw new Error(data.message || 'Save fail');
    if (status) status.textContent = '✅ ' + data.count + ' Current Deals save ho gaye. Home page refresh karke dekhein.';
  } catch (e) { if (status) status.textContent = '❌ ' + (e.message || 'Save fail'); }
}
renderHomeDealsEditor();

async function adminUpload3dPhotos() {
  var input = document.getElementById('f3dFiles');
  var status = document.getElementById('f3dStatus');
  var files = input && input.files ? Array.from(input.files) : [];
  if (!files.length) { alert('Pehle photos choose karo'); return; }
  var replace = !!(document.getElementById('f3dReplace') || {}).checked;
  status.textContent = 'Uploading ' + files.length + '…';
  try {
    var items = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.size > 2.2e6) { alert(f.name + ' 2MB se chhoti rakho'); return; }
      var dataUrl = await new Promise(function(resolve, reject) {
        var r = new FileReader();
        r.onload = function() { resolve(r.result); };
        r.onerror = reject;
        r.readAsDataURL(f);
      });
      items.push({ url: dataUrl, title: f.name });
    }
    var res = await fetch('/admin/frames3d-upload', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items, replace: replace })
    });
    var data = await res.json();
    if (!data.ok) { status.textContent = 'Fail'; return; }
    status.textContent = 'Saved ✅ Total 3D photos: ' + data.count;
    alert('3D sample photos saved!');
    if (input) input.value = '';
  } catch (e) {
    status.textContent = 'Error';
    alert('Network error');
  }
}
async function adminClear3dPhotos() {
  if (!confirm('Saari 3D sample photos delete?')) return;
  var res = await fetch('/admin/frames3d-clear', { method: 'POST', credentials: 'same-origin' });
  var data = await res.json();
  var st = document.getElementById('f3dStatus');
  if (st) st.textContent = data.ok ? 'Cleared' : 'Fail';
}

function compressImageFile(file, maxW, quality) {
  maxW = maxW || 1200;
  quality = quality || 0.82;
  return new Promise(function(resolve, reject) {
    var r = new FileReader();
    r.onerror = function() { reject(new Error('FileReader fail')); };
    r.onload = function() {
      var img = new Image();
      img.onload = function() {
        try {
          var w = img.width || 1, h = img.height || 1;
          if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
          // max dimension safety
          if (w * h > 4000000) {
            var scale = Math.sqrt(4000000 / (w * h));
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
          }
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', quality));
        } catch (err) {
          // canvas fail → return original data URL if small enough
          if (r.result && String(r.result).length < 3e6) resolve(r.result);
          else reject(err);
        }
      };
      img.onerror = function() {
        if (r.result && String(r.result).length < 3e6) resolve(r.result);
        else reject(new Error('Image decode fail'));
      };
      img.src = r.result;
    };
    r.readAsDataURL(file);
  });
}
async function adminUploadHomeFrame() {
  var input = document.getElementById('homeFrameFiles');
  var status = document.getElementById('homeFrameStatus');
  var files = input && input.files ? Array.from(input.files) : [];
  if (!files.length) { alert('Pehle photos choose karo (max 5)\\nWindows: Ctrl+click se multiple select'); return; }
  if (files.length > 5) { alert('Maximum 5 photos select karo'); return; }
  var replace = !!(document.getElementById('homeFrameReplace') || {}).checked;
  status.textContent = 'Compress + upload ' + files.length + ' photo(s)…';
  try {
    var items = [];
    for (var i = 0; i < files.length; i++) {
      status.textContent = 'Photo ' + (i+1) + '/' + files.length + '…';
      var dataUrl = await compressImageFile(files[i], 1200, 0.82);
      items.push({ url: dataUrl, title: files[i].name || ('Photo ' + (i+1)) });
    }
    var res = await fetch('/admin/home-hero-frame-upload', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items, replace: replace })
    });
    var data = await res.json();
    if (!data.ok) { status.textContent = 'Fail: ' + (data.error || ''); alert('Upload fail'); return; }
    status.textContent = 'Saved ✅ ' + data.count + ' / 5 — page reload…';
    alert('Home 3D frame: ' + data.count + ' photos saved!\\nHome page refresh karo.');
    location.href = '/admin#sec-home-frame';
    location.reload();
  } catch (e) {
    console.error(e);
    status.textContent = 'Error: ' + (e.message || 'network');
    alert('Upload error — photo size chhoti try karo');
  }
}
async function adminClearHomeFrame() {
  if (!confirm('Home frame ki saari photos clear?')) return;
  var res = await fetch('/admin/home-hero-frame-clear', { method: 'POST', credentials: 'same-origin' });
  var data = await res.json();
  var st = document.getElementById('homeFrameStatus');
  if (st) st.textContent = data.ok ? 'Cleared' : 'Fail';
  if (data.ok) location.reload();
}

async function adminUploadHeroSideBg() {
  var input = document.getElementById('heroBgFiles');
  var status = document.getElementById('heroBgStatus');
  var files = input && input.files ? Array.from(input.files) : [];
  if (!files.length) { alert('Pehle 4–6 photos choose karo'); return; }
  if (files.length > 6) { alert('Maximum 6 photos'); return; }
  var replace = !!(document.getElementById('heroBgReplace') || {}).checked;
  var durationSec = Number((document.getElementById('heroBgDuration') || {}).value || 5);
  status.textContent = 'Uploading ' + files.length + '…';
  try {
    var items = [];
    for (var i = 0; i < files.length; i++) {
      status.textContent = 'Photo ' + (i+1) + '/' + files.length + '…';
      var dataUrl = await compressImageFile(files[i], 1400, 0.8);
      items.push({ url: dataUrl, title: files[i].name });
    }
    var res = await fetch('/admin/hero-side-bg-upload', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items, replace: replace, durationSec: durationSec })
    });
    var data = await res.json();
    if (!data.ok) { status.textContent = 'Fail'; alert('Upload fail'); return; }
    status.textContent = 'Saved ✅ ' + data.count + ' photos · ' + data.durationSec + 's';
    alert('Hero side BG saved! Home page refresh karo.');
    location.href = '/admin#sec-hero';
    location.reload();
  } catch (e) {
    status.textContent = 'Error';
    alert('Upload error');
  }
}
async function adminSaveHeroBgDuration() {
  var sec = Number((document.getElementById('heroBgDuration') || {}).value || 5);
  var res = await fetch('/admin/hero-side-bg-duration', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ durationSec: sec })
  });
  var data = await res.json();
  var st = document.getElementById('heroBgStatus');
  if (st) st.textContent = data.ok ? ('Duration: ' + data.durationSec + 's saved') : 'Fail';
}
async function adminClearHeroSideBg() {
  if (!confirm('Hero BG photos clear?')) return;
  var res = await fetch('/admin/hero-side-bg-clear', { method: 'POST', credentials: 'same-origin' });
  var data = await res.json();
  if (data.ok) location.reload();
}

async function adminUploadBookImage(key) {
  var input = document.getElementById('bookFile_' + key);
  var st = document.getElementById('bookSt_' + key);
  if (!input || !input.files || !input.files[0]) {
    alert(key + ' ke liye pehle photo choose karo');
    return;
  }
  var file = input.files[0];
  if (st) st.textContent = 'Uploading…';
  try {
    var dataUrl;
    if (typeof compressImageFile === 'function') {
      dataUrl = await compressImageFile(file, 1000, 0.82);
    } else {
      dataUrl = await new Promise(function(resolve, reject) {
        var r = new FileReader();
        r.onload = function() { resolve(r.result); };
        r.onerror = reject;
        r.readAsDataURL(file);
      });
    }
    var res = await fetch('/admin/book-image-upload', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, url: dataUrl })
    });
    var data = await res.json();
    if (!data.ok) {
      if (st) st.textContent = 'Fail';
      alert('Upload fail: ' + (data.error || ''));
      return;
    }
    if (st) st.textContent = 'Saved ✅';
    alert(key + ' photo saved! Page reload…');
    location.href = '/admin#sec-book';
    location.reload();
  } catch (e) {
    if (st) st.textContent = 'Error';
    alert('Network / compress error');
  }
}

/* ---- Photo Frames admin ---- */
var _frImageData = '';
var _frKeepExistingImage = false;
var _adminFramesCache = [];
var frFileEl = document.getElementById('frFile');

function setFrPhotoPreview(src) {
  var prev = document.getElementById('frPhotoPreview');
  var st = document.getElementById('frPhotoStatus');
  if (prev) {
    if (src) { prev.src = src; prev.style.display = 'block'; }
    else { prev.removeAttribute('src'); prev.style.display = 'none'; }
  }
  if (st) {
    if (src) st.textContent = 'Photo ready ✅';
    else st.textContent = 'Nayi photo choose karo (optional on edit)';
  }
}

if (frFileEl) frFileEl.addEventListener('change', function(e) {
  var f = e.target.files && e.target.files[0];
  if (!f) { return; }
  if (f.size > 12e6) { alert('Image 12MB se chhoti rakho'); e.target.value=''; return; }
  var st = document.getElementById('frPhotoStatus');
  if (st) st.textContent = 'Loading preview…';
  _frImageData = '';
  _frKeepExistingImage = false;
  // 1) Turant preview (raw file) — pehle jaisa side me dikhe
  var previewReader = new FileReader();
  previewReader.onload = function() {
    var raw = previewReader.result || '';
    setFrPhotoPreview(raw);
    if (st) st.textContent = 'Preview ready — compress ho raha hai…';
    // 2) Background compress for upload size
    var doCompress = (typeof compressImageFile === 'function')
      ? compressImageFile(f, 1000, 0.8)
      : Promise.resolve(raw);
    doCompress.then(function(dataUrl) {
      if (!dataUrl) throw new Error('empty');
      if (dataUrl.length > 4e6) {
        // try harder compress
        return (typeof compressImageFile === 'function')
          ? compressImageFile(f, 800, 0.7)
          : dataUrl;
      }
      return dataUrl;
    }).then(function(dataUrl) {
      if (!dataUrl) {
        // fallback: use raw preview if not huge
        if (raw && raw.length < 4e6) {
          _frImageData = raw;
          if (st) st.textContent = 'Photo ready ✅';
          return;
        }
        alert('Photo bahut badi hai — chhoti image try karo');
        _frImageData = '';
        e.target.value = '';
        setFrPhotoPreview('');
        return;
      }
      _frImageData = dataUrl;
      setFrPhotoPreview(dataUrl);
      if (st) st.textContent = 'Photo ready ✅';
    }).catch(function(err) {
      // compress fail → raw use if possible
      if (raw && raw.length < 4e6) {
        _frImageData = raw;
        setFrPhotoPreview(raw);
        if (st) st.textContent = 'Photo ready ✅ (raw)';
      } else {
        alert('Image process fail — doosri photo try karo');
        _frImageData = '';
        e.target.value = '';
        setFrPhotoPreview('');
        if (st) st.textContent = 'Fail — phir se choose karo';
      }
    });
  };
  previewReader.onerror = function() {
    alert('File read fail');
    if (st) st.textContent = 'Read fail';
  };
  previewReader.readAsDataURL(f);
});

function adminCancelEditFrame() {
  var idEl = document.getElementById('frId'); if (idEl) idEl.value = '';
  var tEl = document.getElementById('frTitle'); if (tEl) tEl.value = '';
  var pEl = document.getElementById('frPrice'); if (pEl) pEl.value = '';
  var dEl = document.getElementById('frDisc'); if (dEl) dEl.value = '';
  var aEl = document.getElementById('frActive'); if (aEl) aEl.checked = true;
  document.querySelectorAll('.fr-size-tick').forEach(function(box) { box.checked = box.value === ((document.getElementById('frSize') || {}).value || '8x12'); });
  if (frFileEl) frFileEl.value = '';
  _frImageData = '';
  _frKeepExistingImage = false;
  setFrPhotoPreview('');
  var cancel = document.getElementById('frCancelEdit');
  if (cancel) cancel.style.display = 'none';
  var btn = document.querySelector('button[onclick="adminSaveFrame()"]');
  if (btn) btn.textContent = '💾 Save Frame Type';
}

function adminEditFrame(id) {
  var f = (_adminFramesCache || []).find(function(x) { return String(x.id) === String(id); });
  if (!f) return alert('Frame nahi mila — list refresh karke try karo');
  var idEl = document.getElementById('frId'); if (idEl) idEl.value = f.id || '';
  var sizeEl = document.getElementById('frSize'); if (sizeEl && f.size) sizeEl.value = f.size;
  var frameSizes = Array.isArray(f.availableSizes) && f.availableSizes.length ? f.availableSizes : [f.size];
  document.querySelectorAll('.fr-size-tick').forEach(function(box) { box.checked = frameSizes.indexOf(box.value) >= 0; });
  var tEl = document.getElementById('frTitle'); if (tEl) tEl.value = f.title || '';
  var pEl = document.getElementById('frPrice'); if (pEl) pEl.value = f.price != null ? f.price : '';
  var dEl = document.getElementById('frDisc'); if (dEl) dEl.value = f.discountPercent != null ? f.discountPercent : '';
  var aEl = document.getElementById('frActive'); if (aEl) aEl.checked = f.active !== false;
  if (frFileEl) frFileEl.value = '';
  _frImageData = '';
  var existing = f.imageData || f.imageUrl || '';
  _frKeepExistingImage = !!existing;
  setFrPhotoPreview(existing || '');
  var st = document.getElementById('frPhotoStatus');
  if (st) st.textContent = existing ? 'Purani photo rahegi — badalne ke liye nayi choose karo' : 'Abhi photo nahi — nayi choose karo';
  var cancel = document.getElementById('frCancelEdit');
  if (cancel) cancel.style.display = 'inline-block';
  var btn = document.querySelector('button[onclick="adminSaveFrame()"]');
  if (btn) btn.textContent = '💾 Update Frame Type';
  var sec = document.getElementById('sec-frames');
  if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function adminSaveFrame() {
  var id = (document.getElementById('frId') || {}).value || '';
  var size = (document.getElementById('frSize') || {}).value || '';
  var title = (document.getElementById('frTitle') || {}).value || '';
  var price = Number((document.getElementById('frPrice') || {}).value || 0);
  var disc = Number((document.getElementById('frDisc') || {}).value || 0);
  var active = !!((document.getElementById('frActive') || {}).checked);
  var availableSizes = Array.prototype.slice.call(document.querySelectorAll('.fr-size-tick:checked')).map(function(box) { return box.value; });
  if (availableSizes.indexOf(size) < 0) availableSizes.unshift(size);
  if (!size) return alert('Size choose karo');
  if (!title) return alert('Frame Type name likho (jaise Golden border)');
  var fileInput = document.getElementById('frFile');
  // Agar file choose hai lekin compress pending — save pe wait karke process karo
  if (fileInput && fileInput.files && fileInput.files[0] && !_frImageData) {
    var st = document.getElementById('frPhotoStatus');
    if (st) st.textContent = 'Saving — photo process…';
    try {
      var f = fileInput.files[0];
      if (typeof compressImageFile === 'function') {
        _frImageData = await compressImageFile(f, 1000, 0.8);
      } else {
        _frImageData = await new Promise(function(resolve, reject) {
          var r = new FileReader();
          r.onload = function() { resolve(r.result || ''); };
          r.onerror = reject;
          r.readAsDataURL(f);
        });
      }
    } catch (err) {
      return alert('Photo process fail — doosri image try karo');
    }
    if (!_frImageData) {
      return alert('Photo process nahi hui — phir se choose karo');
    }
    setFrPhotoPreview(_frImageData);
    if (st) st.textContent = 'Photo ready ✅';
  }
  var payload = {
    id: id || undefined,
    size: size,
    availableSizes: availableSizes,
    title: title,
    price: price,
    discountPercent: disc,
    imageData: _frImageData || '',
    active: active
  };
  try {
    var res = await fetch('/admin/frame-save', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok || !data.ok) {
      var msg = (data && (data.message || data.error)) || ('HTTP ' + res.status);
      return alert('Save fail: ' + msg);
    }
    var hasImg = data.frame && data.frame.hasImage;
    alert((id ? 'Frame updated ✅' : 'Frame saved ✅') + (hasImg ? ' (photo ke saath)' : ' (bina photo)'));
    adminCancelEditFrame();
    loadAdminFrames();
  } catch (e) { alert('Network error: ' + (e && e.message ? e.message : 'check connection')); }
}

async function adminDeleteFrame(id) {
  if (!confirm('Delete this frame?')) return;
  await fetch('/admin/frame-delete', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id })
  });
  if ((document.getElementById('frId') || {}).value === id) adminCancelEditFrame();
  loadAdminFrames();
}

async function adminUpdateOrder(orderId) {
  var st = (document.getElementById('st-' + orderId) || {}).value;
  var pay = (document.getElementById('pay-' + orderId) || {}).value;
  var dd = (document.getElementById('dd-' + orderId) || {}).value || '';
  var dt = (document.getElementById('dt-' + orderId) || {}).value || '';
  var note = (document.getElementById('an-' + orderId) || {}).value || '';
  try {
    var res = await fetch('/admin/frame-order-update', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: orderId, status: st, paymentStatus: pay, deliveryDate: dd, deliveryTime: dt, adminNote: note })
    });
    var data = await res.json();
    if (data.ok) { alert('Order updated + customer notified ✅'); loadAdminFrames(); }
    else alert('Update fail');
  } catch (e) { alert('Network error'); }
}

async function adminConfirmPay(orderId) {
  if (!confirm('Payment successful confirm karein? Customer ko notify hoga.')) return;
  var dd = (document.getElementById('dd-' + orderId) || {}).value || '';
  var dt = (document.getElementById('dt-' + orderId) || {}).value || '';
  try {
    var res = await fetch('/admin/frame-order-update', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: orderId, confirmPayment: true, status: 'confirmed', deliveryDate: dd, deliveryTime: dt })
    });
    var data = await res.json();
    if (data.ok) { alert('Payment confirmed ✅ Customer notified'); loadAdminFrames(); }
    else alert('Fail');
  } catch (e) { alert('Network error'); }
}

async function loadAdminFrames() {
  var fBox = document.getElementById('adminFramesList');
  var oBox = document.getElementById('adminOrdersList');
  // Admin note/date/type karte waqt live refresh list ko replace na kare.
  var active = document.activeElement;
  if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
  var keepScroll = window.scrollY || window.pageYOffset || 0;
  try {
    var res = await fetch('/admin/frames-json', { credentials: 'same-origin', cache: 'no-store' });
    var data = await res.json();
    if (!data.ok) {
      if (fBox) fBox.innerHTML = '<div class="muted">Frames load fail (API). Login / password check karo.</div>';
      return;
    }
    var frames = data.frames || [];
    var allOrders = data.orders || [];
    // Rejected/cancelled orders live only in Recovery Orders, never in active admin list.
    var orders = allOrders.filter(function(o){ var s=String(o.status||'').toLowerCase(); return s!=='rejected'&&s!=='cancelled'; });
    // Order summary cards update
    (function(){
      var total = orders.length;
      var todayStr = new Date().toDateString();
      var nNew = 0, nPend = 0, nConf = 0, nPay = 0;
      orders.forEach(function(o){
        try { if (o.createdAt && new Date(o.createdAt).toDateString() === todayStr) nNew++; } catch(e){}
        var st = String(o.status || 'processing').toLowerCase();
        if (st === 'processing' || st === 'pending') nPend++;
        if (st === 'confirmed' || st === 'ready' || st === 'delivered') nConf++;
        var pay = String(o.paymentStatus || 'unpaid').toLowerCase();
        if (pay === 'unpaid' || pay === 'paid_claimed' || pay === 'partial_wallet') nPay++;
      });
      function setN(id, v, color) {
        var el = document.getElementById(id);
        if (!el) return;
        el.textContent = v;
        if (color) el.style.color = color;
      }
      setN('cntOrdTotal', total);
      setN('cntOrdNew', nNew, '#f87171');
      setN('cntOrdPending', nPend, '#fb923c');
      setN('cntOrdConfirmed', nConf, '#4ade80');
      setN('cntOrdPayPend', nPay, '#fbbf24');
      setN('cntOrdRejected', allOrders.filter(function(o){var s=String(o.status||'').toLowerCase();return s==='rejected'||s==='cancelled';}).length, '#f87171');
    })();
    if (fBox) {
      _adminFramesCache = frames;
      if (!frames.length) fBox.innerHTML = '<div class="muted">Abhi koi frame nahi — upar se add karo</div>';
      else {
        fBox.innerHTML = frames.map(function(f) {
          var img = f.imageData || f.imageUrl || '';
          var fp = Math.round((Number(f.price)||0) * (1 - (Number(f.discountPercent)||0)/100));
          var hasImg = !!img;
          var fid = esc(f.id);
          return '<div class="msg-card" style="display:flex;gap:10px;align-items:flex-start;margin-top:8px">'
            + (hasImg ? '<img src="'+img+'" style="width:56px;height:56px;object-fit:cover;border-radius:8px;background:#111">' : '<div style="width:56px;height:56px;background:#222;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#666">No photo</div>')
            + '<div class="msg-text" style="flex:1"><b>'+esc(f.title||'')+'</b> · '+esc(f.size)
            + '<br><span style="display:inline-block;margin-top:4px;padding:3px 7px;border-radius:999px;background:#102c3c;border:1px solid rgba(34,211,238,.4);color:#a5f3fc;font-size:10px;font-weight:800">✅ Available: '+esc((Array.isArray(f.availableSizes)&&f.availableSizes.length?f.availableSizes:[f.size]).join(', '))+'</span>'
            + '<br>₹'+fp+(f.discountPercent?(' <span class="muted">('+f.discountPercent+'% off, MRP ₹'+f.price+')</span>'):'')
            + '<br><span class="muted">'+(f.active===false?'Inactive':'Active')+' · '+fid+(hasImg?'':' · <span style="color:#e08a8a">photo missing</span>')+'</span></div>'
            + '<div class="msg-actions" style="display:flex;flex-direction:column;gap:6px">'
            + '<button type="button" class="fr-edit-btn" data-id="'+fid+'" style="padding:6px 10px;background:#2a2418;color:#F3DE9A;border:1px solid rgba(212,175,55,.4);border-radius:6px;cursor:pointer">Edit</button>'
            + '<button type="button" class="fr-del-btn" data-id="'+fid+'" style="padding:6px 10px;background:#5a1a1a;color:#fca5a5;border:1px solid #7f1d1d;border-radius:6px;cursor:pointer">Del</button>'
            + '</div></div>';
        }).join('');
        fBox.querySelectorAll('.fr-edit-btn').forEach(function(btn) {
          btn.addEventListener('click', function() { adminEditFrame(btn.getAttribute('data-id')); });
        });
        fBox.querySelectorAll('.fr-del-btn').forEach(function(btn) {
          btn.addEventListener('click', function() { adminDeleteFrame(btn.getAttribute('data-id')); });
        });
      }
    }
    if (oBox) {
      if (!orders.length) oBox.innerHTML = '<div class="muted">Abhi koi frame order nahi</div>';
      else oBox.innerHTML = orders.map(function(o) {
        return '<div class="msg-card" style="margin-top:10px">'
          + '<div class="msg-text"><b>'+esc(o.orderId)+'</b> · '+esc(o.frameTitle||'')+' ('+esc(o.size)+')'
          + (o.adminAlert ? '<br><span style="display:inline-block;margin-top:7px;padding:5px 9px;border-radius:999px;background:#7c2d12;color:#fde68a;font-weight:800">🔔 NEW ORDER — payment proof check karein</span>' : '')
          + '<br>👤 '+esc(o.name)+' · '+esc(o.mobile)+' · ₹'+(o.finalAmount||0)
          + '<br>📍 '+esc(o.address||'')
          + (o.village ? ' · गाँव: '+esc(o.village) : '')
          + (o.district ? ' · जिला: '+esc(o.district) : '')
          + (o.state ? ' · राज्य: '+esc(o.state) : '')
          + (o.pincode ? ' · PIN: '+esc(o.pincode) : '')
          + (o.note ? '<br>📝 '+esc(o.note) : '')
          + '<br>💳 Payment: <b>'+esc(o.paymentStatus||'unpaid')+'</b>'
          + (o.trackingNumber ? '<br>🔖 Track: <b>'+esc(o.trackingNumber)+'</b>' : '')
          + (o.utr ? '<br>UTR: <b>'+esc(o.utr)+'</b>' : '')
          + (o.paymentScreenshot ? '<br><div style="margin-top:8px"><b style="color:#D4AF37">💳 Payment proof</b><div style="margin-top:6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><a href="'+esc(o.paymentScreenshot)+'" target="_blank"><img src="'+esc(o.paymentScreenshot)+'" style="width:120px;height:120px;object-fit:cover;border-radius:10px;border:2px solid #D4AF37;background:#111;cursor:pointer" title="Click to open"/></a><a download="payment-'+esc(o.orderId)+'.jpg" href="'+esc(o.paymentScreenshot)+'" style="padding:8px 14px;background:linear-gradient(135deg,#D4AF37,#b8860b);color:#1a1200;font-weight:700;border-radius:8px;text-decoration:none;font-size:13px">⬇️ Payment Proof Download</a></div></div>' : '<br><span class="muted">Payment screenshot nahi mila</span>')
          + (o.customerPhoto ? '<br><div style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><img src="'+esc(o.customerPhoto)+'" style="width:72px;height:72px;object-fit:cover;border-radius:10px;border:2px solid #D4AF37;background:#111"/><a download="customer-photo-'+esc(o.orderId)+'.jpg" href="'+esc(o.customerPhoto)+'" style="padding:8px 14px;background:linear-gradient(135deg,#D4AF37,#b8860b);color:#1a1200;font-weight:700;border-radius:8px;text-decoration:none;font-size:13px">⬇️ Customer Photo Download</a></div>' : '<br><span class="muted">Customer photo nahi mili</span>')
          + '<br><span class="muted">'+esc(fmt(o.createdAt))+'</span></div>'
          + '<div style="display:grid;gap:6px;margin-top:8px;max-width:420px">'
          + '<label class="muted">Status <select class="inp" id="st-'+esc(o.orderId)+'" style="width:100%;max-width:200px">'
          + ['processing','pending','confirmed','ready','delivered','cancelled','rejected'].map(function(s){
              return '<option value="'+s+'"'+(o.status===s?' selected':'')+'>'+s+'</option>';
            }).join('')
          + '</select></label>'
          + '<label class="muted">Payment <select class="inp" id="pay-'+esc(o.orderId)+'" style="width:100%;max-width:200px">'
          + ['unpaid','paid_claimed','confirmed'].map(function(s){
              return '<option value="'+s+'"'+((o.paymentStatus||'unpaid')===s?' selected':'')+'>'+s+'</option>';
            }).join('')
          + '</select></label>'
          + '<label class="muted">Delivery date <input class="inp" id="dd-'+esc(o.orderId)+'" type="date" value="'+esc(o.deliveryDate||'')+'" style="width:100%;max-width:200px"></label>'
          + '<label class="muted">Delivery time <input class="inp" id="dt-'+esc(o.orderId)+'" type="time" value="'+esc(o.deliveryTime||'')+'" style="width:100%;max-width:200px"></label>'
          + '<label class="muted">Admin note <input class="inp" id="an-'+esc(o.orderId)+'" value="'+esc(o.adminNote||'')+'" style="width:100%"></label>'
          + '<div style="display:flex;gap:8px;flex-wrap:wrap">'
          + '<button class="gen-btn" type="button" onclick="adminUpdateOrder(\\''+esc(o.orderId)+'\\')">Update + Notify</button>'
          + (o.paymentStatus !== 'confirmed'
              ? '<button type="button" style="padding:8px 12px;background:#14532d;color:#bbf7d0;border:1px solid #166534;border-radius:8px;cursor:pointer" onclick="adminConfirmPay(\\''+esc(o.orderId)+'\\')">✅ Confirm Payment</button>'
              : '<span class="muted">Payment confirmed</span>')
          + ' <button type="button" style="padding:8px 12px;background:#7f1d1d;color:#fecaca;border:1px solid #991b1b;border-radius:8px;cursor:pointer" data-oid="'+esc(o.orderId)+'" onclick="adminRejectOrder(this.dataset.oid)">❌ Reject</button>'
          + '</div>'
          + '</div></div>';
      }).join('');
    }
    requestAnimationFrame(function(){ window.scrollTo(0, keepScroll); });
  } catch (e) {
    if (fBox) fBox.innerHTML = '<div class="muted">Load fail: ' + (e && e.message ? e.message : 'network') + ' — page refresh karke try karo</div>';
    requestAnimationFrame(function(){ window.scrollTo(0, keepScroll); });
  }
}

async function adminRejectOrder(orderId) {
  var reason = prompt('Reject reason (fake/wrong order):', (document.getElementById('an-' + orderId) || {}).value || 'Fake / invalid order');
  if (reason === null) return;
  if (!confirm('Order ' + orderId + ' REJECT?')) return;
  try {
    var res = await fetch('/admin/frame-order-update', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: orderId, reject: true, status: 'rejected', adminNote: reason, rejectReason: reason })
    });
    var data = await res.json();
    if (data.ok) { alert('Rejected ❌'); if (typeof loadAdminFrames==='function') loadAdminFrames(); if (typeof loadOrdersPage==='function') loadOrdersPage(); }
    else alert('Fail');
  } catch (e) { alert('Network error'); }
}
async function adminSaveFees() {
  var payload = {
    platformFee: Number((document.getElementById('feePlatformAmt')||{}).value||0),
    platformMode: (document.getElementById('feePlatformMode')||{}).value||'always',
    platformMinAmount: Number((document.getElementById('feePlatformMin')||{}).value||0),
    deliveryFee: Number((document.getElementById('feeDeliveryAmt')||{}).value||0),
    deliveryMode: (document.getElementById('feeDeliveryMode')||{}).value||'always',
    deliveryFreeAbove: Number((document.getElementById('feeDeliveryFreeAbove')||{}).value||0),
    deliveryMinAmount: Number((document.getElementById('feeDeliveryMin')||{}).value||0)
  };
  try {
    var res = await fetch('/admin/fees-save', { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    var data = await res.json();
    var m=document.getElementById('feeSaveMsg');
    if (data.ok) {
      if(m) m.textContent='Saved ✅ Platform ₹'+payload.platformFee+' · Delivery ₹'+payload.deliveryFee;
      alert('Fee rules saved ✅');
    } else {
      if(m) m.textContent='Save fail: '+(data.error||res.status);
      alert('Save fail: '+(data.error||res.status));
    }
  } catch(e){
    var m=document.getElementById('feeSaveMsg');
    if(m) m.textContent='Network/JS error: '+(e && e.message ? e.message : e);
    alert('Save error: '+(e && e.message ? e.message : e));
  }
}
async function adminLoadFees() {
  try {
    var res = await fetch('/api/settings', { credentials:'same-origin' });
    var data = await res.json();
    var f = (data.settings && data.settings.fees) || {};
    var set = function(id,v){ var el=document.getElementById(id); if(el && v!=null) el.value=v; };
    set('feePlatformAmt', f.platformFee); set('feePlatformMode', f.platformMode);
    set('feePlatformMin', f.platformMinAmount); set('feeDeliveryAmt', f.deliveryFee);
    set('feeDeliveryMode', f.deliveryMode); set('feeDeliveryFreeAbove', f.deliveryFreeAbove);
    set('feeDeliveryMin', f.deliveryMinAmount);
  } catch(e){}
}
if (document.getElementById('feePlatformAmt')) adminLoadFees();

function qualityAddRow(data) {
  data = data || { id: '', label: '', sub: '', extra: 0 };
  var box = document.getElementById('qualityAdminList');
  if (!box) return;
  var row = document.createElement('div');
  row.className = 'quality-admin-row';
  row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 90px 40px;gap:8px;align-items:center;margin-bottom:6px';
  row.innerHTML = '<input class="inp q-label" placeholder="Name" value="'+esc(data.label||'')+'"/>'
    + '<input class="inp q-sub" placeholder="Sub text" value="'+esc(data.sub||'')+'"/>'
    + '<input class="inp q-extra" type="number" min="0" value="'+(data.extra!=null?data.extra:0)+'"/>'
    + '<button type="button" class="gen-btn" style="background:#7f1d1d;color:#fecaca;padding:6px" onclick="this.parentNode.remove()">✕</button>'
    + '<input type="hidden" class="q-id" value="'+esc(data.id||'')+'"/>';
  box.appendChild(row);
}
async function adminLoadQuality() {
  try {
    var res = await fetch('/api/settings', { credentials: 'same-origin' });
    var data = await res.json();
    var list = (data.settings && data.settings.qualityOptions) || [];
    var box = document.getElementById('qualityAdminList');
    if (!box) return;
    box.innerHTML = '';
    if (!list.length) {
      list = [
        { id:'normal', label:'Normal', sub:'Standard print', extra:0 },
        { id:'lamination', label:'Lamination', sub:'Gloss protect', extra:80 },
        { id:'ntr', label:'NTR Print', sub:'Premium NTR', extra:150 }
      ];
    }
    list.forEach(function(q){ qualityAddRow(q); });
  } catch (e) {}
}
async function adminSaveQuality() {
  var rows = document.querySelectorAll('#qualityAdminList .quality-admin-row');
  var options = [];
  rows.forEach(function(row) {
    var label = ((row.querySelector('.q-label')||{}).value||'').trim();
    if (!label) return;
    var sub = ((row.querySelector('.q-sub')||{}).value||'').trim();
    var extra = Number((row.querySelector('.q-extra')||{}).value||0);
    var id = ((row.querySelector('.q-id')||{}).value||'').trim();
    if (!id) id = label.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,30);
    options.push({ id: id, label: label, sub: sub, extra: extra });
  });
  try {
    var res = await fetch('/admin/quality-save', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: options })
    });
    var data = await res.json();
    var msg = document.getElementById('qualitySaveMsg');
    if (data.ok) {
      if (msg) msg.textContent = 'Saved ✅ ' + options.length + ' options';
      alert('Photo quality saved ✅');
    } else {
      if (msg) msg.textContent = 'Fail';
      alert('Save fail');
    }
  } catch (e) {
    alert('Error: ' + (e.message||e));
  }
}
if (document.getElementById('qualityAdminList')) adminLoadQuality();

var ADMIN_SECTIONS = [
  { id: 'sec-order-stats', label: 'Orders Summary' },
  { id: 'sec-orders', label: 'Order List' },
  { id: 'sec-wallet-recharges', label: 'Wallet Recharges' },
  { id: 'sec-fees', label: 'Platform & Delivery Fees' },
  { id: 'sec-quality', label: 'Photo Quality' },
  { id: 'sec-frames', label: 'Frame Types' },
  { id: 'sec-banner', label: 'Home Banner' },
  { id: 'sec-hero', label: 'Hero Text + BG' },
  { id: 'sec-home-frame', label: 'Home 3D Frame' },
  { id: 'sec-book', label: 'Book Cards' },
  { id: 'sec-otp', label: 'OTP / PIN' },
  { id: 'sec-codes', label: 'Spin Codes' },
  { id: 'sec-customers', label: 'Customers' },
  { id: 'sec-notif', label: 'Notifications' },
  { id: 'sec-backup', label: 'Backup' }
];
var adminHiddenMap = {};

async function adminInitUi() {
  try {
    var res = await fetch('/api/settings', { credentials: 'same-origin' });
    var data = await res.json();
    adminHiddenMap = (data.settings && data.settings.adminUi && data.settings.adminUi.hidden) || {};
  } catch (e) { adminHiddenMap = adminHiddenMap || {}; }
  applyAdminHidden();
  renderAdminUiToggles();
  addSectionHideButtons();
}

function applyAdminHidden() {
  ADMIN_SECTIONS.forEach(function(s) {
    var el = document.getElementById(s.id);
    if (!el) return;
    if (adminHiddenMap[s.id]) el.classList.add('sec-hidden');
    else el.classList.remove('sec-hidden');
  });
}

function renderAdminUiToggles() {
  var box = document.getElementById('adminUiToggles');
  if (!box) return;
  box.innerHTML = ADMIN_SECTIONS.map(function(s) {
    var checked = !adminHiddenMap[s.id];
    return '<label><input type="checkbox" data-sec="'+s.id+'" '+(checked?'checked':'')+'/> '+s.label+'</label>';
  }).join('');
}

function addSectionHideButtons() {
  ADMIN_SECTIONS.forEach(function(s) {
    var el = document.getElementById(s.id);
    if (!el || el.querySelector('.sec-hide-btn')) return;
    var h2 = el.querySelector('h2');
    if (!h2) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sec-hide-btn';
    btn.textContent = 'Hide';
    btn.onclick = function() {
      adminHiddenMap[s.id] = true;
      applyAdminHidden();
      renderAdminUiToggles();
      adminSaveUi(true);
    };
    var wrap = document.createElement('div');
    wrap.className = 'sec-head';
    h2.parentNode.insertBefore(wrap, h2);
    wrap.appendChild(h2);
    wrap.appendChild(btn);
  });
}

async function adminSaveUi(silent) {
  var box = document.getElementById('adminUiToggles');
  if (box) {
    adminHiddenMap = {};
    box.querySelectorAll('input[data-sec]').forEach(function(inp) {
      if (!inp.checked) adminHiddenMap[inp.getAttribute('data-sec')] = true;
    });
  }
  applyAdminHidden();
  try {
    var res = await fetch('/admin/ui-save', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: adminHiddenMap })
    });
    var data = await res.json();
    var msg = document.getElementById('adminUiMsg');
    if (data.ok) {
      if (msg) msg.textContent = 'Saved ✅';
      if (!silent) alert('Section visibility saved ✅');
    } else {
      if (msg) msg.textContent = 'Save fail';
      if (!silent) alert('Save fail');
    }
  } catch (e) {
    if (!silent) alert('Error: ' + (e.message || e));
  }
}

function adminShowAllSections() {
  adminHiddenMap = {};
  var box = document.getElementById('adminUiToggles');
  if (box) box.querySelectorAll('input[data-sec]').forEach(function(inp){ inp.checked = true; });
  applyAdminHidden();
  adminSaveUi(true);
  alert('All sections visible');
}

adminInitUi();





loadAdminFrames();
setInterval(loadAdminFrames, 15000);

pollLive();
setInterval(pollLive, 5000);
</script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
    return res.end(html);
  }

  console.warn('404', req.method, urlPath);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found: ' + req.method + ' ' + urlPath);
});

async function hydrateFromMongo() {
  if (!useMongo) return;
  try {
    _cache.accounts = await mongoLoadAccounts();
    _cache.codes = await mongoLoadCodes();
    _cache.otps = await mongoLoadOtps();
    _cache.notifs = await mongoLoadNotifs();
    const st = await mongoLoadSettings();
    if (st) _cache.settings = st;
    try {
      const fr = await mongoDb.collection('meta').findOne({ _id: 'photoFrames' });
      if (fr && Array.isArray(fr.items)) {
        _cache.frames = fr.items.filter(f => f && !String(f.id || '').startsWith('demo-') && f.demo !== true);
      }
      const fo = await mongoDb.collection('meta').findOne({ _id: 'frameOrders' });
      if (fo && Array.isArray(fo.items)) _cache.frameOrders = fo.items;
    } catch (e2) {}
    // mirror to local files as secondary backup
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(_cache.accounts, null, 2));
      fs.writeFileSync(CODES_FILE, JSON.stringify(_cache.codes, null, 2));
      if (_cache.frames) fs.writeFileSync(FRAMES_FILE, JSON.stringify(_cache.frames, null, 2));
      if (_cache.frameOrders) fs.writeFileSync(FRAME_ORDERS_FILE, JSON.stringify(_cache.frameOrders, null, 2));
    } catch (e) {}
    console.log('[db] Hydrated from Atlas — accounts:', _cache.accounts.length, 'codes:', _cache.codes.length);
  } catch (e) {
    console.error('[db] hydrate error:', e.message);
  }
}

// Server PEHLE start — Mongo baad me background (hang nahi hoga)
server.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log(' Aditya Studio server READY');
  console.log(' Port:', PORT);
  console.log(' Open: http://localhost:' + PORT);
  console.log(' Admin: http://localhost:' + PORT + '/admin');
  console.log(' Data:', DATA_DIR);
  console.log('========================================');
});

(async () => {
  try {
    await initMongo();
    await hydrateFromMongo();
    await hydrateFreeSpinBag();
    console.log('DB mode:', useMongo ? 'MongoDB Atlas ✅' : 'JSON files');
  } catch (e) {
    console.error('[boot] DB init error (server already running):', e && e.message ? e.message : e);
  }
})();
