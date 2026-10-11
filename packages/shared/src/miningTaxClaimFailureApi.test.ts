import {describe,it,expect} from 'vitest';
import {MiningTaxClaimRecoveryEnvelopeSchema as recoverySchema} from './miningTaxClaimRecoveryApi';
import fixtures from './testFixtures/miningTaxClaimRecoveryApi.json';
import {MiningTaxClaimFailureEnvelopeSchema as schema} from './miningTaxClaimFailureApi';
function fixture(mode:'claim'|'combined'|'split'='claim',ordinal=0){
 const recovery=recoverySchema.parse(structuredClone(fixtures[mode])),p=recovery.preparation!,w=recovery.wires[ordinal]!;
 recovery.settlement=null;recovery.status='signed';
 const receipt={version:1,wallet:p.wallet,idempotencyKey:p.idempotencyKey,claimId:p.claimId,round:p.round,spot:p.spot,ordinal,kind:w.kind,signature:w.signature,messageSha256:w.messageSha256,signedTransactionSha256:w.wireSha256,
  slot:Math.max(p.source.snapshotSlot,p.source.blockhashSlot)+1,blockTime:Number(p.snapshot.unixTimestamp),feeLamports:'18446744073709551615',rentLamports:'0',paidKeepBaseUnits:'0',
  source:{trust:'trusted-finalized-rpc-reviewed-program',genesisHash:p.identity.genesisHash,programId:p.identity.programId,configAddress:p.identity.configAddress,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,reviewedProgramDataSha256:p.source.reviewedProgramDataSha256,snapshotSha256:p.source.snapshotSha256,snapshotSlot:p.source.snapshotSlot,blockhashSlot:p.source.blockhashSlot,observedAccountSlot:Math.max(p.source.snapshotSlot,p.source.blockhashSlot)+2},
  outcome:'failed',finalityAuthenticated:true,paymentAuthorized:false,signingAuthorized:false,broadcastAuthorized:false,journalClearingAuthorized:false};
 return {recovery,failures:[{wallet:p.wallet,idempotencyKey:p.idempotencyKey,claimId:p.claimId,ordinal,receipt,verifiedAt:'2020-01-01T00:00:00.000000Z',transactionFailed:true,claimFinalized:false}]};
}
describe('owner-attested KEEP tax failure recovery consistency',()=>{
 it.each(['claim','combined','split'] as const)('binds exact %s wire failure without capping actual paid fee or granting whole-plan authority',mode=>{
  const value=fixture(mode);expect(schema.parse(value)).toEqual(value);
 });
 it('allows only wire1 failed without manufacturing a setup prefix',()=>{
  const value=fixture('split',1);value.recovery.wires=value.recovery.wires.slice(1);expect(schema.parse(value)).toEqual(value);
 });
 it('allows successful setup plus failed claim but rejects any successful prefix including a failed ordinal',()=>{
  const value=fixture('split',1);value.recovery=recoverySchema.parse(fixtures.setup);expect(schema.safeParse(value).success).toBe(true);
  value.failures=fixture('split',0).failures;expect(schema.safeParse(value).success).toBe(false);
  value.recovery=recoverySchema.parse(fixtures.split);value.failures=fixture('split',1).failures;expect(schema.safeParse(value).success).toBe(false);
 });
 it('rejects original actor, packet, deployment and Clock substitutions',()=>{
  for(const patch of [{wallet:fixtures.combined.wallet},{claimId:'00000000-0000-4000-8000-000000000099'},{ordinal:1},{signature:fixtures.combined.wires[0]!.signature},{messageSha256:'ab'.repeat(32)},{signedTransactionSha256:'ab'.repeat(32)},{round:'999'},{spot:255},{slot:0},{blockTime:0},{paymentAuthorized:true},{journalClearingAuthorized:true},{paidKeepBaseUnits:'1'},{rentLamports:'1'},{feeLamports:'018'},{feeLamports:'18446744073709551616'},{extra:true}]){const value=fixture();Object.assign(value.failures[0]!.receipt,patch);expect(schema.safeParse(value).success,JSON.stringify(patch)).toBe(false);}
  for(const patch of [{snapshotSha256:'ab'.repeat(32)},{configAddress:fixtures.combined.wallet},{snapshotSlot:0},{blockhashSlot:0},{observedAccountSlot:0},{reviewedDeploymentSlot:0},{reviewedProgramDataSha256:'ab'.repeat(32)},{extra:true}]){const value=fixture();Object.assign(value.failures[0]!.receipt.source,patch);expect(schema.safeParse(value).success,JSON.stringify(patch)).toBe(false);}
 });
 it('rejects invented terminal status, duplicate or missing custody, timestamps and unbounded arrays',()=>{
  for(const mutate of [(v:ReturnType<typeof fixture>)=>{v.failures[0]!.claimFinalized=true;},(v:ReturnType<typeof fixture>)=>{v.failures[0]!.verifiedAt='2020-02-30T00:00:00.000000Z';},(v:ReturnType<typeof fixture>)=>{v.failures.push(v.failures[0]!);},(v:ReturnType<typeof fixture>)=>{v.recovery.wires=[];v.recovery.status='prepared';},(v:ReturnType<typeof fixture>)=>{v.failures=Array(10000).fill(v.failures[0]);}]){const value=fixture();mutate(value);expect(schema.safeParse(value).success).toBe(false);}
 });
 it('accepts empty read-only recovery but never unattached failure evidence',()=>{
  const value=fixture();const unknown={wallet:value.recovery.wallet,idempotencyKey:value.recovery.idempotencyKey,claimId:null,status:'unknown',preparation:null,wires:[],settlement:null,serverNow:value.recovery.serverNow};expect(schema.safeParse({recovery:unknown,failures:[]}).success).toBe(true);expect(schema.safeParse({recovery:unknown,failures:value.failures}).success).toBe(false);
 });
});
