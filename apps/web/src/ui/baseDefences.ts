/**
 * RAIDED — the device-local "seen" contract behind the HUD chip and the
 * base-load toast (D-099, owner 2026-09-02: "no notification that you have
 * been raided"; "no good raid logs button to be able to revenge").
 *
 * The server sends the newest defences on /base (BaseStateDto.defences). What
 * the player has ALREADY SEEN is not a server fact — it is this device's
 * business, like the selected base and REDUCE MOTION — so it lives in
 * localStorage under the deed id, the same pattern as layoutEditor/model.ts's
 * legacy-import marker. "Seen" means the raid log was opened; no migration.
 *
 * Hook-free on purpose: the chip view is rendered to static markup in
 * hudBar.test.tsx, and the toast rule is pinned without a DOM.
 */
import { bus } from '../lib/events';
import type { BaseDefencesDto, BaseStateDto } from '../state/store';
import { COLORS as C, fmtDur } from './primitives';

const SEEN_VERSION = 1;
type SeenStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function defencesSeenKey(baseId: string): string {
  return `skp_defences_seen_v${SEEN_VERSION}:${baseId}`;
}

function deviceStorage(): SeenStorage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/** The ISO stamp up to which this deed's defences have been seen on this
 * device, or null when the deed was never stamped here (or storage is refused). */
export function readDefencesSeen(baseId: string, storage = deviceStorage()): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(defencesSeenKey(baseId));
    return raw && Number.isFinite(Date.parse(raw)) ? raw : null;
  } catch {
    return null;
  }
}

export function markDefencesSeen(baseId: string, at: string, storage = deviceStorage()): void {
  try {
    storage?.setItem(defencesSeenKey(baseId), at);
  } catch {
    // A private window or a refused quota: the chip simply stays a shield.
  }
}

/** Defences newer than the stamp. With NO stamp the answer is zero, not "all":
 * the stamp is written on the first base load (announceDefences), so a null
 * here means storage is unavailable — and a chip that could never be cleared
 * would nag forever. */
export function unreadDefences(
  defences: BaseDefencesDto | undefined, seenAt: string | null,
): number {
  if (!defences || !seenAt) return 0;
  const seen = Date.parse(seenAt);
  return defences.recent.filter((row) => Date.parse(row.createdAt) > seen).length;
}

/** Bases already announced this session: a refresh that returns the same
 * defences must not toast twice, and a player who dismissed the toast is not
 * reminded until the next session (the chip carries the count meanwhile). */
const announced = new Set<string>();

export function resetDefenceAnnouncements(): void {
  announced.clear();
}

/**
 * Base-load toast. Returns the copy it emitted, or null.
 *
 * - No stamp yet → stamp silently at the newest defence (or now). A brand-new
 *   player, or a returning one on a new device, must not be alarmed by history
 *   that was never "new" to them here.
 * - Stamp older than the newest defence → one toast per session per base. The
 *   stamp is NOT moved: only opening the raid log counts as having seen it.
 */
export function announceDefences(
  base: Pick<BaseStateDto, 'baseId' | 'defences'> | null,
  now = new Date(),
  storage = deviceStorage(),
): string | null {
  const baseId = base?.baseId;
  const defences = base?.defences;
  if (!baseId || !defences) return null;
  const seenAt = readDefencesSeen(baseId, storage);
  if (!seenAt) {
    markDefencesSeen(baseId, defences.lastAt ?? now.toISOString(), storage);
    return null;
  }
  const unread = unreadDefences(defences, seenAt);
  if (unread === 0 || announced.has(baseId)) return null;
  announced.add(baseId);
  const msg = `YOUR BASE WAS RAIDED ×${unread} — OPEN RAID LOG`;
  bus.emit('ui:toast', { msg });
  return msg;
}

/** Opening the raid log is what "seen" means. The stamp is the later of the
 * newest defence and now, so a log opened on a stale snapshot still clears
 * everything the log itself just fetched. */
export function markDefencesRead(
  base: Pick<BaseStateDto, 'baseId' | 'defences'> | null,
  now = new Date(),
  storage = deviceStorage(),
): void {
  const baseId = base?.baseId;
  if (!baseId) return;
  const lastAt = base?.defences?.lastAt ?? null;
  const at = lastAt && Date.parse(lastAt) > now.getTime() ? lastAt : now.toISOString();
  markDefencesSeen(baseId, at, storage);
}

/**
 * Shield time left for the HUD pill. Prefers the server's exact `remainingMs`
 * so the pill matches the globe parcel card to the minute ("1D 23H"); the
 * ceil'd `hoursLeft` is only the fallback for payloads that omit it.
 */
function shieldLeft(shield: { hoursLeft: number; remainingMs?: number | undefined }): string {
  return fmtDur(Math.ceil((shield.remainingMs ?? shield.hoursLeft * 3_600_000) / 1_000)).toUpperCase();
}

export interface ShieldChipView {
  label: string;
  /** Announces the permanent destination without erasing the unread state. */
  ariaLabel: string;
  color: string;
  /** Hot-state rim: a suppressed shield, or defences waiting to be avenged. */
  accent: string | undefined;
  raided: boolean;
  /** Every shield state is the permanent one-tap route to defence history. */
  go: 'raidlog';
}

/** The permanent raid-log chip. Unread defences still outrank the timer (and a
 * warzone SUPP) in its copy/accent; opening the log clears only that hot state,
 * never the shortcut itself. */
export function shieldChipView(shield: BaseStateDto['shield'], unread: number): ShieldChipView {
  if (unread > 0) {
    return {
      label: `RAIDED ×${unread}`, ariaLabel: `Raided ×${unread} — open raid log`,
      color: C.goldHi, accent: C.danger, raided: true, go: 'raidlog',
    };
  }
  if (shield?.suppressedByWarzone) {
    const left = shieldLeft(shield);
    return {
      label: `SUPP · ${left}`, ariaLabel: `Shield suppressed · ${left} — open raid log`,
      color: C.goldHi, accent: C.danger, raided: false, go: 'raidlog',
    };
  }
  if (shield) {
    const left = shieldLeft(shield);
    return {
      label: left, ariaLabel: `Shield · ${left} — open raid log`,
      color: C.sky, accent: undefined, raided: false, go: 'raidlog',
    };
  }
  return {
    label: '—', ariaLabel: 'No shield — open raid log',
    color: C.stoneDark, accent: undefined, raided: false, go: 'raidlog',
  };
}
