import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {parseRaidStarterPresentation} from '../src/game/raidStarterPresentation';
import {encodeReplayTimeline,decodeReplayTimeline,type ReplayArchiveEnvelope} from '../src/game/raidReplayArchive';
import {NativePresentationPages} from '../src/native/paging';

const id='10000000-0000-4000-8000-000000000001';
const snapshot={buildings:[{id,type:'berth',level:1}]};
const presentation={version:1 as const,berths:[{buildingId:id,installation:{family:'starter' as const,presence:'away' as const}}]};
it('preserves legacy omission and captured unknown without constructing a vessel',()=>{
 expect(parseRaidStarterPresentation(undefined,{})).toBeUndefined();expect(parseRaidStarterPresentation(null,snapshot)).toBeNull();
 expect(parseRaidStarterPresentation({version:1,berths:[{buildingId:id,installation:null}]},snapshot)).toEqual({version:1,berths:[{buildingId:id,installation:null}]});
});
it('rejects invented families, extra fields, coercion and unsorted/duplicate identities',()=>{
 for(const value of [false,{},'null',{...presentation,version:'1'},{...presentation,actor:'private'},
  {version:1,berths:[{buildingId:id,installation:{family:'advanced',presence:'away'}}]},
  {version:1,berths:[...presentation.berths,...presentation.berths]},
  {version:1,berths:[{buildingId:'20000000-0000-4000-8000-000000000002',installation:null},...presentation.berths]},
 ])expect(()=>parseRaidStarterPresentation(value,snapshot)).toThrow();
});
it('requires complete frozen berth closure, actual positive installed level and no unfinished rows',()=>{
 expect(parseRaidStarterPresentation(presentation,snapshot)).toEqual(presentation);
 for(const other of [{buildings:[]},{buildings:[{id:randomUUID(),type:'berth',level:1}]},
  {buildings:[{id,type:'berth',level:0}]},{buildings:[{id,type:'berth',level:1,underConstruction:true}]},
  {buildings:[...snapshot.buildings,...snapshot.buildings]},
 ])expect(()=>parseRaidStarterPresentation(presentation,other)).toThrow();
});
it('archives exact original facts outside simulator input while retaining byte-identical legacy omission',()=>{
 const legacy:ReplayArchiveEnvelope={snapshot,armySnapshot:{},orders:[],seed:1,simVersion:17,events:[],result:{}};
 const original=encodeReplayTimeline(legacy,0);expect(decodeReplayTimeline(original)).not.toHaveProperty('servicePresentation');
 // JSON callers may omit via undefined even though typed writers must omit the
 // optional property; this runtime wire check must preserve historical bytes.
 expect(encodeReplayTimeline({...legacy,servicePresentation:undefined} as unknown as ReplayArchiveEnvelope,0)).toEqual(original);
 const captured=encodeReplayTimeline({...legacy,servicePresentation:presentation},0);
 expect(captured.sha256).not.toBe(original.sha256);expect(decodeReplayTimeline(captured).servicePresentation).toEqual(presentation);
 expect(decodeReplayTimeline(captured).snapshot).toEqual(snapshot);
 expect(decodeReplayTimeline(encodeReplayTimeline({...legacy,servicePresentation:null},0)).servicePresentation).toBeNull();
 expect(()=>encodeReplayTimeline({...legacy,snapshot:{buildings:[]},servicePresentation:presentation},0)).toThrow();
});
it('binds paged parent identity to presence including absent versus explicit null',()=>{
 const pages=new NativePresentationPages({cacheBytes:1000000,generations:20,timelines:20});
 const raidId=randomUUID(),state={source:'live',status:'pending_orders',simVersion:17,raidProtocolVersion:2,clock:null,
  lastSequence:-1,snapshot,armySnapshot:{},commands:[],result:null};
 const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64),d='d'.repeat(64),e='e'.repeat(64);
 expect(pages.create('wallet',raidId,a,state,[]).parentRevision).toBeNull();
 expect(pages.create('wallet',raidId,b,{...state,servicePresentation:null},[],a).parentRevision).toBeNull();
 expect(pages.create('wallet',raidId,c,{...state,servicePresentation:presentation},[],b).parentRevision).toBeNull();
 expect(pages.create('wallet',raidId,d,{...state,servicePresentation:presentation},[],c).parentRevision).toBe(c);
 expect(pages.create('wallet',raidId,e,{...state,servicePresentation:{...presentation,berths:[{buildingId:id,installation:null}]}},[],d).parentRevision).toBeNull();
 expect(()=>pages.create('wallet',raidId,'f'.repeat(64),{...state,snapshot:{buildings:[]},servicePresentation:presentation},[])).toThrow();
 pages.close();
});
