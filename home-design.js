/* Real Local Delivery interface: replaces old demo home. */
(()=>{
 const appRender=render;
 const food=[
 ['Biryani','https://images.unsplash.com/photo-1589302168068-964664d93dc0?auto=format&fit=crop&w=600&q=82'],
 ['Egg Roll','https://images.unsplash.com/photo-1625944525533-473f1a3d54e7?auto=format&fit=crop&w=600&q=82'],
 ['Pizza','https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?auto=format&fit=crop&w=600&q=82'],
 ['Cake','https://images.unsplash.com/photo-1578985545062-69928b1d9587?auto=format&fit=crop&w=600&q=82']
 ];
 const nav=()=>[['home','⌂','होम'],['orders','♧','मेरे ऑर्डर'],['post','＋','पोस्ट करें'],['wallet','▣','वॉलेट'],['messages','▤','बातचीत']].map(([id,icon,label])=>`<button data-go="${id}" class="${tab===id?'active':''}"><span>${icon}</span>${label}</button>`).join('');
 const home=()=>`<section class="market-feed"><div class="market-post-type-tabs"><button class="need-tab selected" data-go="post">🛍️ सामान मंगाने की requirement</button><button class="service-tab" data-go="orders">🚚 Delivery boy posts</button></div><section style="margin-top:20px"><h2 style="margin:0 0 12px;color:#fff;font-size:22px">🍕 खाने का सामान</h2><div style="display:flex;gap:12px;overflow-x:auto;padding:3px 2px 14px">${food.map(([name,src])=>`<article style="flex:0 0 calc((100% - 36px)/4);min-width:145px;overflow:hidden;border:1px solid #29435e;border-radius:16px;background:#101a2c"><img src="${src}" alt="${name}" style="width:100%;height:126px;object-fit:cover;display:block"><button class="btn" style="width:100%;min-height:62px;border-radius:0;font-size:14px;padding:8px 4px" data-go="post">${name}<br><small>Order →</small></button></article>`).join('')}</div></section></section>`;
 render=function(){appRender();const top=document.querySelector('.topbar'),menu=document.querySelector('.nav'),content=document.querySelector('.content');if(top)top.innerHTML='<div class="market-brand"><span class="brand-symbol">ϟ</span><div><strong>Local Delivery</strong><small>आपके गांव का मददगार</small></div></div><div class="market-tools"><button class="wallet-chip" data-go="wallet">▣ Wallet</button><button class="round-button" data-go="notifications">🔔</button></div>';if(menu)menu.innerHTML=nav();if(tab==='home'&&!active&&content)content.innerHTML=home();};
 tab='home';active=null;render();
})();
