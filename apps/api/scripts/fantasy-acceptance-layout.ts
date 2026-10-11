/** Deterministic local specimens. Geometry is validated before fixture writes. */
import { createHash } from 'node:crypto';
import { CAPS, STRUCTURES, wallCapForKeepLevel } from '@shardkeep/shared';
import { claimRect, insideClaim, overlaps, type Rect } from '../src/game/footprints';

export function fantasyFixtureId(wallet: string, identity: string): string {
  const h = createHash('sha256').update(`fantasy-acceptance-v1:${wallet}:${identity}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function fantasyAcceptanceWalls(blocked: readonly Rect[], dense: boolean) {
  for (const [i, rect] of blocked.entries()) {
    if (!insideClaim(rect, CAPS.expansionsMax) || blocked.slice(i + 1).some(other => overlaps(rect, other))) {
      throw new Error('Acceptance buildings overlap or leave the legal claim');
    }
  }
  const cells = new Map<string, { tx: number; ty: number; level: number }>();
  const put = (tx: number, ty: number, level: number) => {
    const rect = { tx, ty, fw: 1, fh: 1 };
    if (insideClaim(rect, CAPS.expansionsMax) && !blocked.some(b => overlaps(rect, b))) cells.set(`${tx},${ty}`, { tx, ty, level });
  };
  for (let x = 4; x < 24; x++) put(x, 4, x - 3);
  for (const [min, max] of [[6, 23], [9, 20]] as const) {
    for (let x = min; x <= max; x++) { put(x, min, 1 + x % 5 * 4); put(x, max, 1 + (x + 2) % 5 * 4); }
    for (let y = min + 1; y < max; y++) { put(min, y, 1 + y % 5 * 4); put(max, y, 1 + (y + 3) % 5 * 4); }
  }
  for (let y = 11; y < 14; y++) for (let x = 10; x < 13; x++) put(x, y, x === 10 ? 1 : 17);
  const cap = wallCapForKeepLevel(20); const claim = claimRect(CAPS.expansionsMax);
  const levels = STRUCTURES.wall.maxTier;
  if (dense) for (let y = claim.min; y < claim.max && cells.size < cap; y++) for (let x = claim.min; x < claim.max && cells.size < cap; x++) {
    // New claims include negative coordinates; JS remainder must wrap back to
    // the legal tier range while preserving every nonnegative fixture value.
    if (!cells.has(`${x},${y}`)) put(x, y, 1 + ((x + y) % levels + levels) % levels);
  }
  if (cells.size > cap || (dense && cells.size !== cap) || new Set([...cells.values()].map(row => row.level)).size !== levels) {
    throw new Error('Acceptance specimen must preserve every level and the legal wall cap');
  }
  return [...cells.values()];
}
