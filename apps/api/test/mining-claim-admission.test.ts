/** Persisted signatures are recovery facts, never permission to submit stale work. */
import { describe,it,expect,vi } from 'vitest';
import { createMiningClaimAdmission } from '../src/mining/claimAdmission';
import { acceptMiningClaimSigned } from '../src/mining/claimSignedStore';
import { withMiningClaimPreparationFixture as fixture } from './fixtures/miningClaimPreparation';
describe('fresh mining signed-claim admission',()=>{
 it('admits only an already persisted exact wire and current supported reward',async()=>fixture(async f=>{
  const read=createMiningClaimAdmission(f.conn.db,{...f.bank,now:()=>new Date(f.preparedClaim.preparedAt)}),request={wallet:f.wallet,claimId:f.preparedClaim.claimId,ordinal:0};
  await expect(read(request)).rejects.toMatchObject({code:'NOT_SIGNED'});
  const signed=await acceptMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:f.preparedClaim.claimId,signedTransaction:f.sign()});
  const result=await read(request);expect(result.signature).toBe(signed.signature);expect(Buffer.from(result.signedTransaction).toString('hex')).toBe(signed.signedTransactionHex);expect(result.snapshotSlot).toBeGreaterThanOrEqual(f.preparedClaim.blockhashContextSlot);
  expect(result).toHaveProperty('lastValidBlockHeight',f.preparedClaim.lastValidBlockHeight);
 }));
 it('retains signed evidence while disabled or expired but refuses new transport admission',async()=>fixture(async f=>{
  const signed=await acceptMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:f.preparedClaim.claimId,signedTransaction:f.sign()}),request={wallet:f.wallet,claimId:f.preparedClaim.claimId,ordinal:0};
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');await expect(createMiningClaimAdmission(f.conn.db,{...f.bank,now:()=>new Date(f.preparedClaim.preparedAt)})(request)).rejects.toMatchObject({code:'DISABLED'});
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');await expect(createMiningClaimAdmission(f.conn.db,{...f.bank,now:()=>new Date(f.preparedClaim.expiresAt)})(request)).rejects.toMatchObject({code:'EXPIRED'});
  expect(await acceptMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:f.preparedClaim.claimId,signedTransaction:f.sign()})).toEqual(signed);
 }));
 it('refuses another authenticated wallet and rejects a newer allocation frontier',async()=>fixture(async f=>{
  await acceptMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:f.preparedClaim.claimId,signedTransaction:f.sign()});const read=createMiningClaimAdmission(f.conn.db,{...f.bank,now:()=>new Date(f.preparedClaim.preparedAt)});
  await expect(read({wallet:f.buyer,claimId:f.preparedClaim.claimId,ordinal:0})).rejects.toMatchObject({code:'NOT_FOUND'});
  await f.bank.config({latest_sequence:2n});await expect(read({wallet:f.wallet,claimId:f.preparedClaim.claimId,ordinal:0})).rejects.toMatchObject({code:'CLAIM_PROOF_STALE'});
 }));
 it('refuses changed record setup and insufficient payer funds before transport',async()=>fixture(async f=>{
  await acceptMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:f.preparedClaim.claimId,signedTransaction:f.sign()});const read=createMiningClaimAdmission(f.conn.db,{...f.bank,now:()=>new Date(f.preparedClaim.preparedAt)}),request={wallet:f.wallet,claimId:f.preparedClaim.claimId,ordinal:0};
  await f.bank.records();await expect(read(request)).rejects.toMatchObject({code:'SETUP_CHANGED'});
  f.bank.rows[10]=null;f.bank.rows[11]=null;f.bank.rows[13]={...f.bank.rows[13]!,lamports:1};await expect(read(request)).rejects.toMatchObject({code:'INSUFFICIENT_SOL'});
 }));
});
