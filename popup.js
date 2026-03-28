// popup.js — uses chrome.storage.local for all data passing (no args serialization issues)
(function () {
  'use strict';

  const STORAGE_KEY = 'wardyati_state';

  let tabId = null;
  let isArmed = false;
  let availableShifts = [];
  let priorityList = [];

  const $ = id => document.getElementById(id);

  // ── Logging ────────────────────────────────────────────────────────────────
  function log(msg, type = 'info') {
    const box = $('logBox');
    const el = document.createElement('div');
    el.className = 'log-entry ' + type;
    const now = new Date();
    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map(n => String(n).padStart(2, '0')).join(':');
    el.textContent = `[${ts}] ${msg}`;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    while (box.children.length > 15) box.removeChild(box.firstChild);
  }

  // ── Storage helpers ────────────────────────────────────────────────────────
  function saveState(patch) {
    chrome.storage.local.get(STORAGE_KEY, (res) => {
      const current = res[STORAGE_KEY] || {};
      chrome.storage.local.set({ [STORAGE_KEY]: { ...current, ...patch } });
    });
  }

  function loadState(cb) {
    chrome.storage.local.get(STORAGE_KEY, (res) => cb(res[STORAGE_KEY] || {}));
  }

  // ── Send a simple string action to content script (no data in args) ────────
  // All real data travels through chrome.storage.local, not args.
  function sendAction(action) {
    if (!tabId) return;
    chrome.scripting.executeScript({
      target: { tabId },
      func: (act) => {
        window.dispatchEvent(new CustomEvent('wardyati_popup', { detail: { action: act } }));
      },
      args: [action]   // only a plain string — always serializable
    });
  }

  // ── Bridge: forward content-script events back to popup ───────────────────
  function setupBridge() {
    if (!tabId) return;
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (window.__wardyati_bridge) return;
        window.__wardyati_bridge = true;
        window.addEventListener('wardyati_ext', (e) => {
          chrome.runtime.sendMessage({ wardyati: true, detail: e.detail });
        });
      }
      // no args needed
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg.wardyati) return;
    handleContentMsg(msg.detail);
  });

  function handleContentMsg(detail) {
    if (!detail) return;

    if (detail.type === 'shifts') {
      availableShifts = detail.shifts || [];
      // Restore priority list from storage (content script echoes it back)
      if (Array.isArray(detail.priorityList)) priorityList = detail.priorityList;
      isArmed = !!detail.isArmed;
      renderAll();
      $('shiftCount').textContent = `(${availableShifts.length})`;
      log(`Loaded ${availableShifts.length} shifts`, 'info');
    }

    if (detail.type === 'status') {
      isArmed = !!detail.isArmed;
      if (Array.isArray(detail.priorityList)) priorityList = detail.priorityList;
      updateArmButton();
      renderPriority();
    }

    if (detail.type === 'booked') {
      log(`✅ Booked: ${detail.name}`, 'ok');
      setTimeout(() => sendAction('get_shifts'), 1500);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function renderAll() {
    renderShifts();
    renderPriority();
    updateArmButton();
  }

  function renderShifts() {
    const container = $('shiftsList');
    container.innerHTML = '';

    if (!availableShifts.length) {
      container.innerHTML = '<div class="empty-msg">No available shifts or page not loaded yet</div>';
      return;
    }

    const priorityIds = new Set(priorityList.map(p => p.id));

    availableShifts.forEach(s => {
      const el = document.createElement('div');
      el.className = 'shift-item' + (priorityIds.has(s.id) ? ' selected' : '');

      const label = s.maxReached
        ? ' <span style="color:#f87171;font-size:9px">(limit reached)</span>' : '';

      el.innerHTML = `
        <div class="shift-check">${priorityIds.has(s.id) ? '✓' : ''}</div>
        <div class="shift-info">
          <div class="shift-name">${esc(s.name)} <span style="color:#6b7280;font-weight:400;font-size:10px">${esc(s.date)}</span></div>
          <div class="shift-meta">${esc(s.time)}${s.pool ? ' · ' + esc(s.pool) : ''}${label}</div>
        </div>
        <div class="shift-spots">${s.remaining} left</div>
      `;

      el.addEventListener('click', () => toggleShift(s));
      container.appendChild(el);
    });
  }

  function toggleShift(s) {
    const idx = priorityList.findIndex(p => p.id === s.id);
    if (idx === -1) {
      // Only store plain strings/numbers — nothing exotic
      priorityList.push({
        id: String(s.id),
        name: String(s.name || ''),
        date: String(s.date || ''),
        time: String(s.time || ''),
        pool: String(s.pool || '')
      });
      log(`Added: ${s.name} (${s.date})`, 'info');
    } else {
      priorityList.splice(idx, 1);
      log(`Removed: ${s.name}`, 'warn');
    }
    persistPriority();
    renderShifts();
    renderPriority();
  }

  function renderPriority() {
    const container = $('priorityList');
    container.innerHTML = '';

    if (!priorityList.length) {
      container.innerHTML = '<div class="empty-msg">Click a shift to add it here</div>';
      return;
    }

    priorityList.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'priority-item';
      el.innerHTML = `
        <div class="priority-num">${i + 1}</div>
        <div class="priority-info">
          <div class="priority-name">${esc(item.name)}</div>
          <div class="priority-meta">${esc(item.date)} ${esc(item.time)}</div>
        </div>
        <div class="priority-btns">
          ${i > 0
            ? `<button class="p-btn" data-action="up" data-idx="${i}">↑</button>`
            : '<span style="width:20px"></span>'}
          ${i < priorityList.length - 1
            ? `<button class="p-btn" data-action="down" data-idx="${i}">↓</button>`
            : '<span style="width:20px"></span>'}
          <button class="p-btn remove" data-action="remove" data-idx="${i}">✕</button>
        </div>
      `;
      container.appendChild(el);
    });

    container.querySelectorAll('.p-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.action;
        const idx = parseInt(btn.dataset.idx, 10);
        if (act === 'up')   movePriority(idx, idx - 1);
        if (act === 'down') movePriority(idx, idx + 1);
        if (act === 'remove') {
          const removed = priorityList.splice(idx, 1)[0];
          log(`Removed: ${removed.name}`, 'warn');
          persistPriority();
          renderShifts();
          renderPriority();
        }
      });
    });
  }

  function movePriority(from, to) {
    if (to < 0 || to >= priorityList.length) return;
    [priorityList[from], priorityList[to]] = [priorityList[to], priorityList[from]];
    persistPriority();
    renderPriority();
  }

  // Write priority list to storage, then tell content script to re-read it
  function persistPriority() {
    saveState({ priorityList });
    sendAction('reload_priority');
  }

  // ── Arm / Disarm ───────────────────────────────────────────────────────────
  function updateArmButton() {
    const btn = $('btnArm');
    const badge = $('statusBadge');
    if (isArmed) {
      btn.textContent = '🛑 Stop Auto-Book';
      btn.classList.add('active');
      badge.textContent = 'Active';
      badge.className = 'status-badge armed';
    } else {
      btn.textContent = '🔒 Enable Auto-Book';
      btn.classList.remove('active');
      badge.textContent = 'Inactive';
      badge.className = 'status-badge disarmed';
    }
  }

  $('btnArm').addEventListener('click', () => {
    if (!priorityList.length) {
      log('⚠️ Select at least one shift first', 'warn');
      return;
    }
    isArmed = !isArmed;
    saveState({ isArmed });
    sendAction(isArmed ? 'arm' : 'disarm');
    updateArmButton();
    log(isArmed ? '🟢 Auto-book enabled' : '🔴 Auto-book stopped',
        isArmed ? 'ok' : 'warn');
  });

  $('btnRefresh').addEventListener('click', () => {
    log('Refreshing...', 'info');
    sendAction('get_shifts');
  });

  // ── Utility ────────────────────────────────────────────────────────────────
  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('wardyati.com')) {
      $('mainContent').style.display = 'none';
      $('noPage').style.display = 'block';
      return;
    }
    tabId = tab.id;

    // Load saved priority list from storage into popup state
    loadState((state) => {
      if (Array.isArray(state.priorityList)) priorityList = state.priorityList;
      isArmed = !!state.isArmed;
      renderAll();
    });

    setupBridge();
    setTimeout(() => sendAction('get_shifts'), 350);
  }

  init();
})();
