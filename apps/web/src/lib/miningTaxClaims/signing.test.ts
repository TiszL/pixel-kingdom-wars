import {createHash} from 'node:crypto';
import {Keypair,Message,PublicKey,SystemProgram,Transaction,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {describe,it,expect,vi} from 'vitest';
import {MiningTaxClaimPreparationSchema,type MiningTaxClaimPreparation} from '@shardkeep/shared/miningTaxClaimsApi';
import {createCurrentMiningTaxFixture} from '../../../../../packages/chain/src/testFixtures/miningTaxPreparationCurrent';
import {validateMiningTaxPreparationMessages} from '../../../../../packages/chain/src/miningTaxPreparation';
import {buildOpenMiningTaxPoolInstruction,buildOpenMiningTaxSpotInstruction,buildAccrueMiningTaxInstruction,buildClaimMiningTaxInstruction,miningTaxEpochReceiptPda,MINING_TAX_ACCOUNT_BYTES} from '../../../../../packages/chain/src/miningTaxProtocol';
import {miningEpochPda} from '../../../../../packages/chain/src/miningProgramProtocol';
import type {GameWallet} from '../../auth/useGameWallet';
import {prepareMiningTaxClaimSigning,signMiningTaxClaim,verifySignedMiningTaxClaim,type MiningTaxClaimSigningTrust} from './signing';
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function fixture(kind:'claim'|'combined'|'split'='combined',ordinal=0){const raw=createCurrentMiningTaxFixture(kind),p=MiningTaxClaimPreparationSchema.parse(raw.preparation);const trust:MiningTaxClaimSigningTrust={genesisHash:p.identity.genesisHash,programId:p.identity.programId,configAddress:p.identity.configAddress,keepMint:p.identity.keepMint,reserveOwner:p.identity.reserveOwner,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,reviewedProgramDataSha256:p.source.reviewedProgramDataSha256};return {p,trust,ordinal,wire:Buffer.from(raw.wires[ordinal]!.signedTransactionHex,'hex').toString('base64')};}
function wallet(f:ReturnType<typeof fixture>,sign?:(tx:Transaction)=>Promise<Transaction>):GameWallet{return {publicKey:new PublicKey(f.p.wallet),signMessage:null,isEmbedded:false,sendTransaction:vi.fn(),signTransaction:vi.fn(sign??(async()=>Transaction.from(Buffer.from(f.wire,'base64'))))};}
function replaceMessage(p:MiningTaxClaimPreparation,ordinal:number,tx:Transaction){const bytes=tx.serializeMessage();p.transactions[ordinal]!.messageHex=Buffer.from(bytes).toString('hex');p.transactions[ordinal]!.messageSha256=hash(bytes);p.transactions[ordinal]!.packetBytes=bytes.length+65;}
function setupFixture(needsAta:boolean,needsPool:boolean,needsCursor:boolean,days:number){
 const f=fixture('split'),p=f.p,i=p.identity,program=new PublicKey(i.programId),owner=new PublicKey(p.wallet),config=new PublicKey(i.configAddress);
 const term={programId:program,config,keepMint:new PublicKey(i.keepMint),auctionConfig:new PublicKey(i.auctionConfig),term:new PublicKey(i.term),registry:new PublicKey(i.registry),registryHash:Buffer.from(i.registryHash,'hex'),round:BigInt(p.round),auctionStart:BigInt(p.term.auctionStart),auctionEnd:BigInt(p.term.auctionEnd),operatingStart:BigInt(p.term.operatingStart),operatingEnd:BigInt(p.term.operatingEnd),winnerCount:p.term.winnerCount};
 const ata=Transaction.populate(Message.from(Buffer.from(p.transactions[0]!.messageHex,'hex'))).instructions[0]!,setup:TransactionInstruction[]=[],accounts:{address:string;space:number;rentLamports:string}[]=[];
 if(needsAta){setup.push(ata);accounts.push({address:i.claimantAta,space:165,rentLamports:'100'});}if(needsPool){setup.push(buildOpenMiningTaxPoolInstruction(term,{payer:owner}));accounts.push({address:i.pool,space:MINING_TAX_ACCOUNT_BYTES.MiningTaxPool,rentLamports:'100'});}
 const accrualDays=p.setup.accrualDays.slice(0,days);for(const day of accrualDays){setup.push(buildAccrueMiningTaxInstruction(term,{payer:owner,day:BigInt(day)}));accounts.push({address:miningTaxEpochReceiptPda(program,miningEpochPda(program,BigInt(day))).toBase58(),space:MINING_TAX_ACCOUNT_BYTES.MiningTaxAccrual,rentLamports:'100'});}
 if(needsCursor){setup.push(buildOpenMiningTaxSpotInstruction(term,{payer:owner,spot:p.spot}));accounts.push({address:i.cursor,space:MINING_TAX_ACCOUNT_BYTES.MiningTaxSpot,rentLamports:'100'});}
 const claim=buildClaimMiningTaxInstruction(term,{claimant:owner,spot:p.spot}),compile=(instructions:TransactionInstruction[])=>Buffer.from(new TransactionMessage({payerKey:owner,recentBlockhash:p.blockhash,instructions}).compileToLegacyMessage().serialize()),combined=compile([...setup,claim]),messages=combined.length+65>1232?[compile(setup),compile([claim])]:[combined];
 p.setup={needsAta,needsPool,needsCursor,accrualDays};p.snapshot.poolAccruedBaseUnits=days?'0':'70';p.transactions=messages.map((bytes,ordinal)=>({ordinal,kind:messages.length===2?(ordinal?'claim':'setup'):setup.length?'combined':'claim',messageHex:bytes.toString('hex'),messageSha256:hash(bytes),packetBytes:bytes.length+65,feeLamports:'5',rentLamports:String(ordinal?0:accounts.length*100),newAccounts:ordinal?[]:accounts}));p.fees={...p.fees,feeLamports:String(messages.length*5),rentLamports:String(accounts.length*100),totalLamports:String(messages.length*5+accounts.length*100)};
 return f;
}
describe('KEEP tax exact original browser signing foundation',()=>{
 it.each([['claim',0],['combined',0],['split',0],['split',1]] as const)('verifies actual SDK and signed finalized-reader %s ordinal%s',async(kind,ordinal)=>{
  const f=fixture(kind,ordinal);validateMiningTaxPreparationMessages(f.p);const prepared=await prepareMiningTaxClaimSigning(f.p,f.trust,ordinal),w=wallet(f),signed=await signMiningTaxClaim(prepared,w);
  expect(signed).toEqual(await verifySignedMiningTaxClaim(f.p,f.wire,ordinal));expect(signed.ordinal).toBe(ordinal);expect(signed.messageSha256).toBe(f.p.transactions[ordinal]!.messageSha256);expect(signed.wireSha256).toBe(hash(Buffer.from(f.wire,'base64')));expect(prepared.signingAuthorized).toBe(false);expect(prepared.broadcastAuthorized).toBe(false);expect(w.sendTransaction).not.toHaveBeenCalled();expect(w.signTransaction).toHaveBeenCalledTimes(1);
 });
 it('matches independent SDK instructions for every optional setup combination and eligible range',async()=>{
  for(const needsAta of [false,true])for(const needsPool of [false,true])for(const needsCursor of [false,true])for(const days of [0,1,7]){
   if(needsPool&&(!needsCursor||days===0))continue;const f=setupFixture(needsAta,needsPool,needsCursor,days);validateMiningTaxPreparationMessages(f.p);for(const t of f.p.transactions)expect((await prepareMiningTaxClaimSigning(f.p,f.trust,t.ordinal)).ordinal).toBe(t.ordinal);
  }
 });
 it('rejects merged CPI roles while allowing reserve-owner claimant identity',async()=>{
  const f=fixture();f.p.identity.reserveOwner=f.p.wallet;f.trust={...f.trust,reserveOwner:f.p.wallet};expect(await prepareMiningTaxClaimSigning(f.p,f.trust)).toHaveProperty('wallet',f.p.wallet);
  const g=fixture();g.p.identity.keepMint=g.p.wallet;g.trust={...g.trust,keepMint:g.p.wallet};await expect(prepareMiningTaxClaimSigning(g.p,g.trust)).rejects.toThrow(/MESSAGE/);
 });
 it.each(['genesisHash','programId','configAddress','keepMint','reserveOwner','reviewedDeploymentSlot','reviewedProgramDataSha256'] as const)('requires independent pin %s before any wallet callback',async name=>{
  const f=fixture(),value=name==='reviewedDeploymentSlot'?0:name==='reviewedProgramDataSha256'?'ab'.repeat(32):Keypair.generate().publicKey.toBase58();await expect(prepareMiningTaxClaimSigning(f.p,{...f.trust,[name]:value})).rejects.toThrow(/TRUST/);
 });
 it('binds all original PDA identities, account sizes and message hashes',async()=>{
  for(const field of ['configAddress','auctionConfig','registry','term','pool','cursor','auction','claimantAta'] as const){const f=fixture();f.p.identity[field]=Keypair.generate().publicKey.toBase58();if(field==='configAddress')f.trust={...f.trust,configAddress:f.p.identity.configAddress};await expect(prepareMiningTaxClaimSigning(f.p,f.trust)).rejects.toThrow();}
  const f=fixture();f.p.transactions[0]!.newAccounts[0]!.space++;await expect(prepareMiningTaxClaimSigning(f.p,f.trust)).rejects.toThrow(/MESSAGE/);
  const g=fixture();g.p.transactions[0]!.messageSha256='00'.repeat(32);await expect(prepareMiningTaxClaimSigning(g.p,g.trust)).rejects.toThrow(/MESSAGE/);
 });
 it('checks every split message even when only the setup ordinal is selected',async()=>{
  const f=fixture('split');f.p.transactions[1]!.messageSha256='00'.repeat(32);await expect(prepareMiningTaxClaimSigning(f.p,f.trust,0)).rejects.toThrow(/MESSAGE/);
  for(const ordinal of [-1,2,NaN,0.5])await expect(prepareMiningTaxClaimSigning(fixture().p,fixture().trust,ordinal)).rejects.toThrow();
 });
 it('rejects recomposed valid hashes for substituted roles, privileges, instruction bytes, payout or order',async()=>{
  for(const change of [(tx:Transaction)=>{tx.instructions.at(-1)!.keys[9]!.pubkey=Keypair.generate().publicKey;},(tx:Transaction)=>{tx.instructions.at(-1)!.keys[1]!.isWritable=false;},(tx:Transaction)=>{tx.instructions.at(-1)!.data[0]=tx.instructions.at(-1)!.data[0]!^1;},(tx:Transaction)=>{tx.feePayer=Keypair.generate().publicKey;},(tx:Transaction)=>{tx.add(SystemProgram.transfer({fromPubkey:tx.feePayer!,toPubkey:Keypair.generate().publicKey,lamports:1}));},(tx:Transaction)=>{tx.instructions.reverse();}]){
   const f=fixture(),tx=Transaction.populate(Message.from(Buffer.from(f.p.transactions[0]!.messageHex,'hex')));change(tx);replaceMessage(f.p,0,tx);await expect(prepareMiningTaxClaimSigning(f.p,f.trust)).rejects.toThrow();
  }
 });
 it('checks saved payout arithmetic, caps and eligible original accrual days without current authority',async()=>{
  for(const change of [(p:MiningTaxClaimPreparation)=>{p.intended.claimBaseUnits='0';},(p:MiningTaxClaimPreparation)=>{p.intended.cumulativeBaseUnits='4';},(p:MiningTaxClaimPreparation)=>{p.caps.maxFeeLamports='0';},(p:MiningTaxClaimPreparation)=>{p.setup.accrualDays[0]='1';},(p:MiningTaxClaimPreparation)=>{p.term.operatingEnd=p.term.operatingStart;}]){const f=fixture('split');change(f.p);await expect(prepareMiningTaxClaimSigning(f.p,f.trust)).rejects.toThrow();}
  const f=fixture('split');expect(f.p.setup.accrualDays).toHaveLength(7);expect(await prepareMiningTaxClaimSigning(f.p,f.trust)).toHaveProperty('wallet',f.p.wallet);
 });
 it('recovers original crypto after quote expiry; static proof and claim ordinal never assert live admission or completed setup',async()=>{
  const f=fixture('split',1);vi.useFakeTimers();try{vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));const prepared=await prepareMiningTaxClaimSigning(f.p,f.trust,1);expect(prepared.signingAuthorized).toBe(false);expect(await verifySignedMiningTaxClaim(f.p,f.wire,1)).toHaveProperty('signature');}finally{vi.useRealTimers();}
 });
 it('refuses malformed and unsigned packets, actor mismatch and copied opaque proof handles',async()=>{
  const f=fixture(),prepared=await prepareMiningTaxClaimSigning(f.p,f.trust);for(const raw of ['A'.repeat(1648),'!!!!',f.wire+'\n',null])await expect(verifySignedMiningTaxClaim(f.p,raw)).rejects.toThrow();
  const bytes=Buffer.from(f.wire,'base64');bytes[1]=bytes[1]!^1;await expect(verifySignedMiningTaxClaim(f.p,bytes.toString('base64'))).rejects.toThrow(/SIGNATURE/);
  const unsigned=new VersionedTransaction(Message.from(Buffer.from(f.p.transactions[0]!.messageHex,'hex')));await expect(verifySignedMiningTaxClaim(f.p,Buffer.from(unsigned.serialize()).toString('base64'))).rejects.toThrow(/SIGNATURE/);
  await expect(signMiningTaxClaim({...prepared},wallet(f))).rejects.toThrow(/INPUT/);const wrong=wallet(f);wrong.publicKey=Keypair.generate().publicKey;await expect(signMiningTaxClaim(prepared,wrong)).rejects.toThrow(/WALLET/);expect(wrong.signTransaction).not.toHaveBeenCalled();await expect(signMiningTaxClaim(prepared,{...wallet(f),signTransaction:null})).rejects.toThrow(/WALLET/);
 });
 it('bounds hostile arrays and versioned data before any unbounded traversal/serialization',async()=>{
  const f=fixture();let touched=0;const huge=Array(10001);Object.defineProperty(huge,0,{get(){touched++;throw Error('must not traverse');}});await expect(prepareMiningTaxClaimSigning({...f.p,transactions:huge},f.trust)).rejects.toThrow(/INPUT/);expect(touched).toBe(0);
  const tx=Transaction.populate(Message.from(Buffer.from(f.p.transactions[0]!.messageHex,'hex'))),versioned=new TransactionMessage({payerKey:tx.feePayer!,recentBlockhash:tx.recentBlockhash!,instructions:tx.instructions}).compileToV0Message().serialize();f.p.transactions[0]!.messageHex=Buffer.from(versioned).toString('hex');f.p.transactions[0]!.messageSha256=hash(versioned);f.p.transactions[0]!.packetBytes=versioned.length+65;await expect(prepareMiningTaxClaimSigning(f.p,f.trust)).rejects.toThrow();
 });
 it('bounds wallet mutations before serializers and preserves valid late signatures before caller lifecycle decisions',async()=>{
  for(const mutation of ['blockhash','signature','instruction','keys','nonce']){const f=fixture(),serialize=vi.fn(),w=wallet(f,async tx=>{if(mutation==='blockhash')tx.recentBlockhash='1'.repeat(100000);if(mutation==='signature')tx.signatures[0]!.signature=Buffer.alloc(100000);if(mutation==='instruction')tx.instructions[0]!.data=Buffer.alloc(100000);if(mutation==='keys')tx.instructions[0]!.keys=Array(10001).fill(tx.instructions[0]!.keys[0]);if(mutation==='nonce')tx.nonceInfo={} as never;tx.serializeMessage=serialize;tx.serialize=serialize;return tx;});await expect(signMiningTaxClaim(await prepareMiningTaxClaimSigning(f.p,f.trust),w)).rejects.toThrow(/MESSAGE/);expect(serialize).not.toHaveBeenCalled();}
  const f=fixture(),original=structuredClone(f.p),pending=prepareMiningTaxClaimSigning(f.p,f.trust);f.p.wallet=Keypair.generate().publicKey.toBase58();f.trust={...f.trust,keepMint:f.p.wallet};const prepared=await pending,late=wallet({...f,p:original},async()=>{late.publicKey=null;return Transaction.from(Buffer.from(f.wire,'base64'));});expect(await verifySignedMiningTaxClaim(original,(await signMiningTaxClaim(prepared,late)).wire)).toHaveProperty('signature');expect(late.sendTransaction).not.toHaveBeenCalled();
 });
});
