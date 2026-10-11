// Label placement (8acdf059 src/main.js placeLabel): each realm or island name sits on its anchor, nudged at most half
// its width sideways and 36 px up or down off the chrome rects, the screen edges and the names already placed (realms
// first); a name that fits nowhere is hidden. Pure: the HUD measures its labels and places them with this.

/** anchor [x, y]; label w × h; rects {x0, y0, x1, y1} to keep clear of; screen W × H. Returns [x0, y0] or null. */
export function placeLabel(anchor, w, h, rects, W, H) { const m = 4, bx = anchor[0] - w / 2, by = anchor[1] - h / 2, xs = [0], ys = [0];
  if (bx < m) xs.push(m - bx); if (bx + w > W - m) xs.push(W - m - w - bx); if (by < m) ys.push(m - by); if (by + h > H - m) ys.push(H - m - h - by);
  for (const r of rects) { xs.push(r.x0 - m - bx - w, r.x1 + m - bx); ys.push(r.y0 - m - by - h, r.y1 + m - by); }
  let best = null, bd = Infinity;
  for (const dx of xs) if (Math.abs(dx) <= w / 2 + 6) for (const dy of ys) { if (Math.abs(dy) > 36) continue; const dd = Math.hypot(dx, dy * 1.5); if (dd >= bd) continue;
    const x0 = bx + dx, y0 = by + dy, x1 = x0 + w, y1 = y0 + h; if (x0 < m || y0 < m || x1 > W - m || y1 > H - m) continue;
    if (rects.some(r => x0 < r.x1 + m && x1 > r.x0 - m && y0 < r.y1 + m && y1 > r.y0 - m)) continue; best = [x0, y0]; bd = dd; }
  return best; }

/** Place a frame's anchors in order (realms first, as the globe publishes them); each placed name joins the rects. */
export function placeLabels(anchors, sizeOf, rects, W, H) {
  const taken = rects.slice(), out = [];
  for (const a of anchors) { const [w, h] = sizeOf(a); const p = placeLabel([a.x, a.y], w, h, taken, W, H); if (!p) continue;
    taken.push({ x0: p[0], y0: p[1], x1: p[0] + w, y1: p[1] + h }); out.push({ ...a, left: p[0], top: p[1] }); }
  return out;
}
