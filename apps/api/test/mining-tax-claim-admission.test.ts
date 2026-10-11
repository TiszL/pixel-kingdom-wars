/** Fresh observational admission of exact saved packets, never relay/finality. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {buildMiningTaxMessages} from '@shardkeep/chain/mining-tax-message';
import {getMiningTaxClaimSigned} from '../src/mining/taxClaimSignedStore';
import {createMiningTaxClaimSettlement,getMiningTaxClaimSettlement} from '../src/mining/taxClaimSettlement';
import {withMiningTaxAdmissionFixture as fixture,type MiningTaxAdmissionFixture} from './fixtures/miningTaxAdmission';
// Dynamic import permits independent fixture validation while the fixture-first
// admission contract intentionally remains red before implementation exists.
const factory=async()=> (await import('../src/mining/taxClaimAdmission')).createMiningTaxClaimAdmission;
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
const active=()=>{vi.stubEnv('PHASE_E_MINING_ENABLED','true');vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');};
const original=(f:MiningTaxAdmissionFixture,n=0)=>f.record.artifact.transactions[n]!;
const lookup=(f:MiningTaxAdmissionFixture)=>({wallet:f.wallet,idempotencyKey:f.key.idempotencyKey});
afterEach(()=>vi.unstubAllEnvs());
describe('original KEEP tax packet admission',()=>{
 it.each(['claim','combined','split'] as const)('fixture authenticates actual pre-send %s accounts and rebuilds the original ABI',mode=>fixture(async f=>{
  const q=await f.quote(),saved=f.record.artifact,plan=buildMiningTaxMessages(f.chain.trust.mining,q.snapshot,{...f.chain.request.plan,blockhash:saved.blockhash});
  expect(q.blockhash).not.toBe(saved.blockhash);expect(plan.transactions.map(t=>Buffer.from(t.messageBytes).toString('hex'))).toEqual(saved.transactions.map(t=>t.messageHex));
  expect(plan.expectedClaimBaseUnits.toString()).toBe(saved.intended.claimBaseUnits);expect(q.snapshot.term.winnerCount).toBe(saved.term.winnerCount);
  if(mode==='split'){
   const setup=await f.verifySetup();expect(setup.receipt.phase).toBe('setup');expect(setup.receipt.finalityAuthenticated).toBe(true);
   const fresh=await f.quote(),claim=buildMiningTaxMessages(f.chain.trust.mining,fresh.snapshot,{...f.chain.request.plan,blockhash:saved.blockhash});
   expect(claim.transactions).toHaveLength(1);expect(Buffer.from(claim.transactions[0]!.messageBytes).toString('hex')).toBe(saved.transactions[1]!.messageHex);
  }
 },{mode}));
 it.each(['claim','combined','split'] as const)('admits exact saved %s bytes with a fresh quote, measuring their old blockhash separately',mode=>fixture(async f=>{
  active();const admit=(await factory())(f.conn.db,f.sources),a=f.record.artifact,result=await admit(f.key),wire=(await getMiningTaxClaimSigned(f.conn.db,lookup(f)))!.wires[0]!;
  expect(result).toMatchObject({...f.key,claimId:a.claimId,signature:wire.signature,messageSha256:wire.messageSha256,wireSha256:wire.wireSha256,signedTransactionHex:wire.signedTransactionHex,
   feeLamports:5n,rentLamports:BigInt(original(f).rentLamports),totalLamports:5n+BigInt(original(f).rentLamports),paidFeeLamports:0n,paidRentLamports:0n,
   currentSigningAuthorized:false,relayAuthorized:false,settlementAuthorized:false,
   source:{genesisHash:a.identity.genesisHash,programId:a.identity.programId,reviewedDeploymentSlot:a.source.reviewedDeploymentSlot,reviewedProgramDataSha256:a.source.reviewedProgramDataSha256,snapshotSlot:2006,feeSlot:2006,blockHeight:a.blockHeight+1,lastValidBlockHeight:a.lastValidBlockHeight}});
  expect(f.calls.messages).toContain(original(f).messageHex);expect(f.calls.messages.some(hex=>hex!==original(f).messageHex)).toBe(true);expect(Object.isFrozen(result)).toBe(true);
  expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(0);expect((await getMiningTaxClaimSigned(f.conn.db,lookup(f)))!.wires[0]!.signedTransactionHex).toBe(wire.signedTransactionHex);
 },{mode}));
 it('requires exact owner-verified setup before ordinal1 even when all accounts already exist',()=>fixture(async f=>{
  active();const admit=(await factory())(f.conn.db,f.sources),key={...f.key,ordinal:1};await f.stage('setup');
  expect((await f.quote()).plan.transactions.map(t=>t.kind)).toEqual(['claim']);const calls=f.calls.connect;
  await expect(admit(key)).rejects.toMatchObject({code:'SETUP_REQUIRED'});expect(f.calls.connect).toBe(calls);
  const setup=await f.verifySetup();expect(setup.claimFinalized).toBe(false);const result=await admit(key);
  expect(result).toMatchObject({...key,paidFeeLamports:5n,paidRentLamports:1000n,feeLamports:5n,rentLamports:0n,totalLamports:5n,signedTransactionHex:Buffer.from(f.wire(1)).toString('hex')});
  expect(f.calls.messages).toContain(original(f,1).messageHex);expect(await getMiningTaxClaimSettlement(f.conn.db,key)).toBeNull();
 },{mode:'split'}));
 it('deducts actual verified setup fee from the original whole-plan consent caps',()=>fixture(async f=>{
  active();const setup=await f.verifySetup(6);expect(setup.receipt.feeLamports).toBe('6');
  const admit=(await factory())(f.conn.db,f.sources);await expect(admit({...f.key,ordinal:1})).rejects.toMatchObject({code:'COST_CAP'});
  f.control.fee=4;expect(await admit({...f.key,ordinal:1})).toMatchObject({paidFeeLamports:6n,paidRentLamports:1000n,feeLamports:4n,totalLamports:4n});
 },{mode:'split'}));
 it('charges only remaining claim cost against the current payer after verified setup',()=>fixture(async f=>{
  active();await f.verifySetup();f.chain.state.store.get(f.wallet)!.lamports=5;
  const admit=(await factory())(f.conn.db,f.sources);expect(await admit({...f.key,ordinal:1})).toMatchObject({totalLamports:5n,paidRentLamports:1000n});
  f.chain.state.store.get(f.wallet)!.lamports=4;await expect(admit({...f.key,ordinal:1})).rejects.toThrow();
 },{mode:'split'}));
 it('checks the complete split plan budget before its first setup packet',()=>fixture(async f=>{
  active();const admit=(await factory())(f.conn.db,f.sources);f.control.fee=6;await expect(admit(f.key)).rejects.toThrow();
  f.control.fee=5;f.control.rent=101;await expect(admit(f.key)).rejects.toThrow();
 },{mode:'split'}));
 it('remeasures original-message fees and keeps the original block-height expiry',()=>fixture(async f=>{
  active();const admit=(await factory())(f.conn.db,f.sources),fee=f.rpc.getFeeForMessage;
  f.rpc.getFeeForMessage=async(message,commitment)=>{const measured=await fee(message,commitment);return Buffer.from(message.serialize()).toString('hex')===original(f).messageHex?{...measured,value:11}:measured;};
  await expect(admit(f.key)).rejects.toMatchObject({code:'COST_CAP'});f.rpc.getFeeForMessage=fee;
  f.control.height=f.record.artifact.lastValidBlockHeight;expect((await admit(f.key)).source.lastValidBlockHeight).toBe(f.record.artifact.lastValidBlockHeight);
  f.control.height++;expect(f.control.height).toBeLessThan(f.control.lastValidBlockHeight);await expect(admit(f.key)).rejects.toMatchObject({code:'EXPIRED'});
 }));
 it.each(['expired-quote','regressing-height','before-saved-height'] as const)('refuses %s when a later RPC tries to roll back observed block height',kind=>fixture(async f=>{
  active();const admit=(await factory())(f.conn.db,f.sources),a=f.record.artifact;let reads=0;
  const first=kind==='expired-quote'?a.lastValidBlockHeight+1:kind==='regressing-height'?a.blockHeight+1:a.blockHeight-1;
  const second=kind==='expired-quote'?a.lastValidBlockHeight-1:kind==='regressing-height'?a.blockHeight:a.blockHeight-1;
  f.rpc.getBlockHeight=async()=>++reads===1?first:second;
  await expect(admit(f.key)).rejects.toMatchObject({code:kind==='expired-quote'?'EXPIRED':'SOURCE_CONFLICT'});
  expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(0);
 }));
 it.each(['claimed','missing-ata','delegated-ata','insolvent','genesis','deployment'] as const)('refuses fresh %s facts without replacing saved signed consent',kind=>fixture(async f=>{
  active();const admit=(await factory())(f.conn.db,f.sources),s=f.chain.state,before=await getMiningTaxClaimSigned(f.conn.db,lookup(f));
  if(kind==='claimed'){s.models.cursor.claimed_total=1n;await s.encode('cursor');}
  if(kind==='missing-ata')s.store.delete(s.addresses.ata.toBase58());
  if(kind==='delegated-ata')s.store.get(s.addresses.ata.toBase58())!.data.writeUInt32LE(1,72);
  if(kind==='insolvent')s.store.get(s.backing.rows[1]!.address.toBase58())!.data.writeBigUInt64LE(0n,64);
  if(kind==='genesis')f.rpc.getGenesisHash=async()=>Keypair.generate().publicKey.toBase58();
  if(kind==='deployment'){const data=s.store.get(s.backing.programDataAddress.toBase58())!.data;data[45]=data[45]!^1;}
  await expect(admit(f.key)).rejects.toThrow();expect(await getMiningTaxClaimSigned(f.conn.db,lookup(f))).toEqual(before);expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(0);
 }));
 it('checks mining pause and original wall-clock interval before and after asynchronous measurements',()=>fixture(async f=>{
  const admit=(await factory())(f.conn.db,f.sources);vi.stubEnv('PHASE_E_MINING_ENABLED','false');await expect(admit(f.key)).rejects.toMatchObject({code:'DISABLED'});expect(f.calls.connect).toBe(0);
  active();f.control.now=new Date(Date.parse(f.record.artifact.preparedAt)-1);await expect(admit(f.key)).rejects.toMatchObject({code:'EXPIRED'});expect(f.calls.connect).toBe(0);
  f.control.now=new Date(f.record.artifact.expiresAt);await expect(admit(f.key)).rejects.toMatchObject({code:'EXPIRED'});expect(f.calls.connect).toBe(0);
  f.control.now=new Date(f.record.artifact.preparedAt);f.control.afterFee=async()=>{vi.stubEnv('PHASE_E_MINING_ENABLED','false');};await expect(admit(f.key)).rejects.toMatchObject({code:'DISABLED'});
  active();f.control.afterFee=async()=>{f.control.now=new Date(f.record.artifact.expiresAt);};await expect(admit(f.key)).rejects.toMatchObject({code:'EXPIRED'});
 }));
 it('keeps historical finality recoverable after admission expiry and pause',()=>fixture(async f=>{
  active();const admit=(await factory())(f.conn.db,f.sources);f.control.now=new Date(f.record.artifact.expiresAt);await expect(admit(f.key)).rejects.toMatchObject({code:'EXPIRED'});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');await f.stage('paid');const settled=await createMiningTaxClaimSettlement(f.conn.db,f.options)(f.key);expect(settled.claimFinalized).toBe(true);
  expect(await getMiningTaxClaimSettlement(f.conn.db,f.key)).toEqual(settled);
 }));
 it('rejects malformed keys, wrong actor and absent exact signature before RPC',()=>fixture(async f=>{
  active();const make=await factory(),admit=make(f.conn.db,f.sources);
  for(const change of [{ordinal:-1},{ordinal:2},{idempotencyKey:'bad'},{signature:'x'},{wallet:Keypair.generate().publicKey.toBase58(),claimId:randomUUID()},{[Symbol('extra')]:true}])await expect(admit({...f.key,...change})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(admit({...f.key,wallet:f.buyer})).rejects.toMatchObject({code:'NOT_SIGNED'});await expect(admit(f.key)).rejects.toMatchObject({code:'NOT_SIGNED'});expect(f.calls.connect).toBe(0);
  expect(()=>make(f.conn.db,{...f.sources,timeoutMs:30001})).toThrow();expect(()=>make(f.conn.db,{...f.sources,unknown:true} as never)).toThrow();
 },{persistSigned:false}));
 it('copies the saved-key request and independent server trust before asynchronous work',()=>fixture(async f=>{
  active();const trust={mining:{...f.chain.trust.mining},seeker:{...f.chain.trust.seeker,deployment:{...f.chain.trust.seeker.deployment}}},admit=(await factory())(f.conn.db,{...f.sources,trust});
  trust.mining.keepMint=Keypair.generate().publicKey;trust.seeker.deployment.programDataSha256='00'.repeat(32);const request={...f.key},pending=admit(request);request.ordinal=1;request.wallet=f.buyer;
  expect(await pending).toMatchObject(f.key);
 }));
 // 2026-10-10 (CI cluster F): the same admitter must both time out on the hung RPC and then
 // admit for real once that RPC drains, so its deadline also bounds the final complete
 // admission (DB reads, quote and snapshot verification). 1 s left no headroom: under CI
 // load the final admission itself hit TIMEOUT (run 37503885235). 5 s matches the 32-slot
 // case below; the rule pinned (capacity retained until the transport drains) is unchanged.
 it('retains timed-out ignored-abort RPC capacity until the concrete transport drains',()=>fixture(async f=>{
  active();const originalGenesis=f.rpc.getGenesisHash;let release!:(v:string)=>void,entered!:()=>void,calls=0;const began=new Promise<void>(r=>{entered=r;});
  f.rpc.getGenesisHash=()=>{calls++;entered();return new Promise(r=>{release=r;});};const admit=(await factory())(f.conn.db,{...f.sources,timeoutMs:5000});
  const rejected=expect(admit(f.key)).rejects.toMatchObject({code:'TIMEOUT'});await began;await rejected;await expect(admit(f.key)).rejects.toMatchObject({code:'TIMEOUT'});expect(calls).toBe(1);
  release(f.chain.trust.mining.expectedGenesisHash);await tick();f.rpc.getGenesisHash=originalGenesis;expect(await admit(f.key)).toMatchObject(f.key);
  expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(0);
 }));
 it('retains all 32 abandoned RPC slots and rejects the 33rd until actual drain',()=>fixture(async f=>{
  active();const keys=[f.key];for(let i=1;i<32;i++)keys.push(await f.forkClaim());const extra=await f.forkClaim(),old=f.rpc.getGenesisHash,releases:Array<()=>void>=[];let entered!:()=>void;const began=new Promise<void>(r=>{entered=r;});
  f.rpc.getGenesisHash=()=>new Promise<string>(resolve=>{releases.push(()=>resolve(f.chain.trust.mining.expectedGenesisHash));if(releases.length===32)entered();});
  const admit=(await factory())(f.conn.db,{...f.sources,timeoutMs:5000}),all=Promise.all(keys.map(key=>admit(key).then(()=>({code:'unexpected'}),e=>e)));
  try{await Promise.race([began,all.then(()=>{if(releases.length!==32)throw Error(`Only ${releases.length}/32 RPCs entered`);})]);expect((await all).every(e=>e.code==='TIMEOUT')).toBe(true);await tick();await expect(admit(extra)).rejects.toMatchObject({code:'BUSY'});expect(releases).toHaveLength(32);}
  finally{for(const release of releases)release();f.rpc.getGenesisHash=old;await tick();}
  expect(await admit(f.key)).toMatchObject(f.key);
 }));
});
