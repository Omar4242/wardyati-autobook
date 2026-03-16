// Wardyati Auto-Book Content Script
// Data flows: priority list & arm state live in chrome.storage.local.
// Popup sends only plain string action names via executeScript args.
(function () {
  'use strict';

  const STORAGE_KEY = 'wardyati_state';
  const CHECK_INTERVAL = 300;  // ms between booking attempts
  const RETRY_DELAY = 1500;    // ms cooldown after a booking

  let priorityList = [];
  let isArmed = false;
  let bookingInProgress = false;
  let checkTimer = null;
  let lastBookedAt = 0;

  // ── Storage helpers ────────────────────────────────────────────────────────
  function readState(cb) {
    chrome.storage.local.get(STORAGE_KEY, (res) => {
      const s = res[STORAGE_KEY] || {};
      cb(s);
    });
  }

  function syncFromStorage(cb) {
    readState((s) => {
      if (Array.isArray(s.priorityList)) priorityList = s.priorityList;
      isArmed = !!s.isArmed;
      if (cb) cb();
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

  // ── Booking ────────────────────────────────────────────────────────────────
  function tryBookNext() {
    if (!isArmed || bookingInProgress) return;
    if (Date.now() - lastBookedAt < RETRY_DELAY) return;

    for (const item of priorityList) {
      const liveEl = document.getElementById('shift_instance_' + item.id);
      if (!liveEl) continue;

      const noPlace    = liveEl.dataset.noPlace === 'true';
      const pastTime   = liveEl.dataset.pastTime === 'true';
      const maxReached = liveEl.dataset.maxReachedForUser === 'true';
      if (noPlace || pastTime || maxReached) continue;

      const btn = liveEl.querySelector('.button_hold');
      if (!btn) continue;
      if (btn.classList.contains('d-none') || btn.disabled) continue;

      // Button is live — book it
      bookingInProgress = true;
      lastBookedAt = Date.now();
      console.log('[Wardyati] Booking:', item.id, item.name);
      btn.click();

      setTimeout(() => {
        bookingInProgress = false;
        window.dispatchEvent(new CustomEvent('wardyati_ext', {
          detail: { type: 'booked', id: item.id, name: item.name }
        }));
      }, RETRY_DELAY);
      return;
    }
  }

  function startPolling() { stopPolling(); checkTimer = setInterval(tryBookNext, CHECK_INTERVAL); }
  function stopPolling()  { if (checkTimer) { clearInterval(checkTimer); checkTimer = null; } }

  // ── Message handler (actions from popup, all as plain strings) ─────────────
  window.addEventListener('wardyati_popup', (e) => {
    const action = (e.detail || {}).action;
    if (!action) return;

    if (action === 'get_shifts') {
      syncFromStorage(() => {
        const shifts = getAvailableShifts();
        window.dispatchEvent(new CustomEvent('wardyati_ext', {
          detail: { type: 'shifts', shifts, priorityList, isArmed }
        }));
      });
    }

    if (action === 'reload_priority') {
      // Popup updated storage — just re-read
      syncFromStorage(() => {
        if (isArmed) startPolling(); // restart with fresh list
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

  // Initial sync (e.g. if page was reloaded while armed)
  syncFromStorage(() => {
    if (isArmed) startPolling();
  });

  console.log('[Wardyati Auto-Book] Content script ready.');
})();
