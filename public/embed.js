(function() {
  'use strict';

  var WIDGET_URL = 'https://wheel-of-fortune-roan.vercel.app';
  // Allow host page to override widget URL (e.g., for test mode)
  if (window.BWANABET_WIDGET_URL) WIDGET_URL = window.BWANABET_WIDGET_URL;
  var STORAGE_KEY = 'bwanabet_wheel_spun';

  // If the widget iframe never signals ready within this window it was almost
  // certainly blocked (ad-blocker, DNS filter) or failed to load. We report it
  // so the failure is measurable instead of silent. The button deliberately
  // stays hidden — a button that opens a blank overlay is worse than none.
  var READY_TIMEOUT_MS = 8000;

  var WIDGET_ORIGIN = (function () {
    try { return new URL(WIDGET_URL).origin; } catch (e) { return '*'; }
  })();

  // Opt-in diagnostics: which gate is stopping the wheel from appearing?
  // Turn on with EITHER of:
  //   localStorage.setItem('BWANABET_WHEEL_DEBUG', '1')   <- survives reloads
  //   ?wheelDebug=1 on the URL
  // then reload. window.BWANABET_WHEEL_DEBUG also works as a live toggle, but a
  // window global does NOT survive a reload, and the most useful lines (widget
  // build, wheel-ready, availability) only ever fire once, at load.
  function debugOn() {
    if (window.BWANABET_WHEEL_DEBUG) return true;
    // URL param BEFORE storage: it is the fallback for contexts where
    // localStorage throws (Safari with storage blocked, partitioned
    // third-party frames), so reading storage first makes it unreachable
    // exactly when it is needed. Neither of these two can throw.
    if (/[?&]wheelDebug=1/.test(location.search)) return true;
    try {
      return localStorage.getItem('BWANABET_WHEEL_DEBUG') === '1';
    } catch (e) { return false; }
  }

  // Consecutive duplicates are collapsed: tick() re-reads the cookie every 2s,
  // so without this a logged-out user gets the same line 30x/minute and the
  // once-per-load lines that identify the failing gate scroll out of view.
  var lastDbg = '';
  var loggedExpiryFor = 0;
  function dbg() {
    if (!debugOn()) return;
    try {
      var args = ['[wheel]'].concat(Array.prototype.slice.call(arguments));
      var key = String(args);
      if (key === lastDbg) return;
      lastDbg = key;
      console.log.apply(console, args);
    } catch (e) { /* never break the host page */ }
  }

  // Read the BwanaBet session cookie and return the raw JWT only if it is
  // present and not expired. Decode-only (matches server Phase 1). Returns null otherwise.
  function readValidToken() {
    try {
      var m = document.cookie.match(/(?:^|;\s*)token=([^;]+)/);
      if (!m) { dbg('no `token` cookie on', location.host, '- user is logged out, or the cookie is HttpOnly / on another domain'); return null; }
      var raw = decodeURIComponent(m[1]);
      var parts = raw.split('.');
      if (parts.length !== 3) { dbg('the `token` cookie is not a 3-part JWT - another app on this domain may be using the same cookie name'); return null; }
      var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (!payload || typeof payload.exp !== 'number') { dbg('token has no numeric exp claim'); return null; }
      if (payload.exp * 1000 <= Date.now()) {
        // Printing both sides makes device clock skew obvious: if the device
        // clock runs ahead, a perfectly valid session reads as expired here.
        // Deduped on the token's own exp, NOT on the message text: the message
        // embeds the live device clock, so a text-keyed dedupe differs every
        // 2s tick and floods the console in precisely the clock-skew case this
        // line was written to diagnose.
        if (debugOn() && loggedExpiryFor !== payload.exp) {
          loggedExpiryFor = payload.exp;
          dbg('token looks EXPIRED. exp=', new Date(payload.exp * 1000).toISOString(),
              'device clock=', new Date().toISOString(),
              '- if the device clock is wrong, fix the clock, not the wheel');
        }
        return null;
      }
      if (debugOn()) dbg('valid token, expires', new Date(payload.exp * 1000).toISOString());
      return raw;
    } catch (e) { dbg('token read threw:', e && e.message); return null; }
  }

  // --- Day calculation (CAT = UTC+2, resets at 06:00 CAT = 04:00 UTC) ---
  function getWheelDay() {
    var now = new Date();
    var catMs = now.getTime() + (2 * 60 * 60 * 1000);
    var catDate = new Date(catMs);
    if (catDate.getUTCHours() < 6) {
      catDate.setUTCDate(catDate.getUTCDate() - 1);
    }
    return catDate.toISOString().split('T')[0];
  }

  // Browser-safe decode of the session JWT payload id (keys the cache only).
  function customerIdFromToken(raw) {
    try {
      var payload = JSON.parse(atob(raw.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload && payload.id != null && payload.id !== '' ? String(payload.id) : null;
    } catch (e) { return null; }
  }

  // Per-account "spun today" map: { "<customerId>": "<wheelDay>" }. Scoping by
  // account (not device) lets multiple people share one computer.
  function readSpunMap() {
    try {
      var m = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return m && typeof m === 'object' ? m : {};
    } catch (e) { return {}; }
  }

  function hasSpunToday(customerId) {
    if (!customerId) return false;
    return readSpunMap()[customerId] === getWheelDay();
  }

  function markSpun(customerId) {
    if (!customerId) return;
    var today = getWheelDay();
    var map = readSpunMap();
    var next = {};
    for (var id in map) {
      if (Object.prototype.hasOwnProperty.call(map, id) && map[id] === today) next[id] = map[id];
    }
    next[customerId] = today;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
  }

  // Account the widget is currently built/keyed for. Mutable so the widget can
  // be re-pointed when the logged-in account changes in place (SPA login).
  var activeToken = null;
  var activeCustomerId = null;
  var widgetApi = null; // { reload, hideButton, closeWidget }, set by initWidget

  // Builds the trigger button + iframe overlay and wires up the auth handoff.
  // Runs at most once, only after we have a valid session token.
  var initialized = false;
  function initWidget() {
    if (initialized) return;
    initialized = true;
    var readySeen = false;

    // --- Create floating trigger button ---
    var btn = document.createElement('div');
    btn.id = 'bwanabet-wheel-trigger';
    btn.innerHTML = '<svg viewBox="0 0 64 64" width="56" height="56" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
      '<linearGradient id="bwBoxFront" x1="0%" y1="0%" x2="100%" y2="0%">' +
      '<stop offset="0%" stop-color="#eab308"/><stop offset="100%" stop-color="#facc15"/>' +
      '</linearGradient>' +
      '<linearGradient id="bwBoxSide" x1="0%" y1="0%" x2="100%" y2="0%">' +
      '<stop offset="0%" stop-color="#ca8a04"/><stop offset="100%" stop-color="#d69e0a"/>' +
      '</linearGradient>' +
      '<linearGradient id="bwBoxTop" x1="0%" y1="100%" x2="0%" y2="0%">' +
      '<stop offset="0%" stop-color="#fde047"/><stop offset="100%" stop-color="#fef08a"/>' +
      '</linearGradient>' +
      '<linearGradient id="bwLidFront" x1="0%" y1="0%" x2="100%" y2="0%">' +
      '<stop offset="0%" stop-color="#fde047"/><stop offset="100%" stop-color="#fef9c3"/>' +
      '</linearGradient>' +
      '<linearGradient id="bwLidSide" x1="0%" y1="0%" x2="100%" y2="0%">' +
      '<stop offset="0%" stop-color="#ca8a04"/><stop offset="100%" stop-color="#d69e0a"/>' +
      '</linearGradient>' +
      '<linearGradient id="bwLidTop" x1="0%" y1="100%" x2="0%" y2="0%">' +
      '<stop offset="0%" stop-color="#fef08a"/><stop offset="100%" stop-color="#fefce8"/>' +
      '</linearGradient>' +
      '<linearGradient id="bwRibbon" x1="0%" y1="0%" x2="0%" y2="100%">' +
      '<stop offset="0%" stop-color="#ef4444"/><stop offset="100%" stop-color="#b91c1c"/>' +
      '</linearGradient>' +
      '<linearGradient id="bwRibbonDark" x1="0%" y1="0%" x2="0%" y2="100%">' +
      '<stop offset="0%" stop-color="#dc2626"/><stop offset="100%" stop-color="#991b1b"/>' +
      '</linearGradient>' +
      '</defs>' +
      // Box body — front face
      '<polygon points="8,32 48,32 48,56 8,56" fill="url(#bwBoxFront)"/>' +
      // Box body — right side face
      '<polygon points="48,32 58,24 58,48 48,56" fill="url(#bwBoxSide)"/>' +
      // Box body — top face
      '<polygon points="8,32 48,32 58,24 18,24" fill="url(#bwBoxTop)"/>' +
      // Lid — front face
      '<polygon points="5,25 51,25 51,32 5,32" fill="url(#bwLidFront)"/>' +
      // Lid — right side
      '<polygon points="51,25 61,17 61,24 51,32" fill="url(#bwLidSide)"/>' +
      // Lid — top face
      '<polygon points="5,25 51,25 61,17 15,17" fill="url(#bwLidTop)"/>' +
      // Ribbon — front vertical
      '<polygon points="24,25 32,25 32,56 24,56" fill="url(#bwRibbon)"/>' +
      // Ribbon — front horizontal
      '<polygon points="5,27 51,27 51,31 5,31" fill="url(#bwRibbon)"/>' +
      // Ribbon — right side vertical
      '<polygon points="32,25 32,56 48,56 48,32 58,24 42,17" fill="url(#bwRibbonDark)" opacity="0.3"/>' +
      '<polygon points="48,32 52,29 52,52 48,56" fill="url(#bwRibbonDark)" opacity="0.6"/>' +
      // Ribbon — top
      '<polygon points="24,25 32,25 42,17 34,17" fill="#dc2626"/>' +
      // Ribbon cross on top face
      '<polygon points="5,27 51,27 61,19 15,19" fill="#dc2626" opacity="0.5"/>' +
      '<polygon points="5,29 51,29 61,21 15,21" fill="#dc2626" opacity="0.3"/>' +
      // Bow — left loop
      '<ellipse cx="28" cy="14" rx="10" ry="6" fill="#ef4444" stroke="#dc2626" stroke-width="1" transform="rotate(-20 28 14)"/>' +
      '<ellipse cx="28" cy="14" rx="7" ry="4" fill="#f87171" transform="rotate(-20 28 14)"/>' +
      // Bow — right loop
      '<ellipse cx="44" cy="14" rx="10" ry="6" fill="#ef4444" stroke="#dc2626" stroke-width="1" transform="rotate(20 44 14)"/>' +
      '<ellipse cx="44" cy="14" rx="7" ry="4" fill="#f87171" transform="rotate(20 44 14)"/>' +
      // Bow — center knot
      '<ellipse cx="36" cy="16" rx="4" ry="3" fill="#dc2626"/>' +
      '<ellipse cx="36" cy="15.5" rx="2.5" ry="2" fill="#ef4444"/>' +
      // Shine highlights
      '<polygon points="10,34 14,34 13,44 9,44" fill="rgba(255,255,255,0.25)" rx="1"/>' +
      '<polygon points="52,26 56,22 56.5,28 52.5,32" fill="rgba(255,255,255,0.15)"/>' +
      // Edge lines for definition
      '<polygon points="8,32 48,32 48,56 8,56" fill="none" stroke="#b45309" stroke-width="0.5" opacity="0.4"/>' +
      '<polygon points="48,32 58,24 58,48 48,56" fill="none" stroke="#92400e" stroke-width="0.5" opacity="0.4"/>' +
      '<polygon points="5,25 51,25 51,32 5,32" fill="none" stroke="#b45309" stroke-width="0.5" opacity="0.3"/>' +
      '<polygon points="51,25 61,17 61,24 51,32" fill="none" stroke="#92400e" stroke-width="0.5" opacity="0.3"/>' +
      '</svg>';

    // Starts hidden — shown only when the widget confirms a spin is available
    // for this customer today (server-checked, cross-device).
    btn.style.cssText = 'position:fixed;right:16px;top:50%;transform:translateY(-50%);z-index:9998;' +
      'cursor:pointer;width:64px;height:64px;border-radius:50%;' +
      'background:rgba(250,204,21,0.15);backdrop-filter:blur(4px);' +
      'display:none;align-items:center;justify-content:center;' +
      'box-shadow:0 4px 20px rgba(250,204,21,0.4),0 0 0 0 rgba(250,204,21,0.6);' +
      'transition:transform 0.2s ease;';

    // Pulse animation
    var style = document.createElement('style');
    style.textContent = '@keyframes bwPulse{' +
      '0%{box-shadow:0 4px 20px rgba(250,204,21,0.4),0 0 0 0 rgba(250,204,21,0.6);transform:translateY(-50%) scale(1);}' +
      '50%{box-shadow:0 4px 30px rgba(250,204,21,0.6),0 0 0 12px rgba(250,204,21,0);transform:translateY(-50%) scale(1.08);}' +
      '100%{box-shadow:0 4px 20px rgba(250,204,21,0.4),0 0 0 0 rgba(250,204,21,0.6);transform:translateY(-50%) scale(1);}' +
      '}' +
      '#bwanabet-wheel-trigger{animation:bwPulse 2s ease-in-out infinite;}' +
      '#bwanabet-wheel-trigger:hover{animation:none;transform:translateY(-50%) scale(1.15);}' +
      '#bwanabet-wheel-overlay{display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);' +
      'align-items:center;justify-content:center;}' +
      '#bwanabet-wheel-overlay.open{display:flex;}' +
      '#bwanabet-wheel-overlay iframe{border:none;border-radius:16px;max-width:420px;width:95vw;height:90vh;max-height:750px;}';
    document.head.appendChild(style);
    document.body.appendChild(btn);

    // --- Create iframe overlay (hidden) ---
    var overlay = document.createElement('div');
    overlay.id = 'bwanabet-wheel-overlay';
    overlay.innerHTML = '<iframe src="' + WIDGET_URL + '" allow="autoplay"></iframe>';
    document.body.appendChild(overlay);
    dbg('iframe created, waiting for wheel-ready');

    // Close on backdrop click
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeWidget();
    });

    // --- Auth handoff ---
    function sendAuth() {
      var iframe = overlay.querySelector('iframe');
      if (iframe && iframe.contentWindow && activeToken) {
        iframe.contentWindow.postMessage({ type: 'bwanabet-auth', token: activeToken }, WIDGET_ORIGIN);
        dbg('auth sent to', WIDGET_ORIGIN);
      } else {
        dbg('auth NOT sent - iframe=', !!iframe, 'contentWindow=', !!(iframe && iframe.contentWindow), 'token=', !!activeToken);
      }
    }

    // --- Open/close ---
    function openWidget() {
      overlay.classList.add('open');
      sendAuth(); // covers the case where the widget has already mounted
    }

    function closeWidget() {
      overlay.classList.remove('open');
    }

    function hideButton() {
      btn.style.display = 'none';
    }

    // Expose the controls the account-watcher needs when re-keying in place.
    widgetApi = {
      reload: function () { var f = overlay.querySelector('iframe'); if (f) f.src = WIDGET_URL; },
      hideButton: hideButton,
      closeWidget: closeWidget,
    };

    btn.addEventListener('click', openWidget);

    // --- Listen for messages from widget ---
    window.addEventListener('message', function(e) {
      if (!e.data || !e.data.type) return;

      if (e.data.type === 'bwanabet-wheel-ready') {
        readySeen = true;
        dbg('widget signalled ready - sending auth');
        sendAuth();
      }

      if (e.data.type === 'bwanabet-wheel-available') {
        dbg('availability verdict: available=', e.data.available,
            'sticky=', e.data.sticky, 'reason=', e.data.reason, e.data);
        if (e.data.available) {
          btn.style.display = 'flex';
        } else {
          // Persist ONLY a genuine already-spun verdict. Maintenance mode and
          // expired tokens used to be cached here, which suppressed the wheel
          // for the whole wheel-day and stopped later page loads retrying.
          if (e.data.sticky) markSpun(activeCustomerId);
          else dbg('unavailable but NOT sticky - not caching; the next page load will retry');
          hideButton();
        }
      }

      if (e.data.type === 'bwanabet-wheel-close') {
        closeWidget();
      }

      if (e.data.type === 'bwanabet-wheel-spun') {
        markSpun(activeCustomerId);
        // Hide button after a short delay (let user see result first)
        setTimeout(function() {
          hideButton();
        }, 2000);
      }
    });

    // Report a widget that never came alive. Sent as a text/plain beacon so it
    // is a CORS "simple request": no preflight, and no server changes needed
    // (/api/telemetry reads the raw body and JSON-parses it).
    setTimeout(function () {
      if (readySeen) return;
      dbg('widget never signalled ready within', READY_TIMEOUT_MS, 'ms - iframe blocked or failed to load');
      try {
        var payload = JSON.stringify({
          type: 'widget_never_ready',
          message: 'no bwanabet-wheel-ready within ' + READY_TIMEOUT_MS + 'ms',
          context: location.host,
        });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(WIDGET_URL + '/api/telemetry', new Blob([payload], { type: 'text/plain' }));
        } else {
          fetch(WIDGET_URL + '/api/telemetry', {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain' },
            body: payload,
            keepalive: true,
          }).catch(function () {});
        }
      } catch (e) { /* never break the host page */ }
    }, READY_TIMEOUT_MS);
  }

  // --- Account watcher ---------------------------------------------------
  // Show the wheel for the logged-in BwanaBet user, and RE-KEY when the account
  // changes in place — critical for shared store computers where people log in
  // and out (SPA, no full page reload) on one browser. Polls the session cookie.
  function syncToAccount(token) {
    var id = customerIdFromToken(token);
    if (!id) { dbg('token has no `id` claim - cannot key the wheel to an account'); return; }
    if (id === activeCustomerId) return; // no account change
    dbg('active account is now', id);
    activeToken = token;
    activeCustomerId = id;
    if (!initialized) {
      if (hasSpunToday(id)) { dbg('account', id, 'is cached as already-spun today - wheel stays hidden until 06:00 CAT. To clear: localStorage.removeItem("bwanabet_wheel_spun")'); return; }
      dbg('building widget for', id);
      initWidget();                             // build the widget once
      // The freshly-mounted iframe posts 'bwanabet-wheel-ready' → sendAuth().
    } else {
      // Account switched in place: re-point auth and re-run availability.
      dbg('account switched in place - re-keying widget to', id);
      widgetApi.closeWidget();
      widgetApi.hideButton();
      if (hasSpunToday(id)) { dbg('account', id, 'is cached as already-spun today - wheel stays hidden until 06:00 CAT. To clear: localStorage.removeItem("bwanabet_wheel_spun")'); return; }
      widgetApi.reload();                       // re-mount iframe → ready → sendAuth(new token)
    }
  }

  function onLoggedOut() {
    dbg('session cookie gone - hiding wheel until next login');
    if (initialized) { widgetApi.closeWidget(); widgetApi.hideButton(); }
    activeToken = null;
    activeCustomerId = null;
  }

  var POLL_MS = 2000;
  function tick() {
    var token = readValidToken();
    if (token) syncToAccount(token);
    else if (activeCustomerId) onLoggedOut();
  }
  tick();                     // run immediately for an already-logged-in user
  setInterval(tick, POLL_MS); // then watch for login / switch / logout
})();
