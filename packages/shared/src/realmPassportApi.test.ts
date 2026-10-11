/** The Passport wire contract must refuse invented facts: zeros for missing
 * history, foreign leaves, unordered pages, substituted versions and cursors
 * that do not name the last displayed row. */
import {describe,expect,it} from 'vitest';
import {PHASE_E_DIVINE_TRIALS} from './constants';
import {REALM_PASSPORT_PAGE_SIZE,RealmPassportCurrentResponseSchema,RealmPassportExpeditionsQuerySchema,RealmPassportExpeditionsResponseSchema,
 RealmPassportInclusionsQuerySchema,RealmPassportInclusionsResponseSchema} from './realmPassportApi';

const wallet='So11111111111111111111111111111111111111112',other='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const envelope={version:1,wallet,serverNow:'2035-01-01T01:00:00.000Z',projection:'history-only'};
function row(n:number,kind:'starter'|'advanced'='starter'){return {kind,expeditionId:id(n),returnId:id(n+500),originalBaseId:id(999),realmId:'crownlands',routeId:kind==='starter'?'introduction':'ordinary_frost_run',
 routeVersion:kind==='starter'?1:null,policyVersion:kind==='starter'?null:2,departedAt:'2035-01-01T00:00:00.000Z',scheduledReturnAt:'2035-01-01T00:30:00.000Z',returnedAt:'2035-01-01T00:30:00.000Z'};}
const expeditions=(rows:unknown[],nextCursor:string|null=null,kind='starter')=>({...envelope,state:'available',data:{kind,rows,nextCursor}});
const unavailable=(reason:string)=>({...envelope,state:'unavailable',reason,data:null});
function inclusion(sequence:string,overrides:Record<string,unknown>={}){return {sequence,day:'18262',root:'ab'.repeat(32),sourceHash:'cd'.repeat(32),publicationSignature:'3'.repeat(88),publicationSlot:3000,
 genesisHash:wallet,programId:other,configAddress:wallet,keepMint:other,reserveOwner:wallet,totalCumulativeBaseUnits:'1000',
 leaf:{wallet,sequence,cumulativeKeepBaseUnits:'400',cumulativeRenown:'2',cumulativeDays:'3'},proof:[{hash:'ef'.repeat(32),sumBaseUnits:'600',isLeft:false}],...overrides};}
const inclusions=(rows:unknown[],nextCursor:string|null=null)=>({...envelope,state:'available',data:{rows,nextCursor}});
const current=(data:Record<string,unknown>)=>({...envelope,state:'available',data:{observedSlot:3000,chainUnixTimestamp:'1577923200',publicationSequence:'2',published:{cumulativeRenown:'2',cumulativeDays:'3'},attested:{renownTotal:'1',daysAttested:'1',lastSequence:'1'},...data}});
const ok=(schema:{safeParse(v:unknown):{success:boolean}},value:unknown)=>schema.safeParse(value).success;

describe('realm passport queries',()=>{
 it('requires an expedition kind and only a canonical exclusive cursor',()=>{
  expect(ok(RealmPassportExpeditionsQuerySchema,{kind:'advanced'})).toBe(true);
  expect(ok(RealmPassportExpeditionsQuerySchema,{kind:'starter',cursor:id(7)})).toBe(true);
  for(const bad of [{},{kind:'paid'},{kind:'starter',cursor:'1a000000-0000-4000-8000-00000000000a'.toUpperCase()},{kind:'starter',cursor:'7'},{kind:'starter',wallet},{kind:'starter',cursor:null}])expect(ok(RealmPassportExpeditionsQuerySchema,bad)).toBe(false);
 });
 it('accepts only a positive decimal sequence cursor for inclusions',()=>{
  expect(ok(RealmPassportInclusionsQuerySchema,{})).toBe(true);expect(ok(RealmPassportInclusionsQuerySchema,{cursor:'18446744073709551615'})).toBe(true);
  for(const bad of [{cursor:'0'},{cursor:'01'},{cursor:'18446744073709551616'},{cursor:1},{cursor:''},{kind:'starter'}])expect(ok(RealmPassportInclusionsQuerySchema,bad)).toBe(false);
 });
});

describe('realm passport expedition pages',()=>{
 it('uses the shared discovery page size as the transport bound',()=>{expect(REALM_PASSPORT_PAGE_SIZE).toBe(PHASE_E_DIVINE_TRIALS.discoveryPageSize);});
 it('accepts an empty page, an ordered partial page and each unavailable reason without data',()=>{
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions([]))).toBe(true);
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions([row(1),row(2)]))).toBe(true);
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions([row(1,'advanced')],null,'advanced'))).toBe(true);
  for(const reason of ['SOURCE_UNAVAILABLE','SOURCE_CONFLICT','NOT_CONFIGURED'])expect(ok(RealmPassportExpeditionsResponseSchema,unavailable(reason))).toBe(true);
  expect(ok(RealmPassportExpeditionsResponseSchema,{...unavailable('SOURCE_UNAVAILABLE'),data:{kind:'starter',rows:[],nextCursor:null}})).toBe(false);
  expect(ok(RealmPassportExpeditionsResponseSchema,unavailable('DISABLED'))).toBe(false);
  expect(ok(RealmPassportExpeditionsResponseSchema,{...expeditions([]),projection:'current'})).toBe(false);
 });
 it('refuses mixed kinds, unordered or duplicate rows and a foreign-kind version layout',()=>{
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions([row(1),row(2,'advanced')]))).toBe(false);
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions([row(2),row(1)]))).toBe(false);
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions([row(1),row(1)]))).toBe(false);
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions([{...row(1),policyVersion:1}]))).toBe(false);
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions([{...row(1),routeVersion:null}]))).toBe(false);
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions([{...row(1,'advanced'),routeVersion:1}],null,'advanced'))).toBe(false);
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions([{...row(1),routeVersion:0}]))).toBe(false);
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions([{...row(1),realmId:'atlantis'}]))).toBe(false);
 });
 it('refuses a return recorded before its schedule and a schedule before departure',()=>{
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions([{...row(1),returnedAt:'2035-01-01T00:29:59.000Z'}]))).toBe(false);
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions([{...row(1),scheduledReturnAt:'2035-01-01T00:00:00.000Z'}]))).toBe(false);
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions([{...row(1),returnedAt:'2035-01-01T00:30:00Z'}]))).toBe(false);
 });
 it('names the last displayed expeditionId as nextCursor only on a full page',()=>{
  const full=Array.from({length:REALM_PASSPORT_PAGE_SIZE},(_,i)=>row(i+1));
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions(full,id(REALM_PASSPORT_PAGE_SIZE)))).toBe(true);
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions(full))).toBe(true);
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions(full,id(1)))).toBe(false);
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions(full.slice(0,-1),id(REALM_PASSPORT_PAGE_SIZE-1)))).toBe(false);
  expect(ok(RealmPassportExpeditionsResponseSchema,expeditions([...full,row(REALM_PASSPORT_PAGE_SIZE+1)]))).toBe(false);
 });
});

describe('realm passport inclusion pages',()=>{
 it('accepts this wallet\'s exact header, leaf and proof rows in numeric sequence order',()=>{
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions([]))).toBe(true);
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions([inclusion('9'),inclusion('10')]))).toBe(true);
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions([inclusion('10'),inclusion('9')]))).toBe(false);
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions([inclusion('1',{proof:[]})]))).toBe(true);
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions([inclusion('1',{proof:Array.from({length:17},()=>({hash:'ef'.repeat(32),sumBaseUnits:'1',isLeft:true}))})]))).toBe(false);
 });
 it('refuses foreign leaves, leaves of another publication, zero keep and inconsistent totals',()=>{
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions([inclusion('1',{leaf:{wallet:other,sequence:'1',cumulativeKeepBaseUnits:'400',cumulativeRenown:'2',cumulativeDays:'3'}})]))).toBe(false);
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions([inclusion('2',{leaf:{wallet,sequence:'1',cumulativeKeepBaseUnits:'400',cumulativeRenown:'2',cumulativeDays:'3'}})]))).toBe(false);
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions([inclusion('1',{leaf:{wallet,sequence:'1',cumulativeKeepBaseUnits:'0',cumulativeRenown:'0',cumulativeDays:'0'}})]))).toBe(false);
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions([inclusion('1',{leaf:{wallet,sequence:'1',cumulativeKeepBaseUnits:'1001',cumulativeRenown:'2',cumulativeDays:'3'}})]))).toBe(false);
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions([inclusion('1',{leaf:{wallet,sequence:'1',cumulativeKeepBaseUnits:'400',cumulativeRenown:'4',cumulativeDays:'3'}})]))).toBe(false);
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions([inclusion('1',{leaf:{wallet,rootSequence:'1',cumulativeKeepBaseUnits:'400',cumulativeRenown:'2',cumulativeDays:'3'}})]))).toBe(false);
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions([inclusion('1'),inclusion('2',{programId:wallet})]))).toBe(false);
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions([inclusion('1',{publicationSlot:-1})]))).toBe(false);
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions([inclusion('1',{day:'0'})]))).toBe(false);
 });
 it('names the last displayed sequence as nextCursor only on a full page',()=>{
  const full=Array.from({length:REALM_PASSPORT_PAGE_SIZE},(_,i)=>inclusion(String(i+1)));
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions(full,String(REALM_PASSPORT_PAGE_SIZE)))).toBe(true);
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions(full,'1'))).toBe(false);
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions(full.slice(0,-1),String(REALM_PASSPORT_PAGE_SIZE-1)))).toBe(false);
  expect(ok(RealmPassportInclusionsResponseSchema,inclusions([],'1'))).toBe(false);
 });
});

describe('realm passport current record',()=>{
 it('distinguishes published cumulative participation from the attested chain record, which may be absent',()=>{
  expect(ok(RealmPassportCurrentResponseSchema,current({}))).toBe(true);
  expect(ok(RealmPassportCurrentResponseSchema,current({attested:null}))).toBe(true);
  expect(ok(RealmPassportCurrentResponseSchema,current({attested:{renownTotal:'2',daysAttested:'3',lastSequence:'2'}}))).toBe(true);
  for(const reason of ['SOURCE_UNAVAILABLE','SOURCE_CONFLICT','NOT_CONFIGURED'])expect(ok(RealmPassportCurrentResponseSchema,unavailable(reason))).toBe(true);
 });
 it('refuses attested records beyond the published leaf, invented zero sequences and signing fields',()=>{
  expect(ok(RealmPassportCurrentResponseSchema,current({attested:{renownTotal:'3',daysAttested:'3',lastSequence:'2'}}))).toBe(false);
  expect(ok(RealmPassportCurrentResponseSchema,current({attested:{renownTotal:'2',daysAttested:'4',lastSequence:'2'}}))).toBe(false);
  expect(ok(RealmPassportCurrentResponseSchema,current({attested:{renownTotal:'2',daysAttested:'3',lastSequence:'3'}}))).toBe(false);
  expect(ok(RealmPassportCurrentResponseSchema,current({published:{cumulativeRenown:'4',cumulativeDays:'3'}}))).toBe(false);
  expect(ok(RealmPassportCurrentResponseSchema,current({publicationSequence:'0'}))).toBe(false);
  expect(ok(RealmPassportCurrentResponseSchema,current({observedSlot:1.5}))).toBe(false);
  expect(ok(RealmPassportCurrentResponseSchema,current({chainUnixTimestamp:1577923200}))).toBe(false);
  expect(ok(RealmPassportCurrentResponseSchema,current({preparationAllowed:false}))).toBe(false);
  expect(ok(RealmPassportCurrentResponseSchema,{...unavailable('SOURCE_UNAVAILABLE'),data:{observedSlot:0,chainUnixTimestamp:'0',publicationSequence:'1',published:{cumulativeRenown:'0',cumulativeDays:'0'},attested:null}})).toBe(false);
 });
});
