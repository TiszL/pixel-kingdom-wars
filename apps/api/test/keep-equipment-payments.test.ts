/** Real SQL reservation/preparation/retention/delivery composition. RPC adapters
 * supply raw account bytes and signed transaction execution observations; no
 * test can inject an already-verified payment into the production service. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT} from '@shardkeep/shared';
import {KeepEquipmentPurchaseSchema,KeepEquipmentReviewSchema,KeepEquipmentSendSchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {createDb} from '../src/db/client';
import {createKeepEquipmentPayments,type KeepEquipmentPaymentDependencies} from '../src/game/keepEquipmentPayments';
import {bootstrapSystemAccounts,getOrCreatePlayerAccount,postTransaction} from '../src/ledger';
import {connectTestDb} from './helpers';
import {TEST_DATABASE_URL} from './db-url';
import {fixtureFee,fixtureRent,paymentFixture,paymentStock,sellerShare,transferPaymentBase} from './fixtures/keepEquipmentPayments';

const conn=connectTestDb(),db=conn.db;
beforeEach(()=>vi.stubEnv('MULTI_BASE_ENABLED','true'));
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});
afterAll(()=>conn.sql.end());
const claims=(signature:string)=>conn.sql`select signature,consumer_kind,consumer_id from payment_signature_claims where signature=${signature}`;
const deliveries=(id:string)=>conn.sql`select fill_id from keep_equipment_deliveries where fill_id=${id}`;
type Fixture=Awaited<ReturnType<typeof paymentFixture>>;
async function expectHeldStock(f:Fixture){
 expect(await paymentStock(conn,f.seller.baseId)).toEqual({available:'0',market_outgoing:'10',market_incoming:'0'});
 expect(await paymentStock(conn,f.buyer.baseId)).toEqual({available:'0',market_outgoing:'0',market_incoming:'2'});
 expect(await deliveries(f.fill.id)).toHaveLength(0);
}
async function expectDeliveredStock(f:Fixture){
 expect(await paymentStock(conn,f.seller.baseId)).toEqual({available:'0',market_outgoing:'8',market_incoming:'0'});
 expect(await paymentStock(conn,f.buyer.baseId)).toEqual({available:'2',market_outgoing:'0',market_incoming:'0'});
 expect(await deliveries(f.fill.id)).toHaveLength(1);
}
async function deposit(f:Fixture,payment:string|null=null){
 const id=randomUUID();await conn.sql`insert into deposits(id,player_wallet,kind,reference,payment_signature) values(${id},${f.buyer.wallet},'gems_buy',${randomUUID()},${payment})`;return id;
}

it.each((['legacy',0] as const).flatMap(version=>[false,true].map(missingAta=>({version,missingAta}))))('delivers $version missing ATA=$missingAta only after actual readers prove original seller credit and burn',async({version,missingAta})=>{
 const f=await paymentFixture(conn,version,missingAta);expect((await f.payments.read(f.buyer.wallet,f.fill.id)).status).toBe('reserved');await expectHeldStock(f);
 const {state,p}=await f.retain();expect(state.status).toBe('signed');await expectHeldStock(f);
 expect(state.wire!.messageSha256).toBe(p.messageSha256);expect(p.original.sellerAtaExists).toBe(!missingAta);
 expect(p.costs).toMatchObject({feeLamports:String(fixtureFee),rentLamports:String(missingAta?fixtureRent:0)});
 expect(await claims(state.wire!.signature)).toEqual([{signature:state.wire!.signature,consumer_kind:'keep_equipment_market',consumer_id:f.fill.id}]);
 const done=await f.payments.recover(f.buyer.wallet,f.fill.id),total=BigInt(f.fill.totalBaseUnits);
 expect(KeepEquipmentPurchaseSchema.parse(done)).toEqual(done);
 expect(done).toMatchObject({status:'delivered',signingAuthorized:false,broadcastAuthorized:false,fenceReleaseAuthorized:false,unpaidProven:false});
 expect(done.delivery).toMatchObject({fillId:f.fill.id,buyerBaseId:f.buyer.baseId,quantity:'2',itemId:'route_compass',proof:{signature:state.wire!.signature,totalBaseUnits:total.toString(),sellerBaseUnits:sellerShare(total).toString(),burnBaseUnits:(total-sellerShare(total)).toString(),sellerAtaCreated:missingAta,sellerAtaRentLamports:String(missingAta?fixtureRent:0),finalizedAgreement:true,providerIds:f.trust.providerIds,expectedGenesisHash:f.genesis}});
 await expectDeliveredStock(f);expect(f.controls.preparationCalls).toBe(2);expect(f.controls.finalityCalls).toBe(2);expect(f.controls.signals.every(s=>s.aborted)).toBe(true);
});

it('concurrent preparation freezes one consent and later object mutations or changed operator blockhash cannot replace it',async()=>{
 const f=await paymentFixture(conn,0,true),states=await Promise.all([f.payments.prepare(f.buyer.wallet,f.fill.id),f.payments.prepare(f.buyer.wallet,f.fill.id)]);
 expect(states[0]).toEqual(states[1]);const before=structuredClone(states[0]!);
 states[0]!.preparation!.original.sellerAtaRentCapLamports='1';states[0]!.preparation!.providerIds[0]='request-provider';states[0]!.preparation!.messageHex='00';
 f.controls.paused=true;f.controls.preparationMode='fail';
 expect(await f.payments.prepare(f.buyer.wallet,f.fill.id)).toEqual(before);
 expect(await createKeepEquipmentPayments(db).prepare(f.buyer.wallet,f.fill.id)).toEqual(before);
 expect(await conn.sql`select fill_id from keep_equipment_payment_preparations where fill_id=${f.fill.id}`).toHaveLength(1);await expectHeldStock(f);
});

it.each(['missing','disagree','fail'] as const)('holds %s preparation without saving an unsigned packet or releasing stock',async mode=>{
 const f=await paymentFixture(conn);f.controls.preparationMode=mode;
 await expect(f.prepare()).rejects.toMatchObject({code:'KEEP_EQUIPMENT_PREPARATION_UNAVAILABLE'});
 expect((await f.payments.read(f.buyer.wallet,f.fill.id)).status).toBe('reserved');await expectHeldStock(f);
 expect(await conn.sql`select signature from payment_signature_claims where consumer_id=${f.fill.id}`).toHaveLength(0);
 f.controls.preparationMode='ok';expect((await f.prepare()).original.reservationId).toBe(f.fill.id);
});

it('a pause blocks fresh preparation while retained originals survive restart and concurrent completion exactly once',async()=>{
 const blocked=await paymentFixture(conn);blocked.controls.paused=true;
 await expect(blocked.prepare()).rejects.toThrow('Fixture market paused');await expectHeldStock(blocked);
 const {assertAdmission:_admission,...disabled}=blocked.deps;
 await expect(createKeepEquipmentPayments(db,disabled).prepare(blocked.buyer.wallet,blocked.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_MARKET_DISABLED'});
 const f=await paymentFixture(conn),p=await f.prepare(),bytes=f.sign(p);f.controls.wire=Uint8Array.from(bytes);f.controls.paused=true;
 const saved=await Promise.all([f.payments.retainSigned(f.buyer.wallet,f.fill.id,bytes),createKeepEquipmentPayments(db).retainSigned(f.buyer.wallet,f.fill.id,bytes)]);
 expect(saved[0]).toEqual(saved[1]);bytes.fill(0);expect((await f.payments.read(f.buyer.wallet,f.fill.id)).wire).toEqual(saved[0]!.wire);
 const restart=createKeepEquipmentPayments(db,f.deps),done=await Promise.all([f.payments.recover(f.buyer.wallet,f.fill.id),restart.recover(f.buyer.wallet,f.fill.id)]);
 expect(done[0]).toEqual(done[1]);await expectDeliveredStock(f);
 const calls=f.controls.finalityCalls;expect(await createKeepEquipmentPayments(db).recover(f.buyer.wallet,f.fill.id)).toEqual(done[0]);expect(f.controls.finalityCalls).toBe(calls);
});

it.each(['missing','disagree','failed','throw','genesis','unfinalized'] as const)('retains the exact original and stock through %s finality evidence, then recovers it once',async mode=>{
 const f=await paymentFixture(conn),{state}=await f.retain();f.controls.finalityMode=mode;
 await expect(f.payments.recover(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_PAYMENT_UNAVAILABLE'});
 expect((await f.payments.read(f.buyer.wallet,f.fill.id)).wire).toEqual(state.wire);await expectHeldStock(f);expect((await claims(state.wire!.signature))[0]?.consumer_id).toBe(f.fill.id);
 f.controls.finalityMode='ok';await f.payments.recover(f.buyer.wallet,f.fill.id);await expectDeliveredStock(f);
});

it('rejects changed messages and invalid signatures before and after retention; a genuine different packet cannot replace the original',async()=>{
 const f=await paymentFixture(conn,0),p=await f.prepare(),wire=f.sign(p),invalid=Uint8Array.from(wire);invalid[1]=invalid[1]!^1;
 await expect(f.payments.retainSigned(f.buyer.wallet,f.fill.id,invalid)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_PAYMENT_WIRE'});
 expect((await f.payments.read(f.buyer.wallet,f.fill.id)).status).toBe('prepared');
 const first=await f.payments.retainSigned(f.buyer.wallet,f.fill.id,wire),different=VersionedTransaction.deserialize(wire);
 different.message.recentBlockhash=Keypair.generate().publicKey.toBase58();different.sign([f.buyer.signer]);
 for(const other of [different.serialize(),invalid,Uint8Array.from([...wire,0]),new Uint8Array(1233)])await expect(f.payments.retainSigned(f.buyer.wallet,f.fill.id,other)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_PAYMENT_WIRE'});
 expect(await f.payments.read(f.buyer.wallet,f.fill.id)).toEqual(first);expect(await claims(bs58.encode(different.signatures[0]!))).toHaveLength(0);await expectHeldStock(f);
});

it('recovery after both deed transfers delivers to the original base and preserves original buyer privacy',async()=>{
 const f=await paymentFixture(conn),{state}=await f.retain(),newBuyer=await transferPaymentBase(conn,f.buyer),newSeller=await transferPaymentBase(conn,f.seller);
 for(const actor of [newBuyer,newSeller,f.seller.wallet])await expect(f.payments.read(actor,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_FILL_UNKNOWN'});
 const done=await createKeepEquipmentPayments(db,f.deps).recover(f.buyer.wallet,f.fill.id);
 expect(done.delivery!.buyerBaseId).toBe(f.buyer.baseId);expect(done.delivery!.proof.seller).toBe(f.seller.wallet);expect(done.wire).toEqual(state.wire);await expectDeliveredStock(f);
 expect((await conn.sql`select owner_wallet from bases where id=${f.buyer.baseId}`)[0]?.owner_wallet).toBe(newBuyer);
});

it('unretained, unconfigured or repinned recovery cannot manufacture nonpayment or delivery authority',async()=>{
 const f=await paymentFixture(conn);await expect(f.payments.recover(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_PAYMENT_NOT_RETAINED'});
 await expect(f.payments.retainSigned(f.buyer.wallet,f.fill.id,new Uint8Array(100))).rejects.toMatchObject({code:'KEEP_EQUIPMENT_PREPARATION_REQUIRED'});
 const {state}=await f.retain();await expect(createKeepEquipmentPayments(db).recover(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_PAYMENT_UNAVAILABLE'});
 const restart=createKeepEquipmentPayments(db,{...f.deps,trust:{...f.trust,providerIds:['new-one','new-two']}});
 await expect(restart.recover(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_PAYMENT_CONFIGURATION'});
 expect((await f.payments.read(f.buyer.wallet,f.fill.id)).wire).toEqual(state.wire);await expectHeldStock(f);
});

it('a retained payment signature rejects Gems finalization and rolls back its actual ledger grant',async()=>{
 const f=await paymentFixture(conn),{state}=await f.retain(),id=await deposit(f),signature=state.wire!.signature,sys=await bootstrapSystemAccounts(db),account=await getOrCreatePlayerAccount(db,f.buyer.wallet,'player_gems'),grantKey=randomUUID();let posted=false;
 await expect(db.transaction(async tx=>{
  await postTransaction(tx,{idempotencyKey:grantKey,type:'test.keep.market.signature',entries:[{account:sys.onchain_inflow,delta:-7n},{account:sys.emission_pool,delta:7n},{account:sys.gems_mint,delta:-7n},{account:account.id,delta:7n}]});posted=true;
  await tx.execute(sql`update deposits set tx_signature=${signature},status='credited' where id=${id}`);
 })).rejects.toMatchObject({cause:{code:'23505',message:'PAYMENT_SIGNATURE_ALREADY_CLAIMED'}});
 expect(posted).toBe(true);expect(await conn.sql`select id from ledger_transactions where idempotency_key=${grantKey}`).toHaveLength(0);
 expect((await getOrCreatePlayerAccount(db,f.buyer.wallet,'player_gems')).balance).toBe(account.balance);
 expect((await conn.sql`select status,tx_signature from deposits where id=${id}`)[0]).toEqual({status:'pending',tx_signature:null});
 expect((await claims(signature))[0]?.consumer_id).toBe(f.fill.id);await expectHeldStock(f);
});

it('a deposit that claimed the same genuine signature first rolls back market retention without releasing its reservation',async()=>{
 const f=await paymentFixture(conn),p=await f.prepare(),wire=f.sign(p),signature=bs58.encode(VersionedTransaction.deserialize(wire).signatures[0]!),id=await deposit(f,signature);
 await expect(f.payments.retainSigned(f.buyer.wallet,f.fill.id,wire)).rejects.toMatchObject({cause:{code:'23505',message:'PAYMENT_SIGNATURE_ALREADY_CLAIMED'}});
 expect((await f.payments.read(f.buyer.wallet,f.fill.id)).status).toBe('prepared');expect((await claims(signature))[0]).toMatchObject({consumer_kind:'deposit',consumer_id:id});await expectHeldStock(f);
});

it('a delivery capacity failure rolls back seller custody and receipt while preserving the already-retained signature',async()=>{
 const f=await paymentFixture(conn),{state}=await f.retain();await conn.sql`update ordinary_equipment_stocks set market_incoming=0 where base_id=${f.buyer.baseId} and item_id='route_compass'`;
 await expect(f.payments.recover(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({cause:{message:'KEEP_EQUIPMENT_PAYMENT_CAPACITY'}});
 expect(await paymentStock(conn,f.seller.baseId)).toMatchObject({market_outgoing:'10'});expect(await paymentStock(conn,f.buyer.baseId)).toMatchObject({available:'0'});expect(await deliveries(f.fill.id)).toHaveLength(0);
 expect((await claims(state.wire!.signature))[0]?.consumer_id).toBe(f.fill.id);
 await conn.sql`update ordinary_equipment_stocks set market_incoming=2 where base_id=${f.buyer.baseId} and item_id='route_compass'`;
 await f.payments.recover(f.buyer.wallet,f.fill.id);await expectDeliveredStock(f);
});

it('raw owner writes cannot mutate or truncate retained evidence; ignored replay inserts have no stock effects',async()=>{
 const f=await paymentFixture(conn),{wire}=await f.retain(),done=await f.payments.recover(f.buyer.wallet,f.fill.id);
 for(const table of ['keep_equipment_payment_preparations','keep_equipment_payment_wires','keep_equipment_deliveries']){
  await expect(conn.sql`update ${conn.sql(table)} set fill_id=fill_id where fill_id=${f.fill.id}`).rejects.toMatchObject({message:'KEEP_EQUIPMENT_PAYMENT_IMMUTABLE'});
  await expect(conn.sql`delete from ${conn.sql(table)} where fill_id=${f.fill.id}`).rejects.toMatchObject({message:'KEEP_EQUIPMENT_PAYMENT_IMMUTABLE'});
  await expect(conn.sql`truncate ${conn.sql(table)} cascade`).rejects.toMatchObject({message:'KEEP_EQUIPMENT_PAYMENT_IMMUTABLE'});
 }
 await conn.sql`insert into keep_equipment_payment_wires(fill_id,signed_transaction) values(${f.fill.id},${Buffer.from(wire)}) on conflict(fill_id) do nothing`;
 await conn.sql`insert into keep_equipment_deliveries(fill_id,proof) values(${f.fill.id},${JSON.stringify(done.delivery!.proof)}::jsonb) on conflict(fill_id) do nothing`;
 expect(await f.payments.read(f.buyer.wallet,f.fill.id)).toEqual(done);await expectDeliveredStock(f);
});

it('raw missing, null and malformed proof amounts or slots fail closed before SQL can move stock',async()=>{
 const f=await paymentFixture(conn);await f.retain();const done=await f.payments.recover(f.buyer.wallet,f.fill.id),proof=done.delivery!.proof;
 for(const field of ['slot','sellerBaseUnits','burnBaseUnits','expectedGenesisHash','providerIds'] as const){
  const missing:Record<string,unknown>={...proof};delete missing[field];
  for(const value of [missing,{...proof,[field]:null},{...proof,[field]:'invalid'}])await expect(conn.sql`insert into keep_equipment_deliveries(fill_id,proof) values(${f.fill.id},${JSON.stringify(value)}::jsonb)`).rejects.toMatchObject({code:'P0001',message:'KEEP_EQUIPMENT_PAYMENT_PROOF'});
 }
 for(const slot of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,99])await expect(conn.sql`insert into keep_equipment_deliveries(fill_id,proof) values(${f.fill.id},${JSON.stringify({...proof,slot})}::jsonb)`).rejects.toMatchObject({code:'P0001',message:'KEEP_EQUIPMENT_PAYMENT_PROOF'});
 for(const amount of ['NaN','Infinity','0','-1','1.2','2e4'])await expect(conn.sql`insert into keep_equipment_deliveries(fill_id,proof) values(${f.fill.id},${JSON.stringify({...proof,burnBaseUnits:amount})}::jsonb)`).rejects.toMatchObject({code:'P0001',message:'KEEP_EQUIPMENT_PAYMENT_PROOF'});
 await expectDeliveredStock(f);expect(await f.payments.read(f.buyer.wallet,f.fill.id)).toEqual(done);
});

it('raw malformed preparation, unsigned wire and non-read-committed insertion cannot become accepted evidence',async()=>{
 const f=await paymentFixture(conn),p=await f.prepare(),{recordedAt:_time,...original}=p,bytes=Buffer.from(p.messageHex,'hex');
 for(const bad of [{...original,minContextSlot:null},{...original,minContextSlot:'NaN'},{...original,original:{...original.original,keepMint:null}}, {...original,broadcastAuthorized:true}])
  await expect(conn.sql`insert into keep_equipment_payment_preparations(fill_id,preparation,message_bytes) values(${f.fill.id},${JSON.stringify(bad)}::jsonb,${bytes})`).rejects.toMatchObject({code:'P0001',message:'KEEP_EQUIPMENT_PAYMENT_PREPARATION'});
 const unsigned=VersionedTransaction.deserialize(f.sign(p));unsigned.signatures[0]!.fill(0);
 await expect(conn.sql`insert into keep_equipment_payment_wires(fill_id,signed_transaction) values(${f.fill.id},${Buffer.from(unsigned.serialize())})`).rejects.toMatchObject({message:'KEEP_EQUIPMENT_PAYMENT_WIRE'});
 await expect(conn.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into keep_equipment_payment_wires(fill_id,signed_transaction) values(${f.fill.id},${Buffer.from(f.sign(p))})`;})).rejects.toMatchObject({message:'KEEP_EQUIPMENT_PAYMENT_READ_COMMITTED'});
 await expect(db.transaction(async tx=>{createKeepEquipmentPayments(tx as unknown as typeof db);})).rejects.toMatchObject({code:'KEEP_EQUIPMENT_PAYMENT_TOP_LEVEL'});
 expect((await f.payments.read(f.buyer.wallet,f.fill.id)).status).toBe('prepared');await expectHeldStock(f);
});

it('restricted runtime role cannot author payment evidence even when mistakenly granted table writes',async()=>{
 const f=await paymentFixture(conn),p=await f.prepare(),wire=f.sign(p),role='keep_payment_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  await conn.sql.unsafe(`grant usage on schema public to ${role}; grant all on keep_equipment_payment_preparations,keep_equipment_payment_wires,keep_equipment_deliveries to ${role}`);
  const url=new URL(TEST_DATABASE_URL);url.username=role;url.password=password;runtime=createDb(url.toString(),{deedEconomyWriter:false,marketRecoveryWriter:false});
  await expect(createKeepEquipmentPayments(runtime.db,f.deps).retainSigned(f.buyer.wallet,f.fill.id,wire)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_PAYMENT_OWNER'});
  await expect(runtime.sql`insert into keep_equipment_payment_wires(fill_id,signed_transaction) values(${f.fill.id},${Buffer.from(wire)})`).rejects.toMatchObject({code:'42501',message:'KEEP_EQUIPMENT_PAYMENT_OWNER'});
 }finally{await runtime?.sql.end();await conn.sql.unsafe(`drop owned by ${role}; drop role ${role}`);}
 expect((await f.payments.read(f.buyer.wallet,f.fill.id)).status).toBe('prepared');await expectHeldStock(f);
});

it('sealed custody rejects old payment migration and preserves receipts, global claims and exactly-once stock',async()=>{
 const f=await paymentFixture(conn);await f.retain();const done=await f.payments.recover(f.buyer.wallet,f.fill.id),claim=await claims(done.wire!.signature);
 const statements=readFileSync(new URL('../drizzle/0244_keep_equipment_payments.sql',import.meta.url),'utf8').split('--> statement-breakpoint').filter(s=>s.trim());
 await expect(conn.sql.begin(async tx=>{for(const statement of statements)await tx.unsafe(statement);await tx`select public.shardkeep_divine_fragment_source()`;})).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
 expect(await f.payments.recover(f.buyer.wallet,f.fill.id)).toEqual(done);expect(await claims(done.wire!.signature)).toEqual(claim);await expectDeliveredStock(f);
});

it('current review prices only the immutable original message and keeps full rent consent through an idempotent ATA race',async()=>{
 const f=await paymentFixture(conn,0,true),p=await f.prepare(),before=await f.payments.read(f.buyer.wallet,f.fill.id),latest=f.controls.latestCalls;
 f.createSellerAta();f.controls.fee=fixtureFee+1;
 const reviewed=await f.payments.review(f.buyer.wallet,f.fill.id);expect(KeepEquipmentReviewSchema.parse(reviewed)).toEqual(reviewed);
 expect(reviewed.purchase).toEqual(before);expect(reviewed.current).toMatchObject({messageHex:p.messageHex,messageSha256:p.messageSha256,blockhash:p.blockhash,lastValidBlockHeight:p.lastValidBlockHeight,currentReviewPassed:true,signingAuthorized:false,broadcastAuthorized:false,finalityVerified:false,
  original:{sellerAtaExists:false,sellerAtaRentCapLamports:String(fixtureRent)},balances:{sellerAccountState:'existing'},costs:{feeLamports:String(fixtureFee+1),rentLamports:String(fixtureRent)}});
 expect(f.controls.latestCalls).toBe(latest);expect(f.controls.feeMessages.slice(-2)).toEqual([p.messageHex,p.messageHex]);expect(f.controls.validityHashes.slice(-2)).toEqual([p.blockhash,p.blockhash]);
 expect(await f.payments.read(f.buyer.wallet,f.fill.id)).toEqual(before);await expectHeldStock(f);
});

it.each(['expired','rent increased','invalid blockhash','insufficient KEEP','insufficient SOL','wrong mint configuration'] as const)('current %s holds the saved original without preparing replacement bytes',async mode=>{
 const f=await paymentFixture(conn,'legacy',true);await f.retain();const before=await f.payments.read(f.buyer.wallet,f.fill.id),latest=f.controls.latestCalls;
 if(mode==='expired')f.controls.height=301;
 if(mode==='rent increased')f.controls.rent++;
 if(mode==='invalid blockhash')f.controls.blockhashValid=false;
 if(mode==='insufficient KEEP')Buffer.from(f.accountRows[1]!.data.buffer,f.accountRows[1]!.data.byteOffset,f.accountRows[1]!.data.byteLength).writeBigUInt64LE(0n,64);
 if(mode==='insufficient SOL')f.accountRows[3]={...f.accountRows[3]!,lamports:0};
 const payments=mode==='wrong mint configuration'?createKeepEquipmentPayments(db,{...f.deps,trust:{...f.trust,expectedKeepMint:Keypair.generate().publicKey.toBase58()}}):f.payments;
 await expect(payments.review(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:mode==='wrong mint configuration'?'KEEP_EQUIPMENT_PAYMENT_CONFIGURATION':'KEEP_EQUIPMENT_CURRENT_UNAVAILABLE'});
 expect(await f.payments.read(f.buyer.wallet,f.fill.id)).toEqual(before);expect(f.controls.latestCalls).toBe(latest);await expectHeldStock(f);
});

function broadcaster(f:Fixture,send?:(signature:string)=>Promise<string>){
 const calls:Array<{bytes:Uint8Array;options:unknown}>=[],signals:AbortSignal[]=[];
 const control={genesis:f.genesis,slot:120};
 const connect:NonNullable<KeepEquipmentPaymentDependencies['broadcastConnect']>=signal=>{
  signals.push(signal);return {getGenesisHash:async()=>control.genesis,getSlot:async()=>control.slot,sendRawTransaction:async(bytes,options)=>{
   const saved=await f.payments.read(f.buyer.wallet,f.fill.id);expect(saved.status).toBe('signed');expect(saved.wire).not.toBeNull();
   expect(Buffer.from(bytes).toString('hex')).toBe(saved.wire!.signedTransactionHex);expect((await claims(saved.wire!.signature))[0]?.consumer_id).toBe(f.fill.id);
   expect(options).toEqual({skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:100});
   calls.push({bytes:Uint8Array.from(bytes),options});return send?send(saved.wire!.signature):saved.wire!.signature;
  }};
 };
 return {connect,calls,signals,control};
}

it('relay sends only retained exact bytes after current review and leaves stock held until independent finalized recovery',async()=>{
 const f=await paymentFixture(conn),{state}=await f.retain();f.controls.finalityMode='missing';const relay=broadcaster(f),service=createKeepEquipmentPayments(db,{...f.deps,broadcastConnect:relay.connect});
 const result=await service.deliver(f.buyer.wallet,f.fill.id);expect(KeepEquipmentSendSchema.parse(result)).toEqual(result);
 expect(result).toMatchObject({status:'submitted',reason:null,broadcastAuthorized:false,fenceReleaseAuthorized:false,purchase:{status:'signed'}});
 expect(result.purchase.wire).toEqual(state.wire);expect(relay.calls).toHaveLength(1);expect(relay.signals.every(s=>s.aborted)).toBe(true);await expectHeldStock(f);
 relay.calls[0]!.bytes.fill(0);expect((await service.read(f.buyer.wallet,f.fill.id)).wire).toEqual(state.wire);
 f.controls.finalityMode='ok';const done=await service.deliver(f.buyer.wallet,f.fill.id);expect(done.status).toBe('delivered');expect(relay.calls).toHaveLength(1);await expectDeliveredStock(f);
});

it('unsigned and paused originals never send; a payment already finalized during a pause still recovers',async()=>{
 const f=await paymentFixture(conn),relay=broadcaster(f),service=createKeepEquipmentPayments(db,{...f.deps,broadcastConnect:relay.connect});
 expect(await service.deliver(f.buyer.wallet,f.fill.id)).toMatchObject({status:'held',reason:'NOT_SIGNED'});await f.prepare();
 expect(await service.deliver(f.buyer.wallet,f.fill.id)).toMatchObject({status:'held',reason:'NOT_SIGNED'});expect(relay.calls).toHaveLength(0);
 await f.retain();f.controls.finalityMode='missing';f.controls.paused=true;
 expect(await service.deliver(f.buyer.wallet,f.fill.id)).toMatchObject({status:'held',reason:'CURRENT_REVIEW_HELD'});expect(relay.calls).toHaveLength(0);await expectHeldStock(f);
 f.controls.finalityMode='ok';expect((await service.deliver(f.buyer.wallet,f.fill.id)).status).toBe('delivered');expect(relay.calls).toHaveLength(0);await expectDeliveredStock(f);
});

it('a lost relay reply and process restart recover the exact original once without retransmitting or clearing its claim',async()=>{
 const f=await paymentFixture(conn),{state}=await f.retain();f.controls.finalityMode='missing';
 const relay=broadcaster(f,async()=>{f.controls.finalityMode='ok';throw Error('Reply dropped after execution');});
 const service=createKeepEquipmentPayments(db,{...f.deps,broadcastConnect:relay.connect});
 expect(await service.deliver(f.buyer.wallet,f.fill.id)).toMatchObject({status:'held',reason:'SEND_UNCERTAIN'});await expectHeldStock(f);
 f.controls.paused=true;const restart=createKeepEquipmentPayments(db,f.deps),done=await restart.deliver(f.buyer.wallet,f.fill.id);
 expect(done.status).toBe('delivered');expect(done.purchase.wire).toEqual(state.wire);expect(relay.calls).toHaveLength(1);await expectDeliveredStock(f);
 expect(await createKeepEquipmentPayments(db).deliver(f.buyer.wallet,f.fill.id)).toEqual(done);
});

it.each(['wrong cluster','stale context','wrong signature','RPC failure'] as const)('relay %s holds its immutable wire and never turns a send response into stock',async mode=>{
 const f=await paymentFixture(conn),{state}=await f.retain();f.controls.finalityMode='missing';
 const relay=broadcaster(f,async signature=>{if(mode==='RPC failure')throw Error('RPC failed');return mode==='wrong signature'?bs58.encode(new Uint8Array(64).fill(1)):signature;});
 if(mode==='wrong cluster')relay.control.genesis=Keypair.generate().publicKey.toBase58();if(mode==='stale context')relay.control.slot=99;
 const service=createKeepEquipmentPayments(db,{...f.deps,broadcastConnect:relay.connect}),result=await service.deliver(f.buyer.wallet,f.fill.id);
 expect(result).toMatchObject({status:'held',reason:'SEND_UNCERTAIN'});expect(result.purchase.wire).toEqual(state.wire);
 expect(relay.calls).toHaveLength(mode==='wrong cluster'||mode==='stale context'?0:1);expect(relay.signals.every(s=>s.aborted)).toBe(true);await expectHeldStock(f);
 expect((await claims(state.wire!.signature))[0]?.consumer_id).toBe(f.fill.id);
});

it('an abort-ignoring relay keeps all four capacity slots occupied until its actual calls drain',async()=>{
 const f=await paymentFixture(conn),{state}=await f.retain();f.controls.finalityMode='missing';
 const pending:Array<()=>void>=[];let ignoreAbort=true;
 const relay=broadcaster(f,signature=>ignoreAbort?new Promise(resolve=>pending.push(()=>resolve(signature))):Promise.resolve(signature));
 const service=createKeepEquipmentPayments(db,{...f.deps,trust:{...f.trust,deadlineMs:100},broadcastConnect:relay.connect});
 try{
  for(let i=0;i<4;i++)expect(await service.deliver(f.buyer.wallet,f.fill.id)).toMatchObject({status:'held',reason:'SEND_UNCERTAIN'});
  expect(pending).toHaveLength(4);expect(relay.signals.every(s=>s.aborted)).toBe(true);
  expect(await service.deliver(f.buyer.wallet,f.fill.id)).toMatchObject({status:'held',reason:'BUSY'});expect(relay.calls).toHaveLength(4);await expectHeldStock(f);
 }finally{ignoreAbort=false;for(const release of pending)release();await new Promise<void>(resolve=>setImmediate(resolve));}
 expect(await service.deliver(f.buyer.wallet,f.fill.id)).toMatchObject({status:'submitted',purchase:{wire:state.wire}});expect(relay.calls).toHaveLength(5);await expectHeldStock(f);
});

it('review lease boundary rejects expired or backward time before returning current consent',async()=>{
 const f=await paymentFixture(conn);await f.retain();const before=await f.payments.read(f.buyer.wallet,f.fill.id),started=Date.now();
 vi.useFakeTimers({toFake:['Date']});
 for(const delta of [PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.reviewMaxAgeMs,-1]){
  vi.setSystemTime(started);
  const first:KeepEquipmentPaymentDependencies['preparationConnect']=f.deps.preparationConnect;
  const service=createKeepEquipmentPayments(db,{...f.deps,preparationConnect:[signal=>{const rpc=first[0](signal);return {...rpc,getFeeForMessage:async(...args)=>{const fee=await rpc.getFeeForMessage(...args);vi.setSystemTime(started+delta);return fee;}};},first[1]]});
  await expect(service.review(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_CURRENT_EXPIRED'});
  expect(await service.read(f.buyer.wallet,f.fill.id)).toEqual(before);await expectHeldStock(f);
 }
});

it('review lease boundary rejects expired or backward time at the last pre-send check without clearing the original',async()=>{
 const f=await paymentFixture(conn),{state}=await f.retain(),started=Date.now();f.controls.finalityMode='missing';
 vi.useFakeTimers({toFake:['Date']});
 for(const delta of [PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.reviewMaxAgeMs,-1]){
  vi.setSystemTime(started);const relay=broadcaster(f);
  const service=createKeepEquipmentPayments(db,{...f.deps,broadcastConnect:signal=>{const rpc=relay.connect(signal);return {...rpc,getSlot:async(...args)=>{const slot=await rpc.getSlot(...args);vi.setSystemTime(started+delta);return slot;}};}});
  expect(await service.deliver(f.buyer.wallet,f.fill.id)).toMatchObject({status:'held',reason:'SEND_UNCERTAIN',purchase:{wire:state.wire}});
  expect(relay.calls).toHaveLength(0);expect(relay.signals.every(s=>s.aborted)).toBe(true);expect((await claims(state.wire!.signature))[0]?.consumer_id).toBe(f.fill.id);await expectHeldStock(f);
 }
});
