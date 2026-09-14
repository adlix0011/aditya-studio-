// Local keyword matching: no upload, API call or generated product photo needed.
const itemIconRules = [
 ['🍚','rice|chawal|chaval|चावल'],['🌾','atta|aata|flour|wheat|gehun|gehu|seeds|seed|आटा|गेहूं|गेहूँ|बीज'],
 ['🥛','milk|doodh|dudh|दूध'],['🥣','dal|daal|lentils|दाल'],['🧂','salt|namak|नमक'],['🍬','sugar|chini|cheeni|चीनी|शक्कर'],
 ['🛢️','oil|tel|तेल'],['🥔','potato|potatoes|aloo|alu|आलू'],['🍅','tomato|tomatoes|tamatar|टमाटर'],['🧅','onion|onions|pyaz|pyaaz|प्याज|प्याज़'],
 ['🥬','vegetable|vegetables|sabzi|sabji|सब्जी|सब्ज़ी|सब्जियां'],['🍎','apple|apples|seb|सेब'],['🍌','banana|bananas|kela|केला|केले'],
 ['🍇','grapes|angoor|अंगूर'],['🥭','mango|mangoes|aam|आम'],['🍊','orange|oranges|santra|संतरा'],['🍉','watermelon|tarbuj|tarbooz|तरबूज'],
 ['🥚','egg|eggs|anda|ande|अंडा|अंडे'],['🍗','chicken|murga|meat|mutton|चिकन|मुर्गा|मांस'],['🐟','fish|machli|machhli|मछली'],
 ['🍞','bread|ब्रेड'],['🧈','butter|ghee|makhan|घी|मक्खन'],['🧀','paneer|cheese|पनीर|चीज़'],['🍪','biscuit|biscuits|cookies|बिस्कुट'],
 ['☕','tea|chai|coffee|चाय|कॉफी'],['💧','water|pani|paani|पानी'],['🥤','juice|cold drink|जूस'],
 ['💊','medicine|medicines|dawai|dawa|dava|tablet|tablets|pharmacy|दवाई|दवा|दवाइयां|दवाइयाँ'],
 ['📓','notebook|notebooks|copy|copies|stationery|कॉपी|कापी|स्टेशनरी'],['📚','book|books|kitab|kitabe|किताब|किताबें'],['🖊️','pen|pens|pencil|pencils|पेन|पेंसिल'],
 ['🔌','charger|wire|cable|चार्जर|तार'],['🔋','battery|batteries|बैटरी'],['💡','bulb|light bulb|बल्ब'],['🔧','tools|tool|hardware|auzar|औजार|हार्डवेयर'],
 ['🧼','soap|sabun|साबुन'],['🧴','shampoo|detergent|शैम्पू|शैंपू|डिटर्जेंट'],['👕','shirt|clothes|kapde|कपड़े|शर्ट'],['👟','shoes|shoe|jute|जूते'],
 ['🥡','food|khana|खाना'],['🛒','grocery|groceries|ration|rashan|rasan|kirana|राशन|किराना'],['📦','parcel|package|courier|पार्सल|कूरियर']
].map(([emoji,words])=>({emoji,pattern:new RegExp('(^|[^\\p{L}\\p{N}])(?:'+words+')(?=$|[^\\p{L}\\p{N}])','iu')}));
function itemEmoji(order){
 const find=text=>itemIconRules.map(r=>({emoji:r.emoji,match:r.pattern.exec(String(text||'').normalize('NFKC'))})).filter(r=>r.match).sort((a,b)=>a.match.index-b.match.index).map(r=>r.emoji);
 const matches=find(order.title);const chosen=matches.length?matches:find(order.description);
 return chosen.length?[...new Set(chosen)].slice(0,3).join(' '):({Groceries:'🛒',Pickup:'📦',Shopping:'🛍️',Other:'📦'}[order.category]||'📦');
}
if(typeof module!=='undefined')module.exports={itemEmoji};
