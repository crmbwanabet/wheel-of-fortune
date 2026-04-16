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
    // Box body
    '<rect x="8" y="30" width="48" height="28" rx="4" fill="#facc15" stroke="#eab308" stroke-width="2"/>' +
    // Box lid
    '<rect x="5" y="24" width="54" height="10" rx="3" fill="#fde047" stroke="#eab308" stroke-width="2"/>' +
    // Vertical ribbon
    '<rect x="28" y="24" width="8" height="34" fill="#dc2626" rx="1"/>' +
    // Horizontal ribbon
    '<rect x="5" y="27" width="54" height="5" fill="#dc2626" rx="1"/>' +
    // Bow left
    '<ellipse cx="24" cy="20" rx="10" ry="7" fill="#ef4444" stroke="#dc2626" stroke-width="1.5" transform="rotate(-15 24 20)"/>' +
    // Bow right
    '<ellipse cx="40" cy="20" rx="10" ry="7" fill="#ef4444" stroke="#dc2626" stroke-width="1.5" transform="rotate(15 40 20)"/>' +
    // Bow center knot
    '<circle cx="32" cy="22" r="4" fill="#dc2626"/>' +
    // Shine on box
    '<rect x="12" y="34" width="3" height="10" rx="1.5" fill="rgba(255,255,255,0.4)" transform="rotate(-10 13 39)"/>' +
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
