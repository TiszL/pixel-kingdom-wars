/** Frozen SA-0 DTO boundary. RPC provenance is established by the server, never by JSON parsing. */
import { describe, expect, it } from 'vitest';
import { SeekerAuctionRoundViewSchema, SeekerAuctionSourcedRoundViewSchema, SeekerBidPrepareRequestSchema, SeekerWithdrawPrepareRequestSchema,
 SeekerAuctionPreparedSchema, SeekerAuctionSubmitRequestSchema, SeekerAuctionTxStatusSchema } from './seekerAuctionApi';
const wallet = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const view = () => ({version:1, wallet, observedSlot:'2000', round:'0', biddingRound:'0', admissionPaused:false,
 config:{programId:wallet,address:wallet,mint:wallet,prizeOwner:wallet,prizeAta:wallet,decimals:6,openingBidRaw:'10000000',
 firstOperatingStart:'1791158400',termSec:'604800',auctionSec:'86400',graceSec:'600'},
 auctionStart:'1791072000',auctionEnd:'1791158400',operatingStart:'1791158400',operatingEnd:'1791763200',
 openedCount:100,completedCount:0,winnerCount:0,completedAt:null,
 spots:Array.from({length:100},(_,spot) => ({spot,class:spot<20?'king':'regular',realmMask:spot<20?255:
  [0,1,2,3].reduce((m,n)=>m|(1<<((spot-20+n)%8)),0),opened:true,highBidRaw:'0',highBidder:null,settled:false,yourBidRaw:'0',refundable:false}))});

describe('SA-0 strict auction transport contract', () => {
 it('round trips decoded chain facts and raw decimal amounts without numeric coercion', () => {
  expect(SeekerAuctionRoundViewSchema.parse(view())).toEqual(view());
  expect(SeekerBidPrepareRequestSchema.parse({round:'18446744073709551615',spot:99,newTotalRaw:'18446744073709551615'})).toEqual({round:'18446744073709551615',spot:99,newTotalRaw:'18446744073709551615'});
  expect(SeekerWithdrawPrepareRequestSchema.parse({round:'0',spot:0})).toEqual({round:'0',spot:0});
 });
 it.each(['01','-1','1.0','1e6','18446744073709551616','',1,null])('refuses a noncanonical/out-of-range amount %s', amount => {
  expect(SeekerBidPrepareRequestSchema.safeParse({round:'0',spot:0,newTotalRaw:amount}).success).toBe(false);
 });
 it('rejects injected fields at every object boundary', () => {
  const a=view(); expect(SeekerAuctionRoundViewSchema.safeParse({...a,enabled:true}).success).toBe(false);
  expect(SeekerAuctionRoundViewSchema.safeParse({...a,config:{...a.config,extra:1}}).success).toBe(false);
  a.spots[0]={...a.spots[0]!,extra:true} as never; expect(SeekerAuctionRoundViewSchema.safeParse(a).success).toBe(false);
  expect(SeekerBidPrepareRequestSchema.safeParse({round:'0',spot:0,newTotalRaw:'10',wallet}).success).toBe(false);
 });
 it('rejects missing/duplicate/noncanonical spots and inconsistent progress', () => {
  for (const mutate of [(v:ReturnType<typeof view>)=>v.spots.pop(),(v:ReturnType<typeof view>)=>{v.spots[1]!.spot=0;},
   (v:ReturnType<typeof view>)=>{v.spots[20]!.realmMask=255;},(v:ReturnType<typeof view>)=>{v.completedCount=1;},
   (v:ReturnType<typeof view>)=>{v.spots[0]!.highBidRaw='10';}]) {
   const v=view(); mutate(v); expect(SeekerAuctionRoundViewSchema.safeParse(v).success).toBe(false);
  }
 });
 it('keeps the chain calendar authoritative and rejects internal timestamp contradictions', () => {
  const v=view(); v.auctionEnd='1791158401'; expect(SeekerAuctionRoundViewSchema.safeParse(v).success).toBe(false);
  const shifted=view(); const delta=604800n;
  shifted.config.firstOperatingStart=(BigInt(shifted.config.firstOperatingStart)+delta).toString();
  for (const key of ['auctionStart','auctionEnd','operatingStart','operatingEnd'] as const) shifted[key]=(BigInt(shifted[key])+delta).toString();
  expect(SeekerAuctionRoundViewSchema.safeParse(shifted).success).toBe(true);
 });
 it('accepts exactly one submission representation, strict base64 or a canonical 64-byte signature', () => {
  const signature='2'.repeat(88), signedTransaction=Buffer.alloc(200,1).toString('base64');
  expect(SeekerAuctionSubmitRequestSchema.safeParse({signedTransaction}).success).toBe(true);
  expect(SeekerAuctionSubmitRequestSchema.safeParse({signature}).success).toBe(true);
  for (const value of [{},{signature,signedTransaction},{signature:'bad'}, {signedTransaction:'%%%%'}, {signedTransaction:signedTransaction+'\n'}, {signedTransaction:Buffer.alloc(1233).toString('base64')}])
   expect(SeekerAuctionSubmitRequestSchema.safeParse(value).success).toBe(false);
 });
 it('prepared fees and rent stay exact strings, with no private server signing material', () => {
  const p={messageBase64:Buffer.alloc(120,1).toString('base64'),blockhash:wallet,lastValidBlockHeight:'3000',incrementRaw:'10',networkFeeLamports:'5000',newAccountRentLamports:'0'};
  expect(SeekerAuctionPreparedSchema.parse(p)).toEqual(p);
  expect(SeekerAuctionPreparedSchema.safeParse({...p,networkFeeLamports:5000}).success).toBe(false);
  expect(SeekerAuctionPreparedSchema.safeParse({...p,secretKey:'no'}).success).toBe(false);
 });
 it('status distinguishes pending, finalized and failed without claiming an untracked expiry', () => {
  const signature='2'.repeat(88);
  expect(SeekerAuctionTxStatusSchema.parse({signature,status:'pending',slot:null,error:null})).toMatchObject({status:'pending'});
  expect(SeekerAuctionTxStatusSchema.safeParse({signature,status:'finalized',slot:null,error:null}).success).toBe(false);
  expect(SeekerAuctionTxStatusSchema.safeParse({signature,status:'failed',slot:'4',error:'CHAIN_TRANSACTION_FAILED'}).success).toBe(true);
 });
});

// V-M3 labelled successor: freeze Clock and ATA facts before strict native bindings repin.
it('requires exact chain time and nullable canonical-ATA balance at the sourced boundary',()=>{
 const live={...view(),source:'chain',chainUnixTime:'-1',walletSkrRaw:'18446744073709551615'};
 expect(SeekerAuctionSourcedRoundViewSchema.parse(live)).toEqual(live);
 expect(SeekerAuctionSourcedRoundViewSchema.parse({...live,walletSkrRaw:null}).walletSkrRaw).toBeNull();
 for(const value of ['01','1.5',1,'9223372036854775808',undefined])expect(SeekerAuctionSourcedRoundViewSchema.safeParse({...live,chainUnixTime:value}).success).toBe(false);
 for(const value of ['-1','01',0,'18446744073709551616',undefined])expect(SeekerAuctionSourcedRoundViewSchema.safeParse({...live,walletSkrRaw:value}).success).toBe(false);
 expect(SeekerAuctionSourcedRoundViewSchema.safeParse({...live,extra:true}).success).toBe(false);
 expect(SeekerAuctionSourcedRoundViewSchema.safeParse({...live,openedCount:1}).success).toBe(false);
});
