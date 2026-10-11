/** Work-bound safety: admitted children must remain readable. This is a mocked
 * ancestry traversal, not source/receipt authority or a claim execution fixture. */
import {expect,it,vi} from 'vitest';
import type {DbOrTx} from '../src/db/client';
import {getMiningClaimSigned,type MiningClaimSigned} from '../src/mining/claimSignedStore';
import {getMiningClaimSettlement,type MiningClaimSettlement} from '../src/mining/claimSettlement';
import {miningClaimSetup} from '../src/mining/claimContinuationStore';
vi.mock('../src/mining/claimSignedStore',()=>({getMiningClaimSigned:vi.fn()}));
vi.mock('../src/mining/claimSettlement',()=>({getMiningClaimSettlement:vi.fn()}));
it('reserves one ancestry position before accepting another child while preserving existing bounded history',async()=>{
 const nodes=Array.from({length:65},(_,i)=>({preparation:{claimId:String(i),wallet:'wallet',blockhash:String(i),header:{},leafHex:'leaf',proofHex:'proof',needsAta:false,needsMinerRecords:false,
  format:{preset:'ordered-v0',expectedLookupTable:{address:'table',dataSha256:'hash'}},transactions:i===0?[{kind:'setup'},{kind:'claim'}]:[{kind:'claim'}]},wires:[]}) as unknown as MiningClaimSigned);
 const receipt={receipt:{kind:'setup',paidKeepBaseUnits:'0'}} as MiningClaimSettlement;
 vi.mocked(getMiningClaimSettlement).mockResolvedValue(receipt);
 let next=0;const db={execute:async()=>[{parent_claim_id:String(next--),wallet:'wallet'}]} as unknown as DbOrTx;
 vi.mocked(getMiningClaimSigned).mockImplementation(async(_db,key)=>nodes[Number(key.claimId)]!);
 next=61;await expect(miningClaimSetup(db,nodes[62]!,true)).resolves.toBe(receipt);
 next=62;await expect(miningClaimSetup(db,nodes[63]!)).resolves.toBe(receipt);
 next=62;await expect(miningClaimSetup(db,nodes[63]!,true)).rejects.toThrow('MINING_CLAIM_CONTINUATION_BOUND');
 next=63;await expect(miningClaimSetup(db,nodes[64]!)).rejects.toThrow('MINING_CLAIM_CONTINUATION_BOUND');
});
