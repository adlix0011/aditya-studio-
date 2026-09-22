/* Shows the delivery helper a clear five-minute wait after the default offer. */
(function () {
  const WAIT_MS = 5 * 60 * 1000;
  let expiringOrderId = '';

  function currentSession() {
    try { return JSON.parse(localStorage.getItem('aditya_studio_session_v1') || localStorage.getItem('aditya_studio_persistent_login_v2') || 'null'); }
    catch (_) { return null; }
  }

  function sameMobile(a, b) { return String(a || '').replace(/\D/g, '').slice(-10) === String(b || '').replace(/\D/g, '').slice(-10); }

  function pendingConfirmation() {
    const session = currentSession();
    if (!session || typeof state === 'undefined' || !Array.isArray(state.orders)) return null;
    return state.orders.find(function (order) {
      if (order.status !== 'chat' || sameMobile(order.ownerMobile, session.mobile)) return false;
      const candidate = (order.candidateSessions || []).find(function (item) { return sameMobile(item.mobile, session.mobile); });
      return candidate && candidate.deliveryConfirmRequest && candidate.deliveryConfirmRequest.status === 'pending'
        ? { order: order, request: candidate.deliveryConfirmRequest } : false;
    }) || null;
  }

  function formatRemaining(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }

  async function expireRequest(item) {
    if (!item || expiringOrderId === item.order.id) return;
    expiringOrderId = item.order.id;
    const session = currentSession();
    try {
      await fetch('/api/local-delivery/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: session.mobile, sessionToken: session.sessionToken, action: 'delivery-confirm-expire', orderId: item.order.id })
      });
      await window.syncStudioWallet?.();
    } catch (_) { expiringOrderId = ''; }
  }

  function renderWaitingCard() {
    const item = pendingConfirmation();
    const card = document.querySelector('.chat-default-options');
    if (!item || !card) return;
    const deadline = new Date(item.request.expiresAt || (new Date(item.request.createdAt).getTime() + WAIT_MS)).getTime();
    const remaining = deadline - Date.now();
    if (card.dataset.confirmationDeadline === String(deadline)) {
      if (remaining <= 0) expireRequest(item);
      return;
    }
    card.classList.add('confirmation-wait-card');
    card.dataset.confirmationDeadline = String(deadline);
    card.innerHTML = '<div><strong>⏳ Customer confirmation का इंतज़ार करें</strong>'
      + '<p>आपकी ₹' + Number(item.order.fee || 0) + ' delivery request customer को भेज दी गई है।</p>'
      + '<div class="confirmation-countdown" data-confirmation-deadline="' + deadline + '">⏱️ ' + formatRemaining(remaining) + '</div>'
      + '<small>Customer accept करते ही countdown हटेगा और pickup process आगे बढ़ेगा।</small></div>';
    if (remaining <= 0) expireRequest(item);
  }

  function tick() {
    renderWaitingCard();
    document.querySelectorAll('[data-confirmation-deadline]').forEach(function (node) {
      const left = Number(node.dataset.confirmationDeadline || 0) - Date.now();
      const label = left > 0 ? '⏱️ ' + formatRemaining(left) : '⏱️ समय पूरा हो रहा है…';
      if (node.textContent !== label) node.textContent = label;
    });
  }

  new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
})();
