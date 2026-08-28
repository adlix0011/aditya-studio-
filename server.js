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
const PIN_SALT = process.env.PIN_SALT || 'aditya-studio-local-salt';
// Local default password — production pe env se set karo: ADMIN_PASSWORD
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ADlix08';

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
const INDEX_HTML_FILE = path.join(__dirname, 'index.html');
const BOOK_NOW_HTML_FILE = path.join(__dirname, 'aditya-studio-discount-wheel.html');
const FRAMES_HTML_FILE = path.join(__dirname, 'frames-home.html'); // 3D frames shop + order
const FRAME_DETAIL_HTML_FILE = path.join(__dirname, 'frame-detail.html');
const BOOK_SERVICE_HTML_FILE = path.join(__dirname, 'book-service-sample.html');
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
    ],
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
    heroSideBgDurationSec: 5
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
    heroIntro: { ...defaults.heroIntro, ...(data.heroIntro || {}) },
    frames3dPhotos: Array.isArray(data.frames3dPhotos) ? data.frames3dPhotos : defaults.frames3dPhotos,
    homeHeroFramePhotos: Array.isArray(data.homeHeroFramePhotos) ? data.homeHeroFramePhotos : defaults.homeHeroFramePhotos,
    heroSideBgPhotos: Array.isArray(data.heroSideBgPhotos) ? data.heroSideBgPhotos : defaults.heroSideBgPhotos,
    heroSideBgDurationSec: Math.max(2, Math.min(20, Number(data.heroSideBgDurationSec) || defaults.heroSideBgDurationSec))
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
  if (!Array.isArray(acc.walletHistory)) acc.walletHistory = [];
  return acc;
}
function walletHistoryId() {
  return 'WH-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}
/** Credit/debit wallet. amount > 0. Returns entry or null if debit fails. */
function walletTxn(acc, type, amount, meta) {
  ensureWallet(acc);
  amount = Math.round(Number(amount) || 0);
  if (amount <= 0) return null;
  if (type === 'debit' && acc.walletBalance < amount) return null;
  if (type === 'credit') acc.walletBalance += amount;
  else acc.walletBalance -= amount;
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
  return {
    ok: true,
    id: acc.id,
    name: acc.name,
    village: acc.village,
    mobile: acc.mobile,
    history: publicHistory(acc),
    mobileVerified: !!acc.mobileVerified,
    badge: acc.badge || null,
    totalSpend: acc.totalSpend || 0,
    freeSpinUsed: !!acc.freeSpinUsed,
    walletBalance: acc.walletBalance || 0,
    walletHistory: (acc.walletHistory || []).slice(0, 30),
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

  // New luxury homepage (Artisan Collection)
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    fs.readFile(INDEX_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('index.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Old home page — BOOK NOW
  if (req.method === 'GET' && (urlPath === '/book-now' || urlPath === '/book-now.html' || urlPath === '/aditya-studio-discount-wheel.html')) {
    fs.readFile(BOOK_NOW_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Book Now page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'GET' && (urlPath === '/photo-frames.html' || urlPath === '/photo-frames' || urlPath === '/frames')) {
    fs.readFile(FRAMES_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Photo Frames page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'GET' && (urlPath === '/frame-detail.html' || urlPath === '/frame-detail')) {
    fs.readFile(FRAME_DETAIL_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Frame detail page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Service booking form (?service=wedding|birthday|event|baby|studio|pvt|reel|other)
  if (req.method === 'GET' && (urlPath === '/book' || urlPath === '/book-service' || urlPath === '/book-service-sample.html')) {
    fs.readFile(BOOK_SERVICE_HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Book service page missing'); }
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

  /* ---- Photo Frames public APIs ---- */
  if (req.method === 'GET' && urlPath === '/api/frames') {
    const frames = loadFrames().map(f => ({
      id: f.id, size: f.size, title: f.title, price: f.price,
      discountPercent: f.discountPercent || 0, active: f.active !== false,
      imageUrl: f.imageUrl || '', imageData: f.imageData || '', createdAt: f.createdAt
    }));
    return sendJSON(res, 200, { ok: true, frames });
  }

  if (req.method === 'POST' && urlPath === '/api/frame-order') {
    try {
      const body = await readBody(req);
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
      if (pincode && !/^\d{6}$/.test(pincode)) {
        return sendJSON(res, 400, { ok: false, error: 'invalid', message: 'Pincode 6 digit hona chahiye' });
      }
      const frames = loadFrames();
      const frame = frames.find(f => f.id === frameId && f.active !== false);
      if (!frame) return sendJSON(res, 404, { ok: false, error: 'frame-not-found', message: 'Frame nahi mila' });
      const price = Number(frame.price) || 0;
      const disc = Number(frame.discountPercent) || 0;
      let finalAmount = Math.round(price * (1 - disc / 100));
      const orders = loadFrameOrders();
      const orderId = nextFrameOrderId(orders);
      const paymentClaimed = body.paymentClaimed === true || body.paymentClaimed === 'true';
      const useWallet = body.useWallet === true || body.useWallet === 'true';
      let walletPaid = 0;
      let paymentStatus = paymentClaimed ? 'paid_claimed' : 'unpaid';
      // Wallet pay (partial or full)
      if (useWallet) {
        const accounts = loadAccounts();
        const acc = accounts.find(a => String(a.mobile) === mobile);
        if (acc) {
          ensureWallet(acc);
          const want = Math.min(acc.walletBalance, finalAmount);
          if (want > 0) {
            const txn = walletTxn(acc, 'debit', want, {
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
      }
      const order = {
        orderId, frameId: frame.id, frameTitle: frame.title || '', size: frame.size,
        price, discountPercent: disc, finalAmount: finalAmount + walletPaid,
        amountDue: finalAmount,
        walletPaid,
        name, mobile, village, address, pincode, district, state, note,
        status: 'processing',
        paymentStatus,
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
      console.log('Frame order:', orderId, mobile, frame.size, 'total', order.finalAmount, 'wallet', walletPaid, 'due', finalAmount, paymentStatus);
      return sendJSON(res, 200, {
        ok: true, orderId,
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

  if (req.method === 'GET' && urlPath === '/api/my-frame-orders') {
    try {
      const q = (req.url || '').split('?')[1] || '';
      const params = new URLSearchParams(q);
      const mobile = String(params.get('mobile') || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile)) return sendJSON(res, 400, { ok: false, error: 'invalid-mobile' });
      const orders = loadFrameOrders().filter(o => String(o.mobile) === mobile);
      return sendJSON(res, 200, { ok: true, orders });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'server-error' });
    }
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
      const acc = {
        id, name: String(body.name || '').trim(), mobile, village: String(body.village || '').trim(),
        pin, createdAt: new Date().toISOString(), visitCount: 1, lastVisitAt: new Date().toISOString(),
        pinResetRequested: false, freeSpinUsed: false, mobileVerified: false, history: [], totalSpend: 0,
        adTokens: 0, spinBalance: 1, lastAdTokenClaim: '',
        walletBalance: 0, walletHistory: []
      };
      accounts.push(acc);
      saveAccounts(accounts);
      return sendJSON(res, 200, { ...accountPublicPayload(acc), freeSpinGift: true });
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
      return sendJSON(res, 200, accountPublicPayload(acc));
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
      return sendJSON(res, 200, accountPublicPayload(acc));
    } catch (e) {
      return sendJSON(res, 400, { ok: false });
    }
  }

  // Daily AD token — 1 per day; 10 AD tokens → 1 spin
  if (req.method === 'POST' && urlPath === '/api/claim-ad-token') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const pin = String(body.pin || '').trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc || String(acc.pin) !== pin) return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Login required' });
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
      const mobile = String(body.mobile || '').trim();
      const pin = String(body.pin || '').trim();
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc || String(acc.pin) !== pin) return sendJSON(res, 401, { ok: false, error: 'auth', message: 'Login required' });
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
  // Apply own active coupon → credit wallet
  if (req.method === 'POST' && urlPath === '/api/wallet/apply-coupon') {
    try {
      const body = await readBody(req);
      const mobile = String(body.mobile || '').trim();
      const pin = String(body.pin || '').trim();
      const couponId = String(body.couponId || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile) || !couponId) {
        return sendJSON(res, 400, { ok: false, error: 'invalid', message: 'Mobile aur couponId zaroori' });
      }
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'not-found', message: 'Account nahi mila' });
      if (pin && String(acc.pin) !== pin) {
        return sendJSON(res, 401, { ok: false, error: 'wrong-pin', message: 'PIN galat' });
      }
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
        couponId
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
        history: publicHistory(acc)
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
      const mobile = String(body.mobile || '').trim();
      const pin = String(body.pin || '').trim();
      const code = String(body.code || '').trim().toUpperCase();
      if (!/^[6-9]\d{9}$/.test(mobile) || !code) {
        return sendJSON(res, 400, { ok: false, error: 'invalid', message: 'Mobile aur code zaroori' });
      }
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'not-found' });
      if (pin && String(acc.pin) !== pin) return sendJSON(res, 401, { ok: false, error: 'wrong-pin' });
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
      row.usedBy = mobile;
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

  if (req.method === 'GET' && urlPath === '/api/wallet/history') {
    try {
      const u = new URL(req.url, 'http://x');
      const mobile = String(u.searchParams.get('mobile') || '').trim();
      if (!/^[6-9]\d{9}$/.test(mobile)) return sendJSON(res, 400, { ok: false, error: 'invalid' });
      const accounts = loadAccounts();
      const acc = accounts.find(a => String(a.mobile) === mobile);
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'not-found' });
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
      // Welcome free spin: OTP NOT required — register gift direct spin
      if (!acc.mobileVerified && body.mobileVerified) {
        acc.mobileVerified = true;
        saveAccounts(accounts);
      }
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
    return sendJSON(res, 200, { ok: true, frames: loadFrames(), orders: loadFrameOrders() });
  }

  if (req.method === 'POST' && urlPath === '/admin/frame-save') {
    try {
      // Base64 images need larger body (up to ~5MB)
      const body = await readBody(req, 6e6);
      const frames = loadFrames();
      const id = String(body.id || '').trim() || ('FR-' + Date.now().toString(36));
      const size = String(body.size || '').trim();
      const title = String(body.title || '').trim() || size + ' Frame';
      const price = Number(body.price) || 0;
      const discountPercent = Math.min(90, Math.max(0, Number(body.discountPercent != null ? body.discountPercent : body.discount) || 0));
      const active = body.active !== false && body.active !== 'false';
      const imageData = String(body.imageData || '').slice(0, 4e6); // ~4MB base64 cap
      const imageUrl = String(body.imageUrl || '').trim();
      if (!size) return sendJSON(res, 400, { ok: false, error: 'size-required', message: 'Size required' });
      const idx = frames.findIndex(f => f.id === id);
      const row = {
        id, size, title, price, discountPercent, active,
        imageData: imageData || (idx >= 0 ? frames[idx].imageData : '') || '',
        imageUrl: imageUrl || (idx >= 0 ? frames[idx].imageUrl : '') || '',
        createdAt: idx >= 0 ? frames[idx].createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      if (idx >= 0) frames[idx] = row; else frames.unshift(row);
      saveFrames(frames);
      console.log('[frame-save]', row.id, row.size, row.title, 'img', (row.imageData || '').length, 'bytes');
      return sendJSON(res, 200, { ok: true, frame: { id: row.id, size: row.size, title: row.title, price: row.price, discountPercent: row.discountPercent, active: row.active, hasImage: !!(row.imageData || row.imageUrl) } });
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
      // Admin payment confirm shortcut
      if (body.confirmPayment === true || body.confirmPayment === 'true') {
        ord.paymentStatus = 'confirmed';
        if (!ord.status || ord.status === 'processing' || ord.status === 'pending') {
          ord.status = 'confirmed';
        }
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
      return sendJSON(res, 200, { ok: true, order: ord });
    } catch (e) {
      console.error('frame-order-update', e);
      return sendJSON(res, 500, { ok: false });
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
        '<div><span class="lbl">PIN</span><div class="mono gold">' + esc(acc.pin) + '</div></div>' +
        '<div><span class="lbl">Village</span><div>' + esc(acc.village || '—') + '</div></div>' +
        '<div><span class="lbl">Total spend</span><div>₹' + esc(acc.totalSpend || 0) + '</div></div>' +
        '<div><span class="lbl">Wallet</span><div class="gold">₹' + esc(wBal) + '</div></div></div>' +
        adminBtns +
        walletBox +
        '<div class="lbl" style="margin-top:12px">Coupons</div>' +
        '<table><thead><tr><th>Coupon</th><th>From</th><th>Status</th><th>Time</th><th>Action</th></tr></thead><tbody>' + couponRows + '</tbody></table></div></details>';
    }).join('') || '<p class="muted">No customers yet</p>';

    const html = `<!DOCTYPE html><html lang="hi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
</style></head><body>
<div class="layout">
<aside class="sidebar">
  <div class="brand">Aditya Studio</div>
  <div class="brand-sub">Admin Dashboard</div>
  <a class="nav-link" href="#sec-overview">📊 Overview</a>
  <a class="nav-link" href="#sec-orders">📦 Frame Orders</a>
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

<section class="panel" id="sec-orders">
<h2>📦 Frame Orders</h2>
<p class="sub">Customer frame orders — status, payment confirm, delivery date/time.</p>
<div id="adminOrdersList" class="muted">Loading orders…</div>
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
<h2>🔔 Notifications</h2>
<form method="POST" action="/admin/send-notification" class="form-grid">
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
<button class="gen-btn" type="submit">📢 Send to all</button>
</form>
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
    r.onerror = reject;
    r.onload = function() {
      var img = new Image();
      img.onerror = reject;
      img.onload = function() {
        var w = img.width, h = img.height;
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
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

if (frFileEl) frFileEl.addEventListener('change', async function(e) {
  var f = e.target.files && e.target.files[0];
  if (!f) { return; }
  if (f.size > 8e6) { alert('Image 8MB se chhoti rakho'); e.target.value=''; return; }
  var st = document.getElementById('frPhotoStatus');
  if (st) st.textContent = 'Compressing…';
  try {
    if (typeof compressImageFile === 'function') {
      _frImageData = await compressImageFile(f, 1200, 0.82);
    } else {
      _frImageData = await new Promise(function(resolve, reject) {
        var r = new FileReader();
        r.onload = function() { resolve(r.result || ''); };
        r.onerror = reject;
        r.readAsDataURL(f);
      });
    }
    if (_frImageData && _frImageData.length > 3.5e6) {
      alert('Compress ke baad bhi image badi hai. Chhoti photo try karo.');
      _frImageData = '';
      e.target.value = '';
      setFrPhotoPreview('');
      return;
    }
    _frKeepExistingImage = false;
    setFrPhotoPreview(_frImageData);
  } catch (err) {
    alert('Image read fail');
    _frImageData = '';
    e.target.value = '';
    setFrPhotoPreview('');
  }
});

function adminCancelEditFrame() {
  var idEl = document.getElementById('frId'); if (idEl) idEl.value = '';
  var tEl = document.getElementById('frTitle'); if (tEl) tEl.value = '';
  var pEl = document.getElementById('frPrice'); if (pEl) pEl.value = '';
  var dEl = document.getElementById('frDisc'); if (dEl) dEl.value = '';
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
  var tEl = document.getElementById('frTitle'); if (tEl) tEl.value = f.title || '';
  var pEl = document.getElementById('frPrice'); if (pEl) pEl.value = f.price != null ? f.price : '';
  var dEl = document.getElementById('frDisc'); if (dEl) dEl.value = f.discountPercent != null ? f.discountPercent : '';
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
  if (!size) return alert('Size choose karo');
  if (!title) return alert('Frame Type name likho (jaise Golden border)');
  var fileInput = document.getElementById('frFile');
  if (fileInput && fileInput.files && fileInput.files[0] && !_frImageData) {
    return alert('Photo abhi process ho rahi hai — 1-2 sec wait karke Save dobara dabao');
  }
  var payload = {
    id: id || undefined,
    size: size,
    title: title,
    price: price,
    discountPercent: disc,
    imageData: _frImageData || '',
    active: true
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
  try {
    var res = await fetch('/admin/frames-json', { credentials: 'same-origin', cache: 'no-store' });
    var data = await res.json();
    if (!data.ok) {
      if (fBox) fBox.innerHTML = '<div class="muted">Frames load fail (API). Login / password check karo.</div>';
      return;
    }
    var frames = data.frames || [];
    var orders = data.orders || [];
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
          + '<br>👤 '+esc(o.name)+' · '+esc(o.mobile)+' · ₹'+(o.finalAmount||0)
          + '<br>📍 '+esc(o.address||'')
          + (o.village ? ' · गाँव: '+esc(o.village) : '')
          + (o.district ? ' · जिला: '+esc(o.district) : '')
          + (o.state ? ' · राज्य: '+esc(o.state) : '')
          + (o.pincode ? ' · PIN: '+esc(o.pincode) : '')
          + (o.note ? '<br>📝 '+esc(o.note) : '')
          + '<br>💳 Payment: <b>'+esc(o.paymentStatus||'unpaid')+'</b>'
          + '<br><span class="muted">'+esc(fmt(o.createdAt))+'</span></div>'
          + '<div style="display:grid;gap:6px;margin-top:8px;max-width:420px">'
          + '<label class="muted">Status <select class="inp" id="st-'+esc(o.orderId)+'" style="width:100%;max-width:200px">'
          + ['processing','pending','confirmed','ready','delivered','cancelled'].map(function(s){
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
          + '</div>'
          + '</div></div>';
      }).join('');
    }
  } catch (e) {
    if (fBox) fBox.innerHTML = '<div class="muted">Load fail: ' + (e && e.message ? e.message : 'network') + ' — page refresh karke try karo</div>';
  }
}
loadAdminFrames();
setInterval(loadAdminFrames, 15000);

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
