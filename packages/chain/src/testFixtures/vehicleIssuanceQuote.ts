/** Synthetic quote banks/local key only, never live source or supplier authority. */
import {createPrivateKey,sign} from 'node:crypto';
import {Keypair,PublicKey,SystemProgram,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {vehicleIssuanceAdmissionFixture} from './vehicleIssuanceAdmission';
import {vehiclePermitMessage} from '../vehicleIssuanceRequest';
import {type VehicleIssuanceOriginal} from '../vehicleIssuanceProtocol';
import {type VehicleIssuanceQuoteInput,type VehicleIssuanceQuoteRpc} from '../vehicleIssuanceQuote';
export function vehicleIssuanceQuoteFixture(original?:VehicleIssuanceOriginal,policy=Keypair.fromSeed(Buffer.alloc(32,17))){
 const f=vehicleIssuanceAdmissionFixture(),o=original??f.original,policyAuthority=policy.publicKey.toBase58();
 const rows=f.rows.map(row=>({...row,data:Buffer.from(row.data),lamports:1_000_000}));
 new PublicKey(o.genesisHash).toBuffer().copy(rows[6]!.data,9);policy.publicKey.toBuffer().copy(rows[6]!.data,41);rows[6]!.data.writeBigUInt64LE(BigInt(o.escrowRentReserve),178);
 rows.push({address:new PublicKey(o.buyer),owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0),lamports:1_000_000_000});
 const controls={slot:100,initialBankSlot:100,finalBankSlot:103,blockhashSlot:101,feeSlot:102,initialUnixTimestamp:1700000020n,finalUnixTimestamp:1700000021n,lastValidBlockHeight:600,currentBlockHeight:500,networkFee:10000,banks:0};
 const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(policy.secretKey).subarray(0,32)]),format:'der',type:'pkcs8'});
 const authorize=(saved:VehicleIssuanceOriginal):VehicleIssuanceQuoteInput=>({original:saved,policyAuthority,policySignature:sign(null,vehiclePermitMessage(saved),privateKey)});
 const blockhash=new PublicKey(Buffer.alloc(32,21)).toBase58();
 const rpc:VehicleIssuanceQuoteRpc={getGenesisHash:async()=>o.genesisHash,getSlot:async()=>controls.slot,
  getMultipleAccountsInfoAndContext:async addresses=>{const first=++controls.banks===1,slot=first?controls.initialBankSlot:controls.finalBankSlot;controls.slot=slot;
   return {context:{slot},value:addresses.map(address=>{const raw=rows.find(row=>row.address.equals(address));if(!raw)return null;const row={...raw,data:Buffer.from(raw.data)};
    if(address.equals(SYSVAR_CLOCK_PUBKEY)){row.data.writeBigUInt64LE(BigInt(slot));row.data.writeBigInt64LE(first?controls.initialUnixTimestamp:controls.finalUnixTimestamp,32);}return row;})};},
  getLatestBlockhashAndContext:async()=>{controls.slot=controls.blockhashSlot;return {context:{slot:controls.blockhashSlot},value:{blockhash,lastValidBlockHeight:controls.lastValidBlockHeight}};},
  getFeeForMessage:async()=>{controls.slot=controls.feeSlot;return {context:{slot:controls.feeSlot},value:controls.networkFee};},getBlockHeight:async()=>controls.currentBlockHeight};
 const costLimits={maxNetworkFeeLamports:'1000000',maxInitializationRentLamports:'100000000',maxRequiredLamports:'1000000000'};
 return {input:authorize(o),trust:{...f.trust,expectedGenesisHash:o.genesisHash},policy,policyAuthority,rows,rpc,controls,blockhash,costLimits,authorize};
}
