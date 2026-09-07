// Keeps the tap a player makes before the page can answer it.
//
// /spin and /bonus are server-rendered, so the SPIN button is on screen —
// pulsing, captioned "SPIN NOW", indistinguishable from ready — while the
// bundle is still downloading. Nothing is listening yet, so the tap goes
// nowhere. On a throttled phone that window measured 3.2-3.8 seconds and ate
// eight taps; the player sees a wheel that will not spin and leaves.
//
// So a few lines of inline script, which the browser runs the moment it parses
// them, remember that the player asked to spin. Once React mounts it reads the
// flag and starts the spin they already paid for with a tap.

// Marks the controls worth listening to. Both spin buttons carry it.
export const EARLY_TAP_ATTR = 'data-promo-spin';

// Where the pre-hydration listener leaves its note.
export const EARLY_TAP_FLAG = '__promoSpinQueued';

// Runs from the server-rendered markup, before any component exists. Capture
// phase so it sees the tap wherever it lands inside the button, and it retires
// itself on the first hit — after hydration React's own handler takes over.
export const EARLY_TAP_SCRIPT = `(function(){try{
var g=function(e){var t=e.target;if(t&&t.closest&&t.closest('[${EARLY_TAP_ATTR}]')){window.${EARLY_TAP_FLAG}=1;s();}};
var s=function(){document.removeEventListener('pointerdown',g,true);};
document.addEventListener('pointerdown',g,true);
setTimeout(s,30000);
}catch(e){}})();`;

// Reads the note and tears it up, so a queued tap can only ever spin once.
export function takeQueuedTap(win) {
  if (!win || !win[EARLY_TAP_FLAG]) return false;
  win[EARLY_TAP_FLAG] = 0;
  return true;
}
