/** Independent browser reconstruction of D170/D175 only. Loaded by the lazy
 * Charter entry; never imports the Node/Anchor chain package. */
import {AddressLookupTableAccount,AddressLookupTableProgram,ComputeBudgetProgram,Ed25519Program,MessageV0,PublicKey,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {keccak_256} from '@noble/hashes/sha3';
import {PHASE_E_CHARTER_PREPARATION,PHASE_E_CHARTER_TRANSFER,PHASE_E_CHARTER_ADMISSION,PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import {CharterSigningSchema,CharterWireSchema,CharterContributionSchema,type CharterSigning,type CharterWire,type CharterContribution} from '@shardkeep/shared/charterApi';
export interface CharterSignOnlyWallet {readonly publicKey:PublicKey|null;readonly signVersionedTransaction?:((tx:VersionedTransaction)=>Promise<VersionedTransaction>)|null}
export interface CharterSigningTrust {
 readonly version:1;readonly revision:string;readonly deployment:CharterSigning['deployment'];readonly policySigner:string;
 readonly treasury:string;readonly royaltyBps:number;readonly lookupTables:readonly Readonly<{address:string;dataSha256:string}>[];
}
export interface PreparedCharterSigning {readonly wallet:string;readonly kind:'creation'|'sale';readonly attemptId:string;readonly messageSha256:string;readonly unsignedTransaction:Uint8Array}
export type SignedCharter=Readonly<{kind:'creation';wire:CharterWire}>|Readonly<{kind:'sale';contribution:CharterContribution}>;
export class CharterSigningError extends Error {constructor(readonly code:'INPUT'|'TRUST'|'MESSAGE'|'WALLET'|'SIGNATURE'|'CRYPTO_UNAVAILABLE'){super('Charter signing refused: '+code);}}
function need(v:unknown,code:CharterSigningError['code']):asserts v{if(!v)throw new CharterSigningError(code);}
const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]),same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const proofs=new WeakMap<PreparedCharterSigning,{value:CharterSigning;message:Buffer;wallet:string}>();
const CORE=new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'),U64=(1n<<64n)-1n;
function key(v:string){try{const k=new PublicKey(v);need(k.toBase58()===v&&!k.equals(PublicKey.default),'MESSAGE');return k;}catch(e){if(e instanceof CharterSigningError)throw e;throw new CharterSigningError('MESSAGE');}}
const hex=(v:string)=>Buffer.from(v,'hex'),id=(v:string)=>hex(v.replaceAll('-',''));
function le(n:bigint|number,size=8){let v=BigInt(n);need(v>=0n&&v<(1n<<BigInt(size*8)),'MESSAGE');const b=Buffer.alloc(size);for(let i=0;i<size;i++){b[i]=Number(v&255n);v>>=8n;}return b;}
const str=(v:string)=>{const b=Buffer.from(v,'utf8');return Buffer.concat([le(b.length,4),b]);};
const hash=(v:Uint8Array)=>Buffer.from(keccak_256(v));
async function sha(v:Uint8Array|string){try{return Buffer.from(await crypto.subtle.digest('SHA-256',typeof v==='string'?new TextEncoder().encode(v):new Uint8Array(v))).toString('hex');}catch{throw new CharterSigningError('CRYPTO_UNAVAILABLE');}}
async function verify(wallet:string,message:Uint8Array,signature:Uint8Array){
 let publicKey:CryptoKey;try{publicKey=await crypto.subtle.importKey('raw',new Uint8Array(key(wallet).toBytes()),{name:'Ed25519'},false,['verify']);}catch{throw new CharterSigningError('CRYPTO_UNAVAILABLE');}
 let valid:boolean;try{valid=await crypto.subtle.verify({name:'Ed25519'},publicKey,new Uint8Array(signature),new Uint8Array(message));}catch{throw new CharterSigningError('CRYPTO_UNAVAILABLE');}need(valid,'SIGNATURE');
}
function parsed(value:unknown):CharterSigning{try{return CharterSigningSchema.parse(value);}catch{throw new CharterSigningError('INPUT');}}
/** Closed ASCII terms shape mirrors D176 jsonb canonical key ordering/spaces.
 * No arbitrary JSON value, metadata or number enters this serialization. */
export function charterTermsText(t:Extract<CharterSigning,{kind:'sale'}>['original']['terms']):string{
 const json=(v:unknown):string=>{if(v===null||typeof v!=='object')return JSON.stringify(v);const r=v as Record<string,unknown>;return '{'+Object.keys(r).sort((a,b)=>a.length-b.length||(a<b?-1:a>b?1:0)).map(k=>JSON.stringify(k)+': '+json(r[k])).join(', ')+'}';};return json(t);
}
function derived(v:CharterSigning){
 const o=v.kind==='creation'?v.original:v.original.creation,c=o.chain,economy=key(c.economyProgram),craft=key(c.craftProgram);
 const pda=(p:PublicKey,seed:string,...tail:Buffer[])=>PublicKey.findProgramAddressSync([Buffer.from(seed),...tail],p)[0],clan=id(o.clanId),asset=pda(craft,'charter_mint',clan);
 const a={authority:pda(economy,'seeker_authority'),config:pda(economy,'charter_config'),transferConfig:pda(economy,'charter_transfer_config'),craftProgram:craft,craftControl:pda(craft,'charter_control'),collection:pda(craft,'charter_collection'),collectionAuthority:pda(craft,'charter_collection_authority'),charter:pda(economy,'charter',clan),asset,assetBinding:pda(economy,'charter_asset',asset.toBuffer()),freezeAuthority:pda(craft,'charter_freeze',clan),executor:pda(economy,'charter_executor',clan),creationReceipt:pda(economy,'charter_creation',id(o.creationIntentId)),economy};
 for(const field of ['config','craftControl','collection','collectionAuthority','charter','asset','assetBinding','freezeAuthority','executor','creationReceipt'] as const)need(a[field].toBase58()===c[field],'MESSAGE');
 need(CORE.toBase58()===v.deployment.core.programId&&new Set([economy.toBase58(),craft.toBase58(),CORE.toBase58()]).size===3,'MESSAGE');
 need(hash(Buffer.concat([Buffer.from('SKCHMET1'),str(o.metadata.name),str(o.metadata.uri)])).toString('hex')===o.metadata.hash,'MESSAGE');
 return {o,c,a,pda};
}
async function canonical(v:CharterSigning):Promise<Buffer>{
 try{
  const {o,c,a,pda}=derived(v),candidate=hex(v.policy.candidateHex),permitId=candidate.subarray(73,89),expiry=candidate.readBigInt64LE(121),clock=BigInt(v.observedUnixTimestamp);
  need(expiry>clock&&expiry-clock<=BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec),'MESSAGE');
  const treasury=v.kind==='sale'?key(v.original.terms.domain.treasury):null;
  let payload:Buffer,instruction:TransactionInstruction,payer:PublicKey,expectedRent:{kind:string;address:string;bytes:number}[];
  const receipt=pda(a.economy,'permit',permitId),args=Buffer.concat([permitId,le(expiry),le(1,2)]);
  if(v.kind==='creation'){
   payer=key(o.payer);
   payload=Buffer.concat([Buffer.from('SKCHREG1'),Buffer.of(1,0),...[a.config,a.craftProgram,a.craftControl,a.collection,a.collectionAuthority,a.charter,a.asset,a.assetBinding,a.freezeAuthority,a.executor,a.creationReceipt].map(k=>k.toBuffer()),id(o.clanId),payer.toBuffer(),id(o.creationIntentId),hex(o.metadata.hash),hex(o.admissionCommitment)]);
   const keys=[payer,a.authority,a.config,a.charter,a.assetBinding,a.creationReceipt,receipt,a.executor,a.craftProgram,a.craftControl,a.asset,a.collection,a.collectionAuthority,a.freezeAuthority,CORE,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId,a.economy];
   instruction=new TransactionInstruction({programId:a.economy,keys:keys.map((pubkey,i)=>({pubkey,isSigner:i===0,isWritable:[0,3,4,5,6,10,11].includes(i)})),data:Buffer.concat([hex((await sha('global:register_charter')).slice(0,16)),id(o.clanId),id(o.creationIntentId),hex(o.admissionCommitment),str(o.metadata.name),str(o.metadata.uri),args])});
   expectedRent=[{kind:'charter',address:a.charter.toBase58(),bytes:280},{kind:'assetBinding',address:a.assetBinding.toBase58(),bytes:90},{kind:'creationReceipt',address:a.creationReceipt.toBase58(),bytes:154},{kind:'permitReceipt',address:receipt.toBase58(),bytes:107},{kind:'asset',address:a.asset.toBase58(),bytes:137+Buffer.byteLength(o.metadata.name)+Buffer.byteLength(o.metadata.uri)}];
  }else{
   const t=v.original.terms,seller=key(t.seller),buyer=key(t.buyer);payer=buyer;
   need(expiry-clock===BigInt(PHASE_E_CHARTER_ADMISSION.v1.issuedPermitTtlSec)&&t.expectedRevision<0xffffffff,'MESSAGE');
   need(await sha('SHARDKEEP_CHARTER_SALE_TERMS_V1'+charterTermsText(t))===v.original.termsHash,'MESSAGE');
   const transferReceipt=pda(a.economy,'charter_transfer',id(t.id));
   payload=Buffer.concat([Buffer.from('SKCHXFR1'),Buffer.of(1,0),...[a.config,a.transferConfig,a.craftProgram,a.craftControl,a.collection,a.collectionAuthority,a.charter,a.asset,a.assetBinding,a.freezeAuthority,a.executor,transferReceipt,seller,buyer,treasury!].map(k=>k.toBuffer()),id(t.clanId),id(t.id),id(t.fenceId),le(t.expectedRevision,4),le(BigInt(t.priceLamports)),le(PHASE_E_CHARTER_TRANSFER.royaltyBps,2),hex(v.original.termsHash)]);
   const keys=[buyer,seller,a.authority,a.config,a.transferConfig,treasury!,a.charter,a.assetBinding,transferReceipt,receipt,a.executor,a.craftProgram,a.craftControl,a.asset,a.collection,a.collectionAuthority,a.freezeAuthority,CORE,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId,a.economy];
   instruction=new TransactionInstruction({programId:a.economy,keys:keys.map((pubkey,i)=>({pubkey,isSigner:i<2,isWritable:[0,1,5,6,8,9,13,14].includes(i)})),data:Buffer.concat([hex((await sha('global:settle_charter_transfer')).slice(0,16)),id(t.clanId),id(t.id),id(t.fenceId),le(t.expectedRevision,4),le(BigInt(t.priceLamports)),hex(v.original.termsHash),args])});
   expectedRent=[{kind:'transfer-receipt',address:transferReceipt.toBase58(),bytes:338},{kind:'permit-receipt',address:receipt.toBase58(),bytes:107}];
  }
  need(v.costs.allocations.every((row,i)=>{const expected=expectedRent[i];return expected&&row.kind===expected.kind&&row.address===expected.address&&row.bytes===expected.bytes;}),'MESSAGE');
  const expectedCandidate=Buffer.concat([Buffer.from('SKPERMT2'),key(c.genesisHash).toBuffer(),a.economy.toBuffer(),Buffer.of(v.kind==='creation'?5:1),permitId,payer.toBuffer(),le(expiry),hash(payload)]);
  need(equal(candidate,expectedCandidate),'MESSAGE');await verify(v.policy.signer,candidate,hex(v.policy.signatureHex));
  const raw=hex(v.lookupTable.dataHex);need(v.lookupTable.owner===AddressLookupTableProgram.programId.toBase58()&&await sha(raw)===v.lookupPin.dataSha256,'MESSAGE');
  const state=AddressLookupTableAccount.deserialize(raw);need(state.authority===undefined&&state.deactivationSlot===U64&&state.lastExtendedSlot<v.lookupTable.slot&&state.addresses.length===12,'MESSAGE');
  // The domain table is preprovisioned independently of all future clans. Its
  // treasury comes from the table for creation and is checked against app pins.
  const expected=[a.authority,a.config,a.transferConfig,a.craftProgram,a.craftControl,a.collection,a.collectionAuthority,CORE,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId,a.economy,treasury??state.addresses[11]!];
  need(new Set(expected.map(k=>k.toBase58())).size===12&&state.addresses.every((k,i)=>k.equals(expected[i]!)),'MESSAGE');
  const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:PHASE_E_CHARTER_PREPARATION.computeUnitLimit}),Ed25519Program.createInstructionWithPublicKey({publicKey:key(v.policy.signer).toBytes(),message:candidate,signature:hex(v.policy.signatureHex)}),instruction];
  const message=new TransactionMessage({payerKey:payer,recentBlockhash:key(v.blockhash).toBase58(),instructions}).compileToV0Message([new AddressLookupTableAccount({key:key(v.lookupTable.address),state})]),bytes=Buffer.from(message.serialize()),prefix=v.kind==='creation'?65:129;
  need(message.addressTableLookups.length===1&&message.header.numRequiredSignatures===(v.kind==='creation'?1:2)&&message.header.numReadonlySignedAccounts===0&&bytes.length+prefix<=1232&&equal(bytes,hex(v.packet.messageHex))&&await sha(bytes)===v.packet.messageSha256,'MESSAGE');
  need(Buffer.from(new VersionedTransaction(message).serialize()).toString('hex')===v.packet.unsignedTransactionHex,'MESSAGE');return bytes;
 }catch(e){if(e instanceof CharterSigningError)throw e;throw new CharterSigningError('MESSAGE');}
}
function checkTrust(v:CharterSigning,trust:CharterSigningTrust){
 try{need(trust&&trust.version===1&&typeof trust.revision==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(trust.revision)&&same(trust.deployment,v.deployment)&&trust.policySigner===v.policy.signer&&trust.royaltyBps===PHASE_E_CHARTER_TRANSFER.royaltyBps,'TRUST');
  key(trust.treasury);key(trust.policySigner);need(Array.isArray(trust.lookupTables)&&trust.lookupTables.length>0&&trust.lookupTables.length<=4&&trust.lookupTables.some(p=>same(p,v.lookupPin)),'TRUST');
  const table=AddressLookupTableAccount.deserialize(hex(v.lookupTable.dataHex));need(table.addresses[11]?.toBase58()===trust.treasury&&!(v.kind==='sale'&&v.original.terms.domain.treasury!==trust.treasury),'TRUST');
 }catch(e){if(e instanceof CharterSigningError)throw e;throw new CharterSigningError('TRUST');}
}
export async function prepareCharterSigning(value:CharterSigning,trust:CharterSigningTrust,wallet:string):Promise<PreparedCharterSigning>{
 const v=parsed(value);checkTrust(v,trust);const validWallets=v.kind==='creation'?[v.original.payer]:[v.original.terms.buyer,v.original.terms.seller];need(validWallets.includes(wallet),'WALLET');
 const message=await canonical(v),wire=hex(v.packet.unsignedTransactionHex),prepared=Object.freeze({wallet,kind:v.kind,attemptId:v.attemptId,messageSha256:v.packet.messageSha256,get unsignedTransaction(){return Uint8Array.from(wire);}});proofs.set(prepared,{value:v,message,wallet});return prepared;
}
export async function verifyCharterContribution(value:CharterSigning,actor:string,input:unknown):Promise<CharterContribution>{
 const v=parsed(value);need(v.kind==='sale'&&[v.original.terms.buyer,v.original.terms.seller].includes(actor),'WALLET');let contribution:CharterContribution;
 try{contribution=CharterContributionSchema.parse(input);}catch{throw new CharterSigningError('INPUT');}
 need(contribution.wallet===actor&&contribution.attemptId===v.attemptId&&contribution.messageSha256===v.packet.messageSha256,'MESSAGE');const message=await canonical(v),signature=Buffer.from(contribution.signature,'base64');need(signature.length===64&&signature.toString('base64')===contribution.signature,'INPUT');await verify(actor,message,signature);return Object.freeze(contribution);
}
export async function verifyCharterWire(value:CharterSigning,input:unknown):Promise<CharterWire>{
 const v=parsed(value);let expected:CharterWire;try{expected=CharterWireSchema.parse(input);}catch{throw new CharterSigningError('INPUT');}
 const wire=Buffer.from(expected.signedTransaction,'base64'),count=v.kind==='creation'?1:2,prefix=1+64*count,message=await canonical(v);
 need(wire.length<=1232&&wire.length===prefix+message.length&&wire.toString('base64')===expected.signedTransaction&&wire[0]===count&&equal(wire.subarray(prefix),message),'MESSAGE');
 let transaction:VersionedTransaction;try{transaction=VersionedTransaction.deserialize(wire);}catch{throw new CharterSigningError('MESSAGE');}need(equal(transaction.serialize(),wire),'MESSAGE');
 const wallets=v.kind==='creation'?[v.original.payer]:[v.original.terms.buyer,v.original.terms.seller];for(const [i,wallet] of wallets.entries())await verify(wallet,message,wire.subarray(1+i*64,65+i*64));
 need(bs58.encode(wire.subarray(1,65))===expected.signature&&await sha(wire)===expected.wireSha256&&v.packet.messageSha256===expected.messageSha256,'MESSAGE');return Object.freeze(expected);
}
export async function signCharter<T extends CharterSignOnlyWallet>(prepared:PreparedCharterSigning,wallet:T):Promise<SignedCharter>{
 const owned=proofs.get(prepared);need(owned,'INPUT');const sign=wallet.signVersionedTransaction;need(wallet.publicKey?.toBase58()===owned.wallet&&typeof sign==='function','WALLET');
 const response=await sign.call(wallet,VersionedTransaction.deserialize(prepared.unsignedTransaction));
 need(response instanceof VersionedTransaction&&response.message instanceof MessageV0&&response.signatures.length===(owned.value.kind==='creation'?1:2)&&response.signatures.every(s=>s instanceof Uint8Array&&s.length===64),'MESSAGE');
 const m=response.message;need(m.staticAccountKeys.length<=32&&m.compiledInstructions.length===3&&m.addressTableLookups.length===1&&m.compiledInstructions.every(i=>i.data instanceof Uint8Array&&i.data.length<=512&&i.accountKeyIndexes.length<=32)&&m.addressTableLookups.every(a=>a.readonlyIndexes.length<=12&&a.writableIndexes.length<=12),'MESSAGE');
 need(equal(m.serialize(),owned.message),'MESSAGE');const v=owned.value;
 if(v.kind==='sale'){const index=owned.wallet===v.original.terms.buyer?0:1,contribution=await verifyCharterContribution(v,owned.wallet,{wallet:owned.wallet,attemptId:v.attemptId,messageSha256:v.packet.messageSha256,signature:Buffer.from(response.signatures[index]!).toString('base64')});return Object.freeze({kind:'sale',contribution});}
 const bytes=Buffer.from(response.serialize()),wire=await verifyCharterWire(v,{signedTransaction:bytes.toString('base64'),signature:bs58.encode(response.signatures[0]!),wireSha256:await sha(bytes),messageSha256:v.packet.messageSha256});return Object.freeze({kind:'creation',wire});
}
