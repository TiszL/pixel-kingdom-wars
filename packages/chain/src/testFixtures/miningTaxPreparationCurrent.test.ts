import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {PublicKey} from '@solana/web3.js';
import {MiningTaxClaimPreparationSchema} from '@shardkeep/shared/miningTaxClaimsApi';
import {MINING_PROGRAM_ADDRESS} from '../miningProgramProtocol';
import {validateMiningTaxPreparationMessages} from '../miningTaxPreparation';
import {verifyMiningClaimSignedWire} from '../miningClaimWire';
import {createCurrentMiningTaxFixture} from './miningTaxPreparationCurrent';

describe('current tax SDK unit fixture, generated in memory only',()=>{
 it.each(['claim','combined','split'] as const)('binds %s messages and signatures to the current identity',kind=>{
  const f=createCurrentMiningTaxFixture(kind),p=MiningTaxClaimPreparationSchema.parse(f.preparation);
  expect(p.identity.programId).toBe(MINING_PROGRAM_ADDRESS);expect(()=>validateMiningTaxPreparationMessages(p)).not.toThrow();
  expect(p.currentSigningAuthorized).toBe(false);expect(p.submissionAuthorized).toBe(false);
  for(const [ordinal,tx] of p.transactions.entries()){
   const wire=f.wires[ordinal]!;
   const verified=verifyMiningClaimSignedWire({intentBytes:Buffer.from(tx.messageHex,'hex'),signedTransaction:Buffer.from(wire.signedTransactionHex,'hex'),wallet:new PublicKey(p.wallet)});
   expect(verified.signature).toBe(wire.signature);expect(verified.messageSha256).toBe(tx.messageSha256);
  }
 });
 it('does not rewrite any historical signed packet',()=>{
  const bytes=readFileSync(new URL('../../../shared/src/testFixtures/miningTaxClaimRecoveryApi.json',import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('6acc30fa91c7deeac6aea63f8ae5f5dca8e16ccde00f006da7d66010eab48703');
 });
});
