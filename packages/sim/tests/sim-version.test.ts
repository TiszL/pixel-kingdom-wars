/**
 * THE GATE: you cannot change what the simulator does without saying so.
 *
 * Resolved raids persist their authoritative result and event log. Pending raids
 * are still pinned to the live simulator/event protocol under which they were
 * created, so an unversioned change can resolve paid orders under an unaudited
 * contract. This test fingerprints the golden behavior and fails unless
 * SIM_VERSION moves with it.
 *
 * WHEN THIS FAILS you changed simulator behaviour. That is allowed — it is most of
 * what sim work is — but it has to be deliberate:
 *   1. Regenerate the fixtures:  UPDATE_GOLDEN=1 pnpm --filter @shardkeep/sim test
 *   2. Bump SIM_VERSION in src/version.ts and add a line to its History block.
 *   3. Paste the new fingerprint below.
 *   4. Say what moved and why in the commit body.
 * All four in the same commit. That is the whole point of the pair: the version and
 * the fingerprint have to be edited together, by hand, on purpose.
 *
 * If it fails and you did NOT mean to change behaviour, do not update anything here
 * — you have found an accidental regression, which is the other half of the point.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIM_VERSION } from '../src/version';
import { fnv1a } from './helpers';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * The pinned pair. Both lines change together or the test fails — see the header.
 */
const PINNED = {
  simVersion: 18,
  // SIM18 adds phase_e_structures only. Every earlier fixture is retained
  // byte-for-byte; the fold changes because the new scenario joins the corpus.
  // SIM17 clearance is separately pinned by battlefield-v3.test.ts; every
  // historical fixture keeps its original deployment version and event bytes.
  // SIM16's giant targeting is pinned by giant-nearby-target.test.ts; no golden
  // scenario holds a giant near a second defence, so the corpus is byte-identical.
  // SIM15 is separately pinned in battlefield-v2.test.ts; legacy fixture bytes
  // remain unchanged. SIM13's wall-chew cue and SIM14's hero-swing `hit` are pinned by
  // hero-skills.test and ai.test; the canonical troop-only fixture corpus
  // fields no hero, so its fold is unchanged across both bumps.
  fingerprint: 'f03454b3',
};

describe('SIM_VERSION gates every behaviour change', () => {
  it('behaviour has not moved without the version moving', () => {
    // Fold every golden fixture's own hash into one number, in a stable order. The
    // fixtures already cover the troop paths bit-for-bit; this is a fingerprint OF
    // those fingerprints, so it inherits their coverage rather than duplicating it.
    const names = readdirSync(FIX).filter((f) => f.endsWith('.json')).sort();
    expect(names.length).toBeGreaterThan(0); // never vacuous
    const combined = names
      .map((n) => {
        const fx = JSON.parse(readFileSync(join(FIX, n), 'utf8')) as {
          hash: string;
          outcome: { ticks: number; eventCount: number };
        };
        // Ticks and event count too: a change that preserved the event hash but
        // altered the timeline would otherwise slip through.
        return `${n}:${fx.hash}:${fx.outcome.ticks}:${fx.outcome.eventCount}`;
      })
      .join('|');

    expect({ simVersion: SIM_VERSION, fingerprint: fnv1a(combined) }).toEqual(PINNED);
  });

  it('is a positive integer the server can stamp and the client can compare', () => {
    expect(Number.isInteger(SIM_VERSION)).toBe(true);
    expect(SIM_VERSION).toBeGreaterThan(0);
  });
});
