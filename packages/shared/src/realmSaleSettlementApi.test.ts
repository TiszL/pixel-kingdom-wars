/** Owner-attestation consistency, deliberately not a browser RPC/ABI verifier. */
import {describe,expect,it,vi} from 'vitest';
import {PHASE_E_POLICY,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION} from './constants';
import {RealmSaleSettlementSchema,validateRealmSaleSettlement} from './realmSaleSettlementApi';
const P=PHASE_E_POLICY.seekerIsland,address=(n:string)=>n.repeat(32),wallet=address('2'),idempotencyKey='12345678-1234-4234-8234-123456789abc';
const LOADER='BPFLoaderUpgradeab1e11111111111111111111111',CLOCK='SysvarC1ock11111111111111111111111111111111',SYSVAR='Sysvar1111111111111111111111111111111111111';
function fixture(){
 const now=BigInt(PHASE_E_MINING_PUBLICATION.daySec),price=BigInt(P.permitPriceLamports),seller=price*BigInt(P.contractSellerBps)/BigInt(PHASE_E_POLICY.basisPoints),developer=price*BigInt(P.contractDevBps)/BigInt(PHASE_E_POLICY.basisPoints);
 const preparation={version:1 as const,wallet,idempotencyKey,saleId:'01'.repeat(16),spot:0,realm:0,
  terms:{round:'0',day:'1',seller:address('3'),developer:address('4'),priorExpiry:'0',validAfter:String(now),validUntil:String(now+BigInt(PHASE_E_SEEKER_SALE.quoteTtlSec))},
  source:{revision:'browser-fixture',genesisHash:address('5'),programId:address('6'),programDataSha256:'ab'.repeat(32),reviewedDeploymentSlot:1,termProofHash:'cd'.repeat(32),snapshotHash:'ef'.repeat(32),termSlot:2,initialSlot:3,blockhashSlot:4,feeSlot:5,costSlot:6,admissionSlot:7},
  quote:{blockhash:address('7'),lastValidBlockHeight:9,unixTimestamp:String(now),needsAccess:false,needsQuota:false,quotaRemaining:P.paidContractsPerSpotDayMax,messageHex:'01'+'ab'.repeat(99),messageSha256:'de'.repeat(32),packetBytes:165,
   rents:[{address:address('8'),space:294,minimumBalanceLamports:'12',existingLamports:'5',maxIncreaseLamports:'7'}],feeLamports:'3',rentLamports:'7',paymentDebitLamports:String(price),requiredLamports:String(price+10n),payerLamports:String(price+20n)},state:'prepared' as const,currentSigningAuthorized:false as const,submissionAuthorized:false as const};
 const wire={wallet,idempotencyKey,saleId:preparation.saleId,signature:'3'.repeat(88),signedTransactionHex:'01'+'ab'.repeat(64)+preparation.quote.messageHex,wireSha256:'cd'.repeat(32),messageSha256:preparation.quote.messageSha256,acceptedAt:'2026-09-25T12:34:56.123456Z',currentSigningAuthorized:false as const,relayAuthorized:false as const};
 const accounts=[{address:preparation.source.programId,owner:LOADER,executable:true},{address:address('A'),owner:LOADER,executable:false},{address:address('B'),owner:preparation.source.programId,executable:false},{address:address('C'),owner:preparation.source.programId,executable:false},{address:CLOCK,owner:SYSVAR,executable:false},{address:address('8'),owner:preparation.source.programId,executable:false}].map(a=>({...a,exists:true as const,dataSha256:'ab'.repeat(32)}));
 const settlement={wallet,idempotencyKey,saleId:preparation.saleId,signature:wire.signature,
  receipt:{version:1 as const,signature:wire.signature,slot:8,blockTime:null as number|null,originalMessageSha256:wire.messageSha256,signedTransactionSha256:wire.wireSha256,receiptAccountHex:'ab'.repeat(294),feeLamports:'2',actualRentLamports:'6',buyerNetPaymentLamports:String(price),accountRentIncreases:[{address:address('8'),lamports:'6'}],observedAccountSlot:9,proofClockUnixTimestamp:String(now),source:{trust:'trusted-finalized-rpc-reviewed-program' as const,stateProvenance:'fresh-reviewed-deployment' as const,genesisHash:preparation.source.genesisHash,programId:preparation.source.programId,reviewedDeploymentSlot:preparation.source.reviewedDeploymentSlot,reviewedProgramDataSha256:preparation.source.programDataSha256,upgradeAuthority:null as string|null,accounts}},
  purchase:{address:address('8'),buyer:wallet,seller:preparation.terms.seller,developer:preparation.terms.developer,spot:0,realm:0,round:'0',day:'1',acceptedAt:String(now),priorExpiry:'0',coverageStart:String(now),expiresAt:String(now+BigInt(P.permitDurationSec)),priceLamports:String(price),sellerLamports:String(seller),developerLamports:String(developer)},
  settledAt:'2026-09-25T12:34:56.123456Z',purchaseFinalized:true as const,admissionAuthorized:false as const,relayAuthorized:false as const,signingAuthorized:false as const};
 return {preparation,wire,settlement};
}
type Fixture=ReturnType<typeof fixture>;
function check(f:Fixture){return validateRealmSaleSettlement(f.preparation,f.wire,f.settlement);}
function refuses(mutate:(f:Fixture)=>void){const f=fixture();mutate(f);expect(()=>check(f)).toThrow();}
describe('bounded owner-attested realm sale settlement',()=>{
 it('retains lower actual fee/rent and old coverage without requiring current eligibility or blockTime equal Clock',()=>{
  const f=fixture();f.settlement.receipt.blockTime=Number(f.settlement.purchase.acceptedAt)-3;
  expect(check(f)).toEqual(f.settlement);expect(RealmSaleSettlementSchema.parse(f.settlement)).toEqual(f.settlement);
  expect(check(f)).not.toHaveProperty('finalityVerified');expect(check(f)).not.toHaveProperty('journalReleaseAuthorized');
 });
 it('owns and freezes its parsed output so later response mutation cannot change retained success',()=>{
  const f=fixture(),result=check(f);f.settlement.purchase.expiresAt='0';f.settlement.receipt.source.accounts[0]!.address=address('9');
  expect(result.purchase.expiresAt).not.toBe('0');expect(result.receipt.source.accounts[0]!.address).toBe(f.preparation.source.programId);
  expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.receipt.source.accounts)).toBe(true);expect(Object.isFrozen(result.receipt.source.accounts[0])).toBe(true);
  expect(()=>{result.purchase.expiresAt='0';}).toThrow();
 });
 it('preserves alias-aware net debit including a buyer who is both seller and developer',()=>{
  for(const mode of ['seller','developer','both'] as const){const f=fixture();if(mode!=='developer')f.preparation.terms.seller=f.settlement.purchase.seller=wallet;if(mode!=='seller')f.preparation.terms.developer=f.settlement.purchase.developer=wallet;
   const p=f.settlement.purchase,net=BigInt(p.priceLamports)-(p.seller===wallet?BigInt(p.sellerLamports):0n)-(p.developer===wallet?BigInt(p.developerLamports):0n);
   f.preparation.quote.paymentDebitLamports=f.settlement.receipt.buyerNetPaymentLamports=String(net);f.preparation.quote.requiredLamports=String(net+10n);expect(check(f).receipt.buyerNetPaymentLamports).toBe(String(net));
   f.settlement.receipt.buyerNetPaymentLamports=String(net+1n);expect(()=>check(f)).toThrow();
  }
 });
 it('binds original actor/key/sale/signature, declared hashes and exact retained message bytes',()=>{
  const mutations:Array<(f:Fixture)=>void>=[f=>{f.settlement.wallet=address('9');},f=>{f.settlement.idempotencyKey='12345678-1234-4234-8234-123456789abd';},f=>{f.settlement.saleId='02'.repeat(16);},f=>{f.settlement.signature='4'.repeat(88);},f=>{f.settlement.receipt.signature='4'.repeat(88);},f=>{f.wire.wallet=address('9');},f=>{f.wire.idempotencyKey='12345678-1234-4234-8234-123456789abd';},f=>{f.wire.saleId='02'.repeat(16);},f=>{f.wire.messageSha256='ff'.repeat(32);},f=>{f.settlement.receipt.originalMessageSha256='ff'.repeat(32);},f=>{f.settlement.receipt.signedTransactionSha256='ff'.repeat(32);},f=>{f.wire.signedTransactionHex=f.wire.signedTransactionHex.slice(0,-2)+'aa';}];
  for(const mutate of mutations)refuses(mutate);
 });
 it('binds reviewed deployment, monotonic slots and available account identities without inventing PDA validation',()=>{
  const mutations:Array<(f:Fixture)=>void>=[f=>{f.settlement.receipt.source.genesisHash=address('9');},f=>{f.settlement.receipt.source.programId=address('9');},f=>{f.settlement.receipt.source.reviewedDeploymentSlot=0;},f=>{f.settlement.receipt.source.reviewedProgramDataSha256='ff'.repeat(32);},f=>{f.settlement.receipt.slot=7-1;},f=>{f.settlement.receipt.slot=f.preparation.source.reviewedDeploymentSlot;},f=>{f.settlement.receipt.observedAccountSlot=7;},f=>{f.settlement.receipt.source.accounts[0]!.address=address('9');},f=>{f.settlement.receipt.source.accounts[1]!.dataSha256='ff'.repeat(32);},f=>{f.settlement.receipt.source.accounts[4]!.address=address('9');},f=>{f.settlement.receipt.source.accounts[5]!.address=address('9');},f=>{f.settlement.receipt.source.accounts[2]!.owner=address('9');},f=>{f.settlement.receipt.source.accounts[2]!.executable=true;},f=>{f.settlement.receipt.source.accounts[2]!.address=f.settlement.receipt.source.accounts[3]!.address;}];
  for(const mutate of mutations)refuses(mutate);
  const f=fixture();f.preparation.quote.needsAccess=true;f.preparation.quote.rents.unshift({...f.preparation.quote.rents[0]!,address:f.settlement.receipt.source.accounts[3]!.address});f.preparation.quote.rentLamports='14';f.preparation.quote.requiredLamports=String(BigInt(f.preparation.quote.paymentDebitLamports)+17n);f.settlement.receipt.accountRentIncreases.unshift({address:f.settlement.receipt.source.accounts[3]!.address,lamports:'0'});expect(check(f)).toEqual(f.settlement);
  f.settlement.receipt.source.accounts[3]!.address=address('D');expect(()=>check(f)).toThrow();
 });
 it('requires original recipients, term and exact coverage including UTC boundary and prior renewal',()=>{
  const mutations:Array<(f:Fixture)=>void>=[f=>{f.settlement.purchase.buyer=address('9');},f=>{f.settlement.purchase.seller=address('9');},f=>{f.settlement.purchase.developer=address('9');},f=>{f.settlement.purchase.spot=1;},f=>{f.settlement.purchase.realm=1;},f=>{f.settlement.purchase.round='1';},f=>{f.settlement.purchase.day='0';},f=>{f.settlement.purchase.priorExpiry='1';},f=>{f.settlement.purchase.acceptedAt=String(BigInt(f.preparation.terms.validAfter)-1n);},f=>{f.settlement.purchase.acceptedAt=String(BigInt(f.preparation.terms.validUntil)+1n);},f=>{f.settlement.receipt.proofClockUnixTimestamp='0';},f=>{f.settlement.purchase.coverageStart='0';},f=>{f.settlement.purchase.expiresAt=String(BigInt(f.settlement.purchase.expiresAt)+1n);}];for(const mutate of mutations)refuses(mutate);
  const f=fixture(),prior=BigInt(f.settlement.purchase.acceptedAt)+10n;f.preparation.terms.priorExpiry=f.settlement.purchase.priorExpiry=String(prior);f.settlement.purchase.coverageStart=String(prior);f.settlement.purchase.expiresAt=String(prior+BigInt(P.permitDurationSec));expect(check(f)).toEqual(f.settlement);
  const cross=fixture(),midnight=BigInt(PHASE_E_MINING_PUBLICATION.daySec)*2n;cross.preparation.terms.validAfter=String(midnight-1n);cross.preparation.terms.validUntil=String(midnight+1n);cross.preparation.quote.unixTimestamp=String(midnight-1n);cross.settlement.purchase.acceptedAt=cross.settlement.purchase.coverageStart=cross.settlement.receipt.proofClockUnixTimestamp=String(midnight);cross.settlement.purchase.expiresAt=String(midnight+BigInt(P.permitDurationSec));expect(()=>check(cross)).toThrow();
 });
 it('refuses greater fees/rents, changed pool legs and duplicated, reordered or substituted rent plans',()=>{
  const mutations:Array<(f:Fixture)=>void>=[f=>{f.settlement.receipt.feeLamports='4';},f=>{f.settlement.receipt.actualRentLamports='7';},f=>{f.settlement.receipt.accountRentIncreases[0]!.lamports='8';f.settlement.receipt.actualRentLamports='8';},f=>{f.settlement.receipt.accountRentIncreases[0]!.address=address('9');},f=>{f.settlement.receipt.accountRentIncreases.push({...f.settlement.receipt.accountRentIncreases[0]!});},f=>{f.settlement.purchase.priceLamports='0';},f=>{f.settlement.purchase.sellerLamports=String(BigInt(f.settlement.purchase.sellerLamports)+1n);},f=>{f.settlement.purchase.developerLamports=String(BigInt(f.settlement.purchase.developerLamports)+1n);}];for(const mutate of mutations)refuses(mutate);
  const f=fixture();f.preparation.quote.needsAccess=true;f.preparation.quote.rents.unshift({...f.preparation.quote.rents[0]!,address:f.settlement.receipt.source.accounts[3]!.address});f.preparation.quote.rentLamports='14';f.preparation.quote.requiredLamports=String(BigInt(f.preparation.quote.paymentDebitLamports)+17n);f.settlement.receipt.accountRentIncreases.unshift({address:f.settlement.receipt.source.accounts[3]!.address,lamports:'0'});f.settlement.receipt.accountRentIncreases.reverse();expect(()=>check(f)).toThrow();
 });
 it('bounds arrays before touching hostile elements and refuses noncanonical numbers, time, hex and authority',()=>{
  for(const [field,length]of [['accounts',7],['accountRentIncreases',4]] as const){const touch=vi.fn(()=>{throw Error('must not traverse');}),array=new Array(length);Object.defineProperty(array,0,{get:touch});const f=fixture(),r=f.settlement.receipt;
   const raw=field==='accounts'?{...f.settlement,receipt:{...r,source:{...r.source,accounts:array}}}:{...f.settlement,receipt:{...r,accountRentIncreases:array}};
   expect(RealmSaleSettlementSchema.safeParse(raw).success).toBe(false);expect(touch).not.toHaveBeenCalled();
  }
  const f=fixture();for(const value of ['01','-1','1e3','18446744073709551616','1'.repeat(100000)])expect(RealmSaleSettlementSchema.safeParse({...f.settlement,receipt:{...f.settlement.receipt,feeLamports:value}}).success).toBe(false);
  for(const patch of [{settledAt:'2026-02-30T12:34:56.123456Z'},{settledAt:'2026-09-25T12:34:56.123Z'},{relayAuthorized:true},{signingAuthorized:true},{admissionAuthorized:true},{purchaseFinalized:false},{finalityVerified:true},{extra:true}])expect(RealmSaleSettlementSchema.safeParse({...f.settlement,...patch}).success).toBe(false);
  for(const patch of [{receiptAccountHex:'ab'.repeat(295)},{receiptAccountHex:'AB'.repeat(294)},{proofClockUnixTimestamp:String(1n<<63n)},{slot:Number.MAX_SAFE_INTEGER+1},{blockTime:0.5}])expect(RealmSaleSettlementSchema.safeParse({...f.settlement,receipt:{...f.settlement.receipt,...patch}}).success).toBe(false);
 });
});
