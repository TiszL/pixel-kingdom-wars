/**
 * Complete pure GoldForgeLogic.kt port from native 28609e71, plus walletTag from
 * ClaimTab.kt for its thirteenth test. No React, transport, clock, or activation.
 * Every amount is already formatted; this module does not grant money admission.
 */
import { UNKNOWN, badgeCount, outcomeLine } from '../kitLogic';
import { featureId } from '../types';
import type { CommandState, CommandUi, MoneyStage, Verb } from '../types';
import type {
  ClaimUi, ForgeAction, ForgePrimaryLook, GemsUi, GemSpendKind, GemSpendUi,
  GoldForgeTabUi, HeroLine, HeroStatusUi, LoadText, MoneyFailure, SmeltState, SmeltTileUi,
} from './goldForgeModel';

export const GoldForgeTabs = { SMELT: 'SMELT', CLAIM: 'CLAIM', GEMS: 'GEMS', LEGACY: 'LEGACY' } as const;

/** CLAIM never disappears when locked; LEGACY is supplied only by the owner's observed state. */
export function goldForgeTabs(claimReady: boolean, gemsWaiting: number, legacy: boolean): GoldForgeTabUi[] {
  const waiting = badgeCount(gemsWaiting);
  const tabs: GoldForgeTabUi[] = [
    { id: GoldForgeTabs.SMELT, icon: 'streak', label: 'SMELT', badge: null, locked: false },
    { id: GoldForgeTabs.CLAIM, icon: 'keep', label: 'CLAIM', locked: false,
      badge: claimReady ? { text: '!', tone: 'READY', description: 'KEEP ready to claim' } : null },
    { id: GoldForgeTabs.GEMS, icon: 'gem', label: 'GEMS', locked: false,
      badge: waiting === null ? null : { text: waiting, tone: 'COUNT', description: gemsWaiting === 1
        ? 'A Gems purchase is waiting for your wallet' : `${gemsWaiting} Gems purchases are waiting for your wallet` } },
  ];
  if (legacy) tabs.push({ id: GoldForgeTabs.LEGACY, icon: 'shape:chest', label: 'LEGACY', badge: null, locked: false });
  return tabs;
}

/** Explicit existing destination, then ready CLAIM, then SMELT, then first tab. */
export function goldForgeDefaultTab(requested: string | null, tabs: readonly string[], claimReady: boolean): string | null {
  const find = (id: string) => tabs.find(tab => tab.toLowerCase() === id.toLowerCase());
  if (requested !== null) {
    const explicit = find(requested);
    if (explicit !== undefined) return explicit;
  }
  if (claimReady) {
    const claim = find(GoldForgeTabs.CLAIM);
    if (claim !== undefined) return claim;
  }
  return find(GoldForgeTabs.SMELT) ?? tabs[0] ?? null;
}

const AMOUNT = /^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/;

/** Formatted positive amounts only, with no floating-point conversion or abbreviation guessing. */
export function isPositiveAmount(text: string | null): boolean {
  if (text === null) return false;
  const value = text.trim();
  return AMOUNT.test(value) && /[1-9]/.test(value);
}

export function heroStatusLine(ui: HeroStatusUi): HeroLine {
  const time = ui.time ?? UNKNOWN;
  switch (ui.kind) {
    case 'FORGING': return { text: 'Furnace lit · next coins in', emphasis: time, dot: 'GOLD', spoken: `Furnace lit, next coins in ${time}` };
    case 'AT_REST': {
      const text = ui.reason?.trim() ? `Forge at rest · ${ui.reason}` : 'Forge at rest';
      return { text, emphasis: null, dot: 'STONE', spoken: text.replaceAll(' · ', ', ') };
    }
    case 'RECONNECTING': return { text: 'Reconnecting to the forge…', emphasis: null, dot: 'STONE', spoken: 'Reconnecting to the forge' };
    case 'UNDER_CONSTRUCTION': return { text: 'Building ·', emphasis: time, dot: 'STONE', spoken: `Building, ${time} left` };
  }
}

type LookExtras = Partial<Pick<ForgePrimaryLook, 'sub' | 'reason' | 'icon' | 'sentence' | 'subAccent'>>;
function look(label: string, verb: Verb, state: CommandState, action: ForgeAction, extras: LookExtras = {}): ForgePrimaryLook {
  return { label, verb, state, action, sub: null, reason: null, icon: null, sentence: false, subAccent: false, ...extras };
}

/** An uncertain outcome never says nothing moved. */
export function forgeOutcomeLine(action: string, failure: MoneyFailure, serverReason: string | null = null): string {
  if (action === 'claim' && failure === 'REFUSED' && !serverReason?.trim()) return 'Wallet said no. Nothing was sent.';
  if (action === 'claim' && failure === 'UNCERTAIN') return 'Checking whether the claim went through…';
  return outcomeLine(action, failure === 'REFUSED', serverReason);
}

/** Unlike the kit's generic moneyLook, CHECK_WALLET here opens the saved recovery surface. */
function moneyStageLook(stage: MoneyStage, failure: MoneyFailure | null, sentLabel: string): ForgePrimaryLook | null {
  switch (stage) {
    case 'READY': return null;
    case 'CHECK_WALLET': return look('Check wallet', 'STONE', 'ENABLED', 'CONTINUE', { sentence: true });
    case 'SENDING': return look('Sending', 'STONE', 'BUSY', 'NONE', { sentence: true });
    case 'SENT': return look(sentLabel, 'MOSS', 'ENABLED', 'NONE', { icon: 'shape:check' });
    case 'FAILED': return failure === 'REFUSED' ? look('RETRY', 'RED', 'ENABLED', 'RETRY')
      : look('Checking…', 'STONE', 'ENABLED', 'CONTINUE', { sentence: true });
  }
}

export function smeltPrimaryLook(state: SmeltState, primary: CommandUi): ForgePrimaryLook | null {
  switch (state) {
    case 'QUALIFIED': return null;
    case 'LOADING': return look('Checking', 'STONE', 'BUSY', 'NONE', { sentence: true });
    case 'SENDING': return look('Sending', 'STONE', 'BUSY', 'NONE', { sentence: true });
    default: {
      const blocked = primary.state === 'BUSY' || primary.state === 'DISABLED' || primary.state === 'LOCKED';
      const action: ForgeAction = blocked ? 'NONE' : state === 'HELD' ? 'FIND_RAID' : state === 'ERROR' ? 'RETRY' : 'SMELT';
      const verb = primary.verb ?? 'STONE';
      return look(primary.caption, verb === 'STONE' ? 'GOLD' : verb, primary.state, action,
        { sub: primary.sub ?? null, reason: primary.reason, icon: primary.icon.trim() ? primary.icon : null });
    }
  }
}

export function smeltPrimaryCommand(state: SmeltState, items: number, payoutIn: string | null = null, reason: string | null = null): CommandUi {
  const base: CommandUi = { id: featureId('goldforge.smelt'), icon: '', caption: 'SMELT', price: null,
    primary: true, state: 'ENABLED', reason: null, badge: null, verb: 'STONE', sub: null, iconSecondary: null };
  switch (state) {
    case 'HELD': return { ...base, icon: 'attack', caption: 'FIND A RAID', verb: 'RED' };
    case 'QUALIFIED': return { ...base, icon: 'timer', caption: `PAYOUT IN ${payoutIn ?? UNKNOWN}` };
    case 'PAUSED': return { ...base, state: 'DISABLED', reason: reason ?? 'New smelting is paused' };
    case 'NOT_READY': return { ...base, state: 'LOCKED', reason: reason ?? 'Build the mining buildings first' };
    case 'ERROR': return { ...base, caption: 'TRY AGAIN' };
    case 'LOADING':
    case 'SENDING': return { ...base, state: 'BUSY' };
    case 'CHOOSING':
    case 'REVIEW': return items <= 0 ? { ...base, state: 'DISABLED', reason: reason ?? 'Tap what to smelt first' }
      : { ...base, sub: items === 1 ? '1 item' : `${items} items` };
  }
}

/** Native phase precedence is preserved; the live adapter must keep recovery reachable separately. */
export function claimPrimaryLook(ui: ClaimUi): ForgePrimaryLook {
  const phase = ui.phase ?? 'READY';
  switch (phase) {
    case 'LOADING': return look('Checking', 'STONE', 'BUSY', 'NONE', { sentence: true });
    case 'ERROR': return look('CLAIM', 'OFF', 'DISABLED', 'NONE', { sub: 'waiting for the server' });
    case 'LOCKED': return look('CLAIM', 'CHARCOAL', 'LOCKED', 'EXPLAIN_LOCK',
      { sub: ui.lock === null ? 'opens soon' : `opens ${ui.lock.date}`, subAccent: true });
  }
  const money = moneyStageLook(ui.stage, ui.failure ?? null, 'IN YOUR WALLET');
  if (money !== null) return money;
  if (ui.canResumeSaved) return look('CONTINUE CLAIM', 'GOLD', 'ENABLED', 'CONTINUE');
  if (phase === 'COLLECTED' || !isPositiveAmount(ui.ready)) return look('CLAIM', 'OFF', 'DISABLED', 'NONE',
    { reason: ui.nextCoinsIn === null ? 'Nothing to collect yet' : `Next coins in ${ui.nextCoinsIn}` });
  return look('CLAIM', 'GOLD', 'ENABLED', 'CLAIM', { sub: `${ui.ready} KEEP to your wallet` });
}

/** No primary while Gems are off; unresolved purchase stages retain native recovery semantics. */
export function gemsPrimaryLook(ui: GemsUi): ForgePrimaryLook | null {
  switch (ui.phase ?? 'READY') {
    case 'OFF': return null;
    case 'LOADING': return look('Checking', 'STONE', 'BUSY', 'NONE', { sentence: true });
    case 'ERROR': return look('RETRY', 'RED', 'ENABLED', 'RETRY');
  }
  const money = moneyStageLook(ui.stage, ui.failure ?? null, 'SENT');
  if (money !== null) return money;
  if (ui.pendingRecovery) return look('CONTINUE', 'GOLD', 'ENABLED', 'CONTINUE');
  if (ui.walletShort) return look(`BUY ${ui.amount} GEMS`, 'OFF', 'DISABLED', 'NONE', { reason: `Your wallet has ${ui.walletKeep} KEEP` });
  if (ui.amount === UNKNOWN || ui.pay === UNKNOWN) return look('Checking', 'STONE', 'BUSY', 'NONE', { sentence: true });
  return look(`BUY ${ui.amount} GEMS`, 'GOLD', 'ENABLED', 'BUY', { sub: `paid with ${ui.pay} KEEP from your wallet` });
}

export function gemSpendConfirmLabel(kind: GemSpendKind): string { return kind; }

/** Stage wins over live price. A shortfall navigates to Gems without confirming a spend. */
export function gemSpendPrimaryLook(ui: GemSpendUi): ForgePrimaryLook {
  const confirm = gemSpendConfirmLabel(ui.kind);
  if (ui.stage === 'SENDING' || ui.stage === 'CHECK_WALLET') return look('Finishing', 'STONE', 'BUSY', 'NONE', { sentence: true });
  if (ui.stage === 'SENT') return look('DONE', 'MOSS', 'ENABLED', 'NONE', { icon: 'shape:check' });
  if (ui.stage === 'FAILED' && ui.failure === 'REFUSED') return look('RETRY', 'RED', 'ENABLED', 'RETRY');
  if (ui.stage === 'FAILED') return look('Checking…', 'STONE', 'BUSY', 'NONE', { sentence: true });
  if (ui.price.status === 'CHECKING') return look('Checking', 'STONE', 'BUSY', 'NONE', { sentence: true });
  if (ui.price.status === 'UNAVAILABLE') return look(confirm, 'OFF', 'DISABLED', 'NONE',
    { reason: ui.unavailableReason ?? 'The price is unavailable right now' });
  if (ui.short !== null || ui.price.status === 'SHORT') return look('GET GEMS', 'BLUE', 'ENABLED', 'GET_GEMS', { sub: 'at the Gold Forge' });
  return look(confirm, 'GOLD', 'ENABLED', 'CONFIRM');
}

/** Arming policy only, never eligibility. Only authoritative SERVER_ZERO bypasses arming. */
export function gemSpendArms(ui: GemSpendUi): boolean { return ui.price.status !== 'SERVER_ZERO'; }

export function furnaceLabel(pool: string): string {
  switch (pool.trim().toLowerCase()) {
    case 'free': return 'Free furnace';
    case 'deed': return 'Deed furnace';
    case '': return UNKNOWN;
    default: return pool;
  }
}

export function furnaceLoadText(state: SmeltState, committed: string, basketValue: string | null, cap: string | null): LoadText {
  const choosing = state === 'CHOOSING' || state === 'REVIEW';
  const basket = choosing && isPositiveAmount(basketValue) ? `+${basketValue}` : null;
  if (cap === null) return { basket, rest: basket !== null ? ' · Uncapped today' : 'Uncapped today' };
  return basket !== null ? { basket, rest: ` of ${cap}` } : { basket: null, rest: `${committed} of ${cap}` };
}

/** Native Pair becomes a tuple. Overflow uses the final visible slot for the hidden count. */
export function heldStrip(held: readonly SmeltTileUi[], max = 3): [readonly SmeltTileUi[], number] {
  if (held.length <= max) return [held, 0];
  const shown = max - 1;
  // Kotlin List.take rejects negative counts instead of treating them as a negative slice end.
  if (shown < 0) throw new RangeError('Requested element count is less than zero.');
  return [held.slice(0, shown), held.length - shown];
}

export function smeltSealIcons(tiles: readonly SmeltTileUi[]): string[] {
  return tiles.filter(tile => tile.chosen > 0).slice(0, 2).map(tile => tile.icon);
}

export function basketCount(tiles: readonly SmeltTileUi[]): number {
  // Kotlin sumOf returns Int and wraps each addition. This is a presentation port;
  // live adapters must retain raw resource quantities as strings/BigInt separately.
  return tiles.reduce((sum, tile) => (sum + Math.max(tile.chosen, 0)) | 0, 0);
}

const SMALL_ART = new Set(['shards', 'shard', 'gem', 'keep', 'skr', 'sol', 'gf:keep_24', 'gf:gem_24', 'craft:keep_24']);
/** Icon slot sizes from the native design, not game economy values. */
export function tileIconDp(icon: string): number { return SMALL_ART.has(icon) ? 36 : 32; }

export function consentArmStart(armedAtMs: number, consentAtMs: number | null): number | null {
  return consentAtMs === null ? null : Math.max(consentAtMs, armedAtMs);
}

export function quoteArmStart(armedAtMs: number, quoteSeenAtMs: number): number {
  return Math.max(armedAtMs, quoteSeenAtMs);
}

/** ClaimTab.kt's app-name display helper. Callers must never supply a wallet address. */
export function walletTag(label: string | null): string {
  return (label?.trim().toUpperCase().replace(/ WALLET$/, '').trim()) || 'WALLET';
}
