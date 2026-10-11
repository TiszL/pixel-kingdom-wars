/** Current-id unsigned ABI unit vectors; historical planner DTOs stay immutable. */
import {createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {Message,PublicKey,TransactionMessage} from '@solana/web3.js';
import {getAssociatedTokenAddressSync} from '@solana/spl-token';
import fixtures from './testFixtures/miningTaxPreparationCurrent.json';
import historical from '../../shared/src/testFixtures/miningTaxClaimsApi.json';
import {readFileSync} from 'node:fs';
import {MINING_PROGRAM_ADDRESS} from './miningProgramProtocol';
import type {MiningTaxClaimPreparation} from '@shardkeep/shared/miningTaxClaimsApi';
import {validateMiningTaxPreparationMessages} from './miningTaxPreparation';
const copy=(kind:'claim'|'combined'|'split')=>structuredClone(fixtures[kind]) as MiningTaxClaimPreparation;
describe('original tax preparation ABI recovery',()=>{
 it('preserves historical planner bytes instead of rewriting their evidence',()=>{
  const bytes=readFileSync(new URL('../../shared/src/testFixtures/miningTaxClaimsApi.json',import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('2fac5348ba7d8b4da58252d121e08ffbeaafb7787381ce696778b1a2db6c3b11');
 });
 it.each(['claim','combined','split'] as const)('does not admit historical %s identity as current',kind=>{
  expect(()=>validateMiningTaxPreparationMessages(structuredClone(historical[kind]) as MiningTaxClaimPreparation)).toThrow();
 });
 it.each(['claim','combined','split'] as const)('rebuilds the exact original %s message and account roster',kind=>{
  expect(copy(kind).identity.programId).toBe(MINING_PROGRAM_ADDRESS);
  expect(()=>validateMiningTaxPreparationMessages(copy(kind))).not.toThrow();
 });
 it.each(['bytes','signer','destination','pool','auction','cursor','blockhash','rent-size','order'] as const)('rejects a self-consistent but changed %s artifact',kind=>{
  const a=copy('combined');
  if(kind==='bytes'){const bytes=Buffer.from(a.transactions[0]!.messageHex,'hex');bytes[bytes.length-1]=bytes[bytes.length-1]!^1;a.transactions[0]!.messageHex=bytes.toString('hex');a.transactions[0]!.messageSha256=createHash('sha256').update(bytes).digest('hex');}
  if(kind==='signer')a.wallet=a.identity.reserveOwner;
  if(kind==='destination')a.identity.claimantAta=a.identity.pool;
  if(kind==='pool')a.identity.pool=a.identity.cursor;
  if(kind==='auction')a.identity.auction=a.identity.term;
  if(kind==='cursor')a.identity.cursor=a.identity.pool;
  if(kind==='blockhash'){expect(a.blockhash).not.toBe(a.identity.keepMint);a.blockhash=a.identity.keepMint;}
  if(kind==='rent-size')a.transactions[0]!.newAccounts[0]!.space++;
  if(kind==='order')a.transactions[0]!.newAccounts.reverse();
  expect(()=>validateMiningTaxPreparationMessages(a)).toThrow();
 });
 it('rejects self-consistent original bytes that merge the claimant and mint roles',()=>{
  const a=copy('claim'),i=a.identity,oldMint=new PublicKey(i.keepMint),oldAta=i.claimantAta,config=new PublicKey(i.configAddress),wallet=new PublicKey(a.wallet);
  const oldVault=getAssociatedTokenAddressSync(oldMint,config,true).toBase58(),ata=getAssociatedTokenAddressSync(wallet,wallet),vault=getAssociatedTokenAddressSync(wallet,config,true);
  i.keepMint=a.wallet;i.claimantAta=ata.toBase58();
  const replacements=new Map([[oldMint.toBase58(),wallet],[oldAta,ata],[oldVault,vault]]),tx=a.transactions[0]!;
  const decoded=TransactionMessage.decompile(Message.from(Buffer.from(tx.messageHex,'hex')));
  for(const ix of decoded.instructions)for(const key of ix.keys)key.pubkey=replacements.get(key.pubkey.toBase58())??key.pubkey;
  const bytes=decoded.compileToLegacyMessage().serialize();tx.messageHex=Buffer.from(bytes).toString('hex');tx.messageSha256=createHash('sha256').update(bytes).digest('hex');tx.packetBytes=65+bytes.length;
  expect(()=>validateMiningTaxPreparationMessages(a)).toThrow();
 });
 it('does not reread current period, spot-count or quote-duration tuning to recover the saved ABI',async()=>{
  vi.resetModules();vi.doMock('@shardkeep/shared',async()=>{
   const actual=await vi.importActual<typeof import('@shardkeep/shared')>('@shardkeep/shared');
   return {...actual,PHASE_E_POLICY:{...actual.PHASE_E_POLICY,seekerIsland:{...actual.PHASE_E_POLICY.seekerIsland,totalSpots:1,operatingTermSec:1,overlappingAuctionSec:1}},PHASE_E_MINING_CLAIM_QUOTE:{...actual.PHASE_E_MINING_CLAIM_QUOTE,ttlSec:1}};
  });
  try{const {validateMiningTaxPreparationMessages:validate}=await import('./miningTaxPreparation');for(const kind of ['claim','combined','split'] as const)expect(()=>validate(copy(kind))).not.toThrow();}
  finally{vi.doUnmock('@shardkeep/shared');vi.resetModules();}
 });
});
