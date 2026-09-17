/* Local Delivery alerts: background sync must never open a foreground popup. */
(function(){
  const seenKey='aditya_delivery_seen_notifications_v1'; let initialized=false,audioReady=false;
  function session(){try{return JSON.parse(localStorage.getItem('aditya_studio_session_v1')||localStorage.getItem('aditya_studio_persistent_login_v2')||'null')}catch(_){return null}}
  function readSeen(){try{return new Set(JSON.parse(localStorage.getItem(seenKey)||'[]'))}catch(_){return new Set()}}
  function saveSeen(s){try{localStorage.setItem(seenKey,JSON.stringify([...s].slice(0,80)))}catch(_){}}
  function sound(){if(!audioReady)return;try{const C=window.AudioContext||window.webkitAudioContext,c=new C(),t=c.currentTime;[660,880,1040].forEach((f,i)=>{const o=c.createOscillator(),g=c.createGain();o.frequency.value=f;g.gain.setValueAtTime(.0001,t+i*.13);g.gain.exponentialRampToValueAtTime(.13,t+i*.13+.015);g.gain.exponentialRampToValueAtTime(.0001,t+i*.13+.12);o.connect(g).connect(c.destination);o.start(t+i*.13);o.stop(t+i*.13+.13)});setTimeout(()=>c.close(),650)}catch(_){}}
  function show(n){
    // Never show a sticker, toast, browser notification or alert from polling.
    // An actual saved incoming chat message only marks the bell and can chime.
    if(n.kind!=='local-delivery-message'||n.actualMessage!==true)return;
    document.querySelector('.notification-bell i')?.classList.add('unread');
    // Background polling must stay silent.
  }
  async function poll(){const s=session();if(!s?.sessionToken)return;try{const r=await fetch('/api/my-notifications',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mobile:s.mobile,sessionToken:s.sessionToken})}),d=await r.json();if(!r.ok||!d.ok)return;const seen=readSeen(),items=Array.isArray(d.items)?d.items:[];if(!initialized){items.forEach(n=>seen.add(n.id));saveSeen(seen);initialized=true;return}items.slice().reverse().forEach(n=>{if(n.id&&!seen.has(n.id)){seen.add(n.id);show(n)}});saveSeen(seen)}catch(_){}}
  function enable(){audioReady=true;}
  document.addEventListener('pointerdown',enable,{once:true,passive:true});document.addEventListener('keydown',enable,{once:true});
  poll();setInterval(poll,5000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll()});
})();