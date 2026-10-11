/** D153.190 KEEP market payment foundation only. No custody, DB
 * grant, expiry/nonpayment proof, signature consumption or release authority.
 * Memo is an exact reservation string, NOT a Solana Pay account reference. */
import {createHash,createPublicKey,verify} from 'node:crypto';
import {ComputeBudgetProgram,SystemProgram,Message,MessageV0,PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import {ACCOUNT_SIZE,ASSOCIATED_TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,createTransferCheckedInstruction,createBurnCheckedInstruction,createAssociatedTokenAccountIdempotentInstruction,createInitializeImmutableOwnerInstruction,createInitializeAccount3Instruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {PHASE_E_POLICY,TOKEN,PHASE_E_KEEP_EQUIPMENT_MARKET as POLICY} from '@shardkeep/shared';
import bs58 from 'bs58';
const MEMO=new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),U64=(1n<<64n)-1n;
export class KeepEquipmentPaymentError extends Error{
 readonly fenceReleaseAuthorized=false;readonly unpaidProven=false;
 constructor(readonly code:string){super('KEEP equipment payment held: '+code);this.name='KeepEquipmentPaymentError';}
}
function need(value:unknown,code:string):asserts value{if(!value)throw new KeepEquipmentPaymentError(code);}
const safe=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function key(v:string){need(typeof v==='string'&&v.length>=32&&v.length<=44,'INPUT');const p=new PublicKey(v);need(p.toBase58()===v,'INPUT');return p;}
export interface KeepEquipmentPaymentOriginal{
 readonly reservationId:string;readonly buyer:string;readonly seller:string;readonly keepMint:string;readonly totalBaseUnits:bigint;
 /** False freezes willingness to create the canonical ATA; its rent cap is
  * reviewed before signing. The verifier never interprets excess rent as unpaid. */
 readonly sellerAtaExists:boolean;readonly sellerAtaRentCapLamports?:bigint;
}
export interface KeepEquipmentPaymentLimits{
 readonly maxFeeLamports:bigint;readonly maxPriorityFeeLamports:bigint;readonly maxComputeUnitLimit:number;
}
export interface KeepEquipmentComputeBudget{readonly units:number;readonly microLamports?:bigint}
function limits(input:KeepEquipmentPaymentLimits){
 need(input&&typeof input==='object'&&typeof input.maxFeeLamports==='bigint'&&input.maxFeeLamports>=0n&&input.maxFeeLamports<=U64
  &&typeof input.maxPriorityFeeLamports==='bigint'&&input.maxPriorityFeeLamports>=0n&&input.maxPriorityFeeLamports<=input.maxFeeLamports
  &&safe(input.maxComputeUnitLimit)&&input.maxComputeUnitLimit>0&&input.maxComputeUnitLimit<=1_400_000,'INPUT');
 return {...input};
}
function original(input:KeepEquipmentPaymentOriginal){
 need(input&&typeof input==='object'&&typeof input.reservationId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.reservationId),'INPUT');
 need(input.sellerAtaExists===true?input.sellerAtaRentCapLamports===undefined:input.sellerAtaExists===false&&typeof input.sellerAtaRentCapLamports==='bigint'&&input.sellerAtaRentCapLamports>0n&&input.sellerAtaRentCapLamports<=BigInt(Number.MAX_SAFE_INTEGER),'ATA_RENT_CONSENT');
 const buyer=key(input.buyer),seller=key(input.seller),mint=key(input.keepMint);
 need(PublicKey.isOnCurve(buyer.toBytes())&&PublicKey.isOnCurve(seller.toBytes())&&!buyer.equals(seller),'INPUT');
 need(typeof input.totalBaseUnits==='bigint'&&input.totalBaseUnits>=POLICY.minFillBaseUnits&&input.totalBaseUnits<=U64,'AMOUNT');
 const total=input.totalBaseUnits,sellerAmount=total*BigInt(PHASE_E_POLICY.taxes.keepMarket.sellerBps)/BigInt(PHASE_E_POLICY.basisPoints),burnAmount=total-sellerAmount;
 need(sellerAmount>0n&&burnAmount>0n&&sellerAmount+burnAmount===total,'AMOUNT');
 const buyerAta=getAssociatedTokenAddressSync(mint,buyer),sellerAta=getAssociatedTokenAddressSync(mint,seller);
 need(new Set([buyer,seller,mint,buyerAta,sellerAta,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,SystemProgram.programId,MEMO,ComputeBudgetProgram.programId].map(p=>p.toBase58())).size===10,'INPUT');
 return {reservationId:input.reservationId,buyer,seller,mint,buyerAta,sellerAta,total,sellerAmount,burnAmount,createSellerAta:!input.sellerAtaExists,rentCap:input.sellerAtaRentCapLamports??0n,memo:`pkw:keep-market:${input.reservationId}`};
}
export function buildKeepEquipmentPaymentInstructions(input:KeepEquipmentPaymentOriginal,inputLimits:KeepEquipmentPaymentLimits,compute?:KeepEquipmentComputeBudget){
 const o=original(input),l=limits(inputLimits),instructions:TransactionInstruction[]=[];
 if(compute){
  need(safe(compute.units)&&compute.units>0&&compute.units<=l.maxComputeUnitLimit,'COMPUTE');
  instructions.push(ComputeBudgetProgram.setComputeUnitLimit({units:compute.units}));
  if(compute.microLamports!==undefined){need(typeof compute.microLamports==='bigint'&&compute.microLamports>=0n&&compute.microLamports<=U64,'COMPUTE');
   need((BigInt(compute.units)*compute.microLamports+999_999n)/1_000_000n<=l.maxPriorityFeeLamports,'COMPUTE');
   instructions.push(ComputeBudgetProgram.setComputeUnitPrice({microLamports:compute.microLamports}));}
 }
 if(o.createSellerAta)instructions.push(createAssociatedTokenAccountIdempotentInstruction(o.buyer,o.sellerAta,o.seller,o.mint,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID));
 instructions.push(createTransferCheckedInstruction(o.buyerAta,o.mint,o.sellerAta,o.buyer,o.sellerAmount,TOKEN.decimals,[],TOKEN_PROGRAM_ID),
  createBurnCheckedInstruction(o.buyerAta,o.mint,o.buyer,o.burnAmount,TOKEN.decimals,[],TOKEN_PROGRAM_ID),
  new TransactionInstruction({programId:MEMO,keys:[],data:Buffer.from(o.memo,'utf8')}));
 return instructions;
}
export function buildKeepEquipmentPaymentMessage(input:KeepEquipmentPaymentOriginal,l:KeepEquipmentPaymentLimits,blockhash:string,version:'legacy'|0='legacy',compute?:KeepEquipmentComputeBudget){
 const o=original(input);need(version==='legacy'||version===0,'VERSION_UNSUPPORTED');key(blockhash);
 const plan=new TransactionMessage({payerKey:o.buyer,recentBlockhash:blockhash,instructions:buildKeepEquipmentPaymentInstructions(input,l,compute)});
 const message=version==='legacy'?plan.compileToLegacyMessage():plan.compileToV0Message();
 const bytes=message.serialize();need(new VersionedTransaction(message).serialize().length<=1232,'BOUNDS');
 return Object.freeze({reservationId:o.reservationId,buyerAta:o.buyerAta.toBase58(),sellerAta:o.sellerAta.toBase58(),sellerBaseUnits:o.sellerAmount.toString(),burnBaseUnits:o.burnAmount.toString(),totalBaseUnits:o.total.toString(),memo:o.memo,createsSellerAta:o.createSellerAta,sellerAtaRentCapLamports:o.rentCap.toString(),
  get messageBytes(){return Uint8Array.from(bytes);},messageSha256:digest(bytes),signingAuthorized:false as const,broadcastAuthorized:false as const});
}
/** Bounded copy reconstructs message bytes; never invokes an RPC object's
 * serialize() method. LUT resolution is part of independent provider agreement. */
function ownedTransaction(raw:VersionedTransactionResponse|null,signature:string){
 need(raw?.meta&&raw.transaction&&safe(raw.slot)&&raw.slot>0,'TRANSACTION_UNAVAILABLE');
 need(raw.version==='legacy'||raw.version===0,'VERSION_UNSUPPORTED');
 need(raw.meta.err===null,'FAILED');need(Array.isArray(raw.meta.innerInstructions),'TRACE_UNAVAILABLE');
 need(raw.meta.innerInstructions.length<=1,'INNER_UNSUPPORTED');
 const m=raw.transaction.message;
 need(m&&m.version===raw.version&&Array.isArray(m.staticAccountKeys)&&m.staticAccountKeys.length>0&&m.staticAccountKeys.length<=16,'BOUNDS');
 need(m.header.numRequiredSignatures===1&&m.header.numReadonlySignedAccounts===0&&safe(m.header.numReadonlyUnsignedAccounts)&&m.header.numReadonlyUnsignedAccounts<m.staticAccountKeys.length,'SIGNER');
 const index=(n:number)=>{need(Number.isInteger(n)&&n>=0&&n<=255,'BOUNDS');return n;};
 let message:Message|MessageV0;
 if(m.version===0){
  need(Array.isArray(m.compiledInstructions)&&m.compiledInstructions.length>=3&&m.compiledInstructions.length<=6&&Array.isArray(m.addressTableLookups)&&m.addressTableLookups.length<=2,'BOUNDS');
  message=new MessageV0({header:{...m.header},staticAccountKeys:m.staticAccountKeys.map(p=>new PublicKey(p.toBytes())),recentBlockhash:key(m.recentBlockhash).toBase58(),
   compiledInstructions:m.compiledInstructions.map(ix=>{need(ix.data instanceof Uint8Array&&ix.data.length<=128&&Array.isArray(ix.accountKeyIndexes)&&ix.accountKeyIndexes.length<=6,'BOUNDS');return {programIdIndex:index(ix.programIdIndex),accountKeyIndexes:ix.accountKeyIndexes.map(index),data:Uint8Array.from(ix.data)};}),
   addressTableLookups:m.addressTableLookups.map(t=>{need(Array.isArray(t.writableIndexes)&&Array.isArray(t.readonlyIndexes)&&t.writableIndexes.length+t.readonlyIndexes.length<=8,'BOUNDS');return {accountKey:new PublicKey(t.accountKey.toBytes()),writableIndexes:t.writableIndexes.map(index),readonlyIndexes:t.readonlyIndexes.map(index)};})});
 }else{
  need(Array.isArray(m.instructions)&&m.instructions.length>=3&&m.instructions.length<=6,'BOUNDS');
  message=new Message({header:{...m.header},accountKeys:m.accountKeys.map(p=>p.toBase58()),recentBlockhash:key(m.recentBlockhash).toBase58(),
   instructions:m.instructions.map(ix=>{need(typeof ix.data==='string'&&ix.data.length<=176&&Array.isArray(ix.accounts)&&ix.accounts.length<=6,'BOUNDS');const data=bs58.decode(ix.data);need(data.length<=128&&bs58.encode(data)===ix.data,'BOUNDS');return {programIdIndex:index(ix.programIdIndex),accounts:ix.accounts.map(index),data:ix.data};})});
 }
 const bytes=message.serialize();need(bytes.length+65<=1232,'BOUNDS');
 need(typeof signature==='string'&&signature.length>=64&&signature.length<=88,'SIGNATURE');const signed=bs58.decode(signature);need(signed.length===64&&bs58.encode(signed)===signature,'SIGNATURE');
 need(Array.isArray(raw.transaction.signatures)&&raw.transaction.signatures.length===1&&raw.transaction.signatures[0]===signature,'SIGNATURE');
 const payer=message.staticAccountKeys[0]!,pub=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),payer.toBuffer()]),format:'der',type:'spki'});
 need(verify(null,bytes,pub,signed),'SIGNATURE');
 const loaded=raw.meta.loadedAddresses??{writable:[],readonly:[]};need(Array.isArray(loaded.writable)&&Array.isArray(loaded.readonly)&&loaded.writable.length+loaded.readonly.length<=8,'BOUNDS');
 const expectedLoaded=message.version===0?message.addressTableLookups.reduce((n,t)=>({writable:n.writable+t.writableIndexes.length,readonly:n.readonly+t.readonlyIndexes.length}),{writable:0,readonly:0}):{writable:0,readonly:0};
 need(loaded.writable.length===expectedLoaded.writable&&loaded.readonly.length===expectedLoaded.readonly,'LOOKUP');
 const resolved={writable:loaded.writable.map(p=>new PublicKey(p.toBytes())),readonly:loaded.readonly.map(p=>new PublicKey(p.toBytes()))};
 const keys=[...message.staticAccountKeys,...resolved.writable,...resolved.readonly];need(keys.length<=16&&new Set(keys.map(k=>k.toBase58())).size===keys.length,'ACCOUNTS');
 for(const ix of message.compiledInstructions)need(ix.programIdIndex<keys.length&&ix.accountKeyIndexes.every(i=>i<keys.length),'ACCOUNTS');
 need(safe(raw.meta.fee),'FEE');
 return {message,bytes,keys,slot:raw.slot,fee:BigInt(raw.meta.fee),meta:raw.meta};
}
/** Instruction evidence alone claims no finality. The reader below owns the
 * finalized dual-provider requests and compares full relevant proof identity. */
export function verifyKeepEquipmentPaymentTransaction(raw:VersionedTransactionResponse|null,signature:string,input:KeepEquipmentPaymentOriginal,inputLimits:KeepEquipmentPaymentLimits){
 try{
  const o=original(input),l=limits(inputLimits),t=ownedTransaction(raw,signature),{message,keys}=t;
  need(keys[0]!.equals(o.buyer)&&t.fee<=l.maxFeeLamports,'PAYMENT');
  const compiled=message.compiledInstructions;let at=0,compute:KeepEquipmentComputeBudget|undefined;
  if(keys[compiled[0]!.programIdIndex]!.equals(ComputeBudgetProgram.programId)){
   const ix=compiled[at++]!,d=Buffer.from(ix.data);need(ix.accountKeyIndexes.length===0&&d.length===5&&d[0]===2,'COMPUTE');compute={units:d.readUInt32LE(1)};
   if(keys[compiled[at]!.programIdIndex]!.equals(ComputeBudgetProgram.programId)){const ix=compiled[at++]!,d=Buffer.from(ix.data);need(ix.accountKeyIndexes.length===0&&d.length===9&&d[0]===3,'COMPUTE');compute={...compute,microLamports:d.readBigUInt64LE(1)};}
  }
  const expected=buildKeepEquipmentPaymentInstructions(input,l,compute);need(expected.length===compiled.length,'INSTRUCTION');
  const required=new Map<string,{signer:boolean;writable:boolean}>();required.set(o.buyer.toBase58(),{signer:true,writable:true});
  for(const ix of expected){required.set(ix.programId.toBase58(),{signer:false,writable:false});for(const k of ix.keys){const prior=required.get(k.pubkey.toBase58());required.set(k.pubkey.toBase58(),{signer:k.isSigner||!!prior?.signer,writable:k.isWritable||!!prior?.writable});}}
  need(required.size===keys.length,'ACCOUNTS');
  for(const [i,k]of keys.entries()){const r=required.get(k.toBase58());need(r&&message.isAccountSigner(i)===r.signer&&message.isAccountWritable(i)===r.writable,'AUTHORITY');}
  for(const [i,ix]of compiled.entries()){const e=expected[i]!;need(keys[ix.programIdIndex]!.equals(e.programId)&&Buffer.from(ix.data).equals(e.data)&&ix.accountKeyIndexes.length===e.keys.length
   &&ix.accountKeyIndexes.every((idx,j)=>keys[idx]!.equals(e.keys[j]!.pubkey)),'INSTRUCTION');}
  const sellerIndex=keys.findIndex(k=>k.equals(o.sellerAta));
  const balances=(rows:typeof t.meta.preTokenBalances,allowAbsent=false)=>{
   need(Array.isArray(rows)&&(rows.length===2||(allowAbsent&&rows.length===1)),'TOKEN_BALANCE');
   return [o.buyerAta,o.sellerAta].map((ata,index)=>{const accountIndex=keys.findIndex(k=>k.equals(ata)),matched=rows.filter(r=>r.accountIndex===accountIndex);
    if(allowAbsent&&rows.length===1&&index===1){need(matched.length===0,'TOKEN_BALANCE');return 0n;}
    need(matched.length===1,'TOKEN_BALANCE');const b=matched[0]!;
    need(b.mint===o.mint.toBase58()&&b.owner===(index===0?o.buyer:o.seller).toBase58()&&b.programId===TOKEN_PROGRAM_ID.toBase58()&&b.uiTokenAmount.decimals===TOKEN.decimals&&typeof b.uiTokenAmount.amount==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(b.uiTokenAmount.amount),'TOKEN_BALANCE');const amount=BigInt(b.uiTokenAmount.amount);need(amount<=U64,'TOKEN_BALANCE');return amount;});
  };
  const pre=balances(t.meta.preTokenBalances,o.createSellerAta),post=balances(t.meta.postTokenBalances),created=o.createSellerAta&&t.meta.preTokenBalances!.length===1;
  need(pre[0]!>=o.total&&post[0]===pre[0]!-o.total&&post[1]===pre[1]!+o.sellerAmount,'TOKEN_BALANCE');
  need(Array.isArray(t.meta.preBalances)&&Array.isArray(t.meta.postBalances)&&t.meta.preBalances.length===keys.length&&t.meta.postBalances.length===keys.length,'LAMPORTS');
  need(t.meta.preBalances.every(safe)&&t.meta.postBalances.every(safe),'LAMPORTS');
  const sellerLamportsBefore=BigInt(t.meta.preBalances[sellerIndex]!),rent=BigInt(t.meta.postBalances[sellerIndex]!)-sellerLamportsBefore;
  need(rent>=0n&&rent<=o.rentCap&&(created||rent===0n),'ATA_RENT');
  for(let i=0;i<keys.length;i++)need(BigInt(t.meta.preBalances[i]!)-BigInt(t.meta.postBalances[i]!)===(i===0?t.fee+rent:i===sellerIndex?-rent:0n),'LAMPORTS');
  const trace=t.meta.innerInstructions!;
  // A CreateIdempotent race over an already valid ATA performs no CPI. A new
  // account has exactly this Classic SPL profile; no CPI may supply a payment leg.
  const innerEvidence:Array<{program:string;accounts:string[];data:string;stackHeight:number|null}>=[];
  if(!created)need(trace.length===0,'INNER_UNSUPPORTED');
  else{
   need(trace.length===1&&trace[0]!.index===at&&Array.isArray(trace[0]!.instructions),'ATA_TRACE');
   const expectedInner:TransactionInstruction[]=[new TransactionInstruction({programId:TOKEN_PROGRAM_ID,keys:[{pubkey:o.mint,isSigner:false,isWritable:false}],data:Buffer.from([21,7,0]) /* SPL GetAccountDataSize + ImmutableOwner */})];
   if(sellerLamportsBefore===0n){need(rent>0n,'ATA_RENT');expectedInner.push(SystemProgram.createAccount({fromPubkey:o.buyer,newAccountPubkey:o.sellerAta,lamports:Number(rent),space:ACCOUNT_SIZE,programId:TOKEN_PROGRAM_ID}));}
   else{
    if(rent>0n)expectedInner.push(SystemProgram.transfer({fromPubkey:o.buyer,toPubkey:o.sellerAta,lamports:rent}));
    expectedInner.push(SystemProgram.allocate({accountPubkey:o.sellerAta,space:ACCOUNT_SIZE}),SystemProgram.assign({accountPubkey:o.sellerAta,programId:TOKEN_PROGRAM_ID}));
   }
   expectedInner.push(createInitializeImmutableOwnerInstruction(o.sellerAta,TOKEN_PROGRAM_ID),createInitializeAccount3Instruction(o.sellerAta,o.mint,o.seller,TOKEN_PROGRAM_ID));
   need(trace[0]!.instructions.length===expectedInner.length,'ATA_TRACE');
   for(const [i,ix]of trace[0]!.instructions.entries()){
    const e=expectedInner[i]!,height='stackHeight'in ix?ix.stackHeight:undefined;
    need(safe(ix.programIdIndex)&&ix.programIdIndex<keys.length&&Array.isArray(ix.accounts)&&ix.accounts.length===e.keys.length&&ix.accounts.every(n=>safe(n)&&n<keys.length)
     &&typeof ix.data==='string'&&ix.data.length<=80&&height===2,'ATA_TRACE');
    const data=bs58.decode(ix.data);need(bs58.encode(data)===ix.data&&keys[ix.programIdIndex]!.equals(e.programId)&&data.length===e.data.length&&Buffer.from(data).equals(e.data)
     &&ix.accounts.every((n,j)=>keys[n]!.equals(e.keys[j]!.pubkey)),'ATA_TRACE');
    innerEvidence.push({program:e.programId.toBase58(),accounts:ix.accounts.map(n=>keys[n]!.toBase58()),data:ix.data,stackHeight:height===2?2:null});
   }
  }
  const proof={version:1 as const,signature,reservationId:o.reservationId,buyer:input.buyer,seller:input.seller,keepMint:input.keepMint,buyerAta:o.buyerAta.toBase58(),sellerAta:o.sellerAta.toBase58(),totalBaseUnits:o.total.toString(),sellerBaseUnits:o.sellerAmount.toString(),burnBaseUnits:o.burnAmount.toString(),slot:t.slot,feeLamports:t.fee.toString(),createsSellerAta:o.createSellerAta,sellerAtaCreated:created,sellerAtaRentCapLamports:o.rentCap.toString(),sellerAtaRentLamports:rent.toString(),innerInstructionsSha256:digest(Buffer.from(JSON.stringify(innerEvidence))),messageSha256:digest(t.bytes),resolvedKeys:keys.map(k=>k.toBase58()),tokenBefore:pre.map(String),tokenAfter:post.map(String),lamportsBefore:[...t.meta.preBalances],lamportsAfter:[...t.meta.postBalances]};
  return Object.freeze({...proof,evidenceSha256:digest(Buffer.from(JSON.stringify(proof))),fenceReleaseAuthorized:false as const,unpaidProven:false as const});
 }catch(error){if(error instanceof KeepEquipmentPaymentError)throw error;throw new KeepEquipmentPaymentError('MALFORMED');}
}
export interface KeepEquipmentPaymentRpc{
 getGenesisHash():Promise<string>;
 getSlot(commitment:'finalized'):Promise<number>;
 getTransaction(signature:string,options:{commitment:'finalized';maxSupportedTransactionVersion:0}):Promise<VersionedTransactionResponse|null>;
}
export interface KeepEquipmentPaymentTrust extends KeepEquipmentPaymentLimits{
 readonly expectedGenesisHash:string;readonly minContextSlot:number;readonly deadlineMs:number;
 readonly providerIds:readonly[string,string];
}
/** Application-owned connectors and original reservation loader only. Distinct
 * configured provider IDs represent operator-reviewed independent RPC services. */
export function createKeepEquipmentPaymentReader(connect:readonly[(signal:AbortSignal)=>KeepEquipmentPaymentRpc,(signal:AbortSignal)=>KeepEquipmentPaymentRpc],inputTrust:KeepEquipmentPaymentTrust){
 const l=limits(inputTrust),expectedGenesisHash=key(inputTrust.expectedGenesisHash).toBase58(),minContextSlot=inputTrust.minContextSlot,deadline=inputTrust.deadlineMs,providerIds=[...inputTrust.providerIds];
 need(connect.length===2&&connect.every(f=>typeof f==='function')&&providerIds.length===2&&providerIds.every(s=>typeof s==='string'&&s.length>0&&s.length<=128)&&providerIds[0]!==providerIds[1]
  &&safe(minContextSlot)&&safe(deadline)&&deadline>0&&deadline<=60_000,'INPUT');
 const connectors=[...connect];let pending=0;
 return async(input:KeepEquipmentPaymentOriginal,signature:string)=>{
  const saved={...input};original(saved);need(pending<4,'BUSY');pending++;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const check=()=>need(!controller.signal.aborted,'DEADLINE');
  const calls=connectors.map(async open=>{check();const rpc=open(controller.signal);const genesis=await rpc.getGenesisHash();check();need(genesis===expectedGenesisHash,'GENESIS');
   const raw=await rpc.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});check();const proof=verifyKeepEquipmentPaymentTransaction(raw,signature,saved,l);
   const finalizedSlot=await rpc.getSlot('finalized');check();need(safe(finalizedSlot)&&proof.slot>=minContextSlot&&finalizedSlot>=proof.slot,'FINALITY');
   need(await rpc.getGenesisHash()===expectedGenesisHash,'GENESIS');check();return proof;});const work=Promise.all(calls);
  // Retain the concurrency slot until both underlying calls settle, even if an
  // adapter ignores abort. A deadline never authorizes another spend/release.
  const settled=Promise.allSettled(calls);void settled.then(()=>{pending--;});
  try{const proofs=await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new KeepEquipmentPaymentError('DEADLINE'));},deadline);})]);
   need(proofs[0]!.evidenceSha256===proofs[1]!.evidenceSha256,'PROVIDER_MISMATCH');return Object.freeze({...proofs[0]!,expectedGenesisHash,providerIds:Object.freeze(providerIds),finalizedAgreement:true as const});
  }catch(error){if(error instanceof KeepEquipmentPaymentError)throw error;throw new KeepEquipmentPaymentError('UNAVAILABLE');}finally{if(timer)clearTimeout(timer);controller.abort();}
 };
}
