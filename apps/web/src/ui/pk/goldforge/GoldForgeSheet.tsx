/**
 * Controlled Gold Forge body only. The existing session owners provide projections,
 * admission and handoffs; this component has no controller, journal, transport or Seal.
 * Host placement, resource stack, lazy registry and shared consent remain their owners'.
 */
import { useState, type ReactNode } from 'react';
import type { MiningContributionLine, MiningContributionResource } from '@shardkeep/shared/miningContribution';
import type { MiningContributionView } from '@shardkeep/shared/miningContributionApi';
import { PkBadge, PkMoneyButton, PkPrimaryButton, PkSecondaryButton } from '../Button';
import { PkIcon } from '../Icon';
import { PkPlate, PkPlateFrame } from '../Plate';
import { exactAmount, UNKNOWN } from '../kitLogic';
import type { CommandState } from '../types';
import { goldForgeDefaultTab, goldForgeTabs, heroStatusLine, isPositiveAmount } from './GoldForgeLogic';
import type { HeroStatusUi } from './goldForgeModel';
import type { MiningClaimProjection } from './ClaimAdapters';
import type { GemsAdapterProjection } from './GemsAdapters';
import { smeltBasket, smeltMaximum, type SmeltProjection } from './SmeltAdapter';
import './GoldForgeSheet.css';

export type GoldForgeTab = 'SMELT' | 'CLAIM' | 'GEMS' | 'LEGACY';
export type GoldForgeIntent =
  | { kind: 'claim'; amountBaseUnits: string; observedAt: string | null }
  | { kind: 'smelt'; baseId: string; day: string; lines: readonly MiningContributionLine[] }
  | { kind: 'walletBuy'; keepIn: string; gemsOut: string }
  | { kind: 'ledgerKeepToGems' }
  | { kind: 'gemsToShards' };
export type GoldForgeRecovery = 'claim' | 'smelt' | 'gems-purchase' | 'gems-ledger';
export interface GoldForgeOwner {
  /** Cheap, pure live scope read, including account/base/cluster/epoch. Never a captured `true`. */
  scopeCurrent?: () => boolean;
  /** Read live admission for this exact input/quote. Opening the owner's flow is all this permits. */
  canStart?: (intent: GoldForgeIntent) => boolean;
  onStart?: (intent: GoldForgeIntent) => void;
  /** Separate from fresh admission. Recheck the original key against the live journal. */
  canRecover?: (kind: GoldForgeRecovery, requestKey: string | null) => boolean;
  onRecover?: (kind: GoldForgeRecovery, requestKey: string | null) => void;
}
export interface GoldForgeSmelt {
  projection: SmeltProjection;
  /** The same owner-observed view used to produce projection, not a second read. */
  view: MiningContributionView | null;
  lines: readonly MiningContributionLine[];
  /** Admitted owner order (Ingots, Shards, refined, raw); unlisted resources stay visible. */
  resourceOrder?: readonly MiningContributionResource[];
  /** Existing owner resource catalog, including its exact icon names and source text. */
  labels: Partial<Record<MiningContributionResource, { name: string; icon: string; source: string }>>;
  /** Local draft editing only. The existing owner must discard edits when scope changes. */
  onLinesChange?: (lines: readonly MiningContributionLine[]) => void;
}
export interface GoldForgeBuyQuote {
  /** Owner has checked input, quote, bounds, balance and scope. */
  current: boolean;
  keepIn: string | null;
  gemsOut: string | null;
  rateLabel: string | null;
  minimumKeep: string | null;
  maximumKeep: string | null;
  walletAfter: string | null;
  quick: readonly string[];
  /** Local amount selection only; it must never buy or auto-confirm. */
  onAmountChange?: (keepIn: string) => void;
}
/** Future controlled projection only. Production must omit until its existing owner is admitted. */
export interface GoldForgeLegacy {
  visible: boolean;
  saved: string | null;
  current: boolean;
  /** Authoritative owner copy; no assumed conversion rate or date. */
  conversionCopy: string | null;
  historySummary: string | null;
  onHistory?: () => void;
}
export interface GoldForgeSheetProps {
  /** Current render scope witness. Missing/false hides previous identity data. */
  scopeMatches?: boolean;
  tab?: GoldForgeTab | null;
  onTab: (tab: GoldForgeTab) => void;
  level?: string | null;
  /** Existing current-tier building atlas alias, e.g. ui_portrait_goldforge_t2. */
  heroIcon?: string | null;
  heroStatus?: HeroStatusUi;
  onClose?: () => void;
  onHistory?: () => void;
  onDestinationDetails?: () => void;
  owner?: GoldForgeOwner;
  smelt?: GoldForgeSmelt | null;
  claim?: MiningClaimProjection | null;
  gems?: GemsAdapterProjection | null;
  buy?: GoldForgeBuyQuote | null;
  legacy?: GoldForgeLegacy | null;
}

const integer = (value: string | null | undefined): bigint | null =>
  value != null && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;
const display = (value: string | null | undefined): string => value?.trim() || UNKNOWN;
/** Group every whole-unit readout without changing raw inputs used by owner intents. */
const wholeAmount = (value: string | null | undefined): string => exactAmount(value ?? null);
/** Admission can disappear during an owner handoff. A failed read grants nothing. */
function admitted(read: () => boolean): boolean {
  try { return read() === true; } catch { return false; }
}
const validBuy = (quote: GoldForgeBuyQuote | null): boolean => {
  if (!quote?.current) return false;
  const value = integer(quote.keepIn), min = integer(quote.minimumKeep), max = integer(quote.maximumKeep), out = integer(quote.gemsOut);
  return value !== null && value > 0n && min !== null && max !== null && value >= min && value <= max && out !== null && out > 0n;
};
/** Bounded visual fraction only. Money/resource amounts never pass through Number. */
function fill(value: string | null, cap: string | null): number {
  const numerator = integer(value), denominator = integer(cap);
  if (numerator === null || denominator === null || denominator <= 0n) return 0;
  const hundredths = numerator * 10_000n / denominator;
  return Number(hundredths > 10_000n ? 10_000n : hundredths) / 100;
}
function Card({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return <PkPlate kind="CREAM" className="pk-goldforge__card"><h3 className="pk-t-label">{title}</h3>{children}</PkPlate>;
}

export function GoldForgeSheet(props: GoldForgeSheetProps): React.JSX.Element {
  const [pickerNotice, setPickerNotice] = useState<string | null>(null);
  const owner = props.owner;
  // A supplied live witness wins over an older render snapshot. Without that
  // callback, explicitly admitted read-only projections remain visible.
  const scoped = props.scopeMatches === true && admitted(() =>
    owner?.scopeCurrent === undefined || owner.scopeCurrent() === true);
  const smelt = scoped ? props.smelt ?? null : null;
  const claim = scoped ? props.claim ?? null : null;
  const gems = scoped ? props.gems ?? null : null;
  const quote = scoped ? props.buy ?? null : null;
  const legacy = scoped && props.legacy?.visible === true ? props.legacy : null;
  const claimReady = claim?.current === true && claim.status === 'ready' && isPositiveAmount(claim.amountBaseUnits);
  const purchase = gems?.purchase ?? null;
  const ledger = gems?.ledger ?? null;
  // These projections contain bound terminal evidence, not inferred active-wallet state.
  const claimPaid = claim?.stage === 'SENT' && integer(claim.paidBaseUnits) !== null;
  const purchasePaid = purchase?.outcome === 'credited' && purchase.stage === 'SENT' && purchase.receipt !== null;
  const tabs = goldForgeTabs(claimReady, purchase && purchase.outcome !== 'credited' ? 1 : 0, legacy !== null)
    .map(item => item.id === 'GEMS' && item.badge
      ? { ...item, badge: { ...item.badge, description: 'A saved Gems purchase needs checking' } } : item);
  // Round-2 LEGACY requires this explicit fallback, separate from the native pure port.
  const requested = props.tab === 'LEGACY' && !legacy ? 'CLAIM' : props.tab ?? null;
  const tab = goldForgeDefaultTab(requested, tabs.map(item => item.id), claimReady) as GoldForgeTab;
  const hero = heroStatusLine(scoped && props.heroStatus ? props.heroStatus : { kind: 'RECONNECTING' });
  const liveScope = () => scoped && admitted(() => owner?.scopeCurrent?.() === true);
  const canStart = (intent: GoldForgeIntent | null, projectionAllows: boolean): boolean =>
    intent !== null && projectionAllows && !!owner?.onStart && liveScope() && admitted(() => owner?.canStart?.(intent) === true);
  const canRecover = (kind: GoldForgeRecovery, key: string | null, projectionAllows = true): boolean =>
    projectionAllows && !!owner?.onRecover && liveScope() && admitted(() => owner?.canRecover?.(kind, key) === true);
  const start = (intent: GoldForgeIntent | null, projectionAllows: boolean) => {
    if (intent && canStart(intent, projectionAllows)) owner?.onStart?.(intent);
  };
  const recover = (kind: GoldForgeRecovery, key: string | null, projectionAllows = true) => {
    if (canRecover(kind, key, projectionAllows)) owner?.onRecover?.(kind, key);
  };
  const claimIntent: GoldForgeIntent | null = claim?.amountBaseUnits ? {
    kind: 'claim', amountBaseUnits: claim.amountBaseUnits, observedAt: claim.observedAt,
  } : null;
  const buyIntent: GoldForgeIntent | null = quote?.keepIn && quote.gemsOut ? {
    kind: 'walletBuy', keepIn: quote.keepIn, gemsOut: quote.gemsOut,
  } : null;
  const smeltIntent: GoldForgeIntent | null = smelt?.view ? {
    kind: 'smelt', baseId: smelt.view.baseId, day: smelt.view.day, lines: smelt.lines,
  } : null;
  const canClaim = canStart(claimIntent, claim?.canOpenNewFlow === true);
  const canBuy = canStart(buyIntent, gems?.fresh.walletBuy === true && validBuy(quote));
  // One observation supplies the count, value and admission for this exact draft.
  const basket = smeltBasket(smelt?.view ?? null, smelt?.lines ?? []);
  const canSmelt = canStart(smeltIntent, smelt?.projection.canReviewNew === true && basket.valid);
  const canEditBasket = !!smelt?.onLinesChange && !!smelt.view && smelt.projection.freshness === 'current'
    && !smelt.projection.original && liveScope();

  function editBasket(resourceId: MiningContributionResource, operation: 'add' | 'remove' | 'max'): void {
    if (!canEditBasket || !smelt?.view || !liveScope()) return;
    const currentLine = smelt.lines.find(line => line.resourceId === resourceId);
    const current = integer(currentLine?.quantity ?? '0');
    if (current === null) { setPickerNotice('Check the basket quantities.'); return; }
    // Reducing a local draft must remain possible when another line or current stock
    // has become invalid. Only increasing/MAX needs the entire prospective basket.
    const maximum = operation === 'remove' ? null : integer(smeltMaximum(smelt.view, smelt.lines, resourceId));
    if (operation !== 'remove' && maximum === null) { setPickerNotice('Check the basket quantities.'); return; }
    const quantity = operation === 'max' ? maximum! : operation === 'remove' ? current > 0n ? current - 1n : 0n : current + 1n;
    const next = smelt.lines.filter(line => line.resourceId !== resourceId);
    if (quantity > 0n) next.push({ resourceId, quantity: String(quantity) });
    if (operation !== 'remove') {
      const result = next.length ? smeltBasket(smelt.view, next) : { valid: true, reason: null };
      if (!result.valid) { setPickerNotice(result.reason ?? 'Check the basket quantities.'); return; }
    }
    setPickerNotice(null);
    smelt.onLinesChange?.(next);
  }
  function editBuy(value: string): void {
    if (!quote?.onAmountChange || !quote.current || gems?.fresh.walletBuy !== true || !liveScope()) return;
    const amount = integer(value), min = integer(quote.minimumKeep), max = integer(quote.maximumKeep);
    if (amount !== null && min !== null && max !== null && amount >= min && amount <= max) quote.onAmountChange(value);
  }
  const editableBuy = !!quote?.current && !!quote.onAmountChange && gems?.fresh.walletBuy === true && liveScope();
  const keepIn = integer(quote?.keepIn);
  const quoteStep = (direction: -1 | 1) => {
    if (keepIn !== null) editBuy(String(keepIn + BigInt(direction)));
  };
  const claimRecoverable = claim?.recovery.available === true;
  const claimRecoveryEnabled = canRecover('claim', claim?.recovery.requestKey ?? null, claim?.recovery.canOpen === true);
  const historyAllowed = !!props.onHistory && liveScope();
  const pickerResources = smelt ? [
    ...smelt.projection.resources,
    ...smelt.lines.filter(line => !smelt.projection.resources.some(resource => resource.resourceId === line.resourceId))
      .map(line => ({ resourceId: line.resourceId, available: null, unitValue: null })),
  ].filter(resource => (integer(resource.available) ?? 0n) > 0n
    || smelt.lines.some(line => line.resourceId === resource.resourceId && (integer(line.quantity) ?? 0n) > 0n))
    .sort((left, right) => {
      const a = smelt.resourceOrder?.indexOf(left.resourceId) ?? -1;
      const b = smelt.resourceOrder?.indexOf(right.resourceId) ?? -1;
      return a < 0 ? b < 0 ? 0 : 1 : b < 0 ? -1 : a - b;
    }) : [];

  let footer: ReactNode = null;
  if (tab === 'SMELT') {
    const original = smelt?.projection.original;
    footer = <>
      <div className="pk-goldforge__action-row">
        <PkPlate kind="CREAM" className="pk-goldforge__basket-worth"><span className="pk-t-small">Basket worth</span>
          <strong className="pk-t-label" data-basket-worth>{wholeAmount(original ? original.value : basket.value)}</strong></PkPlate>
        {original ? <PkPrimaryButton label="OPEN SAVED BASKET" state={canRecover('smelt', original.requestKey) ? 'ENABLED' : 'DISABLED'}
          onClick={() => recover('smelt', original.requestKey)} />
          : <PkPrimaryButton label="SMELT" sub={canSmelt ? `${wholeAmount(basket.count)} ${basket.count === '1' ? 'item' : 'items'}` : null}
            state={canSmelt ? 'ENABLED' : 'DISABLED'} reason={canSmelt ? null : basket.reason}
            onClick={() => start(smeltIntent, canSmelt)} />}
      </div>
      <p className="pk-t-small pk-goldforge__footnote">Review the basket and its full terms before it enters the furnace.</p>
    </>;
  } else if (tab === 'CLAIM') {
    const state: CommandState = canClaim ? 'ENABLED' : claim?.status === 'unavailable' || claim?.status === 'delayed' ? 'LOCKED' : 'DISABLED';
    footer = <>
      {claimPaid ? <PkMoneyButton stage="SENT" label="CLAIM" onClick={() => {}} />
        : claimRecoverable ? <PkPrimaryButton label="CONTINUE CLAIM" state={claimRecoveryEnabled ? 'ENABLED' : 'DISABLED'}
        onClick={() => recover('claim', claim?.recovery.requestKey ?? null, claim?.recovery.canOpen === true)} />
        : <PkPrimaryButton label="CLAIM" sub={canClaim ? `${claim?.amountLabel} KEEP to your wallet` : null}
          state={state} reason={canClaim ? null : claim?.displayMessage ?? null}
          onClick={() => start(claimIntent, canClaim)} />}
      <p className="pk-t-small pk-goldforge__footnote">Coins go straight to your wallet.</p>
    </>;
  } else if (tab === 'GEMS') {
    footer = <>
      {purchasePaid ? <PkMoneyButton stage="SENT" label="BUY" onClick={() => {}} />
        : purchase ? <PkPrimaryButton label="CONTINUE PURCHASE" state={canRecover('gems-purchase', purchase.requestKey) ? 'ENABLED' : 'DISABLED'}
        onClick={() => recover('gems-purchase', purchase.requestKey)} />
        : <PkPrimaryButton label={`BUY ${wholeAmount(quote?.gemsOut)} GEMS`} sub={canBuy ? `Paid with ${wholeAmount(quote?.keepIn)} KEEP` : null}
          state={canBuy ? 'ENABLED' : 'DISABLED'} reason={null}
          onClick={() => start(buyIntent, canBuy)} />}
      <p className="pk-t-small pk-goldforge__footnote">Gems stay in the game.</p>
    </>;
  }

  return <PkPlateFrame ui={{ title: 'GOLD FORGE', titleTag: scoped ? props.level ?? null : null, history: historyAllowed }}
    {...(props.onClose ? { onClose: props.onClose } : {})} {...(historyAllowed ? { onHistory: () => { if (liveScope()) props.onHistory?.(); } } : {})}
    footer={footer} className={`pk-goldforge pk-goldforge--${tab.toLowerCase()}`} label="Gold Forge">
    <div className="pk-goldforge__hero" aria-label="Gold Forge building">
      <PkIcon name={scoped ? props.heroIcon ?? 'shape:hammer' : 'shape:hammer'} size={160} className="pk-goldforge__building" />
      <PkPlate kind="VEIL" className="pk-goldforge__hero-status"><span className="pk-t-body">{hero.text} {hero.emphasis ?? ''}</span></PkPlate>
    </div>
    <div role="tablist" aria-label="Gold Forge sections" className="pk-goldforge__tabs">
      {tabs.map(item => <button key={item.id} type="button" role="tab" className="pk-goldforge__tab interactive pk-focusable"
        aria-label={item.label} aria-selected={tab === item.id} aria-controls={`goldforge-${item.id.toLowerCase()}`}
        id={`goldforge-tab-${item.id.toLowerCase()}`} onClick={() => props.onTab(item.id as GoldForgeTab)}>
        <PkIcon name={item.icon} size={24} /><span className="pk-t-caption">{item.label}</span>
        {item.badge ? <PkBadge ui={item.badge} /> : null}
      </button>)}
    </div>
    <div role="tabpanel" id={`goldforge-${tab.toLowerCase()}`} aria-labelledby={`goldforge-tab-${tab.toLowerCase()}`}
      className="pk-goldforge__content">
      {tab === 'SMELT' ? <>
        <div className="pk-goldforge__row"><h2 className="pk-t-label">TODAY'S MELT</h2>
          <span className="pk-t-small">{smelt?.projection.pool === 'free' ? 'Free furnace' : smelt?.projection.pool === 'deed' ? 'Deed furnace' : UNKNOWN} · {display(smelt?.projection.day)}</span></div>
        <div className="pk-goldforge__row pk-t-body"><span>Furnace load</span><span>{wholeAmount(smelt?.projection.committed)} · {smelt?.projection.cap.kind === 'uncapped'
          ? 'Uncapped today' : `of ${wholeAmount(smelt?.projection.cap.amount)}`}</span></div>
        <div className="pk-goldforge__load" aria-hidden="true"><span style={{ width: `${fill(smelt?.projection.committed ?? null, smelt?.projection.cap.amount ?? null)}%` }} /></div>
        <p className="pk-t-body">{smelt?.projection.message ?? 'Checking the furnace…'}</p>
        {smelt?.projection.original ? <Card title="SAVED BASKET">
          <p className="pk-t-body">{smelt.projection.original.outcome === 'held' ? 'Your share is set at payout.' : 'Its original record stays with this basket.'}</p>
          <ul className="pk-goldforge__saved-lines">{smelt.projection.original.lines.map(line => <li key={line.resourceId} className="pk-t-body">
            {display(smelt.labels[line.resourceId]?.name)} · {wholeAmount(line.quantity)}</li>)}</ul>
        </Card> : <>
          <h3 className="pk-t-label">CHOOSE WHAT TO SMELT</h3>
          <p className="pk-t-small">Add one item or choose MAX for as much as fits.</p>
          <div className="pk-goldforge__picker">{pickerResources.map(resource => {
            const metadata = smelt?.labels[resource.resourceId];
            const name = metadata?.name ?? 'Resource';
            const chosen = smelt?.lines.find(line => line.resourceId === resource.resourceId)?.quantity ?? '0';
            return <div className="pk-goldforge__resource" key={resource.resourceId}>
              <PkPlate kind="CREAM" className="pk-goldforge__tile"><PkIcon name={metadata?.icon ?? 'shape:unknown'} size={32} />
                <strong className="pk-t-small">{name}</strong><span className="pk-t-small">Have {wholeAmount(resource.available)}</span>
                <span className="pk-t-label">+{wholeAmount(chosen)}</span></PkPlate>
              <PkSecondaryButton label="+ 1" contentDescription={`${name}: add 1`} enabled={canEditBasket} onClick={() => editBasket(resource.resourceId, 'add')} />
              <PkSecondaryButton label="− 1" contentDescription={`${name}: remove 1`} enabled={canEditBasket && (integer(chosen) ?? 0n) > 0n} onClick={() => editBasket(resource.resourceId, 'remove')} />
              <PkSecondaryButton label="MAX" contentDescription={`MAX ${name}`} enabled={canEditBasket} onClick={() => editBasket(resource.resourceId, 'max')} />
              <span className="pk-t-small">Worth {wholeAmount(resource.unitValue)} each</span>
              {metadata?.source ? <span className="pk-t-small">{metadata.source}</span> : null}
            </div>;
          })}</div>
          <p className="pk-t-small">Raid on more days for a bigger share.</p>
        </>}
        {smelt?.projection.history.map(original => <Card key={original.requestKey} title={`BASKET FROM ${original.day}`}>
          <p className="pk-t-body">{original.outcome === 'held' ? 'Your basket is held in the furnace.'
            : original.outcome === 'consumed' ? 'This basket melted. Check CLAIM for any coins ready for you.'
              : original.outcome === 'returned' ? 'This basket came back unused.' : 'Check this saved basket.'}</p>
          <PkSecondaryButton label={`OPEN BASKET FROM ${original.day}`} enabled={canRecover('smelt', original.requestKey)}
            onClick={() => recover('smelt', original.requestKey)} />
        </Card>)}
        <div role="status" className="pk-t-body pk-goldforge__notice">{pickerNotice}</div>
      </> : null}
      {tab === 'CLAIM' ? <>
        <PkPlate kind="CHARCOAL" className="pk-goldforge__claim-well"><PkIcon name="keep" size={96} alpha={claimReady ? 1 : 0.5} />
          <strong className="pk-goldforge__claim-number pk-ol2" data-claim-amount>{display(claim?.amountLabel)}</strong>
          <p className="pk-t-body">KEEP minted for you</p>
          <p className="pk-t-body">{claim?.displayMessage ?? 'Checking your coins…'}</p>
        </PkPlate>
        {claim && !claim.current && claim.amountBaseUnits !== null ? <p className="pk-t-small">Last known coins. Check again for the current amount.</p> : null}
        {claimPaid && claim ? <Card title="SAVED COLLECTION"><p className="pk-t-body">Saved receipt: {claim.paidLabel} KEEP</p>
          {claimRecoverable ? <PkSecondaryButton label="OPEN SAVED COLLECTION" enabled={claimRecoveryEnabled}
            onClick={() => recover('claim', claim.recovery.requestKey, claim.recovery.canOpen)} /> : null}</Card> : null}
        {claimRecoverable && !claimPaid ? <Card title="SAVED COLLECTION"><p className="pk-t-body">Your original collection stays available here.</p></Card> : null}
        {props.onDestinationDetails ? <PkSecondaryButton label="To your wallet" onClick={() => { if (liveScope()) props.onDestinationDetails?.(); }} enabled={scoped} />
          : <Card title="To your wallet"><p className="pk-t-small">History keeps your past collections.</p></Card>}
        <PkSecondaryButton label="SMELT TODAY" onClick={() => props.onTab('SMELT')} />
      </> : null}
      {tab === 'GEMS' ? <>
        <Card title="Gems balance"><div className="pk-goldforge__balance"><PkIcon name="gem" size={32} /><strong className="pk-t-label" data-gems-balance>{wholeAmount(gems?.balance.amount)}</strong></div>
          {gems?.balance.freshness === 'retained' ? <span className="pk-t-small">Last known Gems balance</span> : null}</Card>
        {purchase ? <Card title="SAVED PURCHASE"><p className="pk-t-body">{purchase.outcome === 'credited' ? 'Your saved purchase has a receipt.'
          : purchase.outcome === 'uncertain' ? 'Check whether your saved purchase reached the forge.' : purchase.outcome === 'refused' ? 'Your saved purchase was declined.' : 'Your saved purchase is ready to review.'}</p>
          {purchase.receipt ? <p className="pk-t-body">Saved receipt: {wholeAmount(purchase.receipt.amount)} {purchase.receipt.currency}</p> : null}
          {purchasePaid ? <PkSecondaryButton label="OPEN SAVED PURCHASE" enabled={canRecover('gems-purchase', purchase.requestKey)}
            onClick={() => recover('gems-purchase', purchase.requestKey)} /> : null}</Card> : null}
        {ledger ? <Card title="SAVED EXCHANGE"><p className="pk-t-body">{ledger.outcome === 'credited' ? 'Your saved exchange has a receipt.' : 'Your original exchange stays available here.'}</p>
          {ledger.receipt ? <p className="pk-t-body">Saved receipt: {wholeAmount(ledger.receipt.amount)} {ledger.receipt.currency}</p> : null}
          <PkSecondaryButton label="CHECK SAVED EXCHANGE" enabled={canRecover('gems-ledger', ledger.requestKey)} onClick={() => recover('gems-ledger', ledger.requestKey)} /></Card> : null}
        <h2 className="pk-t-label">BUY GEMS</h2>
        {quote && !quote.current ? <p className="pk-t-small">Last known offer. Check again before buying.</p> : null}
        {quote?.rateLabel ? <span className="pk-t-small">{quote.rateLabel}</span> : null}
        <p className="pk-t-body">Gems finish timers and buy supplies. They stay in the game.</p>
        <PkPlate kind="CHARCOAL" className="pk-goldforge__pay-get"><div><PkIcon name="keep" size={48} /><strong className="pk-t-label">{wholeAmount(quote?.keepIn)} KEEP</strong><span className="pk-t-small">KEEP you pay</span></div>
          <span aria-hidden="true" className="pk-t-title">→</span><div><PkIcon name="gem" size={48} /><strong className="pk-t-label">{wholeAmount(quote?.gemsOut)} GEMS</strong><span className="pk-t-small">Gems you get</span></div></PkPlate>
        <div className="pk-goldforge__stepper"><PkSecondaryButton label="−" contentDescription="Decrease KEEP amount" enabled={editableBuy} onClick={() => quoteStep(-1)} />
          <PkPlate kind="CREAM"><strong className="pk-t-label">{wholeAmount(quote?.keepIn)}</strong><span className="pk-t-small">KEEP</span></PkPlate>
          <PkSecondaryButton label="+" contentDescription="Increase KEEP amount" enabled={editableBuy} onClick={() => quoteStep(1)} /></div>
        <div className="pk-goldforge__quick">{quote?.quick.map(amount => <PkSecondaryButton key={amount} label={wholeAmount(amount)} contentDescription={`Choose ${wholeAmount(amount)} KEEP`}
          enabled={editableBuy} onClick={() => editBuy(amount)} />)}
          {quote?.maximumKeep != null ? <PkSecondaryButton label="MAX" contentDescription={`Choose maximum ${wholeAmount(quote.maximumKeep)} KEEP`} enabled={editableBuy} onClick={() => editBuy(quote.maximumKeep!)} /> : null}</div>
        <div className="pk-goldforge__row pk-t-body"><span>Left in your wallet after</span><span>{wholeAmount(quote?.walletAfter)} KEEP</span></div>
        <div className="pk-goldforge__row"><span className="pk-t-body">Need Shards?</span><PkSecondaryButton label="CONVERT" enabled={canStart({ kind: 'gemsToShards' }, gems?.fresh.gemsToShards === true)}
          onClick={() => start({ kind: 'gemsToShards' }, !!gems?.fresh.gemsToShards)} /></div>
        <PkSecondaryButton label="KEEP INTO GEMS" enabled={canStart({ kind: 'ledgerKeepToGems' }, gems?.fresh.ledgerKeepToGems === true)}
          onClick={() => start({ kind: 'ledgerKeepToGems' }, !!gems?.fresh.ledgerKeepToGems)} />
      </> : null}
      {tab === 'LEGACY' && legacy ? <>
        <PkPlate kind="CHARCOAL" className="pk-goldforge__legacy-well"><PkIcon name="shape:chest" size={64} /><span className="pk-t-body">SAVED IN THE FORGE</span>
          <strong className="pk-t-title" data-legacy-saved>{wholeAmount(legacy.saved)}</strong><span className="pk-t-small">from before the update</span></PkPlate>
        {!legacy.current && legacy.saved !== null ? <p className="pk-t-small">Last known saved amount</p> : null}
        {legacy.conversionCopy ? <Card title="WHAT HAPPENS"><p className="pk-t-body">{legacy.conversionCopy}</p></Card> : null}
        {legacy.historySummary ? <Card title="ON THEIR WAY TO YOUR WALLET"><p className="pk-t-body">{legacy.historySummary}</p>
          {legacy.onHistory ? <PkSecondaryButton label="PAST WITHDRAWALS" onClick={() => { if (liveScope()) legacy.onHistory?.(); }} /> : null}</Card> : null}
      </> : null}
    </div>
  </PkPlateFrame>;
}
