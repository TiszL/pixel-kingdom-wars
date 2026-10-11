import {PublicKey} from '@solana/web3.js';
import {RealmSalePreparationSchema,type RealmSalePreparationView} from '@shardkeep/shared/realmSalesApi';
import {authCookies} from '../../auth/authCookieCoordinator';
import type {GameWallet} from '../../auth/useGameWallet';
import {useApp} from '../../state/store';
import {API_URL} from '../api';
import {SOLANA_CLUSTER} from '../cluster';
import {mutationGate} from '../mutationGate';
import {parseRealmSaleIdentity,type RealmSaleIdentity} from './journal';
import type {RealmSalePorts} from './controller';
import {prepareRealmSaleSigning,signRealmSale,type RealmSaleSigningTrust} from './signing';
import {failedRealmSaleOriginal,prepareRealmSaleOriginal,savedRealmSaleOriginal,reviewRealmSaleOriginal,submitRealmSaleOriginal} from './transport';
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export const realmSaleIdentity=(wallet:string):RealmSaleIdentity=>parseRealmSaleIdentity({origin:window.location.origin,api:new URL(API_URL,window.location.origin).href.replace(/\/$/,''),cluster:SOLANA_CLUSTER,wallet});
export interface RealmSaleBrowserOptions{
 identity:RealmSaleIdentity;trust:RealmSaleSigningTrust|null;wallet():GameWallet;
 lifecycle():{active:boolean;visible:boolean;epoch:number;actionsEnabled:boolean};clock?:()=>number;
}
/** No RPC/default deployment authority. Authenticated review measures current
 * admission; independently pinned signing trust binds every wallet message. */
export function createRealmSaleBrowserPorts(input:RealmSaleBrowserOptions):RealmSalePorts{
 const identity=parseRealmSaleIdentity(input.identity),wallet=input.wallet,lifecycle=input.lifecycle,clock=input.clock??(()=>performance.now());
 const trust=input.trust===null?null:Object.freeze({genesisHash:input.trust.genesisHash,programId:input.trust.programId,developer:input.trust.developer,
  reviewedProgramDataSha256:input.trust.reviewedProgramDataSha256,reviewedDeploymentSlot:input.trust.reviewedDeploymentSlot,revision:input.trust.revision});
 function requireTrust():RealmSaleSigningTrust{
  if(!trust)throw Error('Realm sale deployment trust is unavailable. Saved purchases can still be recovered.');
  try{for(const field of ['genesisHash','programId','developer'] as const){const value=trust[field];if(typeof value!=='string'||value.length<32||value.length>44)throw Error();const p=new PublicKey(value);if(p.toBase58()!==value||p.equals(PublicKey.default))throw Error();}
   if(typeof trust.reviewedProgramDataSha256!=='string'||!/^[a-f0-9]{64}$/.test(trust.reviewedProgramDataSha256)||!Number.isSafeInteger(trust.reviewedDeploymentSlot)||trust.reviewedDeploymentSlot<0||typeof trust.revision!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(trust.revision))throw Error();
  }catch{throw Error('Realm sale deployment trust is invalid. Recover the original saved purchase.');}return trust;
 }
 const capture:RealmSalePorts['capture']=newAction=>{
  if(!same(identity,realmSaleIdentity(identity.wallet)))throw Error('This purchase journal belongs to another origin, server or network.');
  if(newAction)requireTrust();const revision=authCookies.assertSession(),generation=authCookies.captureGeneration(),epoch=lifecycle().epoch;
  const signer=newAction?wallet():null,signerKey=signer?.publicKey?.toBase58(),signTransaction=signer?.signTransaction;
  const guard=()=>{
   authCookies.assertResponse(revision);const state=useApp.getState(),page=lifecycle(),current=newAction?wallet():null;
   if(!same(identity,realmSaleIdentity(identity.wallet))||!authCookies.current(generation)||!state.authed||state.wallet!==identity.wallet||!page.active||!page.visible||page.epoch!==epoch
    ||newAction&&(!mutationGate.getSnapshot()||!page.actionsEnabled||signerKey!==identity.wallet||typeof signTransaction!=='function'||current?.publicKey?.toBase58()!==signerKey||current.signTransaction!==signTransaction))
    throw Error('The account, wallet signer or purchase view changed. Check the original saved purchase.');
  };guard();return guard;
 };
 const current=(guard:()=>void)=>()=>{guard();return true;};
 // Enforce the effect boundary even if a caller accidentally passes a read guard.
 const effect=(guard:()=>void)=>{guard();const own=capture(true);return ()=>{guard();own();};};
 const preparation=(value:RealmSalePreparationView)=>{const owned=RealmSalePreparationSchema.parse(value);if(owned.wallet!==identity.wallet)throw Error('The purchase belongs to another wallet.');return owned;};
 return {
  capture,key:()=>crypto.randomUUID(),clock:()=>clock(),
  lock:async(name,run)=>{if(!navigator.locks?.request)throw Error('This browser cannot coordinate saved purchases across tabs.');return navigator.locks.request(name,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw Error('Another tab is handling this purchase. Check its original saved request.');return run();});},
  prepare:async(request,guard,retain,refusal)=>{const check=effect(guard);check();return prepareRealmSaleOriginal({request,method:'POST',isCurrent:current(check),retain,refusal});},
  getPreparation:async(request,guard,retain)=>{guard();return prepareRealmSaleOriginal({request,method:'GET',isCurrent:current(guard),retain});},
  getFailure:async(idempotencyKey,guard,retain)=>{guard();return failedRealmSaleOriginal({idempotencyKey,isCurrent:current(guard),retain});},
  getSaved:async(idempotencyKey,guard,retain)=>{guard();return savedRealmSaleOriginal({idempotencyKey,isCurrent:current(guard),retain});},
  currentReview:async(value,guard)=>{const check=effect(guard),owned=preparation(value);await prepareRealmSaleSigning(owned,requireTrust());check();return reviewRealmSaleOriginal({preparation:owned,isCurrent:current(check)});},
  sign:async(value,guard)=>{
   const check=effect(guard),owned=preparation(value),prepared=await prepareRealmSaleSigning(owned,requireTrust());check();const signer={...wallet()};check();
   // Do not check lifecycle after approval: a valid late signature must reach
   // the controller's durable journal before obsolete-view handling.
   return signRealmSale(prepared,signer);
  },
  submit:async(request,guard,retain)=>{const check=effect(guard);check();return submitRealmSaleOriginal({request,isCurrent:current(check),retain});},
 };
}
