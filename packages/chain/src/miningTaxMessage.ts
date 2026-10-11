/** Pure unsigned original-spot tax planning. Supplied snapshot facts are checked
 * expectations, not a capability: callers must independently obtain fresh trusted
 * finality and admission. Neither a fabricated object nor this plan grants it. */
import {createHash} from 'node:crypto';
import {Message,PACKET_DATA_SIZE,PublicKey,SystemProgram,TransactionMessage,VersionedTransaction,type TransactionInstruction} from '@solana/web3.js';
import {ACCOUNT_SIZE,ASSOCIATED_TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {PHASE_E_MINING_PUBLICATION as P,PHASE_E_POLICY,TOKEN} from '@shardkeep/shared';
import type {MiningBackingTrust} from './miningBackingSnapshot';
import type {MiningTaxSnapshot} from './miningTaxSnapshot';
import {miningConfigPda,miningEpochPda,miningLiabilityFloor} from './miningProgramProtocol';
import {seekerAuctionConfigPda,seekerAuctionPda,seekerRegistryPda,seekerTermPda} from './seekerAuctionProtocol';
import {buildClaimMiningTaxInstruction,buildOpenMiningTaxPoolInstruction,buildOpenMiningTaxSpotInstruction,buildAccrueMiningTaxInstruction,hashMiningTermTaxIdentity,hashMiningTaxCommitment,miningTermTaxPoolPda,miningTaxSpotCursorPda,miningTaxEpochReceiptPda,MINING_TAX_ACCOUNT_BYTES,type MiningTaxTermIdentity} from './miningTaxProtocol';
const U64=(1n<<64n)-1n;
type Code='INPUT'|'IDENTITY'|'SNAPSHOT'|'PAUSED'|'BACKING'|'NOTHING_TO_CLAIM'|'PACKET'|'QUOTE'|'COST_CAP'|'INSUFFICIENT_SOL';
export class MiningTaxMessageError extends Error{constructor(readonly code:Code){super(`Mining tax message refused: ${code}`);this.name='MiningTaxMessageError';}}
function need(v:unknown,code:Code='INPUT'):asserts v{if(!v)throw new MiningTaxMessageError(code);}
function exact(v:unknown,names:string){need(v&&typeof v==='object'&&!Array.isArray(v));const fields=names.split(' '),keys=Reflect.ownKeys(v);need(fields.length===keys.length&&keys.every(k=>typeof k==='string'&&fields.includes(k)));}
function u64(v:unknown):asserts v is bigint{need(typeof v==='bigint'&&v>=0n&&v<=U64);}
function uint(v:unknown):asserts v is number{need(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0);}
function key(v:PublicKey):PublicKey{need(v instanceof PublicKey);return new PublicKey(v.toBytes());}
function address(v:string):PublicKey{need(typeof v==='string'&&v.length>=32&&v.length<=44);const p=new PublicKey(v);need(p.toBase58()===v);return p;}
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const digest=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
export interface MiningTaxMessageInput{readonly wallet:PublicKey;readonly round:bigint;readonly spot:number;readonly blockhash:string}
export interface MiningTaxNewAccount{readonly address:string;readonly space:number}
export interface MiningTaxUnsignedTransaction{readonly kind:'combined'|'setup'|'claim';readonly messageBytes:Uint8Array;readonly messageSha256:string;readonly packetBytes:number;readonly expectedNewAccounts:readonly Readonly<MiningTaxNewAccount>[]}
export interface MiningTaxMessages{readonly mode:'combined'|'split';readonly wallet:string;readonly term:string;readonly round:bigint;readonly spot:number;readonly snapshotSlot:number;readonly expectedClaimBaseUnits:bigint;readonly cumulativeBaseUnits:bigint;readonly dustBaseUnits:bigint;readonly accrualDays:readonly bigint[];readonly payerBalanceLamports:bigint;readonly transactions:readonly MiningTaxUnsignedTransaction[];readonly signingAuthorized:false;readonly broadcastAuthorized:false}

export function buildMiningTaxMessages(trust:MiningBackingTrust,snapshot:MiningTaxSnapshot,input:MiningTaxMessageInput):MiningTaxMessages{
 try{
  exact(trust,'programId keepMint reserveOwner expectedGenesisHash reviewedDeploymentSlot reviewedProgramDataSha256');exact(input,'wallet round spot blockhash');
  exact(snapshot,'wallet spot term slot backing pool cursor epochs entitlement claimantAta payer chainClock claimsPaused source claimsAuthorized signingAuthorized');
  const wallet=key(input.wallet),program=key(trust.programId),mint=key(trust.keepMint),reserveOwner=key(trust.reserveOwner),config=miningConfigPda(program),blockhash=address(input.blockhash).toBase58();
  need(PublicKey.isOnCurve(wallet.toBytes())&&!wallet.equals(PublicKey.default));u64(input.round);uint(input.spot);need(input.spot<PHASE_E_POLICY.seekerIsland.totalSpots);uint(trust.reviewedDeploymentSlot);need(digest(trust.reviewedProgramDataSha256));address(trust.expectedGenesisHash);
  uint(snapshot.slot);need(snapshot.slot>=trust.reviewedDeploymentSlot&&snapshot.wallet===wallet.toBase58()&&snapshot.spot===input.spot,'IDENTITY');
  const t=snapshot.term,b=snapshot.backing,c=b.config,pool=snapshot.pool,cursor=snapshot.cursor,now=snapshot.chainClock.unixTimestamp;u64(now);
  need(snapshot.chainClock.slot===snapshot.slot&&b.slot===snapshot.slot&&b.unixTimestamp===now&&b.chainDay===now/BigInt(P.daySec)&&snapshot.claimsAuthorized===false&&snapshot.signingAuthorized===false,'SNAPSHOT');
  for(const source of [snapshot.source,b.source])need(source.trust==='trusted-finalized-rpc-reviewed-program'&&source.programId===program.toBase58()&&source.genesisHash===trust.expectedGenesisHash&&source.reviewedDeploymentSlot===trust.reviewedDeploymentSlot&&source.reviewedProgramDataSha256===trust.reviewedProgramDataSha256,'IDENTITY');
  need(t.source.programId===program.toBase58()&&t.source.genesisHash===trust.expectedGenesisHash&&t.source.round===input.round&&t.deployment.deployedSlot===BigInt(trust.reviewedDeploymentSlot)&&t.deployment.programDataSha256===trust.reviewedProgramDataSha256&&t.operatingAdmissionAuthorized===false,'IDENTITY');
  const auctionConfig=seekerAuctionConfigPda(program),termKey=seekerTermPda(program,auctionConfig,input.round),registry=seekerRegistryPda(program),auction=seekerAuctionPda(program,auctionConfig,input.spot,input.round);
  need(t.source.config===auctionConfig.toBase58()&&t.term===termKey.toBase58()&&t.registry===registry.toBase58()&&digest(t.registryHash),'IDENTITY');
  need(Array.isArray(t.auctions)&&t.auctions.length===PHASE_E_POLICY.seekerIsland.totalSpots,'SNAPSHOT');
  need(t.auctions.every((a,i)=>a.terms.spotId===i)&&t.auctions.filter(a=>a.winner!==null).length===t.winnerCount&&t.winnerCount>0&&t.auctions[input.spot]!.winner===wallet.toBase58()&&t.auctions[input.spot]!.terms.auction===auction.toBase58(),'IDENTITY');
  u64(t.completedAt);u64(t.completedSlot);need(t.completedAt>=t.auctionEnd&&t.completedAt<=now&&t.completedSlot>BigInt(trust.reviewedDeploymentSlot)&&t.completedSlot<=BigInt(snapshot.slot)&&t.finality.commitment==='finalized'&&t.finality.contextSlot<=BigInt(snapshot.slot),'SNAPSHOT');
  const term:MiningTaxTermIdentity={programId:program,config,keepMint:mint,auctionConfig,term:termKey,registry,registryHash:Buffer.from(t.registryHash,'hex'),round:input.round,auctionStart:t.auctionStart,auctionEnd:t.auctionEnd,operatingStart:t.operatingStart,operatingEnd:t.operatingEnd,winnerCount:t.winnerCount};
  const termHash=Buffer.from(hashMiningTermTaxIdentity(term)).toString('hex'),poolKey=miningTermTaxPoolPda(program,termKey),cursorKey=miningTaxSpotCursorPda(program,poolKey,input.spot),ata=getAssociatedTokenAddressSync(mint,wallet),vault=getAssociatedTokenAddressSync(mint,config,true),reserve=getAssociatedTokenAddressSync(mint,reserveOwner,true);
  // No merged account role may turn a read-only program/mint into the payer or
  // redirect a transfer. Reserve-owner claimant is valid; reserve is not a CPI role.
  const roles=[wallet,program,mint,config,auctionConfig,registry,termKey,poolKey,cursorKey,auction,ata,vault,SystemProgram.programId,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID].map(k=>k.toBase58());need(new Set(roles).size===roles.length,'IDENTITY');
  need(c.address===config.toBase58()&&c.keepMint===mint.toBase58()&&c.miningVault===vault.toBase58()&&c.emissionReserveOwner===reserveOwner.toBase58()&&c.emissionReserveAta===reserve.toBase58(),'IDENTITY');
  uint(c.flags);need(c.flags<=255);need(typeof snapshot.claimsPaused==='boolean'&&snapshot.claimsPaused===((c.flags&1)!==0),'SNAPSHOT');need(!snapshot.claimsPaused,'PAUSED');
  for(const n of [b.vaultAmount,b.playerOutstanding,b.taxOutstanding,b.totalOutstanding,c.taxHighwater,c.taxPaid,c.totalPublishedHighwater,c.totalClaimed])u64(n);
  need(b.totalOutstanding===miningLiabilityFloor(c)&&b.playerOutstanding===c.totalPublishedHighwater-c.totalClaimed&&b.taxOutstanding===c.taxHighwater-c.taxPaid&&b.vaultAmount>=b.totalOutstanding,'BACKING');
  need(snapshot.payer.address===wallet.toBase58()&&snapshot.payer.exists===true&&snapshot.payer.lamports!==null,'SNAPSHOT');u64(snapshot.payer.lamports);
  need(snapshot.claimantAta.address===ata.toBase58()&&typeof snapshot.claimantAta.exists==='boolean','IDENTITY');
  if(snapshot.claimantAta.exists)u64(snapshot.claimantAta.balanceBaseUnits);else need(snapshot.claimantAta.balanceBaseUnits===null,'SNAPSHOT');
  let accrued=0n,paid=0n,claimed=0n;
  if(pool){u64(pool.accrued);u64(pool.paid);need(pool.version===2&&pool.distributionVersion===1&&pool.address===poolKey.toBase58()&&pool.config===config.toBase58()&&pool.term===termKey.toBase58()&&pool.termIdentity===termHash&&pool.winnerCount===t.winnerCount&&pool.paid<=pool.accrued&&pool.accrued<=c.taxHighwater&&pool.paid<=c.taxPaid,'SNAPSHOT');accrued=pool.accrued;paid=pool.paid;}
  else need(cursor===null&&snapshot.entitlement===null,'SNAPSHOT');
  if(cursor){u64(cursor.claimedTotal);need(pool&&cursor.version===2&&cursor.address===cursorKey.toBase58()&&cursor.pool===poolKey.toBase58()&&cursor.auction===auction.toBase58()&&cursor.wallet===wallet.toBase58()&&cursor.spot===input.spot&&cursor.claimedTotal<=paid&&cursor.claimedTotal<=accrued/BigInt(t.winnerCount),'SNAPSHOT');claimed=cursor.claimedTotal;}
  if(pool)need(snapshot.entitlement&&snapshot.entitlement.cumulative===accrued/BigInt(t.winnerCount)&&snapshot.entitlement.claimed===claimed&&snapshot.entitlement.available===accrued/BigInt(t.winnerCount)-claimed&&snapshot.entitlement.dust===accrued%BigInt(t.winnerCount),'SNAPSHOT');
  const daySec=BigInt(P.daySec),expectedDays:bigint[]=[];for(let day=(t.operatingStart+daySec-1n)/daySec;day<t.operatingEnd/daySec;day++)if(day>0n&&day*daySec>=t.completedAt)expectedDays.push(day);
  need(Array.isArray(snapshot.epochs)&&snapshot.epochs.length===expectedDays.length&&expectedDays.length<=Math.ceil(PHASE_E_POLICY.seekerIsland.operatingTermSec/P.daySec),'SNAPSHOT');
  let recorded=0n,newTax=0n;const accrualDays:bigint[]=[];
  for(const [i,row] of snapshot.epochs.entries()){
   need(row.day===expectedDays[i],'SNAPSHOT');const e=row.epoch,a=row.accrual;if(e===null){need(a===null,'SNAPSHOT');continue;}
   u64(e.tax);u64(e.fundedAt);const epoch=miningEpochPda(program,row.day),receipt=miningTaxEpochReceiptPda(program,epoch);
   need(e.version===1&&e.config===config.toBase58()&&e.address===epoch.toBase58()&&e.day===row.day&&e.taxVersion===2&&digest(e.sourceHash)&&e.sourceHash!=='00'.repeat(32)&&e.taxCommitment===Buffer.from(hashMiningTaxCommitment(term,{day:row.day,epoch})).toString('hex')&&e.fundedAt>=(row.day+1n)*daySec&&e.fundedAt<=now,'SNAPSHOT');
   for(const n of [e.budgetGross,e.freeGross,e.deedGross,e.playerNet,e.recycle])u64(n);uint(e.splitStart);uint(e.splitEnd);
   const gross=e.freeGross+e.deedGross,free=e.budgetGross*BigInt(PHASE_E_POLICY.mining.freePoolBps)/BigInt(PHASE_E_POLICY.basisPoints);
   need(e.day>=c.genesisDay&&e.day<=c.latestDay&&e.budgetGross>0n&&e.budgetGross<=BigInt(PHASE_E_POLICY.mining.grossDailyCeilingKeep)*10n**BigInt(TOKEN.decimals)&&e.freeGross<=free&&e.deedGross<=e.budgetGross-free&&gross<=e.budgetGross&&e.splitStart<P.splitPeriod&&e.splitEnd<P.splitPeriod,'SNAPSHOT');
   const cycles=gross/BigInt(P.splitPeriod),tail=Number(gross%BigInt(P.splitPeriod));let player=cycles*BigInt(P.splitPlayerUnits),recycle=cycles*BigInt(P.splitRecycleUnits),tax=cycles*BigInt(P.splitTaxUnits);
   for(let offset=0;offset<tail;offset++){const at=(e.splitStart+offset)%P.splitPeriod;if(at<P.splitPlayerUnits)player++;else if(at<P.splitPlayerUnits+P.splitRecycleUnits)recycle++;else tax++;}
   need(e.playerNet===player&&e.recycle===recycle&&e.tax===tax&&e.splitEnd===(e.splitStart+tail)%P.splitPeriod,'SNAPSHOT');
   if(a){u64(a.amount);u64(a.accruedAt);need(pool&&a.version===2&&a.address===receipt.toBase58()&&a.config===config.toBase58()&&a.pool===poolKey.toBase58()&&a.epoch===epoch.toBase58()&&a.amount===e.tax&&a.accruedAt>=e.fundedAt+BigInt(P.claimDelaySec)&&a.accruedAt<=now,'SNAPSHOT');recorded+=a.amount;}
   else if(e.tax>0n&&now>=e.fundedAt+BigInt(P.claimDelaySec)){newTax+=e.tax;accrualDays.push(row.day);}
  }
  need(recorded===accrued,'SNAPSHOT');const finalAccrued=accrued+newTax,cumulative=finalAccrued/BigInt(t.winnerCount),amount=cumulative-claimed;
  need(finalAccrued<=c.taxHighwater&&paid<=accrued/BigInt(t.winnerCount)*BigInt(t.winnerCount)&&amount<=b.taxOutstanding&&paid+amount<=finalAccrued,'BACKING');need(amount>0n,'NOTHING_TO_CLAIM');
  need(snapshot.claimantAta.balanceBaseUnits===null||snapshot.claimantAta.balanceBaseUnits+amount<=U64,'BACKING');
  const setup:TransactionInstruction[]=[],accounts:MiningTaxNewAccount[]=[];
  if(!snapshot.claimantAta.exists){setup.push(createAssociatedTokenAccountIdempotentInstruction(wallet,ata,wallet,mint));accounts.push({address:ata.toBase58(),space:ACCOUNT_SIZE});}
  if(!pool){setup.push(buildOpenMiningTaxPoolInstruction(term,{payer:wallet}));accounts.push({address:poolKey.toBase58(),space:MINING_TAX_ACCOUNT_BYTES.MiningTaxPool});}
  for(const day of accrualDays){setup.push(buildAccrueMiningTaxInstruction(term,{payer:wallet,day}));accounts.push({address:miningTaxEpochReceiptPda(program,miningEpochPda(program,day)).toBase58(),space:MINING_TAX_ACCOUNT_BYTES.MiningTaxAccrual});}
  if(!cursor){setup.push(buildOpenMiningTaxSpotInstruction(term,{payer:wallet,spot:input.spot}));accounts.push({address:cursorKey.toBase58(),space:MINING_TAX_ACCOUNT_BYTES.MiningTaxSpot});}
  const claim=buildClaimMiningTaxInstruction(term,{claimant:wallet,spot:input.spot});
  const serialize=(kind:MiningTaxUnsignedTransaction['kind'],instructions:TransactionInstruction[],newAccounts:MiningTaxNewAccount[]):MiningTaxUnsignedTransaction=>{
   try{const message=new TransactionMessage({payerKey:wallet,recentBlockhash:blockhash,instructions}).compileToLegacyMessage();need(message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0&&message.accountKeys[0]!.equals(wallet),'IDENTITY');const bytes=Uint8Array.from(message.serialize());need(Buffer.from(Message.from(bytes).serialize()).equals(Buffer.from(bytes)),'PACKET');const packetBytes=new VersionedTransaction(message).serialize().length;return Object.freeze({kind,get messageBytes(){return Uint8Array.from(bytes);},messageSha256:sha(bytes),packetBytes,expectedNewAccounts:Object.freeze(newAccounts.map(a=>Object.freeze({...a})))});}catch(e){if(e instanceof MiningTaxMessageError)throw e;throw new MiningTaxMessageError('PACKET');}
  };
  const claimOnly=serialize('claim',[claim],[]),combined=setup.length?serialize('combined',[...setup,claim],accounts):claimOnly;let transactions=[combined],mode:MiningTaxMessages['mode']='combined';
  if(combined.packetBytes>PACKET_DATA_SIZE){mode='split';transactions=[serialize('setup',setup,accounts),claimOnly];}
  need(transactions.every(t=>t.packetBytes<=PACKET_DATA_SIZE),'PACKET');
  return Object.freeze({mode,wallet:wallet.toBase58(),term:termKey.toBase58(),round:input.round,spot:input.spot,snapshotSlot:snapshot.slot,expectedClaimBaseUnits:amount,cumulativeBaseUnits:cumulative,dustBaseUnits:finalAccrued%BigInt(t.winnerCount),accrualDays:Object.freeze(accrualDays),payerBalanceLamports:snapshot.payer.lamports,transactions:Object.freeze(transactions),signingAuthorized:false,broadcastAuthorized:false});
 }catch(e){if(e instanceof MiningTaxMessageError)throw e;throw new MiningTaxMessageError('INPUT');}
}
export interface MiningTaxCostQuote{readonly messageSha256:string;readonly feeLamports:bigint;readonly rents:readonly Readonly<MiningTaxNewAccount&{lamports:bigint}>[]}
export interface MiningTaxCostCaps{readonly maxFeeLamports:bigint;readonly maxRentLamports:bigint;readonly maxTotalLamports:bigint}
/** Arithmetic and consent limits only. Quote values must come from an independent
 * finalized RPC; matching these hashes does not authenticate that provider. */
export function quoteMiningTaxMessageCosts(plan:MiningTaxMessages,quotes:readonly MiningTaxCostQuote[],caps:MiningTaxCostCaps){
 try{
  exact(caps,'maxFeeLamports maxRentLamports maxTotalLamports');for(const n of Object.values(caps))u64(n);u64(plan.payerBalanceLamports);
  need(Array.isArray(plan.transactions)&&plan.transactions.length>0&&plan.transactions.length<=2&&Array.isArray(quotes)&&quotes.length===plan.transactions.length,'QUOTE');
  let fees=0n,rents=0n;const seen=new Set<string>();
  const transactions=plan.transactions.map((tx,i)=>{
   const q=quotes[i]!;exact(q,'messageSha256 feeLamports rents');need(digest(tx.messageSha256)&&q.messageSha256===tx.messageSha256&&!seen.has(q.messageSha256),'QUOTE');seen.add(q.messageSha256);u64(q.feeLamports);
   need(Array.isArray(tx.expectedNewAccounts)&&tx.expectedNewAccounts.length<=10&&Array.isArray(q.rents)&&q.rents.length===tx.expectedNewAccounts.length,'QUOTE');
   const addresses=new Set<string>();let rent=0n;
   q.rents.forEach((r:Readonly<MiningTaxNewAccount&{lamports:bigint}>,n:number)=>{exact(r,'address space lamports');const a=tx.expectedNewAccounts[n]!;need(r.address===a.address&&r.space===a.space&&!addresses.has(r.address),'QUOTE');addresses.add(r.address);u64(r.lamports);rent+=r.lamports;});
   fees+=q.feeLamports;rents+=rent;need(fees<=U64&&rents<=U64&&fees+rents<=U64,'QUOTE');return Object.freeze({messageSha256:q.messageSha256,feeLamports:q.feeLamports,rentLamports:rent,totalLamports:q.feeLamports+rent});
  });
  need(fees<=caps.maxFeeLamports&&rents<=caps.maxRentLamports&&fees+rents<=caps.maxTotalLamports,'COST_CAP');need(fees+rents<=plan.payerBalanceLamports,'INSUFFICIENT_SOL');
  return Object.freeze({feeLamports:fees,rentLamports:rents,totalLamports:fees+rents,transactions:Object.freeze(transactions),signingAuthorized:false as const,broadcastAuthorized:false as const});
 }catch(e){if(e instanceof MiningTaxMessageError)throw e;throw new MiningTaxMessageError('QUOTE');}
}
