import { describe, expect, it } from 'vitest';
import { MINING } from './constants';
import { MinePurchaseConsentSchema, MinePurchaseIntentSchema, MinePurchaseProofSchema, matchMinePurchaseProof, minePurchaseBody, minePurchaseReceiptPath, type MinePurchaseIntent } from './minePurchase';
const wallet = '11111111111111111111111111111111', id = '00000000-0000-4000-8000-000000000001';
const request: MinePurchaseIntent = { type: 'mine', tx: 11, ty: 8, baseId: id, idempotencyKey: 'original-mine-key', expectedCurrency: 'GEMS',
  mineConsent: { version: 1, mineIndex: 1, maxCostKeep: String(MINING.MINE_BUILD_KEEP[1]) } };
const proof = () => ({ version: 1, wallet, request, receiptId: id, acceptedAt: '2026-09-21T00:00:00.000Z', funding: { currency: 'GEMS', amount: request.mineConsent.maxCostKeep } });
describe('additional Mine original purchase wire', () => {
  it('keeps exact currency out of the body and original common fields only in the receipt query', () => {
    expect(minePurchaseBody(request)).toEqual({ type: 'mine', tx: 11, ty: 8, baseId: id, idempotencyKey: request.idempotencyKey, mineConsent: request.mineConsent });
    const query = new URL(minePurchaseReceiptPath(request), 'https://test.invalid').searchParams;
    expect([...query.keys()].sort()).toEqual(['baseId','idempotencyKey','tx','ty','type']);
    expect(minePurchaseBody({ ...request, baseId: null })).not.toHaveProperty('baseId');
  });
  it.each([0,-1,'1',1.5,Number.MAX_SAFE_INTEGER + 1])('rejects first-Mine/coerced/invalid index %s', mineIndex => {
    expect(MinePurchaseConsentSchema.safeParse({ ...request.mineConsent, mineIndex }).success).toBe(false);
  });
  it.each(['0','01','-1','1.1','9223372036854775808',1,null])('rejects invalid ceiling %s', maxCostKeep => {
    expect(MinePurchaseConsentSchema.safeParse({ ...request.mineConsent, maxCostKeep }).success).toBe(false);
  });
  it('requires complete canonical terms and rejects another type or unknown fields', () => {
    for (const change of [{ type:'vault' },{ expectedCurrency:'keep' },{ tx:'11' },{ unknown:true }]) expect(MinePurchaseIntentSchema.safeParse({ ...request,...change }).success).toBe(false);
    expect(MinePurchaseConsentSchema.safeParse({ ...request.mineConsent, version:'1' }).success).toBe(false);
  });
  it('proves a lower original charge but never switches currency or exceeds the maximum', () => {
    expect(matchMinePurchaseProof(proof(),wallet,request).request).toEqual(request);
    expect(MinePurchaseProofSchema.safeParse({ ...proof(), funding:{ currency:'GEMS',amount:'1' } }).success).toBe(true);
    for (const funding of [{ currency:'KEEP',amount:'1' },{ currency:'GEMS',amount:String(BigInt(request.mineConsent.maxCostKeep)+1n) }]) expect(MinePurchaseProofSchema.safeParse({ ...proof(),funding }).success).toBe(false);
  });
  it('rejects malformed nested amounts without throwing outside safeParse', () => {
    expect(MinePurchaseProofSchema.safeParse({ ...proof(), funding: { currency: 'GEMS', amount: '1.1' } }).success).toBe(false);
    expect(MinePurchaseProofSchema.safeParse({ ...proof(), request: { ...request, mineConsent: { ...request.mineConsent, maxCostKeep: '1.1' } } }).success).toBe(false);
  });
  it.each(['wallet','key','index','base','tile'] as const)('rejects %s substitution instead of upgrading an unrelated receipt', field => {
    const other = structuredClone(request); let actor = wallet;
    if(field==='wallet') actor='22222222222222222222222222222222';
    if(field==='key') other.idempotencyKey='another-key'; if(field==='index') other.mineConsent.mineIndex=2;
    if(field==='base') other.baseId=null; if(field==='tile') other.tx++;
    expect(()=>matchMinePurchaseProof(proof(),actor,other)).toThrow();
  });
});
