/**
 * Floating damage numbers (HANDOFF §4.1 / read-app-engines §5): pixel text
 * (VT323), Bone White with a Night-Ink stroke, popping at the impact point and
 * rising 36 world px over 800ms while fading (ease-out). Loot ticks are gold;
 * damage is bone. Mirrors the App's dmg-number behaviour at 2× world scale
 * (App: 15px DOM rises 18px → here 28px world rises 36px).
 *
 * POOLED (Seeker perf audit): every hit used to create a fresh Phaser.Text
 * (resolution:2 + stroke) and destroy it 800ms later — a per-hit canvas
 * texture create/upload/delete, a classic Android stutter source. Numbers now
 * come from a small per-scene pool: setText re-rasterises into the Text's
 * EXISTING canvas instead of allocating GL textures per hit.
 */
// TYPE-ONLY import, deliberately: lib/juice.ts (first-paint entry graph)
// imports this module, so a value import of phaser here drags the whole engine
// out of the lazy PhaserGame chunk and blows the size-check budget (+343 KB
// gzip, measured). That is why SHUTDOWN below is the event-string literal.
import type Phaser from 'phaser';
import { overlayDepth } from '../world/depth';

const BONE = '#EFE8D6';
const GOLD = '#F4D77B'; // Shard Glow — loot ticks
const INK = '#1A171E';
const RISE = 36;
const DUR = 800;
/** Pool ceiling per scene — a RENDER tunable, not a game number (constants.ts
 *  holds gameplay values only). Past this many simultaneous numbers the extras
 *  are dropped: a 13th overlapping number is unreadable anyway, and a hard cap
 *  is what bounds the texture memory this pool exists to stop churning. */
const DMG_TEXT_POOL = 12;

interface Pool {
  free: Phaser.GameObjects.Text[];
  active: Map<Phaser.GameObjects.Text, number>;
  generations: WeakMap<Phaser.GameObjects.Text, number>;
  total: number;
}

/** Per-scene pools. Scene teardown destroys pooled Texts with the display
 *  list, so the pool is dropped on SHUTDOWN — the battle scene stops and
 *  re-runs every raid, and a fresh run must not acquire dead objects. */
const pools = new WeakMap<Phaser.Scene, Pool>();

function poolFor(scene: Phaser.Scene): Pool {
  let pool = pools.get(scene);
  if (!pool) {
    pool = { free: [], active: new Map(), generations: new WeakMap(), total: 0 };
    pools.set(scene, pool);
    // Phaser.Scenes.Events.SHUTDOWN — literal to keep the phaser import
    // type-only (see the import note above).
    scene.events.once('shutdown', () => pools.delete(scene));
  }
  return pool;
}

export function popDamage(
  scene: Phaser.Scene,
  x: number,
  y: number,
  amount: number,
  opts?: { gold?: boolean; prefix?: string },
): void {
  const pool = poolFor(scene);
  let acquired = pool.free.pop();
  if (!acquired) {
    if (pool.total >= DMG_TEXT_POOL) return; // overflow: drop the number
    pool.total++;
    acquired = scene.add
      .text(0, 0, '', {
        fontFamily: 'VT323, monospace',
        fontSize: '28px',
        stroke: INK,
        strokeThickness: 4,
        resolution: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(overlayDepth(2700));
  }
  const t = acquired; // const so the tween closure keeps the narrowed type
  const generation = (pool.generations.get(t) ?? 0) + 1;
  pool.generations.set(t, generation);
  pool.active.set(t, generation);
  const sign = opts?.prefix ?? '-';
  t.setColor(opts?.gold ? GOLD : BONE);
  t.setText(`${sign}${amount}`);
  t.setPosition(x, y).setAlpha(1).setVisible(true);
  scene.tweens.add({
    targets: t,
    y: y - RISE,
    alpha: 0,
    duration: DUR,
    ease: 'Quad.easeOut',
    onComplete: () => {
      // Verdict settlement can invalidate a completion already queued for this
      // frame. It has returned the Text exactly once; a stale callback must not
      // duplicate the same object in `free`.
      if (pool.active.get(t) !== generation) return;
      pool.active.delete(t);
      t.setVisible(false);
      pool.free.push(t);
    },
  });
}

/** Return every in-flight number to its per-scene pool without destroying its
 * reusable Text texture. Call only after killing its tweens. Safe to call twice. */
export function settleDamageText(scene: Phaser.Scene): void {
  const pool = pools.get(scene);
  if (!pool) return;
  for (const text of pool.active.keys()) {
    if (text.active) text.setAlpha(0).setVisible(false);
    if (!pool.free.includes(text)) pool.free.push(text);
  }
  pool.active.clear();
}
