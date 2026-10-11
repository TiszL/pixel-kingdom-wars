/** Explicit ordinary-sale epoch initialization through the private service.
 * Importing this module performs no I/O; startup never initializes an epoch. */
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {assertSolanaCluster,loadAddresses} from '@shardkeep/chain';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {loadConfig,type Config} from '../config';
import {createDb} from '../db/client';
import {HttpError} from '../lib/errors';
import {createPhaseEServices} from '../phaseEServices';
import {makeFinalizedDeedReader} from './baseOwnership';
import {createCharterRecoveryRuntime} from './clanCharterRecoveryRuntime';
import {createConfiguredCharterWorkflowRuntime} from './charterConfiguredRuntime';
import {readDivineOperatorInput,DIVINE_OPERATOR_INPUT_BYTES} from './divineOperatorCli';

const USAGE='usage: charter-sale-operator initialize-epoch --input FILE';
type Operator=NonNullable<NonNullable<Awaited<ReturnType<typeof createPhaseEServices>>>['charterOperator']>;
export interface CharterSaleOperatorSession {readonly operator:Operator;readonly close:()=>Promise<void>;}
export interface CharterSaleOperatorCliIo {
 readonly readInput:(path:string)=>Promise<string>;
 readonly openSession:(config:Config)=>Promise<CharterSaleOperatorSession>;
 readonly print:(line:string)=>void;
 readonly printError:(line:string)=>void;
}
/** Reuse normal source construction and the existing DB identity. No migration,
 * provisioning, identity binding, verifier, listener or signing is performed. */
export async function openCharterSaleOperatorSession(config:Config):Promise<CharterSaleOperatorSession>{
 if(!config.PHASE_E_SERVICE_DATABASE_URL||!config.CHARTER_WORKFLOW_SALE_TREASURY)throw Error('CHARTER_SALE_OPERATOR_CONFIGURATION');
 const addresses=loadAddresses(config.REPO_ROOT??process.cwd(),config.SOLANA_CLUSTER);
 if(!addresses)throw Error('CHARTER_SALE_OPERATOR_CONFIGURATION');
 const economy={cluster:config.SOLANA_CLUSTER,keepMint:addresses.keepMint,coreProgram:addresses.coreProgram,configPda:addresses.config};
 let recovery:ReturnType<typeof createCharterRecoveryRuntime>=null,configured:Awaited<ReturnType<typeof createConfiguredCharterWorkflowRuntime>>|null=null;
 let services:Awaited<ReturnType<typeof createPhaseEServices>>=null,request:ReturnType<typeof createDb>|null=null;
 let closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{configured?.close();recovery?.close();try{await services?.close();}finally{await request?.sql.end();}})();
 try{
  recovery=createCharterRecoveryRuntime(config);
  if(!recovery)throw Error('CHARTER_SALE_OPERATOR_CONFIGURATION');
  configured=await createConfiguredCharterWorkflowRuntime(config,recovery.source);
  if(!configured.client?.sales?.newSaleDomain)throw Error('CHARTER_SALE_OPERATOR_CONFIGURATION');
  await assertSolanaCluster({rpcUrl:config.SOLANA_RPC_URL,cluster:config.SOLANA_CLUSTER});
  request=createDb(config.DATABASE_URL,{max:1,connectTimeoutSeconds:5});
  const rows=await request.db.execute<{cluster:string;keep_mint:string;core_program:string;config_pda:string}>(sql`select cluster,keep_mint,core_program,config_pda from public.economy_chain_identity`);
  const identity=rows[0];if(rows.length!==1||!identity||identity.cluster!==economy.cluster||identity.keep_mint!==economy.keepMint||identity.core_program!==economy.coreProgram||identity.config_pda!==economy.configPda)throw Error('CHARTER_SALE_OPERATOR_IDENTITY');
  services=await createPhaseEServices(config,request.db,{deedCollection:addresses.deedCollection??null,
   finalizedDeedReader:makeFinalizedDeedReader({rpcUrl:config.SOLANA_RPC_URL,deedCollection:addresses.deedCollection})},
   undefined,undefined,undefined,undefined,undefined,recovery.source,undefined,undefined,configured.tournaments,configured.client);
  if(!services?.charterOperator)throw Error('CHARTER_SALE_OPERATOR_CONFIGURATION');
  return Object.freeze({operator:services.charterOperator,close});
 }catch(error){await close();throw error;}
}
const DEFAULT_IO:CharterSaleOperatorCliIo={readInput:readDivineOperatorInput,openSession:openCharterSaleOperatorSession,print:line=>console.log(line),printError:line=>console.error(line)};
/** 0 completed, 1 held/refused, 2 malformed invocation or command file. */
export async function main(argv:string[],env:NodeJS.ProcessEnv=process.env,io:CharterSaleOperatorCliIo=DEFAULT_IO):Promise<number>{
 let path:string;
 try{
  const parsed=parseArgs({args:argv,allowPositionals:true,strict:true,tokens:true,options:{input:{type:'string'}}});
  if(parsed.positionals.length!==1||parsed.positionals[0]!=='initialize-epoch'||!parsed.values.input?.trim()
    ||parsed.tokens.filter(token=>token.kind==='option'&&token.name==='input').length!==1)throw Error();
  path=parsed.values.input;
 }catch{io.printError(USAGE);return 2;}
 try{
  const input=await io.readInput(path);if(Buffer.byteLength(input,'utf8')>DIVINE_OPERATOR_INPUT_BYTES)throw Error();
  z.object({}).strict().parse(JSON.parse(input));
 }catch{io.printError('CHARTER_SALE_OPERATOR_INPUT: invalid bounded command file');return 2;}
 let session:CharterSaleOperatorSession|undefined;
 try{
  const config=loadConfig(env);
  if(!config.PHASE_E_SERVICE_DATABASE_URL||!config.CHARTER_WORKFLOW_SALE_TREASURY)throw Error('CHARTER_SALE_OPERATOR_CONFIGURATION');
  session=await io.openSession(config);
  const result=await session.operator.initializeSaleEpoch();
  io.print(JSON.stringify({command:'initialize-epoch',result}));return 0;
 }catch(error){
  const code=error instanceof HttpError&&/^CLAN_CHARTER_SALE_[A-Z_]+$/.test(error.code??'')?error.code:'CHARTER_SALE_OPERATOR_REFUSED';
  io.printError(`${code}: command held; preserve the original command file`);return 1;
 }finally{try{await session?.close();}catch{io.printError('CHARTER_SALE_OPERATOR_CLOSE: cleanup failed; preserve the original command file');return 1;}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main(process.argv.slice(2));
