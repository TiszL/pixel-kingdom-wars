import {SystemProgram} from '@solana/web3.js';
import {seekerPermitReceiptPda} from './seekerAuctionProtocol';
import {it,expect} from 'vitest';
import {createCharterLockCancellationReader} from './charterLockCancellation';
import {lockFixture,lockCandidateHex} from './testFixtures/charterLock';
it('requires complete expired inventory and original state even with pause and signer rotation',async()=>{const f=lockFixture(),messages=[lockCandidateHex(f,1800000009n)];f.authorityData[147]=1;f.get('craftControl').data[137]=1;const result=await createCharterLockCancellationReader(f.connect,f.trust,async()=>({original:f.original,inventory:{version:1,revision:'1',count:1,messages}}))(f.original.operation.id);expect(result.outcome).toBe('absent-after-expiry');expect(result.fenceReleaseAuthorized).toBe(false);});
it.each(['exact-expiry','missing-inventory','changed-revision','present-receipt'] as const)('holds %s, never authorizing absence-only cancellation',async kind=>{const f=lockFixture(),messages=[lockCandidateHex(f,kind==='exact-expiry'?1800000010n:1800000009n)];if(kind==='changed-revision')f.get('charter').data.writeUInt32LE(2,153);if(kind==='present-receipt')f.rows.push({address:f.receipt,owner:f.economy,executable:false,data:Buffer.alloc(107)});await expect(createCharterLockCancellationReader(f.connect,f.trust,async()=>({original:f.original,inventory:{version:1,revision:'1',count:1,messages:kind==='missing-inventory'?[]:messages}}))(f.original.operation.id)).rejects.toThrow();});
it('reads every exposed receipt in the same bank; a second consumed candidate prevents release',async()=>{
 const f=lockFixture(),second=Buffer.alloc(16,45),messages=[lockCandidateHex(f,1800000008n),lockCandidateHex(f,1800000009n,second)];
 const load=async()=>({original:f.original,inventory:{version:1 as const,revision:'2',count:2,messages}}),read=createCharterLockCancellationReader(f.connect,f.trust,load);
 expect((await read(f.original.operation.id)).source.accounts).toHaveLength(17);
 f.rows.push({address:seekerPermitReceiptPda(f.economy,second),owner:f.economy,executable:false,data:Buffer.alloc(107)});
 await expect(read(f.original.operation.id)).rejects.toMatchObject({code:'RECEIPT'});
});
it('allows never-issued clear cancellation only while the original tournament lock still matches',async()=>{
 const f=lockFixture('clear'),load=async()=>({original:f.original,inventory:{version:1 as const,revision:'0',count:0,messages:[]}}),read=createCharterLockCancellationReader(f.connect,f.trust,load);
 expect((await read(f.original.operation.id)).outcome).toBe('absent-after-expiry');f.get('charter').data[159]=f.get('charter').data[159]!^1;
 await expect(read(f.original.operation.id)).rejects.toMatchObject({code:'PROFILE'});
});
it('rejects duplicate exposure IDs and a Clock from beyond the account bank',async()=>{
 const f=lockFixture(),message=lockCandidateHex(f,1800000009n),bad=async()=>({original:f.original,inventory:{version:1 as const,revision:'2',count:2,messages:[message,message]}});
 await expect(createCharterLockCancellationReader(f.connect,f.trust,bad)(f.original.operation.id)).rejects.toThrow();expect(f.connect).not.toHaveBeenCalled();
 f.rows.find(r=>r.data.length===40)!.data.writeBigUInt64LE(151n);
 await expect(createCharterLockCancellationReader(f.connect,f.trust,async()=>({original:f.original,inventory:{version:1,revision:'1',count:1,messages:[message]}}))(f.original.operation.id)).rejects.toThrow();
});

it('a third-party prefunded empty System receipt cannot prevent strict expired cancellation',async()=>{
 const f=lockFixture();f.rows.push({address:f.receipt,owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0)});
 const messages=[lockCandidateHex(f,1800000009n)];
 expect(await createCharterLockCancellationReader(f.connect,f.trust,async()=>({original:f.original,inventory:{version:1,revision:'1',count:1,messages}}))(f.original.operation.id)).toMatchObject({outcome:'absent-after-expiry',entryAuthorized:false,fenceReleaseAuthorized:false});
 f.rows.find(r=>r.address.equals(f.receipt))!.data=Buffer.from([1]);
 await expect(createCharterLockCancellationReader(f.connect,f.trust,async()=>({original:f.original,inventory:{version:1,revision:'1',count:1,messages}}))(f.original.operation.id)).rejects.toMatchObject({code:'RECEIPT'});
});
