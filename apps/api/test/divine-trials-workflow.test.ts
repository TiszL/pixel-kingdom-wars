import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {withDivineTrialFixture} from './fixtures/divineTrials';

it('settled personally earned Renown admits two wallets, actual equal-army combat ranks them and funded stock conserves through original claims',async()=>{
 await withDivineTrialFixture(async f=>{
  const unaffected=async()=>({players:await f.sql`select * from players where wallet in(${f.wallet},${f.buyer}) order by wallet`,army:await f.sql`select * from army order by player_wallet,troop`,profiles:await f.sql`select * from base_profiles order by base_id`,accounts:await f.sql`select * from accounts order by id`,raids:await f.sql`select id,status,result from raids order by id`});
  const before=await unaffected();f.setTime(f.event.entryStartsAt);const first=await f.enter(),second=await f.enter(f.buyer,f.buyerBaseId);
  expect(first.qualification.renown).toBe('1');expect(second.qualification.daysAttested).toBe('1');
  f.setTime(f.event.playStartsAt);const a=await f.admit(),b=await f.admit(f.buyer,f.buyerBaseId);
  const low=await f.client.submit(f.wallet,a.id,{orders:f.orders('north')}),high=await f.client.submit(f.buyer,b.id,{orders:f.orders('south')});
  expect(low.result).toMatchObject({stars:2,destruction:93});expect(high.result).toMatchObject({stars:3,destruction:100});
  f.setTime(f.event.playEndsAt);const terminal=await f.client.close(f.event.id);
  expect(terminal.terminal?.rankings.map(r=>r.wallet)).toEqual([f.buyer,f.wallet]);expect(terminal.terminal?.occupations).toHaveLength(2);
  f.setOnline(false);process.env.PHASE_E_CATALOG_ENABLED='false';const restarted=f.service();
  expect(await restarted.enter(f.wallet,f.event.id,{baseId:first.baseId,idempotencyKey:first.idempotencyKey})).toEqual(first);
  expect(await restarted.submit(f.wallet,a.id,{orders:f.orders('north')})).toEqual(low);
  const mine=await restarted.claim(f.wallet,f.event.id,{baseId:f.baseId}),theirs=await restarted.claim(f.buyer,f.event.id,{baseId:f.buyerBaseId});
  expect(Object.values(mine.amounts)).toEqual(Array(8).fill('4'));expect(Object.values(theirs.amounts)).toEqual(Array(8).fill('3'));
  expect(await restarted.claim(f.wallet,f.event.id,{baseId:f.baseId})).toEqual(mine);
  await expect(restarted.claim(f.wallet,f.event.id,{baseId:randomUUID()})).rejects.toMatchObject({code:'DIVINE_TRIAL_IDEMPOTENCY_BODY_MISMATCH'});
  expect((await restarted.participant(f.wallet,f.event.id)).prize?.claim).toEqual(mine);expect(await unaffected()).toEqual(before);
 });
},120000);
