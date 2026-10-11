/** Generated CPU vectors. Source-backed HTTP pairing is a separate check. */
import {Keypair,MessageV0,PublicKey,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {sha256} from '@noble/hashes/sha256';
import {MiningClaimPreparationViewSchema,MiningClaimViewSchema,type MiningClaimContinuation,type MiningClaimReview} from '@shardkeep/shared/miningClaimsApi';
import {buildMiningClaimMessages} from '../../../../../packages/chain/src/miningClaimMessage';
import {miningClaimFormatFixture} from '../../../../../packages/chain/src/testFixtures/miningClaimOrdered';
import {miningClaimFixture} from './fixtures.test-support';
export function orderedMiningFixture(){
 const f=miningClaimFixture(),identity={programId:new PublicKey(f.trust.programId),keepMint:new PublicKey(f.trust.keepMint),reserveOwner:new PublicKey(f.trust.reserveOwner)},format=miningClaimFormatFixture(identity);
 const make=(setup:boolean)=>{
  const blockhash=Keypair.generate().publicKey.toBase58(),plan=buildMiningClaimMessages(identity,{wallet:f.signer.publicKey,sequence:1n,day:1n,root:Buffer.from(f.preparation.root,'hex'),totalCumulative:80n,leaf:{wallet:f.identity.wallet,sequence:1n,cumulativeKeep:80n,cumulativeRenown:1n,cumulativeDays:1n},proof:[],blockhash,needsAta:setup,needsMinerRecords:setup},format),claimId=crypto.randomUUID();
  return MiningClaimPreparationViewSchema.parse({...f.preparation,version:2,idempotencyKey:crypto.randomUUID(),claimId,quoteId:claimId,format,needsAta:setup,needsMinerRecords:setup,
   fees:{feeLamports:setup?'10000':'5000',rentLamports:setup?'10000':'0',totalLamports:setup?'20000':'5000',payerBalanceLamports:'1000000'},
   transactions:plan.transactions.map((t,ordinal)=>({ordinal,kind:t.kind,version:'v0',message:Buffer.from(t.messageBytes).toString('base64'),lookupTables:[format.lookupTable],feePayer:f.identity.wallet,blockhash,lastValidBlockHeight:250,feeLamports:'5000',rentLamports:t.kind==='setup'?'10000':'0'}))});
 };
 const preparation=make(true),trust={...f.trust,orderedLookupTable:format.expectedLookupTable};
 const signed=(ordinal:number,p=preparation)=>{const tx=new VersionedTransaction(MessageV0.deserialize(Buffer.from(p.transactions[ordinal]!.message,'base64')));tx.sign([f.signer]);return {ordinal,wire:Buffer.from(tx.serialize()).toString('base64'),signature:bs58.encode(tx.signatures[0]!)};};
 const hash=(v:string)=>Buffer.from(sha256(Buffer.from(v,'base64'))).toString('hex');
 const setup={claimId:preparation.claimId,signature:signed(0).signature,slot:110,observedAccountSlot:115,messageSha256:hash(preparation.transactions[0]!.message),wireSha256:hash(signed(0).wire)};
 const claim=(landings:('pending'|'finalized'|'failed')[]=[],retained:number[]=[])=>{
  const transactions=preparation.transactions.map((t,i)=>{const terminal=!!landings[i]&&landings[i]!=='pending';return {ordinal:i,kind:t.kind,signature:terminal||retained.includes(i)?signed(i).signature:null,landing:landings[i]??'pending',settledBaseUnits:landings[i]==='finalized'?(t.kind==='setup'?'0':'80'):null,acceptedAt:terminal||retained.includes(i)?preparation.serverNow:null,settledAt:terminal?preparation.serverNow:null};});
  const paid=transactions.find(t=>t.kind==='claim'&&t.landing==='finalized'),failed=transactions.filter(t=>t.signature).every(t=>t.landing!=='pending')?transactions.filter(t=>t.landing==='failed').at(-1):undefined,last=paid??failed??transactions.filter(t=>t.signature).at(-1);
  return MiningClaimViewSchema.parse({version:1,wallet:preparation.wallet,claimId:preparation.claimId,state:paid?'settled':failed?'failed':last?'retained':'prepared',landing:paid?'finalized':failed?'failed':'pending',signature:last?.signature??null,settledBaseUnits:paid?.settledBaseUnits??null,transactions,serverNow:preparation.serverNow,claimSubmissionAuthorized:false});
 };
 const review=(ordinal:number):MiningClaimReview=>({version:1,wallet:preparation.wallet,claimId:preparation.claimId,ordinal,status:'ready',messageSha256:hash(preparation.transactions[ordinal]!.message),blockhash:preparation.transactions[ordinal]!.blockhash,preparedAt:preparation.preparedAt,expiresAt:preparation.expiresAt,observedAt:preparation.serverNow,snapshotSlot:120,blockHeight:200,lastValidBlockHeight:250,setup:ordinal===1?setup:null,currentSigningAuthorized:false,relayAuthorized:false,settlementAuthorized:false});
 const continuation=():MiningClaimContinuation=>{const child=make(false);return {version:1,wallet:preparation.wallet,parentClaimId:preparation.claimId,childClaimId:child.claimId,reason:'unsigned-expired',parentPreparation:preparation,childPreparation:child,setup,failure:null,expiry:{blockHeight:251,slot:120},createdAt:child.preparedAt,currentSigningAuthorized:false,relayAuthorized:false,settlementAuthorized:false,journalClearingAuthorized:false};};
 return {...f,preparation,trust,signed,claim,review,continuation,make,status:()=>({...f.status(),features:{claims:{version:1 as const,receipts:1 as const,ordered:1 as const}}})};
}
