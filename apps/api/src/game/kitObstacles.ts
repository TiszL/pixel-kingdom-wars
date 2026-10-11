/** E-11 expansion obstacles (docs/REALM-KIT-PLAN.md E-11, D-173 expansion obstacles,
 * owner 2026-09-21: "what happens to trees when you extend base? … they are not
 * interactive like in-base trees"). On revision-5 ground a baked kit prop whose seat
 * an expansion reaches becomes a server obstacle row — the plot's own tap-to-clear
 * flow, tier cost, timer and +15 reward — while every client keeps drawing the
 * prop's own still for that row (packages/shared/src/realmKitObstacles.ts).
 *
 * Economy guarantees (the OBSTACLES.clearRewardShards comment holds for these rows
 * too): a seat yields at most ONE row for the life of the base — a row that exists
 * live or tombstoned at that tile is never recreated, rows are never deleted here,
 * and the plot's own generated rows are never touched — so the ceiling moves once
 * (+5 per small the kit seats in the frame, see KIT_OBSTACLES) and stays one-time,
 * gated behind SOL-bought expansions. Runs only from GET /base, never a worker. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { GRID, REALM_KIT, type BuildingType } from '@shardkeep/shared';
import { isRealmKitBaseVisualContext, type BaseVisualContext } from '@shardkeep/shared/baseVisual';
import { assertRealmKitManifest, realmKitPlacementHidden, realmKitPlacementSeat, type RealmKitManifest } from '@shardkeep/shared/realmKit';
import { realmKitObstacleKindFor, realmKitObstacleRow, realmKitObstacleSize } from '@shardkeep/shared/realmKitObstacles';
import type { DbOrTx } from '../db/client';
import { buildings, obstacles } from '../db/schema';
import { claimRect, footprintOf, overlaps, type Rect } from './footprints';
import { realmKitDescriptor, realmKitDescriptorIsPreview } from './realmKitCatalogue';

const manifests = new Map<string, Promise<RealmKitManifest>>();
/** The published, accepted kit manifest for a revision-5 context, or undefined when
 * this host publishes no kit for the realm (the normal state until the catalogue pins
 * one). The bytes are hash-checked against the descriptor exactly as the deed renderer
 * and the clients check them; a mismatch throws — a broken deploy must be loud, never
 * a silently different set of trees. One decode per manifest hash per process. */
export async function realmKitManifestFor(context: BaseVisualContext): Promise<RealmKitManifest | undefined> {
  if (!isRealmKitBaseVisualContext(context)) return undefined;
  let descriptor;
  try { descriptor = realmKitDescriptor(context); } catch { return undefined; }
  const repoRoot = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
  const publicRoot = path.join(repoRoot, 'apps/web/public'), key = `${publicRoot}:${descriptor.sha256}`;
  let pending = manifests.get(key);
  if (!pending) {
    pending = (async () => {
      const bytes = await readFile(path.join(publicRoot, descriptor.manifestPath));
      if (bytes.length !== descriptor.size || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) {
        throw new Error('Realm kit manifest integrity check failed');
      }
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      assertRealmKitManifest(value);
      if (value.realmId !== context.realmId) throw new Error('Realm kit manifest names another realm');
      return value;
    })();
    manifests.set(key, pending);
    void pending.catch(() => { if (manifests.get(key) === pending) manifests.delete(key); });
  }
  const manifest = await pending;
  // Clients draw revision 5 only from an accepted kit, so a preview-only manifest seats
  // no rows either — except on a dev/QA host whose REALM_KIT_PREVIEW_MANIFESTS switch is
  // the very thing serving that manifest to its clients (never in production).
  return manifest.status === 'accepted' || realmKitDescriptorIsPreview(context) ? manifest : undefined;
}

/** The rows the kit would seat for a claim, before any database check: every placement
 * with a kind that the claim HIDES — seat inside the claim or its edge ring, the one
 * shared rule web, native and the deed stop drawing the prop by (realmKitPlacementHidden)
 * — and seated off the legacy plot. Row-iff-hidden is the invariant: the moment a
 * surface stops drawing the prop, the row draws the same still on the same seat, so a
 * tree never vanishes for one expansion tier and grows back at the next. Whether the
 * player OWNS the row's tiles is the clear flow's question, not this one's: clearObstacle
 * refuses a rect outside the claim ("expand your land to clear this"), exactly as it
 * does for the plot's own rows in the deploy ring, so a row on the ring or a 2×2 tree
 * straddling the claim edge stands untouchable until the land is bought. Pure; exported
 * for tests. */
export function kitObstacleCandidates(manifest: RealmKitManifest, expansions: number): Array<{ spriteKey: string; tx: number; ty: number }> {
  const claim = claimRect(expansions);
  const onPlot = (tx: number, ty: number) => tx >= 0 && tx < GRID.plotTiles && ty >= 0 && ty < GRID.plotTiles;
  const out: Array<{ spriteKey: string; tx: number; ty: number }> = [];
  for (const p of manifest.placements) {
    const seat = realmKitPlacementSeat(p);
    if (!realmKitPlacementHidden(p, claim) || onPlot(seat.tx, seat.ty)) continue;
    const spriteKey = realmKitObstacleKindFor(manifest, p);
    if (!spriteKey) continue;
    out.push({ spriteKey, ...realmKitObstacleRow(spriteKey, seat) });
  }
  return out;
}

/** Insert the obstacle rows a base's expansions have reached (see the module note).
 * Exactly once under concurrency: the whole read-then-insert runs under a per-base
 * transaction advisory lock (the `hashtextextended(<scope>, 0)` pattern this codebase
 * serialises per-wallet work with), so two GET /base races insert one row. A candidate
 * is skipped when a row already exists at its tile (live or tombstoned — a cleared tree
 * is cleared for good), when it would overlap a live row, or when a building already
 * stands on its tiles — including one built before the realm flipped to revision 5
 * (D-184); such a seat is skipped without a tombstone and is seated by a later read
 * once the tile is free (K-186). Nothing for a revision below 5 or a realm with no
 * published kit. Returns the rows inserted. */
export async function syncKitObstacles(
  db: DbOrTx, wallet: string, expansions: number, context: BaseVisualContext, baseId?: string,
): Promise<number> {
  const claim = claimRect(expansions), ring = REALM_KIT.edgeRingTiles;
  // Every kit prop is seated off the legacy plot, so a claim whose edge ring stays inside it hides none.
  if (claim.min - ring >= 0 && claim.max + ring <= GRID.plotTiles) return 0;
  const manifest = await realmKitManifestFor(context);
  if (!manifest) return 0;
  const candidates = kitObstacleCandidates(manifest, expansions);
  if (candidates.length === 0) return 0;
  const scope = baseId ? eq(obstacles.baseId, baseId) : eq(obstacles.playerWallet, wallet);
  const buildingScope = baseId ? eq(buildings.baseId, baseId) : eq(buildings.playerWallet, wallet);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`kit-obstacles:${baseId ?? wallet}`}, 0))`);
    const [existing, standing] = await Promise.all([
      tx.select({ spriteKey: obstacles.spriteKey, tx: obstacles.tx, ty: obstacles.ty, clearedAt: obstacles.clearedAt }).from(obstacles).where(scope),
      tx.select({ type: buildings.type, tx: buildings.tx, ty: buildings.ty }).from(buildings).where(buildingScope),
    ]);
    const taken = new Set(existing.map((o) => `${o.tx},${o.ty}`));
    const blocked: Rect[] = [
      ...existing.filter((o) => o.clearedAt === null).map((o) => ({ tx: o.tx, ty: o.ty, fw: realmKitObstacleSize(o.spriteKey), fh: realmKitObstacleSize(o.spriteKey) })),
      ...standing.map((b) => ({ tx: b.tx, ty: b.ty, ...footprintOf(b.type as BuildingType) })),
    ];
    const rows: Array<typeof obstacles.$inferInsert> = [];
    for (const c of candidates) {
      if (taken.has(`${c.tx},${c.ty}`)) continue;
      const size = realmKitObstacleSize(c.spriteKey), rect: Rect = { tx: c.tx, ty: c.ty, fw: size, fh: size };
      if (blocked.some((b) => overlaps(b, rect))) continue;
      blocked.push(rect); taken.add(`${c.tx},${c.ty}`);
      rows.push({ playerWallet: wallet, baseId, spriteKey: c.spriteKey, tx: c.tx, ty: c.ty });
    }
    if (rows.length > 0) await tx.insert(obstacles).values(rows);
    return rows.length;
  });
}
