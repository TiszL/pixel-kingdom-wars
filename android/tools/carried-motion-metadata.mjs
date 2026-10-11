// Presentation metadata the native renderer depends on but which production
// source (origin/main) does not expose. Each table names the web commit it was
// captured from; the exporter applies it only after proving, against the actual
// source at export time, that the binding still holds. Nothing here is a game
// number: no cost, stat, cap, timing or simulation rule lives in this file.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Web commit 7374477c ("fix(web): cancel owned Leap motion across lifecycle
 * changes", 2026-09-06) gave V2TroopFx an owned Leap counter (`leapTween`), a
 * `leapGeneration` fence in both counter callbacks and `cancelLeapMotion()` calls
 * from clearAbilityVisuals/snapPosition/onAbility. Production main still runs the
 * unowned counter. The Kotlin renderer (GloamfangMotionTimeline) implements the
 * owned cancellation and refuses a Leap contract without it, so a main-based pack
 * carries the fixed policy explicitly instead of exporting a regression. */
export const CARRIED_LEAP_CANCELLATION = Object.freeze({
  sourceCommit: '7374477c3dbabd0e00e233301303f728986dd01e',
  ownedCancellation: true,
  ordinaryPosition: 'preserveBodyAndCounter',
  cancelledBy: Object.freeze(['onDeath', 'cancelReplayAction', 'destroy', 'snapPosition', 'onAbility']),
  staleCallbackFence: 'leapGeneration',
});

/** Web commit 5e4b2e21 ("fix(assets): align Firestorm emitters with selected
 * artwork", 2026-09-06) added a hash-bound sidecar
 * (art/game-v4/metadata/direwyvern-firestorm-emitters.json) that replaces the
 * legacy procedural `emitters.maw` table for the selected game-v4 Direwyvern
 * sheets. Production main packs those same pixels with the stale table. The
 * JSON beside this file is that sidecar byte-for-byte. */
export const CARRIED_FIRESTORM_EMITTERS = Object.freeze({
  sourceCommit: '5e4b2e2165afd5c4d1efb917741f8f86137e4ebd',
  file: 'carried/direwyvern-firestorm-emitters.5e4b2e21.json',
  sha256: '92479cb0b4076daa9e839537c1325db7a18966ab8ee499c1114621810ec318d0',
  /** Where the selected game-v4 overlay sheet for a bound runtime key lives at
   * origin/main. The sidecar binds each key to that PNG's SHA-256. */
  overlayPath: (runtimeKey) => {
    const match = /^v2_trp_direwyvern_t([1-4])_firestorm$/.exec(runtimeKey);
    return match ? `art/game-v4/actors/direwyvern/t${match[1]}/firestorm.png` : null;
  },
});

export async function loadCarriedFirestormEmitters() {
  const bytes = await readFile(path.join(here, CARRIED_FIRESTORM_EMITTERS.file));
  if (sha256(bytes) !== CARRIED_FIRESTORM_EMITTERS.sha256) throw new Error('Carried Firestorm emitter sidecar was modified; re-review against its source commit');
  return JSON.parse(bytes.toString('utf8'));
}

/** Mirror of scripts/src/game-v4-emitter-metadata.ts at 5e4b2e21: the table is
 * admitted only for the exact bound pixels and the exact authored grid. */
export function checkedFirestormEmitterTable(sidecar, runtimeKey, overlayBytes, clip) {
  const expectedHash = sidecar.bindings[runtimeKey];
  if (!expectedHash) return null;
  const fail = (reason) => { throw new Error(`${runtimeKey}: carried Firestorm emitter metadata ${reason}`); };
  if (sha256(overlayBytes) !== expectedHash) fail('does not match the selected overlay PNG hash');
  if (sidecar.schemaVersion !== 1 || clip.cellW !== sidecar.cell[0] || clip.cellH !== sidecar.cell[1]
    || clip.frames !== sidecar.frames || clip.rows !== sidecar.directionOrder.length || clip.fps !== sidecar.fps
    || JSON.stringify(clip.rowOrder) !== JSON.stringify(sidecar.directionOrder)
    || JSON.stringify(clip.anchorPx) !== JSON.stringify(sidecar.anchor)) fail('does not match the authored grid/clock/anchor');
  if (sidecar.maw.length !== clip.rows) fail('has incomplete facing coverage');
  for (const [row, points] of sidecar.maw.entries()) {
    if (points.length !== clip.frames) fail(`has incomplete frame coverage in row ${row}`);
    for (const [frame, point] of points.entries()) {
      if (point.length !== 2 || point.some((v) => !Number.isFinite(v) || v < 0) || point[0] > clip.cellW || point[1] > clip.cellH) fail(`has invalid point at row ${row}, frame ${frame}`);
    }
  }
  return { maw: sidecar.maw.map((row) => row.map((point) => [...point])) };
}
