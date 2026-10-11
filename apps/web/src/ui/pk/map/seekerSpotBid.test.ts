import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SeekerAuctionState } from '../../../lib/seekerAuctions/controller';
import type { SeekerAuctionSourcedRoundView } from '@shardkeep/shared/seekerAuctionApi';
import { seekerSpotBid } from './seekerSpotBid';

function view():SeekerAuctionSourcedRoundView {
 return {version:1,source:'chain',chainUnixTime:'150',walletSkrRaw:'999999999999999999',wallet:'wallet',observedSlot:'1',round:'0',biddingRound:'0',admissionPaused:false,
  config:{programId:'program',address:'config',mint:'mint',prizeOwner:'owner',prizeAta:'ata',decimals:2,openingBidRaw:'500',firstOperatingStart:'200',termSec:'100',auctionSec:'100',graceSec:'1'},
  auctionStart:'100',auctionEnd:'200',operatingStart:'200',operatingEnd:'300',openedCount:1,completedCount:0,winnerCount:0,completedAt:null,
  spots:[{spot:0,class:'king',realmMask:1,opened:true,highBidRaw:'9007199254740993',highBidder:'leader',settled:false,yourBidRaw:'700',refundable:true}]};
}
function state(v:SeekerAuctionSourcedRoundView|null=view()):SeekerAuctionState {
 return {status:'ready',view:v,refunds:{status:'idle',page:null,error:null},canWithdrawRefunds:false,operation:null,receipt:null,costs:null,error:null,canTransact:true,canRetry:false,notEnough:null};
}
test('next bid and scaled display preserve integers above Number precision',()=>{
 const x=seekerSpotBid(state(),0);assert.equal(x.minimumNextTotalRaw,'9007199254740994');assert.equal(x.bid.amount,'90,071,992,547,409.94');assert.equal(x.held.amount,'7');assert.equal(x.leader?.price?.amount,'90,071,992,547,409.93');assert.equal(x.bidState,'ENABLED');
});
test('opening bid wins when greater than high bid plus one',()=>{
 const v=view();v.spots[0]!.highBidRaw='0';v.spots[0]!.highBidder=null;
 const x=seekerSpotBid(state(v),0);assert.equal(x.minimumNextTotalRaw,'500');assert.equal(x.bid.amount,'5');assert.equal(x.leader,undefined);
});
test('U64 maximum has no valid next total and cannot offer a bid',()=>{
 const v=view();v.spots[0]!.highBidRaw='18446744073709551615';const x=seekerSpotBid(state(v),0);
 assert.equal(x.minimumNextTotalRaw,null);assert.equal(x.bidState,'DISABLED');assert.equal(x.bid.status,'UNAVAILABLE');
});
test('U64 maximum remains exact when it is the next valid total',()=>{
 const v=view();v.config.decimals=0;v.spots[0]!.highBidRaw='18446744073709551614';
 assert.equal(seekerSpotBid(state(v),0).bid.amount,'18,446,744,073,709,551,615');
});
for(const [label,change] of [
 ['fixture',(v:SeekerAuctionSourcedRoundView)=>{v.source='fixture';}],
 ['different bidding round',(v:SeekerAuctionSourcedRoundView)=>{v.biddingRound='1';}],
 ['admission paused',(v:SeekerAuctionSourcedRoundView)=>{v.admissionPaused=true;}],
 ['incomplete opening',(v:SeekerAuctionSourcedRoundView)=>{v.openedCount=0;}],
 ['spot unopened',(v:SeekerAuctionSourcedRoundView)=>{v.spots[0]!.opened=false;}],
 ['spot settled',(v:SeekerAuctionSourcedRoundView)=>{v.spots[0]!.settled=true;}],
 ['before auction',(v:SeekerAuctionSourcedRoundView)=>{v.chainUnixTime='99';}],
 ['at exclusive auction end',(v:SeekerAuctionSourcedRoundView)=>{v.chainUnixTime='200';}],
] as const)test(`bid admission fails closed for ${label}`,()=>{
 const v=view();change(v);const x=seekerSpotBid(state(v),0);assert.equal(x.bidState,'DISABLED');if(v.source==='fixture')assert.equal(x.testData,true);
});
test('chain auction start is inclusive',()=>{const v=view();v.chainUnixTime='100';assert.equal(seekerSpotBid(state(v),0).bidState,'ENABLED');});
test('SA-4 canTransact is mandatory even when every view predicate passes',()=>{
 assert.equal(seekerSpotBid({...state(),canTransact:false},0).bidState,'DISABLED');
});
test('unavailable remains unavailable despite a retained old view',()=>{
 const x=seekerSpotBid({...state(),status:'unavailable',error:'RPC unavailable'},0);
 assert.equal(x.bid.status,'UNAVAILABLE');assert.equal(x.held.status,'UNAVAILABLE');assert.equal(x.bid.amount,null);assert.equal(x.held.amount,null);assert.equal(x.leader,undefined);assert.equal(x.bidState,'DISABLED');
});
test('a missing spot or view is unavailable instead of an empty or zero auction',()=>{
 for(const x of [seekerSpotBid(state(null),0),seekerSpotBid(state(),9)]){assert.equal(x.bid.status,'UNAVAILABLE');assert.equal(x.held.status,'UNAVAILABLE');assert.equal(x.minimumNextTotalRaw,null);}
});
test('pending found false retains recovery and never implies expiry',()=>{
 const x=seekerSpotBid({...state(),status:'pending',receipt:{signature:'sig',status:'pending',slot:null,error:null,found:false,finalizedBlockHeight:'999999'}},0);
 assert.equal(x.recoveryPending,true);assert.equal(x.bidState,'BUSY');assert.match(x.bidReason,/saved/i);
});
test('only the controller expired state releases pending recovery',()=>{
 const x=seekerSpotBid({...state(),status:'expired',canRetry:true},0);assert.equal(x.recoveryPending,false);assert.equal(x.bidState,'ENABLED');
});
for(const status of ['preparing','awaiting-wallet','submitting'] as const)test(`${status} keeps the money primary busy`,()=>{
 assert.equal(seekerSpotBid({...state(),status},0).bidState,'BUSY');
});
test('known zero held balance is OK zero, never a free purchase',()=>{
 const v=view();v.spots[0]!.yourBidRaw='0';const x=seekerSpotBid(state(v),0);assert.equal(x.held.amount,'0');assert.equal(x.held.status,'OK');
});
test('scaling uses the supplied precision including leading fractional zeroes',()=>{
 const v=view();v.config.decimals=9;v.spots[0]!.highBidRaw='500';v.spots[0]!.yourBidRaw='1';
 const x=seekerSpotBid(state(v),0);assert.equal(x.bid.amount,'0.000000501');assert.equal(x.held.amount,'0.000000001');
});
test('no unsourced stepper callback or step is produced',()=>{const x=seekerSpotBid(state(),0);assert.equal('onBidStep' in x,false);assert.equal('step' in x,false);});
test('adapter has no Number conversion, device clock, timer or runtime transport import',()=>{
 const src=readFileSync(new URL('./seekerSpotBid.ts',import.meta.url),'utf8');
 assert.doesNotMatch(src,/\b(?:Number|parseInt|parseFloat)\s*\(|\bDate\b|\bperformance\b|setTimeout|setInterval/);
 for(const line of src.split('\n').filter(x=>/^import\b/.test(x)))assert.match(line,/^import type /);
});
for(const raw of ['01','-1','1.1','18446744073709551616'])test(`invalid canonical amount is unavailable: ${raw}`,()=>{
 const v=view();v.spots[0]!.highBidRaw=raw;const x=seekerSpotBid(state(v),0);assert.equal(x.bid.status,'UNAVAILABLE');assert.equal(x.bidState,'DISABLED');
});

test('bid, held and leader amounts group only their integer portions',()=>{
 const v=view();v.spots[0]!.highBidRaw='999999';v.spots[0]!.yourBidRaw='123450';
 const x=seekerSpotBid(state(v),0);
 assert.equal(x.bid.amount,'10,000');assert.equal(x.held.amount,'1,234.5');assert.equal(x.leader?.price?.amount,'9,999.99');
 assert.equal(x.minimumNextTotalRaw,'1000000');assert.equal(v.spots[0]!.highBidRaw,'999999');assert.equal(v.spots[0]!.yourBidRaw,'123450');
});
test('zero-precision integer grouping preserves the exact next total',()=>{
 const v=view();v.config.decimals=0;v.spots[0]!.highBidRaw='999';v.spots[0]!.yourBidRaw='1234';
 const x=seekerSpotBid(state(v),0);
 assert.equal(x.bid.amount,'1,000');assert.equal(x.held.amount,'1,234');assert.equal(x.leader?.price?.amount,'999');assert.equal(x.minimumNextTotalRaw,'1000');
});
test('large grouped amounts retain all fractional digits and U64 held precision',()=>{
 const v=view();v.config.decimals=6;v.spots[0]!.highBidRaw='12345678901234567890';v.spots[0]!.yourBidRaw='18446744073709551615';
 const x=seekerSpotBid(state(v),0);
 assert.equal(x.bid.amount,'12,345,678,901,234.567891');assert.equal(x.held.amount,'18,446,744,073,709.551615');
 assert.equal(x.leader?.price?.amount,'12,345,678,901,234.56789');assert.equal(x.minimumNextTotalRaw,'12345678901234567891');
});
test('minor-unit amounts keep leading fractional zeroes without fractional grouping',()=>{
 const v=view();v.config.decimals=9;v.config.openingBidRaw='1';v.spots[0]!.highBidRaw='999';v.spots[0]!.yourBidRaw='2';
 const x=seekerSpotBid(state(v),0);
 assert.equal(x.bid.amount,'0.000001');assert.equal(x.held.amount,'0.000000002');assert.equal(x.leader?.price?.amount,'0.000000999');assert.equal(x.minimumNextTotalRaw,'1000');
});
test('maximum supplied precision keeps exact nonzero minor units and known zero',()=>{
 const v=view();v.config.decimals=255;v.config.openingBidRaw='1';v.spots[0]!.highBidRaw='1';v.spots[0]!.yourBidRaw='0';
 const x=seekerSpotBid(state(v),0);
 assert.equal(x.bid.amount,`0.${'0'.repeat(254)}2`);assert.equal(x.leader?.price?.amount,`0.${'0'.repeat(254)}1`);
 assert.equal(x.held.amount,'0');assert.equal(x.held.status,'OK');assert.equal(x.minimumNextTotalRaw,'2');
});
