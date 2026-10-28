// Groups a window's tabs into cards: split views become one group of two tabs.
//
// Chrome 155+ reports split views via tab.splitViewId. Browsers that implement their own
// split view (e.g. Dia) leave it at -1, so fall back to geometry: two tabs whose widths add
// up to a full-width tab (minus the divider) are side by side. They are usually adjacent, but
// a tab opened from a split pane is inserted between them, so a later partner is accepted too;
// the card takes the position of the first pane.

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
  const paired = new Set(); // later tabs already taken as the second pane of a split
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    if (paired.has(tab)) continue;
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
    // Nearest later partner; the adjacent tab comes first, so the usual case is unchanged.
    const partner = tabs.slice(i + 1).find((other) =>
      !hasSplitId(other) && !paired.has(other) && looksPaired(tab, other, full));
    if (partner) {
      paired.add(partner);
      groups.push([tab, partner]);
    } else {
      groups.push([tab]);
    }
  }
  return groups;
}
