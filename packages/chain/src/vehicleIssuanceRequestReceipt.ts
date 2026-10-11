/** Exact finalized request execution, separate from paid VRF/Core outcomes.
 * Retained verification binds journal bytes; it does not recreate RPC proof. */
import {Message,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import bs58 from 'bs58';
import {PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import {attest,copyTrust,fields,safe,LOADER,type VehicleIssuanceEvidenceRpc,type VehicleIssuanceTrust,type VehicleIssuanceRawAccount,type VehicleIssuanceProgramTrust} from './vehicleIssuanceAccounts';
import {copyVehicleRequestSaved,copyVehicleRequestRef,vehicleRequestRunner,vehicleRequestNeed as need,type VehicleIssuanceRequestLoader,type VehicleIssuanceRequestRef,type VehicleIssuanceRequestSaved} from './vehicleIssuanceCurrent';
import {isFailedSolanaExecution} from './solanaFailedExecution';
import {vehicleAddress,vehicleHex,vehiclePda,vehicleSha256,vehicleTermsBytes,vehicleTermsHash,vehicleKeccak,vehicleVrfRequest,vehicleWins,vehicleDiscriminator,vehicleFees,VEHICLE_CRAFT_PROGRAM,VEHICLE_VRF_PROGRAM,VEHICLE_VRF_QUEUE,type VehicleIssuanceOriginal} from './vehicleIssuanceProtocol';
export interface VehicleIssuanceRequestReceiptRpc extends VehicleIssuanceEvidenceRpc {
 getTransaction(signature:string,options:{commitment:'finalized';maxSupportedTransactionVersion:0}):Promise<unknown>;
}
export interface VehicleIssuanceRequestReceipt {
 version:1;wallet:string;idempotencyKey:string;originalHash:string;signature:string;wireSha256:string;messageSha256:string;
 outcome:'request_succeeded'|'wire_reverted';slot:number;feeLamports:string;oracleSpendLamports:string|null;
 source:{genesisHash:string;closingSlot:number;accountSlot:number;programs:readonly VehicleIssuanceProgramTrust[];accounts:readonly {address:string;owner:string;executable:boolean;dataSha256:string}[]};
 transactionProofVerified:true;paymentAuthorized:false;activationAuthorized:false;reservationReleaseAuthorized:false;
}
const SYSVAR='Sysvar1111111111111111111111111111111111111',num=(v:unknown)=>{need(safe(v),'SOURCE');return v;};
function array(v:unknown,min:number,max=min):unknown[]{need(Array.isArray(v)&&Object.getPrototypeOf(v)===Array.prototype&&v.length>=min&&v.length<=max&&Reflect.ownKeys(v).length===v.length+1,'SOURCE');return Array.from({length:v.length},(_,j)=>{const d=Object.getOwnPropertyDescriptor(v,String(j));need(d&&d.enumerable&&'value'in d,'SOURCE');return d.value;});}
/** Ignore unrelated JSON metadata, but never execute a provider getter/method. */
function own(v:unknown,names:string,optional=''):Record<string,unknown>{need(v&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null),'SOURCE');const result:Record<string,unknown>={};for(const key of names.split(' ').concat(optional.split(' ')).filter(Boolean)){const d=Object.getOwnPropertyDescriptor(v,key);need(d||!names.split(' ').includes(key),'SOURCE');if(d){need(d.enumerable&&'value'in d,'SOURCE');result[key]=d.value;}}return result;}
function decimal(v:unknown){need(typeof v==='string'&&/^(0|[1-9][0-9]{0,15})$/.test(v)&&BigInt(v)<=BigInt(Number.MAX_SAFE_INTEGER),'SOURCE');return v;}
function addresses(trust:VehicleIssuanceTrust,o?:VehicleIssuanceOriginal){
 const keys=[trust.craft,trust.provider,trust.core].flatMap(p=>{const id=new PublicKey(p.programId);return [id,PublicKey.findProgramAddressSync([id.toBuffer()],LOADER)[0]];});keys.push(vehiclePda('vehicle_control')[0]);
 if(o)keys.push(vehiclePda('vehicle_root',o.rootId)[0],vehiclePda('vehicle_attempt',o.attemptId)[0],vehiclePda('vehicle_permit',o.permitId)[0]);keys.push(new PublicKey(VEHICLE_VRF_QUEUE),SYSVAR_CLOCK_PUBKEY);return keys;
}
function control(rows:VehicleIssuanceRawAccount[],o:VehicleIssuanceOriginal,slot:number){
 const row=rows[6]!,c=Buffer.from(row.data);need(!row.executable&&row.owner.toBase58()===VEHICLE_CRAFT_PROGRAM&&c.length===189&&c.subarray(0,8).equals(vehicleDiscriminator('account','VehicleControl'))&&c[8]===1,'SOURCE');
 need(c.subarray(9,41).equals(new PublicKey(o.genesisHash).toBuffer())&&c.subarray(113,145).equals(new PublicKey(o.identity.collection).toBuffer())&&c.subarray(145,177).equals(vehiclePda('vehicle_authority')[0].toBuffer())&&c[177]!<=1&&c.readBigUInt64LE(178)===BigInt(o.escrowRentReserve)&&c[186]===vehiclePda('vehicle_control')[1]&&c[187]===vehiclePda('vehicle_collection')[1]&&c[188]===vehiclePda('vehicle_authority')[1],'SOURCE');
 vehicleAddress(new PublicKey(c.subarray(41,73)).toBase58());const previous=new PublicKey(c.subarray(73,105)),until=c.readBigInt64LE(105);need(until>=0n&&(!previous.equals(PublicKey.default)||until===0n),'SOURCE');
 const queue=rows.at(-2)!,clock=rows.at(-1)!,b=Buffer.from(clock.data);need(!queue.executable&&queue.owner.toBase58()===VEHICLE_VRF_PROGRAM&&queue.address.toBase58()===VEHICLE_VRF_QUEUE&&!clock.executable&&clock.owner.toBase58()===SYSVAR&&b.length===40&&b.readBigUInt64LE()===BigInt(slot)&&b.readBigInt64LE(32)>0n,'SOURCE');return b.readBigInt64LE(32);
}
function state(rows:VehicleIssuanceRawAccount[],o:VehicleIssuanceOriginal,txSlot:number,slot:number,unix:bigint){
 const begin=(index:number,name:string,size:number)=>{const row=rows[index]!,b=Buffer.from(row.data);need(!row.executable&&row.owner.toBase58()===VEHICLE_CRAFT_PROGRAM&&b.length===size&&b.subarray(0,8).equals(vehicleDiscriminator('account',name))&&b[8]===1,'SOURCE');return b;};
 const r=begin(7,'VehicleRoot',170),a=begin(8,'VehicleAttempt',557),p=begin(9,'VehiclePermitReceipt',170),key=(b:Buffer,at:number,s:string)=>need(b.subarray(at,at+32).equals(new PublicKey(s).toBuffer()),'SOURCE'),hex=(b:Buffer,at:number,s:string)=>need(b.subarray(at,at+s.length/2).toString('hex')===s,'SOURCE');
 const root=vehiclePda('vehicle_root',o.rootId)[0].toBase58(),attempt=vehiclePda('vehicle_attempt',o.attemptId)[0].toBase58(),terms=vehicleTermsHash(o);
 hex(r,9,o.rootId);hex(r,25,o.attemptId);key(r,41,o.buyer);key(r,73,attempt);key(r,105,o.identity.assetId);hex(r,137,terms);need(r[169]===vehiclePda('vehicle_root',o.rootId)[1],'SOURCE');
 key(a,9,root);hex(a,41,o.rootId);hex(a,57,o.attemptId);key(a,73,o.buyer);hex(a,105,o.permitId);key(a,121,o.identity.collection);key(a,153,o.identity.assetId);need(a.subarray(185,393).equals(vehicleTermsBytes(o.terms)),'SOURCE');hex(a,393,terms);hex(a,425,vehicleKeccak(vehicleVrfRequest(o.rootId,o.attemptId,terms)).toString('hex'));
 const fees=vehicleFees();need(a.readBigUInt64LE(457)===fees.application&&a.readBigUInt64LE(465)===fees.operator&&a.readBigUInt64LE(473)===fees.project&&a[556]===vehiclePda('vehicle_attempt',o.attemptId)[1],'SOURCE');
 const outcome=a[513]!,paid=a[514]!,minted=a[515]!,requestedAt=a.readBigInt64LE(516),request=a.readBigUInt64LE(524),result=a.readBigUInt64LE(532),settlement=a.readBigUInt64LE(540),mint=a.readBigUInt64LE(548),random=a.subarray(481,513);
 need(outcome<=2&&paid<=1&&minted<=1&&request===BigInt(txSlot)&&request<=BigInt(slot)&&requestedAt>0n&&requestedAt<=unix&&BigInt(o.permitExpiry)>requestedAt&&BigInt(o.permitExpiry)-requestedAt<=BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec),'SOURCE');
 if(outcome===0)need(random.equals(Buffer.alloc(32))&&paid===0&&minted===0&&result===0n&&settlement===0n&&mint===0n,'SOURCE');
 else{need(vehicleWins(random,o.terms.oddsBps)===(outcome===2)&&result>=request&&result<=BigInt(slot),'SOURCE');need(paid===1?settlement>=result&&settlement<=BigInt(slot):settlement===0n,'SOURCE');need(minted===1?outcome===2&&paid===1&&mint>=settlement&&mint<=BigInt(slot):mint===0n,'SOURCE');}
 hex(p,9,o.permitId);key(p,25,o.buyer);key(p,57,root);key(p,89,attempt);hex(p,121,terms);need(p.readBigInt64LE(153)===BigInt(o.permitExpiry)&&p.readBigInt64LE(161)===requestedAt&&p[169]===vehiclePda('vehicle_permit',o.permitId)[1],'SOURCE');
}
function failure(value:unknown,depth=0):unknown {
 need(depth<=4,'SOURCE');if(typeof value==='string'){need(value.length<=256,'SOURCE');return value;}if(typeof value==='number'){need(safe(value),'SOURCE');return value;}
 if(Array.isArray(value))return array(value,2).map(v=>failure(v,depth+1));
 need(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype,'SOURCE');const keys=Reflect.ownKeys(value);need(keys.length===1&&typeof keys[0]==='string'&&keys[0].length<=64,'SOURCE');const key=keys[0],d=Object.getOwnPropertyDescriptor(value,key);need(d&&d.enumerable&&'value'in d,'SOURCE');return {[key]:failure(d.value,depth+1)};
}
function transaction(value:unknown,saved:ReturnType<typeof copyVehicleRequestSaved>){
 const q=saved.quote,t=own(value,'slot transaction meta','version'),slot=num(t.slot);need(slot>=q.blockhashSlot&&(t.version===undefined||t.version==='legacy'),'SOURCE');
 const tx=own(t.transaction,'signatures message'),m=own(tx.message,'header accountKeys recentBlockhash instructions','version'),h=own(m.header,'numRequiredSignatures numReadonlySignedAccounts numReadonlyUnsignedAccounts');need(m.version===undefined||m.version==='legacy','SOURCE');
 const keys=array(m.accountKeys,1,32).map(v=>{need(typeof v==='string'&&v.length>=32&&v.length<=44,'SOURCE');const key=new PublicKey(v).toBase58();need(key===v,'SOURCE');return key;});need(new Set(keys).size===keys.length,'SOURCE');
 const instructions=array(m.instructions,2).map(v=>{const ix=own(v,'programIdIndex accounts data'),programIdIndex=num(ix.programIdIndex),accounts=array(ix.accounts,0,32).map(num);need(programIdIndex<keys.length&&accounts.every(i=>i<keys.length)&&typeof ix.data==='string'&&ix.data.length<=1683,'SOURCE');return {programIdIndex,accounts,data:ix.data};});
 need(h.numRequiredSignatures===1&&h.numReadonlySignedAccounts===0&&safe(h.numReadonlyUnsignedAccounts)&&h.numReadonlyUnsignedAccounts<keys.length,'SOURCE');
 const message=new Message({header:{numRequiredSignatures:1,numReadonlySignedAccounts:0,numReadonlyUnsignedAccounts:h.numReadonlyUnsignedAccounts},accountKeys:keys,recentBlockhash:vehicleAddress(m.recentBlockhash),instructions});need(message.serialize().toString('hex')===q.messageHex&&array(tx.signatures,1)[0]===saved.wire.signature,'SOURCE');
 const meta=own(t.meta,'err fee preBalances postBalances','loadedAddresses preTokenBalances postTokenBalances');
 if(meta.loadedAddresses!==undefined){const l=own(meta.loadedAddresses,'writable readonly');array(l.writable,0);array(l.readonly,0);}if(meta.preTokenBalances!==undefined)array(meta.preTokenBalances,0);if(meta.postTokenBalances!==undefined)array(meta.postTokenBalances,0);
 const fee=num(meta.fee),pre=array(meta.preBalances,keys.length).map(num),post=array(meta.postBalances,keys.length).map(num);need(BigInt(fee)<=BigInt(q.costs.networkFeeLamports),'COST');
 let outcome:VehicleIssuanceRequestReceipt['outcome'],oracleSpendLamports:string|null=null;
 if(meta.err===null){outcome='request_succeeded';const index=(key:string)=>{const j=keys.indexOf(key);need(j>=0,'SOURCE');return j;},delta=(key:string)=>{const j=index(key);return BigInt(post[j]!)-BigInt(pre[j]!);};
  let initialization=0n;for(const a of q.costs.allocations){const n=delta(a.address);need(n>=0n&&n<=BigInt(a.topUpLamports),'COST');initialization+=n;}
  const app=vehiclePda('vehicle_app',q.original.rootId)[0].toBase58(),oracle=vehiclePda('vehicle_oracle',q.original.rootId)[0].toBase58(),appFunding=BigInt(q.costs.applicationFundingLamports),oracleFunding=BigInt(q.costs.oracleFundingLamports),reserve=BigInt(q.original.escrowRentReserve),oracleDelta=delta(oracle);
  oracleSpendLamports=(oracleFunding-oracleDelta).toString();
  need(delta(app)===appFunding&&oracleDelta>=reserve&&oracleDelta<=oracleFunding&&delta(VEHICLE_VRF_QUEUE)===oracleFunding-oracleDelta&&-delta(q.original.buyer)===BigInt(fee)+initialization+appFunding+oracleFunding,'SOURCE');
  const mutable=new Set([q.original.buyer,...q.costs.allocations.map(a=>a.address),app,oracle,VEHICLE_VRF_QUEUE]);need(keys.every((key,j)=>mutable.has(key)||pre[j]===post[j]),'SOURCE');
 }else{need(isFailedSolanaExecution(failure(meta.err),2,keys.length),'SOURCE');outcome='wire_reverted';need(pre.every((n,j)=>BigInt(n)-BigInt(post[j]!)===(j===0?BigInt(fee):0n)),'SOURCE');}
 return {slot,feeLamports:String(fee),oracleSpendLamports,outcome};
}
/** Strict retained binding, never a provider or dispatch substitute. */
export function verifyVehicleIssuanceRequestReceipt(value:unknown,expectedSaved?:VehicleIssuanceRequestSaved):VehicleIssuanceRequestReceipt {
 const r=fields(value,'version wallet idempotencyKey originalHash signature wireSha256 messageSha256 outcome slot feeLamports oracleSpendLamports source transactionProofVerified paymentAuthorized activationAuthorized reservationReleaseAuthorized');
 need(r.version===1&&r.transactionProofVerified===true&&[r.paymentAuthorized,r.activationAuthorized,r.reservationReleaseAuthorized].every(v=>v===false)&&(r.outcome==='request_succeeded'||r.outcome==='wire_reverted'));
 const ref=copyVehicleRequestRef({wallet:r.wallet,idempotencyKey:r.idempotencyKey}),originalHash=vehicleHex(r.originalHash,32),wireSha256=vehicleHex(r.wireSha256,32),messageSha256=vehicleHex(r.messageSha256,32),slot=num(r.slot),feeLamports=decimal(r.feeLamports);need(typeof r.signature==='string'&&r.signature.length<=88&&bs58.decode(r.signature).length===64&&bs58.encode(bs58.decode(r.signature))===r.signature);
 const oracleSpendLamports=r.outcome==='request_succeeded'?decimal(r.oracleSpendLamports):null;if(r.outcome==='wire_reverted')need(r.oracleSpendLamports===null);
 const s=fields(r.source,'genesisHash closingSlot accountSlot programs accounts'),ps=array(s.programs,3),trust=copyTrust({expectedGenesisHash:s.genesisHash,craft:ps[0],provider:ps[1],core:ps[2],stateProvenance:'fresh-reviewed-deployment'} as VehicleIssuanceTrust),programs=[trust.craft,trust.provider,trust.core],closingSlot=num(s.closingSlot),accountSlot=num(s.accountSlot);need(slot>=Math.max(...programs.map(p=>p.reviewedDeploymentSlot))&&accountSlot>=slot&&closingSlot>=accountSlot);
 const saved=expectedSaved?copyVehicleRequestSaved(expectedSaved,ref):undefined;if(saved){const q=saved.quote;need((oracleSpendLamports===null||BigInt(oracleSpendLamports)<=BigInt(q.original.terms.oracleBudget))&&q.originalHash===originalHash&&saved.wire.signature===r.signature&&saved.wire.wireSha256===wireSha256&&saved.wire.messageSha256===messageSha256&&q.original.genesisHash===trust.expectedGenesisHash&&slot>=q.blockhashSlot&&BigInt(feeLamports)<=BigInt(q.costs.networkFeeLamports)&&JSON.stringify(programs)===JSON.stringify(q.source.final.admission.source.programs));}
 const expected=addresses(trust,r.outcome==='request_succeeded'?saved?.quote.original:undefined),count=r.outcome==='request_succeeded'?12:9;
 const accounts=Object.freeze(array(s.accounts,count).map((v,j)=>{const a=fields(v,'address owner executable dataSha256'),address=vehicleAddress(a.address),owner=vehicleAddress(a.owner),dataSha256=vehicleHex(a.dataSha256,32);need(typeof a.executable==='boolean');
  // Without an expected original only the three original PDA addresses are
  // opaque. Complete saved-graph callers always supply expectedSaved.
  const expectedIndex=count===12&&!saved?(j<7?j:j>=10?j-3:-1):j;if(expectedIndex>=0)need(address===expected[expectedIndex]!.toBase58());
  if(j<6){need(owner===LOADER.toBase58()&&a.executable===(j%2===0));if(j%2)need(dataSha256===programs[(j-1)/2]!.reviewedProgramDataSha256);else{const b=Buffer.alloc(36);b.writeUInt32LE(2);expected[j+1]!.toBuffer().copy(b,4);need(dataSha256===vehicleSha256(b));}}
  else need(!a.executable&&owner===(j===count-1?SYSVAR:j===count-2?VEHICLE_VRF_PROGRAM:VEHICLE_CRAFT_PROGRAM));return Object.freeze({address,owner,executable:a.executable,dataSha256});}));
 need(new Set(accounts.map(a=>a.address)).size===accounts.length);
 return Object.freeze({version:1,...ref,originalHash,signature:r.signature,wireSha256,messageSha256,outcome:r.outcome,slot,feeLamports,oracleSpendLamports,source:Object.freeze({genesisHash:trust.expectedGenesisHash,closingSlot,accountSlot,programs:Object.freeze(programs),accounts}),transactionProofVerified:true,paymentAuthorized:false,activationAuthorized:false,reservationReleaseAuthorized:false});
}
export function createVehicleIssuanceRequestReceiptReader(connect:(signal:AbortSignal)=>VehicleIssuanceRequestReceiptRpc,inputTrust:VehicleIssuanceTrust,loadSaved:VehicleIssuanceRequestLoader,options:{deadlineMs?:number}={}){
 need(typeof connect==='function'&&typeof loadSaved==='function');const trust=copyTrust(inputTrust),programs=[trust.craft,trust.provider,trust.core],run=vehicleRequestRunner(options);
 return async(value:VehicleIssuanceRequestRef,signal?:AbortSignal):Promise<VehicleIssuanceRequestReceipt|null>=>{const ref=copyVehicleRequestRef(value);return run(async ctx=>{
  const {call,active}=ctx,saved=copyVehicleRequestSaved(await call(()=>loadSaved(ref)),ref),o=saved.quote.original;need(o.genesisHash===trust.expectedGenesisHash&&JSON.stringify(programs)===JSON.stringify(saved.quote.source.final.admission.source.programs),'SOURCE');const rpc=connect(ctx.signal);active();need(await call(()=>rpc.getGenesisHash())===o.genesisHash,'SOURCE');
  const raw=await call(()=>rpc.getTransaction(saved.wire.signature,{commitment:'finalized',maxSupportedTransactionVersion:0}));if(raw===null){need(await call(()=>rpc.getGenesisHash())===o.genesisHash,'SOURCE');return null;}const tx=transaction(raw,saved);
  const opening=num(await call(()=>rpc.getSlot('finalized')));need(opening>=tx.slot&&opening>=Math.max(...programs.map(p=>p.reviewedDeploymentSlot)),'SOURCE');
  const keys=addresses(trust,tx.outcome==='request_succeeded'?o:undefined),caps=tx.outcome==='request_succeeded'?[36,8*1024*1024,36,8*1024*1024,36,8*1024*1024,189,170,557,170,65536,40]:[36,8*1024*1024,36,8*1024*1024,36,8*1024*1024,189,65536,40];
  const response=await call(()=>rpc.getMultipleAccountsInfoAndContext(keys.map(p=>new PublicKey(p.toBytes())),{commitment:'finalized',minContextSlot:opening}));need(response&&safe(response.context?.slot)&&response.context.slot>=opening,'SOURCE');const slot=response.context.slot,rows=array(response.value,keys.length).map((v,j)=>{const r=fields(v,'address owner executable data');need(r.address instanceof PublicKey&&r.owner instanceof PublicKey&&r.address.equals(keys[j]!)&&typeof r.executable==='boolean'&&r.data instanceof Uint8Array&&r.data.length<=caps[j]!,'SOURCE');return {address:new PublicKey(r.address.toBytes()),owner:new PublicKey(r.owner.toBytes()),executable:r.executable,data:Buffer.from(r.data)};});
  const closing=num(await call(()=>rpc.getSlot('finalized')));need(closing>=slot&&await call(()=>rpc.getGenesisHash())===o.genesisHash,'SOURCE');programs.forEach((p,j)=>attest(rows[j*2]!,rows[j*2+1]!,p));const unix=control(rows,o,slot);if(tx.outcome==='request_succeeded')state(rows,o,tx.slot,slot,unix);active();
  const receipt=verifyVehicleIssuanceRequestReceipt({version:1,...ref,originalHash:o.originalHash,signature:saved.wire.signature,wireSha256:saved.wire.wireSha256,messageSha256:saved.wire.messageSha256,...tx,source:{genesisHash:o.genesisHash,closingSlot:closing,accountSlot:slot,programs,accounts:rows.map(r=>({address:r.address.toBase58(),owner:r.owner.toBase58(),executable:r.executable,dataSha256:vehicleSha256(r.data)}))},transactionProofVerified:true,paymentAuthorized:false,activationAuthorized:false,reservationReleaseAuthorized:false},{quote:saved.quote,signedTransaction:saved.signedTransaction});active();return receipt;
 },signal);};
}
