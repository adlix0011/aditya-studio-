(function () {
  'use strict';
  const root=document.getElementById('weddingEditors'),status=document.getElementById('weddingManagerStatus');
  if(!root)return;
  const labels={main:'Wedding cover, access & main Drive link',chulmati:'Chulmati',devpoojan:'Devpoojan',haldi:'Haldi',barat:'Barat',reception:'Reception'};
  const css=document.createElement('style');
  css.textContent='.wedding-editor{margin-top:16px;border:1px solid #415a73;border-radius:12px;background:#101925;overflow:hidden}.wedding-editor summary{padding:16px;font-size:17px;font-weight:700;color:#fff0bd;cursor:pointer;overflow-wrap:anywhere}.wedding-fields{border:0;padding:0 14px 16px;margin:0;min-width:0}.wedding-album-editor{margin:14px 0;padding:14px;border:1px solid #384c62;border-radius:12px;background:#182737}.wedding-album-editor h4{margin:0 0 12px;color:#9ce8ed}.wedding-album-grid{display:grid;grid-template-columns:150px minmax(0,1fr);gap:16px}.wedding-photo img{width:140px;height:90px;object-fit:cover;border-radius:9px;display:block;margin-bottom:8px}.wedding-photo img[hidden]{display:none}.wedding-photo input{max-width:100%;font-size:12px}.wedding-password{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-top:12px}.wedding-password label{color:#f4ead6;display:flex;align-items:center;gap:7px}.wedding-editor .inp{box-sizing:border-box;width:100%;color:#f4ead6;background:#080e16}.wedding-password input[type=password]{flex:1;min-width:140px}.wedding-editor small{display:block;color:#c3cdd8;margin-top:7px;line-height:1.4}.wedding-actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.wedding-delete{background:#8f2633;color:white;border:1px solid #ef96a0;padding:10px 14px;border-radius:8px;cursor:pointer}.wedding-status{white-space:pre-wrap;overflow-wrap:anywhere;color:#a5f3fc;margin-top:12px}@media(max-width:600px){.wedding-album-grid{grid-template-columns:1fr}.wedding-photo{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.wedding-photo img{width:110px;height:75px}.wedding-fields{padding:0 10px 12px}.wedding-album-editor{padding:10px}}';
  document.head.appendChild(css);
  function el(tag,text,className){const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;}
  async function request(url,body){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
    try{
      const res=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
      if(res.redirected||res.status===401||res.status===403)throw Error('Admin login verify karein (HTTP '+res.status+').');
      let out;try{out=await res.json();}catch(_){throw Error('Invalid server response (HTTP '+res.status+').');}
      if(!res.ok||!out.ok)throw Error((out.message||'Request failed')+' (HTTP '+res.status+').');
      return out;
    }catch(error){if(error.name==='AbortError')throw Error('Server timeout. Saved weddings check karke retry karein.');throw error;}finally{clearTimeout(timer);}
  }
  function compress(file){return new Promise((resolve,reject)=>{
    if(!file.type.startsWith('image/')||file.size>12*1024*1024)return reject(Error('12 MB se chhoti image choose karein.'));
    const url=URL.createObjectURL(file),img=new Image();
    const finish=(err,data)=>{clearTimeout(timer);URL.revokeObjectURL(url);err?reject(err):resolve(data);};
    const timer=setTimeout(()=>finish(Error('Image processing timeout. JPG/PNG image try karein.')),20000);
    img.onload=()=>{try{const scale=Math.min(1,1200/Math.max(img.width,img.height)),canvas=document.createElement('canvas');canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);finish(null,canvas.toDataURL('image/jpeg',.82));}catch(error){finish(error);}};
    img.onerror=()=>finish(Error('Image read nahi hui. JPG/PNG image choose karein.'));img.src=url;
  });}
  function count(){status.textContent=root.querySelectorAll('.wedding-editor:not([data-wedding-id="new"])').length+' saved weddings � Naam par click karke edit karein.';}
  function editor(row){
    const panel=el('details',null,'wedding-editor');panel.dataset.weddingId=row.id;panel.open=row.id==='new';
    const heading=el('summary',row.id==='new'?'New Wedding':row.title),fields=el('fieldset',null,'wedding-fields');
    const titleLabel=el('label','Bride & groom names'),title=el('input',null,'inp');title.value=row.title||'';title.maxLength=100;title.placeholder='Bride & groom names';title.dataset.field='title';titleLabel.append(title);fields.append(titleLabel);
    const controls={};
    for(const [key,label] of Object.entries(labels)){
      const current=key==='main'?row:(row.albums||{})[key]||{};
      const box=el('section',null,'wedding-album-editor');box.dataset.album=key;box.append(el('h4',label));
      const grid=el('div',null,'wedding-album-grid'),photo=el('div',null,'wedding-photo');
      const preview=el('img');preview.alt=label+' thumbnail';if(current.thumbnail)preview.src=current.thumbnail;else preview.hidden=true;
      const file=el('input');file.type='file';file.accept='image/*';file.setAttribute('aria-label',label+' thumbnail');
      photo.append(preview,file);
      const settings=el('div'),linkLabel=el('label','Google Drive link'),link=el('input',null,'inp');link.type='url';link.placeholder='https://drive.google.com/drive/folders/...';link.value=current.driveUrl||'';link.dataset.field='link';linkLabel.append(link);
      const access=el('div',null,'wedding-password'),toggleLabel=el('label'),toggle=el('input');toggle.type='checkbox';toggle.checked=!!current.passwordEnabled;toggle.dataset.field='passwordEnabled';
      const toggleText=el('span'),pass=el('input',null,'inp');pass.type='password';pass.autocomplete='new-password';pass.maxLength=80;pass.dataset.field='password';pass.setAttribute('aria-label',label+' password');
      const refresh=()=>{toggleText.textContent=toggle.checked?'Password ON':'Password OFF';pass.disabled=!toggle.checked;pass.placeholder=current.passwordSet?'Password saved — blank rakhein ya naya likhein':'Set password (minimum 4 characters)';};toggle.onchange=refresh;refresh();
      toggleLabel.append(toggle,toggleText);access.append(toggleLabel,pass);settings.append(linkLabel,access,el('small',key==='main'?'ON: wedding kholne ke liye password zaroori. OFF: wedding seedha khulegi.':'ON: is album ka alag password zaroori. OFF: album seedha khulega.'));
      grid.append(photo,settings);box.append(grid);fields.append(box);controls[key]={current,file,preview,link,toggle,pass};
      file.onchange=async()=>{if(!file.files[0])return;try{preview.src=await compress(file.files[0]);preview.hidden=false;}catch(error){note.textContent='FAILED: '+error.message;}};
    }
    const actions=el('div',null,'wedding-actions'),save=el('button','Save Wedding','gen-btn'),del=el('button',row.id==='new'?'Cancel':'Delete Wedding','wedding-delete'),note=el('div',null,'wedding-status');
    save.type=del.type='button';note.setAttribute('role','status');actions.append(save,del);fields.append(actions,note);panel.append(heading,fields);
    save.onclick=async()=>{
      if(fields.disabled)return;
      fields.disabled=true;note.style.color='#a5f3fc';note.textContent='Thumbnail aur links check ho rahe hain…';
      try{
        const body={id:row.id,title:title.value.trim(),albums:{}};
        for(const [key,c] of Object.entries(controls)){
          const thumbnail=c.file.files[0]?await compress(c.file.files[0]):c.current.thumbnail||'';
          const value={thumbnail,driveUrl:c.link.value.trim(),passwordEnabled:c.toggle.checked,password:c.pass.value};
          if(key==='main')Object.assign(body,value);else body.albums[key]=value;
        }
        note.textContent='Saving wedding…';
        const out=await request('/admin/live-wedding-save',body),replacement=editor(out.wedding);replacement.open=true;panel.replaceWith(replacement);count();
        const success=replacement.querySelector('.wedding-status');success.textContent='Saved successfully — Home page par wedding update ho gayi.';success.style.color='#86efac';
      }catch(error){note.textContent='FAILED: '+error.message;note.style.color='#fca5a5';}finally{fields.disabled=false;}
    };
    del.onclick=async()=>{
      if(row.id==='new'){panel.remove();return;}
      if(!confirm('Is wedding aur iske albums ko site se delete karein?'))return;
      fields.disabled=true;note.textContent='Deleting wedding…';
      try{await request('/admin/live-wedding-delete',{id:row.id});panel.remove();status.textContent='Wedding deleted — Home page se hata di gayi.';}catch(error){note.textContent='FAILED: '+error.message;note.style.color='#fca5a5';}finally{fields.disabled=false;}
    };
    return panel;
  }
  document.getElementById('addWeddingBtn').onclick=()=>{let draft=root.querySelector('[data-wedding-id="new"]');if(!draft){draft=editor({id:'new',title:'',albums:{}});root.prepend(draft);}draft.open=true;draft.scrollIntoView({behavior:'smooth',block:'start'});draft.querySelector('[data-field="title"]').focus();};
  request('/admin/live-weddings').then(out=>{out.weddings.forEach(row=>root.append(editor(row)));status.textContent=out.weddings.length+' saved weddings · Naam par click karke edit karein.';}).catch(error=>{status.textContent='FAILED: '+error.message;status.style.color='#fca5a5';});
})();
