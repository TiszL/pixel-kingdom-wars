/** @vitest-environment happy-dom */
/**
 * The RAIDED toast and seen-stamp contract (D-099, owner 2026-09-02: "no
 * notification that you have been raided"). What matters and why:
 *
 *  - A stamp OLDER than the newest defence means the player has not looked
 *    since they were hit → exactly ONE toast this session. Twice would nag; zero
 *    is the bug the owner reported.
 *  - The same defences again (an auto-refetch) must not toast again.
 *  - NO stamp yet means this deed has never been seen on this device: a
 *    brand-new player, or a returning one on a new phone. Their history was
 *    never "new" to them here — stamp silently, alarm nobody.
 *
 * This is the loadServerState success-path helper (Overlay.tsx), pinned
 * without the Overlay's wallet/auth surface, the way Overlay.autoRefetch.test
 * pins the refetch loop through its own exported hook.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus } from '../lib/events';
import type { BaseDefencesDto } from '../state/store';
import {
  announceDefences, defencesSeenKey, markDefencesRead, readDefencesSeen,
  resetDefenceAnnouncements, shieldChipView, unreadDefences,
} from './baseDefences';
import { COLORS as C } from './primitives';

const baseId = '00000000-0000-4000-8000-000000000042';
const T0 = '2026-09-02T10:00:00.000Z';
const T1 = '2026-09-02T11:00:00.000Z';
const T2 = '2026-09-02T12:00:00.000Z';

const defence = (createdAt: string): BaseDefencesDto['recent'][number] => ({
  raidId: `raid-${createdAt}`, createdAt, attackerBaseId: 'attacker-base',
  attackerWallet: 'AttackerWallet123456789', attackerName: 'BLACKBEARD',
  stars: 2, destructionPct: 71,
});
const defences = (...at: string[]): BaseDefencesDto => ({
  lastAt: at[0] ?? null, recent: at.map(defence),
});

let toasts: string[];
let off: () => void;
beforeEach(() => {
  localStorage.clear();
  resetDefenceAnnouncements();
  toasts = [];
  off = bus.on('ui:toast', ({ msg }) => toasts.push(msg));
});
afterEach(() => off());

describe('the base-load RAIDED toast', () => {
  it('toasts exactly once when the stamp is older than the newest defence, and not again for the same data', () => {
    localStorage.setItem(defencesSeenKey(baseId), T0);
    const base = { baseId, defences: defences(T2, T1) };
    expect(announceDefences(base)).toBe('YOUR BASE WAS RAIDED ×2 — OPEN RAID LOG');
    expect(announceDefences(base)).toBeNull();
    expect(toasts).toEqual(['YOUR BASE WAS RAIDED ×2 — OPEN RAID LOG']);
    // The toast is not "seen": only the raid log moves the stamp.
    expect(readDefencesSeen(baseId)).toBe(T0);
  });

  it('with no stamp yet writes the stamp silently and never alarms a first-time player', () => {
    expect(announceDefences({ baseId, defences: defences(T1, T0) })).toBeNull();
    expect(toasts).toEqual([]);
    expect(readDefencesSeen(baseId)).toBe(T1);
    // A deed with no history yet is stamped at "now", so its FIRST defence
    // later is new — the chip and toast must fire for it.
    const fresh = '00000000-0000-4000-8000-000000000043';
    const now = new Date(T0);
    expect(announceDefences({ baseId: fresh, defences: defences() }, now)).toBeNull();
    expect(readDefencesSeen(fresh)).toBe(T0);
    expect(announceDefences({ baseId: fresh, defences: defences(T1) })).toBe(
      'YOUR BASE WAS RAIDED ×1 — OPEN RAID LOG',
    );
  });

  it('stays silent for a seen stamp, a deedless base, and a server without the field', () => {
    localStorage.setItem(defencesSeenKey(baseId), T2);
    expect(announceDefences({ baseId, defences: defences(T2, T1) })).toBeNull();
    expect(announceDefences({ baseId: null, defences: defences(T2) })).toBeNull();
    expect(announceDefences({ baseId })).toBeNull();
    expect(announceDefences(null)).toBeNull();
    expect(toasts).toEqual([]);
  });
});

describe('the seen stamp', () => {
  it('counts only defences newer than the stamp, and nothing without a stamp', () => {
    expect(unreadDefences(defences(T2, T1, T0), T0)).toBe(2);
    expect(unreadDefences(defences(T2, T1, T0), T2)).toBe(0);
    expect(unreadDefences(defences(T2, T1, T0), null)).toBe(0);
    expect(unreadDefences(undefined, T0)).toBe(0);
  });

  it('is written by opening the raid log, at the later of the newest defence and now', () => {
    markDefencesRead({ baseId, defences: defences(T2) }, new Date(T1));
    expect(readDefencesSeen(baseId)).toBe(T2);
    markDefencesRead({ baseId, defences: defences(T0) }, new Date(T1));
    expect(readDefencesSeen(baseId)).toBe(T1);
    markDefencesRead({ baseId: null, defences: defences(T2) }, new Date(T1));
    expect(localStorage.length).toBe(1);
  });

  it('treats a corrupt stamp as absent', () => {
    localStorage.setItem(defencesSeenKey(baseId), 'not a date');
    expect(readDefencesSeen(baseId)).toBeNull();
  });
});

describe('the shield chip view', () => {
  it('becomes RAIDED ×N with the danger rim and opens the raid log while defences are unread', () => {
    expect(shieldChipView(null, 3)).toEqual({
      label: 'RAIDED ×3', ariaLabel: 'Raided ×3 — open raid log',
      color: C.goldHi, accent: C.danger, raided: true, go: 'raidlog',
    });
  });

  it('keeps every ordinary shield state as a one-tap raid-log shortcut after unread is dismissed', () => {
    // WHY: acknowledging RAIDED used to turn the chip back into a dead readout,
    // hiding the only permanent route to defence history and REVENGE.
    const shield = { activeUntil: T2, hoursLeft: 2, remainingMs: 7_200_000 };
    expect(shieldChipView(shield, 0)).toEqual({
      label: '2H', ariaLabel: 'Shield · 2H — open raid log',
      color: C.sky, accent: undefined, raided: false, go: 'raidlog',
    });
    expect(shieldChipView(null, 0)).toEqual({
      label: '—', ariaLabel: 'No shield — open raid log',
      color: C.stoneDark, accent: undefined, raided: false, go: 'raidlog',
    });
    expect(shieldChipView({ ...shield, suppressedByWarzone: true }, 0)).toEqual({
      label: 'SUPP · 2H', ariaLabel: 'Shield suppressed · 2H — open raid log',
      color: C.goldHi, accent: C.danger, raided: false, go: 'raidlog',
    });
  });
});
