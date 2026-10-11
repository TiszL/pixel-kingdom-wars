import { expect, it } from 'vitest';
import { matchResearchSpeedupProof, researchSpeedupBody, ResearchSpeedupIntentSchema, researchSpeedupReceiptPath, type ResearchSpeedupIntent } from './researchSpeedup';
const id = '12345678-1234-4123-8123-123456789abc'; const at = '2026-09-21T12:00:00.000Z';
const wallet = '11111111111111111111111111111111';
const intent: ResearchSpeedupIntent = { troop: 'giant', baseId: id, idempotencyKey: 'original-research', expectedCurrency: 'GEMS', currentLevel: 1, toLevel: 2, finishesAt: at, episodeId: id, maxCostKeep: '100' };
const proof = { version: 1, status: 'accepted', wallet, request: intent, receiptId: id, acceptedAt: at, funding: { currency: 'GEMS', amount: '90' }, result: { troop: 'giant', fromLevel: 1, toLevel: 2 } };
it('preserves original consent in compatible POST body and GET-only query', () => {
  expect(researchSpeedupBody(intent)).toEqual({ troop: 'giant', baseId: id, idempotencyKey: intent.idempotencyKey, consent: { currentLevel: 1, toLevel: 2, finishesAt: at, episodeId: id, maxCostKeep: '100' } });
  const legacy = { ...intent, baseId: null, episodeId: null };
  expect(researchSpeedupBody(legacy)).not.toHaveProperty('baseId');
  const url = new URL(researchSpeedupReceiptPath(legacy), 'https://game.example');
  expect(url.searchParams.get('episodeId')).toBe('null'); expect(url.searchParams.has('baseId')).toBe(false);
  expect(url.searchParams.get('expectedCurrency')).toBe('GEMS');
});
it('matches every original term and actual single currency without pooling or substitute episodes', () => {
  expect(matchResearchSpeedupProof(proof, wallet, intent).status).toBe('accepted');
  for (const request of [{ ...intent, baseId: null }, { ...intent, expectedCurrency: 'KEEP' }, { ...intent, maxCostKeep: '101' }, { ...intent, episodeId: null }]) {
    expect(() => matchResearchSpeedupProof({ ...proof, request }, wallet, intent)).toThrow();
  }
  for (const funding of [{ currency: 'KEEP', amount: '90' }, { currency: 'GEMS', amount: '101' }, { currency: 'GEMS', amount: '0' }]) {
    expect(() => matchResearchSpeedupProof({ ...proof, funding }, wallet, intent)).toThrow();
  }
  expect(() => matchResearchSpeedupProof(proof, '11111111111111111111111111111112', intent)).toThrow();
});
it('never treats a POST acknowledgement or a different unknown key as receipt proof', () => {
  expect(() => matchResearchSpeedupProof({ cost: '0', troop: 'giant', toLevel: 2 }, wallet, intent)).toThrow();
  expect(matchResearchSpeedupProof({ version: 1, status: 'unknown', idempotencyKey: intent.idempotencyKey }, wallet, intent).status).toBe('unknown');
  expect(() => matchResearchSpeedupProof({ version: 1, status: 'unknown', idempotencyKey: 'other-research' }, wallet, intent)).toThrow();
});
it('requires bounded original amounts and exactly one level of progress', () => {
  for (const bad of [{ ...intent, toLevel: 3 }, { ...intent, maxCostKeep: '9223372036854775808' }, { ...intent, maxCostKeep: '01' }, { ...intent, expectedCurrency: undefined }]) expect(ResearchSpeedupIntentSchema.safeParse(bad).success).toBe(false);
});
