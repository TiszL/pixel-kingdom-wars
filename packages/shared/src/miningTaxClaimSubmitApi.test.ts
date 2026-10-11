/** Delivery acknowledgements never prove settlement or durable custody when the
 * database result is unknown; clients retain their local signature and use GET. */
import {describe,it,expect} from 'vitest';
import {MiningTaxClaimSubmitResponseSchema as Schema} from './miningTaxClaimRecoveryApi';
import fixtures from './testFixtures/miningTaxClaimRecoveryApi.json';
const ack=()=>{const f=structuredClone(fixtures.combined);return {wallet:f.wallet,idempotencyKey:f.idempotencyKey,claimId:f.claimId,wire:f.wires[0],delivery:'held',reason:'DELIVERY_UNAVAILABLE',serverNow:f.serverNow};};
describe('KEEP tax submit acknowledgement',()=>{
 it('binds confirmed custody to its exact actor/key/claim while treating delivery as an observation',()=>{
  const a=ack();expect(Schema.parse(a)).toEqual(a);for(const delivery of ['submitted','settled']){const {reason,...rest}=a;expect(Schema.safeParse({...rest,delivery}).success).toBe(true);}
  for(const field of ['wallet','idempotencyKey','claimId'] as const){const value=field==='wallet'?fixtures.combined.preparation.identity.programId:'ffffffff-ffff-4fff-8fff-ffffffffffff';expect(Schema.safeParse({...a,[field]:value}).success).toBe(false);}
  const setup=fixtures.setup;expect(Schema.safeParse({...a,claimId:setup.claimId,wallet:setup.wallet,idempotencyKey:setup.idempotencyKey,wire:setup.wires[0],delivery:'setup',reason:undefined}).success).toBe(true);
  expect(Schema.safeParse({...a,delivery:'setup',reason:undefined}).success).toBe(false);
 });
 it('keeps uncertain custody distinct from an accepted wire without inventing acceptedAt or claimId',()=>{
  const a={...ack(),claimId:null,wire:null,reason:'STORAGE_UNCERTAIN'};expect(Schema.parse(a)).toEqual(a);
  for(const change of [{claimId:fixtures.combined.claimId},{reason:'DELIVERY_UNAVAILABLE'},{delivery:'submitted',reason:undefined},{acceptedAt:fixtures.combined.wires[0]!.acceptedAt},{journalClearingAuthorized:true}])expect(Schema.safeParse({...a,...change}).success).toBe(false);
 });
 it('requires bounded canonical reasons only for held results and rejects caller authority or malformed time',()=>{
  const a=ack();for(const change of [{reason:undefined},{reason:'unavailable'},{reason:'A'.repeat(65)},{delivery:'settled'},{serverNow:'2026-02-30T00:00:00.000Z'},{finalityAuthenticated:true},{currentSigningAuthorized:true}])expect(Schema.safeParse({...a,...change}).success).toBe(false);
 });
});
