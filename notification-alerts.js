/* Live customer alerts. Browser notifications need one explicit permission tap. */
(function(){
  const seenKey='aditya_delivery_seen_notifications_v1'; let initialized=false,audioReady=false;
  function session(){try{return JSON.parse(localStorage.getItem('aditya_studio_session_v1')||localStorage.getItem('aditya_studio_persistent_login_v2')||'null')}catch(_){return null}}
  function readSeen(){try{return new Set(JSON.parse(localStorage.getItem(seenKey)||'[]'))}catch(_){return new Set()}}
  function saveSeen(s){try{localStorage.setItem(seenKey,JSON.stringify([...s].slice(0,80)))}catch(_){}}
  function sound(){if(!audioReady)return;try{const C=window.AudioContext||window.webkitAudioContext,c=new C(),t=c.currentTime;[660,880,1040].forEach((f,i)=>{const o=c.createOscillator(),g=c.createGain();o.frequency.value=f;g.gain.setValueAtTime(.0001,t+i*.13);g.gain.exponentialRampToValueAtTime(.13,t+i*.13+.015);g.gain.exponentialRampToValueAtTime(.0001,t+i*.13+.12);o.connect(g).connect(c.destination);o.start(t+i*.13);o.stop(t+i*.13+.13)});setTimeout(()=>c.close(),650)}catch(_){}}
  function show(n){sound();if(window.Notification&&Notification.permission==='granted'){try{new Notification(n.title||'Local Delivery',{body:n.body||'नई update मिली है',tag:n.id,renotify:true})}catch(_){}}if(typeof toast==='function')toast('🔔 '+(n.title||'नई notification')+' — '+(n.body||''));}
  async function poll(){const s=session();if(!s?.sessionToken)return;try{const r=await fetch('/api/my-notifications',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mobile:s.mobile,sessionToken:s.sessionToken})}),d=await r.json();if(!r.ok||!d.ok)return;const seen=readSeen(),items=Array.isArray(d.items)?d.items:[];if(!initialized){items.forEach(n=>seen.add(n.id));saveSeen(seen);initialized=true;return}items.slice().reverse().forEach(n=>{if(n.id&&!seen.has(n.id)){seen.add(n.id);show(n)}});saveSeen(seen)}catch(_){}}
  function enable(){audioReady=true;if(window.Notification&&Notification.permission==='default')Notification.requestPermission().catch(()=>{});}
  document.addEventListener('pointerdown',enable,{once:true,passive:true}); document.addEventListener('keydown',enable,{once:true});
  poll();setInterval(poll,10000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll()});
})();
