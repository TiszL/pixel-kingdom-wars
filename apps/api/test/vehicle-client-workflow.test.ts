/** D182 redacted originals keep the accepted irreversible destination and exact
 * cryptographic receipt. Readability during a pause is not signing authority. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
let f:Awaited<ReturnType<typeof vehicleBurnDatabase>>;
beforeEach(async()=>{f=await vehicleBurnDatabase();for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');},120000);
afterEach(async()=>{await f?.dispose();vi.unstubAllEnvs();},120000);
function privateFields(value:unknown):void{if(!value||typeof value!=='object')return;for(const [key,child] of Object.entries(value)){expect(['owner_attestation','anchor','proof','history','assetDataHex','collectionDataHex','signedTransactionHex']).not.toContain(key);privateFields(child);}}
it('reads the original preparation with redacted custody and no signing or install authority',async()=>{
 const {createVehicleClient}=await import('../src/game/vehicleClient');const service=createVehicleClient(f.conn.db);
 const state=await service.read(f.actor,{kind:'installation',id:f.reservation.id});privateFields(state);
 expect(state).toMatchObject({version:1,kind:'installation',record:{wallet:f.actor,status:'prepared',reservation:{reservationId:f.reservation.id,request:{baseId:f.baseId,berthId:f.berthId,assetId:f.identity.assetId}},preparation:{messageSha256:f.preparation.messageSha256},signingAuthorized:false,installationAuthorized:false},consentSource:{anchorSlot:100},burnReceipt:null});
 expect(await service.readByKey(f.actor,'installation',f.reservation.idempotencyKey)).toMatchObject({record:{reservation:{reservationId:f.reservation.id}}});
 expect(await service.review(f.actor,{kind:'installation',id:f.reservation.id})).toMatchObject({status:'held',reason:'PROVIDER_UNAVAILABLE',observation:null});
},120000);
it('recovers an actual lost-wire burn while paused and retains the bound original terminal without providers',async()=>{
 const {createVehicleClient}=await import('../src/game/vehicleClient');const connected=createVehicleClient(f.conn.db,{installation:{connect:()=>f.rpc,trust:f.trust}});
 const signed=f.finalizeBurn();vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');
 const result=await connected.recover(f.actor,{kind:'installation',id:f.reservation.id});privateFields(result);
 expect(result).toMatchObject({record:{status:'installed',signed:null,installation:{installationId:f.reservation.id,baseId:f.baseId,berthId:f.berthId,signature:signed.signature}},burnReceipt:{signature:signed.signature,messageSha256:f.preparation.messageSha256,slot:110,finalizedThroughSlot:120}});
 const offline=createVehicleClient(f.conn.db);expect(await offline.deliver(f.actor,{kind:'installation',id:f.reservation.id})).toMatchObject({status:'terminal',client:{burnReceipt:{signature:signed.signature}}});
 expect((await offline.activity(f.actor)).items).toMatchObject([{kind:'installation',id:f.reservation.id,status:'installed',baseId:f.baseId}]);
 expect(await f.conn.sql`select count(*)::int n from advanced_vehicle_installations`).toEqual([{n:1}]);
},120000);

it('reviews and sends only the exact retained original; send acknowledgement never installs it',async()=>{
 const {Message,VersionedTransaction}=await import('@solana/web3.js');const bs58=(await import('bs58')).default;
 const {createVehicleClient}=await import('../src/game/vehicleClient');let fee=5000,balance=100000,valid=true,height=100,observed=false;const sent:Uint8Array[]=[];
 const current={...f.rpc,getFeeForMessage:async()=>({context:{slot:100},value:fee}),getBalanceAndContext:async()=>({context:{slot:100},value:balance}),isBlockhashValid:async()=>({context:{slot:100},value:valid}),getBlockHeight:async()=>height,getSignatureStatuses:async()=>({context:{slot:100},value:[observed?{slot:100,confirmations:null,err:null,confirmationStatus:'finalized' as const}:null]}),sendRawTransaction:async(bytes:Uint8Array,options:unknown)=>{expect(options).toEqual({skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:100});sent.push(Uint8Array.from(bytes));return bs58.encode(bytes.subarray(1,65));}};
 const service=createVehicleClient(f.conn.db,{current:{connect:()=>current,trust:f.trust}}),ref={kind:'installation' as const,id:f.reservation.id};
 expect(await service.review(f.actor,ref)).toMatchObject({status:'ready',reason:null,observation:{ownerWallet:f.actor,networkFeeLamports:'5000',payerLamports:'100000'},signingAuthorized:false});
 fee=100001;expect(await service.review(f.actor,ref)).toMatchObject({status:'held',reason:'FEE_LIMIT'});fee=5000;
 balance=4999;expect(await service.review(f.actor,ref)).toMatchObject({status:'held',reason:'INSUFFICIENT_SOL'});balance=100000;
 valid=false;expect(await service.review(f.actor,ref)).toMatchObject({status:'held',reason:'EXPIRED_UNRESOLVED'});valid=true;
 height=1001;expect(await service.review(f.actor,ref)).toMatchObject({status:'held',reason:'EXPIRED_UNRESOLVED'});height=100;
 const tx=new VersionedTransaction(Message.from(Buffer.from(f.preparation.messageHex,'hex')));tx.sign([f.wallet]);const wire=tx.serialize();await service.retainSigned(f.actor,ref,wire);
 expect(await service.deliver(f.actor,ref)).toMatchObject({status:'submitted',signature:bs58.encode(tx.signatures[0]!),client:{record:{status:'signed',installation:null}}});
 expect(await service.deliver(f.actor,ref)).toMatchObject({status:'submitted'});expect(sent).toEqual([wire,wire]);expect(await f.conn.sql`select count(*)::int n from advanced_vehicle_installations`).toEqual([{n:0}]);
 observed=true;expect(await service.deliver(f.actor,ref)).toMatchObject({status:'observed',reason:null});expect(sent).toHaveLength(2);
},120000);

it('keeps original actor privacy and rejects cross-actor or malformed discovery cursors',async()=>{
 const {Keypair}=await import('@solana/web3.js');const other=Keypair.generate().publicKey.toBase58();const {createVehicleClient}=await import('../src/game/vehicleClient');const service=createVehicleClient(f.conn.db),ref={kind:'installation' as const,id:f.reservation.id};
 for(const action of ['read','review','deliver','recover'] as const)await expect(service[action](other,ref)).rejects.toMatchObject({statusCode:404});
 const cross=Buffer.from(JSON.stringify({version:1,wallet:other,lane:'activity',kind:'installation',id:f.reservation.id})).toString('base64url');
 await expect(service.activity(f.actor,cross)).rejects.toMatchObject({code:'VEHICLE_CLIENT_CURSOR'});await expect(service.activity(f.actor,'%%%')).rejects.toMatchObject({code:'VEHICLE_CLIENT_CURSOR'});
 expect(await service.activity(other)).toMatchObject({items:[],nextCursor:null});expect((await service.activity(f.actor)).items).toHaveLength(1);
},120000);
