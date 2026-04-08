// Wardyati Auto-Book Content Script — v3.0
//
// Major fixes vs v2.2:
//
// 1. RATE-LIMIT SURVIVAL: The extension now detects the site's rate-limiting
//    state by watching $store.room.isRateLimited via the Alpine store directly,
//    and also by watching the #rate_limiting_container element visibility.
//    While rate-limited, all shifts stay in queue and armed state is preserved.
//    The moment rate-limiting clears, booking resumes automatically with no
//    manual re-arm or re-selection needed.
//
// 2. NO PHANTOM DROPS: trialCount is only incremented on actual successful
//    clicks (isButtonLive passed). The polling loop never increments trialCount.
//    Shifts are only dropped for:
//      - is_holder=true  (booked successfully)
//      - no_place + past_time both true simultaneously (genuinely gone)
//      - MAX_TRIALS actual click attempts all failed (server error pattern)
//
// 3. RATE-LIMIT AWARENESS: A dedicated isRateLimited() check reads Alpine's
//    store directly, so we never attempt a click while rate-limited.
//
// 4. RATE-LIMIT BAR: Sends rate-limit status back to popup for display.
//
// 5. SPEED: MutationObserver watches 'disabled' on the hold button directly,
//    firing within one browser paint of the rate-limit window ending.

(function () {
  'use strict';

  const STORAGE_KEY    = 'wardyati_state';
  const CHECK_INTERVAL = 50;
  const MAX_TRIALS     = 20;

  let priorityList = [];
  let isArmed      = false;
  let checkTimer   = null;

  const trialCount = {};
  let cursor       = 0;
  const observers  = {};
  let firing       = false;

  // ── Storage helpers ────────────────────────────────────────────────────────
  function readState(cb) {
    chrome.storage.local.get(STORAGE_KEY, (res) => cb(res[STORAGE_KEY] || {}));
  }

  function syncFromStorage(cb) {
    readState((s) => {
      if (Array.isArray(s.priorityList)) priorityList = s.priorityList;
      isArmed = !!s.isArmed;
      if (cb) cb();
    });
  }

  function persistState(patch) {
    chrome.storage.local.get(STORAGE_KEY, (res) => {
      const state = { ...(res[STORAGE_KEY] || {}), ...patch };
      chrome.storage.local.set({ [STORAGE_KEY]: state });
    });
  }

  // ── Rate-limit detection ───────────────────────────────────────────────────
  // Read directly from Alpine's store — fastest possible source of truth.
  // Falls back to DOM visibility of the rate-limit container.
  function isRateLimited() {
    try {
      // Alpine.store is available on window via Alpine global
      if (window.Alpine && window.Alpine.store) {
        const room = window.Alpine.store('room');
        if (room && typeof room.isRateLimited !== 'undefined') {
          return !!room.isRateLimited;
        }
      }
    } catch (e) { /* ignore */ }
    // Fallback: check DOM visibility of the rate-limiting info bar
    const container = document.getElementById('rate_limiting_container');
    if (!container) return false;
    return container.style.display !== 'none' &&
           getComputedStyle(container).display !== 'none';
  }

  // Returns seconds remaining in the rate-limit window, or 0.
  function rateLimitSecondsLeft() {
    try {
      if (window.Alpine && window.Alpine.store) {
        const room = window.Alpine.store('room');
        if (room && room.rateLimitingInfo) {
          const info = room.rateLimitingInfo;
          // eligible_holdings_within_window contains timestamps of recent bookings
          if (Array.isArray(info.eligible_holdings_within_window) &&
              info.eligible_holdings_within_window.length > 0 &&
              info.rate_limiting_window) {
            const oldest = Math.min(...info.eligible_holdings_within_window.map(t => new Date(t).getTime()));
            const windowMs = info.rate_limiting_window * 1000;
            const remaining = Math.ceil((oldest + windowMs - Date.now()) / 1000);
            return Math.max(0, remaining);
          }
        }
      }
    } catch (e) { /* ignore */ }
    return 0;
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────
  function getHoldButton(el) {
    const actionDiv = el.querySelector('[x-data*="shiftInstanceAction"]');
    if (!actionDiv) return null;
    const buttons = actionDiv.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.classList.contains('btn-soft')) continue;
      if (btn.classList.contains('shift-release-btn')) continue;
      if (btn.querySelector('span[x-text]')) return btn;
      if (btn.textContent.includes('حجز')) return btn;
    }
    return null;
  }

  function isButtonLive(btn) {
    if (!btn) return false;
    if (btn.disabled) return false;
    if (btn.style.display === 'none') return false;
    if (getComputedStyle(btn).display === 'none') return false;
    return true;
  }

  function getRemainingSlots(el) {
    const span = el.querySelector('.remaining_slots .number-container');
    if (span) {
      const n = parseInt(span.textContent.trim(), 10);
      if (!isNaN(n)) return n;
    }
    const slots = parseInt(el.dataset.slots, 10);
    return isNaN(slots) ? 1 : slots;
  }

  function getShiftDate(el) {
    const arenaList = document.getElementById('room_arena_list');
    if (!arenaList) return '';
    let lastDate = '';
    for (const child of arenaList.children) {
      if (child.dataset && child.dataset.date) {
        lastDate = child.dataset.date;
      } else {
        const m = (child.textContent || '').match(/\d{4}-\d{2}-\d{2}/);
        if (m) lastDate = m[0];
      }
      if (child === el || child.contains(el)) break;
    }
    return lastDate;
  }

  function getShiftData(el) {
    const id = String(el.dataset.shiftInstanceId || '');
    if (!id) return null;
    const nameEl = el.querySelector('[dir="auto"]');
    const name   = nameEl ? nameEl.textContent.trim() : '—';
    const timeEl = el.querySelector('.text-monospace .text-nowrap');
    const time   = timeEl ? timeEl.textContent.trim() : '';
    const date      = getShiftDate(el);
    const poolEl    = el.querySelector('.pool-info');
    const pool      = poolEl ? poolEl.textContent.trim() : '';
    const remaining = getRemainingSlots(el);
    const canHold   = el.dataset.canHold !== 'false';
    return { id, name, time, date, pool, remaining, canHold };
  }

  function getAvailableShifts() {
    return Array.from(document.querySelectorAll('.arena_shift_instance'))
      .map(getShiftData)
      .filter(Boolean);
  }

  // ── Rate-limit status broadcast ────────────────────────────────────────────
  // Sends current rate-limit state to popup so it can show a countdown.
  function broadcastRateLimitStatus() {
    const limited  = isRateLimited();
    const secondsLeft = limited ? rateLimitSecondsLeft() : 0;
    window.dispatchEvent(new CustomEvent('wardyati_ext', {
      detail: { type: 'rate_limit', limited, secondsLeft }
    }));
  }

  // ── Queue management ───────────────────────────────────────────────────────
  function dropShift(id, reason) {
    console.log('[Wardyati] Dropping', id, '—', reason);

    if (observers[id]) {
      observers[id].disconnect();
      delete observers[id];
    }
    delete trialCount[id];

    priorityList = priorityList.filter(p => p.id !== id);
    if (cursor >= priorityList.length) cursor = 0;

    const patch = { priorityList };
    if (priorityList.length === 0) {
      isArmed       = false;
      patch.isArmed = false;
      stopPolling();
      console.log('[Wardyati] Queue empty — disarmed.');
    }
    persistState(patch);

    window.dispatchEvent(new CustomEvent('wardyati_ext', {
      detail: { type: 'booked', id, name: id }
    }));
  }

  // ── Core fire function ─────────────────────────────────────────────────────
  function fireBooking(item, btn, source) {
    if (!isArmed) return;
    if (firing) return;
    if (!isButtonLive(btn)) return;
    if (isRateLimited()) {
      // Rate-limited — don't click, just make sure observer is watching
      ensureObserving(item);
      return;
    }

    firing = true;
    if (!trialCount[item.id]) trialCount[item.id] = 0;
    trialCount[item.id]++;

    console.log(
      `[Wardyati] [${source}] Click attempt ${trialCount[item.id]}/${MAX_TRIALS}`,
      item.id, item.name
    );

    btn.click();

    const idx = priorityList.findIndex(p => p.id === item.id);
    if (idx !== -1) cursor = (idx + 1) % priorityList.length;

    // Disconnect this shift's observer and re-attach after 50ms so it catches
    // the button re-enabling after actionInProgress / rate-limit clears.
    if (observers[item.id]) {
      observers[item.id].disconnect();
      delete observers[item.id];
    }
    setTimeout(() => {
      firing = false;
      if (isArmed && priorityList.find(p => p.id === item.id)) {
        observeShift(item);
      }
    }, CHECK_INTERVAL);
  }

  // Ensure an observer is running for item without firing immediately.
  function ensureObserving(item) {
    if (!observers[item.id]) observeShift(item);
  }

  // ── MutationObserver — watches a single shift's hold button ───────────────
  function observeShift(item) {
    if (observers[item.id]) return;

    const liveEl = document.getElementById('shift_instance_' + item.id);
    if (!liveEl) return;

    const btn = getHoldButton(liveEl);
    if (!btn) return;

    // Fire immediately if live AND not rate-limited
    if (isButtonLive(btn) && !isRateLimited()) {
      fireBooking(item, btn, 'observer-immediate');
      return;
    }

    const obs = new MutationObserver(() => {
      if (!isArmed) return;
      const freshEl = document.getElementById('shift_instance_' + item.id);
      if (!freshEl) return;

      // Success: is_holder became visible
      const holderIcon = freshEl.querySelector('.text-success[x-show*="is_holder"]');
      if (holderIcon && holderIcon.style.display !== 'none') {
        dropShift(item.id, 'is_holder indicator visible');
        return;
      }

      const freshBtn = getHoldButton(freshEl);
      if (isButtonLive(freshBtn) && !isRateLimited()) {
        fireBooking(item, freshBtn, 'observer');
      }
    });

    // Watch disabled on the button directly — fires the instant Alpine
    // removes it when rate-limit ends or actionInProgress clears.
    obs.observe(btn, {
      attributes:      true,
      attributeFilter: ['disabled', 'class', 'style']
    });

    obs.observe(liveEl, {
      attributes:      true,
      attributeFilter: ['data-is-holder', 'data-can-hold']
    });

    const actionDiv = liveEl.querySelector('[x-data*="shiftInstanceAction"]');
    if (actionDiv) {
      obs.observe(actionDiv, {
        subtree:         true,
        attributes:      true,
        attributeFilter: ['style', 'disabled']
      });
    }

    observers[item.id] = obs;
  }

  function observeAllQueued() {
    priorityList.forEach(observeShift);
  }

  function disconnectAllObservers() {
    Object.values(observers).forEach(obs => obs.disconnect());
    Object.keys(observers).forEach(k => delete observers[k]);
  }

  // ── Rate-limit container watcher ───────────────────────────────────────────
  // When the rate-limit bar disappears (isRateLimited goes false), immediately
  // try to book the next queued shift — this is the fastest possible trigger.
  function watchRateLimitContainer() {
    const container = document.getElementById('rate_limiting_container');
    if (!container) return;

    const obs = new MutationObserver(() => {
      broadcastRateLimitStatus();
      if (!isArmed || priorityList.length === 0) return;
      // Rate limit just cleared — attempt booking immediately
      if (!isRateLimited()) {
        console.log('[Wardyati] Rate limit cleared — resuming booking');
        firing = false;
        tryBookNext();
        // Also poke each queued shift's observer
        priorityList.forEach(item => {
          if (observers[item.id]) {
            observers[item.id].disconnect();
            delete observers[item.id];
          }
          observeShift(item);
        });
      }
    });

    obs.observe(container, {
      attributes:      true,
      attributeFilter: ['style', 'class']
    });

    // Also watch Alpine store changes via the rate-limit balls element
    const balls = document.getElementById('rate_limiting_balls');
    if (balls) {
      obs.observe(balls, { childList: true, subtree: true, characterData: true });
    }
  }

  // ── Polling — 50ms safety net ──────────────────────────────────────────────
  function tryBookNext() {
    if (!isArmed || priorityList.length === 0) return;
    if (firing) return;
    if (isRateLimited()) return;   // don't even try while rate-limited

    if (cursor >= priorityList.length) cursor = 0;

    const start   = cursor;
    let   checked = 0;

    while (checked < priorityList.length) {
      const idx  = (start + checked) % priorityList.length;
      const item = priorityList[idx];

      if (!trialCount[item.id]) trialCount[item.id] = 0;

      if (trialCount[item.id] >= MAX_TRIALS) {
        dropShift(item.id, 'trial cap: ' + MAX_TRIALS + ' actual clicks');
        tryBookNext();
        return;
      }

      const liveEl = document.getElementById('shift_instance_' + item.id);
      if (liveEl) {
        if (liveEl.dataset.isHolder === 'true') {
          dropShift(item.id, 'already holder');
          return;
        }

        const btn = getHoldButton(liveEl);
        if (btn) {
          if (isButtonLive(btn)) {
            fireBooking(item, btn, 'polling');
            return;
          }
          // Button disabled — skip, don't count
          checked++;
          continue;
        }
      }

      checked++;
    }

    cursor = (cursor + 1) % Math.max(priorityList.length, 1);
  }

  // ── Arena-level success observer ───────────────────────────────────────────
  function watchArenaForSuccess() {
    const arenaList = document.getElementById('room_arena_list');
    if (!arenaList) return;

    const arenaObs = new MutationObserver(() => {
      priorityList.forEach(item => {
        const el = document.getElementById('shift_instance_' + item.id);
        if (!el) return;
        if (el.dataset.isHolder === 'true') {
          dropShift(item.id, 'arena observer: is_holder=true');
        }
      });
    });

    arenaObs.observe(arenaList, {
      subtree:         true,
      attributes:      true,
      attributeFilter: ['data-is-holder']
    });
  }

  // ── Start / stop ───────────────────────────────────────────────────────────
  function startPolling() {
    stopPolling();
    cursor = 0;
    firing = false;
    Object.keys(trialCount).forEach(k => delete trialCount[k]);
    watchArenaForSuccess();
    watchRateLimitContainer();
    observeAllQueued();
    tryBookNext();
    checkTimer = setInterval(() => {
      tryBookNext();
      // Broadcast rate-limit status every second (20 ticks × 50ms)
      if (Date.now() % 1000 < CHECK_INTERVAL) broadcastRateLimitStatus();
    }, CHECK_INTERVAL);
  }

  function stopPolling() {
    if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
    disconnectAllObservers();
    firing = false;
  }

  // ── Message handler ────────────────────────────────────────────────────────
  window.addEventListener('wardyati_popup', (e) => {
    const action = (e.detail || {}).action;
    if (!action) return;

    if (action === 'get_shifts') {
      syncFromStorage(() => {
        const shifts = getAvailableShifts();
        console.log('[Wardyati] get_shifts: found', shifts.length, 'cards in DOM');
        window.dispatchEvent(new CustomEvent('wardyati_ext', {
          detail: {
            type: 'shifts', shifts, priorityList, isArmed,
            rateLimited: isRateLimited(),
            rateLimitSecondsLeft: rateLimitSecondsLeft()
          }
        }));
      });
    }

    if (action === 'reload_priority') {
      syncFromStorage(() => {
        if (isArmed) {
          // Only attach observers for newly added shifts — don't restart everything
          observeAllQueued();
        }
      });
    }

    if (action === 'arm') {
      syncFromStorage(() => {
        isArmed = true;
        startPolling();
        window.dispatchEvent(new CustomEvent('wardyati_ext', {
          detail: { type: 'status', isArmed, priorityList }
        }));
      });
    }

    if (action === 'disarm') {
      isArmed = false;
      stopPolling();
      window.dispatchEvent(new CustomEvent('wardyati_ext', {
        detail: { type: 'status', isArmed: false, priorityList }
      }));
    }

    if (action === 'get_status') {
      syncFromStorage(() => {
        window.dispatchEvent(new CustomEvent('wardyati_ext', {
          detail: { type: 'status', isArmed, priorityList }
        }));
      });
    }
  });

  // Initial sync
  syncFromStorage(() => { if (isArmed) startPolling(); });

  console.log('[Wardyati Auto-Book] Content script ready (v3.0).');
})();
