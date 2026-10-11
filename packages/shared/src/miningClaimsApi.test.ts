import {describe,it,expect,vi} from 'vitest';
import {MiningClaimStatusViewSchema,MiningClaimPreparationViewSchema,MiningClaimPreparationEnvelopeSchema,MiningClaimViewSchema,MiningClaimPrepareRequestSchema,MiningClaimSubmitRequestSchema,MiningClaimSubmitResponseSchema} from './miningClaimsApi';
const wallet='11111111111111111111111111111111',id='00000000-0000-4000-8000-000000000001',now='2035-01-01T00:00:00.000Z';
const status={features:{claims:{version:1,receipts:1}},wallet,program:'shardkeep-economy',programId:null,keepMint:null,state:'unavailable',reason:'DISABLED',rootSequence:null,claimableBaseUnits:null,cumulativeKeepBaseUnits:null,claimedBaseUnits:null,decimals:9,observedSlot:null,chainUnixTimestamp:null,claimableAfterUnixTimestamp:null,needsAta:null,needsMinerRecords:null,preparationAllowed:false,claimSubmissionAuthorized:false,serverNow:now};
const prepared={version:1,wallet,idempotencyKey:id,claimId:id,quoteId:id,quoteVersion:1,rootSequence:'1',day:'1',root:'ab'.repeat(32),totalCumulativeBaseUnits:'8',identity:{genesisHash:wallet,programId:wallet,configAddress:wallet,keepMint:wallet,reserveOwner:wallet},leaf:{wallet,rootSequence:'1',cumulativeKeepBaseUnits:'8',cumulativeRenown:'0',cumulativeDays:'0'},proof:[],needsAta:true,needsMinerRecords:true,fees:{feeLamports:'5',rentLamports:'10',totalLamports:'15',payerBalanceLamports:'20'},transactions:[{ordinal:0,kind:'combined',version:'legacy',message:'AQ==',lookupTables:[],feePayer:wallet,blockhash:wallet,lastValidBlockHeight:99,feeLamports:'5',rentLamports:'10'}],preparedAt:now,expiresAt:'2035-01-01T00:02:00.000Z',serverNow:now,state:'prepared',currentSigningAuthorized:false,claimSubmissionAuthorized:false};
const claim={version:1,wallet,claimId:id,state:'unknown',landing:'pending',signature:null,settledBaseUnits:null,transactions:[],serverNow:now,claimSubmissionAuthorized:false};
describe('bounded public mining claim contract',()=>{
 it('keeps unsupported evidence unavailable with null amounts and accepts known zero only when proved',()=>{
  expect(MiningClaimStatusViewSchema.safeParse(status).success).toBe(true);expect(MiningClaimStatusViewSchema.safeParse({...status,claimableBaseUnits:'0'}).success).toBe(false);
  const known={...status,state:'no_allocation',reason:null,rootSequence:'1',claimableBaseUnits:'0',observedSlot:1,chainUnixTimestamp:'10'};expect(MiningClaimStatusViewSchema.safeParse(known).success).toBe(true);
  expect(MiningClaimStatusViewSchema.safeParse({...known,preparationAllowed:true}).success).toBe(false);
 });
 it('requires exact positive ready quantities, sequence and clock rather than accepting contradictory state',()=>{
  const ready={...status,state:'ready',reason:null,rootSequence:'1',claimableBaseUnits:'5',cumulativeKeepBaseUnits:'8',claimedBaseUnits:'3',observedSlot:1,chainUnixTimestamp:'10',claimableAfterUnixTimestamp:'9',needsAta:false,needsMinerRecords:false,preparationAllowed:true};
  expect(MiningClaimStatusViewSchema.safeParse(ready).success).toBe(true);
  for(const delta of [{claimableBaseUnits:'6'},{claimableBaseUnits:'0'},{chainUnixTimestamp:'8'},{preparationAllowed:false}])expect(MiningClaimStatusViewSchema.safeParse({...ready,...delta}).success).toBe(false);
  expect(MiningClaimStatusViewSchema.safeParse({...ready,state:'delayed',preparationAllowed:false,chainUnixTimestamp:'8'}).success).toBe(true);
 });
 it('binds quotes to wallet/key/leaf/fee payer with explicit exact SOL estimates',()=>{
  expect(MiningClaimPreparationViewSchema.safeParse(prepared).success).toBe(true);
  for(const delta of [{quoteId:'00000000-0000-4000-8000-000000000002'},{rootSequence:'2'},{fees:{...prepared.fees,totalLamports:'14'}},{leaf:{...prepared.leaf,cumulativeKeepBaseUnits:'0'}},{currentSigningAuthorized:true},{transactions:[{...prepared.transactions[0],lookupTables:[wallet]}]}])expect(MiningClaimPreparationViewSchema.safeParse({...prepared,...delta}).success).toBe(false);
  expect(MiningClaimPreparationViewSchema.safeParse({...prepared,transactions:[{...prepared.transactions[0],message:'AR=='}]}).success).toBe(false);
 });
 it('bounds amounts before BigInt even when other refinements already failed',()=>{
  const big=vi.spyOn(globalThis,'BigInt');
  try{for(const value of ['x','01','-1','18446744073709551616','9'.repeat(100000)])expect(MiningClaimPreparationViewSchema.safeParse({...prepared,fees:{...prepared.fees,totalLamports:value}}).success).toBe(false);expect(big.mock.calls.some(([v])=>v==='x'||v==='01'||v==='-1'||typeof v==='string'&&v.length>20)).toBe(false);}finally{big.mockRestore();}
 });
 it('supports receipt recovery envelopes without inventing missing preparations',()=>{
  expect(MiningClaimPreparationEnvelopeSchema.safeParse({wallet,idempotencyKey:id,status:'unknown',receipt:null,serverNow:now}).success).toBe(true);
  expect(MiningClaimPreparationEnvelopeSchema.safeParse({wallet,idempotencyKey:id,status:'prepared',receipt:prepared,serverNow:now}).success).toBe(true);
  expect(MiningClaimPreparationEnvelopeSchema.safeParse({wallet,idempotencyKey:id,status:'unknown',receipt:prepared,serverNow:now}).success).toBe(false);
 });
 it('distinguishes retained signatures from finalized claim payment, including setup-only finality',()=>{
  expect(MiningClaimViewSchema.safeParse(claim).success).toBe(true);
  expect(MiningClaimViewSchema.safeParse({...claim,settledBaseUnits:'0'}).success).toBe(false);
  expect(MiningClaimViewSchema.safeParse({...claim,state:'settled',landing:'finalized',settledBaseUnits:'8'}).success).toBe(false);
  expect(MiningClaimViewSchema.safeParse({...claim,state:'submitted'}).success).toBe(false);
 });
 it('retains both split signatures while setup finality alone never becomes a settled KEEP payment',()=>{
  const signature='1'.repeat(63)+'2',second='1'.repeat(63)+'3';
  const split={...prepared,fees:{...prepared.fees,feeLamports:'10',totalLamports:'20'},transactions:[{...prepared.transactions[0],kind:'setup'},{...prepared.transactions[0],ordinal:1,kind:'claim',rentLamports:'0'}]};
  expect(MiningClaimPreparationViewSchema.safeParse(split).success).toBe(true);
  const transactions=[{ordinal:0,kind:'setup',signature,landing:'finalized',settledBaseUnits:'0',acceptedAt:now,settledAt:now},{ordinal:1,kind:'claim',signature:second,landing:'pending',settledBaseUnits:null,acceptedAt:now,settledAt:null}];
  const retained={...claim,state:'retained',signature:second,transactions};expect(MiningClaimViewSchema.safeParse(retained).success).toBe(true);
  expect(MiningClaimViewSchema.safeParse({...retained,state:'settled',landing:'finalized',settledBaseUnits:'0'}).success).toBe(false);
  expect(MiningClaimViewSchema.safeParse({...retained,state:'settled',landing:'finalized',settledBaseUnits:'8',transactions:[transactions[0],{...transactions[1],landing:'finalized',settledBaseUnits:'8',settledAt:now}]}).success).toBe(true);
 });
 it('admits a verified failed transaction without inventing a settled amount or zero-cost payment',()=>{
  const signature='1'.repeat(63)+'2',tx={ordinal:0,kind:'combined',signature,landing:'failed',settledBaseUnits:null,acceptedAt:now,settledAt:now};
  const failed={...claim,state:'failed',landing:'failed',signature,transactions:[tx]};expect(MiningClaimViewSchema.safeParse(failed).success).toBe(true);
  for(const delta of [{settledBaseUnits:'0'},{transactions:[{...tx,settledAt:null}]},{transactions:[{...tx,signature:null}]},{transactions:[{...tx,settledBaseUnits:'8'}]}])expect(MiningClaimViewSchema.safeParse({...failed,...delta}).success).toBe(false);
 });
 it('does not close a split claim while any signed ordinal is unresolved and gives actual payment precedence',()=>{
  const first='1'.repeat(63)+'2',second='1'.repeat(63)+'3';
  const setup={ordinal:0,kind:'setup',signature:first,landing:'failed',settledBaseUnits:null,acceptedAt:now,settledAt:now};
  const pending={ordinal:1,kind:'claim',signature:second,landing:'pending',settledBaseUnits:null,acceptedAt:now,settledAt:null};
  const base={...claim,state:'retained',signature:second,transactions:[setup,pending]};expect(MiningClaimViewSchema.safeParse(base).success).toBe(true);
  expect(MiningClaimViewSchema.safeParse({...base,state:'failed',landing:'failed',signature:first}).success).toBe(false);
  expect(MiningClaimViewSchema.safeParse({...base,state:'failed',landing:'failed',transactions:[setup,{...pending,landing:'failed',settledAt:now}]}).success).toBe(true);
  expect(MiningClaimViewSchema.safeParse({...base,state:'settled',landing:'finalized',settledBaseUnits:'8',transactions:[setup,{...pending,landing:'finalized',settledAt:now,settledBaseUnits:'8'}]}).success).toBe(true);
 });
 it('refuses player prices/identities, oversized/noncanonical signed base64 and accidental public internal fields',()=>{
  expect(MiningClaimPrepareRequestSchema.safeParse({idempotencyKey:id}).success).toBe(true);expect(MiningClaimPrepareRequestSchema.safeParse({idempotencyKey:id,wallet}).success).toBe(false);
  expect(MiningClaimSubmitRequestSchema.safeParse({claimId:id,signedTransaction:Buffer.alloc(66,1).toString('base64')}).success).toBe(true);
  for(const signedTransaction of ['AR==','a'.repeat(100000),Buffer.alloc(1233).toString('base64')])expect(MiningClaimSubmitRequestSchema.safeParse({claimId:id,signedTransaction}).success).toBe(false);
  expect(MiningClaimPreparationViewSchema.safeParse({...prepared,reviewedProgramDataSha256:'ab'.repeat(32)}).success).toBe(false);
  expect(MiningClaimSubmitResponseSchema.safeParse({claimId:id,signature:'1'.repeat(63)+'2',serverNow:now,delivery:'held',reason:'DISABLED'}).success).toBe(true);
 });
});

it('requires explicit ordered opt-in without changing the original default request',()=>{
 expect(MiningClaimPrepareRequestSchema.parse({idempotencyKey:id})).toEqual({idempotencyKey:id});
 expect(MiningClaimPrepareRequestSchema.parse({idempotencyKey:id,profile:'ordered-v0'})).toEqual({idempotencyKey:id,profile:'ordered-v0'});
 for(const profile of ['v0','legacy',0,null])expect(MiningClaimPrepareRequestSchema.safeParse({idempotencyKey:id,profile}).success).toBe(false);
});
it('ordered preparations require the complete two-packet fee plan and exact table snapshot',()=>{
 const lookup={address:wallet,owner:wallet,executable:false,dataHex:'00'.repeat(152),slot:5};
 const format={version:1,preset:'ordered-v0',lookupTable:lookup,expectedLookupTable:{address:wallet,dataSha256:'00'.repeat(32)},blockhashContextSlot:6};
 const p={...prepared,version:2,format,fees:{...prepared.fees,feeLamports:'10',totalLamports:'20'},transactions:[{...prepared.transactions[0],kind:'setup',version:'v0',lookupTables:[lookup]},{...prepared.transactions[0],ordinal:1,kind:'claim',version:'v0',lookupTables:[lookup],rentLamports:'0'}]};
 expect(MiningClaimPreparationViewSchema.safeParse(p).success).toBe(true);
 for(const delta of [{transactions:[p.transactions[0]]},{fees:prepared.fees},{format:{...format,blockhashContextSlot:4}},{transactions:[p.transactions[0],{...p.transactions[1],lookupTables:[{...lookup,slot:4}]}]}])expect(MiningClaimPreparationViewSchema.safeParse({...p,...delta}).success).toBe(false);
});
