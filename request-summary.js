function requestSummary(o){
 const description=String(o.description||'').replace(/\\n/g,'\n');
 const quantity=String(o.quantity||'').trim()||description.match(/(?:^|\n)मात्रा:\s*([^\n]+)/)?.[1]?.trim()||'मात्रा नहीं बताई';
 const route=String(o.area||'').split('→').map(s=>s.trim());
 return {quantity,pickup:route[0]||'जगह नहीं बताई',dropoff:String(o.deliveryVillage||'').trim()||(route.length===2?route[1]:'')||'गांव नहीं बताया'};
}
if(typeof module!=='undefined')module.exports={requestSummary};
