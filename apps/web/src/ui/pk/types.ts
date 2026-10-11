/**
 * PK kit UI state types: the web mirror of the Android `…Ui` classes (K/ui/model/UiModels.kt, KIT-API.md "UI state
 * classes"). Field NAMES and ORDER are the Android ones so a mapper can be ported 1:1 and web and Android cannot drift.
 * Kotlin enums become string-literal unions with the SAME constant names (no TS `enum`: zero runtime cost, tree-shakes).
 * Nullable Kotlin fields are `T | null`; Kotlin defaults are optional (`?:`) fields with the default named in a comment.
 *
 * Only the classes the P0 primitives read are here. Later parts add theirs (CommandUi, SheetFrameUi, …) in the same file.
 */

/** The id of one Feature Registry row (`hud.profile`, `goldforge.forge`). Android: `@JvmInline value class FeatureId`.
 *  Branded so a plain string cannot be passed by mistake; build one with {@link featureId}. */
export type FeatureId = string & { readonly __featureId: unique symbol };
export const featureId = (value: string): FeatureId => value as FeatureId;

/** Colour = verb (DESIGN-SYSTEM §2). */
export type Verb = 'GOLD' | 'GREEN' | 'BLUE' | 'RED' | 'STONE' | 'CHARCOAL' | 'OFF' | 'MOSS';

/** The one badge grammar: red count, gold reward / NEW, green "!" ready, blue info. */
export type BadgeTone = 'COUNT' | 'REWARD' | 'READY' | 'INFO';

export interface BadgeUi {
  /** Exactly what the badge shows ("3", "99+", "NEW", "!"). Never empty. */
  text: string;
  tone: BadgeTone;
  /** Screen-reader text ("3 quests ready to claim"). */
  description: string;
}

export type ChipTone = 'NORMAL' | 'ALERT' | 'DANGER';

/** One StatusChip segment: trophies, builders or shield. */
export interface ChipUi {
  /** The registry row a tap opens (Leagues, Builders, Defence log). */
  id: FeatureId;
  /** League crest, `builder`, `shield`. */
  icon: string;
  /** Formatted value ("1,284", "1/2", "4h", "…"). */
  value: string;
  description: string;
  /** The 6 dp gold dot. Default false. */
  dot?: boolean;
  /** Default NORMAL. */
  tone?: ChipTone;
}

/** A command / button state (CommandState). */
export type CommandState = 'ENABLED' | 'DISABLED' | 'BUSY' | 'SHORT' | 'LOCKED';

export type Currency = 'SHARDS' | 'GEMS' | 'KEEP' | 'SKR' | 'SOL' | 'ITEM';

/** Never "0" or FREE without SERVER_ZERO. */
export type PriceStatus = 'OK' | 'CHECKING' | 'UNAVAILABLE' | 'SHORT' | 'SERVER_ZERO';

export interface PriceUi {
  currency: Currency;
  /** Formatted amount ("52,400"); null while unknown. Never drawn for CHECKING / UNAVAILABLE. */
  amount: string | null;
  status: PriceStatus;
  /** Icon override (required for ITEM). Default null. */
  icon?: string | null;
  /** Screen-reader text; null builds it (priceDescription). Default null. */
  description?: string | null;
}

/** A command of the building bar (CommandMedallion). Declared here because commandDrawState / commandRoute /
 *  orderCommands live in kitLogic; the medallion itself is P2. */
export interface CommandUi {
  id: FeatureId;
  icon: string;
  caption: string;
  price: PriceUi | null;
  primary: boolean;
  state: CommandState;
  reason: string | null;
  badge: BadgeUi | null;
  /** Default STONE. */
  verb?: Verb;
  /** Default null. */
  sub?: string | null;
  /** Default null. */
  iconSecondary?: string | null;
}

/** The name plate over a selected building. */
export interface NamePlateUi {
  name: string;
  /** Tag text exactly as shown ("LV 3", "NEW", "…"). */
  level: string;
  /** "Smelted 2/3 · pool 6h 20m", "Ready", "Max"; null shows none. */
  stateLine: string | null;
  /** 0..1 job progress for the plate meter; null draws none. */
  progress: number | null;
}

/** A money consent. */
export interface SealUi {
  title: string;
  lines: string[];
  price: PriceUi;
  confirmLabel: string;
  /** Wall-clock ms when the seal was raised. The primary accepts only from armedAtMs + sealArm (450 ms). */
  armedAtMs: number;
  /** Default null. */
  gets?: PriceUi | null;
  /** Default "BACK". */
  backLabel?: string;
}

export type ToastKind = 'INFO' | 'ERROR';

export interface ToastUi {
  /** Merge key. */
  key: string;
  /** One VT sentence. Money copy rule: only an authoritative refusal says "Nothing was spent" (kitLogic.outcomeLine). */
  message: string;
  icon: string | null;
  kind: ToastKind;
  /** Where the blue GO goes; null draws no GO. */
  go: FeatureId | null;
  goLabel: string | null;
  /** True draws the "Report" link. */
  report: boolean;
  postedAtMs: number;
  /** Bumped by every merge so the toast's own hold restarts. Default 0. */
  revision?: number;
}

/** The receipt-gated celebration. */
export interface CelebrationUi {
  /** The server receipt that proves the money moved. Required. */
  receiptId: string;
  icon: string;
  ribbon: string;
  line: string;
}

/** A timer readout (TimerChip; also the sheet header's live chip). */
export interface TimerUi {
  /** "6h 20m" (m:ss below 1 h) or "…". */
  text: string;
  description: string;
  /** Default "timer". */
  icon?: string;
  /** Default null. */
  progress?: number | null;
}

/** The money sequence of a CLAIM / BUY GEMS / BID / SOL button. */
export type MoneyStage = 'READY' | 'CHECK_WALLET' | 'SENDING' | 'SENT' | 'FAILED';

/** A world marker's kind (BuildingStateMarkers.kt MarkerKind). The P0 TimerPlate draws CONSTRUCTION / UPGRADING. */
export type MarkerKind = 'READY' | 'NOTICE' | 'CONSTRUCTION' | 'UPGRADING';

/** A rect in overlay CSS px (Android PxRect is screen px; the web bridge `base:selectionAnchor` gives CSS px). */
export interface PxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One building state marker (BuildingStateMarkers.kt BuildingMarkerUi). */
export interface BuildingMarkerUi {
  buildingId: string;
  /** The sprite's visible bounds in overlay CSS px. */
  anchor: PxRect;
  kind: MarkerKind;
  /** Bubbles: the 32 dp icon. Timer plates ignore it (they draw the builder). */
  icon: string;
  /** Timer plates: time left ("1h 12m", "…"). */
  text: string | null;
  /** 0..1 done; null = unknown (empty meter, never drawn as zero done). */
  progress: number | null;
  description: string;
}

/** Sheet sizes (SheetSize). Declared for sheetScrimAlpha; the sheet host is P2. */
export type SheetSize = 'HALF' | 'TALL' | 'FULL';
