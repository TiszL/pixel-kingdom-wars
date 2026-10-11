/** Synthetic bank/transaction envelopes with real ephemeral signatures. These
 * exercise evidence validation, never claim a validator-executed retirement. */
import {AddressLookupTableProgram,MessageV0,PublicKey,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {lockFixture} from './charterLock';
import {charterClanIdBytes} from '../charterProtocol';
import {transferDisc} from '../charterTransferProtocol';
import {charterRetirementReceiptPda,encodeCharterRetirementPermit,hashCharterRetirementPayload} from '../charterRetirementProtocol';
import {createCharterRetirementQuoter,buildCharterRetirementPacket,retirementParts,type CharterRetirementOriginal} from '../charterRetirementPreparation';
export function retirementFixture(){
 const f=lockFixture(),original:CharterRetirementOriginal={creation:f.original.creation,retirement:{id:f.original.operation.id,fenceId:f.original.operation.fenceId,clanId:f.original.creation.clanId,leader:f.original.operation.leader,expectedRevision:0,clearanceHash:'cd'.repeat(32)}};
 return {...f,original,retirementReceipt:charterRetirementReceiptPda(f.economy,original.creation.clanId)};
}
export function retirementCandidateHex(f:ReturnType<typeof retirementFixture>,expiry:bigint,permitId=f.permitId){const {economy,craft,leader,terms}=retirementParts(f.original);return encodeCharterRetirementPermit(f.genesis,economy,leader,{permitId,expiry},hashCharterRetirementPayload(economy,craft,leader,terms)).toString('hex');}
export async function preparedRetirement(){
 const f=retirementFixture(),quote=await createCharterRetirementQuoter(f.connect,f.options)(f.original,f.permitId),packetInput={...quote.packetInput,policySignatureHex:f.sign(f.policy,Buffer.from(quote.packetInput.candidateHex,'hex')).toString('hex')},packet=buildCharterRetirementPacket(packetInput);
 const tx=VersionedTransaction.deserialize(Buffer.from(packet.unsignedTransactionHex,'hex'));tx.sign([f.leader]);const wire=Buffer.from(tx.serialize());return {...f,quote,packetInput,packet,tx,wire,savedRetirement:{packetInput,signedTransactionHex:wire.toString('hex')}};
}
export function retirementReceiptBytes(f:ReturnType<typeof retirementFixture>){
 const c=f.original.creation.chain,r=f.original.retirement,b=Buffer.alloc(250);transferDisc('account:CharterRetirementReceipt').copy(b);b[8]=1;
 new PublicKey(c.config).toBuffer().copy(b,9);charterClanIdBytes(r.id).copy(b,41);charterClanIdBytes(r.fenceId).copy(b,57);charterClanIdBytes(r.clanId).copy(b,73);
 new PublicKey(c.charter).toBuffer().copy(b,89);new PublicKey(c.asset).toBuffer().copy(b,121);f.leader.publicKey.toBuffer().copy(b,153);
 b.writeUInt32LE(r.expectedRevision,185);b.writeUInt32LE(r.expectedRevision+1,189);Buffer.from(r.clearanceHash,'hex').copy(b,193);f.permitId.copy(b,225);b.writeBigInt64LE(1800000010n,241);
 b[249]=PublicKey.findProgramAddressSync([Buffer.from('charter_retirement'),charterClanIdBytes(r.clanId)],f.economy)[1];return b;
}
export async function evidenceRetirement(){
 const f=await preparedRetirement(),loaded=(f.tx.message as MessageV0).resolveAddressTableLookups([f.lookup.table()]),keys=[...f.tx.message.staticAccountKeys,...loaded.writable,...loaded.readonly],pre=keys.map(()=>1000000),post=[...pre];
 post[0]!-=13535;post[keys.findIndex(k=>k.equals(f.receipt))]!+=1535;post[keys.findIndex(k=>k.equals(f.retirementReceipt))]!+=2000;
 const transaction={slot:140,version:0,transaction:{message:f.tx.message,signatures:f.tx.signatures.map(s=>bs58.encode(s))},meta:{err:null,fee:10000,preBalances:pre,postBalances:post,loadedAddresses:loaded}} as VersionedTransactionResponse;
 f.get('charter').data.writeUInt32LE(1,153);f.get('charter').data[157]=2;
 const receiptData=retirementReceiptBytes(f);f.rows.push({address:f.retirementReceipt,owner:f.economy,executable:false,data:receiptData},{address:f.lookup.address,owner:AddressLookupTableProgram.programId,executable:false,data:f.lookup.data});
 const rpc={...f.rpc,getTransaction:async()=>transaction};return {...f,transaction,receiptData,rpc,connect:()=>rpc};
}
