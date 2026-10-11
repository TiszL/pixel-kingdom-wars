import { existsSync, readFileSync } from 'node:fs';

/**
 * Fail closed when a generated atlas sidecar carries art that production must
 * never ship:
 *  - the local-proof three-file candidate marker (`artCandidate`), and
 *  - a missing game-v4 release overlay (M26 makes the reviewed overlay the
 *    production art source), and
 *  - a game-v4 overlay resolved in LOCAL-REVIEW mode (K-061: local review
 *    default-allows unpinned candidates, so its selection is a review build,
 *    never a release). Only a STRICT overlay with zero unresolved holds and
 *    zero conflicting alternates may reach a production build; a malformed
 *    overlay report is treated as candidate art, not as absence of it.
 */
export function assertNoCandidateArt(atlasMetaPath) {
  if (!existsSync(atlasMetaPath)) {
    throw new Error('production build is missing generated atlas metadata');
  }
  const atlasMeta = JSON.parse(readFileSync(atlasMetaPath, 'utf8'));
  if (atlasMeta === null || typeof atlasMeta !== 'object') {
    throw new Error('production build carries malformed atlas metadata');
  }
  if (Object.prototype.hasOwnProperty.call(atlasMeta, 'artCandidate')) {
    throw new Error('production build contains local provider candidate art');
  }
  if (!Object.prototype.hasOwnProperty.call(atlasMeta, 'gameV4Overlay')) {
    throw new Error('production build is missing the approved game-v4 release art');
  }
  const overlay = atlasMeta.gameV4Overlay;
  if (overlay === null || typeof overlay !== 'object') {
    throw new Error('production build carries a malformed game-v4 overlay report');
  }
  if (overlay.selectionMode !== 'strict') {
    throw new Error(
      'production build contains local-review game-v4 overlay art (selection is not strict)',
    );
  }
  if (overlay.unresolvedHolds !== 0 || overlay.conflictingAlternates !== 0) {
    throw new Error(
      'production build contains a strict game-v4 overlay with unresolved holds or conflicts',
    );
  }
}
