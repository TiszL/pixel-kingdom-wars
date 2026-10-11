/**
 * P1 Home HUD + Resource drawer: the Ui state types and the actions, mirrored 1:1 from the approved Android kit
 * (AND:K/ui/model/UiModels.kt, AND:K/ui/hud/HomeHudActions.kt; KIT-API.md "Ui classes"). Same class names, same field
 * names, same order, same defaults. Kotlin `FeatureId` (a value class over a string) is a plain string here; Kotlin
 * enums are string unions spelled exactly as the Kotlin constants; `Pair<Int, Int>` is a `[number, number]` tuple.
 *
 * Pure types, no React. Mappers build these from store/server data (lane §3 universal rules); components only read them.
 */

/** A registry row id, e.g. "hud.resources" (AND:K/ui/features/FeatureId). */
export type FeatureId = string;

/** UiModels.kt:20 */
export type Verb = 'GOLD' | 'GREEN' | 'BLUE' | 'RED' | 'STONE' | 'CHARCOAL' | 'OFF' | 'MOSS';
/** UiModels.kt:40 */
export type BadgeTone = 'COUNT' | 'REWARD' | 'READY' | 'INFO';
/** UiModels.kt:53 */
export type ChipTone = 'NORMAL' | 'ALERT' | 'DANGER';
/** UiModels.kt:93 */
export type ResourceAccent = 'PLAIN' | 'SHARDS' | 'GEMS' | 'KEEP' | 'SKR' | 'DIVINE';
/** UiModels.kt:578 */
export type ResourceGroupLayout = 'WIDE_ROWS' | 'TILE_STRIP';

/** UiModels.kt:43 — a corner badge. `text` is never empty. */
export interface BadgeUi { text: string; tone: BadgeTone; description: string }

/** UiModels.kt:63 — one status-chip segment (trophies, builders, shield). */
export interface ChipUi {
  id: FeatureId; icon: string; value: string; description: string;
  dot?: boolean; /* = false */
  tone?: ChipTone; /* = NORMAL */
}

/** UiModels.kt:79 — the level badge. */
export interface ProfileMedallionUi {
  id: FeatureId; level: string; portrait: string | null; description: string;
  badge?: BadgeUi | null; /* = null */
}

/** UiModels.kt:96 — one resource readout. `value` is "…" while unknown, never "0". `plus` is never drawn. */
export interface ResourceChipUi {
  id: FeatureId; icon: string; value: string; fill: number | null; plus: boolean; badge: BadgeUi | null;
  name?: string; /* = "" */
  accent?: ResourceAccent; /* = PLAIN */
  gain?: string | null; /* = null */
  drawerHandle?: boolean; /* = false */
  exactDescription?: string; /* = "" */
}

/** UiModels.kt:126 — a right edge button or a left edge tab. Shown only while badged. */
export interface EdgeButtonUi { id: FeatureId; icon: string; label: string; badge: BadgeUi | null; glow: boolean }

/** UiModels.kt:140 — one deck button. */
export interface DeckButtonUi {
  id: FeatureId; icon: string; label: string; primary: boolean; badge: BadgeUi | null;
  pips: [number, number] | null;
  verb?: Verb; /* = GOLD if primary else STONE */
}

/** UiModels.kt:158 */
export interface HeraldUi { key: string; icon: string; text: string; target: FeatureId | null }

/** UiModels.kt:170 */
export interface ContextChipUi { id: FeatureId; icon: string; what: string; where: string }

/** UiModels.kt:221 — one tool of the BUILD long-press shelf. */
export interface DeckToolUi { id: FeatureId; icon: string; label: string; enabled: boolean; description: string }

/** UiModels.kt:182 — everything the Home HUD draws. */
export interface HomeHudUi {
  profile: ProfileMedallionUi;
  builders: ChipUi;
  shield: ChipUi;
  resources: ResourceChipUi[];
  rightEdge: EdgeButtonUi[];
  leftEdge: EdgeButtonUi[];
  herald: HeraldUi | null;
  deck: DeckButtonUi[];
  deckVisible: boolean;
  trophies?: ChipUi | null; /* = null */
  context?: ContextChipUi | null; /* = null */
  mirrored?: boolean; /* = false */
  rightEdgeOverflow?: FeatureId | null; /* = null */
  tools?: DeckToolUi[]; /* = [] */
  toolsOpen?: boolean; /* = false */
}

/** UiModels.kt:550 — one drawer resource. */
export interface ResourceRowUi {
  id: string; icon: string; name: string; value: string; purpose: string; earnedAt: string;
  earnedAtFeature: FeatureId | null;
  goIcon?: string | null; /* = null */
  empty?: boolean; /* = false */
  divine?: boolean; /* = false */
  actionLabel?: string | null; /* = null */
  action?: FeatureId | null; /* = null */
}

/** UiModels.kt:586 */
export interface ResourceGroupUi {
  id: string; icon: string; title: string; note: string; go: FeatureId | null; rows: ResourceRowUi[];
  layout?: ResourceGroupLayout; /* = TILE_STRIP */
}

/** UiModels.kt:604 — SOL is never in it. */
export interface ResourceDrawerUi {
  groups: ResourceGroupUi[];
  focusRowId: string | null;
  title?: string; /* = "RESOURCES" */
  hint?: string; /* = "tap one to see where" */
  footnote?: string | null; /* = null */
}

/** HomeHudActions.kt:14 — callbacks out. The HUD never routes and never closes the drawer after a GO. */
export interface HomeHudActions {
  openFeature: (id: FeatureId) => void;
  /** Kept for source compatibility; the HUD calls `openDrawerAt`. */
  openDrawer: (id: FeatureId) => void;
  focusResource: (rowId: string) => void;
  closeDrawer: () => void;
  /** Default forwards to `openDrawer(focus ?? HudIds.RESOURCES)` — see `openDrawerAt()` below. */
  openDrawerAt?: (focus: FeatureId | null) => void;
  /** BUILD long-press toggles the tools shelf. Default: no shelf. */
  toggleTools?: (open: boolean) => void;
}

/** HomeHudActions.kt:52 — canonical HUD registry rows. */
export const HudIds = {
  RESOURCES: 'hud.resources',
  DAILY_CACHE: 'hud.dailyCache',
  SHARDS: 'hud.shards',
  GEMS: 'hud.gems',
  KEEP: 'hud.keep',
  PROFILE: 'hud.profile',
  LEAGUES: 'hud.leagues',
  BUILDERS: 'hud.builders',
  SHIELD: 'hud.shield',
  QUESTS: 'hud.quests',
  EVENT: 'hud.event',
  MAIL: 'hud.mail',
  CHAT: 'hud.chat',
  ATTACK: 'hud.attack',
  ARMY: 'hud.army',
  MAP: 'hud.map',
  BUILD: 'hud.build',
  TOOL_LAYOUTS: 'build.layouts',
  TOOL_EXPAND: 'keep.expand',
  TOOL_FIT: 'hud.fit',
} as const;

/** HomeHudActions.openDrawerAt with its Kotlin default applied. */
export function openDrawerAt(on: HomeHudActions, focus: FeatureId | null): void {
  if (on.openDrawerAt) on.openDrawerAt(focus);
  else on.openDrawer(focus ?? HudIds.RESOURCES);
}

/** KitLogic.kt:19 — unknown is an ellipsis, never zero. */
export const UNKNOWN = '…';

/** HomeHud.kt `shown()` / ResourceDrawer.kt `count()`: a blank value is unknown. */
export function shown(value: string | null | undefined): string {
  return value == null || value.trim() === '' ? UNKNOWN : value;
}
