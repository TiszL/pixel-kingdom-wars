import {IDBFactory} from 'fake-indexeddb';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DivineFragmentsController,type DivineFragmentsPorts} from './controller';
import {DivineFragmentsJournalStore,parseDivineFragmentsCommand,parseDivineFragmentsJournal,type DivineFragmentsCommand as Command} from './journal';
import {award,clanAward,id,identity,proof,read} from './fixtures.test-support';

let factory:IDBFactory,store:DivineFragmentsJournalStore,c:DivineFragmentsController,ports:DivineFragmentsPorts;
let selected:string,allowed:boolean,nextKey:number,current:ReturnType<typeof clanAward>,done:Set<string>;
const posts=()=>vi.mocked(ports.original).mock.calls.filter(([,method])=>method==='POST');
const command=(value:unknown)=>({kind:'delivery',consent:{version:1,wallet:identity.wallet,eventId:current.eventId,request:{baseId:id(1),idempotencyKey:id(2)},award:value}});
beforeEach(()=>{
 factory=new IDBFactory();store=new DivineFragmentsJournalStore(identity,factory);selected=id(1);allowed=true;nextKey=100;current=clanAward(3,8000n);done=new Set();
 ports={get:vi.fn(async(path,guard)=>{guard();if(path.startsWith('/divine-fragments/awards'))return {version:1,wallet:identity.wallet,rows:[{award,delivery:null},{award:current,delivery:null}],nextCursor:null};
   if(path===`/divine-fragments/events/${current.eventId}`)return {version:1,wallet:identity.wallet,eventId:current.eventId,enrolled:true,settled:true,award:current,delivery:null};return read(path);}),
  original:vi.fn(async(original,method,guard,retain)=>{guard();const key=original.consent.request.idempotencyKey;if(method==='POST'){
   const saved=await store.read();expect(saved.operation?.command).toEqual(original);expect(saved.operation?.attemptRevision).toBe(saved.revision);done.add(key);}
   const result=proof(original,done.has(key));await retain(result);guard();return result;}),
  capture:base=>()=>{if(base&&(!allowed||base!==selected))throw Error('Changed destination or admission');},lock:async(_name,run)=>run(),key:()=>id(nextKey++)};
 c=new DivineFragmentsController(store,ports);
});
afterEach(async()=>{await store.close();});

it('keeps the old individual archive exactly intact beside a clan archive across IndexedDB restart',async()=>{
 await c.beginDelivery(id(1),award);await c.confirm();await c.archive();expect(c.snapshot().error).toBeNull();
 const original=JSON.stringify((await store.read()).archives[0]);
 await c.beginDelivery(id(1),current);expect(posts()).toHaveLength(1);expect(c.snapshot().review?.quantity).toBe(current.net);
 expect((await store.read()).operation?.command).toEqual({...command(current),consent:{...command(current).consent,request:{baseId:id(1),idempotencyKey:id(101)}}});
 await c.confirm();await c.archive();expect(c.snapshot().error).toBeNull();await store.close();
 store=new DivineFragmentsJournalStore(identity,factory);c=new DivineFragmentsController(store,ports);await c.open();
 const journal=await store.read();expect(journal.version).toBe(1);expect(journal.archives).toHaveLength(2);expect(JSON.stringify(journal.archives[0])).toBe(original);
 expect(journal.archives[1]?.operation.command.kind==='delivery'&&journal.archives[1].operation.command.consent.award).toEqual(current);
 expect(parseDivineFragmentsJournal(JSON.parse(JSON.stringify(journal)),identity)).toEqual(journal);
 await c.checkArchived(id(100));await c.checkArchived(id(101));expect(c.snapshot().error).toBeNull();expect(posts()).toHaveLength(2);
 expect(JSON.stringify((await store.read()).archives[0])).toBe(original);
});

it.each([
 ['missing clan',(a:ReturnType<typeof clanAward>)=>{const {clan:unused,...rest}=a;void unused;return rest;}],
 ['unknown clan field',(a:ReturnType<typeof clanAward>)=>({...a,clan:{...a.clan,redirectWallet:identity.wallet}})],
 ['individual site with clan',(a:ReturnType<typeof clanAward>)=>({...a,site:award.site})],
 ['foreign tournament projection',(a:ReturnType<typeof clanAward>)=>({...a,clan:{...a.clan,tournamentDomain:{...a.clan.tournamentDomain,economyProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'}}})],
 ['caller quantity',(a:ReturnType<typeof clanAward>)=>({...a,net:String(BigInt(a.net)+1n)})],
] as const)('saved command rejects %s rather than silently treating it as an individual award',(_name,change)=>{
 expect(()=>parseDivineFragmentsCommand(command(change(current)))).toThrow();
 expect(parseDivineFragmentsCommand(command(current))).toEqual(command(current));
});

it.each(['rosterHash','entryId','clanId','treasury','sourceHash'] as const)('a changed valid %s cannot replace the saved clan original at confirmation',async field=>{
 await c.beginDelivery(id(1),current);const original=(await store.read()).operation!.command;
 if(field==='sourceHash')current={...current,sourceHash:'d'.repeat(64)};
 else if(field==='treasury')current={...current,clan:{...current.clan,tournamentDomain:{...current.clan.tournamentDomain,treasury:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'}}};
 else current={...current,clan:{...current.clan,[field]:field==='rosterHash'?'d'.repeat(64):id(99)}};
 // Each substituted award is valid alone. Equality to the saved original is essential.
 expect(()=>parseDivineFragmentsCommand(command(current))).not.toThrow();
 await c.confirm();expect(posts()).toHaveLength(0);expect(c.snapshot().error).toContain('source changed');
 expect((await store.read()).operation?.command).toEqual(original);
});

it('lost clan delivery acknowledgement recovers the original destination while paused after transfer',async()=>{
 const original=ports.original;ports.original=vi.fn(async(...args:Parameters<DivineFragmentsPorts['original']>)=>{if(args[1]==='POST'){done.add(args[0].consent.request.idempotencyKey);throw Error('Lost acknowledgement');}return original(...args);});
 await c.beginDelivery(id(1),current);await c.confirm();const saved=(await store.read()).operation!.command;
 expect((await store.read()).operation?.proof).toBeNull();
 selected=id(9);allowed=false;c=new DivineFragmentsController(store,ports);await c.open();
 expect(c.snapshot().error).toBeNull();expect((await store.read()).operation?.proof).toEqual(proof(saved,true));
 await c.archive();expect((await store.read()).archives[0]?.operation.command).toEqual(saved);expect(posts()).toHaveLength(1);
});

it('unknown clan outcome retries only after fresh explicit review and reuses the full original key and roster',async()=>{
 let lose=true;const original=ports.original;ports.original=vi.fn(async(...args:Parameters<DivineFragmentsPorts['original']>)=>{if(args[1]==='POST'&&lose){lose=false;throw Error('No reply');}return original(...args);});
 await c.beginDelivery(id(1),current);await c.confirm();await c.archive();expect(c.snapshot().error).toContain('Outcome unknown');
 c=new DivineFragmentsController(store,ports);await c.open();await c.confirm();expect(posts()).toHaveLength(1);
 await c.reviewOriginal();await c.confirm();expect(c.snapshot().error).toBeNull();expect(posts()).toHaveLength(2);expect(posts()[0]![0]).toEqual(posts()[1]![0]);
});

it('accepted clan custody cannot lose its proof or replace its original roster through journal CAS',async()=>{
 await c.beginDelivery(id(1),current);await c.confirm();const journal=await store.read();
 const saved=journal.operation!.command;if(saved.kind!=='delivery')throw Error('Expected delivery');
 const replaced:Command={kind:'delivery',consent:{...saved.consent,award:{...current,clan:{...current.clan,rosterHash:'d'.repeat(64)}}}};
 await expect(store.compareAndSet(journal.revision,old=>({...old,operation:{...old.operation!,command:replaced}}))).rejects.toThrow('original fragment command changed');
 await expect(store.compareAndSet(journal.revision,old=>({...old,operation:{...old.operation!,proof:null}}))).rejects.toThrow('acceptance changed');
 expect(await store.read()).toEqual(journal);
});
