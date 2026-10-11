import { describe, expect, it } from 'vitest';
import { CAPS } from './constants';
import { BasePurchaseEnergyQuerySchema, BasePurchaseCancellationSchema, BasePurchaseQuoteSchema, BasePurchaseRequestSchema, BasePurchaseShieldQuerySchema, BasePurchaseStateSchema, BasePurchaseStatusSchema } from './basePurchases';

const key = 'ab123456-1234-4123-8123-123456789abc';
const depositId = 'bc123456-1234-4123-8123-123456789abc';
const wallet = '1'.repeat(32);
const request = { idempotencyKey: key, baseId: depositId, kind: 'builder' as const, expectedBuilders: 1 };
const quote = { version: 1, depositId, wallet, request, baseEpoch: { landPaidAt: '2034-01-01T00:00:00.000Z', deedAssetId: null },
  reference: '2'.repeat(32), amountLamports: '100', quotedCostShards: null,
  rail: { cluster: 'devnet', coreProgram: wallet, configPda: wallet, treasuryLiquidity: wallet, treasuryDev: wallet, treasuryOps: wallet,
    systemProgram: wallet, mode: 'buy_sink', sinkKind: 8, destination: null },
  createdAt: '2034-01-01T00:00:00.000Z', payableUntil: '2034-01-01T00:03:00.000Z', retryAt: '2034-01-01T00:05:00.000Z' };
const pending = { quote, status: 'pending', paymentSignature: null, txSignature: null, amount: null, finalizedAt: null, receipt: null };
const paid = { ...pending, status: 'credited', txSignature: '2'.repeat(88), amount: '100', finalizedAt: quote.createdAt,
  receipt: { version: 1, depositId, acceptedAt: quote.createdAt, txSignature: '2'.repeat(88), amountLamports: '100', shards: null } };
describe('paid base original consent and funding wire', () => {
  it('requires an explicit canonical stable target and exact unchanged next step', () => {
    expect(BasePurchaseRequestSchema.parse(request)).toEqual(request);
    for (const bad of [{ ...request, baseId: null }, { ...request, baseId: undefined }, { ...request, baseId: depositId.toUpperCase() },
      { ...request, idempotencyKey: key.toUpperCase() }, { ...request, expectedBuilders: CAPS.buildersMax },
      { ...request, expectedBuilders: 1.5 }, { ...request, maxCostSol: '100' },
      { idempotencyKey: key, baseId: depositId, kind: 'expansion', expectedExpansions: CAPS.expansionsMax },
      { idempotencyKey: key, baseId: depositId, kind: 'mine', buildingId: key, buildingType: 'mine', fromLevel: 4, toLevel: 6, maxCostShards: '1' }]) {
      expect(BasePurchaseRequestSchema.safeParse(bad).success).toBe(false);
    }
  });
  it('validates malformed amounts without BigInt exceptions and bounds wallet serialization', () => {
    for (const amount of ['0', '-1', '01', '1.5', '1e3', '', 'nope', '9223372036854775808']) {
      expect(BasePurchaseQuoteSchema.safeParse({ ...quote, amountLamports: amount }).success).toBe(false);
      expect(BasePurchaseRequestSchema.safeParse({ idempotencyKey: key, baseId: depositId, kind: 'mine', buildingId: key,
        buildingType: 'mine', fromLevel: 4, toLevel: 5, maxCostShards: amount }).success).toBe(false);
    }
    expect(BasePurchaseQuoteSchema.safeParse({ ...quote, amountLamports: '9007199254740991' }).success).toBe(true);
    expect(BasePurchaseQuoteSchema.safeParse({ ...quote, amountLamports: '9007199254740992' }).success).toBe(false);
  });
  it('ties payment rails and window order to the original action', () => {
    expect(BasePurchaseQuoteSchema.parse(quote)).toEqual(quote);
    for (const bad of [{ ...quote, rail: { ...quote.rail, sinkKind: 1 } },
      { ...quote, payableUntil: quote.retryAt }, { ...quote, createdAt: quote.payableUntil },
      { ...quote, createdAt: '2034-01-01T00:00:00Z' }, { ...quote, quotedCostShards: '1' },
      { ...quote, request: { idempotencyKey: key, baseId: depositId, kind: 'expansion', expectedExpansions: 0 } }]) {
      expect(BasePurchaseQuoteSchema.safeParse(bad).success).toBe(false);
    }
  });
  it('requires immutable exact credit evidence and never labels known paid state unpaid', () => {
    expect(BasePurchaseStateSchema.parse(pending)).toEqual(pending);
    expect(BasePurchaseStateSchema.parse(paid)).toEqual(paid);
    expect(BasePurchaseStateSchema.safeParse({ ...pending, status: 'failed' }).success).toBe(false);
    expect(BasePurchaseStateSchema.safeParse({ ...paid, status: 'failed', receipt: null, paymentSignature: '3'.repeat(88) }).success).toBe(false);
    expect(BasePurchaseStateSchema.safeParse({ ...pending, status: 'expired', paymentSignature: paid.txSignature }).success).toBe(false);
    for (const bad of [{ ...paid, receipt: null }, { ...paid, amount: '101' }, { ...paid, status: 'pending' },
      { ...paid, receipt: { ...paid.receipt, depositId: key } },
      { ...paid, receipt: { ...paid.receipt, amountLamports: '101' } },
      { ...paid, receipt: { ...paid.receipt, acceptedAt: quote.retryAt } }]) {
      expect(BasePurchaseStateSchema.safeParse(bad).success).toBe(false);
    }
  });
  it('keeps historical actor/key authority independent of today’s support flag', () => {
    const status = { version: 1, wallet, idempotencyKey: key, enabled: false, serverNow: quote.retryAt, purchase: paid };
    expect(BasePurchaseStatusSchema.parse(status)).toEqual(status);
    expect(BasePurchaseStatusSchema.parse({ ...status, purchase: null }).purchase).toBeNull();
    expect(BasePurchaseStatusSchema.safeParse({ ...status, wallet: '3'.repeat(32) }).success).toBe(false);
    expect(BasePurchaseStatusSchema.safeParse({ ...status, idempotencyKey: depositId }).success).toBe(false);
  });
  it('binds Mine and Forge SHARDS evidence to original maximum consent', () => {
    const mineRequest = { idempotencyKey: key, baseId: depositId, kind: 'mine', buildingId: key,
      buildingType: 'mine', fromLevel: 4, toLevel: 5, maxCostShards: '200' };
    const mineQuote = { ...quote, request: mineRequest, quotedCostShards: '200',
      rail: { ...quote.rail, mode: 'sol_transfer', sinkKind: null, destination: wallet } };
    const minePaid = { ...paid, quote: mineQuote, receipt: { ...paid.receipt, shards: { receiptId: key, currency: 'SHARDS', amount: '200' } } };
    expect(BasePurchaseStateSchema.parse(minePaid)).toEqual(minePaid);
    for (const bad of [{ ...minePaid, quote: { ...mineQuote, quotedCostShards: '201' } },
      { ...minePaid, receipt: { ...minePaid.receipt, shards: null } },
      { ...minePaid, receipt: { ...minePaid.receipt, shards: { receiptId: key, currency: 'SHARDS', amount: '201' } } },
      { ...minePaid, paymentSignature: '3'.repeat(88) }]) {
      expect(BasePurchaseStateSchema.safeParse(bad).success).toBe(false);
    }
  });
});


describe('shield quote and effect compatibility', () => {
  it('requires an explicit supported shield kind on the additive capability path', () => {
    for (const kind of ['shield', 'warzone_shield']) expect(BasePurchaseShieldQuerySchema.parse({ kind })).toEqual({ kind });
    for (const bad of [{}, { kind: 'builder' }, { kind: ['shield', 'warzone_shield'] }, { kind: 'shield', enabled: true }]) {
      expect(BasePurchaseShieldQuerySchema.safeParse(bad).success).toBe(false);
    }
  });
  const shield = { ...quote, request: { idempotencyKey: key, baseId: depositId, kind: 'shield' }, rail: { ...quote.rail, sinkKind: 4 } };
  const warzone = { ...shield, request: { ...shield.request, kind: 'warzone_shield' },
    rail: { ...quote.rail, mode: 'warzone_split', sinkKind: 6, destination: wallet, directLamports: '50', splitLamports: '50' } };
  it('binds each product to its own exact rail and both frozen Warzone legs', () => {
    expect(BasePurchaseQuoteSchema.parse(shield)).toEqual(shield);
    expect(BasePurchaseQuoteSchema.parse(warzone)).toEqual(warzone);
    for (const bad of [{ ...shield, rail: quote.rail }, { ...warzone, rail: shield.rail },
      { ...warzone, rail: { ...warzone.rail, directLamports: '49' } },
      { ...warzone, rail: { ...warzone.rail, destination: '3'.repeat(32) } },
      ...['0','01','oops','9007199254740992'].map(directLamports => ({ ...warzone, rail: { ...warzone.rail, directLamports } }))]) {
      expect(BasePurchaseQuoteSchema.safeParse(bad).success).toBe(false);
    }
  });
  it('requires shield outcome only on shield receipts and preserves ordinary paid no-op truth', () => {
    const accepted = { ...paid, quote: shield, receipt: { ...paid.receipt, shield: { granted: false, expiresAt: null } } };
    expect(BasePurchaseStateSchema.parse(accepted)).toEqual(accepted);
    expect(BasePurchaseStateSchema.safeParse({ ...paid, quote: shield }).success).toBe(false);
    expect(BasePurchaseStateSchema.safeParse({ ...paid, receipt: accepted.receipt }).success).toBe(false);
    expect(BasePurchaseStateSchema.safeParse({ ...accepted, quote: warzone }).success).toBe(false);
    for (const expiresAt of [null, quote.createdAt]) {
      expect(BasePurchaseStateSchema.safeParse({ ...accepted, receipt: { ...paid.receipt, shield: { granted: true, expiresAt } } }).success).toBe(false);
    }
    expect(BasePurchaseStateSchema.safeParse({ ...accepted, quote: warzone,
      receipt: { ...paid.receipt, shield: { granted: true, expiresAt: quote.retryAt } } }).success).toBe(true);
  });
});


it('unquoted cancellation binds actor/key and cannot falsely discard an existing quote', () => {
  const cancelled = { version: 1, wallet, idempotencyKey: key, cancelled: true, purchase: null };
  expect(BasePurchaseCancellationSchema.parse(cancelled)).toEqual(cancelled);
  const quoted = { ...cancelled, cancelled: false, purchase: pending };
  expect(BasePurchaseCancellationSchema.parse(quoted)).toEqual(quoted);
  for (const bad of [{ ...cancelled, purchase: pending }, { ...quoted, purchase: null },
    { ...quoted, wallet: '3'.repeat(32) }, { ...quoted, idempotencyKey: depositId }, { ...cancelled, refunded: true }]) {
    expect(BasePurchaseCancellationSchema.safeParse(bad).success).toBe(false);
  }
});


describe('frozen paid energy wire', () => {
  for (const [kind, sinkKind] of [['energy', 3], ['energy_pack', 7]] as const) it(`${kind} binds the exact rail and historical quantity`, () => {
    const energy = { ...quote, request: { idempotencyKey: key, baseId: depositId, kind }, energyQuantity: 19,
      rail: { ...quote.rail, sinkKind } };
    expect(BasePurchaseQuoteSchema.parse(energy)).toEqual(energy);
    const accepted = { ...paid, quote: energy, receipt: { ...paid.receipt, energy: { quantity: 19 } } };
    expect(BasePurchaseStateSchema.parse(accepted)).toEqual(accepted);
    for (const quantity of [undefined, null, 0, -1, 1.5, 2_147_483_648]) {
      expect(BasePurchaseQuoteSchema.safeParse({ ...energy, energyQuantity: quantity }).success).toBe(false);
    }
    for (const wrong of [4, 8, sinkKind === 3 ? 7 : 3]) {
      expect(BasePurchaseQuoteSchema.safeParse({ ...energy, rail: { ...energy.rail, sinkKind: wrong } }).success).toBe(false);
    }
    for (const receipt of [{ ...paid.receipt }, { ...paid.receipt, energy: { quantity: 20 } },
      { ...accepted.receipt, shards: { receiptId: key, currency: 'SHARDS', amount: '1' } },
      { ...accepted.receipt, shield: { granted: true, expiresAt: quote.retryAt } }]) {
      expect(BasePurchaseStateSchema.safeParse({ ...accepted, receipt }).success).toBe(false);
    }
    expect(BasePurchaseEnergyQuerySchema.parse({ kind })).toEqual({ kind });
    expect(BasePurchaseRequestSchema.safeParse({ ...energy.request, energyQuantity: 19 }).success).toBe(false);
  });
  it('does not attach energy evidence to older products or accept an ambiguous capability', () => {
    expect(BasePurchaseQuoteSchema.safeParse({ ...quote, energyQuantity: 1 }).success).toBe(false);
    expect(BasePurchaseStateSchema.safeParse({ ...paid, receipt: { ...paid.receipt, energy: { quantity: 1 } } }).success).toBe(false);
    for (const query of [{}, { kind: 'builder' }, { kind: ['energy', 'energy_pack'] }, { kind: 'energy', enabled: true }]) {
      expect(BasePurchaseEnergyQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});
