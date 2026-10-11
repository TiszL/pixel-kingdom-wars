// Zoomable minimap (D-164.6, plan §8.1): a GL pass in the main context over a DOM-positioned rect.
// Every base is a point (gold = mine, white = others, red = attackable when that filter is on,
// filtered-out dimmed), plus the main view's box and a pulsing selection. With no filter active ('All') every
// base is a faint density haze at the fit zoom, so clusters never bleach into white blocks (Gate A OB-7);
// zoomed in, dots are ≤ 0.55 deed with a dark rim at 70 %; your own base is a ≥ 5-CSS-px gold marker with a
// dark outline, and the selection pulse draws last (PM-9). It has its own camera:
// zoom runs from "fit realm" (z = 0) to 12× the main view's width (z = 1); zoomed in it follows the
// main view. The UI owns the DOM hit-div and calls toDeed()/zoomBy()/reset() (plan §8.1 input rules).
// It is redrawn with each main frame (the main canvas does not preserve its buffer) — one quad plus
// ≤ 16k instanced points, well under a millisecond.
import { MINI_VS, MINI_FS, DOTS_VS, DOTS_FS } from './glsl/minimap.glsl.mjs';
import { plotCentre, DEED_PX } from './contracts.mjs';

// a base's dot sits on its plot (plotOffset, visual only), an open deed on its deed centre
const at = b => (b.free || typeof b.level !== 'number' ? { x: b.x + 0.5, y: b.y + 0.5 } : plotCentre(b.x, b.y, b.level));

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/**
 * Distance (deeds, chamfer 1/√2) from this realm's own deeds, per deed (pure; exported for tests). The minimap keeps the
 * painting within ~3.5 deeds of the realm and shows the open sea beyond, like the main map's chart (GROUND rmKeep,
 * GA2-04): the painting's frame and the neighbours' land blocks are not part of this realm (QA GA2 #4, GROUND's request).
 */
export function farDeeds(deeds, cols, rows) {
  const D = new Float32Array(cols * rows).fill(1e9), S2 = Math.SQRT2;
  for (let i = 0; i < cols * rows; i++) if (deeds[i] === DEED_PX.thisRealm) D[i] = 0;
  const relax = (x, y, dx, dy, w) => { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= cols || Y >= rows) return; const v = D[Y * cols + X] + w; if (v < D[y * cols + x]) D[y * cols + x] = v; };
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { relax(x, y, -1, 0, 1); relax(x, y, 0, -1, 1); relax(x, y, -1, -1, S2); relax(x, y, 1, -1, S2); }
  for (let y = rows - 1; y >= 0; y--) for (let x = cols - 1; x >= 0; x--) { relax(x, y, 1, 0, 1); relax(x, y, 0, 1, 1); relax(x, y, 1, 1, S2); relax(x, y, -1, 1, S2); }
  return D;
}
/** The painting's own open-sea colour (0..1 RGB): its outer 3-px ring, blue-dominant pixels only (as GROUND's seaFar). */
export function ringSea(img) {
  const { width: W, height: H, data } = img, ring = [0, 0, 0, 0], all = [0, 0, 0, 0];
  const add = (x, y) => {
    const o = (y * W + x) * 4, r = data[o], g = data[o + 1], b = data[o + 2];
    all[0] += r; all[1] += g; all[2] += b; all[3]++;
    if (b > r + 12 && b > g && r + g + b < 420) { ring[0] += r; ring[1] += g; ring[2] += b; ring[3]++; }
  };
  // only the ring's pixels are visited (stage B D1/D4: the whole-image scan with a skip was 0.6–1.9 M iterations at entry)
  for (let y = 0; y < H; y++) {
    if (y < 3 || y >= H - 3) { for (let x = 0; x < W; x++) add(x, y); continue; }
    for (let x = 0; x < Math.min(3, W); x++) add(x, y);
    for (let x = Math.max(3, W - 3); x < W; x++) add(x, y);
  }
  const c = ring[3] >= all[3] * 0.2 ? ring : all;
  return c[3] ? [c[0] / c[3] / 255, c[1] / c[3] / 255, c[2] / c[3] / 255] : [0.05, 0.13, 0.27];
}

export function createMinimap(core) {
  const gl = core.gl;
  let pChart, pDots, chart, deeds, far, sea = [0.05, 0.13, 0.27], vao, inst, n = 0, first = [0, 0], cols = 1, rows = 1, z = 0, rectCss = null, lastMini = null, frozen = null, filterOn = false;
  const minZoomViewFactor = 12;

  function viewRect(view) { // the minimap's deed rect for the current zoom (frozen during a viewport-box drag)
    if (frozen) return frozen;
    const aspect = rectCss ? rectCss.w / rectCss.h : 1;
    let fitW = cols, fitH = rows; if (fitW / fitH > aspect) fitH = fitW / aspect; else fitW = fitH * aspect;
    const mainW = view ? view.W / view.s : cols, localW = Math.min(fitW, mainW * minZoomViewFactor);
    const w = Math.exp(Math.log(fitW) + (Math.log(localW) - Math.log(fitW)) * z), h = w / aspect;
    let cx = cols / 2, cy = rows / 2;
    if (z > 0 && view) { // follow the main view, blended in with zoom, kept inside the realm
      const k = Math.min(1, z * 3);
      cx = cx + (view.x - cx) * k; cy = cy + (view.y - cy) * k;
      if (w < cols) cx = clamp(cx, w / 2, cols - w / 2); else cx = cols / 2;
      if (h < rows) cy = clamp(cy, h / 2, rows - h / 2); else cy = rows / 2;
    }
    return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
  }

  return {
    async load(pack) {
      pChart = core.program('minimap', { vs: MINI_VS, fs: MINI_FS });
      pDots = core.program('minimap-dots', { vs: DOTS_VS, fs: DOTS_FS });
      ({ cols, rows } = pack.meta.grid);
      chart = core.tex.shared(`${pack.id}:chart8`, () => core.tex.image(pack.first.chart8, { mips: true }));
      deeds = core.tex.shared(`${pack.id}:deeds`, () => core.tex.data(cols, rows, 'R8UI', null, null, pack.first.deeds));
      far = core.tex.shared(`${pack.id}:minifar`, () => core.tex.data(cols, rows, 'R8', null, null, Uint8Array.from(farDeeds(pack.first.deeds, cols, rows), v => Math.min(255, Math.round(v * 16))), { filter: 'linear' }));
      inst = gl.createBuffer(); vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, core.quadBuffer); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, inst); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(1, 1);
      gl.bindVertexArray(null); z = 0;
      // the open-sea colour arrives with the decoded painting (GROUND reads the same pixels); until then the default sea
      Promise.resolve().then(() => pack.pixels(pack.first.chartKey ?? 'chart8.webp')).then(img => { sea = ringSea(img); core.invalidate(); }, () => { /* stale or no pixels: default sea */ });
    },
    /** bases: all; inSet: filtered-in set; sel: the selected base (or free deed); attack: attack filter on; active: any filter on. */
    setBases(bases, inSet, sel, attack, active = true) {
      if (!inst) return; filterOn = !!active;
      const a = new Float32Array((bases.length + 1) * 4); n = 0;
      // others first, then mine on top; the selection last
      const order = bases.filter(b => !b.mine).concat(bases.filter(b => b.mine));
      for (const b of order) { const o = n++ * 4, p = at(b); a[o] = p.x; a[o + 1] = p.y; a[o + 2] = (b.mine ? 1 : 0) | (filterOn && inSet?.has(b) ? 2 : 0) | (attack && b.attackable ? 4 : 0); }
      if (sel) { const o = n++ * 4, p = at(sel); a[o] = p.x; a[o + 1] = p.y; a[o + 2] = 8; }
      if (n) first = [a[0], a[1]]; // the band rehearsal centres its one dot here
      gl.bindBuffer(gl.ARRAY_BUFFER, inst); gl.bufferData(gl.ARRAY_BUFFER, a.subarray(0, n * 4), gl.DYNAMIC_DRAW);
      core.invalidate();
    },
    /** rect: the minimap's DOM rect in CSS px ({ x, y, w, h }) or null when collapsed. */
    draw(view, rect) {
      rectCss = rect; if (!rect || !pChart || !chart) return;
      const dpr = view.dpr, ch = gl.canvas.height;
      const x = Math.round(rect.x * dpr), y = Math.round(ch - (rect.y + rect.h) * dpr), w = Math.round(rect.w * dpr), h = Math.round(rect.h * dpr);
      if (w < 4 || h < 4) return;
      const m = viewRect(view); lastMini = m;
      gl.enable(gl.SCISSOR_TEST); gl.scissor(x, y, w, h); gl.viewport(x, y, w, h);
      pChart.use(); pChart.tex('uChart', 0, chart); pChart.tex('uDeeds', 1, deeds); pChart.tex('uFar', 2, far); gl.uniform3fv(pChart.u('uSea'), sea);
      gl.uniform4f(pChart.u('uMini'), ...m); gl.uniform4f(pChart.u('uBox'), view.rect.fx0, view.rect.fy0, view.rect.fx1, view.rect.fy1);
      gl.uniform4f(pChart.u('uPx'), w, h, dpr, 10 * dpr); gl.uniform2f(pChart.u('uOrigin'), x, y);
      core.fullscreen();
      if (n) {
        const deedPx = w / (m[2] - m[0]), zoomT = clamp((deedPx - 2.5) / 3.5, 0, 1); // 0 = density haze, 1 = distinct dots
        pDots.use(); gl.uniform4f(pDots.u('uMini'), ...m); gl.uniform4f(pDots.u('uPx'), w, h, dpr, 0);
        gl.uniform1f(pDots.u('uDot'), clamp(deedPx * 0.55, 1, 4));     // device px (1 px at the fit zoom: dense clusters stay a haze)
        gl.uniform1f(pDots.u('uMine'), Math.max(5 * dpr, deedPx * 1.2)); // own base marker, device px
        gl.uniform2f(pDots.u('uAlpha'), 0.2 + 0.5 * zoomT, filterOn ? 1 : 0); // unfiltered alpha · filter active
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindVertexArray(vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n); gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
      }
      gl.disable(gl.SCISSOR_TEST); gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    },
    /**
     * SHELL band rehearsal (contract v2, contracts GPU_SAFE.rehearse): the minimap is hidden at FAR, so its two programs'
     * first draws (the driver builds their pipelines then) landed on the FAR→MAP change. Draws `prog` with its real draw's
     * state — canvas, depth test off; the chart opaque with its three textures on units 0–2 (a full-screen pass: it covers
     * the view centre); the dots blended, ONE instance (the first base) whose minimap rect is centred on it and 8 px wide,
     * so it lands on the view centre and shades fragments — and keeps none of that state. → false: not loaded / no bases.
     */
    rehearse(prog) {
      if (!pChart || !chart) return false;
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      if (prog === pChart) { pChart.use(); pChart.tex('uChart', 0, chart); pChart.tex('uDeeds', 1, deeds); pChart.tex('uFar', 2, far); core.fullscreen(); return true; }
      if (prog !== pDots || !n) return false;
      const W = gl.canvas.width, H = gl.canvas.height, e = 16 / Math.max(1, W); // (SHELL's viewport is canvas-sized)
      pDots.use(); gl.uniform4f(pDots.u('uMini'), first[0] - e * W / 2, first[1] - e * H / 2, first[0] + e * W / 2, first[1] + e * H / 2);
      gl.uniform4f(pDots.u('uPx'), W, H, 1, 0); gl.uniform1f(pDots.u('uDot'), 8); gl.uniform1f(pDots.u('uMine'), 8); gl.uniform2f(pDots.u('uAlpha'), 1, 0);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1); gl.bindVertexArray(null); gl.disable(gl.BLEND);
      return true;
    },
    /** Minimap-local CSS px → deed coords (for tap → flyTo and viewport-box drags). */
    toDeed(mx, my) { if (!lastMini || !rectCss) return null; const m = lastMini; return [m[0] + mx / rectCss.w * (m[2] - m[0]), m[1] + my / rectCss.h * (m[3] - m[1])]; },
    /**
     * Is the minimap point on the main view box (for box drags)? The grab zone is ≥ 44 × 44 CSS px however small
     * the box draws (Gate A PM-3: an 18-px zone at fit on a phone).
     */
    inBox(mx, my, view) {
      const p = this.toDeed(mx, my); if (!p || !view) return false; const r = view.rect, dpp = this.deedPerPx();
      const px = Math.max(8, (44 - (r.fx1 - r.fx0) / dpp) / 2) * dpp, py = Math.max(8, (44 - (r.fy1 - r.fy0) / dpp) / 2) * dpp;
      return p[0] > r.fx0 - px && p[0] < r.fx1 + px && p[1] > r.fy0 - py && p[1] < r.fy1 + py;
    },
    /** Deeds per minimap CSS px at the current (or frozen) zoom. */
    deedPerPx() { return lastMini && rectCss ? (lastMini[2] - lastMini[0]) / rectCss.w : 1; },
    /** Hold the minimap's own camera still (a viewport-box drag maps finger deltas through this rect). */
    freeze() { frozen = lastMini ? lastMini.slice() : null; },
    unfreeze() { frozen = null; core.invalidate(); },
    zoomBy(k) { z = clamp(z + Math.log(k) / Math.log(minZoomViewFactor * 2), 0, 1); core.invalidate(); },
    reset() { z = 0; core.invalidate(); },
    get zoom() { return z; }, set zoom(v) { z = clamp(v, 0, 1); core.invalidate(); },
    stats: () => ({ zoom: z, points: n }),
  };
}
