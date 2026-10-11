import {describe,expect,it} from 'vitest';
import {debugWakeOptions,parseDebugWakeOptIn,assertMountedDebugWake} from './manual/fleet-journey-debug-wake';
import type {BoundCosmeticAppearance} from '@shardkeep/shared/boundCosmeticApi';
const appearance:BoundCosmeticAppearance={version:1,outputId:'aurora_wake',sourceId:'auroraWake',
 sourceManifestSha256:'a'.repeat(64),sourceIndexSha256:'b'.repeat(64),bindingSha256:'c'.repeat(64)};
const wallet='fixture-wallet',baseId='fixture-base';
const view=(enabled:boolean)=>({wallet,applicationReady:enabled,acceptingJobs:enabled,recipe:{appearance},
 original:{receipt:{appearance},completion:{completedAt:'2026-10-02T00:00:00.000Z'}},preference:{enabled:true},
 selectedBase:{state:'available',baseId,lodges:[{buildingId:'fixture-lodge'}]}});
describe('private mounted Wake admission opt-in',()=>{
 it('is absent by default and only admits explicit native economy fixtures',()=>{
  expect(parseDebugWakeOptIn([],false,'fleet-journey')).toBe(false);
  expect(parseDebugWakeOptIn(['--debug-wake-application'],true,'phase-e-economy')).toBe(true);
 });
 it.each([{args:['--debug-wake-application','--debug-wake-application'],native:true,profile:'phase-e-economy'},
  {args:['--debug-wake-application=true'],native:true,profile:'phase-e-economy'},
  {args:['--debug-wake-application'],native:false,profile:'phase-e-economy'},
  {args:['--debug-wake-application'],native:true,profile:'fleet-journey'}])('refuses ambiguous or non-debug scope $profile',({args,native,profile})=>{
  expect(()=>parseDebugWakeOptIn(args,native,profile)).toThrow('E4_DEBUG_WAKE_OPT_IN_REFUSED');
 });
 it('does not construct any options in the default mode',()=>expect(debugWakeOptions(false,appearance,{},false)).toBeNull());
 it('preserves existing finality/ownership and the real Awning predicate',()=>{
  const ownership={deedCollection:'fixture-collection',finalizedDeedReader:null},awning=()=>false;
  const options=debugWakeOptions(true,appearance,ownership,awning)!;
  expect(options.deedCollection).toBe(ownership.deedCollection);expect(options.finalizedDeedReader).toBeNull();
  expect(options.awningApplicationReady).toBe(awning);expect(options.wakeApplicationReady!(appearance)).toBe(true);
 });
 it.each(['sourceManifestSha256','sourceIndexSha256','bindingSha256'] as const)('rejects mismatched %s despite Aurora output identity',field=>{
  const predicate=debugWakeOptions(true,appearance,{},false)!.wakeApplicationReady!;
  expect(predicate({...appearance,[field]:'d'.repeat(64)})).toBe(false);
 });
 it('pins a parsed copy, independent of later caller mutation',()=>{
  const input={...appearance},predicate=debugWakeOptions(true,input,{},false)!.wakeApplicationReady!;
  input.bindingSha256='d'.repeat(64);expect(predicate(appearance)).toBe(true);expect(predicate(input)).toBe(false);
 });
 it('refuses non-Aurora expected appearances',()=>{
  expect(()=>debugWakeOptions(true,{...appearance,outputId:'artisan_market_awning_t1',sourceId:'artisan-market-t1'}, {},false)).toThrow();
 });
 it('requires real mounted true only under the explicit opt-in',()=>{
  expect(assertMountedDebugWake(true,view(true),{wallet,baseId,appearance})).toMatchObject({applicationReady:true,privateSyntheticAdmission:true,productionAdmission:false});
  expect(assertMountedDebugWake(false,view(false),{wallet,baseId,appearance}).applicationReady).toBe(false);
  expect(()=>assertMountedDebugWake(false,view(true),{wallet,baseId,appearance})).toThrow('E4_MOUNTED_WAKE_REFUSED');
  expect(()=>assertMountedDebugWake(true,view(false),{wallet,baseId,appearance})).toThrow('E4_MOUNTED_WAKE_REFUSED');
 });
 it.each(['wallet','base','appearance','completion','preference','lodge'])('refuses mounted %s mismatch',fault=>{
  const current=view(true);
  if(fault==='wallet')current.wallet='foreign';
  if(fault==='base')current.selectedBase.baseId='foreign';
  if(fault==='appearance')current.recipe={appearance:{...appearance,bindingSha256:'d'.repeat(64)}};
  if(fault==='completion')current.original.completion=null as unknown as typeof current.original.completion;
  if(fault==='preference')current.preference.enabled=false;
  if(fault==='lodge')current.selectedBase.lodges=[];
  expect(()=>assertMountedDebugWake(true,current,{wallet,baseId,appearance})).toThrow('E4_MOUNTED_WAKE_REFUSED');
 });
});
