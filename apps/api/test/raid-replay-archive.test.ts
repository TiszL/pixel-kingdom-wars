/** The archive is the immutable compact replay truth; corruption must fail loud. */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { brotliCompressSync } from 'node:zlib';
import type { SimEvent } from '@shardkeep/sim';
import { CURRENT_BASE_VISUAL, REALM_IDS, currentBaseVisualForRealm } from '@shardkeep/shared/baseVisual';
import { decodeReplayTimeline, encodeReplayTimeline } from '../src/game/raidReplayArchive';

const EVENTS: SimEvent[] = [
  { t: 0, e: 'deploy', id: 1, troop: 'bowman', x: 0, y: 0 },
  {
    t: 2,
    e: 'attackRun',
    id: 1,
    troop: 'bowman',
    side: 'attacker',
    targetKind: 'building',
    target: 'keep',
    ix: 256,
    iy: 256,
    mode: 'projectile',
    technique: 'arrow',
    cycleMs: 629,
    releaseOffsetMs: 429,
    cycleTicks: 7,
    releaseOffsetTicks: 4,
    impactOffsetsTicks: [14],
    cadenceTicks: 16,
    count: 3,
  },
];
const ENVELOPE = {
  snapshot: { buildings: [{ id: 'keep', type: 'keep' }] },
  armySnapshot: { counts: { bowman: 3 } },
  orders: { deploys: [{ troop: 'bowman', tx: 0, ty: 0, tMs: 0 }] },
  seed: 7,
  simVersion: 9,
  events: EVENTS,
  result: { stars: 1, lootShards: 125 },
};

describe('raid replay archive codec', () => {
  it('round-trips semantic attack runs with integrity metadata', () => {
    const encoded = encodeReplayTimeline(ENVELOPE, 9_000);
    expect(encoded.eventCount).toBe(EVENTS.length);
    expect(encoded.byteLength).toBe(encoded.timeline.byteLength);
    expect(decodeReplayTimeline(encoded)).toEqual(ENVELOPE);
  });

  it('rejects mutated compressed bytes before attempting playback', () => {
    const encoded = encodeReplayTimeline(ENVELOPE, 9_000);
    const timeline = Buffer.from(encoded.timeline);
    timeline[0] = (timeline[0] ?? 0) ^ 0xff;
    expect(() => decodeReplayTimeline({ ...encoded, timeline })).toThrow(/integrity/);
  });

  it('integrity-binds frozen scenery separately without changing simulator snapshot bytes', () => {
    const original = encodeReplayTimeline(ENVELOPE, 9_000);
    const contexts = [1, 2].map(artVersion => ({ version: 1 as const, realmId: 'frostveil' as const, artVersion: artVersion as 1 | 2 }));
    // Revision 5 (the realm kit, docs/REALM-KIT-PLAN.md E-2) freezes into the archive
    // like every earlier layered revision: the QA preview and, after approval, every
    // Crownlands raid depend on the archive keeping it verbatim.
    const realmKit = REALM_IDS.map((realmId) => ({ version: 1 as const, realmId, artVersion: 2 as const, groundRevision: 5 as const }));
    for (const visualContext of [...contexts, { version: 1, realmId: 'crownlands', artVersion: 2, groundRevision: 1 } as const, ...REALM_IDS.map(currentBaseVisualForRealm), ...realmKit]) {
      const themed = encodeReplayTimeline({ ...ENVELOPE, visualContext }, 9_000);
      const decoded = decodeReplayTimeline(themed);
      expect(decoded.visualContext).toEqual(visualContext);
      expect(JSON.stringify(decoded.snapshot)).toBe(JSON.stringify(ENVELOPE.snapshot));
      expect(themed.sha256).not.toBe(original.sha256);
    }
    expect(decodeReplayTimeline(original)).not.toHaveProperty('visualContext');
  });
  it.each([
    // Revisions 3, 4 and 5 (the realm kit, D-173) are the admitted layered revisions;
    // 6 is the first unsupported one. This case previously pinned 5 as unsupported —
    // rewritten when the shared contract admitted the kit (REALM-KIT-PLAN E-2).
    { ...CURRENT_BASE_VISUAL, groundRevision: 6 },
    { ...CURRENT_BASE_VISUAL, groundRevision: 5, artVersion: 1 },
    { ...CURRENT_BASE_VISUAL, groundRevision: '1' },
    { ...CURRENT_BASE_VISUAL, realmId: 'frostveil', groundRevision: 1 },
    { ...CURRENT_BASE_VISUAL, artVersion: 1 },
  ])('refuses unsupported clearing revisions as permanent replay truth: %j', visualContext => {
    const invalid = { ...ENVELOPE, visualContext };
    expect(() => encodeReplayTimeline(invalid as never, 9_000)).toThrow(/visual context/);
    const original = encodeReplayTimeline(ENVELOPE, 9_000);
    const timeline = brotliCompressSync(Buffer.from(JSON.stringify(invalid)));
    expect(() => decodeReplayTimeline({ ...original, timeline, byteLength: timeline.byteLength,
      sha256: createHash('sha256').update(timeline).digest('hex') })).toThrow(/visual context/);
  });

  it('refuses unsupported frozen art at archive write and read without altering historical envelopes', () => {
    const invalid = { ...ENVELOPE, visualContext: { version: 1, realmId: 'frostveil', artVersion: 3 } };
    expect(() => encodeReplayTimeline(invalid as never, 9_000)).toThrow(/visual context/);
    const original = encodeReplayTimeline(ENVELOPE, 9_000);
    const timeline = brotliCompressSync(Buffer.from(JSON.stringify(invalid)));
    expect(() => decodeReplayTimeline({ ...original, timeline, byteLength: timeline.byteLength,
      sha256: createHash('sha256').update(timeline).digest('hex') })).toThrow(/visual context/);
  });
});


it('hashes optional frozen health in new archives while retaining old envelope bytes', () => {
  const old = encodeReplayTimeline(ENVELOPE, 9_000);
  const buildingHealth = [{ id: 'keep', initialHp: 77, maxHp: 77 }];
  const fresh = encodeReplayTimeline({ ...ENVELOPE, simVersion: 14, buildingHealth }, 9_000);
  expect(decodeReplayTimeline(fresh).buildingHealth).toEqual(buildingHealth);
  expect(fresh.sha256).not.toBe(old.sha256);
  expect(decodeReplayTimeline(old)).not.toHaveProperty('buildingHealth');
  expect(encodeReplayTimeline(ENVELOPE, 9_000)).toEqual(old);
  expect(() => decodeReplayTimeline({ ...fresh, sha256: old.sha256 })).toThrow(/integrity/);
});
