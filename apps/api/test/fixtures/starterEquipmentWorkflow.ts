/** Real loopback RPC source for fitted starter private-composition acceptance. */
import {vi} from 'vitest';
import {SOLANA_GENESIS_HASH} from '@shardkeep/chain';
import {PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import {realmSaleQuoteFixture} from '../../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {createMiningTermFixture} from '../../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {realmSaleRuntimeRpc} from './realmSaleRuntime';
import {TEST_CONFIG} from '../helpers';
export async function starterEquipmentChain(){
 const f=await realmSaleQuoteFixture({genesisHash:SOLANA_GENESIS_HASH.devnet});
 f.bodies.clear();f.history.clear();
 const start=new Date(Math.floor((Date.now()-2*86_400_000)/86_400_000)*86_400_000),first=BigInt(+start/1000)-BigInt(PHASE_E_SEEKER_AUCTION.settlementGraceSec);
 async function round(n:bigint){
  const day=new Date(Number(first+n*BigInt(PHASE_E_POLICY.seekerIsland.operatingTermSec)+BigInt(PHASE_E_SEEKER_AUCTION.settlementGraceSec))*1000).toISOString().slice(0,10);
  const bank=await createMiningTermFixture({day,genesisHash:f.termPolicy.genesisHash,programId:f.termPolicy.programId,
   programData:f.programData,programDataAddress:f.programDataAddress,upgradeAuthority:f.upgradeAuthority,
   round:n,firstOperatingStart:first,mint:f.termPolicy.mint,prizeOwner:f.termPolicy.prizeOwner,winners:[{spotId:0,wallet:f.seller}]});
  for(const [k,v] of bank.store)f.store.set(k,v);
  for(const [k,v] of bank.bodies){f.bodies.set(k,v);f.history.set(v.transaction.message.staticAccountKeys[3]!.toBase58(),k);}
  time(new Date(day+'T01:00:00.000Z'));
 }
 function time(at:Date){vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(at);f.controls.now=BigInt(Math.floor(+at/1000));}
 await round(0n);const rpc=await realmSaleRuntimeRpc(f);
 const config={...TEST_CONFIG,SOLANA_RPC_URL:rpc.url,SEEKER_REALM_SALE_PROGRAM_ID:f.termPolicy.programId.toBase58(),
  SEEKER_REALM_SALE_DEPLOYMENT_SLOT:f.accessTrust.reviewedDeploymentSlot,SEEKER_REALM_SALE_PROGRAM_DATA_SHA256:f.accessTrust.reviewedProgramDataSha256,
  SEEKER_REALM_SALE_UPGRADE_AUTHORITY:f.upgradeAuthority.toBase58(),SEEKER_REALM_SALE_AUCTION_MINT:f.termPolicy.mint.toBase58(),
  SEEKER_REALM_SALE_PRIZE_OWNER:f.termPolicy.prizeOwner.toBase58(),SEEKER_REALM_SALE_DEVELOPER:f.developer.toBase58(),
  SEEKER_REALM_SALE_ROUND:'999',SEEKER_REALM_SALE_POLICY_REVISION:'gameplay-r1',SEEKER_REALM_SALE_STATE_PROVENANCE:'fresh-reviewed-deployment' as const};
 return {f,rpc,config,time,round};
}
