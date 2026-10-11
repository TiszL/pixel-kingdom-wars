/** Mocked boundary tests for actual seed function, never a database launcher. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FORGE_INGOT, PLAYTEST } from '@shardkeep/shared';
import type { Db } from '../src/db/client';
const boundary=vi.hoisted(()=>({order:[] as string[],duplicate:false,rows:[] as Record<string,unknown>[],reads:0,database:'fleet_journey_'+'a'.repeat(32)+'_test'}));
vi.mock('../src/ledger',()=>({
  bootstrapSystemAccounts:vi.fn(async()=>{boundary.order.push('accounts');return {keep_genesis:'genesis',emission_pool:'pool'};}),
  postTransaction:vi.fn(async()=>{boundary.order.push('input');return {duplicate:boundary.duplicate,transaction:{id:'input'}};}),
}));
vi.mock('../src/game/gemsGrants',()=>({
  fundGemsRewardBudget:vi.fn(async()=>{boundary.order.push('budget');return {duplicate:false,transaction:{id:'budget'}};}),
  grantWelcomeGems:vi.fn(async()=>{boundary.order.push('grant');return {duplicate:false,transaction:{id:'grant'}};}),
}));
vi.mock('../src/game/baseEconomy',()=>({
  rewardBaseShards:vi.fn(async()=>{boundary.order.push('forge-input');return {duplicate:boundary.duplicate,transaction:{id:'forge-input'}};}),
}));
import { postTransaction } from '../src/ledger';
import { fundGemsRewardBudget, grantWelcomeGems } from '../src/game/gemsGrants';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { seedEconomyWelcome, seedEconomyForge } from './manual/fleet-journey-economy-profile';
const wallet='fixture-wallet',runId='a'.repeat(32),amount=BigInt(PLAYTEST.welcomeGems);
const tx={execute:vi.fn(async()=>{
  if(boundary.reads++===0){boundary.order.push('check-database');return [{name:boundary.database}];}
  boundary.order.push('read-original');return boundary.rows;
})};
const transaction=vi.fn(async(run:(value:typeof tx)=>Promise<unknown>)=>run(tx));
const db={transaction} as unknown as Db;
beforeEach(()=>{
  vi.clearAllMocks();boundary.order=[];boundary.duplicate=false;boundary.reads=0;boundary.database='fleet_journey_'+runId+'_test';
  boundary.rows=[
    {kind:'gems_reward_budget',currency:'KEEP',delta:String(-amount),ownerWallet:null,baseId:null},
    {kind:'emission_pool',currency:'KEEP',delta:String(amount),ownerWallet:null,baseId:null},
    {kind:'gems_mint',currency:'GEMS',delta:String(-amount),ownerWallet:null,baseId:null},
    {kind:'player_gems',currency:'GEMS',delta:String(amount),ownerWallet:wallet,baseId:null},
  ];
  vi.stubEnv('NODE_ENV','test');vi.stubEnv('SOLANA_CLUSTER','devnet');
  vi.stubEnv('GEMS_ENABLED','true');vi.stubEnv('DEVNET_WELCOME_GEMS_ENABLED','true');
  vi.stubEnv('FORGE_INGOTS_ENABLED','true');
});
describe('normal selected-base Forge funding adapter',()=>{
  const baseId='00000000-0000-4000-8000-000000000001';
  it('journals exactly one canonical ingot price in the bound disposable database',async()=>{
    const proof=await seedEconomyForge(db,baseId,runId);
    expect(boundary.order).toEqual(['check-database','forge-input']);
    expect(transaction).toHaveBeenCalledTimes(1);expect(rewardBaseShards).toHaveBeenCalledTimes(1);
    expect(rewardBaseShards).toHaveBeenCalledWith(tx,baseId,BigInt(FORGE_INGOT.shardsPerIngot),
      'fixture.economy.forge-input','fixture:economy:forge:'+runId,{fixture:true,runId});
    expect(proof).toMatchObject({duplicate:false,transaction:{id:'forge-input'}});
    expect(postTransaction).not.toHaveBeenCalled();expect(grantWelcomeGems).not.toHaveBeenCalled();
  });
  it.each([['NODE_ENV','production'],['SOLANA_CLUSTER','mainnet-beta'],['FORGE_INGOTS_ENABLED','false']])('refuses wrong %s before opening the transaction',async(name,value)=>{
    vi.stubEnv(name,value);await expect(seedEconomyForge(db,baseId,runId)).rejects.toThrow('E2_FORGE_SEED_REFUSED');
    expect(transaction).not.toHaveBeenCalled();expect(rewardBaseShards).not.toHaveBeenCalled();
  });
  it('refuses invalid base and run identities before funding',async()=>{
    await expect(seedEconomyForge(db,'other',runId)).rejects.toThrow('E2_FORGE_SEED_REFUSED');
    await expect(seedEconomyForge(db,baseId,'other')).rejects.toThrow('E2_FORGE_SEED_REFUSED');
    expect(transaction).not.toHaveBeenCalled();
  });
  it('refuses a different database before the normal funding boundary',async()=>{
    boundary.database='fleet_journey_'+'b'.repeat(32)+'_test';
    await expect(seedEconomyForge(db,baseId,runId)).rejects.toThrow('E2_FORGE_SEED_REFUSED');
    expect(boundary.order).toEqual(['check-database']);expect(rewardBaseShards).not.toHaveBeenCalled();
  });
  it('refuses duplicate funding inside the transaction',async()=>{
    boundary.duplicate=true;await expect(seedEconomyForge(db,baseId,runId)).rejects.toThrow('E2_FORGE_SEED_REFUSED');
    expect(rewardBaseShards).toHaveBeenCalledTimes(1);
  });
});
afterEach(()=>vi.unstubAllEnvs());
describe('normal welcome ledger seeding adapter',()=>{
  it('journals the canonical amount before the normal welcome grant and reads the committed-original rows',async()=>{
    const proof=await seedEconomyWelcome(db,wallet,runId);
    expect(boundary.order).toEqual(['check-database','accounts','input','budget','grant','read-original']);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(postTransaction).toHaveBeenCalledWith(tx,expect.objectContaining({
      entries:[{account:'genesis',delta:-amount},{account:'pool',delta:amount}],
      metadata:{fixture:true,runId,wallet},idempotencyKey:'fixture:economy:welcome:'+runId,
    }));
    expect(fundGemsRewardBudget).toHaveBeenCalledWith(tx,amount,'fixture-economy:'+runId,{fixture:true,runId,wallet});
    expect(grantWelcomeGems).toHaveBeenCalledWith(tx,wallet);
    expect(proof).toMatchObject({wallet,gems:String(amount),entryCount:4,fixtureInputId:'input',budgetId:'budget',grantId:'grant'});
  });
  it.each([['NODE_ENV','production'],['SOLANA_CLUSTER','mainnet-beta'],['GEMS_ENABLED','false'],['DEVNET_WELCOME_GEMS_ENABLED','false']])('refuses wrong %s before any ledger callback',async(name,value)=>{
    vi.stubEnv(name,value);await expect(seedEconomyWelcome(db,wallet,runId)).rejects.toThrow('E2_WELCOME_SEED_REFUSED');
    expect(transaction).not.toHaveBeenCalled();
  });
  it('refuses an unbound run identity before opening the transaction',async()=>{
    await expect(seedEconomyWelcome(db,wallet,'other')).rejects.toThrow('E2_WELCOME_SEED_REFUSED');expect(transaction).not.toHaveBeenCalled();
  });
  it('refuses a different database or run before any funding callback',async()=>{
    boundary.database='fleet_journey_'+'b'.repeat(32)+'_test';
    await expect(seedEconomyWelcome(db,wallet,runId)).rejects.toThrow('E2_WELCOME_SEED_REFUSED');
    expect(postTransaction).not.toHaveBeenCalled();expect(boundary.order).toEqual(['check-database']);
  });
  it('refuses replay inside the transaction rather than adding a second seed',async()=>{
    boundary.duplicate=true;await expect(seedEconomyWelcome(db,wallet,runId)).rejects.toThrow('E2_WELCOME_SEED_REFUSED');
  });
  it('fails the transaction if the actual grant rows do not back the claimed wallet',async()=>{
    boundary.rows[3]!.ownerWallet='other';await expect(seedEconomyWelcome(db,wallet,runId)).rejects.toThrow('E2_WELCOME_LEDGER_REFUSED');
  });
});
