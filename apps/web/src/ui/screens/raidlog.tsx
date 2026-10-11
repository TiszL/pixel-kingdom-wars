import type {BoundCosmeticBaseRead} from '@shardkeep/shared/boundCosmeticVisual';
import type { BaseVisualContext } from '@shardkeep/shared/baseVisual';
/** Deed-scoped permanent battle history (D-036).
 *
 * Stable multi-base mode reads the selected deed's cursor-paginated record and
 * its deed-authorized replay endpoint. Legacy flag-off servers keep their old
 * wallet-wide /raids surface until the capability boundary is enabled.
 */
import { RAID_RULES, type HeroCombatLoadout, type HeroKey } from '@shardkeep/shared';
import { battleHealthContext } from '../../game/fx/stats';
import { useEffect, useState } from 'react';
import { api, baseSelectorAvailable } from '../../lib/api';
import { bus } from '../../lib/events';
import { type RaidTarget, useApp } from '../../state/store';
import { markDefencesRead } from '../baseDefences';
import { openScout } from '../scoutNavigation';
import { Btn, Chip, COLORS as C, fmtN, Icon, ScrollPage, Sp } from '../primitives';
import { SeekerBadge } from './seeker';

interface LegacyRaidRow {
  id: string;
  role: 'attacker' | 'defender';
  opponent: string | null;
  opponentName: string;
  opponentSeeker: boolean;
  status: string;
  result: {
    stars?: number;
    destructionPct?: number;
    lootShards?: number;
    attackerTrophyDelta?: number;
    defenderTrophyDelta?: number;
  } | null;
  createdAt: string;
  resumable: boolean;
}

export interface BattleHistoryRow {
  baseId: string;
  raidId: string;
  role: 'attacker' | 'defender';
  mode: 'pvp' | 'pve' | 'campaign';
  opponentLabel: string | null;
  result: 'victory' | 'defeat';
  stars: number;
  destructionPct: number;
  /** Signed, exact settled delta for this deed. Null is intentional redaction. */
  lootDeltaShards: string | null;
  /** Exact display amount and real currency. PvE pays KEEP; PvP/campaign pay SHARDS. */
  settledAmount: string | null;
  settledCurrency: 'SHARDS' | 'KEEP';
  lootRedacted: boolean;
  opponent: {
    baseId: string;
    wallet: string;
    name: string;
    seeker: boolean;
  } | null;
  createdAt: string;
  /** Client-only authorization route; never accepted as server authority. */
  replayAccess?: 'deed' | 'participant' | 'legacy';
}

interface BattleHistoryPage {
  baseId?: string;
  battles: BattleHistoryRow[];
  nextCursor: string | null;
}

interface PendingRaidRow {
  id: string;
  attackerBaseId?: string | null;
  defenderWallet?: string | null;
  defenderBaseId?: string | null;
  pveCampId?: string | null;
  campaignStage?: number | null;
}

export interface ReplayResult {
  stars: number;
  destructionPct: number;
  keepDestroyed: boolean;
  lootShards: number | null;
  attackerTrophyDelta: number;
  lootRedacted?: boolean;
}

interface ReplayBundle {
  orders?: Parameters<typeof battleHealthContext>[0];
  visualContext?: BaseVisualContext | undefined; boundCosmeticVisual?: BoundCosmeticBaseRead | undefined;
  id: string;
  snapshot: unknown;
  simVersion: number;
  events: Array<{ t: number; e: string; n?: number }>;
  result?: ReplayResult;
  armySnapshot?: {
    levels?: Record<string, number>;
    counts?: Record<string, number>;
    heroLevels?: Record<string, number>;
    heroLoadouts?: Partial<Record<HeroKey, HeroCombatLoadout>>;
  };
}

const toast = (msg: string): void => bus.emit('ui:toast', { msg });

export function raidLogContinuationTarget(raidId: string): RaidTarget {
  return { kind: 'pvp', raidId };
}

export function battleHistoryPath(baseId: string, cursor?: string): string {
  const root = `/bases/${encodeURIComponent(baseId)}/battles`;
  return cursor ? `${root}?cursor=${encodeURIComponent(cursor)}` : root;
}

export function battleReplayPath(baseId: string, raidId: string): string {
  return `/bases/${encodeURIComponent(baseId)}/battles/${encodeURIComponent(raidId)}/replay`;
}

export function participantHistoryPath(cursor?: string): string {
  const root = '/battles/participated';
  return cursor ? `${root}?cursor=${encodeURIComponent(cursor)}` : root;
}

export function participantReplayPath(raidId: string): string {
  return `/battles/participated/${encodeURIComponent(raidId)}/replay`;
}

/** Selected-deed rows already appear with deed authority. Removing them from
 * the participant section prevents duplicate battles without hiding fights
 * from a sold or merely different deed. */
export function priorParticipantRows(
  rows: readonly BattleHistoryRow[], selectedBaseId: string | null,
): BattleHistoryRow[] {
  return rows
    .filter((row) => row.baseId !== selectedBaseId)
    .map((row) => ({ ...row, replayAccess: 'participant' }));
}

export function historyReplayRequestPath(stable: boolean, row: BattleHistoryRow): string {
  if (!stable || row.replayAccess === 'legacy') {
    return `/raids/${encodeURIComponent(row.raidId)}/replay`;
  }
  return row.replayAccess === 'participant'
    ? participantReplayPath(row.raidId)
    : battleReplayPath(row.baseId, row.raidId);
}

/** Exact integer formatting stays string-based: a deed can outlive JS's safe
 * integer range, and the API deliberately supplies this field as a string. */
export function settledLootLabel(row: Pick<BattleHistoryRow,
  'lootDeltaShards' | 'settledAmount' | 'settledCurrency' | 'lootRedacted'>): string {
  if (row.lootRedacted || row.settledAmount === null) return 'LOOT REDACTED';
  const value = row.settledAmount ?? row.lootDeltaShards ?? '0';
  const prefix = value.startsWith('-') || value === '0' ? '' : '+';
  return `${prefix}${fmtN(value)} ${row.settledCurrency}`;
}

function shortWallet(wallet: string): string {
  return wallet.length > 10 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : wallet;
}

/** Every row names the actual attacker, not merely an ambiguous "opponent". */
export function battleAttacker(row: BattleHistoryRow): { label: string; seeker: boolean } {
  if (row.role === 'attacker') return { label: 'YOU', seeker: false };
  if (!row.opponent) return { label: 'UNKNOWN', seeker: false };
  return {
    label: row.opponent.name || shortWallet(row.opponent.wallet),
    seeker: row.opponent.seeker,
  };
}

/**
 * REVENGE (D-099, owner 2026-09-02: "no good raid logs button to be able to
 * revenge"). A PvP defence row offers the counter-attack as EXACTLY the target
 * map.tsx builds, so it takes the normal raid path and the server's createRaid
 * stays the only attackability gate — its 422 surfaces through RaidUI's error
 * path. No client-side check: a stale "can't" here would be a lie the server
 * never told. PvE and campaign have no player to avenge; an attacker row is
 * your own raid.
 */
export function revengeTarget(row: BattleHistoryRow): RaidTarget | null {
  if (row.role !== 'defender' || row.mode !== 'pvp' || !row.opponent) return null;
  return {
    kind: 'pvp',
    wallet: row.opponent.wallet,
    // Legacy rows carry no deed id; the auto-match target shape covers them.
    defenderBaseId: row.opponent.baseId || undefined,
    name: row.opponent.name || undefined,
  };
}

/** Inside RAID_RULES.revengeLockHours the server treats the counter-attack as
 * revenge (world.ts); after that it is an ordinary attack, and the button says
 * so rather than promising a status the server will not grant. */
export function revengeLabel(row: Pick<BattleHistoryRow, 'createdAt'>, now = Date.now()): string {
  const lockMs = RAID_RULES.revengeLockHours * 3_600_000;
  return now - Date.parse(row.createdAt) > lockMs ? 'ATTACK BACK' : 'REVENGE';
}

/** The button's whole effect, shared with the screen so a test can press it
 * without a DOM: the same two store writes the map's attack makes. */
export function startRevenge(row: BattleHistoryRow): boolean {
  const target = revengeTarget(row);
  if (!target) return false;
  const state = useApp.getState();
  state.setRaidTarget(target);
  state.setScreen('battle');
  return true;
}

/** App row time (L1175 '2H AGO'): relative, uppercase, from raid createdAt. */
function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return 'JUST NOW';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}M AGO`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}H AGO`;
  return `${Math.floor(hr / 24)}D AGO`;
}

export function legacyBattle(row: LegacyRaidRow): BattleHistoryRow {
  const stars = row.result?.stars ?? 0;
  const attackerWon = stars >= 1;
  const won = row.role === 'attacker' ? attackerWon : !attackerWon;
  const rawLoot = row.result?.lootShards;
  return {
    baseId: '',
    raidId: row.id,
    role: row.role,
    mode: 'pvp',
    opponentLabel: null,
    result: won ? 'victory' : 'defeat',
    stars,
    destructionPct: row.result?.destructionPct ?? 0,
    lootDeltaShards: rawLoot === undefined ? '0' : `${row.role === 'defender' ? '-' : ''}${rawLoot}`,
    settledAmount: rawLoot === undefined ? '0' : `${row.role === 'defender' ? '-' : ''}${rawLoot}`,
    settledCurrency: 'SHARDS',
    lootRedacted: false,
    opponent: row.opponent ? {
      baseId: '', wallet: row.opponent, name: row.opponentName, seeker: row.opponentSeeker,
    } : null,
    createdAt: row.createdAt,
    replayAccess: 'legacy',
  };
}

function BattleRows({
  battles, participant, onReplay, onRevenge, onScout,
}: {
  battles: BattleHistoryRow[];
  participant: boolean;
  onReplay(row: BattleHistoryRow): void;
  onRevenge(row: BattleHistoryRow): void;
  onScout?: ((row: BattleHistoryRow) => void) | undefined;
}): React.JSX.Element {
  return (
    <>
      {battles.map((row) => {
        const attacker = battleAttacker(row);
        const won = row.result === 'victory';
        const opponent = row.opponent
          ? row.opponent.name || shortWallet(row.opponent.wallet)
          : row.opponentLabel ?? 'UNKNOWN OPPONENT';
        return (
          <Chip key={`${row.replayAccess ?? 'deed'}:${row.baseId}:${row.raidId}`} style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Icon name={row.role === 'defender' ? 'shield' : 'attack'} size={22} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
              <span style={{ fontSize: 16, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                ATTACKER · {attacker.seeker && <SeekerBadge size={13} />}{attacker.label}
              </span>
              <span style={{ fontSize: 13, color: C.textFaint }}>
                {row.role === 'attacker' ? `VS ${opponent} · ` : ''}{row.stars}★ · {row.destructionPct}% · {relTime(row.createdAt)}
              </span>
              {participant && (
                <span style={{ fontSize: 12, color: C.stoneDark }}>
                  FOUGHT FROM DEED {row.baseId.slice(0, 8).toUpperCase()}
                </span>
              )}
              <span style={{ fontSize: 13, color: row.lootRedacted ? C.textFaint : row.role === 'attacker' ? C.success : C.danger }}>
                {settledLootLabel(row)}
              </span>
            </div>
            <Sp />
            <span style={{ color: won ? C.success : C.danger, fontSize: 13 }}>{row.result.toUpperCase()}</span>
            {revengeTarget(row) && onScout && (
              <Btn variant="sec" fontSize={13} style={{ minHeight: 44, padding: '3px 8px 5px' }} onClick={() => onScout(row)}>
                <Icon name="scout" size={16} />SCOUT
              </Btn>
            )}
            {revengeTarget(row) && (
              <Btn fontSize={13} style={{ minHeight: 44, padding: '3px 8px 5px' }} onClick={() => onRevenge(row)}>
                <Icon name="attack" size={16} />{revengeLabel(row)}
              </Btn>
            )}
            <Btn variant="sec" fontSize={13}
              style={{ minHeight: 44, padding: '3px 8px 5px' }} onClick={() => onReplay(row)}>
              <Icon name="replay" size={16} />REPLAY
            </Btn>
          </Chip>
        );
      })}
    </>
  );
}

export function BattleHistoryView({
  deedBattles, participantBattles, pending, stable, deedSelected, loading,
  deedLoadingMore, participantLoadingMore, error, deedNextCursor, participantNextCursor,
  onReplay, onRevenge, onScout, onResume, onMoreDeed, onMoreParticipant,
}: {
  deedBattles: BattleHistoryRow[];
  participantBattles: BattleHistoryRow[];
  pending: PendingRaidRow[];
  stable: boolean;
  deedSelected: boolean;
  loading: boolean;
  deedLoadingMore: boolean;
  participantLoadingMore: boolean;
  error: string | null;
  deedNextCursor: string | null;
  participantNextCursor: string | null;
  onReplay(row: BattleHistoryRow): void;
  onRevenge(row: BattleHistoryRow): void;
  onScout?: ((row: BattleHistoryRow) => void) | undefined;
  onResume(row: PendingRaidRow): void;
  onMoreDeed(): void;
  onMoreParticipant(): void;
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {error && <Chip><span role="alert" style={{ color: C.danger }}>{error}</span></Chip>}
      {pending.map((row) => (
        <Chip key={`pending:${row.id}`} style={{ alignItems: 'center' }}>
          <Icon name="attack" size={22} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={{ fontSize: 17 }}>UNFINISHED MARCH</span>
            <span style={{ fontSize: 13, color: C.textFaint }}>SERVER-SAVED · READY TO CONTINUE</span>
          </div>
          <Sp />
          <Btn fontSize={13} style={{ padding: '3px 8px 5px' }} onClick={() => onResume(row)}>CONTINUE</Btn>
        </Chip>
      ))}

      <div style={{ color: C.goldHi, fontSize: 15, paddingTop: 4 }}>
        {stable ? 'SELECTED DEED HISTORY' : 'WALLET RAID HISTORY'}
      </div>
      {!loading && stable && !deedSelected && (
        <div style={{ color: C.textFaint, textAlign: 'center', padding: 10 }}>
          NO ACTIVE DEED SELECTED · YOUR PRIOR PARTICIPATION REMAINS BELOW
        </div>
      )}
      {!loading && deedSelected && deedBattles.length === 0 && pending.length === 0 && (
        <div style={{ color: C.textFaint, textAlign: 'center', padding: 10 }}>NO BATTLES RECORDED FOR THIS DEED.</div>
      )}
      <BattleRows battles={deedBattles} participant={false} onReplay={onReplay} onRevenge={onRevenge} onScout={onScout} />
      {deedNextCursor && (
        <Btn variant="sec" disabled={deedLoadingMore} onClick={onMoreDeed}>
          {deedLoadingMore ? 'LOADING…' : 'LOAD OLDER DEED BATTLES'}
        </Btn>
      )}

      {stable && (
        <>
          <div style={{ color: C.goldHi, fontSize: 15, paddingTop: 8 }}>
            OTHER / PRIOR DEED PARTICIPATION
          </div>
          <div style={{ color: C.textFaint, fontSize: 12 }}>
            YOUR EXACT PRIVATE RECORD SURVIVES A DEED SALE
          </div>
          {!loading && participantBattles.length === 0 && !participantNextCursor && (
            <div style={{ color: C.textFaint, textAlign: 'center', padding: 10 }}>NO OTHER PARTICIPATED BATTLES.</div>
          )}
          <BattleRows battles={participantBattles} participant onReplay={onReplay} onRevenge={onRevenge} onScout={onScout} />
          {participantNextCursor && (
            <Btn variant="sec" disabled={participantLoadingMore} onClick={onMoreParticipant}>
              {participantLoadingMore ? 'LOADING…' : 'LOAD OLDER PARTICIPATED BATTLES'}
            </Btn>
          )}
        </>
      )}
      {loading && <div style={{ color: C.textFaint, textAlign: 'center', padding: 12 }}>LOADING BATTLE HISTORY…</div>}
      <div style={{ color: C.stoneDark, fontSize: 15, textAlign: 'center', paddingTop: 6 }}>
        DEED RECORDS TRANSFER · PARTICIPANT REPLAYS REMAIN PRIVATE
      </div>
    </div>
  );
}

export function RaidLogScreen(): React.JSX.Element {
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const directory = useApp((s) => s.baseDirectory);
  const stable = baseSelectorAvailable(directory);
  const setScreen = useApp((s) => s.setScreen);
  const setRaidTarget = useApp((s) => s.setRaidTarget);
  const [deedBattles, setDeedBattles] = useState<BattleHistoryRow[]>([]);
  const [participantBattles, setParticipantBattles] = useState<BattleHistoryRow[]>([]);
  const [pending, setPending] = useState<PendingRaidRow[]>([]);
  const [deedNextCursor, setDeedNextCursor] = useState<string | null>(null);
  const [participantNextCursor, setParticipantNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deedLoadingMore, setDeedLoadingMore] = useState(false);
  const [participantLoadingMore, setParticipantLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Opening this screen is what "seen" means for the RAIDED chip (D-099).
  const loadedBase = useApp((s) => s.base);
  useEffect(() => { markDefencesRead(loadedBase); }, [loadedBase]);

  useEffect(() => {
    let live = true;
    setDeedBattles([]); setParticipantBattles([]); setPending([]);
    setDeedNextCursor(null); setParticipantNextCursor(null); setError(null);
    setLoading(true);
    const history = stable
      ? selectedBaseId
        ? api.get<BattleHistoryPage>(battleHistoryPath(selectedBaseId))
        : Promise.resolve({ battles: [], nextCursor: null } satisfies BattleHistoryPage)
      : api.get<{ raids: LegacyRaidRow[] }>('/raids').then(({ raids }) => ({
        baseId: '', battles: raids.filter((row) => row.status === 'resolved').map(legacyBattle), nextCursor: null,
      }));
    const participated = stable
      ? api.get<BattleHistoryPage>(participantHistoryPath())
      : Promise.resolve({ battles: [], nextCursor: null } satisfies BattleHistoryPage);
    const pendingRaids = api.get<{ raids: PendingRaidRow[] }>('/raids/pending');
    void Promise.allSettled([history, participated, pendingRaids]).then((results) => {
      if (!live) return;
      const [deedResult, participantResult, pendingResult] = results;
      const errors: string[] = [];
      if (deedResult.status === 'fulfilled') {
        setDeedBattles(deedResult.value.battles.map((row) => ({
          ...row, replayAccess: stable ? 'deed' : 'legacy',
        })));
        setDeedNextCursor(deedResult.value.nextCursor);
      } else errors.push(deedResult.reason instanceof Error ? deedResult.reason.message : 'DEED HISTORY UNAVAILABLE');
      if (participantResult.status === 'fulfilled') {
        setParticipantBattles(priorParticipantRows(participantResult.value.battles, selectedBaseId));
        setParticipantNextCursor(participantResult.value.nextCursor);
      } else errors.push(participantResult.reason instanceof Error
        ? participantResult.reason.message : 'PARTICIPANT HISTORY UNAVAILABLE');
      if (pendingResult.status === 'fulfilled') {
        setPending(stable
          ? pendingResult.value.raids.filter((row) => row.attackerBaseId === selectedBaseId)
          : pendingResult.value.raids);
      } else errors.push(pendingResult.reason instanceof Error
        ? pendingResult.reason.message : 'UNFINISHED MARCHES UNAVAILABLE');
      setError(errors.length > 0 ? [...new Set(errors)].join(' · ') : null);
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [selectedBaseId, stable]);

  const watch = (row: BattleHistoryRow): void => {
    const path = historyReplayRequestPath(stable, row);
    void api.get<ReplayBundle>(path).then((rep) => {
      setRaidTarget({
        kind: 'replay', raidId: row.raidId,
        ...(stable ? { replayPath: path } : {}),
        ...(stable && row.replayAccess === 'deed' ? { replayBaseId: row.baseId } : {}),
        name: row.opponent?.name || row.opponent?.wallet || row.opponentLabel || undefined,
        result: rep.result,
      });
      setScreen('battle');
      bus.emit('battle:enter', {
        snapshot: rep.snapshot,
        visualContext: rep.visualContext, boundCosmeticVisual: rep.boundCosmeticVisual,
        armyLevels: rep.armySnapshot?.levels ?? {},
        armyCounts: rep.armySnapshot?.counts,
        heroLevels: rep.armySnapshot?.heroLevels,
      });
      setTimeout(() => bus.emit('battle:play', { ...battleHealthContext(rep.orders, rep.armySnapshot?.heroLoadouts), events: rep.events, simVersion: rep.simVersion }), 80);
    }).catch((cause: Error) => toast(cause.message));
  };

  const resume = (row: PendingRaidRow): void => {
    setRaidTarget(raidLogContinuationTarget(row.id));
    setScreen('battle');
  };

  const loadMoreDeed = (): void => {
    if (!stable || !selectedBaseId || !deedNextCursor || deedLoadingMore) return;
    setDeedLoadingMore(true); setError(null);
    void api.get<BattleHistoryPage>(battleHistoryPath(selectedBaseId, deedNextCursor))
      .then((page) => {
        setDeedBattles((current) => {
          const seen = new Set(current.map((row) => row.raidId));
          return [...current, ...page.battles
            .filter((row) => !seen.has(row.raidId))
            .map((row) => ({ ...row, replayAccess: 'deed' as const }))];
        });
        setDeedNextCursor(page.nextCursor);
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setDeedLoadingMore(false));
  };

  const loadMoreParticipant = (): void => {
    if (!stable || !participantNextCursor || participantLoadingMore) return;
    setParticipantLoadingMore(true); setError(null);
    void api.get<BattleHistoryPage>(participantHistoryPath(participantNextCursor))
      .then((page) => {
        setParticipantBattles((current) => {
          const seen = new Set(current.map((row) => `${row.baseId}:${row.raidId}:${row.role}`));
          return [...current, ...page.battles
            .filter((row) => row.baseId !== selectedBaseId
              && !seen.has(`${row.baseId}:${row.raidId}:${row.role}`))
            .map((row) => ({ ...row, replayAccess: 'participant' as const }))];
        });
        setParticipantNextCursor(page.nextCursor);
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setParticipantLoadingMore(false));
  };

  return (
    <ScrollPage title="BATTLE HISTORY" onClose={() => setScreen('base')}>
      <BattleHistoryView
        deedBattles={deedBattles} participantBattles={participantBattles} pending={pending}
        stable={stable} deedSelected={!stable || selectedBaseId !== null} loading={loading}
        deedLoadingMore={deedLoadingMore} participantLoadingMore={participantLoadingMore}
        error={error} deedNextCursor={deedNextCursor} participantNextCursor={participantNextCursor}
        onScout={(row) => { const target = revengeTarget(row); if (target) void openScout(target, 'raidlog'); }}
        onReplay={watch} onRevenge={(row) => { startRevenge(row); }} onResume={resume}
        onMoreDeed={loadMoreDeed} onMoreParticipant={loadMoreParticipant}
      />
    </ScrollPage>
  );
}
