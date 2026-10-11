/** Exact generated claimant wire with finalized, rolled-back execution evidence. */
import {AccountLayout} from '@solana/spl-token';
import {createMiningClaimReceiptFixture} from './miningClaimReceipt';

export async function createMiningClaimFailureFixture(kind:'combined'|'claim'|'setup'='combined'){
 const f=await createMiningClaimReceiptFixture(kind);
 f.tx.meta!.err={InstructionError:[f.message.instructions.length-1,{Custom:6000}]};
 f.tx.meta!.postBalances=[...f.tx.meta!.preBalances];f.tx.meta!.postBalances[0]=f.tx.meta!.postBalances[0]!-f.tx.meta!.fee;
 f.tx.meta!.postTokenBalances=f.tx.meta!.preTokenBalances!.map(b=>({...b,uiTokenAmount:{...b.uiTokenAmount}}));
 f.state.backing.model.total_claimed=0n;f.state.root.claims_count=0n;
 f.state.miner.claimed_total=0n;f.state.miner.last_sequence=0n;f.state.miner.last_claim_at=0n;
 f.state.renown.last_sequence=0n;f.state.renown.synced_at=0n;
 const vault=f.state.rows[1]!,token=AccountLayout.decode(Buffer.from(vault.data));AccountLayout.encode({...token,amount:100n},Buffer.from(vault.data.buffer,vault.data.byteOffset,vault.data.byteLength));
 await f.state.backing.config();await f.state.encodeRoot();await f.state.records();
 if(kind!=='claim'){f.state.rows[10]=null;f.state.rows[11]=null;f.state.rows[12]=null;}
 else{const ata=f.state.rows[12]!,t=AccountLayout.decode(Buffer.from(ata.data));AccountLayout.encode({...t,amount:0n},Buffer.from(ata.data.buffer,ata.data.byteOffset,ata.data.byteLength));}
 return f;
}
