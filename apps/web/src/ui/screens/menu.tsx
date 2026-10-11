import { phaseEWebEnabled } from '../phaseEWebHold';
import { GemsHeldBalance, GemsRecoveryDoor, GemsWalletScreen } from './gems';
import { gemsAvailable } from '../../lib/gems/contracts';
import { useForgeClaimRecovery } from '../../auth/useForgeClaimRecovery';
import { ForgeClaimRecoveryPanel } from './forgeClaimRecovery';
import { CandidateExpandScreen, candidateExpansionConfigured } from './candidateExpansion';
/**
 * Menu / modal screens that overlay the base scene (App parity): quests,
 * claim, profile, exchange, builders, layout, expand, raidlog, shop.
 * Copy is verbatim from the App (copy.ts); all NUMBERS shown come from
 * @shardkeep/shared or live server state, never hardcoded gameplay values.
 */
import {
  CLANS, CAPS, DAILY_CACHE, ECONOMY, HERO_KEYS, HEROES, ITEMS, MARKETPLACE, MINING,
  SHIELD, TWOFA, WARZONE, USERNAMES, warePortraitAliasKey, type ItemRarity,
} from '@shardkeep/shared';
import { useWallet } from '@solana/wallet-adapter-react';
import { useEffect, useRef, useState } from 'react';
import { api, idemKey, type TesterReferralsDto } from '../../lib/api';
import { baseLocationLabel, fantasyDirectory } from '../../lib/baseLocation';
import { fmtClock, fmtDur } from '../../lib/duration';
import { selectedBasePath, withSelectedBase } from '../../lib/baseSelection';
import { explorerUrl, KEEP_MINT, SOLANA_CLUSTER } from '../../lib/cluster';
import { APP_VERSION_LABEL, versionedPublicAsset } from '../../lib/version';
import { playSfx, setMusic, setSoundFx } from '../../lib/audio';
import { bus } from '../../lib/events';
import { keepConfirmOn, setKeepConfirm } from '../../lib/keepConfirm';
import { haptic } from '../../lib/juice';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { LAND_LOCKED } from '../../state/land';
import { LandLocked } from '../LandGate';
import { useTesterMe } from '../testerDaily';
import { failToast } from '../actionError';
import { useSolPurchase } from '../../auth/useSolPurchase';
import { useKeepDeposit } from '../../auth/useKeepDeposit';
import {
  addKeepDepositAmount, formatWholeKeep, MAX_KEEP_DEPOSIT,
  normalizeKeepDepositInput, parseKeepDepositAmount,
} from '../../auth/keepDepositAmount';
import { useMarketBuy } from '../../auth/useMarketBuy';
import { useMarketRecovery } from '../../auth/useMarketRecovery';
import { marketBrowserLock, supportsMarketV1 } from '../../lib/market/controller';
import { marketSolAmount } from '../../lib/market/browser';
import { MarketConsentPanel, MarketRecoveryPanel, type MarketReview } from './marketRecovery';
import { MarketPurchases } from './marketPurchases';
import { ReferralEntry } from './referralRecovery';
import { ClanRecoveryPanel } from './clanRecovery';
import { useClanRecovery } from '../../auth/useClanRecovery';
import type { ClanController, ClanState } from '../../lib/clans/controller';
import { useSignOut } from '../../auth/useSignOut';
import {
  useRecentAuth, type WithdrawalRecentAuthIntent, type WithdrawalWalletProof,
} from '../../auth/useRecentAuth';
import { isPrivyMfaNotEnrolled, useFreshPrivyMfa } from '../../auth/useFreshPrivyMfa';
import { supportMailto, supportSubject } from '../../lib/support';
import { SupportLinks } from '../SupportLinks';
import { ExportKeySection, RecoveryWalletMfa, PRIVY_ENABLED } from './exportKey';
import { PlayerName, SeekerBadge, SeekerDoor } from './seeker';
import { fmtBalance, WalletTab, type WalletBalancesDto } from './wallet';
import { useKeepSpendConfirm } from '../KeepSpendConfirm';
import {
  isSolanaMobileClient, landscapePref, notificationsGranted, pushOptedIn, setLandscapePref,
} from '../../lib/mobileShell';
import {
  disablePush, enablePush, pushNotificationsSupported, suspendPushSession,
} from '../../lib/pushSubscription';
import { perfDiagEnabled, setPerfDiagEnabled } from '../../lib/perfDiagFlag';
import { EVENTS, track } from '../../lib/analytics';
import { ShopCatalogView, type ShopItemKind, type ShopItemsDto } from './shopCatalog';
import type { SeekerStatus } from '../../auth/useSeekerLink';
import { reloadBase } from '../sheets';
import { SHOP_TOKENS } from '../copy';
import { itemArtUrl } from '../itemArt';
import { troopPortrait } from '../icons';
import { useFetch } from '../useFetch';
import { LayoutEditor } from '../layoutEditor/LayoutEditor';
// TYPE-ONLY, and it has to stay that way: TutorialHost is on the eager
// first-paint path and this whole settings module is a lazy chunk.
import type { TutorialStateDto } from '../tutorial/TutorialHost';
import './forge.css';
import {
  BarMini, Btn, Card, Chip, COLORS as C, fmtN, Icon, ModalWrap, Phead, Pill, PillVal,
  ScrollPage, Sp, Sprite, Switch,
} from '../primitives';

const toast = (msg: string): void => bus.emit('ui:toast', { msg });
const home = (): void => useApp.getState().setScreen('base');
const closeWalletMenu = (): void => {
  const state = useApp.getState();
  state.setScreen(state.walletMenuReturnScreen);
};

function WalletMenuBack(): React.JSX.Element {
  const parent = useApp((state) => state.walletMenuReturnScreen);
  return <Btn variant="ghost" onClick={closeWalletMenu} fontSize={16}
    style={{ minHeight: 44, marginBottom: 10 }}>← BACK TO {parent === 'exchange' ? 'KEEP WALLET' : 'BASE'}</Btn>;
}

/**
 * THE FOUR LOCKED SCREENS (free onboarding, security review F10 2026-08-09).
 *
 * Forge, KEEP wallet, withdraw and clans are `owned` on the server, top to
 * bottom. A deedless player can still REACH them — the shard pill opens the
 * Forge, the KEEP pill opens the wallet, PROFILE lists CLANS — and hiding the
 * buttons would leave a player who has never seen the game unable to find out
 * what land buys. So each one renders its locked STATE instead of firing requests
 * the server will refuse: no request, no 402, no sheet-plus-toast double refusal.
 *
 * `entryPaid` is the store's server-confirmed land fact (players.entryPaidAt via
 * /me · /auth/verify — see state/land.ts). With FREE_ONBOARDING off a deedless
 * wallet never gets past the blocking ENTRY screen, so these branches are
 * unreachable and the flag-off behaviour is byte-identical.
 */
const useLandOwned = (): boolean => useApp((s) => s.entryPaid);

/** BUY YOUR LAND, from a locked screen. The ENTRY screen is the only place that
 *  can take the payment — Overlay's LandGateHost routes there for the same reason,
 *  so the pay/claim/deposit logic keeps exactly one home. */
const buyLand = (): void => {
  const s = useApp.getState();
  s.setLandPrompt(null);
  s.setLandPurchase({ kind: 'entry', earthCell: null });
  s.setScreen('entry');
};

/** Open the buy-land sheet from a control that would otherwise 402. Used where a
 *  single BUTTON is gated inside an otherwise-free screen (market BUY/SELL). */
const askLand = (): void => useApp.getState().setLandPrompt('browse');

/** player_sol_credit is stored in lamports (1 SOL = 1e9). Render the linked
 *  wallet's SOL balance with 2 decimals, matching the App's '1.24' shop pill. */
function fmtSol(lamports: string | undefined): string {
  return (Number(lamports ?? 0) / 1e9).toFixed(2);
}

// QUESTS moved to screens/quests.tsx (2026-08-28, quest-onboarding lane). The
// board is now its own screen — a forged full-screen shell with the first-run
// chain pinned above the weekly and the dailies — and it was the last thing in
// this file that was not a menu/profile/shop surface.

// ===========================================================================
// DAILY CLAIM — POST /mine/claim, D1-D7 streak track
// ===========================================================================

/** GET /mine/status (emission.ts getMineStatus) — two SEPARATE systems:
 *  `mining` is the fixed-quota Mine buffer settled via COLLECT (Mine sheet),
 *  `cache` is the daily streak-ladder reward CLAIMed here (ECONOMY.md §2/§3). */
export interface MineStatusDto {
  mining: { quotaPerDay: number; accrued: number; storageCap: number; ratePerHour: number; mineCount: number; maxMines: number };
  cache: { streakDays: number; currentDay: number; cacheShards: number; claimable: boolean; nextClaimAt: string };
}

/** mm:ss:… countdown to an ISO target, re-rendered each second. */
function useCountdownTo(targetIso: string | undefined): string {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!targetIso) return '--:--:--';
  const ms = Math.max(0, new Date(targetIso).getTime() - Date.now());
  return fmtClock(Math.floor(ms / 1000));
}

/**
 * Countdown seeded from a SERVER-supplied remaining-seconds value and ticked
 * locally — unlike useCountdownTo it never reads the device clock, so a skewed
 * phone cannot mis-render the Gold Forge cycle boundary. Re-seeds whenever the
 * server value changes (every reload).
 */
function useCountdownFrom(sec: number | undefined): { text: string; done: boolean; left: number } {
  const [left, setLeft] = useState(sec ?? 0);
  useEffect(() => { setLeft(sec ?? 0); }, [sec]);
  useEffect(() => {
    const t = setInterval(() => setLeft((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, []);
  if (sec === undefined) return { text: '--:--:--', done: false, left: 0 };
  return { text: fmtClock(left), done: left <= 0, left };
}

export function ClaimScreen(): React.JSX.Element {
  const selectedBaseId = useApp((state) => state.selectedBaseId);
  const [busy, setBusy] = useState(false);
  // Server-authoritative daily-cache state (GET /mine/status → cache). The cache
  // is the streak-ladder reward (ECONOMY.md §3), SEPARATE from mining — mining
  // is COLLECTed at the Mine sheet, never here. Replaces the App's faked values.
  const { data: status, reload } = useFetch<MineStatusDto>(
    () => api.get<MineStatusDto>(selectedBasePath('/mine/status')),
    [selectedBaseId],
  );
  const cache = status?.cache;
  const countdown = useCountdownTo(cache?.nextClaimAt);
  const D = DAILY_CACHE.consistencyStreakDays; // 7-day cache track (ECONOMY.md §3)

  const claim = (): void => {
    setBusy(true);
    void api.post<{ amount?: string }>('/mine/claim', withSelectedBase({}))
      .then((r) => {
        // §3.10/§3.11 daily claim: the signature gold chime + coin shower + light haptic.
        playSfx('sfx_claim_chime');
        playSfx('sfx_coin_shower', { volume: 0.8 });
        haptic('light');
        // The daily cache credits the selected deed's SHARDS.
        toast(r.amount ? `+${fmtN(r.amount)} SHARDS CLAIMED` : 'CLAIMED');
        return reloadBase();
      })
      .catch((e: Error) => failToast(e, e.message))
      .finally(() => { setBusy(false); reload(); home(); });
  };

  const lit = cache?.currentDay ?? 0;
  const claimable = cache?.claimable ?? false;
  return (
    <ModalWrap onBackdrop={home}>
      <Phead title="DAILY SHARD CACHE" />
      <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0 4px' }}>
        <Sprite name={warePortraitAliasKey('vault', 1)} w={96} h={96} />
      </div>
      {/* Reward = today's cache payout (ECONOMY.md §3 streak ladder: 100→700 the
          first week, then 500/100 by consistency). Flat shards, server-computed —
          NOT the mining quota (that is COLLECTed at the Mine). */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 18, padding: '6px 0 2px', fontSize: 23 }}>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Icon name="shard" size={22} /><span style={{ color: C.goldHi }}>+{fmtN(cache?.cacheShards ?? 0)}</span>
        </span>
      </div>
      <div style={{ display: 'flex', gap: 5, justifyContent: 'center', padding: '10px 12px 2px' }}>
        {Array.from({ length: D }, (_, i) => i + 1).map((d) => (
          <Pill key={d} accent={d <= lit ? C.goldDp : undefined}
            style={{ fontSize: 15, color: d <= lit ? C.goldHi : C.stoneDark }}>D{d}</Pill>
        ))}
      </div>
      {/* ×1.4 mining bonus (CONSISTENCY_BPS/BPS_ONE), earned at a 7-day cache
          streak (ECONOMY.md §3 "day-7 mining bonus"). */}
      <div style={{ textAlign: 'center', color: C.textFaint, fontSize: 16, paddingTop: 2 }}>
        DAY {Math.max(1, lit)} OF {D} · ×{MINING.CONSISTENCY_BPS / MINING.BPS_ONE} BONUS AT D{D}
      </div>
      <div style={{ padding: '12px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Btn fontSize={23} disabled={busy || !claimable} onClick={claim}>
          {claimable ? 'CLAIM' : 'CLAIMED TODAY'}
        </Btn>
        <div style={{ textAlign: 'center', color: C.stoneDark, fontSize: 15 }}>NEXT CACHE {countdown}</div>
      </div>
    </ModalWrap>
  );
}

// ===========================================================================
// KEEP WALLET — the currency hub (deposit / withdraw / economy). KEEP can move
// one-way into non-withdrawable shards at 1:1; the reverse remains the daily,
// capped Gold Forge. The `screen` id stays 'exchange' for route compatibility.
// ===========================================================================

interface Balances { shards: string; keep: string; keepRate: number; withdrawFeeBps: number }

/** Gold Forge (owner rules): daily shards→KEEP conversion. The whole surface is
 *  driven by GET /forge — when the server runs FORGE_ENABLED=false (pre-split)
 *  the route doesn't exist, the probe 404s, and the entry chip stays hidden.
 *  Flip the env → the screen lights up with zero client changes. */
interface ForgeDto {
  day: string;
  /** SERVER-computed cycle clock. The countdown ticks from `cycleEndsInSec`,
   *  never from `cycleEndsAt` vs the device clock — a skewed phone would
   *  otherwise show a pour that already happened (or one hours away). */
  serverNow: string; cycleEndsAt: string; cycleEndsInSec: number;
  dailyEmissionKeep: number; softCapShards: number; maxDailyShareBps: number;
  totalShards: string; myShards: string; myShardBalance: string;
  /** Gold Forge BUILDING level (0 = none/under construction) + its daily cap
   *  (owner 2026-07-24: the building gates contributions). */
  goldforgeLevel: number; myDailyCapShards: string;
  /** Every positive deed/day position rolls each item independently. */
  drops: { independentDropBps: Record<string, number> };
  /** Everything settled and waiting in escrow — the WHOLE open window, not just
   *  yesterday (a today/yesterday view hides a payout for anyone away 3 days). */
  claimable: { count: number; totalKeep: string; days: string[]; nextExpiresAt: string | null };
  yesterday: { shards: string; keepPaid: string; shardsRefunded: string; itemDropped: string | null; itemsDropped?: string[]; status: ForgeRowStatus } | null;
}

/** Allocation row state (server-derived — apps/api/src/game/forge.ts). */
type ForgeRowStatus = 'open' | 'claimable' | 'claimed' | 'expired' | 'paid_legacy' | 'nothing';

/** GET /forge/allocations — the caller's OWN history, keyset on day DESC. */

interface ForgeAllocationsDto {
  days: Array<{
    day: string; shards: string; counted: string; keepPaid: string; shardsRefunded: string;
    itemDropped: string | null; itemsDropped?: string[]; settledAt: string | null; status: ForgeRowStatus;
    claimedAt: string | null; expiresAt: string | null;
  }>;
  nextBefore: string | null;
  totals: { keepClaimed: string; keepClaimable: string; keepExpired: string; shardsBurned: string; itemsWon: number };
}

/** GET /forge/global — one SETTLED cycle, public. Wallets arrive ALREADY
 *  abbreviated (server-side): the full address never reaches the client. */
interface ForgeGlobalDto {
  day: string | null; settled: boolean;
  totalShards: string; distributedKeep: string; contributors: number;
  rows: Array<{ rank: number; walletShort: string; name: string; seeker: boolean; shards: string; keepPaid: string }>;
  nextCursor: string | null;
  me: { rank: number; walletShort: string; name: string; seeker: boolean; shards: string; keepPaid: string } | null;
  days: string[];
}

/** GET /forge/drops/recent — PUBLIC relics won (tester 69arc, report
 *  0d1b6d9d): who won which relic in which cycle, newest settlement first.
 *  Winners arrive already abbreviated; the row carries no base id or claim
 *  state. `name`/`rarity` come from the server catalog; art resolves locally. */
interface ForgeRecentDropsDto {
  drops: Array<{
    day: string; settledAt: string; itemId: string; name: string; rarity: ItemRarity | null;
    winner: { name: string; walletShort: string; seeker: boolean };
  }>;
  cacheSec: number;
}

export function useForgeStatus(): { forge: ForgeDto | null; reload: () => void; refresh: () => Promise<ForgeDto | null> } {
  const selectedBaseId = useApp((state) => state.selectedBaseId);
  const { data, reload, refresh } = useFetch<ForgeDto | null>(() =>
    api.get<ForgeDto>(selectedBaseId ? `/forge?baseId=${encodeURIComponent(selectedBaseId)}` : '/forge')
      .catch(() => null), [selectedBaseId]); // 404 = forge dark → hidden
  return { forge: data ?? null, reload, refresh };
}

/**
 * Animated Gold Forge hero (owner 2026-07-24: "animation to be running right
 * side … forging animation of gold shards"). The REAL building masters animate
 * the idle ⇄ work_f1 loop (same convention the base scene runs); molten gold
 * shards stream into the hopper while the player has a live stake; the whole
 * thing dims to a cold silhouette until a Gold Forge is built. reduceMotion →
 * static frame, no falling shards. Sized to fill the right column.
 */
function ForgeHero({ level, smelting }: { level: number; smelting: boolean }): React.JSX.Element {
  const reduceMotion = useApp((s) => s.reduceMotion);
  const built = level > 0;
  // The handoff's purpose-built eight-step story is decoration, not forge
  // state: every built Forge keeps the shards-in / KEEP-out cycle visible.
  const streaming = built && !reduceMotion;
  const emberLeft = [-42, -18, 6, 28];
  const emberDx = [-8, 6, -4, 10];
  const shardLeft = [-34, -4, 22];
  const pourLeft = [-26, 2, 24];
  return (
    <section className="sk-forge-panel">
      <div className="sk-forge-panel__head">
        THE CRUCIBLE
        <span className="sk-forge-head-note">{built ? (smelting ? 'SMELTING' : 'READY') : 'LOCKED'}</span>
      </div>
      <div className={`sk-forge-art${built ? '' : ' sk-forge-art--unbuilt'}`}>
        {streaming && <span className="sk-forge-glow" />}
        {streaming && emberLeft.map((left, i) => (
          <span key={`ember-${left}`} className="sk-forge-ember" style={{
            left: `calc(50% + ${left}px)`,
            ['--sk-dx' as string]: `${emberDx[i]}px`,
            animationDuration: `${1.6 + (i % 3) * 0.2}s`,
            animationDelay: `${i * 0.3}s`,
          }} />
        ))}
        {streaming && shardLeft.map((left, i) => (
          <span key={`shard-${left}`} className="sk-forge-shard" style={{
            left: `calc(50% + ${left}px)`, animationDuration: `${1.5 + i * 0.1}s`, animationDelay: `${i * 0.45}s`,
          }}><Icon name="shard" size={15} /></span>
        ))}
        {streaming && pourLeft.map((left, i) => (
          <span key={`pour-${left}`} className="sk-forge-pour" style={{
            left: `calc(50% + ${left}px)`, animationDuration: `${2.6 + (i % 2) * 0.3}s`, animationDelay: `${i * 0.7}s`,
          }}><Icon name="keep" size={17} /></span>
        ))}
        <div className="sk-forge-scene" role="img"
          style={{ backgroundImage: `url("${versionedPublicAsset('/brand/ui_forgescene.png')}")` }}
          aria-label="Goblin smelters feeding shards to the crucible and drawing minted KEEP off the press" />
        {!built && <span className="sk-forge-unbuilt">NOT BUILT</span>}
      </div>
      <div className="sk-forge-flow">
        <FlowStep number="1" icon={<Icon name="shard" size={17} />} name="DEPLOY"
          desc="Feed shards to the hopper before UTC midnight." />
        <FlowStep number="2" icon={<PixelCrucible />} name="SMELT"
          desc="Overnight the crucible melts the realm's whole haul." />
        <FlowStep number="3" icon={<Icon name="keep" size={17} />} name="POUR"
          desc="At dawn KEEP pours out by your share. Relics drop." />
      </div>
    </section>
  );
}

function PixelCrucible(): React.JSX.Element {
  const rows = ['..fF..', '.fFFf.', '..hh..', '.HHHH.', '.HggH.', '..HH..'];
  const colors: Record<string, string> = { f: C.danger, F: C.goldHi, h: C.stoneDark, H: C.border, g: C.gold };
  return (
    <span className="sk-forge-crucible" aria-hidden="true">
      {rows.flatMap((row, y) => [...row].map((ch, x) => ch === '.' ? null : (
        <i key={`${x}-${y}`} data-molten={ch === 'g'} style={{ left: x * 3, top: y * 3, background: colors[ch] }} />
      )))}
    </span>
  );
}

function FlowStep({ number, icon, name, desc }: {
  number: string; icon: React.ReactNode; name: string; desc: string;
}): React.JSX.Element {
  return (
    <div className="sk-forge-flow__step">
      <span className="sk-forge-flow__name">{icon}<b className="sk-forge-flow__number">{number}</b>{name}</span>
      <p>{desc}</p>
    </div>
  );
}

/**
 * The Forge is the FIRST locked door most deedless players will touch, because
 * the HUD's shard pill opens it. Without this it fetched GET /forge on mount, got
 * a 402, and answered a tap on a currency readout with an error sound.
 */
type ForgeTab = 'DEPLOY' | 'MY LEDGER' | 'THIS CYCLE' | 'RELICS WON';

export function ForgeScreen(): React.JSX.Element {
  const recovery = useForgeClaimRecovery();
  const landOwned = useLandOwned();
  const wallet = useApp(state => state.wallet), baseId = useApp(state => state.selectedBaseId);
  if (!landOwned) {
    return (
      <ScrollPage title="GOLD FORGE" onClose={closeWalletMenu}>
        <WalletMenuBack />
        {recovery.controller && <ForgeClaimRecoveryPanel controller={recovery.controller} state={recovery.state} />}
        <LandLocked {...LAND_LOCKED.forge} entryFeeSol={ECONOMY.entryFeeSol} onBuy={buyLand} />
      </ScrollPage>
    );
  }
  return <ForgeOwnedScreen key={JSON.stringify([wallet, baseId])} recovery={recovery} />;
}

function ForgeOwnedScreen({ recovery }: { recovery: ReturnType<typeof useForgeClaimRecovery> }): React.JSX.Element {
  const selectedBaseId = useApp((state) => state.selectedBaseId);
  const [amt, setAmt] = useState('');
  const [busy, setBusy] = useState(false);
  const [custodyHeld, setCustodyHeld] = useState(false);
  const [tab, setTab] = useState<ForgeTab>('DEPLOY');
  const mutation = useRef(false);
  const claimKey = recovery.state.journal?.hydrated ? recovery.state.journal.intent?.request.idempotencyKey : null;
  // RELICS WON also reads the ledger: its MY RELICS strip is the player's own
  // drop history, which already lives in the allocations page.
  const readLedger = tab === 'MY LEDGER' || tab === 'RELICS WON' || Boolean(claimKey);
  const { data: availability, loading: refreshing, error: refreshError, reload } = useFetch(async () => {
    const scope = selectedBaseId ? `?baseId=${encodeURIComponent(selectedBaseId)}` : '';
    const [forge, allocations] = await Promise.all([
      api.get<ForgeDto>(`/forge${scope}`),
      readLedger ? api.get<ForgeAllocationsDto>(`/forge/allocations${scope}`) : Promise.resolve(null),
    ]);
    return { claimKey, forge, allocations };
  }, [selectedBaseId, claimKey, readLedger]);
  const forge = availability?.forge ?? null;
  // A saved receipt proves payout, not that the previous claim buttons are
  // current. Release them only after this receipt's overview and ledger refresh.
  const availabilityPending = refreshing || Boolean(refreshError) || !availability || availability.claimKey !== claimKey
    || (readLedger && !availability.allocations);
  const claimBusy = busy || recovery.state.busy || !recovery.state.loaded || !recovery.state.supported || !recovery.state.enabled
    || availabilityPending || Boolean(recovery.state.review) || Boolean(recovery.state.journal?.intent && !recovery.state.journal.finished);
  const total = Number(forge?.totalShards ?? 0);
  const mine = Number(forge?.myShards ?? 0);
  const balance = Number(forge?.myShardBalance ?? 0);
  const level = forge?.goldforgeLevel ?? 0;
  const built = level > 0;
  // Daily headroom under the Gold Forge BUILDING cap (0 until one is built).
  const dailyCap = Number(forge?.myDailyCapShards ?? 0);
  const capLeft = Math.max(0, dailyCap - mine);
  const softCap = forge?.softCapShards ?? 1;
  const emission = forge?.dailyEmissionKeep ?? 0;
  // Live preview of TODAY's implied rate + my payout at current totals — the
  // same formula the server settles with (rate = emission/max(total, softCap)).
  const amtN = parseInt(amt, 10) || 0;
  const totalAfter = total + amtN;
  const rate = emission / Math.max(totalAfter, softCap);
  const myAfter = mine + amtN;
  const projected = Math.floor(myAfter * rate);
  const softCapPct = Math.min(100, Math.round((total / softCap) * 100));

  const contribute = (): void => {
    if (busy || custodyHeld || mutation.current || amtN <= 0) return;
    mutation.current = true; setBusy(true);
    void api.post('/forge/contribute', {
      shards: String(amtN),
      ...(selectedBaseId ? { baseId: selectedBaseId } : {}),
    })
      .then(() => {
        playSfx('sfx_confirm'); haptic('light'); toast('SHARDS DEPLOYED TO THE FORGE'); setAmt(''); reload();
        // The HUD reads the base snapshot, independently of the Forge panel.
        return reloadBase();
      })
      .catch(async (e: Error) => {
        const { refreshCustodyRefusal } = await import('../../lib/phaseERefusals');
        await refreshCustodyRefusal(e, () => setCustodyHeld(true), async () => { reload(); await reloadBase(); });
        failToast(e, e.message.toUpperCase());
      })
      .finally(() => { mutation.current = false; setBusy(false); });
  };
  const maxDeploy = Math.max(0, Math.min(balance, capLeft));
  const setMax = (): void => setAmt(String(maxDeploy));
  const setPercent = (pct: number): void => setAmt(String(Math.floor(maxDeploy * pct / 100)));

  // ---- cycle clock -------------------------------------------------------
  const cycle = useCountdownFrom(forge?.cycleEndsInSec);
  // Hitting zero is what MATERIALISES the allocation: GET /forge runs the lazy
  // settlement, so the reload IS the pour. One retry covers the boundary race.
  // The ref fires this ONCE per zero-crossing — reload() replaces `forge`, and
  // re-running on that would spin while the countdown sits at zero.
  const pouredRef = useRef(false);
  useEffect(() => {
    if (!cycle.done) { pouredRef.current = false; return; }
    if (pouredRef.current) return;
    pouredRef.current = true;
    reload();
    const t = setTimeout(reload, 5_000);
    return () => clearTimeout(t);
  }, [cycle.done, reload]);

  // ---- claim -------------------------------------------------------------
  const claimable = forge?.claimable;
  const claim = (day?: string): void => {
    if (claimBusy) return;
    void recovery.controller?.review({ baseId: selectedBaseId ?? null, day: day ?? null });
  };

  const tabs: ForgeTab[] = ['DEPLOY', 'MY LEDGER', 'THIS CYCLE', 'RELICS WON'];
  const capPct = dailyCap > 0 ? Math.min(100, (mine / dailyCap) * 100) : 0;
  const cyclePct = Math.min(100, Math.max(0, 100 - (cycle.left / 86_400) * 100));
  const dropRows = Object.entries(forge?.drops.independentDropBps ?? {});
  const maxDropBps = Math.max(1, ...dropRows.map(([, bps]) => bps));
  const title = (
    <span className="sk-forge-title">
      <span className="sk-forge-title__mark"><Icon name="keep" size={30} /></span>
      <span>GOLD FORGE</span>
      <span className="sk-forge-title__level">{built ? `L${level}` : 'NOT BUILT'}</span>
    </span>
  );
  return (
    <ScrollPage title={title} onClose={closeWalletMenu}
      tabs={
        <div className="sk-forge-tabs">
          {tabs.map((t) => (
            <button key={t} type="button" className="interactive sk-forge-tab" aria-selected={tab === t}
              onClick={() => { playSfx('sfx_tap'); setTab(t); }}>{t}</button>
          ))}
        </div>
      }>
      <WalletMenuBack />
      {recovery.controller && <ForgeClaimRecoveryPanel controller={recovery.controller} state={recovery.state} />}
      {refreshError && <div role="status">
        <span>{recovery.state.journal?.receipt ? 'Your claim is confirmed. ' : ''}Forge availability could not refresh.</span>
        <Btn variant="ghost" onClick={reload}>REFRESH FORGE</Btn>
      </div>}
      {claimable && claimable.count > 0 && <section className="sk-forge-claim">
        <Icon name="keep" size={22} /><span className="sk-forge-claim__label">READY TO CLAIM</span>
        <span className="sk-forge-claim__value">{fmtN(claimable.totalKeep)} KEEP</span>
        <button type="button" className="interactive" disabled={claimBusy} onClick={() => claim()}>CLAIM ALL READY · {claimable.count}</button>
        {claimable.nextExpiresAt && <span className="sk-forge-claim__expiry">unclaimed KEEP returns to the emission pool — earliest expires {claimable.nextExpiresAt.slice(0, 10)}</span>}
      </section>}
      {tab === 'MY LEDGER' && <ForgeLedgerTab onClaim={day => claim(day)} claimBusy={claimBusy} firstPage={availability?.allocations ?? null} />}
      {tab === 'THIS CYCLE' && <ForgeGlobalTab />}
      {tab === 'RELICS WON' && <ForgeRelicsTab mine={availability?.allocations ?? null} />}
      {tab === 'DEPLOY' && (
      <div className="sk-forge-cols">
        <div className="sk-forge-stack">
          <section className="sk-forge-deploy">
            <h2 className="sk-forge-deploy__head">
              <Icon name="shard" size={20} />DEPLOY SHARDS
              <span className="sk-forge-head-note">before UTC midnight</span>
            </h2>
            <div className="sk-forge-amount">
              <span className="sk-forge-amount__icon"><Icon name="shard" size={22} /></span>
              <input className="interactive" value={amt ? fmtN(amt) : ''} inputMode="numeric"
                aria-label="Shards to deploy" placeholder="0"
                onChange={(e) => setAmt(e.target.value.replace(/[^0-9]/g, ''))} />
              <span className="sk-forge-amount__unit">SHARDS</span>
            </div>
            <div className="sk-forge-quick">
              <button type="button" disabled={!built || maxDeploy === 0} aria-pressed={amtN === Math.floor(maxDeploy * .25)} onClick={() => setPercent(25)}>25%</button>
              <button type="button" disabled={!built || maxDeploy === 0} aria-pressed={amtN === Math.floor(maxDeploy * .5)} onClick={() => setPercent(50)}>50%</button>
              <button type="button" disabled={!built || maxDeploy === 0} aria-pressed={amtN === maxDeploy} onClick={setMax}>MAX · {fmtN(maxDeploy)}</button>
            </div>
            <div className="sk-forge-projection">
              <span className="sk-forge-projection__label">PROJECTED AT TODAY'S POOL</span>
              <span className="sk-forge-projection__value">{fmtN(projected)}</span>
              <span className="sk-forge-projection__rate">KEEP · {rate.toFixed(3)}/shard</span>
            </div>
            <button type="button" className="interactive sk-forge-go"
              disabled={busy || custodyHeld || !built || amtN <= 0 || amtN > balance || amtN > capLeft} onClick={contribute}>DEPLOY</button>
            <p className="sk-forge-hint">Every remaining shard participates. Raid theft reduces this deed's stake before the pour.</p>
          </section>

          <section className="sk-forge-today">
            <div className="sk-forge-today__head">TODAY<span className="sk-forge-head-note">settles at UTC midnight</span></div>
            <div className="sk-forge-trow sk-forge-trow--pour">
              <span className="sk-forge-trow__key">NEXT POUR</span>
              <span className="sk-forge-trow__value">{cycle.done ? 'SMELTING…' : cycle.text}</span>
              <span className="sk-forge-bar"><i data-tone="hi" style={{ width: `${cyclePct}%` }} /></span>
            </div>
            <div className="sk-forge-trow">
              <span className="sk-forge-trow__key">TODAY'S POOL</span>
              <span className="sk-forge-trow__value">{fmtN(total)} <em className="sk-forge-trow__unit">SHARDS</em></span>
            </div>
            <div className="sk-forge-trow">
              <span className="sk-forge-trow__key">SOFT CAP</span>
              <span className="sk-forge-trow__value">{softCapPct}<em className="sk-forge-trow__unit">%</em></span>
              <span className="sk-forge-bar"><i style={{ width: `${softCapPct}%` }} /></span>
              <span className="sk-forge-subline">{total < softCap ? 'below the cap the rate is fixed — the pool is not diluting you yet' : 'above the cap each added shard shares the fixed daily emission'}</span>
            </div>
            <div className="sk-forge-trow">
              <span className="sk-forge-trow__key">MY FORGE CAP</span>
              <span className="sk-forge-trow__value">{fmtN(mine)} <em className="sk-forge-trow__unit">/ {fmtN(dailyCap)}</em></span>
              <span className="sk-forge-bar"><i data-tone="sky" style={{ width: `${capPct}%` }} /></span>
              <span className="sk-forge-subline">{built ? 'upgrade the Gold Forge to raise the daily cap' : 'build a Gold Forge to deploy shards'}</span>
            </div>
            <div className="sk-forge-trow">
              <span className="sk-forge-trow__key">MY SHARD BALANCE</span>
              <span className="sk-forge-trow__value">{fmtN(balance)}</span>
            </div>
            <div className="sk-forge-trow">
              <span className="sk-forge-trow__key">DAY'S EMISSION</span>
              <span className="sk-forge-trow__value">{fmtN(emission)} <em className="sk-forge-trow__unit">KEEP</em></span>
            </div>
          </section>

          {(!claimable || claimable.count === 0) && forge?.yesterday && forge.yesterday.status !== 'nothing' && (
            <section className="sk-forge-claim">
              <Icon name="keep" size={22} />
              <span className="sk-forge-claim__label">YESTERDAY</span>
              <span className="sk-forge-claim__value">
                {forge.yesterday.status === 'expired' ? 'EXPIRED' : `+${fmtN(forge.yesterday.keepPaid)} KEEP`}
              </span>
              <span className="sk-forge-claim__expiry">
                {forge.yesterday.status === 'expired' ? 'unclaimed KEEP returned to the emission pool' : forge.yesterday.status === 'claimed' ? 'claimed' : 'paid'}
              </span>
            </section>
          )}
        </div>

        <div className="sk-forge-stack">
          <ForgeHero level={level} smelting={mine > 0} />
          {dropRows.length > 0 && (
            <section className="sk-forge-panel sk-forge-drops">
              <div className="sk-forge-panel__head">DAILY DROPS<span className="sk-forge-head-note">INDEPENDENT PER DEED</span></div>
              {dropRows.map(([itemId, bps]) => {
                const spec = (ITEMS as Record<string, { name: string; asset: string }>)[itemId];
                // Gear drops carry handout art (itm_*) outside the Phaser
                // atlas — resolve it like Shop/Inventory or the rarest rows
                // render as broken sprites (the Aegis map-marker lesson).
                const art = spec ? itemArtUrl(spec.asset) : null;
                return (
                  <div className="sk-forge-drop" key={itemId}>
                    {art
                      ? <img src={art} width={24} height={24} alt="" style={{ imageRendering: 'pixelated' }} />
                      : <Sprite name={spec?.asset ?? ''} w={24} h={24} />}
                    <span>
                      <span className="sk-forge-drop__name">{spec?.name ?? itemId}</span>
                      <span className="sk-forge-drop__track"><i style={{ width: `${(bps / maxDropBps) * 100}%` }} /></span>
                    </span>
                    <span className="sk-forge-drop__pct">{(bps / 100).toFixed(2)}%</span>
                  </div>
                );
              })}
              <p className="sk-forge-drops__foot">Every positive deed position rolls every relic independently. Splitting a contribution creates no extra rolls, and more than one relic may drop.</p>
            </section>
          )}
        </div>
      </div>
      )}
    </ScrollPage>
  );
}

/** Status pill colour + label for one allocation row. */
const FORGE_STATUS: Record<ForgeRowStatus, { label: string; color: string }> = {
  open: { label: 'SMELTING', color: '#6cc0ff' },
  claimable: { label: 'READY', color: '#ffd76a' },
  claimed: { label: 'CLAIMED', color: '#7fd67f' },
  // To a player 'paid_legacy' means exactly what 'claimed' means — the KEEP is
  // in their balance. It is only distinct to the ledger.
  paid_legacy: { label: 'PAID', color: '#9aa0a6' },
  expired: { label: 'EXPIRED', color: '#e06060' },
  nothing: { label: '—', color: '#9aa0a6' },
};

/**
 * MY LEDGER — the caller's own allocation history (GET /forge/allocations).
 * Own rows only: claim status and relic drops are private (see the endpoint's
 * contract). Pages by keyset on `nextBefore`.
 */
function ForgeLedgerTab({ onClaim, claimBusy, firstPage }: { onClaim: (day: string) => void; claimBusy: boolean; firstPage: ForgeAllocationsDto | null }): React.JSX.Element {
  const selectedBaseId = useApp((state) => state.selectedBaseId);
  const [pages, setPages] = useState<ForgeAllocationsDto[]>([]);
  const [busy, setBusy] = useState(false);
  const currentPage = useRef(firstPage);
  currentPage.current = firstPage;
  useEffect(() => { setPages(firstPage ? [firstPage] : []); setBusy(false); }, [firstPage]);
  useEffect(() => () => { currentPage.current = null; }, []);

  const last = pages[pages.length - 1];
  const rows = pages.flatMap((p) => p.days);
  const totals = pages[0]?.totals;

  const more = (): void => {
    if (busy || !last?.nextBefore) return;
    const originalPage = firstPage;
    setBusy(true);
    const params = new URLSearchParams({ before: last.nextBefore });
    if (selectedBaseId) params.set('baseId', selectedBaseId);
    void api.get<ForgeAllocationsDto>(`/forge/allocations?${params.toString()}`)
      .then((p) => { if (currentPage.current === originalPage) setPages((ps) => [...ps, p]); })
      .catch((e: Error) => { if (currentPage.current === originalPage) failToast(e, e.message.toUpperCase()); })
      .finally(() => { if (currentPage.current === originalPage) setBusy(false); });
  };


  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {totals && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <Chip><span style={{ color: C.textDim, fontSize: 13 }}>CLAIMED</span><Sp /><span style={{ color: C.success }}>{fmtN(totals.keepClaimed)}</span></Chip>
          <Chip><span style={{ color: C.textDim, fontSize: 13 }}>CLAIMABLE</span><Sp /><span style={{ color: C.goldHi }}>{fmtN(totals.keepClaimable)}</span></Chip>
          <Chip><span style={{ color: C.textDim, fontSize: 13 }}>SHARDS BURNED</span><Sp /><span>{fmtN(totals.shardsBurned)}</span></Chip>
          <Chip><span style={{ color: C.textDim, fontSize: 13 }}>RELICS WON</span><Sp /><span style={{ color: C.goldHi }}>{totals.itemsWon}</span></Chip>
        </div>
      )}
      {rows.length === 0 && <div style={{ color: C.textFaint, fontSize: 14 }}>No cycles yet — deploy shards and come back after the pour.</div>}
      {rows.map((r) => {
        const st = FORGE_STATUS[r.status];
        return (
          <div key={r.day} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, background: C.card, border: `2px solid ${C.border}`, padding: '7px 10px' }}>
            <span style={{ color: C.text, fontSize: 14 }}>{r.day}</span>
            <span style={{ color: C.textFaint, fontSize: 13 }}>{fmtN(r.shards)} SHARDS IN</span>
            <span style={{ color: C.goldHi, fontSize: 14 }}>+{fmtN(r.keepPaid)} KEEP</span>
            {(r.itemsDropped ?? (r.itemDropped ? [r.itemDropped] : [])).map((itemId) => (
              <Sprite key={itemId} name={(ITEMS as Record<string, { asset: string }>)[itemId]?.asset ?? ''} w={18} h={18} />
            ))}
            <Sp />
            <span style={{ color: st.color, fontSize: 13 }}>{st.label}</span>
            {r.status === 'claimable' && (
              <Btn fontSize={13} disabled={busy || claimBusy} onClick={() => onClaim(r.day)}>CLAIM</Btn>
            )}
          </div>
        );
      })}
      {last?.nextBefore && (
        <Btn variant="ghost" fontSize={14} disabled={busy} onClick={more}>LOAD MORE</Btn>
      )}
    </div>
  );
}

/**
 * THIS CYCLE — public per-day allocations (GET /forge/global). Settled cycles
 * only; wallets arrive already abbreviated from the server.
 */
function ForgeGlobalTab(): React.JSX.Element {
  const [day, setDay] = useState<string | null>(null);
  const [pages, setPages] = useState<ForgeGlobalDto[]>([]);
  const [busy, setBusy] = useState(false);
  const { data } = useFetch<ForgeGlobalDto>(
    () => api.get<ForgeGlobalDto>(day ? `/forge/global?day=${day}` : '/forge/global'), [day]);
  useEffect(() => { setPages(data ? [data] : []); }, [data]);

  const head = pages[0];
  const last = pages[pages.length - 1];
  const rows = pages.flatMap((p) => p.rows);
  const more = (): void => {
    if (busy || !last?.nextCursor || !head?.day) return;
    setBusy(true);
    void api.get<ForgeGlobalDto>(`/forge/global?day=${head.day}&cursor=${encodeURIComponent(last.nextCursor)}`)
      .then((p) => setPages((ps) => [...ps, p]))
      .catch((e: Error) => failToast(e, e.message.toUpperCase()))
      .finally(() => setBusy(false));
  };

  if (head && !head.day) {
    return <div style={{ color: C.textFaint, fontSize: 14 }}>No settled cycles yet — the first pour is at UTC midnight.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Day chips — SETTLED cycles only; the endpoint refuses an open one. */}
      <div style={{ display: 'flex', gap: 5, overflowX: 'auto', paddingBottom: 2 }}>
        {(head?.days ?? []).map((d) => (
          <Btn key={d} variant={(head?.day ?? '') === d ? 'gold' : 'ghost'} fontSize={13}
            onClick={() => { playSfx('sfx_tap'); setDay(d); }}>{d.slice(5)}</Btn>
        ))}
      </div>
      {head && (
        <div style={{ color: C.textFaint, fontSize: 13 }}>
          {fmtN(head.contributors)} KINGDOMS · {fmtN(head.totalShards)} SHARDS · <span style={{ color: C.goldHi }}>{fmtN(head.distributedKeep)} KEEP POURED</span>
        </div>
      )}
      {head?.me && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.card, border: `2px solid ${C.goldDp}`, padding: '7px 10px' }}>
          <span style={{ color: C.gold, fontSize: 14 }}>#{head.me.rank}</span>
          <PlayerName name={head.me.name} wallet={head.me.walletShort} seeker={head.me.seeker} />
          <Sp />
          <span style={{ color: C.textFaint, fontSize: 13 }}>{fmtN(head.me.shards)}</span>
          <span style={{ color: C.goldHi, fontSize: 14 }}>+{fmtN(head.me.keepPaid)}</span>
        </div>
      )}
      {rows.map((r) => (
        <div key={r.walletShort + r.rank} style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.card, border: `2px solid ${C.border}`, padding: '6px 10px' }}>
          <span style={{ color: C.textDim, fontSize: 13, minWidth: 34 }}>#{r.rank}</span>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {/* PlayerName falls back to a 4…4 slice of whatever wallet it is
                given — here that is ALREADY the server's abbreviation. */}
            <PlayerName name={r.name} wallet={r.walletShort} seeker={r.seeker} />
            <span style={{ color: C.textFaint, fontSize: 11 }}>{r.walletShort}</span>
          </div>
          <Sp />
          <span style={{ color: C.textFaint, fontSize: 13 }}>{fmtN(r.shards)}</span>
          <span style={{ color: C.goldHi, fontSize: 14 }}>+{fmtN(r.keepPaid)}</span>
        </div>
      ))}
      {last?.nextCursor && <Btn variant="ghost" fontSize={14} disabled={busy} onClick={more}>LOAD MORE</Btn>}
    </div>
  );
}

/** Rarity tint shared with the Shop catalog and Inventory detail. */
const FORGE_RARITY_COLOR: Record<ItemRarity, string> = {
  common: '#C4BBA4', uncommon: '#8CB36E', rare: '#BBD0D6',
  epic: '#9A78B8', legendary: '#E3AE3C', mythic: '#F4D77B',
};

/** Item art + name for one relic row: handout art (itm_*) outside the Phaser
 *  atlas resolves like Shop/Inventory, everything else is a Sprite. */
function ForgeRelicArt({ itemId, size }: { itemId: string; size: number }): React.JSX.Element {
  const spec = (ITEMS as Record<string, { asset: string } | undefined>)[itemId];
  const art = spec ? itemArtUrl(spec.asset) : null;
  return art
    ? <img src={art} width={size} height={size} alt="" style={{ imageRendering: 'pixelated' }} />
    : <Sprite name={spec?.asset ?? ''} w={size} h={size} />;
}

/**
 * RELICS WON — the PUBLIC drop feed (GET /forge/drops/recent): who won which
 * relic in which cycle, so every player can see that drops really happen
 * (tester 69arc, report 0d1b6d9d). The MY RELICS strip above it is the
 * caller's own history from the allocations page the ledger already loads.
 */
function ForgeRelicsTab({ mine }: { mine: ForgeAllocationsDto | null }): React.JSX.Element {
  const { data, loading, error } = useFetch<ForgeRecentDropsDto>(() => api.get<ForgeRecentDropsDto>('/forge/drops/recent'), []);
  const myDrops = (mine?.days ?? []).flatMap((day) =>
    (day.itemsDropped ?? (day.itemDropped ? [day.itemDropped] : [])).map((itemId) => ({ day: day.day, itemId })));
  return (
    <div className="sk-forge-relics">
      <section className="sk-forge-panel">
        <div className="sk-forge-panel__head">MY RELICS<span className="sk-forge-head-note">{mine ? `${mine.totals.itemsWon} WON` : 'LOADING'}</span></div>
        {mine && myDrops.length === 0 && <p className="sk-forge-drops__foot">No relic yet — every settled deed position rolls each relic independently.</p>}
        {myDrops.length > 0 && (
          <div className="sk-forge-relics__mine">
            {myDrops.map((drop) => {
              const spec = (ITEMS as Record<string, { name: string } | undefined>)[drop.itemId];
              return (
                <span className="sk-forge-relics__chip" key={`${drop.day}:${drop.itemId}`} title={drop.day}>
                  <ForgeRelicArt itemId={drop.itemId} size={18} />
                  <span>{spec?.name ?? drop.itemId}</span>
                  <em>{drop.day.slice(5)}</em>
                </span>
              );
            })}
          </div>
        )}
      </section>
      <section className="sk-forge-panel">
        <div className="sk-forge-panel__head">RELICS WON<span className="sk-forge-head-note">EVERY KINGDOM · NEWEST FIRST</span></div>
        {error && <p className="sk-forge-drops__foot">The relic feed could not load.</p>}
        {!error && loading && !data && <p className="sk-forge-drops__foot">Loading recent drops…</p>}
        {data && data.drops.length === 0 && <p className="sk-forge-drops__foot">No relic has dropped yet — the first pour is at UTC midnight.</p>}
        {data?.drops.map((drop, index) => (
          <div className="sk-forge-relic" key={`${drop.settledAt}:${drop.winner.walletShort}:${drop.itemId}:${index}`}>
            <ForgeRelicArt itemId={drop.itemId} size={24} />
            <span className="sk-forge-relic__item">
              <span className="sk-forge-relic__name" style={{ color: drop.rarity ? FORGE_RARITY_COLOR[drop.rarity] : undefined }}>{drop.name}</span>
              <span className="sk-forge-relic__meta">{drop.rarity ? `${drop.rarity.toUpperCase()} · ` : ''}CYCLE {drop.day}</span>
            </span>
            <span className="sk-forge-relic__winner">
              {/* PlayerName falls back to a 4…4 slice of whatever wallet it is
                  given — here that is ALREADY the server's abbreviation. */}
              <PlayerName name={drop.winner.name} wallet={drop.winner.walletShort} seeker={drop.winner.seeker} />
              <span className="sk-forge-relic__wallet">{drop.winner.walletShort}</span>
            </span>
          </div>
        ))}
        <p className="sk-forge-drops__foot">Winners are the deed owner at the pour. Names and wallets are shown the way the cycle table shows them.</p>
      </section>
    </div>
  );
}

// ===========================================================================
// COLLECTION & MARKET — Marketplace Lane A (external NFT marketplaces). A
// READ-ONLY browse of the player's owned Core assets (Land Deeds now, cosmetics
// later) + deep-links to Tensor / Magic Eden. No in-app trading yet: deeds are
// soulbound until the liquidity event (tradingEnabled), so assets show a "not
// yet tradable" badge and the external links go live at TGE. Gameplay never
// reads any of this — attackability is server-truth (spec INV-1).
// ===========================================================================

interface MarketAssetDto {
  id: string; name: string; image: string | null; frozen: boolean;
  kind: 'deed' | 'cosmetic';
  links: { tensor: string; magicEden: string };
}
interface MarketAssetsDto { assets: MarketAssetDto[]; dasConfigured: boolean; tradingEnabled: boolean }
interface MarketCollectionDto {
  collection: string | null; feeBps: number; tradingEnabled: boolean;
  links: { tensor: string; magicEden: string } | null;
}

/** Truncate a base58 asset/collection id for display. */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

function ExtLink({ href, label, disabled }: { href: string; label: string; disabled: boolean }): React.JSX.Element {
  if (disabled) {
    return <span style={{ fontSize: 13, color: C.stoneDark, padding: '4px 8px', border: `2px solid ${C.border}` }}>{label}</span>;
  }
  return (
    <a className="interactive" href={href} target="_blank" rel="noopener noreferrer"
      style={{ fontSize: 13, color: C.goldHi, padding: '4px 8px', border: `2px solid ${C.goldDp}`, textDecoration: 'none' }}
      onClick={() => playSfx('sfx_tap')}>
      {label} ↗
    </a>
  );
}

// --- Item market (Shard-settled) DTOs + tab ---------------------------------

/** `sellerName` is the seller's PUBLIC identity as the server computes it (display
 *  name, else 4…4 wallet) — optional only so a web build ahead of the API keeps rendering. */
interface ListingDto { id: string; seller: string; sellerName?: string; itemId: string; priceLamports: string; baseId?: string | null }
/** GET /market/listings — rows for the current filter/sort PLUS a per-item floor
 *  summary computed over the whole open book (so the floor never moves with a filter). */
interface BookDto {
  features?: { itemMarket?: unknown };
  feeBps: number;
  listings: ListingDto[];
  summary: Array<{ itemId: string; floorLamports: string; listed: number }>;
}
interface MyListingsDto {
  listings: Array<{ id: string; itemId: string; priceLamports: string; status: string; baseId?: string | null;
    cancelConsent?: { version: 1; status: 'active' | 'reserved'; reference: string | null } }>;
}

const LAMPORTS_PER_SOL = 1_000_000_000;
/** Lamports → a compact SOL string (up to 4 dp, trailing zeros trimmed). */
function solStr(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(4).replace(/\.?0+$/, '');
}

type MarketItemSpec = ShopItemsDto['catalog'][number];

function MarketItemArt({ spec, size }: { spec: MarketItemSpec | undefined; size: number }): React.JSX.Element {
  const art = spec ? itemArtUrl(spec.asset) : null;
  if (art) return <img src={art} width={size} height={size} alt="" style={{ imageRendering: 'pixelated' }} />;
  return <Sprite name={spec?.asset ?? ''} w={size} h={size} />;
}

/** Browse + buy (SOL) active listings; list your own available items; cancel your listings. */
/**
 * ITEM MARKET browse (owner 2026-07-26 redesign). Shaped like a real NFT
 * marketplace instead of one flat list: a FLOOR RAIL (one row per item type with
 * its floor price + listing count) that you drill into for that item's listings,
 * cheapest first. Filter and sort come from the server (`/market/listings?itemId&sort`)
 * so the floor is always computed over the WHOLE open book, never the visible slice.
 */
function ItemMarketTab({
  sellItemId,
  onSellItemConsumed,
}: {
  sellItemId?: string | null;
  onSellItemConsumed?: () => void;
}): React.JSX.Element {
  const selectedBaseId = useApp((state) => state.selectedBaseId);
  const recovery = useMarketRecovery();
  const [review, setReview] = useState<MarketReview | null>(null);
  const reviewGuard = useRef<ReturnType<typeof captureBaseSnapshotGuard> | null>(null);
  const reviewRequest = (next: MarketReview): void => { reviewGuard.current = captureBaseSnapshotGuard(); setReview(next); };
  const [itemFilter, setItemFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<'floor' | 'price_desc' | 'newest'>('floor');
  const qs = `${itemFilter ? `itemId=${encodeURIComponent(itemFilter)}&` : ''}sort=${sort}`;
  const { data: book, reload: reloadBook } = useFetch<BookDto>(
    () => api.get<BookDto>(`/market/listings?${qs}`), [itemFilter, sort],
  );
  const v1 = supportsMarketV1(book) || recovery.state.journal?.activated === true;
  const tradeReady = recovery.state.loaded && !recovery.state.busy && !recovery.state.journal?.command && !recovery.state.journal?.purchase && !review;
  const { data: mineListed, reload: reloadMine } = useFetch<MyListingsDto>(
    () => api.get(v1 ? '/market/v1/listings/mine' : '/market/listings/mine'), [v1],
  );
  const { data: inv, reload: reloadInv } = useFetch<ItemsDto>(
    () => api.get<ItemsDto>(selectedBasePath('/items')),
    [selectedBaseId],
  );
  const wallet = useApp((s) => s.wallet);
  const [busy, setBusy] = useState<string | null>(null);
  const [listing, setListing] = useState<{ itemId: string; price: string } | null>(null);
  /** Listing whose item description is expanded (tester ef22cdb7: descriptions live
   *  behind an INFO toggle so the grid reads art · name · seller · price). */
  const [infoFor, setInfoFor] = useState<string | null>(null);
  const listingAttempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const market = useMarketBuy();
  const feePct = (book?.feeBps ?? 500) / 100;
  /**
   * BROWSING IS FREE, TRADING IS NOT — and that asymmetry is the trap this fixes.
   * GET /market/listings and /market/listings/mine are `free`, so a deedless player
   * legitimately sees the whole order book; POST /market/list and the buy path
   * (reserve → paid → settle) are `owned`. So the book renders in full and the two
   * ACTIONS say what they need, instead of a BUY that reserves, 402s, and leaves
   * `useMarketBuy` to toast the gate message under the sheet.
   */
  const landOwned = useLandOwned();

  const reloadAll = (): void => { reloadBook(); reloadMine(); reloadInv(); void reloadBase({ background: true }); };
  useEffect(() => { if (market.error) { playSfx('sfx_error'); toast(market.error.toUpperCase()); } }, [market.error]);
  // Handed off from an inventory cube's SELL ON MARKET: open that item's price
  // editor prefilled with the current floor, so listing starts where the item is.
  useEffect(() => {
    if (!sellItemId || !book) return;
    const f = book.summary.find((x) => x.itemId === sellItemId);
    setListing({ itemId: sellItemId, price: f ? solStr(Number(f.floorLamports)) : '' });
    onSellItemConsumed?.();
  }, [sellItemId, book, onSellItemConsumed]);
  const act = (id: string, fn: () => Promise<unknown>, msg: string): void => {
    if (busy) return;
    setBusy(id);
    void fn()
      .then(() => { playSfx('sfx_confirm'); haptic('light'); toast(msg); reloadAll(); })
      .catch((e: Error) => failToast(e, e.message.toUpperCase()))
      .finally(() => setBusy(null));
  };
  // A stale tab re-reads activation under the same action lock before any
  // legacy command. A v1 intent can never fall back to this rail.
  const legacyCommand = async <T,>(action: () => Promise<T>): Promise<T> => {
    const controller = recovery.controller;
    if (!controller || !recovery.state.loaded) throw new Error('Read saved market requests first.');
    const guard = captureBaseSnapshotGuard();
    return marketBrowserLock(`pkw-market-v1:${controller.store.key}`, async () => {
      const saved = await controller.store.read();
      if (saved.activated || !isBaseSnapshotGuardCurrent(guard)) throw new Error('The saved market request or selected base changed. Refresh the market.');
      return action();
    });
  };
  const confirmReview = async (): Promise<void> => {
    if (!review || !recovery.controller || !reviewGuard.current) return;
    if (!isBaseSnapshotGuardCurrent(reviewGuard.current)) { setReview(null); toast('REVIEW THE CURRENT ACCOUNT AND BASE AGAIN'); return; }
    const controller = recovery.controller;
    if (review.kind === 'list') await controller.list({ itemId: review.itemId, priceLamports: review.priceLamports, baseId: review.baseId });
    else if (review.kind === 'reserve') await controller.reserve(review.listingId, { itemId: review.itemId, sourceBaseId: review.sourceBaseId,
      buyerBaseId: review.buyerBaseId, seller: review.seller, priceLamports: review.priceLamports });
    else await controller.cancel(review.listingId, { itemId: review.itemId, sourceBaseId: review.sourceBaseId,
      priceLamports: review.priceLamports, status: review.status, reference: review.reference });
    setReview(null); setListing(null); reloadAll();
  };
  const submitList = (): void => {
    if (!listing || !tradeReady) return;
    // POST /market/list is `owned`. The price editor can be reached with no land
    // (INVENTORY → SELL ON MARKET hands off into it), so the refusal is caught
    // here rather than by the server.
    if (!landOwned) { askLand(); return; }
    if (v1) {
      try { reviewRequest({ kind: 'list', itemId: listing.itemId, name: spec(listing.itemId)?.name ?? listing.itemId,
        priceLamports: marketSolAmount(listing.price), baseId: spec(listing.itemId)?.kind === 'cosmetic' ? null : selectedBaseId }); }
      catch (error) { toast(error instanceof Error ? error.message : 'Review the price again.'); }
      return;
    }
    const sol = parseFloat(listing.price);
    if (!(sol > 0)) { toast('SET A SOL PRICE'); return; }
    const lamports = Math.round(sol * LAMPORTS_PER_SOL);
    if (lamports < MARKETPLACE.itemMarket.minPriceLamports) { toast(`MIN ${solStr(MARKETPLACE.itemMarket.minPriceLamports)} SOL`); return; }
    if (lamports > MARKETPLACE.itemMarket.maxPriceLamports) { toast(`MAX ${solStr(MARKETPLACE.itemMarket.maxPriceLamports)} SOL`); return; }
    const fingerprint = JSON.stringify([selectedBaseId, listing.itemId, lamports]);
    if (listingAttempt.current?.fingerprint !== fingerprint) {
      listingAttempt.current = { fingerprint, key: idemKey() };
    }
    const key = listingAttempt.current.key;
    act('list', () => legacyCommand(() => api.post('/market/list', withSelectedBase({
      itemId: listing.itemId,
      priceLamports: String(lamports),
      idempotencyKey: key,
    })).then((result) => {
      if (listingAttempt.current?.key === key) listingAttempt.current = null;
      return result;
    })), 'LISTED');
    setListing(null);
  };
  const doBuy = (id: string): void => {
    if (!tradeReady) return;
    if (v1) {
      const offer = book?.listings.find((row) => row.id === id);
      if (!offer || offer.baseId === undefined) { toast('REFRESH THIS OFFER BEFORE RESERVING'); return; }
      reviewRequest({ kind: 'reserve', listingId: id, itemId: offer.itemId, name: spec(offer.itemId)?.name ?? offer.itemId,
        seller: offer.seller, sourceBaseId: offer.baseId, buyerBaseId: offer.baseId === null ? null : selectedBaseId, priceLamports: offer.priceLamports });
      return;
    }
    void legacyCommand(() => market.buy(id, () => { playSfx('sfx_confirm'); haptic('light'); toast('BOUGHT!'); reloadAll(); }))
      .catch((error: Error) => failToast(error, error.message));
  };
  const buyLabel = market.phase === 'reserving' ? 'RESERVING…'
    : market.phase === 'paying' ? 'CONFIRM IN WALLET…'
      : market.phase === 'confirming' ? 'CONFIRMING…' : 'BUY';

  const spec = (id: string): MarketItemSpec | undefined => {
    const fromApi = inv?.catalog.find((item) => item.id === id);
    if (fromApi) return fromApi;
    const fallback = (ITEMS as unknown as Record<string, Omit<MarketItemSpec, 'id'> | undefined>)[id];
    return fallback ? { id, ...fallback } : undefined;
  };
  const summary = book?.summary ?? [];
  const floorOf = (id: string): number | null => {
    const s = summary.find((x) => x.itemId === id);
    return s ? Number(s.floorLamports) : null;
  };
  // Only loose copies may enter custody. This mirrors the API's exact
  // qty-minus-hero-equipment fence, so an equipped-only item never advertises
  // a SELL control that the server must reject.
  const equippedCount = new Map<string, number>();
  for (const loadout of inv?.heroLoadouts ?? []) {
    for (const itemId of Object.values(loadout.equipment)) {
      if (itemId) equippedCount.set(itemId, (equippedCount.get(itemId) ?? 0) + 1);
    }
  }
  const sellableItems = (inv?.owned ?? []).flatMap((owned) => {
    const item = spec(owned.itemId);
    const available = Math.max(0, owned.qty - (equippedCount.get(owned.itemId) ?? 0));
    // Crafted materials have a future KEEP market; the current SOL market
    // refuses them even when paid collection remains available during a pause.
    return item && !item.dropOnly && item.acquisition.type !== 'craft' && available > 0
      ? [{ ...owned, qty: available }] : [];
  });
  const listings = book?.listings ?? [];
  const myOpen = mineListed?.listings ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {recovery.controller && <MarketRecoveryPanel controller={recovery.controller} state={recovery.state}
        pay={recovery.pay} check={recovery.check} afterFinish={reloadAll} />}
      {wallet && <MarketPurchases key={wallet} wallet={wallet} itemName={(id) => spec(id)?.name ?? id} afterFinish={reloadAll} />}
      {review && <MarketConsentPanel review={review} busy={recovery.state.busy}
        confirm={() => { void confirmReview().catch((error: Error) => failToast(error, error.message)); }} cancel={() => setReview(null)} />}
      {/* Said ONCE, up front, so the NEEDS LAND buttons below read as a tier
          rather than as a dozen individual failures. */}
      {!landOwned && (
        <Chip accent={C.goldDp} onClick={askLand} style={{ alignItems: 'flex-start', gap: 8 }}>
          <Icon name="sol" size={17} style={{ marginTop: 2, flex: 'none' }} />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span style={{ color: C.goldHi, fontSize: 15, letterSpacing: '1px' }}>{LAND_LOCKED.market.title}</span>
            <span style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.4 }}>{LAND_LOCKED.market.why}</span>
          </span>
          <Sp /><span style={{ color: C.gold, fontSize: 14 }}>›</span>
        </Chip>
      )}
      {/* ── FLOOR RAIL: the market at a glance, cheapest floor first ───────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 15, color: C.gold, letterSpacing: '1px' }}>FLOOR PRICES</span>
        <Sp />
        <span style={{ fontSize: 12, color: C.textFaint }}>{feePct}% FEE · SELLER GETS {100 - feePct}%</span>
      </div>
      {summary.length === 0 ? (
        <div style={{ color: C.textFaint, fontSize: 14, textAlign: 'center', padding: '10px 0' }}>
          Nothing listed right now. List one of your available items below to open the market.
        </div>
      ) : (
        summary.map((s) => {
          const sp = spec(s.itemId);
          const active = itemFilter === s.itemId;
          return (
            <Chip key={s.itemId} accent={active ? C.gold : undefined}
              onClick={() => setItemFilter(active ? null : s.itemId)}>
              <MarketItemArt spec={sp} size={30} />
              <span style={{ fontSize: 14, color: C.text }}>{sp?.name ?? s.itemId}</span>
              <Sp />
              <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: C.goldHi, fontSize: 15 }}>
                <Icon name="sol" size={14} />{solStr(Number(s.floorLamports))}
              </span>
              <span style={{ fontSize: 12, color: C.textFaint }}>· {s.listed} LISTED</span>
              <span style={{ color: active ? C.gold : C.textFaint, fontSize: 14 }}>{active ? '▾' : '▸'}</span>
            </Chip>
          );
        })
      )}

      {/* ── FILTER + SORT ─────────────────────────────────────────────────── */}
      {listings.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <Btn variant={itemFilter === null ? 'gold' : 'ghost'} fontSize={13} style={{ padding: '3px 10px 5px' }}
            onClick={() => setItemFilter(null)}>ALL</Btn>
          {([['floor', 'PRICE ↑'], ['price_desc', 'PRICE ↓'], ['newest', 'NEWEST']] as const).map(([k, label]) => (
            <Btn key={k} variant={sort === k ? 'gold' : 'ghost'} fontSize={13} style={{ padding: '3px 10px 5px' }}
              onClick={() => setSort(k)}>{label}</Btn>
          ))}
        </div>
      )}

      {/* ── LISTINGS ──────────────────────────────────────────────────────── */}
      <Phead title={
        <span style={{ fontSize: 16 }}>
          {itemFilter ? `${spec(itemFilter)?.name ?? itemFilter} · ${listings.length}` : `ALL LISTINGS · ${listings.length}`}
        </span>
      } fontSize={16} />
      {listings.length === 0 ? (
        <div style={{ color: C.textFaint, fontSize: 14, textAlign: 'center', padding: '10px 0' }}>
          No listings{itemFilter ? ' for this item' : ''}.
        </div>
      ) : (
        /* Card GRID, matching the D1 inventory cubes — the market and your bag are
         * the same objects, so they read the same way. Wider min than the 76px
         * cubes: a listing card also carries price + BUY. Auto-fill reflows from
         * phone (2-up) to desktop widths. */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 1fr))', gap: 8 }}>
          {listings.map((l) => {
            const sp = spec(l.itemId);
            const isMine = l.seller === wallet;
            const buying = market.phase !== 'idle' && market.listingId === l.id;
            const price = Number(l.priceLamports);
            const floor = floorOf(l.itemId);
            // "AT FLOOR" / "+N%" tells a buyer instantly whether this is the cheapest
            // unit of that item, which is the one number that decides the purchase.
            const overFloorPct = floor && floor > 0 && price > floor ? Math.round(((price - floor) / floor) * 100) : 0;
            const infoOpen = infoFor === l.id;
            // Never the full address on a card: the server already abbreviates, and the
            // fallback abbreviates the same way for an API that predates sellerName.
            const sellerLabel = l.sellerName ?? `${l.seller.slice(0, 4)}…${l.seller.slice(-4)}`;
            return (
              <div key={l.id}
                style={{ background: C.card, border: `2px solid ${overFloorPct === 0 ? C.goldDp : C.border}`, padding: '8px 8px 7px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <MarketItemArt spec={sp} size={44} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: '100%' }}>
                  <div style={{ color: C.text, fontSize: 13, textAlign: 'center', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                    {sp?.name ?? l.itemId}
                  </div>
                  {sp?.desc && (
                    <Btn variant="ghost" fontSize={11} aria-expanded={infoOpen} style={{ padding: '0 5px 2px', lineHeight: 1.2, flex: 'none' }}
                      onClick={() => setInfoFor(infoOpen ? null : l.id)}>INFO</Btn>
                  )}
                </div>
                {infoOpen && sp?.desc && <div style={{ color: C.textDim, fontSize: 12, textAlign: 'center', lineHeight: 1.3 }}>{sp.desc}</div>}
                <div style={{ color: C.textFaint, fontSize: 11, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                  BY {sellerLabel}
                </div>
                <div style={{ fontSize: 11, lineHeight: 1.2 }}>
                  {isMine
                    ? <span style={{ color: C.gold }}>YOUR LISTING</span>
                    : overFloorPct === 0
                      ? <span style={{ color: C.success }}>AT FLOOR</span>
                      : <span style={{ color: C.textFaint }}>+{overFloorPct}% OVER</span>}
                </div>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: C.goldHi, fontSize: 15 }}>
                  <Icon name="sol" size={14} />{solStr(price)}
                </span>
                {!landOwned && !isMine ? (
                  /* Not disabled — a dead button explains nothing. It opens the
                     pitch, which is the only useful thing a tap here can do. */
                  <Btn variant="ghost" fontSize={12} style={{ width: '100%', padding: '4px 0 6px' }} onClick={askLand}>
                    NEEDS LAND
                  </Btn>
                ) : (
                  <Btn fontSize={13} style={{ width: '100%', padding: '4px 0 6px' }} disabled={!tradeReady || buying || isMine} onClick={() => doBuy(l.id)}>
                    {isMine ? 'YOURS' : buying ? buyLabel : 'BUY'}
                  </Btn>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── SELL (from inventory), with floor guidance ─────────────────────── */}
      <Phead title={<span style={{ fontSize: 16 }}>SELL FROM INVENTORY</span>} fontSize={16} />
      {sellableItems.length === 0 ? (
        <div style={{ color: C.textFaint, fontSize: 14, textAlign: 'center', padding: '10px 0' }}>
          You have no unequipped tradable items. Buy items in the Shop or free a worn copy in Inventory.
        </div>
      ) : (
        sellableItems.map((o) => {
          const sp = spec(o.itemId);
          const open = listing?.itemId === o.itemId;
          const floor = floorOf(o.itemId);
          const typed = open ? Math.round((parseFloat(listing.price) || 0) * LAMPORTS_PER_SOL) : 0;
          return (
            <div key={o.itemId} style={{ background: C.card, border: `2px solid ${C.border}`, padding: '7px 10px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <MarketItemArt spec={sp} size={34} />
              <div style={{ flex: 1, minWidth: 90 }}>
                <div style={{ color: C.text, fontSize: 14 }}>{sp?.name ?? o.itemId} <span style={{ color: C.textFaint }}>×{o.qty}</span></div>
                <div style={{ color: C.textFaint, fontSize: 12 }}>
                  {floor ? `FLOOR ${solStr(floor)} SOL` : 'NO FLOOR YET — YOU SET IT'}
                </div>
              </div>
              {open ? (
                <>
                  <input className="interactive" value={listing.price} inputMode="decimal" autoFocus
                    onChange={(e) => setListing({ itemId: o.itemId, price: e.target.value.replace(/[^0-9.]/g, '') })}
                    placeholder="SOL PRICE"
                    style={{ width: 110, fontFamily: 'inherit', fontSize: 15, background: C.surface, color: C.text, border: `2px solid ${C.border}`, padding: '6px 8px' }} />
                  <span style={{ fontSize: 11, color: typed > 0 && floor && typed > floor ? C.danger : C.success, width: 74 }}>
                    {typed > 0 && floor
                      ? (typed <= floor ? 'NEW FLOOR ✓' : `+${Math.round(((typed - floor) / floor) * 100)}% OVER`)
                      : typed > 0 ? `YOU NET ${solStr(Math.round(typed * (1 - feePct / 100)))}` : ''}
                  </span>
                  <Btn fontSize={14} disabled={!tradeReady || busy !== null} onClick={submitList}>LIST</Btn>
                  <Btn variant="ghost" fontSize={14} onClick={() => setListing(null)}>✕</Btn>
                </>
              ) : !landOwned ? (
                <Btn variant="ghost" fontSize={13} onClick={askLand}>NEEDS LAND</Btn>
              ) : (
                <Btn variant="sec" fontSize={14}
                  onClick={() => setListing({ itemId: o.itemId, price: floor ? solStr(floor) : '' })}>SELL</Btn>
              )}
            </div>
          );
        })
      )}

      {/* ── MY OPEN LISTINGS ──────────────────────────────────────────────── */}
      {myOpen.length > 0 && (
        <>
          <Phead title={<span style={{ fontSize: 16 }}>MY LISTINGS · {myOpen.length}</span>} fontSize={16} />
          {myOpen.map((l) => {
            const sp = spec(l.itemId);
            const reserved = l.status === 'reserved';
            return (
              <div key={l.id} style={{ background: C.card, border: `2px solid ${C.border}`, padding: '7px 10px', display: 'flex', gap: 10, alignItems: 'center' }}>
                <MarketItemArt spec={sp} size={30} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: C.text, fontSize: 14 }}>{sp?.name ?? l.itemId}</div>
                  <div style={{ fontSize: 12, color: reserved ? C.goldHi : C.textFaint }}>
                    {reserved ? 'RESERVED — A BUYER IS PAYING' : 'LIVE'}
                  </div>
                </div>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: C.goldHi, fontSize: 15 }}>
                  <Icon name="sol" size={14} />{solStr(Number(l.priceLamports))}
                </span>
                <Btn variant="ghost" fontSize={13} disabled={!tradeReady || busy !== null || !v1 && reserved}
                  onClick={() => {
                    if (v1) {
                      if (l.baseId === undefined || l.cancelConsent?.version !== 1) { toast('REFRESH THE ORIGINAL LISTING CONSENT'); return; }
                      reviewRequest({ kind: 'cancel', listingId: l.id, itemId: l.itemId, name: sp?.name ?? l.itemId,
                        sourceBaseId: l.baseId, priceLamports: l.priceLamports, status: l.cancelConsent.status, reference: l.cancelConsent.reference });
                    } else act(l.id, () => legacyCommand(() => api.post(`/market/listings/${l.id}/cancel`)), 'DELISTED');
                  }}>
                  {v1 ? 'REVIEW CANCELLATION' : reserved ? 'LOCKED' : 'DELIST'}
                </Btn>
              </div>
            );
          })}
        </>
      )}

      <div style={{ color: C.textFaint, fontSize: 12, lineHeight: 1.5, paddingTop: 2 }}>
        The buyer pays the seller straight from their own wallet ({100 - feePct}%) plus a {feePct}% fee —
        SOL never pools in a game wallet. Your item is held while listed and changes hands the moment
        payment finalizes on-chain.
      </div>
    </div>
  );
}

export function MarketScreen(): React.JSX.Element {
  const { data: col } = useFetch<MarketCollectionDto>(() => api.get<MarketCollectionDto>('/market/collection'));
  const { data: mine } = useFetch<MarketAssetsDto>(() => api.get<MarketAssetsDto>('/market/assets'));
  const [tab, setTab] = useState<'MARKET' | 'COLLECTION'>('MARKET');
  const sellItemId = useApp((state) => state.marketSellItemId);
  const setSellItemId = useApp((state) => state.setMarketSellItemId);
  const tradingOpen = col?.tradingEnabled ?? false;
  const feePct = (col?.feeBps ?? 500) / 100;
  const assets = mine?.assets ?? [];

  return (
    // The wallet link returns to KEEP Wallet; direct navbar entry returns home.
    <ScrollPage title="MARKET" onClose={closeWalletMenu}
      tabs={
        <div style={{ display: 'flex', gap: 4, padding: '8px 10px 0', background: C.card }}>
          {(['MARKET', 'COLLECTION'] as const).map((t) => (
            <Btn key={t} variant={tab === t ? 'gold' : 'ghost'} fontSize={16} style={{ flex: 1, padding: '4px 8px 6px' }} onClick={() => { playSfx('sfx_tap'); setTab(t); }}>{t}</Btn>
          ))}
        </div>
      }>
      <WalletMenuBack />
      {tab === 'MARKET' ? (
        <ItemMarketTab sellItemId={sellItemId} onSellItemConsumed={() => setSellItemId(null)} />
      ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ color: C.textFaint, fontSize: 14, lineHeight: 1.5 }}>
          Your kingdom's on-chain assets — Land Deeds now, cosmetics later. They're
          real Metaplex Core NFTs that trade on Tensor and Magic Eden with a {feePct}%
          royalty. {tradingOpen
            ? 'Trading is live — list from your wallet or the links below.'
            : 'Deeds are soulbound until the liquidity event; trading and the links below go live at launch.'}
        </div>

        {/* Trading-status banner */}
        <Chip accent={tradingOpen ? C.goldDp : C.border}>
          <Icon name={tradingOpen ? 'keep' : 'shield'} size={20} />
          <span style={{ color: tradingOpen ? C.success : C.textDim, fontSize: 14 }}>
            {tradingOpen ? 'TRADING LIVE' : 'SOULBOUND — TRADING OPENS AT LAUNCH'}
          </span>
          <Sp />
          <span style={{ color: C.textFaint, fontSize: 13 }}>{feePct}% ROYALTY</span>
        </Chip>

        {/* Collection external links */}
        {col?.links && (
          <div style={{ background: C.card, border: `2px solid ${C.border}`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 14, color: C.gold, letterSpacing: '1px' }}>LAND DEEDS COLLECTION</span>
              <Sp />
              <span style={{ fontSize: 12, color: C.textFaint }}>{shortId(col.collection!)}</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <ExtLink href={col.links.tensor} label="TENSOR" disabled={!tradingOpen} />
              <ExtLink href={col.links.magicEden} label="MAGIC EDEN" disabled={!tradingOpen} />
            </div>
          </div>
        )}

        {/* Owned assets */}
        <Phead title={<span style={{ fontSize: 16 }}>MY ASSETS</span>} fontSize={16} />
        {assets.length === 0 ? (
          <div style={{ color: C.textFaint, fontSize: 14, textAlign: 'center', padding: '12px 0' }}>
            No tradable assets yet. Your Land Deed mints when you found your base.
          </div>
        ) : (
          assets.map((a) => (
            <div key={a.id} style={{ background: C.card, border: `2px solid ${C.border}`, padding: '8px 10px', display: 'flex', gap: 10, alignItems: 'center' }}>
              {a.image
                ? <img src={a.image} width={44} height={44} alt="" style={{ imageRendering: 'pixelated', border: `2px solid ${C.border}` }} />
                : <Sprite name={warePortraitAliasKey('keep', 1)} w={44} h={44} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: C.text, fontSize: 15 }}>{a.name}</div>
                <div style={{ color: C.textFaint, fontSize: 12 }}>
                  {a.kind === 'deed' ? 'LAND DEED' : 'COSMETIC'} · {shortId(a.id)}
                  {a.frozen && <span style={{ color: C.slate }}> · SOULBOUND</span>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <ExtLink href={a.links.tensor} label="TENSOR" disabled={a.frozen || !tradingOpen} />
                <ExtLink href={a.links.magicEden} label="ME" disabled={a.frozen || !tradingOpen} />
              </div>
            </div>
          ))
        )}
        {mine && !mine.dasConfigured && (
          <div style={{ color: C.stoneDark, fontSize: 12, textAlign: 'center', paddingTop: 4 }}>
            Live on-chain asset discovery activates at launch.
          </div>
        )}
      </div>
      )}
    </ScrollPage>
  );
}

/**
 * The KEEP pill opens this. For a deedless player land-backed money actions are
 * shut: BUY KEEP and DEPOSIT KEEP mint a non-`entry` deposit intent, which POST
 * /deposits refuses for an unpaid wallet (and refuses CODELESSLY, so the global
 * land handler never even fires — that path toasted a bare 'ENTRY NOT PAID'),
 * and WITHDRAW is `owned`. Auth-only KEEP→shards remains available because it
 * creates no withdrawable value and the server deliberately carries no land
 * gate. The read-only economy and market doors stay open as well.
 */
export function ExchangeScreen(): React.JSX.Element {
  const gemsEnabled = useApp(s => gemsAvailable(s.balances));
  const freshGems = phaseEWebEnabled() && gemsEnabled;
  const [recoverGems, setRecoverGems] = useState(freshGems);
  // A flag pause during receipt hydration must not unmount recovery mid-write.
  useEffect(() => { if (freshGems) setRecoverGems(true); }, [freshGems]);
  const landOwned = useLandOwned();
  if (freshGems || recoverGems) return <GemsWalletScreen />;
  if (gemsEnabled) return <GemsHeldBalance onRecovery={() => setRecoverGems(true)} />;
  if (!landOwned) return <ExchangeLockedScreen onGemsRecovery={() => setRecoverGems(true)} />;
  return <ExchangeOwnedScreen onGemsRecovery={() => setRecoverGems(true)} />;
}

function ExchangeLockedScreen({ onGemsRecovery }: { onGemsRecovery: () => void }): React.JSX.Element {
  const setScreen = useApp((s) => s.setScreen);
  const balances = useApp((s) => s.balances) as Balances | null;
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const { data } = useFetch<Balances>(
    () => api.get<Balances>(selectedBasePath('/balances')),
    [selectedBaseId],
  );
  return (
    <ModalWrap onBackdrop={home}>
      <Phead title="KEEP WALLET" onClose={home} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px' }}>
        <GemsRecoveryDoor onOpen={onGemsRecovery} />
        <KeepToShardsPanel balances={balances ?? data ?? null} />
        <LandLocked {...LAND_LOCKED.keepWallet} entryFeeSol={ECONOMY.entryFeeSol} onBuy={buyLand}>
          {/* All three are FREE, so they are offers, not traps. The security row
              keeps account security and key export reachable from the wallet as
              well as PROFILE, including for deedless players (security review F8). */}
          <Chip onClick={() => setScreen('economy')}>
            <Icon name="keep" size={22} /><span>KEEP ECONOMY</span><Sp /><span style={{ color: C.gold }}>›</span>
          </Chip>
          <Chip onClick={() => setScreen('market')}>
            <Icon name="shard" size={22} /><span>BROWSE THE MARKET</span><Sp /><span style={{ color: C.gold }}>›</span>
          </Chip>
          <Chip onClick={() => setScreen('security')}>
            <Icon name="shield" size={22} /><span>SECURITY &amp; KEY EXPORT</span><Sp /><span style={{ color: C.gold }}>›</span>
          </Chip>
        </LandLocked>
      </div>
      <div style={{ display: 'flex', gap: 10, padding: '0 14px 14px' }}>
        <Btn variant="ghost" style={{ flex: 1 }} onClick={home}>CLOSE</Btn>
      </div>
    </ModalWrap>
  );
}

export interface KeepConversionAttempt { amount: string; key: string }

/** Keep one idempotency key across retry of the same exact amount. Changing the
 * amount must create a new intent because the API rejects key/amount reuse. */
export function stableKeepConversionAttempt(
  current: KeepConversionAttempt | null,
  amount: string,
  key: () => string = idemKey,
): KeepConversionAttempt {
  return current?.amount === amount ? current : { amount, key: key() };
}

/** Auth-only, one-way currency conversion. It deliberately remains reachable
 * for deedless players: no Land Deed or Gold Forge is required to turn already
 * earned/deposited KEEP into the nonwithdrawable building currency. */
function KeepToShardsPanel({ balances }: { balances: Balances | null }): React.JSX.Element {
  const keep = BigInt(balances?.keep ?? '0');
  const shards = BigInt(balances?.shards ?? '0');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const retry = useRef<{ amount: string; key: string } | null>(null);
  const parsed = /^\d+$/.test(amount) ? BigInt(amount) : 0n;
  const valid = parsed > 0n && parsed <= keep;

  const convert = (): void => {
    if (busy || !valid) return;
    const exact = parsed.toString();
    const attempt = stableKeepConversionAttempt(retry.current, exact);
    retry.current = attempt;
    setBusy(true);
    void api.post<{ converted: string; shards: string; rate: number }>('/forge/convert', {
      keep: exact,
      idempotencyKey: attempt.key,
      ...withSelectedBase({}),
    }).then((res) => {
      retry.current = null;
      setAmount('');
      haptic('light');
      playSfx('sfx_confirm');
      toast(`${res.converted} KEEP CONVERTED TO ${res.shards} SHARDS`);
      return reloadBase();
    }).catch((e: Error) => failToast(e, e.message.toUpperCase()))
      .finally(() => setBusy(false));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, border: `2px solid ${C.goldDp}`, background: C.card, padding: '9px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="keep" size={20} /><span>{fmtN(Number(keep))} KEEP</span>
        <span style={{ color: C.gold }}>→ 1 KEEP = {balances?.keepRate ?? ECONOMY.shardsPerKeep} SHARDS →</span>
        <Icon name="shard" size={20} /><span>{fmtN(Number(shards))} SHARDS</span>
      </div>
      <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.35 }}>
        ONE-WAY: converted KEEP becomes building and troop currency. Shards cannot be withdrawn; only the capped Gold Forge can turn them back into KEEP.
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="interactive" value={amount} inputMode="numeric"
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="KEEP TO CONVERT"
          style={{ flex: 1, minWidth: 0, fontFamily: 'inherit', fontSize: 16, background: C.surface, color: C.text, border: `2px solid ${C.border}`, padding: '8px 10px' }} />
        <Btn fontSize={14} disabled={!valid || busy} onClick={convert}>
          {busy ? 'CONVERTING…' : 'CONVERT'}
        </Btn>
      </div>
    </div>
  );
}

function ExchangeOwnedScreen({ onGemsRecovery }: { onGemsRecovery: () => void }): React.JSX.Element {
  const balances = useApp((s) => s.balances) as Balances | null;
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const { data } = useFetch<Balances>(
    () => api.get<Balances>(selectedBasePath('/balances')),
    [selectedBaseId],
  );
  const bal = (balances ?? data) as Balances | null;
  const keep = bal ? Number(bal.keep) : 0; // dual-split: the HARD balance
  // Gold Forge entry — hidden while the forge is dark (probe 404s pre-split).
  const { forge } = useForgeStatus();

  return (
    <ModalWrap onBackdrop={home}>
      <Phead title="KEEP WALLET" onClose={home} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px' }}>
        <Chip><Icon name="keep" size={22} /><span>KEEP BALANCE</span><Sp /><span style={{ color: C.goldHi }}>{fmtN(keep)}</span></Chip>
        <GemsRecoveryDoor onOpen={onGemsRecovery} />
        <KeepToShardsPanel balances={bal} />
        <div style={{ color: C.stoneDark, fontSize: 14, textAlign: 'center', lineHeight: 1.35 }}>
          KEEP — Pixel Kingdom Gold — is the kingdom currency. Earn it in-game; move it on-chain.
          Withdrawing to your wallet burns a {(bal?.withdrawFeeBps ?? ECONOMY.withdrawFeeBps) / 100}% fee.
        </div>
        {/* No payment CTA until SOL→KEEP is backed by reserve KEEP in custody. */}
        <Phead title={<span style={{ fontSize: 17 }}>BUY KEEP WITH SOL</span>} fontSize={17} />
        <div style={{ color: C.textDim, fontSize: 14, textAlign: 'center', lineHeight: 1.4, border: `2px solid ${C.border}`, background: C.surface, padding: '9px 10px' }}>
          TEMPORARILY UNAVAILABLE · RESERVE-BACKED SALES ARE BEING PREPARED.
          NO SOL PAYMENT WILL BE REQUESTED.
        </div>
        <Chip accent={C.goldDp} onClick={() => useApp.getState().setScreen('deposit')}>
          <Icon name="keep" size={22} /><span>DEPOSIT KEEP ← WALLET</span><Sp /><span style={{ color: C.goldHi }}>›</span>
        </Chip>
        <Chip accent={C.goldDp} onClick={() => useApp.getState().setScreen('withdraw')}>
          <Icon name="sol" size={22} /><span>WITHDRAW KEEP → WALLET</span><Sp /><span style={{ color: C.goldHi }}>›</span>
        </Chip>
        {forge && (
          <Chip accent={C.goldDp} onClick={() => useApp.getState().setScreen('forge')}>
            <Icon name="streak" size={22} /><span>GOLD FORGE</span><Sp />
            <span style={{ color: C.goldHi, fontSize: 13 }}>{fmtN(Number(forge.totalShards))} SHARDS TODAY ›</span>
          </Chip>
        )}
        <Chip onClick={() => useApp.getState().setScreen('economy')}>
          <Icon name="keep" size={22} /><span>KEEP ECONOMY</span><Sp /><span style={{ color: C.gold }}>›</span>
        </Chip>
        <Chip accent={C.goldDp} onClick={() => useApp.getState().setScreen('market')}>
          <Icon name="shard" size={22} /><span>COLLECTION &amp; MARKET</span><Sp /><span style={{ color: C.goldHi }}>›</span>
        </Chip>
      </div>
      <div style={{ display: 'flex', gap: 10, padding: '0 14px 14px' }}>
        <Btn variant="ghost" style={{ flex: 1 }} onClick={home}>CLOSE</Btn>
      </div>
    </ModalWrap>
  );
}

// ===========================================================================
// KEEP ECONOMY — read-only transparency dashboard (owner 2026-07-19). Aggregates
// GET /economy/stats (the ledger) into pool health + mining flows + on-chain
// custody figures. No mutations; every number reconciles with the ledger.
// ===========================================================================

interface EconomyStatsDto {
  pool: { emissionPool: string; playPoolInitial: string; poolPct: number; circulating: string; withdrawalEscrow: string; forgePayoutEscrow: string; leagueEntitlementEscrow: string };
  keepFlows: { emittedTotal: string; emittedToday: string; recycledTotal: string; expiredReturnedTotal: string };
  shards: {
    circulating: string; forgeEscrow: string; clanChest: string; burned: string;
    walletCompatibility?: string; deedBalances?: string;
    legacyForgeEscrow?: string; deedForgeEscrow?: string;
    flows: {
      issuedTotal: string; minedTotal: string; minedToday: string; cacheClaimedTotal: string;
      starterGrantedTotal: string; convertedTotal: string; otherIssuedTotal: string;
    };
  };
  onchain: { withdrawnNet: string; withdrawnTotal: string; withdrawnToday: string; feesBurned: string; deposited: string };
  health: { netEmissionDrain: string };
}

export function EconomyScreen(): React.JSX.Element {
  const { data } = useFetch<EconomyStatsDto>(() => api.get<EconomyStatsDto>('/economy/stats'), []);
  const n = (s?: string): number => Number(s ?? 0);
  const { pool, keepFlows, shards, onchain: oc, health } = data ?? {};
  const drain = n(health?.netEmissionDrain);
  const Row = ({ label, value, color = C.text, sub }: { label: string; value: number; color?: string; sub?: string }): React.JSX.Element => (
    <Chip>
      <span style={{ color: C.textDim, fontSize: 15 }}>{label}</span><Sp />
      <span style={{ color, fontSize: 16 }}>{fmtN(value)}</span>
      {sub ? <span style={{ color: C.textFaint, fontSize: 13 }}>{sub}</span> : null}
    </Chip>
  );
  return (
    <ScrollPage title="KEEP ECONOMY" onClose={() => useApp.getState().setScreen('exchange')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Phead title={<span style={{ fontSize: 18 }}>KEEP POOL</span>} fontSize={18} />
        <Chip accent={C.goldDp}>
          <Icon name="keep" size={22} /><span>EMISSION POOL</span><Sp />
          <span style={{ color: C.goldHi, fontSize: 18 }}>{fmtN(n(pool?.emissionPool))}</span>
          {/* denominator from the SERVER's playPoolInitial (fetched above) —
              the old hardcoded "500M" would silently lie if the allocation
              ever changed in constants.ts. */}
          <span style={{ color: C.textFaint, fontSize: 13 }}>
            · {pool?.poolPct ?? 0}% of {pool ? `${Math.round(n(pool.playPoolInitial) / 1e6)}M` : '—'}
          </span>
        </Chip>
        <Row label="CIRCULATING (players)" value={n(pool?.circulating)} />
        <Row label="WITHDRAWAL ESCROW" value={n(pool?.withdrawalEscrow)} />
        <Row label="FORGE PAYOUT ESCROW" value={n(pool?.forgePayoutEscrow)} />
        <Row label="LEAGUE PRIZE ESCROW" value={n(pool?.leagueEntitlementEscrow)} />

        <Phead title={<span style={{ fontSize: 18 }}>KEEP FLOWS</span>} fontSize={18} />
        <Row label="EMITTED TODAY" value={n(keepFlows?.emittedToday)} color={C.goldHi} />
        <Row label="EMITTED (all-time)" value={n(keepFlows?.emittedTotal)} />
        <Row label="RECYCLED → POOL (sinks)" value={n(keepFlows?.recycledTotal)} color={C.success} />
        <Row label="EXPIRED ALLOCATIONS RETURNED" value={n(keepFlows?.expiredReturnedTotal)} />
        <Row label="NET KEEP EMISSION DRAIN" value={drain} color={drain > 0 ? C.danger : C.success}
          sub={drain > 0 ? '· pool shrinking' : '· pool healthy'} />

        <Phead title={<span style={{ fontSize: 18 }}>SHARDS ISSUANCE</span>} fontSize={18} />
        <Row label="CIRCULATING SHARDS" value={n(shards?.circulating)} />
        <Row label="MINED TODAY" value={n(shards?.flows.minedToday)} color={C.success} />
        <Row label="MINED (all-time)" value={n(shards?.flows.minedTotal)} />
        <Row label="DAILY CACHE CLAIMS" value={n(shards?.flows.cacheClaimedTotal)} />
        <Row label="STARTER GRANTS + TOP-UPS" value={n(shards?.flows.starterGrantedTotal)} />
        <Row label="KEEP CONVERSIONS" value={n(shards?.flows.convertedTotal)} />
        <Row label="OTHER SHARDS ISSUED" value={n(shards?.flows.otherIssuedTotal)} />
        <Row label="TOTAL SHARDS ISSUED" value={n(shards?.flows.issuedTotal)} />
        <Row label="SHARDS BURNED" value={n(shards?.burned)} color={C.textDim} />

        <Phead title={<span style={{ fontSize: 18 }}>ON-CHAIN (custody)</span>} fontSize={18} />
        <Row label="WITHDRAWN TODAY" value={n(oc?.withdrawnToday)} />
        <Row label="WITHDRAWN (net out)" value={n(oc?.withdrawnNet)} />
        <Row label="DEPOSITED (in)" value={n(oc?.deposited)} color={C.success} />
        <Row label="FEES BURNED" value={n(oc?.feesBurned)} color={C.textDim} />

        <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.4, padding: '4px 2px' }}>
          Quests award SHARDS. Gold Forge payouts, eligible Ruined Keep KEEP
          bounties and explicitly budgeted alpha rewards debit the single bounded
          gameplay emission pool. Deposits mirror player-owned KEEP in custody and
          never fund rewards. Withdrawals are the on-chain KEEP outflow.
        </div>
      </div>
    </ScrollPage>
  );
}

// ===========================================================================
// WITHDRAW — KEEP → wallet (POST/GET/cancel /withdrawals). Server is
// authoritative on the fee, personal limit and unbonding; the client only requests and
// lists. All shown numbers come from ECONOMY / live server state.
// ===========================================================================

export interface WithdrawalRow {
  id: string; status: string; amount: string; feeBurned: string;
  unbondsAt: string | null; txSignature: string | null; refundable: boolean;
  /** M23 a4 track record — optional so a client rolled forward of the API
   *  (or vice versa) renders the short row instead of crashing. */
  netAmount?: string; destination?: string; mint?: string | null;
  createdAt?: string; completedAt?: string | null;
}

export interface WithdrawalStatus {
  personalDailyLimitKeep: string;
  personalDailyUsedKeep: string;
  personalDailyRemainingKeep: string;
  governingKeepLevel: number;
  nextAvailableAt: string | null;
}

export function personalWithdrawalCooldownActive(
  status: Pick<WithdrawalStatus, 'nextAvailableAt'> | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!status?.nextAvailableAt) return false;
  const nextAt = Date.parse(status.nextAvailableAt);
  return !Number.isFinite(nextAt) || nextAt > nowMs;
}

export function personalWithdrawalMax(
  keepBalance: number,
  status: Pick<WithdrawalStatus, 'personalDailyRemainingKeep' | 'nextAvailableAt'> | null | undefined,
  nowMs = Date.now(),
): number {
  if (!status) return 0;
  if (personalWithdrawalCooldownActive(status, nowMs)) return 0;
  const remaining = Number(status.personalDailyRemainingKeep);
  if (!Number.isFinite(remaining) || remaining < 0) return 0;
  return Math.min(Math.max(0, keepBalance), remaining);
}

// Match the production worker cadence. Faster polling cannot make a payout
// settle sooner and only turns a reserve/RPC hold into a request loop.
const WITHDRAWAL_STATUS_POLL_MS = 10_000;

/** An immediately-due row is an instant payout waiting for the isolated worker;
 * a claimed row is processing regardless of whether it began as standard or
 * instant. Neither should be described as a fresh 24h unbonding request. */
export function isWithdrawalPayoutPending(
  row: Pick<WithdrawalRow, 'status' | 'unbondsAt'>,
  nowMs = Date.now(),
): boolean {
  if (row.status === 'processing') return true;
  if (row.status !== 'unbonding' || !row.unbondsAt) return false;
  const dueAt = Date.parse(row.unbondsAt);
  return Number.isFinite(dueAt) && dueAt <= nowMs;
}

export function withdrawalDisplayStatus(
  row: Pick<WithdrawalRow, 'status' | 'unbondsAt'>,
  nowMs = Date.now(),
): string {
  if (row.status === 'processing') return 'PROCESSING';
  if (row.status === 'unbonding' && isWithdrawalPayoutPending(row, nowMs)) return 'PAYOUT QUEUED';
  return row.status.toUpperCase();
}

export function withdrawalSubmitToast(status: string, instant: boolean): string {
  if (status === 'sent') return 'WITHDRAWAL SENT ✓';
  if (status === 'failed') return 'WITHDRAWAL PAYOUT FAILED · REVIEW REQUIRED';
  if (instant || status === 'processing') return 'INSTANT WITHDRAWAL QUEUED FOR PAYOUT';
  return `WITHDRAWAL REQUESTED · UNBONDING ${ECONOMY.unbondingHours}H`;
}

type PreparedWithdrawal = WithdrawalRecentAuthIntent;

/** Withdrawal 2FA status (server): which methods are enrolled + instant unlock. */
export interface TwoFaStatus {
  totpEnabled: boolean;
  emailVerified: boolean;
  email: string | null;
  pendingEmail: string | null;
  totpReady: boolean;
  totpReadyAt: string | null;
  instantEligible: boolean;
  instantWithdrawalsEnabled: boolean;
  reenrollmentRequired?: boolean;
  recovery?: {
    recoveryId: string | null;
    status: 'email_pending' | 'holding' | 'cancelled' | 'completed' | 'expired' | null;
    readyAt: string | null;
    expiresAt: string | null;
    reenrollmentRequired: boolean;
    receipt?: {
      cancelledWithdrawals: number;
      inFlightWithdrawals: number;
      refundedKeep: string;
    } | null;
  };
  recoveryEnabled?: boolean;
  loginTotpRequired?: boolean;
}

export type InstantWithdrawalUiState =
  | 'authenticator_not_configured'
  | 'maturing'
  | 'unavailable'
  | 'available_off'
  | 'available_on';

/** A mature authenticator is necessary but not sufficient: the API's live
 * operational switch must also be on. Instant stays opt-in per request. */
export function instantWithdrawalUiState(
  status: Pick<TwoFaStatus,
    'totpEnabled' | 'totpReady' | 'totpReadyAt' | 'instantEligible' | 'instantWithdrawalsEnabled'>
    | null | undefined,
  requested: boolean,
): InstantWithdrawalUiState {
  if (!status?.totpEnabled) return 'authenticator_not_configured';
  if (!status.totpReady && status.totpReadyAt) return 'maturing';
  if (!status.totpReady || !status.instantEligible || !status.instantWithdrawalsEnabled) return 'unavailable';
  return requested ? 'available_on' : 'available_off';
}

export function TwoFaStatusNotice({
  loading, error, onRetry,
}: { loading: boolean; error: string | null; onRetry: () => void }): React.JSX.Element {
  if (loading) {
    return <Chip><Icon name="shield" size={20} /><span style={{ color: C.textFaint }}>CHECKING 2FA STATUS…</span></Chip>;
  }
  return (
    <Chip style={{ flexWrap: 'wrap' }}>
      <Icon name="shield" size={20} />
      <span style={{ color: C.danger }}>SECURITY STATUS UNAVAILABLE</span>
      <span style={{ color: C.textFaint, fontSize: 13 }}>{error ? '· try again' : '· no status returned'}</span>
      <Sp />
      <Btn variant="ghost" fontSize={13} style={{ padding: '3px 8px 5px' }} onClick={onRetry}>RETRY</Btn>
    </Chip>
  );
}

export interface WithdrawalIntentDraft {
  amount: string;
  destination: string;
  method: 'totp';
  instant: boolean;
}

export interface StableWithdrawalIntent {
  amount: string;
  destination: string;
  idempotencyKey: string;
  /** Includes presentation choices that change the eventual request. */
  fingerprint: string;
}

/** One request identity per exact, normalized form intent. Retries and the
 * prepare/proof/code/final chain share it; changing any input mints a new one. */
export function stableWithdrawalIntent(
  previous: StableWithdrawalIntent | null,
  draft: WithdrawalIntentDraft,
  makeKey: () => string = idemKey,
): StableWithdrawalIntent {
  const amount = draft.amount;
  const destination = draft.destination.trim();
  const fingerprint = JSON.stringify([amount, destination, draft.method, draft.instant]);
  if (previous?.fingerprint === fingerprint) return previous;
  return { amount, destination, idempotencyKey: makeKey(), fingerprint };
}

export function emailEnrollmentStepUp(
  status: Pick<TwoFaStatus, 'totpEnabled' | 'emailVerified'> | null | undefined,
  code: string,
): { method: 'totp' | 'email'; code: string } | undefined {
  if (status?.totpEnabled) return { method: 'totp', code: code.trim() };
  if (status?.emailVerified) return { method: 'email', code: code.trim() };
  return undefined;
}

export function AccountSecuritySetting({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  return (
    <Chip onClick={onOpen}>
      <Icon name="shield" size={22} /><span>ACCOUNT EMAIL &amp; 2FA</span><Sp />
      <span style={{ color: C.textFaint }}>MANAGE ›</span>
    </Chip>
  );
}

/** Shared style for the 2FA / destination inputs. */
const FIELD_STYLE: React.CSSProperties = {
  fontFamily: 'inherit', fontSize: 16, background: C.surface, color: C.text,
  border: `2px solid ${C.border}`, padding: '8px 10px', width: '100%',
};
const CODE_STYLE: React.CSSProperties = {
  ...FIELD_STYLE,
  minHeight: 44,
  textAlign: 'center',
  letterSpacing: '4px',
  fontSize: 20,
};

/**
 * Creating a withdrawal is `owned`; listing and unwinding the caller's existing
 * rows are auth-only so selling a deed cannot strand already-escrowed KEEP.
 * Account security and
 * /2fa/status are auth-only and deliberately remain reachable without a deed.
 *
 * The locked state keeps ONE door open on purpose: SECURITY & KEY EXPORT. This
 * row is an entry point to SecurityScreen, which hosts private-key export, a
 * custody right that is NOT land-gated
 * (POST /auth/export/challenge is auth-only). Closing this screen wholesale would
 * have made a deedless wallet's own key unreachable from the UI.
 */
export function WithdrawScreen(): React.JSX.Element {
  const landOwned = useLandOwned();
  if (!landOwned) {
    return (
      <ScrollPage title="WITHDRAW KEEP" onClose={() => useApp.getState().setScreen('exchange')}>
        <LandLocked {...LAND_LOCKED.withdraw} entryFeeSol={ECONOMY.entryFeeSol} onBuy={buyLand}>
          <Chip onClick={() => useApp.getState().setScreen('security')}>
            <Icon name="shield" size={20} />
            <span style={{ fontSize: 14, color: C.textDim }}>SECURITY &amp; KEY EXPORT</span>
            <Sp /><span style={{ color: C.gold, fontSize: 14 }}>›</span>
          </Chip>
        </LandLocked>
        <WithdrawalHistory />
      </ScrollPage>
    );
  }
  return <WithdrawOwnedScreen />;
}

function WithdrawOwnedScreen(): React.JSX.Element {
  const { proveWithdrawal } = useRecentAuth();
  const balances = useApp((s) => s.balances) as Balances | null;
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const { data: balData } = useFetch<Balances>(
    () => api.get<Balances>(selectedBasePath('/balances')),
    [selectedBaseId],
  );
  const bal = (balances ?? balData) as Balances | null;
  const keep = bal ? Number(bal.keep) : 0; // withdrawals move the HARD balance
  const {
    data: twofa, loading: twofaLoading, error: twofaError, reload: reloadTwofa,
  } = useFetch<TwoFaStatus>(() => api.get<TwoFaStatus>('/2fa/status'));
  const {
    data: withdrawalStatus, loading: limitLoading, error: limitError, reload: reloadLimit,
  } = useFetch<WithdrawalStatus>(() => api.get<WithdrawalStatus>('/withdrawals/status'));
  const myWallet = useApp((s) => s.wallet) ?? '';
  const [amt, setAmt] = useState(0);
  // Destination defaults to the player's OWN connected wallet, but stays fully
  // editable so KEEP can be sent to a different wallet (owner 2026-07-19).
  const [dest, setDest] = useState(() => useApp.getState().wallet ?? '');
  const [busy, setBusy] = useState(false);
  const [custodyHeld, setCustodyHeld] = useState(false);
  // Instant (2FA) withdrawal: skip the 24h unbonding by re-proving ownership.
  const [instant, setInstant] = useState(false);
  const [code, setCode] = useState('');
  const intentRef = useRef<StableWithdrawalIntent | null>(null);
  const grantRef = useRef<{
    fingerprint: string;
    grant: string;
    proof: WithdrawalWalletProof;
  } | null>(null);
  const [prepared, setPrepared] = useState<(PreparedWithdrawal & { fingerprint: string }) | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);

  const min = ECONOMY.minWithdrawKeep;
  const feeBps = bal?.withdrawFeeBps ?? ECONOMY.withdrawFeeBps;
  const feeEst = Math.floor((amt * feeBps) / 10_000);
  const receiveEst = Math.max(0, amt - feeEst);
  // The server resolves the strongest active paid base under the same ownership
  // policy used at withdrawal admission. Never infer this from the selected base.
  const verifiedWithdrawalStatus = limitLoading || limitError ? null : withdrawalStatus;
  const cooldownActive = personalWithdrawalCooldownActive(verifiedWithdrawalStatus);
  const maxWithdrawable = personalWithdrawalMax(keep, verifiedWithdrawalStatus);
  const overPersonalLimit = amt > maxWithdrawable;
  const resetIntentAuth = (): void => {
    setCode(''); setPrepared(null); grantRef.current = null;
  };
  const set = (n: number): void => {
    const next = Math.max(0, Math.min(keep, Math.floor(n)));
    if (next !== amt) resetIntentAuth();
    setAmt(next);
  };
  // Free-text amount entry keeps only digits and clamps to the balance. The
  // personal daily limit remains visible as a warning rather than changing text.
  const onAmtInput = (v: string): void => {
    const n = parseInt(v.replace(/[^0-9]/g, ''), 10);
    const next = Number.isFinite(n) ? Math.min(keep, n) : 0;
    if (next !== amt) resetIntentAuth();
    setAmt(next);
  };
  const onDestinationInput = (value: string): void => {
    if (value.trim() !== dest.trim()) resetIntentAuth();
    setDest(value);
  };

  // Instant custody is deliberately TOTP-only. The server cannot distinguish a
  // Privy email-login proof from an independent mailbox factor, so email remains
  // an account contact/recovery proof and never shortens the custody hold.
  const verifiedTwoFa = twofaLoading || twofaError ? null : twofa;
  const instantState = instantWithdrawalUiState(verifiedTwoFa, instant);
  const useInstant = instantState === 'available_on';
  useEffect(() => {
    if (instantState === 'available_off' || instantState === 'available_on') return;
    // A retained useFetch snapshot must not silently re-arm an instant request
    // after an operational-status error or maturity/availability change.
    setInstant(false); setCode(''); setPrepared(null); grantRef.current = null;
  }, [instantState]);

  const intent = stableWithdrawalIntent(intentRef.current, {
    amount: String(amt), destination: dest, method: 'totp', instant: useInstant,
  });
  intentRef.current = intent;
  const validateIntent = (): boolean => {
    if (amt < min) { toast(`MIN WITHDRAWAL ${fmtN(min)} KEEP`); return false; }
    if (amt > keep) { toast('NOT ENOUGH KEEP'); return false; }
    if (dest.trim().length < 32) { toast('ENTER A VALID WALLET ADDRESS'); return false; }
    return true;
  };

  const prepareIntent = async (): Promise<PreparedWithdrawal> => {
    const quote = await api.postRaw<PreparedWithdrawal>('/withdrawals/prepare', {
      amount: intent.amount,
      destination: intent.destination,
      idempotencyKey: intent.idempotencyKey,
      ...(useInstant ? { instant: true } : {}),
    });
    if (quote.version !== 1 || quote.grossAmount !== intent.amount
      || quote.cluster !== SOLANA_CLUSTER || quote.keepMint !== KEEP_MINT
      || quote.destination !== intent.destination
      || quote.idempotencyKey !== intent.idempotencyKey
      || quote.mode !== (useInstant ? 'instant' : 'standard')
      || intentRef.current?.fingerprint !== intent.fingerprint) {
      throw new Error('Withdrawal details changed. Review the current request and try again.');
    }
    setPrepared({ ...quote, fingerprint: intent.fingerprint });
    return quote;
  };

  const proveIntent = async (quote: PreparedWithdrawal): Promise<{
    grant: string;
    proof: WithdrawalWalletProof;
  }> => {
    if (grantRef.current?.fingerprint === intent.fingerprint) return grantRef.current;
    const authorization = await proveWithdrawal(quote);
    if (intentRef.current?.fingerprint !== intent.fingerprint) {
      throw new Error('Withdrawal details changed. Confirm the current request again.');
    }
    grantRef.current = { fingerprint: intent.fingerprint, ...authorization };
    return authorization;
  };

  const submit = (): void => {
    if (busy || custodyHeld) return;
    if (!validateIntent()) return;
    const body: Record<string, unknown> = {
      amount: intent.amount,
      destination: intent.destination,
      idempotencyKey: intent.idempotencyKey,
    };
    if (useInstant) {
      if (code.trim().length < 6) { toast('ENTER YOUR 2FA CODE'); return; }
      body['instant'] = true; body['method'] = 'totp'; body['code'] = code.trim();
    }
    setBusy(true);
    void prepareIntent()
      .then(async (quote) => {
        const authorization = await proveIntent(quote);
        body['authorization'] = authorization.proof;
        return api.postRecent<{ id: string; status: string }>(
          '/withdrawals', body, authorization.grant,
        );
      })
      .then((r) => {
        playSfx('sfx_confirm'); haptic('light');
        toast(withdrawalSubmitToast(r.status, useInstant));
        setAmt(0); setDest(myWallet); setCode(''); setPrepared(null); grantRef.current = null;
        setHistoryVersion((version) => version + 1);
        return reloadBase();
      })
      .catch(async (e: Error) => {
        const { refreshCustodyRefusal } = await import('../../lib/phaseERefusals');
        await refreshCustodyRefusal(e, () => { setCustodyHeld(true); resetIntentAuth(); }, async () => { reloadLimit(); await reloadBase(); });
        failToast(e, e.message);
      })
      .finally(() => setBusy(false));
  };

  return (
    <ScrollPage title="WITHDRAW KEEP" onClose={() => useApp.getState().setScreen('exchange')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Chip><Icon name="keep" size={22} /><span>KEEP BALANCE</span><Sp /><span style={{ color: C.goldHi }}>{fmtN(keep)}</span></Chip>

        {/* A recovery hold is announced BEFORE the server refuses the request
            (D-098). The DTO is the authority: the button stays live so a stale
            snapshot can never block a withdrawal the server would accept. */}
        {twofa?.recovery?.status === 'holding' && (
          <Chip accent={C.blood} style={{ flexWrap: 'wrap' }} onClick={() => useApp.getState().setScreen('security')}>
            <Icon name="shield" size={20} />
            <span style={{ fontSize: 14, color: C.danger }}>
              AUTHENTICATOR RECOVERY HOLD · NEW WITHDRAWALS LOCKED UNTIL {twofa.recovery.readyAt ? new Date(twofa.recovery.readyAt).toLocaleString() : 'THE HOLD ENDS'}
            </span>
            <Sp /><span style={{ color: C.gold, fontSize: 14 }}>›</span>
          </Chip>
        )}

        {/* Amount — a real typeable field plus quick-set buttons (owner 2026-07-19:
            the display-only value was inconvenient to edit). Percentages are of the
            max withdrawable now = min(balance, the player's daily limit). */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="keep" size={22} />
            <input className="interactive" inputMode="numeric" value={amt ? String(amt) : ''}
              onChange={(e) => onAmtInput(e.target.value)} placeholder="0"
              style={{ ...FIELD_STYLE, fontSize: 24, textAlign: 'right', color: overPersonalLimit && !cooldownActive ? C.danger : C.text }} />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Btn variant="sec" fontSize={14} style={{ padding: '4px 9px 6px' }} onClick={() => set(min)}>MIN</Btn>
            <Btn variant="sec" fontSize={14} style={{ padding: '4px 9px 6px' }} onClick={() => set(maxWithdrawable * 0.25)}>25%</Btn>
            <Btn variant="sec" fontSize={14} style={{ padding: '4px 9px 6px' }} onClick={() => set(maxWithdrawable * 0.5)}>50%</Btn>
            <Btn variant="sec" fontSize={14} style={{ padding: '4px 9px 6px' }} onClick={() => set(maxWithdrawable)}>MAX</Btn>
            <Btn variant="sec" fontSize={14} style={{ padding: '4px 9px 6px' }} onClick={() => set(0)}>✕</Btn>
          </div>
        </div>

        {/* Destination — defaults to the player's own wallet; editable to any other
            wallet, with a one-tap reset back to self. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <input className="interactive" value={dest} onChange={(e) => onDestinationInput(e.target.value)} placeholder="DESTINATION WALLET ADDRESS"
            style={{ ...FIELD_STYLE, fontSize: 15 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.textFaint }}>
            <span>{dest.trim() === myWallet ? 'SENDING TO YOUR WALLET' : 'SENDING TO A DIFFERENT WALLET'}</span>
            <Sp />
            {myWallet && dest.trim() !== myWallet && (
              <Btn variant="ghost" fontSize={13} style={{ padding: '2px 8px 4px' }} onClick={() => onDestinationInput(myWallet)}>MY WALLET</Btn>
            )}
          </div>
        </div>

        {/* Instant is opt-in per request and only armable while the server says
            the mature authenticator rail is operational. */}
        {twofaError || !twofa ? (
          <TwoFaStatusNotice loading={twofaLoading} error={twofaError} onRetry={reloadTwofa} />
        ) : instantState === 'available_off' || instantState === 'available_on' ? (
          <Chip style={{ padding: '8px 10px' }}>
            <Icon name="shield" size={20} />
            <span style={{ fontSize: 15, color: useInstant ? C.success : C.text }}>
              {useInstant ? 'INSTANT ON FOR THIS REQUEST' : 'INSTANT AVAILABLE · OFF FOR THIS REQUEST'}
            </span>
            <span style={{ fontSize: 13, color: C.textFaint }}>· authenticator enabled · skip {ECONOMY.unbondingHours}h when on</span>
            <Sp />
            <Switch on={useInstant} onClick={() => { resetIntentAuth(); setInstant((v) => !v); }} />
          </Chip>
        ) : instantState === 'maturing' ? (
          <Chip onClick={() => useApp.getState().setScreen('security')}>
            <Icon name="shield" size={20} />
            <span style={{ fontSize: 14, color: C.gold }}>
              AUTHENTICATOR ENABLED · INSTANT MATURING UNTIL {new Date(twofa.totpReadyAt!).toLocaleString()} · STANDARD WITHDRAWALS AVAILABLE
            </span>
            <Sp /><span style={{ color: C.gold, fontSize: 14 }}>›</span>
          </Chip>
        ) : instantState === 'unavailable' ? (
          <Chip onClick={() => useApp.getState().setScreen('security')}>
            <Icon name="shield" size={20} />
            <span style={{ fontSize: 14, color: C.textDim }}>
              AUTHENTICATOR ENABLED · INSTANT TEMPORARILY UNAVAILABLE · STANDARD WITHDRAWALS AVAILABLE
            </span>
            <Sp /><span style={{ color: C.gold, fontSize: 14 }}>›</span>
          </Chip>
        ) : (
          <Chip onClick={() => useApp.getState().setScreen('security')}>
            <Icon name="shield" size={20} />
            <span style={{ fontSize: 14, color: C.textDim }}>SET UP 2FA FOR INSTANT WITHDRAWALS</span>
            <Sp /><span style={{ color: C.gold, fontSize: 14 }}>›</span>
          </Chip>
        )}

        {/* Keep account security and key export reachable here after enrollment;
            the setup chip above vanishes once a factor is active. */}
        {instantState !== 'authenticator_not_configured' && (
          <Chip onClick={() => useApp.getState().setScreen('security')}>
            <Icon name="shield" size={20} />
            <span style={{ fontSize: 14, color: C.textDim }}>SECURITY & KEY EXPORT</span>
            <Sp /><span style={{ color: C.gold, fontSize: 14 }}>›</span>
          </Chip>
        )}

        {/* 2FA code entry when instant is armed. The prompt itself says where a
            lost authenticator goes and that the standard rail never needs the
            code — a custody safeguard nobody can find reads as a lockout (D-098). */}
        {useInstant && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input className="interactive" value={code} onChange={(e) => setCode(e.target.value)}
              placeholder="AUTHENTICATOR CODE" inputMode="numeric" style={CODE_STYLE} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, color: C.textFaint }}>
              <span>STANDARD WITHDRAWALS NEVER NEED THIS CODE</span>
              <Sp />
              <Btn variant="ghost" fontSize={13} style={{ padding: '2px 8px 4px' }}
                onClick={() => useApp.getState().setScreen('security')}>
                LOST AUTHENTICATOR?
              </Btn>
            </div>
          </div>
        )}

        {limitLoading ? (
          <Chip><Icon name="keep" size={20} /><span style={{ color: C.textFaint }}>CHECKING YOUR WITHDRAWAL LIMIT…</span></Chip>
        ) : limitError || !withdrawalStatus ? (
          <Chip style={{ flexWrap: 'wrap' }}>
            <Icon name="keep" size={20} /><span style={{ color: C.danger }}>YOUR WITHDRAWAL LIMIT IS UNAVAILABLE</span>
            <span style={{ color: C.textFaint, fontSize: 13 }}>· withdrawal is paused until it can be verified</span>
            <Sp /><Btn variant="ghost" fontSize={13} style={{ padding: '3px 8px 5px' }} onClick={reloadLimit}>RETRY</Btn>
          </Chip>
        ) : (
          <div style={{ color: overPersonalLimit && !cooldownActive ? C.danger : C.textFaint, fontSize: 13 }}>
            MAX {fmtN(maxWithdrawable)} NOW · YOUR DAILY LIMIT {fmtN(Number(withdrawalStatus.personalDailyLimitKeep))} KEEP
            {' '}· {fmtN(Number(withdrawalStatus.personalDailyRemainingKeep))} REMAINING
            {' '}· GOVERNING ACTIVE PAID BASE KEEP L{withdrawalStatus.governingKeepLevel} · 24H COOLDOWN
            {withdrawalStatus.nextAvailableAt
              ? ` · NEXT ${new Date(withdrawalStatus.nextAvailableAt).toLocaleString()}` : ''}
            {cooldownActive ? ' · COOLDOWN ACTIVE' : ''}
            {overPersonalLimit && !cooldownActive ? (amt > keep ? ' · NOT ENOUGH KEEP' : ' · ABOVE YOUR DAILY LIMIT') : ''}
          </div>
        )}
        <div style={{ color: C.textFaint, fontSize: 14, lineHeight: 1.4 }}>
          MIN {fmtN(min)} KEEP · {feeBps / 100}% FEE BURNED (≈{fmtN(feeEst)}) · YOU RECEIVE ≈{fmtN(receiveEst)}
          {useInstant ? ' · INSTANT (2FA)' : ` · FROZEN ${ECONOMY.unbondingHours}H UNBONDING (CANCELLABLE)`}
        </div>
        <Chip style={{ alignItems: 'flex-start', flexWrap: 'wrap', fontSize: 13 }}>
          <span>REVIEW</span>
          <span style={{ color: C.textFaint }}>AMOUNT {prepared?.fingerprint === intent.fingerprint ? prepared.grossAmount : intent.amount} KEEP</span>
          <span style={{ color: C.textFaint, wordBreak: 'break-all' }}>DEST {intent.destination || '—'}</span>
          <span style={{ color: C.danger }}>FEE {prepared?.fingerprint === intent.fingerprint ? prepared.feeBurned : String(feeEst)}</span>
          <span style={{ color: C.success }}>NET {prepared?.fingerprint === intent.fingerprint ? prepared.netAmount : String(receiveEst)}</span>
        </Chip>
        <Btn disabled={busy || custodyHeld || !verifiedWithdrawalStatus || amt < min || overPersonalLimit} onClick={submit}>
          <Icon name={useInstant ? 'shield' : 'sol'} size={20} />{useInstant ? 'WITHDRAW INSTANTLY' : 'WITHDRAW'}
        </Btn>

        <WithdrawalHistory refreshToken={historyVersion} />
      </div>
    </ScrollPage>
  );
}

/** "Sep 16 14:05" for a history row; null for a missing or unparsable stamp. */
const shortDate = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};

/** Caller-scoped recovery/history surface. Deliberately independent of land:
 * an owner may sell their deed while KEEP is still queued or awaiting an
 * audited refund, and custody rights must survive that gameplay transition. */
export function WithdrawalHistory({ refreshToken = 0 }: { refreshToken?: number }): React.JSX.Element | null {
  const { data: list, loading, reload } = useFetch<{ withdrawals: WithdrawalRow[] }>(
    () => api.get<{ withdrawals: WithdrawalRow[] }>('/withdrawals'),
    [refreshToken],
  );
  const myWallet = useApp((s) => s.wallet);
  const hasPendingPayout = list?.withdrawals.some((w) => isWithdrawalPayoutPending(w)) ?? false;
  useEffect(() => {
    if (!hasPendingPayout) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) reload();
    }, WITHDRAWAL_STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasPendingPayout, reload]);

  const cancel = (id: string): void => {
    void api.post(`/withdrawals/${id}/cancel`)
      .then(() => { toast('WITHDRAWAL CANCELLED'); reload(); return reloadBase(); })
      .catch((e: Error) => toast(e.message));
  };
  const refund = (id: string): void => {
    void api.post(`/withdrawals/${id}/refund`)
      .then(() => { toast('WITHDRAWAL REFUNDED'); reload(); return reloadBase(); })
      .catch((e: Error) => toast(e.message));
  };

  if (!list) {
    if (loading) {
      return <Chip><Icon name="keep" size={20} /><span style={{ color: C.textFaint }}>CHECKING WITHDRAWAL HISTORY…</span></Chip>;
    }
    return (
      <Chip style={{ flexWrap: 'wrap' }}>
        <Icon name="keep" size={20} /><span style={{ color: C.danger }}>WITHDRAWAL HISTORY UNAVAILABLE</span>
        <Sp /><Btn variant="ghost" fontSize={13} style={{ padding: '3px 8px 5px' }} onClick={reload}>RETRY</Btn>
      </Chip>
    );
  }
  if (!list.withdrawals.length) return null;
  const copyText = (label: string, value: string): void => {
    void navigator.clipboard?.writeText(value)
      .then(() => toast(`${label} COPIED`))
      .catch(() => toast('COPY FAILED — LONG-PRESS THE TEXT'));
  };
  return (
    <>
      <Phead title={<span style={{ fontSize: 19 }}>WITHDRAWALS</span>} fontSize={19} />
      {list.withdrawals.map((w) => (
        // Full track record per row (M23 a4): request time, destination, fee →
        // net, and for a PAID row the on-chain signature with copy + explorer.
        <div key={w.id} style={{ background: C.card, border: `2px solid ${C.border}`, padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <Icon name="keep" size={20} /><span style={{ fontSize: 16 }}>{fmtN(w.amount)}</span>
            <span style={{ fontSize: 13, color: C.textFaint }}>· {withdrawalDisplayStatus(w)}</span>
            {shortDate(w.createdAt) && <span style={{ fontSize: 12, color: C.textFaint }}>· {shortDate(w.createdAt)}</span>}
            <Sp />
            {w.status === 'unbonding' ? (
              <Btn variant="ghost" fontSize={13} style={{ padding: '3px 8px 5px' }} onClick={() => cancel(w.id)}>CANCEL</Btn>
            ) : w.status === 'failed' && w.refundable ? (
              <Btn variant="ghost" fontSize={13} style={{ padding: '3px 8px 5px' }} onClick={() => refund(w.id)}>REFUND</Btn>
            ) : w.status === 'failed' ? (
              // A failed, non-refundable payout is money the player cannot
              // unwind alone; the row carries a real address with the id
              // support needs, not a sentence (D-098).
              <a className="interactive" href={supportMailto(supportSubject(`Failed withdrawal ${w.id}`, myWallet))}
                style={{ color: C.gold, fontSize: 13 }}>CONTACT SUPPORT</a>
            ) : w.status === 'sent' && w.txSignature ? (
              <span style={{ color: C.success, fontSize: 13 }}>PAID{shortDate(w.completedAt) ? ` · ${shortDate(w.completedAt)}` : ''}</span>
            ) : null}
          </div>
          {(w.destination || w.netAmount) && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: C.textFaint }}>
              {w.netAmount && <span>NET {fmtN(w.netAmount)} (FEE {fmtN(w.feeBurned)})</span>}
              {w.destination && (
                <span className="copyable interactive" style={{ cursor: 'pointer' }} title={w.destination}
                  onClick={() => copyText('DESTINATION', w.destination!)}>
                  → {w.destination.slice(0, 4)}…{w.destination.slice(-4)} ⧉
                </span>
              )}
            </div>
          )}
          {w.txSignature && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
              <span className="copyable interactive" style={{ color: C.sky, cursor: 'pointer' }} title={w.txSignature}
                onClick={() => copyText('SIGNATURE', w.txSignature!)}>
                TX {w.txSignature.slice(0, 8)}…{w.txSignature.slice(-8)} ⧉
              </span>
              <a className="interactive" style={{ color: C.sky, fontSize: 12 }}
                href={explorerUrl('tx', w.txSignature)}
                target="_blank" rel="noreferrer">EXPLORER ↗</a>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

// ===========================================================================
// DEPOSIT — KEEP wallet → play balance (owner 2026-07-19). The inbound mirror of
// WITHDRAW: the wallet signs an SPL transfer to custody, the server verifies the
// finalized tx and credits the ledger. All hooks stay above any early return.
// ===========================================================================

/** GET /wallet/keep-deposits row (apps/api money/deposits.ts listKeepDeposits). */
interface KeepDepositRow {
  id: string; status: 'pending' | 'finalized' | 'credited' | 'expired' | 'failed';
  amount: string | null; amountKeep: string | null; txSignature: string | null;
  createdAt: string; finalizedAt: string | null;
}

/** RECENT DEPOSITS on the DEPOSIT KEEP page (tester request 2026-09-16). The
 * caller's own custody inflows, newest first, quoting the server's whole-KEEP
 * figure — never a client conversion of base units. Mirrors WithdrawalHistory
 * minus its actions: a deposit has nothing to cancel or refund. */
function KeepDepositHistory({ refreshToken = 0 }: { refreshToken?: number }): React.JSX.Element {
  const { data, loading, reload } = useFetch<{ deposits: KeepDepositRow[] }>(
    () => api.get<{ deposits: KeepDepositRow[] }>('/wallet/keep-deposits'),
    [refreshToken],
  );
  if (!data) {
    if (loading) return <Chip><Icon name="keep" size={20} /><span style={{ color: C.textFaint }}>CHECKING RECENT DEPOSITS…</span></Chip>;
    return (
      <Chip style={{ flexWrap: 'wrap' }}>
        <Icon name="keep" size={20} /><span style={{ color: C.danger }}>RECENT DEPOSITS UNAVAILABLE</span>
        <Sp /><Btn variant="ghost" fontSize={13} style={{ padding: '3px 8px 5px' }} onClick={reload}>RETRY</Btn>
      </Chip>
    );
  }
  return (
    <>
      <Phead title={<span style={{ fontSize: 19 }}>RECENT DEPOSITS</span>} fontSize={19} />
      {data.deposits.length === 0 && <div style={{ color: C.textFaint, fontSize: 13 }}>NO KEEP DEPOSITS YET.</div>}
      {data.deposits.map((d) => (
        <div key={d.id} style={{ background: C.card, border: `2px solid ${C.border}`, padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <Icon name="keep" size={20} /><span style={{ fontSize: 16 }}>{d.amountKeep !== null ? fmtN(d.amountKeep) : '—'}</span>
            <span style={{ fontSize: 13, color: d.status === 'credited' ? C.success : d.status === 'failed' || d.status === 'expired' ? C.danger : C.textFaint }}>
              · {d.status.toUpperCase()}
            </span>
            {shortDate(d.createdAt) && <span style={{ fontSize: 12, color: C.textFaint }}>· {shortDate(d.createdAt)}</span>}
          </div>
          {d.txSignature && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
              <span className="copyable" style={{ color: C.sky }} title={d.txSignature}>TX {d.txSignature.slice(0, 8)}…{d.txSignature.slice(-8)}</span>
              <a className="interactive" style={{ color: C.sky, fontSize: 12 }} href={explorerUrl('tx', d.txSignature)} target="_blank" rel="noreferrer">EXPLORER ↗</a>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

export function DepositScreen(): React.JSX.Element {
  const balances = useApp((s) => s.balances) as Balances | null;
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const wallet = useApp((s) => s.wallet);
  const { data: balData } = useFetch<Balances>(
    () => api.get<Balances>(selectedBasePath('/balances')),
    [selectedBaseId],
  );
  const bal = (balances ?? balData) as Balances | null;
  const keep = bal ? Number(bal.keep) : 0; // deposits credit the HARD balance
  // The number the player needs BEFORE typing an amount (tester request
  // 2026-09-16): the connected wallet's on-chain KEEP, from the same
  // server-side read PROFILE › WALLET shows (GET /wallet/balances — the
  // browser never touches an RPC). null = that read failed, shown as such.
  const { data: chain, reload: reloadChain } = useFetch<WalletBalancesDto>(
    () => api.get<WalletBalancesDto>('/wallet/balances'),
    [wallet],
  );
  const chainKeep = chain ? chain.tokens['KEEP'] ?? null : null;
  const [historyVersion, setHistoryVersion] = useState(0);
  const { deposit, phase, error } = useKeepDeposit();
  const [amountInput, setAmountInput] = useState('');
  const amount = parseKeepDepositAmount(amountInput);
  useEffect(() => { if (error) { playSfx('sfx_error'); toast(error); } }, [error]);

  const submit = (): void => {
    if (phase !== 'idle') return;
    if (amount === null) { toast('ENTER A VALID WHOLE KEEP AMOUNT'); return; }
    void deposit(amount, () => {
      playSfx('sfx_confirm'); haptic('light'); toast(`DEPOSITED ${formatWholeKeep(amount)} KEEP`);
      setAmountInput(''); void reloadBase({ background: true });
      reloadChain(); setHistoryVersion((n) => n + 1);
    });
  };

  const addShortcut = (delta: bigint): void => {
    const next = addKeepDepositAmount(amountInput, delta);
    if (next === null) { toast(`MAX ${formatWholeKeep(MAX_KEEP_DEPOSIT)} KEEP`); return; }
    setAmountInput(next);
  };

  return (
    <ScrollPage title="DEPOSIT KEEP" onClose={() => useApp.getState().setScreen('exchange')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Chip><Icon name="keep" size={22} /><span>PLAY BALANCE</span><Sp /><span style={{ color: C.goldHi }}>{fmtN(keep)}</span></Chip>
        <Chip style={{ flexWrap: 'wrap' }}>
          <Icon name="keep" size={22} /><span>WALLET KEEP · ON-CHAIN</span>
          {chain && chainKeep === null && <span style={{ color: C.textFaint, fontSize: 12 }}>UNAVAILABLE — REFRESH</span>}
          <Sp />
          <span className="copyable" style={{ color: chainKeep ? C.goldHi : C.textDim }}>{fmtBalance(chainKeep)}</span>
          <Btn variant="ghost" fontSize={13} style={{ padding: '3px 8px 5px' }} onClick={reloadChain}>REFRESH</Btn>
        </Chip>
        <div style={{ color: C.textFaint, fontSize: 14, lineHeight: 1.4 }}>
          Move KEEP from your wallet into the game. Your wallet signs the transfer to custody; the balance credits once it finalizes on-chain (~15–30s).
        </div>
        <Chip style={{ padding: 10, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <label htmlFor="keep-deposit-amount" style={{ fontSize: 13, color: C.textFaint, letterSpacing: '1px' }}>
            WHOLE KEEP AMOUNT
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="keep" size={24} />
            <input id="keep-deposit-amount" className="interactive copyable-all" type="text"
              inputMode="numeric" pattern="[0-9]*" autoComplete="off" enterKeyHint="done"
              aria-label="KEEP deposit amount" aria-invalid={amountInput !== '' && amount === null}
              value={amountInput} placeholder="0" disabled={phase !== 'idle'}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => {
                const normalized = normalizeKeepDepositInput(e.currentTarget.value);
                if (normalized !== null) setAmountInput(normalized);
              }}
              style={{
                flex: 1, minWidth: 0, width: '100%', fontFamily: 'inherit', fontSize: 28,
                color: C.text, background: C.surface, border: `2px solid ${C.border}`,
                padding: '7px 9px 9px', outline: 'none',
              }} />
          </div>
          {amountInput !== '' && amount === null && (
            <div role="alert" style={{ color: C.danger, fontSize: 13 }}>
              ENTER 1–{formatWholeKeep(MAX_KEEP_DEPOSIT)} WHOLE KEEP
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="sec" fontSize={15} disabled={phase !== 'idle'} style={{ flex: 1, padding: '5px 8px 7px' }}
              onClick={() => addShortcut(100n)}>+100</Btn>
            <Btn variant="sec" fontSize={15} disabled={phase !== 'idle'} style={{ flex: 1, padding: '5px 8px 7px' }}
              onClick={() => addShortcut(1_000n)}>+1K</Btn>
            <Btn variant="sec" fontSize={15} disabled={phase !== 'idle' || amountInput === ''}
              style={{ flex: 1, padding: '5px 8px 7px' }} onClick={() => setAmountInput('')}>CLEAR</Btn>
          </div>
        </Chip>
        <Btn disabled={phase !== 'idle' || amount === null} onClick={submit}>
          <Icon name="keep" size={20} />
          {phase === 'paying' ? 'CONFIRM IN WALLET…'
            : phase === 'confirming' ? 'CONFIRMING ON-CHAIN…'
              : amount === null ? 'DEPOSIT KEEP' : `DEPOSIT ${formatWholeKeep(amount)} KEEP`}
        </Btn>
        {phase === 'confirming' && (
          <div style={{ color: C.textFaint, fontSize: 13, textAlign: 'center' }}>finality takes ~30s — safe to wait</div>
        )}
        <KeepDepositHistory refreshToken={historyVersion} />
      </div>
    </ScrollPage>
  );
}

// ===========================================================================
// SECURITY · 2FA — verified email is an account contact/recovery proof; only a
// mature authenticator unlocks instant custody (owner 2026-08-11).
// ===========================================================================

interface TotpEnroll { secret: string; otpauthUrl: string; qrDataUri: string }

export function SecurityScreen({ loginRecovery = false, onLoginClose }: {
  loginRecovery?: boolean; onLoginClose?: () => void;
} = {}): React.JSX.Element {
  const { prove, isEmbedded } = useRecentAuth();
  const requireFreshPrivyMfa = useFreshPrivyMfa(isEmbedded);
  const signOut = useSignOut();
  const {
    data: status, loading: statusLoading, error: statusError, reload,
  } = useFetch<TwoFaStatus>(() => api.get<TwoFaStatus>('/2fa/status'));
  const [enroll, setEnroll] = useState<TotpEnroll | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [email, setEmail] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [emailCode, setEmailCode] = useState('');
  const [busy, setBusy] = useState(false);
  // Step-up: adding an authenticator when email 2FA is already verified requires
  // proving the email factor first (server guard against 2FA takeover).
  const [stepSent, setStepSent] = useState(false);
  const [stepCode, setStepCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryCancelCode, setRecoveryCancelCode] = useState('');
  const [recoveryCompleteCode, setRecoveryCompleteCode] = useState('');
  const [recoveryCompleteSent, setRecoveryCompleteSent] = useState(false);
  const [, setRecoveryClock] = useState(0);
  // React state disables the controls on the next render; the ref closes the
  // same-tick double-tap window common on Android WebViews.
  const recoveryBusyRef = useRef(false);
  // An embedded wallet without Privy Wallet MFA fails BEFORE the wallet proof
  // (requireFreshPrivyMfa). That is a setup gap the player can close on this
  // very screen, so it renders as a hint next to the control, not a raw toast.
  const [privyMfaMissing, setPrivyMfaMissing] = useState(false);
  const recoveryFailure = (error: Error & { status?: number }): void => {
    if (isPrivyMfaNotEnrolled(error)) { setPrivyMfaMissing(true); return; }
    failToast(error, error.message);
    if (error.status === 410) reload();
  };

  // A screen left open across an authoritative ready/expiry boundary must reveal
  // the new state without a manual reload. Re-fetch at the earliest boundary
  // even if the returned status object is referentially unchanged.
  useEffect(() => {
    const recovery = status?.recovery;
    const boundaries = recovery ? [
      recovery.status === 'holding' ? recovery.readyAt : null,
      recovery.status === 'email_pending' || recovery.status === 'holding' ? recovery.expiresAt : null,
    ].filter((value): value is string => Boolean(value)).map(Date.parse)
      .filter((value) => value > Date.now()) : [];
    if (boundaries.length === 0) return undefined;
    const delay = Math.min(...boundaries) - Date.now();
    if (delay <= 0) return undefined;
    const timer = window.setTimeout(() => {
      setRecoveryClock((value) => value + 1);
      reload();
    }, delay + 25);
    return () => window.clearTimeout(timer);
  }, [reload, status?.recovery?.expiresAt, status?.recovery?.readyAt, status?.recovery?.status]);

  // Never infer “no factors” from a missing response. Apart from being
  // misleading, rendering enrollment controls during an outage encourages a
  // mutation whose required step-up state is unknown. Key export remains
  // independently reachable below; factor controls wait for authoritative data.
  if (statusError || !status) {
    return (
      <ScrollPage title="ACCOUNT EMAIL · 2FA" viewportSafe
        onClose={loginRecovery ? (onLoginClose ?? (() => undefined)) : () => useApp.getState().setScreen('profile')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <TwoFaStatusNotice loading={statusLoading} error={statusError} onRetry={reload} />
          {PRIVY_ENABLED && (loginRecovery ? <RecoveryWalletMfa /> : <ExportKeySection />)}
        </div>
      </ScrollPage>
    );
  }

  const factorPost = async <T,>(path: string, body: unknown): Promise<T> => {
    const grant = await prove('factor_change');
    return api.postRecent<T>(path, body, grant);
  };

  const startTotp = (): void => {
    const body = status.emailVerified ? { stepUp: { method: 'email', code: stepCode.trim() } } : {};
    setBusy(true);
    void factorPost<TotpEnroll>('/2fa/totp/enroll', body)
      .then((r) => { setEnroll(r); setStepSent(false); setStepCode(''); playSfx('sfx_tap'); })
      .catch((e: Error) => toast(e.message))
      .finally(() => setBusy(false));
  };
  const sendStepCode = (): void => {
    setBusy(true);
    void factorPost<{ sent: boolean; devCode?: string }>('/2fa/step-up/email', {})
      .then((r) => { setStepSent(true); if (r.devCode) { setStepCode(r.devCode); toast(`DEV CODE: ${r.devCode}`); } else toast('CODE SENT TO YOUR EMAIL'); })
      .catch((e: Error) => toast(e.message))
      .finally(() => setBusy(false));
  };
  const verifyTotp = (): void => {
    setBusy(true);
    void factorPost('/2fa/totp/verify', { code: totpCode.trim() })
      .then(() => {
        playSfx('sfx_confirm'); haptic('light');
        toast(`AUTHENTICATOR ENABLED · ${ECONOMY.unbondingHours}H SECURITY HOLD STARTED · CHECK WITHDRAW FOR AVAILABILITY`);
        setEnroll(null); setTotpCode('');
        if (loginRecovery) {
          toast('REPLACEMENT VERIFIED · SIGN IN AGAIN WITH YOUR NEW AUTHENTICATOR');
          void signOut();
        } else reload();
      })
      .catch((e: Error) => failToast(e, e.message))
      .finally(() => setBusy(false));
  };
  const disableTotp = (): void => {
    setBusy(true);
    void factorPost('/2fa/totp/disable', { code: disableCode.trim() })
      .then(() => { toast('AUTHENTICATOR DISABLED'); setDisableCode(''); reload(); })
      .catch((e: Error) => failToast(e, e.message))
      .finally(() => setBusy(false));
  };
  const sendEmail = (): void => {
    const stepUp = emailEnrollmentStepUp(status, stepCode);
    setBusy(true);
    void factorPost<{ sent: boolean; devCode?: string }>('/2fa/email/start', {
      email: email.trim(), ...(stepUp ? { stepUp } : {}),
    })
      .then((r) => {
        setEmailSent(true); setStepCode(''); setStepSent(false); reload();
        if (r.devCode) { setEmailCode(r.devCode); toast(`DEV CODE: ${r.devCode}`); }
        else toast('CODE SENT — CHECK YOUR EMAIL');
      })
      .catch((e: Error) => failToast(e, e.message))
      .finally(() => setBusy(false));
  };
  const verifyEmail = (): void => {
    setBusy(true);
    void factorPost('/2fa/email/verify', { code: emailCode.trim() })
      .then(() => {
        playSfx('sfx_confirm'); haptic('light'); toast('EMAIL VERIFIED');
        setEmail(''); setEmailSent(false); setEmailCode(''); setStepCode(''); reload();
      })
      .catch((e: Error) => failToast(e, e.message))
      .finally(() => setBusy(false));
  };

  const requestRecoveryEmail = (recoveryId: string): void => {
    if (recoveryBusyRef.current) return;
    recoveryBusyRef.current = true;
    setBusy(true);
    void (async () => {
      await requireFreshPrivyMfa();
      const grant = await prove('totp_recovery', { recoveryId, action: 'start' });
      return api.postRecent<{ status: TwoFaStatus['recovery']; devCode?: string }>(
        '/2fa/totp/recovery/start', { recoveryId }, grant,
      );
    })().then((result) => {
      if (result.devCode) {
        setRecoveryCode(result.devCode);
        toast(`DEV CODE: ${result.devCode}`);
      } else toast('RECOVERY CODE SENT TO YOUR VERIFIED EMAIL');
      reload();
    }).catch((e: Error) => {
      recoveryFailure(e);
      // A provider failure deliberately leaves the exact bounded recovery row
      // retryable; refresh so the same UUID's resend control becomes visible.
      reload();
    }).finally(() => { recoveryBusyRef.current = false; setBusy(false); });
  };
  const startRecovery = (): void => requestRecoveryEmail(crypto.randomUUID());
  const confirmRecovery = (): void => {
    const recoveryId = status.recovery?.recoveryId;
    if (!recoveryId || recoveryBusyRef.current) return;
    recoveryBusyRef.current = true;
    setBusy(true);
    void api.post<{ cancelledWithdrawals: number; inFlightWithdrawals: number; refundedKeep: string }>(
      '/2fa/totp/recovery/confirm', {
      recoveryId, code: recoveryCode.trim(),
      },
    ).then((result) => {
      setRecoveryCode('');
      toast(
        `RECOVERY HOLD STARTED · WAIT ${TWOFA.recoveryHoldHours}H · DETAILS SAVED BELOW`,
      );
      reload();
    }).catch((e: Error & { status?: number }) => recoveryFailure(e))
      .finally(() => { recoveryBusyRef.current = false; setBusy(false); });
  };
  const cancelRecovery = (): void => {
    const recoveryId = status.recovery?.recoveryId;
    if (!recoveryId || recoveryBusyRef.current) return;
    recoveryBusyRef.current = true;
    setBusy(true);
    void api.post('/2fa/totp/recovery/cancel', {
      recoveryId, code: recoveryCancelCode.trim(),
    }).then(() => {
      setRecoveryCancelCode(''); toast('AUTHENTICATOR RECOVERY CANCELLED'); reload();
    }).catch((e: Error & { status?: number }) => recoveryFailure(e))
      .finally(() => { recoveryBusyRef.current = false; setBusy(false); });
  };
  const sendRecoveryCompletionCode = (): void => {
    const recoveryId = status.recovery?.recoveryId;
    if (!recoveryId || recoveryBusyRef.current) return;
    recoveryBusyRef.current = true;
    setBusy(true);
    void (async () => {
      await requireFreshPrivyMfa();
      const grant = await prove('totp_recovery', { recoveryId, action: 'complete' });
      return api.postRecent<{ sent: true; devCode?: string }>(
        '/2fa/totp/recovery/complete/send-code', { recoveryId }, grant,
      );
    })().then((result) => {
      setRecoveryCompleteSent(true);
      if (result.devCode) {
        setRecoveryCompleteCode(result.devCode); toast(`DEV CODE: ${result.devCode}`);
      } else toast('COMPLETION CODE SENT TO YOUR VERIFIED EMAIL');
    }).catch((e: Error & { status?: number }) => recoveryFailure(e))
      .finally(() => { recoveryBusyRef.current = false; setBusy(false); });
  };
  const completeRecovery = (): void => {
    const recoveryId = status.recovery?.recoveryId;
    if (!recoveryId || recoveryBusyRef.current) return;
    recoveryBusyRef.current = true;
    setBusy(true);
    void (async () => {
      await requireFreshPrivyMfa();
      const grant = await prove('totp_recovery', { recoveryId, action: 'complete' });
      await api.postRecent('/2fa/totp/recovery/complete', {
        recoveryId, code: recoveryCompleteCode.trim(),
      }, grant);
      toast('OLD AUTHENTICATOR REMOVED · SIGN IN AGAIN TO ENROLL A REPLACEMENT');
      await signOut();
    })().catch((e: Error & { status?: number }) => recoveryFailure(e))
      .finally(() => { recoveryBusyRef.current = false; setBusy(false); });
  };

  const emailNeedsStep = status.emailVerified || status.totpEnabled;
  const emailStepReady = !emailNeedsStep || stepCode.trim().length >= 6;
  const recovery = status.recovery;
  const recoveryHolding = recovery?.status === 'holding';
  const recoveryPending = recovery?.status === 'email_pending';
  const recoveryReady = recoveryHolding && recovery.readyAt !== null
    && Date.parse(recovery.readyAt) <= Date.now();
  const reenrollmentRequired = status.reenrollmentRequired === true
    || recovery?.reenrollmentRequired === true;

  return (
    <ScrollPage title="ACCOUNT EMAIL · 2FA" viewportSafe
      onClose={loginRecovery ? (onLoginClose ?? (() => undefined)) : () => useApp.getState().setScreen('profile')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ color: C.textFaint, fontSize: 14, lineHeight: 1.5 }}>
          Your verified email and authenticator protect this account. Every change also requires a fresh wallet confirmation.
        </div>
        {reenrollmentRequired && (
          <Chip style={{ flexWrap: 'wrap' }}>
            <Icon name="shield" size={20} />
            <span style={{ color: C.danger }}>REPLACEMENT AUTHENTICATOR REQUIRED</span>
            <span style={{ color: C.textFaint, fontSize: 13 }}>
              · key export and new withdrawals stay locked until setup below is verified
            </span>
          </Chip>
        )}
        {recoveryPending && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: `2px solid ${C.gold}`, padding: 10 }}>
            <div style={{ color: C.gold, fontSize: 15 }}>CONFIRM LOST-AUTHENTICATOR RECOVERY</div>
            <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.5 }}>
              Enter the code sent to your verified PKW contact email. Confirmation starts a {TWOFA.recoveryHoldHours}-hour hold and cancels/refunds pending withdrawals.
            </div>
            <input className="interactive" value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)}
              aria-label="Authenticator recovery email code" placeholder="RECOVERY EMAIL CODE"
              inputMode="numeric" autoComplete="one-time-code" style={CODE_STYLE} />
            <Btn disabled={busy || recoveryCode.trim().length < 6} onClick={confirmRecovery}>
              START {TWOFA.recoveryHoldHours}H SECURITY HOLD
            </Btn>
            <Btn variant="sec" disabled={busy || !recovery.recoveryId}
              onClick={() => recovery.recoveryId && requestRecoveryEmail(recovery.recoveryId)}>
              RESEND RECOVERY EMAIL
            </Btn>
            <div style={{ color: C.textFaint, fontSize: 12, lineHeight: 1.5 }}>
              Still have the current PKW authenticator? Enter it to cancel this request before the hold starts.
            </div>
            <input className="interactive" value={recoveryCancelCode}
              onChange={(event) => setRecoveryCancelCode(event.target.value)}
              aria-label="Current Pixel Kingdom Wars Authenticator Code"
              placeholder="CURRENT PKW AUTHENTICATOR CODE" inputMode="numeric"
              autoComplete="one-time-code" style={CODE_STYLE} />
            <Btn variant="ghost" disabled={busy || recoveryCancelCode.trim().length < 6} onClick={cancelRecovery}>
              CANCEL RECOVERY
            </Btn>
          </div>
        )}
        {recoveryHolding && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: `2px solid ${C.blood}`, padding: 10 }}>
            <div style={{ color: C.danger, fontSize: 15 }}>AUTHENTICATOR RECOVERY HOLD ACTIVE</div>
            <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.5 }}>
              {recovery.readyAt ? `Ready to complete: ${new Date(recovery.readyAt).toLocaleString()}. ` : ''}
              {recovery.expiresAt ? `Complete before ${new Date(recovery.expiresAt).toLocaleString()}.` : ''}
              {' '}Key export, security changes and new withdrawals are locked during this hold.
            </div>
            {recovery.receipt && (
              <div role="status" aria-live="polite" style={{
                color: C.text, fontSize: 13, lineHeight: 1.5, whiteSpace: 'normal',
                overflowWrap: 'anywhere', border: `1px solid ${C.border}`, padding: 8,
              }}>
                REFUND RECEIPT · {recovery.receipt.cancelledWithdrawals} PENDING WITHDRAWAL(S)
                {' '}CANCELLED · {fmtN(recovery.receipt.refundedKeep)} KEEP REFUNDED
                {' '}· {recovery.receipt.inFlightWithdrawals} PROCESSING LEFT UNTOUCHED
              </div>
            )}
            {privyMfaMissing && (
              <span role="alert" style={{ color: C.gold, fontSize: 12, lineHeight: 1.5 }}>
                ENROL PRIVY WALLET MFA FIRST (SECURE WALLET WITH PRIVY MFA, below) — then send the completion code again.
              </span>
            )}
            {recoveryReady && !recoveryCompleteSent ? (
              <Btn disabled={busy} onClick={sendRecoveryCompletionCode}>SEND COMPLETION EMAIL CODE</Btn>
            ) : recoveryReady ? (
              <>
                <input className="interactive" value={recoveryCompleteCode}
                  onChange={(event) => setRecoveryCompleteCode(event.target.value)}
                  aria-label="Authenticator recovery completion email code"
                  placeholder="COMPLETION EMAIL CODE" inputMode="numeric"
                  autoComplete="one-time-code" style={CODE_STYLE} />
                <Btn disabled={busy || recoveryCompleteCode.trim().length < 6} onClick={completeRecovery}>
                  REMOVE OLD AUTHENTICATOR &amp; SIGN OUT
                </Btn>
              </>
            ) : null}
            <div style={{ color: C.textFaint, fontSize: 12, lineHeight: 1.5 }}>
              Still have the current PKW authenticator? Enter that code to cancel immediately. Refunded withdrawals remain cancelled.
            </div>
            <input className="interactive" value={recoveryCancelCode}
              onChange={(event) => setRecoveryCancelCode(event.target.value)}
              aria-label="Current Pixel Kingdom Wars Authenticator Code"
              placeholder="CURRENT PKW AUTHENTICATOR CODE" inputMode="numeric"
              autoComplete="one-time-code" style={CODE_STYLE} />
            <Btn variant="ghost" disabled={busy || recoveryCancelCode.trim().length < 6} onClick={cancelRecovery}>
              CANCEL RECOVERY
            </Btn>
          </div>
        )}
        {status.instantEligible && status.instantWithdrawalsEnabled && (
          <Chip style={{ flexWrap: 'wrap' }}><Icon name="shield" size={20} />
            <span style={{ color: C.success }}>INSTANT WITHDRAWALS AVAILABLE</span>
            <span style={{ color: C.textFaint, fontSize: 13 }}>· off by default; turn on for each withdrawal</span></Chip>
        )}
        {status.totpEnabled && !status.totpReady && status.totpReadyAt && (
          <Chip><Icon name="shield" size={20} /><span style={{ color: C.gold }}>AUTHENTICATOR MATURING</span>
            <span style={{ color: C.textFaint, fontSize: 13 }}>· ready {new Date(status.totpReadyAt).toLocaleString()}</span></Chip>
        )}
        {status.totpEnabled && status.totpReady
          && (!status.instantEligible || !status.instantWithdrawalsEnabled) && (
          <Chip style={{ flexWrap: 'wrap' }}><Icon name="shield" size={20} />
            <span style={{ color: C.gold }}>AUTHENTICATOR ENABLED</span>
            <span style={{ color: C.textFaint, fontSize: 13 }}>· instant withdrawals temporarily unavailable; standard withdrawals remain available</span></Chip>
        )}

        {!loginRecovery && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: `2px solid ${C.border}`, padding: 10 }}>
            <Phead title="PKW LOGIN PROTECTION" fontSize={19} />
            <span>Require PKW Authenticator on Login · {status.loginTotpRequired ? 'ON' : 'OFF'}</span>
            <span style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.5 }}>
              Optional. Requires a verified PKW authenticator, verified recovery email and available recovery service.
              Changing this signs out your other sessions. Wallet-sensitive actions keep their own verification.
            </span>
            <input aria-label="Authenticator code for login protection" className="interactive" value={loginCode}
              onChange={(event) => setLoginCode(event.target.value)} placeholder="CURRENT PKW CODE"
              inputMode="numeric" autoComplete="one-time-code" style={CODE_STYLE} />
            <Btn disabled={busy || !status.totpEnabled || loginCode.trim().length !== 6 || recoveryHolding || recoveryPending
              || (!status.loginTotpRequired && (!status.emailVerified || status.recoveryEnabled !== true))}
              onClick={() => {
                setBusy(true);
                void factorPost('/auth/login/protection', { enabled: !status.loginTotpRequired, code: loginCode.trim() })
                  .then(() => { setLoginCode(''); reload(); toast('LOGIN PROTECTION UPDATED · OTHER SESSIONS SIGNED OUT'); })
                  .catch((e: Error) => failToast(e, e.message)).finally(() => setBusy(false));
              }}>{status.loginTotpRequired ? 'DISABLE LOGIN PROTECTION' : 'REQUIRE AUTHENTICATOR ON LOGIN'}</Btn>
            {status.loginTotpRequired && <span style={{ color: C.gold, fontSize: 13 }}>
              Disable login protection here before removing its authenticator.
            </span>}
          </div>
        )}
        <Phead title={<span style={{ fontSize: 19 }}>AUTHENTICATOR APP</span>} fontSize={19} />
        {status?.totpEnabled ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Chip><Icon name="shield" size={20} /><span style={{ color: C.success }}>ENABLED</span></Chip>
            {!recoveryHolding && (
              <>
                <input className="interactive" value={disableCode} onChange={(e) => setDisableCode(e.target.value)}
                  aria-label="Current Pixel Kingdom Wars Authenticator Code"
                  placeholder="PKW CODE TO DISABLE" inputMode="numeric"
                  autoComplete="one-time-code" style={CODE_STYLE} />
                <Btn variant="ghost" fontSize={14} disabled={busy || loginRecovery || status.loginTotpRequired || disableCode.trim().length < 6} onClick={disableTotp}>DISABLE AUTHENTICATOR</Btn>
                {!recoveryPending && (
                  <>
                    <Btn variant="ghost" fontSize={14}
                      disabled={busy || !status.emailVerified || status.recoveryEnabled === false}
                      onClick={startRecovery}>
                      LOST AUTHENTICATOR?
                    </Btn>
                    {/* D-099: the recovery order differs by wallet kind — an
                        external wallet is never asked for Privy MFA
                        (useFreshPrivyMfa returns at once when !isEmbedded),
                        yet the only copy near this button spoke of it, so an
                        external-wallet player went looking for a factor they
                        never had. */}
                    <span style={{ color: C.textFaint, fontSize: 12, lineHeight: 1.5 }}>
                      {isEmbedded
                        ? 'PRIVY WALLET MFA FIRST, THEN A WALLET SIGNATURE AND THE EMAIL CODE'
                        : 'EXTERNAL WALLET: SIGN A MESSAGE WITH YOUR WALLET, THEN ENTER THE EMAIL CODE — NO PRIVY MFA NEEDED'}
                    </span>
                    {privyMfaMissing && (
                      <span role="alert" style={{ color: C.gold, fontSize: 12, lineHeight: 1.5 }}>
                        ENROL PRIVY WALLET MFA FIRST (SECURE WALLET WITH PRIVY MFA, below) — then tap LOST AUTHENTICATOR? again.
                      </span>
                    )}
                    {/* Both dead ends are support-only by D-094 (no automated
                        bypass). Each says exactly why the button is off and hands
                        over a real address — a "contact support" without one is
                        the dead end D-098 exists to remove. */}
                    {status.recoveryEnabled === false && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={{ color: C.textFaint, fontSize: 12, lineHeight: 1.5 }}>
                          Automated authenticator recovery is switched off right now, so this button cannot start one. Standard withdrawals never need the code. If you have lost this authenticator, write to support:
                        </span>
                        <SupportLinks topic="Lost Pixel Kingdom Wars authenticator" fontSize={12} />
                      </div>
                    )}
                    {!status.emailVerified && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={{ color: C.textFaint, fontSize: 12, lineHeight: 1.5 }}>
                          Recovery needs a verified PKW contact email and this account has none, so the automated path has no second proof it is you. Standard withdrawals never need the code. If you have lost this authenticator, write to support from the wallet you play with:
                        </span>
                        <SupportLinks topic="Lost Pixel Kingdom Wars authenticator (no verified email)" fontSize={12} />
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        ) : enroll ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
            <img src={enroll.qrDataUri} width={200} height={200} alt="Scan in your authenticator app"
              style={{ border: `2px solid ${C.border}`, background: '#fff' }} />
            <div style={{ color: C.textFaint, fontSize: 13, wordBreak: 'break-all', textAlign: 'center' }}>
              Or enter this key manually:<br /><span style={{ color: C.text, fontSize: 14 }}>{enroll.secret}</span>
            </div>
            <input className="interactive" value={totpCode} onChange={(e) => setTotpCode(e.target.value)}
              placeholder="6-DIGIT CODE" inputMode="numeric" style={CODE_STYLE} />
            <Btn disabled={busy || totpCode.trim().length < 6} onClick={verifyTotp} style={{ width: '100%' }}>VERIFY &amp; ENABLE</Btn>
          </div>
        ) : status?.emailVerified ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ color: C.textFaint, fontSize: 13 }}>Confirm with an email code to add an authenticator:</div>
            {!stepSent ? (
              <Btn variant="sec" fontSize={15} disabled={busy} onClick={sendStepCode}>SEND CONFIRMATION CODE</Btn>
            ) : (
              <>
                <input className="interactive" value={stepCode} onChange={(e) => setStepCode(e.target.value)}
                  placeholder="EMAIL CODE" inputMode="numeric" style={CODE_STYLE} />
                <Btn variant="sec" disabled={busy || stepCode.trim().length < 6} onClick={startTotp}>SET UP AUTHENTICATOR</Btn>
              </>
            )}
          </div>
        ) : (
          <Btn variant="sec" disabled={busy} onClick={startTotp}>SET UP AUTHENTICATOR</Btn>
        )}

        {!loginRecovery && !recoveryHolding && !reenrollmentRequired && (
          <>
        <Phead title={<span style={{ fontSize: 19 }}>VERIFIED CONTACT EMAIL</span>} fontSize={19} />
        <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.4 }}>
          Used for account confirmations and key export. Email does not authorize instant withdrawals.
        </div>
        {status?.emailVerified && (
          <Chip><Icon name="shield" size={20} /><span style={{ color: C.success }}>VERIFIED</span>
            <span style={{ color: C.textFaint, fontSize: 13 }}>· {status.email}</span></Chip>
        )}
        {status?.pendingEmail && (
          <Chip><Icon name="shield" size={20} /><span style={{ color: C.gold }}>PENDING VERIFICATION</span>
            <span style={{ color: C.textFaint, fontSize: 13 }}>· {status.pendingEmail}</span></Chip>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input className="interactive" value={email} onChange={(e) => { setEmail(e.target.value); setEmailSent(false); }}
            placeholder={status?.emailVerified ? 'NEW EMAIL ADDRESS' : 'you@example.com'} inputMode="email" style={FIELD_STYLE} />
          {emailNeedsStep && status?.totpEnabled ? (
            <input className="interactive" value={stepCode} onChange={(e) => setStepCode(e.target.value)}
              placeholder="CURRENT AUTHENTICATOR CODE" inputMode="numeric" style={CODE_STYLE} />
          ) : emailNeedsStep && !stepSent ? (
            <Btn variant="sec" fontSize={15} disabled={busy} onClick={sendStepCode}>CONFIRM CURRENT EMAIL</Btn>
          ) : emailNeedsStep ? (
            <input className="interactive" value={stepCode} onChange={(e) => setStepCode(e.target.value)}
              placeholder="CURRENT EMAIL CODE" inputMode="numeric" style={CODE_STYLE} />
          ) : null}
          <Btn variant="sec" disabled={busy || email.trim().length < 3 || !emailStepReady} onClick={sendEmail}>
            {emailSent || status?.pendingEmail ? 'RESEND NEW-EMAIL CODE' : status?.emailVerified ? 'CHANGE EMAIL' : 'SEND CODE'}
          </Btn>
          {(emailSent || !!status?.pendingEmail) && (
            <>
              <input className="interactive" value={emailCode} onChange={(e) => setEmailCode(e.target.value)}
                placeholder="NEW EMAIL CODE" inputMode="numeric" style={CODE_STYLE} />
              <Btn disabled={busy || emailCode.trim().length < 6} onClick={verifyEmail}>VERIFY EMAIL</Btn>
            </>
          )}
        </div>
          </>
        )}

        {/* Privy embedded wallets only (Phase 2, Flow B): the render gate keeps
            the Privy hooks off when no provider is mounted.
            It takes no land props from this screen and runs entirely on the
            auth-only /auth/export/* routes, so no land
            state and no gated 2FA read can stand between a player and their own
            key (security review F8). */}
        {PRIVY_ENABLED && (loginRecovery ? <RecoveryWalletMfa /> : <ExportKeySection />)}
      </div>
    </ScrollPage>
  );
}

// ===========================================================================
// BUILDERS — /base jobs: WORKING/RESTING, six-slot permanent roster
// ===========================================================================

export function BuildersScreen(): React.JSX.Element {
  const base = useApp((s) => s.base);
  const wallet = useApp((s) => s.wallet);
  const builders = base?.player.builders ?? 1;
  const free = base?.freeBuilders ?? builders;
  const busy = builders - free;
  const { purchase, phase, error } = useSolPurchase();
  useEffect(() => { if (error) { playSfx('sfx_error'); toast(error); } }, [error]);

  // Hiring a builder is pay-per-action on-chain: mint a server-priced 'builder'
  // intent, pay via shardkeep-core buy_sink(kind=builder), and let the watcher
  // credit exactly the next slot after finalized amount/order checks.
  const hire = (): void => {
    if (!wallet) { toast('LINK WALLET FIRST'); return; }
    if (phase !== 'idle') return; // one purchase in flight at a time
    void purchase('builder', {
      onDone: () => { haptic('light'); playSfx('sfx_confirm'); toast('BUILDER HIRED'); void reloadBase({ background: true }); },
    });
  };

  function row(i: number): React.JSX.Element {
    const owned = i <= builders;
    const next = i === builders + 1;
    const price = CAPS.builderPricesSol[i - 2]; // i=2 -> idx0 (2 SOL), i=3 -> idx1 (10)
    let state: React.JSX.Element;
    if (owned) {
      // working/resting derived from real server jobs (freeBuilders). App used
      // per-slot job flags (L1626); since builders are fungible, lowest-index =
      // WORKING is an acceptable, more-correct-than-hardcoded approximation.
      const working = i <= busy;
      state = <span style={{ color: working ? C.danger : C.success }}>{working ? 'WORKING' : 'RESTING'}</span>;
    } else if (next) {
      state = (
        <Btn fontSize={15} style={{ padding: '4px 12px 6px' }} disabled={phase !== 'idle'} onClick={hire}>
          <Icon name="sol" size={16} />HIRE · {price} SOL
        </Btn>
      );
    } else {
      state = <span style={{ color: C.stoneDark }}>HIRE BUILDER {i - 1} FIRST</span>;
    }
    return (
      <Chip key={i} style={{ opacity: owned || next ? 1 : 0.55 }}>
        <Icon name="builder" size={32} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{ fontSize: 18 }}>BUILDER {i}</span>
          <span style={{ color: C.textFaint, fontSize: 13 }}>{i === 1 ? 'CAME WITH THE KEEP' : `${price} SOL · ONE-TIME`}</span>
        </div>
        <Sp />
        {state}
      </Chip>
    );
  }

  return (
    <ModalWrap onBackdrop={home}>
      <Phead title={`BUILDERS · ${free}/${builders} FREE`} onClose={home} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px' }}>
        {Array.from({ length: CAPS.buildersMax }, (_, i) => row(i + 1))}
        <div style={{ color: C.stoneDark, fontSize: 14, textAlign: 'center', lineHeight: 1.3 }}>
          EACH BUILDER WORKS ONE JOB — UPGRADES, NEW CONSTRUCTION, OR CLEARING. MORE BUILDERS, MORE JOBS AT ONCE. PAID IN SOL VIA LINKED WALLET · PERMANENT.
        </div>
      </div>
      <div style={{ padding: '0 14px 14px' }}>
        <Btn style={{ width: '100%' }} onClick={home}>DONE</Btn>
      </div>
    </ModalWrap>
  );
}

// ===========================================================================
// EXPAND — ring 14→16→18, wallet-required note
// ===========================================================================

export function ExpandScreen(): React.JSX.Element {
  return candidateExpansionConfigured() ? <CandidateExpandScreen /> : <PaidExpandScreen />;
}

function PaidExpandScreen(): React.JSX.Element {
  const base = useApp((s) => s.base);
  const wallet = useApp((s) => s.wallet);
  const { purchase, phase, error } = useSolPurchase();
  const busy = phase !== 'idle';
  useEffect(() => { if (error) { playSfx('sfx_error'); toast(error); } }, [error]);
  const ext = base?.player.expansions ?? 0;
  const size = CAPS.claimTilesByExpansion[ext] ?? 14 + ext * 2;
  const maxed = ext >= CAPS.expansionsMax;
  const next = CAPS.claimTilesByExpansion[ext + 1] ?? size + 2;
  // Per-index price + Keep-level gate (owner 2026-07-20 big-base expansion): slots
  // 3–6 grow the claim toward 26×26 and cost more, gated by Keep level.
  const keepLevel = base?.player.keepLevel ?? 1;
  const reqKeep = CAPS.expansionReqKeepLevel[ext] ?? 1;
  const gated = keepLevel < reqKeep;
  const priceSol = CAPS.expansionPriceSolByIndex[ext] ?? CAPS.expansionPriceSol;

  // Expansion pays SOL 100% to the liquidity wallet (owner 2026-07-20): mint an
  // 'expansion' intent (server preflights the Keep gate + returns the per-index
  // price + liquidity destination), sign a direct SOL transfer, and the watcher
  // credits expansions+1 once finalized. The server derives the index from the DB.
  const expand = (): void => {
    if (!wallet) { toast('LINK WALLET FIRST'); return; }
    if (busy || gated) return;
    void purchase('expansion', {
      onDone: () => { haptic('light'); playSfx('sfx_confirm'); toast('LAND EXPANDED'); void reloadBase({ background: true }); },
    });
  };

  return (
    <ModalWrap onBackdrop={home}>
      <Phead title="EXPAND LAND" onClose={home} />
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Chip><Icon name="layout" size={22} /><span>CURRENT CLAIM</span><Sp /><span style={{ color: C.textDim }}>{size}×{size} BUILDABLE</span></Chip>
        {maxed ? (
          <Chip><span style={{ color: C.textFaint }}>MAX CLAIM REACHED — THE LAND ALLOWS NO MORE</span></Chip>
        ) : (
          <>
            <Chip accent={C.goldDp}><Icon name="plus" size={22} /><span>NEXT RING</span><Sp /><span style={{ color: C.goldHi }}>{next}×{next} BUILDABLE</span></Chip>
            <div style={{ color: C.textFaint, fontSize: 15, lineHeight: 1.3 }}>
              ADDS MORE BUILDING SPACE AROUND YOUR CLAIM. EXISTING BUILDINGS STAY IN PLACE.
            </div>
            {gated && (
              <Chip><Icon name="keep" size={20} /><span style={{ color: C.danger, fontSize: 14 }}>REQUIRES KEEP LEVEL {reqKeep}</span></Chip>
            )}
          </>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, padding: '0 14px 14px' }}>
        <Btn variant="ghost" style={{ flex: 1 }} onClick={home}>CLOSE</Btn>
        {!maxed && (
          <Btn style={{ flex: 2 }} disabled={busy || gated} onClick={expand}>
            <Icon name="sol" size={20} />EXPAND · {priceSol} SOL
          </Btn>
        )}
      </div>
    </ModalWrap>
  );
}

// ===========================================================================
// LAYOUT — authoritative HOME/FARM presets. The independently mountable editor
// owns the live Phaser draft and server API; this lazy menu export is only the
// existing Overlay routing seam.
// ===========================================================================

export function LayoutScreen(): React.JSX.Element {
  const base = useApp((s) => s.base);
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const baseId = base?.baseId ?? selectedBaseId;
  if (!base || !baseId) {
    return (
      <ModalWrap onBackdrop={home}>
        <Phead title="LAYOUT PRESETS" onClose={home} />
        <div style={{ padding: 14, color: C.textDim }}>SELECT AN ACTIVE DEEDED BASE FIRST.</div>
      </ModalWrap>
    );
  }
  return <LayoutEditor baseId={baseId} base={base} onClose={home} reloadBase={reloadBase} />;
}

// ===========================================================================
// SHOP — SKINS/BOOSTS/TOKENS tabs (verbatim items)
// ===========================================================================

// CODEX joined the Shop's tabs when MARKET took its navbar slot (owner
// 2026-07-26) — it is reference reading, so a tab is the right home for it.
type ShopTab = 'ITEMS' | 'BOOSTS' | 'TOKENS' | 'CODEX';

/** The complete purchasable item catalog. Buying charges KEEP and delivers the
 * item into the player's separate owned-only Inventory. */
type ItemsDto = ShopItemsDto;

export function ShopItemsTab(): React.JSX.Element {
  const wallet = useApp((s) => s.wallet);
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const selectionEpoch = useApp((s) => s.baseSelectionEpoch);
  // Remount immediately on identity changes: useFetch intentionally retains
  // prior data on failure, which must never become another base's BUY cards.
  return <ShopItemsSelection key={JSON.stringify([wallet, selectedBaseId, selectionEpoch])} />;
}

function ShopItemsSelection(): React.JSX.Element {
  const scope = useRef(captureBaseSnapshotGuard());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = (): boolean => mounted.current && isBaseSnapshotGuardCurrent(scope.current);
  const { data, reload, loading, error } = useFetch<ItemsDto>(
    () => api.get<ItemsDto>(selectedBasePath('/items')),
  );
  const [kind, setKind] = useState<ShopItemKind>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const { confirmKeepSpend, keepSpendDialog } = useKeepSpendConfirm();
  const post = (id: string, done: string): void => {
    if (busyId || loading || error || !current()) return;
    setBusyId(id);
    void api.post('/items/buy', withSelectedBase({ itemId: id }))
      .then(() => {
        if (!current()) return;
        playSfx('sfx_confirm');
        haptic('light');
        toast(done);
        reload();
        void reloadBase({ background: true });
      })
      .catch((cause: Error) => { if (current()) failToast(cause, cause.message.toUpperCase()); })
      .finally(() => { if (current()) setBusyId(null); });
  };
  const buy = (id: string, item: ItemsDto['catalog'][number]): void => {
    // A hero contract this base ALREADY consumed still sells — as an unused
    // tradeable copy for the bag (D-110: bag stock ≠ activation). Tester
    // report 2026-09-16: a player re-bought HERO CONTRACT: VEX and read the
    // card's "UNUSED ×1" as nothing delivered. The copy IS delivered; the
    // dialog states what the KEEP buys BEFORE it is spent, and `always`
    // shows it even to a player who opted out of plain KEEP confirmations —
    // this warns about the purchase, not merely the price.
    const hero = item.activation?.kind === 'hero' && item.activation.active
      ? HERO_KEYS.find((key) => HEROES[key].recruitItemId === item.id) : undefined;
    if (!hero) { post(id, 'ITEM ADDED TO INVENTORY'); return; }
    confirmKeepSpend({
      costKeep: item.costKeep, immediate: false, always: true,
      what: `BUY AN UNUSED COPY OF ${item.name}`,
      warning: `${HEROES[hero].name.toUpperCase()} IS ALREADY RECRUITED HERE. THIS BUYS AN UNUSED TRADEABLE COPY FOR YOUR BAG${item.maxOwned !== null ? ` (BAG LIMIT ${item.maxOwned})` : ''}. CONTINUE?`,
      onConfirm: () => post(id, 'COPY ADDED TO BAG'),
    });
  };
  if (error) return <div role="alert" style={{ color: C.danger }}>
    {error}
    <Sp /><Btn variant="ghost" onClick={reload}>RETRY</Btn>
  </div>;
  return <>
    {keepSpendDialog}
    <ShopCatalogView data={loading ? null : data} busyId={busyId} kind={kind} onKind={setKind} onBuy={buy} />
  </>;
}

export function ShopScreen(): React.JSX.Element {
  const parent = useApp((state) => state.shopReturnScreen);
  const closeShop = (): void => useApp.getState().setScreen(parent);
  const balances = useApp((s) => s.balances);
  const [tab, setTab] = useState<ShopTab>('ITEMS');
  const { purchase, phase, error } = useSolPurchase();
  const busy = phase !== 'idle';
  useEffect(() => { if (error) { playSfx('sfx_error'); toast(error); } }, [error]);
  const tabs: ShopTab[] = ['ITEMS', 'BOOSTS', 'TOKENS', 'CODEX'];

  // Warzone shield (#49) is offered ONLY while a warzone is active — the ONE
  // protection that works during a shieldless window. /economy/stats reports the
  // CURRENT window state (never an upcoming purge start, so nothing leaks).
  const [warzoneActive, setWarzoneActive] = useState(false);
  useEffect(() => {
    void api.get<{ warzone?: { active?: boolean } }>('/economy/stats')
      .then((s) => setWarzoneActive(!!s.warzone?.active)).catch(() => { /* stay hidden on error */ });
  }, []);
  const buyWarzoneShield = (): void => {
    if (busy) return;
    void purchase('warzone_shield', {
      onDone: () => { toast(`WARZONE SHIELD ACTIVE · ${fmtDur(WARZONE.shieldDurationHours * 3_600).toUpperCase()}`); void reloadBase({ background: true }); },
    });
  };

  // Shield extension is pay-per-action on-chain (v3): mint a 'shield' deposit
  // intent, pay via shardkeep-core buy_sink through the wallet, and the extension
  // is granted when the payment finalizes. The purchase hook serializes the flow
  // and `busy` disables the button, so a double-tap can't start two payments
  // (security review P0 — no double charge).
  const extendShield = (): void => {
    if (busy) return;
    void purchase('shield', {
      onDone: () => { toast(`SHIELD EXTENDED +${SHIELD.extendHours}H`); void reloadBase({ background: true }); },
    });
  };

  return (
    <ScrollPage
      title="SHOP"
      onClose={closeShop}
      tabs={
        <>
          {/* Shop header shows the player's KEEP (shards). There is no in-game
              SOL balance in v3 — SOL is paid per action straight from the linked
              wallet at purchase time, so the old SOL-credit pill is gone. */}
          <div style={{ position: 'absolute', top: 8, right: 50, display: 'flex', gap: 10, alignItems: 'center' }}>
            <Pill style={{ border: 'none' }}><Icon name="keep" size={20} /><PillVal>{fmtN(Number(balances?.keep ?? 0))}</PillVal></Pill>
          </div>
          <div style={{ display: 'flex', gap: 4, padding: '8px 10px 0', background: C.card }}>
            {tabs.map((t) => (
              // CODEX is a full page of its own, so its tab NAVIGATES rather than
              // swapping the body — cheaper than restructuring CodexScreen, and it
              // keeps the codex reachable now that MARKET holds the navbar slot.
              <Btn key={t} variant={tab === t ? 'gold' : 'ghost'} fontSize={18} style={{ flex: 1, padding: '6px 0 8px' }}
                onClick={() => { playSfx('sfx_tap'); if (t === 'CODEX') useApp.getState().setScreen('codex'); else setTab(t); }}>{t}</Btn>
            ))}
          </div>
        </>
      }>
      <Btn variant="ghost" onClick={closeShop} fontSize={16}
        style={{ minHeight: 44, marginBottom: 10 }}>← BACK TO {parent === 'inventory' ? 'INVENTORY' : 'BASE'}</Btn>
      {tab === 'ITEMS' && <ShopItemsTab />}
      {tab === 'BOOSTS' && (
        <Grid>
          {warzoneActive && (
            <ShopGridCard
              name={`WARZONE SHIELD ${fmtDur(WARZONE.shieldDurationHours * 3_600).toUpperCase()}`} img="ui_icon_shield" w={52} h={52} cur="sol"
              price={fmtSol(String(WARZONE.shieldCostSolLamports))}
              disabled={busy} onClick={buyWarzoneShield} />
          )}
          {/* On-chain SOL sinks stay as-is (ECONOMY.md §4a: shields are SOL-only). */}
          <ShopGridCard name={`SHIELD +${SHIELD.extendHours}H`} img="ui_icon_shield" w={52} h={52} cur="sol"
            price={fmtSol(String(SHIELD.extendCostSolLamports))}
            disabled={busy} onClick={extendShield} />
          <ShopGridCard name="2ND BUILDER" img="ui_builder_workman" w={52} h={52} cur="sol"
            price={`${CAPS.builderPricesSol[0]}+`}
            onClick={() => useApp.getState().setScreen('builders')} />
          {busy && <span style={{ color: C.textFaint }}>…</span>}
        </Grid>
      )}
      {tab === 'TOKENS' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Token packs have no purchase endpoint in alpha — shown locked, not a
              fake buy() toast. The only real action here is the in-game 1:1
              Shards → KEEP exchange. */}
          {SHOP_TOKENS.map((t) => (
            <Chip key={t.keep} accent={t.accent} style={{ opacity: 0.5 }}>
              <Icon name="keep" size={24} /><span>{t.keep}</span><Sp />
              <span style={{ color: C.stoneDark, fontSize: 14, letterSpacing: '1px' }}>COMING SOON</span>
            </Chip>
          ))}
          <Chip accent={C.goldDp} onClick={() => useApp.getState().setScreen('exchange')}>
            <Icon name="keep" size={24} /><span>KEEP WALLET · DEPOSIT & WITHDRAW</span><Sp /><span style={{ color: C.goldHi }}>›</span>
          </Chip>
          <div style={{ color: C.stoneDark, fontSize: 15, textAlign: 'center', paddingTop: 6 }}>
            KEEP — PIXEL KINGDOM GOLD · EARN IT IN-GAME, WITHDRAW IT TO YOUR WALLET
          </div>
        </div>
      )}
    </ScrollPage>
  );
}

function Grid({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>{children}</div>;
}
function ShopGridCard({ img, w, h, name, cur, price, onClick, disabled, soon }: {
  img: string; w: number; h: number; name: string; cur: 'keep' | 'sol'; price: string; onClick?: () => void; disabled?: boolean; soon?: boolean;
}): React.JSX.Element {
  const locked = disabled || soon;
  const handleClick = locked || !onClick ? () => undefined : onClick;
  return (
    <Card onClick={handleClick}
      style={locked ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
      <div style={{ height: h > 80 ? 96 : 64, display: 'flex', alignItems: 'flex-end' }}><Sprite name={img} w={w} h={h} /></div>
      <span style={{ fontSize: 16, color: C.textDim, lineHeight: 1.1, textAlign: 'center' }}>{name}</span>
      {soon ? (
        <span style={{ fontSize: 13, color: C.stoneDark, letterSpacing: '1px' }}>COMING SOON</span>
      ) : (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 17, color: C.goldHi }}>
          <Icon name={cur} size={16} />{price}
        </span>
      )}
    </Card>
  );
}

// ===========================================================================
// PROFILE — wallet, name, toggles incl. REDUCE MOTION, referral, raid-log
// ===========================================================================

// Toggles that persist + drive a real subsystem. SOUND FX gates the SFX engine,
// MUSIC gates the background theme (independently — audio.ts musicOn/setMusic,
// owner 2026-07-20), HAPTICS gates juice.ts haptics. (Prior dead MUSIC/notification
// toggles were removed; MUSIC is now real.)
const SETTING_TOGGLES = ['SOUND FX', 'MUSIC', 'HAPTICS'] as const;

// Persisted toggles read by the SFX/music/juice modules. SOUND FX + MUSIC default
// ON ('0' = off); HAPTICS defaults OFF ('1' = on).
const TOGGLE_KEY: Partial<Record<(typeof SETTING_TOGGLES)[number], string>> = {
  'SOUND FX': 'skp_sound_fx',
  MUSIC: 'skp_music',
  HAPTICS: 'skp_haptics',
};
function readToggle(label: (typeof SETTING_TOGGLES)[number], fallback: boolean): boolean {
  const key = TOGGLE_KEY[label];
  if (!key || typeof localStorage === 'undefined') return fallback;
  const v = localStorage.getItem(key);
  if (v === null) return fallback;
  return label === 'SOUND FX' || label === 'MUSIC' ? v !== '0' : v === '1';
}
function writeToggle(label: (typeof SETTING_TOGGLES)[number], on: boolean): void {
  const key = TOGGLE_KEY[label];
  if (!key || typeof localStorage === 'undefined') return;
  localStorage.setItem(key, label === 'SOUND FX' ? (on ? '1' : '0') : on ? '1' : '0');
}

interface Me {
  wallet: string; name: string; keepLevel: number; deedAssetId?: string | null;
  avatarUrl: string | null;
  avatarUpdatedAt: string | null;
  /** Days until a rename is allowed (0 = now) — server-computed, never guessed. */
  nameCooldownDays?: number;
  /** Verified Seeker identity, or an unlinked stub. Server truth. */
  seeker?: SeekerStatus | null;
}

/**
 * The only documents the in-app legal reader may frame. These are the same
 * canonical public URLs submitted to the dApp Store; keeping the allowlist in
 * code means neither a query string nor server response can turn the restricted
 * frame into a general-purpose browser.
 */
export const LEGAL_DOCUMENTS = {
  TERMS: {
    label: 'TERMS OF USE',
    url: 'https://pixelkingdomwars.com/terms',
    frameTitle: 'Pixel Kingdom Wars Terms of Use',
  },
  PRIVACY: {
    label: 'PRIVACY POLICY',
    url: 'https://pixelkingdomwars.com/privacy',
    frameTitle: 'Pixel Kingdom Wars Privacy Policy',
  },
} as const;

type LegalDocumentKey = keyof typeof LEGAL_DOCUMENTS;

/**
 * Full legal delivery inside the existing lazy menu chunk. The empty sandbox
 * grants the remote, script-free documents no capabilities; they need only
 * render and scroll. Real anchors remain available for players who prefer the
 * system browser or need to copy/share a canonical document URL.
 */
export function AboutLegalPane(): React.JSX.Element {
  const [documentKey, setDocumentKey] = useState<LegalDocumentKey>('TERMS');
  const document = LEGAL_DOCUMENTS[documentKey];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Chip style={{ alignItems: 'flex-start' }}>
        <Icon name="info" size={22} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ color: C.goldHi, fontSize: 20 }}>{APP_VERSION_LABEL}</span>
          <span style={{ color: C.textFaint, fontSize: 14, lineHeight: 1.35 }}>
            SELECT A DOCUMENT TO READ ITS COMPLETE PUBLISHED TEXT HERE.
          </span>
        </div>
      </Chip>

      <div style={{ display: 'flex', gap: 4 }}>
        {(Object.keys(LEGAL_DOCUMENTS) as LegalDocumentKey[]).map((key) => (
          <Btn key={key} variant={documentKey === key ? 'gold' : 'ghost'} fontSize={16}
            style={{ flex: 1, padding: '7px 4px 9px' }} onClick={() => setDocumentKey(key)}>
            {LEGAL_DOCUMENTS[key].label}
          </Btn>
        ))}
      </div>

      <Chip style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
        {(Object.keys(LEGAL_DOCUMENTS) as LegalDocumentKey[]).map((key) => (
          <a key={key} className="interactive" href={LEGAL_DOCUMENTS[key].url}
            target="_blank" rel="noopener noreferrer"
            style={{ color: C.gold, fontSize: 14, padding: '5px 0' }}>
            OPEN {LEGAL_DOCUMENTS[key].label} ↗
          </a>
        ))}
      </Chip>

      {/* The Terms promise support by email; the app must carry the same
          address and the Discord invite where a player will look for them
          (D-098, owner 2026-09-02). */}
      <Chip style={{ alignItems: 'flex-start' }}>
        <Icon name="info" size={20} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 14 }}>SUPPORT</span>
          <SupportLinks topic="Pixel Kingdom Wars support" fontSize={14} />
        </div>
      </Chip>

      <iframe
        key={documentKey}
        src={document.url}
        title={document.frameTitle}
        loading="lazy"
        sandbox=""
        referrerPolicy="no-referrer"
        style={{
          display: 'block', width: '100%', height: 'min(64vh, 720px)', minHeight: 320,
          border: `2px solid ${C.borderLt}`, background: C.surface,
        }}
      />
    </div>
  );
}

interface AvatarMutation {
  avatarUrl: string | null;
  avatarUpdatedAt: string;
}

/** Wallet identity photo. The native file picker works for desktop files and
 * phone photo libraries; the server owns decoding, crop, metadata stripping,
 * and every size/type limit. A local object URL exists only while that exact
 * upload is pending, then the immutable content-addressed CDN URL takes over. */
export function AvatarEditor({ avatarUrl, name }: {
  avatarUrl: string | null;
  name: string;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const opRef = useRef(0);
  const previewRef = useRef<string | null>(null);
  const [override, setOverride] = useState<string | null | undefined>(undefined);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const shown = preview ?? (override === undefined ? avatarUrl : override);

  const clearPreview = (): void => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreview(null);
  };
  useEffect(() => () => {
    opRef.current += 1;
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  const choose = (file: File | undefined): void => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('CHOOSE A JPG, PNG, OR WEBP IMAGE');
      return;
    }
    const op = ++opRef.current;
    clearPreview();
    const local = URL.createObjectURL(file);
    previewRef.current = local;
    setPreview(local);
    setBusy(true);
    setError(null);
    setNotice(null);
    void api.patchBinary<AvatarMutation>('/me/avatar', file)
      .then((result) => {
        if (op !== opRef.current) return;
        clearPreview();
        setOverride(result.avatarUrl);
        setNotice('AVATAR SAVED');
        toast('AVATAR SAVED');
      })
      .catch((cause: Error) => {
        if (op !== opRef.current) return;
        clearPreview();
        setError(cause.message.toUpperCase());
        toast(cause.message.toUpperCase());
      })
      .finally(() => { if (op === opRef.current) setBusy(false); });
  };
  const remove = (): void => {
    const op = ++opRef.current;
    clearPreview();
    setBusy(true);
    setError(null);
    setNotice(null);
    void api.del<AvatarMutation>('/me/avatar')
      .then((result) => {
        if (op !== opRef.current) return;
        setOverride(result.avatarUrl);
        const message = result.avatarUrl ? 'AVATAR CHANGED IN ANOTHER SESSION' : 'AVATAR REMOVED';
        setNotice(message);
        toast(message);
      })
      .catch((cause: Error) => {
        if (op !== opRef.current) return;
        setError(cause.message.toUpperCase());
        toast(cause.message.toUpperCase());
      })
      .finally(() => { if (op === opRef.current) setBusy(false); });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', flex: 'none' }}>
      <button
        className="interactive"
        type="button"
        aria-label={shown ? 'Change profile avatar' : 'Upload profile avatar'}
        aria-busy={busy}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        style={{
          position: 'relative', width: 64, height: 64, padding: 4,
          border: `2px solid ${C.goldDp}`, background: C.ink, cursor: busy ? 'wait' : 'pointer',
        }}>
        <Sprite name={troopPortrait('highlander')} w={52} h={52} />
        {shown && <img key={shown} src={shown} alt={`${name || 'Player'} avatar`} width={52} height={52}
          onLoad={(event) => { event.currentTarget.hidden = false; }}
          onError={(event) => { event.currentTarget.hidden = true; }}
          style={{
            position: 'absolute', left: 4, top: 4, width: 52, height: 52,
            objectFit: 'cover', imageRendering: 'pixelated',
          }} />}
        {busy && <span aria-hidden="true" style={{
          position: 'absolute', inset: 4, display: 'grid', placeItems: 'center',
          background: 'rgba(20,18,26,.72)', color: C.goldHi, fontSize: 13,
        }}>SAVING</span>}
      </button>
      <input
        ref={inputRef}
        className="interactive"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-label="Choose profile avatar image"
        hidden
        onChange={(event) => {
          choose(event.currentTarget.files?.[0]);
          event.currentTarget.value = '';
        }}
      />
      <div style={{ display: 'flex', gap: 5 }}>
        <Btn variant="sec" fontSize={12} disabled={busy}
          style={{ padding: '4px 10px 6px', minHeight: 44 }}
          onClick={() => inputRef.current?.click()}>
          {shown ? 'CHANGE' : 'UPLOAD'}
        </Btn>
        {shown && <Btn variant="ghost" fontSize={12} disabled={busy}
          style={{ padding: '4px 10px 6px', minHeight: 44 }} onClick={remove}>REMOVE</Btn>}
      </div>
      {(busy || notice) && <span role="status" aria-live="polite"
        style={{ color: busy ? C.goldHi : C.success, fontSize: 12 }}>
        {busy ? 'SAVING AVATAR' : notice}
      </span>}
      {error && <span role="alert" style={{ color: C.danger, fontSize: 12, maxWidth: 150 }}>{error}</span>}
    </div>
  );
}

/**
 * D-103: the three referral counts beside the code — INVITED (joined with
 * your code), QUALIFIED (bought land and reached Keep 3: the D-052 bar that
 * pays daily referral points) and ACTIVE TODAY (qualified friends who acted
 * today, which is what pays). Server counts from /tester/me; nothing renders
 * until they exist, so an older API cut shows the code chip exactly as before.
 */
export function ReferralCounts({ referrals }: { referrals: TesterReferralsDto | null }): React.JSX.Element | null {
  if (!referrals) return null;
  const cell = (label: string, n: number): React.JSX.Element => (
    <span key={label} style={{ display: 'inline-flex', gap: 4, alignItems: 'baseline' }}>
      <span style={{ color: C.textFaint, fontSize: 12, letterSpacing: 1 }}>{label}</span>
      <span style={{ color: n > 0 ? C.goldHi : C.textDim, fontSize: 16 }}>{n}</span>
    </span>
  );
  return (
    <Chip style={{ gap: 12, flexWrap: 'wrap', fontSize: 14 }}>
      {cell('INVITED', referrals.invited)}
      {cell('QUALIFIED', referrals.qualified)}
      {cell('ACTIVE TODAY', referrals.activeToday)}
    </Chip>
  );
}

/** The entire referral is one copyable value; mobile wrapping must never imply
 * that only the suffix is the code. Clipboard success is acknowledged afterward. */
export function ReferralCodeChip({ code }: {
  code: { code: string; bonusBps?: number } | null;
}): React.JSX.Element {
  const [copying, setCopying] = useState(false);
  const copy = async (link: boolean): Promise<void> => {
    if (!code?.code || copying) return;
    if (!navigator.clipboard?.writeText) {
      toast('COPY UNAVAILABLE — SELECT THE FULL CODE');
      return;
    }
    setCopying(true);
    try {
      await navigator.clipboard.writeText(link
        ? `${window.location.origin}/?ref=${encodeURIComponent(code.code)}` : code.code);
      if (link) track(EVENTS.REFERRAL_LINK_SHARED, {});
      toast(link ? 'REFERRAL LINK COPIED — OPTIONAL CODE, SAME FRIEND BENEFITS' : 'FULL REFERRAL CODE COPIED');
    } catch {
      toast('COULD NOT COPY — SELECT THE FULL CODE');
    } finally {
      setCopying(false);
    }
  };
  return (
    <Chip style={{ flexWrap: 'wrap', gap: 8 }}>
      <Icon name="referral" size={22} />
      <div style={{ flex: '1 1 140px', minWidth: 0 }}>
        <div style={{ color: C.textFaint, fontSize: 13 }}>REFERRAL CODE</div>
        <span className="copyable copyable-all" style={{ display: 'inline-block', whiteSpace: 'nowrap' }}>
          {code?.code ?? '…'}
        </span>
      </div>
      <span style={{ color: (code?.bonusBps ?? 0) > 0 ? C.goldHi : C.textFaint, fontSize: 13, whiteSpace: 'nowrap' }}>
        +{((code?.bonusBps ?? 0) / 100).toFixed(1)}% MINING
      </span>
      <div style={{ width: '100%', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Btn variant="sec" fontSize={15} disabled={!code?.code || copying}
          style={{ minHeight: 44, padding: '7px 12px' }} onClick={() => { void copy(false); }}>COPY CODE</Btn>
        <Btn variant="sec" fontSize={15} disabled={!code?.code || copying}
          style={{ minHeight: 44, padding: '7px 12px' }} onClick={() => { void copy(true); }}>SHARE LINK</Btn>
      </div>
    </Chip>
  );
}

export function ProfileScreen(): React.JSX.Element {
  const landOwned = useLandOwned();
  const wallet = useApp((s) => s.wallet);
  const balances = useApp((s) => s.balances);
  const base = useApp((s) => s.base);
  const baseDirectory = useApp((s) => s.baseDirectory);
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const reduceMotion = useApp((s) => s.reduceMotion);
  const setReduceMotion = useApp((s) => s.setReduceMotion);
  const setScreen = useApp((s) => s.setScreen);
  const setAuth = useApp((s) => s.setAuth);
  const { disconnect } = useWallet();
  const doSignOut = useSignOut();
  const { data: code } = useFetch<{ code: string; bonusBps?: number }>(
    () => api.get<{ code: string; bonusBps?: number }>('/referrals/code'),
  );
  // D-103 referral counts ride the one shared /tester/me read (cached for the
  // server's recompute gate) — no endpoint of their own.
  const { data: testerMe } = useTesterMe();
  const { data: me, reload: reloadMe } = useFetch<Me>(() => api.get<Me>('/me'));
  // GUIDED FIRST RUN — the undo for a mis-tapped SKIP (owner 2026-08-29: the
  // guided flow must be skippable, and a player who skipped by accident must be
  // able to get it back). Server-stored, so this reads the row rather than a
  // local flag; `guideSkipped` is absent on a server that predates the switch,
  // which correctly reads as "still guided".
  const { data: tutorialState, reload: reloadTutorial } =
    useFetch<TutorialStateDto>(() => api.get<TutorialStateDto>('/tutorial'));
  const [toggles, setToggles] = useState<Record<string, boolean>>({
    // HAPTICS defaults ON inside the Solana-Mobile shell (owner 2026-08-16),
    // matching juice.ts's own gate; an explicit choice always wins.
    'SOUND FX': readToggle('SOUND FX', true), MUSIC: readToggle('MUSIC', true), HAPTICS: readToggle('HAPTICS', isSolanaMobileClient()),
  });
  // The KEEP-spend guard's reversible half (player report 2026-08-29): the
  // dialog's own DON'T ASK AGAIN can only turn this OFF, so it has to be
  // turn-back-on-able from here.
  const [confirmKeep, setConfirmKeepState] = useState(keepConfirmOn());
  // Solana-Mobile shell prefs (owner 2026-08-16).
  const [landscape, setLandscapeState] = useState(landscapePref());
  // The single NOTIFICATIONS toggle (D-101): raids, Mines, builds, troops and mail
  // ride one push subscription. ON means opted in AND the permission is still
  // granted — a browser-side revoke reads as OFF and re-arms cleanly.
  const [pushOn, setPushOn] = useState(
    pushOptedIn() && notificationsGranted() && pushNotificationsSupported(),
  );
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    const refreshPushStatus = (): void => {
      setPushOn(pushOptedIn() && notificationsGranted() && pushNotificationsSupported());
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refreshPushStatus();
    };
    window.addEventListener('focus', refreshPushStatus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refreshPushStatus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  // Opt-in perf diagnostics (D-101 "measure first"): the flag only; the
  // measurement module loads on demand from PhaserGame while it is on.
  const [diag, setDiagState] = useState(perfDiagEnabled());
  // ABOUT stays in this menu module so both legal documents remain in the
  // existing lazy profile chunk rather than adding anything to first paint.
  const [profileTab, setProfileTab] = useState<'PROFILE' | 'WALLET' | 'ABOUT'>('PROFILE');
  // Inline name editor (PATCH /me). `nameOverride` reflects a successful save
  // immediately — the /me fetch is cached and not re-run within this screen.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  /** Server rejection (taken / charset / cooldown), shown inline under the input
   *  as well as toasted — the toast is gone in 1.6s and the reason matters. */
  const [nameError, setNameError] = useState<string | null>(null);
  // No invented fallback: an unnamed account is PROMPTED to choose, it is not
  // silently labelled 'SKEEP_LORD' (which every unnamed player used to share).
  const shownName = nameOverride ?? (me?.name || '');
  // Server-owned Seeker state; `seekerOverride` reflects a link/unlink made on
  // this screen without re-fetching the whole /me payload.
  const [seekerOverride, setSeekerOverride] = useState<SeekerStatus | null | undefined>(undefined);
  const seeker = seekerOverride !== undefined ? seekerOverride : me?.seeker ?? null;
  const activeDirectoryBases = baseDirectory?.bases.filter(
    (candidate) => candidate.status === 'active' && candidate.slot !== null,
  ) ?? [];
  const selectedDirectoryBase = baseDirectory?.enabled
    ? activeDirectoryBases.find((candidate) => candidate.id === selectedBaseId)
      ?? (activeDirectoryBases.length === 1 ? activeDirectoryBases[0] : undefined)
    : undefined;
  // Under multi-base, the selected stable base is the only deed identity that
  // may be paired with the selected parcel. The wallet compatibility scalar is
  // intentionally ignored because it can name another owned deed.
  const profileDeedAssetId = baseDirectory?.enabled
    ? selectedDirectoryBase?.deedAssetId ?? null
    : me?.deedAssetId ?? null;
  // Pair the deed with its persisted location from the same selected base.
  // Never fall back to private Earth bindings after fantasy cutover.
  const profileLocationBase = baseDirectory?.enabled
    ? selectedDirectoryBase
    : baseDirectory?.bases.find((candidate) => (
      candidate.deedAssetId !== null && candidate.deedAssetId === profileDeedAssetId
    ));
  const profileLocation = profileLocationBase
    ? baseLocationLabel(profileLocationBase, fantasyDirectory(baseDirectory)) : 'YOUR LAND TITLE';
  /** Server-computed days left on the rename cooldown (0 = can rename now). */
  const nameCooldownDays = me?.nameCooldownDays ?? 0;
  /** The name was ADOPTED from a proven `.skr` (server does this on link when
   *  the account had no name), so it must be explained rather than look magic. */
  const nameFromDomain = !!seeker?.linked && !!seeker.skrDomain
    && shownName.toLowerCase() === seeker.skrDomain.toLowerCase();

  const short = wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : 'NO WALLET';
  const startEditName = (): void => { setNameDraft(shownName); setNameError(null); setEditingName(true); };
  const cancelEditName = (): void => { setNameError(null); setEditingName(false); };
  // The server owns every rule (USERNAMES in @shardkeep/shared): 3–16 chars,
  // letters/digits/_/- only, case-insensitively unique, one change per
  // USERNAMES.changeCooldownDays. Surface its message verbatim — including the
  // 409 "already taken", which only the DB can decide.
  const saveName = (): void => {
    const name = nameDraft.trim();
    if (!name) { setNameError('ENTER A NAME'); toast('ENTER A NAME'); return; }
    void api.patch<{ name: string }>('/me', { name })
      .then((r) => {
        setNameOverride(r.name); setNameError(null); setEditingName(false); toast('NAME SAVED');
        // Refetch so the rename cooldown shown underneath is the server's, not
        // the pre-save one.
        reloadMe();
      })
      .catch((e: Error) => { setNameError(e.message.toUpperCase()); toast(e.message.toUpperCase()); });
  };
  // App UNLINK clears the wallet flag in place (App L1054 S.wallet=false),
  // distinct from SIGN OUT which ends the session. Disconnect the adapter and
  // clear app wallet/auth state; stay on the profile screen.
  const unlink = (): void => {
    // Preserve the preference for a future link, but sever this session's
    // private push endpoint before the wallet/auth identity disappears.
    void suspendPushSession();
    setAuth(null);
    void disconnect().catch(() => null);
    toast('WALLET UNLINKED');
  };
  // SIGN OUT ends the server session, logs out of Privy (so another social
  // account can sign in), disconnects the adapter, then clears client state —
  // unified in useSignOut (shared with the entry paywall's escape hatch).
  const signOut = (): void => { void doSignOut(); };
  // REPLAY TUTORIAL (M23 a6): the tutorial is server-stored, so replay is a
  // server reset — republish the SERVER's answer on the bus so the eager
  // TutorialHost re-arms, then land on the base where the first card lives.
  const replayTutorial = (): void => {
    void api.postRaw<TutorialStateDto>('/tutorial/reset', {})
      .then((s) => {
        bus.emit('tutorial:state', s);
        reloadTutorial();
        toast('TUTORIAL RESTARTED');
        home();
      })
      .catch(() => toast('COULD NOT RESTART THE TUTORIAL — TRY AGAIN'));
  };
  // Same contract as REPLAY: the server owns the bit, and its answer is
  // republished on the bus so the eager TutorialHost re-arms without a refetch.
  // Turning it OFF from here is the same request the in-game SKIP makes.
  const guided = tutorialState?.guideSkipped !== true;
  const toggleGuidance = (): void => {
    void api.postRaw<TutorialStateDto>(guided ? '/tutorial/guide/skip' : '/tutorial/guide/resume', {})
      .then((s) => {
        bus.emit('tutorial:state', s);
        reloadTutorial();
        toast(guided ? 'GUIDANCE OFF' : 'GUIDANCE ON');
      })
      .catch(() => toast('COULD NOT CHANGE GUIDANCE — TRY AGAIN'));
  };

  return (
    <ScrollPage title="PROFILE" onClose={home}
      tabs={
        /* PROFILE | WALLET | ABOUT. Wallet and legal delivery stay in the same
           lazy menu chunk, outside first paint. */
        <div style={{ display: 'flex', gap: 4, padding: '8px 10px 0', background: C.card }}>
          {(['PROFILE', 'WALLET', 'ABOUT'] as const).map((t) => (
            <Btn key={t} variant={profileTab === t ? 'gold' : 'ghost'} fontSize={18}
              style={{ flex: 1, padding: '6px 0 8px' }} onClick={() => setProfileTab(t)}>{t}</Btn>
          ))}
        </div>
      }>
      {profileTab === 'WALLET' ? <WalletTab wallet={wallet} />
        : profileTab === 'ABOUT' ? <AboutLegalPane /> : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <Chip style={{
          padding: 10, alignItems: 'flex-start', flexWrap: 'wrap', rowGap: 10,
          maxWidth: '100%', overflow: 'hidden',
        }}>
          <AvatarEditor avatarUrl={me?.avatarUrl ?? null} name={shownName} />
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 2,
            flex: '1 1 140px', minWidth: 0,
          }}>
            {/* Read-only identity line. The badge sits with the NAME wherever a
                player is identified; the EDITOR lives in SETTINGS › USERNAME
                below (owner 2026-07-29: setting a name is a settings action,
                not something to do from the base HUD). */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {seeker?.linked && <SeekerBadge size={19} />}
              <span style={{
                fontSize: 23, color: shownName ? C.text : C.textFaint,
                minWidth: 0, overflowWrap: 'anywhere',
              }}>
                {shownName || 'NO NAME YET'}
              </span>
            </div>
            <span style={{ color: C.textFaint, fontSize: 16 }}>
              {seeker?.linked && (
                <span style={{ color: C.goldHi }}>
                  SEEKER{seeker.memberNumber !== null ? ` #${seeker.memberNumber}` : ''} ·{' '}
                </span>
              )}
              KEEP L{base?.player.keepLevel ?? me?.keepLevel ?? 1} · {base?.player.league ?? '—'}
            </span>
          </div>
          <Sp />
          <Pill><Icon name="trophy" size={20} /><PillVal>{fmtN(base?.player.trophies ?? 0)}</PillVal></Pill>
        </Chip>
        {/* App wallet chip has both COPY and UNLINK (App L1052-1054). */}
        <Chip>
          <Icon name="sol" size={22} /><span style={{ color: C.textDim }}>{short}</span><Sp />
          <Btn variant="sec" fontSize={15} style={{ padding: '4px 10px 6px' }} onClick={() => { if (wallet) void navigator.clipboard?.writeText(wallet); toast('ADDRESS COPIED'); }}>COPY</Btn>
          <Btn variant="ghost" fontSize={15} style={{ padding: '4px 10px 6px' }} onClick={unlink}>UNLINK</Btn>
        </Chip>
        <Chip><Icon name="keep" size={22} /><span>KEEP BALANCE</span><Sp /><span style={{ color: C.goldHi }}>{fmtN(Number(balances?.keep ?? 0))}</span></Chip>
        <Chip><Icon name="shard" size={22} /><span>SHARD BALANCE</span><Sp /><span style={{ color: C.sky }}>{fmtN(Number(balances?.shards ?? 0))}</span></Chip>
        {/* Land Deed (Phase 6): the TITLE to this base's land — the thing 0.2
            SOL buys, and what unlocks the forge, the market and PvP. Conveys
            structures and land, never currency. It is TRADEABLE
            (MARKETPLACE.tradingEnabled is true, and deed.ts mints with
            `frozen: !tradingEnabled`), so the old "soulbound" copy here was
            false — selling the deed sells the base (baseTransfer.ts). */}
        {profileDeedAssetId && (
          <Chip>
            <Icon name="keep" size={22} /><span>LAND DEED</span><Sp />
            {/* Show only the selected deed's verified directory location. */}
            <span style={{ color: C.textFaint, fontSize: 13 }}>
              {profileDeedAssetId.slice(0, 4)}…{profileDeedAssetId.slice(-4)}
              {` · ${profileLocation}`}
            </span>
            <Btn variant="sec" fontSize={15} style={{ padding: '4px 10px 6px' }}
              onClick={() => { void navigator.clipboard?.writeText(profileDeedAssetId); toast('DEED ADDRESS COPIED'); }}>COPY</Btn>
            <a className="interactive" style={{ fontSize: 13, color: C.gold }}
              href={explorerUrl('address', profileDeedAssetId)}
              target="_blank" rel="noreferrer">VIEW ↗</a>
          </Chip>
        )}
        <Chip onClick={() => setScreen('raidlog')}><Icon name="replay" size={22} /><span>RAID LOG &amp; REPLAYS</span><Sp /><span style={{ color: C.textFaint }}>PERMANENT HISTORY ›</span></Chip>
        {/* The subtitle is a promise about what is behind the chip, and for a
            deedless player still has historical command recovery. Current GET /clans
            and /clans/mine remain owned, so the roster and leaderboard need land. */}
        <Chip onClick={() => setScreen('clans')}><Icon name="shield" size={22} /><span>CLANS</span><Sp />
          <span style={{ color: landOwned ? C.textFaint : C.gold }}>
            {landOwned ? 'ROSTER · CHEST · LEADERBOARD ›' : 'SAVED COMMANDS · ROSTER NEEDS LAND ›'}
          </span>
        </Chip>
        {/* Referral attribution is optional in the open playtest. The chip shows
            the LIVE mining bonus (+0.5% per active referred deed at Keep 3+,
            lapsing while that player is away). SHARE copies the full link. */}
        <ReferralCodeChip code={code} />
        <ReferralCounts referrals={testerMe?.referrals ?? null} />
        <ReferralEntry />

        {/* A link can ADOPT the proven `.skr` as the username server-side, so a
            link/unlink has to refresh /me — otherwise the name above stays
            blank until the screen is reopened. SeekerDoor: the full section
            only for the linked; everyone else gets one low-key line (Seekers
            on their own wallet are auto-detected at the alpha gate after sign-in,
            2026-08-08). */}
        <SeekerDoor status={seeker} onChange={(s) => { setSeekerOverride(s); reloadMe(); }} />

        <Phead title={<span style={{ fontSize: 19 }}>SETTINGS</span>} fontSize={19} />
        {/* Account identity/security is auth-only, not a deed perk. Keep this row
            unconditional so every admitted player can reach email and 2FA. */}
        <AccountSecuritySetting onOpen={() => setScreen('security')} />
        {/* USERNAME — the one place a name is chosen or changed. */}
        {editingName ? (
          <>
            <Chip style={{ gap: 6 }}>
              <input className="interactive" value={nameDraft} maxLength={USERNAMES.maxLen} autoFocus
                onChange={(e) => { setNameDraft(e.target.value); setNameError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') cancelEditName(); }}
                placeholder={`USERNAME (${USERNAMES.minLen}–${USERNAMES.maxLen})`}
                style={{ flex: 1, minWidth: 0, fontFamily: 'inherit', fontSize: 17, background: C.surface, color: C.text, border: `2px solid ${C.border}`, padding: '4px 8px' }} />
              <Btn variant="sec" fontSize={15} style={{ padding: '4px 10px 6px' }} onClick={saveName}>SAVE</Btn>
              <Btn variant="ghost" fontSize={15} style={{ padding: '4px 10px 6px' }} onClick={cancelEditName}>✕</Btn>
            </Chip>
            {/* The server owns every rule; this only says what they are. */}
            <div style={{ color: nameError ? C.danger : C.textFaint, fontSize: 13, lineHeight: 1.35 }}>
              {nameError ?? `LETTERS, DIGITS, _ AND - · ${USERNAMES.minLen}–${USERNAMES.maxLen} CHARACTERS · MUST BE UNIQUE`}
            </div>
          </>
        ) : (
          <Chip>
            <Icon name="settings" size={22} /><span>USERNAME</span><Sp />
            {seeker?.linked && <SeekerBadge size={17} />}
            <span style={{ color: shownName ? C.text : C.textFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {shownName || 'NOT SET'}
            </span>
            <Btn variant="sec" fontSize={15} style={{ padding: '4px 10px 6px' }} onClick={startEditName}>
              {shownName ? 'CHANGE' : 'SET NAME'}
            </Btn>
          </Chip>
        )}
        {!editingName && (
          <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.35 }}>
            {!shownName
              ? 'THIS IS THE NAME OTHER PLAYERS SEE ON THE MAP, IN THE RAID LOG AND ON MARKET LISTINGS.'
              : nameFromDomain
                // A Seeker who never picked a name gets their PROVEN .skr adopted
                // as their username — say so, or the name looks like it appeared
                // from nowhere and they hunt for the setting that "did it".
                ? `THIS NAME COMES FROM YOUR VERIFIED ${seeker?.skrDomain?.toUpperCase() ?? ''} DOMAIN — ADOPTED WHEN YOU LINKED YOUR SEEKER. CHANGING IT REPLACES IT WITH A NAME YOU PICK.`
                : nameCooldownDays > 0
                  ? `NAME LOCKED FOR ${nameCooldownDays} MORE DAY${nameCooldownDays === 1 ? '' : 'S'} — ONE CHANGE EVERY ${USERNAMES.changeCooldownDays} DAYS.`
                  : `ONE CHANGE EVERY ${USERNAMES.changeCooldownDays} DAYS.`}
          </div>
        )}
        {/* The tutorial is replayable BY DESIGN (owner M23 a6) — this is the
            one place that says so. Routes back to the base, where the run
            starts over from the welcome card. */}
        <Chip>
          <Icon name="info" size={22} /><span>TUTORIAL</span><Sp />
          <Btn variant="sec" fontSize={15} style={{ padding: '4px 10px 6px' }} onClick={replayTutorial}>
            REPLAY TUTORIAL
          </Btn>
        </Chip>
        {/* THE SKIP IS REVERSIBLE (owner 2026-08-29). SKIP is one tap on a strip
            a new player is looking at anyway, so it will be pressed by accident;
            without this, that accident is permanent. It is a switch rather than a
            second REPLAY because it does not rewind anything — the onboarding
            quests keep their progress and their rewards either way, which is the
            whole distinction between skipping the guide and abandoning it. */}
        <Chip>
          <span>GUIDED FIRST RUN</span>
          <span style={{ color: C.textFaint, fontSize: 12 }}>SHOW ME WHERE TO TAP</span>
          <Sp />
          <Switch on={guided} onClick={toggleGuidance} />
        </Chip>
        <Chip>
          <span>REDUCE MOTION</span><Sp />
          <Switch on={reduceMotion} onClick={() => setReduceMotion(!reduceMotion)} />
        </Chip>
        <Chip>
          <span>CONFIRM KEEP SPENDS</span>
          <span style={{ color: C.textFaint, fontSize: 12 }}>ASK BEFORE A SPEED-UP</span>
          <Sp />
          <Switch on={confirmKeep} onClick={() => {
            const next = !confirmKeep;
            setConfirmKeepState(next);
            setKeepConfirm(next);
          }} />
        </Chip>
        {SETTING_TOGGLES.map((k) => (
          <Chip key={k}>
            <span>{k}</span><Sp />
            <Switch on={!!toggles[k]} onClick={() => setToggles((t) => {
              const next = !t[k];
              writeToggle(k, next);
              if (k === 'MUSIC') setMusic(next);
              if (k === 'SOUND FX') setSoundFx(next);
              return { ...t, [k]: next };
            })} />
          </Chip>
        ))}
        {/* Solana-Mobile shell prefs (owner 2026-08-16). The lock only takes
            effect inside the installed app (browsers refuse orientation
            locks); the toggle records intent either way. */}
        <Chip>
          <span>LANDSCAPE LOCK</span>
          <span style={{ color: C.textFaint, fontSize: 12 }}>INSTALLED APP</span>
          <Sp />
          <Switch on={landscape} onClick={() => {
            const next = !landscape;
            setLandscapeState(next);
            setLandscapePref(next);
          }} />
        </Chip>
        <Chip>
          <span>NOTIFICATIONS</span>
          <span style={{ color: C.textFaint, fontSize: 12 }}>
            {pushBusy ? 'SYNCING…' : 'RAIDS · MINES · BUILDS · TROOPS · MAIL'}
          </span>
          <Sp />
          <Switch on={pushOn} onClick={() => {
            if (pushBusy) return;
            setPushBusy(true);
            if (pushOn) {
              setPushOn(false);
              void disablePush().finally(() => setPushBusy(false));
              return;
            }
            void enablePush().then((granted) => {
              setPushOn(granted);
              if (!granted) toast('NOTIFICATIONS ARE UNAVAILABLE — ALLOW THEM IN YOUR BROWSER OR APP SETTINGS');
            }).finally(() => setPushBusy(false));
          }} />
        </Chip>
        {/* Perf diagnostics (D-101): the overlay + one perf_summary telemetry
            event a minute, from any real device — the numbers every later
            Solana-Mobile perf cut is judged on. Off by default; costs nothing
            until switched on. */}
        <Chip>
          <span>DIAGNOSTICS</span>
          <span style={{ color: C.textFaint, fontSize: 12 }}>PERF OVERLAY</span>
          <Sp />
          <Switch on={diag} onClick={() => {
            const next = !diag;
            setDiagState(next);
            setPerfDiagEnabled(next);
          }} />
        </Chip>
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <Btn variant="ghost" style={{ flex: 1 }} onClick={() => setProfileTab('ABOUT')}><Icon name="info" size={20} />ABOUT</Btn>
          <Btn variant="ghost" style={{ flex: 1, color: C.blood, border: `2px solid ${C.blood}` }} onClick={signOut}>SIGN OUT</Btn>
        </div>
      </div>
      )}
    </ScrollPage>
  );
}

// ===========================================================================
// CLANS (Phase 3 pulled forward — CLANS-SELLABLE-DEEDS-PLAN C4)
// ===========================================================================

interface ClanRosterRow {
  wallet: string; name: string; keepLevel: number; trophies: number; joinedAt: string;
  /** Verified Seeker (server-denormalized) — badge beside the roster name. */
  seeker?: boolean;
}
interface MyClanDto {
  clan: {
    id: string; name: string; tag: string; inviteMode: 'open' | 'invite';
    leaderWallet: string; inviteCode: string | null; roster: ClanRosterRow[];
  } | null;
}
interface ClanListDto { clans: Array<{ id: string; name: string; tag: string; inviteMode: 'open' | 'invite'; members: number; trophies: number }> }

/** Current roster reads remain land-owned. Immutable command history is
 * authenticated-only and must remain reachable after the original deed is lost. */
export function ClansScreen(): React.JSX.Element {
  const recovery = useClanRecovery(); const landOwned = useLandOwned();
  const close = (): void => { recovery.controller?.dismiss(); home(); };
  return <ScrollPage title="CLANS" onClose={close}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {recovery.controller && <ClanRecoveryPanel key={`recovery:${recovery.controller.store.key}`} controller={recovery.controller} state={recovery.state} />}
      {landOwned ? <ClansOwnedScreen key={`roster:${recovery.controller?.store.key ?? 'signed-out'}`} controller={recovery.controller} state={recovery.state} />
        : <LandLocked {...LAND_LOCKED.clans} entryFeeSol={ECONOMY.entryFeeSol} onBuy={buyLand} />}
    </div>
  </ScrollPage>;
}

function ClansOwnedScreen({ controller, state }: { controller: ClanController | null; state: ClanState }): React.JSX.Element {
  const wallet = useApp((s) => s.wallet);
  const { data: mine, reload: reloadMine } = useFetch<MyClanDto>(() => api.get('/clans/mine'));
  const { data: list, reload: reloadList } = useFetch<ClanListDto>(() => api.get('/clans'));
  const busy = !controller || !state.loaded || !state.supported || state.busy || Boolean(state.journal?.intent && !state.journal.finished);
  const refreshed = state.journal?.hydrated ? state.journal.intent?.request.idempotencyKey : null;
  useEffect(() => { if (refreshed) { reloadMine(); reloadList(); } }, [refreshed, reloadMine, reloadList]);
  const clan = mine?.clan ?? null;
  const isLeader = clan !== null && clan.leaderWallet === wallet;

  return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {clan ? (
          <>
            <Chip><span style={{ fontSize: 13, color: C.goldHi }}>
              CLAN WARFARE — COMING SOON AFTER THE PLAYTEST. YOUR CLAN AND CHEST ARE PRESERVED.
            </span></Chip>
            <Phead title={<span style={{ fontSize: 18 }}>[{clan.tag}] {clan.name}</span>} fontSize={18} />
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: C.textFaint }}>
                {clan.inviteMode === 'invite' ? 'INVITE-ONLY' : 'OPEN'} · {clan.roster.length} MEMBER{clan.roster.length === 1 ? '' : 'S'}
              </span>
              <Sp />
              {clan.inviteCode && (
                <span className="interactive" style={{ fontSize: 13, color: C.goldHi, cursor: 'pointer' }}
                  onClick={() => { void navigator.clipboard.writeText(clan.inviteCode!); toast('INVITE CODE COPIED'); }}>
                  CODE {clan.inviteCode} ⧉
                </span>
              )}
            </div>
            {/* The weekly chest: funded by 2% of every member's raid loot, split
              * evenly each Monday. The countdown is the league reset's clock. */}
            <Chip><span style={{ fontSize: 13 }}>WEEKLY CHEST — 2% OF EVERY MEMBER'S RAID LOOT, SPLIT EVENLY AT THE MONDAY RESET</span></Chip>
            {clan.roster.map((r) => (
              <div key={r.wallet} style={{ background: C.card, border: `2px solid ${C.border}`, padding: '6px 10px', display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ color: r.wallet === clan.leaderWallet ? C.gold : C.text, fontSize: 14, flex: 1, minWidth: 0 }}>
                  {r.wallet === clan.leaderWallet ? '♛ ' : ''}
                  <PlayerName name={r.name} wallet={r.wallet} seeker={r.seeker} size={13} />
                </span>
                <span style={{ fontSize: 12, color: C.textFaint }}>K{r.keepLevel}</span>
                <span style={{ fontSize: 13, color: C.goldHi }}>🏆{r.trophies}</span>
                {isLeader && r.wallet !== wallet && (
                  <Btn variant="ghost" fontSize={12} disabled={busy}
                    onClick={() => void controller?.review({ kind: 'kick', clanId: clan.id, target: r.wallet })}>KICK</Btn>
                )}
              </div>
            ))}
            <Btn variant="ghost" style={{ color: C.blood, border: `2px solid ${C.blood}` }} disabled={busy}
              onClick={() => void controller?.review({ kind: 'leave', clanId: clan.id })}>
              {isLeader ? (clan.roster.length > 1 ? 'LEAVE (KICK MEMBERS FIRST)' : 'DISBAND CLAN') : 'LEAVE CLAN'}
            </Btn>
          </>
        ) : (
          // M23 a17 (owner 2026-08-15): clans arrive as a major update after
          // closed alpha. Founding and joining are closed (the server refuses
          // them too — CLANS_COMING_SOON); the leaderboard stays as a read-only
          // preview of the clans founded before the freeze.
          <>
            <div style={{
              background: C.card, border: `2px solid ${C.gold}`, padding: '18px 14px',
              display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', textAlign: 'center',
            }}>
              <span style={{ fontSize: 22, color: C.goldHi, letterSpacing: '3px' }}>CLANS — COMING SOON</span>
              <span style={{ fontSize: 14, color: C.textDim, lineHeight: 1.5, maxWidth: 340 }}>
                Clan warfare arrives as a major update after the playtest.
                Existing clans and their weekly chests are preserved.
              </span>
            </div>
            {(list?.clans ?? []).length > 0 && (
              <>
                <Phead title={<span style={{ fontSize: 16 }}>FOUNDING CLANS</span>} fontSize={16} />
                {(list?.clans ?? []).map((c2, i) => (
                  <div key={c2.id} style={{ background: C.card, border: `2px solid ${C.border}`, padding: '6px 10px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ color: C.textFaint, fontSize: 13, width: 22 }}>#{i + 1}</span>
                    <span style={{ color: C.text, fontSize: 14 }}>[{c2.tag}] {c2.name}</span>
                    <Sp />
                    <span style={{ fontSize: 12, color: C.textFaint }}>{c2.members}/{CLANS.rosterCap}</span>
                    <span style={{ fontSize: 13, color: C.goldHi }}>🏆{fmtN(c2.trophies)}</span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
  );
}
