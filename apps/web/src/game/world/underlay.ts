/**
 * Pure presentation data for the grass skirt outside the authoritative plot.
 * The scene turns these specs into non-interactive Images; no returned value is
 * an obstacle or enters placement/simulation state.
 */

import { isRealmKitBaseVisualContext, resolveBaseVisualContext } from '@shardkeep/shared/baseVisual';

/** One decor sprite to place. x/y are world px; the anchor is the sprite's. */
export interface DecorSpec {
  key: string;
  x: number;
  y: number;
  /** Painter depth, already clamped to ≤899 for skirt decor. */
  depth: number;
}

export interface ClaimPerimeterSpec {
  segments: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  stones: DecorSpec[];
}

const SKIRT_TILES = 10; // 640 App px / 32 = 10 tiles → SKIRT*T world px
const DECOR_DEPTH_MAX = 899;

/** Every existing outer-world prop key; no new asset or gameplay identity. */
const PROPS = [
  'dec_pine_1',
  'dec_bush',
  'dec_boulder',
  'dec_pine_2',
  'dec_stump',
  'dec_tree_old',
  'dec_rock_s',
  'dec_rock_l',
] as const;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Stable integer mixing only: deterministic across reloads, with no random seed. */
function mix32(value: number): number {
  let mixed = value | 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

function sample(side: number, cluster: number, item: number, salt: number): number {
  return mix32(
    Math.imul(side + 1, 0x1f123bb5)
      ^ Math.imul(cluster + 1, 0x5f356495)
      ^ Math.imul(item + 1, 0x2c1b3c6d)
      ^ salt,
  );
}

/**
 * Whether the scene draws the dashed perimeter and its eight stones for this
 * visual context. Revisions ≤4 (paintings that know nothing of the claim) keep
 * them. Revision 5 (docs/REALM-KIT-PLAN.md §3, D-173) does not: the terrain's
 * own corner-Wang edge ring, generated from the same server claim, IS the
 * boundary, and a stroke on top would draw it twice.
 */
export function claimPerimeterDrawn(context?: unknown): boolean {
  return !isRealmKitBaseVisualContext(resolveBaseVisualContext(context));
}

/**
 * Persistent, authoritative claim read without recreating the rejected square
 * plot wash. Broken strokes follow the exact [min,max) edge; deterministic
 * sub-tile wobble and sparse existing rocks keep it part of the terrain.
 * Consulted only when claimPerimeterDrawn(context) holds.
 */
export function claimPerimeter(
  claim: { min: number; max: number },
  T: number,
  style: {
    dashMinTiles: number; dashJitterTiles: number;
    gapMinTiles: number; gapJitterTiles: number;
    wobbleTiles: number; stoneOffsetTiles: number;
  },
): ClaimPerimeterSpec {
  const lo = claim.min * T;
  const hi = claim.max * T;
  const segments: ClaimPerimeterSpec['segments'] = [];
  for (let side = 0; side < 4; side++) {
    let cursor = lo;
    let index = 0;
    while (cursor < hi) {
      const dash = (style.dashMinTiles
        + (sample(side, index, 0, 0x517) % 101) / 100 * style.dashJitterTiles) * T;
      const gap = (style.gapMinTiles
        + (sample(side, index, 0, 0x729) % 101) / 100 * style.gapJitterTiles) * T;
      const end = Math.min(hi, cursor + dash);
      const wobble = (((sample(side, index, 0, 0x93b) % 201) - 100) / 100)
        * style.wobbleTiles * T;
      if (side === 0) segments.push({ x1: cursor, y1: lo + wobble, x2: end, y2: lo + wobble });
      else if (side === 1) segments.push({ x1: cursor, y1: hi + wobble, x2: end, y2: hi + wobble });
      else if (side === 2) segments.push({ x1: lo + wobble, y1: cursor, x2: lo + wobble, y2: end });
      else segments.push({ x1: hi + wobble, y1: cursor, x2: hi + wobble, y2: end });
      cursor = end + gap;
      index++;
    }
  }

  const o = style.stoneOffsetTiles * T;
  const mid = (lo + hi) / 2;
  const stones: DecorSpec[] = [
    { key: 'dec_rock_l', x: lo - o, y: lo - o, depth: 2 },
    { key: 'dec_rock_l', x: hi + o, y: lo - o, depth: 2 },
    { key: 'dec_rock_l', x: lo - o, y: hi + o, depth: 2 },
    { key: 'dec_rock_l', x: hi + o, y: hi + o, depth: 2 },
    { key: 'dec_rock_s', x: mid, y: lo - o, depth: 2 },
    { key: 'dec_rock_s', x: mid, y: hi + o, depth: 2 },
    { key: 'dec_rock_s', x: lo - o, y: mid, depth: 2 },
    { key: 'dec_rock_s', x: hi + o, y: mid, depth: 2 },
  ];
  return { segments, stones };
}

/** Each eight-item block is a different full permutation. The block transition
 * is deliberately offset by two, so immediate neighbours can never share a key. */
function propAt(index: number): typeof PROPS[number] {
  const block = Math.floor(index / PROPS.length);
  const slot = index % PROPS.length;
  return PROPS[(slot * 5 + block * 2) % PROPS.length]!;
}

/**
 * Deterministic irregular clusters around all four outer sides. Cluster gaps,
 * item count, tangent spread and distance from the plot come from the stable
 * integer mixer above. This removes the ruler-straight two-pine rows and short
 * repeated scatter sequence while keeping every sprite outside the plot.
 *
 * @param worldPx  plot edge length in world px (GRID.plotTiles * T)
 * @param T        world px per tile (64)
 */
export function skirtDecor(worldPx: number, T: number): DecorSpec[] {
  const out: DecorSpec[] = [];
  const SK = SKIRT_TILES * T;
  const s = T / 32;
  const W = worldPx;
  const H = worldPx;
  let propIndex = 0;

  for (let side = 0; side < 4; side++) {
    const horizontal = side < 2;
    const axisLength = horizontal ? W : H;
    const tangentMin = -SK + 36 * s;
    const tangentMax = axisLength + SK - 36 * s;
    let cluster = 0;
    let cursor = tangentMin + (48 + sample(side, 0, 0, 0x127) % 49) * s;

    while (cursor < tangentMax) {
      const itemCount = 2 + sample(side, cluster, 0, 0x2a9) % 3;
      const spread = 22 + sample(side, cluster, 0, 0x53b) % 35;
      for (let item = 0; item < itemCount; item++) {
        const centred = item - (itemCount - 1) / 2;
        const jitter = (sample(side, cluster, item, 0x761) % 19) - 9;
        const tangent = clamp(
          cursor + (centred * spread + jitter) * s, tangentMin, tangentMax,
        );
        const normal = (48 + sample(side, cluster, item, 0x9d3) % 230) * s;
        let x: number;
        let y: number;
        if (side === 0) { x = tangent; y = -normal; }
        else if (side === 1) { x = tangent; y = H + normal; }
        else if (side === 2) { x = -normal; y = tangent; }
        else { x = W + normal; y = tangent; }

        // Keep the complete ring below buildings while preserving useful local
        // painter variation inside each cluster.
        const painter = 30 + ((y + SK) / (H + 2 * SK)) * 820
          + sample(side, cluster, item, 0xb47) % 11;
        out.push({
          key: propAt(propIndex++),
          x: Math.round(x),
          y: Math.round(y),
          depth: clamp(Math.round(painter), 2, DECOR_DEPTH_MAX),
        });
      }
      cursor += (112 + sample(side, cluster, 0, 0xd15) % 91) * s;
      cluster++;
    }
  }
  return out;
}

/** Palette treatment applies only to the non-interactive skirt. Sprite keys,
 * positions and authoritative obstacle appearances remain the accepted pack. */
export function skirtTint(key: string, context?: unknown): number {
  const visual = resolveBaseVisualContext(context);
  if (visual.artVersion === 1) return 0xffffff;
  const stone = key.includes('rock') || key.includes('boulder');
  switch (visual.realmId) {
    case 'frostveil': return stone ? 0xc6e4f0 : 0xafd1db;
    case 'elderwood': return stone ? 0xd8d5bd : 0xc8d68d;
    case 'sunscar': return stone ? 0xefd0a4 : 0xd3b77c;
    case 'seeker-reach': return stone ? 0xd2bbed : 0xa9e6d5;
    case 'stormcairn': return stone ? 0xb0bccb : 0xa2b6b4;
    case 'thornwake': return stone ? 0xb8c7b9 : 0x9cc6aa;
    case 'cinderfall': return stone ? 0xbca5a3 : 0xa59e97;
    default: return 0xffffff;
  }
}
