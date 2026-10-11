/** Explicit private operator commands. Importing this module performs no I/O;
 * no HTTP route, scheduler, migration, signing or automatic funding is started. */
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {PublicKey} from '@solana/web3.js';
import {assertSolanaCluster,loadAddresses} from '@shardkeep/chain';
import {DivineTrialIdSchema} from '@shardkeep/shared/divineTrials';
import {tournamentSchedule} from '@shardkeep/shared/charterTournament';
import {FundCharterTournamentSchema} from './charterTournamentEvents';
import {readDivineOperatorInput, DIVINE_OPERATOR_INPUT_BYTES} from './divineOperatorCli';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {loadConfig,type Config} from '../config';
import {createDb} from '../db/client';
import {HttpError} from '../lib/errors';
import {createCharterRecoveryRuntime} from './clanCharterRecoveryRuntime';
import {createRealmSaleRuntime} from '../seeker/realmSaleRuntime';
import {createPhaseEServices} from '../phaseEServices';
import {makeFinalizedDeedReader} from './baseOwnership';

// Operational input bound; no gameplay quantities are selected here.
const USAGE='usage: clan-divine-operator <initialize-epoch|fund-and-enroll|enroll|close-and-settle> --input FILE';
const Wallet=z.string().refine(value=>{try{return new PublicKey(value).toBase58()===value&&!new PublicKey(value).equals(PublicKey.default);}catch{return false;}});
const Funding=z.object({sponsorWallet:Wallet,request:FundCharterTournamentSchema.refine(value=>{try{tournamentSchedule(value.weekStart);return true;}catch{return false;}})}).strict();
const Event=z.object({eventId:DivineTrialIdSchema}).strict();
type Command={kind:'initialize-epoch';body:Record<string,never>}|{kind:'fund-and-enroll';body:z.infer<typeof Funding>}|{kind:'enroll'|'close-and-settle';body:z.infer<typeof Event>};
type Operator=NonNullable<NonNullable<Awaited<ReturnType<typeof createPhaseEServices>>>['clanOperator']>;
export interface ClanDivineOperatorSession {readonly operator:Operator;readonly close:()=>Promise<void>;}
export interface ClanDivineOperatorCliIo {
 readonly readInput:(path:string)=>Promise<string>;
 readonly openSession:(config:Config)=>Promise<ClanDivineOperatorSession>;
 readonly print:(line:string)=>void;
 readonly printError:(line:string)=>void;
}
/** Same reviewed sources and role boundary as normal startup, without any
 * verifier, listener, account bootstrap or worker. No signer is loaded. */
export async function openClanDivineOperatorSession(config:Config):Promise<ClanDivineOperatorSession>{
 if(!config.PHASE_E_SERVICE_DATABASE_URL||!config.CHARTER_TOURNAMENT_SPONSOR_WALLET)throw Error('CLAN_DIVINE_OPERATOR_CONFIGURATION');
 const addresses=loadAddresses(config.REPO_ROOT??process.cwd(),config.SOLANA_CLUSTER);
 if(!addresses)throw Error('CLAN_DIVINE_OPERATOR_CONFIGURATION');
 const economy={cluster:config.SOLANA_CLUSTER,keepMint:addresses.keepMint,coreProgram:addresses.coreProgram,configPda:addresses.config};
 let recovery:ReturnType<typeof createCharterRecoveryRuntime>=null,realm:ReturnType<typeof createRealmSaleRuntime>=null;
 let services:Awaited<ReturnType<typeof createPhaseEServices>>=null,request:ReturnType<typeof createDb>|null=null;
 let closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{recovery?.close();realm?.close();try{await services?.close();}finally{await request?.sql.end();}})();
 try{
  recovery=createCharterRecoveryRuntime(config);realm=createRealmSaleRuntime(config);
  if(!recovery||!realm)throw Error('CLAN_DIVINE_OPERATOR_CONFIGURATION');
  await assertSolanaCluster({rpcUrl:config.SOLANA_RPC_URL,cluster:config.SOLANA_CLUSTER});
  request=createDb(config.DATABASE_URL,{max:1,connectTimeoutSeconds:5});
  // Existing identity only: an operator lifecycle command never binds a new DB.
  const rows=await request.db.execute<{cluster:string;keep_mint:string;core_program:string;config_pda:string}>(sql`select cluster,keep_mint,core_program,config_pda from public.economy_chain_identity`);
  const identity=rows[0];if(rows.length!==1||!identity||identity.cluster!==economy.cluster||identity.keep_mint!==economy.keepMint||identity.core_program!==economy.coreProgram||identity.config_pda!==economy.configPda)throw Error('CLAN_DIVINE_OPERATOR_IDENTITY');
  services=await createPhaseEServices(config,request.db,{deedCollection:addresses.deedCollection??null,
   finalizedDeedReader:makeFinalizedDeedReader({rpcUrl:config.SOLANA_RPC_URL,deedCollection:addresses.deedCollection})},
   undefined,undefined,undefined,undefined,realm.gameplaySources,recovery.source);
  if(!services?.clanOperator)throw Error('CLAN_DIVINE_OPERATOR_CONFIGURATION');
  return Object.freeze({operator:services.clanOperator,close});
 }catch(error){await close();throw error;}
}
const DEFAULT_IO:ClanDivineOperatorCliIo={readInput:readDivineOperatorInput,openSession:openClanDivineOperatorSession,print:line=>console.log(line),printError:line=>console.error(line)};
/** 0 completed, 1 held/refused, 2 malformed invocation or command file. */
export async function main(argv:string[],env:NodeJS.ProcessEnv=process.env,io:ClanDivineOperatorCliIo=DEFAULT_IO):Promise<number>{
 let kind:Command['kind'],path:string;
 try{
  const parsed=parseArgs({args:argv,allowPositionals:true,strict:true,options:{input:{type:'string'}}});
  const verb=parsed.positionals[0];
  if(parsed.positionals.length!==1||!['initialize-epoch','fund-and-enroll','enroll','close-and-settle'].includes(verb??'')||!parsed.values.input?.trim())throw Error();
  kind=verb as Command['kind'];path=parsed.values.input;
 }catch{io.printError(USAGE);return 2;}
 let command:Command;
 try{
  const input=await io.readInput(path);if(Buffer.byteLength(input,'utf8')>DIVINE_OPERATOR_INPUT_BYTES)throw Error();const value:unknown=JSON.parse(input);
  command=kind==='initialize-epoch'?{kind,body:z.object({}).strict().parse(value)}:kind==='fund-and-enroll'?{kind,body:Funding.parse(value)}:{kind,body:Event.parse(value)};
 }catch{io.printError('CLAN_DIVINE_OPERATOR_INPUT: invalid bounded command file');return 2;}
 let session:ClanDivineOperatorSession|undefined;
 try{
  const config=loadConfig(env);
  if(!config.CHARTER_TOURNAMENT_SPONSOR_WALLET||!config.PHASE_E_SERVICE_DATABASE_URL)throw Error('CLAN_DIVINE_OPERATOR_CONFIGURATION');
  if(command.kind==='fund-and-enroll'&&command.body.sponsorWallet!==config.CHARTER_TOURNAMENT_SPONSOR_WALLET)throw new HttpError(403,'Sponsor differs','CLAN_CHARTER_TOURNAMENT_SPONSOR');
  session=await io.openSession(config);
  const result=command.kind==='initialize-epoch'?await session.operator.initializeEpoch():command.kind==='fund-and-enroll'?await session.operator.fundAndEnroll(command.body.sponsorWallet,command.body.request)
   :command.kind==='enroll'?await session.operator.enroll(command.body.eventId):await session.operator.closeAndSettle(command.body.eventId);
  io.print(JSON.stringify({command:command.kind,...(command.kind==='initialize-epoch'?{}:{eventId:command.kind==='fund-and-enroll'?command.body.request.id:command.body.eventId}),result:result??null}));return 0;
 }catch(error){
  const code=error instanceof HttpError&&/^(DIVINE_FRAGMENT|CLAN_CHARTER_TOURNAMENT)_[A-Z_]+$/.test(error.code??'')?error.code:'CLAN_DIVINE_OPERATOR_REFUSED';
  io.printError(`${code}: command held; preserve the original command file`);return 1;
 }finally{try{await session?.close();}catch{io.printError('CLAN_DIVINE_OPERATOR_CLOSE: cleanup failed; preserve the original command file');return 1;}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main(process.argv.slice(2));
