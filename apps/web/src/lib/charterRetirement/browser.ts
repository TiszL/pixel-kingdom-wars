import type {Connection} from '@solana/web3.js';
import {LAND_CHECKOUT_RECOVERY} from '@shardkeep/shared';
import type {CharterRetirementOperation} from '@shardkeep/shared/charterRetirementApi';
import {authCookies} from '../../auth/authCookieCoordinator';
import type {GameWallet} from '../../auth/useGameWallet';
import {useApp} from '../../state/store';
import {mutationGate} from '../mutationGate';
import {browserCharterIdentity} from '../charter/browser';
import {charterIdentity,type CharterIdentity} from '../charter/journal';
import {prepareRetirementSigning,signRetirement,type RetirementSigningTrust} from './signing';
import {requestRetirement} from './transport';
import type {RetirementPorts} from './controller';
export {browserCharterIdentity as browserRetirementIdentity};
export function createRetirementBrowserPorts(input:{identity:CharterIdentity;trust:RetirementSigningTrust|null;wallet:()=>GameWallet;connection:Pick<Connection,'getGenesisHash'|'getBlockHeight'>;lifecycle:()=>{active:boolean;visible:boolean;epoch:number;actionsEnabled:boolean}}):RetirementPorts{
 const identity=charterIdentity(input.identity),trust=input.trust===null?null:structuredClone(input.trust),wallet=input.wallet,lifecycle=input.lifecycle,genesis=input.connection.getGenesisHash.bind(input.connection),height=input.connection.getBlockHeight.bind(input.connection);let pending=false;
 const capture:RetirementPorts['capture']=newAction=>{const revision=authCookies.assertSession(),generation=authCookies.captureGeneration(),epoch=lifecycle().epoch,selection=useApp.getState().baseSelectionEpoch,signer=newAction?wallet():null,key=signer?.publicKey?.toBase58(),sign=signer?.signVersionedTransaction;
  const guard=()=>{authCookies.assertResponse(revision);const state=useApp.getState(),page=lifecycle(),current=newAction?wallet():null;if(JSON.stringify(identity)!==JSON.stringify(browserCharterIdentity(identity.wallet))||!authCookies.current(generation)||!state.authed||state.wallet!==identity.wallet||!page.active||!page.visible||page.epoch!==epoch||newAction&&(!trust||!mutationGate.getSnapshot()||!page.actionsEnabled||state.baseSelectionEpoch!==selection||key!==identity.wallet||typeof sign!=='function'||current?.publicKey?.toBase58()!==key||current?.signVersionedTransaction!==sign))throw Error('The account, selected kingdom or dissolution view changed. Recover the saved original.');};guard();return guard;};
 async function prepared(value:CharterRetirementOperation,guard:()=>void){if(!trust||!value.attempt||!value.preparation)throw Error('Independent dissolution trust is unavailable. Saved originals remain recoverable.');const own=capture(true);guard();own();const result=await prepareRetirementSigning(value,trust,identity.wallet);guard();own();if(pending)throw Error('A previous dissolution chain check is still pending.');pending=true;
  const calls=[Promise.resolve().then(()=>genesis()),Promise.resolve().then(()=>height({commitment:'finalized',minContextSlot:value.attempt!.quote.context.closingSlot}))] as const;
  void Promise.allSettled(calls).then(()=>{pending=false;});let timer:ReturnType<typeof setTimeout>|undefined;
  try{const [chain,currentHeight]=await Promise.race([Promise.all(calls),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Chain check timed out. Keep the original dissolution approval.')),LAND_CHECKOUT_RECOVERY.requestTimeoutMs);})]);guard();own();if(chain!==trust.deployment.expectedGenesisHash||!Number.isSafeInteger(currentHeight)||currentHeight<0||currentHeight>value.attempt.quote.packetInput.lastValidBlockHeight)throw Error('The saved dissolution packet is unavailable or expired. Recover its original outcome.');return result;}finally{clearTimeout(timer);}
 }
 return {capture,key:()=>crypto.randomUUID(),lock:async(name,run)=>{if(!navigator.locks?.request)throw Error('This browser cannot coordinate dissolution recovery across tabs.');return navigator.locks.request(`charter-dissolution:${name}`,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw Error('Another tab is handling this dissolution.');return run();});},request:(request,guard,retain)=>requestRetirement({actor:identity.wallet,request,isCurrent:()=>{guard();return true;},retain}),review:async(value,guard)=>{await prepared(value,guard);},sign:async(value,guard)=>{const packet=await prepared(value,guard),signer={...wallet()};guard();return signRetirement(packet,signer);}};
}
