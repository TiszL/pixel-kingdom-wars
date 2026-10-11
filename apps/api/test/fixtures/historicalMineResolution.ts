/** Private provenance repair using real encoded/signed term fixtures and the
 * actual registered-custody reader. No ledger posting or operating admission. */
import { randomBytes } from 'node:crypto';
import { PublicKey, Keypair, SYSVAR_CLOCK_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Ed25519Program, TransactionMessage, VersionedTransaction, type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import { verifyHistoricalSeekerTermAccounts } from '../../../../packages/chain/src/seekerTermAccounts';
import idl from '../../../../packages/chain/src/idl/shardkeep_economy.json' with { type: 'json' };
import { encodeSeekerActionPermit, hashSettleSeekerAuctionPayload, seekerAuthorityPda, seekerPermitReceiptPda, seekerRegistryPda, seekerTermPda, seekerAuctionPda, canonicalSeekerRegistry } from '../../../../packages/chain/src/seekerAuctionProtocol';
import { MINING, PHASE_E_SEEKER_AUCTION, getMiningQuota } from '@shardkeep/shared';
import type { SeekerTermRpc } from '@shardkeep/chain/seeker-terms';
import type { DeedMiningWalletReader } from '@shardkeep/chain/mining-wallet';
import { createMiningWalletFixture } from '../../../../packages/chain/src/testFixtures/deedMiningWallet';
import { createMiningTermFixture } from '../../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import type { resourceClaimsDatabase } from './resourceClaimsDatabase';
import { createTestPlayer } from '../helpers';
import { bases, baseSlots, buildings, mineAccrualStates } from '../../src/db/schema';
import { initializeMiningRosterHistory } from '../../src/mining/rosterHistory';
import { reanchorBaseMineAccrual, MINE_DAY_MS } from '../../src/game/baseMining';
import { resolvePhysicalMineTaxSource } from '../../src/mining/shardsTaxMineResolution';
type ResolutionTestDatabase=ReturnType<typeof resourceClaimsDatabase>;
const quota=getMiningQuota(1,[1],0,MINING.EPOCH_RATE_BPS),unit=MINE_DAY_MS/quota;
const boundary=new Date('2035-01-08T00:00:00.000Z'),anchor=new Date(+boundary-6*unit),verified=new Date('2035-01-16T00:00:00.000Z');
export const mineResolutionFixtureTimes={boundary,anchor,verified,quota,unit};
// Exact-boundary settlement needs native permit evidence; permissionless
// settlement remains subject to grace. Re-sign full genuine messages locally.
function nativeBoundarySettlements(bank:Awaited<ReturnType<typeof createMiningTermFixture>>){
 const settler=Keypair.generate(),policy=Keypair.generate(),p=bank.policy;
 const raw=(address:PublicKey)=>({...bank.store.get(address.toBase58())!,address});
 const verified=verifyHistoricalSeekerTermAccounts({...p,operatingAt:BigInt(Date.parse('2035-01-16T00:00:00Z')/1000)},{
  authority:raw(seekerAuthorityPda(p.programId)),config:raw(p.config),registry:raw(seekerRegistryPda(p.programId)),term:raw(seekerTermPda(p.programId,p.config,p.round)),
  auctions:canonicalSeekerRegistry().map(e=>raw(seekerAuctionPda(p.programId,p.config,e.spotId,p.round)))});
 const facts=new Map(verified.auctions.map(a=>[a.terms.auction,a]));
 const layout=idl.instructions.find(i=>i.name==='settle_auction_with_permit')!;
 const bodies=new Map<string,VersionedTransactionResponse>(),history=new Map<string,string>();
 for(const prior of bank.bodies.values()){
  const message=prior.transaction.message,ix=message.compiledInstructions[0]!,keys=message.getAccountKeys();
  const accounts=Array.from(ix.accountKeyIndexes,i=>keys.get(i)!);accounts[0]=settler.publicKey;
  const auction=facts.get(accounts[3]!.toBase58())!,permitId=randomBytes(16);
  const settledAt=auction.settledAt,expiry=settledAt+BigInt(PHASE_E_SEEKER_AUCTION.issuedPolicyPermitTtlSec);
  const permit=encodeSeekerActionPermit({genesisHash:bank.policy.genesisHash,programId:bank.policy.programId,kind:8,permitId,wallet:settler.publicKey,expiry,
   payloadHash:hashSettleSeekerAuctionPayload({auction:accounts[3]!,config:accounts[1]!,term:accounts[2]!,termsHash:Buffer.from(auction.termsHash,'hex'),highBid:auction.highBid,highBidder:auction.winner?new PublicKey(auction.winner):null})});
  const data=Buffer.alloc(34);data.set(layout.discriminator);data.set(permitId,8);data.writeBigInt64LE(expiry,24);data.writeUInt16LE(0,32);
  accounts.push(seekerAuthorityPda(bank.policy.programId),seekerPermitReceiptPda(bank.policy.programId,permitId),SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId);
  const replacement=new TransactionMessage({payerKey:settler.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[
   Ed25519Program.createInstructionWithPrivateKey({privateKey:policy.secretKey,message:permit}),
   {programId:bank.policy.programId,data,keys:accounts.map((pubkey,i)=>({pubkey,isSigner:'signer' in layout.accounts[i]!&&layout.accounts[i]!.signer,
    isWritable:(i!==7||auction.winner!==null)&&'writable' in layout.accounts[i]!&&layout.accounts[i]!.writable}))}]}).compileToLegacyMessage();
  const signed=new VersionedTransaction(replacement);signed.sign([settler]);const signature=bs58.encode(signed.signatures[0]!);
  bodies.set(signature,{...prior,transaction:{message:replacement,signatures:[signature]}});history.set(accounts[3]!.toBase58(),signature);
 }return {bodies,history};
}
// Caller setup installs registered migrations; this function adds test data only.
export async function installMineResolutionFixtureBoundary(conn:ResolutionTestDatabase){
 await conn.sql`insert into shards_mine_policy_boundary(id,version,policy_version,tax_table_version,effective_at) values(1,1,1,1,${new Date(+anchor+4*unit+1).toISOString()})`;
}
export interface HistoricalMineResolutionFixtureOptions {
 /** Optional reviewed fixture identity for actual runtime adapters; no production defaults. */
 identity?:Pick<Parameters<typeof createMiningTermFixture>[0],'genesisHash'|'programId'|'programData'|'programDataAddress'|'upgradeAuthority'|'mint'|'prizeOwner'>;
 round0Winners?:Parameters<typeof createMiningTermFixture>[0]['winners'];
 round1Winners?:Parameters<typeof createMiningTermFixture>[0]['winners'];
}
export async function createMineResolutionTermBank(options:HistoricalMineResolutionFixtureOptions={}){
 const source={genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey,...options.identity,firstOperatingStart:BigInt(Date.parse('2035-01-01T00:00:00Z')/1000)};
 const original=await createMiningTermFixture({...source,day:'2035-01-01',winners:options.round0Winners??[]});
 const next=await createMiningTermFixture({...source,day:'2035-01-08',round:1n,winners:options.round1Winners??[],mint:original.policy.mint,prizeOwner:original.policy.prizeOwner,
  programData:original.programData,programDataAddress:original.programDataAddress,upgradeAuthority:original.upgradeAuthority});
 const priorNative=nativeBoundarySettlements(original),nextNative=nativeBoundarySettlements(next);
 const store=new Map([...original.store,...next.store]),bodies=new Map([...priorNative.bodies,...nextNative.bodies]),history=new Map([...priorNative.history,...nextNative.history]);
 store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(+verified/1000),32);
 const rpc:SeekerTermRpc={...original.rpc,getMultipleAccountsInfoAndContext:async addresses=>({context:{slot:2000},value:addresses.map(a=>{
  const found=store.get(a.toBase58());return found?{...found,data:Buffer.from(found.data)}:null;
 })}),getSignaturesForAddress:async(address)=>{const signature=history.get(address.toBase58()),tx=signature?bodies.get(signature):null;return signature&&tx?[{signature,slot:tx.slot,err:null,memo:null,confirmationStatus:'finalized'}]:[];},
 getTransaction:(async(signature:string)=>bodies.get(signature)??null) as SeekerTermRpc['getTransaction']};

 return {original,rpc,store,bodies,history};
}
export async function setMineResolutionRosterClock(conn:ResolutionTestDatabase,at:string){await conn.sql.unsafe(`create or replace function public.shardkeep_mining_roster_clock() returns timestamptz language sql volatile as $$select '${at}'::timestamptz$$`);}
export async function createBufferedMineResolutionFixture(conn:ResolutionTestDatabase,options:{deeded?:boolean;rosterBaselineAt?:string;deedInterval?:{startAt:Date;endAt:Date}}={}){
 const db=conn.db;
 await setMineResolutionRosterClock(conn,options.rosterBaselineAt??'2035-01-01T00:00:00Z');const {wallet}=await createTestPlayer(db);
 // This fixture retains units5..8 across Jan7/8. Archive the complete closed
 // earning days, not just the four unit-completion instants.
 const chain=options.deeded?createMiningWalletFixture({targetWallet:wallet,startAt:options.deedInterval?.startAt??new Date('2035-01-07T00:00:00Z'),endAt:options.deedInterval?.endAt??new Date('2035-01-09T00:00:00Z'),scenario:'continuous'}):null;
 const [base]=await db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1,
  ...(chain?{landPaidAt:new Date('2034-12-31T00:00:00Z'),deedAssetId:chain.assetId,deedMintAssetId:chain.assetId}:{})}).returning();
 await db.insert(baseSlots).values({wallet,slot:1,baseId:base!.id});
 const [mine]=await db.insert(buildings).values({playerWallet:wallet,baseId:base!.id,type:'mine',level:1,tx:1,ty:1}).returning();
 await db.insert(mineAccrualStates).values({mineBuildingId:mine!.id,lastAccrualAt:anchor});await initializeMiningRosterHistory(db,wallet);
 await db.transaction(tx=>reanchorBaseMineAccrual(tx,base!.id,new Date(+anchor+8*unit)));
 const [parent]=await conn.sql`select * from shards_mine_segments where mine_id=${mine!.id} and wallet=${wallet}`;
 if(parent?.first_unit!=='5'||parent.last_unit!=='8')throw Error('Fixture must retain original post-policy ordinals5..8');
 await setMineResolutionRosterClock(conn,verified.toISOString());return {wallet,base:base!,mine:mine!,parent:parent!,chain};
}
export async function createResolvedMineResolutionFixture(conn:ResolutionTestDatabase,bank:Awaited<ReturnType<typeof createMineResolutionTermBank>>){
 const buffered=await createBufferedMineResolutionFixture(conn);
 const deps={historicalTerm:{connect:(signal:AbortSignal)=>{signal.throwIfAborted();return bank.rpc;},policy:bank.original.policy},clock:()=>new Date(verified)};
 const resolution=await resolvePhysicalMineTaxSource(conn.db,buffered.parent.id,deps);
 return {...buffered,resolution,deps,...mineResolutionFixtureTimes};
}
/** The caller owns setup/close of its isolated database and the mining flag.
 * No current admission is fabricated; these are retained historical units. */
export async function createHistoricalMineResolutionFixture(conn:ResolutionTestDatabase,options:HistoricalMineResolutionFixtureOptions={}){
 await installMineResolutionFixtureBoundary(conn);const bank=await createMineResolutionTermBank(options);
 const deps={historicalTerm:{connect:(signal:AbortSignal)=>{signal.throwIfAborted();return bank.rpc;},policy:bank.original.policy},clock:()=>new Date(verified)};
 const createDeededSource=async()=>{
  const buffered=await createBufferedMineResolutionFixture(conn,{deeded:true});
  if(!buffered.chain)throw Error('Deeded fixture requires actual archival source');
  const deedCustody={source:buffered.chain.reader as unknown as DeedMiningWalletReader,collection:buffered.chain.collection,expectedGenesisHash:buffered.chain.expectedGenesisHash};
  return {...buffered,chain:buffered.chain,deedCustody,deps:{...deps,deedCustody}};
 };
 return {bank,deps,...mineResolutionFixtureTimes,createDeededSource,
  createResolvedDeededSource:async()=>{const source=await createDeededSource();const resolution=await resolvePhysicalMineTaxSource(conn.db,source.parent.id,source.deps);return {...source,resolution,...mineResolutionFixtureTimes};},
  createSource:()=>createBufferedMineResolutionFixture(conn),
  resolve:(segmentId:string)=>resolvePhysicalMineTaxSource(conn.db,segmentId,deps),
  createResolvedSource:()=>createResolvedMineResolutionFixture(conn,bank),
  rosterClock:(at:string)=>setMineResolutionRosterClock(conn,at)};
}
