import { describe, expect, it } from 'vitest';
import { FORGE_INGOT } from './constants';
import { matchWorkshopCollectEnvelope, matchWorkshopStartEnvelope, WorkshopAllowanceSchema, WorkshopCollectRequestSchema,
  WorkshopCollectResultSchema, WorkshopStartEnvelopeSchema, WorkshopStartReceiptSchema, WorkshopStartRequestSchema, WorkshopViewSchema } from './workshop';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wallet = '11111111111111111111111111111111', otherWallet = 'So11111111111111111111111111111111111111112';
const start = '2026-09-21T00:00:00.000Z', ready = '2026-09-21T00:01:00.000Z', now = '2026-09-21T00:02:00.000Z';
const request = { baseId: id(1), idempotencyKey: 'original-start-key', ingots: 1, recipeVersion: 1 };
const receipt = () => ({ version: 1, status: 'accepted', wallet, baseId: id(1), jobId: id(2), ingots: 1,
  shardsCharged: String(FORGE_INGOT.shardsPerIngot), recipeVersion: 1, workshopLevelAtStart: 1, capacityScopeAtStart: 'free_wallet',
  startedAt: start, readyAt: ready, receiptId: id(3), acceptedAt: start });
const envelope = () => ({ wallet, idempotencyKey: request.idempotencyKey, status: 'accepted', receipt: receipt(), serverNow: now });
const collect = () => ({ wallet, idempotencyKey: 'original-collect-key', status: 'accepted', serverNow: now,
  receipt: { version: 1, status: 'accepted', wallet, baseId: id(1), jobId: id(2), receiptId: id(2), ingotsCredited: 1, collectedAt: now } });
const allowance = () => ({ version: 1, scope: 'free_wallet', day: start, resetsAt: '2026-09-22T00:00:00.000Z', capacityUnits: 2,
  daily: { cap: 6, used: 2, remaining: 4 }, holding: { held: 3, pending: 2, listed: 0, reserved: 0, cap: 14, remaining: 9 } });
const view = () => ({ features: { workshop: { version: 1, receipts: 1, allowance: 1 } }, acceptingJobs: false, level: 1, recipeVersion: 1,
  shardsPerIngot: FORGE_INGOT.shardsPerIngot, batch: { size: 1, max: 30 }, secPerIngot: 60,
  inventory: { baseId: id(1), held: 1, pending: 1 }, allowance: allowance(), dailyRefineCap: 6, refinedToday: 1,
  holding: { held: 1, listed: 0, reserved: 0, inProgress: 1, cap: 14 }, capacity: 2,
  jobs: [{ jobId: id(2), ingots: 1, shards: String(FORGE_INGOT.shardsPerIngot), recipeVersion: 1, workshopLevel: 1,
    capacityScopeAtStart: null, startedAt: start, readyAt: ready, ready: true, collectedAt: null }], serverNow: now });

describe('Workshop v1 allowance and current inventory', () => {
  it('separates selected-base stock and compatibility fields from the shared free-wallet allowance, including paused views', () => {
    expect(WorkshopViewSchema.parse(view())).toMatchObject({ acceptingJobs: false, inventory: { held: 1 }, allowance: { holding: { held: 3 } } });
    const paid = view(); paid.allowance.scope = 'deed_base'; paid.allowance.daily.used = 1; paid.allowance.daily.remaining = 5;
    paid.allowance.holding.held = 1; paid.allowance.holding.pending = 1; paid.allowance.holding.remaining = 12;
    expect(WorkshopViewSchema.safeParse(paid).success).toBe(true);
    paid.inventory.held = 2; expect(WorkshopViewSchema.safeParse(paid).success).toBe(false);
  });
  it('validates exact UTC midnight/day rollover, clamped arithmetic and zero listed/reserved fields', () => {
    for (const bad of [{ day: ready }, { day: 'invalid' }, { resetsAt: start }, { resetsAt: '2026-09-23T00:00:00.000Z' },
      { daily: { cap: 6, used: 2, remaining: 5 } }, { holding: { ...allowance().holding, remaining: 10 } },
      { holding: { ...allowance().holding, listed: 1 } }, { holding: { ...allowance().holding, reserved: 1 } }]) {
      expect(WorkshopAllowanceSchema.safeParse({ ...allowance(), ...bad }).success).toBe(false);
    }
    expect(WorkshopAllowanceSchema.safeParse({ ...allowance(), day: '2028-02-29T00:00:00.000Z', resetsAt: '2028-03-01T00:00:00.000Z' }).success).toBe(true);
  });
  it('permits already owned stock and original daily use above current caps without treating it as permission to start', () => {
    const over = { ...allowance(), daily: { cap: 1, used: 10, remaining: 0 }, holding: { ...allowance().holding, cap: 1, remaining: 0 } };
    expect(WorkshopAllowanceSchema.parse(over)).toEqual(over);
    expect(WorkshopAllowanceSchema.safeParse({ ...over, daily: { ...over.daily, remaining: -9 } }).success).toBe(false);
    const huge = { ...over, holding: { ...over.holding, held: Number.MAX_SAFE_INTEGER, pending: Number.MAX_SAFE_INTEGER } };
    expect(WorkshopAllowanceSchema.safeParse(huge).success).toBe(true); // exact BigInt sum, not rounded Number arithmetic
  });
  it('refuses unsafe counts, wrong selected-base stock, duplicate jobs and incorrect readiness/day evidence', () => {
    for (const bad of [{ refinedToday: Number.MAX_SAFE_INTEGER + 1 }, { inventory: { ...view().inventory, held: 2 } },
      { jobs: [...view().jobs, ...view().jobs] }, { jobs: [{ ...view().jobs[0], ready: false }] }, { serverNow: 'invalid' },
      { serverNow: '2026-09-22T00:02:00.000Z' }, { jobs: [{ ...view().jobs[0], collectedAt: start }] }]) {
      expect(WorkshopViewSchema.safeParse({ ...view(), ...bad }).success).toBe(false);
    }
  });
  it('network reads tolerate additive feature/response fields without accepting another protocol', () => {
    expect(WorkshopViewSchema.safeParse({ ...view(), futureField: true, features: { workshop: { ...view().features.workshop, extra: 1 }, futureFeature: {} } }).success).toBe(true);
    expect(WorkshopViewSchema.safeParse({ ...view(), features: { workshop: { version: 2, receipts: 1, allowance: 1 } } }).success).toBe(false);
  });
});
describe('original Workshop request and receipt proofs', () => {
  it('requires an explicit canonical start base and strict current body/key format; collect body does not invent a base field', () => {
    expect(WorkshopStartRequestSchema.parse(request)).toEqual(request);
    for (const bad of [{ ...request, baseId: undefined }, { ...request, baseId: null }, { ...request, idempotencyKey: 'short' },
      { ...request, idempotencyKey: 'x'.repeat(129) }, { ...request, ingots: 1.5 }, { ...request, extra: true }, { ...request, ingots: Number.MAX_SAFE_INTEGER }]) {
      expect(WorkshopStartRequestSchema.safeParse(bad).success).toBe(false);
    }
    expect(WorkshopCollectRequestSchema.safeParse({ idempotencyKey: 'original-collect-key' }).success).toBe(true);
    expect(WorkshopCollectRequestSchema.safeParse({ idempotencyKey: 'original-collect-key', baseId: id(1) }).success).toBe(false);
  });
  it('historical recipe versions/quantities and missing or NULL capacity scope stay readable without current admission caps', () => {
    const { capacityScopeAtStart: _scope, ...legacy } = receipt();
    expect(WorkshopStartReceiptSchema.parse(legacy)).toMatchObject({ capacityScopeAtStart: null });
    expect(WorkshopStartReceiptSchema.safeParse({ ...receipt(), capacityScopeAtStart: null, recipeVersion: 123,
      ingots: FORGE_INGOT.batch.max + 1, shardsCharged: String(BigInt(FORGE_INGOT.batch.max + 1) * BigInt(FORGE_INGOT.shardsPerIngot)) }).success).toBe(true);
    // Ledger acceptedAt is PostgreSQL transaction-start time; the locked job can
    // start later. Requiring equality would strand sound historical receipts.
    expect(WorkshopStartReceiptSchema.safeParse({ ...receipt(), startedAt: ready, readyAt: now }).success).toBe(true);
  });
  it('refuses noncanonical/overflow/wrong debit proofs and reversed job timing', () => {
    for (const bad of [{ shardsCharged: '01' }, { shardsCharged: '1e4' }, { shardsCharged: '9223372036854775808' },
      { shardsCharged: '1' }, { wallet: 'a'.repeat(32) }, { ingots: Number.MAX_SAFE_INTEGER + 1 }, { readyAt: '2026-09-20T00:00:00.000Z' },
      { startedAt: '2026-02-30T00:00:00.000Z' }, { capacityScopeAtStart: 'future_scope' }]) {
      expect(WorkshopStartReceiptSchema.safeParse({ ...receipt(), ...bad }).success).toBe(false);
    }
  });
  it('binds accepted start wallet/key/base/quantity/recipe to saved consent and accepts a genuine unknown receipt', () => {
    expect(matchWorkshopStartEnvelope(envelope(), { wallet, request }).receipt?.jobId).toBe(id(2));
    for (const bad of [{ wallet: otherWallet }, { idempotencyKey: 'another-start-key' }, { receipt: { ...receipt(), baseId: id(4) } },
      { receipt: { ...receipt(), recipeVersion: 2 } }, { receipt: { ...receipt(), ingots: 2, shardsCharged: String(2 * FORGE_INGOT.shardsPerIngot) } }]) {
      expect(() => matchWorkshopStartEnvelope({ ...envelope(), ...bad }, { wallet, request })).toThrow();
    }
    expect(matchWorkshopStartEnvelope({ ...envelope(), status: 'unknown', receipt: null }, { wallet, request }).receipt).toBeNull();
    expect(WorkshopStartEnvelopeSchema.safeParse({ ...envelope(), status: 'unknown' }).success).toBe(false);
  });
  it('binds collect proof to original wallet/key/job/base, keeps over-cap paid collect valid, and does not equate current stock with original credit', () => {
    const expected = { wallet, baseId: id(1), jobId: id(2), request: { idempotencyKey: 'original-collect-key' } };
    expect(matchWorkshopCollectEnvelope(collect(), expected).receipt?.ingotsCredited).toBe(1);
    for (const bad of [{ wallet: otherWallet }, { idempotencyKey: 'another-collect-key' }, { receipt: { ...collect().receipt, baseId: id(4) } },
      { receipt: { ...collect().receipt, jobId: id(4), receiptId: id(4) } }, { receipt: { ...collect().receipt, receiptId: id(3) } }]) {
      expect(() => matchWorkshopCollectEnvelope({ ...collect(), ...bad }, expected)).toThrow();
    }
    expect(matchWorkshopCollectEnvelope({ ...collect(), receipt: { ...collect().receipt, ingotsCredited: FORGE_INGOT.batch.max + 1 } }, expected).status).toBe('accepted');
    expect(WorkshopCollectResultSchema.safeParse({ jobId: id(2), baseId: id(1), ingotsCredited: 5, held: 0, collectedAt: now, duplicate: true, serverNow: now }).success).toBe(true);
  });
});
