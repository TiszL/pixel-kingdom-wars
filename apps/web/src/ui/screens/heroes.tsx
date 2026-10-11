/** Hero roster display stays server-owned. Paid upgrades and recovery always
 * open the shared durable Hero command's exact-currency review. */
import type { HeroKey } from '@shardkeep/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useHeroProgressionView } from '../../lib/heroProgression/context';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { useFetch } from '../useFetch';
import { Btn, Chip, COLORS as C, fmtN, Icon, Sp, Sprite } from '../primitives';
import { heroRecoveryLabel, heroRecoveryRevision } from './heroRecovery';
import { heroPortrait } from '../heroPortrait';

/** Mirrors HeroView in apps/api/src/game/heroes.ts (KEEP amounts are strings —
 *  they are bigint server-side). */
export interface HeroDto {
  hero: HeroKey;
  name: string;
  title: string;
  altar: string;
  unlockKeepLevel: number;
  /** D-058: server-priced KEEP recruit fee (charged at altar placement unless
   *  a hero-contract item is consumed instead). */
  recruitCostKeep: string;
  recruitItemId: string;
  recruited: boolean;
  level: number;
  tier: number;
  tierName: string;
  hp: number;
  dps: number;
  recoveryUntil: string | null;
  available: boolean;
  /** D-059 gear-modified stats — null while combat rollout is dark or nothing
   * is equipped. The roster renders the server's delta, never client math. */
  gear: { hp: number; dps: number; hpBonus: number; dpsBonus: number } | null;
  recoveryFinishNow: { remainingSec: number; costKeep: string; affordable: boolean } | null;
  maxLevel: number;
  next: { level: number; tier: number; tierName: string; hp: number; dps: number; costKeep: string } | null;
  affordable: boolean;
}
interface HeroesDto { heroes: HeroDto[]; keepBalance: string; keepLevel: number }

/** "42 +6 → 55" stat line; the arrow half is suppressed at max level and the
 * signed gear delta (D-059, server-computed) appears only when it is non-zero. */
function StatLine({ label, cur, bonus, next }: {
  label: string; cur: number; bonus: number | undefined; next: number | undefined;
}): React.JSX.Element {
  return (
    <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', fontSize: 14 }}>
      <span style={{ color: C.textFaint }}>{label}</span>
      <span style={{ color: C.text }}>{fmtN(cur)}</span>
      {bonus !== undefined && bonus !== 0 && (
        <span style={{ color: bonus > 0 ? C.success : C.danger }}>
          {bonus > 0 ? `+${fmtN(bonus)}` : fmtN(bonus)}
        </span>
      )}
      {next !== undefined && next !== cur && <span style={{ color: C.goldHi }}>→{fmtN(next)}</span>}
    </span>
  );
}

function HeroRow({ h, busy, nowMs, onUpgrade, onRecover }: {
  h: HeroDto; busy: boolean; nowMs: number;
  onUpgrade: (hero: HeroKey) => void;
  onRecover: (hero: HeroKey) => void;
}): React.JSX.Element {
  const maxed = h.next === null;
  const recovery = heroRecoveryLabel(h.recoveryUntil, nowMs, h.available);
  return (
    <Chip style={{ alignItems: 'stretch', flexWrap: 'wrap', gap: 10, opacity: h.recruited ? 1 : 0.55 }}>
      <div style={{ position: 'relative', width: 52, height: 52, flex: 'none' }}>
        <Sprite name={heroPortrait(h.hero, h.level)} w={52} h={52} />
        {/* Level badge only once recruited — an un-owned hero has no level yet. */}
        {h.recruited && (
          <span style={{ position: 'absolute', right: -2, bottom: -2, fontSize: 12, color: C.ink, background: C.gold, padding: '0 3px', border: `1px solid ${C.ink}` }}>
            L{h.level}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 16, color: C.text, lineHeight: 1 }}>
          {h.name.toUpperCase()}
          <span style={{ color: C.textFaint, fontSize: 13 }}> · {h.recruited ? h.tierName.toUpperCase() : h.title.toUpperCase()}</span>
        </span>
        {h.recruited ? (
          <>
            <StatLine label="HP" cur={h.hp} bonus={h.gear?.hpBonus} next={h.next?.hp} />
            <StatLine label="DPS" cur={h.dps} bonus={h.gear?.dpsBonus} next={h.next?.dps} />
            {recovery && (
              <span role="status" style={{ fontSize: 13, color: C.danger }}>
                {recovery} · CANNOT ATTACK OR DEFEND
              </span>
            )}
          </>
        ) : (
          <span style={{ fontSize: 14, color: C.danger }}>
            {/* D-058 (owner 2026-08-16): the recruit fee is KEEP — name the
                price and the Keep-5 gate right where the lock is shown. */}
            LOCKED · RECRUIT AT THE ALTAR — <Icon name="keep" size={12} />{fmtN(h.recruitCostKeep)} · KEEP L{h.unlockKeepLevel}
          </span>
        )}
      </div>

      <Sp />

      <div style={{ display: 'flex', alignItems: 'center', flex: 'none', maxWidth: '100%' }}>
        {h.recoveryFinishNow ? (
          <Btn
            fontSize={14}
            disabled={busy}
            style={{ padding: '4px 10px 6px', minHeight: 44, maxWidth: '100%', whiteSpace: 'normal' }}
            onClick={() => onRecover(h.hero)}>
            REVIEW RECOVERY
          </Btn>
        ) : !h.recruited ? (
          <span style={{ fontSize: 13, color: C.textFaint }}>NOT RECRUITED</span>
        ) : maxed ? (
          <span style={{ fontSize: 14, color: C.goldHi }}>MAX L{h.maxLevel}</span>
        ) : (
          <Btn
            fontSize={14}
            // The legacy KEEP-only affordability flag cannot veto a Gems review.
            disabled={busy}
            style={{ padding: '4px 10px 6px', minHeight: 44, maxWidth: '100%', whiteSpace: 'normal' }}
            onClick={() => onUpgrade(h.hero)}>
            REVIEW UPGRADE · L{h.next!.level}
          </Btn>
        )}
      </div>
    </Chip>
  );
}

/** BUILD ▸ HEROES roster + upgrade controls. */
export function HeroTray(): React.JSX.Element {
  const selectedBaseId = useApp(s => s.selectedBaseId), wallet = useApp(s => s.wallet), baseEpoch = useApp(s => s.baseSelectionEpoch);
  const base = useApp(s => s.base), money = useHeroProgressionView(), revision = money?.snapshotRevision ?? 0;
  const { data, error, loading, reload } = useFetch(async () => {
    const scope = captureBaseSnapshotGuard(), generation = authCookies.captureGeneration();
    const current = () => useApp.getState().authed && authCookies.current(generation) && isBaseSnapshotGuardCurrent(scope);
    if (!scope.wallet || !scope.selectedBaseId || !current()) throw new Error('Select an owned kingdom to view its Heroes.');
    const heroes = await api.get<HeroesDto>(`/heroes?baseId=${encodeURIComponent(scope.selectedBaseId)}`, { isCurrent: current });
    if (!current()) throw new Error('The Hero account or kingdom changed.');
    return { heroes, scope, revision };
  }, [selectedBaseId, wallet, baseEpoch, revision]);
  const [nowMs, setNowMs] = useState(Date.now());
  const recoveryRevision = base?.baseId === selectedBaseId ? heroRecoveryRevision(base.heroes) : null;
  const priorRecoveryRevision = useRef(recoveryRevision);
  useEffect(() => {
    const prior = priorRecoveryRevision.current; priorRecoveryRevision.current = recoveryRevision;
    if (prior !== null && recoveryRevision !== null && prior !== recoveryRevision) reload();
  }, [recoveryRevision, reload]);
  const current = data && data.revision === revision && isBaseSnapshotGuardCurrent(data.scope);
  const heroes = current ? data.heroes.heroes : [];
  useEffect(() => {
    if (!heroes.some(hero => hero.recoveryUntil && Date.parse(hero.recoveryUntil) > Date.now())) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000); return () => clearInterval(timer);
  }, [heroes]);
  const busy = !money || !money.state.loaded || money.state.busy || !money.actionsEnabled || !!money.state.journal?.operation;
  const begin = (kind: 'upgrade' | 'recovery', hero: HeroKey) => {
    if (money && selectedBaseId && !busy) money.begin({ kind, hero, baseId: selectedBaseId });
  };
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <span style={{ fontSize: 13, color: C.textFaint, letterSpacing: '1px' }}>HERO ROSTER · REVIEW EXACT PAYMENT BEFORE SPENDING</span>
    {money?.state.journal?.operation && <Btn variant="sec" fontSize={16} onClick={money.openHistory}>OPEN ORIGINAL HERO PAYMENT</Btn>}
    {error && <span role="alert" style={{ color: C.danger }}>{error}</span>}
    {loading || !current && !error || money?.state.busy ? <span role="status" style={{ color: C.textFaint }}>REFRESHING HEROES…</span>
      : heroes.map(h => <HeroRow key={h.hero} h={h} busy={busy} nowMs={nowMs} onUpgrade={hero => begin('upgrade', hero)} onRecover={hero => begin('recovery', hero)} />)}
  </div>;
}
