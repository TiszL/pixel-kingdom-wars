/** Synthetic finalized quote transport, real ephemeral Ed25519 signatures. */
import { createHash } from 'node:crypto';
import { AddressLookupTableAccount, AddressLookupTableProgram, Ed25519Program, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram } from '@solana/web3.js';
import { vi } from 'vitest';
import { encodeCharterRegistrationPermit, hashCharterRegistrationPayload } from '../charterProtocol';
import { seekerAuthorityPda, seekerPermitReceiptPda } from '../seekerAuctionProtocol';
import type { CharterPacketInput, CharterPreparationOriginal, CharterCreationQuoteRpc, CharterCreationQuoteOptions } from '../charterCreationPreparation';
import { fixture } from './charterCreation';
export const digest=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
export const sign=(key:Keypair,message:Uint8Array)=>Buffer.from(Ed25519Program.createInstructionWithPrivateKey({privateKey:key.secretKey,message}).data.subarray(48,112));
export function registrationKeys(original:CharterPreparationOriginal,candidate:Uint8Array){
 const c=original.chain,key=(field:keyof typeof c)=>new PublicKey(c[field]),economy=key('economyProgram');
 const values=[new PublicKey(original.payer),seekerAuthorityPda(economy),key('config'),key('charter'),key('assetBinding'),key('creationReceipt'),
  seekerPermitReceiptPda(economy,candidate.subarray(73,89)),key('executor'),key('craftProgram'),key('craftControl'),key('asset'),key('collection'),
  key('collectionAuthority'),key('freezeAuthority'),new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'),SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId,economy];
 return values.map((pubkey,i)=>({pubkey,isSigner:i===0,isWritable:[0,3,4,5,6,10,11].includes(i)}));
}
export function lookupFixture(original:CharterPreparationOriginal,candidate:Uint8Array){
 const address=Keypair.generate().publicKey,keys=registrationKeys(original,candidate).map(v=>v.pubkey)
  .filter((k,i,a)=>a.findIndex(v=>v.equals(k))===i).sort((a,b)=>a.toBase58().localeCompare(b.toBase58()));
 const data=Buffer.alloc(56+keys.length*32);data.writeUInt32LE(1);data.writeBigUInt64LE((1n<<64n)-1n,4);data.writeBigUInt64LE(100n,12);
 keys.forEach((k,i)=>k.toBuffer().copy(data,56+i*32));
 const row={address:address.toBase58(),owner:AddressLookupTableProgram.programId.toBase58(),executable:false,dataHex:data.toString('hex'),slot:150};
 return {address,keys,data,row,pin:{address:address.toBase58(),dataSha256:digest(data)},table:()=>new AddressLookupTableAccount({key:address,state:AddressLookupTableAccount.deserialize(data)})};
}
export function candidateFor(original:CharterPreparationOriginal,expiry=1_800_000_550n){
 const c=original.chain,k=(f:keyof typeof c)=>new PublicKey(c[f]);
 return encodeCharterRegistrationPermit({genesisHash:k('genesisHash'),programId:k('economyProgram'),kind:5,permitId:Buffer.alloc(16,23),wallet:new PublicKey(original.payer),expiry,
  payloadHash:hashCharterRegistrationPayload({config:k('config'),craftProgram:k('craftProgram'),craftControl:k('craftControl'),collection:k('collection'),collectionAuthority:k('collectionAuthority'),
   charter:k('charter'),asset:k('asset'),assetBinding:k('assetBinding'),freezeAuthority:k('freezeAuthority'),executor:k('executor'),creationReceipt:k('creationReceipt'),
   clanId:original.clanId,leader:new PublicKey(original.payer),creationIntentId:original.creationIntentId,metadataHash:Buffer.from(original.metadata.hash,'hex'),admissionCommitment:Buffer.from(original.admissionCommitment,'hex')})});
}
export function preparationFixture(){
 const f=fixture(),{issuedPermitIds:_ids,...original}=f.saved,policy=Keypair.generate(),candidate=candidateFor(original),lookup=lookupFixture(original,candidate);
 const authority=seekerAuthorityPda(new PublicKey(original.chain.economyProgram)),bump=PublicKey.findProgramAddressSync([Buffer.from('seeker_authority')],new PublicKey(original.chain.economyProgram))[1];
 const authorityData=Buffer.alloc(213),deadline=Buffer.alloc(8);Buffer.concat([createHash('sha256').update('account:SeekerAuthority').digest().subarray(0,8),Buffer.of(1),
  Keypair.generate().publicKey.toBuffer(),Buffer.of(0),Keypair.generate().publicKey.toBuffer(),policy.publicKey.toBuffer(),Buffer.of(0),deadline,
  new PublicKey(original.chain.genesisHash).toBuffer(),Buffer.of(0,bump)]).copy(authorityData);
 f.rows.push({address:authority,owner:new PublicKey(original.chain.economyProgram),executable:false,data:authorityData});
 const blockhash=Keypair.generate().publicKey.toBase58();
 const rpc:CharterCreationQuoteRpc={...f.rpc,getAccountInfoAndContext:vi.fn(async()=>({context:{slot:150},value:{owner:AddressLookupTableProgram.programId,executable:false,data:lookup.data}})),
  getLatestBlockhashAndContext:vi.fn(async()=>({context:{slot:150},value:{blockhash,lastValidBlockHeight:300}})),getFeeForMessage:vi.fn(async()=>({context:{slot:150},value:10000})),
  getMinimumBalanceForRentExemption:vi.fn(async n=>1000+n*5),getBlockHeight:vi.fn(async()=>200)};
 const options:CharterCreationQuoteOptions={trust:f.trust,expectedCurrentSigner:policy.publicKey.toBase58(),lookupTable:lookup.pin,
  coreCostProfile:{version:1,profile:'mpl-core-0.15.2-charter-pfd-seq-none',reviewedProgramDataSha256:f.trust.core.reviewedProgramDataSha256},
  costLimits:{maxNetworkFeeLamports:100000n,maxRentLamports:100000n,maxTotalLamports:2000000n}};
 const input:CharterPacketInput={original,candidate,policySigner:policy.publicKey.toBase58(),policySignature:sign(policy,candidate),lookupTable:lookup.row,expectedLookupTable:lookup.pin,
  blockhash,blockhashSlot:150,lastValidBlockHeight:300,currentBlockHeight:200};
 return {...f,original,policy,candidate,lookup,authorityData,blockhash,rpc,options,input,connect:vi.fn((_signal:AbortSignal)=>rpc)};
}
