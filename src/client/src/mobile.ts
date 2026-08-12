/**
 * Mobile/touch helpers.
 *
 * `isTouchDevice()` decides whether the on-screen race controller is shown.
 * Query overrides make it testable on desktop: `?touch` forces controls ON
 * (emulate a phone), `?notouch` forces them OFF.
 *
 * `installOrientationNudge()` shows a full-screen "rotate your phone" overlay in
 * portrait, since the race track is wide and only reads well in landscape.
 */

/**
 * Inject a small stylesheet that makes the lobby's desktop-sized DOM panels fit
 * a phone. Centered modals (inventory, profile, gacha, shop, leaderboard, queue)
 * all carry `transform: translate(-50%,-50%)` inline, so one attribute selector
 * reins them all in — no per-panel edits. `!important` beats the inline widths.
 * Scoped to narrow viewports so desktop is untouched.
 */
export function installMobileStyles(): void {
  if (document.getElementById('cs-mobile-styles')) return;
  const style = document.createElement('style');
  style.id = 'cs-mobile-styles';
  style.textContent = `
    @media (max-width: 1024px) {
      /* Centered modal panels */
      body > div[style*="translate(-50%"] {
        width: 94vw !important;
        max-width: 560px !important;
        max-height: 90vh !important;
        box-sizing: border-box !important;
        overflow-y: auto !important;
        padding: 16px !important;
      }
      /* Chat: shrink so it doesn't dominate or crowd the joystick */
      #chat-box { width: 40vw !important; max-width: 230px !important; bottom: 6px !important; left: 6px !important; }
      #chat-box #chat-messages { height: 84px !important; }
    }
  `;
  document.head.appendChild(style);
}

export function isTouchDevice(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.has('notouch')) return false;
  if (params.has('touch')) return true;
  return ('ontouchstart' in window) || (navigator.maxTouchPoints ?? 0) > 0;
}

/**
 * Overlay prompting the player to rotate to landscape. No-op on non-touch
 * devices (desktop users can freely resize/portrait a window without a nag).
 */
export function installOrientationNudge(): void {
  if (!isTouchDevice()) return;

  const el = document.createElement('div');
  el.id = 'rotate-nudge';
  const icon = document.createElement('div');
  icon.textContent = '🔄';
  Object.assign(icon.style, { fontSize: '52px', lineHeight: '1', marginBottom: '16px' });
  const msg = document.createElement('div');
  msg.textContent = 'Rotate your phone to play';
  el.append(icon, msg);
  Object.assign(el.style, {
    position: 'fixed', inset: '0', zIndex: '100000',
    display: 'none', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', textAlign: 'center',
    background: '#0a0a18', color: '#cfe3ff',
    font: 'bold 22px monospace', padding: '24px',
  });
  document.body.appendChild(el);

  const mq = window.matchMedia('(orientation: portrait)');
  const apply = () => { el.style.display = mq.matches ? 'flex' : 'none'; };
  apply();
  // Safari <14 lacks addEventListener on MediaQueryList — fall back to resize.
  if (mq.addEventListener) mq.addEventListener('change', apply);
  else window.addEventListener('resize', apply);
}
