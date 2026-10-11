import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertNoCandidateArt } from './candidate-art-gate.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function metadataFile(contents) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shardkeep-candidate-art-gate-'));
  temporaryDirectories.push(directory);
  const file = path.join(directory, 'meta.json');
  if (contents !== undefined) await fs.writeFile(file, JSON.stringify(contents));
  return file;
}

describe('production candidate-art gate', () => {
  it('fails closed when generated metadata or the approved release overlay is absent', async () => {
    const absent = await metadataFile(undefined);
    const ordinary = await metadataFile({ version: 1 });
    expect(() => assertNoCandidateArt(absent))
      .toThrow('production build is missing generated atlas metadata');
    expect(() => assertNoCandidateArt(ordinary))
      .toThrow('production build is missing the approved game-v4 release art');
  });

  it('fails whenever the candidate marker is present', async () => {
    const marked = await metadataFile({
      version: 1,
      artCandidate: { files: ['keep/bld_keep_l20_idle.png'] },
    });
    const nullMarked = await metadataFile({ artCandidate: null });
    expect(() => assertNoCandidateArt(marked))
      .toThrow('production build contains local provider candidate art');
    expect(() => assertNoCandidateArt(nullMarked))
      .toThrow('production build contains local provider candidate art');
  });

  // WHY: LOCAL-REVIEW selection default-allows unpinned candidates (K-061), so
  // an atlas resolved in that mode is a review build by definition. Production
  // may carry a game-v4 overlay ONLY when it was resolved strictly and nothing
  // was held back or conflicting — anything else must stop the build.
  it('rejects a game-v4 overlay resolved in local-review mode', async () => {
    const localReview = await metadataFile({
      version: 1,
      gameV4Overlay: {
        selectionMode: 'local-review', unresolvedHolds: 0, conflictingAlternates: 0,
      },
    });
    expect(() => assertNoCandidateArt(localReview))
      .toThrow('production build contains local-review game-v4 overlay art');
  });

  it('accepts a strict game-v4 overlay only with zero unresolved holds and conflicts', async () => {
    const clean = await metadataFile({
      version: 1,
      gameV4Overlay: {
        selectionMode: 'strict', unresolvedHolds: 0, conflictingAlternates: 0,
      },
    });
    expect(() => assertNoCandidateArt(clean)).not.toThrow();

    for (const dirty of [
      { selectionMode: 'strict', unresolvedHolds: 3, conflictingAlternates: 0 },
      { selectionMode: 'strict', unresolvedHolds: 0, conflictingAlternates: 1 },
      // A report missing either counter is malformed, not clean: fail closed.
      { selectionMode: 'strict' },
    ]) {
      const file = await metadataFile({ version: 1, gameV4Overlay: dirty });
      expect(() => assertNoCandidateArt(file), JSON.stringify(dirty))
        .toThrow('production build contains a strict game-v4 overlay with unresolved holds or conflicts');
    }
  });

  it('treats a malformed or mode-less overlay report as candidate art', async () => {
    const nullOverlay = await metadataFile({ version: 1, gameV4Overlay: null });
    expect(() => assertNoCandidateArt(nullOverlay))
      .toThrow('production build carries a malformed game-v4 overlay report');
    const modeless = await metadataFile({
      version: 1,
      gameV4Overlay: { unresolvedHolds: 0, conflictingAlternates: 0 },
    });
    expect(() => assertNoCandidateArt(modeless))
      .toThrow('production build contains local-review game-v4 overlay art');
  });
});
