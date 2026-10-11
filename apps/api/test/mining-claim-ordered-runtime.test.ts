import {expect,it} from 'vitest';
import {PublicKey} from '@solana/web3.js';
import {MINING_PROGRAM_ADDRESS} from '@shardkeep/chain/mining-program';
import {loadConfig} from '../src/config';
import {createMiningClaimRuntime} from '../src/mining/claimRuntime';
import {TEST_CONFIG} from './helpers';
const pk=(n:number)=>new PublicKey(Buffer.alloc(32,n)).toBase58();
it('keeps ordered capability dark by default and validates/copies all independent runtime pins without a live read',()=>{
 const common={DATABASE_URL:TEST_CONFIG.DATABASE_URL,JWT_SECRET:TEST_CONFIG.JWT_SECRET,WEB_ORIGIN:TEST_CONFIG.WEB_ORIGIN[0],NODE_ENV:'test'},pins={MINING_CLAIM_PROGRAM_ID:MINING_PROGRAM_ADDRESS,MINING_CLAIM_DEPLOYMENT_SLOT:'90',MINING_CLAIM_PROGRAM_DATA_SHA256:'a'.repeat(64),GEMS_RESERVE_OWNER:pk(2),HOT_WALLET_PUBKEY:pk(3)},lookup={MINING_CLAIM_LOOKUP_TABLE:pk(4),MINING_CLAIM_LOOKUP_TABLE_SHA256:'b'.repeat(64)};
 expect(loadConfig(common).MINING_CLAIM_ORDERED_ENABLED).toBe('false');
 for(const missing of [...Object.keys(pins),...Object.keys(lookup)])expect(()=>loadConfig({...common,...pins,...lookup,MINING_CLAIM_ORDERED_ENABLED:'true',[missing]:undefined})).toThrow();
 const economy={cluster:'devnet' as const,keepMint:pk(1),coreProgram:pk(6),configPda:pk(7)},dark=createMiningClaimRuntime(loadConfig({...common,...pins,...lookup}),economy)!;
 expect(dark.provider.ordered).toBeUndefined();dark.close();
 const config=loadConfig({...common,...pins,...lookup,MINING_CLAIM_ORDERED_ENABLED:'true'}),active=createMiningClaimRuntime(config,economy)!;
 config.MINING_CLAIM_LOOKUP_TABLE=pk(8);config.MINING_CLAIM_LOOKUP_TABLE_SHA256='f'.repeat(64);expect(active.provider.ordered).toEqual({address:lookup.MINING_CLAIM_LOOKUP_TABLE,dataSha256:lookup.MINING_CLAIM_LOOKUP_TABLE_SHA256});active.close();
});
