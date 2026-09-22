/* Final, page-level guard for the Local Delivery post form. */
(function () {
  const LIMIT = 500;
  const DRAFT = 'local_delivery_paid_post_draft_v1';
  const form = () => document.getElementById('broadcastForm');
  const districts = ['रायपुर','बिलासपुर','दुर्ग','कोरबा','रायगढ़','राजनांदगांव','जगदलपुर','सरगुजा','महासमुंद','जांजगीर-चांपा','कबीरधाम','धमतरी','बस्तर','बालोद','बलौदाबाजार-भाटापारा','बलरामपुर','बेमेतरा','बीजापुर','दंतेवाड़ा','गरियाबंद','जशपुर','कांकेर','कोंडागांव','खैरागढ़-छुईखदान-गंडई','मनेन्द्रगढ़-चिरमिरी-भरतपुर','मोहला-मानपुर-अंबागढ़ चौकी','मुंगेली','नारायणपुर','गौरेला-पेण्ड्रा-मरवाही','सक्ती','सारंगढ़-बिलाईगढ़','सुकमा','सूरजपुर'];
  const districtPicker = f => {
    const input = f?.elements?.district;
    if (!input || input.tagName === 'SELECT') return;
    const select = document.createElement('select');
    select.name = 'district'; select.required = true; select.className = input.className;
    const value = districts.includes(input.value) ? input.value : 'रायपुर';
    select.innerHTML = districts.map(d => '<option value="' + d + '"' + (d === value ? ' selected' : '') + '>' + d + '</option>').join('');
    input.replaceWith(select);
  };
  const amount = f => Math.max(0, Math.round(Number(f?.elements?.items?.value || 0))) + Math.max(0, Math.round(Number(f?.elements?.fee?.value || 0)));
  const paid = f => !!f?.elements?.alreadyPurchased?.checked;
  const balance = () => Number((document.querySelector('.wallet-chip,.wallet')?.textContent || '0').replace(/[^0-9]/g, '')) || 0;
  const save = f => {
    if (!f) return;
    const data = {};
    new FormData(f).forEach((v, k) => { data[k] = String(v); });
    data.alreadyPurchased = paid(f);
    try { sessionStorage.setItem(DRAFT, JSON.stringify(data)); sessionStorage.setItem('local_delivery_view_v1', JSON.stringify({ tab: 'post', active: null })); } catch (_) {}
  };
  const show = f => {
    if (!f) return;
    let box = document.getElementById('postMoneyNeed');
    // The request form is rendered by a later template.  Keep a fallback here so
    // a missing placeholder can never silently hide the recharge instruction.
    if (!box) {
      box = document.createElement('div');
      box.id = 'postMoneyNeed';
      const submit = f.querySelector('button[type="submit"]');
      if (submit) f.insertBefore(box, submit); else f.appendChild(box);
    }
    const total = amount(f), totalEl = document.getElementById('postTotal');
    if (totalEl) totalEl.textContent = '₹' + total.toLocaleString('en-IN');
    if (paid(f) || total <= LIMIT || balance() >= total) { box.innerHTML = ''; return; }
    const short = Math.max(0, total - balance());
    box.innerHTML = '<div class="post-wallet-short post-recharge-card"><strong>⚠️ Wallet balance कम है</strong><span>Product + delivery total <b>₹' + total.toLocaleString('en-IN') + '</b> है। Wallet में अभी <b>₹' + balance().toLocaleString('en-IN') + '</b> है।</span><span>Post करने के लिए ₹' + short.toLocaleString('en-IN') + ' add करें।</span><a class="btn add-money-glow" href="/add-money?return=%2Flocal-delivery">📷 Add Money · QR Scan</a><small>नीचे के Add Money button को दबाने तक payment page नहीं खुलेगा। आपकी भरी हुई details safe हैं।</small></div>';
  };
  const showTimeError = f => {
    const date = String(f?.elements?.neededDate?.value || ''), time = String(f?.elements?.neededTime?.value || '');
    const box = document.getElementById('postTimeNeed');
    if (!box || !date || !time) return false;
    if (new Date(date + 'T' + time + ':00').getTime() > Date.now()) { box.innerHTML = ''; return false; }
    box.innerHTML = '<div class="post-wallet-short"><strong>⏰ यह समय निकल चुका है</strong><span>आज के लिए आगे का time या अगली तारीख चुनें।</span></div>';
    return true;
  };
  window.localDeliveryPostClick = f => {
    show(f);
    if (showTimeError(f)) { save(f); return false; }
    if (!paid(f) && amount(f) > LIMIT && balance() < amount(f)) {
      save(f); show(f); document.getElementById('postMoneyNeed')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }
    return true;
  };
  document.addEventListener('input', e => { const f = e.target.form; if (f?.id !== 'broadcastForm') return; save(f); show(f); }, true);
  document.addEventListener('change', e => { const f = e.target.form; if (f?.id !== 'broadcastForm') return; save(f); show(f); }, true);
  document.addEventListener('click', e => {
    const button = e.target.closest?.('#broadcastForm button[type="submit"]');
    if (!button) return;
    const f = button.form;
    show(f);
    if (showTimeError(f)) { e.preventDefault(); e.stopImmediatePropagation(); save(f); return; }
    if (paid(f) || amount(f) <= LIMIT || balance() >= amount(f)) return;
    e.preventDefault(); e.stopImmediatePropagation(); save(f); show(f);
    document.getElementById('postMoneyNeed')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, true);
  document.addEventListener('submit', e => {
    const f = e.target;
    if (f?.id !== 'broadcastForm') return;
    show(f);
    if (showTimeError(f) || (!paid(f) && amount(f) > LIMIT && balance() < amount(f))) {
      e.preventDefault(); e.stopImmediatePropagation(); save(f); show(f);
      document.getElementById('postMoneyNeed')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, true);
  const watch = new MutationObserver(() => { const f = form(); if (f) { districtPicker(f); show(f); } });
  watch.observe(document.documentElement, { childList: true, subtree: true });
  districtPicker(form()); show(form());
})();
