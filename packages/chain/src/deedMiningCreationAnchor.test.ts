import { describe,it,expect,vi } from 'vitest';
import { Keypair,PublicKey,SystemProgram,TransactionMessage,type VersionedTransactionResponse } from '@solana/web3.js';
import { getCreateV1InstructionDataSerializer,getCreateV2InstructionDataSerializer,getTransferV1InstructionDataSerializer } from '@metaplex-foundation/mpl-core';
import bs58 from 'bs58';
import { readDeedMiningCreationAnchor,type DeedMiningCreationReader } from './deedMiningCreationAnchor';
const key=()=>Keypair.generate().publicKey,asset=key(),collection=key(),creator=key(),owner=key(),buyer=key(),genesis=key().toBase58();
const core=new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');let sequence=0;
function sig(){const b=Buffer.alloc(64,7);b.writeUInt32LE(++sequence);return bs58.encode(b);}
function transaction(kind:'create1'|'create2'|'transfer',slot=10,recipient=owner):VersionedTransactionResponse{
 const mint=kind!=='transfer',keys=mint?[asset,collection,creator,creator,recipient,core,SystemProgram.programId,core]:[asset,collection,creator,owner,recipient];
 const data=mint?(kind==='create1'?getCreateV1InstructionDataSerializer():getCreateV2InstructionDataSerializer()).serialize({name:'Deed',uri:'https://example.org/deed',dataState:0}):getTransferV1InstructionDataSerializer().serialize({});
 const message=new TransactionMessage({payerKey:creator,recentBlockhash:key().toBase58(),instructions:[{programId:core,
  keys:keys.map((pubkey,i)=>({pubkey,isSigner:pubkey.equals(creator)||(mint&&i===0),isWritable:i===0||i===1||pubkey.equals(creator)})),data:Buffer.from(data)}]}).compileToV0Message();
 return {version:0,slot,blockTime:slot*10,transaction:{message,signatures:Array.from({length:message.header.numRequiredSignatures},sig)},meta:{err:null,fee:1,preBalances:[],postBalances:[],innerInstructions:[]}};
}
function fixture(txs:VersionedTransactionResponse[]=[transaction('create2')]){
 const rows=txs.map(tx=>({signature:tx.transaction.signatures[0]!,slot:tx.slot,blockTime:tx.blockTime,err:tx.meta!.err,confirmationStatus:'finalized' as const})).sort((a,b)=>b.slot-a.slot);
 const reader={getGenesisHash:vi.fn().mockResolvedValue(genesis),getSlot:vi.fn().mockResolvedValue(20),
  getBlockTime:vi.fn().mockImplementation((slot:number)=>Promise.resolve(slot*10)),
  getSignaturesForAddress:vi.fn().mockResolvedValue(rows),
  getTransaction:vi.fn().mockImplementation((signature:string)=>Promise.resolve(txs.find(tx=>tx.transaction.signatures[0]===signature)??null)),
  getBlockSignatures:vi.fn().mockImplementation((slot:number)=>Promise.resolve({blockTime:slot*10,signatures:txs.filter(tx=>tx.slot===slot).map(tx=>tx.transaction.signatures[0])})),
 };
 return {reader,rows,read:(override={})=>readDeedMiningCreationAnchor(reader as unknown as DeedMiningCreationReader,{assetId:asset.toBase58(),collection:collection.toBase58(),expectedGenesisHash:genesis,...override})};
}
const refuse=(p:Promise<unknown>,code:string)=>expect(p).rejects.toMatchObject({name:'DeedMiningCreationAnchorError',code});
describe('finalized original deed creation and mint-slot boundary',()=>{
 it.each(['create1','create2'] as const)('derives explicit owner from %s, never substituting the creator signer',async kind=>{
  const f=fixture([transaction(kind)]),result=await f.read();
  expect(result).toMatchObject({originalOwner:owner.toBase58(),ownerAtMintSlot:owner.toBase58(),ownerAtHorizon:owner.toBase58(),anchor:{owner:owner.toBase58(),priorFinalizedSlot:'10'}});
  expect(result.originalOwner).not.toBe(creator.toBase58());expect(result.evidence.trust).toBe('trusted-finalized-rpc');
 });
 it('replays same-slot transfers in block order and preserves out-and-back transitions',async()=>{
  const mint=transaction('create2'),out=transaction('transfer',10,buyer),back=transaction('transfer',10,owner),later=transaction('transfer',11,buyer);
  const f=fixture([mint,out,back,later]);f.reader.getSignaturesForAddress.mockResolvedValue([f.rows[0]!,f.rows[3]!,f.rows[2]!,f.rows[1]!]);
  const result=await f.read();expect(result.ownerAtMintSlot).toBe(owner.toBase58());expect(result.ownerAtHorizon).toBe(buyer.toBase58());
  expect(result.evidence.sameSlotTransactions.flatMap(t=>t.transitions).map(t=>t.to)).toEqual([buyer.toBase58(),owner.toBase58()]);
  expect((await f.read({throughSlot:'10'})).ownerAtHorizon).toBe(owner.toBase58());
 });
 it('keeps original owner distinct when the asset transfers before the mint slot ends',async()=>{
  const r=await fixture([transaction('create2'),transaction('transfer',10,buyer)]).read();
  expect(r.originalOwner).toBe(owner.toBase58());expect(r.anchor.owner).toBe(buyer.toBase58());
 });
 it('ignores rolled-back transfers without reporting attempted transitions',async()=>{
  const tx=transaction('transfer',10,buyer);tx.meta!.err={InstructionError:[0,'InvalidArgument']};
  const r=await fixture([transaction('create2'),tx]).read();expect(r.ownerAtMintSlot).toBe(owner.toBase58());expect(r.evidence.sameSlotTransactions[0]!.transitions).toEqual([]);
 });
 it.each(['fallback','extra','cpi','trailing','version','unsigned'] as const)('refuses unsupported mint %s evidence',async kind=>{
  const tx=transaction('create2'),ix=tx.transaction.message.compiledInstructions[0]!;
  if(kind==='fallback')ix.accountKeyIndexes[4]=ix.programIdIndex;
  if(kind==='extra')tx.transaction.message.compiledInstructions.push({...ix,data:getTransferV1InstructionDataSerializer().serialize({})});
  if(kind==='cpi')tx.meta!.innerInstructions=[{index:0,instructions:[{programIdIndex:ix.programIdIndex,accounts:[...ix.accountKeyIndexes],data:bs58.encode(ix.data)}]}];
  if(kind==='trailing')ix.data=Uint8Array.from([...ix.data,0]);
  if(kind==='version')Object.assign(tx,{version:1});
  if(kind==='unsigned'){tx.transaction.message.header.numRequiredSignatures=1;tx.transaction.signatures=tx.transaction.signatures.slice(0,1);}
  await refuse(fixture([tx]).read(),'UNSUPPORTED_HISTORY');
 });
 it('rejects recreated assets, unsupported mutation and successful effects before creation',async()=>{
  await refuse(fixture([transaction('create1'),transaction('create2',11)]).read(),'UNSUPPORTED_HISTORY');
  const burn=transaction('transfer',11);burn.transaction.message.compiledInstructions[0]!.data=new Uint8Array([12]);
  await refuse(fixture([transaction('create2'),burn]).read(),'UNSUPPORTED_HISTORY');
  await refuse(fixture([transaction('transfer',9),transaction('create2')]).read(),'HISTORY_INCOMPLETE');
 });
 it.each(['signature','slot','time','block','duplicate','collection','keys','trace'] as const)('refuses contradictory %s bindings',async kind=>{
  const tx=transaction('create2'),f=fixture([tx]),ix=tx.transaction.message.compiledInstructions[0]!;
  if(kind==='signature')f.reader.getTransaction.mockResolvedValue({...tx,transaction:{...tx.transaction,signatures:[sig(),sig()]}});
  if(kind==='slot')f.reader.getTransaction.mockResolvedValue({...tx,slot:11});
  if(kind==='time')f.reader.getBlockTime.mockResolvedValue(201);
  if(kind==='block')f.reader.getBlockSignatures.mockResolvedValue({signatures:[]});
  if(kind==='duplicate')f.reader.getBlockSignatures.mockResolvedValue({signatures:[tx.transaction.signatures[0],tx.transaction.signatures[0]]});
  if(kind==='collection')ix.accountKeyIndexes[1]=ix.accountKeyIndexes[4]!;
  if(kind==='keys')ix.accountKeyIndexes[0]=250;
  if(kind==='trace')tx.meta!.innerInstructions=null;
  await expect(f.read()).rejects.toHaveProperty('code');
 });
 it('detects an omitted mint-slot transaction using the finalized block inventory',async()=>{
  const mint=transaction('create2'),transfer=transaction('transfer',10,buyer),f=fixture([mint,transfer]);
  f.reader.getSignaturesForAddress.mockResolvedValue([f.rows[0]!]);await refuse(f.read(),'HISTORY_INCOMPLETE');
 });
 it('refuses a busy mint block before fetching beyond the shared transaction budget',async()=>{
  const mint=transaction('create2'),f=fixture([mint]);
  f.reader.getBlockSignatures.mockResolvedValue({blockTime:100,signatures:[mint.transaction.signatures[0]!,...Array.from({length:2000},sig)]});
  await refuse(f.read(),'TOO_LARGE');expect(f.reader.getTransaction).toHaveBeenCalledTimes(1);
 });
 it('rejects missing history, missing bodies, genesis mismatch and a regressing finalized context',async()=>{
  const empty=fixture([]);await refuse(empty.read(),'HISTORY_INCOMPLETE');
  const missing=fixture();missing.reader.getTransaction.mockResolvedValue(null);await refuse(missing.read(),'HISTORY_INCOMPLETE');
  const genesisMismatch=fixture();genesisMismatch.reader.getGenesisHash.mockResolvedValue(key().toBase58());await refuse(genesisMismatch.read(),'GENESIS_MISMATCH');
  const regression=fixture();regression.reader.getSlot.mockResolvedValueOnce(20).mockResolvedValueOnce(19);await refuse(regression.read(),'CONTEXT_REGRESSION');
  await refuse(fixture().read({throughSlot:'21'}),'CONTEXT_REGRESSION');
 });
 it('bounds pagination, malformed structures, unknown caller authority and transport failures',async()=>{
  const f=fixture();f.reader.getSignaturesForAddress.mockImplementation(()=>Promise.resolve(Array.from({length:1000},()=>({signature:sig(),slot:19,blockTime:190,err:null,confirmationStatus:'finalized'}))));
  await refuse(f.read(),'TOO_LARGE');
  const malformed=fixture();malformed.reader.getSignaturesForAddress.mockResolvedValue([null]);await refuse(malformed.read(),'EVIDENCE_CONFLICT');
  await refuse(fixture().read({owner:owner.toBase58()}),'INVALID_INPUT');await refuse(fixture().read({assetId:'1'.repeat(100_000)}),'INVALID_INPUT');
  const offline=fixture();offline.reader.getSlot.mockRejectedValue(Error('offline'));await refuse(offline.read(),'READER_UNAVAILABLE');
 });
});
