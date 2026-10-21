// Content script: a small notch at the top center of the page that opens the switcher.
// Proximity and hover are tracked from document mousemove, so in hover mode the notch never
// takes pointer events and can't block clicks on the page.
(() => {
  if (window.__tabSwitcherNotch) return; // already injected (manifest + scripting on install)
  window.__tabSwitcherNotch = true;

  const DWELL = 250;          // ms the mouse has to stay on the notch (hover mode)
  const HIT = { w: 160, h: 10 }; // trigger area, a bit larger than the visible bar
  const NEAR = { w: 400, h: 80 }; // "near" area for the near-only visibility mode

  let trigger = 'hover';      // hover | click | off
  let visibility = 'near';    // near | always
  let armed = true;           // must leave the notch before it can trigger again
  let dwellTimer = null;

  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; top: 0; left: 50%; transform: translateX(-50%); z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .notch {
        width: 80px; height: 5px;
        margin: 0 auto;
        border-radius: 0 0 6px 6px;
        background: rgba(60, 64, 67, 0.45);
        display: grid; place-items: center;
        opacity: 0; pointer-events: none;
        transition: width .15s, height .15s, opacity .15s, background .15s;
        box-sizing: border-box;
        cursor: pointer;
      }
      .notch.shown { opacity: 1; }
      .notch.clickable.shown { pointer-events: auto; } /* never block clicks while invisible */
      .notch.hot { width: 140px; height: 22px; border-radius: 0 0 10px 10px; background: rgba(26, 115, 232, 0.9); }
      .notch svg { width: 14px; height: 14px; fill: #fff; opacity: 0; transition: opacity .15s; }
      .notch.hot svg { opacity: 1; }
      @media (prefers-color-scheme: dark) {
        .notch { background: rgba(232, 234, 237, 0.4); }
        .notch.hot { background: rgba(138, 180, 248, 0.95); }
        .notch.hot svg { fill: #202124; }
      }
    </style>
    <div class="notch"><svg viewBox="0 0 16 16"><rect x="1" y="2" width="6" height="5" rx="1"/><rect x="9" y="2" width="6" height="5" rx="1"/><rect x="1" y="9" width="6" height="5" rx="1"/><rect x="9" y="9" width="6" height="5" rx="1"/></svg></div>`;
  const notch = root.querySelector('.notch');

  function open() {
    armed = false;
    try {
      chrome.runtime.sendMessage({ type: 'openSwitcher' });
    } catch {
      teardown(); // extension was reloaded; this copy of the script is orphaned
    }
  }

  function inArea(e, area) {
    return e.clientY <= area.h && Math.abs(e.clientX - innerWidth / 2) <= area.w / 2;
  }

  function cancelDwell() {
    clearTimeout(dwellTimer);
    dwellTimer = null;
  }

  function onMove(e) {
    if (trigger === 'off' || document.fullscreenElement) return;
    const hot = inArea(e, HIT);
    if (!hot) armed = true;
    notch.classList.toggle('hot', hot && armed);
    notch.classList.toggle('shown', visibility === 'always' || inArea(e, NEAR));
    if (trigger !== 'hover') return;
    if (hot && armed) {
      dwellTimer ??= setTimeout(() => { dwellTimer = null; open(); }, DWELL);
    } else {
      cancelDwell();
    }
  }

  function onLeave() {
    cancelDwell();
    armed = true;
    notch.classList.remove('hot');
    notch.classList.toggle('shown', visibility === 'always');
  }

  function apply() {
    const off = trigger === 'off';
    host.style.display = off || document.fullscreenElement ? 'none' : '';
    notch.classList.toggle('clickable', trigger === 'click');
    notch.classList.toggle('shown', visibility === 'always');
    if (off) cancelDwell();
  }

  function onStorage(changes, area) {
    if (area !== 'local' || !changes.settings) return;
    const s = changes.settings.newValue || {};
    trigger = s.notchTrigger || 'hover';
    visibility = s.notchVisibility || 'near';
    apply();
  }

  function teardown() {
    document.removeEventListener('mousemove', onMove, true);
    document.documentElement.removeEventListener('mouseleave', onLeave);
    document.removeEventListener('fullscreenchange', apply);
    host.remove();
  }

  notch.addEventListener('click', () => { if (trigger === 'click') open(); });
  document.addEventListener('mousemove', onMove, { capture: true, passive: true });
  document.documentElement.addEventListener('mouseleave', onLeave);
  document.addEventListener('fullscreenchange', apply);
  chrome.storage.onChanged.addListener(onStorage);
  chrome.storage.local.get('settings').then(({ settings = {} }) => {
    trigger = settings.notchTrigger || 'hover';
    visibility = settings.notchVisibility || 'near';
    apply();
  });
  (document.body || document.documentElement).appendChild(host);
})();
