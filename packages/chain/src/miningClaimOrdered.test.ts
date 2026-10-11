import {createHash} from 'node:crypto';
import {ComputeBudgetProgram,Keypair,Message,MessageV0,PublicKey,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {describe,expect,it,vi} from 'vitest';
import {PHASE_E_MINING_CLAIM_FORMAT} from '@shardkeep/shared';
import {buildMiningClaimMessages} from './miningClaimMessage';
import {copyMiningClaimFormat,miningClaimLookupTable,miningClaimV0Accounts,type MiningClaimFormat} from './miningClaimFormat';
import {verifyMiningClaimSignedWire} from './miningClaimWire';
import {createMiningClaimReceiptVerifier} from './miningClaimReceipt';
import {createMiningClaimFailureVerifier} from './miningClaimFailure';
import {miningClaimOrderedMessageFixture as fixture,miningClaimOrderedReceiptFixture} from './testFixtures/miningClaimOrdered';

const receipt=(f:Awaited<ReturnType<typeof miningClaimOrderedReceiptFixture>>)=>createMiningClaimReceiptVerifier(f.reader,f.state.trust)(f.request);
const failure=(f:Awaited<ReturnType<typeof miningClaimOrderedReceiptFixture>>)=>createMiningClaimFailureVerifier(f.reader,f.state.trust)(f.request);
function alterData(format:MiningClaimFormat,mutate:(b:Buffer)=>void):MiningClaimFormat{const b=Buffer.from(format.lookupTable.dataHex,'hex');mutate(b);return {...format,lookupTable:{...format.lookupTable,dataHex:b.toString('hex')},expectedLookupTable:{...format.expectedLookupTable,dataSha256:createHash('sha256').update(b).digest('hex')}};}
describe('explicit ordered v0 mining transport',()=>{
 it.each([14,15,16])('keeps depth %i setup and claim within the actual signed packet with compute budget',depth=>{
  const f=fixture(depth),legacy=buildMiningClaimMessages(f.identity,f.input),planned=buildMiningClaimMessages(f.identity,f.input,f.format);
  expect(buildMiningClaimMessages(f.identity,{...f.input,needsAta:false,needsMinerRecords:false},f.format).transactions[0]!.messageBytes).toEqual(planned.transactions[1]!.messageBytes);
  expect(planned.mode).toBe('split');expect(planned.transactions.map(t=>t.kind)).toEqual(['setup','claim']);
  expect(Message.from(legacy.transactions[0]!.messageBytes).version).toBe('legacy');
  for(const tx of planned.transactions){const message=MessageV0.deserialize(tx.messageBytes),signed=new VersionedTransaction(message);signed.sign([f.signer]);expect(signed.serialize().length).toBe(tx.packetBytes);expect(tx.packetBytes).toBeLessThanOrEqual(1232);
   const decoded=TransactionMessage.decompile(message,{addressLookupTableAccounts:[miningClaimLookupTable(f.format)]});expect(decoded.instructions[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);expect(decoded.instructions[0]!.data).toEqual(ComputeBudgetProgram.setComputeUnitLimit({units:PHASE_E_MINING_CLAIM_FORMAT.computeUnitLimit}).data);
   expect(verifyMiningClaimSignedWire({intentBytes:tx.messageBytes,signedTransaction:signed.serialize(),wallet:f.signer.publicKey,format:f.format}).messageSha256).toBe(tx.messageSha256);
   expect(()=>verifyMiningClaimSignedWire({intentBytes:tx.messageBytes,signedTransaction:signed.serialize(),wallet:f.signer.publicKey})).toThrow();
  }
  expect(buildMiningClaimMessages(f.identity,f.input,f.format).transactions.map(t=>t.messageSha256)).toEqual(planned.transactions.map(t=>t.messageSha256));
 });
 it.each([[false,true],[true,false],[false,false]])('only prepares missing accounts: ATA %s records %s', (needsAta,needsMinerRecords)=>{
  const f=fixture(14,needsAta,needsMinerRecords),p=buildMiningClaimMessages(f.identity,f.input,f.format);expect(p.transactions.map(t=>t.kind)).toEqual(needsAta||needsMinerRecords?['setup','claim']:['claim']);
  if(!needsAta&&needsMinerRecords)expect(MessageV0.deserialize(p.transactions[0]!.messageBytes).addressTableLookups).toEqual([]);
 });
 it('refuses mutable, deactivated, swapped, extra, stale, wrong-owner or unpinned tables',()=>{
  const f=fixture();const bad=[{...f.format,version:2},{...f.format,preset:'whatever'},{...f.format,extra:true},{...f.format,lookupTable:{...f.format.lookupTable,owner:f.signer.publicKey.toBase58()}},{...f.format,lookupTable:{...f.format.lookupTable,executable:true}},{...f.format,expectedLookupTable:{...f.format.expectedLookupTable,dataSha256:'00'.repeat(32)}},{...f.format,expectedLookupTable:{...f.format.expectedLookupTable,address:f.signer.publicKey.toBase58()}},{...f.format,blockhashContextSlot:119},
   alterData(f.format,b=>{b[21]=1;}),alterData(f.format,b=>{b.writeBigUInt64LE(119n,4);}),alterData(f.format,b=>{b.writeBigUInt64LE(120n,12);}),alterData(f.format,b=>{f.signer.publicKey.toBuffer().copy(b,56);}),alterData(f.format,b=>{f.identity.programId.toBuffer().copy(b,56);}),alterData(f.format,b=>{ComputeBudgetProgram.programId.toBuffer().copy(b,56);})];
  for(const value of bad)expect(()=>buildMiningClaimMessages(f.identity,f.input,value as MiningClaimFormat)).toThrow();
  const copied=copyMiningClaimFormat(f.format,f.identity);expect(Object.isFrozen(copied.lookupTable)).toBe(true);expect(JSON.parse(JSON.stringify(copied))).toEqual(f.format);
 });
 it('rejects substituted signed message, signature, version and lookup index while preserving exact bytes',()=>{
  const f=fixture(),selected=buildMiningClaimMessages(f.identity,f.input,f.format).transactions[1]!,message=MessageV0.deserialize(selected.messageBytes),tx=new VersionedTransaction(message);tx.sign([f.signer]);const wire=tx.serialize(),input={intentBytes:selected.messageBytes,signedTransaction:wire,wallet:f.signer.publicKey,format:f.format};
  const accepted=verifyMiningClaimSignedWire(input);wire[1]=wire[1]!^1;expect(()=>verifyMiningClaimSignedWire(input)).toThrow();expect(accepted.signedTransaction).not.toEqual(wire);
  tx.sign([f.signer]);message.recentBlockhash=Keypair.generate().publicKey.toBase58();tx.sign([f.signer]);expect(()=>verifyMiningClaimSignedWire({...input,signedTransaction:tx.serialize()})).toThrow();
  message.addressTableLookups[0]!.writableIndexes[0]=3;expect(()=>miningClaimV0Accounts(message,f.format)).toThrow();
 });
 it.each(['setup','claim'] as const)('authenticates %s finalized history through exact loaded keys and frozen raw table',async kind=>{
  const f=await miningClaimOrderedReceiptFixture(kind),result=await receipt(f);expect(result.kind).toBe(kind);expect(result.paidKeepBaseUnits).toBe(f.payment.toString());expect(result.currentClaimsAuthorized).toBe(false);
 });
 it('retains prefunded ATA shortfall accounting under ordered setup',async()=>{const f=await miningClaimOrderedReceiptFixture('setup',false,7);expect((await receipt(f)).paidKeepBaseUnits).toBe('0');f.tx.meta!.postBalances[0]!++;await expect(receipt(f)).rejects.toMatchObject({code:'PAYMENT'});});
 it.each(['writable','readonly','owner','bytes','slot','missing'] as const)('refuses %s ALT evidence substitution',async kind=>{
  const f=await miningClaimOrderedReceiptFixture('claim');
  if(kind==='writable'||kind==='readonly')f.tx.meta!.loadedAddresses![kind][0]=Keypair.generate().publicKey;
  else if(kind==='owner')f.lookupRow.owner=Keypair.generate().publicKey;
  else if(kind==='bytes')f.lookupRow.data[56]=f.lookupRow.data[56]!^1;
  else if(kind==='missing')delete f.tx.meta!.loadedAddresses;
  else{const old=f.reader.getMultipleAccountsInfoAndContext;f.reader.getMultipleAccountsInfoAndContext=async(k,o)=>k.length===1?{context:{slot:139},value:[f.lookupRow]}:old(k,o);}
  await expect(receipt(f)).rejects.toMatchObject({code:kind==='writable'||kind==='readonly'||kind==='missing'?'TRANSACTION':'ACCOUNTS'});
 });
 it('requires both the original context and actual provider message without invoking provider serialize',async()=>{
  let f=await miningClaimOrderedReceiptFixture('claim');f.request.blockhashContextSlot++;await expect(receipt(f)).rejects.toMatchObject({code:'INPUT'});
  f=await miningClaimOrderedReceiptFixture('claim');f.message.compiledInstructions[1]!.data=new Uint8Array(100_000);const spy=vi.spyOn(f.message,'serialize');await expect(receipt(f)).rejects.toMatchObject({code:'TRANSACTION'});expect(spy).not.toHaveBeenCalled();
 });
 it('keeps historical payment valid after pause and ATA closure, but refuses forged transfer effects',async()=>{
  const f=await miningClaimOrderedReceiptFixture('claim');f.state.backing.model.flags=7;await f.state.backing.config();f.state.rows[12]=null;expect((await receipt(f)).paidKeepBaseUnits).toBe('50');f.tx.meta!.postTokenBalances![1]!.uiTokenAmount.amount='51';await expect(receipt(f)).rejects.toMatchObject({code:'PAYMENT'});
 });
 it.each(['setup','claim'] as const)('authenticates failed %s rollback with fee only and no payment authority',async kind=>{
  const f=await miningClaimOrderedReceiptFixture(kind,true);expect((await failure(f)).outcome).toBe('failed');f.tx.meta!.postBalances[1]!++;await expect(failure(f)).rejects.toMatchObject({code:'TRANSACTION'});
 });
 it('failure cannot bypass loaded-address or frozen-table authentication',async()=>{
  let f=await miningClaimOrderedReceiptFixture('claim',true);f.tx.meta!.loadedAddresses!.readonly.reverse();f.tx.meta!.loadedAddresses!.readonly.push(Keypair.generate().publicKey);await expect(failure(f)).rejects.toMatchObject({code:'TRANSACTION'});
  f=await miningClaimOrderedReceiptFixture('claim',true);f.lookupRow.data[0]=2;await expect(failure(f)).rejects.toMatchObject({code:'ACCOUNTS'});
 });
});
