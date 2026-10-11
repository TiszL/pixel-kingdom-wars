/**
 * Shield-break warning rules (tester report 2026-09-16). These pin the two
 * facts RaidUI's gate is built on, because each is a way the warning could
 * exist and still fail the reporter:
 *  - WHICH raids break the shield mirrors the server (PvP only — a warning on
 *    campaign would be a lie, its absence on auto-match the reported bug);
 *  - the time quoted is the server's remaining figure, never a client guess.
 */
import { describe, expect, it } from 'vitest';
import { raidBreaksShield, shieldBreakRemainingSec } from './shieldBreak';

const now = Date.parse('2026-09-16T12:00:00.000Z');

describe('raidBreaksShield — mirrors liveRaids/raids: only a raid with a defender wallet', () => {
  it('auto-match (no target) and a chosen PvP base break it', () => {
    expect(raidBreaksShield(null)).toBe(true);
    expect(raidBreaksShield({ kind: 'pvp', wallet: 'w', defenderBaseId: 'b' })).toBe(true);
    expect(raidBreaksShield({ kind: 'pvp', excludeBaseId: 'b' })).toBe(true);
  });
  it('campaign, PvE camps, replays and live spectating never do', () => {
    expect(raidBreaksShield({ kind: 'campaign', stage: 3 })).toBe(false);
    expect(raidBreaksShield({ kind: 'pve', campId: 'c' })).toBe(false);
    expect(raidBreaksShield({ kind: 'replay', raidId: 'r' })).toBe(false);
    expect(raidBreaksShield({ kind: 'live', raidId: 'r' })).toBe(false);
  });
  it('resuming an already-started PvP raid asks nothing — the shield was settled when it started', () => {
    expect(raidBreaksShield({ kind: 'pvp', raidId: 'r', wallet: 'w' })).toBe(false);
  });
});

describe('shieldBreakRemainingSec — the server figure, or nothing', () => {
  it('null without a shield or with one already run out', () => {
    expect(shieldBreakRemainingSec(null, now)).toBeNull();
    expect(shieldBreakRemainingSec(undefined, now)).toBeNull();
    expect(shieldBreakRemainingSec({ activeUntil: new Date(now - 1).toISOString(), hoursLeft: 0, remainingMs: 0 }, now)).toBeNull();
  });
  it('prefers remainingMs (the HUD pill\'s field) and ceils to whole seconds', () => {
    expect(shieldBreakRemainingSec({ activeUntil: 'ignored', hoursLeft: 1, remainingMs: 90_500 }, now)).toBe(91);
  });
  it('falls back to the stored expiry for an older API cut', () => {
    const until = new Date(now + 2 * 3_600_000).toISOString();
    expect(shieldBreakRemainingSec({ activeUntil: until, hoursLeft: 2 }, now)).toBe(7_200);
    expect(shieldBreakRemainingSec({ activeUntil: 'garbage', hoursLeft: 2 }, now)).toBeNull();
  });
  it('a warzone-suppressed shield still counts — it resumes after the purge and the attack deletes it', () => {
    expect(shieldBreakRemainingSec({ activeUntil: 'x', hoursLeft: 5, remainingMs: 5 * 3_600_000, active: false, suppressedByWarzone: true }, now)).toBe(18_000);
  });
});
