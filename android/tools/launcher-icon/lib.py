"""Avatar-v2 shared helpers (2026-09-26). Pure code, 0 credits.

Sources (read-only):
  KEEP  = SHARDKEEP-release/art/game-v4/buildings/keep/l20/identity.png  (new v4 L20 keep, 144x136)
  WORDM = ROOT/refs/brand/wordmark-lockup-approved.png  (approved wordmark; text on an exact 4-px grid)
Only the wordmark's own glyphs are used (rows 416-580). The old keep above them is never used.
"""
import os
import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
# Read-only owner art: the game-v4 KEEP L20 identity lives in the backend repo (set PKW_BACKEND_ROOT to your checkout).
KDIR = os.path.join(os.environ.get('PKW_BACKEND_ROOT', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..')), 'art/game-v4/buildings/keep/l20/')
# The approved wordmark lockup from the dApp Store listing kit (refs/brand/wordmark-lockup-approved.png), tracked here so the
# icon regenerates without the kit; only its glyph rows (400-588 at the 4-px grid) are read.
WORDM = os.path.join(HERE, 'wordmark-lockup-approved.png')
FONT_PS2P = os.environ.get('PKW_FONT_PS2P', os.path.expanduser('~/Library/Fonts/PressStart2P-Regular.ttf'))
FONT_VT = os.environ.get('PKW_FONT_VT', os.path.expanduser('~/Library/Fonts/VT323-Regular.ttf'))

CREAM = (239, 232, 214)
OUTLINE = (26, 23, 30)
GOLD = (227, 174, 60)
CYAN = (92, 242, 255)


def keep(name='identity', frame=0, crop=True):
    im = Image.open(KDIR + name + '.png').convert('RGBA')
    im = im.crop((frame * 144, 0, frame * 144 + 144, 136))
    if crop:
        im = im.crop((13, 6, 130, 129))  # identity bbox -> 117x123
    return im


# core gem centre inside the cropped keep (art px). Measured below by keep_core().
def keep_core(k=None):
    k = k or keep()
    a = np.asarray(k).astype(int)
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    m = (al > 0) & (b > 180) & (g > 170) & (r < 170)
    ys, xs = np.nonzero(m)
    return float(xs.mean()), float(ys.mean())


def wordmark_1x():
    """The approved wordmark at its native 1/4 grid, lossless (phase 0 at y 400, x 0)."""
    a = np.asarray(Image.open(WORDM).convert('RGBA'))[400:588:4, 0:844:4]
    im = Image.fromarray(a.copy())
    return im.crop(im.getbbox())  # 209x41


def words():
    """Cut the approved glyph words (1x): PIXEL 60x16, KINGDOM 125x23, WARS 71x23, and the lockup 209x41."""
    w = wordmark_1x()
    return {
        'PIXEL': w.crop((75, 0, 135, 16)),
        'KINGDOM': w.crop((0, 18, 125, 41)),
        'WARS': w.crop((138, 18, 209, 41)),
        'KINGDOM WARS': w.crop((0, 18, 209, 41)),
        'LOCKUP': w,
    }


def up(im, k):
    return im.resize((im.width * k, im.height * k), Image.NEAREST)


def stack(lines, gap=1, align='center'):
    """Stack RGBA images vertically, centred. gap in px (can be negative: shared outline rows)."""
    W = max(i.width for i in lines)
    H = sum(i.height for i in lines) + gap * (len(lines) - 1)
    c = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    y = 0
    for i in lines:
        x = (W - i.width) // 2 if align == 'center' else 0
        c.alpha_composite(i, (x, y))
        y += i.height + gap
    return c


# ---------- float image helpers (0..1 RGB arrays) ----------
def f(im):
    return np.asarray(im.convert('RGB')).astype(np.float32) / 255.0


def to_img(a):
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))


def hexc(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], np.float32) / 255.0


def radial(W, H, cx, cy, rx, ry=None):
    ry = ry or rx
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    return np.sqrt(((xx + .5 - cx) / rx) ** 2 + ((yy + .5 - cy) / ry) ** 2)


def smooth(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def bg_radial(W, H, cx, cy, r, inner, outer, power=1.0):
    d = radial(W, H, cx, cy, r)
    t = smooth(d) ** power
    return hexc(inner)[None, None] * (1 - t[..., None]) + hexc(outer)[None, None] * t[..., None]


def glow_spot(W, H, cx, cy, r, color, strength, falloff=2.0):
    d = radial(W, H, cx, cy, r)
    g = np.clip(1 - d, 0, 1) ** falloff
    return g[..., None] * hexc(color)[None, None] * strength


def screen(base, add):
    return 1 - (1 - base) * (1 - np.clip(add, 0, 1))


def over(base, rgba_img, pos=(0, 0)):
    """Alpha-composite a PIL RGBA over a float RGB base at integer pos (clips)."""
    a = np.asarray(rgba_img).astype(np.float32) / 255.0
    x, y = pos
    H, W = base.shape[:2]
    h, w = a.shape[:2]
    x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
    if x1 <= x0 or y1 <= y0:
        return base
    s = a[y0 - y:y1 - y, x0 - x:x1 - x]
    al = s[..., 3:4]
    out = base.copy()
    out[y0:y1, x0:x1] = out[y0:y1, x0:x1] * (1 - al) + s[..., :3] * al
    return out


def blur_layer(rgba_img, radius):
    """Premultiplied gaussian blur of an RGBA image; returns float RGB (premultiplied) and alpha."""
    a = np.asarray(rgba_img).astype(np.float32) / 255.0
    pm = a[..., :3] * a[..., 3:4]
    ch = [Image.fromarray((pm[..., i] * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius)) for i in range(3)]
    al = Image.fromarray((a[..., 3] * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius))
    rgb = np.stack([np.asarray(c).astype(np.float32) / 255.0 for c in ch], -1)
    return rgb, np.asarray(al).astype(np.float32) / 255.0


def alpha_mask(img_rgba):
    return np.asarray(img_rgba)[..., 3] > 0


def rim(img_rgba, dirs, color, alpha, interior=True):
    """Pixel-grid rim light. For each opaque pixel with a transparent neighbour in any of `dirs` (dx,dy),
    tint the first interior pixel (one step opposite the edge) or the edge pixel itself."""
    a = np.asarray(img_rgba).astype(np.float32)
    m = a[..., 3] > 0
    H, W = m.shape
    hit = np.zeros_like(m)
    for dx, dy in dirs:
        nb = np.zeros_like(m)
        ys0, ys1 = max(0, -dy), H - max(0, dy)
        xs0, xs1 = max(0, -dx), W - max(0, dx)
        nb[ys0:ys1, xs0:xs1] = m[ys0 + dy:ys1 + dy, xs0 + dx:xs1 + dx]
        edge = m & ~nb
        if interior:
            # move one step inward (opposite the open side)
            inward = np.zeros_like(m)
            yy, xx = np.nonzero(edge)
            yy2, xx2 = yy - dy, xx - dx
            ok = (yy2 >= 0) & (yy2 < H) & (xx2 >= 0) & (xx2 < W)
            inward[yy2[ok], xx2[ok]] = True
            hit |= inward & m & ~edge
        else:
            hit |= edge
    c = np.array(color, np.float32)
    out = a.copy()
    out[hit, :3] = out[hit, :3] * (1 - alpha) + c * alpha
    return Image.fromarray(out.astype(np.uint8))


def outer_halo(img_rgba, color, alpha, dirs=((1, 0), (-1, 0), (0, 1), (0, -1))):
    """1-art-px halo just outside the silhouette (on the grid)."""
    a = np.asarray(img_rgba)
    m = a[..., 3] > 0
    H, W = m.shape
    halo = np.zeros_like(m)
    for dx, dy in dirs:
        sh = np.zeros_like(m)
        sh[max(0, dy):H - max(0, -dy), max(0, dx):W - max(0, -dx)] = m[max(0, -dy):H - max(0, dy), max(0, -dx):W - max(0, dx)]
        halo |= sh
    halo &= ~m
    out = np.zeros((H, W, 4), np.uint8)
    out[halo] = list(color) + [int(alpha * 255)]
    return Image.fromarray(out)


def noise_dither(a, amp=1.0 / 255, seed=7):
    rng = np.random.default_rng(seed)
    return a + (rng.random(a.shape[:2], dtype=np.float32)[..., None] - 0.5) * 2 * amp


def circle_mask(size, bg=(0, 0, 0, 0)):
    ss = 4
    m = Image.new('L', (size * ss, size * ss), 0)
    from PIL import ImageDraw
    ImageDraw.Draw(m).ellipse((0, 0, size * ss - 1, size * ss - 1), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def rounded_mask(size, radius_frac=0.12):
    ss = 4
    from PIL import ImageDraw
    m = Image.new('L', (size * ss, size * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size * ss - 1, size * ss - 1), radius=int(size * ss * radius_frac), fill=255)
    return m.resize((size, size), Image.LANCZOS)
