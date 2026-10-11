/** Read-only transparency uses real database identity and serialized chain accounts. */
import { PublicKey } from '@solana/web3.js';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import postgres from 'postgres';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bootstrapEconomyAllocations } from '../src/ledger';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMiningBackingFixture } from '../../../packages/chain/src/testFixtures/miningBacking';
import { createMiningTransparencyReader } from '../src/money/miningTransparency';
import { assertEconomyChainIdentity,assertGemsReserveIdentity } from '../src/money/economyIdentity';
import { checkReserves } from '../src/money/snapshot';
import { convertKeepToGems } from '../src/game/gems';
import { createTestPlayer,fundTestKeep } from './helpers';
import { randomUUID } from 'node:crypto';
// The shared suite database is already pinned to its Gems/devnet identity.
// This suite needs an initially unbound database and a different serialized mint;
// own one disposable database rather than rebinding another suite's identity.
const name=`mining_transparency_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);
url.pathname=`/${name}`;
const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),pk=(n:number)=>new PublicKey(Buffer.alloc(32,n));
let conn:ReturnType<typeof createDb>;
beforeAll(async()=>{await admin.unsafe(`create database ${name}`);conn=createDb(url.toString());await runMigrations(conn.db);await bootstrapEconomyAllocations(conn.db);});
afterAll(async()=>{vi.restoreAllMocks();try{await conn?.sql.end();await admin.unsafe(`drop database if exists ${name} with (force)`);}finally{await admin.end();}});
const binding={cluster:'devnet' as const,keepMint:pk(1).toBase58(),coreProgram:pk(30).toBase58(),configPda:pk(31).toBase58()},hotWallet=pk(32).toBase58();
let bound=false;
async function fixture(bind=true){
 const f=await createMiningBackingFixture();
 if(bind&&!bound){await assertEconomyChainIdentity(conn.db,binding,binding);await assertGemsReserveIdentity(conn.db,{GEMS_RESERVE_OWNER:f.trust.reserveOwner.toBase58(),HOT_WALLET_PUBKEY:hotWallet},binding,[{getAccountInfoAndContext:async()=>({context:{slot:150},value:{...f.rows[2]!,lamports:1,rentEpoch:0}})}]);bound=true;}
 const deps={economy:binding,expectedGenesisHash:f.trust.expectedGenesisHash,hotWallet,source:f.reader,trust:f.trust};
 return {...f,deps,read:createMiningTransparencyReader(conn.db,deps)};
}
describe('mining backing transparency without custody double counting',()=>{
 it('refuses an unbound database without reporting invented zero balances',async()=>{
  const f=await fixture(false),result=await f.read();expect(result).toEqual({status:'unavailable',reason:'DATABASE_IDENTITY'});expect(result).not.toHaveProperty('vault');
 });
 it('reports both mining liabilities and separates emission reserve from the only backing vault',async()=>{
  const f=await fixture(),r=await f.read();expect(r).toMatchObject({status:'available',slot:150,liabilities:{playerBaseUnits:'50',taxBaseUnits:'10',totalBaseUnits:'60'},vault:{balanceBaseUnits:'100'},unallocatedVaultBaseUnits:'40',emissionReserve:{balanceBaseUnits:'10',countsAsMiningBacking:false},custodialCoverageAffected:false});
  expect(Object.isFrozen(r)).toBe(true);expect(r).not.toHaveProperty('combinedCoverage');
 });
 it('does not count Gems or ledger emission_pool as an additional reserve or custodial liability',async()=>{
  const f=await fixture(),{wallet}=await createTestPlayer(conn.db);await fundTestKeep(conn.db,wallet,500n,'test.mining.transparency',randomUUID());
  const before=await checkReserves(conn.db,async()=>1000000n),sourceBefore=await f.read();await convertKeepToGems(conn.db,wallet,100n,randomUUID());
  const after=await checkReserves(conn.db,async()=>1000000n),sourceAfter=await createMiningTransparencyReader(conn.db,f.deps)();
  expect(before.liabilityKeep-after.liabilityKeep).toBe(100n);expect(sourceAfter).toEqual(sourceBefore);
 });
 it('keeps highwater liabilities through revocation and reports claim reduction exactly once',async()=>{
  const f=await fixture();f.model.total_published=0n;f.model.correction_pending=true;await f.config();
  expect(await f.read()).toMatchObject({status:'available',liabilities:{playerBaseUnits:'50',taxBaseUnits:'10'}});
  f.model.total_claimed=40n;await f.config();f.rows[1]!.data.writeBigUInt64LE(90n,64);
  expect(await createMiningTransparencyReader(conn.db,f.deps)()).toMatchObject({status:'available',liabilities:{playerBaseUnits:'40',totalBaseUnits:'50'},vault:{balanceBaseUnits:'90'},unallocatedVaultBaseUnits:'40'});
 });
 it('refuses wrong database, mint, genesis, reserve identity and every custody alias',async()=>{
  const f=await fixture();
  for(const deps of [{...f.deps,economy:{...binding,cluster:'mainnet-beta' as const}},{...f.deps,economy:{...binding,keepMint:pk(33).toBase58()}},{...f.deps,expectedGenesisHash:pk(33).toBase58()},{...f.deps,hotWallet:f.trust.reserveOwner.toBase58()},{...f.deps,hotWallet:f.rows[0]!.address.toBase58()}]){
   const result=await createMiningTransparencyReader(conn.db,deps)();expect(result.status).toBe('unavailable');expect(result).not.toHaveProperty('liabilities');
  }
  const wrong=await createMiningBackingFixture();
  // The actual fixture has a fixed reserve identity; alter canonical raw source
  // under a separately configured trust, so the real backing decoder must refuse.
  wrong.trust.reserveOwner=pk(34);expect((await createMiningTransparencyReader(conn.db,{...f.deps,source:wrong.reader,trust:wrong.trust})()).status).toBe('unavailable');
 });
 it('reports incompatible mutable mint and insolvency as unavailable, never a zero liability success',async()=>{
  const f=await fixture();f.rows[3]!.data.writeUInt32LE(1,0);expect(await f.read()).toEqual({status:'unavailable',reason:'BACKING_UNAVAILABLE'});
  f.rows[3]!.data.writeUInt32LE(0,0);f.rows[1]!.data.writeBigUInt64LE(59n,64);
  expect(await createMiningTransparencyReader(conn.db,f.deps)()).toEqual({status:'unavailable',reason:'BACKING_UNAVAILABLE'});
 });
 it('shares a concurrent read, caches success and isolates different configured readers',async()=>{
  const f=await fixture(),calls=vi.spyOn(f.reader,'getMultipleAccountsInfoAndContext');
  const [a,b]=await Promise.all([f.read(),f.read()]);expect(a).toEqual(b);expect(calls).toHaveBeenCalledTimes(1);expect(await f.read()).toEqual(a);expect(calls).toHaveBeenCalledTimes(1);
  const other=await fixture(),otherCalls=vi.spyOn(other.reader,'getMultipleAccountsInfoAndContext');await other.read();expect(otherCalls).toHaveBeenCalledTimes(1);
 });
 it('caches failure and retries only after its bounded TTL',async()=>{
  const f=await fixture(),clock=vi.spyOn(performance,'now').mockReturnValue(0);let calls=0;const original=f.reader.getGenesisHash;f.reader.getGenesisHash=async()=>{calls++;throw Error('provider down');};
  try{expect((await f.read()).status).toBe('unavailable');expect((await f.read()).status).toBe('unavailable');expect(calls).toBe(1);
   clock.mockReturnValue(15001);f.reader.getGenesisHash=original;expect((await f.read()).status).toBe('available');
  }finally{clock.mockRestore();}
 });
 it('deadlines abort the source and discard late success without starting overlapping retries',async()=>{
  const f=await fixture();let release!:()=>void,started=0,signal:AbortSignal|undefined;const gate=new Promise<void>(resolve=>{release=resolve;});
  const read=createMiningTransparencyReader(conn.db,{...f.deps,source:s=>{signal=s;return {...f.reader,getGenesisHash:async()=>{started++;await gate;return f.trust.expectedGenesisHash;}};}});
  const result=await read();expect(result).toEqual({status:'unavailable',reason:'TIMEOUT'});expect(signal?.aborted).toBe(true);
  const clock=vi.spyOn(performance,'now').mockReturnValue(performance.now()+60000);try{expect(await read()).toEqual(result);expect(started).toBe(1);}finally{clock.mockRestore();}
  release();await new Promise(resolve=>setImmediate(resolve));expect(await read()).toEqual(result);
 },10000);
});
