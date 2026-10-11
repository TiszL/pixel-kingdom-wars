import {Keypair,PublicKey,SystemProgram,VersionedTransaction} from '@solana/web3.js';
import {it,expect,vi} from 'vitest';
import {buildCharterRetirementInstruction,encodeCharterRetirementPayload,matchCharterRetirementReceipt,charterRetirementReceiptPda} from './charterRetirementProtocol';
import {buildCharterRetirementPacket,createCharterRetirementQuoter,verifyCharterRetirementQuote,retirementParts} from './charterRetirementPreparation';
import {verifyCharterRetirementSignedWire} from './charterRetirementWire';
import {createCharterRetirementReader} from './charterRetirementEvidence';
import {createCharterRetirementCancellationReader} from './charterRetirementCancellation';
import {seekerPermitReceiptPda} from './seekerAuctionProtocol';
import {retirementFixture,retirementCandidateHex,preparedRetirement,evidenceRetirement,retirementReceiptBytes} from './testFixtures/charterRetirement';
import {evidenceLock} from './testFixtures/charterLock';
import {createCharterLockEvidenceReader} from './charterLockEvidence';

it('pins a distinct permanent per-clan receipt and exact least-privilege retirement ABI',()=>{
 const f=retirementFixture(),{economy,craft,leader,terms}=retirementParts(f.original),permit={permitId:f.permitId,expiry:1800000050n,ed25519Instruction:1},ix=buildCharterRetirementInstruction(economy,craft,leader,terms,permit);
 expect(ix.keys).toHaveLength(16);expect(ix.keys.map((k,i)=>k.isWritable?i:-1).filter(i=>i>=0)).toEqual([0,3,5,6]);expect(ix.keys.filter(k=>k.isSigner).map(k=>k.pubkey.toBase58())).toEqual([leader.toBase58()]);
 expect(ix.data).toHaveLength(118);expect(ix.data.readUInt32LE(56)).toBe(0);expect(ix.data.subarray(60,92).toString('hex')).toBe(Buffer.from(terms.clearanceHash).toString('hex'));
 expect(encodeCharterRetirementPayload(economy,craft,leader,terms)).toHaveLength(446);
 expect(charterRetirementReceiptPda(economy,terms.clanId)).toEqual(f.retirementReceipt);
 const different={...terms,retirementId:'12345678-1234-4678-9abc-def012345689'};expect(buildCharterRetirementInstruction(economy,craft,leader,different,permit).keys[5]!.pubkey).toEqual(f.retirementReceipt);
 expect(()=>buildCharterRetirementInstruction(economy,craft,leader,{...terms,clearanceHash:Buffer.alloc(32)},permit)).toThrow();
 expect(()=>buildCharterRetirementInstruction(economy,craft,leader,{...terms,expectedRevision:0xffffffff},permit)).toThrow();
});

it('quotes both receipts with no royalty or reward debit and reconstructs exact terminal consent',async()=>{
 const f=retirementFixture(),q=await createCharterRetirementQuoter(f.connect,f.options)(f.original,f.permitId);
 expect(q.costs.allocations.map(r=>[r.kind,r.bytes])).toEqual([['retirement-receipt',250],['permit-receipt',107]]);expect(BigInt(q.costs.totalLamports)).toBe(BigInt(q.costs.networkFeeLamports)+BigInt(q.costs.rentLamports));
 expect(Buffer.from(q.packetInput.candidateHex,'hex')[72]).toBe(9);expect(q.retirementAuthorized).toBe(false);expect(verifyCharterRetirementQuote(JSON.parse(JSON.stringify(q)))).toEqual(q);
 const signed=f.sign(f.policy,Buffer.from(q.packetInput.candidateHex,'hex')).toString('hex');expect(buildCharterRetirementPacket({...q.packetInput,policySignatureHex:signed}).packetBytes).toBeLessThanOrEqual(1232);
 expect(()=>verifyCharterRetirementQuote({...q,costs:{...q.costs,allocations:q.costs.allocations.slice(1)}})).toThrow();
 expect(()=>buildCharterRetirementPacket({...q.packetInput,original:{...f.original,retirement:{...f.original.retirement,clearanceHash:'ef'.repeat(32)}},policySignatureHex:signed})).toThrow();
});

it.each(['retired','tournament','owner','revision','pause','craft-pause','receipt','program'] as const)('holds %s before preparing irreversible consent',async kind=>{
 const f=retirementFixture();if(kind==='retired')f.get('charter').data[157]=2;if(kind==='tournament')f.get('charter').data[158]=1;
 if(kind==='owner')f.get('asset').data[1]=f.get('asset').data[1]!^1;if(kind==='revision')f.get('charter').data.writeUInt32LE(3,153);if(kind==='pause')f.authorityData[147]=1;if(kind==='craft-pause')f.get('craftControl').data[137]=1;
 if(kind==='receipt')f.rows.push({address:f.retirementReceipt,owner:f.economy,executable:false,data:retirementReceiptBytes(f)});if(kind==='program')f.rows[1]!.data[45]=f.rows[1]!.data[45]!^1;
 await expect(createCharterRetirementQuoter(f.connect,f.options)(f.original,f.permitId)).rejects.toThrow();
});

it('owns the original clearance commitment before async RPC and refuses altered signed intent',async()=>{
 const f=retirementFixture(),original=structuredClone(f.original);let release!:(s:string)=>void;f.rpc.getGenesisHash=vi.fn().mockImplementationOnce(()=>new Promise<string>(r=>release=r)).mockResolvedValue(f.genesis.toBase58());
 const pending=createCharterRetirementQuoter(f.connect,f.options)(original,f.permitId);while(!release)await Promise.resolve();(original.retirement as {clearanceHash:string}).clearanceHash='ef'.repeat(32);release(f.genesis.toBase58());
 expect((await pending).packetInput.original.retirement.clearanceHash).toBe('cd'.repeat(32));
 const p=await preparedRetirement();expect(verifyCharterRetirementSignedWire({leader:p.leader.publicKey,intentBytes:Buffer.from(p.packet.messageHex,'hex'),signedTransaction:p.wire}).signature).toBeTruthy();
 expect(()=>verifyCharterRetirementSignedWire({leader:Keypair.generate().publicKey,intentBytes:Buffer.from(p.packet.messageHex,'hex'),signedTransaction:p.wire})).toThrow();
 const tx=VersionedTransaction.deserialize(p.wire);tx.message.compiledInstructions[2]!.data[60]=tx.message.compiledInstructions[2]!.data[60]!^1;tx.sign([p.leader]);expect(()=>verifyCharterRetirementSignedWire({leader:p.leader.publicKey,intentBytes:Buffer.from(p.packet.messageHex,'hex'),signedTransaction:tx.serialize()})).toThrow();
});

it('recovers exact finalized retirement from its permanent receipt even after the generic permit closes and admission pauses',async()=>{
 const f=await evidenceRetirement();expect(f.rows.some(r=>r.address.equals(f.receipt))).toBe(false);f.authorityData[147]=1;f.get('craftControl').data[137]=1;
 const result=await createCharterRetirementReader(f.connect,f.trust,async()=>f.savedRetirement)(f.original.retirement.id);
 expect(result).toMatchObject({retirementId:f.original.retirement.id,priorRevision:0,revision:1,currentStateMatchesResult:true,finalizedTransitionObserved:true,retirementAuthorized:false,fenceReleaseAuthorized:false,rentLamports:'3535',feeLamports:'10000'});
 expect(result.receipt.clearanceHash).toBe(f.original.retirement.clearanceHash);
});

it.each(['receipt-missing','receipt-owner','receipt-clearance','receipt-bump','nonterminal','changed-leader','failed-tx','fee','instruction','loaded'] as const)('rejects %s without completing dissolution',async kind=>{
 const f=await evidenceRetirement();if(kind==='receipt-missing')f.rows.splice(f.rows.findIndex(r=>r.address.equals(f.retirementReceipt)),1);
 if(kind==='receipt-owner')f.rows.find(r=>r.address.equals(f.retirementReceipt))!.owner=SystemProgram.programId;
 if(kind==='receipt-clearance')f.receiptData[193]=f.receiptData[193]!^1;if(kind==='receipt-bump')f.receiptData[249]=f.receiptData[249]!^1;if(kind==='nonterminal')f.get('charter').data[157]=1;
 if(kind==='changed-leader')Keypair.generate().publicKey.toBuffer().copy(f.get('charter').data,121);if(kind==='failed-tx')f.transaction.meta!.err={InstructionError:[2,'InvalidArgument']};if(kind==='fee')f.transaction.meta!.fee++;
 if(kind==='instruction')f.transaction.transaction.message.compiledInstructions[2]!.data[60]=f.transaction.transaction.message.compiledInstructions[2]!.data[60]!^1;if(kind==='loaded')f.transaction.meta!.loadedAddresses!.readonly.reverse();
 await expect(createCharterRetirementReader(f.connect,f.trust,async()=>f.savedRetirement)(f.original.retirement.id)).rejects.toThrow();
});

it('a retirement receipt cannot be replayed for a different clearance, permit or clan',()=>{
 const f=retirementFixture(),{economy,craft,leader,terms}=retirementParts(f.original),bytes=retirementReceiptBytes(f);
 expect(matchCharterRetirementReceipt(bytes,economy,craft,leader,terms,f.permitId).revision).toBe(1);
 expect(()=>matchCharterRetirementReceipt(bytes,economy,craft,leader,terms,Buffer.alloc(16,45))).toThrow();
 expect(()=>matchCharterRetirementReceipt(bytes,economy,craft,leader,{...terms,clearanceHash:Buffer.alloc(32,1)},f.permitId)).toThrow();
 expect(()=>matchCharterRetirementReceipt(bytes,economy,craft,leader,{...terms,clanId:'12345678-1234-4678-9abc-def012345688'},f.permitId)).toThrow();
});

it('cancels only after every original permit expires and both permanent and exposed receipts are absent',async()=>{
 const f=retirementFixture(),messages=[retirementCandidateHex(f,1800000009n)],load=async()=>({original:f.original,inventory:{version:1 as const,revision:'1',count:1,messages}});
 const read=createCharterRetirementCancellationReader(f.connect,f.trust,load);expect((await read(f.original.retirement.id)).source.accounts).toHaveLength(17);
 const prefund={address:f.retirementReceipt,owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0)};f.rows.push(prefund);expect((await read(f.original.retirement.id)).fenceReleaseAuthorized).toBe(false);
 f.rows.push({address:f.receipt,owner:f.economy,executable:false,data:Buffer.alloc(107)});await expect(read(f.original.retirement.id)).rejects.toMatchObject({code:'RECEIPT'});f.rows.pop();
 prefund.owner=f.economy;prefund.data=retirementReceiptBytes(f);await expect(read(f.original.retirement.id)).rejects.toMatchObject({code:'RECEIPT'});
});

it.each(['equal-expiry','missing-inventory','wrong-clan','retired','changed-revision'] as const)('holds %s cancellation even without a permit receipt',async kind=>{
 const f=retirementFixture(),messages=[retirementCandidateHex(f,kind==='equal-expiry'?1800000010n:1800000009n)];if(kind==='retired')f.get('charter').data[157]=2;if(kind==='changed-revision')f.get('charter').data.writeUInt32LE(1,153);
 const original=kind==='wrong-clan'?{...f.original,retirement:{...f.original.retirement,clanId:'12345678-1234-4678-9abc-def012345688'}}:f.original;
 await expect(createCharterRetirementCancellationReader(f.connect,f.trust,async()=>({original,inventory:{version:1,revision:'1',count:1,messages:kind==='missing-inventory'?[]:messages}}))(f.original.retirement.id)).rejects.toThrow();
});

it('retirement does not erase an earlier authenticated tournament transition',async()=>{
 const f=await evidenceLock();f.get('charter').data[157]=2;f.get('charter').data[158]=0;f.get('charter').data.fill(0,159,175);f.get('charter').data.writeUInt32LE(3,153);
 expect(await createCharterLockEvidenceReader(f.connect,f.trust,async()=>f.savedLock)(f.original.operation.id)).toMatchObject({finalizedTransitionObserved:true,currentStateMatchesResult:false,entryAuthorized:false});
});

it('refuses a second retirement candidate before RPC because renewal is not an admitted workflow',async()=>{
 const f=retirementFixture(),messages=[retirementCandidateHex(f,1800000008n),retirementCandidateHex(f,1800000009n,Buffer.alloc(16,45))];
 await expect(createCharterRetirementCancellationReader(f.connect,f.trust,async()=>({original:f.original,inventory:{version:1,revision:'2',count:2,messages}}))(f.original.retirement.id)).rejects.toMatchObject({code:'INVENTORY'});expect(f.connect).not.toHaveBeenCalled();
});
