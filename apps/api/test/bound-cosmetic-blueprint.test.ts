/** Real-source acceptance for the Blueprint eligibility reader: actual ordinary
 * refining jobs started and settled by the production writers on an owned
 * database, RECORDED stable-base transfers, a non-owner boundary and deliberate
 * source corruption. Nothing is mocked; no read ever writes. Cases run in order. */
import {Keypair} from '@solana/web3.js';
import {BOUND_COSMETIC_BLUEPRINT_ID} from '@shardkeep/shared/phaseEBoundCosmetics';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {BoundCosmeticBlueprintError,readBoundCosmeticBlueprintEligibility as read} from '../src/game/boundCosmeticBlueprint';
import {BLUEPRINT_TEST_FLAGS,CRAFTING_SOURCE_TABLES,boundCosmeticBlueprintFixture,snapshotTables} from './fixtures/boundCosmeticBlueprint';

const outsider=()=>Keypair.generate().publicKey.toBase58();
const PRIVATE=['recipeSnapshot','inputs','custodyWallet','workshopId','reserveOperationId','consumeOperationId','shardsLedgerTxnId','serverNow','grant'];
function noPrivate(value:unknown,...words:string[]){const text=JSON.stringify(value);for(const w of [...PRIVATE,...words])expect(text,w).not.toContain(w);}
const NOT_EARNED={state:'not-earned',proof:null} as const,CONFLICT={state:'unavailable',reason:'SOURCE_CONFLICT',proof:null} as const;

describe('bound cosmetic Blueprint eligibility from real refining history',()=>{
 let f:Awaited<ReturnType<typeof boundCosmeticBlueprintFixture>>;
 beforeAll(async()=>{for(const flag of BLUEPRINT_TEST_FLAGS)vi.stubEnv(flag,'true');f=await boundCosmeticBlueprintFixture();},300_000);
 afterAll(async()=>{vi.unstubAllEnvs();await f?.close();},120_000);

 it('is not earned before any job or while a refining job is only accepted, then eligible with the earliest completed job, and never writes',async()=>{
  expect(await read(f.db,f.wallet)).toEqual(NOT_EARNED);
  const pending=await f.start(f.wallet,'refine_frostglass');f.advance(pending.job.readyAt.getTime()-f.clock().getTime()+60_000);
  const whilePending=await snapshotTables(f.sql,CRAFTING_SOURCE_TABLES);
  expect(await read(f.db,f.wallet)).toEqual(NOT_EARNED);expect(await read(f.db,f.wallet)).toEqual(NOT_EARNED);
  expect(await snapshotTables(f.sql,CRAFTING_SOURCE_TABLES)).toBe(whilePending);
  const proven=await f.complete(pending),settled=await snapshotTables(f.sql,CRAFTING_SOURCE_TABLES);
  const first=await read(f.db,f.wallet);
  expect(first).toEqual({state:'eligible',proof:{blueprintId:BOUND_COSMETIC_BLUEPRINT_ID,jobId:proven.job.id,baseId:f.baseId,actorWallet:f.wallet,completedAt:proven.completion!.completedAt.toISOString()}});
  expect(first.proof!.completedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);expect(first.proof!.jobId).toBe(first.proof!.jobId.toLowerCase());
  expect(await read(f.db,f.wallet)).toEqual(first);expect(await snapshotTables(f.sql,CRAFTING_SOURCE_TABLES)).toBe(settled);
  noPrivate(first,f.buyer);
  // Deterministic: a later completed job does not move the proof.
  const later=await f.complete(await f.start(f.wallet,'refine_thornsilk'));expect(later.job.id).not.toBe(first.proof!.jobId);
  expect(await read(f.db,f.wallet)).toEqual(first);
 },180_000);

 it('credits the original actor through a recorded base transfer, even when their only refining job settles into the buyer\'s custody, and never the buyer',async()=>{
  // A fresh pair on a fresh base: the seller's ONLY refining job straddles the recorded transfer.
  const sellerB=outsider(),buyerB=outsider(),baseB=await f.ownBase(sellerB);
  const straddling=await f.start(sellerB,'refine_crownsteel',1,baseB);
  await f.transfer(baseB,sellerB,buyerB);
  const proven=await f.complete(straddling);expect(proven.completion!.custodyWallet).toBe(buyerB);expect(proven.job.actorWallet).toBe(sellerB);
  expect(await read(f.db,sellerB)).toEqual({state:'eligible',proof:{blueprintId:BOUND_COSMETIC_BLUEPRINT_ID,jobId:proven.job.id,baseId:baseB.baseId,actorWallet:sellerB,completedAt:proven.completion!.completedAt.toISOString()}});
  expect(await read(f.db,buyerB)).toEqual(NOT_EARNED);
  // The buyer earns only through their own completed refining job on the base they now control.
  const own=await f.complete(await f.start(buyerB,'refine_heartwood_beams',1,baseB));
  expect(await read(f.db,buyerB)).toEqual({state:'eligible',proof:{blueprintId:BOUND_COSMETIC_BLUEPRINT_ID,jobId:own.job.id,baseId:baseB.baseId,actorWallet:buyerB,completedAt:own.completion!.completedAt.toISOString()}});
  expect((await read(f.db,sellerB)).proof!.jobId).toBe(proven.job.id);noPrivate(await read(f.db,sellerB),buyerB);
  // The main base: the seller keeps the earlier proof through a transfer, the buyer starts with nothing.
  const seller=await read(f.db,f.wallet);expect(seller.state).toBe('eligible');
  await f.transfer(f.main,f.wallet,f.buyer);
  expect(await read(f.db,f.wallet)).toEqual(seller);expect(await read(f.db,f.buyer)).toEqual(NOT_EARNED);
 },180_000);

 it('ignores non-refinement crafting and refuses fabricated, half-completed or altered history instead of skipping to genuine rows',async()=>{
  // An actor whose ONLY completed job is a Navigation Kit (real crafting, not refining) has not earned the Blueprint.
  const crafter=outsider(),baseC=await f.ownBase(crafter);
  const kit=await f.complete(await f.start(crafter,'craft_navigation_kit',1,baseC));expect(kit.job.recipeId).toBe('craft_navigation_kit');
  expect(await read(f.db,crafter)).toEqual(NOT_EARNED);
  // A refining job that is still pending but carries a receipt (half-state) is selected and refused, never treated as earned or skipped.
  const pending=await f.start(crafter,'refine_frostglass',1,baseC);
  await f.halfState(pending.job.id,pending.job.readyAt);
  try{expect(await read(f.db,crafter)).toEqual(CONFLICT);}finally{await f.clearHalfState(pending.job.id);}
  expect(await read(f.db,crafter)).toEqual(NOT_EARNED);
  // A job row with a completion receipt but no input proofs is refused, not treated as earned.
  const forger=outsider();await f.fabricate(forger);expect(await read(f.db,forger)).toEqual(CONFLICT);
  // A receipt moved before its own deadline fails the selected proof; the genuine later job is never used to paper over it.
  const seller=await read(f.db,f.wallet);expect(seller.state).toBe('eligible');
  await f.shiftCompletion(seller.proof!.jobId,-3600);
  try{expect(await read(f.db,f.wallet)).toEqual(CONFLICT);}finally{await f.shiftCompletion(seller.proof!.jobId,3600);}
  expect(await read(f.db,f.wallet)).toEqual(seller);
 },180_000);

 it('is a private owner capability: a non-owner reader is not configured, an unreachable source is unavailable, bad inputs are refused',async()=>{
  const reader=await f.readerRole();
  expect(await read(reader.db,f.wallet)).toEqual({state:'unavailable',reason:'NOT_CONFIGURED',proof:null});
  const gone=f.conn.reopen();await gone.sql.end();
  expect(await read(gone.db,f.wallet)).toEqual({state:'unavailable',reason:'SOURCE_UNAVAILABLE',proof:null});
  // Non-base58 characters, the default key, empty and overlong (45-char) strings are refused before any source read.
  for(const wallet of ['not-a-wallet','1'.repeat(32),'','0'+f.wallet.slice(1),f.wallet.padEnd(45,'1')])await expect(read(f.db,wallet)).rejects.toBeInstanceOf(BoundCosmeticBlueprintError);
  await expect(f.db.transaction(tx=>read(tx as never,f.wallet))).rejects.toMatchObject({code:'TOP_LEVEL'});
  expect(await read(f.db,outsider())).toEqual(NOT_EARNED);
 },120_000);
});
