(function(){
  function addContact(){
    const heading=document.querySelector('.tracking-page .live-heading');
    if(!heading||document.getElementById('deliveryContactCard'))return;
    const order=(typeof state!=='undefined'&&Array.isArray(state.orders)?state.orders:[]).find(o=>o&&o.owner===user&&o.providerMobile&&['booked','delivering'].includes(String(o.status||'')));
    if(!order)return;
    const phone=String(order.providerMobile||'').replace(/\D/g,'').slice(-10);
    if(!/^[6-9]\d{9}$/.test(phone))return;
    const card=document.createElement('section');
    card.id='deliveryContactCard'; card.className='track-panel';
    const title=document.createElement('h2');title.textContent='📞 Delivery boy contact';
    const label=document.createElement('p');label.textContent=String(order.providerName||'Delivery boy');
    const call=document.createElement('a');call.href='tel:'+phone;call.className='track-help';call.textContent='📞 '+phone+' को call करें';
    card.append(title,label,call);heading.insertAdjacentElement('afterend',card);
  }
  new MutationObserver(addContact).observe(document.documentElement,{childList:true,subtree:true});
  setInterval(addContact,1000); addContact();
})();