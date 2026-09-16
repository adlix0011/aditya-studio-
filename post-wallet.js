function postRequiredAmount(form){
 if(form.elements.alreadyPurchased?.checked)return 0;
 const items=Number(form.elements.items?.value)||0;
 const fee=Number(form.elements.fee?.value)||0;
 return items>=0&&fee>0?items+fee:0;
}
function showPostMoneyNeed(form,required=postRequiredAmount(form)){
  const box=document.getElementById('postMoneyNeed');
  if(!box)return;
 if(form.elements.alreadyPurchased?.checked){box.innerHTML='<div class="post-wallet-ok">✓ Product पहले से paid है। Customer wallet से कोई रकम lock नहीं होगी।</div>';return}
 const shortage=Math.max(0,required-DeliveryEngine.available(state,user));
 if(!shortage){box.innerHTML=`<div class="post-wallet-ok">✓ Wallet में ${money(DeliveryEngine.available(state,user))} उपलब्ध है। Post करने पर ${money(required)} lock होगी।</div>`;return}
 box.innerHTML=`<div class="post-wallet-short"><strong>Wallet में ${money(shortage)} कम है</strong><span>Post करने के लिए कुल ${money(required)} चाहिए।</span><a class="btn" href="/add-money?return=%2Flocal-delivery">＋ पैसा ऐड करें</a></div>`;
}
function refreshPostMoneyNeed(form){
 if(!form?.matches('#broadcastForm'))return;
 showPostMoneyNeed(form);
}
document.addEventListener('input',e=>{if(['items','fee'].includes(e.target.name))refreshPostMoneyNeed(e.target.form)});
document.addEventListener('change',e=>{if(e.target.name==='alreadyPurchased')refreshPostMoneyNeed(e.target.form)});
const postWalletRenderBefore=render;
render=function(){postWalletRenderBefore();const form=document.getElementById('broadcastForm');if(form)showPostMoneyNeed(form)};
render();

document.addEventListener('submit',e=>{const f=e.target;if(f.id!=='broadcastForm'||!f.checkValidity())return;const required=postRequiredAmount(f);if(required&&DeliveryEngine.available(state,user)<required){e.preventDefault();e.stopImmediatePropagation();location.href='/add-money?return=%2Flocal-delivery';}},true);
