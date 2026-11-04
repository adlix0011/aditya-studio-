const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('Live Event admin rendering, save and password access', { timeout: 120000 }, async t => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditya-live-events-test-'));
  const settingsFile = path.join(dataDir, 'settings.json');
  const secret = 'JBSWY3DPEHPK3PXP';
  const password = 'isolated-test-password';
  const token = crypto.createHmac('sha256', password).update('aditya-admin-totp:' + secret).digest('hex');
  fs.writeFileSync(settingsFile, JSON.stringify({ adminTotpSecret: secret }));
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const headers = { Authorization: 'Basic ' + Buffer.from('admin:' + password).toString('base64'), Cookie: 'aditya_admin_totp=' + token };
  let child;
  let browser;
  let logs = '';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD: password,
        MONGODB_URI: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_ENDPOINT: '',
        SMS_GATEWAY_URL: '', SMS_GATEWAY_API_KEY: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '',
        WHATSAPP_ACCESS_TOKEN: '', FIREBASE_SERVICE_ACCOUNT_FILE: path.join(dataDir, 'unused-firebase.json') }
    });
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(origin + '/api/home-gallery-samples')).ok) return; } catch (_) {}
      if (child.exitCode !== null) throw new Error('Test server stopped: ' + logs);
      await sleep(100);
    }
    throw new Error('Test server startup timeout: ' + logs);
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const ended = once(child, 'exit'); child.kill(); await ended;
  }
  async function post(route, body, authed = true) {
    const response = await fetch(origin + route, { method: 'POST', headers: {
      ...(authed ? headers : {}), 'Content-Type': 'application/json'
    }, body: JSON.stringify(body), redirect: 'manual' });
    return { status: response.status, text: await response.text() };
  }

  try {
    await start();
    await t.test('actual generated admin scripts parse, not only the server template', async () => {
      const response = await fetch(origin + '/admin', { headers, redirect: 'manual' });
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /src="\/admin-live-events\.js\?v=3"/);
      let i = 0;
      for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        new vm.Script(match[1], { filename: 'rendered-admin-script-' + (++i) + '.js' });
      }
      const script = await fetch(origin + '/admin-live-events.js?v=3');
      assert.equal(script.status, 200);
      assert.match(script.headers.get('content-type'), /javascript/);
      new vm.Script(await script.text());
    });

    await t.test('admin auth and validation reject unsaved submissions', async () => {
      assert.equal((await post('/admin/live-events-add', {}, false)).status, 401);
      assert.equal((await post('/admin/live-events-add', {})).status, 400);
      assert.equal((await post('/admin/live-events-delete', { id: 'legacy' }, false)).status, 401);
      assert.equal((await post('/admin/live-events-delete', {})).status, 400);
      assert.equal((await post('/admin/live-events-delete', { id: 'does-not-exist' })).status, 404);
      assert.equal((await post('/api/live-event-open', { id: 'does-not-exist', password: '0011' }, false)).status, 404);
    });

    await t.test('Chrome click uploads thumbnail, persists link, shows errors and opens the right event', {
      skip: process.env.LIVE_EVENT_BROWSER !== '1'
    }, async () => {
      const { chromium } = require('playwright');
      browser = await chromium.launch({ headless: true,
        ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
      const context = await browser.newContext({ httpCredentials: { username: 'admin', password }, viewport: { width: 1280, height: 900 } });
      await context.addCookies([{ name: 'aditya_admin_totp', value: token, url: origin }]);
      // Do not contact third-party services while exercising isolated test data.
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '' }));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/admin#site');
      const status = page.locator('#liveEventAddSt');
      await page.waitForFunction(() => document.getElementById('liveEventAddSt').textContent === 'Ready to add');
      await page.locator('#liveEventAddBtn').click();
      assert.match(await status.textContent(), /FAILED:.*Drive/);
      assert.equal(await page.locator('#liveEventAddDebug').isVisible(), true);
      const image = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 100;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#22d3ee'; ctx.fillRect(0, 0, 180, 100);
        ctx.fillStyle = '#111827'; ctx.font = '18px sans-serif'; ctx.fillText('Event test', 20, 55);
        return canvas.toDataURL('image/png').split(',')[1];
      });
      const upload = { name: 'test-event.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') };
      const driveUrl = 'https://drive.google.com/drive/folders/isolated-event-test?usp=sharing';
      await page.locator('#liveEventNewTitle').fill('Browser test event');
      await page.locator('#liveEventNewDriveUrl').fill(driveUrl);
      await page.locator('#liveEventNewPassword').fill('0011');
      await page.locator('#liveEventNewFile').setInputFiles(upload);
      let saveRequests = 0;
      page.on('request', req => { if (req.url().endsWith('/admin/live-events-add')) saveRequests++; });
      await page.locator('#liveEventAddBtn').dblclick();
      await page.waitForFunction(() => document.getElementById('liveEventAddSt').textContent.startsWith('Saved successfully'));
      assert.equal(saveRequests, 1, 'One interaction must not create duplicate events');
      assert.equal(await page.locator('#liveEventAddedPreviews img').count(), 1);
      if (process.env.LIVE_EVENT_SCREENSHOT) {
        await page.locator('#liveEventAddBtn').locator('xpath=../..').screenshot({ path: process.env.LIVE_EVENT_SCREENSHOT });
      }
      const stored = JSON.parse(fs.readFileSync(settingsFile));
      assert.equal(stored.liveEvents.length, 1);
      const event = stored.liveEvents[0];
      assert.equal(event.driveUrl, driveUrl);
      assert.match(event.thumbnail, /^data:image\/jpeg;base64,/);
      assert.equal(event.passwordHash, crypto.createHash('sha256').update('0011').digest('hex'));
      const publicState = await (await fetch(origin + '/api/home-gallery-samples')).json();
      assert.equal(publicState.liveEvents.length, 1);
      assert.equal(publicState.liveEvents[0].thumbnail, event.thumbnail);
      assert.equal(publicState.liveEvents[0].driveUrl, undefined);
      assert.equal(publicState.liveEvents[0].passwordHash, undefined);
      assert.equal((await post('/api/live-event-open', { id: event.id, password: 'wrong' }, false)).status, 401);
      const opened = await post('/api/live-event-open', { id: event.id, password: '0011' }, false);
      assert.equal(opened.status, 200); assert.equal(JSON.parse(opened.text).url, driveUrl);

      // A server failure must remain visible and keep the chosen inputs for retry.
      await page.locator('#liveEventNewFile').setInputFiles(upload);
      await page.locator('#liveEventNewPassword').fill('0011');
      await page.route('**/admin/live-events-add', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, message: 'Test storage failure' }) }));
      await page.locator('#liveEventAddBtn').click();
      await page.waitForFunction(() => document.getElementById('liveEventAddSt').textContent.includes('HTTP 500'));
      assert.match(await page.locator('#liveEventAddDebug').textContent(), /Test storage failure/);
      assert.equal(await page.locator('#liveEventAddBtn').isEnabled(), true);
      await page.unroute('**/admin/live-events-add');

      // Saving the original event's link without re-uploading its default photo works too.
      await page.locator('#liveEventDriveUrl').fill('https://drive.google.com/drive/folders/updated-legacy');
      await page.locator('#liveEventSaveBtn').click();
      await page.waitForFunction(() => document.getElementById('liveEventSt').textContent.startsWith('Saved successfully'));
      assert.equal(JSON.parse(fs.readFileSync(settingsFile)).liveEvent.driveUrl, 'https://drive.google.com/drive/folders/updated-legacy');
      await page.reload();
      assert.match(await page.locator('#sec-gallery-samples').textContent(), /Browser test event/);
      assert.deepEqual(errors, [], 'Admin should not have JavaScript parse/runtime errors');

      await page.goto(origin + '/');
      const card = page.getByRole('link', { name: 'Open Browser test event', exact: true });
      await card.scrollIntoViewIfNeeded();
      assert.equal(await card.locator('img').getAttribute('src'), event.thumbnail);
      page.once('dialog', dialog => dialog.accept('0011'));
      await card.click();
      await page.waitForURL(driveUrl);
      await browser.close(); browser = null;
      await stop(); await start();
      const restarted = await (await fetch(origin + '/api/home-gallery-samples')).json();
      assert.equal(restarted.liveEvents[0].id, event.id, 'Event must survive a server restart');
      t.diagnostic('Chrome verified real button click, thumbnail, link, password, error state, refresh, and restart.');
    });

    await t.test('Chrome deletes only the chosen event, supports cancel and errors, and persists after restart', {
      skip: process.env.LIVE_EVENT_BROWSER !== '1'
    }, async () => {
      const { chromium } = require('playwright');
      browser = await chromium.launch({ headless: true,
        ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
      const context = await browser.newContext({ httpCredentials: { username: 'admin', password }, viewport: { width: 1280, height: 900 } });
      await context.addCookies([{ name: 'aditya_admin_totp', value: token, url: origin }]);
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '' }));
      const page = await context.newPage();
      await page.goto(origin + '/admin#site');
      const first = JSON.parse(fs.readFileSync(settingsFile)).liveEvents[0];
      const firstRow = page.locator('[data-live-event-id="' + first.id + '"]');
      assert.equal(await firstRow.locator('img').getAttribute('src'), first.thumbnail);

      // Create another event with the same title through the UI; deletion must use its ID.
      await page.locator('#liveEventNewTitle').fill(first.title);
      await page.locator('#liveEventNewDriveUrl').fill(first.driveUrl);
      await page.locator('#liveEventNewPassword').fill('0011');
      await page.locator('#liveEventNewFile').setInputFiles({ name: 'second.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(first.thumbnail.split(',')[1], 'base64') });
      await page.locator('#liveEventAddBtn').click();
      await page.waitForFunction(() => document.getElementById('liveEventAddSt').textContent.startsWith('Saved successfully'));
      const second = JSON.parse(fs.readFileSync(settingsFile)).liveEvents[1];
      const secondRow = page.locator('[data-live-event-id="' + second.id + '"]');
      assert.equal(await secondRow.getByRole('button', { name: 'Delete ' + first.title, exact: true }).count(), 1);
      if (process.env.LIVE_EVENT_SCREENSHOT) {
        await page.locator('#liveEventAddedPreviews').screenshot({ path: process.env.LIVE_EVENT_SCREENSHOT });
      }
      let deleteRequests = 0;
      page.on('request', req => { if (req.url().endsWith('/admin/live-events-delete')) deleteRequests++; });
      page.once('dialog', dialog => dialog.dismiss());
      await secondRow.locator('button').click();
      assert.equal(deleteRequests, 0);
      assert.equal(await secondRow.count(), 1);

      await page.route('**/admin/live-events-delete', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, message: 'Test delete failure' }) }));
      page.once('dialog', dialog => dialog.accept());
      await secondRow.locator('button').click();
      await page.waitForFunction(id => document.querySelector('[data-live-event-id="' + id + '"] .live-event-delete-status').textContent.includes('HTTP 500'), second.id);
      assert.match(await secondRow.textContent(), /Test delete failure/);
      assert.equal(await secondRow.locator('button').isEnabled(), true);
      assert.equal(JSON.parse(fs.readFileSync(settingsFile)).liveEvents.length, 2);
      await page.unroute('**/admin/live-events-delete');

      page.once('dialog', dialog => dialog.accept());
      await secondRow.locator('button').click();
      await secondRow.waitFor({ state: 'detached' });
      assert.equal(await firstRow.count(), 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile)).liveEvents.map(event => event.id), [first.id]);
      assert.equal((await post('/api/live-event-open', { id: second.id, password: '0011' }, false)).status, 404);

      // Also exercise server-rendered delete buttons after refresh, including the original event.
      await page.reload();
      page.once('dialog', dialog => dialog.accept());
      await firstRow.locator('button').click();
      await firstRow.waitFor({ state: 'detached' });
      const legacy = page.locator('[data-live-event-id="legacy"]');
      page.once('dialog', dialog => dialog.accept());
      await legacy.locator('button').click();
      await legacy.waitFor({ state: 'detached' });
      assert.equal(await page.locator('#liveEventDriveUrl').inputValue(), '');
      await page.reload();
      assert.equal(await page.locator('[data-live-event-delete]').count(), 0);
      await page.goto(origin + '/');
      assert.equal(await page.getByRole('link', { name: 'Open ' + first.title, exact: true }).count(), 0);
      await browser.close(); browser = null;
      await stop(); await start();
      const restarted = await (await fetch(origin + '/api/home-gallery-samples')).json();
      assert.deepEqual(restarted.liveEvents, []);
      assert.equal(restarted.liveEvent.thumbnail, '', 'Deleted original photo must not fall back to the default');
      assert.equal((await post('/api/live-event-open', { password: '0011' }, false)).status, 404);
      const readd = { thumbnail: '/assets/live-event-default.png', driveUrl: first.driveUrl };
      assert.equal((await post('/admin/live-event-save', readd)).status, 400, 'Re-adding a deleted event needs a new password');
      assert.equal((await post('/admin/live-event-save', { ...readd, password: '0022' })).status, 200);
      assert.equal((await post('/api/live-event-open', { password: '0022' }, false)).status, 200);
      t.diagnostic('Chrome verified Delete beside thumbnails, cancellation, visible errors, duplicate titles, Home removal, refresh and restart.');
    });

    await t.test('storage failures return an error and do not publish an unsaved event', async () => {
      const original = fs.readFileSync(settingsFile);
      const before = await (await fetch(origin + '/api/home-gallery-samples')).json();
      const body = { title: 'Storage failure test', thumbnail: 'https://example.com/test.png',
        driveUrl: 'https://drive.google.com/drive/folders/storage-test', password: '0011' };
      fs.renameSync(settingsFile, settingsFile + '.test-backup');
      fs.mkdirSync(settingsFile);
      try {
        const failed = await post('/admin/live-events-add', body);
        assert.equal(failed.status, 500);
        assert.equal(JSON.parse(failed.text).ok, false);
        const after = await (await fetch(origin + '/api/home-gallery-samples')).json();
        assert.deepEqual(after.liveEvents, before.liveEvents);
        assert.equal((await post('/admin/live-events-delete', { id: 'legacy' })).status, 500);
        const afterDelete = await (await fetch(origin + '/api/home-gallery-samples')).json();
        assert.deepEqual(afterDelete.liveEvent, before.liveEvent, 'Failed deletion must preserve the original event');
      } finally {
        fs.rmdirSync(settingsFile);
        fs.renameSync(settingsFile + '.test-backup', settingsFile);
      }
      assert.deepEqual(fs.readFileSync(settingsFile), original);
      assert.equal((await post('/admin/live-events-add', body)).status, 200);
      assert.equal(JSON.parse(fs.readFileSync(settingsFile)).liveEvents.at(-1).driveUrl, body.driveUrl);
    });
  } finally {
    if (browser) await browser.close();
    await stop();
    // Only this test-created temporary directory is removed.
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
