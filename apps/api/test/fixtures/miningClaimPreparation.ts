/** Actual settled entitlement and B3f preparation, with a disposable claimant key. */
import { randomUUID } from 'node:crypto';
import { PublicKey,VersionedMessage,VersionedTransaction,type Keypair } from '@solana/web3.js';
import { PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import { createMiningClaimFixture } from '../../../../packages/chain/src/testFixtures/miningClaim';
import type { MiningClaimSnapshotReader,MiningClaimSnapshotTrust } from '@shardkeep/chain/mining-claim-snapshot';
import { projectMiningClaimEntitlements } from '../../src/mining/claimEntitlement';
import { createMiningClaimPreparer,type MiningClaimQuoteReader } from '../../src/mining/claimPreparation';
import type { MiningClaimPreparation } from '../../src/mining/claimPreparationStore';
import { withMiningClaimEntitlementFixture,type MiningClaimEntitlementFixture } from './miningClaimEntitlement';
export type MiningClaimPreparationBank=Omit<Awaited<ReturnType<typeof createMiningClaimFixture>>,'reader'|'trust'|'clock'> & {
 reader:MiningClaimSnapshotReader;trust:MiningClaimSnapshotTrust;sync:()=>void;clock:(at:bigint)=>void;reads:()=>number;setSlot:(slot:number)=>void;
 config:(change:Record<string,unknown>)=>Promise<void>;allocation:(change:Record<string,unknown>)=>Promise<void>;
};
export interface MiningClaimPreparationQuote{reader:MiningClaimQuoteReader;fees:Uint8Array[];rentSpaces:number[];reads:()=>number}
export type MiningClaimPreparationFixture=MiningClaimEntitlementFixture & {
 preparedClaim:MiningClaimPreparation;claimantSigner:Keypair;bank:MiningClaimPreparationBank;quote:MiningClaimPreparationQuote;
 claimService:ReturnType<typeof createMiningClaimPreparer>;sign:(ordinal?:number)=>Uint8Array;
};
async function currentBank(f:MiningClaimEntitlementFixture):Promise<MiningClaimPreparationBank>{
 const bank=await createMiningClaimFixture({wallet:new PublicKey(f.wallet),day:'2020-01-01'});
 for(let i=0;i<8;i++)bank.rows[i]={...f.backing.rows[i]!,data:Buffer.from(f.backing.rows[i]!.data)};
 const clock=bank.rows[7]!.data as Buffer;clock.writeBigUInt64LE(3000n);clock.writeBigInt64LE(BigInt(f.prepared.publication.day)*BigInt(POLICY.daySec)+BigInt(POLICY.daySec+POLICY.claimDelaySec),32);
 function sync(){bank.rows[0]=f.chain.accounts[0]!;bank.rows[8]=f.chain.accounts[2]!;bank.rows[9]=f.chain.accounts[1]!;}sync();
 for(const [i,which] of [[1,0],[2,1]] as const)(bank.rows[i]!.data as Buffer).writeBigUInt64LE(BigInt(f.chain.tx.meta!.postTokenBalances![which]!.uiTokenAmount.amount),64);
 // Exercise actual ATA + permanent-record setup along with the claim.
 bank.rows[12]=null;
 let reads=0,slot=3000;const reader:MiningClaimSnapshotReader={getGenesisHash:async()=>f.identity.genesisHash,getSlot:async()=>slot,getMultipleAccountsInfoAndContext:async()=>{reads++;return {context:{slot},value:bank.rows};}};
 return {...bank,reader,trust:f.chain.trusted,sync,clock:(at:bigint)=>{clock.writeBigInt64LE(at,32);},reads:()=>reads,setSlot:(next:number)=>{slot=next;clock.writeBigUInt64LE(BigInt(next));},
  async config(change){Object.assign(f.chain.models[0]!,change);await f.chain.encode(0);sync();},
  async allocation(change){Object.assign(f.chain.models[2]!,change);await f.chain.encode(2);sync();}};
}
function quote(genesis:string):MiningClaimPreparationQuote{
 let reads=0;const fees:Uint8Array[]=[],rentSpaces:number[]=[];
 const reader:MiningClaimQuoteReader={getGenesisHash:async()=>{reads++;return genesis;},getSlot:async()=>3002,getBlockHeight:async()=>200,
  getLatestBlockhashAndContext:async()=>({context:{slot:3001},value:{blockhash:new PublicKey(Buffer.alloc(32,89)).toBase58(),lastValidBlockHeight:250}}),
  getFeeForMessage:async message=>{fees.push(message.serialize());return {context:{slot:3002},value:5000};},
  getMinimumBalanceForRentExemption:async space=>{rentSpaces.push(space);return space*10;}};
 return {reader,fees,rentSpaces,reads:()=>reads};
}
export async function withMiningClaimPreparationFixture(run:(f:MiningClaimPreparationFixture)=>Promise<void>,options:{genesisHash?:string}={}):Promise<void>{
 return withMiningClaimEntitlementFixture(async f=>{
  await f.settle();await projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId});const bank=await currentBank(f),q=quote(f.identity.genesisHash);
  const claimService=createMiningClaimPreparer(f.conn.db,{...bank,now:()=>new Date('2020-01-02T02:00:00.000Z'),quoteSource:()=>q.reader});
  const preparedClaim=await claimService.prepare(f.wallet,{idempotencyKey:randomUUID()});
  bank.setSlot(3003);
  const sign=(ordinal=0):Uint8Array=>{const t=preparedClaim.transactions[ordinal];if(!t)throw Error('Unknown fixture ordinal');const tx=new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(t.messageHex,'hex')));tx.sign([f.walletSigner]);return tx.serialize();};
  await run({...f,preparedClaim,claimantSigner:f.walletSigner,bank,quote:q,claimService,sign});
 },options);
}
