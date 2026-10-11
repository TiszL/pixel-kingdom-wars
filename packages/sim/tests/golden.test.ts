/**
 * Golden replays: full event-log fingerprints + outcomes for three canonical
 * raids. ANY sim change that alters these must regenerate fixtures with
 * justification in the commit (CLAUDE.md):  UPDATE_GOLDEN=1 pnpm --filter @shardkeep/sim test
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BuildingType } from '@shardkeep/shared';
import { simulateRaid } from '../src/sim';
import type { RaidOutcome } from '../src/types';
import { b, base, deploy, fnv1a, orders, resetIds, wallLine, wallRing } from './helpers';

const FIX = join(__dirname, 'fixtures');

const SCENARIOS = {
  mixed_assault: () =>
    simulateRaid(
      base([
        b(BuildingType.Keep, 8, 8, 2, 'keep'),
        b(BuildingType.Vault, 11, 8, 2, 'vault'),
        b(BuildingType.Mine, 5, 8, 2, 'mine'),
        b(BuildingType.Cannon, 8, 5, 2, 'cannon'),
        b(BuildingType.ArcherTower, 8, 12, 2, 'tower'),
        b(BuildingType.Mortar, 12, 12, 1, 'mortar'),
        ...wallLine(4, 4, 12, 2),
      ]),
      orders(
        [
          deploy('kegrunner', 0, 8, 0),
          deploy('highlander', 0, 8, 800),
          deploy('highlander', 0, 9, 900),
          deploy('bowman', 0, 7, 1500),
          deploy('plunderer', 0, 10, 2500),
          deploy('turrider', 17, 8, 0),
        ],
        { buffs: { warhorn: true }, rally: { tx: 6, ty: 8, tMs: 8000 } },
      ),
      0xc0ffee,
    ),
  underground_heist: () =>
    simulateRaid(
      base([
        b(BuildingType.Keep, 8, 8, 1, 'keep'),
        b(BuildingType.Vault, 11, 8, 1, 'vault'),
        ...wallLine(4, 2, 15, 3),
        ...wallLine(13, 2, 15, 1),
      ]),
      orders([
        deploy('tunneler', 0, 8, 0),
        deploy('tunneler', 0, 9, 300),
        deploy('plunderer', 17, 8, 4000),
      ]),
      0xbeef,
    ),
  failed_rush: () =>
    simulateRaid(
      base([
        b(BuildingType.Keep, 8, 8, 3, 'keep'),
        b(BuildingType.Cannon, 6, 7, 3, 'c1'),
        b(BuildingType.Cannon, 10, 7, 3, 'c2'),
        b(BuildingType.ArcherTower, 8, 10, 3, 'a1'),
        b(BuildingType.Mortar, 5, 11, 3, 'mortar'),
        b(BuildingType.SpikeTrap, 3, 8, 1, 'trap'),
      ]),
      orders([
        deploy('bowman', 0, 8, 0),
        deploy('bowman', 0, 9, 100),
        deploy('plunderer', 0, 7, 200),
      ]),
      0xdead,
    ),

  // --- Pixel Kingdom Wars Phase 2b new-roster mechanics (claim PINNED to [2,16) so
  // these are insulated from the sim's claim default). Each isolates one mechanic. ---
  // SEALED ring, not a wall line (2026-07-26): rule 2 routes troops through any gap,
  // and a line never encloses anything — the giant simply walked around it and this
  // scenario stopped testing smashing at all. A ring keeps its name honest.
  giant_smash: () =>
    simulateRaid(
      { ...base([
        b(BuildingType.Keep, 8, 8, 2, 'keep'),
        b(BuildingType.Vault, 11, 8, 2, 'vault'),
        ...wallRing(2, 15, 2),
      ]), claimMin: 2, claimMax: 16 },
      orders([deploy('giant', 0, 8, 0)]),
      0x51a17,
    ),
  electric_chain: () =>
    simulateRaid(
      { ...base([
        b(BuildingType.Keep, 8, 8, 1, 'keep'),
        b(BuildingType.ElectricTower, 8, 6, 3, 'electric'),
      ]), claimMin: 2, claimMax: 16 },
      orders([
        deploy('highlander', 7, 0, 0),
        deploy('highlander', 8, 0, 0),
        deploy('highlander', 9, 0, 0),
        deploy('highlander', 8, 1, 0),
      ]),
      0xe1ec7,
    ),
  magetower_splash: () =>
    simulateRaid(
      { ...base([
        b(BuildingType.Keep, 8, 8, 1, 'keep'),
        b(BuildingType.MageTower, 8, 6, 3, 'magetower'),
      ]), claimMin: 2, claimMax: 16 },
      orders([
        deploy('highlander', 7, 0, 0),
        deploy('highlander', 8, 0, 0),
        deploy('highlander', 9, 0, 0),
        deploy('highlander', 8, 1, 0),
      ]),
      0x3a6e7,
    ),
  mage_attacker_splash: () =>
    simulateRaid(
      { ...base([
        b(BuildingType.Keep, 8, 8, 1, 'keep'),
        b(BuildingType.Vault, 10, 8, 1, 'vault'),
        b(BuildingType.Mine, 8, 10, 1, 'mine'),
      ]), claimMin: 2, claimMax: 16 },
      orders([deploy('mage', 0, 8, 0)]),
      0x3a9e7,
    ),
  bilgewraith_dig: () =>
    simulateRaid(
      { ...base([
        b(BuildingType.Keep, 8, 8, 1, 'keep'),
        b(BuildingType.Vault, 5, 8, 1, 'vault'),
        b(BuildingType.Mine, 12, 8, 1, 'mine'),
        ...wallLine(10, 6, 10, 1),
      ]), claimMin: 2, claimMax: 16 },
      orders([deploy('bilgewraith', 0, 8, 0)]),
      0xb11e7,
    ),
  // Render-only Troll attack cues must remain a deterministic overlay on the
  // same pinned combat outcome; this full log catches cadence/target drift.
  troll_contacts: () =>
    simulateRaid(
      { ...base([
        b(BuildingType.Keep, 5, 8, 1, 'keep'),
      ]), claimMin: 2, claimMax: 16 },
      orders([deploy('troll', 1, 8, 300)]),
      0x7a011,
    ),
  laser_beam: () =>
    simulateRaid(
      { ...base([
        b(BuildingType.Keep, 8, 8, 1, 'keep'),
        b(BuildingType.LaserTower, 8, 6, 3, 'laser'),
      ]), claimMin: 2, claimMax: 16 },
      orders([deploy('highlander', 8, 0, 0)]),
      0x1a5e7,
    ),
  // Air: a flying Dragon over a wall ring; the cannon can't touch it, the archer can.
  dragon_air: () =>
    simulateRaid(
      { ...base([
        b(BuildingType.Keep, 8, 8, 1, 'keep'),
        b(BuildingType.Cannon, 8, 5, 3, 'cannon'),
        b(BuildingType.ArcherTower, 5, 8, 3, 'archer'),
        ...wallLine(4, 4, 12, 2),
      ]), claimMin: 2, claimMax: 16 },
      orders([deploy('dragon', 0, 8, 0)]),
      0xd7a90,
    ),
  // Dragon Nest spawns defender wyrmlings that fight the raiders (killable via retaliation).
  dragon_nest: () =>
    simulateRaid(
      { ...base([
        b(BuildingType.Keep, 8, 8, 1, 'keep'),
        b(BuildingType.DragonNest, 11, 8, 3, 'nest'),
      ]), claimMin: 2, claimMax: 16 },
      orders([
        deploy('highlander', 0, 8, 0),
        deploy('highlander', 0, 9, 0),
        deploy('highlander', 0, 7, 0),
      ]),
      0xd7e57,
    ),
  // M22/SIM10: one fixture pins all four spent-trap event families and their
  // ground/flying filters without letting trap HP enter destruction scoring.
  m22_traps: () =>
    simulateRaid(
      { ...base([
        b(BuildingType.Keep, 14, 14, 1, 'keep'),
        b(BuildingType.SpikeTrap, 3, 8, 6, 'spike'),
        b(BuildingType.PowderMine, 5, 8, 11, 'powder'),
        b(BuildingType.Pitfall, 7, 8, 16, 'pitfall'),
        b(BuildingType.AirMine, 9, 10, 20, 'airmine'),
      ]), claimMin: 2, claimMax: 16 },
      orders([
        deploy('giant', 0, 8, 0), deploy('highlander', 0, 8, 0),
        deploy('dragon', 9, 0, 0),
      ]),
      0x22a10,
    ),
  // M22/SIM10: high/low Keep selection and dedicated air-only fire share one
  // deterministic building-order timeline.
  m22_keep_air: () =>
    simulateRaid(
      { ...base([
        b(BuildingType.Keep, 14, 14, 17, 'keep'),
        b(BuildingType.AirDefence, 10, 10, 17, 'air'),
      ], 17), claimMin: 2, claimMax: 16 },
      orders([deploy('giant', 0, 14, 0), deploy('dragon', 10, 0, 0)]),
      0x22a17,
    ),
  // D-099/SIM12: one fixture where BOTH answers are priced at the same T2
  // ring. The giant (row 11) meets w_6_11 with the only gap 12 tiles of
  // walking away and commits to breaching it (tick 71); the highlander
  // (row 13) meets the ring first, prices its own T2 segment against the
  // gap and detours north; the keg dropped at 8 s finds the giant's live
  // breach, runs to it and blows it (tick 101), breachOpened releases the
  // giant onto the field, and the routing highlander turns back into the
  // new hole because a fallen wall only ever shortens a detour. Before this
  // scenario no fixture held a unit with a breach AND a detour to compare,
  // so the fingerprint gate could not see decideAtWall move. The cannon sits
  // east so the highlander is outside its reach while it decides.
  decisive_walls: () =>
    simulateRaid(
      { ...base([
        b(BuildingType.Keep, 12, 12, 2, 'keep'),
        b(BuildingType.Cannon, 13, 10, 1, 'cannon'),
        ...wallRing(6, 16, 2, 'w').filter((w) => !(w.tx === 11 && w.ty === 6)),
      ]), claimMin: 2, claimMax: 20 },
      orders([
        deploy('giant', 0, 11, 0),
        deploy('highlander', 0, 13, 0),
        deploy('kegrunner', 0, 12, 8_000),
      ]),
      0xd099,
    ),
  // SIM18: all five Phase E types share the ordinary passive-structure combat
  // contract. Version3 deployment and explicit stable IDs pin their complete
  // target/damage/collapse timeline without altering any historical scenario.
  phase_e_structures: () =>
    simulateRaid(
      { ...base([
        b(BuildingType.Keep, 14, 14, 1, 'keep'),
        b(BuildingType.Workshop, 4, 4, 1, 'workshop'),
        b(BuildingType.Lodge, 8, 4, 1, 'lodge'),
        b(BuildingType.Market, 12, 4, 1, 'market'),
        b(BuildingType.Harvester, 4, 10, 1, 'harvester'),
        b(BuildingType.Berth, 10, 10, 1, 'berth'),
      ]), battlefieldVersion: 3, claimMin: 2, claimMax: 18 },
      orders([
        deploy('turrider', 0, 4), deploy('turrider', 0, 10),
        deploy('turrider', 17, 4), deploy('turrider', 17, 10),
        deploy('dragon', 8, 0),
      ]),
      0xe518,
    ),
} as const;

function fingerprint(r: RaidOutcome): { hash: string; outcome: Omit<RaidOutcome, 'events'> & { eventCount: number } } {
  const { events, ...rest } = r;
  return { hash: fnv1a(JSON.stringify(events)), outcome: { ...rest, eventCount: events.length } };
}

describe('golden replays', () => {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    it(name, () => {
      resetIds(); // per-scenario stable ids — see helpers.resetIds
      const got = fingerprint(run());
      const file = join(FIX, `${name}.json`);
      // Explicit opt-in ONLY: regeneration requires UPDATE_GOLDEN=1. The old
      // path also auto-authored a fixture whenever the file was MISSING — so a
      // deleted baseline was silently rewritten from current sim output and the
      // second run passed green against a fixture the sim had just certified
      // for itself. A missing fixture is now always a hard failure that tells
      // you which of the two situations you're in.
      if (process.env['UPDATE_GOLDEN'] === '1') {
        mkdirSync(FIX, { recursive: true });
        writeFileSync(file, JSON.stringify(got, null, 2) + '\n');
        return;
      }
      if (!existsSync(file)) {
        throw new Error(
          `golden fixture ${name}.json is MISSING. New scenario → author it with UPDATE_GOLDEN=1 and commit. ` +
          `Deleted fixture → restore it from git; regenerating would let the current sim certify its own output.`,
        );
      }
      const want = JSON.parse(readFileSync(file, 'utf8'));
      expect(got).toEqual(want);
    });
  }
});
