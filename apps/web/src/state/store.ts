import type { BaseVisualContext } from '@shardkeep/shared/baseVisual';
/**
 * Zustand app store: screen routing + the server-state caches the Phaser
 * scenes read. HUD values ALWAYS come from here (server data) — never
 * hardcoded (CLAUDE.md hard rule).
 */
import { create } from 'zustand';
import { bus } from '../lib/events';
import { basePanelAfterSelect, type BasePanel } from '../ui/pk/basePanel';
import { carryPanelControl, markControlledPanel, requestBasePanelChange, withAdmittedPanelChange } from '../ui/pk/panelSession';
import { BASE_FEATURES, resolveBaseFeature, type BaseFeatureRegistry } from '../ui/pk/featureRegistry';
import type { BasesDto } from '../lib/api';
import type { FantasyAddress } from '@shardkeep/shared/fantasyWorld';

let panelRegistry: BaseFeatureRegistry = BASE_FEATURES;
let panelActionsEnabled = false;

export type Screen =
  // Phase E: second-free-base purchase and durable recovery.
  | 'free-base-purchase'
  // End Phase E purchase screen.
  | 'loading' | 'title' | 'entry' | 'base' | 'build' | 'layout' | 'expand' | 'exchange'
  // NB no 'victory'/'defeat' screens: RaidUI renders result states internally
  // while screen stays 'battle' (they were unreachable union members — nothing
  // across 53 setScreen call sites could produce them).
  | 'builders' | 'bases' | 'map' | 'battle' | 'shop' | 'inventory' | 'claim'
  | 'profile' | 'codex' | 'quests' | 'raidlog' | 'withdraw' | 'security' | 'deposit' | 'economy' | 'scout' | 'clans'
  | 'forge' | 'market' | 'mail' | 'leagues' | 'workshop' | 'ordinary-crafting' | 'starter-fleet' | 'starter-expeditions' | 'harvesters'
  // 'alphagate': closed-alpha invite-code redemption (ALPHA_GATED 403s route
  // here). 'admin': owner-only application review; the route is only reachable
  // when the GET /admin/alpha/stats probe succeeded (screens/admin.tsx).
  | 'alphagate' | 'admin'
  // 'tester': the alpha tester program (progress / leaderboard / feedback),
  // owner 2026-08-21. Lazy-loaded like every menu screen.
  | 'tester'
  // 'army': the base-wide troop roster behind the task rail's ARMY button
  // (D-096 troop stock, owner 2026-09-02) — the same lazy chunk the camp
  // sheet's VIEW ARMY tray already loads on demand.
  | 'army';

/** Scout preview HUD state (title/trophies/countdown). The full layout (buildings,
 *  obstacles, claim) is handed to the battle scene via battle:enter, not stored. */
export interface ScoutReport {
  name: string; keepLevel: number; trophies: number; previewSec: number;
  returnScreen?: 'map' | 'raidlog';
  attackTarget?: RaidTarget;
  attackUnavailable?: string;
}

export interface BaseStateDto {
  /** Phase E transient response only; snapshot publication strips this before caching. */
  fleetJourneyEvents?: import('@shardkeep/shared/fleetJourneyPresentation').FleetJourneyEventBatch;
  /** Same authoritative current base; missing is legacy, unavailable is explicit. */
  boundCosmetics?: import('@shardkeep/shared/boundCosmeticVisual').BoundCosmeticBaseRead;
  /** Phase E P3 starter-only berth facts (apps/api starterServicePresentation.ts):
   *  missing is legacy, null is source unavailable, a per-berth null installation
   *  says only that no starter is installed there. Presentation data, never a capability. */
  servicePresentation?: {
    version: 1;
    berths: Array<{ buildingId: string; installation: null | { family: 'starter'; presence: 'occupied' | 'away' } }>;
  } | null;
  /** Current advanced installation facts from the same protected base read.
   * Away lasts until an accepted return; a null berth does not prove vacancy.
   * Missing is legacy and whole-field null is unavailable. Presentation only. */
  advancedServicePresentation?: {
    version: 1;
    berths: Array<{
      buildingId: string;
      installation: null | {
        family: import('@shardkeep/shared/phaseEVehicles').PhaseEVehicleFamily;
        tier: import('@shardkeep/shared/phaseEVehicles').PhaseEVehicleTier;
        presence: 'occupied' | 'away' | 'exhausted';
      };
    }>;
  } | null;
  /** Current original Workshop obligations only; idle means no authorized
   * activity animation. Automatic completion never creates a ready/claim state.
   * Missing is legacy; null is unavailable. Never carried into frozen raids. */
  serviceActivity?: {
    version: 1;
    services: Array<{ buildingId: string; state: 'idle' | 'working' }>;
  } | null;
  /** Current server berth cap; old snapshots keep the legacy catalogue limit. */
  constructionCapacity?: import('@shardkeep/shared').ConstructionCapacity;
  features?: { phaseEBuildings?: { version: 1; enabledTypes: string[] }; [key: string]: unknown };
  /** Frozen plot coordinates; omitted preserves the historical 30-tile frame. */
  plotVersion?: number;
  /** Server-resolved scenery; independent of placement and gameplay state. */
  visualContext?: BaseVisualContext | undefined;
  /** Present on capability-gated, explicitly selected multi-base reads. */
  baseId?: string | null;
  player: {
    wallet: string; name: string; keepLevel: number; trophies: number;
    league: string; builders: number; expansions: number;
  };
  claim: { min: number; max: number };
  /** Raid energy (GDD §3.3): free raids left today + the daily ceiling. */
  energy: { used: number; free: number; max: number };
  /** Stored deed shield. During a warzone an ordinary row remains visible but
   * is explicitly ineffective; only a warzone-source row blocks attacks. */
  shield: {
    activeUntil: string;
    expiresAt?: string;
    hoursLeft: number;
    remainingMs?: number;
    active?: boolean;
    source?: 'loss' | 'purchase' | 'warzone' | null;
    suppressedByWarzone?: boolean;
  } | null;
  /** Public warzone clock. A dormant unannounced purge has no boundary. */
  warzone?: {
    active: boolean;
    boundaryAt: string | null;
    remainingMs: number | null;
  };
  buildings: Array<{
    id: string; type: string; level: number; tx: number; ty: number;
    underConstruction: boolean;
  }>;
  obstacles: Array<{ id: string; spriteKey: string; tx: number; ty: number }>;
  /** Remnants of obstacles the player cleared within OBSTACLE_REMNANT_DAYS
   * (docs/REALM-KIT-PLAN.md E-11): the realm kit draws its stump/rubble twin on
   * the same tile. Presentation only — the tile is already buildable. Optional
   * across rolling web/API cuts; absent draws nothing. */
  clearedObstacles?: Array<{ spriteKey: string; tx: number; ty: number; clearedAt: string }>;
  /** Trained army (troop → count) — garrisons the Army Camp with real units (#56).
   *  `level` is the troop's research level (server-sent; the client never invents
   *  one). Optional so the client degrades to the legacy level-agnostic art while
   *  the server-side change ships separately — absent level = exactly the old
   *  rendering (game/world/patrol.ts ART LEVEL). */
  army: Array<{ troop: string; count: number; level?: number }>;
  /** Authoritative base-wide readiness. Optional across rolling web/API cuts. */
  armyStatus?: {
    readyTroopCount: number;
    readyPts: number;
    campCapacityPts: number;
    trainingTroopCount: number;
    trainingPts: number;
    barracksQueuePts: number;
    nextReadyAt: string | null;
    allReadyAt: string | null;
  };
  /** Recruited deed heroes. Recovery is a server deadline: while unavailable
   * the hero neither patrols nor appears in attack/defence snapshots. `level`
   * is server-owned; optional preserves a safe base-portrait fallback while an
   * older cached /base response is replaced after rollout. */
  heroes?: Array<{
    hero: 'vex' | 'theodor'; level?: number;
    recoveryUntil: string | null; available: boolean;
  }> | undefined;
  jobs: Array<{
    id: string; kind: string; buildingId: string | null; obstacleId: string | null;
    startedAt: string; finishesAt: string;
    /** Server quote: zero authorizes a free finish; absent uses legacy paid UI. */
    finishCostKeep?: string;
    /** Server verdict on the CANCEL control (tester request 2026-09-04): only
     * a running shard-paid upgrade with a recorded receipt; `refundShards` is
     * the exact debit it would compensate. Optional across rolling web/API
     * cuts — absent reads as "not cancellable". */
    canCancel?: boolean;
    refundShards?: string | null;
  }>;
  freeBuilders: number;
  /** Newest defences of this deed (D-099): what the RAIDED chip counts against
   * the device-local seen stamp and what the base-load toast announces. Optional
   * across rolling web/API cuts — absent reads exactly as "nothing new". */
  defences?: BaseDefencesDto;
}

/** See BaseStateDto.defences. `recent` is capped server-side by
 * BATTLE_HISTORY.hudRecentDefences and carries no loot: the raid log does. */
export interface BaseDefencesDto {
  lastAt: string | null;
  recent: Array<{
    raidId: string;
    createdAt: string;
    attackerBaseId: string | null;
    attackerWallet: string | null;
    attackerName: string | null;
    stars: number;
    destructionPct: number;
  }>;
}

export interface BalancesDto {
  /** SOFT currency (dual-split): mined, spent on builds/troops/forge. */
  shards: string;
  /** HARD token: forge payouts, quests, raid loot — on-chain in/out. */
  keep: string;
  keepRate: number;
  /** Optional on pre-Gems servers and old saved snapshots; KEEP remains custodial KEEP. */
  gems?: string;
  gemsRate?: { gemsPerKeep: number; shardsPerGem: number };
  features?: { gems?: { version: number; receipts: number }; gameCurrency?: { version: number; exactSpendCurrency: number }; [feature: string]: unknown };
}

/** Identity fence captured before an asynchronous base snapshot read. */
export interface BaseSnapshotGuard {
  wallet: string | null;
  selectedBaseId: string | null;
  selectionEpoch: number;
}

/** A land checkout draft is navigation state only. The server reservation is
 * authoritative once POST /deposits returns; this merely carries the player's
 * requested Earth cell from the lazy globe/base directory into checkout. */
export interface LandPurchaseDraft {
  kind: 'entry' | 'deed';
  earthCell: number | null;
  landAddress?: ({ kind: 'fantasy' } & FantasyAddress);
}

/** Why the player opened WORLD (the caller's purpose): find land to buy, a rival to raid,
 *  or their own deeds. World v2 maps it onto its HUD hint. */
export type WorldIntent = 'choose-land' | 'find-rival' | 'view-deeds';

/** A map/raid-log target the player chose to attack. When set, RaidUI raids
 * this wallet (or replays this raid) instead of auto-matching. */
export interface RaidTarget {
  /** PvP defender wallet, PvE camp, campaign stage, a saved replay, or the
   * selected deed's participant-authorized live defence stream. */
  kind: 'pvp' | 'pve' | 'campaign' | 'replay' | 'live';
  wallet?: string | undefined;
  /** Stable defender identity. Required to distinguish several bases owned by
   * one wallet; omitted only for legacy/auto-match targets. */
  defenderBaseId?: string | undefined;
  /** Automatic Next target excludes the opponent whose retreat was confirmed. */
  excludeBaseId?: string | undefined;
  campId?: string | undefined;
  stage?: number | undefined;
  raidId?: string | undefined;
  /** Stable deed authorization for history/live replay reads. Keeping this in
   * navigation state prevents a later device-local selection change from
   * retargeting an already-open participant replay. */
  replayBaseId?: string | undefined;
  /** Exact authenticated archive endpoint chosen by the history row. Needed
   * for prior-participant replays, whose authority survives after replayBaseId
   * is no longer owned. It is navigation state only; the API re-authorizes. */
  replayPath?: string | undefined;
  name?: string | undefined;
  /** For replays: the already-resolved result, so the spectator HUD/result
   * screen shows the real stars/loot without re-resolving. */
  result?: {
    stars: number; destructionPct: number; keepDestroyed: boolean;
    lootShards: number | null; attackerTrophyDelta: number;
    lootRedacted?: boolean;
  } | undefined;
  /** Durable process-death recovery of an already-settled pointer opens the
   * canonical verdict immediately. Ordinary history replays remain watchable. */
  resumeTerminal?: true | undefined;
  /** Lifecycle reconciliation of the raid already on screen. Primitive epoch
   * lets RaidUI refresh canonical commands/clock without replacing the route. */
  recoveryEpoch?: number | undefined;
  /** The device pointer exists but every canonical source was offline. */
  reconnecting?: true | undefined;
  /** Exact idempotent live-clock write recovered after a lost response/restart. */
  inFlightSpeed?: {
    clientCommandId: string; expectedClockRevision: number; rate: 1 | 2;
  } | undefined;
}

interface AppState {
  screen: Screen;
  /** A sheet over the current base; never a second screen router. */
  basePanel: BasePanel | null;
  openBasePanel(panel: BasePanel): void;
  closeBasePanel(): void;
  /** Forge/Market can be opened from KEEP Wallet or directly from the base. */
  walletMenuReturnScreen: 'base' | 'exchange';
  shopReturnScreen: 'base' | 'inventory';
  /** Set by BootScene when atlases are loaded — state, not an event, so a
   * listener registered late can never miss it. */
  booted: boolean;
  setBooted(b: boolean): void;
  wallet: string | null;
  authed: boolean;
  /** Server-confirmed 0.2 SOL on-chain payment (R9). Since free onboarding this
   *  IS land ownership — the server column keeps its exact meaning and only what
   *  it gates changed (LOCKED Q2). Paired with `base !== null` it gives the third
   *  state; see state/land.ts, which is the only place that decides. */
  entryPaid: boolean;
  /** The buy-land sheet: null when closed, otherwise WHY it is open — 'refused'
   *  (a 402 LAND_NOT_OWNED came back from an action the player just tapped) or
   *  'browse' (they asked what land is). The two need different opening lines and
   *  the sheet must not guess. Store state rather than screen-local so the GLOBAL
   *  api handler can raise it from any screen — the gate sits in front of the
   *  Forge, market, raids, bounties, clans and withdrawals. */
  landPrompt: 'refused' | 'browse' | null;
  landPurchase: LandPurchaseDraft | null;
  base: BaseStateDto | null;
  /** Fresh GET /bases capability/ownership answer; null on old/flag-off servers. */
  baseDirectory: BasesDto | null;
  /** Device-local only. It is never accepted until a fresh directory confirms it. */
  selectedBaseId: string | null;
  /** Changes only when auth/selection identity changes, fencing stale async reads. */
  baseSelectionEpoch: number;
  balances: BalancesDto | null;
  selectedBuildingId: string | null;
  selectedObstacleId: string | null;
  /** #61: the selected wall's WHOLE ROW is selected (drag moves the run together).
   *  Always false unless a wall is selected — every `select()` collapses it. */
  wallRow: boolean;
  /** Build-placement mode: the building type being placed, or null. */
  placing: string | null;
  /** Set by MAP/RAIDLOG before routing to 'battle'; RaidUI consumes it. */
  raidTarget: RaidTarget | null;
  /** Set by MAP before routing to 'scout'; ScoutHud consumes it. */
  scoutReport: ScoutReport | null;
  /** One owned loose item handed from the dedicated Inventory into the Market's
   * existing listing editor. The Market consumes and clears it after opening. */
  marketSellItemId: string | null;
  /** Which half of the MAP screen to open (owner 2026-08-09: RAID now offers a
   *  destination instead of silently auto-matching, so the caller has to be
   *  able to say "open the campaign"). Store state rather than MapScreen-local
   *  so a deep link survives the mount and the tab is remembered on return. */
  mapTab: 'world' | 'campaign';
  /** Why WORLD was opened (World v2 hint, D-186): set by the caller that opens the map,
   *  cleared when the visit ends (the screen leaves 'map' or the tab leaves 'world', here in
   *  setScreen/setMapTab: an effect cleanup would also run on StrictMode's simulated unmount)
   *  or when a choose-land dive lands (native 78b20d3).
   *  Presentation only; the land draft itself is `landPurchase`. */
  worldIntent: WorldIntent | null;
  /** Mount-safe request for the base-local RAID chooser. The quest board
   * unmounts BaseHud before returning to the base, so a synchronous event can
   * be lost between those two trees. Store state survives that hand-off. */
  raidChooserPending: boolean;
  /** Tutorial destinations survive the quest board → base mount. */
  baseFocusRequest: { kind: 'building' | 'obstacle'; id: string } | null;
  trainingRequested: boolean;
  buildCategory: 'def' | 'bld' | 'her';
  /** Last server-confirmed step; presentation only, cleared on identity change. */
  onboardingStepCode: string | null;
  playtestWelcomeOpen: boolean;
  /** Persisted accessibility toggle (App profile: REDUCE MOTION). */
  reduceMotion: boolean;
  setScreen(s: Screen): void;
  setAuth(wallet: string | null, entryPaid?: boolean): void;
  setEntryPaid(b: boolean): void;
  setLandPrompt(p: 'refused' | 'browse' | null): void;
  setLandPurchase(p: LandPurchaseDraft | null): void;
  setBase(b: BaseStateDto | null): void;
  setBaseDirectory(d: BasesDto | null): void;
  setSelectedBaseId(id: string | null, persist?: boolean): void;
  setBalances(b: BalancesDto | null): void;
  select(buildingId: string | null): void;
  setWallRow(on: boolean): void;
  selectObstacle(obstacleId: string | null): void;
  setPlacing(type: string | null): void;
  setRaidTarget(t: RaidTarget | null): void;
  setScoutReport(r: ScoutReport | null): void;
  setMarketSellItemId(id: string | null): void;
  setMapTab(t: 'world' | 'campaign'): void;
  setWorldIntent(intent: WorldIntent | null): void;
  requestRaidChooser(): void;
  consumeRaidChooserRequest(): void;
  requestBaseFocus(target: { kind: 'building' | 'obstacle'; id: string }): void;
  consumeBaseFocusRequest(): void;
  requestTraining(): void;
  consumeTrainingRequest(): void;
  setBuildCategory(category: 'def' | 'bld' | 'her'): void;
  setOnboardingStepCode(code: string | null): void;
  setPlaytestWelcomeOpen(open: boolean): void;
  setReduceMotion(b: boolean): void;
}

const REDUCE_MOTION_KEY = 'skp_reduce_motion';
const SELECTED_BASE_KEY = 'skp_selected_base';

function selectedBaseKey(wallet: string): string { return `${SELECTED_BASE_KEY}:${wallet}`; }

function persistSelectedBaseId(wallet: string | null, selectedBaseId: string | null): void {
  if (!wallet || typeof localStorage === 'undefined') return;
  try {
    const key = selectedBaseKey(wallet);
    if (selectedBaseId) localStorage.setItem(key, selectedBaseId);
    else localStorage.removeItem(key);
  } catch {
    // Safari private mode/storage policy must not make fresh server state fail.
  }
}

/** A saved ID is only a preference. Callers must confirm it against fresh /bases. */
export function readDeviceSelectedBaseId(wallet: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(selectedBaseKey(wallet));
  } catch {
    return null;
  }
}
function readReduceMotion(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(REDUCE_MOTION_KEY) === '1';
}

export const useApp = create<AppState>((set, get) => ({
  screen: 'loading',
  basePanel: null,
  walletMenuReturnScreen: 'base',
  shopReturnScreen: 'base',
  booted: false,
  setBooted: (booted) => set({ booted }),
  wallet: null,
  authed: false,
  entryPaid: false,
  landPrompt: null,
  landPurchase: null,
  base: null,
  baseDirectory: null,
  selectedBaseId: null,
  baseSelectionEpoch: 0,
  balances: null,
  selectedBuildingId: null,
  selectedObstacleId: null,
  wallRow: false,
  placing: null,
  raidTarget: null,
  scoutReport: null,
  marketSellItemId: null,
  mapTab: 'world',
  worldIntent: null,
  raidChooserPending: false,
  baseFocusRequest: null, trainingRequested: false, buildCategory: 'def', onboardingStepCode: null,
  playtestWelcomeOpen: false,
  reduceMotion: readReduceMotion(),
  setScreen: (screen) => {
    const state = get();
    const next: Partial<AppState> = {
    screen, basePanel: null, ...(state.screen === 'map' && screen !== 'map' ? { worldIntent: null } : {}), selectedBuildingId: null, selectedObstacleId: null, wallRow: false, placing: null,
    shopReturnScreen: screen === state.screen ? state.shopReturnScreen
      : screen === 'shop' && state.screen === 'inventory' ? 'inventory' : 'base',
    walletMenuReturnScreen: screen === state.screen ? state.walletMenuReturnScreen
      : (screen === 'forge' || screen === 'market') && state.screen === 'exchange' ? 'exchange' : 'base',
    };
    // Low-level setters stay synchronous. User producers gate their complete
    // command explicitly; authority/recovery updates never wait for a draft.
    set(next);
  },
  setAuth: (wallet, entryPaid = false) => set((state) => ({
    wallet, authed: wallet !== null, entryPaid, basePanel: null,
    base: null, balances: null, baseDirectory: null, selectedBaseId: null,
    baseSelectionEpoch: state.baseSelectionEpoch + 1,
    landPurchase: null, marketSellItemId: null, walletMenuReturnScreen: 'base', shopReturnScreen: 'base', raidChooserPending: false,
    baseFocusRequest: null, trainingRequested: false, onboardingStepCode: null,
    playtestWelcomeOpen: false, worldIntent: null,
  })),
  // Owning land dismisses the prompt: it exists only to explain a refusal that
  // can no longer happen, and leaving it up over a freshly deeded base would be
  // the last thing a player sees after paying.
  setEntryPaid: (entryPaid) => set(entryPaid ? { entryPaid, landPrompt: null } : { entryPaid }),
  setLandPrompt: (landPrompt) => set({ landPrompt }),
  setLandPurchase: (landPurchase) => set({ landPurchase }),
  setBase: (base) => set({ base: base && withoutFleetJourneyEvents(base) }),
  setBaseDirectory: (baseDirectory) => set({ baseDirectory }),
  setSelectedBaseId: (selectedBaseId, persist = true) => set((state) => {
    if (persist) persistSelectedBaseId(state.wallet, selectedBaseId);
    return {
      selectedBaseId,
      ...(state.selectedBaseId === selectedBaseId ? {} : {
        basePanel: null,
        baseFocusRequest: null, trainingRequested: false, onboardingStepCode: null,
      }),
      baseSelectionEpoch: state.baseSelectionEpoch
        + (state.selectedBaseId === selectedBaseId ? 0 : 1),
    };
  }),
  setBalances: (balances) => set({ balances }),
  // Selecting anything collapses a widened wall row — the row only ever belongs to
  // the wall that is currently selected.
  select: (selectedBuildingId) => {
    const state = get();
    set({ selectedBuildingId, selectedObstacleId: null, wallRow: false,
      basePanel: carryPanelControl(state.basePanel, basePanelAfterSelect(state.basePanel, selectedBuildingId === null ? null : { buildingId: selectedBuildingId })),
    });
  },
  setWallRow: (wallRow) => set({ wallRow }),
  selectObstacle: (selectedObstacleId) => {
    const state = get();
    set({ selectedObstacleId, selectedBuildingId: null, wallRow: false,
      basePanel: carryPanelControl(state.basePanel, basePanelAfterSelect(state.basePanel, selectedObstacleId === null ? null : { obstacleId: selectedObstacleId })),
    });
  },
  setPlacing: (placing) => set({ placing, selectedBuildingId: null, selectedObstacleId: null, wallRow: false, basePanel: null }),
  openBasePanel: (requestedPanel) => {
    const before = get();
    const basePanel = { ...requestedPanel };
    const feature = resolveBaseFeature(panelRegistry, basePanel, panelActionsEnabled);
    if (!feature) return;
    requestBasePanelChange(before.basePanel, { reason: 'replace', nextPanel: basePanel, proceed: () => {
      const current = get();
      if (current.basePanel !== before.basePanel || current.wallet !== before.wallet
        || current.selectedBaseId !== before.selectedBaseId || current.baseSelectionEpoch !== before.baseSelectionEpoch) return false;
      if (resolveBaseFeature(panelRegistry, basePanel, panelActionsEnabled) !== feature) return false;
      if (feature.dismissal === 'controller') markControlledPanel(basePanel);
      // The existing scene owner retires its ghost only after dismissal permits the transition.
      if (current.placing !== null) bus.emit('build:end', undefined);
      set((state) => state.screen === 'base'
        ? { basePanel, placing: null }
        : { screen: 'base', basePanel, placing: null, selectedBuildingId: null, selectedObstacleId: null, wallRow: false,
          walletMenuReturnScreen: 'base', shopReturnScreen: 'base',
          ...(state.screen === 'map' ? { worldIntent: null } : {}),
        });
      return true;
    } });
  },
  closeBasePanel: () => {
    const before = get();
    if (!before.basePanel) return;
    requestBasePanelChange(before.basePanel, { reason: 'close', proceed: () => {
      const current = get();
      if (current.basePanel !== before.basePanel || current.wallet !== before.wallet
        || current.selectedBaseId !== before.selectedBaseId || current.baseSelectionEpoch !== before.baseSelectionEpoch) return false;
      set({ basePanel: null }); return true;
    } });
  },
  setRaidTarget: (raidTarget) => set({ raidTarget }),
  setScoutReport: (scoutReport) => set({ scoutReport }),
  setMarketSellItemId: (marketSellItemId) => set({ marketSellItemId }),
  setMapTab: (mapTab) => set((state) => ({ mapTab,
    ...(state.screen === 'map' && state.mapTab === 'world' && mapTab !== 'world' ? { worldIntent: null } : {}) })),
  setWorldIntent: (worldIntent) => set({ worldIntent }),
  requestRaidChooser: () => set({ raidChooserPending: true }),
  consumeRaidChooserRequest: () => set({ raidChooserPending: false }),
  requestBaseFocus: (baseFocusRequest) => set({ baseFocusRequest }),
  consumeBaseFocusRequest: () => set({ baseFocusRequest: null }),
  requestTraining: () => set({ trainingRequested: true }),
  consumeTrainingRequest: () => set({ trainingRequested: false }),
  setBuildCategory: (buildCategory) => set({ buildCategory }),
  setOnboardingStepCode: (onboardingStepCode) => set({ onboardingStepCode }),
  setPlaytestWelcomeOpen: (playtestWelcomeOpen) => set({ playtestWelcomeOpen }),
  setReduceMotion: (reduceMotion) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(REDUCE_MOTION_KEY, reduceMotion ? '1' : '0');
    set({ reduceMotion });
  },
}));

/** Registry changes are an authority fence: a genuinely removed/replaced feature
 * and its panel retire in this same store transition. Capability loss alone never
 * clears a mounted draft. Overlay owns this configuration; open rechecks it live. */
export function configureBasePanels(registry: BaseFeatureRegistry, enabled: boolean): void {
  useApp.setState(state => {
    const old = state.basePanel && panelRegistry[state.basePanel.featureId];
    panelRegistry = registry; panelActionsEnabled = enabled;
    const next = state.basePanel && registry[state.basePanel.featureId];
    return state.basePanel && (!next || next.kind !== state.basePanel.kind || (old && old !== next))
      ? { basePanel: null } : state;
  });
}
/** H-1 read-only observation of the live host configuration. No caller receives
 * a registry mutator, and recovery resolution is not new-action capability. */
export function inspectConfiguredBasePanel(panel: BasePanel) {
  const registered = Object.hasOwn(panelRegistry, panel.featureId)
    && panelRegistry[panel.featureId]?.kind === panel.kind;
  return Object.freeze({ registered, actionsEnabled: panelActionsEnabled,
    feature: resolveBaseFeature(panelRegistry, panel, panelActionsEnabled) });
}

export type UserCommandSettlement = { status: 'fulfilled'; value: unknown }
  | { status: 'cancelled' } | { status: 'rejected'; error: unknown };
/** Callable cleanup remains compatible with React effects; listeners observe
 * completion even when they attach after synchronous execution or refusal. */
export interface UserCommandHandle {
  (): void;
  onSettled: (listener: (result: UserCommandSettlement) => void) => () => void;
}
export function requestUserCommand(command: () => unknown, canRun: () => boolean = () => true): UserCommandHandle {
  const before = useApp.getState(); let pending = true;
  let result: UserCommandSettlement | null = null;
  const listeners = new Set<(result: UserCommandSettlement) => void>();
  let unsubscribe = (): void => undefined;
  const settle = (next: UserCommandSettlement): void => {
    if (result) return; result = next; unsubscribe();
    for (const listener of listeners) listener(next);
    listeners.clear();
  };
  const cancel = (() => { if (pending) { pending = false; settle({ status: 'cancelled' }); } }) as UserCommandHandle;
  cancel.onSettled = listener => {
    if (result) listener(result); else listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const currentScope = (): boolean => {
    const current = useApp.getState();
    return current.basePanel === before.basePanel && current.wallet === before.wallet
      && current.selectedBaseId === before.selectedBaseId && current.baseSelectionEpoch === before.baseSelectionEpoch;
  };
  if (!canRun()) { cancel(); return cancel; }
  unsubscribe = useApp.subscribe(() => { if (pending && !currentScope()) cancel(); });
  requestBasePanelChange(before.basePanel, { reason: 'navigate', cancel, proceed: () => {
    if (!pending || !currentScope() || !canRun()) { cancel(); return false; }
    pending = false; unsubscribe();
    try {
      const value = withAdmittedPanelChange(before.basePanel, command);
      // Always observe asynchronous rejection, including callers without listeners.
      if (value && typeof (value as PromiseLike<unknown>).then === 'function') {
        Promise.resolve(value).then(value => settle({ status: 'fulfilled', value }), error => settle({ status: 'rejected', error }));
      } else settle({ status: 'fulfilled', value });
    } catch (error) { settle({ status: 'rejected', error }); }
    return true;
  } });
  return cancel;
}

export function captureBaseSnapshotGuard(): BaseSnapshotGuard {
  const state = useApp.getState();
  return {
    wallet: state.wallet,
    selectedBaseId: state.selectedBaseId,
    selectionEpoch: state.baseSelectionEpoch,
  };
}

export function isBaseSnapshotGuardCurrent(guard: BaseSnapshotGuard): boolean {
  const state = useApp.getState();
  return state.wallet === guard.wallet
    && state.selectedBaseId === guard.selectedBaseId
    && state.baseSelectionEpoch === guard.selectionEpoch;
}

/** Mark a user-driven selection intent without exposing a half-switched base.
 * A later intent invalidates every older in-flight switch, even before either
 * network response returns. */
export function beginBaseSelectionGuard(): BaseSnapshotGuard {
  let guard: BaseSnapshotGuard | null = null;
  useApp.setState((state) => {
    const selectionEpoch = state.baseSelectionEpoch + 1;
    guard = { wallet: state.wallet, selectedBaseId: state.selectedBaseId, selectionEpoch };
    return { baseSelectionEpoch: selectionEpoch };
  });
  return guard!;
}

/** C5: `fleetJourneyEvents` is a transient, once-only callback carried by ONE
 * protected /base response; root's producer publishes it at the publication
 * seam. It never enters cached base state — a later read, reload or hydration
 * would otherwise replay a journey. Same object identity when the field is
 * absent; a shallow copy without it when present. */
function withoutFleetJourneyEvents<T extends object>(base: T): T {
  if (!Object.prototype.hasOwnProperty.call(base, 'fleetJourneyEvents')) return base;
  const copy = { ...(base as Record<string, unknown>) };
  delete copy['fleetJourneyEvents'];
  return copy as unknown as T;
}

/** Commit only if auth and selection identity are unchanged since request start. */
export function commitBaseSnapshot(
  guard: BaseSnapshotGuard, selectedBaseId: string | null,
  base: BaseStateDto, balances: BalancesDto,
): boolean {
  let committed = false;
  useApp.setState((state) => {
    if (state.wallet !== guard.wallet
      || state.selectedBaseId !== guard.selectedBaseId
      || state.baseSelectionEpoch !== guard.selectionEpoch) return state;
    persistSelectedBaseId(state.wallet, selectedBaseId);
    committed = true;
    return {
      selectedBaseId, base: withoutFleetJourneyEvents(base), balances,
      basePanel: state.selectedBaseId === selectedBaseId ? state.basePanel : null,
      baseSelectionEpoch: state.baseSelectionEpoch
        + (state.selectedBaseId === selectedBaseId ? 0 : 1),
    };
  });
  return committed;
}

/** Invalidate selection and every deed-scoped display value as one transition. */
export function clearBaseSnapshot(persist = true): void {
  useApp.setState((state) => {
    if (persist) persistSelectedBaseId(state.wallet, null);
    return {
      selectedBaseId: null, base: null, balances: null, basePanel: null,
      baseSelectionEpoch: state.baseSelectionEpoch + 1,
    };
  });
}

// dev-only handle for preview-driven e2e (mirrors window.__game)
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __store?: typeof useApp }).__store = useApp;
}
