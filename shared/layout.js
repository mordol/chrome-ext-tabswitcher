// Window/grid geometry shared by the service worker (initial window placement)
// and the switcher page (re-fit when tabs are added or closed).

export const M = {
  pad: 14,        // grid padding
  gap: 12,        // gap between cards
  header: 48,     // toolbar height
  titleH: 42,     // title area under the thumbnail
  ratio: 0.625,   // thumbnail height / width (16:10)
  minCard: 120,
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

/**
 * @param {object} p
 * @param {number} p.count    number of cards
 * @param {string} p.preset   center | top | bottom | left | right
 * @param {number} p.columns  column count for the center preset
 * @param {{left:number,top:number,width:number,height:number}} p.area  display work area
 * @param {{w:number,h:number}} p.frame  window frame size (outer - inner)
 */
export function computeLayout({ count, preset, columns, area, frame }) {
  count = Math.max(1, count);
  const box = BOX[preset] || BOX.center;
  const maxOuterW = Math.floor(area.width * box.w);
  const maxOuterH = Math.floor(area.height * box.h);
  const maxW = maxOuterW - frame.w;
  const maxH = maxOuterH - frame.h;
  const horizontal = preset === 'top' || preset === 'bottom';

  const colOptions = preset === 'center' || !BOX[preset]
    ? [Math.min(columns, count)]
    : Array.from({ length: count }, (_, i) => (horizontal ? count - i : i + 1));

  let best = null;
  for (const cols of colOptions) {
    const rows = Math.ceil(count / cols);
    const byWidth = (maxW - M.pad * 2 - (cols - 1) * M.gap) / cols;
    const byHeight = ((maxH - M.header - M.pad * 2 - (rows - 1) * M.gap) / rows - M.titleH) / M.ratio;
    const w = Math.floor(Math.min(M.maxCard, byWidth, byHeight));
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
  if (w < M.minCard) {
    // Too many tabs to fit: use the minimum card size, fill the width, and scroll.
    w = M.minCard;
    const fitCols = Math.max(1, Math.floor((maxW - M.pad * 2 + M.gap) / (w + M.gap)));
    cols = preset === 'center' ? Math.min(columns, count, fitCols) : Math.min(count, fitCols);
    rows = Math.ceil(count / cols);
    scroll = true;
  }

  const width = Math.min(maxOuterW, gridWidth(cols, w) + frame.w);
  const height = Math.min(maxOuterH, gridHeight(rows, w) + frame.h);
  const right = area.left + area.width;
  const bottom = area.top + area.height;
  const centerLeft = area.left + Math.round((area.width - width) / 2);
  const centerTop = area.top + Math.round((area.height - height) / 2);

  const pos = {
    center: [centerLeft, centerTop],
    top: [centerLeft, area.top + M.margin],
    bottom: [centerLeft, bottom - height - M.margin],
    left: [area.left + M.margin, centerTop],
    right: [right - width - M.margin, centerTop],
  }[preset] || [centerLeft, centerTop];

  return { cols, rows, cardW: w, scroll, width, height, left: pos[0], top: pos[1] };
}

// Toolbar popup: Chrome caps popups at 800x600, so only the card width scales.
export function computePopupLayout(columns) {
  const width = 780;
  const cardW = Math.floor((width - M.pad * 2 - (columns - 1) * M.gap) / columns);
  return { cols: columns, cardW, width };
}
