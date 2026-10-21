import { loadSettings, thumbKey } from './shared/settings.js';
import { computeLayout, placeWindow } from './shared/layout.js';
import { groupTabs } from './shared/split.js';

const THUMB_WIDTH = 640;
const CAPTURE_INTERVAL = 600; // captureVisibleTab is limited to 2 calls/sec

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- capture queue

let queue = Promise.resolve();
let lastCapture = 0;

function enqueue(fn) {
  const run = queue.then(async () => {
    const wait = lastCapture + CAPTURE_INTERVAL - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastCapture = Date.now();
    }
  });
  queue = run.catch(() => {});
  return run;
}

async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(bin)}`;
}

// When a tab is in a split view the captured image may cover both panes.
// Detect that from the aspect ratio and crop to this tab's pane.
async function cropRegion(tab, bmp) {
  const whole = [0, 0, bmp.width, bmp.height];
  if (!tab.width || !tab.height || bmp.width / bmp.height < (tab.width / tab.height) * 1.3) return whole;
  const [tabs, win] = await Promise.all([
    chrome.tabs.query({ windowId: tab.windowId }),
    chrome.windows.get(tab.windowId),
  ]);
  const panes = groupTabs(tabs, win.width).find((group) => group.some((t) => t.id === tab.id));
  if (!panes || panes.length < 2) return whole;
  const total = panes.reduce((s, t) => s + (t.width || 0), 0);
  const w = Math.round(bmp.width * (tab.width / total));
  return [panes[0].id === tab.id ? 0 : bmp.width - w, 0, w, bmp.height];
}

async function captureTab(tab) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const [sx, sy, sw, sh] = await cropRegion(tab, bmp);
  const scale = Math.min(1, THUMB_WIDTH / sw);
  const canvas = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
  canvas.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
  await chrome.storage.local.set({
    [thumbKey(tab.id)]: { url: tab.url, data: await blobToDataUrl(blob), ts: Date.now() },
  });
}

// Capture the active tab of a normal window, if it is still active when our turn comes.
function captureActive(windowId) {
  return enqueue(async () => {
    const win = await chrome.windows.get(windowId).catch(() => null);
    if (!win || win.type !== 'normal' || win.state === 'minimized') return;
    const [tab] = await chrome.tabs.query({ windowId, active: true });
    if (tab) await captureTab(tab).catch(() => {}); // restricted pages (chrome://, store) can't be captured
  });
}

const timers = new Map();
function scheduleCapture(windowId, delay = 350) {
  clearTimeout(timers.get(windowId));
  timers.set(windowId, setTimeout(() => {
    timers.delete(windowId);
    captureActive(windowId);
  }, delay));
}

function waitForComplete(tabId, timeout = 4000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const timer = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') done(); }, done);
  });
}

// Activate each tab in turn, capture it, then restore the originally active tab.
let refreshing = false;
async function refreshAll(windowId) {
  if (refreshing) return;
  refreshing = true;
  try {
    const tabs = await chrome.tabs.query({ windowId });
    const original = tabs.find((t) => t.active);
    for (const tab of tabs) {
      if (!/^(https?|file|ftp):/.test(tab.url || '')) continue;
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      await waitForComplete(tab.id);
      await sleep(250); // let the page paint
      const fresh = await chrome.tabs.get(tab.id).catch(() => null);
      if (fresh?.active) await enqueue(() => captureTab(fresh)).catch(() => {});
    }
    if (original) await chrome.tabs.update(original.id, { active: true }).catch(() => {});
  } finally {
    refreshing = false;
  }
}

chrome.tabs.onActivated.addListener(({ windowId }) => {
  if (!refreshing) scheduleCapture(windowId);
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!refreshing && info.status === 'complete' && tab.active) scheduleCapture(tab.windowId, 500);
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (!refreshing && windowId !== chrome.windows.WINDOW_ID_NONE) scheduleCapture(windowId);
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.local.remove(thumbKey(tabId)));
chrome.tabs.onReplaced.addListener(async (added, removed) => {
  const old = (await chrome.storage.local.get(thumbKey(removed)))[thumbKey(removed)];
  if (old) await chrome.storage.local.set({ [thumbKey(added)]: old });
  await chrome.storage.local.remove(thumbKey(removed));
});

// Tab ids are reassigned after a browser restart; drop thumbnails of tabs that no longer exist.
async function pruneThumbs() {
  const all = await chrome.storage.local.get(null);
  const live = new Set((await chrome.tabs.query({})).map((t) => thumbKey(t.id)));
  const stale = Object.keys(all).filter((k) => k.startsWith('thumb:') && !live.has(k));
  if (stale.length) await chrome.storage.local.remove(stale);
}

// ---------------------------------------------------------------- open mode / switcher window

async function applyOpenMode() {
  const { openMode } = await loadSettings();
  await chrome.action.setPopup({ popup: openMode === 'popup' ? 'switcher.html?mode=popup' : '' });
}

// Manifest content scripts only reach pages loaded after install/update; add the notch to open tabs.
async function injectNotch() {
  for (const tab of await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file://*/*'] })) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['notch.js'] }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(() => { applyOpenMode(); pruneThumbs(); injectNotch(); });
chrome.runtime.onStartup.addListener(() => { applyOpenMode(); pruneThumbs(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) applyOpenMode();
});

async function workAreaFor(win) {
  const displays = await chrome.system.display.getInfo();
  const cx = (win.left ?? 0) + (win.width ?? 0) / 2;
  const cy = (win.top ?? 0) + (win.height ?? 0) / 2;
  const hit = displays.find(({ bounds: b }) =>
    cx >= b.left && cx < b.left + b.width && cy >= b.top && cy < b.top + b.height);
  return (hit || displays.find((d) => d.isPrimary) || displays[0]).workArea;
}


const MAX_DELTA = 200;   // larger create/actual differences are measurement errors, not frame size
const MIN_REQUEST = 100; // never request a window smaller than this

function applyDelta(bounds, delta) {
  const keys = ['left', 'top', 'width', 'height'];
  if (!delta || !keys.every((k) => Number.isFinite(delta[k]) && Math.abs(delta[k]) <= MAX_DELTA)) return bounds;
  const req = Object.fromEntries(keys.map((k) => [k, bounds[k] - delta[k]]));
  return req.width >= MIN_REQUEST && req.height >= MIN_REQUEST ? req : bounds;
}

function createSwitcher(windowId, req) {
  return chrome.windows.create({
    url: `switcher.html?mode=window&windowId=${windowId}&req=${[req.left, req.top, req.width, req.height]}`,
    type: 'popup',
    focused: true,
    ...req,
  });
}

// toggle: close the switcher if it is open. The notch only opens (or focuses) it.
async function toggleSwitcherWindow({ toggle = true } = {}) {
  const { switcherId } = await chrome.storage.session.get('switcherId');
  if (switcherId !== undefined) {
    const existing = await chrome.windows.get(switcherId).catch(() => null);
    if (existing && !toggle) {
      await chrome.windows.update(switcherId, { focused: true });
      return;
    }
    await chrome.storage.session.remove('switcherId');
    if (existing) {
      await chrome.windows.remove(switcherId).catch(() => {});
      return;
    }
  }

  const target = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (!target) return;
  const [settings, tabs, { frame, zoom, windowSize, createDelta }] = await Promise.all([
    loadSettings(),
    chrome.tabs.query({ windowId: target.id }),
    chrome.storage.local.get(['frame', 'zoom', 'windowSize', 'createDelta']),
  ]);
  const area = await workAreaFor(target);
  let layout;
  if (windowSize) {
    // Size chosen by the user (kept until the preset changes); only the position follows the preset.
    const width = Math.min(windowSize.width, area.width);
    const height = Math.min(windowSize.height, area.height);
    layout = { width, height, ...placeWindow(settings.preset, area, width, height) };
  } else {
    layout = computeLayout({
      count: groupTabs(tabs, target.width).length,
      preset: settings.preset,
      columns: settings.columns,
      minCard: settings.minCard,
      area,
      frame: frame || { w: 0, h: 28 },
      zoom: zoom || 1,
    });
  }
  // Some browsers (e.g. Dia) size a new window differently than requested; the switcher page
  // measures the difference (createDelta) and we pre-compensate for it here.
  const bounds = { left: layout.left, top: layout.top, width: layout.width, height: layout.height };
  let req = applyDelta(bounds, createDelta);
  let win;
  try {
    win = await createSwitcher(target.id, req);
  } catch {
    // A bad stored delta must not break the switcher for good: drop it and use the plain bounds.
    await chrome.storage.local.remove('createDelta');
    req = bounds;
    win = await createSwitcher(target.id, req);
  }
  await chrome.storage.session.set({ switcherId: win.id });
}

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { switcherId } = await chrome.storage.session.get('switcherId');
  if (switcherId === windowId) await chrome.storage.session.remove('switcherId');
});

chrome.action.onClicked.addListener(() => toggleSwitcherWindow()); // only fires when no popup is set

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-switcher') return;
  const { openMode } = await loadSettings();
  if (openMode === 'popup') chrome.action.openPopup().catch(() => {});
  else toggleSwitcherWindow();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'openSwitcher') {
    loadSettings().then(({ openMode }) => {
      if (openMode === 'popup') chrome.action.openPopup().catch(() => {}); // may need a user gesture
      else toggleSwitcherWindow({ toggle: false });
    });
    return;
  }
  if (msg.type === 'refreshAll') {
    refreshAll(msg.windowId).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'captureActive') {
    captureActive(msg.windowId);
  }
});
