/** Synthetic same-bank delivery boundary; actual DB/Core flow is separate. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {afterEach,expect,it,vi} from 'vitest';
import {preparedLock} from '../../../packages/chain/src/testFixtures/charterLock';
import {verifyCharterLockSignedWire} from '@shardkeep/chain/charter-lock-wire';
import {createCharterTournamentDelivery,type CharterTournamentDeliveryOptions} from '../src/game/clanCharterTournamentDelivery';
import type {TournamentOperationState} from '../src/db/charterTournaments';
afterEach(()=>{vi.unstubAllEnvs();});
async function fixture(){
 vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');vi.stubEnv('MULTI_BASE_ENABLED','true');const f=await preparedLock(),wire=verifyCharterLockSignedWire({intentBytes:Buffer.from(f.packet.messageHex,'hex'),signedTransaction:f.wire,leader:f.leader.publicKey});
 const state={version:1,original:f.original,status:'signed',entryId:randomUUID(),operationTerms:{},attempt:{id:randomUUID(),candidateHex:f.quote.packetInput.candidateHex,policySigner:f.policy.publicKey.toBase58(),quote:f.quote},preparation:{policySignatureHex:f.packetInput.policySignatureHex,packet:f.packet},signed:{signedTransactionHex:f.wire.toString('hex'),signature:wire.signature,wireSha256:wire.wireSha256,messageSha256:wire.messageSha256},terminal:null,inventory:{version:1,revision:'1',count:1,messages:[f.quote.packetInput.candidateHex]}} as TournamentOperationState;
 const send=vi.fn(async()=>wire.signature),statuses=vi.fn(async()=>({context:{slot:150},value:[null]})),rpc={...f.rpc,getSignatureStatuses:statuses,sendRawTransaction:send},read=vi.fn(async()=>structuredClone(state));
 const options:CharterTournamentDeliveryOptions={connect:()=>rpc,trust:f.trust,expectedCurrentSigner:f.policy.publicKey.toBase58(),lookupTable:f.lookup.pin};
 return {...f,state,send,statuses,rpc,read,options,deliver:createCharterTournamentDelivery(read,options)};
}
it('sends only the retained leader-approved bytes with finalized preflight and exact retries',async()=>{
 const f=await fixture(),id=f.original.operation.id;
 for(let n=0;n<2;n++)expect(await f.deliver(f.original.operation.leader,id)).toMatchObject({status:'submitted',signature:f.state.signed!.signature,entryAuthorized:false,fenceReleaseAuthorized:false});
 expect(f.send).toHaveBeenCalledTimes(2);
 for(const args of f.send.mock.calls as unknown as [Uint8Array,unknown][]){expect(Buffer.from(args[0])).toEqual(f.wire);expect(args[1]).toEqual({skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:150});}
});
it.each(['pin','genesis','expiry','alt','fee','rent','height','registry','pause'] as const)('holds %s before delivery without changing the original or exposing an alternative',async kind=>{
 const f=await fixture(),snapshot=structuredClone(f.state);let options=f.options;
 if(kind==='pin')options={...options,expectedCurrentSigner:Keypair.generate().publicKey.toBase58()};
 if(kind==='genesis')f.rpc.getGenesisHash=async()=>Keypair.generate().publicKey.toBase58();
 if(kind==='expiry')f.rows.find(r=>r.data.length===40)!.data.writeBigInt64LE(Buffer.from(f.state.attempt!.candidateHex,'hex').readBigInt64LE(121),32);
 if(kind==='alt')f.lookup.data[60]=f.lookup.data[60]!^1;
 if(kind==='fee')f.rpc.getFeeForMessage=async()=>({context:{slot:150},value:10001});
 if(kind==='rent')f.rpc.getMinimumBalanceForRentExemption=async()=>100000;
 if(kind==='height')f.rpc.getBlockHeight=async()=>Number.MAX_SAFE_INTEGER;
 if(kind==='registry')f.get('charter').data.writeUInt32LE(10,153);
 if(kind==='pause')vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');
 const result=await createCharterTournamentDelivery(f.read,options)(f.original.operation.leader,f.original.operation.id);
 expect(result.status).toBe('held');expect(f.send).not.toHaveBeenCalled();expect(f.state).toEqual(snapshot);
});
it('retains uncertain send and observed transaction errors as original unresolved outcomes',async()=>{
 const f=await fixture(),snapshot=structuredClone(f.state);f.send.mockRejectedValueOnce(Error('reply lost after send'));
 expect(await f.deliver(f.original.operation.leader,f.original.operation.id)).toMatchObject({status:'held',reason:'SEND_UNCERTAIN'});expect(f.state).toEqual(snapshot);
 f.statuses.mockResolvedValueOnce({context:{slot:150},value:[{slot:149,confirmations:null,err:{InstructionError:[2,'Custom']},confirmationStatus:'finalized'}]} as never);
 expect(await createCharterTournamentDelivery(f.read,f.options)(f.original.operation.leader,f.original.operation.id)).toMatchObject({status:'held',reason:'FINALIZED_ERROR_UNVERIFIED'});expect(f.send).toHaveBeenCalledTimes(1);
});
it('rereads terminal before send and recovers terminal history with providers absent while paused',async()=>{
 const f=await fixture(),done={...structuredClone(f.state),status:'completed',terminal:{id:randomUUID(),outcome:'completed',record:{}}} as TournamentOperationState;
 f.read.mockResolvedValueOnce(f.state).mockResolvedValueOnce(done);
 expect(await f.deliver(f.original.operation.leader,f.original.operation.id)).toMatchObject({status:'terminal'});expect(f.send).not.toHaveBeenCalled();
 vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');expect(await createCharterTournamentDelivery(async()=>done,null)(f.original.operation.leader,f.original.operation.id)).toMatchObject({status:'terminal'});
});
