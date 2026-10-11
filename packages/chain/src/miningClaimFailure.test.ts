import {Keypair,Message,SystemProgram} from '@solana/web3.js';
import bs58 from 'bs58';
import {describe,it,expect,vi} from 'vitest';
import {createMiningClaimFailureFixture as fixture} from './testFixtures/miningClaimFailure';
import {createMiningClaimFailureVerifier} from './miningClaimFailure';
const verify=(f:Awaited<ReturnType<typeof fixture>>)=>createMiningClaimFailureVerifier(f.reader,f.state.trust)(f.request);
describe('exact finalized failed claimant transaction proof',()=>{
 it.each(['combined','claim','setup'] as const)('proves %s failure without making payment or cursor claims',async kind=>{
  const f=await fixture(kind),r=await verify(f);expect(r).toMatchObject({kind,outcome:'failed',paymentAuthorized:false,signature:f.request.signature,slot:140,observedAccountSlot:150});
  expect(r).not.toHaveProperty('paidKeepBaseUnits');expect(r).not.toHaveProperty('currentClaimedTotal');expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  if(kind!=='claim')expect(f.state.rows.slice(10,13)).toEqual([null,null,null]);
 });
 it('does not interpret rolled-back transfer CPI or logs as payment',async()=>{
  const f=await fixture();expect(f.tx.meta!.innerInstructions!.length).toBeGreaterThan(0);f.tx.meta!.logMessages=['Program log: transfer succeeded before a later failure'];
  const r=await verify(f);expect(r.outcome).toBe('failed');expect(r).not.toHaveProperty('paidKeepBaseUnits');
 });
 it('preserves historical failure with pause, revocation, later cursors and a closed ATA',async()=>{
  const f=await fixture('claim');f.state.backing.model.flags=7;f.state.backing.model.latest_sequence=2n;f.state.backing.model.total_claimed=40n;f.state.root.revoked=true;
  f.state.miner.claimed_total=40n;f.state.miner.last_sequence=2n;f.state.miner.last_claim_at=f.state.root.published_at;
  f.state.renown.last_sequence=2n;f.state.renown.synced_at=f.state.root.published_at;
  await f.state.backing.config();await f.state.records();await f.state.encodeRoot();f.state.rows[12]=null;f.state.rows[13]=null;
  expect((await verify(f)).outcome).toBe('failed');
 });
 it('rejects unsigned, changed messages and mismatched signatures before RPC',async()=>{
  for(const change of ['signature','wire','root'] as const){const f=await fixture(),rpc=vi.fn(f.reader.getTransaction);f.reader.getTransaction=rpc;
   if(change==='signature')f.request.signature=bs58.encode(new Uint8Array(64).fill(1));else if(change==='wire')f.request.signedTransaction[1]=f.request.signedTransaction[1]!^1;else f.request.plan.root.fill(0);
   await expect(verify(f)).rejects.toMatchObject({code:'INPUT'});expect(rpc).not.toHaveBeenCalled();}
 });
 it('requires an actual failed transaction, never missing history, success or provider status',async()=>{
  let f=await fixture();f.reader.getTransaction=async()=>null;await expect(verify(f)).rejects.toMatchObject({code:'UNAVAILABLE'});
  f=await fixture();f.tx.meta!.err=null;await expect(verify(f)).rejects.toMatchObject({code:'TRANSACTION'});
  f=await fixture();f.reader.getTransaction=async()=>({context:{slot:150},value:[{err:'AccountInUse'}]} as never);await expect(verify(f)).rejects.toMatchObject({code:'TRANSACTION'});
 });
 it.each([{},'nonsense',{InstructionError:[999,'InvalidArgument']},{InstructionError:[0,'nonsense']},{InstructionError:[0,{Custom:-1}]},{InstructionError:[0,{Custom:4294967296}]},{InstructionError:[0,{BorshIoError:'x'.repeat(257)}]},{InstructionError:[0,{Custom:0,extra:true}]},{InsufficientFundsForRent:{account_index:255}},{DuplicateInstruction:999}])('refuses malformed or unbounded transaction error %#',async err=>{
  const f=await fixture();f.tx.meta!.err=err as never;await expect(verify(f)).rejects.toMatchObject({code:'TRANSACTION'});
 });
 it('accepts bounded valid legacy and indexed error variants',async()=>{
  const f=await fixture();for(const err of ['AccountInUse',{InstructionError:[0,'InvalidArgument']},{InstructionError:[0,{BorshIoError:'bounded legacy detail'}]},{InsufficientFundsForRent:{account_index:0}},{ProgramExecutionTemporarilyRestricted:{account_index:0}},{DuplicateInstruction:0}]){f.tx.meta!.err=err as never;expect((await verify(f)).outcome).toBe('failed');}
 });
 it.each(['data','blockhash','instructions','accounts'] as const)('bounds raw %s before decoding provider message',async field=>{
  const f=await fixture(),m=f.tx.transaction.message as Message;
  if(field==='data')m.instructions[0]!.data='1'.repeat(100000);else if(field==='blockhash')m.recentBlockhash='1'.repeat(100000);else if(field==='instructions')m.instructions=Array.from({length:4},()=>m.instructions[0]!);else m.instructions[0]!.accounts=Array.from({length:33},()=>0);
  const compiled=vi.spyOn(m,'compiledInstructions','get'),serialize=vi.spyOn(m,'serialize'),decode=vi.spyOn(bs58,'decode');f.reader.getTransaction=async()=>{decode.mockClear();return f.tx;};
  try{await expect(verify(f)).rejects.toMatchObject({code:'TRANSACTION'});expect(compiled).not.toHaveBeenCalled();expect(serialize).not.toHaveBeenCalled();expect(decode).not.toHaveBeenCalled();}finally{compiled.mockRestore();serialize.mockRestore();decode.mockRestore();}
 });
 it('rejects provider wire/signature/version substitution',async()=>{
  let f=await fixture();(f.tx.transaction.message as Message).recentBlockhash=Keypair.generate().publicKey.toBase58();await expect(verify(f)).rejects.toMatchObject({code:'TRANSACTION'});
  f=await fixture();f.tx.transaction.signatures[0]=bs58.encode(new Uint8Array(64).fill(2));await expect(verify(f)).rejects.toMatchObject({code:'TRANSACTION'});
  f=await fixture();f.tx.version=0;await expect(verify(f)).rejects.toMatchObject({code:'TRANSACTION'});
 });
 it('refuses missing metadata, fee/balance contradictions or changed token amounts',async()=>{
  let f=await fixture();f.tx.meta=null;await expect(verify(f)).rejects.toMatchObject({code:'TRANSACTION'});
  f=await fixture();delete f.tx.meta!.preBalances[1];await expect(verify(f)).rejects.toMatchObject({code:'TRANSACTION'});
  f=await fixture();f.tx.meta!.postBalances[1]=f.tx.meta!.postBalances[1]!+1;await expect(verify(f)).rejects.toMatchObject({code:'TRANSACTION'});
  f=await fixture();f.tx.meta!.postTokenBalances![0]!.uiTokenAmount.amount='99';await expect(verify(f)).rejects.toMatchObject({code:'TRANSACTION'});
  f=await fixture();f.tx.meta!.postTokenBalances![0]!.uiTokenAmount.amount='9'.repeat(100000);await expect(verify(f)).rejects.toMatchObject({code:'TRANSACTION'});
 });
 it('requires trusted genesis, reviewed bytes, source hash and observed bank after the transaction',async()=>{
  let f=await fixture();f.reader.getGenesisHash=async()=>Keypair.generate().publicKey.toBase58();await expect(verify(f)).rejects.toMatchObject({code:'IDENTITY'});
  f=await fixture();f.state.rows[5]!.data[49]=f.state.rows[5]!.data[49]!^1;await expect(verify(f)).rejects.toMatchObject({code:'DEPLOYMENT'});
  f=await fixture();f.request.sourceHash='ab'.repeat(32);await expect(verify(f)).rejects.toMatchObject({code:'ACCOUNTS'});
  f=await fixture();f.tx.slot=151;await expect(verify(f)).rejects.toMatchObject({code:'ACCOUNTS'});
  f=await fixture();f.tx.slot=129;await expect(verify(f)).rejects.toMatchObject({code:'TRANSACTION'});
  f=await fixture();f.tx.slot=90;await expect(verify(f)).rejects.toMatchObject({code:'TRANSACTION'});
 });
 it('does not invent missing cursor pairs or permit arbitrary account owners',async()=>{
  let f=await fixture('claim');f.state.rows[10]=null;await expect(verify(f)).rejects.toMatchObject({code:'ACCOUNTS'});
  f=await fixture('claim');f.state.rows[12]={...f.state.rows[12]!,owner:SystemProgram.programId};await expect(verify(f)).rejects.toMatchObject({code:'ACCOUNTS'});
 });
 it('owns immutable results and refuses a provider failure',async()=>{
  const f=await fixture(),r=await verify(f);f.request.sourceHash='ab'.repeat(32);f.request.plan.root.fill(0);expect(r.source.sourceHash).not.toBe(f.request.sourceHash);expect(Object.isFrozen(r)).toBe(true);expect(Object.isFrozen(r.source)).toBe(true);
  f.reader.getTransaction=async()=>{throw Error('offline');};const fresh=await fixture();fresh.reader.getTransaction=f.reader.getTransaction;await expect(verify(fresh)).rejects.toMatchObject({code:'UNAVAILABLE'});
 });
});
