import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {RAID_ADVANCED_PRESENTATION_V1,PHASE_E_VEHICLES} from '@shardkeep/shared';
import {parseRaidAdvancedPresentation,parseRaidAdvancedCapture} from '../src/game/raidAdvancedPresentation';
import {encodeReplayTimeline,decodeReplayTimeline,type ReplayArchiveEnvelope} from '../src/game/raidReplayArchive';
import {NativePresentationPages} from '../src/native/paging';
const id='10000000-0000-4000-8000-000000000001',snapshot={buildings:[{id,type:'berth',level:1}]};
const presentation={version:1 as const,berths:[{buildingId:id,installation:{family:'survey_balloon' as const,tier:1 as const,presence:'away' as const}}]};
it('preserves missing/null/no-advanced and rejects unsupported or incoherent frozen facts',()=>{
 expect(parseRaidAdvancedPresentation(undefined,{})).toBeUndefined();expect(parseRaidAdvancedPresentation(null,{})).toBeNull();
 expect(parseRaidAdvancedPresentation({...presentation,berths:[{buildingId:id,installation:null}]},snapshot)).toBeTruthy();
 for(const value of [{...presentation,version:2},{...presentation,private:'x'},
  {...presentation,berths:[...presentation.berths,...presentation.berths]},
  {...presentation,berths:[{buildingId:id,installation:{family:'starter',tier:1,presence:'occupied'}}]},
  {...presentation,berths:[{buildingId:id,installation:{family:'survey_balloon',tier:5,presence:'occupied'}}]},
 ])expect(()=>parseRaidAdvancedPresentation(value,snapshot)).toThrow();
 for(const other of [{buildings:[]},{buildings:[{id,type:'berth',level:0}]},{buildings:[{id,type:'berth',level:1,underConstruction:true}]}])expect(()=>parseRaidAdvancedPresentation(presentation,other)).toThrow();
});
it('pins v1 allowance separately from mutable gameplay and maps only actual frozen counters',()=>{
 expect(RAID_ADVANCED_PRESENTATION_V1.completedUsesPerInstall).toBe(100);
 expect(RAID_ADVANCED_PRESENTATION_V1).not.toBe(PHASE_E_VEHICLES);
 const capture=(used:string,away=false)=>({version:1,sourceSha256:'a'.repeat(64),facts:{version:1,berths:[{buildingId:id,installation:{family:'survey_balloon',tier:2,away,completedTotal:used,allowanceStart:'0'}}]}});
 expect(parseRaidAdvancedCapture(capture('0'),snapshot).presentation!.berths[0]!.installation!.presence).toBe('occupied');
 expect(parseRaidAdvancedCapture(capture(String(RAID_ADVANCED_PRESENTATION_V1.completedUsesPerInstall)),snapshot).presentation!.berths[0]!.installation!.presence).toBe('exhausted');
 expect(parseRaidAdvancedCapture(capture('1',true),snapshot).presentation!.berths[0]!.installation!.presence).toBe('away');
 expect(()=>parseRaidAdvancedCapture(capture(String(RAID_ADVANCED_PRESENTATION_V1.completedUsesPerInstall+1)),snapshot)).toThrow();
});
it('archives optional advanced facts without changing legacy bytes or starter grammar',()=>{
 const legacy:ReplayArchiveEnvelope={snapshot,armySnapshot:{},orders:[],seed:1,simVersion:17,events:[],result:{}};
 const encoded=encodeReplayTimeline(legacy,0);
 expect(encodeReplayTimeline({...legacy,advancedServicePresentation:undefined} as unknown as ReplayArchiveEnvelope,0)).toEqual(encoded);
 for(const advancedServicePresentation of [null,presentation])expect(decodeReplayTimeline(encodeReplayTimeline({...legacy,advancedServicePresentation},0)).advancedServicePresentation).toEqual(advancedServicePresentation);
 expect(()=>encodeReplayTimeline({...legacy,advancedServicePresentation:presentation,snapshot:{buildings:[]}},0)).toThrow();
});
it('invalidates paged suffixes on family, tier, presence and optional-state changes',()=>{
 const pages=new NativePresentationPages({cacheBytes:1000000,generations:20,timelines:20}),raid=randomUUID();
 const state={source:'live',status:'pending_orders',simVersion:17,raidProtocolVersion:2,clock:null,lastSequence:-1,snapshot,armySnapshot:{},commands:[],result:null};
 let previous:string|undefined;let n=1;
 for(const advanced of [undefined,null,presentation,{...presentation,berths:[{buildingId:id,installation:{family:'survey_balloon',tier:2,presence:'away'}}]},
  {...presentation,berths:[{buildingId:id,installation:{family:'cargo_cutter',tier:2,presence:'away'}}]},
  {...presentation,berths:[{buildingId:id,installation:{family:'cargo_cutter',tier:2,presence:'occupied'}}]}]){
  const revision=String(n++).repeat(64),value={...state,...advanced===undefined?{}:{advancedServicePresentation:advanced}};
  expect(pages.create('wallet',raid,revision,value,[],previous).parentRevision).toBeNull();
  const same=String(n++).repeat(64);expect(pages.create('wallet',raid,same,value,[],revision).parentRevision).toBe(revision);previous=same;
 }
 pages.close();
});
