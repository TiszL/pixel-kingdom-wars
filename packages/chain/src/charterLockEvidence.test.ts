import {Keypair} from '@solana/web3.js';
import {it,expect} from 'vitest';
import {createCharterLockEvidenceReader} from './charterLockEvidence';
import {evidenceLock} from './testFixtures/charterLock';
it('proves the exact finalized original transition with current match separate from historical proof',async()=>{const f=await evidenceLock(),read=createCharterLockEvidenceReader(f.connect,f.trust,async()=>f.savedLock);expect(await read(f.original.operation.id)).toMatchObject({finalizedTransitionObserved:true,currentStateMatchesResult:true,entryAuthorized:false,fenceReleaseAuthorized:false});f.get('charter').data.writeUInt32LE(5,153);f.get('charter').data[158]=0;f.get('charter').data.fill(0,159,175);expect(await read(f.original.operation.id)).toMatchObject({finalizedTransitionObserved:true,currentStateMatchesResult:false});});
it.each(['failed','signature','loaded','fee','deployment','slot'] as const)('rejects %s finalized evidence corruption',async kind=>{const f=await evidenceLock();if(kind==='failed')f.transaction.meta!.err={InstructionError:[2,'InvalidArgument']};if(kind==='signature')f.transaction.transaction.signatures[0]='1';if(kind==='loaded')f.transaction.meta!.loadedAddresses!.readonly.reverse();if(kind==='fee')f.transaction.meta!.fee++;if(kind==='deployment')f.rows[1]!.data[45]=f.rows[1]!.data[45]!^1;if(kind==='slot')f.transaction.slot=89;await expect(createCharterLockEvidenceReader(f.connect,f.trust,async()=>f.savedLock)(f.original.operation.id)).rejects.toThrow();});
it('recovers a clear transition and old set after a later sale without depending on closeable receipt presence',async()=>{
 const clear=await evidenceLock('clear');expect(await createCharterLockEvidenceReader(clear.connect,clear.trust,async()=>clear.savedLock)(clear.original.operation.id)).toMatchObject({action:'clear',revision:2,currentStateMatchesResult:true,entryAuthorized:false});
 const set=await evidenceLock(),newLeader=Keypair.generate().publicKey;newLeader.toBuffer().copy(set.get('charter').data,121);newLeader.toBuffer().copy(set.get('asset').data,1);set.get('charter').data.writeUInt32LE(3,153);set.get('charter').data[158]=0;set.get('charter').data.fill(0,159,175);
 expect(set.rows.some(r=>r.address.equals(set.receipt))).toBe(false);
 expect(await createCharterLockEvidenceReader(set.connect,set.trust,async()=>set.savedLock)(set.original.operation.id)).toMatchObject({finalizedTransitionObserved:true,currentStateMatchesResult:false,entryAuthorized:false,fenceReleaseAuthorized:false});
});
it('does not use a transport serialize method or accept unapproved transaction instructions',async()=>{
 const f=await evidenceLock();f.transaction.transaction.message.serialize=()=>{throw Error('must not execute RPC method');};
 expect((await createCharterLockEvidenceReader(f.connect,f.trust,async()=>f.savedLock)(f.original.operation.id)).finalizedTransitionObserved).toBe(true);
 f.transaction.transaction.message.compiledInstructions[2]!.data[0]=f.transaction.transaction.message.compiledInstructions[2]!.data[0]!^1;
 await expect(createCharterLockEvidenceReader(f.connect,f.trust,async()=>f.savedLock)(f.original.operation.id)).rejects.toThrow();
});
