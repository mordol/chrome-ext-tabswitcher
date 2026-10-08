import { loadSettings, saveSettings, thumbKey } from './shared/settings.js';
import { computeLayout, computePopupLayout, fitToWindow, placeWindow } from './shared/layout.js';
import { groupTabs } from './shared/split.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'popup' ? 'popup' : 'window';
const KEYS = '1234567890abcdefghijklmnopqrstuvwxyz';

const $ = (id) => document.getElementById(id);
const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
const grid = $('grid');
const settingsEl = $('settings');

let windowId = Number(params.get('windowId')) || null;
let selfWindowId = null;
let settings;
let items = [];   // [{ tabs: Tab[], active: boolean }], one per card; split views share a card
let thumbs = {};  // tabId -> { url, data }
let selected = 0;
let cols = 4;
let windowSize = null;     // outer size the user resized the window to; kept until the preset changes
let ignoreResizeUntil = 0; // resize events caused by our own windows.update

// ---------------------------------------------------------------- data

async function loadItems() {
  const [tabs, win] = await Promise.all([chrome.tabs.query({ windowId }), chrome.windows.get(windowId)]);
  const out = groupTabs(tabs, win.width).map((group) => ({
    tabs: group,
    active: group.some((tab) => tab.active),
  }));

  const keys = tabs.map((tab) => thumbKey(tab.id));
  const stored = await chrome.storage.local.get(keys);
  thumbs = {};
  for (const tab of tabs) {
    const entry = stored[thumbKey(tab.id)];
    if (entry) thumbs[tab.id] = entry;
  }
  return out;
}

// The tab to activate for a card: the active one, else the most recently used pane of a split.
function primaryTab(item) {
  return item.tabs.find((tab) => tab.active) ||
    [...item.tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

const origin = (url) => { try { return new URL(url).origin; } catch { return url; } };

// Tab ids can collide with stale entries after a restart; only trust thumbnails from the same origin.
function thumbFor(tab) {
  const entry = thumbs[tab.id];
  return entry && origin(entry.url) === origin(tab.url || tab.pendingUrl) ? entry.data : null;
}

function faviconUrl(tab, size = 32) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', tab.url || tab.pendingUrl || '');
  url.searchParams.set('size', String(size));
  return url.toString();
}

// ---------------------------------------------------------------- render

function el(tag, className, props) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (props) Object.assign(node, props);
  return node;
}

function renderThumb(thumb, tab) {
  const data = thumbFor(tab);
  thumb.replaceChildren(data
    ? el('img', 'shot', { src: data, alt: '', draggable: false })
    : el('img', 'big-fav', { src: faviconUrl(tab), alt: '', draggable: false }));
}

function cardEl(item, index) {
  const split = item.tabs.length > 1;
  const primary = primaryTab(item);
  const card = el('div', 'card');
  card.classList.toggle('active', item.active);
  card.classList.toggle('selected', index === selected);
  card.classList.toggle('split', split);
  card.dataset.index = index;
  card.title = item.tabs.map((tab) => tab.title || tab.url).join('\n');

  const close = el('button', 'close', { textContent: '×', title: t('closeTab') });
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    closeItem(item);
  });
  card.append(close);

  if (settings.showShortcuts && index < KEYS.length) {
    card.append(el('span', 'key', { textContent: KEYS[index].toUpperCase() }));
  }
  if (item.active) card.append(el('span', 'badge', { textContent: t('currentTab') }));
  if (split) card.append(el('span', 'split-badge', { textContent: t('splitView') }));

  const thumbsEl = el('div', 'thumbs');
  for (const tab of item.tabs) {
    const thumb = el('div', 'thumb');
    thumb.dataset.tabId = tab.id;
    thumb.classList.toggle('current', split && tab.id === primary.id);
    renderThumb(thumb, tab);
    if (split) {
      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        activate(tab);
      });
    }
    thumbsEl.append(thumb);
  }
  card.append(thumbsEl);

  const favs = el('span', 'favs');
  for (const tab of item.tabs) favs.append(el('img', '', { src: faviconUrl(tab, 16), alt: '' }));
  const meta = el('div', 'meta');
  meta.append(favs, el('span', 'title', {
    textContent: item.tabs.map((tab) => tab.title || tab.url).join('  │  '),
  }));
  card.append(meta);

  card.addEventListener('click', () => activate(primary));
  card.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll
  card.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    // Middle-click on one pane of a split closes only that pane.
    const tabId = Number(e.target.closest('.thumb')?.dataset.tabId);
    if (split && tabId) chrome.tabs.remove(tabId);
    else closeItem(item);
  });
  card.addEventListener('mouseenter', () => select(index, false));
  return card;
}

function setGridVars(layoutCols, cardW) {
  cols = layoutCols;
  document.documentElement.style.setProperty('--cols', layoutCols);
  document.documentElement.style.setProperty('--card-w', `${cardW}px`);
  grid.classList.toggle('dense', cardW < 150);
}

function render() {
  selected = Math.min(selected, Math.max(0, items.length - 1));
  grid.replaceChildren(...items.map((item, i) => cardEl(item, i)));
  const tabCount = items.reduce((n, item) => n + item.tabs.length, 0);
  $('count').textContent = t('tabsCount', [String(tabCount)]);
}

function select(index, scroll = true) {
  if (index === selected || index < 0 || index >= items.length) return;
  grid.children[selected]?.classList.remove('selected');
  selected = index;
  const card = grid.children[selected];
  card?.classList.add('selected');
  if (scroll) card?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- layout

let selfTabId = null;
async function currentZoom() {
  selfTabId ??= (await chrome.tabs.getCurrent())?.id;
  return selfTabId ? chrome.tabs.getZoom(selfTabId).catch(() => 1) : 1;
}

/**
 * Fit the cards and, with move, set the window bounds: the user's size if one is saved
 * (positioned by the preset), otherwise the preset's automatic size.
 */
async function applyLayout({ move = true } = {}) {
  if (mode === 'popup') {
    const layout = computePopupLayout(settings.columns);
    setGridVars(layout.cols, layout.cardW);
    return;
  }
  // Window bounds are screen px, inner sizes CSS px: convert with the page zoom (Dia defaults to 125%).
  const zoom = await currentZoom();
  const frame = { w: outerWidth - Math.round(innerWidth * zoom), h: outerHeight - Math.round(innerHeight * zoom) };
  const saved = await chrome.storage.local.get(['frame', 'zoom']);
  if (saved.zoom !== zoom || saved.frame?.w !== frame.w || saved.frame?.h !== frame.h) {
    await chrome.storage.local.set({ frame, zoom });
  }
  const area = { left: screen.availLeft, top: screen.availTop, width: screen.availWidth, height: screen.availHeight };

  let bounds;
  if (windowSize) {
    // The user picked the window size: keep it and scale the cards to fit.
    const fit = fitToWindow({ count: items.length, innerW: innerWidth, innerH: innerHeight, minCard: settings.minCard });
    setGridVars(fit.cols, fit.cardW);
    const width = Math.min(windowSize.width, area.width);
    const height = Math.min(windowSize.height, area.height);
    bounds = { width, height, ...placeWindow(settings.preset, area, width, height) };
  } else {
    bounds = computeLayout({
      count: items.length,
      preset: settings.preset,
      columns: settings.columns,
      minCard: settings.minCard,
      area,
      frame,
      zoom,
    });
    setGridVars(bounds.cols, bounds.cardW);
  }
  if (move) await setBounds(bounds);
}

const BOUND_KEYS = ['left', 'top', 'width', 'height'];

// Some browsers (e.g. Dia) apply a requested size to the page area instead of the whole
// window, so check the result and correct the request by the difference.
async function setBounds(target) {
  const request = Object.fromEntries(BOUND_KEYS.map((k) => [k, target[k]]));
  for (let attempt = 0; attempt < 3; attempt++) {
    const win = await chrome.windows.get(selfWindowId);
    const diff = BOUND_KEYS.map((k) => win[k] - target[k]);
    if (diff.every((d) => Math.abs(d) <= 1)) return;
    if (attempt > 0) BOUND_KEYS.forEach((k, i) => { request[k] -= diff[i]; });
    ignoreResizeUntil = Date.now() + 500;
    await chrome.windows.update(selfWindowId, request);
  }
}

// Remember how the browser's actual window differed from what the background requested,
// so the next window can be created at the right size without a visible correction.
async function recordCreateDelta() {
  const requested = params.get('req')?.split(',').map(Number);
  if (requested?.length !== 4) return;
  const win = await chrome.windows.get(selfWindowId);
  const createDelta = Object.fromEntries(BOUND_KEYS.map((k, i) => [k, win[k] - requested[i]]));
  await chrome.storage.local.set({ createDelta });
}

let saveSizeTimer;
function onResize() {
  // Resizes from our own windows.update only refit the cards; a user resize also becomes the saved size.
  if (Date.now() >= ignoreResizeUntil) {
    windowSize = { width: outerWidth, height: outerHeight };
    clearTimeout(saveSizeTimer);
    saveSizeTimer = setTimeout(() => chrome.storage.local.set({ windowSize }), 300);
  }
  if (windowSize) applyLayout({ move: false });
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const before = items.length;
    items = await loadItems();
    if (items.length !== before) await applyLayout({ move: !windowSize });
    render();
  }, 60);
}

// ---------------------------------------------------------------- actions

function closeSwitcher() {
  window.close();
}

async function activate(tab) {
  if (!tab) return;
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  closeSwitcher();
}

function closeItem(item) {
  if (item) chrome.tabs.remove(item.tabs.map((tab) => tab.id));
}

async function refreshAll() {
  const btn = $('refresh');
  if (btn.classList.contains('spinning')) return;
  btn.classList.add('spinning');
  try {
    await chrome.runtime.sendMessage({ type: 'refreshAll', windowId });
  } finally {
    btn.classList.remove('spinning');
  }
}

// ---------------------------------------------------------------- keyboard

function onKeyDown(e) {
  if (!settingsEl.hidden) {
    if (e.key === 'Escape') {
      e.preventDefault();
      toggleSettings(false);
    }
    return;
  }
  const n = items.length;
  if (!n && e.key !== 'Escape') return;
  switch (e.key) {
    case 'ArrowLeft': select((selected - 1 + n) % n); break;
    case 'ArrowRight': select((selected + 1) % n); break;
    case 'ArrowUp': select(selected - cols); break;
    case 'ArrowDown': select(selected + cols); break;
    case 'Enter': activate(primaryTab(items[selected])); break;
    case 'Delete':
    case 'Backspace': closeItem(items[selected]); break;
    case 'Escape': closeSwitcher(); break;
    default: {
      if (!settings.showShortcuts || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
      const index = KEYS.indexOf(e.key.toLowerCase());
      if (index < 0 || index >= n) return;
      activate(primaryTab(items[index]));
    }
  }
  e.preventDefault();
}

// ---------------------------------------------------------------- settings

function applyTheme() {
  if (settings.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
}

function toggleSettings(show) {
  settingsEl.hidden = !show;
}

async function update(patch) {
  settings = await saveSettings(patch);
}

async function initSettings() {
  const columns = $('columns');
  columns.value = settings.columns;
  $('columnsOut').value = settings.columns;
  columns.addEventListener('input', async () => {
    $('columnsOut').value = columns.value;
    await update({ columns: Number(columns.value) });
    await applyLayout({ move: !windowSize });
    render();
  });

  const minCard = $('minCard');
  minCard.value = settings.minCard;
  $('minCardOut').value = settings.minCard;
  minCard.addEventListener('input', async () => {
    $('minCardOut').value = minCard.value;
    await update({ minCard: Number(minCard.value) });
    await applyLayout({ move: !windowSize });
  });

  $('theme').value = settings.theme;
  $('theme').addEventListener('change', async (e) => {
    await update({ theme: e.target.value });
    applyTheme();
  });

  $('showShortcuts').checked = settings.showShortcuts;
  $('showShortcuts').addEventListener('change', async (e) => {
    await update({ showShortcuts: e.target.checked });
    render();
  });

  $('openMode').value = settings.openMode;
  $('openMode').addEventListener('change', (e) => update({ openMode: e.target.value }));

  const presetButtons = [...$('preset').querySelectorAll('button')];
  const markPreset = () => presetButtons.forEach((b) => b.classList.toggle('on', b.dataset.preset === settings.preset));
  markPreset();
  for (const button of presetButtons) {
    button.addEventListener('click', async () => {
      await update({ preset: button.dataset.preset });
      // A new preset drops the user's window size and returns to the preset's default size.
      windowSize = null;
      await chrome.storage.local.remove('windowSize');
      markPreset();
      await applyLayout();
      render();
    });
  }

  const command = (await chrome.commands.getAll()).find((c) => c.name === 'open-switcher');
  $('shortcut').textContent = command?.shortcut || t('notSet');
  $('changeShortcut').addEventListener('click', async () => {
    // Without an explicit windowId the tab would target the switcher popup window itself.
    await chrome.tabs.create({ url: 'chrome://extensions/shortcuts', windowId });
    await chrome.windows.update(windowId, { focused: true });
    closeSwitcher();
  });

  $('openSettings').addEventListener('click', () => toggleSettings(settingsEl.hidden));
  settingsEl.addEventListener('click', (e) => { if (e.target === settingsEl) toggleSettings(false); });
}

function localize() {
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
  document.documentElement.lang = chrome.i18n.getUILanguage();
}

// ---------------------------------------------------------------- init

async function init() {
  document.body.classList.add(mode);
  localize();

  const current = await chrome.windows.getCurrent();
  if (mode === 'window') selfWindowId = current.id;
  else windowId = current.id; // the toolbar popup belongs to the browser window
  if (!windowId) {
    windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
  }

  settings = await loadSettings();
  if (mode === 'window') ({ windowSize = null } = await chrome.storage.local.get('windowSize'));
  applyTheme();
  items = await loadItems();
  selected = Math.max(0, items.findIndex((item) => item.active));
  await applyLayout({ move: false });
  render();
  grid.children[selected]?.scrollIntoView({ block: 'nearest' });
  await initSettings();

  if (mode === 'window') {
    // The background used an estimated frame size and the browser may have sized the window
    // differently than requested; correct it now that the real numbers are known.
    await recordCreateDelta();
    await applyLayout();
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', () => {
      setTimeout(() => { if (!document.hasFocus()) closeSwitcher(); }, 150);
    });
  }

  chrome.runtime.sendMessage({ type: 'captureActive', windowId });

  $('refresh').addEventListener('click', refreshAll);
  $('newTab').addEventListener('click', async () => {
    await chrome.tabs.create({ windowId });
    await chrome.windows.update(windowId, { focused: true });
    closeSwitcher();
  });
  document.addEventListener('keydown', onKeyDown);

  const inWindow = (fn) => (...args) => { if (fn(...args)) scheduleRefresh(); };
  chrome.tabs.onCreated.addListener(inWindow((tab) => tab.windowId === windowId));
  chrome.tabs.onRemoved.addListener(inWindow((_id, info) => info.windowId === windowId));
  chrome.tabs.onUpdated.addListener(inWindow((_id, change, tab) => tab.windowId === windowId &&
    ('title' in change || 'favIconUrl' in change || 'url' in change || 'splitViewId' in change || 'status' in change)));
  chrome.tabs.onMoved.addListener(inWindow((_id, info) => info.windowId === windowId));
  chrome.tabs.onActivated.addListener(inWindow((info) => info.windowId === windowId));
  chrome.tabs.onAttached.addListener(inWindow((_id, info) => info.newWindowId === windowId));
  chrome.tabs.onDetached.addListener(inWindow((_id, info) => info.oldWindowId === windowId));
  chrome.windows.onRemoved.addListener((id) => { if (id === windowId) closeSwitcher(); });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (!key.startsWith('thumb:') || !newValue) continue;
      const tabId = Number(key.slice(6));
      thumbs[tabId] = newValue;
      const thumb = grid.querySelector(`.thumb[data-tab-id="${tabId}"]`);
      const tab = items.flatMap((item) => item.tabs).find((x) => x.id === tabId);
      if (thumb && tab) renderThumb(thumb, tab);
    }
  });
}

init();
