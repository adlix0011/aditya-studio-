/* Final, page-level guard for the Local Delivery post form. */
(function () {
  const LIMIT = 500;
  const DRAFT = 'local_delivery_paid_post_draft_v1';
  const form = () => document.getElementById('broadcastForm');
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
    const box = document.getElementById('postMoneyNeed'); if (!box || !f) return;
    const total = amount(f), totalEl = document.getElementById('postTotal');
    if (totalEl) totalEl.textContent = '₹' + total.toLocaleString('en-IN');
    if (paid(f) || total <= LIMIT || balance() >= total) return;
    const short = Math.max(0, total - balance());
    box.innerHTML = '<div class="post-wallet-short post-recharge-card"><strong>⚠️ Wallet balance कम है</strong><span>Product + delivery total <b>₹' + total.toLocaleString('en-IN') + '</b> है। Wallet में अभी <b>₹' + balance().toLocaleString('en-IN') + '</b> है।</span><span>Post करने के लिए ₹' + short.toLocaleString('en-IN') + ' add करें।</span><a class="btn add-money-glow" href="/add-money?return=%2Flocal-delivery">📷 Add Money · QR Scan</a><small>नीचे के Add Money button को दबाने तक payment page नहीं खुलेगा। आपकी भरी हुई details safe हैं।</small></div>';
  };
  document.addEventListener('input', e => { const f = e.target.form; if (f?.id !== 'broadcastForm') return; save(f); show(f); }, true);
  document.addEventListener('change', e => { const f = e.target.form; if (f?.id !== 'broadcastForm') return; save(f); show(f); }, true);
  document.addEventListener('click', e => {
    const button = e.target.closest?.('#broadcastForm button[type="submit"]');
    if (!button) return;
    const f = button.form;
    if (paid(f) || amount(f) <= LIMIT || balance() >= amount(f)) return;
    e.preventDefault(); e.stopImmediatePropagation(); save(f); show(f);
    document.getElementById('postMoneyNeed')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, true);
  const watch = new MutationObserver(() => { const f = form(); if (f) show(f); });
  watch.observe(document.documentElement, { childList: true, subtree: true });
  show(form());
})();
