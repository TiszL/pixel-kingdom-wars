import { createHash } from 'node:crypto';
import { ComputeBudgetProgram, Ed25519Program, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { expect,it,vi } from 'vitest';
import { PHASE_E_CHARTER_PREPARATION } from '@shardkeep/shared';
import { buildCharterCreationPacket,verifyCharterCreationPacket,createCharterCreationQuoteReader,verifyCharterCreationQuote } from './charterCreationPreparation';
import { charterClanIdBytes,hashCharterMetadata } from './charterProtocol';
import { preparationFixture,registrationKeys,lookupFixture,candidateFor,sign,digest } from './testFixtures/charterPreparation';
const fail=(code:string)=>expect.objectContaining({code});
const borshString=(s:string)=>{const b=Buffer.from(s),n=Buffer.alloc(4);n.writeUInt32LE(b.length);return Buffer.concat([n,b]);};
it('builds the actual three-instruction v0 registration with one payer and exactly18 canonical metas',()=>{
 const f=preparationFixture(),p=buildCharterCreationPacket(f.input),tx=VersionedTransaction.deserialize(Buffer.from(p.unsignedTransactionHex,'hex'));
 expect(tx.version).toBe(0);expect(tx.signatures).toHaveLength(1);expect(tx.signatures[0]).toEqual(new Uint8Array(64));expect(p.packetBytes).toBeLessThanOrEqual(1232);
 expect(Buffer.from(tx.message.serialize()).toString('hex')).toBe(p.messageHex);expect(p.messageSha256).toBe(digest(tx.message.serialize()));
 const decoded=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:[f.lookup.table()]});expect(decoded.payerKey.toBase58()).toBe(f.original.payer);
 expect(decoded.instructions).toHaveLength(3);expect(decoded.instructions[0]).toEqual(ComputeBudgetProgram.setComputeUnitLimit({units:PHASE_E_CHARTER_PREPARATION.computeUnitLimit}));
 expect(decoded.instructions[1]).toEqual(Ed25519Program.createInstructionWithPublicKey({publicKey:f.policy.publicKey.toBytes(),message:f.candidate,signature:f.input.policySignature!}));
 const register=decoded.instructions[2]!;expect(register.programId.toBase58()).toBe(f.original.chain.economyProgram);expect(register.keys).toEqual(registrationKeys(f.original,f.candidate));
 const permit=Buffer.alloc(26);Buffer.from(f.candidate.subarray(73,89)).copy(permit);permit.writeBigInt64LE(f.candidate.readBigInt64LE(121),16);permit.writeUInt16LE(1,24);
 expect(register.data).toEqual(Buffer.concat([createHash('sha256').update('global:register_charter').digest().subarray(0,8),charterClanIdBytes(f.original.clanId),charterClanIdBytes(f.original.creationIntentId),
  Buffer.from(f.original.admissionCommitment,'hex'),borshString(f.original.metadata.name),borshString(f.original.metadata.uri),permit]));
 expect(verifyCharterCreationPacket(f.input,p)).toEqual(p);expect(Object.isFrozen(p)).toBe(true);
});
it('permits only the native signature region to differ between reviewed template and prepared message',()=>{
 const f=preparationFixture(),template=buildCharterCreationPacket({...f.input,policySignature:null}),ready=buildCharterCreationPacket(f.input);
 const t=TransactionMessage.decompile(VersionedTransaction.deserialize(Buffer.from(template.unsignedTransactionHex,'hex')).message,{addressLookupTableAccounts:[f.lookup.table()]});
 const r=TransactionMessage.decompile(VersionedTransaction.deserialize(Buffer.from(ready.unsignedTransactionHex,'hex')).message,{addressLookupTableAccounts:[f.lookup.table()]});
 expect(template.packetBytes).toBe(ready.packetBytes);const bytes=Buffer.from(r.instructions[1]!.data);bytes.fill(0,48,112);
 expect(bytes).toEqual(t.instructions[1]!.data);expect(r.instructions[0]).toEqual(t.instructions[0]);expect(r.instructions[2]).toEqual(t.instructions[2]);
});
it('cryptographically rejects wrong keys, changed full161-byte messages and malformed signatures',()=>{
 const f=preparationFixture();buildCharterCreationPacket(f.input);
 for(const mode of ['key','signature','message','short','zero']){const b=Buffer.from(f.candidate);let sig:Buffer=Buffer.from(f.input.policySignature!);if(mode==='message'){const other=Buffer.from(b);other[73]=other[73]!^1;sig=sign(f.policy,other);}if(mode==='signature')sig[0]=sig[0]!^1;
  expect(()=>buildCharterCreationPacket({...f.input,candidate:b,policySigner:mode==='key'?Keypair.generate().publicKey.toBase58():f.input.policySigner,
   policySignature:mode==='short'?sig.subarray(1):mode==='zero'?Buffer.alloc(64):sig})).toThrow(fail('SIGNATURE'));}
});
it('recomputes original UUID halves, metadata and every domain identity instead of trusting hashes',()=>{
 const f=preparationFixture();buildCharterCreationPacket(f.input);
 for(const mode of ['clan','intent','payer','metadata','domain','commitment']){const o=JSON.parse(JSON.stringify(f.original)) as {clanId:string;creationIntentId:string;payer:string;metadata:{name:string;uri:string;hash:string};chain:typeof f.original.chain;admissionCommitment:string};
  if(mode==='clan')o.clanId='12345678-1234-5678-9abc-def012345679';if(mode==='intent')o.creationIntentId='87654321-4321-4321-8abc-def012345679';
  if(mode==='payer')o.payer=Keypair.generate().publicKey.toBase58();if(mode==='metadata')o.metadata.name+='X';if(mode==='domain')o.chain={...o.chain,genesisHash:Keypair.generate().publicKey.toBase58()};if(mode==='commitment')o.admissionCommitment='ee'.repeat(32);
  expect(()=>buildCharterCreationPacket({...f.input,original:o})).toThrow(fail('IDENTITY'));}
});
it('rejects damaged v0 instructions, indexes, blockhashes and trailing or extra-signature wire',()=>{
 const f=preparationFixture(),p=buildCharterCreationPacket(f.input);
 for(const mode of ['index','extra','payer','blockhash','trailing','signature']){const t=TransactionMessage.decompile(VersionedTransaction.deserialize(Buffer.from(p.unsignedTransactionHex,'hex')).message,{addressLookupTableAccounts:[f.lookup.table()]});
  if(mode==='index')t.instructions.reverse();if(mode==='extra')t.instructions.push(new TransactionInstruction({programId:Keypair.generate().publicKey,keys:[],data:Buffer.alloc(0)}));
  if(mode==='payer')t.payerKey=Keypair.generate().publicKey;if(mode==='blockhash')t.recentBlockhash=Keypair.generate().publicKey.toBase58();
  const tx=new VersionedTransaction(t.compileToV0Message([f.lookup.table()]));if(mode==='signature')tx.signatures[0]=new Uint8Array(64).fill(1);
  const wire=Buffer.concat([Buffer.from(tx.serialize()),mode==='trailing'?Buffer.of(0):Buffer.alloc(0)]);
  expect(()=>verifyCharterCreationPacket(f.input,{...p,unsignedTransactionHex:wire.toString('hex')})).toThrow(fail('PACKET'));}
});
it('requires pinned raw frozen and activated ALT contents including owner and complete byte identity',()=>{
 for(const mode of ['pin','owner','executable','authority','deactivated','not-active','truncated','index','duplicate']){const f=preparationFixture();buildCharterCreationPacket(f.input);const row={...f.input.lookupTable},data=Buffer.from(row.dataHex,'hex');
  if(mode==='pin')row.address=Keypair.generate().publicKey.toBase58();if(mode==='owner')row.owner=Keypair.generate().publicKey.toBase58();if(mode==='executable')row.executable=true;
  if(mode==='authority')data[21]=1;if(mode==='deactivated')data.writeBigUInt64LE(149n,4);if(mode==='not-active')data.writeBigUInt64LE(150n,12);
  if(mode==='index')data[20]=255;if(mode==='duplicate')data.subarray(56,88).copy(data,88);
  row.dataHex=(mode==='truncated'?data.subarray(1):data).toString('hex');
  expect(()=>buildCharterCreationPacket({...f.input,lookupTable:row,expectedLookupTable:{...f.lookup.pin,dataSha256:mode==='pin'?f.lookup.pin.dataSha256:digest(Buffer.from(row.dataHex,'hex'))}})).toThrow(fail('LOOKUP'));}
});
it('refuses stale blockhash horizons and oversize consent without truncation or a legacy fallback',()=>{
 const f=preparationFixture();buildCharterCreationPacket(f.input);
 for(const patch of [{currentBlockHeight:301},{blockhashSlot:99},{blockhash:PublicKey.default.toBase58()},{lastValidBlockHeight:NaN}])expect(()=>buildCharterCreationPacket({...f.input,...patch})).toThrow(fail('BLOCKHASH'));
 const metadata={name:'X'.repeat(64),uri:'u'.repeat(512)};const original={...f.original,metadata:{...metadata,hash:hashCharterMetadata(metadata).toString('hex')}};
 const candidate=candidateFor(original),lookup=lookupFixture(original,candidate);
 expect(()=>buildCharterCreationPacket({...f.input,original,candidate,policySignature:sign(f.policy,candidate),lookupTable:lookup.row,expectedLookupTable:lookup.pin})).toThrow(fail('PACKET'));
});
it('quotes exact five allocations plus pinned Core create fee against the actual v0 fee message',async()=>{
 const f=preparationFixture(),q=await createCharterCreationQuoteReader(f.connect,f.options)(f.original,f.candidate);
 const lengths=[280,90,154,107,137+Buffer.byteLength(f.original.metadata.name)+Buffer.byteLength(f.original.metadata.uri)];
 expect(q.costs.allocations.map(a=>a.bytes)).toEqual(lengths);expect(vi.mocked(f.rpc.getMinimumBalanceForRentExemption).mock.calls.map(c=>c[0])).toEqual(lengths);
 expect(q.costs.coreCreateFeeLamports).toBe(BigInt(PHASE_E_CHARTER_PREPARATION.coreCreateFeeLamports));expect(q.costs.networkFeeLamports).toBe(10000n);
 expect(q.costs.totalLamports).toBe(q.costs.networkFeeLamports+q.costs.rentLamports+q.costs.coreCreateFeeLamports);
 const message=vi.mocked(f.rpc.getFeeForMessage).mock.calls[0]![0];expect(message.version).toBe(0);expect(Buffer.from(message.serialize()).toString('hex')).toBe(q.template.messageHex);
 expect(f.get('asset').data.length).toBe(lengths[4]);expect(q.coreCostProfile).toEqual(f.options.coreCostProfile);
});
it('rejects unsupported seqSome and mismatched operator cost-profile deployment mappings',async()=>{
 for(const mode of ['hash','profile','version']){const f=preparationFixture();const profile={...f.options.coreCostProfile};if(mode==='hash')profile.reviewedProgramDataSha256='11'.repeat(32);
  if(mode==='profile')Object.assign(profile,{profile:'mpl-core-seq-some'});if(mode==='version')Object.assign(profile,{version:2});
  await expect(async()=>createCharterCreationQuoteReader(f.connect,{...f.options,coreCostProfile:profile})(f.original,f.candidate)).rejects.toMatchObject({code:'COST_PROFILE'});}
});
it('rejects null, unsafe, over-cap and expired quote observations without replacing the message',async()=>{
 for(const mode of ['null','unsafe','fee-cap','rent-cap','total-cap','height','fee-slot']){const f=preparationFixture();
  if(mode==='null'||mode==='unsafe'||mode==='fee-cap')f.rpc.getFeeForMessage=vi.fn(async()=>({context:{slot:150},value:mode==='null'?null:mode==='unsafe'?Number.MAX_SAFE_INTEGER+1:100001}));
  if(mode==='fee-slot')f.rpc.getFeeForMessage=vi.fn(async()=>({context:{slot:149},value:10000}));if(mode==='height')f.rpc.getBlockHeight=vi.fn(async()=>301);
  const options={...f.options,costLimits:{...f.options.costLimits,...mode==='rent-cap'?{maxRentLamports:1n}:{},...mode==='total-cap'?{maxTotalLamports:1n}:{}}};
  await expect(createCharterCreationQuoteReader(f.connect,options)(f.original,f.candidate)).rejects.toMatchObject({code:mode==='height'?'BLOCKHASH':'COST'});}
});
it('copies trust caps and ALT bytes across awaits and returns detached immutable artifacts',async()=>{
 const f=preparationFixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),arrived=new Promise<void>(r=>entered=r);
 f.rpc.getBlockHeight=vi.fn(async()=>{entered();await gate;return 200;});const read=createCharterCreationQuoteReader(f.connect,f.options),pending=read(f.original,f.candidate);
 await Promise.race([arrived,pending.then(()=>{throw Error('Quote did not reach final height observation');})]);
 Object.assign(f.options.costLimits,{maxTotalLamports:1n});f.lookup.data.fill(0);release();const q=await pending;
 expect(q.packetInput.lookupTable.dataHex).not.toBe(f.lookup.data.toString('hex'));expect(q.costs.totalLamports).toBeGreaterThan(1n);expect(Object.isFrozen(q.costs.allocations)).toBe(true);
});
it('enforces original expiry and one total deadline while ignored providers retain all eight slots',async()=>{
 const expired=preparationFixture(),candidate=candidateFor(expired.original,1_800_000_010n);
 await expect(createCharterCreationQuoteReader(expired.connect,expired.options)(expired.original,candidate)).rejects.toMatchObject({code:'EXPIRED'});
 vi.useFakeTimers();const f=preparationFixture();let release!:()=>void,entered!:()=>void,count=0;
 const wait=new Promise<void>(r=>release=r),arrived=new Promise<void>(r=>entered=r);
 f.rpc.getFeeForMessage=vi.fn(async()=>{if(++count===PHASE_E_CHARTER_PREPARATION.maxPending)entered();await wait;return {context:{slot:150},value:10000};});
 const read=createCharterCreationQuoteReader(f.connect,f.options);
 const pending=Array.from({length:PHASE_E_CHARTER_PREPARATION.maxPending},()=>read(f.original,f.candidate).then(value=>({ok:true as const,value}),error=>({ok:false as const,error})));
 try{
  await Promise.race([arrived,Promise.race(pending).then(r=>{if(!r.ok)throw r.error;throw Error('Quote escaped the intended provider wait');})]);
  await vi.advanceTimersByTimeAsync(PHASE_E_CHARTER_PREPARATION.timeoutMs+1);
  for(const result of await Promise.all(pending))expect(result).toMatchObject({ok:false,error:{code:'DEADLINE'}});
  await expect(read(f.original,f.candidate)).rejects.toMatchObject({code:'BUSY'});
  expect(f.rpc.getFeeForMessage).toHaveBeenCalledTimes(PHASE_E_CHARTER_PREPARATION.maxPending);expect(f.rpc.getBlockHeight).not.toHaveBeenCalled();
  release();await vi.advanceTimersByTimeAsync(0);expect(f.rpc.getBlockHeight).not.toHaveBeenCalled();
 }finally{release();await Promise.all(pending);vi.useRealTimers();}
});

it('validates retained quote history offline with closed fields, canonical decimals and immutable cost/context bindings',async()=>{
 const f=preparationFixture(),original=await createCharterCreationQuoteReader(f.connect,f.options)(f.original,f.candidate);
 const json=()=>JSON.parse(JSON.stringify(original,(_key,value)=>typeof value==='bigint'?value.toString():value));
 const saved=json(),restored=verifyCharterCreationQuote(saved),calls=f.connect.mock.calls.length;
 expect(restored).toEqual(original);expect(verifyCharterCreationQuote(original)).toEqual(original);
 saved.costLimits.maxTotalLamports='1';saved.packetInput.lookupTable.dataHex='00';
 expect(restored.costLimits.maxTotalLamports).toBe(f.options.costLimits.maxTotalLamports);
 expect(Object.isFrozen(restored.context)).toBe(true);expect(Object.isFrozen(restored.packetInput.original.chain)).toBe(true);
 for(const mode of ['extra','decimal','total','allocation','profile','template','clock','signer','fee-slot','closing-slot','closing-genesis','cap']){
  const bad=json();let code='COST';
  if(mode==='extra'){bad.callerVerified=true;code='INPUT';}
  if(mode==='decimal')bad.costs.networkFeeLamports='010000';
  if(mode==='total')bad.costs.totalLamports=(BigInt(bad.costs.totalLamports)+1n).toString();
  if(mode==='allocation')bad.costs.allocations[0].address=f.original.chain.asset;
  if(mode==='profile'){bad.coreCostProfile.reviewedProgramDataSha256='11'.repeat(32);code='COST_PROFILE';}
  if(mode==='template'){bad.template.unsignedTransactionHex+='00';code='PACKET';}
  if(mode==='clock'){bad.observation.unixTimestamp='1800000550';code='EXPIRED';}
  if(mode==='signer'){bad.observation.authority.currentPolicyKey=Keypair.generate().publicKey.toBase58();code='IDENTITY';}
  if(mode==='fee-slot')bad.context.feeSlot=149;
  if(mode==='closing-slot')bad.context.closingSlot=149;
  if(mode==='closing-genesis')bad.context.closingGenesisHash=Keypair.generate().publicKey.toBase58();
  if(mode==='cap')bad.costLimits.maxTotalLamports='1';
  expect(()=>verifyCharterCreationQuote(bad),mode).toThrow(fail(code));
 }
 expect(f.connect).toHaveBeenCalledTimes(calls);
});
