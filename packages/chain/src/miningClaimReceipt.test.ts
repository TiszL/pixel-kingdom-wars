import {Keypair,Message,SystemProgram} from '@solana/web3.js';
import bs58 from 'bs58';
import {describe,it,expect,vi} from 'vitest';
import {createMiningClaimReceiptFixture as fixture,prefundMiningClaimReceiptAta} from './testFixtures/miningClaimReceipt';
import {createMiningClaimReceiptVerifier,MiningClaimReceiptError} from './miningClaimReceipt';
import {createMiningClaimSnapshotReader} from './miningClaimSnapshot';

const verify=(f:Awaited<ReturnType<typeof fixture>>)=>createMiningClaimReceiptVerifier(f.reader,f.state.trust)(f.request);
async function refused(f:Awaited<ReturnType<typeof fixture>>,code?:string){await expect(verify(f)).rejects.toBeInstanceOf(MiningClaimReceiptError);if(code)await expect(verify(f)).rejects.toMatchObject({code});}
describe('historical claimant receipts from exact wire and finalized raw evidence',()=>{
 it.each(['combined','claim','setup'] as const)('verifies actual serialized %s, with historical payment rather than UI estimate',async kind=>{
  const f=await fixture(kind),result=await verify(f);expect(result.kind).toBe(kind);expect(result.paidKeepBaseUnits).toBe(f.payment.toString());expect(result.sequence).toBe('1');expect(result.wallet).toBe(f.signer.publicKey.toBase58());expect(result.currentClaimsAuthorized).toBe(false);expect(result.slot).toBe(140);expect(result.observedAccountSlot).toBe(150);expect(result.source.sourceHash).toBe(f.request.sourceHash);expect(()=>JSON.stringify(result)).not.toThrow();
 });
 it.each([['combined',7],['combined',1_000_000],['combined',1_500_000],['setup',7],['setup',1_000_000],['setup',1_500_000]] as const)('recovers %s with %s prefunded ATA lamports and only the actual payer shortfall',async(kind,lamports)=>{
  const f=await fixture(kind),wire=Buffer.from(f.request.signedTransaction);prefundMiningClaimReceiptAta(f,lamports);
  const result=await verify(f);expect(result.kind).toBe(kind);expect(result.paidKeepBaseUnits).toBe(f.payment.toString());expect(result.currentClaimsAuthorized).toBe(false);expect(Buffer.from(f.request.signedTransaction)).toEqual(wire);
 });
 it.each(['combined','setup'] as const)('refuses %s prefunding without exact ordered initialization and conserved payer costs',async kind=>{
  for(const mutation of ['size-query','immutable-owner','allocate','assign','initialize','owner','space','amount','target','payer-account','order','depth','duplicate','fee','payer-delta','unrelated-delta','extra-transfer','pre-token-row']){
   const f=await fixture(kind);prefundMiningClaimReceiptAta(f,7);const meta=f.tx.meta!,group=meta.innerInstructions![0]!,system=f.index(SystemProgram.programId.toBase58());
   const position=(tag:number)=>group.instructions.findIndex(ix=>ix.programIdIndex===system&&Buffer.from(bs58.decode(ix.data)).readUInt32LE(0)===tag);
   if(mutation==='allocate'||mutation==='assign')group.instructions.splice(position(mutation==='allocate'?8:1),1);
   if(mutation==='initialize')group.instructions.pop();
   if(mutation==='size-query')group.instructions.shift();
   if(mutation==='immutable-owner')group.instructions.splice(group.instructions.findIndex(ix=>ix.programIdIndex!==system&&bs58.decode(ix.data)[0]===22),1);
   if(['owner','space','amount'].includes(mutation)){const ix=group.instructions[position(mutation==='owner'?1:mutation==='space'?8:2)]!,data=Buffer.from(bs58.decode(ix.data));if(mutation==='owner')Keypair.generate().publicKey.toBuffer().copy(data,4);else data.writeBigUInt64LE(1n,4);ix.data=bs58.encode(data);}
   if(mutation==='target')group.instructions[position(2)]!.accounts[1]=0;
   if(mutation==='payer-account')group.instructions[position(2)]!.accounts[0]=f.index(f.state.rows[12]!.address.toBase58());
   if(mutation==='order'){const a=position(8),b=position(1);[group.instructions[a],group.instructions[b]]=[group.instructions[b]!,group.instructions[a]!];}
   if(mutation==='depth')Object.assign(group.instructions[position(2)]!,{stackHeight:3});
   if(mutation==='duplicate')group.instructions.splice(position(8),0,group.instructions[position(8)]!);
   if(mutation==='fee')meta.fee++;
   if(mutation==='payer-delta')meta.postBalances[0]!++;
   if(mutation==='unrelated-delta')meta.postBalances[f.index(f.state.trust.keepMint.toBase58())]!++;
   if(mutation==='extra-transfer')group.instructions.push(group.instructions[position(2)]!);
   if(mutation==='pre-token-row')meta.preTokenBalances!.push({...meta.postTokenBalances!.at(-1)!,uiTokenAmount:{...meta.postTokenBalances!.at(-1)!.uiTokenAmount,amount:'0'}});
   await expect(verify(f),mutation).rejects.toBeInstanceOf(MiningClaimReceiptError);
  }
 });
 it('recovers a historical claim after pause, later cursors and an emptied System payer',async()=>{
  const f=await fixture('claim');f.state.backing.model.flags=7;f.state.backing.model.latest_sequence=2n;f.state.miner.last_sequence=2n;f.state.renown.last_sequence=2n;f.state.root.revoked=true;f.state.rows[13]=null;await f.state.backing.config();await f.state.records();await f.state.encodeRoot();expect((await verify(f)).paidKeepBaseUnits).toBe('50');
 });
 it('accepts setup history after its records have progressed from a later claim',async()=>{
  const f=await fixture('setup');f.state.miner.claimed_total=40n;f.state.miner.last_sequence=1n;f.state.miner.last_claim_at=f.state.root.published_at+7200n;f.state.renown.last_sequence=1n;f.state.renown.synced_at=f.state.miner.last_claim_at;f.state.backing.model.total_claimed=40n;await f.state.backing.config();await f.state.records();expect((await verify(f)).paidKeepBaseUnits).toBe('0');
 });
 it('rejects a different or unsigned wallet wire before RPC',async()=>{
  const f=await fixture();let calls=0;f.reader.getTransaction=async()=>{calls++;return f.tx;};const wire=Uint8Array.from(f.request.signedTransaction);wire[1]=wire[1]!^1;f.request.signedTransaction=wire;await refused(f,'INPUT');expect(calls).toBe(0);
 });
 it('rejects changed saved root, source, kind or signature',async()=>{
  let f=await fixture();f.request.plan.root.fill(0);await refused(f);
  f=await fixture();f.request.sourceHash='ab'.repeat(32);await refused(f,'ACCOUNTS');
  f=await fixture();f.request.kind='setup';await refused(f,'INPUT');
  f=await fixture();f.request.signature=bs58.encode(new Uint8Array(64).fill(1));await refused(f,'INPUT');
 });
 it('rejects RPC message/signature substitution even if RPC says successful',async()=>{
  let f=await fixture();f.tx.transaction.signatures[0]=bs58.encode(new Uint8Array(64).fill(1));await refused(f,'TRANSACTION');
  f=await fixture();const message=Message.from(f.planned.transactions[0]!.messageBytes);message.recentBlockhash=Keypair.generate().publicKey.toBase58();f.tx.transaction.message=message;await refused(f,'TRANSACTION');
 });
 it.each(['instruction','blockhash','instruction-count','accounts'] as const)('bounds raw legacy %s before the compiled getter or base58 decoding',async field=>{
  const f=await fixture('claim'),message=f.tx.transaction.message as Message;
  if(field==='instruction')message.instructions[0]!.data='1'.repeat(100000);
  else if(field==='blockhash')message.recentBlockhash='1'.repeat(100000);
  else if(field==='instruction-count')message.instructions=Array.from({length:4},()=>message.instructions[0]!);
  else message.instructions[0]!.accounts=Array.from({length:33},()=>0);
  const compiled=vi.spyOn(message,'compiledInstructions','get'),serialized=vi.spyOn(message,'serialize'),decode=vi.spyOn(bs58,'decode');
  // Preparation and local signature verification may decode bounded local bytes.
  // Observe only the point after the provider returns this malformed message.
  f.reader.getTransaction=async()=>{decode.mockClear();return f.tx;};
  try{await expect(verify(f)).rejects.toMatchObject({code:'TRANSACTION'});expect(compiled).not.toHaveBeenCalled();expect(serialized).not.toHaveBeenCalled();expect(decode).not.toHaveBeenCalled();}
  finally{compiled.mockRestore();serialized.mockRestore();decode.mockRestore();}
 });
 it('rejects missing, failed, unfinalized context and pre-deployment transaction evidence',async()=>{
  let f=await fixture();f.reader.getTransaction=async()=>null;await refused(f,'UNAVAILABLE');
  f=await fixture();f.tx.meta!.err={InstructionError:[0,'InvalidArgument']};await refused(f,'TRANSACTION');
  f=await fixture();f.tx.slot=90;await refused(f,'TRANSACTION');
  f=await fixture();f.tx.slot=129;await refused(f,'TRANSACTION');
  f=await fixture();f.tx.slot=151;await refused(f,'ACCOUNTS');
 });
 it('requires the trusted genesis and exact current reviewed ProgramData bytes',async()=>{
  let f=await fixture();f.reader.getGenesisHash=async()=>Keypair.generate().publicKey.toBase58();await refused(f,'IDENTITY');
  f=await fixture();f.state.rows[5]!.data[49]=8;await refused(f,'DEPLOYMENT');
 });
 it('rejects payment deltas with wrong recipient, mint, missing metadata, oversized decimals or duplicate legs',async()=>{
  let f=await fixture();f.tx.meta!.postTokenBalances![1]!.owner=Keypair.generate().publicKey.toBase58();await refused(f,'PAYMENT');
  f=await fixture();f.tx.meta!.postTokenBalances![1]!.mint=Keypair.generate().publicKey.toBase58();await refused(f,'PAYMENT');
  f=await fixture();delete f.tx.meta!.preTokenBalances;await refused(f,'PAYMENT');
  f=await fixture();f.tx.meta!.postTokenBalances![1]!.uiTokenAmount.amount='9'.repeat(100000);await refused(f,'PAYMENT');
  f=await fixture();f.tx.meta!.postTokenBalances!.push(f.tx.meta!.postTokenBalances![1]!);await refused(f,'PAYMENT');
 });
 it('refuses zero/mismatched/excess payment or ATA omission without prepared creation',async()=>{
  let f=await fixture();f.tx.meta!.postTokenBalances![1]!.uiTokenAmount.amount='49';await refused(f,'PAYMENT');
  f=await fixture();f.tx.meta!.postTokenBalances![0]!.uiTokenAmount.amount='100';f.tx.meta!.postTokenBalances![1]!.uiTokenAmount.amount='0';await refused(f,'PAYMENT');
  f=await fixture('claim');f.tx.meta!.preTokenBalances!.pop();await refused(f,'PAYMENT');
  f=await fixture();f.tx.meta!.preBalances[f.index(f.state.rows[12]!.address.toBase58())]=1;await refused(f,'PAYMENT');
 });
 it('requires one exact TransferChecked attributed directly to the reviewed claim instruction',async()=>{
  let f=await fixture();f.tx.meta!.innerInstructions!.pop();await refused(f,'PAYMENT');
  f=await fixture();const group=f.tx.meta!.innerInstructions!.at(-1)!;group.index=0;await refused(f);
  f=await fixture();const ix=f.tx.meta!.innerInstructions!.at(-1)!.instructions[0]!;ix.accounts[2]=ix.accounts[0]!;await refused(f,'PAYMENT');
  f=await fixture();Object.assign(f.tx.meta!.innerInstructions!.at(-1)!.instructions[0]!,{stackHeight:3});await refused(f,'TRANSACTION');
  f=await fixture();f.tx.meta!.innerInstructions!.at(-1)!.instructions.push(f.tx.meta!.innerInstructions!.at(-1)!.instructions[0]!);await refused(f,'PAYMENT');
 });
 it('setup cannot hide a token transfer or omit permanent resulting records',async()=>{
  let f=await fixture('setup');const ix=f.tx.meta!.innerInstructions![0]!.instructions[0]!;ix.data=bs58.encode(Buffer.of(3,0,0,0,0,0,0,0,0));await refused(f,'PAYMENT');
  f=await fixture('setup');f.state.rows[10]=null;f.state.rows[11]=null;await refused(f,'ACCOUNTS');
 });
 it.each(['closed','delegated','close-authority'] as const)('preserves the historical receipt after payout ATA is %s',async kind=>{
  const f=await fixture('claim');
  if(kind==='closed')f.state.rows[12]=null;
  else{
   const ata=Buffer.from(f.state.rows[12]!.data.buffer,f.state.rows[12]!.data.byteOffset,f.state.rows[12]!.data.byteLength);
   if(kind==='delegated'){ata.writeUInt32LE(1,72);Keypair.generate().publicKey.toBuffer().copy(ata,76);ata.writeBigUInt64LE(50n,121);}
   else{ata.writeUInt32LE(1,129);Keypair.generate().publicKey.toBuffer().copy(ata,133);}
   await expect(createMiningClaimSnapshotReader(f.state.reader,f.state.trust)(f.state.request)).rejects.toMatchObject({code:'TOKEN'});
  }
  const result=await verify(f);expect(result.paidKeepBaseUnits).toBe('50');expect(result.currentClaimsAuthorized).toBe(false);
 });
 it('preserves a proven setup receipt when its ATA is closed after setup',async()=>{
  const f=await fixture('setup');f.state.rows[12]=null;const result=await verify(f);expect(result.kind).toBe('setup');expect(result.paidKeepBaseUnits).toBe('0');expect(result.currentClaimsAuthorized).toBe(false);
 });
 it.each(['reassigned-owner','closed-SOL-funded'] as const)('preserves payment history after ATA %s without granting current admission',async kind=>{
  const f=await fixture('claim');
  if(kind==='closed-SOL-funded')f.state.rows[12]={...f.state.rows[12]!,owner:SystemProgram.programId,data:Buffer.alloc(0),lamports:123};
  else{const ata=Buffer.from(f.state.rows[12]!.data.buffer,f.state.rows[12]!.data.byteOffset,f.state.rows[12]!.data.byteLength);Keypair.generate().publicKey.toBuffer().copy(ata,32);}
  await expect(createMiningClaimSnapshotReader(f.state.reader,f.state.trust)(f.state.request)).rejects.toMatchObject({code:'TOKEN'});
  const result=await verify(f);expect(result.paidKeepBaseUnits).toBe('50');expect(result.currentClaimsAuthorized).toBe(false);
 });
 it('current state must retain the claimed cumulative cursor and a root use',async()=>{
  let f=await fixture();f.state.root.claims_count=0n;await f.state.encodeRoot();await refused(f,'ACCOUNTS');
  f=await fixture();f.state.miner.claimed_total=79n;await f.state.records();await refused(f,'ACCOUNTS');
 });
 it('rejects malformed dense metadata and absent CPI attribution rather than inferring success',async()=>{
  let f=await fixture();delete f.tx.meta!.preBalances[0];await refused(f,'TRANSACTION');
  f=await fixture();Object.assign(f.tx.meta!.innerInstructions!.at(-1)!.instructions[0]!,{stackHeight:null});await refused(f,'TRANSACTION');
  f=await fixture();f.tx.meta!.innerInstructions=null;await refused(f,'TRANSACTION');
 });
 it('provider failure remains unavailable, and result facts do not alias mutable input',async()=>{
  const f=await fixture('claim'),result=await verify(f);f.tx.meta!.postTokenBalances![1]!.uiTokenAmount.amount='0';f.request.plan.root.fill(0);expect(result.paidKeepBaseUnits).toBe('50');expect(Object.isFrozen(result)).toBe(true);
  f.reader.getTransaction=async()=>{throw new Error('offline');};await refused(f);
 });
});
