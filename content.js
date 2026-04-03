// Wardyati Auto-Book Content Script
// Data flows: priority list & arm state live in chrome.storage.local.
// Popup sends only plain string action names via executeScript args.
//
// Booking strategy:
// - MutationObserver watches each queued shift's hold button for attribute
//   changes and fires immediately when the button becomes clickable.
// - setInterval at 50ms runs in parallel as a safety net.
// - Whichever triggers first wins — a guard prevents double-firing.
// - Round-robin across all queued shifts, max MAX_TRIALS attempts each.
(function () {
  'use strict';

  const STORAGE_KEY    = 'wardyati_state';
  const CHECK_INTERVAL = 50;
  const MAX_TRIALS     = 5;

  let priorityList = [];
  let isArmed      = false;
  let checkTimer   = null;

  // Trial counters per shift id — session only, not persisted
  const trialCount = {};

  // Round-robin cursor
  let cursor = 0;

  // MutationObserver instances per shift id — so we can disconnect them
  // when a shift is dropped
  const observers = {};

  // Guard flag — prevents both MutationObserver and polling from firing
  // simultaneously on the same tick
  let firing = false;

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

    const namEl     = el.querySelector('.text-truncate');
    const name      = namEl ? namEl.textContent.trim() : '—';
    const timeEl    = el.querySelector('.text-nowrap');
    const time      = timeEl ? timeEl.textContent.trim() : '';
    const dayCard   = el.closest('[id^="arena_day_"]');
    const date      = dayCard ? dayCard.id.replace('arena_day_', '') : '';
    const poolEl    = el.querySelector('.pool-info small');
    const pool      = poolEl ? poolEl.textContent.trim() : '';
    const remainEl  = el.querySelector('.remaining_holdings_count .number-container');
    const remaining = remainEl ? parseInt(remainEl.dataset.number, 10) || 0 : 0;

    return { id, name, time, date, pool, remaining, noPlace, pastTime, maxReached };
  }

  function getAvailableShifts() {
    return Array.from(document.querySelectorAll('.arena_shift_instance'))
      .map(getShiftData)
      .filter(s => s && !s.noPlace && !s.pastTime && s.remaining > 0);
  }

  function isButtonLive(btn) {
    return btn && !btn.classList.contains('d-none') && !btn.disabled;
  }

  // ── Queue management ───────────────────────────────────────────────────────
  function dropShift(id, reason) {
    console.log('[Wardyati] Dropping', id, '—', reason);

    // Disconnect and remove the observer for this shift
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

  // ── Core fire function — called by both observer and polling ───────────────
  function fireBooking(item, btn, source) {
    if (!isArmed) return;
    if (firing) return;        // already being handled this instant
    if (!isButtonLive(btn)) return;

    firing = true;

    if (!trialCount[item.id]) trialCount[item.id] = 0;
    trialCount[item.id]++;

    console.log(
      `[Wardyati] [${source}] Attempt ${trialCount[item.id]}/${MAX_TRIALS}`,
      item.id, item.name
    );

    btn.click();

    // Advance cursor so polling round-robin continues correctly
    const idx = priorityList.findIndex(p => p.id === item.id);
    if (idx !== -1) cursor = (idx + 1) % priorityList.length;

    // Release the guard after a single tick so the next shift can fire
    // on the very next polling interval without unnecessary delay
    setTimeout(() => { firing = false; }, CHECK_INTERVAL);
  }

  // ── MutationObserver — watches a single shift's hold button ───────────────
  function observeShift(item) {
    if (observers[item.id]) return; // already watching

    const liveEl = document.getElementById('shift_instance_' + item.id);
    if (!liveEl) return;

    const btn = liveEl.querySelector('.button_hold');
    if (!btn) return;

    // If button is already live when we start observing, fire immediately
    if (isButtonLive(btn)) {
      fireBooking(item, btn, 'observer-immediate');
      return;
    }

    const obs = new MutationObserver(() => {
      if (!isArmed) return;
      const freshBtn = liveEl.querySelector('.button_hold');
      if (isButtonLive(freshBtn)) {
        fireBooking(item, freshBtn, 'observer');
      }
    });

    // Watch for class changes (d-none removal) and attribute changes (disabled removal)
    obs.observe(btn, {
      attributes: true,
      attributeFilter: ['class', 'disabled']
    });

    // Also observe the parent element in case htmx replaces the button entirely
    obs.observe(liveEl, {
      childList: true,
      subtree:   true,
      attributes: true,
      attributeFilter: ['class', 'disabled']
    });

    observers[item.id] = obs;
  }

  function observeAllQueued() {
    priorityList.forEach(observeShift);
  }

  function disconnectAllObservers() {
    Object.values(observers).forEach(obs => obs.disconnect());
    Object.keys(observers).forEach(k => delete observers[k]);
  }

  // ── Polling — 50ms safety net running in parallel ──────────────────────────
  function tryBookNext() {
    if (!isArmed || priorityList.length === 0) return;
    if (firing) return;

    if (cursor >= priorityList.length) cursor = 0;

    const start = cursor;
    let checked = 0;

    while (checked < priorityList.length) {
      const idx  = (start + checked) % priorityList.length;
      const item = priorityList[idx];

      if (!trialCount[item.id]) trialCount[item.id] = 0;

      if (trialCount[item.id] >= MAX_TRIALS) {
        dropShift(item.id, 'trial cap reached');
        tryBookNext(); // recurse after mutation
        return;
      }

      const liveEl = document.getElementById('shift_instance_' + item.id);
      if (liveEl) {
        if (liveEl.dataset.noPlace           === 'true') { dropShift(item.id, 'no places left'); return; }
        if (liveEl.dataset.pastTime          === 'true') { dropShift(item.id, 'past time');      return; }
        if (liveEl.dataset.maxReachedForUser === 'true') { dropShift(item.id, 'max reached');    return; }

        const btn = liveEl.querySelector('.button_hold');
        if (isButtonLive(btn)) {
          fireBooking(item, btn, 'polling');
          return;
        }
      }

      checked++;
    }

    cursor = (cursor + 1) % Math.max(priorityList.length, 1);
  }

  // ── htmx confirmation — drop shift as soon as server confirms success ──────
  document.addEventListener('htmx:afterRequest', (evt) => {
    const url    = (evt.detail.pathInfo && evt.detail.pathInfo.requestPath) || '';
    const status = evt.detail.xhr ? evt.detail.xhr.status : 0;
    if (!url.includes('/action/hold/') || status !== 200) return;

    const match = url.match(/shift-instances\/(\d+)\/action\/hold/);
    if (!match) return;
    const bookedId = match[1];

    if (priorityList.find(p => p.id === bookedId)) {
      dropShift(bookedId, 'server confirmed booking');
    }
  });

  // ── Start / stop ───────────────────────────────────────────────────────────
  function startPolling() {
    stopPolling();
    cursor  = 0;
    firing  = false;
    observeAllQueued();          // start observers for all queued shifts
    tryBookNext();               // check immediately without waiting 50ms
    checkTimer = setInterval(tryBookNext, CHECK_INTERVAL);
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
        window.dispatchEvent(new CustomEvent('wardyati_ext', {
          detail: { type: 'shifts', shifts: getAvailableShifts(), priorityList, isArmed }
        }));
      });
    }

    if (action === 'reload_priority') {
      syncFromStorage(() => {
        if (isArmed) {
          observeAllQueued(); // watch any newly added shifts too
          startPolling();
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

  console.log('[Wardyati Auto-Book] Content script ready.');
})();
