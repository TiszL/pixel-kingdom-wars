import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accountLandModel, accountKingdomsModel, type LandAdapterInput, type KingdomsAdapterInput } from './accountAdapters';

function land():LandAdapterInput {
 return {entry:{phase:'idle',reservation:null,error:null,paymentSignature:null},kind:'entry',walletLinked:true,entryPaid:false,actionsEnabled:true,serverOffReason:null,
  quotedPrice:{currency:'SOL',amount:'0.2',status:'OK'},formatReservedLamports:raw=>String(raw/1_000_000_000)};
}
function kingdoms():KingdomsAdapterInput {
 return {wallet:'wallet',entryPaid:false,selectedBaseId:'base',loading:false,busy:false,error:null,realmLabel:()=> 'Crownlands',
  directory:{enabled:true,maxActive:5,nextLandPurchaseKind:'entry',capabilities:{baseScopedReads:true,baseScopedMutations:true,cellReservations:true},
   bases:[{id:'base',status:'active',slot:1,deedAssetId:null,keepLevel:3,builders:1,expansions:0,landPaidAt:null,earthCell:null,countryA3:null}]},
  freePurchase:{actionsAllowed:true,refreshError:null,state:{loaded:true,busy:false,journal:null,review:null,error:null},
   snapshot:{enabled:true,balances:null,view:{version:1,wallet:'wallet',sourceBaseId:'base',enabled:true,terms:{policyVersion:1,costShards:'9007199254740993',minKeepLevel:3,minWorkshopLevel:2,minGoldForgeLevel:2,maxFreeBases:2,maxActiveBases:5},admission:{allowed:true,reason:'ready'},receipt:null}}}};
}
function withSaved(x:KingdomsAdapterInput):KingdomsAdapterInput {
 const terms=x.freePurchase.snapshot!.view.terms;
 x.freePurchase.state.journal={version:1,identity:{origin:'https://game.example',api:'https://api.example',cluster:'devnet',wallet:'wallet'},revision:1,archives:[],
  operation:{command:{request:{sourceBaseId:'base',idempotencyKey:'original-key'},terms},attemptRevision:1,proof:null,refusal:null}};
 return x;
}
test('land starts at the existing choose-land navigation and never emits a payment command',()=>{
 assert.deepEqual(accountLandModel(land()).primary,{id:'land.choose',label:'CHOOSE REALM',state:'ENABLED',kind:'navigate',price:{currency:'SOL',amount:'0.2',status:'OK'}});
});
test('unlinked wallet opens connect instead of a land payment',()=>{
 const x=land();x.walletLinked=false;const m=accountLandModel(x);assert.equal(m.primary?.id,'wallet.connect');assert.equal(m.primary?.kind,'navigate');
});
test('unknown ownership fails closed instead of acting landless',()=>{const x=land();x.entryPaid=null;assert.equal(accountLandModel(x).primary?.state,'DISABLED');});
test('server hold blocks new land action and preserves its supplied reason',()=>{
 const x=land();x.serverOffReason='Land purchases paused';assert.equal(accountLandModel(x).primary?.state,'LOCKED');assert.equal(accountLandModel(x).primary?.reason,x.serverOffReason);
});
for(const phase of ['restoring','reserving','paying','confirming'] as const)test(`land ${phase} cannot offer another payment`,()=>{
 const x=land();x.entry.phase=phase;const m=accountLandModel(x);assert.equal(m.primary?.state,'BUSY');assert.notEqual(m.primary?.kind,'confirm');assert.doesNotMatch(m.note??'',/Nothing was spent/);
});
test('land ready uses the reserved quote and review only',()=>{
 const x=land();x.entry.phase='ready';x.entry.reservation={id:'intent',reference:'ref',kind:'entry',baseId:'base',amountLamports:300_000_000,countryA3:null,countryName:null};
 const m=accountLandModel(x);assert.equal(m.primary?.price?.amount,'0.3');assert.equal(m.primary?.kind,'review');assert.equal(m.primary?.id,'land.payment.review');
});
test('ready without a reservation cannot create a payable price',()=>{
 const x=land();x.entry.phase='ready';const m=accountLandModel(x);assert.equal(m.primary?.state,'DISABLED');assert.equal(m.primary?.price?.status,'UNAVAILABLE');
});
test('land failure never claims no spend and routes to the existing history',()=>{
 const x=land();x.entry.phase='failed';x.entry.error='Payment requires support';const m=accountLandModel(x);
 assert.equal(m.primary?.id,'land.history');assert.equal(m.primary?.kind,'navigate');assert.match(m.note??'',/Payment requires support/);assert.doesNotMatch(m.note??'',/Nothing was spent/);
});
test('credited payment is not a minted-deed celebration',()=>{
 const x=land();x.entry.phase='credited';const m=accountLandModel(x);assert.equal(m.primary?.id,'account.profile.kingdoms');assert.match(m.note??'',/Payment confirmed/);assert.doesNotMatch(m.note??'',/deed is ready|minted/i);
});
test('new-action hold does not erase a failed payment history route',()=>{
 const x=land();x.actionsEnabled=false;x.entry.phase='failed';assert.equal(accountLandModel(x).primary?.id,'land.history');
});
test('KINGDOMS maps existing base identity and current selection without inventing a kingdom name',()=>{
 const m=accountKingdomsModel(kingdoms());assert.equal(m.rows[0]?.id,'base');assert.equal(m.rows[0]?.title,'KEEP 3');assert.equal(m.rows[0]?.tag,'CURRENT');assert.equal(m.rows[0]?.action?.state,'DISABLED');
});
test('second free camp has the exact server SHARDS cost and never claims free SOL land',()=>{
 const m=accountKingdomsModel(kingdoms());assert.deepEqual(m.primary?.price,{currency:'SHARDS',amount:'9,007,199,254,740,993',status:'OK'});assert.equal(m.primary?.id,'kingdom.purchase.begin');assert.equal(m.primary?.kind,'review');assert.equal(m.summary?.additionalLandPrice,null);
});
test('insufficient SHARDS preserves server reason without guessing a deficit',()=>{
 const x=kingdoms();x.freePurchase.snapshot!.enabled=false;x.freePurchase.snapshot!.view.admission={allowed:false,reason:'insufficient-shards'};
 const m=accountKingdomsModel(x);assert.equal(m.primary?.state,'LOCKED');assert.match(m.primary?.reason??'',/SHARDS/);assert.notEqual(m.primary?.price?.status,'SHORT');
});
test('snapshot for another wallet cannot expose a price or admit purchase',()=>{
 const x=kingdoms();x.freePurchase.snapshot!.view.wallet='other';const m=accountKingdomsModel(x);assert.equal(m.primary?.state,'DISABLED');assert.equal(m.primary?.price?.status,'UNAVAILABLE');
});
test('snapshot for another selected base cannot admit purchase',()=>{
 const x=kingdoms();x.selectedBaseId='other';assert.equal(accountKingdomsModel(x).primary?.state,'DISABLED');
});
test('unavailable purchase snapshot is unknown, never a zero or free quote',()=>{
 const x=kingdoms();x.freePurchase.snapshot=null;const m=accountKingdomsModel(x);assert.equal(m.primary?.price?.status,'UNAVAILABLE');assert.equal(m.primary?.price?.amount,null);
});
test('pending original purchase remains GET recovery when new actions are disabled',()=>{
 const x=withSaved(kingdoms());x.freePurchase.actionsAllowed=false;x.freePurchase.snapshot=null;const m=accountKingdomsModel(x);
 assert.equal(m.primary?.id,'kingdom.purchase.recover');assert.equal(m.primary?.kind,'recover');assert.equal(m.primary?.state,'ENABLED');
});
test('saved request from another wallet is never offered for recovery',()=>{
 const x=withSaved(kingdoms());x.freePurchase.state.journal!.identity.wallet='other';assert.notEqual(accountKingdomsModel(x).primary?.id,'kingdom.purchase.recover');assert.equal(accountKingdomsModel(x).primary?.state,'DISABLED');
});
test('unattempted original purchase offers its own review and never starts a new command',()=>{
 const x=withSaved(kingdoms());x.freePurchase.state.journal!.operation!.attemptRevision=null;
 assert.equal(accountKingdomsModel(x).primary?.id,'kingdom.purchase.review');
});
test('an original draft on another selected kingdom stays recovery-only',()=>{
 const x=withSaved(kingdoms());x.freePurchase.state.journal!.operation!.attemptRevision=null;x.selectedBaseId='other';
 assert.equal(accountKingdomsModel(x).primary?.id,'kingdom.purchase.recover');assert.equal(accountKingdomsModel(x).primary?.kind,'recover');
});
test('definitive refusal keeps the original recovery path without auto-archiving',()=>{
 const x=withSaved(kingdoms());x.freePurchase.state.journal!.operation!.refusal={phase:'first_post',status:422,code:'INSUFFICIENT_SHARDS'};
 const m=accountKingdomsModel(x);assert.equal(m.primary?.id,'kingdom.purchase.recover');assert.notEqual(m.primary?.kind,'confirm');
});
test('loading directory retains rows but blocks stale switches and purchase review',()=>{
 const x=kingdoms();x.loading=true;x.selectedBaseId=null;const m=accountKingdomsModel(x);assert.equal(m.rows[0]?.id,'base');assert.equal(m.rows[0]?.action?.state,'DISABLED');assert.notEqual(m.primary?.state,'ENABLED');
});
test('failed directory read keeps prior rows without enabling their actions',()=>{
 const x=kingdoms();x.error='Ownership unavailable';x.selectedBaseId=null;const m=accountKingdomsModel(x);assert.equal(m.load,'ERROR');assert.equal(m.rows[0]?.action?.state,'DISABLED');
});
test('server nextLandPurchaseKind determines the separate land door',()=>{
 const x=kingdoms();x.directory!.nextLandPurchaseKind='deed';const row=accountKingdomsModel(x).rows.find(r=>r.id==='account.land');assert.equal(row?.action?.id,'land.deed');
});
test('inactive deed routes to existing management instead of a direct activation',()=>{
 const x=kingdoms();x.directory!.bases[0]!.status='inactive';x.directory!.bases[0]!.slot=null;const row=accountKingdomsModel(x).rows[0];assert.equal(row?.action?.id,'kingdom.manage:base');assert.equal(row?.action?.kind,'navigate');
});
test('account mapper owns no hook, network, wallet call, storage or clock',()=>{
 const src=readFileSync(new URL('./accountAdapters.ts',import.meta.url),'utf8');assert.doesNotMatch(src,/\bfetch\s*\(|localStorage|indexedDB|\bDate\b|setInterval|signTransaction|\.confirm\s*\(/);
 for(const line of src.split('\n').filter(x=>/^import\b/.test(x)))assert.match(line,/^import type /);
});

// Lantern861478c1 M1/m1: preserve recovery and add explicit confirmed exits.
test('definitive refusal exposes a separate confirmed archive and its server reason',()=>{
 const x=withSaved(kingdoms());x.freePurchase.state.journal!.operation!.refusal={phase:'first_post',status:422,code:'INSUFFICIENT_SHARDS'};
 const m=accountKingdomsModel(x);assert.equal(m.primary?.id,'kingdom.purchase.recover');
 const row=m.rows.find(r=>r.id==='kingdom.purchase.refusal');assert.match(row?.sub??'',/INSUFFICIENT_SHARDS/);
 assert.deepEqual(row?.action,{id:'kingdom.purchase.archive',label:'ARCHIVE REFUSAL',state:'ENABLED',kind:'confirm'});
 assert.equal(x.freePurchase.state.journal!.operation!.refusal!.code,'INSUFFICIENT_SHARDS');assert.match(row?.sub??'',/Not enough SHARDS/);
});
test('attempted ambiguous purchase never exposes archive or draft abandonment',()=>{
 const x=withSaved(kingdoms());x.freePurchase.actionsAllowed=false;x.freePurchase.state.error='Answer lost';
 const m=accountKingdomsModel(x);assert.equal(m.primary?.id,'kingdom.purchase.recover');
 assert.ok(m.rows.every(r=>!['kingdom.purchase.archive','kingdom.purchase.abandon'].includes(r.action?.id??'')));
});
test('an unattempted unavailable original draft may be discarded only through confirmation',()=>{
 const x=withSaved(kingdoms());x.freePurchase.state.journal!.operation!.attemptRevision=null;x.selectedBaseId='other';
 const m=accountKingdomsModel(x);assert.equal(m.primary?.id,'kingdom.purchase.recover');
 assert.deepEqual(m.rows.find(r=>r.id==='kingdom.purchase.draft')?.action,{id:'kingdom.purchase.abandon',label:'DISCARD UNSENT REQUEST',state:'ENABLED',kind:'confirm'});
});
test('busy or unread recovery cannot archive a refusal',()=>{
 for(const loading of [true,false]){const x=withSaved(kingdoms());x.freePurchase.state.journal!.operation!.refusal={phase:'first_post',status:422,code:'INSUFFICIENT_SHARDS'};x.freePurchase.state.busy=loading;x.freePurchase.state.loaded=loading;
 assert.equal(accountKingdomsModel(x).rows.find(r=>r.id==='kingdom.purchase.refusal')?.action?.state,'BUSY');}
});
test('another wallet cannot inspect or discard the original refusal',()=>{
 const x=withSaved(kingdoms());x.freePurchase.state.journal!.identity.wallet='other';x.freePurchase.state.journal!.operation!.refusal={phase:'first_post',status:422,code:'INSUFFICIENT_SHARDS'};
 assert.ok(accountKingdomsModel(x).rows.every(r=>r.id!=='kingdom.purchase.refusal'));
});
test('accepted receipt has only authoritative finish and no archive or abandon action',()=>{
 const x=withSaved(kingdoms());x.freePurchase.state.journal!.operation!.refusal={phase:'first_post',status:422,code:'INSUFFICIENT_SHARDS'};x.freePurchase.state.journal!.operation!.proof={status:'accepted',receipt:{} as never};
 const m=accountKingdomsModel(x);assert.equal(m.primary?.id,'kingdom.purchase.finish');assert.ok(m.rows.every(r=>!r.id.startsWith('kingdom.purchase.')));
});
test('SHARDS grouping preserves every canonical digit without mutating reviewed terms',()=>{
 const x=kingdoms();const canonical=x.freePurchase.snapshot!.view.terms.costShards;
 const amount=accountKingdomsModel(x).primary?.price?.amount;assert.equal(amount,'9,007,199,254,740,993');assert.equal(amount?.replaceAll(',',''),canonical);assert.equal(x.freePurchase.snapshot!.view.terms.costShards,canonical);
 x.freePurchase.snapshot!.view.terms.costShards='12';assert.equal(accountKingdomsModel(x).primary?.price?.amount,'12');
});
test('durable server refusal copy never mislabels a client lock error',()=>{const x=withSaved(kingdoms());x.freePurchase.state.error='Another tab owns the lock';x.freePurchase.state.journal!.operation!.refusal={phase:'first_post',status:422,code:'INSUFFICIENT_SHARDS'};const m=accountKingdomsModel(x);assert.equal(m.note,'Another tab owns the lock');const sub=m.rows.find(r=>r.id==='kingdom.purchase.refusal')?.sub??'';assert.match(sub,/Server reason: Not enough SHARDS.*INSUFFICIENT_SHARDS/);assert.doesNotMatch(sub,/Another tab/);});
test('all eleven definitive refusal codes have player-facing text beside the code',()=>{const x=withSaved(kingdoms());const reasons:Record<string,string>={BASE_NOT_OWNED:'no longer yours',BASE_ID_REQUIRED:'Choose the original',DEED_OWNERSHIP_CHANGED:'ownership changed',BASE_BEING_RAIDED:'being raided',DEED_AUTHORITY_UNAVAILABLE:'could not be verified',PHASE_E_DISABLED:'not open',FREE_BASE_SOURCE_REQUIRED:'free camp',FREE_BASE_SOURCE_RESERVED:'saved purchase request',BASE_SLOTS_FULL:'slots are full',FREE_BASE_DEVELOPMENT_REQUIRED:'Develop',INSUFFICIENT_SHARDS:'Not enough SHARDS'};for(const [code,copy] of Object.entries(reasons)){x.freePurchase.state.journal!.operation!.refusal={phase:'first_post',status:422,code};const sub=accountKingdomsModel(x).rows.find(r=>r.id==='kingdom.purchase.refusal')?.sub??'';assert.ok(sub.includes(code),code);assert.ok(sub.includes(copy),copy);}});
test('unattempted same-scope admission-refused draft has a confirm-class discard',()=>{const x=withSaved(kingdoms());x.freePurchase.state.journal!.operation!.attemptRevision=null;x.freePurchase.snapshot!.view.admission={allowed:false,reason:'insufficient-shards'};assert.equal(accountKingdomsModel(x).rows.find(r=>r.id==='kingdom.purchase.draft')?.action?.kind,'confirm');});
test('unsent discard row survives directory reload without changing its controller gate',()=>{const x=withSaved(kingdoms());x.freePurchase.state.journal!.operation!.attemptRevision=null;for(const loading of [false,true,false]){x.loading=loading;assert.equal(accountKingdomsModel(x).rows.find(r=>r.id==='kingdom.purchase.draft')?.action?.state,'ENABLED');}x.freePurchase.state.busy=true;assert.equal(accountKingdomsModel(x).rows.find(r=>r.id==='kingdom.purchase.draft')?.action?.state,'BUSY');});
