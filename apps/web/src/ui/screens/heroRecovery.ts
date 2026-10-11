import { fmtDur } from '../../lib/duration';

/** Server owns availability; the client clock only formats its remaining duration. */
export function heroRecoveryLabel(
  recoveryUntil: string | null,
  nowMs: number,
  available?: boolean,
): string | null {
  if (available === true) return null;
  if (!recoveryUntil) return available === false ? 'RECOVERING · VERIFYING' : null;
  const remainingSec = Math.ceil((Date.parse(recoveryUntil) - nowMs) / 1_000);
  if (!Number.isFinite(remainingSec) || remainingSec <= 0) {
    return available === false ? 'RECOVERING · VERIFYING' : null;
  }
  return `RECOVERING · ${fmtDur(remainingSec).toUpperCase()}`;
}

/** Stable primitive used to refresh screen-owned snapshots when /base changes. */
export function heroRecoveryRevision(heroes: ReadonlyArray<{
  hero: string; recoveryUntil: string | null; available: boolean;
}> | undefined): string | null {
  if (heroes === undefined) return null;
  return heroes
    .map((hero) => `${hero.hero}:${hero.available ? 1 : 0}:${hero.recoveryUntil ?? '-'}`)
    .sort()
    .join('|');
}
