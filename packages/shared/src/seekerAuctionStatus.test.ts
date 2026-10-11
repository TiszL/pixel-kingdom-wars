/** review 552d2d4d: server never invents expiry without the client's saved height. */
import { describe,expect,it } from 'vitest';
import { SeekerAuctionTxStatusSchema } from './seekerAuctionApi';
const signature='2'.repeat(88);
describe('T15 additive finalized-height observation',()=>{
 it('accepts unknown as pending at every finalized height',()=>{
  for(const finalizedBlockHeight of ['0','999999999'])expect(SeekerAuctionTxStatusSchema.parse({signature,status:'pending',slot:null,error:null,found:false,finalizedBlockHeight})).toMatchObject({status:'pending',found:false,finalizedBlockHeight});
 });
 it('refuses missing status observations, contradictory found flags and malformed heights',()=>{
  for(const row of [
   {signature,status:'expired',slot:null,error:null,found:false,finalizedBlockHeight:'10'},
   {signature,status:'finalized',slot:'1',error:null,found:false,finalizedBlockHeight:'10'},
   {signature,status:'pending',slot:null,error:null,found:false,finalizedBlockHeight:'01'},
   {signature,status:'pending',slot:null,error:null,found:false},
   {signature,status:'pending',slot:null,error:null,finalizedBlockHeight:'10'},
  ])expect(SeekerAuctionTxStatusSchema.safeParse(row).success).toBe(false);
 });
 it('keeps the original v1 pending observation parseable without fabricating expiry context',()=>{
  expect(SeekerAuctionTxStatusSchema.parse({signature,status:'pending',slot:null,error:null})).toEqual({signature,status:'pending',slot:null,error:null});
 });
});
