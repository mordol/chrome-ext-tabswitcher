export const DEFAULT_SETTINGS = {
  columns: 4,          // 2-6, used by "center" preset and toolbar popup
  theme: 'system',     // system | light | dark
  showShortcuts: false,
  openMode: 'window',  // window | popup
  preset: 'center',    // center | top | bottom | left | right
  minCard: 120,        // minimum thumbnail width (px); below it the grid scrolls
};

export const PRESETS = ['center', 'top', 'bottom', 'left', 'right'];

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(patch) {
  const settings = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

export const thumbKey = (tabId) => `thumb:${tabId}`;
