/**
 * Deterministically promote the reviewed game-v4 working tree into a clean,
 * temporary release root, then pass that root through the unchanged strict
 * resolver. Owner-authored masters remain untouched: promotion copies only
 * the exact bytes selected by hash-pinned overlay-policy rules (plus ordinary
 * single-claim masters) and never copies the local-review policy itself.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  GAME_V4_OVERLAY_ENV,
  GAME_V4_OVERLAY_RELEASE_ENV,
  gameV4SelectionSha256,
  resolveGameV4Overlay,
  type GameV4Overlay,
  type GameV4OverlayEnvironment,
} from './game-v4-overlay.js';

function enabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function strictRequested(environment: GameV4OverlayEnvironment): boolean {
  return enabled(environment.SHARDKEEP_GAME_V4_OVERLAY_ALLOW_RELEASE)
    || environment.NODE_ENV?.trim().toLowerCase() === 'production'
    || enabled(environment.CI);
}

/**
 * Local review still shows every alternate and hold. A release/CI build gets a
 * separately materialized root with one selected claim per runtime key; the
 * existing strict resolver then proves that root contains no policy, holds, or
 * conflicting claims. Production/CI without the explicit release opt-in still
 * fails through resolveGameV4Overlay's original gate.
 */
export async function resolveReleaseReadyGameV4Overlay(options: {
  root: string;
  environment: GameV4OverlayEnvironment;
}): Promise<GameV4Overlay | null> {
  const { root, environment } = options;
  if (!enabled(environment.SHARDKEEP_GAME_V4_OVERLAY) || !strictRequested(environment)) {
    return resolveGameV4Overlay(options);
  }

  const production = environment.NODE_ENV?.trim().toLowerCase() === 'production';
  const ci = enabled(environment.CI);
  if ((production || ci) && !enabled(environment.SHARDKEEP_GAME_V4_OVERLAY_ALLOW_RELEASE)) {
    // Preserve the original, actionable refusal message and never perform a
    // local-policy read for an unauthorized production/CI build.
    return resolveGameV4Overlay(options);
  }

  const reviewed = await resolveGameV4Overlay({
    root,
    environment: { SHARDKEEP_GAME_V4_OVERLAY: '1', NODE_ENV: 'development', CI: '0' },
  });
  if (!reviewed) throw new Error(`${GAME_V4_OVERLAY_ENV}: reviewed release selection is disabled`);

  const releaseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shardkeep-game-v4-release-'));
  try {
    try {
      await fs.copyFile(path.join(root, 'manifest.json'), path.join(releaseRoot, 'manifest.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`${GAME_V4_OVERLAY_ENV}: release promotion requires manifest.json`);
      }
      throw error;
    }

    for (const source of reviewed.sources) {
      const destination = path.join(releaseRoot, ...source.file.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, source.png, { flag: 'wx' });
    }

    const strict = await resolveGameV4Overlay({ root: releaseRoot, environment });
    if (!strict || strict.selectionMode !== 'strict') {
      throw new Error(`${GAME_V4_OVERLAY_ENV}: release promotion did not enter strict mode`);
    }
    if (strict.unresolvedHolds.length !== 0 || strict.conflictingAlternates.length !== 0) {
      throw new Error(
        `${GAME_V4_OVERLAY_ENV}: promoted release root retained holds or conflicting claims`,
      );
    }
    if (strict.sources.length !== reviewed.sources.length) {
      throw new Error(
        `${GAME_V4_OVERLAY_ENV}: promoted ${reviewed.sources.length} selections but strict mode read `
          + `${strict.sources.length}`,
      );
    }

    return {
      ...strict,
      // The PNG buffers are already snapshotted, so the temporary root can be
      // removed before atlas rendering. Keep the durable source root for logs.
      root,
      releasePromotion: {
        sourceScannedFiles: reviewed.scannedFiles,
        selectedFiles: reviewed.sources.length,
        excludedHolds: reviewed.unresolvedHolds.length,
        resolvedIdenticalAlternates: reviewed.identicalAlternates.length,
        resolvedConflictingAlternates: reviewed.conflictingAlternates.length,
        selectionSha256: gameV4SelectionSha256(reviewed.sources.map((source) => ({
          runtimeKey: source.runtimeKey,
          file: source.file,
          sha256: source.sha256,
        }))),
      },
    };
  } finally {
    await fs.rm(releaseRoot, { recursive: true, force: true });
  }
}

export function formatGameV4ReleasePromotion(overlay: GameV4Overlay): string | null {
  const promotion = overlay.releasePromotion;
  if (!promotion) return null;
  return `game-v4 release promotion: ${promotion.selectedFiles} exact claims from `
    + `${promotion.sourceScannedFiles} source PNGs; final holds 0, final conflicts 0; `
    + `${promotion.excludedHolds} held candidates excluded, `
    + `${promotion.resolvedConflictingAlternates} reviewed conflicts resolved; `
    + `selection ${promotion.selectionSha256}`;
}

export { GAME_V4_OVERLAY_RELEASE_ENV };
