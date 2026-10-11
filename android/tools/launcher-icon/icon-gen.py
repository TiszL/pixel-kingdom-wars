"""Launcher icon set from the owner-picked avatar V1 ("Crest stack", x/avatar-v2/OWNER-PICK.md).
Same composition code as v1.py, rendered as adaptive layers: background = midnight navy radial + cyan glow + vignette;
foreground = keep (rim lights, base scrim) + stacked wordmark + core bloom + text shadow plate, with alpha.
Sources are read-only (game-v4 keep L20 identity, approved wordmark). Nothing here writes into the listing folder."""
import sys, os, math, json
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
A = 200            # V1 art grid
KEEP_TOP, TEXT_TOP, SCRIM_START, SCRIM_LEN = 14, 118, 96, 26

def content_layer(K):
    """Foreground on the 200-art-px grid at integer scale K: returns RGBA (A*K x A*K) and the core centre (px)."""
    S = A * K
    k = lib.keep(); cxc, cyc = lib.keep_core(k)
    kx = (A - k.width) // 2; ky = KEEP_TOP
    kl = lib.rim(k, [(-1, 0), (0, -1), (-1, -1)], (255, 238, 200), 0.30)
    kl = lib.rim(kl, [(1, 0), (1, -1)], (150, 235, 255), 0.35)
    w = lib.words(); txt = lib.stack([w['PIXEL'], w['KINGDOM'], w['WARS']], gap=1)
    tx = (A - txt.width) // 2; ty = TEXT_TOP
    core = ((kx + cxc + .5) * K, (ky + cyc + .5) * K)
    keep_big = lib.up(kl, K); ka = np.asarray(keep_big).astype(np.float32)
    yy = np.arange(keep_big.height)[:, None] / K
    t = lib.smooth(np.clip((yy - SCRIM_START) / SCRIM_LEN, 0, 1))[..., None]
    dark = np.array([10, 14, 28], np.float32)
    ka[..., :3] = ka[..., :3] * (1 - 0.85 * t) + dark * (0.85 * t); ka[..., 3] = ka[..., 3] * (1 - t[..., 0])
    fg = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    # text shadow plate (soft dark, alpha only) under the wordmark
    tb = lib.up(txt, K)
    _, al = lib.blur_layer(Image.fromarray(np.dstack([np.zeros((tb.height, tb.width, 3), np.uint8), np.asarray(tb)[..., 3]])), 10 * K / 2)
    pad = np.zeros((S, S), np.float32); x0, y0 = tx * K, ty * K
    pad[y0:y0 + tb.height, x0:x0 + tb.width] = al[:S - y0, :S - x0]
    shadow = np.zeros((S, S, 4), np.uint8); shadow[..., 3] = (np.clip(pad * 0.55, 0, 1) * 255).astype(np.uint8)
    fg.alpha_composite(Image.fromarray(shadow))
    fg.alpha_composite(Image.fromarray(ka.astype(np.uint8)), (kx * K, ky * K))
    fg.alpha_composite(tb, (x0, y0))
    # core bloom as additive light with alpha (screen-like on any background)
    for r, col, st, fo in ((46, '#6FF6FF', 0.55, 2.2), (16, '#E6FFFF', 0.45, 1.5)):
        g = lib.glow_spot(S, S, core[0], core[1], r * K / 2, col, st, falloff=fo)
        a = np.clip(g.max(axis=2), 0, 1)
        rgb = np.where(a[..., None] > 0, g / np.maximum(a[..., None], 1e-6), 0)
        layer = np.dstack([np.clip(rgb, 0, 1) * 255, a * 255]).astype(np.uint8)
        fg.alpha_composite(Image.fromarray(layer))
    return fg, core

def background(S, core_rel):
    """Navy radial + glow spot at the core + vignette, as float RGB (S x S). core_rel in 0..1 canvas units."""
    bg = lib.bg_radial(S, S, S / 2, S * 0.42, S * 0.78, '#15213F', '#04060C', power=0.9)
    bg = bg + lib.glow_spot(S, S, core_rel[0] * S, core_rel[1] * S, 190 * S / 400, '#1FB8E6', 0.22, falloff=1.6)
    v = lib.smooth(lib.radial(S, S, S / 2, S / 2, S * 0.72))
    return bg * (1 - 0.35 * v[..., None])

# --- 1. high-res content (K=8 -> 1600) and its silhouette ---
K = 8
fg16, core16 = content_layer(K)
alpha = np.asarray(fg16)[..., 3] > 8
ys, xs = np.nonzero(alpha)
cx_c, cy_c = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2   # content bbox centre (px @1600)
# radius of the silhouette around the bbox centre (px @1600)
rmax = np.sqrt((xs - cx_c) ** 2 + (ys - cy_c) ** 2).max()
# --- 2. adaptive canvas 108 dp = 432 px @xxxhdpi; safe circle 66 dp = 264 px, keep a 2 dp margin ---
CAN, SAFE = 432, 264 - 8
scale = (SAFE / 2) / rmax                       # px@432 per px@1600
content_px = np.array(fg16.size) * scale
print(json.dumps({'silhouette_radius_px1600': round(float(rmax), 1), 'scale': round(float(scale), 4),
                  'content_canvas_px': [round(float(v), 1) for v in content_px], 'content_frac_of_108dp': round(float(content_px[0]) / CAN, 3)}))
fg_small = fg16.resize((int(round(fg16.width * scale)), int(round(fg16.height * scale))), Image.LANCZOS)
# place so the silhouette centre sits at the canvas centre
off = (int(round(CAN / 2 - cx_c * scale)), int(round(CAN / 2 - cy_c * scale)))
fg432 = Image.new('RGBA', (CAN, CAN), (0, 0, 0, 0)); fg432.alpha_composite(fg_small, off)
core_rel = ((core16[0] * scale + off[0]) / CAN, (core16[1] * scale + off[1]) / CAN)
bg432 = lib.to_img(background(CAN, core_rel)).convert('RGBA')
# --- 3. densities ---
dens = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for name, m in dens.items():
    px = int(108 * m)
    fg = fg432.resize((px, px), Image.LANCZOS) if px != CAN else fg432
    bg = lib.to_img(background(px, core_rel)).convert('RGBA')
    d = os.path.join(OUT, f'mipmap-{name}'); os.makedirs(d, exist_ok=True)
    fg.save(os.path.join(d, 'ic_launcher_foreground.png')); bg.save(os.path.join(d, 'ic_launcher_background.png'))
    # legacy 48 dp: full composite (square) and round
    lp = int(48 * m)
    comp = Image.alpha_composite(bg432, fg432).resize((lp, lp), Image.LANCZOS)
    comp.save(os.path.join(d, 'ic_launcher.png'))
    rnd = comp.copy(); rnd.putalpha(lib.circle_mask(lp)); rnd.save(os.path.join(d, 'ic_launcher_round.png'))
# --- 4. masters: 1000x1000 V1 export (K=5 grid-exact, effects scaled) and a 1024 square icon composite ---
S = 1000; Kb = 5
fgm, corem = content_layer(Kb)
bgm = background(S, (corem[0] / S, corem[1] / S))
master = Image.alpha_composite(lib.to_img(bgm).convert('RGBA'), fgm)
master = lib.to_img(lib.noise_dither(np.asarray(master.convert('RGB')).astype(np.float32) / 255, 1.2 / 255)); master.save(os.path.join(OUT, 'avatar-V1-1000.png'))
Image.alpha_composite(bg432, fg432).resize((1024, 1024), Image.LANCZOS).convert('RGB').save(os.path.join(OUT, 'icon-1024-square.png'))
# --- 5. previews: square, rounded, circle, squircle-ish at 192 ---
pv = Image.new('RGB', (4 * 212 + 20, 232), (34, 34, 34)); comp = Image.alpha_composite(bg432, fg432).resize((192, 192), Image.LANCZOS)
masks = [None, lib.rounded_mask(192, 0.18), lib.circle_mask(192), lib.rounded_mask(192, 0.30)]
for i, mk in enumerate(masks):
    tile = comp.copy()
    if mk is not None: tile.putalpha(mk)
    base = Image.new('RGBA', (192, 192), (34, 34, 34, 255)); base.alpha_composite(tile); pv.paste(base.convert('RGB'), (20 + i * 212, 20))
# safe-zone overlay check
chk = Image.alpha_composite(bg432, fg432).convert('RGB'); dr = ImageDraw.Draw(chk); dr.ellipse((CAN/2-132, CAN/2-132, CAN/2+132, CAN/2+132), outline=(255, 0, 0)); dr.rectangle((CAN/2-144, CAN/2-144, CAN/2+144, CAN/2+144), outline=(0, 255, 0)); chk.save(os.path.join(OUT, 'safe-zone-check.png'))
pv.save(os.path.join(OUT, 'preview-masks.png'))
print('done')
