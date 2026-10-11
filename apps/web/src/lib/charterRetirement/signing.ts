/** Independent browser consent for permanent retirement. The API supplies
 * original terms; only separately installed deployment pins supply trust. */
import {AddressLookupTableAccount,AddressLookupTableProgram,ComputeBudgetProgram,Ed25519Program,MessageV0,PublicKey,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {keccak_256} from '@noble/hashes/sha3';
import {PHASE_E_CHARTER_ADMISSION,PHASE_E_CHARTER_PREPARATION,PHASE_E_CHARTER_TRANSFER} from '@shardkeep/shared';
import {CharterRetirementOperationSchema,CharterRetirementWireSchema,type CharterRetirementOperation,type CharterRetirementWire} from '@shardkeep/shared/charterRetirementApi';
import type {CharterSigningTrust,CharterSignOnlyWallet} from '../charter/signing';
export type RetirementSigningTrust=CharterSigningTrust;
export interface PreparedRetirementSigning {readonly wallet:string;readonly retirementId:string;readonly messageSha256:string;readonly unsignedTransaction:Uint8Array}
const proofs=new WeakMap<PreparedRetirementSigning,{operation:CharterRetirementOperation;message:Buffer;wallet:string}>();
const CORE=new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'),U64=(1n<<64n)-1n;
const need=(v:unknown,message='Dissolution approval differs from its original.')=>{if(!v)throw Error(message);};
const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const hex=(v:string)=>Buffer.from(v,'hex'),id=(v:string)=>hex(v.replaceAll('-',''));
function key(v:string){const p=new PublicKey(v);need(p.toBase58()===v&&!p.equals(PublicKey.default));return p;}
function le(n:bigint|number,size=8){let v=BigInt(n);need(v>=0n&&v<(1n<<BigInt(size*8)));const b=Buffer.alloc(size);for(let i=0;i<size;i++){b[i]=Number(v&255n);v>>=8n;}return b;}
const str=(v:string)=>{const b=Buffer.from(v,'utf8');return Buffer.concat([le(b.length,4),b]);};
const hash=(v:Uint8Array)=>Buffer.from(keccak_256(v));
async function sha(v:Uint8Array|string){return Buffer.from(await crypto.subtle.digest('SHA-256',typeof v==='string'?new TextEncoder().encode(v):new Uint8Array(v))).toString('hex');}
async function verify(wallet:string,message:Uint8Array,signature:Uint8Array){const k=await crypto.subtle.importKey('raw',new Uint8Array(key(wallet).toBytes()),{name:'Ed25519'},false,['verify']);need(await crypto.subtle.verify({name:'Ed25519'},k,new Uint8Array(signature),new Uint8Array(message)),'Dissolution signature is invalid.');}
function samePin(a:CharterSigningTrust['deployment']['economy'],b:CharterSigningTrust['deployment']['economy']){return a.programId===b.programId&&a.reviewedDeploymentSlot===b.reviewedDeploymentSlot&&a.reviewedProgramDataSha256===b.reviewedProgramDataSha256&&a.upgradeAuthority===b.upgradeAuthority;}
async function canonical(v:CharterRetirementOperation){
 if(!v.attempt||!v.preparation)throw Error('Original dissolution approval is not prepared.');
 const o=v.original.retirement,cr=v.original.creation,c=cr.chain,q=v.attempt.quote,p=q.packetInput,policySignature=hex(v.preparation.policySignatureHex),candidate=hex(p.candidateHex),permitId=candidate.subarray(73,89),expiry=candidate.readBigInt64LE(121);
 const economy=key(c.economyProgram),craft=key(c.craftProgram),leader=key(o.leader),pda=(program:PublicKey,seed:string,...tail:Buffer[])=>PublicKey.findProgramAddressSync([Buffer.from(seed),...tail],program)[0],clan=id(cr.clanId),asset=pda(craft,'charter_mint',clan);
 const a={authority:pda(economy,'seeker_authority'),config:pda(economy,'charter_config'),transferConfig:pda(economy,'charter_transfer_config'),craftControl:pda(craft,'charter_control'),collection:pda(craft,'charter_collection'),collectionAuthority:pda(craft,'charter_collection_authority'),charter:pda(economy,'charter',clan),asset,assetBinding:pda(economy,'charter_asset',asset.toBuffer()),freezeAuthority:pda(craft,'charter_freeze',clan),executor:pda(economy,'charter_executor',clan),creationReceipt:pda(economy,'charter_creation',id(cr.creationIntentId)),permitReceipt:pda(economy,'permit',permitId),retirementReceipt:pda(economy,'charter_retirement',clan)};
 for(const f of ['config','craftControl','collection','collectionAuthority','charter','asset','assetBinding','freezeAuthority','executor','creationReceipt'] as const)need(a[f].toBase58()===c[f]);
 need(hex(o.clearanceHash).some(Boolean));
 need(hash(Buffer.concat([Buffer.from('SKCHMET1'),str(cr.metadata.name),str(cr.metadata.uri)])).toString('hex')===cr.metadata.hash);
 const deployment=q.observation.source.programs;need(deployment.core.programId===CORE.toBase58());
 need(expiry-BigInt(q.observation.unixTimestamp)===BigInt(PHASE_E_CHARTER_ADMISSION.v1.issuedPermitTtlSec));
 const payload=Buffer.concat([Buffer.from('SKCHRET1'),Buffer.of(1,0),...[a.config,craft,a.craftControl,a.collection,a.collectionAuthority,a.charter,a.asset,a.assetBinding,a.freezeAuthority,a.retirementReceipt,leader].map(k=>k.toBuffer()),clan,id(o.id),id(o.fenceId),le(o.expectedRevision,4),hex(o.clearanceHash)]);
 const expected=Buffer.concat([Buffer.from('SKPERMT2'),key(c.genesisHash).toBuffer(),economy.toBuffer(),Buffer.of(9),permitId,leader.toBuffer(),le(expiry),hash(payload)]);need(equal(candidate,expected));await verify(p.policySigner,candidate,policySignature);
 for(const [kind,address,bytes] of [['permit-receipt',a.permitReceipt,107],['retirement-receipt',a.retirementReceipt,250]] as const){const allocation=q.costs.allocations.find(row=>row.kind===kind);need(allocation?.address===address.toBase58()&&allocation.bytes===bytes);}
 const raw=hex(p.lookupTable.dataHex);need(p.lookupTable.owner===AddressLookupTableProgram.programId.toBase58()&&await sha(raw)===p.expectedLookupTable.dataSha256);
 const lookup=AddressLookupTableAccount.deserialize(raw);need(lookup.authority===undefined&&lookup.deactivationSlot===U64&&lookup.lastExtendedSlot<p.lookupTable.slot&&lookup.addresses.length<=256);
 const keys=[leader,a.authority,a.config,a.charter,a.assetBinding,a.retirementReceipt,a.permitReceipt,craft,a.craftControl,a.asset,a.collection,a.collectionAuthority,a.freezeAuthority,CORE,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId];
 need(new Set(keys.map(k=>k.toBase58())).size===keys.length);
 const instruction=new TransactionInstruction({programId:economy,keys:keys.map((pubkey,i)=>({pubkey,isSigner:i===0,isWritable:[0,3,5,6].includes(i)})),data:Buffer.concat([hex((await sha('global:retire_charter')).slice(0,16)),clan,id(o.id),id(o.fenceId),le(o.expectedRevision,4),hex(o.clearanceHash),permitId,le(expiry),le(1,2)])});
 const table=new AddressLookupTableAccount({key:key(p.lookupTable.address),state:lookup});
 function build(signature:Uint8Array){return new TransactionMessage({payerKey:leader,recentBlockhash:key(p.blockhash).toBase58(),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:PHASE_E_CHARTER_PREPARATION.computeUnitLimit}),Ed25519Program.createInstructionWithPublicKey({publicKey:key(p.policySigner).toBytes(),message:candidate,signature}),instruction]}).compileToV0Message([table]);}
 const message=build(policySignature),bytes=Buffer.from(message.serialize()),wire=Buffer.from(new VersionedTransaction(message).serialize()),template=build(new Uint8Array(64));
 need(message.addressTableLookups.length===1&&message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0&&wire.length<=1232&&wire.length===v.preparation.packet.packetBytes&&bytes.toString('hex')===v.preparation.packet.messageHex&&wire.toString('hex')===v.preparation.packet.unsignedTransactionHex&&await sha(bytes)===v.preparation.packet.messageSha256);
 need(Buffer.from(template.serialize()).toString('hex')===q.template.messageHex&&Buffer.from(new VersionedTransaction(template).serialize()).toString('hex')===q.template.unsignedTransactionHex&&await sha(template.serialize())===q.template.messageSha256&&q.template.packetBytes===wire.length);
 return {message:bytes,wire};
}
export async function prepareRetirementSigning(raw:CharterRetirementOperation,trust:RetirementSigningTrust,wallet:string):Promise<PreparedRetirementSigning>{
 const v=CharterRetirementOperationSchema.parse(raw);if(!v.attempt||!v.preparation||v.terminal||v.signed)throw Error('Original dissolution is not awaiting approval.');const q=v.attempt.quote,p=q.packetInput;
 const d=trust?.deployment,s=q.observation.source.programs;
 need(trust&&trust.version===1&&/^[A-Za-z0-9_.:-]{1,128}$/.test(trust.revision)&&d.expectedGenesisHash===s.expectedGenesisHash&&d.stateProvenance===s.stateProvenance
  &&samePin(d.economy,s.economy)&&samePin(d.craft,s.craft)&&samePin(d.core,s.core)&&trust.policySigner===p.policySigner
  &&trust.royaltyBps===PHASE_E_CHARTER_TRANSFER.royaltyBps&&trust.lookupTables.length>0&&trust.lookupTables.length<=4
  &&trust.lookupTables.some(pin=>pin.address===p.expectedLookupTable.address&&pin.dataSha256===p.expectedLookupTable.dataSha256),'Independent dissolution trust is unavailable.');
 need(wallet===v.original.retirement.leader,'Only the original clan leader may approve dissolution.');const {message,wire}=await canonical(v);
 const result=Object.freeze({wallet,retirementId:v.original.retirement.id,messageSha256:v.preparation.packet.messageSha256,get unsignedTransaction(){return Uint8Array.from(wire);}});proofs.set(result,{operation:v,message,wallet});return result;
}
export async function verifyRetirementWire(raw:CharterRetirementOperation,input:unknown):Promise<CharterRetirementWire>{
 const v=CharterRetirementOperationSchema.parse(raw),wire=CharterRetirementWireSchema.parse(input),{message}=await canonical(v),bytes=hex(wire.signedTransactionHex);
 need(bytes.length===65+message.length&&bytes[0]===1&&equal(bytes.subarray(65),message));const tx=VersionedTransaction.deserialize(bytes);need(equal(tx.serialize(),bytes));
 await verify(v.original.retirement.leader,message,bytes.subarray(1,65));need(bs58.encode(bytes.subarray(1,65))===wire.signature&&await sha(bytes)===wire.wireSha256&&await sha(message)===wire.messageSha256);return Object.freeze(wire);
}
export async function signRetirement(prepared:PreparedRetirementSigning,wallet:CharterSignOnlyWallet):Promise<CharterRetirementWire>{
 const proof=proofs.get(prepared);if(!proof||wallet.publicKey?.toBase58()!==proof.wallet||typeof wallet.signVersionedTransaction!=='function')throw Error('Original dissolution signer changed.');
 const response=await wallet.signVersionedTransaction(VersionedTransaction.deserialize(prepared.unsignedTransaction));
 need(response instanceof VersionedTransaction&&response.message instanceof MessageV0&&response.signatures.length===1&&response.signatures[0] instanceof Uint8Array&&response.signatures[0].length===64);
 const m=response.message;need(m.staticAccountKeys.length<=32&&m.compiledInstructions.length===3&&m.addressTableLookups.length===1&&m.compiledInstructions.every(i=>i.data instanceof Uint8Array&&i.data.length<=512&&i.accountKeyIndexes.length<=32)&&m.addressTableLookups.every(a=>a.readonlyIndexes.length<=32&&a.writableIndexes.length<=32));
 need(equal(m.serialize(),proof.message));const bytes=Buffer.from(response.serialize());return verifyRetirementWire(proof.operation,{signedTransactionHex:bytes.toString('hex'),signature:bs58.encode(response.signatures[0]!),wireSha256:await sha(bytes),messageSha256:prepared.messageSha256});
}
