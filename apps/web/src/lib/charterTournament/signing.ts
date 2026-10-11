/** Independent D181 browser reconstruction. No server/chain package imports. */
import {AddressLookupTableAccount,AddressLookupTableProgram,ComputeBudgetProgram,Ed25519Program,MessageV0,PublicKey,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {keccak_256} from '@noble/hashes/sha3';
import {PHASE_E_CHARTER_ADMISSION,PHASE_E_CHARTER_PREPARATION,PHASE_E_CHARTER_TRANSFER} from '@shardkeep/shared';
import {CharterTournamentOperationSchema,CharterTournamentWireSchema,postgresJsonbText,type CharterTournamentOperation,type CharterTournamentWire} from '@shardkeep/shared/charterTournamentApi';
import type {CharterSigningTrust,CharterSignOnlyWallet} from '../charter/signing';
export type TournamentSigningTrust=CharterSigningTrust;
export interface PreparedTournamentSigning {readonly wallet:string;readonly operationId:string;readonly messageSha256:string;readonly unsignedTransaction:Uint8Array}
const proofs=new WeakMap<PreparedTournamentSigning,{operation:CharterTournamentOperation;message:Buffer;wallet:string}>();
const CORE=new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'),U64=(1n<<64n)-1n;
const need=(value:unknown,message='Tournament approval differs from its original.')=>{if(!value)throw Error(message);};
const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const same=(a:unknown,b:unknown)=>postgresJsonbText(a)===postgresJsonbText(b);
const hex=(v:string)=>Buffer.from(v,'hex'),id=(v:string)=>hex(v.replaceAll('-',''));
function key(v:string){const p=new PublicKey(v);need(p.toBase58()===v&&!p.equals(PublicKey.default));return p;}
function le(n:bigint|number,size=8){let v=BigInt(n);need(v>=0n&&v<(1n<<BigInt(size*8)));const b=Buffer.alloc(size);for(let i=0;i<size;i++){b[i]=Number(v&255n);v>>=8n;}return b;}
const str=(v:string)=>{const b=Buffer.from(v,'utf8');return Buffer.concat([le(b.length,4),b]);};
const hash=(v:Uint8Array)=>Buffer.from(keccak_256(v));
async function sha(v:Uint8Array|string){return Buffer.from(await crypto.subtle.digest('SHA-256',typeof v==='string'?new TextEncoder().encode(v):new Uint8Array(v))).toString('hex');}
async function verify(wallet:string,message:Uint8Array,signature:Uint8Array){const k=await crypto.subtle.importKey('raw',new Uint8Array(key(wallet).toBytes()),{name:'Ed25519'},false,['verify']);need(await crypto.subtle.verify({name:'Ed25519'},k,new Uint8Array(signature),new Uint8Array(message)),'Tournament signature is invalid.');}
export async function tournamentTermsHash(value:CharterTournamentOperation['operationTerms']){return sha('SHARDKEEP_CHARTER_TOURNAMENT_LOCK_TERMS_V1'+postgresJsonbText(value));}
async function canonical(v:CharterTournamentOperation){
 if(!v.attempt||!v.preparation)throw Error('Original tournament approval is not prepared.');
 const o=v.original.operation,cr=v.original.creation,c=cr.chain,q=v.attempt.quote,p=q.packetInput,policySignature=hex(v.preparation.policySignatureHex),candidate=hex(p.candidateHex),permitId=candidate.subarray(73,89),expiry=candidate.readBigInt64LE(121);
 const economy=key(c.economyProgram),craft=key(c.craftProgram),leader=key(o.leader),pda=(program:PublicKey,seed:string,...tail:Buffer[])=>PublicKey.findProgramAddressSync([Buffer.from(seed),...tail],program)[0],clan=id(cr.clanId),asset=pda(craft,'charter_mint',clan);
 const a={authority:pda(economy,'seeker_authority'),config:pda(economy,'charter_config'),transferConfig:pda(economy,'charter_transfer_config'),craftControl:pda(craft,'charter_control'),collection:pda(craft,'charter_collection'),collectionAuthority:pda(craft,'charter_collection_authority'),charter:pda(economy,'charter',clan),asset,assetBinding:pda(economy,'charter_asset',asset.toBuffer()),freezeAuthority:pda(craft,'charter_freeze',clan),executor:pda(economy,'charter_executor',clan),creationReceipt:pda(economy,'charter_creation',id(cr.creationIntentId)),receipt:pda(economy,'permit',permitId)};
 for(const f of ['config','craftControl','collection','collectionAuthority','charter','asset','assetBinding','freezeAuthority','executor','creationReceipt'] as const)need(a[f].toBase58()===c[f]);
 need(await tournamentTermsHash(v.operationTerms)===o.termsHash);
 need(hash(Buffer.concat([Buffer.from('SKCHMET1'),str(cr.metadata.name),str(cr.metadata.uri)])).toString('hex')===cr.metadata.hash);
 const trust=q.observation.source.programs;need(trust.expectedGenesisHash===c.genesisHash&&trust.economy.programId===c.economyProgram&&trust.craft.programId===c.craftProgram&&trust.core.programId===CORE.toBase58());
 need([trust.economy,trust.craft,trust.core].every(pin=>pin.reviewedDeploymentSlot<=q.observation.slot));
 need(expiry-BigInt(q.observation.unixTimestamp)===BigInt(PHASE_E_CHARTER_ADMISSION.v1.issuedPermitTtlSec));
 const payload=Buffer.concat([Buffer.from('SKCHLCK1'),Buffer.of(1,0),...[a.config,a.charter,a.asset,leader].map(k=>k.toBuffer()),clan,id(o.lockId),le(o.expectedRevision,4),Buffer.of(o.action==='set'?1:2),hex(o.termsHash)]);
 const expected=Buffer.concat([Buffer.from('SKPERMT2'),key(c.genesisHash).toBuffer(),economy.toBuffer(),Buffer.of(6),permitId,leader.toBuffer(),le(expiry),hash(payload)]);need(equal(candidate,expected));await verify(p.policySigner,candidate,policySignature);
 const allocation=q.costs.allocations[0]!;need(allocation.address===a.receipt.toBase58()&&allocation.kind==='permit-receipt'&&allocation.bytes===107);
 const raw=hex(p.lookupTable.dataHex);need(p.lookupTable.owner===AddressLookupTableProgram.programId.toBase58()&&await sha(raw)===p.expectedLookupTable.dataSha256);
 const lookup=AddressLookupTableAccount.deserialize(raw);need(lookup.authority===undefined&&lookup.deactivationSlot===U64&&lookup.lastExtendedSlot<p.lookupTable.slot&&lookup.addresses.length===12);
 const expectedLookup=[a.authority,a.config,a.transferConfig,craft,a.craftControl,a.collection,a.collectionAuthority,CORE,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId,economy,key(v.operationTerms.domain.treasury)];
 need(new Set(expectedLookup.map(k=>k.toBase58())).size===12&&lookup.addresses.every((k,i)=>k.equals(expectedLookup[i]!)));
 const keys=[leader,a.authority,a.config,a.charter,a.craftControl,a.receipt,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId];
 const instruction=new TransactionInstruction({programId:economy,keys:keys.map((pubkey,i)=>({pubkey,isSigner:i===0,isWritable:[0,3,5].includes(i)})),data:Buffer.concat([hex((await sha(`global:${o.action}_charter_lock`)).slice(0,16)),clan,id(o.lockId),le(o.expectedRevision,4),hex(o.termsHash),permitId,le(expiry),le(1,2)])});
 const table=new AddressLookupTableAccount({key:key(p.lookupTable.address),state:lookup});
 function build(signature:Uint8Array){return new TransactionMessage({payerKey:leader,recentBlockhash:key(p.blockhash).toBase58(),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:PHASE_E_CHARTER_PREPARATION.computeUnitLimit}),Ed25519Program.createInstructionWithPublicKey({publicKey:key(p.policySigner).toBytes(),message:candidate,signature}),instruction]}).compileToV0Message([table]);}
 const message=build(policySignature),bytes=Buffer.from(message.serialize()),wire=Buffer.from(new VersionedTransaction(message).serialize()),template=build(new Uint8Array(64));
 need(message.addressTableLookups.length===1&&message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0&&wire.length<=1232&&wire.length===v.preparation.packet.packetBytes&&bytes.toString('hex')===v.preparation.packet.messageHex&&wire.toString('hex')===v.preparation.packet.unsignedTransactionHex&&await sha(bytes)===v.preparation.packet.messageSha256);
 need(Buffer.from(template.serialize()).toString('hex')===q.template.messageHex&&Buffer.from(new VersionedTransaction(template).serialize()).toString('hex')===q.template.unsignedTransactionHex&&await sha(template.serialize())===q.template.messageSha256&&q.template.packetBytes===wire.length);
 return {message:bytes,wire};
}
export async function prepareTournamentSigning(raw:CharterTournamentOperation,trust:TournamentSigningTrust,wallet:string):Promise<PreparedTournamentSigning>{
 const v=CharterTournamentOperationSchema.parse(raw);if(!v.attempt||!v.preparation||v.terminal||v.signed)throw Error('Original tournament is not awaiting approval.');const q=v.attempt.quote,p=q.packetInput;
 need(trust&&trust.version===1&&typeof trust.revision==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(trust.revision)&&same(trust.deployment,q.observation.source.programs)&&trust.policySigner===p.policySigner&&trust.royaltyBps===PHASE_E_CHARTER_TRANSFER.royaltyBps&&trust.treasury===v.operationTerms.domain.treasury&&trust.lookupTables.length>0&&trust.lookupTables.length<=4&&trust.lookupTables.some(pin=>same(pin,p.expectedLookupTable)),'Independent tournament trust is unavailable.');
 need(wallet===v.original.operation.leader,'Only the original captain may approve this lock.');const {message,wire}=await canonical(v);
 const result=Object.freeze({wallet,operationId:v.original.operation.id,messageSha256:v.preparation.packet.messageSha256,get unsignedTransaction(){return Uint8Array.from(wire);}});proofs.set(result,{operation:v,message,wallet});return result;
}
export async function verifyTournamentWire(raw:CharterTournamentOperation,input:unknown):Promise<CharterTournamentWire>{
 const v=CharterTournamentOperationSchema.parse(raw),wire=CharterTournamentWireSchema.parse(input),{message}=await canonical(v),bytes=hex(wire.signedTransactionHex);
 need(bytes.length===65+message.length&&bytes[0]===1&&equal(bytes.subarray(65),message));const tx=VersionedTransaction.deserialize(bytes);need(equal(tx.serialize(),bytes));
 await verify(v.original.operation.leader,message,bytes.subarray(1,65));need(bs58.encode(bytes.subarray(1,65))===wire.signature&&await sha(bytes)===wire.wireSha256&&await sha(message)===wire.messageSha256);return Object.freeze(wire);
}
export async function signTournament(prepared:PreparedTournamentSigning,wallet:CharterSignOnlyWallet):Promise<CharterTournamentWire>{
 const proof=proofs.get(prepared);if(!proof||wallet.publicKey?.toBase58()!==proof.wallet||typeof wallet.signVersionedTransaction!=='function')throw Error('Original tournament signer changed.');
 const response=await wallet.signVersionedTransaction(VersionedTransaction.deserialize(prepared.unsignedTransaction));
 need(response instanceof VersionedTransaction&&response.message instanceof MessageV0&&response.signatures.length===1&&response.signatures[0] instanceof Uint8Array&&response.signatures[0].length===64);
 const m=response.message;need(m.staticAccountKeys.length<=32&&m.compiledInstructions.length===3&&m.addressTableLookups.length===1&&m.compiledInstructions.every(i=>i.data instanceof Uint8Array&&i.data.length<=512&&i.accountKeyIndexes.length<=32)&&m.addressTableLookups.every(a=>a.readonlyIndexes.length<=12&&a.writableIndexes.length<=12));
 need(equal(m.serialize(),proof.message));const bytes=Buffer.from(response.serialize());return verifyTournamentWire(proof.operation,{signedTransactionHex:bytes.toString('hex'),signature:bs58.encode(response.signatures[0]!),wireSha256:await sha(bytes),messageSha256:prepared.messageSha256});
}
