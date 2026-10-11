/** Server-owned repair capability. The ordinary application receives no owner
 * connection or private evidence; issuance reloads the committed graph itself. */
import type {Db} from '../db/client';
import {copyHistoricalShardsSourcePolicy} from './shardsTaxHistoricalTermReader';
import {resolvePhysicalMineTaxSource,type PhysicalMineResolutionDependencies} from './shardsTaxMineResolution';
import {captureFullPhysicalMineSources,capturePhysicalMineSources} from './shardsTaxMineFullCapture';
export interface PhysicalMineRecoveryProvider {
 readonly recover:(segmentId:string)=>Promise<void>;
 readonly captureOriginal?:(wallet:string,baseId:string)=>Promise<void>;
 readonly captureFull?:(wallet:string,baseId:string)=>Promise<void>;
}
export function createPhysicalMineRecoveryProvider(owner:Db,deps:PhysicalMineResolutionDependencies&{
 historicalTerm:NonNullable<PhysicalMineResolutionDependencies['historicalTerm']>;
}):PhysicalMineRecoveryProvider{
 if('rollback' in owner)throw Error('Mine recovery capability requires a top-level owner connection');
 const context=Object.freeze({historicalTerm:Object.freeze({connect:deps.historicalTerm.connect,policy:copyHistoricalShardsSourcePolicy(deps.historicalTerm.policy)}),
  ...(deps.deedCustody?{deedCustody:Object.freeze({...deps.deedCustody})}:{}),clock:deps.clock??(()=>new Date())});
 return Object.freeze({recover:async(segmentId:string):Promise<void>=>{await resolvePhysicalMineTaxSource(owner,segmentId,context);},
  captureOriginal:async(wallet:string,baseId:string):Promise<void>=>{await capturePhysicalMineSources(owner,wallet,baseId,{clock:context.clock});},
  captureFull:async(wallet:string,baseId:string):Promise<void>=>{await captureFullPhysicalMineSources(owner,wallet,baseId,{clock:context.clock});}});
}
