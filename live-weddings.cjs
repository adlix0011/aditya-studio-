const crypto = require('node:crypto');
const keys = ['chulmati', 'devpoojan', 'haldi', 'barat', 'reception'];
const labels = { chulmati:'Chulmati', devpoojan:'Devpoojan', haldi:'Haldi', barat:'Barat', reception:'Reception' };
function rows(settings) {
  const first = settings.liveWedding;
  return [...(first && !first.deleted ? [{ ...first, id:'legacy' }] : []), ...(Array.isArray(settings.liveWeddings) ? settings.liveWeddings : [])];
}
function album(row, key) {
  const value = (row.albums || {})[key];
  if (value && typeof value === 'object') return value;
  // Older weddings used one shared download link and string thumbnails.
  return { thumbnail: value || '', driveUrl:row.driveUrl || '', passwordEnabled:false, passwordHash:'' };
}
function visible(row, mediaUrl, admin = false) {
  const access = item => ({ ...(admin ? { driveUrl:item.driveUrl || '', passwordSet:!!item.passwordHash } : {}), available:!!item.driveUrl, passwordEnabled:!!item.passwordEnabled });
  return { id:row.id, title:row.title || 'Live Wedding', thumbnail:mediaUrl(row.thumbnail || ''), ...access(row),
    albums:Object.fromEntries(keys.map(key => { const item=album(row,key); return [key,{ thumbnail:mediaUrl(item.thumbnail || ''), ...access(item) }]; })) };
}
function fail(message, status = 400) { const error=new Error(message); error.status=status; throw error; }
function makeRow(body, previous, { storedMediaValue, isSafeAdminR2ImageKey }) {
  const image = raw => {
    const value=storedMediaValue(String(raw || '').trim());
    if (value && !/^data:image\/(png|jpe?g|webp);base64,/i.test(value) && !(value.startsWith('r2:')&&isSafeAdminR2ImageKey(value.slice(3))) && !/^https:\/\//i.test(value) && !/^\/assets\/[a-z0-9._-]+$/i.test(value)) fail('Valid thumbnail image choose karein.');
    return value;
  };
  const access = (input, old, name) => {
    const driveUrl=String(input.driveUrl ?? old.driveUrl ?? '').trim();
    if (driveUrl && !/^https:\/\/(drive\.google\.com|docs\.google\.com)\//i.test(driveUrl)) fail(name+': valid Google Drive link paste karein.');
    const enabled=input.passwordEnabled === undefined ? !!old.passwordEnabled : input.passwordEnabled === true;
    const password=String(input.password || '');
    if (password && (password.length<4 || password.length>80)) fail(name+': password 4–80 characters ka rakhein.');
    const passwordHash=password ? crypto.createHash('sha256').update(password).digest('hex') : old.passwordHash || '';
    if (enabled && !passwordHash) fail(name+': password ON hai; password set karein.');
    return {driveUrl,passwordEnabled:enabled,passwordHash};
  };
  const title=String(body.title ?? previous.title ?? '').trim().slice(0,100);
  if (!title) fail('Bride & groom names likhein.');
  const thumbnail=image(body.thumbnail ?? previous.thumbnail);
  if (!thumbnail) fail('Wedding cover thumbnail choose karein.');
  const albums=Object.fromEntries(keys.map(key=>{
    const old=album(previous,key),raw=(body.albums || {})[key];
    const input=typeof raw === 'string' ? {thumbnail:raw} : raw || {};
    return [key,{thumbnail:image(input.thumbnail ?? old.thumbnail),...access(input,old,labels[key])}];
  }));
  return {title,thumbnail,...access(body,previous,'Main album'),albums};
}
function save(settings, body, helpers) {
  const id=String(body.id || 'legacy');
  const old=rows(settings).find(row=>row.id===id);
  if (id !== 'new' && !old) fail('Wedding nahi mila. Refresh karein.',404);
  if (id === 'new' && rows(settings).length>=20) fail('Maximum 20 weddings allowed.');
  const row={...makeRow(body,old || {},helpers),id:id==='new'?crypto.randomUUID():id};
  if (id==='legacy') settings.liveWedding=row;
  else if(id==='new')settings.liveWeddings=[...(settings.liveWeddings || []),row];
  else settings.liveWeddings=(settings.liveWeddings || []).map(item=>item.id===row.id?row:item);
  return row;
}
function remove(settings,id) {
  if (!rows(settings).some(row=>row.id===id)) fail('Wedding nahi mila.',404);
  if (id==='legacy') settings.liveWedding={deleted:true};
  else settings.liveWeddings=(settings.liveWeddings || []).filter(row=>row.id!==id);
}
function verify(item,password) {
  if(!item.passwordEnabled)return;
  const actual=crypto.createHash('sha256').update(String(password || '')).digest();
  const expected=Buffer.from(String(item.passwordHash || ''),'hex');
  if(expected.length!==actual.length||!crypto.timingSafeEqual(expected,actual))fail('Password sahi nahi hai.',401);
}
function detail(settings,body) {
  const row=rows(settings).find(item=>item.id===String(body.id || 'legacy'));
  if(!row)fail('Wedding available nahi hai.',404);
  verify(row,body.weddingPassword);
  return row;
}
function open(settings,body) {
  const row=detail(settings,body);
  const key=String(body.album || 'main');
  if(key!=='main'&&!keys.includes(key))fail('Album nahi mila.',404);
  const item=key==='main'?row:album(row,key);
  if(!item.driveUrl)fail('Photos coming soon.',404);
  if(key!=='main')verify(item,body.password);
  return item.driveUrl;
}
module.exports={keys,labels,rows,visible,save,remove,open,detail};
