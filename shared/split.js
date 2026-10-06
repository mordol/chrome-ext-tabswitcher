// Groups a window's tabs into cards: split views become one group of two tabs.
//
// Chrome 155+ reports split views via tab.splitViewId. Browsers that implement their own
// split view (e.g. Dia) leave it at -1, so fall back to geometry: two adjacent tabs whose
// widths add up to a full-width tab (minus the divider) are side by side.

export const SPLIT_NONE = -1;

const hasSplitId = (tab) => tab.splitViewId !== undefined && tab.splitViewId !== SPLIT_NONE;

function fullWidth(tabs, windowWidth) {
  const max = Math.max(0, ...tabs.map((tab) => tab.width || 0));
  // If every tab is split there is no full-width tab to compare against; use the window.
  return max >= windowWidth * 0.7 ? max : windowWidth - 12;
}

function looksPaired(a, b, full) {
  if (!a.width || !b.width || a.height !== b.height) return false;
  if (a.width > full * 0.85 || b.width > full * 0.85) return false;
  return Math.abs(a.width + b.width - full) <= Math.max(24, full * 0.03);
}

/** @returns {chrome.tabs.Tab[][]} groups in tab order */
export function groupTabs(tabs, windowWidth) {
  tabs = [...tabs].sort((a, b) => a.index - b.index);
  const full = fullWidth(tabs, windowWidth);
  const bySplitId = new Map();
  const groups = [];
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    if (hasSplitId(tab)) {
      let group = bySplitId.get(tab.splitViewId);
      if (!group) {
        group = [];
        bySplitId.set(tab.splitViewId, group);
        groups.push(group);
      }
      group.push(tab);
      continue;
    }
    const next = tabs[i + 1];
    if (next && !hasSplitId(next) && looksPaired(tab, next, full)) {
      groups.push([tab, next]);
      i++;
    } else {
      groups.push([tab]);
    }
  }
  return groups;
}
