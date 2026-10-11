/**
 * P2 UI state types: the web twins of the Android `…Ui` classes the selection, command bar, sheet host and Need-more
 * sheet read (KIT-API.md "UI state classes"; AND:K/ui/model/UiModels.kt; AND:K/ui/command/CommandBar.kt `SelectionUi`;
 * AND:K/ui/sheets/buildings/NeedMoreSheet.kt). Field names and order are the Android ones, so a mapper ported 1:1 from
 * Kotlin compiles against these without renames. Enums are string unions with the Kotlin constant names.
 *
 * When P0's `src/ui/pk/kitTypes.ts` lands, the shared classes (PriceUi, CommandUi, BadgeUi, …) move there and this
 * file keeps only the P2-local ones (SelectionUi, NeedMore*, SheetHostUi). Rule 7: P0's copy wins on a conflict.
 */

/** A registry row id ("goldforge.upgrade", "mine.collect"). Android `FeatureId` is a value class over a String. */
export type FeatureId = string;

export type Verb = 'GOLD' | 'GREEN' | 'BLUE' | 'RED' | 'STONE' | 'CHARCOAL' | 'OFF' | 'MOSS';
export type CommandState = 'ENABLED' | 'DISABLED' | 'BUSY' | 'SHORT' | 'LOCKED';
export type Currency = 'SHARDS' | 'GEMS' | 'KEEP' | 'SKR' | 'SOL' | 'ITEM';
export type PriceStatus = 'OK' | 'CHECKING' | 'UNAVAILABLE' | 'SHORT' | 'SERVER_ZERO';
export type BadgeTone = 'COUNT' | 'REWARD' | 'READY' | 'INFO';
export type SheetSize = 'HALF' | 'TALL' | 'FULL';

/** `PriceUi`: amount is a server-formatted string; null/blank renders "…" (UNKNOWN). "0" only with SERVER_ZERO. */
export interface PriceUi {
  currency: Currency;
  amount: string | null;
  status: PriceStatus;
  icon?: string | null;
  description?: string | null;
}

export interface BadgeUi {
  text: string;
  tone: BadgeTone;
  description: string;
}

/** `CommandUi` (§7.2 fields, then the final-design additions with defaults). */
export interface CommandUi {
  id: FeatureId;
  icon: string;
  caption: string;
  price: PriceUi | null;
  primary: boolean;
  state: CommandState;
  reason: string | null;
  badge: BadgeUi | null;
  verb?: Verb; // default STONE
  sub?: string | null;
  iconSecondary?: string | null;
}

/** `CommandBarUi`: the selected building's commands in any order (the bar orders them) and the first-selection hint. */
export interface CommandBarUi {
  buildingId: string;
  commands: CommandUi[];
  hint?: string | null;
}

/** `NamePlateUi`: level is the tag text ("LV 3", "LV 2>3", "NEW"); stateLine is server-formatted; progress 0..1. */
export interface NamePlateUi {
  name: string;
  level: string;
  stateLine: string | null;
  progress: number | null;
}

/** A rectangle in CSS px in the overlay root's space (the root fills the viewport from its origin). */
export interface PxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Safe-area insets in CSS px. */
export interface PxInsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** `SelectionUi`: anchor is the selected sprite's visible bounds from `base:selectionAnchor`; null = unknown. */
export interface SelectionUi {
  plate: NamePlateUi;
  bar: CommandBarUi;
  anchor: PxRect | null;
}

/** What the caller does with a command tap (`CommandRoute`, KitLogic.kt). */
export type CommandRoute = 'OPEN' | 'NEED_MORE' | 'EXPLAIN' | 'IGNORE';

/** One open sheet as the host sees it. `key` changes when a different sheet replaces the current one. */
export interface SheetHostUi {
  key: string;
  size: SheetSize;
  /** Accessible name of the dialog region ("Need more", "Gold Forge"). */
  label: string;
}

/** What the host publishes once per snap change into the single `base:insets` writer (LANE §6 (e)). */
export interface SheetInset {
  /** CSS px the sheet covers from the bottom edge (bottom sheets), else 0. */
  bottom: number;
  /** CSS px the sheet covers from the right edge (side panels), else 0. */
  right: number;
}

/** `NeedMoreDoorUi` (NeedMoreSheet.kt). */
export interface NeedMoreDoorUi {
  icon: string;
  label: string;
  hint: string | null;
  destination: FeatureId;
  locked?: string | null;
}

/** `ShortfallUi` (NeedMoreSheet.kt). have/need/more are server-formatted; unknown = "…". */
export interface ShortfallUi {
  currency: string;
  icon: string;
  name: string;
  have: string;
  need: string;
  more: string;
  sourceLine: string;
  doors: NeedMoreDoorUi[];
}

/** `NeedMoreUi` (NeedMoreSheet.kt). Empty blocks = the shortfall disappeared (the host closes and toasts). */
export interface NeedMoreUi {
  forLabel: string;
  blocks: ShortfallUi[];
  best: NeedMoreDoorUi;
  stale: boolean;
}

/** `NeedMoreActions`: every button only navigates; nothing here can spend. */
export interface NeedMoreActions {
  onDoor: (destination: FeatureId) => void;
  onClose: () => void;
}

/** The JS classifier is the one owner of viewport classes and the bridge attributes. */
import type { PkViewportClass } from './viewportClass';
export type { PkViewportClass } from './viewportClass';

export interface PkViewport {
  vp: PkViewportClass;
  /** Layout viewport in CSS px. */
  w: number;
  h: number;
  dpr: number;
  /** Phone-landscape height sub-class from the JS viewport classifier (LANE §4 `land` column, 915×311 / 844×311):
   *  true = `land` (Full sheet goes to the right panel, Compact header 60). Absent/false = regular height. */
  short?: boolean;
}
