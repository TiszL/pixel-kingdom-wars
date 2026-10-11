import type {BoundCosmeticBaseRead} from '@shardkeep/shared/boundCosmeticVisual';
import type { BaseVisualContext } from '@shardkeep/shared/baseVisual';
import type { HeroCombatLoadout, HeroKey } from '@shardkeep/shared';
import type { FleetJourneyEvent } from '@shardkeep/shared/fleetJourneyPresentation';
/**
 * EventBus between Phaser scenes and the React overlay (research:
 * engine-pipeline §2 — communicate via a bus, never re-render the canvas).
 *
 * DELIBERATELY HAS NO PHASER IMPORT. It used to construct a
 * `Phaser.Events.EventEmitter`, which is a VALUE import, and eleven React
 * modules on the first-paint path import `{ bus }` from here. That one line
 * pinned the entire Phaser engine into the entry chunk: lazy-loading the game
 * canvas saved exactly zero bytes while it stood, because the bus dragged Phaser
 * back in regardless. Every other consumer in the codebase already uses
 * `import type`, so this was the single exception — and the whole reason the
 * obvious split did not work.
 *
 * The replacement is ~15 lines and does what the two call sites below need. If
 * you ever need Phaser's richer emitter semantics (once, priority, context
 * binding), add them HERE rather than reaching back for Phaser.
 */

export interface WalletErrorNotice {
  /** Adapter name only; never the adapter object or its account/public key. */
  walletName: string | null;
  /** Compact display-safe fields only; stack/cause/provider payloads stay out. */
  name: string;
  message: string;
}

/** Fixed atlas identities and coarse loader counters only; never request URLs,
 * response bodies or provider-owned error objects. */
export interface BootFileDiagnostic {
  key: string;
  kind: 'image' | 'json';
  phase: 'queued' | 'loading' | 'processing' | 'complete' | 'failed';
  state: number | null;
  status: number | null;
  loadedBytes: number;
  totalBytes: number;
}

export interface BootRoundDiagnostic {
  attempt: 1 | 2;
  reason: 'complete' | 'idle-timeout' | 'active-deadline';
  activeMs: number;
  budgetMs: number;
  queued: number;
  inflight: number;
  processing: number;
  files: BootFileDiagnostic[];
}

export interface BootDiagnostics {
  profile: 'full' | 'constrained';
  rounds: BootRoundDiagnostic[];
}

/** Reduce an extension-owned error to the only fields the connect sheet needs.
 * Wallet errors can carry arbitrary provider objects in `cause`; those must not
 * cross the app bus or accidentally end up in UI/debug state. */
export function walletErrorNotice(
  error: { name?: string | undefined; message?: string | undefined },
  walletName: string | null,
): WalletErrorNotice {
  const compact = (value: string | undefined, max: number): string =>
    (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return {
    walletName,
    name: compact(error.name, 64) || 'WalletError',
    message: compact(error.message, 240),
  };
}

export type GroundLoadReason = 'complete' | 'idle-timeout' | 'active-deadline' | 'network' | 'http'
  | 'range' | 'size' | 'integrity' | 'decode';
export type GroundProtocol = 'h1' | 'h2' | 'h3' | 'unknown';
export interface SceneVisualTimings {
  loadProtocol?: GroundProtocol;
  loadReason?: GroundLoadReason; loadAttempt?: number; loadActiveMs?: number;
  downloadMs?: number; verifyMs?: number; decodeMs?: number; paintMs?: number;
  uploadMs?: number; maxPaintBatchMs?: number; width?: number; height?: number; cacheHit?: boolean;
}
export interface SceneVisualProgress {
  scene: 'base' | 'battle';
  phase: 'base' | 'download' | 'verify' | 'decode' | 'terrain' | 'upload' | 'walls' | 'ready';
  completed: number;
  total: number;
  timings?: SceneVisualTimings;
}

export interface GameEvents {
  /** Phaser finished preloading; scenes may start. */
  'boot:ready': void;
  /** Required artwork failed to load; React offers a manual full-page retry. */
  'boot:failed': { files: string[]; diagnostics?: BootDiagnostics };
  /** Valid required files, including retained successes on the single retry. */
  'boot:progress': { completed: number; total: number; attempt: 1 | 2 };
  /** Initial scene pixels publish only after terrain and contextual walls settle. */
  'scene:visual': { scene: 'base' | 'battle'; state: 'loading' | 'ready' | 'failed' };
  /** Measured work within the current preparation phase; never estimated overall progress. */
  'scene:visualProgress': SceneVisualProgress;
  'scene:visualRetry': { scene: 'base' | 'battle' };
  /** A base or raid context carried a ground revision newer than this bundle
   * draws (unsupportedGroundRevision); the scene paints its fallback and
   * UpdateGate asks for a reload. Presentation only: the simulator still agrees. */
  'scene:artworkOutdated': { groundRevision: number };
  /** A building was tapped in the base scene. */
  'base:select': { buildingId: string | null };
  /** A drag-drop move finished and validated locally; React posts the move. */
  'base:move': { buildingId: string; tx: number; ty: number };
  /** #61: move a whole wall LINE together — {id → new tile} for each wall. */
  'base:moveLine': { moves: Array<{ id: string; tx: number; ty: number }> };
  /**
   * A posted move has RESOLVED (committed or rejected) and the store now agrees
   * with reality. Player report 2026-08-29 was a flicker DURING the drag; the
   * same seam reopens for the ~200ms between the drop and the PATCH landing,
   * because the store still holds the old tile and the 2s job heartbeat can
   * repaint in that window. The scene holds the dropped tile until this fires,
   * so only React — which knows the request's outcome — decides when the store
   * is authoritative again. `ok:false` means the scene must fall back to the
   * store, which by then carries the server's rejection.
   */
  'base:moveSettled': { buildingIds: readonly string[]; ok: boolean };
  /** #61: the wall sheet's SELECT WHOLE ROW toggle — widen/narrow the selection. */
  'base:wallRow': { on: boolean };
  /** React asks the scene to refresh from the latest server state. */
  'base:refresh': void;
  /** A foreground mail push asks only the HUD badge to re-read /mail/status. */
  'mail:refresh': void;
  /** A HUD queue card asks the scene to reveal its authoritative world target.
   * Identity is typed because obstacle ids and building ids share no namespace
   * in the server snapshot even though the scene stores both as sprites. */
  'base:focus': { kind: 'building' | 'obstacle'; id: string };
  /** Server-layout editor → scene. `show` is presentation-only: real sprites
   * move to draft coordinates, but the Zustand/server snapshot is untouched. */
  'base:layoutDraft':
    | {
      op: 'show';
      geometryVersion: number;
      positions: Array<{ buildingId: string; tx: number; ty: number }>;
      trayIds: string[];
      selectedBuildingId: string | null;
      wallPaintLevel: number | null;
    }
    | { op: 'hide' };
  /** Scene gestures → layout reducer. No event in this family is an API write. */
  'base:layoutEdit':
    | { kind: 'select'; buildingId: string | null }
    | { kind: 'move'; buildingId: string; tx: number; ty: number }
    | { kind: 'paintWalls'; level: number; tiles: Array<{ tx: number; ty: number }> };
  /** An obstacle was tapped in the base scene. */
  'base:selectObstacle': { obstacleId: string | null };
  /** React entered placement mode for a building type. */
  'build:start': { type: string };
  /** Ghost moved/validated; React's confirm bar reflects this. */
  'build:spot': { tx: number; ty: number; valid: boolean };
  /** Wall SWIPE placement (#59): the ordered set of valid tiles painted in one drag. */
  'build:paint': { tiles: Array<{ tx: number; ty: number }> };
  /** Placement confirmed (React POSTed) or cancelled — scene removes the ghost. */
  'build:end': void;
  /** Enter the battle scene with a raid's frozen snapshot (deploy phase).
   *  `armyCounts` (armySnapshot.counts) lets the scene SKIP downloading the
   *  ~8.6MB `trpdg_l<N>` atlas of a levelled troop the army has zero of. It is
   *  `| undefined` rather than merely optional on purpose: ABSENT must mean
   *  "load everything" (an older replay bundle), and coalescing to `{}` — the
   *  armyLevels idiom — would instead mean "all counts are zero, load nothing". */
  'battle:enter': {
    /** Frozen defender scenery, separate from the simulator snapshot. */
    visualContext?: BaseVisualContext | undefined; boundCosmeticVisual?: BoundCosmeticBaseRead | undefined;
    /** Frozen berth siblings captured with the raid (P6a): starter v1 and advanced v1, payload only. */
    servicePresentation?: unknown; advancedServicePresentation?: unknown;
    snapshot: unknown;
    armyLevels?: Record<string, number>;
    armyCounts?: Record<string, number> | undefined;
    /** Frozen hero research levels; absent on old replay bundles means L1. */
    heroLevels?: Record<string, number> | undefined;
    scout?: boolean;
  };
  /** Base-HUD camera command. Commands never echo from pinch/wheel, so changing
   * zoom cannot feed the same multiplier back into the scene. */
  /** FIT is the only remaining HUD camera command (M23 a10 removed the +/-
   *  pills); pinch, wheel and drag talk to the camera directly. */
  /** C5: root's producer published ONE fresh fleet departure/return for the
   * current base (an actual commit or settlement, never a presence diff); the
   * base scene plays that berth's authored track once per event key. */
  'fleet:journey': FleetJourneyEvent;
  'base:camera': { op: 'fit' };
  /** One complete stationary empty-ground gesture owned by the base scene. */
  'base:emptyTap': undefined;
  /** Actual screen pixels occupied by the base HUD, navigation and device
   * cutout. BaseScene fits the live claim into the remaining rectangle. */
  'base:insets': { top: number; bottom: number; left?: number; right?: number };
  /** Transient toast line (App: top 14%, 1600ms). */
  'ui:toast': { msg: string };
  /**
   * The first-run chain moved — re-read GET /tutorial.
   *
   * The chain's live step is published by that probe, and the two places that
   * can advance it (claiming a step on the quest board, finishing a build) are
   * not the component that renders the base-screen objective strip. Without this
   * the strip keeps offering a step the player has already been paid for until
   * the next reload.
   */
  'onboarding:refresh': undefined;
  /** Mobile Wallet Adapter found no wallet app to hand off to. Emitted from
   *  lib/mwa.ts in place of the library's own unbranded "get a wallet" modal, so
   *  the CONNECT sheet — which already has the deep links and store links on
   *  screen — is what answers instead. */
  'wallet:not-found': undefined;
  /** WalletProvider reported an adapter error. Sanitized at the provider
   *  boundary; the sheet consumes it only while that wallet's row is pending,
   *  so later transaction errors do not masquerade as connection failures. */
  'wallet:error': WalletErrorNotice;
  /** A tile was tapped in the battle scene (deploy targeting). */
  /** fx/fy are the FRACTIONAL tile coords of the pointer (M23 a1): RaidUI's
   *  snap-to-valid uses them to pick the nearest legal tile when the tapped
   *  one is not deployable. Optional so a synthetic emitter stays valid. */
  'battle:tap': {
    tx: number; ty: number; fx?: number; fy?: number;
    /** Candidate destinations whose full actor preview is outside HUD chrome. */
    visibleTiles?: string[];
    /** Synchronous final-snap check using the selected actor's real fanned
     * sprite bounds. Optional for synthetic/legacy emitters. */
    previewVisible?: (
      destination: { tx: number; ty: number },
      troop: string,
      hero?: 'vex' | 'theodor',
    ) => boolean;
  };
  /** Raid-HUD camera pills → BattleScene. 'fit' re-frames the base + deploy ring
   *  (the entry framing); 'in'/'out' step by RAID_CAMERA.zoomStep. Separate from
   *  'base:camera' because the base and battle scenes have independent bands. */
  'battle:camera': { op: 'in' | 'out' | 'fit' };
  /** MEASURED raid HUD chrome (screen px) so the camera fit reserves the space
   *  the tray actually occupies instead of a constant that drifts with layout.
   *  `left`/`right` are the LANDSCAPE half of the same idea (2026-08-02): the
   *  navbar stands up as a rail on one side, and chrome that eats width has to
   *  reach the fit the same way chrome that eats height does. Optional because
   *  portrait has none — omitted reads as 0, so the existing emitter is correct
   *  as it stands. */
  'battle:insets': { top: number; bottom: number; left?: number; right?: number };
  /** A newly-created scene has subscribed; ask the mounted HUD to measure its
   * current DOM again if its initial publications preceded scene creation. */
  'battle:insetsRequest': void;
  /** Live destruction % from the scene's own HP ledger (HP-weighted over
   *  non-wall, non-trap buildings — the same accounting the sim reports at the
   *  end). The HUD used to fake this by counting `destroyed` events, which made
   *  three walls move the bar as much as the Keep and chip damage move it not at
   *  all. Presentation only; the server's final value still pins the result. */
  'battle:progress': { pct: number; corrected?: boolean };
  /** Show a pending deploy marker (React validated troop + counts). `hero` marks
   *  a HERO drop: the marker renders the hero's own art at hero scale, while
   *  `troop` stays the donor troop so the non-hero path is unchanged. */
  'battle:mark': { troop: string; hero?: 'vex' | 'theodor'; tx: number; ty: number };
  /** Take back ONE pending marker the server definitely rejected. A live raid
   *  marks a tap the moment it is queued (so the player sees what a tap or a
   *  hold has already committed); an accepted deploy consumes that marker at
   *  its tile, a rejection removes it here. Presentation only — never SIM input. */
  'battle:unmark': { troop: string; hero?: 'vex' | 'theodor'; tx: number; ty: number };
  /** Cancel an in-progress hold-to-deploy repeat (a hero drop ends the gesture). */
  'battle:holdCancel': undefined;
  /** Play a resolved event stream. A cold seek materialises the prefix into the
   * field; `appliedPrefix` is reserved for a same-scene replacement whose
   * prefix is already visible and must not be applied twice. */
  'battle:play': {
    events: Array<{ t: number; e: string; n?: number }>;
    /** Frozen loadouts of accepted hero orders, not the available hero roster. */
    heroLoadouts?: Partial<Record<HeroKey, HeroCombatLoadout>>;
    fromTick?: number;
    appliedPrefix?: true;
    /** Replay protocol that authored `events`; absent only on older bundles. */
    simVersion?: number;
    /** Participant replay proves the server already settled. Materialize the
     * canonical final field before announcing battle:done; never POST finish. */
    terminal?: true;
    /** D-106: the attacker still holds undeployed troops/heroes in the tray, so
     * this stream's end is NOT the fight's end — the field sits idle until the
     * next reserve re-feeds it. BattleScene keeps its rendered clock running
     * past this stream's `battle:done` so that reserve lands at its true tick. */
    fightOpen?: true;
  };
  /** Presentation rate from the canonical raid clock (or a local completed
   * replay control). This never enters simulator input. */
  'battle:rate': { rate: 1 | 2 };
  /** Canonical simulator playhead. The scene may repay a positive gap at the
   * absolute 8x catch-up cap; it never writes this value back to the server. */
  'battle:playhead': { simMs: number };
  /** Playback finished — React shows victory/defeat. */
  'battle:done': void;
  /** D-099: BattleScene is repaying a hidden-tab pause at 8× (`true`) or is
   *  back at real time (`false`) — RaidUI shows CATCHING UP… beside the timer
   *  while it is true. A return AFTER the wall-clock end jumps straight to the
   *  verdict and never reports true. Emitted on change only. */
  'battle:catchup': { active: boolean };
  /** Leave the battle scene, return to base. */
  'battle:exit': void;
  /** Tutorial progress changed OUTSIDE the overlay (M23 a6): the settings
   *  REPLAY chip posts /tutorial/reset — and since 2026-08-29 the GUIDED FIRST
   *  RUN switch posts /tutorial/guide/{skip,resume} — and republishes the
   *  SERVER's answer so the eager TutorialHost re-arms without a refetch.
   *  Always server truth — never a client-invented step. `guideSkipped` is
   *  optional so a server that predates the switch reads as "still guided". */
  'tutorial:state': { step: number; completedAt: string | null; guideSkipped?: boolean };
}

type Handler = (payload: never) => void;

class TypedBus {
  private handlers = new Map<string, Set<Handler>>();

  emit<K extends keyof GameEvents>(event: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(event as string);
    if (!set) return;
    // Iterate a COPY: a handler that unsubscribes itself (or another) during
    // dispatch would otherwise mutate the set mid-iteration. React effects do
    // exactly this on unmount.
    for (const fn of [...set]) (fn as (p: GameEvents[K]) => void)(payload);
  }

  on<K extends keyof GameEvents>(event: K, fn: (payload: GameEvents[K]) => void): () => void {
    const key = event as string;
    let set = this.handlers.get(key);
    if (!set) { set = new Set(); this.handlers.set(key, set); }
    set.add(fn as Handler);
    return () => { set.delete(fn as Handler); };
  }
}

export const bus = new TypedBus();

// dev-only handle for preview-driven e2e (mirrors window.__game / __store)
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __bus?: TypedBus }).__bus = bus;
}
