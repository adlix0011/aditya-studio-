/* Local Delivery alerts: only new, server-recorded events may open a popup. */
(function(){
  const seenKey='aditya_delivery_seen_notifications_v1';
  const initialGraceMs=60000;
  let initialized=false,audioReady=false;
  function session(){try{return JSON.parse(localStorage.getItem('aditya_studio_session_v1')||localStorage.getItem('aditya_studio_persistent_login_v2')||'null')}catch(_){return null}}
  function readSeen(){try{return new Set(JSON.parse(localStorage.getItem(seenKey)||'[]'))}catch(_){return new Set()}}
  function saveSeen(s){try{localStorage.setItem(seenKey,JSON.stringify([...s].slice(0,80)))}catch(_){}}
  function escapeHtml(value){return String(value||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
  function sound(){if(!audioReady)return;try{const C=window.AudioContext||window.webkitAudioContext,c=new C(),t=c.currentTime;[660,880,1040].forEach((f,i)=>{const o=c.createOscillator(),g=c.createGain();o.frequency.value=f;g.gain.setValueAtTime(.0001,t+i*.13);g.gain.exponentialRampToValueAtTime(.13,t+i*.13+.015);g.gain.exponentialRampToValueAtTime(.0001,t+i*.13+.12);o.connect(g).connect(c.destination);o.start(t+i*.13);o.stop(t+i*.13+.13)});setTimeout(()=>c.close(),650)}catch(_){}}
  function popup(n){
    document.getElementById('deliveryServerAlertPopup')?.remove();
    const box=document.createElement('button');
    box.type='button';box.id='deliveryServerAlertPopup';
    box.style.cssText='position:fixed;right:16px;bottom:92px;z-index:99999;max-width:min(360px,calc(100vw - 32px));padding:15px 17px;border:1px solid #4ade80;border-radius:16px;background:linear-gradient(135deg,#065f46,#0f172a 72%);color:#ecfdf5;text-align:left;font:700 14px/1.45 Arial,sans-serif;box-shadow:0 12px 30px #0009,0 0 22px #22c55e66;cursor:pointer';
    const heading=n.kind==='local-delivery-message'?'💬 नया message':'📦 Order pickup request';
    box.innerHTML='<strong style="display:block;font-size:16px;margin-bottom:4px">'+heading+'</strong><span>'+escapeHtml(n.body)+'</span><small style="display:block;margin-top:8px;color:#bbf7d0">Tap करके direct chat खोलें</small>';
    box.onclick=()=>{box.remove();if(typeof window.openLocalDeliveryChat==='function')window.openLocalDeliveryChat(n.orderId,n.senderMobile||'');else if(typeof go==='function')go('messages')};
    document.body.appendChild(box);sound();setTimeout(()=>box.remove(),12000);
  }
  function isPopupEvent(n){return n?.kind==='local-delivery-confirm-request'||(n?.kind==='local-delivery-message'&&n?.actualMessage===true)}
  function show(n){document.querySelector('.notification-bell i')?.classList.add('unread');if(isPopupEvent(n)&&!document.querySelector('.chat-room'))popup(n)}
  async function poll(){
    const s=session();if(!s?.sessionToken)return;
    try{
      const r=await fetch('/api/my-notifications',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mobile:s.mobile,sessionToken:s.sessionToken})}),d=await r.json();
      if(!r.ok||!d.ok)return;
      const seen=readSeen(),items=Array.isArray(d.items)?d.items:[];
      if(!initialized){
        const now=Date.now();
        items.forEach(n=>{if(n.id)seen.add(n.id)});const newest=items[0],fresh=newest&&now-new Date(newest.at||0).getTime()<=initialGraceMs;if(newest?.id&&!readSeen().has(newest.id)&&fresh&&isPopupEvent(newest))show(newest);
        saveSeen(seen);initialized=true;return;
      }
      items.slice().reverse().forEach(n=>{if(n.id&&!seen.has(n.id)){seen.add(n.id);show(n)}});saveSeen(seen);
    }catch(_){}
  }
  function enable(){audioReady=true}
  document.addEventListener('pointerdown',enable,{once:true,passive:true});document.addEventListener('keydown',enable,{once:true});
  poll();setInterval(poll,3000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll()});
})();
