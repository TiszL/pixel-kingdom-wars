import anchorPkg,{type Idl} from '@coral-xyz/anchor';
import {Keypair,Message,PublicKey,VersionedTransaction,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {AccountLayout,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import bs58 from 'bs58';
import {beforeAll,describe,expect,it} from 'vitest';
import idl from './idl/shardkeep_economy.json' with {type:'json'};
import {verifyMiningTaxReceipt} from './miningTaxReceipt';
import {createMiningTaxReceiptFixture,prefundMiningTaxReceiptAta} from './testFixtures/miningTaxReceipt';
const {BN,BorshCoder}=anchorPkg,coder=new BorshCoder(idl as Idl);
type Fixture=Awaited<ReturnType<typeof createMiningTaxReceiptFixture>>;
const bases={} as Record<'claim'|'combined'|'split',Fixture>;
beforeAll(async()=>{for(const kind of ['claim','combined','split'] as const)bases[kind]=await createMiningTaxReceiptFixture(kind);},15000);
function fixture(kind:'claim'|'combined'|'split'='claim'){
 const base=bases[kind],request={...base.request,snapshot:structuredClone(base.request.snapshot),plan:{...base.request.plan},caps:{...base.request.caps},evidence:base.request.evidence.map(e=>({...e,signedTransaction:Uint8Array.from(e.signedTransaction),transaction:{...e.transaction,transaction:{...e.transaction.transaction,message:Message.from(e.transaction.transaction.message.serialize()),signatures:[...e.transaction.transaction.signatures]},meta:structuredClone(e.transaction.meta)},bank:{...e.bank,accounts:e.bank.accounts.map(a=>({...a,data:Buffer.from(a.data)}))}}))};
 return {...base,request,trust:{...base.trust},e:request.evidence[0]!,tx:request.evidence[0]!.transaction};
}
const run=(f:ReturnType<typeof fixture>)=>verifyMiningTaxReceipt(f.trust,f.request);
const row=(f:ReturnType<typeof fixture>,a:PublicKey,n=0)=>f.request.evidence[n]!.bank.accounts.find(r=>r.address.equals(a))!;
async function account(f:ReturnType<typeof fixture>,address:PublicKey,name:string,change:(data:Record<string,any>)=>void,n=0){const raw=row(f,address,n),data=coder.accounts.decode(name,Buffer.from(raw.data));change(data);raw.data=Buffer.from(await coder.accounts.encode(name,data));}
function claimEvent(f:ReturnType<typeof fixture>,change:(data:Record<string,any>)=>void,n=0){const logs=f.request.evidence[n]!.transaction.meta!.logMessages!,i=logs.findIndex(s=>s.startsWith('Program data: ')&&coder.events.decode(s.slice(14))?.name==='MiningTaxClaimed'),e=coder.events.decode(logs[i]!.slice(14))!;change(e.data);logs[i]=`Program data: ${f.event(e.name,e.data)}`;}

describe('original KEEP tax receipt evidence',()=>{
 it.each(['claim','combined'] as const)('recovers actual %s quote after its post-cost bank advances beyond the blockhash',async kind=>{
  const f=await createMiningTaxReceiptFixture(kind,{advancingQuote:true});
  expect(f.quote!.source).toMatchObject({firstSnapshotSlot:2000,feeSlot:2002,snapshotSlot:2003});expect(f.quote!.blockhashSlot).toBe(2001);
  expect(f.request.blockhashContextSlot).toBe(f.quote!.blockhashSlot);expect(f.planned.transactions.map(t=>t.messageSha256)).toEqual(f.quote!.plan.transactions.map(t=>t.messageSha256));
  expect(await verifyMiningTaxReceipt(f.trust,f.request)).toMatchObject({phase:'settled',paidKeepBaseUnits:'3',finalityAuthenticated:false});
  // A real newer snapshot remains a transaction floor; accepting the older
  // blockhash must not admit payment evidence from before either observation.
  f.txs[0]!.slot=2002;await expect(verifyMiningTaxReceipt(f.trust,f.request)).rejects.toMatchObject({code:'TRANSACTION'});
  f.txs[0]!.slot=2004;await expect(verifyMiningTaxReceipt(f.trust,{...f.request,blockhashContextSlot:2005})).rejects.toMatchObject({code:'TRANSACTION'});
  await expect(verifyMiningTaxReceipt(f.trust,{...f.request,blockhashContextSlot:f.trust.reviewedDeploymentSlot-1})).rejects.toMatchObject({code:'INPUT'});
 });
 it('binds an expired original spot to actual successful payment and permanent cursors',async()=>{
  const f=fixture(),r=await run(f);expect(f.snapshot.chainClock.unixTimestamp).toBeGreaterThan(f.snapshot.term.operatingEnd);
  expect(r).toMatchObject({phase:'settled',paidKeepBaseUnits:'3',wallet:f.signer.publicKey.toBase58(),round:'0',spot:0,term:f.snapshot.term.term,currentClaimsAuthorized:false,finalityAuthenticated:false,journalClearingAuthorized:false});
  expect(r.transactions[0]).toMatchObject({currentPoolPaid:'6',currentClaimedTotal:'3',currentGlobalTaxPaid:'6',feeLamports:'5',rentLamports:'0'});
 });
 it('proves combined ATA and cursor setup with exact claimant-paid rent conservation',async()=>{
  const f=fixture('combined'),r=await run(f);expect(r).toMatchObject({phase:'settled',paidKeepBaseUnits:'3',rentLamports:'200',feeLamports:'5'});expect(Object.isFrozen(r.transactions[0])).toBe(true);
 });
 it('keeps split setup non-paying and only settles after both exact signed transactions',async()=>{
  const f=fixture('split');expect(f.planned.mode).toBe('split');
  const setup=await verifyMiningTaxReceipt(f.trust,{...f.request,evidence:[f.request.evidence[0]!]});expect(setup).toMatchObject({phase:'setup',paidKeepBaseUnits:'0',rentLamports:'1000',journalClearingAuthorized:false});
  const result=await run(f);expect(result).toMatchObject({phase:'settled',paidKeepBaseUnits:'23',feeLamports:'10',rentLamports:'1000'});expect(result.transactions.map(t=>t.kind)).toEqual(['setup','claim']);
  await expect(verifyMiningTaxReceipt(f.trust,{...f.request,evidence:[f.request.evidence[1]!]})).rejects.toThrow();
 });
 it.each(['wallet','spot','round','program','mint','genesis','deployment','flags','alias'] as const)('refuses a substituted %s expectation',async kind=>{
  const f=fixture();if(kind==='wallet')f.request.plan.wallet=Keypair.generate().publicKey;if(kind==='spot')f.request.plan.spot++;if(kind==='round')f.request.plan.round++;
  if(kind==='program')f.trust.programId=Keypair.generate().publicKey;if(kind==='mint')f.trust.keepMint=Keypair.generate().publicKey;if(kind==='genesis')f.trust.expectedGenesisHash=Keypair.generate().publicKey.toBase58();if(kind==='deployment')f.trust.reviewedProgramDataSha256='00'.repeat(32);
  if(kind==='flags')f.request.snapshot={...f.request.snapshot,claimsPaused:true,backing:{...f.request.snapshot.backing,config:{...f.request.snapshot.backing.config,flags:1}}};if(kind==='alias')f.trust.keepMint=f.request.plan.wallet;
  await expect(run(f)).rejects.toThrow();
 });
 it.each(['status-only','failed','processed','wire','signature','message','extra-signature','slot','bank-slot','clock','loaded','oversized','extra-account'] as const)('refuses missing or corrupted %s transaction evidence',async kind=>{
  const f=fixture(),tx=f.tx;
  if(kind==='status-only')f.e.transaction=null as never;if(kind==='failed')tx.meta!.err={InstructionError:[0,'Custom']};if(kind==='processed')f.e.commitment='processed' as never;
  if(kind==='wire')f.e.signedTransaction[10]=f.e.signedTransaction[10]!^1;if(kind==='signature')tx.transaction.signatures[0]=bs58.encode(Buffer.alloc(64,7));
  if(kind==='message')(tx.transaction.message as Message).recentBlockhash=Keypair.generate().publicKey.toBase58();if(kind==='extra-signature')tx.transaction.signatures.push(tx.transaction.signatures[0]!);
  if(kind==='slot')tx.slot=1999;if(kind==='bank-slot')f.e.bank.slot=1999;if(kind==='clock')(row(f,SYSVAR_CLOCK_PUBKEY).data as Buffer).writeBigInt64LE(0n,32);
  if(kind==='loaded')tx.meta!.loadedAddresses={writable:[Keypair.generate().publicKey],readonly:[]};if(kind==='oversized')(tx.transaction.message as Message).instructions[0]!.data='1'.repeat(1684);
  if(kind==='extra-account')f.e.bank.accounts.push({...f.e.bank.accounts[0]!,address:Keypair.generate().publicKey});
  await expect(run(f)).rejects.toThrow();
 });
 it.each(['missing','nested-spoof','duplicate','wrong-wallet','wrong-spot','wrong-term','amount','cumulative','pool-paid','tax-paid','truncated'] as const)('refuses %s claim events even with a signature',async kind=>{
  const f=fixture(),logs=f.tx.meta!.logMessages!;
  if(kind==='missing')f.tx.meta!.logMessages=[];
  else if(kind==='nested-spoof'){const at=logs.findIndex(s=>s.startsWith('Program data:'));logs.splice(at,0,`Program ${TOKEN_PROGRAM_ID.toBase58()} invoke [2]`);logs.splice(at+2,0,`Program ${TOKEN_PROGRAM_ID.toBase58()} success`);}
  else if(kind==='duplicate')logs.splice(logs.length-1,0,logs.find(s=>s.startsWith('Program data:'))!);
  else if(kind==='truncated')logs.pop();
  else claimEvent(f,d=>{if(kind==='wrong-wallet')d.wallet=Keypair.generate().publicKey;if(kind==='wrong-spot')d.spot=20;if(kind==='wrong-term')d.term=Keypair.generate().publicKey;if(kind==='amount')d.amount=new BN(2);if(kind==='cumulative')d.cumulative=new BN(2);if(kind==='pool-paid')d.pool_paid=new BN(5);if(kind==='tax-paid')d.total_tax_paid=new BN(5);});
  await expect(run(f)).rejects.toThrow();
 });
 it.each(['missing-cpi','transfer-amount','transfer-mint','transfer-owner','transfer-depth','token-mint','token-owner','token-delta','duplicate-balance','fee','rent','redirected-rent'] as const)('refuses %s payment or rent evidence',async kind=>{
  const f=fixture(kind==='rent'||kind==='redirected-rent'?'combined':'claim'),meta=f.tx.meta!,cpi=meta.innerInstructions!.at(-1)!.instructions[0]!;
  if(kind==='missing-cpi')meta.innerInstructions=[];
  if(kind==='transfer-amount'){const bytes=bs58.decode(cpi.data);bytes[1]=2;cpi.data=bs58.encode(bytes);}
  if(kind==='transfer-mint')cpi.accounts[1]=0;if(kind==='transfer-owner')cpi.accounts[3]=0;if(kind==='transfer-depth')(cpi as unknown as {stackHeight:number}).stackHeight=3;
  if(kind==='token-mint')meta.postTokenBalances![0]!.mint=Keypair.generate().publicKey.toBase58();if(kind==='token-owner')meta.postTokenBalances![0]!.owner=f.signer.publicKey.toBase58();if(kind==='token-delta')meta.postTokenBalances![1]!.uiTokenAmount.amount='2';if(kind==='duplicate-balance')meta.postTokenBalances!.push(meta.postTokenBalances![0]!);
  if(kind==='fee')meta.fee=4;if(kind==='rent')meta.postBalances[0]!--;if(kind==='redirected-rent')meta.innerInstructions![0]!.instructions[0]!.accounts[1]=0;
  await expect(run(f)).rejects.toThrow();
 });
 it.each(['vault-delegate','ata-delegate','ata-owner','ata-mint','vault-balance','cursor-missing','cursor-wallet','cursor-regression','pool-regression','global-regression','term-swap','accrual-missing','epoch-swap','program-bytes'] as const)('refuses %s same-bank state',async kind=>{
  const f=fixture(),s=f.state;
  if(['vault-delegate','ata-delegate','ata-owner','ata-mint','vault-balance'].includes(kind)){const raw=row(f,kind.startsWith('vault')?s.backing.rows[1]!.address:s.addresses.ata),token=AccountLayout.decode(Buffer.from(raw.data));if(kind.endsWith('delegate')){token.delegateOption=1;token.delegate=Keypair.generate().publicKey;}if(kind==='ata-owner')token.owner=Keypair.generate().publicKey;if(kind==='ata-mint')token.mint=Keypair.generate().publicKey;if(kind==='vault-balance')token.amount--;AccountLayout.encode(token,raw.data as Buffer);}
  if(kind==='cursor-missing'||kind==='accrual-missing'){const key=kind==='cursor-missing'?s.addresses.cursor:s.addresses.accrual;f.e.bank.accounts.splice(f.e.bank.accounts.findIndex(r=>r.address.equals(key)),1);}
  if(kind==='cursor-wallet')await account(f,s.addresses.cursor,'MiningTaxSpot',d=>{d.wallet=Keypair.generate().publicKey;});
  if(kind==='cursor-regression')await account(f,s.addresses.cursor,'MiningTaxSpot',d=>{d.claimed_total=new BN(0);});
  if(kind==='pool-regression')await account(f,s.addresses.pool,'MiningTaxPool',d=>{d.paid=new BN(3);});
  if(kind==='global-regression')await account(f,s.term.config,'EconomyConfig',d=>{d.tax_paid=new BN(3);});
  if(kind==='term-swap')(row(f,s.term.term).data as Buffer)[8]=(row(f,s.term.term).data as Buffer)[8]!^1;
  if(kind==='epoch-swap')(row(f,s.addresses.epoch).data as Buffer)[40]=(row(f,s.addresses.epoch).data as Buffer)[40]!^1;
  if(kind==='program-bytes')(row(f,s.backing.programDataAddress).data as Buffer)[45]=(row(f,s.backing.programDataAddress).data as Buffer)[45]!^1;
  await expect(run(f)).rejects.toThrow();
 });
 it('applies aggregate split fee/rent/total caps to actual metadata',async()=>{
  for(const caps of [{maxFeeLamports:9n},{maxRentLamports:999n},{maxTotalLamports:1009n}]){const f=fixture('split');Object.assign(f.request.caps,caps);await expect(run(f)).rejects.toThrow();}
 });
 it('allows later strict backing and permanent cursor evidence after the paid ATA is closed',async()=>{
  const f=fixture();f.e.bank.slot++;const clock=row(f,SYSVAR_CLOCK_PUBKEY).data as Buffer;clock.writeBigUInt64LE(BigInt(f.e.bank.slot),0);clock.writeBigInt64LE(BigInt(f.tx.blockTime!)+1n,32);
  f.e.bank.accounts.splice(f.e.bank.accounts.findIndex(r=>r.address.equals(f.state.addresses.ata)),1);
  expect((await run(f)).paidKeepBaseUnits).toBe('3');
 });
 it('requires exact same-slot pool/global counter changes, not unrelated larger totals',async()=>{
  const f=fixture();await account(f,f.state.addresses.pool,'MiningTaxPool',d=>{d.paid=new BN(7);});await account(f,f.state.term.config,'EconomyConfig',d=>{d.tax_paid=new BN(7);});
  await expect(run(f)).rejects.toThrow();
 });
 it('does not mistake a later observed split claim cursor for the pre-claim cursor',async()=>{
  const f=fixture('split'),latest=f.request.evidence[1]!.bank;
  for(const e of f.request.evidence){e.bank={...latest,slot:2003,accounts:latest.accounts.map(a=>({...a,data:Buffer.from(a.data)}))};const clock=e.bank.accounts.find(a=>a.address.equals(SYSVAR_CLOCK_PUBKEY))!.data as Buffer;clock.writeBigUInt64LE(2003n,0);clock.writeBigInt64LE(BigInt(f.request.evidence[1]!.transaction.blockTime!)+1n,32);}
  expect((await run(f)).paidKeepBaseUnits).toBe('23');
 });
 it('retains historical payment when the claims pause is applied after execution',async()=>{
  const f=fixture();await account(f,f.state.term.config,'EconomyConfig',d=>{d.flags=1;});expect((await run(f)).paidKeepBaseUnits).toBe('3');
 });
 it.each(['owner','space','amount'] as const)('rejects a substituted system creation %s',async kind=>{
  const f=fixture('combined'),ix=f.tx.meta!.innerInstructions![0]!.instructions[0]!,bytes=Buffer.from(bs58.decode(ix.data));
  if(kind==='owner')Keypair.generate().publicKey.toBuffer().copy(bytes,20);if(kind==='space')bytes.writeBigUInt64LE(1n,12);if(kind==='amount')bytes.writeBigUInt64LE(99n,4);ix.data=bs58.encode(bytes);await expect(run(f)).rejects.toThrow();
 });
 it('copies request-owned evidence before its first asynchronous backing check',async()=>{
  const f=fixture(),pending=run(f);f.e.signedTransaction.fill(0);f.tx.meta!.err={InstructionError:[0,'Custom']};f.tx.meta!.logMessages=[];(row(f,f.state.addresses.cursor).data as Buffer).fill(0);f.request.caps.maxTotalLamports=0n;f.trust.keepMint=Keypair.generate().publicKey;
  expect((await pending).paidKeepBaseUnits).toBe('3');
 });
 it.each([['combined',7],['combined',100],['combined',150],['split',7],['split',100],['split',150]] as const)('recovers %s payment when a missing ATA is dusted with %s lamports after signing',async(kind,dust)=>{
  const f=fixture(kind);prefundMiningTaxReceiptAta(f.e,f.state.addresses.ata,f.signer.publicKey,dust);
  const r=await run(f);expect(r.paidKeepBaseUnits).toBe(kind==='split'?'23':'3');expect(r.rentLamports).toBe(String((kind==='split'?1000:200)-Math.min(dust,100)));
  if(kind==='split'){const setup=await verifyMiningTaxReceipt(f.trust,{...f.request,evidence:[f.e]});expect(setup.phase).toBe('setup');expect(setup.paidKeepBaseUnits).toBe('0');}
 });
 it('preserves original paid tax rights after the settled auction refunds loser escrow',async()=>{
  const f=fixture();await account(f,f.state.models.cursor.auction,'Auction',d=>{d.outstanding_escrow=new BN(300);});expect((await run(f)).paidKeepBaseUnits).toBe('3');
 });
 it.each(['allocate','assign','initialize','owner','space','amount','target','order','payer'] as const)('refuses dusted ATA creation with invalid %s evidence',async kind=>{
  const f=fixture('combined');prefundMiningTaxReceiptAta(f.e,f.state.addresses.ata,f.signer.publicKey,7);const group=f.tx.meta!.innerInstructions![0]!;
  if(kind==='allocate')group.instructions.splice(1,1);if(kind==='assign')group.instructions.splice(2,1);if(kind==='initialize')group.instructions.pop();
  if(kind==='owner'||kind==='space'||kind==='amount'){const i=kind==='owner'?2:kind==='space'?1:0,ix=group.instructions[i]!,data=Buffer.from(bs58.decode(ix.data));if(kind==='owner')Keypair.generate().publicKey.toBuffer().copy(data,4);else data.writeBigUInt64LE(1n,4);ix.data=bs58.encode(data);}
  if(kind==='target')group.instructions[0]!.accounts[1]=0;if(kind==='order')[group.instructions[1],group.instructions[2]]=[group.instructions[2]!,group.instructions[1]!];if(kind==='payer')f.tx.meta!.postBalances[0]!++;
  await expect(run(f)).rejects.toThrow();
 });
 it.each(['version','config','term','registry','spot','round','auction_start','auction_end','operating_start','operating_end','terms_hash','vault','high_bid','high_bidder','settled','result_owner','settled_at','settled_slot','bump','owner','discriminator'] as const)('retains immutable auction %s binding while permitting escrow refunds',async field=>{
  const f=fixture(),auction=f.state.models.cursor.auction;
  if(field==='owner')row(f,auction).owner=Keypair.generate().publicKey;
  else if(field==='discriminator')row(f,auction).data[0]=row(f,auction).data[0]!^1;
  else await account(f,auction,'Auction',d=>{
   if(['config','term','registry','vault','high_bidder','result_owner'].includes(field))d[field]=Keypair.generate().publicKey;
   else if(field==='version'||field==='bump')d[field]=(d[field]+1)%256;
   else if(field==='spot')d.spot.realm_mask^=1;
   else if(field==='terms_hash')d.terms_hash[0]^=1;
   else if(field==='settled')d.settled=false;
   else d[field]=d[field].addn(1);
  });
  await expect(run(f)).rejects.toThrow();
 });
});
