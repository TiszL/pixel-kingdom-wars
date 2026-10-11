/** Browser DTO assertions are bounds/consistency checks, not signer authority. */
import {describe,expect,it,vi} from 'vitest';
import {PHASE_E_POLICY,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION} from './constants';
import {RealmSaleReviewSchema,validateRealmSaleReview} from './realmSaleReviewApi';
const P=PHASE_E_POLICY.seekerIsland,address=(n:string)=>n.repeat(32),wallet=address('2'),idempotencyKey='12345678-1234-4234-8234-123456789abc';
function fixture(){const now=BigInt(PHASE_E_MINING_PUBLICATION.daySec),payment=BigInt(P.permitPriceLamports);return {
 version:1 as const,wallet,idempotencyKey,saleId:'01'.repeat(16),spot:0,realm:0,
 terms:{round:'0',day:'1',seller:address('3'),developer:address('4'),priorExpiry:'0',validAfter:String(now),validUntil:String(now+BigInt(PHASE_E_SEEKER_SALE.quoteTtlSec))},
 source:{revision:'browser-fixture',genesisHash:address('5'),programId:address('6'),programDataSha256:'ab'.repeat(32),reviewedDeploymentSlot:1,termProofHash:'cd'.repeat(32),snapshotHash:'ef'.repeat(32),termSlot:2,initialSlot:3,blockhashSlot:4,feeSlot:5,costSlot:6,admissionSlot:7},
 quote:{blockhash:address('7'),lastValidBlockHeight:9,unixTimestamp:String(now),needsAccess:false,needsQuota:false,quotaRemaining:P.paidContractsPerSpotDayMax,messageHex:'01'+'ab'.repeat(99),messageSha256:'de'.repeat(32),packetBytes:165,
 rents:[{address:address('8'),space:294,minimumBalanceLamports:'12',existingLamports:'5',maxIncreaseLamports:'7'}],feeLamports:'3',rentLamports:'7',paymentDebitLamports:String(payment),requiredLamports:String(payment+10n),payerLamports:String(payment+20n)},state:'prepared' as const,currentSigningAuthorized:false as const,submissionAuthorized:false as const,
};}
function review(a=fixture()){return {version:1 as const,saleId:a.saleId,wallet:a.wallet,idempotencyKey:a.idempotencyKey,messageSha256:a.quote.messageSha256,sourceRevision:a.source.revision,snapshotHash:'bc'.repeat(32),quoteSlot:a.source.admissionSlot,unixTimestamp:a.quote.unixTimestamp,validUntil:a.terms.validUntil,feeSlot:a.source.admissionSlot+1,bracketSlot:a.source.admissionSlot+2,blockHeight:a.quote.lastValidBlockHeight,feeLamports:a.quote.feeLamports,rentLamports:a.quote.rentLamports,paymentDebitLamports:a.quote.paymentDebitLamports,requiredLamports:a.quote.requiredLamports,payerLamports:a.quote.payerLamports,quotaRemaining:a.quote.quotaRemaining,rents:a.quote.rents.map(r=>({address:r.address,lamports:r.maxIncreaseLamports})),admissionEligible:true as const,signingAuthorized:false as const,paymentAuthorized:false as const,submissionAuthorized:false as const,reservation:false as const};}
describe('original-consent-bound browser sale review',()=>{
 it('accepts exact route facts and lower observed costs without granting new action authority',()=>{
  const a=fixture(),r=review(a);expect(RealmSaleReviewSchema.parse(r)).toEqual(r);expect(validateRealmSaleReview(a,r)).toEqual(r);
  const lower={...r,feeLamports:'2',rentLamports:'6',rents:[{...r.rents[0]!,lamports:'6'}],requiredLamports:String(BigInt(r.paymentDebitLamports)+8n)};expect(validateRealmSaleReview(a,lower)).toEqual(lower);
  for(const [name,value]of Object.entries({admissionEligible:false,signingAuthorized:true,paymentAuthorized:true,submissionAuthorized:true,reservation:true,relayAuthorized:false}))expect(RealmSaleReviewSchema.safeParse({...r,[name]:value}).success).toBe(false);
 });
 it('binds wallet, key, sale, exact message, source revision and original expiry',()=>{
  const a=fixture(),r=review(a);for(const patch of [{wallet:address('9')},{idempotencyKey:'12345678-1234-4234-8234-123456789abd'},{saleId:'02'.repeat(16)},{messageSha256:'01'.repeat(32)},{sourceRevision:r.sourceRevision+'-new'},{validUntil:String(BigInt(r.validUntil)+1n)}])expect(()=>validateRealmSaleReview(a,{...r,...patch})).toThrow();
  expect(()=>validateRealmSaleReview({...a,quote:{...a.quote,requiredLamports:'0'}},r)).toThrow();
 });
 it('pins the observed Clock window, safe source slots and original blockheight cap',()=>{
  const a=fixture(),r=review(a);for(const patch of [{unixTimestamp:String(BigInt(a.terms.validAfter)-1n)},{unixTimestamp:String(BigInt(a.terms.validUntil)+1n)},{quoteSlot:a.source.admissionSlot-1},{feeSlot:r.quoteSlot-1},{bracketSlot:r.feeSlot-1},{blockHeight:a.quote.lastValidBlockHeight+1},{quoteSlot:Number.MAX_SAFE_INTEGER+1}])expect(()=>validateRealmSaleReview(a,{...r,...patch})).toThrow();
  for(const unixTimestamp of [a.terms.validAfter,a.terms.validUntil])expect(validateRealmSaleReview(a,{...r,unixTimestamp}).unixTimestamp).toBe(unixTimestamp);
  const midnight=BigInt(PHASE_E_MINING_PUBLICATION.daySec)*2n,cross={...a,terms:{...a.terms,validAfter:String(midnight-1n),validUntil:String(midnight+1n)},quote:{...a.quote,unixTimestamp:String(midnight-1n)}};
  expect(validateRealmSaleReview(cross,review(cross)).unixTimestamp).toBe(String(midnight-1n));
  expect(()=>validateRealmSaleReview(cross,{...review(cross),unixTimestamp:String(midnight)})).toThrow();
 });
 it('matches a bounded unique rent set by address and refuses per-account overages even when total falls',()=>{
  const a=fixture();a.quote.needsAccess=true;a.quote.rents.push({address:address('9'),space:83,minimumBalanceLamports:'5',existingLamports:'2',maxIncreaseLamports:'3'});a.quote.rentLamports='10';a.quote.requiredLamports=String(BigInt(a.quote.paymentDebitLamports)+13n);
  const r=review(a);expect(validateRealmSaleReview(a,{...r,rents:[...r.rents].reverse()}).rents).toEqual([...r.rents].reverse());
  for(const rents of [r.rents.slice(0,1),[{...r.rents[0]!,address:address('7')},r.rents[1]!],[r.rents[0]!,r.rents[0]!],[{...r.rents[0]!,lamports:'4'},{...r.rents[1]!,lamports:'4'}]]){const rentLamports=String(rents.reduce((n,x)=>n+BigInt(x.lamports),0n)),requiredLamports=String(BigInt(r.paymentDebitLamports)+BigInt(r.feeLamports)+BigInt(rentLamports));expect(()=>validateRealmSaleReview(a,{...r,rents,rentLamports,requiredLamports})).toThrow();}
 });
 it('refuses changed commercial debit, cost caps, insufficient funds and internally inconsistent totals',()=>{
  const a=fixture(),r=review(a);for(const patch of [{paymentDebitLamports:String(BigInt(r.paymentDebitLamports)-1n),requiredLamports:String(BigInt(r.requiredLamports)-1n)},{feeLamports:String(BigInt(a.quote.feeLamports)+1n),requiredLamports:String(BigInt(r.requiredLamports)+1n)},{requiredLamports:'1'},{rentLamports:'1'},{payerLamports:String(BigInt(r.requiredLamports)-1n)},{quotaRemaining:0},{quotaRemaining:P.paidContractsPerSpotDayMax+1}])expect(()=>validateRealmSaleReview(a,{...r,...patch})).toThrow();
  // A buyer who receives both sale legs still pays the recorded rent and fee.
  a.terms.seller=a.wallet;a.terms.developer=a.wallet;a.quote.paymentDebitLamports='0';a.quote.requiredLamports='10';expect(validateRealmSaleReview(a,review(a)).paymentDebitLamports).toBe('0');
 });
 it('bounds arrays before element traversal and rejects hostile numeric strings without BigInt exceptions',()=>{
  const r=review(),touch=vi.fn(()=>{throw Error('unbounded traversal');}),rents=new Array(4);Object.defineProperty(rents,0,{get:touch});expect(RealmSaleReviewSchema.safeParse({...r,rents}).success).toBe(false);expect(touch).not.toHaveBeenCalled();
  for(const value of ['01','-1','1.1','1e4','18446744073709551616','1'.repeat(100000)])expect(RealmSaleReviewSchema.safeParse({...r,requiredLamports:value}).success).toBe(false);
  expect(RealmSaleReviewSchema.safeParse({...r,unixTimestamp:String(1n<<63n)}).success).toBe(false);expect(RealmSaleReviewSchema.safeParse({...r,feeLamports:1n}).success).toBe(false);
 });
 it('owns nested output copies and rejects noncanonical identity plus unknown proof fields',()=>{
  const a=fixture(),r=review(a),copy=validateRealmSaleReview(a,r);r.rents[0]!.lamports='0';expect(copy.rents[0]!.lamports).toBe('7');
  for(const patch of [{wallet:'0'.repeat(32)},{idempotencyKey:idempotencyKey.toUpperCase()},{saleId:'00'.repeat(16)},{snapshotHash:'ABC'.repeat(22)},{sourceRevision:'x'.repeat(129)},{currentSigningAuthorized:false}])expect(RealmSaleReviewSchema.safeParse({...review(a),...patch}).success).toBe(false);
 });
});
