/** @vitest-environment happy-dom
 * AUTHORED / UNRUN. Copy to ui/pk/army only with both reviewed action-owner proposals.
 * Uses the actual proposed owner components and mocks only transport/provider ports.
 */
import {act,isValidElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {useApp,type BaseStateDto} from '../../../state/store';
import {ArmyTrainingOwner,ArmyResearchOwner,type ArmyOwnerBinding,type ArmyTrainingModel,type ArmyResearchModel} from '../../screens/army';
import {readTrainingPurchase,saveTrainingPurchase,clearTrainingPurchase} from '../../screens/trainingPurchase';
import {readFreeFinish} from '../../screens/trainingFreeFinish';
import {TrainingPurchaseOwner,armyOwnerDispatch} from '../../screens/trainingPresets';
import {createPanelSession} from '../panelSession';
import {bus} from '../../../lib/events';
import type {TrainingQuote} from '@shardkeep/shared';
const port=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),put:vi.fn(),del:vi.fn(),trainingBegin:vi.fn(),researchBegin:vi.fn(),history:vi.fn()}));
vi.mock('../../../lib/api',async load=>({...await load<typeof import('../../../lib/api')>(),api:port}));
vi.mock('../../sheets',()=>({reloadBase:vi.fn(async()=>undefined)}));
vi.mock('../../../lib/audio',()=>({playSfx:vi.fn()}));
vi.mock('../../../lib/juice',()=>({haptic:vi.fn()}));
vi.mock('../../../lib/trainingFinish/context',()=>({useTrainingFinishView:()=>({begin:port.trainingBegin,openHistory:port.history,actionsEnabled:true,state:{busy:false,loaded:true},snapshotRevision:0})}));
vi.mock('../../../lib/researchSpeedup/context',()=>({useResearchSpeedupView:()=>({begin:port.researchBegin,openHistory:port.history,actionsEnabled:true,state:{busy:false,loaded:true},snapshotRevision:0})}));
const wallet='11111111111111111111111111111111',baseA='00000000-0000-4000-8000-000000000001',baseB='00000000-0000-4000-8000-000000000002';
const army=()=>({counts:{},levels:{bowman:1},research:[] as {troop:string;toLevel:number;finishesAt:string}[],queue:[1,2].map(n=>({id:String(n),troop:'bowman',startedAt:'2035-01-01T00:00:00.000Z',finishesAt:'2035-01-01T00:0'+n+':00.000Z',canCancel:true,refundShards:'1'})),rosterPts:0,campCapacityPts:200,barracksQueuePts:200,eliteUnlocks:{},features:{}});
const quote:TrainingQuote={requested:[{troop:'bowman',count:2}],queueable:[{troop:'bowman',count:2}],remaining:[],costShards:'10',availableShards:'100',camp:{used:0,after:2,capacity:200},barracks:{used:0,after:2,capacity:200},completionSec:120,consent:{version:2,queue:[],unitDurations:[{troop:'bowman',durationMs:60000}]},schedule:{version:2,mode:'sequential',serverNow:'2026-09-06T00:00:00.000Z',startsAt:'2026-09-06T00:00:00.000Z',finishesAt:'2026-09-06T00:02:00.000Z',waitMs:0,durationMs:120000}};
let host:HTMLDivElement,root:Root,binding:ArmyOwnerBinding,training:ArmyTrainingModel,research:ArmyResearchModel;
const flush=()=>act(async()=>{for(let i=0;i<10;i++)await Promise.resolve();});
const mountTrain=async()=>{await act(async()=>root.render(<ArmyTrainingOwner binding={binding}>{model=>{training=model;return <div>training owner{model.purchase.closeDialog}</div>;}}</ArmyTrainingOwner>));await flush();};
const mountResearch=async()=>{await act(async()=>root.render(<ArmyResearchOwner binding={binding}>{model=>{research=model;return <div>research owner{model.cancelDialog}{model.blockedReason}</div>;}}</ArmyResearchOwner>));await flush();};
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.resetAllMocks();localStorage.clear();
 useApp.getState().setAuth(wallet,true);useApp.getState().setSelectedBaseId(baseA,false);
 useApp.getState().setBase({baseId:baseA,player:{wallet,keepLevel:3},buildings:[{id:'forge',type:'forge',level:3,underConstruction:false}],jobs:[]} as unknown as BaseStateDto);
 port.get.mockImplementation(async(path:string)=>path.startsWith('/army/training/receipt')?{status:'unknown'}:army());port.post.mockImplementation(async(path:string)=>path.endsWith('/quote')?quote:{refundShards:'1'});
 binding={actionsEnabled:true,session:{dispatch:vi.fn((_kind,action)=>{action();return true;})}};
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('two immediate purchase confirmations post once and retain the exact key for explicit retry',async()=>{
 await mountTrain();expect(training.data).not.toBeNull();await act(async()=>training.purchase.preview([{troop:'bowman',count:2}]));
 let reject!:(error:Error)=>void;port.post.mockImplementation((path:string)=>path.endsWith('/batch')?new Promise((_resolve,no)=>{reject=no;}):Promise.resolve(quote));
 await act(async()=>{void training.purchase.confirm();void training.purchase.confirm();});
 const batches=()=>port.post.mock.calls.filter(([path])=>path==='/army/training/batch');expect(batches()).toHaveLength(1);const key=batches()[0]![1].idempotencyKey;expect(readTrainingPurchase(wallet)?.idempotencyKey).toBe(key);
 await act(async()=>reject(Error('response lost')));await flush();port.post.mockRejectedValueOnce(Error('still unknown'));await act(async()=>training.purchase.confirm());
 expect(batches()).toHaveLength(2);expect(batches()[1]![1].idempotencyKey).toBe(key);
});
it('cancels distinct original queue rows serially with one POST per tap',async()=>{
 let first!:(v:unknown)=>void;port.post.mockImplementationOnce(()=>new Promise(resolve=>{first=resolve;}));await mountTrain();expect(training.data?.queue).toHaveLength(2);
 await act(async()=>{training.cancelOne('bowman');training.cancelOne('bowman');});await flush();expect(port.post).toHaveBeenCalledTimes(1);
 await act(async()=>first({refundShards:'1'}));await flush();expect(port.post).toHaveBeenCalledTimes(2);expect(port.post.mock.calls[0]![0]).not.toBe(port.post.mock.calls[1]![0]);
 expect(binding.session.dispatch).toHaveBeenCalledWith('mutate',expect.any(Function));
});
it('capability loss while a cancel waits prevents its later POST',async()=>{
 let first!:(v:unknown)=>void;port.post.mockImplementationOnce(()=>new Promise(resolve=>{first=resolve;}));await mountTrain();await act(async()=>{training.cancelOne('bowman');training.cancelOne('bowman');});await flush();expect(port.post).toHaveBeenCalledTimes(1);
 binding={...binding,actionsEnabled:false};await mountTrain();await act(async()=>first({refundShards:'1'}));await flush();expect(port.post).toHaveBeenCalledTimes(1);
});
it('research serializes immediate re-entry and reads active research when reopened',async()=>{
 let finish!:(v:unknown)=>void;port.post.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));await mountResearch();expect(research.data).not.toBeNull();
 await act(async()=>{research.research('bowman');research.research('bowman');});expect(port.post).toHaveBeenCalledTimes(1);
 const active={...army(),research:[{troop:'bowman',toLevel:2,finishesAt:'2035-01-01T00:02:00.000Z'}]};port.get.mockResolvedValue(active);await act(async()=>finish({}));await flush();
 await act(async()=>root.render(<div/>));await mountResearch();expect(research.data?.research).toHaveLength(1);await act(async()=>research.research('bowman'));expect(port.post).toHaveBeenCalledTimes(1);
});
it('a retained old research owner is inert after a base switch while the new owner can act',async()=>{
 await mountResearch();const old=research;expect(old.data).not.toBeNull();await act(async()=>{useApp.getState().setSelectedBaseId(baseB,false);useApp.getState().setBase({...useApp.getState().base!,baseId:baseB});});await mountResearch();
 await act(async()=>old.research('bowman'));expect(port.post).not.toHaveBeenCalled();await act(async()=>research.research('bowman'));expect(port.post).toHaveBeenCalledTimes(1);expect(port.post.mock.calls[0]![1].baseId).toBe(baseB);
});
it('paid finishes call only the existing provider and never a local speedup POST',async()=>{
 await mountTrain();await act(async()=>training.finishAll());expect(port.trainingBegin).toHaveBeenCalledExactlyOnceWith({baseId:baseA});expect(port.post).not.toHaveBeenCalled();
 port.get.mockResolvedValue({...army(),research:[{troop:'bowman',toLevel:2,finishesAt:'2035-01-01T00:02:00.000Z'}]});await mountResearch();await act(async()=>research.finish('bowman'));
 expect(port.researchBegin).toHaveBeenCalledExactlyOnceWith({troop:'bowman',baseId:baseA});expect(port.post).not.toHaveBeenCalled();
});
it('live required capability and a denied session each refuse the original mutation',async()=>{
 await mountResearch();binding={...binding,actionsEnabled:false};await mountResearch();await act(async()=>research.research('bowman'));expect(port.post).not.toHaveBeenCalled();
 binding={actionsEnabled:true,session:{dispatch:vi.fn(()=>false)}};await mountResearch();await act(async()=>research.research('bowman'));expect(port.post).not.toHaveBeenCalled();
 binding={actionsEnabled:true,session:{dispatch:vi.fn((_kind,action)=>{action();return true;})}};await mountResearch();await act(async()=>research.research('bowman'));expect(port.post).toHaveBeenCalledTimes(1);
});
it('duplicate presentation requests for the same base never mount a second training action owner',async()=>{
 let bodies=0;await act(async()=>root.render(<><ArmyTrainingOwner binding={binding}>{()=>{bodies++;return <div>first owner</div>;}}</ArmyTrainingOwner><ArmyTrainingOwner binding={binding}>{()=>{bodies++;return <div>second owner</div>;}}</ArmyTrainingOwner></>));await flush();
 expect(host.textContent).toContain('first owner');expect(host.textContent).not.toContain('second owner');expect(host.textContent).toContain('Army actions are already open for this kingdom. Close this panel and reopen it after the other panel closes.');expect(port.get.mock.calls.filter(([path])=>path.startsWith('/army')&&!path.includes('/training/'))).toHaveLength(1);expect(bodies).toBeGreaterThan(0);
});

it('a refused purchase admission creates no saved key and preserves the reviewed quote',async()=>{
 await mountTrain();await act(async()=>training.purchase.preview([{troop:'bowman',count:2}]));expect(training.purchase.quote).not.toBeNull();port.post.mockClear();
 binding={actionsEnabled:true,session:{dispatch:vi.fn(()=>false)}};await mountTrain();await act(async()=>training.purchase.confirm());
 expect(port.post).not.toHaveBeenCalled();expect(readTrainingPurchase(wallet)).toBeNull();expect(training.purchase.quote).not.toBeNull();
 binding={actionsEnabled:false,session:{dispatch:vi.fn((_kind,action)=>{action();return true;})}};await mountTrain();await act(async()=>training.purchase.confirm());
 expect(port.post).not.toHaveBeenCalled();expect(readTrainingPurchase(wallet)).toBeNull();
});
it('a refused free-finish admission creates no saved key and does not freeze the next permitted attempt',async()=>{
 const dto={...army(),freeFinishAllOffer:{offer:'first_troops',consent:{version:2,maxCostKeep:'0',queue:army().queue.map(row=>({id:row.id,finishesAt:row.finishesAt}))}}};port.get.mockResolvedValue(dto);await mountTrain();
 binding={actionsEnabled:true,session:{dispatch:vi.fn(()=>false)}};await mountTrain();await act(async()=>training.finishAll());expect(port.post).not.toHaveBeenCalled();expect(readFreeFinish(wallet)).toBeNull();
 binding={actionsEnabled:true,session:{dispatch:vi.fn((_kind,action)=>{action();return true;})}};await mountTrain();port.post.mockRejectedValueOnce(Error('response lost'));await act(async()=>training.finishAll());await flush();
 expect(port.post).toHaveBeenCalledTimes(1);expect(readFreeFinish(wallet)?.idempotencyKey).toBe(port.post.mock.calls[0]![1].idempotencyKey);
});
it('a refused queued cancel changes neither the selected rows nor transport',async()=>{
 await mountTrain();binding={actionsEnabled:true,session:{dispatch:vi.fn(()=>false)}};await mountTrain();await act(async()=>training.cancelOne('bowman'));await flush();
 expect(training.pendingCancelIds.size).toBe(0);expect(port.post).not.toHaveBeenCalled();
});
it('untyped omitted bindings never fall through into the legacy action owner',async()=>{
 const absent=undefined as unknown as ArmyOwnerBinding;let seen=0;
 await act(async()=>root.render(<><ArmyTrainingOwner binding={absent}>{()=>{seen++;return null;}}</ArmyTrainingOwner><ArmyResearchOwner binding={absent}>{()=>{seen++;return null;}}</ArmyResearchOwner><TrainingPurchaseOwner binding={absent} onTrained={()=>undefined} onBusyChange={()=>undefined}>{()=>{seen++;return null;}}</TrainingPurchaseOwner></>));await flush();
 expect(seen).toBe(0);expect(port.get).not.toHaveBeenCalled();expect(port.post).not.toHaveBeenCalled();expect(host.textContent).toBe('');
});
it('a truthy non-boolean capability and unknown troop never authorize a research POST',async()=>{
 binding={...binding,actionsEnabled:'yes' as unknown as boolean};await mountResearch();expect(host.textContent).toBe('');expect(port.post).not.toHaveBeenCalled();
 binding={...binding,actionsEnabled:true};await mountResearch();await act(async()=>research.research('unknownTroop'));expect(port.post).not.toHaveBeenCalled();
 await act(async()=>research.research('bowman'));expect(port.post).toHaveBeenCalledTimes(1);
});

it('both paid-provider starts consult the live capability and the session before admission',async()=>{
 await mountTrain();binding={...binding,actionsEnabled:false};await mountTrain();await act(async()=>training.finishAll());expect(port.trainingBegin).not.toHaveBeenCalled();
 binding={actionsEnabled:true,session:{dispatch:vi.fn(()=>false)}};await mountTrain();await act(async()=>training.finishAll());expect(port.trainingBegin).not.toHaveBeenCalled();
 port.get.mockResolvedValue({...army(),research:[{troop:'bowman',toLevel:2,finishesAt:'2035-01-01T00:02:00.000Z'}]});await mountResearch();await act(async()=>research.finish('bowman'));expect(port.researchBegin).not.toHaveBeenCalled();
 binding={actionsEnabled:false,session:{dispatch:vi.fn((_kind,action)=>{action();return true;})}};await mountResearch();await act(async()=>research.finish('bowman'));expect(port.researchBegin).not.toHaveBeenCalled();expect(port.post).not.toHaveBeenCalled();
});
it('the original research cancel confirmation rechecks a later capability loss and admits one valid POST',async()=>{
 port.get.mockResolvedValue({...army(),research:[{troop:'bowman',toLevel:2,finishesAt:'2035-01-01T00:02:00.000Z',canCancel:true,refundShards:'1'}]});await mountResearch();
 await act(async()=>research.cancel('bowman',2,'1'));expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();expect(port.post).not.toHaveBeenCalled();
 binding={...binding,actionsEnabled:false};await mountResearch();const confirm=()=>[...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(b=>b.textContent?.includes('CANCEL RESEARCH ·'))!;
 await act(async()=>confirm().click());await flush();expect(port.post).not.toHaveBeenCalled();
 binding={...binding,actionsEnabled:true};await mountResearch();await act(async()=>research.cancel('bowman',2,'1'));await act(async()=>confirm().click());await flush();
 expect(port.post).toHaveBeenCalledExactlyOnceWith('/army/research/bowman/cancel',{baseId:baseA});
});
it('paused mutation still permits original saved-key recovery, while a refused recover session blocks it',async()=>{
 await mountTrain();await act(async()=>training.purchase.preview([{troop:'bowman',count:2}]));port.post.mockRejectedValueOnce(Error('response lost'));await act(async()=>training.purchase.confirm());const intent=training.purchase.pending!;expect(intent).not.toBeNull();
 binding={...binding,actionsEnabled:false};await mountTrain();port.get.mockImplementation(async()=>({version:1,idempotencyKey:intent.idempotencyKey,status:'unknown'}));port.get.mockClear();
 await act(async()=>training.purchase.recover(training.purchase.pending!));expect(port.get).toHaveBeenCalledExactlyOnceWith(`/army/training/receipt?idempotencyKey=${encodeURIComponent(intent.idempotencyKey)}`);expect(readTrainingPurchase(wallet)?.idempotencyKey).toBe(intent.idempotencyKey);
 port.get.mockClear();binding={actionsEnabled:false,session:{dispatch:vi.fn(()=>false)}};await mountTrain();await act(async()=>training.purchase.recover(training.purchase.pending!));expect(port.get).not.toHaveBeenCalled();
});

it('both original provider histories remain reachable while mutations are paused and obey recover admission',async()=>{
 binding={...binding,actionsEnabled:false};await mountTrain();await act(async()=>training.openHistory());expect(port.history).toHaveBeenCalledTimes(1);
 await mountResearch();await act(async()=>research.openHistory());expect(port.history).toHaveBeenCalledTimes(2);
 binding={actionsEnabled:false,session:{dispatch:vi.fn(()=>false)}};await mountResearch();await act(async()=>research.openHistory());expect(port.history).toHaveBeenCalledTimes(2);expect(port.post).not.toHaveBeenCalled();
});
it('retained free-finish stays visible while paused but resubmission needs mutation admission and reuses its key',async()=>{
 port.get.mockResolvedValue({...army(),freeFinishAllOffer:{offer:'first_troops',consent:{version:2,maxCostKeep:'0',queue:army().queue.map(row=>({id:row.id,finishesAt:row.finishesAt}))}}});await mountTrain();port.post.mockRejectedValue(Error('response lost'));await act(async()=>training.finishAll());await flush();
 const original=training.pendingFree!;expect(original).not.toBeNull();expect(training.freeStorageError).toBe(false);
 // ac225818 m4: a saved-key POST can first complete training, so it is mutation-class.
 binding={...binding,actionsEnabled:false};await mountTrain();await act(async()=>training.finishFree());await flush();
 expect(port.post).toHaveBeenCalledTimes(1);expect(training.pendingFree?.idempotencyKey).toBe(original.idempotencyKey);
 binding={...binding,actionsEnabled:true};await mountTrain();await act(async()=>training.finishFree());await flush();
 expect(port.post).toHaveBeenCalledTimes(2);expect(port.post.mock.calls[1]![1].idempotencyKey).toBe(original.idempotencyKey);expect(training.pendingFree?.idempotencyKey).toBe(original.idempotencyKey);
 expect(binding.session.dispatch).toHaveBeenCalledWith('mutate',expect.any(Function));
});

const failPurchase=async()=>{
 await mountTrain();await act(async()=>training.purchase.preview([{troop:'bowman',count:2}]));
 port.post.mockRejectedValueOnce(Error('response lost'));await act(async()=>training.purchase.confirm());
 const intent=training.purchase.pending!;expect(intent).not.toBeNull();
 port.get.mockImplementation(async()=>({version:1,idempotencyKey:intent.idempotencyKey,status:'unknown'}));return intent;
};
it('bound training close keeps the original consent dialog and only confirmation closes the saved key',async()=>{
 const intent=await failPurchase();port.post.mockClear();
 await act(async()=>{
  // @ts-expect-error the bound read API must never expose its old close argument.
  await training.purchase.recover(intent,true);
 });expect(port.post).not.toHaveBeenCalled();expect(document.querySelector('[aria-label="Close unaccepted training request"]')).toBeNull();
 await act(async()=>training.purchase.requestClose());expect(port.post).not.toHaveBeenCalled();
 const dialog=()=>document.querySelector('[aria-label="Close unaccepted training request"]')!;
 expect(dialog().textContent).toContain('permanently prevents this unaccepted request');
 const choice=(label:string)=>[...dialog().querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!;
 await act(async()=>choice('KEEP REQUEST').click());expect(port.post).not.toHaveBeenCalled();
 await act(async()=>training.purchase.requestClose());port.post.mockResolvedValueOnce({version:1,idempotencyKey:intent.idempotencyKey,status:'closed',closedAt:'2026-10-04T20:00:00.000Z'});
 const confirm=choice('CONFIRM CLOSE REQUEST');await act(async()=>{confirm.click();confirm.click();});
 expect(port.post).toHaveBeenCalledExactlyOnceWith('/army/training/close',{idempotencyKey:intent.idempotencyKey,confirmed:true});expect(readTrainingPurchase(wallet)).toBeNull();
});
it('recover storage events and close cannot clear the in-flight purchase guard or start another POST',async()=>{
 await mountTrain();await act(async()=>training.purchase.preview([{troop:'bowman',count:2}]));let reject!:(error:Error)=>void;
 port.post.mockImplementationOnce(()=>new Promise((_resolve,no)=>{reject=no;}));await act(async()=>{void training.purchase.confirm();});
 const intent=training.purchase.pending!;expect(intent).not.toBeNull();port.get.mockClear();
 await act(async()=>{void training.purchase.recover(intent);training.purchase.requestClose();window.dispatchEvent(new Event('storage'));void training.purchase.confirm();});
 expect(port.get).not.toHaveBeenCalled();expect(port.post.mock.calls.filter(([path])=>path==='/army/training/batch')).toHaveLength(1);
 expect(document.querySelector('[aria-label="Close unaccepted training request"]')).toBeNull();
 await act(async()=>reject(Error('response lost')));await flush();expect(port.post.mock.calls.filter(([path])=>path==='/army/training/batch')).toHaveLength(1);expect(readTrainingPurchase(wallet)?.idempotencyKey).toBe(intent.idempotencyKey);
});
it('a denied duplicate remains visible after retirement and a deliberate reopen claims the released slot',async()=>{
 const first=<ArmyTrainingOwner key="first" binding={binding}>{()=> <div>first owner</div>}</ArmyTrainingOwner>;
 const second=<ArmyTrainingOwner key="second" binding={binding}>{()=> <div>second owner</div>}</ArmyTrainingOwner>;
 await act(async()=>root.render(<>{first}{second}</>));await flush();expect(host.textContent).toContain('first owner');expect(host.textContent).toContain('Army actions are already open for this kingdom.');
 await act(async()=>root.render(<>{second}</>));await flush();expect(host.textContent).not.toContain('first owner');expect(host.textContent).not.toContain('second owner');expect(host.textContent).toContain('reopen it after the other panel closes.');
 await act(async()=>root.render(<div/>));await act(async()=>root.render(second));await flush();expect(host.textContent).toContain('second owner');expect(host.textContent).not.toContain('Army actions are already open');
});
it('paused mutation and a retired panel have distinct player-facing refusal messages',()=>{
 const action=vi.fn(),ref={current:{...binding,actionsEnabled:false}};
 expect(()=>armyOwnerDispatch(ref,()=>true,'mutate',action)).toThrow('New army actions are paused. You can still check saved requests.');
 expect(()=>armyOwnerDispatch({current:binding},()=>false,'mutate',action)).toThrow('This army panel is no longer current. Close it and reopen Army.');
 expect(action).not.toHaveBeenCalled();
});
it('a failed research request exposes its hold until an explicit fresh army read',async()=>{
 port.post.mockRejectedValueOnce(Error('response lost'));await mountResearch();await act(async()=>research.research('bowman'));await flush();
 expect(research.blockedReason).toBe('The previous research request needs a fresh army check. Use CHECK ARMY before trying again.');expect(host.textContent).toContain(research.blockedReason!);
 await act(async()=>research.research('bowman'));expect(port.post).toHaveBeenCalledTimes(1);
 await act(async()=>research.refresh());await flush();expect(research.blockedReason).toBeNull();await act(async()=>research.research('bowman'));expect(port.post).toHaveBeenCalledTimes(2);
});
it('research refusal exposes a reason for paused capability and unavailable troops',async()=>{
 binding={...binding,actionsEnabled:false};await mountResearch();await act(async()=>research.research('bowman'));
 expect(research.blockedReason).toBe('New army actions are paused. You can still check saved requests.');expect(port.post).not.toHaveBeenCalled();
 binding={...binding,actionsEnabled:true};await mountResearch();await act(async()=>research.research('unknownTroop'));
 expect(research.blockedReason).toBe('This troop is not available for research. Check the current army and its requirements.');expect(port.post).not.toHaveBeenCalled();
});
it('a refused free-finish refresh does not mark storage failed or block a later paid provider start',async()=>{
 await mountTrain();binding={actionsEnabled:true,session:{dispatch:vi.fn(()=>false)}};await mountTrain();await act(async()=>training.finishFree());
 expect(training.freeStorageError).toBe(false);expect(port.post).not.toHaveBeenCalled();
 binding={actionsEnabled:true,session:{dispatch:vi.fn((_kind,action)=>{action();return true;})}};await mountTrain();await act(async()=>training.finishAll());expect(port.trainingBegin).toHaveBeenCalledExactlyOnceWith({baseId:baseA});
});
it('a bound storage failure exposes retrySavedPurchase without requiring a remount',async()=>{
 const intent={version:1 as const,wallet,baseId:baseA,idempotencyKey:'10000000-0000-4000-8000-000000000001',composition:quote.queueable,confirmedCostShards:quote.costShards,consent:quote.consent};saveTrainingPurchase(intent);
 // happy-dom binds Storage methods onto the localStorage instance at first use, so a Storage.prototype spy installed
 // after that never runs (night 2026-10-06: storageError stayed false). Spy the instance the owner actually reads.
 const get=Storage.prototype.getItem;let fail=true;vi.spyOn(localStorage,'getItem').mockImplementation(function(this:Storage,key:string){if(fail&&key.startsWith('pkw:training-purchase:'))throw Error('storage held');return get.call(this,key);});
 await mountTrain();expect(training.purchase.storageError).toBe(true);fail=false;port.get.mockImplementation(async()=>({version:1,idempotencyKey:intent.idempotencyKey,status:'unknown'}));
 await act(async()=>training.purchase.retrySavedPurchase());await flush();expect(training.purchase.storageError).toBe(false);expect(training.purchase.pending?.idempotencyKey).toBe(intent.idempotencyKey);expect(binding.session.dispatch).toHaveBeenCalledWith('recover',expect.any(Function));
});
it('old training and purchase owners cannot POST or save keys after a base switch',async()=>{
 port.get.mockResolvedValue({...army(),freeFinishAllOffer:{offer:'first_troops',consent:{version:2,maxCostKeep:'0',queue:army().queue.map(row=>({id:row.id,finishesAt:row.finishesAt}))}}});await mountTrain();await act(async()=>training.purchase.preview([{troop:'bowman',count:2}]));const old=training;expect(old.purchase.quote).not.toBeNull();port.post.mockClear();
 await act(async()=>{useApp.getState().setSelectedBaseId(baseB,false);useApp.getState().setBase({...useApp.getState().base!,baseId:baseB});});await mountTrain();
 await act(async()=>{void old.purchase.confirm();old.cancelOne('bowman');old.finishFree();});await flush();expect(port.post).not.toHaveBeenCalled();expect(readTrainingPurchase(wallet)).toBeNull();expect(readFreeFinish(wallet)).toBeNull();
 await act(async()=>training.purchase.preview([{troop:'bowman',count:2}]));port.post.mockRejectedValueOnce(Error('response lost'));await act(async()=>training.purchase.confirm());expect(readTrainingPurchase(wallet)?.baseId).toBe(baseB);
});
it('the actual PanelSession invokes admitted callbacks synchronously and retirement refuses them',()=>{
 const session=createPanelSession({panel:{kind:'army',featureId:'army.train'},controlled:true,isCurrent:()=>true,canMutate:()=>true,canRecover:()=>true});const unmount=session.mount();
 const order:string[]=[];const value=armyOwnerDispatch({current:{actionsEnabled:true,session}},()=>true,'mutate',()=>{order.push('action');return 'result';});order.push('returned');
 expect(value).toBe('result');expect(order).toEqual(['action','returned']);unmount();
 expect(()=>armyOwnerDispatch({current:{actionsEnabled:true,session}},()=>true,'mutate',()=>order.push('stale'))).toThrow('This army panel is no longer current. Close it and reopen Army.');expect(order).toEqual(['action','returned']);
});

// 6844a8f9 N1–N4. Additive v2.1 contracts; all v2 cases remain intact.
const otherSavedPurchase=()=>({version:1 as const,wallet,baseId:baseA,idempotencyKey:'10000000-0000-4000-8000-000000000099',composition:[{troop:'bowman' as const,count:1}],confirmedCostShards:'5',consent:quote.consent});
const unknownPurchase=(key:string)=>({version:1 as const,idempotencyKey:key,status:'unknown' as const});
it('an empty queueable quote refuses before minting or saving a key and reports why',async()=>{
 const empty:TrainingQuote={...quote,queueable:[],remaining:quote.requested.map(row=>({...row,reason:'Queue full'})),costShards:'0',completionSec:0,consent:{version:2,queue:[],unitDurations:[]},schedule:{...quote.schedule!,finishesAt:quote.schedule!.startsAt,durationMs:0}};
 port.post.mockResolvedValue(empty);await mountTrain();await act(async()=>training.purchase.preview(quote.requested));expect(training.purchase.quote?.queueable).toEqual([]);
 port.post.mockClear();const key=vi.spyOn(crypto,'randomUUID');await act(async()=>training.purchase.confirm());
 expect(key).not.toHaveBeenCalled();expect(port.post).not.toHaveBeenCalled();expect(readTrainingPurchase(wallet)).toBeNull();expect(training.purchase.storageError).toBe(false);expect(training.purchase.message).toBe('No troops can be queued from this review. Check the army and choose another batch.');
});
it('a storage event retaining another original clears the unrelated open quote without submitting it',async()=>{
 await mountTrain();await act(async()=>training.purchase.preview(quote.requested));expect(training.purchase.quote?.queueable).toEqual(quote.queueable);
 const saved=otherSavedPurchase();saveTrainingPurchase(saved);port.get.mockResolvedValue(unknownPurchase(saved.idempotencyKey));port.post.mockClear();
 await act(async()=>window.dispatchEvent(new Event('storage')));await flush();
 expect(training.purchase.quote).toBeNull();expect(training.purchase.pending?.composition).toEqual(saved.composition);expect(training.purchase.pending?.idempotencyKey).toBe(saved.idempotencyKey);expect(port.post).not.toHaveBeenCalled();
});
it('confirm discovering a saved original clears the unrelated quote and only checks that original',async()=>{
 await mountTrain();await act(async()=>training.purchase.preview(quote.requested));const saved=otherSavedPurchase();saveTrainingPurchase(saved);port.get.mockResolvedValue(unknownPurchase(saved.idempotencyKey));port.post.mockClear();
 await act(async()=>training.purchase.confirm());await flush();
 expect(training.purchase.quote).toBeNull();expect(training.purchase.pending?.idempotencyKey).toBe(saved.idempotencyKey);expect(port.get).toHaveBeenCalledWith(`/army/training/receipt?idempotencyKey=${saved.idempotencyKey}`);expect(port.post).not.toHaveBeenCalled();
});
it('a same-key storage reread keeps close consent usable without changing its original destination',async()=>{
 const intent=await failPurchase();await act(async()=>training.purchase.requestClose());port.post.mockClear();
 await act(async()=>window.dispatchEvent(new Event('storage')));await flush();expect(training.purchase.pending).not.toBe(intent);expect(training.purchase.pending?.idempotencyKey).toBe(intent.idempotencyKey);expect(training.purchase.pending?.baseId).toBe(intent.baseId);
 port.post.mockResolvedValueOnce({version:1,idempotencyKey:intent.idempotencyKey,status:'closed',closedAt:'2026-10-04T21:00:00.000Z'});
 const close=[...document.querySelectorAll<HTMLButtonElement>('[aria-label="Close unaccepted training request"] button')].find(b=>b.textContent==='CONFIRM CLOSE REQUEST')!;
 expect(close).toBeDefined();await act(async()=>close.click());expect(port.post).toHaveBeenCalledExactlyOnceWith('/army/training/close',{idempotencyKey:intent.idempotencyKey,confirmed:true});expect(readTrainingPurchase(wallet)).toBeNull();
});
it('close consent refuses a different retained original with a visible message and no close POST',async()=>{
 const intent=await failPurchase();await act(async()=>training.purchase.requestClose());clearTrainingPurchase(intent);const saved=otherSavedPurchase();saveTrainingPurchase(saved);port.get.mockResolvedValue(unknownPurchase(saved.idempotencyKey));port.post.mockClear();
 await act(async()=>window.dispatchEvent(new Event('storage')));await flush();expect(training.purchase.pending?.idempotencyKey).toBe(saved.idempotencyKey);
 const close=[...document.querySelectorAll<HTMLButtonElement>('[aria-label="Close unaccepted training request"] button')].find(b=>b.textContent==='CONFIRM CLOSE REQUEST')!;
 await act(async()=>close.click());expect(port.post).not.toHaveBeenCalled();expect(document.querySelector('[aria-label="Close unaccepted training request"]')).toBeNull();expect(training.purchase.message).toBe('The saved training request changed. Check it before closing a request.');expect(readTrainingPurchase(wallet)?.idempotencyKey).toBe(saved.idempotencyKey);
});
it('research cancel confirmation while paused reports the pause and posts nothing',async()=>{
 port.get.mockResolvedValue({...army(),research:[{troop:'bowman',toLevel:2,finishesAt:'2035-01-01T00:02:00.000Z'}]});await mountResearch();await act(async()=>research.cancel('bowman',2,'1'));
 binding={...binding,actionsEnabled:false};await mountResearch();const confirm=[...document.querySelectorAll<HTMLButtonElement>('[aria-label="Confirm cancelling this research"] button')].find(b=>b.textContent?.startsWith('CANCEL RESEARCH'))!;
 expect(confirm).toBeDefined();await act(async()=>confirm.click());expect(port.post).not.toHaveBeenCalled();expect(research.blockedReason).toBe('New army actions are paused. You can still check saved requests.');expect(host.textContent).toContain(research.blockedReason!);
});
it('a retained research cancel confirmation reports a retired panel without sending',async()=>{
 port.get.mockResolvedValue({...army(),research:[{troop:'bowman',toLevel:2,finishesAt:'2035-01-01T00:02:00.000Z'}]});await mountResearch();await act(async()=>research.cancel('bowman',2,'1'));
 const dialog=research.cancelDialog;if(!isValidElement<{intent:{onConfirm:()=>void}}>(dialog))throw Error('Expected original cancellation consent');const confirm=dialog.props.intent.onConfirm;
 await act(async()=>{useApp.getState().setSelectedBaseId(baseB,false);useApp.getState().setBase({...useApp.getState().base!,baseId:baseB});});await mountResearch();const toast=vi.spyOn(bus,'emit');
 await act(async()=>confirm());expect(port.post).not.toHaveBeenCalled();expect(toast).toHaveBeenCalledWith('ui:toast',{msg:'This army panel is no longer current. Close it and reopen Army.'});
});
it('a purchase saved for another kingdom refuses confirmation with actionable copy',async()=>{
 const saved={...otherSavedPurchase(),baseId:baseB};saveTrainingPurchase(saved);port.get.mockImplementation(async(path:string)=>path.startsWith('/army/training/receipt')?unknownPurchase(saved.idempotencyKey):army());await mountTrain();
 expect(training.purchase.pending?.baseId).toBe(baseB);await act(async()=>training.purchase.confirm());expect(port.post).not.toHaveBeenCalled();expect(readTrainingPurchase(wallet)?.idempotencyKey).toBe(saved.idempotencyKey);expect(training.purchase.message).toBe('This saved training request belongs to another kingdom. Select its original kingdom to retry it.');
});
