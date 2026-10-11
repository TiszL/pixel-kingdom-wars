import { describe, expect, it } from 'vitest';
import { TrainingFinishIntentSchema, TrainingFinishProofSchema, matchTrainingFinishProof, trainingFinishBody, trainingFinishReceiptPath } from './trainingFinish';
const row = { id: '00000000-0000-4000-8000-000000000001', startedAt: '2026-09-21T10:00:00.000Z', finishesAt: '2026-09-21T10:01:00.000Z' };
const request = { baseId: null, idempotencyKey: 'original-key', expectedCurrency: 'GEMS' as const, consent: { version: 2 as const, queue: [row], maxCostKeep: '10' } };
const wallet = '11111111111111111111111111111111';
const proof = { version: 1, status: 'accepted', wallet, request, receiptId: row.id, acceptedAt: row.startedAt,
  funding: { currency: 'GEMS', amount: '8' }, result: { completedAt: row.startedAt, paidRows: [{ ...row, troop: 'bowman' }], completed: [{ troop: 'bowman', count: 1 }] } };
describe('paid Finish All wire proof', () => {
  it('separates private minimal lookup from complete POST consent and currency header', () => {
    expect(trainingFinishBody(request)).toEqual({ idempotencyKey: request.idempotencyKey, consent: request.consent });
    expect(trainingFinishReceiptPath({ baseId: null, idempotencyKey: request.idempotencyKey })).toBe('/army/train/speedup/receipt?idempotencyKey=original-key');
    expect(matchTrainingFinishProof(proof, wallet, request)).toEqual(proof);
  });
  it.each([{ version: '2' }, { maxCostKeep: 10 }, { maxCostKeep: '0' }, { maxCostKeep: '01' }, { queue: [] }, { queue: [row, row] }, { hidden: true }])('rejects malformed/ambiguous consent %j', change => {
    expect(TrainingFinishIntentSchema.safeParse({ ...request, consent: { ...request.consent, ...change } }).success).toBe(false);
  });
  it.each([{ funding: { currency: 'KEEP', amount: '8' } }, { funding: { currency: 'GEMS', amount: '11' } },
    { result: { ...proof.result, completed: [{ troop: 'bowman', count: '1' }] } },
    { result: { ...proof.result, completed: [{ troop: 'bowman', count: 2 }] } },
    { result: { ...proof.result, completedAt: row.finishesAt } },
    { result: { ...proof.result, paidRows: [{ ...row, troop: 'bowman', id: '00000000-0000-4000-8000-000000000002' }] } },
  ])('rejects proof that cannot represent the original paid rows %j', change => {
    expect(TrainingFinishProofSchema.safeParse({ ...proof, ...change }).success).toBe(false);
  });
  it('requires every still-running original row, rather than proving a partial finish as Finish All', () => {
    expect(TrainingFinishProofSchema.safeParse({ ...proof, request: { ...request, consent: { ...request.consent, queue: [row, { ...row, id: '00000000-0000-4000-8000-000000000002' }] } } }).success).toBe(false);
  });
  it('rejects another wallet/key/ceiling instead of claiming matching current troop count proves success', () => {
    expect(() => matchTrainingFinishProof(proof, '22222222222222222222222222222222', request)).toThrow();
    expect(() => matchTrainingFinishProof(proof, wallet, { ...request, consent: { ...request.consent, maxCostKeep: '11' } })).toThrow();
    expect(() => matchTrainingFinishProof({ version: 1, status: 'unknown', idempotencyKey: 'another-key' }, wallet, request)).toThrow();
  });
});
