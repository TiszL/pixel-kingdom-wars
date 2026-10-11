/** Read-only owner failure evidence; public runtime never constructs a writer. */
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {MiningTaxClaimFailureEnvelopeSchema} from '@shardkeep/shared/miningTaxClaimFailureApi';
import type {Db} from '../db/client';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import {getMiningTaxClaimSigned} from './taxClaimSignedStore';
import {getMiningTaxClaimSettlement} from './taxClaimSettlement';
import {getMiningTaxClaimFailure} from './taxClaimFailure';
const keySchema=z.object({key:z.uuid().refine(v=>v===v.toLowerCase())}).strict(),empty=z.object({}).strict();
export function registerMiningTaxClaimFailureRoutes(app:FastifyInstance,db:Db){
 const auth={preHandler:[app.authenticate],onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 app.get('/claims/mining-tax/failures/by-key/:key',auth,async req=>{
  const {key}=parse(keySchema,req.params);parse(empty,req.query);
  try{
   const lookup={wallet:req.wallet,idempotencyKey:key},signed=await getMiningTaxClaimSigned(db,lookup);
   const settlement=await getMiningTaxClaimSettlement(db,{...lookup,ordinal:1})??await getMiningTaxClaimSettlement(db,{...lookup,ordinal:0});
   const failures=[];for(const ordinal of [0,1]){const saved=await getMiningTaxClaimFailure(db,{...lookup,ordinal});if(saved)failures.push(saved);}
   return MiningTaxClaimFailureEnvelopeSchema.parse({recovery:{...lookup,claimId:signed?.preparation.claimId??null,status:settlement?settlement.receipt.phase:signed?.wires.length?'signed':signed?'prepared':'unknown',preparation:signed?.preparation??null,wires:signed?.wires??[],settlement,serverNow:new Date().toISOString()},failures});
  }catch{throw new HttpError(503,'KEEP tax claim recovery is unavailable; keep the saved request','MINING_TAX_UNAVAILABLE');}
 });
}
