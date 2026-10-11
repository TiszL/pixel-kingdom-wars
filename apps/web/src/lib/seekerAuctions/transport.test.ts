/** SA-4 W1/W4. These are browser boundaries, never chain-proof substitutes. */
import {describe,expect,it,vi} from 'vitest';
import {Buffer} from 'buffer';
import {Keypair} from '@solana/web3.js';
import bs58 from 'bs58';
import {PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import type {SeekerAuctionSourcedRoundView} from '@shardkeep/shared/seekerAuctionApi';
import {createSeekerAuctionTransport} from './transport';

const P=PHASE_E_POLICY.seekerIsland,A=PHASE_E_SEEKER_AUCTION;
const address=(n:number)=>Keypair.fromSeed(Buffer.alloc(32,n)).publicKey.toBase58();
const wallet=address(1),signature=bs58.encode(Buffer.alloc(64,7)),base='https://game.test/api';
function view():SeekerAuctionSourcedRoundView {
 const first=1791158400n;
 return {version:1,source:'chain',chainUnixTime:String(first-1n),walletSkrRaw:'1234567890123',wallet,observedSlot:'9007199254740993',round:'0',biddingRound:'0',admissionPaused:false,
  config:{programId:address(2),address:address(3),mint:address(4),prizeOwner:address(5),prizeAta:address(6),decimals:6,
   openingBidRaw:'10000000',firstOperatingStart:String(first),termSec:String(P.operatingTermSec),auctionSec:String(P.overlappingAuctionSec),graceSec:String(A.settlementGraceSec)},
  auctionStart:String(first-BigInt(P.overlappingAuctionSec)),auctionEnd:String(first),operatingStart:String(first),operatingEnd:String(first+BigInt(P.operatingTermSec)),
  openedCount:P.totalSpots,completedCount:0,winnerCount:0,completedAt:null,
  spots:Array.from({length:P.totalSpots},(_,spot)=>({spot,class:spot<P.kingSpots?'king':'regular',realmMask:spot<P.kingSpots?(1<<P.realmCount)-1:
   Array.from({length:A.regularRealmCount},(_,i)=>i).reduce((mask,i)=>mask|(1<<((spot-P.kingSpots+i)%P.realmCount)),0),
   opened:true,highBidRaw:'0',highBidder:null,settled:false,yourBidRaw:'0',refundable:false}))};
}
const prepared=()=>({messageBase64:Buffer.alloc(120,1).toString('base64'),blockhash:address(7),lastValidBlockHeight:'9007199254740993',
 incrementRaw:'10000000',networkFeeLamports:'5000',newAccountRentLamports:'0'});
const pending=()=>({signature,status:'pending' as const,slot:null,error:null,found:false,finalizedBlockHeight:'9007199254740992'});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function setup(value:unknown=view(),status=200){
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>json(value,status));
 return {fetch,transport:createSeekerAuctionTransport({apiBase:base,fetch})};
}

describe('SA-4 W1 strict Seeker auction transport',()=>{
 it('preserves chain calendar and every raw integer string without Number conversion',async()=>{
  const f=setup(),controller=new AbortController();
  expect(await f.transport.current(wallet,controller.signal)).toEqual(view());
  expect(f.fetch).toHaveBeenCalledWith(`${base}/seeker/auctions/current`,expect.objectContaining({method:'GET',credentials:'include',cache:'no-store',redirect:'error',signal:controller.signal}));
  f.fetch.mockImplementation(async()=>json(prepared()));
  expect(await f.transport.prepareBid({round:'0',spot:20,newTotalRaw:'10000000'})).toEqual(prepared());
  expect(f.fetch.mock.calls[1]![0]).toBe(`${base}/seeker/auctions/bids/prepare`);
  expect(f.fetch.mock.calls[1]![1]).toMatchObject({method:'POST',credentials:'include',cache:'no-store',redirect:'error',body:JSON.stringify({round:'0',spot:20,newTotalRaw:'10000000'})});
  expect(await f.transport.prepareWithdraw({round:'0',spot:20})).toEqual(prepared());
  expect(f.fetch.mock.calls[2]![0]).toBe(`${base}/seeker/auctions/withdrawals/prepare`);
  f.fetch.mockImplementation(async()=>json(view()));
  expect(await f.transport.round(wallet,'0')).toEqual(view());
  expect(f.fetch.mock.calls[3]![0]).toBe(`${base}/seeker/auctions/round/0`);
 });
 it.each([
  {name:'extra root',mutate:(v:SeekerAuctionSourcedRoundView)=>Object.assign(v,{enabled:true})},
  {name:'extra config',mutate:(v:SeekerAuctionSourcedRoundView)=>Object.assign(v.config,{trusted:true})},
  {name:'extra row',mutate:(v:SeekerAuctionSourcedRoundView)=>Object.assign(v.spots[0]!,{canBid:true})},
  {name:'coerced amount',mutate:(v:SeekerAuctionSourcedRoundView)=>{v.spots[0]!.yourBidRaw=1 as never;}},
  {name:'missing spot',mutate:(v:SeekerAuctionSourcedRoundView)=>{v.spots.pop();}},
  {name:'duplicate spot',mutate:(v:SeekerAuctionSourcedRoundView)=>{v.spots[1]!.spot=0;}},
  {name:'contradictory calendar',mutate:(v:SeekerAuctionSourcedRoundView)=>{v.auctionEnd=String(BigInt(v.auctionEnd)+1n);}},
  {name:'wrong authenticated wallet',mutate:(v:SeekerAuctionSourcedRoundView)=>{v.wallet=address(9);}},
  {name:'missing provenance',mutate:(v:SeekerAuctionSourcedRoundView)=>{delete (v as {source?:string}).source;}},
  {name:'unknown provenance',mutate:(v:SeekerAuctionSourcedRoundView)=>{v.source='devnet' as never;}},
 ])('W1 refuses $name',async({mutate})=>{
  const v=view();mutate(v);const f=setup(v);await expect(f.transport.current(wallet)).rejects.toThrow();expect(f.fetch).toHaveBeenCalledOnce();
 });
 it('binds historical round responses to the requested round',async()=>{
  const f=setup();await expect(f.transport.round(wallet,'1')).rejects.toThrow();
 });
 it('retains fixture provenance for a read-only display without promoting it to chain',async()=>{
  const value={...view(),source:'fixture' as const},f=setup(value);expect(await f.transport.current(wallet)).toEqual(value);
 });
 it('refuses malformed requests and path injection before making a request',async()=>{
  const f=setup();
  for(const amount of ['01','-1','1e7','18446744073709551616',1,null])
   await expect(f.transport.prepareBid({round:'0',spot:0,newTotalRaw:amount} as never)).rejects.toThrow();
  await expect(f.transport.prepareBid({round:'0',spot:0,newTotalRaw:'1',wallet} as never)).rejects.toThrow();
  for(const round of ['01','../current','0?wallet=other','0#x'])await expect(f.transport.round(wallet,round)).rejects.toThrow();
  await expect(f.transport.prepareWithdraw({round:'0',spot:P.totalSpots})).rejects.toThrow();
  await expect(f.transport.status(`${signature}/../current`)).rejects.toThrow();
  await expect(f.transport.submit({signature,signedTransaction:Buffer.alloc(200,1).toString('base64')} as never)).rejects.toThrow();
  expect(f.fetch).not.toHaveBeenCalled();
 });
 it('parses prepare and status responses strictly, including paired supplemental height fields',async()=>{
  const f=setup(prepared());
  for(const value of [{...prepared(),networkFeeLamports:5000},{...prepared(),secretKey:'unexpected'},{...prepared(),messageBase64:'%%%%'}]){
   f.fetch.mockImplementation(async()=>json(value));await expect(f.transport.prepareBid({round:'0',spot:0,newTotalRaw:'10000000'})).rejects.toThrow();
  }
  for(const value of [{...pending(),found:undefined},{...pending(),finalizedBlockHeight:undefined},{...pending(),finalizedBlockHeight:'01'},
   {...pending(),signature:bs58.encode(Buffer.alloc(64,9))},{...pending(),status:'finalized',slot:null},{...pending(),retry:true}]){
   f.fetch.mockImplementation(async()=>json(value));await expect(f.transport.status(signature)).rejects.toThrow();
  }
  for(const value of [pending(),{signature,status:'pending',slot:null,error:null},{...pending(),found:true,status:'finalized',slot:'51'}]){
   f.fetch.mockImplementation(async()=>json(value));expect(await f.transport.status(signature)).toEqual(value);
  }
 });
 it('submits exactly one representation without retries and binds the returned signature',async()=>{
  const f=setup(pending()),signedTransaction=Buffer.alloc(200,1).toString('base64');
  expect(await f.transport.submit({signature})).toEqual(pending());
  expect(f.fetch.mock.calls[0]![0]).toBe(`${base}/seeker/auctions/submit`);
  expect(f.fetch.mock.calls[0]![1]).toMatchObject({method:'POST',body:JSON.stringify({signature})});
  expect(await f.transport.submit({signedTransaction})).toEqual(pending());
  expect(f.fetch.mock.calls[1]![1]!.body).toBe(JSON.stringify({signedTransaction}));
  f.fetch.mockImplementation(async()=>json({...pending(),signature:bs58.encode(Buffer.alloc(64,8))}));
  await expect(f.transport.submit({signature})).rejects.toThrow();
  f.fetch.mockRejectedValue(Error('lost response'));
  await expect(f.transport.submit({signature})).rejects.toThrow('lost response');
  expect(f.fetch).toHaveBeenCalledTimes(4);
 });
 it('W4 maps only a current probe 404 to hidden, keeping auth/RPC/route failures distinct',async()=>{
  const f=setup({error:{code:'NOT_FOUND'}},404);expect(await f.transport.current(wallet)).toBeNull();
  await expect(f.transport.round(wallet,'0')).rejects.toThrow();
  await expect(f.transport.status(signature)).rejects.toThrow();
  await expect(f.transport.prepareBid({round:'0',spot:0,newTotalRaw:'10000000'})).rejects.toThrow();
  for(const status of [401,403,429,500,503]){
   f.fetch.mockImplementation(async()=>json({error:{code:'UNAVAILABLE'}},status));await expect(f.transport.current(wallet)).rejects.toThrow();
  }
 });
 it('refuses redirected and non-JSON successes instead of manufacturing empty auctions',async()=>{
  const f=setup();f.fetch.mockImplementation(async()=>new Response('{}',{status:302,headers:{location:'https://elsewhere.test'}}));
  await expect(f.transport.current(wallet)).rejects.toThrow();
  f.fetch.mockImplementation(async()=>new Response('<html>login</html>',{status:200}));await expect(f.transport.current(wallet)).rejects.toThrow();
 });
});
