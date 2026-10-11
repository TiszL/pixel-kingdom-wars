/**
 * The pure rules behind the kit: a 1:1 port of AND:K/ui/kit/KitLogic.kt (plus `stateLineRuns` from
 * K/ui/command/CommandBarLayout.kt and the web-only `commandBarLimit` compact cap, LANE §5 amendment 4).
 * Same names, same branches, same outputs, so `KitLogicTest.kt` ports to vitest case-for-case (LANE §3 P0 "Pure logic").
 * No React, no DOM, no wall clock: callers pass `nowMs`.
 */
import { GLYPH_ALIASES, KIT_GLYPHS } from './kitGlyphs';
import type {
  CommandState, CommandUi, Currency, MoneyStage, PriceUi, SheetSize, ToastUi, Verb,
} from './types';

/**
 * Numbers the JS rules need (TOKENS motion.durationMs.sealArm / toastHold, budget.*, KIT PkwTokens.Budget).
 * TODO(F2a): import these from the generated `pk-tokens.ts` (LANE §3 P0) and delete this block; the values are the
 * bridge's (`--pk-dur-seal-arm` 450, `--pk-dur-toast-hold` 4000). They live in JS, not read from CSS, because the Seal's
 * double-tap guard must not depend on a stylesheet having loaded.
 */
export const PK_KIT = {
  SEAL_ARM_MS: 450,
  TOAST_HOLD_MS: 4000,
  MAX_TOASTS: 3,
  /** PkwTokens.Budget.MAX_COMMANDS (landscape). */
  MAX_COMMANDS: 5,
  /** PkwTokens.Budget.MAX_COMMANDS_PORTRAIT. */
  MAX_COMMANDS_PORTRAIT: 4,
  /** Web-only (LANE §5 amendment 4): below 360 CSS px wide. Not part of the Android parity port. */
  MAX_COMMANDS_COMPACT: 3,
  /** The compact cap applies below this width (MAP-DESIGN-FOR-WEB §4.3 item 3). A rule input, not a CSS breakpoint. */
  COMPACT_WIDTH_PX: 360,
  /** Scrim alphas (TOKENS color.scrim). */
  SCRIM_SHEET_HALF: 0,
  SCRIM_SHEET_TALL: 0.4,
  SCRIM_FULL_CARD: 0.6,
} as const;

/** The ellipsis every unknown value renders as. Never "0". */
export const UNKNOWN = '…';

/** A count badge's text: null for nothing to show (<= 0), "99+" above 99. */
export function badgeCount(count: number): string | null {
  if (count <= 0) return null;
  if (count > 99) return '99+';
  return String(Math.trunc(count));
}

/** The icon name of a currency's 24 px icon; an ITEM price must carry its own override. */
export function currencyIcon(currency: Currency, override: string | null = null): string {
  if (override != null) return override;
  switch (currency) {
    case 'SHARDS': return 'shards';
    case 'GEMS': return 'gem';
    case 'KEEP': return 'keep';
    case 'SKR': return 'skr';
    case 'SOL': return 'sol';
    case 'ITEM': return 'shape:unknown';
  }
}

/** A currency's spoken name. */
export function currencyName(currency: Currency): string {
  switch (currency) {
    case 'SHARDS': return 'Shards';
    case 'GEMS': return 'Gems';
    case 'KEEP': return 'KEEP';
    case 'SKR': return 'SKR';
    case 'SOL': return 'SOL';
    case 'ITEM': return 'items';
  }
}

/** What a cost pill reads: CHECKING "…", UNAVAILABLE "unavailable", missing amount "…", "0" only for SERVER_ZERO. */
export function priceText(price: PriceUi): string {
  switch (price.status) {
    case 'CHECKING': return UNKNOWN;
    case 'UNAVAILABLE': return 'unavailable';
    case 'SERVER_ZERO': return price.amount ?? '0';
    case 'OK':
    case 'SHORT': return price.amount != null && price.amount.trim() !== '' ? price.amount : UNKNOWN;
  }
}

/** What a screen reader says for a price. */
export function priceDescription(price: PriceUi): string {
  if (price.description != null) return price.description;
  const name = currencyName(price.currency);
  switch (price.status) {
    case 'CHECKING': return `${name} price: checking`;
    case 'UNAVAILABLE': return `${name} price unavailable`;
    case 'SHORT': return `Costs ${priceText(price)} ${name}, not enough`;
    case 'SERVER_ZERO':
    case 'OK': return `Costs ${priceText(price)} ${name}`;
  }
}

/** "1234567" → "1,234,567" (no locale: the same output on every device). */
function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** value / unit with one truncated decimal, dropping ".0". */
function scaled(value: number, unit: number, suffix: string): string {
  const tenths = Math.floor(value / (unit / 10));
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  return frac === 0 ? `${whole}${suffix}` : `${whole}.${frac}${suffix}`;
}

/** A HUD readout value in at most 6 glyphs ("40,943", "123.4K", "1.2M"). Rounds down. Null is "…". */
export function readoutValue(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return UNKNOWN;
  const v = Math.trunc(value);
  if (v < 0) return '-' + readoutValue(-v);
  if (v < 100_000) return groupThousands(String(v));
  if (v < 1_000_000) return scaled(v, 1_000, 'K');
  if (v < 1_000_000_000) return scaled(v, 1_000_000, 'M');
  return scaled(v, 1_000_000_000, 'B');
}

/** A drawer tile count in at most 4 glyphs ("120", "2.5K", "48K", "1.2M"). Rounds down. Null is "…". */
export function tileCount(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return UNKNOWN;
  const v = Math.trunc(value);
  if (v < 0) return '-' + tileCount(-v);
  if (v < 1_000) return String(v);
  if (v < 10_000) return scaled(v, 1_000, 'K');
  if (v < 1_000_000) return `${Math.floor(v / 1_000)}K`;
  if (v < 10_000_000) return scaled(v, 1_000_000, 'M');
  if (v < 1_000_000_000) return `${Math.floor(v / 1_000_000)}M`;
  return `${Math.floor(v / 1_000_000_000)}B`;
}

const GROUPED = /^\d{1,3}(,\d{3})*$/;
const PLAIN = /^\d+$/;

/** The text a readout shows t (0..1) through its count-up. Only plain / grouped whole numbers count up. */
export function countUpText(from: string, to: string, t: number): string {
  if (t >= 1 || from === to) return to;
  const grouped = GROUPED.test(to);
  if (!(grouped || PLAIN.test(to)) || !(GROUPED.test(from) || PLAIN.test(from))) return to;
  const a = Number(from.replace(/,/g, ''));
  const b = Number(to.replace(/,/g, ''));
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return to;
  const k = Math.min(1, Math.max(0, t));
  const v = a + Math.trunc((b - a) * k);
  return grouped ? groupThousands(String(v)) : String(v);
}

interface DecimalParts { negative: boolean; whole: string; fraction: string }
const CANONICAL_DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/** A canonical decimal or base-unit string split by string arithmetic only (no Number, any length). */
function decimalParts(amount: string | null, decimals: number): DecimalParts | null {
  if (amount == null || decimals < 0) return null;
  const match = CANONICAL_DECIMAL.exec(amount.trim());
  if (!match) return null;
  const int = match[2] ?? '';
  const frac = match[3] ?? '';
  if (int === '' && frac === '') return null;
  const digits = int + frac;
  const pointAt = int.length - decimals;
  const whole = pointAt <= 0 ? '' : digits.slice(0, pointAt);
  const fraction = pointAt <= 0 ? '0'.repeat(-pointAt) + digits : digits.slice(pointAt);
  const w = whole.replace(/^0+/, '') || '0';
  const f = fraction.replace(/0+$/, '');
  const isZero = w === '0' && f === '';
  return { negative: !isZero && match[1] === '-', whole: w, fraction: f };
}

const COMPACT_UNITS: ReadonlyArray<readonly [number, string]> = [[3, 'K'], [6, 'M'], [9, 'B'], [12, 'T']];

/** A HUD / pill amount in at most maxGlyphs glyphs from a canonical decimal or base-unit string; rounds DOWN. */
export function compactAmount(amount: string | null, decimals = 0, maxGlyphs = 6): string {
  const parts = decimalParts(amount, decimals);
  if (!parts) return UNKNOWN;
  if (parts.whole === '0' && parts.fraction === '') return '0';
  const sign = parts.negative ? '-' : '';
  const { whole, fraction } = parts;
  if (whole === '0') {
    const two = fraction.slice(0, 2).padEnd(2, '0');
    if (two === '00') return sign + '<0.01';
    return sign + '0.' + two.replace(/0+$/, '');
  }
  const grouped = groupThousands(whole);
  if (grouped.length <= maxGlyphs) {
    const room = maxGlyphs - grouped.length - 1;
    const shown = room <= 0 ? '' : fraction.slice(0, Math.min(2, room)).replace(/0+$/, '');
    return sign + (shown === '' ? grouped : `${grouped}.${shown}`);
  }
  let unit = COMPACT_UNITS[0]!;
  for (const u of COMPACT_UNITS) if (whole.length > u[0]) unit = u;
  const [drop, suffix] = unit;
  const head = whole.slice(0, whole.length - drop);
  const tenth = whole[whole.length - drop]!;
  const withTenth = `${head}.${tenth}${suffix}`;
  const plain = `${head}${suffix}`;
  return sign + (tenth !== '0' && withTenth.length <= maxGlyphs ? withTenth : plain);
}

/** Every digit, grouped, trailing fraction zeros dropped ("1,234,567.000001"). Unknown → "…". */
export function exactAmount(amount: string | null, decimals = 0): string {
  const parts = decimalParts(amount, decimals);
  if (!parts) return UNKNOWN;
  const sign = parts.negative ? '-' : '';
  const grouped = groupThousands(parts.whole);
  return sign + (parts.fraction === '' ? grouped : `${grouped}.${parts.fraction}`);
}

/** Toast queue rules: the same key merges in place (hold restarts), at most MAX_TOASTS, 4 s each. */
export const ToastQueue = {
  post(current: readonly ToastUi[], toast: ToastUi, nowMs: number, max: number = PK_KIT.MAX_TOASTS): ToastUi[] {
    const index = current.findIndex((t) => t.key === toast.key);
    if (index >= 0) {
      const merged: ToastUi = { ...toast, postedAtMs: nowMs, revision: (current[index]!.revision ?? 0) + 1 };
      return current.map((t, i) => (i === index ? merged : t));
    }
    return [...current, { ...toast, postedAtMs: nowMs }].slice(-Math.max(1, max));
  },
  expire(current: readonly ToastUi[], nowMs: number, holdMs: number = PK_KIT.TOAST_HOLD_MS): ToastUi[] {
    return current.filter((t) => nowMs - t.postedAtMs < holdMs);
  },
  /** When the next toast expires, or null: the host's single timer. */
  nextExpiry(current: readonly ToastUi[], holdMs: number = PK_KIT.TOAST_HOLD_MS): number | null {
    if (current.length === 0) return null;
    return Math.min(...current.map((t) => t.postedAtMs + holdMs));
  },
} as const;

/** How far (0..1) a seal raised at armedAtMs has armed at nowMs. */
export function sealArmFraction(nowMs: number, armedAtMs: number, armMs: number = PK_KIT.SEAL_ARM_MS): number {
  return Math.min(1, Math.max(0, (nowMs - armedAtMs) / armMs));
}

/** Whether a seal's primary accepts a tap at nowMs (it arms over 450 ms first). */
export function sealAccepts(nowMs: number, armedAtMs: number, armMs: number = PK_KIT.SEAL_ARM_MS): boolean {
  return nowMs - armedAtMs >= armMs;
}

export interface MoneyLook { verb: Verb; text: string; sentence: boolean; dots: boolean; accepts: boolean }

/** The money sequence: gold label → stone "Check wallet" → stone dots "Sending" → moss SENT, or red RETRY. */
export function moneyLook(stage: MoneyStage, label: string, retryLabel = 'RETRY'): MoneyLook {
  switch (stage) {
    case 'READY': return { verb: 'GOLD', text: label, sentence: false, dots: false, accepts: true };
    case 'CHECK_WALLET': return { verb: 'STONE', text: 'Check wallet', sentence: true, dots: false, accepts: false };
    case 'SENDING': return { verb: 'STONE', text: 'Sending', sentence: true, dots: true, accepts: false };
    case 'SENT': return { verb: 'MOSS', text: 'SENT', sentence: false, dots: false, accepts: false };
    case 'FAILED': return { verb: 'RED', text: retryLabel, sentence: false, dots: false, accepts: true };
  }
}

/** INFO first, secondaries, the one primary LAST; a second primary is demoted; never more than max (primary kept). */
export function orderCommands(commands: readonly CommandUi[], max: number = PK_KIT.MAX_COMMANDS): CommandUi[] {
  const primary = commands.find((c) => c.primary);
  const rest = commands.filter((c) => c !== primary).map((c) => (c.primary ? { ...c, primary: false } : c));
  return primary == null ? rest.slice(0, max) : [...rest.slice(0, Math.max(0, max - 1)), primary];
}

/**
 * The bar limit for a viewport: 4 portrait / 5 landscape (AND:K/ui/command/CommandBarLayout.kt:136-138), and the
 * web-only 3 below 360 CSS px wide (LANE §5 amendment 4; tested separately from the parity port).
 */
export function commandBarLimit(widthPx: number, heightPx: number): number {
  if (widthPx < PK_KIT.COMPACT_WIDTH_PX) return PK_KIT.MAX_COMMANDS_COMPACT;
  return widthPx > heightPx ? PK_KIT.MAX_COMMANDS : PK_KIT.MAX_COMMANDS_PORTRAIT;
}

/** The DRAWN state: a CHECKING price stays ENABLED (navigation), UNAVAILABLE → DISABLED, SHORT → SHORT. */
export function commandDrawState(ui: Pick<CommandUi, 'state' | 'price'>): CommandState {
  if (ui.state !== 'ENABLED') return ui.state;
  switch (ui.price?.status) {
    case 'UNAVAILABLE': return 'DISABLED';
    case 'SHORT': return 'SHORT';
    default: return 'ENABLED';
  }
}

/** What the caller does with a tap: OPEN (incl. CHECKING), NEED_MORE (SHORT), EXPLAIN (DISABLED/LOCKED), IGNORE (BUSY). */
export type CommandRoute = 'OPEN' | 'NEED_MORE' | 'EXPLAIN' | 'IGNORE';

export function commandRoute(ui: Pick<CommandUi, 'state' | 'price'>): CommandRoute {
  switch (commandDrawState(ui)) {
    case 'ENABLED': return 'OPEN';
    case 'SHORT': return 'NEED_MORE';
    case 'DISABLED':
    case 'LOCKED': return 'EXPLAIN';
    case 'BUSY': return 'IGNORE';
  }
}

/** The one sentence after a spend that did not complete. ONLY an authoritative refusal says nothing was spent. */
export function outcomeLine(action: string, authoritative: boolean, serverReason: string | null = null): string {
  if (!authoritative) return `Checking whether the ${action} went through.`;
  const why = serverReason?.trim().replace(/\.+$/, '');
  return why ? `${why}. Nothing was spent.` : `The ${action} didn't happen. Nothing was spent.`;
}

/** The KIT_GLYPHS key a `shape:<name>` draws: the name, an alias, or "unknown" (the visible "?"). */
export function glyphKey(name: string): string {
  const bare = name.startsWith('shape:') ? name.slice('shape:'.length) : name;
  const key = GLYPH_ALIASES[bare] ?? bare;
  return key in KIT_GLYPHS ? key : 'unknown';
}

/** Stepped corner profiles as (x, y) px pairs of the top-left corner: S cuts 4 in 2 steps, M cuts 8 in 3. */
export const CornerProfiles = {
  S: [0, 4, 2, 4, 2, 2, 4, 2, 4, 0],
  M: [0, 8, 2, 8, 2, 4, 4, 4, 4, 2, 8, 2, 8, 0],
  NONE: [0, 0],
} as const;

/** The closed polygon (x0, y0, …) of a width × height box with all four corners cut by profile. */
export function steppedPolygon(width: number, height: number, profile: readonly number[]): number[] {
  if (profile.length < 2 || profile.length % 2 !== 0) throw new Error('profile must be (x, y) pairs');
  const n = profile.length / 2;
  const cut = Math.max(Math.max(...profile), 0);
  const k = cut <= 0 ? 1 : Math.max(0, Math.min(1, width / (2 * cut), height / (2 * cut)));
  const px = (j: number) => profile[2 * j]! * k;
  const py = (j: number) => profile[2 * j + 1]! * k;
  const out: number[] = [];
  for (let j = 0; j < n; j++) out.push(px(j), py(j));
  for (let j = n - 1; j >= 0; j--) out.push(width - px(j), py(j));
  for (let j = 0; j < n; j++) out.push(width - px(j), height - py(j));
  for (let j = n - 1; j >= 0; j--) out.push(px(j), height - py(j));
  return out;
}

/** steppedPolygon as a size-independent CSS clip-path (the web helper MAP §3 calls steppedClipPath). */
export function steppedClipPath(profile: 'S' | 'M'): string {
  const p = CornerProfiles[profile];
  const n = p.length / 2;
  const pts: string[] = [];
  const at = (x: string, y: string) => pts.push(`${x} ${y}`);
  const v = (n2: number) => `${n2}px`;
  const far = (n2: number) => (n2 === 0 ? '100%' : `calc(100% - ${n2}px)`);
  for (let j = 0; j < n; j++) at(v(p[2 * j]!), v(p[2 * j + 1]!));
  for (let j = n - 1; j >= 0; j--) at(far(p[2 * j]!), v(p[2 * j + 1]!));
  for (let j = 0; j < n; j++) at(far(p[2 * j]!), far(p[2 * j + 1]!));
  for (let j = n - 1; j >= 0; j--) at(v(p[2 * j]!), far(p[2 * j + 1]!));
  return `polygon(${pts.join(', ')})`;
}

/** The scrim alpha of a sheet size: a HALF sheet has none. */
export function sheetScrimAlpha(size: SheetSize): number {
  switch (size) {
    case 'HALF': return PK_KIT.SCRIM_SHEET_HALF;
    case 'TALL': return PK_KIT.SCRIM_SHEET_TALL;
    case 'FULL': return PK_KIT.SCRIM_FULL_CARD;
  }
}

/** The whole number of device px per art px nearest to fitting art into targetPx (>= 1). Nearest, not floor. */
export function integerArtScale(targetPx: number, art: number): number {
  return art <= 0 ? 1 : Math.max(1, Math.floor(targetPx / art + 0.5));
}

/**
 * The CSS size that draws `art` px art at a whole device scale near `targetCss` CSS px (LANE §4 pixel-art rule).
 * Web-only branch: art more than 1.5x the box in DEVICE px (60 px builder in a 30 box, 64 px Phase E icon at 32, 40 px
 * crest at 20 — all at DPR 1) draws at a whole DIVISOR instead (1/2, 1/3 …), so it never overflows its box. Android
 * never reaches it (density >= 2 keeps those at scale 1); P1 homeHudLogic.artCssSize already does the same.
 */
export function pixelArtCssSize(targetCss: number, art: number, dpr: number): number {
  const d = dpr > 0 ? dpr : 1;
  const target = targetCss * d;
  if (art > target * 1.5) return art / (Math.max(1, Math.round(art / target)) * d);
  return (art * integerArtScale(target, art)) / d;
}

export const SheetGeometry = {
  TALL_TOP_DP: 104,
  FULL_TOP_DP: 60,
  FULL_BOTTOM_DP: 14,
  HEADER_DP: 136,
  GOLD_FORGE_HEADER_DP: 204,
} as const;

/** (top, bottom) gaps of a sheet, bottom incl. the gesture inset; null for HALF. */
export function sheetEdgesDp(size: SheetSize, gestureInsetDp: number): [number, number] | null {
  const inset = Math.max(0, gestureInsetDp);
  switch (size) {
    case 'HALF': return null;
    case 'TALL': return [SheetGeometry.TALL_TOP_DP, inset];
    case 'FULL': return [SheetGeometry.FULL_TOP_DP, SheetGeometry.FULL_BOTTOM_DP + inset];
  }
}

/** Name-plate state line tones (CommandBarLayout.kt StateTone). */
export type StateTone = 'MUTED' | 'VALUE' | 'TIME' | 'READY' | 'DANGER';
export interface StateRun { text: string; tone: StateTone }

const STATE_TIME = /\b\d+h(?: \d+m)?\b|\b\d+m(?: \d+s)?\b|\b\d+:\d{2}\b|\b\d+s\b/g;
const STATE_VALUE = /[^\s·]*\d[^\s·]*/g;
const STATE_LEAD = /^(Ready|Spent)\b/;

/** Splits a state line into tinted runs: muted words, counts VALUE, times TIME, a leading Ready/Spent READY/DANGER. */
export function stateLineRuns(line: string): StateRun[] {
  if (line === '') return [];
  const tones: StateTone[] = Array.from({ length: line.length }, () => 'MUTED');
  const paint = (re: RegExp, tone: StateTone) => {
    for (const m of line.matchAll(re)) for (let i = m.index!; i < m.index! + m[0].length; i++) tones[i] = tone;
  };
  paint(STATE_VALUE, 'VALUE');
  paint(STATE_TIME, 'TIME');
  const lead = STATE_LEAD.exec(line);
  if (lead) for (let i = 0; i < lead[0].length; i++) tones[i] = lead[0] === 'Spent' ? 'DANGER' : 'READY';
  const runs: StateRun[] = [];
  let start = 0;
  for (let i = 1; i <= line.length; i++) {
    if (i === line.length || tones[i] !== tones[start]) {
      runs.push({ text: line.slice(start, i), tone: tones[start]! });
      start = i;
    }
  }
  return runs;
}
