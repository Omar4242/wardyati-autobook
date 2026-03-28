// Wardyati Auto-Book Content Script
// Data flows: priority list & arm state live in chrome.storage.local.
// Popup sends only plain string action names via executeScript args.
//
// Booking strategy:
// - Each shift in the priority queue gets a maximum of MAX_TRIALS attempts.
// - Every polling tick fires the next due attempt in round-robin priority order,
//   without waiting for the server response of the previous attempt.
// - A shift is dropped from the queue once it is booked OR exhausts MAX_TRIALS.
(function () {
  'use strict';

  const STORAGE_KEY    = 'wardyati_state';
  const CHECK_INTERVAL = 50;   // ms between polling ticks
  const MAX_TRIALS     = 5;    // max submission attempts per shift before skipping

  let priorityList = [];  // [{id, name, date, time, pool}, ...]
  let isArmed      = false;
  let checkTimer   = null;

  // Per-session trial counters — NOT persisted, reset if page reloads.
  // Key: shift id, Value: number of times we have fired a booking attempt.
  const trialCount = {};

  // Round-robin cursor: index into priorityList of the next shift to attempt.
  // Advances each tick so attempts are spread evenly across all queued shifts.
  let cursor = 0;

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

  // ── DOM helpers ────────────────────────────────────────────────────────────
  function getShiftData(el) {
    const id = String(el.dataset.shiftInstanceId || '');
    if (!id) return null;

    const noPlace    = el.dataset.noPlace === 'true';
    const pastTime   = el.dataset.pastTime === 'true';
    const maxReached = el.dataset.maxReachedForUser === 'true';

    const namEl    = el.querySelector('.text-truncate');
    const name     = namEl ? namEl.textContent.trim() : '—';
    const timeEl   = el.querySelector('.text-nowrap');
    const time     = timeEl ? timeEl.textContent.trim() : '';
    const dayCard  = el.closest('[id^="arena_day_"]');
    const date     = dayCard ? dayCard.id.replace('arena_day_', '') : '';
    const poolEl   = el.querySelector('.pool-info small');
    const pool     = poolEl ? poolEl.textContent.trim() : '';
    const remainEl = el.querySelector('.remaining_holdings_count .number-container');
    const remaining = remainEl ? parseInt(remainEl.dataset.number, 10) || 0 : 0;

    return { id, name, time, date, pool, remaining, noPlace, pastTime, maxReached };
  }

  function getAvailableShifts() {
    return Array.from(document.querySelectorAll('.arena_shift_instance'))
      .map(getShiftData)
      .filter(s => s && !s.noPlace && !s.pastTime && s.remaining > 0);
  }

  // ── Queue management ───────────────────────────────────────────────────────
  // Remove a shift from the priority list and persist the change.
  function dropShift(id, reason) {
    console.log('[Wardyati] Dropping shift', id, '—', reason);
    priorityList = priorityList.filter(p => p.id !== id);
    delete trialCount[id];

    // Keep cursor in bounds after removal
    if (cursor >= priorityList.length) cursor = 0;

    const patch = { priorityList };
    if (priorityList.length === 0) {
      isArmed       = false;
      patch.isArmed = false;
      stopPolling();
      console.log('[Wardyati] All shifts handled — disarmed.');
    }
    persistState(patch);

    window.dispatchEvent(new CustomEvent('wardyati_ext', {
      detail: { type: 'booked', id, name: (priorityList.find(p => p.id === id) || {}).name || id }
    }));
  }

  // ── Booking ────────────────────────────────────────────────────────────────
  function tryBookNext() {
    if (!isArmed || priorityList.length === 0) return;

    // Wrap cursor
    if (cursor >= priorityList.length) cursor = 0;

    // Walk the list once starting from cursor, find the next actionable item
    const start = cursor;
    let tried = 0;

    while (tried < priorityList.length) {
      const idx  = (start + tried) % priorityList.length;
      const item = priorityList[idx];

      if (!trialCount[item.id]) trialCount[item.id] = 0;

      // Drop if trial cap reached
      if (trialCount[item.id] >= MAX_TRIALS) {
        dropShift(item.id, 'trial cap reached');
        // List mutated — restart from same cursor position
        tryBookNext();
        return;
      }

      const liveEl = document.getElementById('shift_instance_' + item.id);
      if (liveEl) {
        if (liveEl.dataset.noPlace           === 'true') { dropShift(item.id, 'no places left'); return; }
        if (liveEl.dataset.pastTime          === 'true') { dropShift(item.id, 'past time');      return; }
        if (liveEl.dataset.maxReachedForUser === 'true') { dropShift(item.id, 'max reached');    return; }

        const btn = liveEl.querySelector('.button_hold');
        if (btn && !btn.classList.contains('d-none') && !btn.disabled) {
          // Fire the attempt
          trialCount[item.id]++;
          console.log(
            `[Wardyati] Attempt ${trialCount[item.id]}/${MAX_TRIALS} — shift ${item.id} (${item.name})`
          );
          btn.click();

          // Advance cursor so next tick tries the next shift in order
          cursor = (idx + 1) % priorityList.length;
          return;
        }
      }

      tried++;
    }

    // No actionable shift found this tick — advance cursor anyway
    cursor = (cursor + 1) % Math.max(priorityList.length, 1);
  }

  // Listen for successful booking confirmation from htmx response
  // so we can drop the shift as soon as the server confirms it.
  document.addEventListener('htmx:afterRequest', (evt) => {
    const url    = (evt.detail.pathInfo && evt.detail.pathInfo.requestPath) || '';
    const status = evt.detail.xhr ? evt.detail.xhr.status : 0;
    if (!url.includes('/action/hold/') || status !== 200) return;

    // Extract shift id from URL: /rooms/.../shift-instances/{id}/action/hold/
    const match = url.match(/shift-instances\/(\d+)\/action\/hold/);
    if (!match) return;
    const bookedId = match[1];

    // Only drop if it's still in our list (not already dropped by cap)
    if (priorityList.find(p => p.id === bookedId)) {
      dropShift(bookedId, 'server confirmed booking');
    }
  });

  function startPolling() {
    stopPolling();
    cursor     = 0;
    checkTimer = setInterval(tryBookNext, CHECK_INTERVAL);
  }

  function stopPolling() {
    if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
  }

  // ── Message handler ────────────────────────────────────────────────────────
  window.addEventListener('wardyati_popup', (e) => {
    const action = (e.detail || {}).action;
    if (!action) return;

    if (action === 'get_shifts') {
      syncFromStorage(() => {
        window.dispatchEvent(new CustomEvent('wardyati_ext', {
          detail: { type: 'shifts', shifts: getAvailableShifts(), priorityList, isArmed }
        }));
      });
    }

    if (action === 'reload_priority') {
      syncFromStorage(() => { if (isArmed) startPolling(); });
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

  console.log('[Wardyati Auto-Book] Content script ready.');
})();
