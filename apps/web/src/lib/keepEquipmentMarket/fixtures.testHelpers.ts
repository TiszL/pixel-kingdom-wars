import {createHash,randomUUID} from 'node:crypto';
import bs58 from 'bs58';
import {Keypair,Message,MessageV0,VersionedTransaction} from '@solana/web3.js';
import {buildKeepEquipmentPaymentMessage} from '../../../../../packages/chain/src/keepEquipmentPayment';
import {KeepEquipmentPurchaseSchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import type {KeepEquipmentSigningTrust} from './signing';
// Independent server constructor supplies vectors for the browser's SPL
// decoder. No fixture bypass enters production wallet authority.
export function keepMarketFixture(version:'legacy'|0='legacy',createAta=false){
 const buyer=Keypair.generate(),seller=Keypair.generate(),mint=Keypair.generate().publicKey.toBase58(),genesis=Keypair.generate().publicKey.toBase58(),blockhash=Keypair.generate().publicKey.toBase58(),id=randomUUID();
 const limits={maxFeeLamports:100_000n,maxPriorityFeeLamports:0n,maxComputeUnitLimit:300_000};
 const original={reservationId:id,buyer:buyer.publicKey.toBase58(),seller:seller.publicKey.toBase58(),keepMint:mint,totalBaseUnits:1_000_001n,sellerAtaExists:!createAta,...createAta?{sellerAtaRentCapLamports:2_039_280n}:{}};
 const built=buildKeepEquipmentPaymentMessage(original,limits,blockhash,version),at='2035-01-01T00:00:00.000Z';
 const policyPins={expectedGenesisHash:genesis,expectedKeepMint:mint,providerIds:['one','two']};
 const observation={openingSlot:100,accountSlot:100,feeSlot:101,validitySlot:102,closingSlot:103,currentBlockHeight:200,feeLamports:'5000'};
 const value=KeepEquipmentPurchaseSchema.parse({fill:{id,listingId:randomUUID(),buyerWallet:original.buyer,buyerBaseId:randomUUID(),quantity:'1',totalBaseUnits:'1000001',createdAt:at,sellerWallet:original.seller,sellerBaseId:randomUUID(),itemId:'route_compass',unitPriceBaseUnits:'1000001'},
  preparation:{version:1,transactionVersion:version,original:{...original,totalBaseUnits:'1000001',...createAta?{sellerAtaRentCapLamports:'2039280'}:{}},limits:{...limits,maxFeeLamports:'100000',maxPriorityFeeLamports:'0'},...policyPins,
   blockhash,lastValidBlockHeight:300,blockhashSlot:100,minContextSlot:100,messageSha256:built.messageSha256,messageHex:Buffer.from(built.messageBytes).toString('hex'),
   observedAccounts:[mint,built.buyerAta,built.sellerAta,original.buyer].map(address=>({address,owner:null,lamports:'0',dataLength:0,dataSha256:null,executable:false})),accountEvidenceSha256:'a'.repeat(64),observations:[observation,observation],
   balances:{buyerKeepBaseUnits:'10000000',sellerKeepBaseUnits:createAta?null:'0',buyerSolLamports:'100000000',sellerAccountState:createAta?'missing':'existing'},costs:{feeLamports:'5000',rentLamports:createAta?'2039280':'0',fullAtaRentLamports:'2039280',totalLamports:createAta?'2044280':'5000'},
   signingAuthorized:false,broadcastAuthorized:false,deliveryAuthorized:false,fenceReleaseAuthorized:false,unpaidProven:false,recordedAt:at},wire:null,delivery:null,status:'prepared',signingAuthorized:false,broadcastAuthorized:false,fenceReleaseAuthorized:false,unpaidProven:false});
 const trust:KeepEquipmentSigningTrust={version:1,revision:'local-test',expectedGenesisHash:genesis,expectedKeepMint:mint,maxFeeLamports:'100000',maxAtaRentLamports:'2039280'};
 return {value,buyer,seller,trust,built,signer:{publicKey:buyer.publicKey,signVersionedTransaction:async(tx:VersionedTransaction)=>{tx.sign([buyer]);return tx;}},unsigned:()=>new VersionedTransaction(version==='legacy'?Message.from(built.messageBytes):MessageV0.deserialize(built.messageBytes))};
}

/** Public failed-packet receipt shape for client state tests. Actual finalized
 * failure and API custody evidence live in the separate local-chain fixture. */
export function keepMarketReleasedFixture(version:'legacy'|0='legacy',createAta=false){
 const f=keepMarketFixture(version,createAta),tx=f.unsigned();tx.sign([f.buyer]);const bytes=Buffer.from(tx.serialize());
 const hash=(input:Uint8Array|string)=>createHash('sha256').update(input).digest('hex');
 const wire={signature:bs58.encode(tx.signatures[0]!),signedTransactionHex:bytes.toString('hex'),messageSha256:f.built.messageSha256,wireSha256:hash(bytes),recordedAt:f.value.fill.createdAt};
 const signed=KeepEquipmentPurchaseSchema.parse({...f.value,wire,status:'signed'}),p=signed.preparation!,keys=tx.message.staticAccountKeys.map(k=>k.toBase58());
 const before=keys.map((_,i)=>i===0?10000000:0),after=before.map((v,i)=>i===0?v-5000:v);
 const evidence={slot:110,blockTime:2051222400,error:{InstructionError:[createAta?2:1,{Custom:1}]},feeLamports:'5000',resolvedKeys:keys,lamportsBefore:before,lamportsAfter:after,tokenBalances:null};
 const proof={version:1,outcome:'failed',reservationId:signed.fill.id,buyer:signed.fill.buyerWallet,seller:signed.fill.sellerWallet,keepMint:p.expectedKeepMint,totalBaseUnits:signed.fill.totalBaseUnits,
  signature:wire.signature,messageSha256:wire.messageSha256,wireSha256:wire.wireSha256,transactionVersion:version,...evidence,evidenceSha256:hash(JSON.stringify(evidence)),rentLamports:'0',paidKeepBaseUnits:'0',
  expectedGenesisHash:p.expectedGenesisHash,providerIds:p.providerIds,minContextSlot:100,observations:[{openingSlot:100,closingSlot:111},{openingSlot:100,closingSlot:111}],finalizedAgreement:true,
  paymentAuthorized:false,signingAuthorized:false,broadcastAuthorized:false,deliveryAuthorized:false,fenceReleaseAuthorized:false,unpaidProven:false};
 const released=KeepEquipmentPurchaseSchema.parse({...signed,status:'released',release:{fillId:signed.fill.id,reason:'finalized_failed',signature:wire.signature,proof,releasedAt:signed.fill.createdAt}});
 const reserved=KeepEquipmentPurchaseSchema.parse({...f.value,preparation:null,status:'reserved'}),cancelled=KeepEquipmentPurchaseSchema.parse({...reserved,status:'released',release:{fillId:reserved.fill.id,reason:'never_prepared',signature:null,proof:null,releasedAt:reserved.fill.createdAt}});
 return {...f,signed,released,reserved,cancelled};
}
