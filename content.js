// ============================================================
// Wardyati Auto-Book — Content Script v1.2
// Fixes: multi-shift queue + rate limit cooldown awareness
// ============================================================

// ── Rate Limit Detection ─────────────────────────────────────
function getRateLimitInfo() {
  try {
    const waitEl = document.getElementById('rate_limiting_waiting_message');
    const isWaiting = waitEl && !waitEl.classList.contains('d-none');
    const remEl = document.getElementById('rate_limiting_remaining_message');
    const match = remEl ? remEl.textContent.match(/(\d+)/) : null;
    const remaining = match ? parseInt(match[1]) : 1;
    return { isWaiting, remaining };
  } catch { return { isWaiting: false, remaining: 1 }; }
}

// ── Shift Detection ──────────────────────────────────────────
function getShifts() {
  const shifts = [];
  document.querySelectorAll('.arena_shift_instance').forEach(el => {
    const id = el.dataset.shiftInstanceId;
    const nameEl = el.querySelector('.text-start.text-truncate');
    const name = nameEl ? nameEl.textContent.trim() : `Shift ${id}`;
    const holdBtn = el.querySelector('.button_hold');
    const isVisible = holdBtn && !holdBtn.classList.contains('d-none');
    const isOpen = isVisible && !holdBtn.disabled;
    const remainingEl = el.querySelector('.remaining_holdings_count .number-container');
    const remaining = remainingEl ? parseInt(remainingEl.dataset.number) : '?';
    const holderEl = el.querySelector('[id$="_holder_count_text"]');
    const holderText = holderEl ? holderEl.textContent.trim() : '?';
    const isHolder = el.dataset.isHolder === 'true';
    const isFull = remaining === 0;
    shifts.push({ id, name, isOpen, isVisible, remaining, holderText, isHolder, isFull });
  });
  return shifts;
}

function getCountdown() {
  const el = document.getElementById('coord_countdown');
  return el ? el.textContent.trim() : null;
}

// ── State ────────────────────────────────────────────────────
let shiftQueue = [];
let isArmed = false;
let pollInterval = null;
let cooldownTimeout = null;
let countdownInterval = null;
let currentTarget = null;
let isCoolingDown = false;
const RATE_LIMIT_WINDOW_MS = 30000; // fallback only if DOM detection fails

// ── Core Booking Logic ───────────────────────────────────────
function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    if (!isArmed || !currentTarget) return;
    const { isWaiting } = getRateLimitInfo();
    if (isWaiting) {
      if (!isCoolingDown) {
        isCoolingDown = true;
        log('Rate limited — watching DOM for unlock (16ms)', 'warn');
        renderShifts();
        updateSelectedInfo();
        // Poll every 16ms until the site's own waiting message disappears
        // This is faster than any fixed timer — fires the frame it unlocks
        const waitPoll = setInterval(() => {
          const { isWaiting: stillWaiting } = getRateLimitInfo();
          if (!stillWaiting) {
            clearInterval(waitPoll);
            isCoolingDown = false;
            log('Rate limit cleared — firing next shift', 'info');
            updateSelectedInfo();
            renderShifts();
          }
        }, 16);
        // Fallback: if DOM never updates, force resume after window duration
        cooldownTimeout = setTimeout(() => {
          clearInterval(waitPoll);
          if (isCoolingDown) {
            isCoolingDown = false;
            log('Cooldown fallback fired', 'warn');
            updateSelectedInfo();
            renderShifts();
          }
        }, RATE_LIMIT_WINDOW_MS);
      }
      return;
    }
    const el = document.getElementById(`shift_instance_${currentTarget.id}`);
    if (!el) { log(`${currentTarget.name} not in DOM — skipping`, 'warn'); advanceQueue(); return; }
    const btn = el.querySelector('.button_hold');
    if (btn && !btn.classList.contains('d-none') && !btn.disabled) {
      btn.click();
      log(`Booked: ${currentTarget.name}`, 'success');
      setTimeout(() => advanceQueue(), 500);
    }
  }, 16);
}

function advanceQueue() {
  shiftQueue.shift();
  if (shiftQueue.length === 0) {
    log('Queue complete', 'success');
    disarm(false);
    renderShifts();
    return;
  }
  currentTarget = shiftQueue[0];
  log(`Next: ${currentTarget.name}`, 'info');
  updateSelectedInfo();
  renderShifts();
}

function arm() {
  if (shiftQueue.length === 0) return;
  isArmed = true;
  isCoolingDown = false;
  currentTarget = shiftQueue[0];
  log(`ARMED — ${shiftQueue.length} shift(s) queued`, 'armed');
  log(`First target: ${currentTarget.name}`, 'armed');
  updateSelectedInfo();
  const armBtn = document.getElementById('wb-arm-btn');
  const disarmBtn = document.getElementById('wb-disarm-btn');
  if (armBtn) armBtn.style.display = 'none';
  if (disarmBtn) disarmBtn.style.display = 'block';
  startPolling();
}

function disarm(userInitiated = true) {
  isArmed = false;
  isCoolingDown = false;
  currentTarget = null;
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  if (cooldownTimeout) { clearTimeout(cooldownTimeout); cooldownTimeout = null; }
  const armBtn = document.getElementById('wb-arm-btn');
  const disarmBtn = document.getElementById('wb-disarm-btn');
  if (armBtn) { armBtn.style.display = 'block'; armBtn.disabled = shiftQueue.length === 0; }
  if (disarmBtn) disarmBtn.style.display = 'none';
  if (userInitiated) log('Disarmed by user', 'warn');
  updateSelectedInfo();
}

// ── Queue Management ─────────────────────────────────────────
function toggleShiftInQueue(id, name) {
  if (isArmed) return;
  const idx = shiftQueue.findIndex(s => s.id === id);
  if (idx === -1) {
    shiftQueue.push({ id, name });
    log(`Queued: ${name} (#${shiftQueue.length})`, 'info');
  } else {
    shiftQueue.splice(idx, 1);
    log(`Removed: ${name}`, 'warn');
  }
  renderShifts();
  updateSelectedInfo();
}

function moveUp(id) {
  const idx = shiftQueue.findIndex(s => s.id === id);
  if (idx <= 0) return;
  [shiftQueue[idx - 1], shiftQueue[idx]] = [shiftQueue[idx], shiftQueue[idx - 1]];
  renderShifts();
}

function moveDown(id) {
  const idx = shiftQueue.findIndex(s => s.id === id);
  if (idx === -1 || idx >= shiftQueue.length - 1) return;
  [shiftQueue[idx], shiftQueue[idx + 1]] = [shiftQueue[idx + 1], shiftQueue[idx]];
  renderShifts();
}

// ── UI ───────────────────────────────────────────────────────
function createOverlay() {
  if (document.getElementById('wb-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'wb-overlay';
  overlay.innerHTML = `
    <div id="wb-panel">
      <div id="wb-header">
        <span id="wb-title">⚡ Wardyati Auto-Book</span>
        <div style="display:flex;gap:6px;align-items:center;">
          <span id="wb-countdown-display" style="font-size:11px;opacity:0.8;"></span>
          <button id="wb-minimize">−</button>
          <button id="wb-close">✕</button>
        </div>
      </div>
      <div id="wb-body">
        <div id="wb-status">Scanning shifts...</div>
        <div class="wb-section-label">SHIFTS — click to queue</div>
        <div id="wb-shifts-list"></div>
        <div class="wb-section-label" style="margin-top:6px;">QUEUE — books in this order</div>
        <div id="wb-queue-list"></div>
        <div id="wb-selected-info"></div>
        <div id="wb-actions">
          <button id="wb-scan-btn" class="wb-btn wb-btn-secondary">🔄 Rescan</button>
          <button id="wb-arm-btn" class="wb-btn wb-btn-primary" disabled>⚡ Arm</button>
          <button id="wb-disarm-btn" class="wb-btn wb-btn-danger" style="display:none;">🛑 Disarm</button>
        </div>
        <div id="wb-log"></div>
      </div>
    </div>
  `;
  const style = document.createElement('style');
  style.textContent = `
    #wb-overlay { position:fixed; bottom:20px; left:20px; z-index:99999; font-family:monospace; font-size:13px; }
    #wb-panel { background:#1a1a2e; border:1px solid #4a9eff; border-radius:10px; box-shadow:0 4px 24px rgba(74,158,255,0.25); width:310px; overflow:hidden; }
    #wb-header { background:#16213e; padding:8px 12px; display:flex; justify-content:space-between; align-items:center; cursor:move; user-select:none; border-bottom:1px solid #2a4a7f; }
    #wb-title { color:#4a9eff; font-weight:bold; font-size:13px; }
    #wb-header button { background:transparent; border:1px solid #4a9eff44; color:#aaa; border-radius:4px; width:22px; height:22px; cursor:pointer; font-size:12px; line-height:1; }
    #wb-body { padding:10px 12px; }
    #wb-status { color:#88ccff; font-size:11px; margin-bottom:8px; padding:4px 8px; background:#0f3460; border-radius:4px; }
    .wb-section-label { font-size:10px; color:#88ccff; margin-bottom:4px; }
    #wb-shifts-list { max-height:150px; overflow-y:auto; margin-bottom:4px; }
    #wb-queue-list  { max-height:100px; overflow-y:auto; margin-bottom:8px; }
    .wb-shift-item { display:flex; align-items:center; gap:6px; padding:5px 8px; margin-bottom:4px; border-radius:6px; background:#0f3460; cursor:pointer; border:2px solid transparent; transition:border-color 0.15s; }
    .wb-shift-item:hover { border-color:#4a9eff88; }
    .wb-shift-item.queued { border-color:#4a9eff; background:#1a3a6f; }
    .wb-shift-item.open { border-color:#44ff8888; background:#0f3d20; }
    .wb-shift-item.open.queued { border-color:#44ff88; background:#1a5a30; }
    .wb-queue-item { display:flex; align-items:center; gap:6px; padding:4px 8px; margin-bottom:3px; border-radius:6px; background:#1a2a4f; border:1px solid #2a4a8f; font-size:11px; }
    .wb-queue-item.current-target { background:#3a1a6f; border-color:#ff88ff; }
    .wb-queue-item.cooldown { background:#3a2a0f; border-color:#ffaa33; }
    .wb-queue-order { color:#4a9eff; font-weight:bold; min-width:16px; font-size:10px; }
    .wb-queue-name  { color:#eee; flex:1; }
    .wb-queue-btns  { display:flex; gap:2px; }
    .wb-queue-btns button { background:#334; border:1px solid #445; color:#aaa; border-radius:3px; width:18px; height:18px; cursor:pointer; font-size:10px; line-height:1; padding:0; }
    .wb-queue-btns button:hover { background:#556; }
    .wb-shift-name  { color:#eee; font-weight:bold; flex:1; font-size:12px; }
    .wb-shift-meta  { color:#aaa; font-size:10px; }
    .wb-shift-badge { font-size:9px; padding:1px 5px; border-radius:10px; font-weight:bold; white-space:nowrap; }
    .badge-closed { background:#ff4444; color:white; }
    .badge-open   { background:#44cc66; color:black; }
    .badge-full   { background:#888;    color:white; }
    .badge-holder { background:#ffaa00; color:black; }
    .badge-queued { background:#4a9eff; color:white; }
    #wb-selected-info { font-size:11px; min-height:16px; margin-bottom:8px; }
    #wb-actions { display:flex; gap:6px; margin-bottom:8px; }
    .wb-btn { border:none; border-radius:5px; padding:5px 10px; cursor:pointer; font-size:11px; font-weight:bold; font-family:monospace; flex:1; }
    .wb-btn:disabled { opacity:0.4; cursor:not-allowed; }
    .wb-btn-primary  { background:#4a9eff; color:white; }
    .wb-btn-primary:hover:not(:disabled) { background:#2a7eff; }
    .wb-btn-secondary { background:#334; color:#aaa; border:1px solid #445; }
    .wb-btn-secondary:hover { background:#445; }
    .wb-btn-danger  { background:#cc3333; color:white; }
    .wb-btn-danger:hover { background:#ff4444; }
    #wb-log { font-size:10px; color:#aaa; max-height:80px; overflow-y:auto; background:#0a0a1a; border-radius:4px; padding:4px 6px; }
    #wb-log .log-success { color:#44ff88; }
    #wb-log .log-warn    { color:#ffaa33; }
    #wb-log .log-info    { color:#88ccff; }
    #wb-log .log-armed   { color:#ff88ff; font-weight:bold; }
    #wb-panel.minimized #wb-body { display:none; }
    .wb-empty { color:#555; font-size:10px; padding:4px 8px; font-style:italic; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(overlay);
  setupOverlayEvents();
}

function log(msg, type = 'info') {
  const logEl = document.getElementById('wb-log');
  if (!logEl) return;
  const time = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const line = document.createElement('div');
  line.className = `log-${type}`;
  line.textContent = `[${time}] ${msg}`;
  logEl.prepend(line);
  while (logEl.children.length > 20) logEl.lastChild.remove();
}

function renderShifts() {
  const shifts = getShifts();
  const list = document.getElementById('wb-shifts-list');
  const queueList = document.getElementById('wb-queue-list');
  const status = document.getElementById('wb-status');
  const armBtn = document.getElementById('wb-arm-btn');
  if (!list || !queueList) return;

  list.innerHTML = '';
  if (shifts.length === 0) {
    status.textContent = 'No shifts found. Are you on the room page?';
  } else {
    const open = shifts.filter(s => s.isOpen).length;
    status.textContent = `${shifts.length} shifts — ${open} open, ${shifts.length - open} closed`;
    shifts.forEach(s => {
      const inQueue = shiftQueue.some(q => q.id === s.id);
      const item = document.createElement('div');
      item.className = 'wb-shift-item' + (s.isOpen ? ' open' : '') + (inQueue ? ' queued' : '');
      let badge = inQueue ? '<span class="wb-shift-badge badge-queued">QUEUED</span>'
        : s.isHolder ? '<span class="wb-shift-badge badge-holder">MINE</span>'
        : s.isFull   ? '<span class="wb-shift-badge badge-full">FULL</span>'
        : s.isOpen   ? '<span class="wb-shift-badge badge-open">OPEN</span>'
        :               '<span class="wb-shift-badge badge-closed">CLOSED</span>';
      item.innerHTML = `<div style="flex:1;min-width:0;"><div class="wb-shift-name">${s.name}</div><div class="wb-shift-meta">${s.holderText} | ${s.remaining} left</div></div>${badge}`;
      if (!isArmed) item.addEventListener('click', () => toggleShiftInQueue(s.id, s.name));
      list.appendChild(item);
    });
  }

  queueList.innerHTML = '';
  if (shiftQueue.length === 0) {
    queueList.innerHTML = '<div class="wb-empty">Empty — click shifts above to add</div>';
  } else {
    shiftQueue.forEach((s, idx) => {
      const isCurrent = currentTarget && currentTarget.id === s.id;
      const item = document.createElement('div');
      item.className = 'wb-queue-item' +
        (isCurrent && isCoolingDown ? ' cooldown' : '') +
        (isCurrent && isArmed && !isCoolingDown ? ' current-target' : '');
      item.innerHTML = `
        <span class="wb-queue-order">${idx + 1}.</span>
        <span class="wb-queue-name">${s.name}</span>
        ${isCurrent && isArmed ? `<span style="font-size:9px;color:${isCoolingDown ? '#ffaa33' : '#ff88ff'}">${isCoolingDown ? '⏳' : '⚡'}</span>` : ''}
        ${!isArmed ? `<div class="wb-queue-btns"><button class="up-btn">↑</button><button class="dn-btn">↓</button><button class="rm-btn">✕</button></div>` : ''}
      `;
      if (!isArmed) {
        item.querySelector('.up-btn').addEventListener('click', e => { e.stopPropagation(); moveUp(s.id); });
        item.querySelector('.dn-btn').addEventListener('click', e => { e.stopPropagation(); moveDown(s.id); });
        item.querySelector('.rm-btn').addEventListener('click', e => { e.stopPropagation(); toggleShiftInQueue(s.id, s.name); });
      }
      queueList.appendChild(item);
    });
  }

  if (armBtn) armBtn.disabled = shiftQueue.length === 0 || isArmed;
  updateSelectedInfo();
}

function updateSelectedInfo() {
  const el = document.getElementById('wb-selected-info');
  if (!el) return;
  if (shiftQueue.length === 0) {
    el.textContent = 'Build your queue then arm';
    el.style.color = '#aaa';
  } else if (isArmed && isCoolingDown) {
    el.textContent = `⏳ Rate limit cooldown — next shift ready soon`;
    el.style.color = '#ffaa33';
  } else if (isArmed && currentTarget) {
    el.textContent = `⚡ ARMED — targeting: ${currentTarget.name} (${shiftQueue.length} queued)`;
    el.style.color = '#ff88ff';
  } else {
    el.textContent = `✓ Queue ready: ${shiftQueue.length} shift(s)`;
    el.style.color = '#44ff88';
  }
}

function startCountdownSync() {
  countdownInterval = setInterval(() => {
    const cd = getCountdown();
    const el = document.getElementById('wb-countdown-display');
    if (el && cd) el.textContent = `⏱ ${cd}`;
  }, 500);
}

function makeDraggable(panel, handle) {
  let ox = 0, oy = 0, mx = 0, my = 0;
  handle.addEventListener('mousedown', e => {
    e.preventDefault(); ox = e.clientX; oy = e.clientY;
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', stopDrag);
  });
  function drag(e) {
    mx = ox - e.clientX; my = oy - e.clientY;
    ox = e.clientX; oy = e.clientY;
    panel.style.top = (panel.offsetTop - my) + 'px';
    panel.style.left = (panel.offsetLeft - mx) + 'px';
    panel.style.bottom = 'auto';
  }
  function stopDrag() {
    document.removeEventListener('mousemove', drag);
    document.removeEventListener('mouseup', stopDrag);
  }
}

function setupOverlayEvents() {
  const panel = document.getElementById('wb-panel');
  makeDraggable(document.getElementById('wb-overlay'), document.getElementById('wb-header'));
  document.getElementById('wb-close').addEventListener('click', () => { disarm(); document.getElementById('wb-overlay').remove(); });
  document.getElementById('wb-minimize').addEventListener('click', () => panel.classList.toggle('minimized'));
  document.getElementById('wb-scan-btn').addEventListener('click', () => { renderShifts(); log('Rescanned', 'info'); });
  document.getElementById('wb-arm-btn').addEventListener('click', arm);
  document.getElementById('wb-disarm-btn').addEventListener('click', () => disarm(true));
}

function init() {
  const waitForShifts = setInterval(() => {
    if (document.querySelectorAll('.arena_shift_instance').length > 0) {
      clearInterval(waitForShifts);
      createOverlay();
      renderShifts();
      startCountdownSync();
      log('v1.2 ready — queue shifts, then arm', 'info');
      const observer = new MutationObserver(() => { if (!isArmed) renderShifts(); });
      const arena = document.getElementById('room_arena_list');
      if (arena) observer.observe(arena, { childList: true, subtree: true, attributes: true });
    }
  }, 200);
}

init();
