/** Explicit simulated finalized bank for ordinary HTTP composition. Genuine
 * submitted SBF transactions are covered by charter-retirement-core.fixture.ts. */
import {AddressLookupTableAccount,PublicKey,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import type {CharterRetirementOperation} from '@shardkeep/shared/charterRetirementApi';
import {charterClanIdBytes} from '@shardkeep/chain/charter-protocol';
import {transferDisc} from '@shardkeep/chain/charter-transfer-protocol';
import {retirementParts,retirementCandidate} from '@shardkeep/chain/charter-retirement-preparation';
import {charterRetirementAccounts} from '@shardkeep/chain/charter-retirement-protocol';
export function simulatedRetirementFinality(bank:{clock:Buffer;rows:{address:PublicKey;owner:PublicKey;executable:boolean;data:Buffer}[]},state:CharterRetirementOperation):VersionedTransactionResponse{
 const q=state.attempt!.quote,{economy,craft,leader,terms}=retirementParts(state.original),permit=retirementCandidate(state.original,state.attempt!.candidateHex),a=charterRetirementAccounts(economy,craft,leader,terms,permit.permitId),tx=VersionedTransaction.deserialize(Buffer.from(state.signed!.signedTransactionHex,'hex'));
 const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;},u64=(n:bigint)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b;};
 const receipt=Buffer.concat([transferDisc('account:CharterRetirementReceipt'),Buffer.of(1),a.config.toBuffer(),...[terms.retirementId,terms.fenceId,terms.clanId].map(charterClanIdBytes),...[a.charter,a.asset,leader].map(k=>k.toBuffer()),u32(terms.expectedRevision),u32(terms.expectedRevision+1),Buffer.from(terms.clearanceHash),permit.permitId,u64(bank.clock.readBigInt64LE(32)),Buffer.of(PublicKey.findProgramAddressSync([Buffer.from('charter_retirement'),charterClanIdBytes(terms.clanId)],economy)[1])]);
 bank.rows.push({address:a.retirementReceipt,owner:economy,executable:false,data:receipt});const registry=bank.rows.find(row=>row.address.equals(a.charter))!;registry.data.writeUInt32LE(terms.expectedRevision+1,153);registry.data[157]=2;
 if(tx.message.version!==0)throw Error('Retirement fixture requires canonical v0');
 const lookup=new AddressLookupTableAccount({key:new PublicKey(q.packetInput.lookupTable.address),state:AddressLookupTableAccount.deserialize(Buffer.from(q.packetInput.lookupTable.dataHex,'hex'))}),loaded=tx.message.resolveAddressTableLookups([lookup]),keys=[...tx.message.staticAccountKeys,...loaded.writable,...loaded.readonly],pre=keys.map(()=>10000000),post=[...pre],fee=10000,rent=2000;
 keys.forEach((key,i)=>{if(key.equals(leader))post[i]!-=fee+rent;else if(key.equals(a.retirementReceipt))post[i]!+=rent;});
 return {slot:150,version:0,transaction:{message:tx.message,signatures:tx.signatures.map(s=>bs58.encode(s))},meta:{err:null,fee,preBalances:pre,postBalances:post,loadedAddresses:loaded}} as unknown as VersionedTransactionResponse;
}
