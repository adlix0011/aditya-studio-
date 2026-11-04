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

test('Multiple weddings, per-album passwords and admin UI', { timeout: 120000 }, async t => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditya-live-events-test-'));
  const settingsFile = path.join(dataDir, 'settings.json');
  const secret = 'JBSWY3DPEHPK3PXP';
  const password = 'isolated-test-password';
  const token = crypto.createHmac('sha256', password).update('aditya-admin-totp:' + secret).digest('hex');
  fs.writeFileSync(settingsFile, JSON.stringify({ adminTotpSecret: secret, liveWedding:{title:'Original Wedding',thumbnail:'/assets/live-event-default.png',driveUrl:'https://drive.google.com/drive/folders/original',albums:{haldi:'/assets/live-event-default.png'}} }));
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
    const url=key=>'https://drive.google.com/drive/folders/'+key;
    let weddingId;
    await t.test('legacy wedding is preserved and admin endpoints require authentication',async()=>{
      assert.equal((await post('/admin/live-wedding-save',{},false)).status,401);
      assert.equal((await post('/admin/live-wedding-delete',{id:'legacy'},false)).status,401);
      assert.equal((await fetch(origin+'/admin/live-weddings',{redirect:'manual'})).status,401);
      const publicData=await (await fetch(origin+'/api/live-weddings')).json();
      assert.equal(publicData.weddings[0].title,'Original Wedding');
      assert.equal(publicData.weddings[0].albums.haldi.thumbnail,'/assets/live-event-default.png');
      assert.equal((await post('/api/wedding-open',{id:'legacy',album:'haldi'},false)).status,200);
      assert.equal(JSON.parse((await post('/api/wedding-open',{id:'legacy',album:'haldi'},false)).text).url,url('original'));
      const adminHtml=await (await fetch(origin+'/admin',{headers})).text();
      for(const match of adminHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
      assert.match(adminHtml,/admin-live-weddings\.js/);
    });
    await t.test('independent main and ceremony passwords, toggle persistence, and sanitized public data',async()=>{
      const body={id:'new',title:'Aman & Reena',thumbnail:'/assets/live-event-default.png',driveUrl:url('main'),passwordEnabled:true,password:'main1234',albums:{
        chulmati:{driveUrl:url('chulmati'),passwordEnabled:true,password:'1111'},
        haldi:{driveUrl:url('haldi'),passwordEnabled:true,password:'2222'},
        devpoojan:{driveUrl:url('devpoojan'),passwordEnabled:false},
        barat:{driveUrl:url('barat'),passwordEnabled:true,password:'3333'},
        reception:{driveUrl:url('reception'),passwordEnabled:true,password:'4444'}
      }};
      assert.equal((await post('/admin/live-wedding-save',{...body,password:''})).status,400);
      const added=await post('/admin/live-wedding-save',body);assert.equal(added.status,200);weddingId=JSON.parse(added.text).wedding.id;
      let persisted=JSON.parse(fs.readFileSync(settingsFile));assert.equal(persisted.liveWedding.title,'Original Wedding');assert.equal(persisted.liveWeddings.length,1);assert.equal(persisted.liveWeddings[0].password,undefined);
      assert.equal((await post('/api/wedding-detail',{id:weddingId,weddingPassword:'bad'},false)).status,401);
      assert.equal((await post('/api/wedding-detail',{id:weddingId,weddingPassword:'main1234'},false)).status,200);
      const open=async(album,password,weddingPassword='main1234')=>post('/api/wedding-open',{id:weddingId,album,password,weddingPassword},false);
      assert.equal((await open('haldi','1111')).status,401);
      assert.equal((await open('haldi','2222','bad')).status,401);
      for(const [album,password] of Object.entries({main:'',chulmati:'1111',haldi:'2222',devpoojan:'',barat:'3333',reception:'4444'})){
        const response=await open(album,password);assert.equal(response.status,200);assert.equal(JSON.parse(response.text).url,url(album));
      }
      assert.equal((await open('unknown','')).status,404);
      assert.equal((await post('/admin/live-wedding-save',{id:weddingId,albums:{haldi:{driveUrl:'javascript:alert(1)'}}})).status,400);
      assert.equal((await post('/admin/live-wedding-save',{id:weddingId,albums:{haldi:{passwordEnabled:false}}})).status,200);
      assert.equal((await open('haldi','')).status,200);
      assert.equal((await post('/admin/live-wedding-save',{id:weddingId,albums:{haldi:{passwordEnabled:true,password:''}}})).status,200);
      assert.equal((await open('haldi','')).status,401);assert.equal((await open('haldi','2222')).status,200);
      for(const route of ['/api/settings','/api/home-gallery-samples','/api/live-weddings','/']){
        const text=await (await fetch(origin+route)).text();
        assert.ok(!text.includes(url('haldi')),'Protected URL leaked in '+route);
        assert.ok(!text.includes(crypto.createHash('sha256').update('2222').digest('hex')),'Password hash leaked in '+route);
      }
      await stop();await start();assert.equal((await open('reception','4444')).status,200);
    });
    await t.test('Chrome uploads, saves, edits, opens albums, validates passwords and deletes weddings', {skip:process.env.LIVE_EVENT_BROWSER!=='1'},async()=>{
      const {chromium}=require('playwright');browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_EXECUTABLE});
      const context=await browser.newContext({httpCredentials:{username:'admin',password},viewport:{width:1280,height:1000}});
      await context.addCookies([{name:'aditya_admin_totp',value:token,url:origin}]);
      await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,body:''}));
      // The isolated test blocks the Tailwind CDN; provide its config object.
      await context.addInitScript(()=>{window.tailwind={};});
      const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(origin+'/admin#site');await page.waitForFunction(()=>document.querySelectorAll('.wedding-editor').length===2);
      await page.locator('#addWeddingBtn').click();const draft=page.locator('[data-wedding-id="new"]');
      assert.equal(await draft.locator('[data-album="main"] img').isVisible(),false);
      await draft.locator('[data-field="title"]').fill('Browser Wedding');
      const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=180;c.height=100;const ctx=c.getContext('2d');ctx.fillStyle='#0891b2';ctx.fillRect(0,0,180,100);return c.toDataURL('image/png').split(',')[1];});
      const upload={name:'wedding.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')};
      for(const key of ['main','chulmati','devpoojan','haldi','barat','reception']){
        const album=draft.locator('[data-album="'+key+'"]');await album.locator('input[type=file]').setInputFiles(upload);await album.locator('[data-field="link"]').fill(url('browser-'+key));
        if(key==='haldi'||key==='chulmati'){await album.locator('[data-field="passwordEnabled"]').check();await album.locator('[data-field="password"]').fill(key==='haldi'?'5566':'7788');}
      }
      await draft.getByRole('button',{name:'Save Wedding',exact:true}).dblclick();
      await draft.waitFor({state:'detached'});
      const data=JSON.parse(fs.readFileSync(settingsFile));assert.equal(data.liveWeddings.length,2,'Double click must save only once');
      const created=data.liveWeddings.find(w=>w.title==='Browser Wedding'),id=created.id;
      assert.ok(Object.values(created.albums).every(a=>a.thumbnail.startsWith('data:image/jpeg;base64,')));
      await page.reload();const editor=page.locator('[data-wedding-id="'+id+'"]');await editor.locator('summary').click();
      const haldi=editor.locator('[data-album="haldi"]');assert.equal(await haldi.locator('[data-field="passwordEnabled"]').isChecked(),true);
      assert.equal(await haldi.locator('[data-field="password"]').inputValue(),'');
      await page.route('**/admin/live-wedding-save',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({ok:false,message:'Test storage failure'})}));
      await editor.getByRole('button',{name:'Save Wedding',exact:true}).click();await page.waitForFunction(id=>document.querySelector('[data-wedding-id="'+id+'"] .wedding-status').textContent.includes('HTTP 500'),id);
      assert.equal(await editor.getByRole('button',{name:'Save Wedding',exact:true}).isEnabled(),true);await page.unroute('**/admin/live-wedding-save');
      await haldi.locator('[data-field="passwordEnabled"]').uncheck();await editor.getByRole('button',{name:'Save Wedding',exact:true}).click();
      await page.waitForFunction(id=>document.querySelector('[data-wedding-id="'+id+'"] .wedding-status').textContent.startsWith('Saved successfully'),id);
      assert.equal(JSON.parse(fs.readFileSync(settingsFile)).liveWeddings.find(w=>w.id===id).albums.haldi.passwordEnabled,false);
      if(process.env.WEDDING_SCREENSHOT)await page.locator('#weddingManager').screenshot({path:process.env.WEDDING_SCREENSHOT});
      await page.setViewportSize({width:390,height:844});
      assert.equal(await editor.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'Wedding editor must fit a mobile screen');
      if(process.env.WEDDING_SCREENSHOT)await editor.screenshot({path:process.env.WEDDING_SCREENSHOT.replace('.png','-mobile.png')});
      await page.setViewportSize({width:1280,height:1000});
      await page.goto(origin+'/');await page.getByRole('link',{name:'Open wedding Browser Wedding',exact:true}).click();await page.waitForURL(origin+'/live-wedding?id='+id);
      await page.locator('.album[data-album="haldi"]').click();await page.waitForURL(url('browser-haldi'));
      await page.goto(origin+'/live-wedding?id='+id);await page.locator('.album[data-album="chulmati"]').click();await page.locator('#albumPassword').fill('5566');await page.locator('#passwordSubmit').click();await page.waitForFunction(()=>document.getElementById('passwordError').textContent.includes('Password sahi nahi'));
      await page.locator('#albumPassword').fill('7788');await page.locator('#passwordSubmit').click();await page.waitForURL(url('browser-chulmati'));
      // The main wedding password is separate from each ceremony password.
      await page.goto(origin+'/live-wedding?id='+weddingId);await page.locator('#passwordDialog').waitFor({state:'visible'});assert.equal(await page.locator('#weddingContent').isVisible(),false);
      await page.locator('#albumPassword').fill('main1234');await page.locator('#passwordSubmit').click();await page.locator('#weddingContent').waitFor({state:'visible'});
      await page.locator('[data-album="barat"]').click();await page.locator('#albumPassword').fill('3333');await page.locator('#passwordSubmit').click();await page.waitForURL(url('barat'));
      await page.goto(origin+'/admin#site');await editor.locator('summary').click();page.once('dialog',d=>d.dismiss());await editor.getByRole('button',{name:'Delete Wedding'}).click();assert.equal(await editor.count(),1);
      page.once('dialog',d=>d.accept());await editor.getByRole('button',{name:'Delete Wedding'}).click();await editor.waitFor({state:'detached'});
      assert.equal((await post('/api/wedding-open',{id,album:'haldi'},false)).status,404);
      assert.deepEqual(errors,[]);
      await browser.close();browser=null;
    });
    await t.test('failed storage does not report success; deletions persist without restoring legacy defaults',async()=>{
      const before=fs.readFileSync(settingsFile),state=await (await fetch(origin+'/api/live-weddings')).json();
      fs.renameSync(settingsFile,settingsFile+'.test-backup');fs.mkdirSync(settingsFile);
      try{
        assert.equal((await post('/admin/live-wedding-delete',{id:'legacy'})).status,500);
        assert.equal((await post('/admin/live-wedding-save',{id:weddingId,title:'Must not save'})).status,500);
        assert.deepEqual(await (await fetch(origin+'/api/live-weddings')).json(),state);
      }finally{fs.rmdirSync(settingsFile);fs.renameSync(settingsFile+'.test-backup',settingsFile);}
      assert.deepEqual(fs.readFileSync(settingsFile),before);
      assert.equal((await post('/admin/live-wedding-delete',{id:'legacy'})).status,200);
      assert.equal((await post('/admin/live-wedding-delete',{id:weddingId})).status,200);
      await stop();await start();
      const after=await (await fetch(origin+'/api/live-weddings')).json();assert.equal(after.weddings.length,0);
      assert.equal((await post('/api/wedding-detail',{id:'legacy'},false)).status,404);
    });
  } finally {
    if(browser)await browser.close();await stop();fs.rmSync(dataDir,{recursive:true,force:true});
  }
});
