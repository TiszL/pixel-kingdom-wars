/** Browser DTO assertions are bounds/consistency checks, not signer authority. */
import {describe,expect,it,vi} from 'vitest';
import {PHASE_E_POLICY,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION} from './constants';
import {RealmSalePreparationSchema,RealmSalePrepareRequestSchema,RealmSalePreparationEnvelopeSchema,RealmSaleSignedWireSchema} from './realmSalesApi';
const P=PHASE_E_POLICY.seekerIsland,address=(n:string)=>n.repeat(32),wallet=address('2'),idempotencyKey='12345678-1234-4234-8234-123456789abc';
function fixture(){const now=BigInt(PHASE_E_MINING_PUBLICATION.daySec),payment=BigInt(P.permitPriceLamports);return {
 version:1 as const,wallet,idempotencyKey,saleId:'01'.repeat(16),spot:0,realm:0,
 terms:{round:'0',day:'1',seller:address('3'),developer:address('4'),priorExpiry:'0',validAfter:String(now),validUntil:String(now+BigInt(PHASE_E_SEEKER_SALE.quoteTtlSec))},
 source:{revision:'browser-fixture',genesisHash:address('5'),programId:address('6'),programDataSha256:'ab'.repeat(32),reviewedDeploymentSlot:1,termProofHash:'cd'.repeat(32),snapshotHash:'ef'.repeat(32),termSlot:2,initialSlot:3,blockhashSlot:4,feeSlot:5,costSlot:6,admissionSlot:7},
 quote:{blockhash:address('7'),lastValidBlockHeight:9,unixTimestamp:String(now),needsAccess:false,needsQuota:false,quotaRemaining:P.paidContractsPerSpotDayMax,messageHex:'01'+'ab'.repeat(99),messageSha256:'de'.repeat(32),packetBytes:165,
 rents:[{address:address('8'),space:294,minimumBalanceLamports:'12',existingLamports:'5',maxIncreaseLamports:'7'}],feeLamports:'3',rentLamports:'7',paymentDebitLamports:String(payment),requiredLamports:String(payment+10n),payerLamports:String(payment+20n)},state:'prepared' as const,currentSigningAuthorized:false as const,submissionAuthorized:false as const,
};}
function signed(){return {wallet,idempotencyKey,saleId:'01'.repeat(16),signature:'3'.repeat(88),signedTransactionHex:'01'+'ab'.repeat(64)+fixture().quote.messageHex,wireSha256:'cd'.repeat(32),messageSha256:'de'.repeat(32),acceptedAt:'2026-09-25T12:34:56.123456Z',currentSigningAuthorized:false as const,relayAuthorized:false as const};}
describe('bounded browser realm sale contracts',()=>{
 it('accepts complete preparation and absent/present actor-bound envelopes without authority',()=>{
  const a=fixture();expect(RealmSalePreparationSchema.parse(a)).toEqual(a);expect(RealmSalePrepareRequestSchema.parse({idempotencyKey,spot:0,realm:0})).toEqual({idempotencyKey,spot:0,realm:0});
  for(const preparation of [null,a])expect(RealmSalePreparationEnvelopeSchema.parse({wallet,idempotencyKey,preparation})).toEqual({wallet,idempotencyKey,preparation});
  for(const extra of [{currentSigningAuthorized:true},{submissionAuthorized:true},{paymentAuthorized:true}])expect(RealmSalePreparationSchema.safeParse({...a,...extra}).success).toBe(false);
  expect(RealmSalePreparationEnvelopeSchema.safeParse({wallet:address('9'),idempotencyKey,preparation:a}).success).toBe(false);expect(RealmSalePreparationEnvelopeSchema.safeParse({wallet,idempotencyKey:'12345678-1234-4234-8234-123456789abd',preparation:a}).success).toBe(false);
 });
 it('validates recipient aliases from shared payment policy instead of assuming a gross buyer debit',()=>{
  for(const mode of ['seller','developer','both'] as const){const a=fixture();if(mode!=='developer')a.terms.seller=wallet;if(mode!=='seller')a.terms.developer=wallet;
   const price=BigInt(P.permitPriceLamports),seller=price*BigInt(P.contractSellerBps)/BigInt(PHASE_E_POLICY.basisPoints),developer=price*BigInt(P.contractDevBps)/BigInt(PHASE_E_POLICY.basisPoints),debit=price-(a.terms.seller===wallet?seller:0n)-(a.terms.developer===wallet?developer:0n);
   a.quote.paymentDebitLamports=String(debit);a.quote.requiredLamports=String(debit+10n);expect(RealmSalePreparationSchema.safeParse(a).success).toBe(true);
   a.quote.paymentDebitLamports=String(debit+1n);a.quote.requiredLamports=String(debit+11n);expect(RealmSalePreparationSchema.safeParse(a).success).toBe(false);
  }
 });
 it('rejects inconsistent rent deficits, sums, packet lengths, duplicate accounts and insufficient approved balance',()=>{
  const a=fixture();for(const quote of [{...a.quote,rentLamports:'8'},{...a.quote,requiredLamports:'1'},{...a.quote,payerLamports:'1'},{...a.quote,packetBytes:a.quote.packetBytes+1},{...a.quote,rents:[{...a.quote.rents[0]!,maxIncreaseLamports:'8'}]},{...a.quote,needsAccess:true,rents:[a.quote.rents[0]!,a.quote.rents[0]!],rentLamports:'14',requiredLamports:String(BigInt(a.quote.paymentDebitLamports)+17n)}])expect(RealmSalePreparationSchema.safeParse({...a,quote}).success).toBe(false);
  const prefunded={...a,quote:{...a.quote,rents:[{...a.quote.rents[0]!,existingLamports:'20',maxIncreaseLamports:'0'}],rentLamports:'0',requiredLamports:String(BigInt(a.quote.paymentDebitLamports)+3n)}};expect(RealmSalePreparationSchema.safeParse(prefunded).success).toBe(true);
 });
 it('refuses oversized arrays before traversing their elements',()=>{
  const touch=vi.fn(()=>{throw Error('must not traverse oversized rents');}),rents=new Array(4);Object.defineProperty(rents,0,{get:touch});
  expect(RealmSalePreparationSchema.safeParse({...fixture(),quote:{...fixture().quote,rents}}).success).toBe(false);expect(touch).not.toHaveBeenCalled();
 });
 it('rejects noncanonical, out-of-range and hostile numeric inputs without throwing',()=>{
  const a=fixture();for(const value of ['01','-1','1.0','1e3','18446744073709551616','1'.repeat(100000)])expect(RealmSalePreparationSchema.safeParse({...a,quote:{...a.quote,feeLamports:value}}).success).toBe(false);
  for(const terms of [{...a.terms,priorExpiry:String(1n<<63n)},{...a.terms,validUntil:String((1n<<63n)-1n)},{...a.terms,day:'18446744073709551615'}])expect(RealmSalePreparationSchema.safeParse({...a,terms}).success).toBe(false);
  for(const patch of [{wallet:'1'.repeat(100000)},{wallet:'0'.repeat(32)},{idempotencyKey:idempotencyKey.toUpperCase()},{saleId:'00'.repeat(16)},{spot:P.totalSpots},{realm:P.realmCount}])expect(RealmSalePreparationSchema.safeParse({...a,...patch}).success).toBe(false);
  expect(RealmSalePrepareRequestSchema.safeParse({idempotencyKey,spot:0,realm:0,wallet}).success).toBe(false);
 });
 it('requires ordered safe slots and bounded UTC day/quote windows without consulting local now',()=>{
  const a=fixture();expect(RealmSalePreparationSchema.safeParse({...a,source:{...a.source,costSlot:2}}).success).toBe(false);expect(RealmSalePreparationSchema.safeParse({...a,source:{...a.source,admissionSlot:Number.MAX_SAFE_INTEGER+1}}).success).toBe(false);
  for(const quote of [{...a.quote,unixTimestamp:'0'},{...a.quote,quotaRemaining:P.paidContractsPerSpotDayMax+1}])expect(RealmSalePreparationSchema.safeParse({...a,quote}).success).toBe(false);
  const midnight=BigInt(PHASE_E_MINING_PUBLICATION.daySec)*2n;const cross={...a,terms:{...a.terms,validAfter:String(midnight-1n),validUntil:String(midnight+1n)},quote:{...a.quote,unixTimestamp:String(midnight-1n)}};expect(RealmSalePreparationSchema.safeParse(cross).success).toBe(true);
  expect(RealmSalePreparationSchema.safeParse({...cross,terms:{...cross.terms,validAfter:String(midnight)}}).success).toBe(false);
 });
 it('strictly bounds retained one-signature packet metadata and six-digit UTC receipts',()=>{
  const s=signed();expect(RealmSaleSignedWireSchema.parse(s)).toEqual(s);
  for(const patch of [{relayAuthorized:true},{currentSigningAuthorized:true},{extra:true},{signature:'0'.repeat(88)},{signedTransactionHex:'01'+'00'.repeat(64)+'01'},{signedTransactionHex:'02'+s.signedTransactionHex.slice(2)},{signedTransactionHex:'01'+'ab'.repeat(64)+'02'},{signedTransactionHex:s.signedTransactionHex.toUpperCase()},{signedTransactionHex:'aa'.repeat(1233)},{acceptedAt:'2026-02-30T12:34:56.123456Z'},{acceptedAt:'2026-09-25T12:34:56.123Z'}])expect(RealmSaleSignedWireSchema.safeParse({...s,...patch}).success).toBe(false);
 });
});
