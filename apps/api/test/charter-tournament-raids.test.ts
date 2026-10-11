import {describe,it,expect,vi} from 'vitest';
import {BuildingType,COMBAT_TICK_MS,PHASE_E_CHARTER_TOURNAMENT as P} from '@shardkeep/shared';
import {simulateRaid,SIM_VERSION} from '@shardkeep/sim';
import {base,b,orders,deploy} from '../../../packages/sim/tests/helpers';
import {verifyCharterTournamentReplay} from '../src/game/charterTournamentRaids';
import type {RaidSimulationWorkerInput} from '../src/game/raidSimulationWorker';
function fixture(stopAfterTick?:number){
 const snapshot=base([b(BuildingType.Keep,8,8,2,'keep'),b(BuildingType.Cannon,5,8,1,'cannon')]);
 const input={snapshot,orders:orders([deploy('highlander',0,8,0),deploy('bowman',17,8,500)]),seed:471,options:{troopLevels:{},...(stopAfterTick===undefined?{}:{stopAfterTick})}};
 const result=simulateRaid(input.snapshot,input.orders,input.seed,input.options);
 return {input,original:{status:'resolved',sim_version:SIM_VERSION,seed:input.seed,snapshot,orders:input.orders,army_snapshot:{levels:{}},result:{stars:Number(result.stars),destructionPct:result.destructionPct,...(stopAfterTick===undefined?{}:{retreated:true})},events:result.events}};
}
const run=async (i:RaidSimulationWorkerInput)=>simulateRaid(i.snapshot,i.orders,i.seed,i.options);
describe('D181 original bounded deterministic raid authority',()=>{
 it('recomputes a completed original raid using the actual simulator',async()=>{const f=fixture(),result=await verifyCharterTournamentReplay(f.original,null,run);expect(result).toMatchObject({completed:true,stars:f.original.result.stars,destruction:f.original.result.destructionPct});expect(result.inputSha256).toMatch(/^[0-9a-f]{64}$/);});
 it('rejects forged stars even when result and supplied event history look plausible',async()=>{const f=fixture();f.original.result.stars=(f.original.result.stars+1)%4;await expect(verifyCharterTournamentReplay(f.original,null,run)).rejects.toThrow('REPLAY_MISMATCH');});
 it('rejects edited original event output instead of trusting persisted result alone',async()=>{const f=fixture();f.original.events=f.original.events.slice(1);await expect(verifyCharterTournamentReplay(f.original,null,run)).rejects.toThrow('REPLAY_MISMATCH');});
 it('replays an actual retreat at its accepted original simulator tick',async()=>{const f=fixture(40),retreat={kind:'retreat',payload:{_clock:{simNowMs:40*COMBAT_TICK_MS}}};expect(await verifyCharterTournamentReplay(f.original,retreat,run)).toMatchObject({completed:true,stars:f.original.result.stars});await expect(verifyCharterTournamentReplay(f.original,null,run)).rejects.toThrow('RETREAT');});
 it('never manufactures completion for pending admission or unsupported simulator version',async()=>{const f=fixture(),worker=vi.fn(run);await expect(verifyCharterTournamentReplay({...f.original,status:'pending_orders'},null,worker)).rejects.toMatchObject({code:'CHARTER_TOURNAMENT_PENDING_RAID'});await expect(verifyCharterTournamentReplay({...f.original,sim_version:SIM_VERSION-1},null,worker)).rejects.toThrow('REPLAY_INPUT');expect(worker).not.toHaveBeenCalled();});
 it('retains original expiry as a consumed admission with no score or replay worker',async()=>{const worker=vi.fn(run);expect(await verifyCharterTournamentReplay({status:'expired'},null,worker)).toMatchObject({completed:false,stars:0,destruction:0});expect(worker).not.toHaveBeenCalled();});
 it('pre-start retreat consumes admission without manufacturing a completed raid or occupying a site',async()=>{const worker=vi.fn(run),original={status:'resolved',result:{stars:0,destructionPct:0,retreated:true},events:[]};expect(await verifyCharterTournamentReplay(original,{kind:'retreat',payload:{_clock:{simNowMs:0}}},worker,{started_at:null,stream_closed_at:'2035-01-07T00:00:01Z'})).toMatchObject({completed:false,stars:0,destruction:0});expect(worker).not.toHaveBeenCalled();});
 it('refuses oversized source before scheduling CPU replay',async()=>{const f=fixture(),worker=vi.fn(run);await expect(verifyCharterTournamentReplay({...f.original,oversized:'x'.repeat(P.maxReplayInputBytes)},null,worker)).rejects.toThrow('REPLAY_BOUNDS');expect(worker).not.toHaveBeenCalled();});
});
