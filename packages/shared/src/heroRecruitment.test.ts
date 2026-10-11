import { describe, expect, it } from 'vitest';
import { HEROES, PLOT_GEOMETRY } from './constants';
import { plotBounds } from './plotGeometry';
import { HeroRecruitmentReceiptSchema, HeroRecruitmentRequestSchema, HeroRecruitmentStatusSchema } from './heroRecruitment';
const key = '00000000-0000-4000-8000-000000000001';
const plot = plotBounds(PLOT_GEOMETRY.currentVersion);
const other = '00000000-0000-4000-8000-000000000002';
const actor = '11111111111111111111111111111111';
const request = { idempotencyKey: key, baseId: null, type: 'heroaltar', tx: 8, ty: 9, heroContractOnly: false, maxCostKeep: String(HEROES.vex.recruitCostKeep) };
const receipt = { version: 1, actor, idempotencyKey: key, request, hero: 'vex',
  building: { id: key, baseId: null, type: 'heroaltar', level: 1, tx: 8, ty: 9 },
  job: { id: other, buildingId: key, startedAt: '2026-09-13T00:00:00.000Z', finishesAt: '2026-09-13T00:01:00.000Z' },
  funding: { kind: 'keep', amount: request.maxCostKeep, ledgerTransactionId: other }, createdAt: '2026-09-13T00:00:00.000Z' };
describe('Hero recruitment consent and immutable accepted construction', () => {
  it('recovers original signed altar coordinates without rebuilding today’s claim', () => {
    const position = { tx: plot.min, ty: plot.max - 1 };
    const expanded = { ...receipt, request: { ...request, ...position }, building: { ...receipt.building, ...position } };
    expect(HeroRecruitmentReceiptSchema.parse(expanded)).toEqual(expanded);
    expect(HeroRecruitmentReceiptSchema.safeParse({ ...expanded, building: { ...expanded.building, tx: position.tx + 1 } }).success).toBe(false);
  });
  it('requires every original selector and explicit funding consent', () => {
    expect(HeroRecruitmentRequestSchema.parse(request)).toEqual(request);
    for (const field of Object.keys(request)) {
      const omitted = { ...request } as Record<string, unknown>; delete omitted[field];
      expect(HeroRecruitmentRequestSchema.safeParse(omitted).success).toBe(false);
    }
    for (const change of [{ maxCostKeep: '0' }, { heroContractOnly: true }, { type: 'mine' }, { tx: plot.max }, { ty: plot.min - 1 }, { tx: '8' }, { tx: 1.5 },
      { idempotencyKey: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, { baseId: other.toUpperCase().replace('000002', 'ABCDEF') }, { price: '1' }]) {
      expect(HeroRecruitmentRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
    }
  });
  it('never accepts rounded, signed, overflowed or noncanonical KEEP consent', () => {
    for (const value of [3000, '-1', '+1', '01', '1e3', '1.0', '9223372036854775808', '9'.repeat(200)]) {
      expect(HeroRecruitmentRequestSchema.safeParse({ ...request, maxCostKeep: value }).success).toBe(false);
      expect(HeroRecruitmentReceiptSchema.safeParse({ ...receipt, funding: { ...receipt.funding, amount: value } }).success).toBe(false);
    }
    expect(HeroRecruitmentRequestSchema.safeParse({ ...request, maxCostKeep: '9223372036854775807' }).success).toBe(true);
  });
  it('binds accepted identity, hero, geometry and original job to exact consent', () => {
    expect(HeroRecruitmentReceiptSchema.parse(receipt)).toEqual(receipt);
    for (const change of [{ idempotencyKey: other }, { hero: 'theodor' }, { extra: true },
      { building: { ...receipt.building, baseId: other } }, { building: { ...receipt.building, tx: 9 } },
      { building: { ...receipt.building, type: 'siegestool' } }, { building: { ...receipt.building, level: 2 } },
      { job: { ...receipt.job, buildingId: other } }, { job: { ...receipt.job, finishesAt: '2026-09-12T23:59:59.000Z' } },
      { job: { ...receipt.job, startedAt: '2026-09-13T00:00:00+00:00' } }]) {
      expect(HeroRecruitmentReceiptSchema.safeParse({ ...receipt, ...change }).success).toBe(false);
    }
  });
  it('records a prepaid contract from the exact deed or legacy wallet without permitting a KEEP fallback', () => {
    const contract = { ...receipt, request: { ...request, baseId: other, heroContractOnly: true, maxCostKeep: '0' }, building: { ...receipt.building, baseId: other },
      funding: { kind: 'contract', itemId: HEROES.vex.recruitItemId, itemUseId: key, sourceBaseId: other, quantity: 1 } };
    expect(HeroRecruitmentReceiptSchema.safeParse(contract).success).toBe(true);
    expect(HeroRecruitmentReceiptSchema.safeParse({ ...contract, funding: { ...contract.funding, sourceBaseId: null } }).success).toBe(true);
    for (const change of [{ sourceBaseId: key }, { itemId: HEROES.theodor.recruitItemId }, { quantity: 2 }, { amount: '0' }]) {
      expect(HeroRecruitmentReceiptSchema.safeParse({ ...contract, funding: { ...contract.funding, ...change } }).success).toBe(false);
    }
    expect(HeroRecruitmentReceiptSchema.safeParse({ ...contract, funding: receipt.funding }).success).toBe(false);
    expect(HeroRecruitmentReceiptSchema.safeParse({ ...receipt, request: { ...request, maxCostKeep: '1' } }).success).toBe(false);
  });
  it('missing history stays unknown while an accepted receipt remains bound to the authenticated actor and key', () => {
    const status = { version: 1, wallet: actor, idempotencyKey: key, enabled: false, receipt };
    expect(HeroRecruitmentStatusSchema.parse(status)).toEqual(status);
    expect(HeroRecruitmentStatusSchema.parse({ ...status, receipt: null }).receipt).toBeNull();
    expect(HeroRecruitmentStatusSchema.safeParse({ ...status, idempotencyKey: other }).success).toBe(false);
    expect(HeroRecruitmentStatusSchema.safeParse({ ...status, wallet: '22222222222222222222222222222222' }).success).toBe(false);
  });
});
