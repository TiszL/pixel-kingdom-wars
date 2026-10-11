import type {Connection} from '@solana/web3.js';
import {LAND_CHECKOUT_RECOVERY} from '@shardkeep/shared';
import type {CharterMigration} from '@shardkeep/shared/charterMigrationApi';
import {authCookies} from '../../auth/authCookieCoordinator';
import type {GameWallet} from '../../auth/useGameWallet';
import {useApp} from '../../state/store';
import {mutationGate} from '../mutationGate';
import {browserCharterIdentity} from '../charter/browser';
import {charterIdentity,type CharterIdentity} from '../charter/journal';
import {prepareCharterSigning,signCharter,type CharterSigningTrust} from '../charter/signing';
import {requestMigration} from './transport';
import type {MigrationPorts} from './controller';
export {browserCharterIdentity as browserMigrationIdentity};
export function createMigrationBrowserPorts(input:{identity:CharterIdentity;trust:CharterSigningTrust|null;wallet:()=>GameWallet;connection:Pick<Connection,'getGenesisHash'|'getBlockHeight'>;lifecycle:()=>{active:boolean;visible:boolean;epoch:number;actionsEnabled:boolean}}):MigrationPorts{
 const identity=charterIdentity(input.identity),trust=input.trust===null?null:structuredClone(input.trust),wallet=input.wallet,lifecycle=input.lifecycle,genesis=input.connection.getGenesisHash.bind(input.connection),height=input.connection.getBlockHeight.bind(input.connection);let pending=false;
 const capture:MigrationPorts['capture']=newAction=>{const revision=authCookies.assertSession(),generation=authCookies.captureGeneration(),epoch=lifecycle().epoch,selection=useApp.getState().baseSelectionEpoch,signer=newAction?wallet():null,key=signer?.publicKey?.toBase58(),sign=signer?.signVersionedTransaction;
  const guard=()=>{authCookies.assertResponse(revision);const state=useApp.getState(),page=lifecycle(),current=newAction?wallet():null;if(JSON.stringify(identity)!==JSON.stringify(browserCharterIdentity(identity.wallet))||!authCookies.current(generation)||!state.authed||state.wallet!==identity.wallet||!page.active||!page.visible||page.epoch!==epoch||newAction&&(!trust||!mutationGate.getSnapshot()||!page.actionsEnabled||state.baseSelectionEpoch!==selection||key!==identity.wallet||typeof sign!=='function'||current?.publicKey?.toBase58()!==key||current?.signVersionedTransaction!==sign))throw Error('The account, selected kingdom or migration view changed. Recover the saved original.');};guard();return guard;};
 async function prepared(value:CharterMigration,guard:()=>void){const signing=value.signing&&structuredClone(value.signing);if(!trust||!signing)throw Error('Independent migration trust is unavailable. Saved originals remain recoverable.');const own=capture(true);guard();own();const result=await prepareCharterSigning(signing,trust,identity.wallet);guard();own();if(pending)throw Error('A previous migration chain check is still pending.');pending=true;
  const calls=[Promise.resolve().then(()=>genesis()),Promise.resolve().then(()=>height({commitment:'finalized',minContextSlot:signing.context.closingSlot}))] as const;
  void Promise.allSettled(calls).then(()=>{pending=false;});let timer:ReturnType<typeof setTimeout>|undefined;
  try{const [chain,currentHeight]=await Promise.race([Promise.all(calls),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Chain check timed out. Keep the original migration approval.')),LAND_CHECKOUT_RECOVERY.requestTimeoutMs);})]);guard();own();if(chain!==trust.deployment.expectedGenesisHash||!Number.isSafeInteger(currentHeight)||currentHeight<0||currentHeight>signing.lastValidBlockHeight)throw Error('The saved migration packet is unavailable or expired. Recover its original outcome.');return result;}finally{clearTimeout(timer);}
 }
 return {capture,key:()=>crypto.randomUUID(),lock:async(name,run)=>{if(!navigator.locks?.request)throw Error('This browser cannot coordinate migration recovery across tabs.');return navigator.locks.request(`charter-migration:${name}`,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw Error('Another tab is handling this migration.');return run();});},request:(request,guard,retain)=>requestMigration({actor:identity.wallet,request,isCurrent:()=>{guard();return true;},retain}),review:async(value,guard)=>{await prepared(value,guard);},sign:async(value,guard)=>{const packet=await prepared(value,guard),signer={...wallet()};guard();const signed=await signCharter(packet,signer);if(signed.kind!=='creation')throw Error('Unexpected registration signature.');return signed.wire;}};
}
