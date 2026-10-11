/** Capture registered custody after a successful normal base read, before the
 * player builds a new Mine. The API retains no owner DB or authorizing receipt. */
import type {FastifyInstance} from 'fastify';
import type {Db} from '../db/client';
import {multiBaseEnabled,phaseEMiningEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {initializeMiningRosterHistory,MiningRosterHistoryError} from './rosterHistory';
import {captureMiningRosterCheckpoint} from './rosterCheckpoints';

export interface MiningRosterEnrollmentProvider {readonly enroll:(wallet:string)=>Promise<void>}
export function createMiningRosterEnrollmentProvider(owner:Db):MiningRosterEnrollmentProvider{
 if('rollback' in owner)throw Error('Roster enrollment requires a top-level owner connection');
 return Object.freeze({enroll:async(wallet:string):Promise<void>=>{await initializeMiningRosterHistory(owner,wallet);await captureMiningRosterCheckpoint(owner,wallet);}});
}

export function registerMiningRosterEnrollment(app:FastifyInstance,deps:{provider?:MiningRosterEnrollmentProvider|null}):void{
 const provider=deps.provider;if(!provider)return;
 app.addHook('onRoute',options=>{
  if(options.url!=='/base'||!(Array.isArray(options.method)?options.method.includes('GET'):options.method==='GET'))return;
  const previous=options.preSerialization?(Array.isArray(options.preSerialization)?options.preSerialization:[options.preSerialization]):[];
  options.preSerialization=[...previous,async(req,reply,payload)=>{
   // Automatic HEAD routes may inherit GET hooks. Errors, legacy mode and
   // paused mining never trigger a new privileged enrollment attempt.
   if(req.method!=='GET'||reply.statusCode<200||reply.statusCode>=300||!req.wallet
    ||!multiBaseEnabled()||!phaseEMiningEnabled())return payload;
   try{await provider.enroll(req.wallet);}
   catch(error){
    if(error instanceof MiningRosterHistoryError&&error.code==='DISABLED')return payload;
    throw new HttpError(503,'Your base is temporarily unavailable; try loading it again','MINING_ROSTER_ENROLLMENT_HELD');
   }
   return payload;
  }];
 });
}
