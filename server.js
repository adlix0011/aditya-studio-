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
        serverSelectionTimeoutMS: 25000,
        connectTimeoutMS: 25000,
        tls: true,
        family: 4,
        retryWrites: true
      }
    },
    {
      name: 'ipv4-default',
      opts: {
        serverSelectionTimeoutMS: 25000,
        connectTimeoutMS: 25000,
        family: 4
      }
    },
    {
      name: 'default',
      opts: {
        serverSelectionTimeoutMS: 25000,
        connectTimeoutMS: 25000
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
  settings: null
};

function normalizeAccount(a) {
  return {
    ...a,
    mobile: String(a.mobile || ''),
    pin: String(a.pin || '')
  };
}

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
  return String(Math.floor(1000 + Math.random() * 9000));
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
    offerImages: data.offerImages || defaults.offerImages
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

function nextCustomerId(accounts) {
  return 'AS-' + String(accounts.length + 1).padStart(4, '0');
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
      acceptedAt: h.acceptedAt || null
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



  if (req.method === 'POST' && urlPath === '/api/assign-work-spin') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const amount = Number(body.amount) || 0;
      if (!/^[6-9]\d{9}$/.test(mobile)) return sendJSON(res, 400, { ok: false, error: 'invalid-mobile' });
      if (amount < 50) return sendJSON(res, 400, { ok: false, error: 'invalid-amount' });
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'no-account' });
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
      let acc = accounts.find(a => String(a.mobile) === mobile);
      // Soft create if session exists on client but not on server (after wipe/migrate)
      if (!acc && body.name) {
        acc = {
          id: body.id || nextCustomerId(accounts),
          name: String(body.name || '').trim(),
          mobile,
          village: String(body.village || '').trim(),
          pin: String(body.pin || '0000'),
          createdAt: new Date().toISOString(),
          history: [],
          mobileVerified: !!body.mobileVerified,
          freeSpinUsed: false,
          totalSpend: 0
        };
        accounts.push(acc);
        saveAccounts(accounts);
        console.log('assign-free-spin soft account', acc.id, mobile);
      }
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'no-account', message: 'Account server pe nahi — dubara login/register karein' });
      if (acc.freeSpinUsed) return sendJSON(res, 409, { ok: false, error: 'already-used', message: 'Free spin pehle use ho chuki hai' });
      // Sync verify flag from client if already verified in session
      if (!acc.mobileVerified && body.mobileVerified) {
        acc.mobileVerified = true;
        saveAccounts(accounts);
      }
      if (!acc.mobileVerified) return sendJSON(res, 403, { ok: false, error: 'not-verified', message: 'Pehle mobile OTP verify karein' });
      const { prize, stats } = assignNextFreePrize();
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
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc) return sendJSON(res, 404, { ok: false });
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
          couponStatus: 'active'
        });
        saveAccounts(accounts);
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
      // expiresIn: hours (0 = never)
      let hours = parseInt(String(body.expiresIn || '24'), 10);
      if (isNaN(hours) || hours < 0) hours = 24;
      const id = 'N-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      const item = {
        id,
        title,
        body: bodyText,
        at: new Date().toISOString(),
        expiresAt: hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null
      };
      const list = loadNotifs();
      list.unshift(item);
      saveNotifs(list);
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


  if (req.method === 'GET' && urlPath === '/admin/live-json') {
    const accounts = loadAccounts();
    const pendingResets = accounts.filter(a => a.pinResetRequested).map(a => ({
      id: a.id, name: a.name, mobile: a.mobile,
      at: a.pinResetRequestedAt || null
    }));
    const pendingOtps = loadOtpRequests().filter(r => !r.verified).map(r => ({
      mobile: r.mobile, name: r.name || '', id: r.id || '', otp: r.otp,
      at: r.createdAt || null
    }));
    const codes = loadCodes();
    const notifs = loadNotifs().slice(0, 10);
    return sendJSON(res, 200, {
      ok: true,
      at: new Date().toISOString(),
      counts: {
        customers: accounts.length,
        pendingOtp: pendingOtps.length,
        pendingPin: pendingResets.length,
        unusedCodes: codes.filter(c => !c.used).length,
        notifs: notifs.length
      },
      pendingOtps,
      pendingResets,
      notifications: notifs
    });
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

        const codeRows = codes.filter(c => !c.couponAccepted).map(c =>
      '<tr><td class="mono">' + esc(c.code) + '</td>'
      + '<td>₹' + esc(c.amount != null ? c.amount : '—') + '</td>'
      + '<td>' + (c.used ? '<span class="bad">Used</span>' : '<span class="ok">Unused</span>') + '</td>'
      + '<td>' + esc(c.usedBy || '—') + '</td>'
      + '<td>' + esc(c.prize || (c.discount != null ? c.discount + '%' : (c.used ? 'Spin pending/unknown' : '—'))) + '</td>'
      + '<td>' + esc(fmtDate(c.createdAt)) + '</td>'
      + '<td>' + esc(c.usedAt ? fmtDate(c.usedAt) : '—') + '</td>'
      + '<td><form method="POST" action="/admin/delete-spin-code" style="display:inline" onsubmit="return confirm(\'Delete code '+esc(c.code)+'?\')"><input type="hidden" name="code" value="'+esc(c.code)+'"><button type="submit" style="padding:3px 8px;font-size:11px;background:#5a1a1a;color:#fca5a5;border:1px solid #7f1d1d;border-radius:6px;cursor:pointer">🗑</button></form></td></tr>'
    ).join('') || '<tr><td colspan="8">No codes yet (accepted coupons auto-hidden)</td></tr>';

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
      return '<div class="msg-card" style="margin-top:8px"><div class="msg-text"><b>' + esc(n.title || '') + '</b><br>' + esc(n.body || '') +
        '<br><span class="muted">Sent: ' + esc(fmtDate(n.at)) + ' · Exp: ' + esc(exp) + '</span></div>' +
        '<div class="msg-actions"><form method="POST" action="/admin/delete-notification"><input type="hidden" name="id" value="' + nid + '">' +
        '<button type="submit" style="padding:6px 10px;background:#5a1a1a;color:#fca5a5;border:1px solid #7f1d1d;border-radius:6px;cursor:pointer">🗑 Delete</button></form></div></div>';
    }).join('') || '<div class="muted">No active notifications</div>';

        const rows = accounts.map(acc => {
      const hist = (acc.history || []).slice().reverse();
      const couponRows = hist.filter(h => h.prize || h.discount != null).map(h => {
        const cid = esc(h.couponId || h.entryId || '');
        const st = h.couponStatus || 'active';
        if (st === 'deleted') return '';
        const statusBadge = st === 'accepted'
          ? '<span class="ok">Accepted / Used</span>'
          : '<span class="tag">Active</span>';
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
      return '<details class="acc" data-filter="' + filters + '" data-id="' + esc(acc.id) + '"><summary><span class="c-id">' + esc(acc.id) + '</span> <b>' + esc(acc.name) + '</b> <span class="muted">' + esc(acc.mobile) + '</span> ' +
        (acc.mobileVerified ? '<span class="ok">✓ Verified</span>' : '<span class="bad">✗ Unverified</span>') +
        ' <span class="tag">' + esc(acc.badge || tierName(acc.totalSpend || 0)) + '</span></summary><div class="acc-body"><div class="grid">' +
        '<div><span class="lbl">PIN</span><div class="mono gold">' + esc(acc.pin) + '</div></div>' +
        '<div><span class="lbl">Village</span><div>' + esc(acc.village || '—') + '</div></div>' +
        '<div><span class="lbl">Total spend</span><div>₹' + esc(acc.totalSpend || 0) + '</div></div>' +
        '<div><span class="lbl">Last prize</span><div>' + esc(lastPrize(acc)) + '</div></div></div>' +
        adminBtns +
        '<div class="lbl" style="margin-top:12px">Coupons</div>' +
        '<table><thead><tr><th>Coupon</th><th>From</th><th>Status</th><th>Time</th><th>Action</th></tr></thead><tbody>' + couponRows + '</tbody></table></div></details>';
    }).join('') || '<p class="muted">No customers yet</p>';

    const html = `<!DOCTYPE html><html lang="hi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aditya Studio Admin</title>
<style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0F0C09;color:#F4EAD6;padding:20px;margin:0}
h1{color:#D4AF37;font-size:1.4rem}h2{color:#D4AF37;font-size:1.05rem;margin:28px 0 12px}
.sub{color:#B7A480;font-size:13px;margin-bottom:16px}.sub a{color:#D4AF37}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:16px 0}
.card-click{cursor:pointer;transition:transform .15s,box-shadow .15s}.card-click:hover{transform:translateY(-2px);box-shadow:0 0 14px rgba(212,175,55,0.35);border-color:rgba(212,175,55,0.6)}.card-click.active-filter{outline:2px solid #D4AF37}.card{background:#1B140F;border:1px solid rgba(212,175,55,0.2);border-radius:12px;padding:14px}
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
<div class="card card-click" onclick="filterPanel('all')" title="Saare customers"><div class="n" id="cntCust">${accounts.length}</div><div class="l">Customers</div></div>
<div class="card card-click" onclick="filterPanel('today')" title="Aaj naye"><div class="n" id="cntToday">${newToday}</div><div class="l">Aaj naye</div></div>
<div class="card card-click" onclick="filterPanel('otp')" title="Pending OTP"><div class="n" id="cntOtp">${pendingOtps.length}</div><div class="l">Pending OTP</div></div>
<div class="card card-click" onclick="filterPanel('pin')" title="PIN Reset"><div class="n" id="cntPin">${pendingResets.length}</div><div class="l">PIN Reset</div></div>
<div class="card card-click" onclick="filterPanel('verified')" title="Verified"><div class="n" id="cntVer">${verifiedCount}</div><div class="l">Verified</div></div>
<div class="card card-click" onclick="filterPanel('freespin')" title="Free spin used"><div class="n" id="cntFree">${freeUsed}</div><div class="l">Free spin used</div></div>
<div class="card card-click" onclick="filterPanel('codes')" title="Unused codes"><div class="n" id="cntCodes">${codes.filter(c=>!c.used).length}</div><div class="l">Unused codes</div></div>
</div>
<div id="filterBar" style="display:none;margin:8px 0 16px;padding:10px 14px;background:#1B140F;border:1px solid rgba(212,175,55,0.35);border-radius:10px;align-items:center;gap:10px;flex-wrap:wrap">
<span style="color:#D4AF37;font-weight:700" id="filterLabel">Filter:</span>
<button type="button" class="gen-btn" style="padding:6px 12px;font-size:12px" onclick="filterPanel('all')">Show all</button>
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
<label class="muted">Expire after
<select name="expiresIn" class="inp" style="width:100%;max-width:240px">
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
<button class="gen-btn" type="submit">📢 Send to all</button>
</form>
<div class="lbl" style="margin-top:14px">Active notifications (live)</div>
<div id="adminNotifList">${notifAdminCards}</div>
</div>

<h2 id="h2Otp">📱 Spin OTP (${pendingOtps.length})</h2>
<div id="otpLiveBox">${otpCards}</div>

<h2 id="h2Pin">⚠️ PIN Reset (${pendingResets.length})</h2>
<div id="pinLiveBox">${resetCards}</div>

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
<table id="codesTable"><thead><tr><th>Code</th><th>Amount</th><th>Status</th><th>Used By</th><th>Coupon/Prize</th><th>Created</th><th>Used At</th><th>Action</th></tr></thead>
<tbody>${codeRows}</tbody></table>
</div>

<h2>👥 Customers (${accounts.length})</h2>
<input id="search" type="search" placeholder="Search..." oninput="filterAcc(this.value)">
<div id="accList">${rows}</div>
<div id="liveBar" style="position:fixed;bottom:12px;right:12px;background:#1B140F;border:1px solid rgba(212,175,55,0.4);border-radius:10px;padding:8px 12px;font-size:12px;color:#B7A480;z-index:99;">
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
var audioCtx = null;
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

function renderOtps(list) {
  var box = document.getElementById('otpLiveBox');
  if (!box) return;
  if (!list.length) { box.innerHTML = '<div class="muted">No pending OTP</div>'; return; }
  box.innerHTML = list.map(function(r) {
    var msg = encodeURIComponent('Namaste ' + (r.name || '') + '!\\nAditya Studio Spin OTP: *' + r.otp + '*\\n— Aditya Studio');
    return '<div class="msg-card" style="border-color:rgba(255,80,80,0.4);box-shadow:0 0 12px rgba(255,80,80,0.15)">'
      + '<div class="msg-text">🎡 <b>' + esc(r.name || '') + '</b> (' + esc(r.mobile) + ')<br>OTP: <span class="otp-big">' + esc(r.otp) + '</span><br><span class="muted">' + esc(fmt(r.at)) + '</span></div>'
      + '<div class="msg-actions"><a class="gen-btn wa-link" href="https://wa.me/91' + esc(r.mobile) + '?text=' + msg + '" target="_blank">💬 WhatsApp OTP</a></div></div>';
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
    return '<div class="msg-card" style="margin-top:8px"><div class="msg-text"><b>' + esc(n.title||'') + '</b><br>' + esc(n.body||'') +
      '<br><span class="muted">Sent: ' + esc(fmt(n.at)) + ' · Exp: ' + esc(exp) + '</span></div>' +
      '<div class="msg-actions"><form method="POST" action="/admin/delete-notification"><input type="hidden" name="id" value="' + nid + '">' +
      '<button type="submit" style="padding:6px 10px;background:#5a1a1a;color:#fca5a5;border:1px solid #7f1d1d;border-radius:6px;cursor:pointer">🗑 Delete</button></form></div></div>';
  }).join('');
}
function setCount(id, n) {
  var el = document.getElementById(id);
  if (el) el.textContent = n;
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
    var sig = JSON.stringify({ o: data.pendingOtps, p: data.pendingResets, n: data.notifications });
    if (lastSig && sig !== lastSig) {
      var prev = {};
      try { prev = JSON.parse(lastSig); } catch(e) {}
      var newOtp = (data.pendingOtps || []).length > ((prev.o || []).length || 0);
      var newPin = (data.pendingResets || []).length > ((prev.p || []).length || 0);
      var newNotif = false;
      var prevN0 = (prev.n && prev.n[0]) ? (prev.n[0].at + '|' + prev.n[0].title) : '';
      var curN0 = (data.notifications && data.notifications[0]) ? (data.notifications[0].at + '|' + data.notifications[0].title) : '';
      if (curN0 && curN0 !== prevN0) newNotif = true;
      // also detect brand-new mobile
      var prevOtpKeys = (prev.o || []).map(function(x){ return x.mobile + ':' + x.otp; }).join('|');
      (data.pendingOtps || []).forEach(function(r) {
        if (prevOtpKeys && prevOtpKeys.indexOf(r.mobile + ':' + r.otp) < 0) newOtp = true;
      });
      if (newOtp || newPin || newNotif) {
        playAlert();
        if (st) st.innerHTML = '<span style="color:#3ee06b">🔔 NEW ' + (newOtp ? 'OTP' : newPin ? 'PIN' : 'Notification') + '!</span>';
        try {
          if (document.hidden && Notification && Notification.permission === 'granted') {
            new Notification('Aditya Studio Admin', { body: newOtp ? 'Naya OTP request' : 'Naya PIN reset request' });
          }
        } catch(e) {}
      } else if (st) {
        st.textContent = 'ok · ' + new Date().toLocaleTimeString('en-IN');
      }
    } else if (st) {
      st.textContent = 'ok · ' + new Date().toLocaleTimeString('en-IN');
    }
    lastSig = sig;
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

pollLive();
setInterval(pollLive, 5000);
</script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
    // mirror to local files as secondary backup
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(_cache.accounts, null, 2));
      fs.writeFileSync(CODES_FILE, JSON.stringify(_cache.codes, null, 2));
    } catch (e) {}
    console.log('[db] Hydrated from Atlas — accounts:', _cache.accounts.length, 'codes:', _cache.codes.length);
  } catch (e) {
    console.error('[db] hydrate error:', e.message);
  }
}

(async () => {
  await initMongo();
  await hydrateFromMongo();
  await hydrateFreeSpinBag();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Aditya Studio server port:', PORT);
    console.log('Data folder:', DATA_DIR);
    console.log('DB mode:', useMongo ? 'MongoDB Atlas ✅' : 'JSON files (Render pe wipe ho sakta hai)');
    console.log('Admin:', ADMIN_PASSWORD ? 'password protected' : 'LOCKED — set ADMIN_PASSWORD');
  });
})();
