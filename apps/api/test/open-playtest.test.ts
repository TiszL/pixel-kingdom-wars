/** D-118: public admission changes no authentication or referral economics. */
import { randomUUID } from 'node:crypto';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { REFERRALS, TESTER_DAILY, TESTER_PROGRAM } from '@shardkeep/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE } from '../src/auth/session';
import { alphaAccess, alphaApplications, alphaInviteCodes, bases, globalChatMessages,
  players, referrals, sessions, testerDailyPoints, testerMilestones } from '../src/db/schema';
import { activeReferralBonusBps, getOrCreateReferralCode, qualifyReferrals } from '../src/game/social';
import { internalWalletsOf } from '../src/game/playtestStats';
import { recomputeTesterMilestones } from '../src/game/tester';
import { connectTestDb, randomWallet, TEST_CONFIG } from './helpers';

const admin=randomWallet(),internal=randomWallet();
const openConfig={...TEST_CONFIG,PLAYTEST_OPEN:'true' as const,ALPHA_WALLETS:[internal],ADMIN_WALLETS:[admin]};
const closedConfig={...openConfig,PLAYTEST_OPEN:'false' as const};
let conn: ReturnType<typeof connectTestDb>;
let open:FastifyInstance,closed:FastifyInstance;
const emails: string[]=[];
async function identity(wallet=randomWallet()) {
  await conn.db.insert(players).values({wallet}).onConflictDoNothing();
  const [session]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+86_400_000)}).returning();
  return {wallet,sessionId:session!.id,cookies:{[SESSION_COOKIE]:await issueSessionJwt(openConfig,wallet,session!.id)}};
}
async function signIn(app:FastifyInstance) {
  const secretKey=utils.randomSecretKey();
  const wallet=bs58.encode(await getPublicKeyAsync(secretKey));
  const challenge=await app.inject({method:'GET',url:'/auth/challenge',query:{wallet}});
  expect(challenge.statusCode).toBe(200);
  const signature=bs58.encode(await signAsync(new TextEncoder().encode(challenge.json().message),secretKey));
  const verified=await app.inject({method:'POST',url:'/auth/verify',payload:{wallet,signature}});
  expect(verified.statusCode).toBe(200);
  return {wallet,cookies:{[SESSION_COOKIE]:verified.cookies.find(c=>c.name===SESSION_COOKIE)!.value}};
}
beforeAll(async()=>{
  conn=connectTestDb();
  open=await buildApp(openConfig,conn.db,{emailSender:async(to)=>{emails.push(to);}});
  closed=await buildApp(closedConfig,conn.db,{emailSender:async(to)=>{emails.push(to);}});
  await Promise.all([open.ready(),closed.ready()]);
});
afterAll(async()=>{await Promise.all([open.close(),closed.close()]);await conn.sql.end();});

describe('open playtest admission',()=>{
  it('admits a fresh signed wallet with internal lists retained and no invite or Seeker record',async()=>{
    const player=await signIn(open);
    expect((await open.inject({url:'/bases',cookies:player.cookies})).statusCode).toBe(200);
    expect(await conn.db.select().from(alphaAccess).where(eq(alphaAccess.wallet,player.wallet))).toHaveLength(0);
    const [stored]=await conn.db.select().from(players).where(eq(players.wallet,player.wallet));
    expect(stored?.seekerVerified).toBe(false);
    expect(internalWalletsOf(openConfig)).toEqual(expect.arrayContaining([internal,admin]));
    const access=await open.inject({url:'/playtest/access'});
    expect(access.json()).toMatchObject({open:true});
  });

  it('lets a previously gated session continue with its existing progress intact',async()=>{
    const player=await identity();
    await conn.db.update(players).set({keepLevel:5,trophies:42}).where(eq(players.wallet,player.wallet));
    const gated=await closed.inject({url:'/bases',cookies:player.cookies});
    expect(gated.statusCode).toBe(403);
    expect(gated.json().error.code).toBe('ALPHA_GATED');
    expect((await open.inject({url:'/bases',cookies:player.cookies})).statusCode).toBe(200);
    const [stored]=await conn.db.select().from(players).where(eq(players.wallet,player.wallet));
    expect(stored).toMatchObject({keepLevel:5,trophies:42});
    expect(await conn.db.select().from(alphaAccess).where(eq(alphaAccess.wallet,player.wallet))).toHaveLength(0);
  });

  it('retains session revocation, admin authorization and paid-land requirements',async()=>{
    const player=await identity();
    expect((await open.inject({url:'/bases'})).statusCode).toBe(401);
    expect((await open.inject({url:'/admin/alpha/stats',cookies:player.cookies})).statusCode).toBe(403);
    expect((await open.inject({url:'/map/me',cookies:player.cookies})).statusCode).toBe(402);
    await conn.db.update(sessions).set({revokedAt:new Date()}).where(eq(sessions.id,player.sessionId));
    expect((await open.inject({url:'/bases',cookies:player.cookies})).statusCode).toBe(401);
    expect((await open.inject({method:'POST',url:'/referrals/use',cookies:player.cookies,payload:{code:'KEEP-ABCDE'}})).statusCode).toBe(401);
  });

  it('retires applications and invite issuance without emails or historical record mutations',async()=>{
    const staff=await identity(admin);
    const [application]=await conn.db.insert(alphaApplications).values({email:`${randomUUID()}@example.com`}).returning();
    const before=await conn.db.select().from(alphaInviteCodes);
    const mailCount=emails.length;
    const newEmail=`${randomUUID()}@example.com`;
    for(const request of [
      {url:'/alpha/apply',payload:{email:newEmail}},
      {url:`/admin/alpha/${application!.id}/approve`,payload:{}},
      {url:'/admin/alpha/invites',payload:{count:1,idempotencyKey:randomUUID()}},
    ]) {
      const response=await open.inject({method:'POST',...request,cookies:staff.cookies});
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('PLAYTEST_OPEN');
    }
    expect(emails).toHaveLength(mailCount);
    expect(await conn.db.select().from(alphaApplications).where(eq(alphaApplications.id,application!.id))).toEqual([application]);
    expect(await conn.db.select().from(alphaApplications).where(eq(alphaApplications.email,newEmail))).toHaveLength(0);
    expect(await conn.db.select().from(alphaInviteCodes)).toEqual(before);
  });
});

describe('optional open referrals',()=>{
  it('does not block play on unknown, expired, self or repeated codes and never replaces a referrer',async()=>{
    const referrer=await identity(),other=await identity(),player=await identity();
    const code=await getOrCreateReferralCode(conn.db,referrer.wallet);
    const otherCode=await getOrCreateReferralCode(conn.db,other.wallet);
    const request=(cookies:typeof player.cookies,value:string)=>open.inject({method:'POST',url:'/referrals/use',cookies,payload:{code:value}});
    expect((await request(player.cookies,'KEEP-XXXXX')).statusCode).toBe(404);
    expect((await open.inject({url:'/bases',cookies:player.cookies})).statusCode).toBe(200);
    expect((await request(referrer.cookies,code)).statusCode).toBe(422);
    const results=await Promise.all([request(player.cookies,code),request(player.cookies,code)]);
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,422]);
    expect((await request(player.cookies,otherCode)).statusCode).toBe(422);
    const rows=await conn.db.select().from(referrals).where(eq(referrals.refereeWallet,player.wallet));
    expect(rows).toHaveLength(1);expect(rows[0]?.referrerWallet).toBe(referrer.wallet);
    const expired=await identity();
    await conn.db.update(players).set({createdAt:new Date(Date.now()-(REFERRALS.useWindowDays+1)*86_400_000)}).where(eq(players.wallet,expired.wallet));
    expect((await request(expired.cookies,code)).statusCode).toBe(422);
    expect((await open.inject({url:'/bases',cookies:expired.cookies})).statusCode).toBe(200);
  });

  it('attributes more than the old admission limit while preserving uncapped mining and capped daily points',async()=>{
    const referrer=await identity();
    const code=await getOrCreateReferralCode(conn.db,referrer.wallet);
    const wallets:string[]=[];
    const now=new Date();
    for(let i=0;i<=REFERRALS.maxAlphaAdmissionsPerReferrer;i++) {
      const player=await identity();wallets.push(player.wallet);
      const used=await open.inject({method:'POST',url:'/referrals/use',cookies:player.cookies,payload:{code}});
      expect(used.statusCode).toBe(200);
      await conn.db.update(players).set({keepLevel:REFERRALS.qualifyKeepLevel,entryPaidAt:now,lastSeenAt:now}).where(eq(players.wallet,player.wallet));
      await conn.db.insert(bases).values({ownerWallet:player.wallet,status:'active',keepLevel:REFERRALS.qualifyKeepLevel,landPaidAt:now});
      await conn.db.insert(globalChatMessages).values({authorWallet:player.wallet,clientMessageId:randomUUID(),text:'gg',textHash:'h',authorNameAtSend:'',authorSeekerVerifiedAtSend:false,createdAt:now});
    }
    expect(await conn.db.select().from(referrals).where(eq(referrals.referrerWallet,referrer.wallet))).toHaveLength(wallets.length);
    expect(await conn.db.select().from(alphaAccess).where(inArray(alphaAccess.wallet,wallets))).toHaveLength(0);
    await qualifyReferrals(conn.db,now);
    expect(await activeReferralBonusBps(conn.db,referrer.wallet,now)).toBe(wallets.length*REFERRALS.miningBonusBpsPerReferral);
    await recomputeTesterMilestones(conn.db,referrer.wallet,'derived',now);
    await recomputeTesterMilestones(conn.db,wallets[0]!,'derived',now);
    const dailyRule=TESTER_DAILY.sources.find(s=>s.key==='referral_active')!;
    const [daily]=await conn.db.select().from(testerDailyPoints).where(sql`${testerDailyPoints.wallet}=${referrer.wallet} and ${testerDailyPoints.key}='referral_active' and ${testerDailyPoints.day}=${now.toISOString().slice(0,10)}`);
    expect(daily?.points).toBe(dailyRule.cap*dailyRule.points);
    for(const [wallet,key] of [[referrer.wallet,'friend_invited'],[referrer.wallet,'friend_qualified'],[wallets[0]!,'referral_used']] as const) {
      const [milestone]=await conn.db.select().from(testerMilestones).where(sql`${testerMilestones.wallet}=${wallet} and ${testerMilestones.key}=${key}`);
      expect(milestone?.points).toBe(TESTER_PROGRAM.milestones.find(m=>m.key===key)!.points);
    }
    await conn.db.update(players).set({lastSeenAt:new Date(now.getTime()-(REFERRALS.inactivityLapseDays+1)*86_400_000)}).where(eq(players.wallet,wallets[0]!));
    expect(await activeReferralBonusBps(conn.db,referrer.wallet,now)).toBe((wallets.length-1)*REFERRALS.miningBonusBpsPerReferral);
    await conn.db.update(players).set({lastSeenAt:now,entryPaidAt:null}).where(eq(players.wallet,wallets[0]!));
    expect(await activeReferralBonusBps(conn.db,referrer.wallet,now)).toBe((wallets.length-1)*REFERRALS.miningBonusBpsPerReferral);
    await conn.db.update(players).set({entryPaidAt:now}).where(eq(players.wallet,wallets[0]!));
    expect(await activeReferralBonusBps(conn.db,referrer.wallet,now)).toBe(wallets.length*REFERRALS.miningBonusBpsPerReferral);
  });
});
