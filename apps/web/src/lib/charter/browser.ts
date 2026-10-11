import type {Connection} from '@solana/web3.js';
import {LAND_CHECKOUT_RECOVERY} from '@shardkeep/shared';
import type {CharterClient} from '@shardkeep/shared/charterApi';
import {authCookies} from '../../auth/authCookieCoordinator';
import type {GameWallet} from '../../auth/useGameWallet';
import {useApp} from '../../state/store';
import {API_URL} from '../api';
import {SOLANA_CLUSTER} from '../cluster';
import {mutationGate} from '../mutationGate';
import {charterIdentity,type CharterIdentity} from './journal';
import {prepareCharterSigning,signCharter,type CharterSigningTrust} from './signing';
import {charterActivity,requestCharter} from './transport';
import type {CharterPorts} from './controller';
export const browserCharterIdentity=(wallet:string):CharterIdentity=>charterIdentity({origin:window.location.origin,api:new URL(API_URL,window.location.origin).href.replace(/\/$/,''),cluster:SOLANA_CLUSTER,wallet});
export function createCharterBrowserPorts(input:{identity:CharterIdentity;trust:CharterSigningTrust|null;wallet:()=>GameWallet;connection:Pick<Connection,'getGenesisHash'|'getBlockHeight'>;lifecycle:()=>{active:boolean;visible:boolean;epoch:number;actionsEnabled:boolean}}):CharterPorts{
 const identity=charterIdentity(input.identity),trust=input.trust===null?null:structuredClone(input.trust),wallet=input.wallet,lifecycle=input.lifecycle,genesis=input.connection.getGenesisHash.bind(input.connection),height=input.connection.getBlockHeight.bind(input.connection);let pending=false;
 const capture:CharterPorts['capture']=newAction=>{const revision=authCookies.assertSession(),generation=authCookies.captureGeneration(),epoch=lifecycle().epoch,signer=newAction?wallet():null,key=signer?.publicKey?.toBase58(),sign=signer?.signVersionedTransaction;
  const guard=()=>{authCookies.assertResponse(revision);const state=useApp.getState(),page=lifecycle(),current=newAction?wallet():null;if(JSON.stringify(identity)!==JSON.stringify(browserCharterIdentity(identity.wallet))||!authCookies.current(generation)||!state.authed||state.wallet!==identity.wallet||!page.active||!page.visible||page.epoch!==epoch||newAction&&(!trust||!mutationGate.getSnapshot()||!page.actionsEnabled||key!==identity.wallet||typeof sign!=='function'||current?.publicKey?.toBase58()!==key||current?.signVersionedTransaction!==sign))throw Error('The account, signer or Charter view changed. Recover the saved original.');};guard();return guard;};
 const current=(guard:()=>void)=>()=>{guard();return true;};
 async function prepared(value:CharterClient,guard:()=>void){if(!trust||!value.signing||value.actor!==identity.wallet)throw Error('Independent Charter trust is unavailable. Saved originals remain recoverable.');const own=capture(true);guard();own();const result=await prepareCharterSigning(value.signing,trust,identity.wallet);guard();own();if(pending)throw Error('A previous chain check is still pending.');pending=true;
  const calls=[Promise.resolve().then(()=>genesis()),Promise.resolve().then(()=>height({commitment:'finalized',minContextSlot:value.signing!.context.closingSlot}))] as const;
  // A fast rejection must not release a still-pending sibling RPC.
  void Promise.allSettled(calls).then(()=>{pending=false;});const rpc=Promise.all(calls);let timer:ReturnType<typeof setTimeout>|undefined;
  try{const [chain,currentHeight]=await Promise.race([rpc,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Chain check timed out. Check the original Charter later.')),LAND_CHECKOUT_RECOVERY.requestTimeoutMs);})]);guard();own();if(chain!==trust.deployment.expectedGenesisHash||!Number.isSafeInteger(currentHeight)||currentHeight<0||currentHeight>value.signing.lastValidBlockHeight)throw Error('The original Charter packet is unavailable or expired. Recover its original outcome.');return result;}finally{clearTimeout(timer);}
 }
 return {capture,key:()=>crypto.randomUUID(),lock:async(name,run)=>{if(!navigator.locks?.request)throw Error('This browser cannot coordinate Charter recovery across tabs.');return navigator.locks.request(`charter:${name}`,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw Error('Another tab is handling this Charter.');return run();});},activity:(guard,cursor)=>charterActivity(identity.wallet,current(guard),cursor),request:(request,guard,retain)=>requestCharter({actor:identity.wallet,request,isCurrent:current(guard),retain}),review:async(value,guard)=>{await prepared(value,guard);},sign:async(value,guard)=>{const packet=await prepared(value,guard),signer={...wallet()};guard();return signCharter(packet,signer);}};
}
