// ============================================================
// Wardyati Auto-Book — Content Script
// Runs directly inside the page → zero latency on click
// ============================================================

const STATE_KEY = 'wardyati_autobook';

// ── Utilities ────────────────────────────────────────────────

function getShifts() {
  const shifts = [];
  document.querySelectorAll('.arena_shift_instance').forEach(el => {
    const id = el.dataset.shiftInstanceId;
    const nameEl = el.querySelector('[data-bs-title]');
    const name = nameEl ? nameEl.getAttribute('data-bs-title') : `Shift ${id}`;
    const holdBtn = el.querySelector('.button_hold');
    const isVisible = holdBtn && !holdBtn.classList.contains('d-none');
    const isOpen = isVisible && !holdBtn.disabled;
    const remainingEl = el.querySelector('.remaining_holdings_count .number-container');
    const remaining = remainingEl ? parseInt(remainingEl.dataset.number) : '?';
    const holderEl = el.querySelector('[id$="_holder_count_text"]');
    const holderText = holderEl ? holderEl.textContent.trim() : '?';
    const isHolder = el.dataset.isHolder === 'true';

    shifts.push({ id, name, isOpen, isVisible, remaining, holderText, isHolder });
  });
  return shifts;
}

function getCountdown() {
  const el = document.getElementById('coord_countdown');
  return el ? el.textContent.trim() : null;
}

function isCoordOpen() {
  // coord_open badge text changes or button becomes clickable
  const badge = document.querySelector('.text-bg-danger');
  if (badge && badge.textContent.includes('مغلق')) return false;
  const openBadge = document.querySelector('.text-bg-success');
  if (openBadge && openBadge.textContent.includes('مفتوح')) return true;
  // Fallback: check if any hold button is visible
  return document.querySelectorAll('.button_hold:not(.d-none)').length > 0;
}

function clickHold(shiftId) {
  const el = document.getElementById(`shift_instance_${shiftId}`);
  if (!el) return false;
  const btn = el.querySelector('.button_hold');
  if (!btn || btn.classList.contains('d-none') || btn.disabled) return false;
  btn.click();
  return true;
}

// ── Overlay UI ───────────────────────────────────────────────

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
        <div id="wb-shifts-list"></div>
        <div id="wb-selected-info"></div>
        <div id="wb-actions">
          <button id="wb-scan-btn" class="wb-btn wb-btn-secondary">🔄 Rescan</button>
          <button id="wb-arm-btn" class="wb-btn wb-btn-primary" disabled>⚡ Arm Auto-Book</button>
          <button id="wb-disarm-btn" class="wb-btn wb-btn-danger" style="display:none;">🛑 Disarm</button>
        </div>
        <div id="wb-log"></div>
      </div>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #wb-overlay {
      position: fixed;
      bottom: 20px;
      left: 20px;
      z-index: 99999;
      font-family: monospace;
      font-size: 13px;
    }
    #wb-panel {
      background: #1a1a2e;
      border: 1px solid #4a9eff;
      border-radius: 10px;
      box-shadow: 0 4px 24px rgba(74,158,255,0.25);
      width: 300px;
      overflow: hidden;
    }
    #wb-header {
      background: #16213e;
      padding: 8px 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: move;
      user-select: none;
      border-bottom: 1px solid #2a4a7f;
    }
    #wb-title { color: #4a9eff; font-weight: bold; font-size: 13px; }
    #wb-header button {
      background: transparent;
      border: 1px solid #4a9eff44;
      color: #aaa;
      border-radius: 4px;
      width: 22px;
      height: 22px;
      cursor: pointer;
      font-size: 12px;
      line-height: 1;
    }
    #wb-body { padding: 10px 12px; }
    #wb-status {
      color: #88ccff;
      font-size: 11px;
      margin-bottom: 8px;
      padding: 4px 8px;
      background: #0f3460;
      border-radius: 4px;
    }
    #wb-shifts-list { max-height: 180px; overflow-y: auto; margin-bottom: 8px; }
    .wb-shift-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 8px;
      margin-bottom: 4px;
      border-radius: 6px;
      background: #0f3460;
      cursor: pointer;
      border: 2px solid transparent;
      transition: border-color 0.15s;
    }
    .wb-shift-item:hover { border-color: #4a9eff88; }
    .wb-shift-item.selected { border-color: #4a9eff; background: #1a4a8f; }
    .wb-shift-item.open { border-color: #44ff88; background: #0f3d20; }
    .wb-shift-name { color: #eee; font-weight: bold; flex: 1; font-size: 12px; }
    .wb-shift-meta { color: #aaa; font-size: 10px; }
    .wb-shift-badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 10px;
      font-weight: bold;
    }
    .badge-closed { background: #ff4444; color: white; }
    .badge-open { background: #44cc66; color: black; }
    .badge-full { background: #888; color: white; }
    .badge-holder { background: #ffaa00; color: black; }
    #wb-selected-info {
      color: #44ff88;
      font-size: 11px;
      min-height: 16px;
      margin-bottom: 8px;
    }
    #wb-actions { display: flex; gap: 6px; margin-bottom: 8px; }
    .wb-btn {
      border: none;
      border-radius: 5px;
      padding: 5px 10px;
      cursor: pointer;
      font-size: 11px;
      font-weight: bold;
      font-family: monospace;
      flex: 1;
    }
    .wb-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .wb-btn-primary { background: #4a9eff; color: white; }
    .wb-btn-primary:hover:not(:disabled) { background: #2a7eff; }
    .wb-btn-secondary { background: #334; color: #aaa; border: 1px solid #445; }
    .wb-btn-secondary:hover { background: #445; }
    .wb-btn-danger { background: #cc3333; color: white; }
    .wb-btn-danger:hover { background: #ff4444; }
    #wb-log {
      font-size: 10px;
      color: #aaa;
      max-height: 80px;
      overflow-y: auto;
      background: #0a0a1a;
      border-radius: 4px;
      padding: 4px 6px;
    }
    #wb-log .log-success { color: #44ff88; }
    #wb-log .log-warn { color: #ffaa33; }
    #wb-log .log-info { color: #88ccff; }
    #wb-log .log-armed { color: #ff88ff; font-weight: bold; }
    #wb-panel.minimized #wb-body { display: none; }
  `;

  document.head.appendChild(style);
  document.body.appendChild(overlay);
  setupOverlayEvents();
  return overlay;
}

function log(msg, type = 'info') {
  const logEl = document.getElementById('wb-log');
  if (!logEl) return;
  const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const line = document.createElement('div');
  line.className = `log-${type}`;
  line.textContent = `[${time}] ${msg}`;
  logEl.prepend(line);
  // Keep only last 20 lines
  while (logEl.children.length > 20) logEl.lastChild.remove();
}

// ── State ────────────────────────────────────────────────────

let selectedShiftId = null;
let isArmed = false;
let pollInterval = null;
let countdownInterval = null;

function renderShifts() {
  const shifts = getShifts();
  const list = document.getElementById('wb-shifts-list');
  const status = document.getElementById('wb-status');
  const armBtn = document.getElementById('wb-arm-btn');
  if (!list) return;

  list.innerHTML = '';

  if (shifts.length === 0) {
    status.textContent = '⚠ No shifts found. Are you on the room page?';
    return;
  }

  const open = shifts.filter(s => s.isOpen).length;
  const closed = shifts.filter(s => !s.isOpen).length;
  status.textContent = `Found ${shifts.length} shifts — ${open} open, ${closed} closed`;

  shifts.forEach(s => {
    const item = document.createElement('div');
    item.className = 'wb-shift-item' + (s.isOpen ? ' open' : '') + (s.id === selectedShiftId ? ' selected' : '');
    item.dataset.id = s.id;

    let badge = '';
    if (s.isHolder) badge = '<span class="wb-shift-badge badge-holder">MINE</span>';
    else if (s.remaining === 0) badge = '<span class="wb-shift-badge badge-full">FULL</span>';
    else if (s.isOpen) badge = '<span class="wb-shift-badge badge-open">OPEN</span>';
    else badge = '<span class="wb-shift-badge badge-closed">CLOSED</span>';

    item.innerHTML = `
      <div>
        <div class="wb-shift-name">${s.name}</div>
        <div class="wb-shift-meta">Spots: ${s.holderText} | Left: ${s.remaining}</div>
      </div>
      ${badge}
    `;

    item.addEventListener('click', () => selectShift(s.id, s.name));
    list.appendChild(item);
  });

  if (armBtn) armBtn.disabled = !selectedShiftId;
  updateSelectedInfo();
}

function selectShift(id, name) {
  if (isArmed) return; // don't change while armed
  selectedShiftId = id;
  log(`Selected: ${name} (ID: ${id})`, 'info');
  renderShifts();
}

function updateSelectedInfo() {
  const el = document.getElementById('wb-selected-info');
  if (!el) return;
  if (!selectedShiftId) {
    el.textContent = 'Click a shift above to select it';
    el.style.color = '#aaa';
  } else if (isArmed) {
    el.textContent = `⚡ ARMED — will book shift ${selectedShiftId} instantly`;
    el.style.color = '#ff88ff';
  } else {
    const shifts = getShifts();
    const s = shifts.find(x => x.id === selectedShiftId);
    el.textContent = s ? `✓ Selected: ${s.name}` : `✓ Selected ID: ${selectedShiftId}`;
    el.style.color = '#44ff88';
  }
}

// ── Arming / Polling ─────────────────────────────────────────

function arm() {
  if (!selectedShiftId) return;
  isArmed = true;
  log('ARMED — polling every 16ms for button unlock', 'armed');
  updateSelectedInfo();

  const armBtn = document.getElementById('wb-arm-btn');
  const disarmBtn = document.getElementById('wb-disarm-btn');
  if (armBtn) armBtn.style.display = 'none';
  if (disarmBtn) disarmBtn.style.display = 'block';

  // 16ms ≈ 1 animation frame — fastest reliable poll without hammering
  pollInterval = setInterval(() => {
    const el = document.getElementById(`shift_instance_${selectedShiftId}`);
    if (!el) return;
    const btn = el.querySelector('.button_hold');
    if (btn && !btn.classList.contains('d-none') && !btn.disabled) {
      // Fire immediately
      btn.click();
      log(`🎯 CLICKED! Booking shift ${selectedShiftId}`, 'success');
      disarm(false);
    }
  }, 16);
}

function disarm(userInitiated = true) {
  isArmed = false;
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  const armBtn = document.getElementById('wb-arm-btn');
  const disarmBtn = document.getElementById('wb-disarm-btn');
  if (armBtn) { armBtn.style.display = 'block'; armBtn.disabled = !selectedShiftId; }
  if (disarmBtn) disarmBtn.style.display = 'none';
  if (userInitiated) log('Disarmed by user', 'warn');
  updateSelectedInfo();
}

// ── Countdown Sync ───────────────────────────────────────────

function startCountdownSync() {
  countdownInterval = setInterval(() => {
    const cd = getCountdown();
    const el = document.getElementById('wb-countdown-display');
    if (el && cd) el.textContent = `⏱ ${cd}`;
  }, 500);
}

// ── Drag ────────────────────────────────────────────────────

function makeDraggable(panel, handle) {
  let ox = 0, oy = 0, mx = 0, my = 0;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    ox = e.clientX; oy = e.clientY;
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

// ── Event Wiring ─────────────────────────────────────────────

function setupOverlayEvents() {
  const panel = document.getElementById('wb-panel');
  const header = document.getElementById('wb-header');
  makeDraggable(document.getElementById('wb-overlay'), header);

  document.getElementById('wb-close').addEventListener('click', () => {
    disarm();
    document.getElementById('wb-overlay').remove();
  });

  document.getElementById('wb-minimize').addEventListener('click', () => {
    panel.classList.toggle('minimized');
  });

  document.getElementById('wb-scan-btn').addEventListener('click', () => {
    renderShifts();
    log('Rescanned shifts', 'info');
  });

  document.getElementById('wb-arm-btn').addEventListener('click', arm);
  document.getElementById('wb-disarm-btn').addEventListener('click', () => disarm(true));
}

// ── Init ────────────────────────────────────────────────────

function init() {
  // Wait for arena to load (it loads async)
  const waitForShifts = setInterval(() => {
    if (document.querySelectorAll('.arena_shift_instance').length > 0) {
      clearInterval(waitForShifts);
      createOverlay();
      renderShifts();
      startCountdownSync();
      log('Extension loaded — select a shift and arm', 'info');

      // Auto-rescan when the arena updates (htmx swaps DOM)
      const observer = new MutationObserver(() => {
        if (!isArmed) renderShifts();
      });
      const arena = document.getElementById('room_arena_list');
      if (arena) observer.observe(arena, { childList: true, subtree: true, attributes: true });
    }
  }, 200);
}

init();
