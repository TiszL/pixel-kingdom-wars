/** CLI dispatch uses an injected private session; actual earning/role evidence
 * lives in the clan runtime tests. No default operator process runs here. */
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {expect,it,vi} from 'vitest';
import {ORDINARY_REFINED_IDS} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {main,type ClanDivineOperatorCliIo} from '../src/game/clanDivineOperatorCli';
import {loadConfig} from '../src/config';
const key=(n:number)=>new PublicKey(Buffer.alloc(32,n)).toBase58(),sponsor=key(1);
const base={NODE_ENV:'test',DATABASE_URL:'postgres://request:test@127.0.0.1:5433/test',PHASE_E_SERVICE_DATABASE_URL:'postgres://owner:test@127.0.0.1:5433/test',JWT_SECRET:'x'.repeat(32),WEB_ORIGIN:'http://localhost:5173'};
const env={...base,CHARTER_TOURNAMENT_SPONSOR_WALLET:sponsor,CHARTER_TOURNAMENT_TREASURY:key(2),
 CHARTER_RECOVERY_ECONOMY_PROGRAM_ID:key(3),CHARTER_RECOVERY_CRAFT_PROGRAM_ID:key(4),CHARTER_RECOVERY_STATE_PROVENANCE:'fresh-reviewed-deployment',
 ...Object.fromEntries(['ECONOMY','CRAFT','CORE'].flatMap(f=>[[`CHARTER_RECOVERY_${f}_DEPLOYMENT_SLOT`,'1'],[`CHARTER_RECOVERY_${f}_PROGRAM_DATA_SHA256`,'a'.repeat(64)],[`CHARTER_RECOVERY_${f}_UPGRADE_AUTHORITY`,'none']])),
 SEEKER_REALM_SALE_PROGRAM_ID:key(5),SEEKER_REALM_SALE_DEPLOYMENT_SLOT:'1',SEEKER_REALM_SALE_PROGRAM_DATA_SHA256:'b'.repeat(64),SEEKER_REALM_SALE_UPGRADE_AUTHORITY:'none',SEEKER_REALM_SALE_AUCTION_MINT:key(6),SEEKER_REALM_SALE_PRIZE_OWNER:key(7),SEEKER_REALM_SALE_DEVELOPER:key(8),SEEKER_REALM_SALE_ROUND:'1',SEEKER_REALM_SALE_POLICY_REVISION:'fixture',SEEKER_REALM_SALE_STATE_PROVENANCE:'fresh-reviewed-deployment'};
function fixture(body:unknown){
 const operator={initializeEpoch:vi.fn().mockResolvedValue({id:'original-epoch'}),fundAndEnroll:vi.fn().mockResolvedValue({id:'original-event'}),enroll:vi.fn(),closeAndSettle:vi.fn()},close=vi.fn(),openSession=vi.fn().mockResolvedValue({operator,close}),print=vi.fn(),printError=vi.fn();
 const io:ClanDivineOperatorCliIo={readInput:async()=>JSON.stringify(body),openSession,print,printError};return {operator,close,openSession,print,printError,io};
}
const funding=()=>({sponsorWallet:sponsor,request:{id:randomUUID(),baseId:randomUUID(),weekStart:'2020-01-04T00:00:00.000Z',budget:Object.fromEntries(ORDINARY_REFINED_IDS.map(id=>[id,'1']))}});
it('requires independently complete clan authority; blank configuration stays absent',()=>{
 expect(loadConfig(base).CHARTER_TOURNAMENT_SPONSOR_WALLET).toBeUndefined();expect(loadConfig(env).CHARTER_TOURNAMENT_SPONSOR_WALLET).toBe(sponsor);
 for(const k of ['CHARTER_TOURNAMENT_SPONSOR_WALLET','CHARTER_TOURNAMENT_TREASURY','CHARTER_RECOVERY_ECONOMY_PROGRAM_ID','SEEKER_REALM_SALE_PROGRAM_ID'])expect(()=>loadConfig({...env,[k]:''}),k).toThrow();
 expect(()=>loadConfig({...base,CHARTER_TOURNAMENT_SPONSOR_WALLET:sponsor,DIVINE_TRIAL_SPONSOR_WALLET:sponsor})).toThrow();
});
it('dispatches each explicit original command once and never implicitly initializes an epoch',async()=>{
 for(const verb of ['initialize-epoch','fund-and-enroll','enroll','close-and-settle'] as const){const body=verb==='initialize-epoch'?{}:verb==='fund-and-enroll'?funding():{eventId:randomUUID()},f=fixture(body);
  expect(await main([verb,'--input','command.json'],env,f.io)).toBe(0);expect(f.close).toHaveBeenCalledTimes(1);expect(f.openSession).toHaveBeenCalledTimes(1);
  const names={'initialize-epoch':'initializeEpoch','fund-and-enroll':'fundAndEnroll',enroll:'enroll','close-and-settle':'closeAndSettle'} as const;
  for(const [name,fn] of Object.entries(f.operator))expect(fn).toHaveBeenCalledTimes(name===names[verb]?1:0);
  if(verb==='initialize-epoch')expect(f.operator.initializeEpoch).toHaveBeenCalledWith();
  if(verb==='fund-and-enroll')expect(f.operator.fundAndEnroll).toHaveBeenCalledWith(sponsor,(body as ReturnType<typeof funding>).request);
  expect(JSON.parse(f.print.mock.calls[0]![0]).command).toBe(verb);
 }
});
it('refuses caller-selected epoch/domain, wrong sponsor and malformed actions before sources; errors do not leak credentials',async()=>{
 for(const [verb,body] of [['initialize-epoch',{domain:{}}],['enroll',{eventId:randomUUID(),winner:sponsor}],['fund-and-enroll',{...funding(),expiry:'future'}]]){const f=fixture(body);expect(await main([verb as string,'--input','x'],env,f.io)).toBe(2);expect(f.openSession).not.toHaveBeenCalled();}
 const invalidWeek=fixture({...funding(),request:{...funding().request,weekStart:'not-a-week'}});expect(await main(['fund-and-enroll','--input','x'],env,invalidWeek.io)).toBe(2);expect(invalidWeek.openSession).not.toHaveBeenCalled();
 const wrong=fixture({...funding(),sponsorWallet:key(9)});expect(await main(['fund-and-enroll','--input','x'],env,wrong.io)).toBe(1);expect(wrong.openSession).not.toHaveBeenCalled();
 const refused=fixture({eventId:randomUUID()});refused.operator.enroll.mockRejectedValue(Error('postgres://owner:secret@host/db'));
 expect(await main(['enroll','--input','x'],env,refused.io)).toBe(1);expect(refused.operator.enroll).toHaveBeenCalledTimes(1);expect(refused.close).toHaveBeenCalledTimes(1);expect(refused.printError.mock.calls.flat().join()).not.toMatch(/secret|postgres/);
 const extra=fixture({});expect(await main(['initialize-epoch','--input','x','--replace'],env,extra.io)).toBe(2);expect(extra.openSession).not.toHaveBeenCalled();
});
