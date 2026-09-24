/* Real Local Delivery interface: replaces old demo home. */
(()=>{
 const appRender=render;document.documentElement.style.overflowX='hidden';document.body.style.overflowX='hidden';
 const food=[
  ['Biryani','https://images.unsplash.com/photo-1589302168068-964664d93dc0?auto=format&fit=crop&w=600&q=82'],
  ['Egg Roll','https://images.unsplash.com/photo-1625944525533-473f1a3d54e7?auto=format&fit=crop&w=600&q=82'],
  ['Pizza','https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?auto=format&fit=crop&w=600&q=82'],
  ['Cake','https://images.unsplash.com/photo-1578985545062-69928b1d9587?auto=format&fit=crop&w=600&q=82']
 ];
 const ration=[
  ['Aata','https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=600&q=82'],
  ['Chawal','https://images.unsplash.com/photo-1586208958839-06c17cacdf08?auto=format&fit=crop&w=600&q=82'],
  ['Dal','https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=600&q=82'],
  ['Tel','https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?auto=format&fit=crop&w=600&q=82']
 ];
 const nav=()=>[['home','⌂','होम'],['orders','♧','मेरे ऑर्डर'],['post','＋','पोस्ट करें'],['wallet','▣','वॉलेट'],['messages','▤','बातचीत']].map(([id,icon,label])=>`<button data-go="${id}" class="${tab===id?'active':''}"><span>${icon}</span>${label}</button>`).join('');
 const card=([name,src])=>`<article style="flex:0 0 calc((100% - 36px)/4);min-width:145px;overflow:hidden;border:1px solid #29435e;border-radius:16px;background:#101a2c"><img src="${src}" alt="${name}" style="width:100%;height:126px;object-fit:cover;display:block"><button class="btn" style="width:100%;min-height:62px;border-radius:0;font-size:14px;padding:8px 4px" data-go="post">${name}<br><small>Order →</small></button></article>`;
 const row=(title,items)=>`<section style="margin-top:20px"><h2 style="margin:0 0 12px;color:#fff;font-size:22px">${title}</h2><div style="display:flex;gap:12px;overflow-x:auto;overscroll-behavior-x:contain;padding:3px 2px 14px">${items.map(card).join('')}</div></section>`;
 const home=()=>`<section class="market-feed"><div class="market-post-type-tabs"><button class="need-tab selected" data-go="post">🛍️ सामान मंगाने की requirement</button><button class="service-tab" data-go="orders">🚚 Delivery boy posts</button></div>${row('🍕 खाने का सामान',food)}${row('🛒 राशन का सामान',ration)}</section>`;
 render=function(){appRender();const top=document.querySelector('.topbar'),menu=document.querySelector('.nav'),content=document.querySelector('.content');if(top)top.innerHTML=`<div class="market-brand"><span class="brand-symbol">ϟ</span><div><strong>Local Delivery</strong><small>आपके गांव का मददगार</small></div></div><div class="market-tools"><button class="wallet-chip" data-go="wallet" aria-label="वॉलेट खोलें">▣ <strong>${money(available(user))}</strong></button><button class="round-button notification-bell" data-go="notifications" aria-label="Notifications खोलें">🔔</button>${(()=>{try{const s=JSON.parse(localStorage.getItem('aditya_studio_session_v1')||localStorage.getItem('aditya_studio_persistent_login_v2')||'null'),name=state.users[user]?.name||'U';return s?.sessionToken?'<button class="profile-button" data-go="profile" aria-label="मेरी प्रोफ़ाइल खोलें">'+esc(name.charAt(0))+'</button>':'<a class="market-login" href="/" aria-label="Login करें">Login</a>'}catch(_){return '<a class="market-login" href="/" aria-label="Login करें">Login</a>'}})()}</div>`;if(menu)menu.innerHTML=nav();if(tab==='home'&&!active&&content)content.innerHTML=home();};
 tab='home';active=null;render();
})();
