import { phaseEWebEnabled, phaseEBuildingHeld } from './phaseEWebHold';
import { useUserCommand } from './pk/useUserCommand';
import { wallTierOfLevel } from '@shardkeep/shared/wallArt';
/**
 * Bottom sheets: building action sheet (with TRAIN/RESEARCH/VIEW-ARMY trays),
 * obstacle clear sheet, build tray with placement bar (HANDOFF §5.1/§5.3).
 * Every sheet minimises to its header (App parity: chevron collapses body,
 * state resets on nav). Costs/stats shown from @shardkeep/shared for DISPLAY;
 * the server re-validates everything on POST.
 */
import {
  artTierOfLevel,
  buildCountCapForKeep,
  advertisedBerthBuildCapacity,
  BUILD_COSTS,
  CAPS,
  DEFENSE_LEVELING,
  DEFENSES,
  HEROES,
  MINING,
  OBSTACLES,
  STRUCTURES,
  TRAP_TYPES,
  TRAP_REPAIR,
  UPGRADE_COSTS,
  UPGRADE_TIMES_SEC,
  upgradeSolLamports,
  WARE_PORTRAIT_ART,
  warePortraitAliasKey, vaultProtectionBps,
} from '@shardkeep/shared';
import { lazy, Suspense, useEffect, useState } from 'react';
import { ApiError, api, idemKey } from '../lib/api';
import { selectedBasePath, withSelectedBase } from '../lib/baseSelection';
import { playSfx } from '../lib/audio';
import { bus } from '../lib/events';
import { haptic } from '../lib/juice';
import { reloadBase } from '../state/baseSnapshot';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../state/store';
import { useHeroRecruitmentRecovery } from '../auth/useHeroRecruitmentRecovery';
import { useBuilderJobSpeedupView } from '../lib/builderJobSpeedup/context';
import { useHeroProgressionView } from '../lib/heroProgression/context';
import { HeroRecruitmentPanel } from './HeroRecruitmentPanel';
import { useSolPurchase } from '../auth/useSolPurchase';
import { CHROME, hudHeight, hudTier, usePortrait, useWindowSize } from './layout';
import { HudPrimaryButton, HudSheetHead, HudStatBlock, HudStatDelta } from './hudChrome';
import { useFetch } from './useFetch';
import { useMineStatus } from './useMineStatus';
import { isHandledGlobally } from './actionError';
import { useMobileBackHandler } from '../lib/mobileBackGuard';
import { chooseGameCurrency } from '../lib/gameCurrency';
import { useCancelJobConfirm } from './CancelJobConfirm';
import { WallRowUpgrade } from './WallRowUpgrade';
const WorkshopDoor = lazy(() => import('./WorkshopDoor').then(m => ({ default: m.WorkshopDoor })));
const PhaseEBuildingDoor = lazy(() => import('./phaseE/PhaseERegistration').then(m => ({ default: m.PhaseEBuildingDoor })));
import { heroPortrait } from './heroPortrait';
import { sprite } from './icons';
import { readTrainingPurchase } from './screens/trainingPurchase';
import {
  Btn, COLORS as C, fmtDur, fmtN, Icon, MinBtn, Panel9, Pill, PillVal, Sprite,
} from './primitives';

// Orientation moved to ./layout so the base chrome, the sheets and the Phaser
// layer all derive it once (two derivations drift mid-rotation). Re-exported
// here because this module was its original home.
export { isPortrait, usePortrait } from './layout';

export { reloadBase } from '../state/baseSnapshot';

function useCountdown(finishesAt: string | undefined): number {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!finishesAt) return 0;
  return Math.max(0, Math.ceil((new Date(finishesAt).getTime() - Date.now()) / 1000));
}

// ---------------------------------------------------------------------------
// Stat-row helpers — current value with a gold "next level" column (App selSheet)
// ---------------------------------------------------------------------------

/**
 * ONE STAT, BEFORE AND AFTER (owner 2026-08-29: the sheet is the flattest thing
 * on screen). This used to be a Pill reading "HP 1250 →1562": the two numbers a
 * player is choosing between were the same size and weight inside one grey box,
 * so the comparison the whole sheet exists to support was its least legible
 * part. HudStatDelta lays them out as a captioned block of aligned rows with the
 * bought value as the only gold thing in each — the numbers and the gate are
 * unchanged, only which of them the eye reaches first.
 */
function StatChip({ label, cur, next }: { label: string; cur: string | number; next?: string | number | undefined }): React.JSX.Element {
  return (
    <HudStatDelta label={label} cur={String(cur)}
      {...(next !== undefined ? { next: String(next) } : {})} />
  );
}

/** Max level/tier for a build type (App selLevel.max): walls use maxTier,
 * structures their maxLevel, defenses DEFENSE_LEVELING.maxLevel. */
export function maxLevelFor(type: string): number {
  if (type === 'wall') return STRUCTURES.wall.maxTier;
  if (type in DEFENSES) return DEFENSE_LEVELING.maxLevel;
  const struct = (STRUCTURES as Record<string, { maxLevel?: number }>)[type];
  return struct?.maxLevel ?? 1;
}

export interface TrapRepairDetails {
  costShards: number;
  repairSec: number;
}

/** Every spent trap on the base with the price its own REPAIR button would
 * quote — the REPAIR ALL plan (tester reports 2026-09-16 ×2). The same
 * trapRepairDetails per row, so the total is exactly the sum of the single
 * taps; order is the base's, which is the order the POSTs are sent. */
export function spentTrapRepairs(
  buildings: ReadonlyArray<{ id: string; type: string; level: number; trapSpentAt?: string | null }>,
): Array<{ id: string; costShards: number }> {
  const plan: Array<{ id: string; costShards: number }> = [];
  for (const b of buildings) {
    const repair = trapRepairDetails(b.type, b.level, b.trapSpentAt);
    if (repair) plan.push({ id: b.id, costShards: repair.costShards });
  }
  return plan;
}

/** A saved training purchase the barracks tray has not resolved (a failed
 * batch waiting on RETRY / CLOSE). A read-only peek at the SAME durable receipt
 * TrainingPresets recovers from, so the building sheet can flag it before the
 * tray opens (tester report 2026-09-16). Unreadable storage reads as "none"
 * here — the tray reports the storage fault itself. */
function hasUnresolvedTrainingPurchase(wallet: string | null): boolean {
  if (!wallet) return false;
  try { return readTrainingPurchase(wallet) !== null; } catch { return false; }
}

/** Pure presentation contract for a spent trap; all values stay shared-owned. */
export function trapRepairDetails(
  type: string, level: number, trapSpentAt?: string | null,
): TrapRepairDetails | null {
  const repair = (TRAP_REPAIR as Record<string, {
    costShardsByTier: readonly number[]; repairSec: number;
  }>)[type];
  if (!trapSpentAt || !repair) return null;
  const tier = artTierOfLevel(level);
  return { costShards: repair.costShardsByTier[tier - 1]!, repairSec: repair.repairSec };
}

/** Leveled HP/DPS preview for a defence/structure. Mirrors App dStat/statChips:
 * walls use the explicit per-tier HP table (DEFENSES/STRUCTURES, App DSTATS),
 * mine shows a PWR ×level chip, and the →next preview is suppressed at max
 * (App statChips L567 gate). All numbers come from @shardkeep/shared. */
function levelStats(type: string, level: number, previewUpgrade = true): React.JSX.Element | null {
  const def = (DEFENSES as Record<string, { hp?: number; dps?: number; rangeTiles?: number }>)[type];
  const struct = (STRUCTURES as Record<string, { hp?: number; capacity?: readonly number[]; queuePts?: readonly number[]; capacityPts?: readonly number[] }>)[type];
  // Defences and structures both level by DEFENSE_LEVELING.statMultPerLevel
  // (was a duplicated hardcoded 1.25 for structures).
  const mult = DEFENSE_LEVELING.statMultPerLevel;
  const max = maxLevelFor(type);
  const atMax = level >= max || !previewUpgrade;
  // Gameplay levels remain distinct from visual art tiers. The
  // sheet header makes, restated here because the caption has to agree with it.
  const unit = 'LEVEL';
  const chips: React.JSX.Element[] = [];

  if (type === 'wall') {
    // Wall HP is a fixed per-tier table, NOT a ×mult (App dStat L557).
    const hpByTier = STRUCTURES.wall.hpByTier;
    chips.push(<StatChip key="hp" label="HP" cur={hpByTier[level - 1] ?? hpByTier[hpByTier.length - 1]!} next={atMax ? undefined : hpByTier[level]} />);
  } else {
    const hp = def?.hp ?? struct?.hp;
    if (hp) {
      chips.push(<StatChip key="hp" label="HP" cur={Math.round(hp * mult ** (level - 1))} next={atMax ? undefined : Math.round(hp * mult ** level)} />);
    }
  }
  if (def?.dps) {
    chips.push(<StatChip key="dps" label="DMG" cur={Math.round(def.dps * mult ** (level - 1))} next={atMax ? undefined : Math.round(def.dps * mult ** level)} />);
  }
  if (def?.rangeTiles) chips.push(<StatChip key="rng" label="RNG" cur={def.rangeTiles} />);
  // D-065: the Vault's job is raid protection by LEVEL, not a storage cap —
  // show how much of the 50% lootable share it shields now and next level.
  if (type === 'vault') {
    chips.push(<StatChip key="protect" label="SHIELDS"
      cur={`${vaultProtectionBps(level) / 100}%`}
      next={atMax ? undefined : `${vaultProtectionBps(level + 1) / 100}%`} />);
  }
  const cap = type === 'vault' ? undefined : (struct?.capacity ?? struct?.capacityPts ?? struct?.queuePts);
  if (cap) {
    chips.push(<StatChip key="cap" label="CAP" cur={fmtN(cap[level - 1] ?? cap[cap.length - 1]!)} next={atMax || cap[level] === undefined ? undefined : fmtN(cap[level]!)} />);
  }
  // Mine PWR chip — the real quota multiplier from MINING.MINE_MULT_BPS
  // (bps → ×, e.g. 17000 → ×1.7), for the current and next mine level.
  if (type === 'mine') {
    const bps = MINING.MINE_MULT_BPS;
    const curBps = bps[level - 1];
    const nextBps = bps[level];
    if (curBps !== undefined) {
      chips.push(<StatChip key="pwr" label="PWR"
        cur={`×${curBps / MINING.BPS_ONE}`}
        next={atMax || nextBps === undefined ? undefined : `×${nextBps / MINING.BPS_ONE}`} />);
    }
  }
  if (chips.length === 0) return null;
  // The caption names what the gold column IS. Without it a gold number beside a
  // white one is merely a brighter number; with it the block is a quote for the
  // upgrade the button underneath sells. At max there is nothing to quote, so
  // the block is the plain live stats and says so by having no caption.
  return (
    <HudStatBlock {...(atMax ? {} : { caption: `AT ${unit} ${level + 1}` })}>
      {chips}
    </HudStatBlock>
  );
}

// ---------------------------------------------------------------------------
// Mine COLLECT (ECONOMY.md §2) — settle the fixed-quota buffer into the ledger.
// Every completed Mine owns a capped buffer; this base-level control harvests
// every physical Mine on the selected deed in one transaction. Reads the
// aggregate selected-deed view from GET
// /mine/status.mining (accrued / cap + rate/h + mineCount), POSTs /mine/collect
// (→ {amount}). The daily-cache streak is CLAIMed separately (Claim screen, §3).
// ---------------------------------------------------------------------------

function MineCollect(): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const { data, error, reload } = useMineStatus();
  const m = data?.mining;
  const mineCount = m?.mineCount ?? 0;
  const collect = (): void => {
    setBusy(true);
    void api.post<{ amount?: string }>('/mine/collect', withSelectedBase({}))
      .then((r) => {
        const got = Number(r.amount ?? 0);
        playSfx(got > 0 ? 'sfx_confirm' : 'sfx_tap');
        haptic('light');
        // Mining credits this deed's base_shards, not wallet KEEP/SHARDS.
        bus.emit('ui:toast', { msg: got > 0 ? `+${fmtN(got)} SHARDS` : 'NOTHING TO COLLECT YET' });
        return reloadBase();
      })
      .catch((e: Error) => { playSfx('sfx_error'); bus.emit('ui:toast', { msg: e.message }); })
      .finally(() => { setBusy(false); reload(); });
  };
  return (
    <div style={{ marginBottom: 6 }}>
      <Btn fontSize={18} disabled={busy || !m} style={{ width: '100%' }} onClick={collect}>
        <Icon name="shard" size={18} />
        <span>{m ? <>COLLECT MINING · <span style={{ whiteSpace: 'nowrap' }}>{fmtN(m.accrued)} / {fmtN(m.storageCap)}</span></> : error ? 'MINING STATUS UNAVAILABLE' : 'LOADING MINING…'}</span>
        {m?.ratePerHour ? <span style={{ fontSize: 14, whiteSpace: 'nowrap' }}> · {fmtN(m.ratePerHour)}/H</span> : null}
      </Btn>
      {error ? <div role="status" style={{ color: C.textFaint, fontSize: 13, textAlign: 'center' }}>
        Mining status could not refresh. <Btn variant="ghost" fontSize={14} onClick={reload}>Retry</Btn>
      </div> : null}
      {/* One tap settles each physical buffer on this deed; other deeds are untouched. */}
      <div style={{ color: C.textFaint, fontSize: 13, textAlign: 'center', paddingTop: 3 }}>
        {mineCount > 1 ? `selected deed · all ${mineCount} mine buffers` : 'selected deed mining income'}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Building action sheet
// ---------------------------------------------------------------------------

/** Army buildings whose action button opens a two-step tray (App selSheet:
 * barracks→TRAIN TROOPS, forge→UPGRADE TROOPS, camp→VIEW ARMY). */
/** Inline Codex prose + Keep unlock list (M23 a7/a19) — lazy for the same
 *  first-paint reason as the trays: it drags the whole Codex copy in. */
const BuildingInfo = lazy(() => import('./BuildingInfo'));
const TrainTray = lazy(() => import('./screens/army').then((m) => ({ default: m.TrainTray })));
const ResearchTray = lazy(() => import('./screens/army').then((m) => ({ default: m.ResearchTray })));
const ArmyRoster = lazy(() => import('./screens/army').then((m) => ({ default: m.ArmyRoster })));
const HeroTray = lazy(() => import('./screens/heroes').then((m) => ({ default: m.HeroTray })));

const TRAY_BUILDINGS: Record<string, { label: string; Tray: React.ElementType }> = {
  barracks: { label: 'TRAIN TROOPS', Tray: TrainTray },
  forge: { label: 'UPGRADE TROOPS', Tray: ResearchTray },
  camp: { label: 'VIEW ARMY', Tray: ArmyRoster },
};

/** builderJobs.kind as a noun the KEEP confirmation can put in a sentence
 *  ("FINISH THIS UPGRADE"); the raw kind reads "CLEAR_OBSTACLE". */
const JOB_NOUN: Record<string, string> = {
  build: 'BUILD', upgrade: 'UPGRADE', clear_obstacle: 'CLEARING',
};

export function ActionSheet(): React.JSX.Element | null {
  const base = useApp((s) => s.base);
  const id = useApp((s) => s.selectedBuildingId);
  const screen = useApp((s) => s.screen);
  const select = useApp((s) => s.select);
  const wallet = useApp((s) => s.wallet);
  const wallRow = useApp((s) => s.wallRow);
  const setWallRow = useApp((s) => s.setWallRow);
  const setScreen = useApp((s) => s.setScreen);
  // The identity block and the stat block STACK in portrait and sit SIDE BY SIDE
  // in landscape. Not decoration: Sheet bounds its body to the viewport minus
  // the HUD, its own header and the navbar, which in the 311px-tall Seeker
  // webview leaves 223px — and a stacked head pushed UPGRADE, the one thing the
  // sheet exists to offer, below the fold there. Landscape has width to spare
  // and no height, which is the same trade the whole HUD makes when it turns.
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [min, setMin] = useState(false);
  // App S.train: the army tray replaces the action buttons once its toggle is
  // tapped, and resets on a new selection / nav / close (selSheet L617-619,
  // go() L152, select L453).
  const [tray, setTray] = useState(false);
  const trainingRequested = useApp((s) => s.trainingRequested);
  // Inline info (M23 a7): null = the default — OPEN for the Keep, whose sheet
  // is the base's progression dialog and must show what the next level
  // unlocks without a hunt (a19); closed for everything else.
  const [infoOpen, setInfoOpen] = useState(false);
  // SOL-gated upgrades (D-057: Mine → L5+, Gold Forge → L2+) are pay-per-action
  // on-chain — driven through the deposit flow rather than the direct shard
  // upgrade route. Every other step upgrades for shards alone.
  const { purchase: buyPaidUpgrade, phase: buyPhase, error: buyError } = useSolPurchase();
  const builderPayment = useBuilderJobSpeedupView();
  const heroPayment = useHeroProgressionView();
  // Cancelling a running upgrade asks first (tester request 2026-09-04).
  const { confirmCancel, cancelDialog } = useCancelJobConfirm();

  const b = base?.buildings.find((x) => x.id === id);
  const job = base?.jobs.find((j) => j.buildingId === id);
  const remSec = useCountdown(job?.finishesAt);
  const heroKey = b?.type === 'heroaltar' ? 'vex' : b?.type === 'siegestool' ? 'theodor' : null;
  const heroState = heroKey ? base?.heroes?.find((hero) => hero.hero === heroKey) : null;
  const heroRecoverySec = useCountdown(heroState?.recoveryUntil ?? undefined);
  // Reset min on a new selection AND on navigation (App resets S.shMin in
  // go() L152 and on selection L453); screen in deps covers nav-away-and-back.
  useEffect(() => { setErr(null); setMin(false); setTray(false); setInfoOpen(false); }, [id, screen]);
  useEffect(() => {
    if (trainingRequested && screen === 'base' && b?.type === 'barracks' && !job) {
      setTray(true);
      useApp.getState().consumeTrainingRequest();
    }
  }, [trainingRequested, screen, b?.type, job]);
  useEffect(() => { if (buyError) { playSfx('sfx_error'); setErr(buyError); } }, [buyError]);
  if (!base || !b) return null;
  if (phaseEBuildingHeld(b.type)) return <Sheet
    title={`${trayLabel(b.type)} · LEVEL ${b.level}`} min={min} onMin={() => setMin(!min)}
    art={<Sprite name={sheetPortrait(b.type, b.level)} w={40} h={40} />} onClose={() => select(null)}>
    <p>Available in the Android app for now.</p>
  </Sheet>;

  const repair = trapRepairDetails(
    b.type, b.level, (b as { trapSpentAt?: string | null }).trapSpentAt,
  );
  // REPAIR ALL TRAPS: the existing per-trap endpoint, posted one trap at a
  // time so the server prices and refuses each exactly as a single tap would.
  // The first refusal stops the run and the inline line says how far it got;
  // a partial run still moved shards, so the base reloads either way.
  const spentTraps = spentTrapRepairs(base.buildings);
  const repairAllCost = spentTraps.reduce((sum, t) => sum + t.costShards, 0);
  const repairAll = (): void => {
    setBusy(true); setErr(null);
    void (async () => {
      let done = 0;
      try {
        for (const t of spentTraps) {
          await api.post(`/base/buildings/${t.id}/repair`, withSelectedBase({}));
          done += 1;
        }
        playSfx('sfx_confirm'); haptic('light');
      } catch (e) {
        if (!isHandledGlobally(e as Error)) {
          playSfx('sfx_error'); setErr(`${done} OF ${spentTraps.length} TRAPS REPAIRED · ${(e as Error).message}`);
        }
      } finally {
        setBusy(false);
        await reloadBase();
      }
    })();
  };

  const run = (fn: () => Promise<unknown>): void => {
    setBusy(true);
    setErr(null);
    void fn()
      .then(() => { playSfx('sfx_confirm'); haptic('light'); return reloadBase(); })
      // UPGRADE on a land-gated building (goldforge) 402s LAND_NOT_OWNED from
      // inside a FREE route, and the global handler has already put the buy-land
      // sheet up — the inline red line and the error sound would be a second
      // refusal for the same tap.
      .catch((e: Error) => { if (isHandledGlobally(e)) return; playSfx('sfx_error'); setErr(e.message); })
      .finally(() => setBusy(false));
  };

  const upgradeCost = (UPGRADE_COSTS as Record<string, readonly number[]>)[b.type]?.[b.level - 1];
  // Walls upgrade INSTANTLY (owner 2026-07-20) — no timer, so no duration suffix.
  const upgradeTime = b.type === 'wall'
    ? undefined
    : (UPGRADE_TIMES_SEC as Record<string, readonly number[]>)[b.type]?.[b.level - 1];
  const unit = 'LEVEL';
  const trayMeta = TRAY_BUILDINGS[b.type];
  // Initial construction alone uses the server's separate free-finish verdict.
  // Paid jobs are reviewed using a fresh server quote by the shared wallet owner.
  const freeFinish = job?.kind === 'build' && job.finishCostKeep === '0';

  // D-057 (owner 2026-08-16): SOL charges on exactly the priced TARGET levels —
  // Mine upgrades to L5+ and Gold Forge upgrades to L2+. 0 means this step is
  // shards-only and takes the plain upgrade route; the server re-prices every
  // paid step, so this value only decides which button/label to show.
  const upgradeSol = upgradeSolLamports(b.type, b.level + 1);
  const anyBusy = busy || buyPhase !== 'idle';
  const paidUpgrade = (): void => {
    if (upgradeSol <= 0) return;
    void buyPaidUpgrade('mine', { // 'mine' = the wire kind for BOTH paid buildings
      buildingId: b.id,
      amountLamports: BigInt(upgradeSol),
      onDone: () => { playSfx('sfx_confirm'); haptic('light'); void reloadBase({ background: true }); },
    });
  };

  return (
    <Sheet
      title={`${trayLabel(b.type)} · ${unit} ${b.level}`}
      min={min}
      art={<Sprite name={sheetPortrait(b.type, b.level, heroState?.level)} w={40} h={40} />}
      onMin={() => setMin(!min)}
      onClose={() => select(null)}>
      {cancelDialog}
      {infoOpen && <div aria-label="Building statistics" style={{ marginBottom: 8 }}>
        <HudSheetHead art={<Sprite name={sheetPortrait(b.type, b.level, heroState?.level)} w={48} h={48} />}
          title={trayLabel(b.type)} level={b.level} max={maxLevelFor(b.type)} unit={unit} />
        {levelStats(b.type, b.level)}
      </div>}

      {heroState && (
        <div role="status" style={{
          marginBottom: 8, padding: '7px 9px',
          color: !heroState.available ? C.danger : C.success,
          background: C.ink, border: `1px solid ${!heroState.available ? C.danger : C.success}`,
          fontSize: 15, letterSpacing: '1px',
        }}>
          {!heroState.available
            ? `RECOVERING · ${heroRecoverySec > 0 ? fmtDur(heroRecoverySec).toUpperCase() : 'VERIFYING'} · CANNOT ATTACK OR DEFEND`
            : 'READY · ATTACK + DEFENCE'}
        </div>
      )}

      {/* The altar uses the same durable review as the roster. The client
          countdown is informational; only fresh server terms can authorize payment. */}
      {heroState && !heroState.available && heroKey && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '4px 0' }}>
          <span style={{ color: C.gold }}>⚕ RECOVERY</span>
          <Btn fontSize={16} disabled={busy || !heroPayment || !heroPayment.state.loaded || heroPayment.state.busy || !heroPayment.actionsEnabled}
            style={{ padding: '4px 10px 6px', minHeight: 44 }}
            onClick={() => {
              const baseId = useApp.getState().selectedBaseId;
              if (heroPayment?.state.journal?.operation) heroPayment.openHistory();
              else if (baseId) heroPayment?.begin({ kind: 'recovery', hero: heroKey, baseId });
            }}>
            REVIEW RECOVERY
          </Btn>
        </div>
      )}

      {job && (
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '4px 0' }}>
          <span style={{ color: C.gold }}>⚒ {job.kind.toUpperCase()} · {fmtDur(remSec)}</span>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0, maxWidth: '100%' }}>
            {/* CANCEL only where the server says the job is refundable
                (running shard-paid upgrade with a receipt): SOL-priced steps
                and pre-update jobs carry no control and finish normally. The
                quoted refund is the server's, never UPGRADE_COSTS. */}
            {job.canCancel && job.refundShards != null && (
              <Btn variant="ghost" fontSize={16} disabled={busy} style={{ padding: '4px 10px 6px' }}
                onClick={() => confirmCancel({
                  kind: 'UPGRADE',
                  what: `${trayLabel(b.type)} ${unit} ${b.level}→${b.level + 1}`,
                  refundShards: job.refundShards!,
                  onConfirm: () => run(() => api.post<{ refundShards: string }>(`/base/jobs/${job.id}/cancel`, withSelectedBase({}))
                    .then((r) => { bus.emit('ui:toast', { msg: `UPGRADE CANCELLED · +${fmtN(r.refundShards)} SHARDS` }); })),
                })}>
                ✕ CANCEL
              </Btn>
            )}
            <span data-onboarding-finish={b.type} style={{ minWidth: 0, maxWidth: '100%' }}>
            <Btn fontSize={16} disabled={busy || (!freeFinish && (job.kind === 'build' || !builderPayment?.actionsEnabled || !builderPayment.state.loaded || builderPayment.state.busy))} style={{ minHeight: 44, padding: '4px 10px 6px', maxWidth: '100%', whiteSpace: 'normal', flexWrap: 'wrap' }}
              onClick={() => freeFinish
                ? run(() => api.post(`/base/jobs/${job.id}/speedup`, withSelectedBase({})))
                : builderPayment?.begin({ jobId: job.id, baseId: base.baseId ?? null })}>
              {freeFinish ? 'FINISH NOW · FREE' : 'REVIEW FINISH PAYMENT'}
            </Btn>
            </span>
          </span>
          <div role="progressbar" aria-label="Building progress" aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={Math.round(Math.max(0, Math.min(100, 100 * (Date.now() - Date.parse(job.startedAt)) / Math.max(1, Date.parse(job.finishesAt) - Date.parse(job.startedAt)))))}
            style={{ flexBasis: '100%', height: 6, background: C.ink }}>
            <div style={{ height: '100%', background: C.gold, width: `${Math.max(0, Math.min(100, 100 * (Date.now() - Date.parse(job.startedAt)) / Math.max(1, Date.parse(job.finishesAt) - Date.parse(job.startedAt))))}%` }} />
          </div>
        </div>
      )}

      {/* App selSheet: when an army tray is open it REPLACES the action buttons
          (S.train body branch); a BACK button returns to the buttons. */}
      {trayMeta && tray ? (
        <>
          <Btn variant="ghost" fontSize={16} style={{ padding: '4px 12px 6px', marginBottom: 8 }} onClick={() => setTray(false)}>
            ← BACK
          </Btn>
          <Suspense fallback={null}>
            <trayMeta.Tray />
          </Suspense>
        </>
      ) : (
        <>
          {b.type === 'mine' && <MineCollect key={b.id} />}
          {phaseEWebEnabled() && b.type === 'workshop' && !b.underConstruction && <Suspense fallback={null}><WorkshopDoor discover /></Suspense>}
          {phaseEWebEnabled() && !b.underConstruction && <Suspense fallback={null}><PhaseEBuildingDoor buildingType={b.type} /></Suspense>}

          {/* The Gold Forge IS the shards→KEEP interface (owner 2026-07-24):
              tapping the building opens the forge dialog, like a real trainer. */}
          {b.type === 'goldforge' && (
            <Btn fontSize={18} style={{ width: '100%', marginBottom: 6 }}
              onClick={() => { playSfx('sfx_tap'); setScreen('forge'); }}>
              ⚒ SMELT SHARDS → KEEP
            </Btn>
          )}

          {/* M23 a17: clan warfare ships as a post-alpha major update; the
              building keeps upgrading normally, the social system is frozen. */}
          {b.type === 'clanhall' && (
            <div style={{
              border: `2px solid ${C.gold}`, background: C.card, padding: '8px 10px',
              marginBottom: 6, textAlign: 'center', color: C.goldHi, fontSize: 15,
            }}>
              CLAN WARFARE — COMING SOON
            </div>
          )}

          {/* A failed training purchase is flagged on the building itself, so
              the player learns before opening the tray (tester report
              2026-09-16: "no sign unless I check the Barracks"). */}
          {b.type === 'barracks' && hasUnresolvedTrainingPurchase(wallet) && (
            <Btn variant="sec" fontSize={16} style={{ width: '100%', marginBottom: 6, color: C.danger, borderColor: C.danger }}
              onClick={() => { playSfx('sfx_tap'); setTray(true); }}>
              TRAINING FAILED · OPEN TRAIN TROOPS TO RETRY
            </Btn>
          )}

          {trayMeta && (
            <span data-tutorial-target={b.type === 'barracks' ? 'train-troops' : undefined}>
            <Btn fontSize={18} style={{ width: '100%', marginBottom: 6 }} onClick={() => { playSfx('sfx_tap'); setTray(true); }}>
              {trayMeta.label}
            </Btn>
            </span>
          )}

          {/* #61: widen the selection to the whole wall run. Lives here rather than
              as a floating on-canvas chip — a 16px square over a 32px wall was
              unhittable, and the sheet is already where a selected piece's actions
              are. The scene marks the run by pulsing it; dragging any wall of a
              selected row then moves them all together. */}
          {b.type === 'wall' && (
            <Btn variant="sec" fontSize={18} style={{ width: '100%', marginBottom: 6 }}
              onClick={() => {
                playSfx('sfx_tap');
                const next = !wallRow;
                setWallRow(next);
                bus.emit('base:wallRow', { on: next });
              }}>
              {wallRow ? '◂ SELECT SINGLE WALL' : 'SELECT WHOLE ROW ▸'}
            </Btn>
          )}

          {/* THE PRIMARY ACTION of this sheet, on the same forged gold plate
              RAID wears in the navigation — so "the one thing this sheet is
              for" is the same object everywhere in the game, and it answers a
              press instead of merely changing colour. Every other button here
              stays an ordinary Btn and so cannot be mistaken for it. */}
          {repair && !job && (
            <HudPrimaryButton disabled={busy}
              onClick={() => run(() => api.post(`/base/buildings/${b.id}/repair`, withSelectedBase({})))}>
              REPAIR SPENT TRAP · <Icon name="shard" size={16} />{repair.costShards.toLocaleString()} · {fmtDur(repair.repairSec)}
            </HudPrimaryButton>
          )}
          {TRAP_TYPES.includes(b.type as (typeof TRAP_TYPES)[number]) && !job && (
            <Btn variant="sec" fontSize={16} style={{ width: '100%', marginTop: 6, minHeight: 48 }}
              disabled={busy || spentTraps.length === 0} onClick={repairAll}>
              REPAIR ALL TRAPS · {spentTraps.length}
              {spentTraps.length > 0 && <> · <Icon name="shard" size={14} />{fmtN(repairAllCost)}</>}
            </Btn>
          )}

          {b.type === 'wall' && wallRow && <WallRowUpgrade key={`${base.baseId ?? base.player.wallet}:${b.id}`} wallId={b.id} />}
          {upgradeCost !== undefined && !job && !repair && !(b.type === 'wall' && wallRow) && (
            upgradeSol > 0 ? (
              // SOL-gated step (D-057: Mine → L5+, Gold Forge → L2+): shards +
              // the table's SOL, paid on-chain through the deposit flow.
              <HudPrimaryButton disabled={anyBusy} onClick={paidUpgrade}>
                UPGRADE · <Icon name="shard" size={16} />{upgradeCost.toLocaleString()} + <Icon name="sol" size={16} />
                {(upgradeSol / 1e9).toFixed(2)}
                {upgradeTime ? ` · ${fmtDur(upgradeTime)}` : ''}
              </HudPrimaryButton>
            ) : (
              // Every un-priced step (incl. Mine L2–L4) is shards-only — no SOL shown.
              <HudPrimaryButton disabled={busy} onClick={() => run(() => api.post(`/base/buildings/${b.id}/upgrade`, withSelectedBase({})))}>
                {b.type === 'wall' && <Sprite name={sheetPortrait('wall', b.level + 1)} w={24} h={24} />}
                UPGRADE · <Icon name="shard" size={16} />{upgradeCost.toLocaleString()}{upgradeTime ? ` · ${fmtDur(upgradeTime)}` : ''}
              </HudPrimaryButton>
            )
          )}

          {/* M23 a7: INFO renders the building's own Codex prose in place —
              the old button dumped the player on the Codex's TROOPS tab. The
              Keep opens with it visible (a19: its next-level unlock list is
              the progression dialog's whole point). */}
          {infoOpen && (
            <Suspense fallback={<div style={{ color: C.textFaint, fontSize: 13, paddingTop: 6 }}>LOADING…</div>}>
              <BuildingInfo type={b.type} level={b.level} maxLevel={maxLevelFor(b.type)} />
            </Suspense>
          )}
          <Btn variant="ghost" fontSize={16} style={{ width: '100%', marginTop: 6, minHeight: 48 }} aria-expanded={infoOpen}
            onClick={() => setInfoOpen(!infoOpen)}>
            {infoOpen ? 'HIDE DETAILS' : 'DETAILS'}
          </Btn>
        </>
      )}

      {err && <div style={{ color: C.danger, paddingTop: 6 }}>{err}</div>}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Obstacle clear sheet
// ---------------------------------------------------------------------------

export function ObstacleSheet(): React.JSX.Element | null {
  const base = useApp((s) => s.base);
  const id = useApp((s) => s.selectedObstacleId);
  const screen = useApp((s) => s.screen);
  const selectObstacle = useApp((s) => s.selectObstacle);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [min, setMin] = useState(false);
  const builderPayment = useBuilderJobSpeedupView();

  const o = base?.obstacles.find((x) => x.id === id);
  // Tester report fca93288 (2026-09-17): re-selecting an obstacle while the
  // builder was clearing it showed the PRE-clearing sheet (cost, duration, a
  // second CLEAR). The running job in the server snapshot is the truth about
  // this obstacle; the sheet must read it before offering anything.
  const job = base?.jobs.find((j) => j.obstacleId === id);
  const remSec = useCountdown(job?.finishesAt);
  useEffect(() => { setErr(null); setMin(false); }, [id, screen]);
  if (!base || !o) return null;

  const tier = Object.values(OBSTACLES.tiers).find((t) => (t.kinds as readonly string[]).includes(o.spriteKey));
  const run = (fn: () => Promise<unknown>): void => {
    setBusy(true);
    void fn()
      .then(() => { playSfx('sfx_confirm'); haptic('light'); selectObstacle(null); return reloadBase(); })
      .catch((e: Error) => { playSfx('sfx_error'); setErr(e.message); })
      .finally(() => setBusy(false));
  };
  // Paid clearing uses the server's exact original-job quote. Initial construction
  // alone has a separate free finish; a zero/missing clearing quote cannot grant one.
  const progressPct = job
    ? Math.round(Math.max(0, Math.min(100, 100 * (Date.now() - Date.parse(job.startedAt)) / Math.max(1, Date.parse(job.finishesAt) - Date.parse(job.startedAt)))))
    : 0;

  return (
    <Sheet title={o.spriteKey.replace(/_/g, ' ').toUpperCase()} min={min} onMin={() => setMin(!min)} onClose={() => selectObstacle(null)}>
      {job ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '4px 0' }}>
          <span style={{ color: C.gold }}>⚒ CLEARING · {remSec > 0 ? fmtDur(remSec) : 'VERIFYING'}</span>
          {/* An elapsed timer has nothing left to sell: the snapshot auto-refetch
              lands the completion and this sheet closes with the obstacle. */}
          {remSec > 0 && (
            <Btn fontSize={16} disabled={busy || !builderPayment?.actionsEnabled || !builderPayment.state.loaded || builderPayment.state.busy} style={{ minHeight: 44, padding: '4px 10px 6px', maxWidth: '100%', whiteSpace: 'normal', flexWrap: 'wrap' }}
              onClick={() => builderPayment?.begin({ jobId: job.id, baseId: base.baseId ?? null })}>
              REVIEW FINISH PAYMENT
            </Btn>
          )}
          <div role="progressbar" aria-label="Clearing progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPct}
            style={{ flexBasis: '100%', height: 6, background: C.ink }}>
            <div style={{ height: '100%', background: C.gold, width: `${progressPct}%` }} />
          </div>
        </div>
      ) : (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '4px 0' }}>
        {/* Clearing costs SHARDS and rewards SHARDS (base.ts spendShards /
            rewardShards) — the old "KEEP" labels promised the wrong wallet, so a
            KEEP-rich, shard-poor player got an unexplained 422. (tier.costKeep is
            pre-split naming residue; the value is a shard price.) */}
        <span style={{ display: 'flex', gap: 4, alignItems: 'center', color: C.textDim }}>
          {tier ? (
            <>
              <Icon name="shard" size={16} />{tier.costKeep} · {fmtDur(tier.clearSec)} · +{OBSTACLES.clearRewardShards} <Icon name="shard" size={16} />
            </>
          ) : null}
        </span>
        <Btn fontSize={18} disabled={busy}
          onClick={() => run(() => api.post(`/base/obstacles/${o.id}/clear`, withSelectedBase({})))}>
          CLEAR
        </Btn>
      </div>
      )}
      {err && <div style={{ color: C.danger }}>{err}</div>}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Build tray + placement bar
// ---------------------------------------------------------------------------

export const BUILD_TRAY: Record<'def' | 'bld' | 'her', readonly string[]> = {
  // Epic defenses (electric/mage/laser/nest) are Keep-level gated server-side; the
  // BUILD panel shows them with their requiresKeepLevel badge (master plan §3D/§3G).
  def: ['cannon', 'archertower', 'mortar', 'airdefence', 'spiketrap', 'powdermine', 'pitfall', 'airmine', 'wall', 'electrictower', 'magetower', 'lasertower', 'dragonnest'],
  // goldforge: the shards→KEEP fusion building (owner 2026-07-24) — Keep L3 gate
  // + max 1 shown by the server caps; its level raises the daily forge cap.
  bld: ['mine', 'vault', 'barracks', 'forge', 'camp', 'clanhall', 'goldforge'],
  // HEROES: recruiting a hero = placing their altar. D-058 (owner 2026-08-16):
  // both gate at Keep L5 and the fee is KEEP (3,000 Vex / 10,000 Theodor) or a
  // consumed hero-contract item; max-1-each comes from the server caps.
  her: ['heroaltar', 'siegestool'],
};

export interface BuildCountPresentation {
  owned: number;
  max: number;
  /** Traps share one server cap even though every family keeps its own card. */
  familyOwned?: number;
  atCap: boolean;
}

/** Add only the server-discovered berth and only with the existing scene key's
 * shipped artwork. A future renderer/art admission remains a separate change. */
export function berthConstructionAvailable(base: { features?: { phaseEBuildings?: { version: number; enabledTypes: string[] } } } | null,
  artAvailable = Boolean(sprite(spriteFor('berth')))): boolean {
  const feature = base?.features?.phaseEBuildings;
  return phaseEWebEnabled() && feature?.version === 1 && Array.isArray(feature.enabledTypes) && feature.enabledTypes.includes('berth') && artAvailable;
}

function keepLevelValue(values: readonly number[], keepLevel: number): number {
  const index = Math.min(Math.max(Math.trunc(keepLevel), 1), values.length) - 1;
  return values[index] ?? values.at(-1) ?? 0;
}

/** The exact count contract enforced by apps/api/src/game/base.ts, expressed for
 * one build card. Existing under-construction rows count because the server's
 * cap query counts every building identity, not only completed jobs. */
export function buildCountPresentation(
  type: string,
  keepLevel: number,
  buildings: readonly { type: string }[],
  capacity?: unknown,
): BuildCountPresentation {
  const owned = buildings.filter((building) => building.type === type).length;
  if ((TRAP_TYPES as readonly string[]).includes(type)) {
    const familyOwned = buildings.filter((building) =>
      (TRAP_TYPES as readonly string[]).includes(building.type)).length;
    const max = keepLevelValue(CAPS.trapsByKeepLevel, keepLevel);
    return { owned, max, familyOwned, atCap: familyOwned >= max };
  }
  const max = type === 'mine'
    ? keepLevelValue(MINING.MAX_MINES_BY_KEEP, keepLevel)
    : (type === 'berth' ? advertisedBerthBuildCapacity(capacity) : undefined) ?? buildCountCapForKeep(type, keepLevel) ?? 0;
  return { owned, max, atCap: owned >= max };
}

/** Catalog and placement quote the same count-dependent price as placeBuilding. */
function buildPrice(type: string, owned: number): { amount: number; currency: 'KEEP' | 'SHARDS' } {
  const hero = type === 'heroaltar' ? 'vex' : type === 'siegestool' ? 'theodor' : null;
  if (hero) return { amount: HEROES[hero].recruitCostKeep, currency: 'KEEP' };
  if (type === 'mine') return {
    amount: MINING.MINE_BUILD_KEEP[Math.min(owned, MINING.MINE_BUILD_KEEP.length - 1)] ?? 0,
    currency: owned > 0 ? 'KEEP' : 'SHARDS',
  };
  return { amount: (BUILD_COSTS as Record<string, { costShards: number }>)[type]?.costShards ?? 0, currency: 'SHARDS' };
}

/**
 * Buildings the SERVER refuses to place for a landless player, mirroring
 * `LAND_GATED_BUILDINGS` in apps/api/src/game/base.ts. Kept as a set rather than a
 * `type === 'goldforge'` test so adding one is the same one-line change on both
 * sides — the api file says "if a future building mints or moves KEEP, add it here
 * in the same commit", and this is the other half of that commit.
 *
 * Why the client mirrors a server rule at all: POST /base/buildings is FREE, so the
 * refusal arrives as a 402 LAND_NOT_OWNED from inside the handler. That fires the
 * global buy-land sheet AND leaves the placement bar showing its own red inline
 * error with an error sound — one tap, two refusals. Not offering placement is
 * both cheaper and honest.
 */
const LAND_GATED_BUILDINGS: ReadonlySet<string> = new Set(['goldforge']);

export function BuildTray({ actionsEnabled = true }: { actionsEnabled?: boolean } = {}): React.JSX.Element | null {
  const requestCommand = useUserCommand(() => actionsEnabled);
  const requestRecovery = useUserCommand();
  const [infoType, setInfoType] = useState<string | null>(null);
  const screen = useApp((s) => s.screen);
  const base = useApp((s) => s.base);
  /** Server-confirmed land ownership (players.entryPaidAt via /me · /auth/verify). */
  const landOwned = useApp((s) => s.entryPaid);
  const placing = useApp((s) => s.placing);
  const setPlacing = useApp((s) => s.setPlacing);
  const setScreen = useApp((s) => s.setScreen);
  const tab = useApp((s) => s.buildCategory);
  const setTab = useApp((s) => s.setBuildCategory);
  const [placingBusy, setPlacingBusy] = useState(false);
  const [spot, setSpot] = useState<{ tx: number; ty: number; valid: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [min, setMin] = useState(false);
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const wallet = useApp((s) => s.wallet);
  const heroRecovery = useHeroRecruitmentRecovery(actionsEnabled);
  const balances = useApp((s) => s.balances);
  const heroPriceLabel = (amount: number): string => {
    try { return `${amount.toLocaleString()} ${chooseGameCurrency(String(amount), balances)}`; }
    catch { return 'REVIEW PRICE'; }
  };
  const heroPending = !!heroRecovery.state.journal?.intent && !heroRecovery.state.journal.finished;
  useEffect(() => {
    if (heroPending && ['heroaltar', 'siegestool'].includes(useApp.getState().placing ?? '')) { setPlacing(null); bus.emit('build:end', undefined); }
  }, [heroPending, setPlacing]);
  const [heroContracts, setHeroContracts] = useState<Record<string, number> | null>(null);
  // The selected-base catalog includes legacy wallet contracts consumed by the
  // same placement endpoint. Unknown stock keeps the honest price alternative.
  useEffect(() => {
    setHeroContracts(null);
    if (screen !== 'build' || (tab !== 'her' && placing !== 'heroaltar' && placing !== 'siegestool')) return;
    let cancelled = false;
    const scope = captureBaseSnapshotGuard();
    void api.get<{ catalog: Array<{ id: string; activation?: { kind: string; availableContracts?: number } }> }>(selectedBasePath('/items'))
      .then((items) => {
        if (!cancelled && isBaseSnapshotGuardCurrent(scope)) setHeroContracts(Object.fromEntries(
          items.catalog.filter((item) => item.activation?.kind === 'hero')
            .map((item) => [item.id, item.activation?.availableContracts ?? 0]),
        ));
      }).catch(() => { /* Keep the price-or-contract alternative when unavailable. */ });
    return () => { cancelled = true; };
  }, [screen, tab, placing, selectedBaseId, wallet]);
  const hasHeroContract = (hero: 'vex' | 'theodor'): boolean => (heroContracts?.[HEROES[hero].recruitItemId] ?? 0) > 0;
  const port = usePortrait();
  const win = useWindowSize();
  // The full label + three tabs + three tools measured wider than a 320px
  // viewport, leaving minimize/close completely off-screen. At the narrowest
  // supported width the tabs already identify this surface, so the redundant
  // BUILD label yields and the remaining chrome tightens without renaming a tab.
  const compactHeader = win.w < 360;

  useEffect(() => bus.on('build:spot', setSpot), []);
  useEffect(() => { setSpot(null); }, [placing, selectedBaseId, wallet]);
  // Wall SWIPE (#59): the scene emits the painted run on release → batch-place it in
  // ONE call (one charge), then exit build mode.
  useEffect(() => bus.on('build:paint', ({ tiles }) => {
    if (tiles.length === 0) return;
    void api.post('/base/buildings/batch', withSelectedBase({
      tiles, idempotencyKey: `wallbatch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }))
      .then(() => {
        playSfx('sfx_wall_clink'); haptic('light');
        setPlacing(null); bus.emit('build:end', undefined); setErr(null); return reloadBase();
      })
      .catch((e: Error) => { playSfx('sfx_error'); setErr(e.message); });
  }), []);
  // App go() resets S.shMin on every nav — reset the tray's min on screen change.
  useEffect(() => { setMin(false); setInfoType(null); }, [screen, tab, selectedBaseId, wallet]);
  if (screen !== 'build') return heroPending && heroRecovery.controller && ['base', 'bases', 'inventory'].includes(screen)
    ? <div className="interactive" style={{ position: 'absolute', left: 12, bottom: 90, zIndex: 1100 }}>
      <Btn onClick={() => requestRecovery(() => { setTab('her'); setScreen('build'); })}>REVIEW HERO PLACEMENT</Btn></div> : null;
  if (heroRecovery.controller && (heroPending && tab === 'her' || heroRecovery.state.review)) return (
    <Panel9 className="interactive" style={{ position: 'absolute', left: 0, right: port ? 0 : CHROME.rail, bottom: 0,
      maxHeight: `calc(100% - ${hudHeight(port)}px)`, overflowY: 'auto', zIndex: 1100 }}>
      <HeroRecruitmentPanel controller={heroRecovery.controller} state={heroRecovery.state} actionsEnabled={actionsEnabled} />
      {!heroRecovery.state.review && actionsEnabled && <Btn variant="ghost" disabled={heroRecovery.state.busy} onClick={() => setTab('bld')}>BUILD OTHER STRUCTURES</Btn>}
      <Btn variant="ghost" onClick={() => setScreen('base')}>CLOSE</Btn>
    </Panel9>
  );
  if (!actionsEnabled) return null;

  // Count every server-owned identity, including under-construction rows. The
  // API uses the same population when enforcing placement caps.
  const owned = (type: string): number => (base?.buildings.filter((b) => b.type === type).length ?? 0);

  // The catalog floats above the same primary action cluster in both
  // orientations. No landscape navigation rail consumes scene width.
  const bottomAnchor = {
    left: `calc(${CHROME.clusterPad}px + env(safe-area-inset-left))`,
    right: `calc(${CHROME.clusterPad}px + env(safe-area-inset-right))`,
    bottom: `calc(${CHROME.navBar + CHROME.clusterPad}px + env(safe-area-inset-bottom))`,
  } as const;
  const trayToolStyle = {
    width: 48, height: 48, flex: '0 0 48px', padding: 0, border: 0,
    background: 'transparent', color: C.textDim, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
  } as const;

  const keepLevel = base?.player.keepLevel ?? 1;

  if (placing) {
    // Mines use PROGRESSIVE pricing by count — and since D-057 (owner
    // 2026-08-16: "we should not gate miners with sol at start") NO mine build
    // costs SOL: every mine, 1st or 8th, places through the same instant POST.
    // The 1st mine charges SHARDS; mines 2+ charge the progressive price in
    // KEEP (server truth: game/base.ts placeBuilding), so the label switches
    // icon to match the wallet actually debited. Every other building keeps
    // its flat shard cost.
    // D-058: hero altars are KEEP-priced recruits (or consume an owned hero
    // contract — the server prefers the prepaid item automatically).
    const placingHero = placing === 'heroaltar' ? ('vex' as const)
      : placing === 'siegestool' ? ('theodor' as const) : null;
    const price = buildPrice(placing, owned(placing));
    const berthUnavailable = placing === 'berth' && (!berthConstructionAvailable(base)
      || buildCountPresentation(placing, keepLevel, base?.buildings ?? [], base?.constructionCapacity).atCap);
    const doPlace = (): void => {
      if (!spot?.valid || placingBusy || (placing !== 'wall' && base?.freeBuilders === 0)) return;
      const currentBase = useApp.getState().base;
      if (placing === 'berth' && (!berthConstructionAvailable(currentBase)
        || buildCountPresentation(placing, currentBase?.player.keepLevel ?? 1, currentBase?.buildings ?? [], currentBase?.constructionCapacity).atCap)) return;
      if (placingHero) {
        if (heroRecovery.controller) void heroRecovery.controller.review({ baseId: selectedBaseId,
          type: placing as 'heroaltar' | 'siegestool', tx: spot.tx, ty: spot.ty });
        return;
      }
      const scope = captureBaseSnapshotGuard();
      setPlacingBusy(true);
      void api.post('/base/buildings', withSelectedBase({ type: placing, tx: spot.tx, ty: spot.ty }))
        .then(async () => {
          if (!isBaseSnapshotGuardCurrent(scope)) return;
          playSfx(placing === 'wall' ? 'sfx_wall_clink' : 'sfx_place_thump');
          haptic('light');
          // The server accepted placement. Retire its purchase control even if
          // the following snapshot read fails, then use normal hydration retry.
          setPlacing(null); bus.emit('build:end', undefined); setErr(null); setScreen('base');
          try {
            await reloadBase();
          } catch (e) {
            if (!isBaseSnapshotGuardCurrent(scope) || isHandledGlobally(e)) return;
            bus.emit('ui:toast', { msg: 'BUILD ACCEPTED — RECONNECTING TO YOUR BASE' });
            if (useApp.getState().screen === 'base') setScreen('loading');
          }
        })
        // The NEEDS LAND card above means this branch should be unreachable for a
        // land-gated type; kept so a drift between the two sets degrades to ONE
        // refusal (the sheet) rather than two.
        .catch((e: Error) => {
          if (!isBaseSnapshotGuardCurrent(scope) || isHandledGlobally(e)) return;
          playSfx('sfx_error'); setErr(e.message);
        })
        .finally(() => setPlacingBusy(false));
    };
    return (
      <div className="interactive" style={{ position: 'absolute', ...bottomAnchor, zIndex: 1100, display: 'flex', flexWrap: 'wrap', gap: 10, padding: 12, paddingBottom: 'calc(12px + env(safe-area-inset-bottom))', justifyContent: 'center', alignItems: 'center', background: 'linear-gradient(transparent, rgba(16,14,20,.95) 45%)' }}>
        <Btn variant="sec" disabled={placingBusy} onClick={() => requestCommand(() => { setPlacing(null); bus.emit('build:end', undefined); })}>✕ CANCEL</Btn>
        <span data-build-price style={{ color: C.goldHi, display: 'flex', gap: 4, alignItems: 'center' }}>
          {placingHero && hasHeroContract(placingHero)
            ? <span>USES 1 HERO CONTRACT · NO GEMS OR KEEP</span>
            : placingHero ? <span>{heroPriceLabel(price.amount)} OR 1 HERO CONTRACT</span> : <><Icon name={price.currency === 'KEEP' ? 'keep' : 'shard'} size={18} />{price.amount.toLocaleString()} {price.currency}
              {placingHero && <span style={{ fontSize: 13, color: C.textDim }}>OR 1 HERO CONTRACT</span>}</>}
        </span>
        <span data-tutorial-target="place-building" aria-busy={placingBusy || !!placingHero && heroRecovery.state.busy} style={{ display: 'inline-flex' }}>
          <Btn disabled={!spot?.valid || placingBusy || berthUnavailable || (placingHero && (!heroRecovery.controller || heroRecovery.state.busy)) || (placing !== 'wall' && base?.freeBuilders === 0)} onClick={doPlace}>{placingBusy ? 'PLACING…' : placingHero && heroRecovery.state.busy ? 'CHECKING…' : placingHero ? 'REVIEW PLACEMENT' : '✓ PLACE'}</Btn>
        </span>
        {berthUnavailable && <span role="status" style={{ color: C.goldHi }}>{phaseEWebEnabled() ? 'THIS BERTH CANNOT BE STARTED — CHECK YOUR CURRENT BUILD CAPACITY AND AVAILABLE GAME CONTENT' : 'Available in the Android app for now.'}</span>}
        {placing !== 'wall' && base?.freeBuilders === 0 && <span role="status" style={{ color: C.goldHi }}>YOUR BUILDER IS BUSY — OPEN THE ACTIVE JOB ABOVE</span>}
        {placingHero && heroRecovery.state.error && <span role="alert" style={{ color: C.danger, flexBasis: '100%', textAlign: 'center' }}>{heroRecovery.state.error}</span>}
        {err && <span role="alert" style={{ color: C.danger, flexBasis: '100%', textAlign: 'center' }}>{err}</span>}
      </div>
    );
  }

  // App build sheet (L806): .sheet.panel9 at z 1100 (above the action sheet's
  // 1050) with a .phead header. Left: BUILD + the two tabs. Right cluster:
  // layout icon, minimize, then a ✕ CLOSE that exits build mode back to the base
  // (owner 2026-07-19 — the App relied on the top HUD to leave build, but with
  // the minimized panel pinned over the navbar that left no obvious way out).
  // `interactive` on the whole Panel9 so taps anywhere on the panel are captured
  // and never fall through to the Phaser canvas (fixes mis-selecting buildings
  // underneath when tapping near a tray button).
  return (
    <Panel9 className="interactive" style={{ position: 'absolute', ...bottomAnchor, paddingBottom: 'env(safe-area-inset-bottom)', zIndex: 1100,
      maxHeight: `calc(100% - ${hudHeight(port) + CHROME.navBar + CHROME.clusterPad}px - env(safe-area-inset-top) - env(safe-area-inset-bottom))`, overflowY: 'auto' }}>
      {tab === 'her' && heroRecovery.state.journal?.refusal && <p role="status" style={{ padding: '0 12px', color: C.textDim }}>
        THE ORIGINAL HERO PLACEMENT WAS REFUSED. NOTHING WAS SPENT. CHOOSE A NEW PLACEMENT TO REVIEW CURRENT BALANCES.
      </p>}
      <div className="interactive" data-build-tray-header data-compact={compactHeader ? '1' : '0'}
        aria-label="Build catalog"
        style={{ position: 'sticky', top: 0, zIndex: 1, background: C.ink, borderBottom: `2px solid ${C.borderLt}`, padding: compactHeader ? '5px 6px' : '5px 12px', fontSize: 18, letterSpacing: '2px', color: C.gold, display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'space-between', alignItems: 'center' }}>
        <span data-build-tray-tabs style={{ display: 'flex', gap: compactHeader ? 4 : 8, alignItems: 'center' }}>
          {!compactHeader && 'BUILD'}
          {(['def', 'bld', 'her'] as const).map((c) => (
            <span key={c} {...(c === 'bld' ? { 'data-tutorial-target': 'buildings-tab' } : {})}
              style={{ display: 'inline-flex' }}>
              <Btn variant={tab === c ? 'gold' : 'ghost'} fontSize={compactHeader ? 13 : 14}
                style={{ padding: compactHeader ? '3px 5px 5px' : '3px 10px 5px' }} onClick={() => setTab(c)}>
                {c === 'def' ? 'DEFENSES' : c === 'bld' ? 'BUILDINGS' : 'HEROES'}
              </Btn>
            </span>
          ))}
        </span>
        <span data-build-tray-tools style={{ display: 'flex', flex: 'none', marginLeft: 'auto', gap: compactHeader ? 6 : 10, alignItems: 'center' }}>
          <button type="button" className="interactive" aria-label="Base layout" onClick={() => requestCommand(() => setScreen('layout'))} style={trayToolStyle}>
            <Icon name="layout" size={20} />
          </button>
          <button type="button" className="interactive" aria-label={min ? 'Expand build tray' : 'Minimise build tray'}
            aria-expanded={!min} onClick={() => setMin(!min)} style={trayToolStyle}>{min ? '▴' : '▾'}</button>
          <button type="button" className="interactive" aria-label="Close build tray" onClick={() => requestCommand(() => { playSfx('sfx_tap'); setScreen('base'); })} style={trayToolStyle}>
            <Icon name="close" size={20} />
          </button>
        </span>
      </div>
      {heroPending && <Btn variant="ghost" onClick={() => setTab('her')}>REVIEW ORIGINAL HERO PLACEMENT</Btn>}
      {!min && (
        <div className="interactive" style={{ display: 'flex', gap: 6, padding: '8px 10px 12px', overflowX: 'auto' }}>
          {(tab === 'bld' && berthConstructionAvailable(base) ? [...BUILD_TRAY[tab], 'berth'] : BUILD_TRAY[tab]).map((type) => {
            const meta = (BUILD_COSTS as Record<string, { costShards: number; requiresKeepLevel?: number }>)[type];
            // D-058: altar cards advertise the KEEP recruit fee, not shards.
            const cardHero = type === 'heroaltar' ? ('vex' as const)
              : type === 'siegestool' ? ('theodor' as const) : null;
            const price = buildPrice(type, owned(type));
            const locked = meta?.requiresKeepLevel !== undefined && keepLevel < meta.requiresKeepLevel;
            const count = buildCountPresentation(type, keepLevel, base?.buildings ?? [], base?.constructionCapacity);
            const isTrap = (TRAP_TYPES as readonly string[]).includes(type);
            const capReached = count.atCap;
            // Only when the KEEP gate is already clear: at Keep L1 the level is the
            // nearer wall and KEEP L3 is the more useful thing to say, so this never
            // overwrites it.
            const needsLand = !locked && !capReached && !landOwned
              && LAND_GATED_BUILDINGS.has(type);
            const countText = isTrap
              ? `OWNED ${count.owned} · TRAPS ${count.familyOwned ?? 0} / ${count.max}`
              : `OWNED ${count.owned} / MAX ${count.max}`;
            const countAria = isTrap
              ? `${count.owned} owned; ${count.familyOwned ?? 0} of ${count.max} total traps`
              : `${count.owned} of ${count.max} owned`;
            return (
              // `data-build-type` is the first-run coach mark's anchor for the
              // three structures the onboarding chain names (ui/tutorial/
              // guideCues.ts). A data hook, not an aria-label: the card's
              // accessible name has to keep carrying the live owned-count and
              // the cost that the sighted player reads off it.
              <div key={type} style={{ flex: 'none', width: 96, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <button data-build-type={type} className="interactive"
                aria-label={`${trayLabel(type)}, ${countAria}, ${cardHero && hasHeroContract(cardHero) ? '1 hero contract, no Gems or KEEP' : cardHero ? heroPriceLabel(price.amount) : `${price.amount.toLocaleString()} ${price.currency}`}`}
                disabled={locked || capReached}
                onClick={() => {
                  requestCommand(() => {
                    const current = useApp.getState();
                    playSfx('sfx_tap');
                    if (!current.entryPaid && LAND_GATED_BUILDINGS.has(type)) { current.setLandPrompt('browse'); return; }
                    current.setPlacing(type); bus.emit('build:start', { type });
                  }, () => {
                    const current = useApp.getState();
                    const level = current.base?.player.keepLevel ?? 1;
                    return !(meta?.requiresKeepLevel !== undefined && level < meta.requiresKeepLevel)
                      && !buildCountPresentation(type, level, current.base?.buildings ?? [], current.base?.constructionCapacity).atCap
                      && (type !== 'berth' || berthConstructionAvailable(current.base));
                  });
                }}
                style={{ flex: 'none', width: 96, background: C.card, border: `2px solid ${needsLand ? C.goldDp : C.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '6px 4px', cursor: locked || capReached ? 'default' : 'pointer', opacity: locked || capReached ? 0.5 : 1 }}>
                <Sprite name={spriteFor(type)} w={44} h={44} />
                <span style={{ fontSize: 14, color: C.textDim }}>{trayLabel(type)}</span>
                <span data-build-count style={{ fontSize: 12, color: C.textFaint }}>{countText}</span>
                {locked
                  ? <span style={{ fontSize: 11, color: C.danger }}>KEEP L{meta?.requiresKeepLevel}</span>
                  : capReached
                    ? <span style={{ fontSize: 11, color: C.danger }}>MAX</span>
                  : needsLand
                    ? <span style={{ fontSize: 11, color: C.goldHi }}>NEEDS LAND</span>
                    : (
                    <span data-build-price style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 3, alignItems: 'center', fontSize: 14, color: C.goldHi }}>
                      {cardHero && hasHeroContract(cardHero)
                        ? <span style={{ fontSize: 11 }}>1 CONTRACT · NO GEMS OR KEEP</span>
                        : cardHero ? <span>{heroPriceLabel(price.amount)}</span> : <><Icon name={price.currency === 'KEEP' ? 'keep' : 'shard'} size={14} />{price.amount.toLocaleString()} <span style={{ fontSize: 11 }}>{price.currency}</span></>}
                    </span>
                  )}
              </button>
              <button type="button" className="interactive" aria-label={`Info about ${trayLabel(type)}`}
                aria-expanded={infoType === type} style={{ minHeight: 48, width: '100%', fontSize: 13,
                  background: C.card, color: C.textDim, border: `2px solid ${C.border}`, cursor: 'pointer' }}
                onClick={() => setInfoType(infoType === type ? null : type)}>INFO</button>
              </div>
            );
          })}
        </div>
      )}
      {!min && infoType && (
        <div className="interactive" role="region" aria-label={`${trayLabel(infoType)} building information`}
          style={{ padding: '0 12px 12px', maxHeight: '30vh', overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span style={{ color: C.gold }}>{trayLabel(infoType)} · LEVEL 1</span>
            <Btn variant="ghost" fontSize={13} style={{ minHeight: 48 }} onClick={() => setInfoType(null)}>CLOSE INFO</Btn>
          </div>
          {levelStats(infoType, 1, false)}
          <Suspense fallback={<div>LOADING BUILDING INFO…</div>}>
            <BuildingInfo type={infoType} level={1} maxLevel={maxLevelFor(infoType)} />
          </Suspense>
        </div>
      )}
      {/* HEROES tab (D-Q1): the cards above RECRUIT a hero (place the altar);
          the roster below LEVELS the ones already recruited. Same panel, because
          "where do I upgrade Vex" has exactly one answer — the tab named after
          him. Scrolls on its own so a 2-hero roster never pushes the tray off a
          short landscape viewport. */}
      {!min && tab === 'her' && (
        <div className="interactive" style={{ padding: '0 10px 12px', maxHeight: '38vh', overflowY: 'auto' }}>
          <Suspense fallback={null}><HeroTray /></Suspense>
        </div>
      )}
    </Panel9>
  );
}

/** Representative master sprite for a build-tray type. */
/** Tray display names where the raw type reads badly (heroes recruit PEOPLE —
 *  the card should say who, not the building's enum value). */
const TRAY_LABELS: Record<string, string> = {
  heroaltar: 'VEX · ALTAR',
  siegestool: 'THEODOR · STOOL',
  archertower: 'ARCHER TWR',
  electrictower: 'TESLA TWR',
  lasertower: 'LASER TWR',
  magetower: 'MAGE TWR',
  dragonnest: 'DRAGON NEST',
  airdefence: 'AIR DEFENCE',
  powdermine: 'POWDER MINE',
  airmine: 'AIR MINE',
  clanhall: 'CLAN HALL',
  forge: 'ALCHEMY LAB',
  goldforge: 'GOLD FORGE',
};
export function trayLabel(type: string): string {
  return TRAY_LABELS[type] ?? type.toUpperCase();
}

/**
 * The portrait for a building AT THE LEVEL IT IS, for the action sheet.
 *
 * spriteFor() is the BUILD TRAY's resolver and pins tier 1 on purpose — the tray
 * is placing a new building, which is always L1. The sheet is looking at one
 * that already exists, and the ware packs ship four tiers of every portrait, so
 * a level-16 mine must not be shown wearing its level-1 face. Cannon, Mortar,
 * Wall, and the two hero altars have separate approved tier families; only a
 * type with no tier portrait falls back to the build-tray preview.
 */
export function sheetPortrait(type: string, level: number, heroLevel?: number): string {
  if (type === 'heroaltar') return heroPortrait('vex', heroLevel);
  if (type === 'siegestool') return heroPortrait('theodor', heroLevel);
  const tier = artTierOfLevel(level);
  if (type === 'cannon' || type === 'mortar') return `ui_portrait_${type}_t${tier}`;
  if (type === 'wall') return `wall5_t${wallTierOfLevel(level)}_straight_intact_f1`;
  return type in WARE_PORTRAIT_ART
    ? warePortraitAliasKey(type as keyof typeof WARE_PORTRAIT_ART, tier)
    : spriteFor(type);
}

export function spriteFor(type: string): string {
  if (type === 'heroaltar') return heroPortrait('vex');
  if (type === 'siegestool') return heroPortrait('theodor');
  if (type in WARE_PORTRAIT_ART) {
    return warePortraitAliasKey(type as keyof typeof WARE_PORTRAIT_ART, 1);
  }
  const map: Record<string, string> = {
    // Rework-v2 cannon/mortar (Phase D): the t1 tier PORTRAIT, not the idle
    // atlas SVG — v2 masters are 8-row grid sheets, and an <img> of one shows
    // the whole grid. The portrait is the pack's single-cell UI art for
    // exactly this use.
    cannon: 'ui_portrait_cannon_t1', mortar: 'ui_portrait_mortar_t1',
    wall: 'wall5_t1_straight_intact_f1',
  };
  return map[type] ?? `bld_${type}_l1`;
}

// ---------------------------------------------------------------------------
// shared bits — minimizable bottom sheet (panel9)
// ---------------------------------------------------------------------------

function Sheet({
  title, onClose, onMin, min, children, art,
}: { art?: React.ReactNode; title: string; onClose: () => void; onMin: () => void; min: boolean; children: React.ReactNode }): React.JSX.Element {
  useMobileBackHandler(onClose, true, 220);
  const port = usePortrait();
  const win = useWindowSize();
  const chrome = hudTier(win.w, win.h);
  const maxWidth = chrome.rail ? Math.min(480, win.w - 232) : 480;
  const bottomReserve = chrome.rail ? CHROME.clusterPad : CHROME.navBar + CHROME.clusterPad;
  const topReserve = chrome.tier === 'compact' && !chrome.rail
    ? hudHeight(port) + CHROME.queueRow + CHROME.clusterPad
    : CHROME.clusterPad;
  // Let the real wrapped header take its measured flex height. A fixed header
  // subtraction clips long names and larger text; only the body may scroll.
  const sheetMax = `calc(var(--game-viewport-height, 100dvh) - ${topReserve + bottomReserve}px - env(safe-area-inset-top) - env(safe-area-inset-bottom))`;
  return (
    // `interactive` on the whole Panel9 so taps anywhere on the sheet are captured
    // and never fall through to select a building on the Phaser canvas beneath.
    <Panel9 className="interactive" style={{
      position: 'absolute',
      left: `calc(${CHROME.clusterPad}px + env(safe-area-inset-left))`, right: 'auto',
      width: `min(${maxWidth}px, calc(100vw - ${CHROME.clusterPad * 2}px - env(safe-area-inset-left) - env(safe-area-inset-right) - 0px))`,
      bottom: `calc(${bottomReserve}px + env(safe-area-inset-bottom))`,
      boxSizing: 'border-box', display: 'flex', flexDirection: 'column', maxHeight: sheetMax,
      zIndex: 1050,
    }}>
      <div className="interactive" style={{ flexShrink: 0, background: C.ink, borderBottom: `2px solid ${C.borderLt}`, padding: '6px 12px', fontSize: 18, letterSpacing: '2px', color: C.gold, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ flex: 'none' }}>{art}</span><span style={{ overflowWrap: 'break-word' }}>{title}</span></span>
        <span style={{ display: 'flex', flexShrink: 0, gap: 8, alignItems: 'center' }}>
          <MinBtn min={min} onToggle={onMin} />
          <button type="button" aria-label="Close sheet" className="interactive" onClick={onClose} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center', flexShrink: 0, width: 48, height: 48, border: 0, background: 'transparent', color: 'inherit' }}>
            <Icon name="close" size={20} />
          </button>
        </span>
      </div>
      {!min && (
        <div className="interactive" style={{
          padding: '10px 12px', minHeight: 0, overflowY: 'auto',
          // Momentum scrolling on iOS; contain so reaching the end never
          // scroll-chains into (and pans) the Phaser canvas underneath.
          WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain',
        }}>{children}</div>
      )}
    </Panel9>
  );
}
