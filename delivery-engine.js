/* Local-demo state machine. No real payment or identity security is provided here. */
const DeliveryEngine=(()=>{
 const locked=o=>Number(o.customerHold)>0||Number(o.helperHold)>0||['chat','booked','delivering','disputed'].includes(o.status);
 const total=o=>o.items+o.fee;
 const holds=(s,id)=>s.orders.reduce((n,o)=>n+(locked(o)?(o.owner===id?(o.customerHold??(['booked','delivering'].includes(o.status)?total(o):0)):0)+(o.provider===id?(o.helperHold||0):0):0),0);
 const available=(s,id)=>s.users[id].balance-holds(s,id);
 const fail=message=>{throw Error(message)};
 const note=(o,text)=>o.messages.push({sender:'system',text,time:new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})});
 function reserve(s,o,items=o.items,fee=o.fee){
  const oldCustomer=Number(o.customerHold)||0;
  const oldHelper=Number(o.helperHold)||0;
  if(available(s,o.owner)+oldCustomer<items+fee)fail('Customer के wallet में रकम कम है। पहले पैसे जोड़ें।');
  if(!o.provider||available(s,o.provider)+oldHelper<items)fail('Delivery करने वाले के wallet में सामान की कीमत जितना deposit नहीं है।');
  o.customerHold=items+fee;o.helperHold=items;
 }
 function otpCode(){const a=new Uint32Array(1);do{crypto.getRandomValues(a)}while(a[0]>=4294800000);return String(100000+a[0]%900000)}
 function run(s,id,actor,action,data={},now=Date.now()){
  const o=s.orders.find(o=>o.id===id);if(!o||!s.users[actor])fail('ऑर्डर नहीं मिला।');
  const owner=o.owner===actor,helper=o.provider===actor,member=owner||helper;
  if(action==='accept'){
   if(o.status!=='open'||owner)fail('यह काम स्वीकार नहीं कर सकते।');
   o.provider=actor;reserve(s,o);o.status='chat';o.providerDone=false;o.ownerDone=false;o.otp=null;o.cancelBy=null;
   note(o,'काम स्वीकार हुआ। Customer के ₹'+o.customerHold+' और helper का ₹'+o.helperHold+' deposit lock है। Customer की booking confirmation बाकी है।');
  }else if(action==='book'){
   if(!owner||o.status!=='chat'||o.proposal)fail('पहले बातचीत और रकम की सहमति पूरी करें।');
   reserve(s,o);o.status='booked';note(o,'Customer ने booking confirm की। सामान मिलने के बाद ही delivery OTP दें।');
  }else if(action==='cancel'||action==='release'||action==='leave'){
   if(!(owner&&o.status==='open'||['chat'].includes(o.status)&&(owner||helper)))fail('Booking के बाद दोनों की सहमति से ही cancel करें।');
   if(o.status==='open'){o.customerHold=0;o.status='cancelled';note(o,'मांग रद्द हो गई। Customer की रकम wallet में वापस unlock हो गई।')}
   else{o.status=action==='cancel'?'cancelled':'open';o.customerHold=0;o.helperHold=0;o.provider=null;o.proposal=null;o.otp=null;o.ownerDone=false;o.providerDone=false;note(o,'Booking से पहले काम छोड़ा गया। दोनों की रकम unlock हो गई।')}
  }else if(['agree','reject','withdraw'].includes(action)){
   if(!member||!['chat','booked'].includes(o.status)||o.ownerDone||!o.proposal)fail('यह price proposal उपलब्ध नहीं है।');
   const p=o.proposal;if(action==='withdraw'?p.by!==actor:p.by===actor)fail('दूसरे user की सहमति जरूरी है।');
   if(action==='agree'){reserve(s,o,p.items,p.fee);o.items=p.items;o.fee=p.fee;o.otp=null;note(o,'नई रकम मंज़ूर। Customer lock ₹'+o.customerHold+'; helper deposit ₹'+o.helperHold+'.')}
   else note(o,action==='reject'?'नई रकम मंज़ूर नहीं हुई। पुरानी रकम कायम है।':'Price proposal वापस लिया गया।');o.proposal=null;
  }else if(action==='propose'){
   if(!member||!['chat','booked'].includes(o.status)||o.ownerDone||o.cancelBy)fail('इस समय रकम नहीं बदल सकते।');
   if(!Number.isSafeInteger(data.items)||!Number.isSafeInteger(data.fee)||data.items<0||data.fee<1||data.items>100000||data.fee>100000)fail('सही रकम पूरे रुपये में भरें।');
   if(data.items===o.items&&data.fee===o.fee)fail('पहले रकम बदलें।');o.proposal={items:data.items,fee:data.fee,by:actor};note(o,'नई रकम का सुझाव: सामान ₹'+data.items+' + delivery ₹'+data.fee+'. दूसरे user की सहमति बाकी है।');
  }else if(action==='otp'){
   if(!owner||!['booked','delivering'].includes(o.status)||o.proposal||o.cancelBy)fail('Booking और price agreement के बाद OTP बनेगा।');
   reserve(s,o);
   if(o.otp&&now-o.otp.createdAt<30000)fail('नया OTP बनाने से पहले 30 सेकंड रुकें।');
   if(o.otp?.blockedUntil>now)fail('गलत attempts के कारण OTP अभी lock है। एक मिनट बाद कोशिश करें।');
   o.ownerDone=true;o.status='delivering';o.otp={code:otpCode(),createdAt:now,expiresAt:now+600000,attempts:0,blockedUntil:0};note(o,'Customer ने सामान मिलने की पुष्टि की। Delivery OTP तैयार है; code केवल customer view में दिखेगा।');
  }else if(action==='verify'){
   if(!helper||o.status!=='delivering'||!o.ownerDone||o.proposal||o.cancelBy||!o.otp)fail('Customer को पहले सामान check करके OTP बनाना है।');
   if(o.otp.blockedUntil>now)fail('OTP attempts lock हैं। एक मिनट बाद कोशिश करें।');
   if(o.otp.expiresAt<=now)fail('OTP expire हो गया। Customer से नया OTP बनवाएं।');
   if(!/^\d{6}$/.test(String(data.code)))fail('6 अंकों का OTP भरें।');
   if(o.otp.code!==String(data.code)){o.otp.attempts++;if(o.otp.attempts>=5){o.otp.blockedUntil=now+60000;o.otp.attempts=0}return {message:o.otp.blockedUntil>now?'5 गलत OTP। एक मिनट के लिए रोक दिया गया।':'गलत OTP। Customer से code दोबारा पूछें।',error:true};}
   reserve(s,o);const amount=total(o);s.users[o.owner].balance-=amount;s.users[o.provider].balance+=amount;o.providerDone=true;o.status='completed';o.customerHold=0;o.helperHold=0;o.otp=null;o.settledAt=now;
   for(const [user,amount]of [[o.owner,-total(o)],[o.provider,total(o)]])s.transactions.push({user,amount,label:o.title+' · OTP delivery',date:new Date(now).toLocaleString('en-IN')});note(o,'OTP verified। Payment ₹'+amount+' helper को transfer; helper का पूरा deposit unlock।');
  }else if(action==='dispute'){
   if(!member||!['booked','delivering'].includes(o.status))fail('इस ऑर्डर पर शिकायत नहीं खोल सकते।');if(!String(data.reason||'').trim())fail('समस्या लिखें।');
   o.status='disputed';o.dispute={by:actor,reason:String(data.reason).trim().slice(0,1000),at:now};o.otp=null;o.cancelBy=null;note(o,'शिकायत: '+o.dispute.reason+'। दोनों की रकम hold है। कोई automatic deduction नहीं होगा।');
  }else if(action==='cancel-request'){
   if(!member||!['booked','delivering','disputed'].includes(o.status))fail('Cancel request उपलब्ध नहीं है।');
   if(o.cancelBy&&o.cancelBy!==actor){o.status='cancelled';o.customerHold=0;o.helperHold=0;o.otp=null;o.cancelBy=null;note(o,'दोनों ने बिना payment cancellation मंज़ूर किया। Customer और helper की रकम unlock।');}
   else{o.cancelBy=actor;o.otp=null;note(o,'बिना payment cancel करने का अनुरोध। सामान/खर्च का हिसाब तय करके दूसरा user मंज़ूर करे।');}
  }else if(action==='cancel-reject'){
   if(!member||!o.cancelBy||o.cancelBy===actor)fail('यह cancellation request उपलब्ध नहीं है।');o.cancelBy=null;note(o,'Cancellation मंज़ूर नहीं हुआ। रकम hold है।');
  }else fail('यह action उपलब्ध नहीं है।');
  return {message:'बदलाव सेव हो गए।'};
 }
 return {holds,available,run};
})();
if(typeof module!=='undefined')module.exports=DeliveryEngine;

