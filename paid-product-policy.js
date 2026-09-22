/* Paid-product confirmation and ₹500 unpaid-order recharge rule. */
(function () {
  const LIMIT = 500, DRAFT_KEY = 'local_delivery_paid_post_draft_v1';
  const session = () => { try { return JSON.parse(localStorage.getItem('aditya_studio_session_v1') || localStorage.getItem('aditya_studio_persistent_login_v2') || 'null'); } catch (_) { return null; } };
  const paid = form => !!form?.elements?.alreadyPurchased?.checked;
  const productAmount = form => Math.max(0, Math.round(Number(form?.elements?.items?.value) || 0));
  const deliveryFee = form => Math.max(0, Math.round(Number(form?.elements?.fee?.value) || 0));
  const balance = () => Number(state?.users?.[user]?.balance || 0);

  function saveDraft(form) {
    const values = {};
    new FormData(form).forEach((value, key) => { if (typeof value === 'string') values[key] = value; });
    values.alreadyPurchased = !!form.elements.alreadyPurchased?.checked;
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(values)); } catch (_) {}
  }
  function restoreDraft(form) {
    let values; try { values = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null'); } catch (_) {}
    if (!values) return;
    Object.entries(values).forEach(([key, value]) => {
      const field = form.elements[key]; if (!field) return;
      if (field.type === 'checkbox') field.checked = !!value; else field.value = value;
    });
  }
  function showNeed(form) {
    const box = document.getElementById('postMoneyNeed'); if (!box) return;
    if (paid(form)) { box.innerHTML = '<div class="post-wallet-ok">✓ Product पहले से paid है। Product amount wallet में नहीं जुड़ेगी या lock नहीं होगी। केवल delivery fee final confirmation पर लागू होगी।</div>'; return; }
    const amount = productAmount(form) + deliveryFee(form);
    if (amount <= LIMIT) { box.innerHTML = '<div class="post-wallet-ok">✓ Product + delivery total ₹500 तक है। अभी Add Money की जरूरत नहीं है।</div>'; return; }
    const need = Math.max(0, amount - balance());
    box.innerHTML = '<div class="post-wallet-short post-recharge-card"><strong>⚠️ Wallet recharge की जरूरत है</strong><span><b>Product ₹' + productAmount(form) + ' + delivery ₹' + deliveryFee(form) + ' = ₹' + amount + '</b></span><span>₹500 से अधिक total के लिए post करने से पहले wallet recharge करें। अभी ₹' + need + ' कम है।</span><a class="btn add-money-glow" href="/add-money?return=%2Flocal-delivery">📷 QR Scan करके Add Money करें</a><small>आपकी भरी हुई post details सुरक्षित हैं। Recharge के बाद यहीं वापस आएंगी।</small></div>';
  }
  function hydrate() {
    const form = document.getElementById('broadcastForm'); if (!form || form.dataset.paidPolicyReady) return;
    form.dataset.paidPolicyReady = '1';
    const order = state?.orders?.find(o => String(o.id) === String(active));
    if (order?.alreadyPurchased) form.elements.alreadyPurchased.checked = true;
    restoreDraft(form); showNeed(form);
  }
  // Older submit code checks the demo wallet before this policy listener runs.
  // The server remains authoritative; this lets the inline ₹500 policy decide.
  if (!window.__paidPostOriginalAvailable) {
    window.__paidPostOriginalAvailable = DeliveryEngine.available;
    DeliveryEngine.available = (...args) => document.getElementById('broadcastForm')
      ? Number.MAX_SAFE_INTEGER : window.__paidPostOriginalAvailable(...args);
  }
  document.addEventListener('change', e => {
    if (e.target.name !== 'alreadyPurchased' || !e.target.form?.matches('#broadcastForm')) return;
    if (e.target.checked && !confirm('यह tick केवल तब करें जब दुकान को सामान का पूरा payment पहले ही हो चुका है। Paid product की रकम wallet में नहीं जुड़ेगी। क्या confirm है?')) e.target.checked = false;
    showNeed(e.target.form);
  }, true);
  document.addEventListener('input', e => { if (e.target.form?.matches('#broadcastForm') && ['items','fee'].includes(e.target.name)) showNeed(e.target.form); }, true);
  document.addEventListener('click', e => {
    const add = e.target.closest('#postMoneyNeed a[href*="add-money"]');
    if (add) {
      saveDraft(add.closest('form') || document.getElementById('broadcastForm'));
      try { sessionStorage.setItem('local_delivery_view_v1', JSON.stringify({ tab: 'post', active: null })); } catch (_) {}
    }
  }, true);
  // This runs on window before the older document submit handler. It prevents
  // that handler from trying a wallet lock first and gives the user the inline
  // recharge card immediately.
  window.addEventListener('submit', e => {
    const form = e.target;
    if (!form?.matches?.('#broadcastForm') || paid(form)) return;
    const amount = productAmount(form) + deliveryFee(form);
    if (amount <= LIMIT || balance() >= amount) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    saveDraft(form); showNeed(form);
    const card = document.getElementById('postMoneyNeed');
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, true);
  document.addEventListener('submit', e => {
    const form = e.target;
    if (!form?.matches('#broadcastForm')) return;
    const amount = paid(form) ? 0 : productAmount(form) + deliveryFee(form);
    if (amount > LIMIT && balance() < amount) {
      e.preventDefault(); e.stopImmediatePropagation(); saveDraft(form); showNeed(form); document.getElementById('postMoneyNeed')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return;
    }
    // Existing paid posts can be edited/reposted without a new wallet lock.
    const original = DeliveryEngine.available;
    DeliveryEngine.available = () => Number.MAX_SAFE_INTEGER;
    setTimeout(() => { DeliveryEngine.available = original; }, 0);
  }, true);
  new MutationObserver(hydrate).observe(document.documentElement, { childList: true, subtree: true });
  window.showPaidPostMoneyNeed = showNeed;
  hydrate();
})();
