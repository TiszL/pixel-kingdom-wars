/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { captureBaseBalanceCommit } from '../../state/baseSnapshot';
import { useApp } from '../../state/store';
import { api, ApiError } from '../api';
import { builderJobSpeedupIdentity, createBuilderJobSpeedupBrowserPorts, refreshBuilderJobSpeedupSnapshot } from './browser';
import { builder, id, identity } from './fixtures.test-support';
const funds=()=>({keep:'100',gems:'100',shards:'500',keepRate:1,features:{gameCurrency:{version:1,exactSpendCurrency:1},gems:{version:1,receipts:1}}});
const directory=()=>({enabled:true,capabilities:{baseScopedReads:true,baseScopedMutations:true},bases:[{id:id(1),status:'active',slot:1}]});
const base=()=>({baseId:id(1),player:{wallet:identity.wallet,keepLevel:5},buildings:[],army:[],obstacles:[],features:{builderJobSpeedup:{version:1,receipts:1}},jobs:[{
  id:builder.jobId,kind:builder.consent.kind,buildingId:builder.consent.buildingId,obstacleId:builder.consent.obstacleId,
  startedAt:builder.consent.startedAt,finishesAt:builder.consent.finishesAt,finishCostKeep:'100',paidFinishQuote:structuredClone(builder.consent),canCancel:true,refundShards:'100',
}]});
let snapshot:ReturnType<typeof base>,balances:ReturnType<typeof funds>,dirs:ReturnType<typeof directory>;
const read=async(path:string):Promise<unknown>=>{
  if(path==='/me')return {wallet:identity.wallet};if(path==='/bases')return dirs;
  if(path.startsWith('/base?'))return snapshot;if(path.startsWith('/balances?'))return balances;
  throw new Error(`Unexpected GET ${path}`);
};
const setup=()=>{const page={active:true,visible:true,epoch:0,actionsEnabled:true},scoped=builderJobSpeedupIdentity(identity.wallet);
  return {page,scoped,ports:createBuilderJobSpeedupBrowserPorts({identity:scoped,lifecycle:()=>page})};};
beforeEach(()=>{
  vi.spyOn(authCookies,'assertSession').mockReturnValue('session');vi.spyOn(authCookies,'assertResponse').mockImplementation(()=>undefined);
  useApp.getState().setAuth(identity.wallet,true);useApp.setState({selectedBaseId:id(1),baseSelectionEpoch:0});
  snapshot=base();balances=funds();dirs=directory();vi.spyOn(api,'get').mockImplementation(async path=>structuredClone(await read(path)) as never);
});
afterEach(()=>{vi.restoreAllMocks();useApp.getState().setAuth(null);});
const prepare=(ports:ReturnType<typeof setup>['ports'])=>ports.prepare({jobId:builder.jobId,baseId:builder.baseId},builder.idempotencyKey,ports.capture(builder.baseId));
describe('builder original server quote and currency',()=>{
  it('chooses one whole currency from current balances and never reprices using the browser clock',async()=>{
    const {ports}=setup();vi.spyOn(Date,'now').mockReturnValue(0);expect(await prepare(ports)).toEqual(builder);
    balances.gems='99';expect((await prepare(ports)).expectedCurrency).toBe('KEEP');balances.keep='99';await expect(prepare(ports)).rejects.toThrow('Neither');
  });
  it.each(['currency','feature','version-string','quote-string','missing-quote','price-number','extra-consent','duplicate-job'] as const)('fails closed on %s',async kind=>{
    const {ports}=setup(),job=snapshot.jobs[0]!;
    if(kind==='currency')balances.features={} as never;
    if(kind==='feature')snapshot.features={} as never;
    if(kind==='version-string')snapshot.features.builderJobSpeedup.version='1' as never;
    if(kind==='quote-string')job.paidFinishQuote.version='1' as never;
    if(kind==='missing-quote')delete (job as Partial<typeof job>).paidFinishQuote;
    if(kind==='price-number')job.finishCostKeep=100 as never;
    if(kind==='extra-consent')Object.assign(job.paidFinishQuote,{unexpected:true});
    if(kind==='duplicate-job')snapshot.jobs.push(structuredClone(job));
    await expect(prepare(ports)).rejects.toThrow();
  });
  it.each(['build','zero','unknown-free'] as const)('cannot turn %s initial construction into a paid confirmation',async kind=>{
    const {ports}=setup(),job=snapshot.jobs[0]!;if(kind==='zero')job.finishCostKeep='0';else job.kind='build' as never;
    if(kind==='unknown-free')delete (job as Partial<typeof job>).finishCostKeep;
    await expect(prepare(ports)).rejects.toThrow('no paid finish');await expect(ports.validate(builder,ports.capture(id(1)))).rejects.toThrow('no paid finish');
  });
  it('only lower price with the identical target/start/deadline can validate original consent',async()=>{
    const {ports}=setup(),original=structuredClone(builder);snapshot.jobs[0]!.paidFinishQuote.maxCostKeep='80';snapshot.jobs[0]!.finishCostKeep='80';balances.gems='80';
    await expect(ports.validate(builder,ports.capture(id(1)))).resolves.toBeUndefined();expect(builder).toEqual(original);
  });
  it.each(['job','kind','building','deadline','start','price','missing','currency'] as const)('rejects %s drift instead of retargeting the saved paid job',async kind=>{
    const {ports}=setup(),job=snapshot.jobs[0]!;
    if(kind==='job')job.id=id(8);
    if(kind==='kind'){job.kind='repair';job.paidFinishQuote.kind='repair';}
    if(kind==='building'){job.buildingId=id(7);job.paidFinishQuote.buildingId=id(7);}
    if(kind==='deadline'){job.finishesAt='2026-09-21T12:00:01.000Z';job.paidFinishQuote.finishesAt=job.finishesAt;}
    if(kind==='start'){job.startedAt='2026-09-21T11:00:01.000Z';job.paidFinishQuote.startedAt=job.startedAt;}
    if(kind==='price'){job.finishCostKeep='101';job.paidFinishQuote.maxCostKeep='101';}
    if(kind==='missing')snapshot.jobs=[];
    if(kind==='currency')balances.gems='0';
    await expect(ports.validate(builder,ports.capture(id(1)))).rejects.toThrow();expect(builder.expectedCurrency).toBe('GEMS');
  });
  it.each(['kind','target','time','price'] as const)('requires the quoted %s to agree with the outer job DTO',async field=>{
    const {ports}=setup(),job=snapshot.jobs[0]!;
    if(field==='kind')job.kind='repair';if(field==='target')job.buildingId=id(7);if(field==='time')job.finishesAt='2026-09-21T12:00:01.000Z';if(field==='price')job.finishCostKeep='99';
    await expect(prepare(ports)).rejects.toThrow('differs');
  });
  it('requires explicitly owned selected base and stable capabilities',async()=>{
    const {ports}=setup();dirs.capabilities.baseScopedMutations=false;await expect(prepare(ports)).rejects.toThrow('unavailable');
    dirs.capabilities.baseScopedMutations=true;dirs.bases[0]!.status='inactive';await expect(prepare(ports)).rejects.toThrow('unavailable');
    useApp.setState({selectedBaseId:null});await expect(ports.prepare({jobId:builder.jobId,baseId:null},builder.idempotencyKey,ports.capture(null))).rejects.toThrow('unavailable');
  });
  it('guards actual enqueue after account/base/visibility and keeps receipt recovery independent of action gates',async()=>{
    const {ports,page}=setup(),guard=ports.capture(id(1));vi.spyOn(api,'postRaw').mockResolvedValue({});await ports.post(`/base/jobs/${builder.jobId}/speedup`,{},'GEMS',guard);
    const call=vi.mocked(api.postRaw).mock.calls[0]!;expect(call[2]?.expectedCurrency).toBe('GEMS');useApp.setState({baseSelectionEpoch:2});expect(call[2]?.isCurrent).toThrow();
    const history=ports.capture();page.actionsEnabled=false;expect(history).not.toThrow();expect(ports.capture(id(1))).toThrow();page.visible=false;expect(history).toThrow();
  });
  it('classifies only exact first-response status/code and matching currency details',()=>{
    const {ports}=setup();for(const[status,code]of[[404,'BUILDER_JOB_NOT_RUNNING'],[409,'BUILDER_SPEEDUP_QUOTE_CHANGED'],[409,'BUILDER_SPEEDUP_SCOPE_CHANGED'],[404,'BASE_NOT_OWNED'],[409,'BASE_ID_REQUIRED'],[409,'DEED_OWNERSHIP_CHANGED'],[423,'BASE_BEING_RAIDED'],[503,'DEED_AUTHORITY_UNAVAILABLE']]as const){
      expect(ports.definitiveRefusal(new ApiError(status,'refused',code),builder)?.code).toBe(code);expect(ports.definitiveRefusal(new ApiError(status+1,'refused',code),builder)).toBeNull();}
    expect(ports.definitiveRefusal(new ApiError(409,'changed','CURRENCY_CONSENT_CHANGED',{expectedCurrency:'GEMS'}),builder)?.code).toBe('CURRENCY_CONSENT_CHANGED');
    for(const error of [new ApiError(404,'not running'),new ApiError(409,'collision','BUILDER_SPEEDUP_RECEIPT_INVALID'),new ApiError(409,'body','IDEMPOTENCY_BODY_MISMATCH'),new ApiError(409,'currency','CURRENCY_CONSENT_CHANGED',{expectedCurrency:'KEEP'}),new Error('offline')])expect(ports.definitiveRefusal(error,builder)).toBeNull();
  });
  it('publishes only fresh current base and balances atomically, without requiring current paid capabilities',async()=>{
    const {ports,scoped}=setup();snapshot.features={} as never;useApp.getState().setBalances({...balances,gems:'999'});const observed:string[]=[],stop=useApp.subscribe(s=>observed.push(`${s.base?.baseId}/${s.balances?.gems}`));
    await refreshBuilderJobSpeedupSnapshot(scoped,ports);stop();expect(observed).toEqual([`${id(1)}/100`]);
  });
  it.each(['wallet','base','ownership','selection','newer-read']as const)('never publishes a stale %s snapshot',async change=>{
    const{ports,scoped}=setup();useApp.getState().setBalances({...balances,gems:'999'});let seen=0;
    vi.mocked(api.get).mockImplementation(async path=>{
      if(change==='wallet'&&path==='/me')return{wallet:'another-wallet'}as never;
      if(change==='base'&&path.startsWith('/base?'))return{...snapshot,baseId:id(9)}as never;
      if(change==='ownership'&&path==='/bases'&&++seen===2)return{...dirs,bases:[]}as never;
      if(path.startsWith('/balances?')){if(change==='selection')useApp.setState({baseSelectionEpoch:2});if(change==='newer-read')captureBaseBalanceCommit(id(1))({...balances,gems:'777'});}
      return structuredClone(await read(path))as never;
    });await expect(refreshBuilderJobSpeedupSnapshot(scoped,ports)).rejects.toThrow();expect(useApp.getState().balances?.gems).toBe(change==='newer-read'?'777':'999');
  });
  it('unowned or unselected base returns no current snapshot, never a substitute',async()=>{
    const{ports,scoped}=setup();dirs.bases=[];expect(await refreshBuilderJobSpeedupSnapshot(scoped,ports)).toBeNull();expect(vi.mocked(api.get).mock.calls.map(([path])=>path)).toEqual(['/me','/bases']);
  });
});
