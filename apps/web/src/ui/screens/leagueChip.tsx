/** Rank content mounted inside the generic measured HudChip by Overlay. */
import { COLORS as C } from '../primitives';
import {
  TIER_COLOR, TIER_LABEL, leagueCrestUrl, leagueRailLabel,
  tierForTrophies, tierProgressPct,
} from './leagueTier';

export type LeagueChipForm = 'full' | 'compact';

export function leagueChipAriaLabel(trophies: number): string {
  return `${TIER_LABEL[tierForTrophies(trophies)]} league, ${trophies} trophies`;
}

export function LeagueChip({
  trophies, form = 'full',
}: { trophies: number; form?: LeagueChipForm }): React.JSX.Element {
  const tier = tierForTrophies(trophies);
  const color = TIER_COLOR[tier];
  return (
    <>
      <img
        src={leagueCrestUrl(tier)} width={24} height={24} alt=""
        style={{
          imageRendering: 'pixelated', filter: `drop-shadow(1px 1px 0 ${C.ink})`, flex: 'none',
        }} />
      <span style={{
        display: 'flex', flexDirection: 'column', gap: form === 'full' ? 2 : 0, minWidth: 0,
      }}>
        <span style={{ color, fontSize: 20, lineHeight: 1, textShadow: `1px 1px 0 ${C.ink}` }}>
          {trophies.toLocaleString('en-US')}
        </span>
        {form === 'full' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span aria-hidden="true" style={{
              display: 'block', width: 36, height: 4, flex: 'none',
              background: C.ink, boxShadow: `inset 0 0 0 1px ${C.border}`,
            }}>
              <span style={{
                display: 'block', height: '100%', width: `${tierProgressPct(trophies)}%`,
                background: color,
              }} />
            </span>
            <span style={{
              fontSize: 11, letterSpacing: 1, color: C.textFaint, whiteSpace: 'nowrap',
            }}>
              {leagueRailLabel(trophies)}
            </span>
          </span>
        )}
      </span>
    </>
  );
}
