import { describe, expect, it } from 'vitest';
import type { GemsState } from '../../../lib/gems/controller';
import { parseGemsOverview } from '../../../lib/gems/contracts';
import { identity, intent, overview, proof } from '../../../lib/gems/fixtures.test-support';
import type { GemsJournal } from '../../../lib/gems/journal';
import type { GemsBuyState } from '../../../lib/gemsBuy/controller';
import { binding, credited, disclosure, quote, request, signature } from '../../../lib/gemsBuy/fixtures.test-support';
import { parseGemsBuyDeposit, type GemsBuyDeposit } from '../../../lib/gemsBuy/contracts';
import type { GemsBuyJournal, GemsBuyPurchase } from '../../../lib/gemsBuy/journal';
import { projectGemsAdapters, type GemsAdapterInput, type GemsAdapterOwner } from './GemsAdapters';

const admitted: GemsAdapterOwner = {
  gemsObservationCurrent: true, purchaseObservationCurrent: true,
  actionsAllowed: true, ownerHandoffReady: true, freshEntryAllowed: true,
};
function ledgerJournal(update: Partial<GemsJournal> = {}): GemsJournal {
  return { version: 1, identity, revision: 0, intent: null, attempted: false, receipt: null,
    hydrated: false, finished: false, refusal: null, refusals: [], ...update };
}
function gems(update: Partial<GemsState> = {}): GemsState {
  return { loaded: true, enabled: true, busy: false, journal: ledgerJournal(),
    overview: parseGemsOverview({ ...overview(), sources: ['ledger-keep', 'wallet-keep'] }), review: null, error: null, ...update };
}
function purchase(update: Partial<GemsBuyPurchase> = {}): GemsBuyPurchase {
  return { request, binding, quote: null, prepared: null, signature: null,
    broadcastStarted: false, deposit: null, hydrated: false, ...update };
}
function paid(): GemsBuyDeposit {
  const original = quote();
  return parseGemsBuyDeposit({ ...credited(), id: original.id, kind: 'gems_buy', reference: original.reference }, original);
}
function buyJournal(saved: GemsBuyPurchase | null = null): GemsBuyJournal {
  return { version: 1, identity: { origin: 'https://game.example', api: identity.api,
    cluster: 'devnet', wallet: binding.wallet }, revision: 0, purchase: saved, archives: [] };
}
function buy(update: Partial<GemsBuyState> = {}): GemsBuyState {
  return { loaded: true, busy: false, journal: buyJournal(), error: null,
    networkFee: null, reviewed: false, ...update };
}
function input(update: Partial<GemsAdapterInput> = {}): GemsAdapterInput {
  return { gems: gems(), buy: buy(), scope: { gemsMatches: true, purchaseMatches: true }, owner: admitted, ...update };
}
const held = { walletBuy: false, ledgerKeepToGems: false, gemsToShards: false };
const prepared = { blockhash: binding.mint, lastValidBlockHeight: 100, messageFingerprint: 'a'.repeat(64) };

describe('Gold Forge Gems read-only adapters', () => {
  it('admits fresh entry from current capabilities and an observed empty purchase journal', () => {
    const result = projectGemsAdapters(input());
    expect(result.fresh).toEqual({ walletBuy: true, ledgerKeepToGems: true, gemsToShards: true });
    expect(result.purchase).toBeNull();
    expect(result.ledger).toBeNull();
    expect(result.balance).toEqual({ amount: '100', freshness: 'current' });
  });

  it('defaults fresh permission off without hiding the original in-scope request', () => {
    const saved = purchase();
    const result = projectGemsAdapters({ gems: gems(), buy: buy({ journal: buyJournal(saved) }),
      scope: { gemsMatches: true, purchaseMatches: true } });
    expect(result.fresh).toEqual(held);
    expect(result.balance).toEqual({ amount: '100', freshness: 'retained' });
    expect(result.purchase).toMatchObject({ requestKey: request.idempotencyKey, outcome: 'saved', stage: 'READY' });
  });

  it.each(['actionsAllowed', 'ownerHandoffReady', 'freshEntryAllowed'] as const)(
    'holds all fresh actions when only owner %s is missing', field => {
      expect(projectGemsAdapters(input()).fresh).toEqual({ walletBuy: true, ledgerKeepToGems: true, gemsToShards: true });
      expect(projectGemsAdapters(input({ owner: { ...admitted, [field]: false } })).fresh).toEqual(held);
    });

  it('separates current observations from in-scope retained balance and recovery', () => {
    const saved = intent();
    const result = projectGemsAdapters(input({ owner: { ...admitted, gemsObservationCurrent: false, purchaseObservationCurrent: false },
      gems: gems({ journal: ledgerJournal({ intent: saved, attempted: true }) }),
      buy: buy({ journal: buyJournal(purchase({ quote: quote(), prepared })) }) }));
    expect(result.fresh).toEqual(held);
    expect(result.balance).toEqual({ amount: '100', freshness: 'retained' });
    expect(result.ledger).toMatchObject({ requestKey: saved.idempotencyKey, outcome: 'uncertain', stage: 'SENDING' });
    expect(result.purchase).toMatchObject({ requestKey: request.idempotencyKey, outcome: 'uncertain', stage: 'SENDING' });
  });

  it.each(['gemsMatches', 'purchaseMatches'] as const)('rejects values from a different owner scope: %s', field => {
    const result = projectGemsAdapters(input({ scope: { gemsMatches: true, purchaseMatches: true, [field]: false },
      gems: gems({ journal: ledgerJournal({ intent: intent(), attempted: true }) }),
      buy: buy({ journal: buyJournal(purchase()) }) }));
    if (field === 'gemsMatches') {
      expect(result.balance).toEqual({ amount: null, freshness: 'unknown' });
      expect(result.ledger).toBeNull();
      expect(result.purchase?.requestKey).toBe(request.idempotencyKey);
    } else {
      expect(result.balance.amount).toBe('100');
      expect(result.ledger?.requestKey).toBe(intent().idempotencyKey);
      expect(result.purchase).toBeNull();
    }
    expect(result.fresh).toEqual(held);
  });

  it('keeps exact large server balances visible while disabled, busy and held', () => {
    const amount = '90071992547409931234567890123456';
    const result = projectGemsAdapters(input({ owner: { ...admitted, freshEntryAllowed: false },
      gems: gems({ enabled: false, busy: true, overview: parseGemsOverview({ ...overview(), gems: amount }) }) }));
    expect(result.balance).toEqual({ amount, freshness: 'current' });
    expect(result.fresh).toEqual(held);
  });

  it('labels a retained overview after error even when observationCurrent stayed true', () => {
    const result = projectGemsAdapters(input({ gems: gems({ error: 'Refresh failed' }) }));
    expect(result.balance).toEqual({ amount: '100', freshness: 'retained' });
    expect(result.fresh).toEqual(held);
  });

  it('does not invent zero balance when no overview exists', () => {
    const result = projectGemsAdapters(input({ gems: gems({ overview: null }) }));
    expect(result.balance).toEqual({ amount: null, freshness: 'unknown' });
    expect(result.fresh).toEqual(held);
  });

  it('requires exact consent and authoritative ledger source for fresh converters', () => {
    const current = gems();
    expect(projectGemsAdapters(input()).fresh.ledgerKeepToGems).toBe(true);
    expect(projectGemsAdapters(input({ gems: gems({ overview: { ...current.overview!, exactConsent: false } }) })).fresh)
      .toEqual({ walletBuy: true, ledgerKeepToGems: false, gemsToShards: false });
    expect(projectGemsAdapters(input({ gems: gems({ overview: { ...current.overview!, sources: ['wallet-keep'] } }) })).fresh)
      .toEqual({ walletBuy: true, ledgerKeepToGems: false, gemsToShards: true });
    expect(projectGemsAdapters(input({ gems: gems({ overview: { ...current.overview!, sources: ['ledger-keep'] } }) })).fresh.walletBuy).toBe(false);
  });

  it('requires a current loaded purchase observation for wallet entry without gating converters on it', () => {
    expect(projectGemsAdapters(input()).fresh.walletBuy).toBe(true);
    for (const state of [buy({ loaded: false, journal: null }), buy({ busy: true }), buy({ error: 'Unavailable' })]) {
      expect(projectGemsAdapters(input({ buy: state })).fresh.walletBuy).toBe(false);
    }
    expect(projectGemsAdapters(input({ owner: { ...admitted, purchaseObservationCurrent: false } })).fresh)
      .toEqual({ walletBuy: false, ledgerKeepToGems: true, gemsToShards: true });
  });

  it('preserves original ledger amounts and keys without converting them to numbers', () => {
    const saved = { kind: 'gems-from-keep' as const, keep: '90071992547409931234567890', idempotencyKey: 'Original-Key.Exact-Case' };
    const result = projectGemsAdapters(input({ gems: gems({ journal: ledgerJournal({ intent: saved }) }) }));
    expect(result.ledger).toMatchObject({ requestKey: saved.idempotencyKey, inputAmount: saved.keep, outcome: 'saved', stage: 'READY', receipt: null });
    expect(result.fresh.ledgerKeepToGems).toBe(false);
    expect(result.fresh.gemsToShards).toBe(false);
  });

  it.each(['gems-from-keep', 'gems-to-shards', 'gems-task-claim'] as const)(
    'uses only the matching accepted receipt for SENT: %s', kind => {
      const saved = intent(kind);
      const result = projectGemsAdapters(input({ owner: { ...admitted, freshEntryAllowed: false },
        gems: gems({ enabled: false, busy: true, error: 'Hydration pending',
          journal: ledgerJournal({ intent: saved, attempted: true, receipt: proof(saved) }) }) }));
      expect(result.ledger).toMatchObject({ requestKey: saved.idempotencyKey, outcome: 'credited', stage: 'SENT', hydrated: false, finished: false,
        receipt: { amount: kind === 'gems-task-claim' ? '10' : '20', currency: kind === 'gems-to-shards' ? 'SHARDS' : 'GEMS' } });
      expect(result.fresh).toEqual(held);
    });

  it('keeps attempted ledger requests uncertain after a mismatched receipt', () => {
    const saved = intent();
    const wrong = proof({ ...saved, idempotencyKey: 'different-original-key' });
    const result = projectGemsAdapters(input({ gems: gems({ journal: ledgerJournal({ intent: saved, attempted: true, receipt: wrong }) }) }));
    expect(result.ledger).toMatchObject({ requestKey: saved.idempotencyKey, outcome: 'uncertain', stage: 'SENDING', receipt: null });
    expect(result.fresh.ledgerKeepToGems).toBe(false);
  });

  it('distinguishes a definitive typed ledger refusal from unknown transport failure', () => {
    const saved = intent();
    const result = projectGemsAdapters(input({ gems: gems({ journal: ledgerJournal({ intent: saved, attempted: true,
      finished: true, refusal: { status: 422, code: 'INSUFFICIENT_KEEP' } }) }) }));
    expect(result.ledger).toMatchObject({ requestKey: saved.idempotencyKey, outcome: 'refused', stage: 'FAILED', receipt: null });
    expect(result.fresh.ledgerKeepToGems).toBe(true);
    expect(projectGemsAdapters(input({ gems: gems({ error: 'Timeout', journal: ledgerJournal({ intent: saved, attempted: true }) }) })).ledger)
      .toMatchObject({ outcome: 'uncertain', stage: 'SENDING' });
  });

  it.each([
    { name: 'saved request', saved: purchase(), outcome: 'saved', stage: 'READY' },
    { name: 'quote', saved: purchase({ quote: quote() }), outcome: 'saved', stage: 'READY' },
    { name: 'prepared', saved: purchase({ quote: quote(), prepared }), outcome: 'uncertain', stage: 'SENDING' },
    { name: 'signature', saved: purchase({ quote: quote(), prepared, signature: signature(2) }), outcome: 'uncertain', stage: 'SENDING' },
    { name: 'broadcast', saved: purchase({ quote: quote(), prepared, signature: signature(2), broadcastStarted: true }), outcome: 'uncertain', stage: 'SENDING' },
  ])('never calls $name a credited purchase', ({ saved, outcome, stage }) => {
    const result = projectGemsAdapters(input({ buy: buy({ journal: buyJournal(saved) }) }));
    expect(result.purchase).toMatchObject({ requestKey: request.idempotencyKey, keepIn: '10', outcome, stage, receipt: null });
    expect(result.fresh.walletBuy).toBe(false);
  });

  it('retains observed payment evidence without turning it into a receipt', () => {
    const deposit: GemsBuyDeposit = { ...disclosure(), status: 'finalized', amount: '12000007', dustBaseUnits: '7',
      txSignature: signature(1), finalizedAt: '2026-09-21T10:00:00.000Z' };
    const result = projectGemsAdapters(input({ buy: buy({ error: 'Receipt pending', journal: buyJournal(purchase({ quote: quote(), deposit })) }) }));
    expect(result.purchase).toMatchObject({ requestKey: request.idempotencyKey, outcome: 'uncertain', stage: 'SENDING', receipt: null });
  });

  it('shows the actual credited amount even when it differs from the quote and hydration is pending', () => {
    const result = projectGemsAdapters(input({ owner: { ...admitted, freshEntryAllowed: false }, gems: gems({ enabled: false }),
      buy: buy({ busy: true, error: 'Hydration pending', journal: buyJournal(purchase({ quote: quote(), deposit: paid() })) }) }));
    expect(result.purchase).toMatchObject({ requestKey: request.idempotencyKey, keepIn: '10', quotedGems: '10',
      outcome: 'credited', stage: 'SENT', hydrated: false, receipt: { amount: '12', currency: 'GEMS' } });
    expect(result.fresh).toEqual(held);
  });

  it('rejects mismatched purchase credit evidence without losing the original recovery key', () => {
    const valid = paid();
    const deposit: GemsBuyDeposit = { ...valid, receipt: { ...valid.receipt!, depositId: '00000000-0000-4000-8000-000000000099' } };
    const result = projectGemsAdapters(input({ buy: buy({ journal: buyJournal(purchase({ quote: quote(), deposit })) }) }));
    expect(result.purchase).toMatchObject({ requestKey: request.idempotencyKey, outcome: 'uncertain', stage: 'SENDING', receipt: null });
    expect(result.fresh.walletBuy).toBe(false);
  });

  it('does not expose wallet, signature, funding addresses or mutable transport objects', () => {
    const source = input({ buy: buy({ journal: buyJournal(purchase({ quote: quote(), deposit: paid() })) }) });
    const before = JSON.stringify(source);
    const result = projectGemsAdapters(source);
    expect(JSON.stringify(source)).toBe(before);
    expect(Object.keys(result.purchase ?? {}).sort()).toEqual(['hydrated', 'keepIn', 'outcome', 'quotedGems', 'receipt', 'requestKey', 'stage']);
    expect(Object.keys(result.purchase?.receipt ?? {}).sort()).toEqual(['acceptedAt', 'amount', 'currency', 'receiptId']);
    expect(JSON.stringify(result)).not.toContain(binding.wallet);
    expect(JSON.stringify(result)).not.toContain(quote().destination);
  });
});
