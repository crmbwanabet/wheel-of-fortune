(function() {
  'use strict';

  var WIDGET_URL = 'https://wheel-of-fortune-roan.vercel.app';
  var STORAGE_KEY = 'bwanabet_wheel_spun';

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

  function hasSpunToday() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return false;
      var data = JSON.parse(stored);
      return data.day === getWheelDay();
    } catch(e) { return false; }
  }

  function markSpun() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ day: getWheelDay() }));
  }

  // Don't show if already spun today
  if (hasSpunToday()) return;

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

  btn.style.cssText = 'position:fixed;right:16px;top:50%;transform:translateY(-50%);z-index:9998;' +
    'cursor:pointer;width:64px;height:64px;border-radius:50%;' +
    'background:rgba(250,204,21,0.15);backdrop-filter:blur(4px);' +
    'display:flex;align-items:center;justify-content:center;' +
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

  // Close on backdrop click
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeWidget();
  });

  // --- Open/close ---
  function openWidget() {
    overlay.classList.add('open');
  }

  function closeWidget() {
    overlay.classList.remove('open');
  }

  function hideButton() {
    btn.style.display = 'none';
  }

  btn.addEventListener('click', openWidget);

  // --- Listen for messages from widget ---
  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.type) return;

    if (e.data.type === 'bwanabet-wheel-close') {
      closeWidget();
    }

    if (e.data.type === 'bwanabet-wheel-spun') {
      markSpun();
      // Hide button after a short delay (let user see result first)
      setTimeout(function() {
        hideButton();
      }, 2000);
    }
  });
})();
