function notificationPage(){
 const entries=state.orders.filter(o=>o.owner===user||o.provider===user).flatMap(o=>(o.messages||[]).filter(m=>m.sender==='system').map(m=>({order:o,message:m}))).slice(-30).reverse();
 return `<section class="notifications-page"><button class="back" data-go="home">← होम पर वापस जाएं</button><div class="notification-heading"><span>🔔</span><div><h1>Notifications</h1><p>ऑर्डर और payment से जुड़ी सभी updates</p></div></div><div class="notification-list">${entries.map(({order,message})=>`<button class="notification-item" data-open="${order.id}"><strong>${esc(order.title)}</strong><span>${esc(message.text)}</span><small>${esc(message.time||'')}</small></button>`).join('')||'<div class="empty">अभी कोई notification नहीं है।</div>'}</div><a class="whatsapp-help" href="https://wa.me/917024230041?text=Hello%20Local%20Delivery%20support%2C%20I%20need%20help." target="_blank" rel="noopener">◉ WhatsApp पर मदद लें</a></section>`
}
const notificationRenderBefore=render;
render=function(){notificationRenderBefore();if(tab==='notifications'&&!active&&!demoLoggedOut){document.querySelector('.content').innerHTML=notificationPage();if(typeof localizePage==='function')localizePage()}};
render();
