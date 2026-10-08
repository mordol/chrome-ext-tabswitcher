// Window/grid geometry shared by the service worker (initial window placement)
// and the switcher page (re-fit when tabs are added or closed).

export const M = {
  pad: 14,        // grid padding
  gap: 12,        // gap between cards
  header: 48,     // toolbar height
  titleH: 42,     // title area under the thumbnail
  ratio: 0.625,   // thumbnail height / width (16:10)
  minCard: 120,   // default for the user's minimum thumbnail width setting
  prefCard: 160,  // edge presets keep a single strip as long as cards stay at least this wide
  maxCard: 340,
  margin: 8,      // distance from the screen edge for edge presets
};

// Max outer size of the switcher window per preset, as a fraction of the work area.
const BOX = {
  center: { w: 0.8, h: 0.8 },
  top: { w: 0.96, h: 0.45 },
  bottom: { w: 0.96, h: 0.45 },
  left: { w: 0.4, h: 0.96 },
  right: { w: 0.4, h: 0.96 },
};

export const cardHeight = (w) => Math.round(w * M.ratio) + M.titleH;

const gridWidth = (cols, w) => M.pad * 2 + cols * w + (cols - 1) * M.gap;
const gridHeight = (rows, w) => M.header + M.pad * 2 + rows * cardHeight(w) + (rows - 1) * M.gap;

// Largest card width for a cols x rows grid inside an inner (viewport) size.
function fitCardWidth(cols, rows, innerW, innerH) {
  const byWidth = (innerW - M.pad * 2 - (cols - 1) * M.gap) / cols;
  const byHeight = ((innerH - M.header - M.pad * 2 - (rows - 1) * M.gap) / rows - M.titleH) / M.ratio;
  return Math.floor(Math.min(byWidth, byHeight));
}

// Columns that fit across innerW at the given card width.
const colsAt = (w, innerW) => Math.max(1, Math.floor((innerW - M.pad * 2 + M.gap) / (w + M.gap)));

// Outer window position for a preset.
export function placeWindow(preset, area, width, height) {
  const right = area.left + area.width;
  const bottom = area.top + area.height;
  const centerLeft = area.left + Math.round((area.width - width) / 2);
  const centerTop = area.top + Math.round((area.height - height) / 2);
  const [left, top] = {
    center: [centerLeft, centerTop],
    top: [centerLeft, area.top + M.margin],
    bottom: [centerLeft, bottom - height - M.margin],
    left: [area.left + M.margin, centerTop],
    right: [right - width - M.margin, centerTop],
  }[preset] || [centerLeft, centerTop];
  return { left, top };
}

/**
 * @param {object} p
 * @param {number} p.count    number of cards
 * @param {string} p.preset   center | top | bottom | left | right
 * @param {number} p.columns  column count for the center preset
 * @param {{left:number,top:number,width:number,height:number}} p.area  display work area
 * @param {{w:number,h:number}} p.frame  window frame size in screen px (outer - inner * zoom)
 * @param {number} p.minCard  minimum card width; below it the grid scrolls
 * @param {number} p.zoom     page zoom of the switcher; grid metrics are CSS px, window bounds screen px
 */
export function computeLayout({ count, preset, columns, area, frame, minCard = M.minCard, zoom = 1 }) {
  count = Math.max(1, count);
  const box = BOX[preset] || BOX.center;
  const maxOuterW = Math.floor(area.width * box.w);
  const maxOuterH = Math.floor(area.height * box.h);
  const maxW = (maxOuterW - frame.w) / zoom;
  const maxH = (maxOuterH - frame.h) / zoom;
  const horizontal = preset === 'top' || preset === 'bottom';

  const colOptions = preset === 'center' || !BOX[preset]
    ? [Math.min(columns, count)]
    : Array.from({ length: count }, (_, i) => (horizontal ? count - i : i + 1));

  let best = null;
  for (const cols of colOptions) {
    const rows = Math.ceil(count / cols);
    const w = Math.min(M.maxCard, fitCardWidth(cols, rows, maxW, maxH));
    // Edge presets: the first (thinnest) shape with comfortably sized cards wins,
    // e.g. a single row for top/bottom. Otherwise larger cards win; ties prefer the thinner shape.
    if (!best?.pref) {
      const pref = preset !== 'center' && w >= M.prefCard;
      const thinner = horizontal ? rows < best?.rows : cols < best?.cols;
      if (pref || !best || w > best.w || (w === best.w && thinner)) best = { cols, rows, w, pref };
    }
  }

  let { cols, rows, w } = best;
  let scroll = false;
  if (w < minCard) {
    // Too many tabs to fit: use the minimum card size, fill the width, and scroll.
    w = minCard;
    const fitCols = colsAt(w, maxW);
    cols = preset === 'center' ? Math.min(columns, count, fitCols) : Math.min(count, fitCols);
    rows = Math.ceil(count / cols);
    scroll = true;
  }

  const width = Math.min(maxOuterW, Math.round(gridWidth(cols, w) * zoom) + frame.w);
  const height = Math.min(maxOuterH, Math.round(gridHeight(rows, w) * zoom) + frame.h);
  return { cols, rows, cardW: w, scroll, width, height, ...placeWindow(preset, area, width, height) };
}

/**
 * Fit cards into a window whose size the user chose. The window keeps its size and the cards
 * scale instead: a wide window is filled by height, a tall one by width (whichever constrains).
 * More tabs make cards smaller; below minCard they stay at minCard and the grid scrolls.
 */
export function fitToWindow({ count, innerW, innerH, minCard = M.minCard }) {
  count = Math.max(1, count);
  let best = null;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const w = fitCardWidth(cols, rows, innerW, innerH);
    if (!best || w > best.w) best = { cols, w };
  }
  if (best.w >= minCard) return { cols: best.cols, cardW: best.w, scroll: false };
  return { cols: Math.min(count, colsAt(minCard, innerW)), cardW: minCard, scroll: true };
}

// Toolbar popup: Chrome caps popups at 800x600, so only the card width scales.
export function computePopupLayout(columns) {
  const width = 780;
  const cardW = Math.floor((width - M.pad * 2 - (columns - 1) * M.gap) / columns);
  return { cols: columns, cardW, width };
}
