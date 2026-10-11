import {expect,it} from 'vitest';
import {sha256} from '@noble/hashes/sha256';
import {MiningClaimPreparationViewSchema,MiningClaimContinuationEnvelopeSchema,MiningClaimReviewSchema,MiningClaimViewSchema} from '@shardkeep/shared/miningClaimsApi';
import {prepareMiningClaimSigning,verifySignedMiningClaim} from './signing';
import pair from './testFixtures/ordered-http-pair.json';
it('independently reconstructs the actual source-backed HTTP setup, remainder and fresh child',()=>{
 const original=MiningClaimPreparationViewSchema.parse(pair.prepared),continued=MiningClaimContinuationEnvelopeSchema.parse(pair.continuation),child=continued.continuation!.childPreparation;
 for(const [p,ordinal] of [[original,0],[original,1],[child,0]] as const)expect(prepareMiningClaimSigning(p,pair.trust,ordinal).wallet).toBe(original.wallet);
 const setup=verifySignedMiningClaim(original,pair.setupWire,0),paid=verifySignedMiningClaim(child,pair.childWire,0),setupView=MiningClaimViewSchema.parse(pair.setupView),final=MiningClaimViewSchema.parse(pair.final);
 expect(setupView.state).toBe('retained');expect(setupView.settledBaseUnits).toBeNull();expect(setupView.transactions[0]!.signature).toBe(setup.signature);
 expect(final.state).toBe('settled');expect(final.signature).toBe(paid.signature);expect(BigInt(final.settledBaseUnits!)).toBeGreaterThan(0n);
 const review=MiningClaimReviewSchema.parse(pair.review1);expect(review.setup?.signature).toBe(setup.signature);expect(review.setup?.wireSha256).toBe(Buffer.from(sha256(Buffer.from(pair.setupWire,'base64'))).toString('hex'));
 expect(MiningClaimReviewSchema.parse(pair.childReview).setup).toEqual(review.setup);expect(continued.continuation!.setup).toEqual(review.setup);
 expect(pair.browserCalls.some(v=>v.endsWith('/continuation'))).toBe(true);expect(pair.browserCalls.filter(v=>v==='POST /claims/mining/submit')).toHaveLength(2);
});
it('rejects cross-ordinal or changed pins for the exact API-generated signed originals',()=>{
 const original=MiningClaimPreparationViewSchema.parse(pair.prepared),child=MiningClaimContinuationEnvelopeSchema.parse(pair.continuation).continuation!.childPreparation;
 expect(()=>verifySignedMiningClaim(original,pair.setupWire,1)).toThrow();expect(()=>verifySignedMiningClaim(original,pair.childWire,1)).toThrow();
 expect(()=>prepareMiningClaimSigning(child,{...pair.trust,orderedLookupTable:{...pair.trust.orderedLookupTable,dataSha256:'00'.repeat(32)}})).toThrow();
});
