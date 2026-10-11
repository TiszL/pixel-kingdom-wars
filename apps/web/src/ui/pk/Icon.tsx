/**
 * <PkIcon>: the web PkwIcon (AND:K/ui/kit/PkwIcon.kt, KIT-API rule 4). One string grammar for every icon:
 *   - `shape:<name>`  a drawn 12x12 kit glyph (lock close caret up plus minus info chat mail check go chest hammer axe
 *                     anchor unknown; aliases envelope / speech / chevron-up). Any other shape draws the visible "?".
 *   - `ui:<id>`       one of the 16 bundled Phase E icons (64 px art; draw at 32 or 64).
 *   - kit names       `skr gem gem-32 shards keep sol timer builder`, league crests `league-<bronze|silver|gold|sol>`,
 *                     and the GameArt aliases `army` / `build` (AND:K/ui/chrome/PixelArt.kt).
 *   - any other name  an existing web icon (`src/ui/icons.ts` ICONS) or master sprite (`sprite(name)`).
 * A name the web cannot resolve draws the "?" glyph (never nothing) and carries `data-pk-missing` so QA can list it.
 *
 * Pixel rule (LANE §4): the art draws at a WHOLE number of device px per art px nearest the target box
 * (`pixelArtCssSize`), centred, `image-rendering: pixelated`. A 24 px icon at DPR 1 is 24 or 48, never 36.
 *
 * Also exports `FEATURE_ICONS`, the FeatureId -> icon-name table (Android has none yet: BuildingCommandAdapter.kt:27
 * "the kit has no FeatureId -> icon table yet"); it is seeded only from names the Android code already uses.
 */
import type { CSSProperties } from 'react';
import { ICONS, type IconName, sprite } from '../icons';
import { leagueCrestUrl } from '../screens/leagueTier';
// Kit art, byte copies (cp -p, sha256 checked: art/SHA256SUMS, Icon.md "Art copies").
import gem24 from './art/gem-24.png';
import gem32 from './art/gem-32.png';
import builder from './art/builder.png';
import climateKit from './art/climate-kit.png';
import crystalFragments from './art/crystal-fragments.png';
import divineNavigation from './art/divine-navigation.png';
import exhaustedStatus from './art/exhausted-status.png';
import exp from './art/exp.png';
import expeditionKit from './art/expedition-kit.png';
import harvesterMenu from './art/harvester-menu.png';
import lodgeMenu from './art/lodge-menu.png';
import marketMenu from './art/market-menu.png';
import navigationKit from './art/navigation-kit.png';
import queueStatus from './art/queue-status.png';
import readyStatus from './art/ready-status.png';
import renown from './art/renown.png';
import seekerNavigation from './art/seeker-navigation.png';
import solanaNavigation from './art/solana-navigation.png';
import workshopMenu from './art/workshop-menu.png';
import { GLYPH_CELLS, KIT_GLYPHS } from './kitGlyphs';
import { glyphKey, pixelArtCssSize } from './kitLogic';
import './kitBase.css';
import './Icon.css';

/** Bridge colour names an icon may be tinted with (glyphs only; art is never tinted). Resolves to `var(--pk-<tint>)`. */
export type PkTint =
  | 'text' | 'text-muted' | 'text-faint' | 'k-label' | 'ink' | 'ink-text' | 'ink-text-2'
  | 'gold' | 'gold-hi' | 'green' | 'green-hi' | 'blue' | 'blue-hi' | 'blue-lo' | 'red' | 'red-hi' | 'stone-hi' | 'danger';

/** Kit names -> the existing web icon (src/ui/icons.ts). */
const KIT_TO_WEB: Readonly<Record<string, IconName>> = {
  shards: 'shard',
  shard: 'shard',
  keep: 'keep',
  skr: 'skr',
  sol: 'sol',
  timer: 'timer',
};

/**
 * Kit names with their own copied art (AND:K/ui/kit/PkwIcon.kt kitDrawable): `gem` = gem_24, `gem-32` = gem_32,
 * `builder` = pkw_web_builder (60 x 60). [url, art px].
 */
const KIT_ART: Readonly<Record<string, readonly [string, number]>> = {
  gem: [gem24, 24],
  'gem-32': [gem32, 32],
  builder: [builder, 60],
  pkw_web_builder: [builder, 60],
};

/** League crests (AND:K/ui/chrome/PixelArt.kt:37-40): `league-<tier>` / `league_<tier>` -> league-assets, 40 x 40. */
const LEAGUE_CREST = /^(?:pkw_web_)?league[-_](bronze|silver|gold|sol)$/;
const LEAGUE_ART_PX = 40;

/** GameArt name aliases the Android kit applies before the sprite lookup (AND:K/ui/chrome/PixelArt.kt:221-226). */
const SPRITE_ALIASES: Readonly<Record<string, string>> = {
  army: 'ui_portrait_highlander_t1',
  build: 'ui_portrait_keep_t1',
};

/** Every web ICONS entry is 24 x 24 art (art/game-v4/ui/legacy-ui_icon_*.png, brand_token_logo.svg viewBox 24). */
const WEB_ICON_ART_PX = 24;
/** The Phase E production icons are 64 x 64 (ASSET-COPIES.md). */
const PHASE_E_ART_PX = 64;

/** The 16 Phase E icons, byte-copied from production-assets/icons (sha256 = manifest.json, see art/SHA256SUMS). */
const PHASE_E_ICON_URLS: Readonly<Record<PhaseEIconId, string>> = {
  'climate-kit': climateKit,
  'crystal-fragments': crystalFragments,
  'divine-navigation': divineNavigation,
  'exhausted-status': exhaustedStatus,
  exp,
  'expedition-kit': expeditionKit,
  'harvester-menu': harvesterMenu,
  'lodge-menu': lodgeMenu,
  'market-menu': marketMenu,
  'navigation-kit': navigationKit,
  'queue-status': queueStatus,
  'ready-status': readyStatus,
  renown,
  'seeker-navigation': seekerNavigation,
  'solana-navigation': solanaNavigation,
  'workshop-menu': workshopMenu,
};

export type PhaseEIconId =
  | 'climate-kit' | 'crystal-fragments' | 'divine-navigation' | 'exhausted-status' | 'exp' | 'expedition-kit'
  | 'harvester-menu' | 'lodge-menu' | 'market-menu' | 'navigation-kit' | 'queue-status' | 'ready-status' | 'renown'
  | 'seeker-navigation' | 'solana-navigation' | 'workshop-menu';

/**
 * FeatureId -> icon name. Seeded ONLY from icon names the Android build already pairs with these ids
 * (BuildingCommandAdapter.kt:72-111, HomeHudBinding.kt:126-128, KitGlyphs.kt SHAPE_CONTRACT header); everything else
 * is the screen's own `icon` field. Grows with the registry (MS-C2), never guessed here.
 */
export const FEATURE_ICONS: Readonly<Record<string, string>> = {
  'building.info': 'shape:info',
  'building.upgrade': 'shape:up',
  'building.finish': 'timer',
  'trap.rearm': 'shape:hammer',
  'barracks.train': 'army',
  'forge.research': 'energy',
  'camp.army': 'army',
  'goldforge.open': 'keep',
  'goldforge.gems': 'gem',
  'mine.collect': 'shards',
  'wall.rowUpgrade': 'shape:up',
  'hud.dailyCache': 'shape:chest',
  'hud.build': 'shape:hammer',
  'build.buildings': 'shape:hammer',
  'obstacle.remove': 'shape:axe',
  'berth.fleet': 'shape:anchor',
};

type Resolved =
  | { kind: 'glyph'; key: string; missing: boolean }
  | { kind: 'art'; url: string; artPx: number };

/** Resolves an icon name to a glyph or an art URL. Pure (no DOM). */
export function resolvePkIcon(name: string): Resolved {
  if (name.startsWith('shape:')) {
    const key = glyphKey(name);
    return { kind: 'glyph', key, missing: key === 'unknown' && name !== 'shape:unknown' };
  }
  const phaseE = name.startsWith('ui:') ? name.slice(3)
    : name.startsWith('pkw_ui_') ? name.slice('pkw_ui_'.length).replace(/_/g, '-') : null;
  if (phaseE != null) {
    const url = (PHASE_E_ICON_URLS as Readonly<Record<string, string>>)[phaseE];
    return url ? { kind: 'art', url, artPx: PHASE_E_ART_PX } : { kind: 'glyph', key: 'unknown', missing: true };
  }
  const kit = KIT_ART[name];
  if (kit) return { kind: 'art', url: kit[0], artPx: kit[1] };
  const crest = LEAGUE_CREST.exec(name);
  if (crest) return { kind: 'art', url: leagueCrestUrl(crest[1] as Parameters<typeof leagueCrestUrl>[0]), artPx: LEAGUE_ART_PX };
  const web = KIT_TO_WEB[name] ?? (name in ICONS ? (name as IconName) : null);
  if (web) return { kind: 'art', url: ICONS[web], artPx: WEB_ICON_ART_PX };
  const url = sprite(SPRITE_ALIASES[name] ?? name);
  // Master sprites have no fixed art size; they are drawn at the box size (pixelated). See Icon.md open question 3.
  if (url) return { kind: 'art', url, artPx: 0 };
  return { kind: 'glyph', key: 'unknown', missing: true };
}

/**
 * The art half of the resolver in the `{ src, artPx }` shape, so any older icon context (P1 `PkArtContext`, P2
 * `PkIconContext`) can be fed from THIS table at the mount until it delegates to `<PkIcon>` (one resolver, Rule 7).
 * `artPx` 0 = a master sprite with no fixed art size. Glyph names and unknowns return null.
 */
export function pkArt(name: string): { src: string; artPx: number } | null {
  const r = resolvePkIcon(name);
  return r.kind === 'art' ? { src: r.url, artPx: r.artPx } : null;
}

/** One row of a glyph as merged horizontal runs: [x, width, cell]. */
function glyphRuns(row: string): Array<[number, number, string]> {
  const runs: Array<[number, number, string]> = [];
  let x = 0;
  while (x < row.length) {
    const cell = row[x]!;
    let w = 1;
    while (x + w < row.length && row[x + w] === cell) w++;
    if (cell !== '.') runs.push([x, w, cell]);
    x += w;
  }
  return runs;
}

const CELL_CLASS: Readonly<Record<string, string>> = { '#': 'pk-icon__t', h: 'pk-icon__h', x: 'pk-icon__x' };

export interface PkIconProps {
  /** Icon name (see grammar above). */
  name: string;
  /** The target box in CSS px (24, 32, 36, 48, 64 in the design). */
  size: number;
  /** Screen-reader text (Android `contentDescription`); omit for a decorative icon (aria-hidden). */
  contentDescription?: string;
  /** 0..1 (a disabled command's icon is 0.6, a locked one 0.5). */
  alpha?: number;
  /** Glyph tint (shapes only). Default 'text'. */
  tint?: PkTint;
  /** Device pixel ratio; defaults to the live window value at render. Injected by tests and previews. */
  dpr?: number;
  className?: string;
}

export function PkIcon({ name, size, contentDescription, alpha = 1, tint = 'text', dpr, className }: PkIconProps): React.JSX.Element {
  const ratio = dpr ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
  const r = resolvePkIcon(name);
  const a11y = contentDescription ? { role: 'img' as const, 'aria-label': contentDescription } : { 'aria-hidden': true as const };
  const box: CSSProperties = { width: size, height: size, opacity: alpha < 1 ? alpha : undefined };
  const cls = ['pk-icon', className].filter(Boolean).join(' ');
  if (r.kind === 'art') {
    const css = r.artPx > 0 ? pixelArtCssSize(size, r.artPx, ratio) : size;
    return (
      <span className={cls} style={box} {...a11y}>
        <img className="pk-icon__img pk-pixel" src={r.url} width={css} height={css} alt="" draggable={false} />
      </span>
    );
  }
  const css = pixelArtCssSize(size, GLYPH_CELLS, ratio);
  // Missing ART (not a shape) draws its "?" in text-faint, which reads on dark plates and on parchment alike.
  const glyphTint: PkTint = r.missing && !name.startsWith('shape:') ? 'text-faint' : tint;
  const rows = KIT_GLYPHS[r.key] ?? KIT_GLYPHS.unknown!;
  return (
    <span className={cls} style={{ ...box, ['--pk-icon-tint' as string]: `var(--pk-${glyphTint})` }}
      data-pk-missing={r.missing ? name : undefined} {...a11y}>
      <svg className="pk-icon__glyph" width={css} height={css} viewBox={`0 0 ${GLYPH_CELLS} ${GLYPH_CELLS}`}
        shapeRendering="crispEdges" focusable="false">
        {rows.map((row, y) => glyphRuns(row).map(([x, w, cell]) => (
          <rect key={`${y}-${x}`} className={CELL_CLASS[cell]} x={x} y={y} width={w} height={1} />
        )))}
      </svg>
    </span>
  );
}
