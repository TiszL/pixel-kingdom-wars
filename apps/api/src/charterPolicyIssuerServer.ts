/** Separate issuer process. Opening a missing journal refuses startup. */
import {pathToFileURL} from 'node:url';
import {isAbsolute} from 'node:path';
import {loadAddresses} from '@shardkeep/chain';
import type {CharterCreationEvidenceRpc} from '@shardkeep/chain/charter-creation-evidence';
import {loadCharterPolicyIssuerConfig,loadCharterPolicyIssuerSecrets,type CharterPolicyIssuerConfig} from './charterPolicyIssuerConfig';
import {createCharterWorkflowRpc} from './game/charterWorkflowRpc';
import {createCharterPolicyIssuer} from './charterPolicyIssuer';
import {createCharterPolicyIssuerService} from './charterPolicyIssuerService';
import {CharterIssuerError} from './charterPolicyIssuerJournal';

const factories={loadSecrets:loadCharterPolicyIssuerSecrets,createRpc:createCharterWorkflowRpc,createIssuer:createCharterPolicyIssuer,createService:createCharterPolicyIssuerService};
export async function startCharterPolicyIssuer(config:CharterPolicyIssuerConfig,deps:typeof factories=factories){
 let secrets:Awaited<ReturnType<typeof loadCharterPolicyIssuerSecrets>>|undefined,rpc:ReturnType<typeof createCharterWorkflowRpc>|undefined,
  issuer:Awaited<ReturnType<typeof createCharterPolicyIssuer>>|undefined,app:ReturnType<typeof createCharterPolicyIssuerService>|undefined,closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{rpc?.close();try{await app?.close();}finally{try{await issuer?.close();}finally{secrets?.close();}}})();
 try{
  secrets=await deps.loadSecrets(config);
  // Config independently permits only an explicitly opted-in private HTTP URL.
  // The shared transport's environment switch adds no other endpoint fallback.
  rpc=deps.createRpc({readRpcUrl:config.readRpcUrl,nodeEnv:config.readRpcUrl.startsWith('http:')?'development':'production'});
  const readSource=rpc;
  const connect=(signal:AbortSignal):CharterCreationEvidenceRpc=>{const source=readSource.recoveryConnect(signal);return Object.freeze<CharterCreationEvidenceRpc>({
   getGenesisHash:()=>source.getGenesisHash(),getSlot:commitment=>source.getSlot(commitment),getMultipleAccountsInfoAndContext:(addresses,options)=>source.getMultipleAccountsInfoAndContext(addresses,options),
  });};
  issuer=await deps.createIssuer({journalFile:config.journalFile,trust:config.trust,connect,signer:secrets.signer,
   ...(config.seekerAuction?{seekerAuction:{source:{connect,trust:config.seekerAuction.trust},
    crankPublicKey:config.seekerAuction.crankPublicKey}}:{}),
  });
  app=deps.createService({issuer,authToken:secrets.authToken});await app.listen({host:config.host,port:config.port});
  return Object.freeze({app,close});
 }catch{await close().catch(()=>{});throw new CharterIssuerError('STARTUP');}
}
export async function main(argv:string[],env:NodeJS.ProcessEnv=process.env):Promise<number>{
 if(argv.length){console.error('usage: charter-policy-issuer (configuration through dedicated environment only)');return 2;}
 try{
  let registry:ReturnType<typeof loadAddresses>|undefined;
  if(env.CHARTER_ISSUER_SEEKER_AUCTION_ENABLED==='true'){
   const root=env.CHARTER_ISSUER_REGISTRY_ROOT?.trim(),cluster=env.CHARTER_ISSUER_CLUSTER?.trim();
   if(!root||!isAbsolute(root)||root.includes('\0')||(cluster!=='devnet'&&cluster!=='mainnet-beta'))throw new CharterIssuerError('CONFIGURATION');
   registry=loadAddresses(root,cluster);
  }
  const runtime=await startCharterPolicyIssuer(loadCharterPolicyIssuerConfig(env,registry));
  const shutdown=()=>{process.off('SIGINT',shutdown);process.off('SIGTERM',shutdown);void runtime.close().catch(()=>{console.error('CHARTER_ISSUER_SHUTDOWN_REFUSED');process.exitCode=1;});};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);return 0;
 }catch{console.error('CHARTER_ISSUER_STARTUP_REFUSED');return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main(process.argv.slice(2));
