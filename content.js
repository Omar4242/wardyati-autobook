// Wardyati Auto-Book Content Script
// Data flows: priority list & arm state live in chrome.storage.local.
// Popup sends only plain string action names via executeScript args.
// Booking speed: uses htmx response event instead of a fixed retry delay —
// the next shift is attempted the moment the server confirms the previous booking.
(function () {
  'use strict';

  const STORAGE_KEY    = 'wardyati_state';
  const CHECK_INTERVAL = 50;   // ms between polling ticks
  const SAFETY_DELAY   = 50;   // ms after server response before next attempt
                                // (just enough for htmx to update the DOM)

  let priorityList      = [];
  let isArmed           = false;
  let bookingInProgress = false;
  let checkTimer        = null;

  // Track what we just tried to book so onHtmxResponse can reference it
  let currentBookingId   = null;
  let currentBookingName = null;
  let fallbackTimer      = null;

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

  function persistState(patch, cb) {
    chrome.storage.local.get(STORAGE_KEY, (res) => {
      const state = { ...(res[STORAGE_KEY] || {}), ...patch };
      chrome.storage.local.set({ [STORAGE_KEY]: state }, cb);
    });
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────
  function getShiftData(el) {
    const id = String(el.dataset.shiftInstanceId || '');
    if (!id) return null;

    const noPlace    = el.dataset.noPlace === 'true';
    const pastTime   = el.dataset.pastTime === 'true';
    const maxReached = el.dataset.maxReachedForUser === 'true';

    const namEl = el.querySelector('.text-truncate');
    const name  = namEl ? namEl.textContent.trim() : '—';

    const timeEl = el.querySelector('.text-nowrap');
    const time   = timeEl ? timeEl.textContent.trim() : '';

    const dayCard = el.closest('[id^="arena_day_"]');
    const date    = dayCard ? dayCard.id.replace('arena_day_', '') : '';

    const poolEl = el.querySelector('.pool-info small');
    const pool   = poolEl ? poolEl.textContent.trim() : '';

    const remainEl = el.querySelector('.remaining_holdings_count .number-container');
    const remaining = remainEl ? parseInt(remainEl.dataset.number, 10) || 0 : 0;

    return { id, name, time, date, pool, remaining, noPlace, pastTime, maxReached };
  }

  function getAvailableShifts() {
    return Array.from(document.querySelectorAll('.arena_shift_instance'))
      .map(getShiftData)
      .filter(s => s && !s.noPlace && !s.pastTime && s.remaining > 0);
  }

  // ── htmx response hook ─────────────────────────────────────────────────────
  // htmx fires 'htmx:afterRequest' on the document after every request.
  // We filter to only hold-action URLs so we don't interfere with anything else.
  // This replaces the fixed RETRY_DELAY entirely — bookingInProgress unlocks
  // the moment the server responds, not after an arbitrary timer.

  function onHtmxResponse(evt) {
    if (!bookingInProgress) return;

    // Reconstruct the request URL from htmx event detail
    const requestPath = evt.detail && evt.detail.pathInfo
      ? evt.detail.pathInfo.requestPath || ''
      : '';
    const responseURL = evt.detail && evt.detail.xhr
      ? evt.detail.xhr.responseURL || ''
      : '';
    const url = requestPath || responseURL;

    if (!url.includes('/action/hold/')) return;

    const status = evt.detail.xhr ? evt.detail.xhr.status : 0;

    // Clear the fallback since htmx responded normally
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }

    // Wait SAFETY_DELAY ms for htmx to finish updating the DOM,
    // then unlock so polling can immediately attempt the next shift
    setTimeout(() => {
      bookingInProgress = false;

      if (status === 200) {
        console.log('[Wardyati] Server confirmed booking:', currentBookingId);
        window.dispatchEvent(new CustomEvent('wardyati_ext', {
          detail: { type: 'booked', id: currentBookingId, name: currentBookingName }
        }));
      } else {
        // Server rejected (rate limit, already booked, etc.) — polling will retry
        console.warn('[Wardyati] Booking rejected, status:', status);
      }

      currentBookingId   = null;
      currentBookingName = null;
    }, SAFETY_DELAY);
  }

  document.addEventListener('htmx:afterRequest', onHtmxResponse);

  // ── Fallback ───────────────────────────────────────────────────────────────
  // If htmx never fires (network error, timeout) bookingInProgress would
  // stay true forever and lock the extension. Release after 5s maximum.
  function armFallback() {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      if (bookingInProgress) {
        console.warn('[Wardyati] Fallback: unlocking after 5s with no server response');
        bookingInProgress  = false;
        currentBookingId   = null;
        currentBookingName = null;
      }
    }, 5000);
  }

  // ── Booking ────────────────────────────────────────────────────────────────
  function tryBookNext() {
    if (!isArmed || bookingInProgress) return;

    for (const item of priorityList) {
      const liveEl = document.getElementById('shift_instance_' + item.id);
      if (!liveEl) continue;

      if (liveEl.dataset.noPlace           === 'true') continue;
      if (liveEl.dataset.pastTime          === 'true') continue;
      if (liveEl.dataset.maxReachedForUser === 'true') continue;

      const btn = liveEl.querySelector('.button_hold');
      if (!btn) continue;
      if (btn.classList.contains('d-none') || btn.disabled) continue;

      // Button is live — fire the booking
      bookingInProgress  = true;
      currentBookingId   = item.id;
      currentBookingName = item.name;
      console.log('[Wardyati] Firing booking:', item.id, item.name);
      btn.click();
      armFallback();

      // Remove from priority list immediately
      priorityList = priorityList.filter(p => p.id !== item.id);
      const patch = { priorityList };
      if (priorityList.length === 0) {
        isArmed       = false;
        patch.isArmed = false;
        stopPolling();
      }
      persistState(patch);

      return; // onHtmxResponse will unlock bookingInProgress
    }
  }

  function startPolling() {
    stopPolling();
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
