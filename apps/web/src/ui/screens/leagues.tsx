/** Lazy ranked-league screen. Rewards are SHARDS + two consumables only. */
import {
  LEAGUES, LEGACY_ITEMS, type League, type LeagueOverview, type LeagueRewardItem,
} from '@shardkeep/shared';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { selectedBasePath } from '../../lib/baseSelection';
import { fmtDur } from '../../lib/duration';
import { useApp } from '../../state/store';
import { Btn, Icon, ScrollPage, fmtN } from '../primitives';
import { useFetch } from '../useFetch';
import {
  LEAGUE_TIERS, TIER_COLOR, TIER_LABEL, leagueCrestUrl, nextThreshold,
  tierForTrophies, tierIndex, tierProgressPct,
} from './leagueTier';
import './leagues.css';

const home = (): void => useApp.getState().setScreen('base');

export function weeklyCache(tier: League, keepLevel: number): number {
  const table = LEAGUES.weeklyCacheShardsByKeepLevel;
  const level = Math.min(table.length, Math.max(1, Math.trunc(keepLevel)));
  return Math.trunc((table[level - 1]! * LEAGUES.cacheTierMultBps[tier]) / 10_000);
}

function itemName(itemId: LeagueRewardItem['itemId']): string {
  return (LEGACY_ITEMS as Record<string, { name: string }>)[itemId]?.name
    ?? itemId.replaceAll('_', ' ').toUpperCase();
}

export function tierRewardLines(tier: League, keepLevel: number): string[] {
  return [
    `${fmtN(weeklyCache(tier, keepLevel))} SHARDS at Keep ${Math.max(1, Math.trunc(keepLevel))}`,
    ...LEAGUES.weeklyItemsByTier[tier].map((item) => `${item.qty} × ${itemName(item.itemId)}`),
  ];
}

function tierBand(tier: League): string {
  const index = tierIndex(tier);
  const low = LEAGUES.thresholds[index]!;
  const high = LEAGUES.thresholds[index + 1];
  return high === undefined ? `${low}+ trophies` : `${low}–${high - 1} trophies`;
}

export default function LeaguesScreen(): React.JSX.Element {
  const base = useApp((state) => state.base);
  const { data, error, loading, reload } = useFetch<LeagueOverview>(
    () => api.get<LeagueOverview>(selectedBasePath('/leagues')),
  );
  const trophies = data?.you?.trophies ?? base?.player.trophies ?? 0;
  const tier = data?.you?.tier ?? tierForTrophies(trophies);
  const keepLevel = base?.player.keepLevel ?? data?.lastSettlement?.keepLevel ?? 1;

  return (
    <ScrollPage title="RANKED LEAGUES" onClose={home}>
      <main className="lg-stack">
        <Standing trophies={trophies} tier={tier} closesAt={data?.week.closesAt} />
        {data ? <RewardState data={data} /> : null}
        {error ? (
          <section className="lg-well lg-error" role="alert">
            <span>LEAGUE STANDING UNAVAILABLE · {error.toUpperCase()}</span>
            <Btn variant="sec" fontSize={15} onClick={reload}>RETRY</Btn>
          </section>
        ) : null}
        {loading && !data ? <div className="lg-loading">CHECKING THE LADDER…</div> : null}
        <Participation data={data} />

        <h2 className="lg-heading">REWARD LADDER</h2>
        <div className="lg-ladder">
          {LEAGUE_TIERS.map((rowTier) => (
            <LadderRow
              key={rowTier} tier={rowTier} current={tier} keepLevel={keepLevel} />
          ))}
        </div>
        <p className="lg-rule-copy">
          Trophies are cumulative and never reset. Complete {LEAGUES.rewardMinAttackerRaids}{' '}
          resolved attacks on deeded player bases during the Monday UTC earning window. Rewards
          settle Monday at 00:15 UTC. Only one base per wallet earns: highest tier, then trophies,
          then base ID.
        </p>

        <Board data={data} />
        <LastSettlement settlement={data?.lastSettlement ?? null} />
      </main>
    </ScrollPage>
  );
}

function Standing({ trophies, tier, closesAt }: {
  trophies: number; tier: League; closesAt: string | undefined;
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const next = nextThreshold(trophies);
  const nextTier = next === null ? null : LEAGUE_TIERS[tierIndex(tier) + 1] ?? null;
  const deadline = closesAt ? Date.parse(closesAt) : NaN;
  const remaining = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1_000)) : null;
  return (
    <section className="lg-well lg-standing">
      <img className="lg-crest lg-crest-large" src={leagueCrestUrl(tier)} alt="" />
      <div className="lg-standing-main">
        <div className="lg-tier" style={{ color: TIER_COLOR[tier] }}>{TIER_LABEL[tier]} LEAGUE</div>
        <div className="lg-trophies"><Icon name="trophy" size={18} /><b>{fmtN(trophies)}</b> TROPHIES</div>
        <span className="lg-progress" aria-label={`${tierProgressPct(trophies)} percent through current tier`}>
          <i style={{ width: `${tierProgressPct(trophies)}%`, background: TIER_COLOR[tier] }} />
        </span>
        <div className="lg-muted">
          {next !== null && nextTier
            ? `${fmtN(next - trophies)} TO ${TIER_LABEL[nextTier]}`
            : 'TOP TIER'}
        </div>
      </div>
      <div className="lg-clock">
        <span>WINDOW CLOSES IN</span>
        <b>{remaining === null ? '—' : fmtDur(remaining).toUpperCase()}</b>
      </div>
    </section>
  );
}

function RewardState({ data }: { data: LeagueOverview }): React.JSX.Element {
  const copy = data.rewards.status === 'disabled'
    ? 'REWARDS ARE DISABLED. NO CACHE WILL BE CREATED FOR THIS WINDOW.'
    : data.rewards.status === 'scheduled'
      ? `FIRST SETTLEMENT IS SCHEDULED FOR ${new Date(data.rewards.firstSettlementAt).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC.`
      : `REWARDS ACTIVE · NEXT SETTLEMENT ${new Date(data.week.settlesAt).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC.`;
  return (
    <section className={`lg-well lg-reward-state is-${data.rewards.status}`}>
      <b>{data.rewards.status.toUpperCase()}</b>
      <span>{copy}</span>
    </section>
  );
}

function Participation({ data }: { data: LeagueOverview | null }): React.JSX.Element {
  const you = data?.you;
  const required = data?.rewards.minRatedAttacks ?? LEAGUES.rewardMinAttackerRaids;
  let state = 'SELECT A LANDED DEEDED BASE TO ENTER THE LADDER.';
  if (you?.rewardCandidate) state = 'THIS BASE IS YOUR WALLET’S CURRENT REWARD CANDIDATE.';
  else if (you?.blockedByHigherBase) state = 'ANOTHER BASE IN THIS WALLET CURRENTLY RANKS HIGHER.';
  else if (you && you.trophies <= 0) state = 'EARN A TROPHY TO BECOME REWARD-ELIGIBLE.';
  else if (you && !you.participationMet) state = 'COMPLETE THE ATTACK REQUIREMENT BEFORE THE WINDOW CLOSES.';
  return (
    <section className="lg-well lg-participation">
      <div>
        <span className="lg-kicker">RATED ATTACKS</span>
        <b>{you?.currentWeekRatedAttacks ?? 0} / {required}</b>
      </div>
      <span className={you?.rewardCandidate ? 'is-good' : ''}>{state}</span>
    </section>
  );
}

function LadderRow({ tier, current, keepLevel }: {
  tier: League; current: League; keepLevel: number;
}): React.JSX.Element {
  return (
    <section className={`lg-well lg-row${tier === current ? ' is-current' : ''}`}>
      <img className="lg-crest" src={leagueCrestUrl(tier)} alt="" />
      <div>
        <div className="lg-row-title" style={{ color: TIER_COLOR[tier] }}>
          {TIER_LABEL[tier]} <span>{tierBand(tier)}</span>
        </div>
        <ul>
          {tierRewardLines(tier, keepLevel).map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>
      {tier === current ? <strong>YOU</strong> : null}
    </section>
  );
}

function Board({ data }: { data: LeagueOverview | null }): React.JSX.Element {
  return (
    <section>
      <h2 className="lg-heading">GLOBAL STANDINGS</h2>
      <div className="lg-board">
        {data?.board.length ? data.board.map((entry) => (
          <div key={entry.baseId} className={`lg-well lg-board-row${entry.you ? ' is-you' : ''}`}>
            <span className="lg-rank">#{entry.rank}</span>
            <img className="lg-crest lg-crest-small" src={leagueCrestUrl(entry.tier)} alt="" />
            <span className="lg-name">{entry.you ? 'YOU' : entry.name || 'UNNAMED KEEP'}</span>
            <b style={{ color: TIER_COLOR[entry.tier] }}>{fmtN(entry.trophies)}</b>
          </div>
        )) : <div className="lg-well lg-empty">NO RANKED BASES YET.</div>}
      </div>
    </section>
  );
}

function LastSettlement({ settlement }: {
  settlement: LeagueOverview['lastSettlement'];
}): React.JSX.Element {
  return (
    <section>
      <h2 className="lg-heading">LAST SETTLEMENT</h2>
      {!settlement ? <div className="lg-well lg-empty">NO REWARD RECEIPT YET.</div> : (
        <div className="lg-well lg-last">
          <img className="lg-crest" src={leagueCrestUrl(settlement.tier)} alt="" />
          <div>
            <b>{settlement.week} · {TIER_LABEL[settlement.tier]} · {fmtN(settlement.trophies)} TROPHIES</b>
            <span>{Number(settlement.cacheShards).toLocaleString('en-US')} SHARDS · KEEP {settlement.keepLevel}</span>
            {settlement.items.map((item) => (
              <span key={item.itemId}>{item.qty} × {itemName(item.itemId)}</span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
