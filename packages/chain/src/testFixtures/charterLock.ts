/** Explicit synthetic same-bank D181 fixtures; real ephemeral Ed25519 keys.
 * Actual Core execution belongs to the separate API acceptance journey. */
import {AddressLookupTableAccount,AddressLookupTableProgram,Keypair,MessageV0,PublicKey,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {preparationFixture,digest,sign} from './charterPreparation';
import {charterTransferConfigPda,CORE_PROGRAM,encodeCharterPurposePermit,hashCharterLockPayload} from '../charterTransferProtocol';
import {seekerAuthorityPda,seekerPermitReceiptPda} from '../seekerAuctionProtocol';
import {charterClanIdBytes} from '../charterProtocol';
import {createCharterLockQuoteReader,buildCharterLockPacket,lockParts,type CharterLockOriginal,type CharterLockQuoteOptions} from '../charterLockPreparation';
export function lockFixture(action:'set'|'clear'='set'){
 const f=preparationFixture(),leader=Keypair.generate(),economy=new PublicKey(f.saved.chain.economyProgram),craft=new PublicKey(f.saved.chain.craftProgram),permitId=Buffer.alloc(16,44);
 const original:CharterLockOriginal={creation:f.saved,operation:{id:'12345678-1234-4678-9abc-def012345680',fenceId:'12345678-1234-4678-9abc-def012345681',eventId:'12345678-1234-4678-9abc-def012345682',lockId:'12345678-1234-4678-9abc-def012345683',leader:leader.publicKey.toBase58(),expectedRevision:action==='set'?0:1,action,termsHash:'ab'.repeat(32)}};
 leader.publicKey.toBuffer().copy(f.get('charter').data,121);f.get('charter').data.writeUInt32LE(original.operation.expectedRevision,153);leader.publicKey.toBuffer().copy(f.get('asset').data,1);
 if(action==='clear'){f.get('charter').data[158]=1;charterClanIdBytes(original.operation.lockId).copy(f.get('charter').data,159);}
 // Same finite static D180 table, containing no per-clan/per-operation address.
 const c=f.saved.chain,keys=[seekerAuthorityPda(economy),new PublicKey(c.config),charterTransferConfigPda(economy),craft,new PublicKey(c.craftControl),new PublicKey(c.collection),new PublicKey(c.collectionAuthority),CORE_PROGRAM,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId,economy,Keypair.generate().publicKey];
 const data=Buffer.alloc(56+32*keys.length);data.writeUInt32LE(1);data.writeBigUInt64LE((1n<<64n)-1n,4);data.writeBigUInt64LE(100n,12);keys.forEach((k,i)=>k.toBuffer().copy(data,56+i*32));
 const lookup={address:f.lookup.address,keys,data,pin:{address:f.lookup.address.toBase58(),dataSha256:digest(data)},table:()=>new AddressLookupTableAccount({key:f.lookup.address,state:AddressLookupTableAccount.deserialize(data)})};
 f.rpc.getAccountInfoAndContext=async()=>({context:{slot:150},value:{owner:AddressLookupTableProgram.programId,executable:false,data}});
 const options:CharterLockQuoteOptions={trust:f.trust,expectedCurrentSigner:f.policy.publicKey.toBase58(),lookupTable:lookup.pin,costLimits:{maxNetworkFeeLamports:100000n,maxRentLamports:100000n,maxAdditionalLamports:200000n}};
 return {...f,original,leader,economy,craft,permitId,receipt:seekerPermitReceiptPda(economy,permitId),lookup,options,sign};
}
export function lockCandidateHex(f:ReturnType<typeof lockFixture>,expiry:bigint,permitId=f.permitId){const {economy,craft,leader,terms}=lockParts(f.original);return encodeCharterPurposePermit(f.genesis,economy,6,leader,{permitId,expiry},hashCharterLockPayload(economy,craft,leader,terms)).toString('hex');}
export async function preparedLock(action:'set'|'clear'='set'){
 const f=lockFixture(action),quote=await createCharterLockQuoteReader(f.connect,f.options)(f.original,f.permitId),packetInput={...quote.packetInput,policySignatureHex:sign(f.policy,Buffer.from(quote.packetInput.candidateHex,'hex')).toString('hex')},packet=buildCharterLockPacket(packetInput);
 const tx=VersionedTransaction.deserialize(Buffer.from(packet.unsignedTransactionHex,'hex'));tx.sign([f.leader]);const wire=Buffer.from(tx.serialize());return {...f,quote,packetInput,packet,tx,wire,savedLock:{packetInput,signedTransactionHex:wire.toString('hex')}};
}
export async function evidenceLock(action:'set'|'clear'='set'){
 const f=await preparedLock(action),loaded=(f.tx.message as MessageV0).resolveAddressTableLookups([f.lookup.table()]),keys=[...f.tx.message.staticAccountKeys,...loaded.writable,...loaded.readonly],pre=keys.map(()=>1000000),post=[...pre];
 post[0]!-=11535;post[keys.findIndex(k=>k.equals(f.receipt))]!+=1535;
 const transaction={slot:140,version:0,transaction:{message:f.tx.message,signatures:f.tx.signatures.map(s=>bs58.encode(s))},meta:{err:null,fee:10000,preBalances:pre,postBalances:post,loadedAddresses:loaded}} as VersionedTransactionResponse;
 f.get('charter').data.writeUInt32LE(f.original.operation.expectedRevision+1,153);f.get('charter').data[158]=action==='set'?1:0;
 if(action==='set')charterClanIdBytes(f.original.operation.lockId).copy(f.get('charter').data,159);else f.get('charter').data.fill(0,159,175);
 f.rows.push({address:f.lookup.address,owner:AddressLookupTableProgram.programId,executable:false,data:f.lookup.data});
 const rpc={...f.rpc,getTransaction:async()=>transaction};return {...f,transaction,rpc,connect:()=>rpc};
}
