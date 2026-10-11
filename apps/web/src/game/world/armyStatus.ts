/**
 * Army chips: troop housing and training shown ON the buildings they belong to.
 *
 * Owner 2026-09-19: the former base-wide summary was a three-line opaque text
 * block held at constant SCREEN size. At claim-fit zoom it was several times
 * wider than the Barracks or Camp it hung from, covered the neighbouring
 * buildings, and was clamped into the HUD-safe rectangle — so it could slide
 * off its building entirely and float over open ground. It also picked its
 * anchor by lowest row id across Barracks AND Camps, i.e. an arbitrary one.
 *
 * Now each fact sits on the structure that owns it, in the job-chip plate
 * language (jobs.ts): one CAMP carries the base-wide housing pool, one BARRACKS
 * carries the base-wide training queue and only while something is training.
 * The server does not assign queue rows or housed troops to physical buildings
 * (D-094), so repeating one pool on every Camp would read as several pools;
 * a single stable carrier per kind keeps the number truthful and the map quiet.
 * A chip never leaves its building: it is not clamped to the viewport, and it
 * hides rather than jumping to another building while its carrier is carried.
 */
import type Phaser from 'phaser';
import { fmtDur } from '../../lib/duration';
import type { BaseStateDto } from '../../state/store';
import { overlayDepth } from './depth';
import { jobChipPanelTopOffset } from './worldChipGeometry';

type ArmyStatus = NonNullable<BaseStateDto['armyStatus']>;
type Building = BaseStateDto['buildings'][number];
export type ArmyChipKind = 'camp' | 'barracks';
export type ArmyChipTone = 'normal' | 'full' | 'over';
export type ArmyChipIcon = 'helm' | 'hourglass';

const CHIP_DEPTH = overlayDepth(2220);
const MIN_SCREEN_SCALE = 1;
const MAX_WORLD_SCALE = 8;
const MIN_WORLD_SCALE = 0.7;
const CHIP_GAP_WORLD_PX = 8;
const KINDS = ['camp', 'barracks'] as const;

/** VT323 sizes, largest first. The scene renders with NEAREST filtering, so a
 * chip shrinks by re-rasterising its text at a smaller size — never by a
 * fractional scale, which would shred the glyphs. */
export const ARMY_CHIP_FONT_STEPS = [20, 18, 16, 14, 12] as const;
/** Detail is shed before the text drops below this size, so neighbouring chips
 * keep one type size instead of a wordy chip reading smaller than a terse one. */
const DETAIL_MIN_FONT_PX = 18;
/** A chip may overhang its building's footprint by this factor, no more. */
export const ARMY_CHIP_FOOTPRINT_RATIO = 1.2;
const ICON_ART_PX = 9;
const ICON_TEXTURE_KEY = 'army_chip_icons';

/** Plate/ink per tone. `normal` is the builder job chip; `over` is the hero
 * recovery chip — the two plates the base view already uses. */
export const ARMY_CHIP_TONES: Record<ArmyChipTone, {
  fill: number; fillAlpha: number; stroke: number; ink: number; inkCss: string;
}> = {
  normal: { fill: 0x14121a, fillAlpha: 0.92, stroke: 0x3d3833, ink: 0xf4d77b, inkCss: '#F4D77B' },
  full: { fill: 0x14121a, fillAlpha: 0.92, stroke: 0xe3ae3c, ink: 0xf4d77b, inkCss: '#F4D77B' },
  over: { fill: 0x1a0f12, fillAlpha: 0.94, stroke: 0x923746, ink: 0xffd6d6, inkCss: '#ffd6d6' },
};

/** 9×9 one-bit icons, drawn white and tinted with the tone's ink. */
export const ARMY_CHIP_ICON_ROWS: Record<ArmyChipIcon, readonly string[]> = {
  helm: [
    '..XXXXX..',
    '.XXXXXXX.',
    'XXXXXXXXX',
    'XXXXXXXXX',
    'X...X...X',
    'XXXXXXXXX',
    'XXX.X.XXX',
    'XXX.X.XXX',
    '.XXXXXXX.',
  ],
  hourglass: [
    'XXXXXXXXX',
    '.XXXXXXX.',
    '..XXXXX..',
    '...XXX...',
    '....X....',
    '...X.X...',
    '..X.X.X..',
    '.XXXXXXX.',
    'XXXXXXXXX',
  ],
};

export interface ArmyStatusAnchor {
  x: number;
  y: number;
  /** World-pixel width of the building's footprint: the chip's width budget. */
  footprintWidth: number;
}

export interface ArmyChipContent {
  icon: ArmyChipIcon;
  tone: ArmyChipTone;
  /** Widest first; the last entry is the essential form. */
  variants: string[];
}

/** Stack above the job panel when this completed structure is upgrading/repairing. */
export function armyStatusAnchorY(
  visualTopY: number,
  footprintTopY: number,
  hasActiveJob: boolean,
  T: number,
): number {
  return (hasActiveJob
    ? footprintTopY - jobChipPanelTopOffset(T)
    : visualTopY) - CHIP_GAP_WORLD_PX;
}

/** Keep labels legible at claim-fit zoom without letting close zoom dominate. */
export function armyStatusChipScale(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(MAX_WORLD_SCALE, Math.max(MIN_WORLD_SCALE, MIN_SCREEN_SCALE / zoom));
}

/**
 * The ONE building of a kind that carries its base-wide chip: highest level,
 * then plain-string id, matching native. The stable tie-break keeps the chip
 * on the same building when equally levelled camps move past one another.
 * Under-construction structures house and train nothing, so they never carry.
 */
export function armyChipCarrier(
  buildings: ReadonlyArray<Building>,
  kind: ArmyChipKind,
): Building | undefined {
  let carrier: Building | undefined;
  for (const building of buildings) {
    if (building.type !== kind || building.underConstruction) continue;
    if (!carrier
      || building.level > carrier.level
      || (building.level === carrier.level && building.id < carrier.id)) {
      carrier = building;
    }
  }
  return carrier;
}

/** Housing pool: ready plus in-training points against the shared camp capacity. */
export function campChipContent(status: ArmyStatus): ArmyChipContent {
  const used = status.readyPts + status.trainingPts;
  const capacity = status.campCapacityPts;
  const figures = `${used}/${capacity}`;
  if (used > capacity) return { icon: 'helm', tone: 'over', variants: [`OVER ${figures}`, 'OVER'] };
  if (capacity > 0 && used === capacity) {
    return { icon: 'helm', tone: 'full', variants: [`FULL ${figures}`, 'FULL'] };
  }
  return { icon: 'helm', tone: 'normal', variants: [figures] };
}

/** Training queue; `null` while nothing trains — an idle Barracks shows nothing. */
export function barracksChipContent(status: ArmyStatus, nowMs: number): ArmyChipContent | null {
  if (!(status.trainingTroopCount > 0)) return null;
  const deadlineMs = status.allReadyAt === null ? Number.NaN : Date.parse(status.allReadyAt);
  const remainingSec = Math.ceil((deadlineMs - nowMs) / 1_000);
  // Same words as the job chip ("36m 5s"). An elapsed local countdown waits
  // for the server rather than announcing troops it has not confirmed.
  const left = Number.isFinite(remainingSec) && remainingSec > 0 ? fmtDur(remainingSec) : 'VERIFYING';
  const count = status.trainingTroopCount;
  return {
    icon: 'hourglass',
    tone: 'normal',
    variants: [
      `${count} TRAINING · ${left} · ${status.trainingPts}/${status.barracksQueuePts}`,
      `${count} TRAINING · ${left}`,
      `${count} · ${left}`,
      left,
    ],
  };
}

export interface ArmyChipMetrics { iconPx: number; gapPx: number; padX: number; padY: number; cellPx: number }

/** Chip geometry at one font size, in chip-local pixels. */
export function armyChipMetrics(fontPx: number): ArmyChipMetrics {
  return {
    iconPx: ICON_ART_PX * (fontPx >= 18 ? 2 : 1),
    gapPx: Math.round(fontPx * 0.3),
    padX: Math.round(fontPx * 0.3),
    padY: 2,
    cellPx: fontPx * 0.4, // VT323 advance width
  };
}

/** Monospace estimate used to CHOOSE a form; the plate wraps the measured text. */
export function armyChipWidth(text: string, fontPx: number): number {
  const m = armyChipMetrics(fontPx);
  return m.padX * 2 + m.iconPx + m.gapPx + [...text].length * m.cellPx;
}

/**
 * Pick the text form and size for the current zoom. `budget` is the footprint
 * overhang allowance in chip-local pixels. Order of sacrifice: shed detail
 * while the text stays ≥18 px, then shrink the essential form down to 12 px,
 * and only then overhang — legibility at claim-fit zoom outranks the width cap.
 */
export function armyChipLayout(
  variants: ReadonlyArray<string>,
  footprintWidth: number,
  zoom: number,
): { text: string; fontPx: number; scale: number } {
  const scale = armyStatusChipScale(zoom);
  const budget = footprintWidth * ARMY_CHIP_FOOTPRINT_RATIO / scale;
  const essential = variants[variants.length - 1] ?? '';
  for (const text of variants) {
    for (const fontPx of ARMY_CHIP_FONT_STEPS) {
      if (fontPx < DETAIL_MIN_FONT_PX) break;
      if (armyChipWidth(text, fontPx) <= budget) return { text, fontPx, scale };
    }
  }
  for (const fontPx of ARMY_CHIP_FONT_STEPS) {
    if (fontPx < DETAIL_MIN_FONT_PX && armyChipWidth(essential, fontPx) <= budget) {
      return { text: essential, fontPx, scale };
    }
  }
  return { text: essential, fontPx: ARMY_CHIP_FONT_STEPS[ARMY_CHIP_FONT_STEPS.length - 1]!, scale };
}

interface ChipVis {
  kind: ArmyChipKind;
  root: Phaser.GameObjects.Container;
  plate: Phaser.GameObjects.Rectangle;
  icon: Phaser.GameObjects.Image | null;
  label: Phaser.GameObjects.Text;
  /** The carrier this pooled chip currently annotates; null = no carrier. */
  buildingId: string | null;
  anchor: ArmyStatusAnchor;
  manuallyHidden: boolean;
  lastText: string;
  lastFontPx: number;
  lastTone: ArmyChipTone | null;
  lastIcon: ArmyChipIcon | null;
}

/** One game-global 18×9 sheet, written pixel by pixel (keepClock pattern). */
function ensureIconTexture(scene: Phaser.Scene): boolean {
  if (scene.textures.exists(ICON_TEXTURE_KEY)) return true;
  const icons = Object.keys(ARMY_CHIP_ICON_ROWS) as ArmyChipIcon[];
  const texture = scene.textures.createCanvas(ICON_TEXTURE_KEY, ICON_ART_PX * icons.length, ICON_ART_PX);
  if (!texture) return false;
  const context = texture.getContext();
  context.fillStyle = '#ffffff';
  icons.forEach((icon, index) => {
    ARMY_CHIP_ICON_ROWS[icon].forEach((row, y) => {
      [...row].forEach((cell, x) => {
        if (cell === 'X') context.fillRect(index * ICON_ART_PX + x, y, 1, 1);
      });
    });
    texture.add(icon, 0, index * ICON_ART_PX, 0, ICON_ART_PX, ICON_ART_PX);
  });
  texture.refresh();
  return true;
}

export class ArmyStatusLayer {
  /** At most one pooled chip per kind, reused when the carrier changes. */
  private readonly chips = new Map<ArmyChipKind, ChipVis>();
  private status: ArmyStatus | null = null;
  private lastSecond = Number.NaN;
  private lastZoom = Number.NaN;
  private suppressed = false;
  private selectedBuildingId: string | null = null;

  constructor(private readonly scene: Phaser.Scene) {}

  sync(
    status: ArmyStatus | undefined,
    buildings: ReadonlyArray<Building>,
    anchorOf: (building: Building) => ArmyStatusAnchor | undefined,
    nowMs = Date.now(),
  ): void {
    this.status = status ?? null;
    for (const kind of KINDS) {
      // Carriers come from THIS snapshot only: after a base switch the previous
      // base's buildings are not in it, so its chip cannot linger at old tiles.
      const carrier = status ? armyChipCarrier(buildings, kind) : undefined;
      const anchor = carrier ? anchorOf(carrier) : undefined;
      let chip = this.chips.get(kind);
      if (!carrier || !anchor) {
        if (chip) chip.buildingId = null;
        continue;
      }
      if (!chip) { chip = this.create(kind); this.chips.set(kind, chip); }
      chip.buildingId = carrier.id;
      // A server refresh completes a committed drag. Active drags are hidden
      // again synchronously by BaseScene.reseatCarriedPieces after this sync.
      chip.manuallyHidden = false;
      chip.anchor = { ...anchor };
      chip.root.setPosition(anchor.x, anchor.y);
    }
    this.refresh(nowMs);
  }

  /** Text changes once a second; size follows zoom. Panning costs nothing:
   * the chips are world objects glued to their buildings. */
  update(nowMs: number): void {
    const second = Math.floor(nowMs / 1_000);
    if (second === this.lastSecond && this.scene.cameras.main.zoom === this.lastZoom) return;
    this.refresh(nowMs);
  }

  private refresh(nowMs: number): void {
    const zoom = this.scene.cameras.main.zoom;
    this.lastSecond = Math.floor(nowMs / 1_000);
    this.lastZoom = zoom;
    for (const chip of this.chips.values()) {
      const content = !this.status || chip.buildingId === null ? null
        : chip.kind === 'camp' ? campChipContent(this.status)
          : barracksChipContent(this.status, nowMs);
      const visible = content !== null && !this.suppressed && !chip.manuallyHidden
        // The sheet opened over this building is the fuller answer; stay out of its way.
        && chip.buildingId !== this.selectedBuildingId
        && Number.isFinite(zoom) && zoom > 0;
      chip.root.setVisible(visible);
      if (!visible || !content) continue;
      this.present(chip, content, zoom);
    }
  }

  private present(chip: ChipVis, content: ArmyChipContent, zoom: number): void {
    const layout = armyChipLayout(content.variants, chip.anchor.footprintWidth, zoom);
    const tone = ARMY_CHIP_TONES[content.tone];
    const metrics = armyChipMetrics(layout.fontPx);
    let relayout = false;
    if (layout.fontPx !== chip.lastFontPx) {
      chip.label.setFontSize(layout.fontPx); chip.lastFontPx = layout.fontPx; relayout = true;
    }
    if (layout.text !== chip.lastText) {
      chip.label.setText(layout.text); chip.lastText = layout.text; relayout = true;
    }
    if (content.tone !== chip.lastTone) {
      chip.plate.setFillStyle(tone.fill, tone.fillAlpha).setStrokeStyle(2, tone.stroke);
      chip.label.setColor(tone.inkCss);
      chip.icon?.setTint(tone.ink);
      chip.lastTone = content.tone;
    }
    if (chip.icon && content.icon !== chip.lastIcon) {
      chip.icon.setFrame(content.icon); chip.lastIcon = content.icon;
    }
    if (relayout) {
      const iconSpan = chip.icon ? metrics.iconPx + metrics.gapPx : 0;
      const contentWidth = iconSpan + chip.label.width;
      const height = Math.max(chip.label.height, metrics.iconPx) + metrics.padY * 2;
      const left = -Math.round(contentWidth / 2);
      const middle = -Math.round(height / 2);
      chip.plate.setSize(contentWidth + metrics.padX * 2, height);
      chip.icon?.setScale(metrics.iconPx / ICON_ART_PX).setPosition(left, middle);
      chip.label.setPosition(left + iconSpan, middle);
    }
    if (chip.root.scaleX !== layout.scale) chip.root.setScale(layout.scale);
  }

  private create(kind: ArmyChipKind): ChipVis {
    const fontPx = ARMY_CHIP_FONT_STEPS[0];
    const plate = this.scene.add.rectangle(0, 0, 10, 10, 0x14121a, 0.92).setOrigin(0.5, 1);
    const label = this.scene.add.text(0, 0, '', {
      color: ARMY_CHIP_TONES.normal.inkCss,
      fontFamily: 'VT323, monospace',
      fontSize: `${fontPx}px`,
    }).setOrigin(0, 0.5);
    const icon = ensureIconTexture(this.scene)
      ? this.scene.add.image(0, 0, ICON_TEXTURE_KEY, kind === 'camp' ? 'helm' : 'hourglass').setOrigin(0, 0.5)
      : null;
    const root = this.scene.add.container(0, 0, icon ? [plate, icon, label] : [plate, label])
      .setDepth(CHIP_DEPTH).setVisible(false);
    return {
      kind, root, plate, icon, label, buildingId: null,
      anchor: { x: 0, y: 0, footprintWidth: 0 }, manuallyHidden: false,
      lastText: '', lastFontPx: fontPx, lastTone: null, lastIcon: null,
    };
  }

  /** Placement, moves and layout drafts suppress every chip until ordinary mode returns. */
  setSuppressed(suppressed: boolean): void {
    if (this.suppressed === suppressed) return;
    this.suppressed = suppressed;
    this.refresh(Date.now());
  }

  /** The building whose sheet is open; its chip yields to the sheet. */
  setSelected(buildingId: string | null): void {
    if (this.selectedBuildingId === buildingId) return;
    this.selectedBuildingId = buildingId;
    this.refresh(Date.now());
  }

  /** Hide the chip paired with a building while that building is carried. */
  hide(buildingId: string): void { this.setManuallyHidden(buildingId, true); }

  /** Restore after a rejected/cancelled drag; a live layout draft stays hidden. */
  show(buildingId: string): void { this.setManuallyHidden(buildingId, false); }

  private setManuallyHidden(buildingId: string, hidden: boolean): void {
    for (const chip of this.chips.values()) {
      if (chip.buildingId !== buildingId || chip.manuallyHidden === hidden) continue;
      chip.manuallyHidden = hidden;
      this.refresh(Date.now());
    }
  }

  destroy(): void {
    for (const chip of this.chips.values()) chip.root.destroy();
    this.chips.clear();
    this.status = null;
  }
}
