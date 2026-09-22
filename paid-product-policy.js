/* Paid-product safety: confirmation, ₹500 no-wallet limit, and recharge draft restore. */
(function () {
  const LIMIT = 500, DRAFT_KEY = 'local_delivery_paid_post_draft_v1';
  const session = () => { try { return JSON.parse(localStorage.getItem('aditya_studio_session_v1') || localStorage.getItem('aditya_studio_persistent_login_v2') || 'null'); } catch (_) { return null; } };
  const paid = form => !!form?.elements?.alreadyPurchased?.checked;
  const productAmount = form => Math.max(0, Math.round(Number(form?.elements?.items?.value) || 0));
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
    sessionStorage.removeItem(DRAFT_KEY);
  }
  function showNeed(form) {
    const box = document.getElementById('postMoneyNeed'); if (!box || !paid(form)) return;
    const amount = productAmount(form);
    if (amount <= LIMIT) { box.innerHTML = '<div class="post-wallet-ok">✓ Paid product ₹500 तक है। Wallet lock नहीं लगेगा।</div>'; return; }
    const need = Math.max(0, amount - balance());
    box.innerHTML = '<div class="post-wallet-short"><strong>⚠️ ₹500 से अधिक paid product</strong><span>इस product के लिए wallet में ₹' + amount + ' रखना जरूरी है। अभी ₹' + need + ' कम है।</span><a class="btn add-money-glow" href="/add-money?return=%2Flocal-delivery">💰 Add Money</a></div>';
  }
  function hydrate() {
    const form = document.getElementById('broadcastForm'); if (!form || form.dataset.paidPolicyReady) return;
    form.dataset.paidPolicyReady = '1';
    const order = state?.orders?.find(o => String(o.id) === String(active));
    if (order?.alreadyPurchased) form.elements.alreadyPurchased.checked = true;
    restoreDraft(form); showNeed(form);
  }
  document.addEventListener('change', e => {
    if (e.target.name !== 'alreadyPurchased' || !e.target.form?.matches('#broadcastForm')) return;
    if (e.target.checked && !confirm('यह tick केवल तब करें जब दुकान को सामान का पूरा payment पहले ही हो चुका है। Paid product में ₹500 तक ही बिना wallet पैसे के post कर सकते हैं। क्या confirm है?')) e.target.checked = false;
    showNeed(e.target.form);
  }, true);
  document.addEventListener('input', e => { if (e.target.form?.matches('#broadcastForm') && e.target.name === 'items') showNeed(e.target.form); }, true);
  document.addEventListener('click', e => {
    const add = e.target.closest('#postMoneyNeed a[href*="add-money"]');
    if (add) saveDraft(add.closest('form') || document.getElementById('broadcastForm'));
  }, true);
  document.addEventListener('submit', e => {
    const form = e.target;
    if (!form?.matches('#broadcastForm') || !paid(form)) return;
    const amount = productAmount(form);
    if (amount > LIMIT && balance() < amount) {
      e.preventDefault(); e.stopImmediatePropagation(); saveDraft(form); showNeed(form); toast('₹500 से अधिक paid product के लिए पहले Add Money करें। आपका भरा हुआ post सुरक्षित है।'); return;
    }
    // Existing paid posts can be edited/reposted without a new wallet lock.
    const original = DeliveryEngine.available;
    DeliveryEngine.available = () => Number.MAX_SAFE_INTEGER;
    setTimeout(() => { DeliveryEngine.available = original; }, 0);
  }, true);
  new MutationObserver(hydrate).observe(document.documentElement, { childList: true, subtree: true });
  hydrate();
})();
