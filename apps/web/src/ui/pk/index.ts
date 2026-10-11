/**
 * PK kit, P0 primitives: the web mirror of the Android kit (KIT-API.md). Intended repo home: `apps/web/src/ui/pk/`
 * (LANE §3 "New code lives in src/ui/pk/"); `Icon.tsx` imports `../icons` from there.
 *
 * FIRST-PAINT RULE (CLAUDE.md hard rule; LANE §1 item 3): this barrel is for code that is ALREADY lazy (sheet chunks,
 * the overlay host's lazy parts). Eager first-paint code (the Home HUD) must import the one file it needs, never this
 * index, so a barrel re-export cannot drag every primitive + its CSS into first paint. Load order of the CSS:
 * pk-tokens.css (eager, generated) -> kitBase.css -> the component CSS each file imports itself.
 *
 * Names follow KIT-API.md with the web `Pk` prefix (MAP-DESIGN-FOR-WEB §3). Where the design map named a component
 * differently, the KIT name wins (Rule 7): PriceChip (not CostPill), TimerChip, SheetTitlePlate.
 *
 * SINGLE SOURCE (Rule 7, parity review 2026-10-03): P0 is the one kit. P1 (HudArt.tsx, pkViewport.ts) and P2 (p2Kit.tsx,
 * usePkViewport.ts, p2Logic outcomeLine/orderCommands, the second PkNamePlate) carry stand-ins that must import from
 * here instead; the migration table is in Icon.md "Single source".
 */
import './kitBase.css';

export type * from './types';
export { featureId } from './types';

export {
  PK_KIT, UNKNOWN, badgeCount, currencyIcon, currencyName, priceText, priceDescription, readoutValue, tileCount,
  compactAmount, exactAmount, countUpText, ToastQueue, sealArmFraction, sealAccepts, moneyLook, orderCommands,
  commandBarLimit, commandDrawState, commandRoute, outcomeLine, glyphKey, CornerProfiles, steppedPolygon,
  steppedClipPath, sheetScrimAlpha, integerArtScale, pixelArtCssSize, SheetGeometry, sheetEdgesDp, stateLineRuns,
} from './kitLogic';
export type { MoneyLook, CommandRoute, StateTone, StateRun } from './kitLogic';

export { syncViewportClass, readViewportClass, useViewportClass, isTouchClass, prefersReducedMotion } from './viewport';
export type { ViewportClass } from './viewport';
export { usePresence } from './presence';
export type { Presence } from './presence';

export { PkIcon, resolvePkIcon, pkArt, FEATURE_ICONS } from './Icon';
export type { PkIconProps, PkTint, PhaseEIconId } from './Icon';

export { PkPlate, PkSheetTitlePlate, PkPlateFrame } from './Plate';
export type { PlateKind, PlateTint, PkPlateProps, PkPlateFrameProps, SheetTitleUi } from './Plate';

export {
  PkPrimaryButton, PkSecondaryButton, PkQuietButton, PkCloseSquare, PkIconSquare, PkGoButton, PkMoneyButton,
  PkBusyDots, PkBadge, PkTag, stateVerb,
} from './Button';
export type {
  PkPrimaryButtonProps, PkSecondaryButtonProps, PkQuietButtonProps, PkIconSquareProps, PkGoButtonProps, PkMoneyButtonProps,
} from './Button';

export { PkPriceChip } from './PriceChip';
export type { PkPriceChipProps } from './PriceChip';

export { PkStatusChip } from './StatusChip';
export type { PkStatusChipProps, StatusChipUi } from './StatusChip';

export { PkTimerPlate, PkTimerChip } from './TimerPlate';

export { PkNamePlate, namePlatePlacement } from './NamePlate';
export type { PkNamePlateProps, NamePlatePlacement } from './NamePlate';

export { PkSeal } from './Seal';
export type { PkSealProps } from './Seal';

export { PkToastHost, PkToast } from './ToastQueue';
export type { PkToastHostProps, PkToastProps, ToastZone } from './ToastQueue';

export { PkCelebration } from './Celebration';
export type { PkCelebrationProps } from './Celebration';
