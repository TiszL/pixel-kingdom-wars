import { describe, expect, it } from 'vitest';
import { HERO_KEYS, HERO_LEVELING } from './constants';
import { HeroProgressionIntentSchema, heroProgressionBody, heroProgressionPath, heroProgressionReceiptPath, matchHeroProgressionProof, type HeroProgressionIntent } from './heroProgression';

const wallet = '11111111111111111111111111111111';
const baseId = '12345678-1234-4123-8123-123456789abc';
const timestamp = '2026-09-21T12:00:00.000Z';
const upgrade: HeroProgressionIntent = { kind: 'upgrade', hero: HERO_KEYS[0], baseId, idempotencyKey: 'original-hero-key', expectedCurrency: 'GEMS', maxCostKeep: '100', expectedLevel: 1 };
const recovery: HeroProgressionIntent = { kind: 'recovery', hero: HERO_KEYS[0], baseId, idempotencyKey: 'original-hero-key', expectedCurrency: 'GEMS', maxCostKeep: '100', recoveryUntil: timestamp };
function receipt(intent: HeroProgressionIntent) {
  return { version: 1, status: 'accepted', wallet, baseId: intent.baseId, receiptId: baseId, acceptedAt: timestamp,
    funding: { currency: intent.expectedCurrency, amount: '90' },
    request: { hero: intent.hero, ...(intent.baseId ? { baseId: intent.baseId } : {}), idempotencyKey: intent.idempotencyKey, maxCostKeep: intent.maxCostKeep,
      ...(intent.kind === 'upgrade' ? { expectedLevel: intent.expectedLevel } : { recoveryUntil: intent.recoveryUntil }) },
    result: intent.kind === 'upgrade' ? { fromLevel: intent.expectedLevel, toLevel: intent.expectedLevel + 1 } : { recoveryUntil: intent.recoveryUntil } };
}
describe('original Hero progression currency and episode proof', () => {
  it.each([upgrade, recovery])('uses frozen compatible body and read-only receipt query for $kind', intent => {
    const body = heroProgressionBody(intent);
    expect(body).toEqual({ idempotencyKey: intent.idempotencyKey, baseId, consent: intent.kind === 'upgrade'
      ? { expectedLevel: 1, maxCostKeep: '100' } : { recoveryUntil: timestamp, maxCostKeep: '100' } });
    expect(body).not.toHaveProperty('expectedCurrency'); // This is a command-local header.
    const url = new URL(heroProgressionReceiptPath(intent), 'https://game.example');
    expect(url.pathname).toBe(`${heroProgressionPath(intent)}/receipt`);
    expect(url.searchParams.get('idempotencyKey')).toBe(intent.idempotencyKey);
    expect(url.searchParams.get('maxCostKeep')).toBe('100');
    expect(url.searchParams.get('baseId')).toBe(baseId);
  });
  it.each([upgrade, recovery])('requires matching original currency even when the other balance could cover $kind', intent => {
    const proof = receipt(intent);
    expect(matchHeroProgressionProof(proof, wallet, intent).status).toBe('accepted');
    expect(() => matchHeroProgressionProof({ ...proof, funding: { currency: 'KEEP', amount: '90' } }, wallet, intent)).toThrow();
    expect(matchHeroProgressionProof(receipt({ ...intent, expectedCurrency: 'KEEP' }), wallet, { ...intent, expectedCurrency: 'KEEP' }).status).toBe('accepted');
    for (const amount of ['0', '101', '-1', '1.5', '9223372036854775808']) {
      expect(() => matchHeroProgressionProof({ ...proof, funding: { ...proof.funding, amount } }, wallet, intent)).toThrow();
    }
  });
  it.each([upgrade, recovery])('rejects valid receipts for another wallet/base/key/price/hero on $kind', intent => {
    const proof = receipt(intent);
    for (const wrong of [
      { ...proof, wallet: '11111111111111111111111111111112' }, { ...proof, baseId: null },
      { ...proof, request: { ...proof.request, idempotencyKey: 'another-key' } },
      { ...proof, request: { ...proof.request, maxCostKeep: '101' } },
      { ...proof, request: { ...proof.request, hero: HERO_KEYS[1] } },
    ]) expect(() => matchHeroProgressionProof(wrong, wallet, intent)).toThrow();
    expect(matchHeroProgressionProof({ version: 1, status: 'unknown', idempotencyKey: intent.idempotencyKey }, wallet, intent).status).toBe('unknown');
    expect(() => matchHeroProgressionProof({ version: 1, status: 'unknown', idempotencyKey: 'another-key' }, wallet, intent)).toThrow();
  });
  it('refuses a newer Hero level or another recovery episode instead of inferring payment from current state', () => {
    expect(() => matchHeroProgressionProof({ ...receipt(upgrade), result: { fromLevel: 2, toLevel: 3 } }, wallet, upgrade)).toThrow();
    expect(() => matchHeroProgressionProof({ ...receipt(recovery), result: { recoveryUntil: '2026-09-22T12:00:00.000Z' } }, wallet, recovery)).toThrow();
    expect(() => matchHeroProgressionProof({ hero: upgrade.hero, spentKeep: '0', duplicate: true }, wallet, upgrade)).toThrow();
  });
  it('retains explicit legacy base scope without substituting a selected deed', () => {
    const legacy = { ...upgrade, baseId: null };
    expect(heroProgressionBody(legacy)).not.toHaveProperty('baseId');
    expect(new URL(heroProgressionReceiptPath(legacy), 'https://game.example').searchParams.has('baseId')).toBe(false);
    expect(matchHeroProgressionProof(receipt(legacy), wallet, legacy).status).toBe('accepted');
    expect(() => matchHeroProgressionProof(receipt(upgrade), wallet, legacy)).toThrow();
  });
  it('refuses malformed or incomplete new consent, unsafe amounts and max-level upgrades', () => {
    for (const wrong of [{ ...upgrade, expectedCurrency: undefined }, { ...upgrade, expectedCurrency: 'SOL' },
      { ...upgrade, expectedLevel: HERO_LEVELING.maxLevel }, { ...upgrade, maxCostKeep: '0' },
      { ...upgrade, maxCostKeep: '9223372036854775808' }, { ...recovery, recoveryUntil: 'later' }]) {
      expect(() => HeroProgressionIntentSchema.parse(wrong)).toThrow();
    }
  });
});
