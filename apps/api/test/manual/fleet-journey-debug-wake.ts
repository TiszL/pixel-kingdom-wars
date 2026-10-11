/** E4 supplemental private QA fixture capability. Never production admission. */
import {BoundCosmeticAppearanceSchema,type BoundCosmeticAppearance} from '@shardkeep/shared/boundCosmeticApi';
import type {BoundCosmeticWorkshopOptions} from '../../src/game/boundCosmeticWorkshop';

export function parseDebugWakeOptIn(argv:readonly string[],nativeMode:boolean,profile:string):boolean {
 if(argv.some(arg=>arg.startsWith('--debug-wake-application='))||argv.filter(arg=>arg==='--debug-wake-application').length>1)
  throw Error('E4_DEBUG_WAKE_OPT_IN_REFUSED');
 if(!argv.includes('--debug-wake-application'))return false;
 if(!nativeMode||profile!=='phase-e-economy')throw Error('E4_DEBUG_WAKE_OPT_IN_REFUSED');
 return true;
}
export function debugWakeOptions(enabled:boolean,appearance:BoundCosmeticAppearance,
 ownership:Pick<BoundCosmeticWorkshopOptions,'finalizedDeedReader'|'deedCollection'>,
 awningApplicationReady:BoundCosmeticWorkshopOptions['awningApplicationReady']):BoundCosmeticWorkshopOptions|null {
 if(!enabled)return null;
 const expected=BoundCosmeticAppearanceSchema.parse(appearance);
 if(expected.outputId!=='aurora_wake'||expected.sourceId!=='auroraWake')throw Error('E4_DEBUG_WAKE_APPEARANCE_REFUSED');
 const exact=JSON.stringify(expected);
 return {...ownership,awningApplicationReady,wakeApplicationReady:observed=>{
  const parsed=BoundCosmeticAppearanceSchema.safeParse(observed);
  return parsed.success&&JSON.stringify(parsed.data)===exact;
 }};
}
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const field=(value:unknown,key:string)=>object(value)[key];
/** Caller first parses the real authenticated mounted route with its unchanged
 * shared schema. These checks bind that result to this exact seeded fixture. */
export function assertMountedDebugWake(enabled:boolean,raw:unknown,expected:{wallet:string;baseId:string;appearance:BoundCosmeticAppearance}) {
 const view=object(raw),selected=object(view.selectedBase),original=object(view.original);
 const predicate=debugWakeOptions(true,expected.appearance,{},false)!.wakeApplicationReady!;
 const current=BoundCosmeticAppearanceSchema.safeParse(field(view.recipe,'appearance'));
 const completed=BoundCosmeticAppearanceSchema.safeParse(field(original.receipt,'appearance'));
 if(view.wallet!==expected.wallet||view.applicationReady!==enabled||view.acceptingJobs!==enabled
  ||selected.baseId!==expected.baseId||selected.state!=='available'||!Array.isArray(selected.lodges)||selected.lodges.length===0
  ||!current.success||!predicate(current.data)||!completed.success||!predicate(completed.data)
  ||!original.completion||field(view.preference,'enabled')!==true)throw Error('E4_MOUNTED_WAKE_REFUSED');
 return {applicationReady:enabled,privateSyntheticAdmission:enabled,productionAdmission:false,
  exactAppearance:current.data,originalCompleted:true,nativeApplication:'not-proved'} as const;
}
