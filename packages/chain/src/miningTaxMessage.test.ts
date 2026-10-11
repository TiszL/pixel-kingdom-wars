import {createHash} from 'node:crypto';
import {Keypair,Message,PublicKey,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {ACCOUNT_SIZE,createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {beforeAll,describe,expect,it} from 'vitest';
import {PHASE_E_MINING_PUBLICATION as P} from '@shardkeep/shared';
import {createMiningTaxSnapshotFixture} from './testFixtures/miningTaxSnapshot';
import {miningEpochPda} from './miningProgramProtocol';
import {createMiningTaxSnapshotReader,type MiningTaxSnapshot} from './miningTaxSnapshot';
import {buildMiningTaxMessages,quoteMiningTaxMessageCosts,type MiningTaxMessageInput} from './miningTaxMessage';
import {buildClaimMiningTaxInstruction,buildOpenMiningTaxPoolInstruction,buildOpenMiningTaxSpotInstruction,buildAccrueMiningTaxInstruction,MINING_TAX_ACCOUNT_BYTES,hashMiningTaxCommitment} from './miningTaxProtocol';
let fixture:Awaited<ReturnType<typeof createMiningTaxSnapshotFixture>>,observed:MiningTaxSnapshot;
beforeAll(async()=>{fixture=await createMiningTaxSnapshotFixture();fixture.models.cursor.claimed_total=0n;await fixture.encode('cursor');observed=await createMiningTaxSnapshotReader(()=>fixture.rpc,fixture.trust)(fixture.request);});
type Mutable<T>={-readonly [K in keyof T]:T[K]};
const copy=()=>structuredClone(observed) as Mutable<MiningTaxSnapshot>;
const input=():Mutable<MiningTaxMessageInput>=>({...fixture.request,blockhash:Keypair.generate().publicKey.toBase58()});
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function plan(s=copy(),i=input()){return buildMiningTaxMessages(fixture.trust.mining,s,i);}
function absent(s:Mutable<MiningTaxSnapshot>,k:'pool'|'cursor'|'ata'){
 if(k==='pool'){s={...s,pool:null,cursor:null,entitlement:null,epochs:s.epochs.map(e=>({...e,accrual:null}))};}
 else if(k==='cursor')s={...s,cursor:null,entitlement:s.entitlement?{...s.entitlement,claimed:0n,available:s.entitlement.cumulative}:null};
 else s={...s,claimantAta:{...s.claimantAta,exists:false,balanceBaseUnits:null}};
 return s;
}
describe('pure original-spot KEEP tax transaction planning',()=>{
 it.each([[false,false,false],[false,false,true],[false,true,false],[false,true,true],[true,true,false],[true,true,true]])('uses exact reviewed ABI for pool=%s cursor=%s ATA=%s setup', (pool,cursor,ata)=>{
  let s=copy();if(pool)s=absent(s,'pool');if(cursor)s=absent(s,'cursor');if(ata)s=absent(s,'ata');const i=input(),r=plan(s,i),instructions=[];
  if(ata)instructions.push(createAssociatedTokenAccountIdempotentInstruction(i.wallet,getAssociatedTokenAddressSync(fixture.term.keepMint,i.wallet),i.wallet,fixture.term.keepMint));
  if(pool)instructions.push(buildOpenMiningTaxPoolInstruction(fixture.term,{payer:i.wallet}));
  if(pool)instructions.push(buildAccrueMiningTaxInstruction(fixture.term,{payer:i.wallet,day:fixture.models.epoch.day}));
  if(cursor)instructions.push(buildOpenMiningTaxSpotInstruction(fixture.term,{payer:i.wallet,spot:i.spot}));
  instructions.push(buildClaimMiningTaxInstruction(fixture.term,{claimant:i.wallet,spot:i.spot}));
  const expected=new TransactionMessage({payerKey:i.wallet,recentBlockhash:i.blockhash,instructions}).compileToLegacyMessage(),tx=r.transactions[0]!;
  expect(r.mode).toBe('combined');expect(tx.messageBytes).toEqual(Uint8Array.from(expected.serialize()));expect(tx.messageSha256).toBe(hash(expected.serialize()));expect(tx.packetBytes).toBe(new VersionedTransaction(expected).serialize().length);
  expect(tx.expectedNewAccounts).toEqual([
   ...(ata?[{address:fixture.addresses.ata.toBase58(),space:ACCOUNT_SIZE}]:[]),
   ...(pool?[{address:fixture.addresses.pool.toBase58(),space:MINING_TAX_ACCOUNT_BYTES.MiningTaxPool},{address:fixture.addresses.accrual.toBase58(),space:MINING_TAX_ACCOUNT_BYTES.MiningTaxAccrual}]:[]),
   ...(cursor?[{address:fixture.addresses.cursor.toBase58(),space:MINING_TAX_ACCOUNT_BYTES.MiningTaxSpot}]:[])]);
  expect(r.expectedClaimBaseUnits).toBe(3n);expect(r.signingAuthorized).toBe(false);expect(r.broadcastAuthorized).toBe(false);
  const message=Message.from(tx.messageBytes);expect(message.header.numRequiredSignatures).toBe(1);expect(message.accountKeys[0]!.equals(i.wallet)).toBe(true);
 });
 it('does not renew terms or reapply current taxes after expiry',()=>{const r=plan();expect(observed.chainClock.unixTimestamp).toBeGreaterThan(fixture.term.operatingEnd);expect(r.term).toBe(fixture.term.term.toBase58());expect(r.expectedClaimBaseUnits).toBe(3n);expect(r.dustBaseUnits).toBe(1n);});
 it('only accrues mature funded epochs and never pays setup for a zero delta',()=>{
  const s=absent(copy(),'pool'),epoch=s.epochs.find(e=>e.epoch)!.epoch!;s.chainClock={...s.chainClock,unixTimestamp:epoch.fundedAt+BigInt(P.claimDelaySec)-1n};s.backing={...s.backing,unixTimestamp:s.chainClock.unixTimestamp,chainDay:s.chainClock.unixTimestamp/BigInt(P.daySec)};
  expect(()=>plan(s)).toThrowError(expect.objectContaining({code:'NOTHING_TO_CLAIM'}));
  s.chainClock={...s.chainClock,unixTimestamp:epoch.fundedAt+BigInt(P.claimDelaySec)};s.backing={...s.backing,unixTimestamp:s.chainClock.unixTimestamp,chainDay:s.chainClock.unixTimestamp/BigInt(P.daySec)};expect(plan(s).accrualDays).toEqual([epoch.day]);
  expect(()=>plan({...observed,cursor:{...observed.cursor!,claimedTotal:3n},entitlement:{...observed.entitlement!,claimed:3n,available:0n}})).toThrowError(expect.objectContaining({code:'NOTHING_TO_CLAIM'}));
 });
 it.each(['wallet','round','spot','genesis','deployment','mint','term','winner','pause','backing','payer','cursor','pool','epoch','epoch-version','unknown','blockhash','overflow'] as const)('refuses substituted or inconsistent %s',kind=>{
  const s=copy(),i=input(),trust={...fixture.trust.mining};
  if(kind==='wallet')i.wallet=Keypair.generate().publicKey;if(kind==='round')i.round++;if(kind==='spot')i.spot++;
  if(kind==='genesis')trust.expectedGenesisHash=Keypair.generate().publicKey.toBase58();if(kind==='deployment')trust.reviewedProgramDataSha256='00'.repeat(32);if(kind==='mint')trust.keepMint=Keypair.generate().publicKey;
  if(kind==='term')s.term={...s.term,term:Keypair.generate().publicKey.toBase58()};if(kind==='winner')s.term={...s.term,auctions:s.term.auctions.map((a,n)=>n===s.spot?{...a,winner:Keypair.generate().publicKey.toBase58()}:a)};
  if(kind==='pause')s.claimsPaused=true;if(kind==='backing')s.backing={...s.backing,vaultAmount:0n};if(kind==='payer')s.payer={...s.payer,exists:false,lamports:null};
  if(kind==='cursor')s.cursor={...s.cursor!,claimedTotal:4n};if(kind==='pool')s.pool={...s.pool!,accrued:9n};
  if(kind==='epoch'||kind==='epoch-version')s.epochs=s.epochs.map(e=>e.epoch?{...e,epoch:{...e.epoch,...(kind==='epoch'?{taxCommitment:'00'.repeat(32)}:{taxVersion:1})}}:e);
  if(kind==='unknown')Object.assign(i,{payer:Keypair.generate().publicKey});if(kind==='blockhash')i.blockhash='1'.repeat(33);if(kind==='overflow')s.backing={...s.backing,taxOutstanding:1n<<64n};
  expect(()=>buildMiningTaxMessages(trust,s,i)).toThrow();
 });
 it('splits only the maximum seven-day setup that exceeds the real legacy packet limit',()=>{
  // Pure planning expectations exercise the maximal ABI; these manually changed
  // facts are deliberately not passed off as authenticated chain observations.
  let s=absent(absent(copy(),'pool'),'ata');const sec=BigInt(P.daySec),start=fixture.models.epoch.day*sec;
  const term={...fixture.term,auctionStart:start-sec,auctionEnd:start,operatingStart:start,operatingEnd:start+7n*sec};
  s.term={...s.term,auctionStart:term.auctionStart,auctionEnd:start,operatingStart:start,operatingEnd:term.operatingEnd,completedAt:start};
  s.chainClock={...s.chainClock,unixTimestamp:term.operatingEnd+sec};
  s.backing={...s.backing,unixTimestamp:s.chainClock.unixTimestamp,chainDay:s.chainClock.unixTimestamp/sec,vaultAmount:1000n,taxOutstanding:70n,totalOutstanding:s.backing.playerOutstanding+70n,config:{...s.backing.config,taxHighwater:70n,taxPaid:0n,latestDay:fixture.models.epoch.day+6n}};
  const original=observed.epochs.find(e=>e.epoch)!.epoch!;
  s.epochs=Array.from({length:7},(_,i)=>{const day=fixture.models.epoch.day+BigInt(i),address=miningEpochPda(term.programId,day);return {day,accrual:null,epoch:{...original,day,address:address.toBase58(),fundedAt:(day+1n)*sec,taxCommitment:Buffer.from(hashMiningTaxCommitment(term,{day,epoch:address})).toString('hex')}};});
  const i=input(),r=plan(s,i);expect(r.mode).toBe('split');expect(r.transactions.map(t=>t.kind)).toEqual(['setup','claim']);expect(r.transactions.every(t=>t.packetBytes<=1232)).toBe(true);expect(r.transactions[0]!.expectedNewAccounts).toHaveLength(10);expect(r.transactions[1]!.expectedNewAccounts).toEqual([]);expect(r.expectedClaimBaseUnits).toBe(23n);expect(r.dustBaseUnits).toBe(1n);
  const quotes=r.transactions.map(tx=>({messageSha256:tx.messageSha256,feeLamports:5n,rents:tx.expectedNewAccounts.map(a=>({...a,lamports:7n}))}));expect(quoteMiningTaxMessageCosts(r,quotes,{maxFeeLamports:10n,maxRentLamports:70n,maxTotalLamports:80n}).totalLamports).toBe(80n);
 });
 it('retains an existing delta while leaving a newer not-yet-mature epoch unaccrued',()=>{
  const s=copy(),prior=s.epochs.find(e=>e.epoch)!.epoch!,day=prior.day+1n,epoch=miningEpochPda(fixture.term.programId,day);
  s.epochs=s.epochs.map(e=>e.day===day?{day,accrual:null,epoch:{...prior,day,address:epoch.toBase58(),fundedAt:s.chainClock.unixTimestamp,taxCommitment:Buffer.from(hashMiningTaxCommitment(fixture.term,{day,epoch})).toString('hex')}}:e);
  s.backing={...s.backing,config:{...s.backing.config,latestDay:day}};expect(plan(s).expectedClaimBaseUnits).toBe(3n);expect(plan(s).accrualDays).toEqual([]);
 });
 it('refuses exact claims pause while permitting a paused Seeker sale authority',()=>{const s=copy();s.claimsPaused=true;s.backing={...s.backing,config:{...s.backing.config,flags:1}};expect(()=>plan(s)).toThrowError(expect.objectContaining({code:'PAUSED'}));expect(plan().expectedClaimBaseUnits).toBe(3n);});
 it('rejects an unsafe shared account role before message compilation',()=>{const s=copy(),trust={...fixture.trust.mining,keepMint:fixture.wallet};expect(()=>buildMiningTaxMessages(trust,s,input())).toThrow();});
 it('returns immutable detached bytes and bound rent rosters',()=>{const r=plan(absent(copy(),'ata')),tx=r.transactions[0]!,original=tx.messageBytes;tx.messageBytes.fill(0);expect(tx.messageBytes).toEqual(original);expect(Object.isFrozen(r)).toBe(true);expect(Object.isFrozen(r.transactions)).toBe(true);expect(Object.isFrozen(tx.expectedNewAccounts[0])).toBe(true);});
 it('binds exact fee and rent quotes to the unsigned message and claimant balance',()=>{
  const p=plan(absent(copy(),'ata')),quote={messageSha256:p.transactions[0]!.messageSha256,feeLamports:5n,rents:[{...p.transactions[0]!.expectedNewAccounts[0]!,lamports:7n}]};
  const caps={maxFeeLamports:5n,maxRentLamports:7n,maxTotalLamports:12n};
  expect(quoteMiningTaxMessageCosts(p,[quote],caps)).toMatchObject({feeLamports:5n,rentLamports:7n,totalLamports:12n,signingAuthorized:false});
  for(const change of [{maxFeeLamports:4n},{maxRentLamports:6n},{maxTotalLamports:11n}])expect(()=>quoteMiningTaxMessageCosts(p,[quote],{...caps,...change})).toThrow();
  expect(()=>quoteMiningTaxMessageCosts({...p,payerBalanceLamports:11n},[quote],caps)).toThrowError(expect.objectContaining({code:'INSUFFICIENT_SOL'}));
  for(const q of [{...quote,messageSha256:'00'.repeat(32)},{...quote,feeLamports:-1n},{...quote,rents:[]},{...quote,rents:[...quote.rents,...quote.rents]},{...quote,rents:[{...quote.rents[0]!,space:1}]},{...quote,rents:[{...quote.rents[0]!,address:Keypair.generate().publicKey.toBase58()}]}])expect(()=>quoteMiningTaxMessageCosts(p,[q],caps)).toThrow();
 });
});
