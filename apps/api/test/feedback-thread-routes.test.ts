/** Private thread routes must preserve the existing SIWS/alpha session boundary. */
import { randomUUID } from 'node:crypto';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { FEEDBACK_THREADS as LIMIT } from '@shardkeep/shared/feedback';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { feedbackMessages, testerFeedback } from '../src/db/schema';
import { TEST_CONFIG, connectTestDb } from './helpers';

let app: FastifyInstance;
let conn: ReturnType<typeof connectTestDb>;
let owner: string;
let admin: string;
let ownerCookie: string;
let adminCookie: string;
let otherCookie: string;
let reportId: string;
async function keypair() {
  const secret = utils.randomSecretKey();
  return { secret, wallet: bs58.encode(await getPublicKeyAsync(secret)) };
}
async function login(key: Awaited<ReturnType<typeof keypair>>) {
  const challenge = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet: key.wallet } });
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(challenge.json().message), key.secret));
  const response = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: key.wallet, signature } });
  expect(response.statusCode).toBe(200);
  return response.cookies.find(c => c.name === SESSION_COOKIE)!.value;
}
const cookies = (value: string) => ({ [SESSION_COOKIE]: value });
beforeAll(async () => {
  conn = connectTestDb();
  const a = await keypair(); const o = await keypair(); const other = await keypair();
  admin = a.wallet; owner = o.wallet;
  app = await buildApp({ ...TEST_CONFIG, ADMIN_WALLETS: [admin] }, conn.db);
  adminCookie = await login(a); ownerCookie = await login(o); otherCookie = await login(other);
  const [report] = await conn.db.insert(testerFeedback).values({ wallet: owner, category: 'bug', title: 'Private test report', body: 'Only the reporter and team should read this.', adminNote: 'Historical visible response' }).returning();
  reportId = report!.id;
});
afterAll(async () => { await app?.close(); await conn?.sql.end(); });
it('denies unauthenticated and other-wallet reads, including reporter-mode admins', async () => {
  const url = `/tester/feedback/${reportId}/thread`;
  expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  for (const cookie of [otherCookie, adminCookie]) {
    const result = await app.inject({ method: 'GET', url, cookies: cookies(cookie) });
    expect(result.statusCode).toBe(404);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).not.toContain('Historical visible response');
  }
});
it('separates private staff notes from player replies and refuses role injection', async () => {
  const write = (cookie: string, prefix: string, payload: object) => app.inject({ method: 'POST', url: `${prefix}/${reportId}/replies`, cookies: cookies(cookie), payload });
  expect((await write(ownerCookie, '/tester/feedback', { requestId: randomUUID(), body: 'Attempt staff note', visibility: 'admin' })).statusCode).toBe(403);
  expect((await write(otherCookie, '/admin/tester/feedback', { requestId: randomUUID(), body: 'Attempt staff reply' })).statusCode).toBe(403);
  expect((await write(ownerCookie, '/tester/feedback', { requestId: randomUUID(), body: 'Forged role', mode: 'admin' })).statusCode).toBe(400);
  expect((await write(adminCookie, '/admin/tester/feedback', { requestId: randomUUID(), body: 'Secret staff note', visibility: 'admin' })).statusCode).toBe(200);
  const visible = await write(adminCookie, '/admin/tester/feedback', { requestId: randomUUID(), body: 'Please retry this step', visibility: 'reporter' });
  expect(visible.statusCode).toBe(200);
  const read = await app.inject({ method: 'GET', url: `/tester/feedback/${reportId}/thread`, cookies: cookies(ownerCookie) });
  expect(read.statusCode).toBe(200);
  expect(read.headers['cache-control']).toBe('private, no-store');
  expect(read.body).toContain('Historical visible response');
  expect(read.body).toContain('Please retry this step');
  expect(read.body).not.toContain('Secret staff note');
  expect(read.body).not.toContain(admin);
  expect(read.body).not.toContain(owner);
});
it('replays a lost reply response once and advances only the loaded read cursor', async () => {
  const payload = { requestId: randomUUID(), body: 'This local reply is private.' };
  const request = { method: 'POST' as const, url: `/tester/feedback/${reportId}/replies`, cookies: cookies(ownerCookie), payload };
  const first = await app.inject(request); const retry = await app.inject(request);
  expect(first.statusCode).toBe(200); expect(retry.json()).toEqual(first.json());
  const read = await app.inject({ method: 'GET', url: `/tester/feedback/${reportId}/thread`, cookies: cookies(ownerCookie) });
  const revision = read.json().nextRevision;
  const mark = await app.inject({ method: 'POST', url: `/tester/feedback/${reportId}/read`, cookies: cookies(ownerCookie), payload: { revision } });
  expect(mark.statusCode).toBe(200); expect(mark.json()).toEqual({ readRevision: revision });
  expect(read.json().messages.filter((m: { body: string }) => m.body === payload.body)).toHaveLength(1);
});
it('keeps rejected private requests uncacheable and rejects unsafe cursors', async () => {
  for (const afterRevision of ['-1', '1.5', '9007199254740992', 'NaN']) {
    const response = await app.inject({ method: 'GET', url: `/tester/feedback/${reportId}/thread`, query: { afterRevision }, cookies: cookies(ownerCookie) });
    expect(response.statusCode).toBe(400);
    expect(response.headers['cache-control']).toBe('private, no-store');
  }
  for (const query of [{beforeRevision:'-1'}, {beforeRevision:'NaN'}, {beforeRevision:'1.5'}, {beforeRevision:'9007199254740992'}, {beforeRevision:'3',afterRevision:'0'}]) {
    const response=await app.inject({method:'GET',url:`/tester/feedback/${reportId}/thread`,query,cookies:cookies(ownerCookie)});
    expect(response.statusCode).toBe(400);
    expect(response.headers['cache-control']).toBe('private, no-store');
  }
  const unauthenticated = await app.inject({ method: 'GET', url: `/admin/tester/feedback/${reportId}/thread` });
  expect(unauthenticated.statusCode).toBe(401);
  expect(unauthenticated.headers['cache-control']).toBe('private, no-store');
});

it('opens the latest page over authenticated HTTP and traverses earlier history without a gap', async () => {
  const [report]=await conn.db.insert(testerFeedback).values({wallet:owner,category:'bug',title:'Paged report',body:'Visible history',revision:LIMIT.pageSize+3,reporterRevision:LIMIT.pageSize+3}).returning();
  await conn.db.insert(feedbackMessages).values(Array.from({length:LIMIT.pageSize+2},(_,i)=>({reportId:report!.id,author:admin,visibility:'reporter',kind:'reply',body:`message ${i}`,revision:i+2,reporterRevision:i+2,requestId:`http-page-${report!.id}-${i}`,context:{authorRole:'admin'}})));
  const url=`/tester/feedback/${report!.id}/thread`;
  const latest=await app.inject({method:'GET',url,cookies:cookies(ownerCookie)});
  expect(latest.statusCode).toBe(200);
  expect(latest.json()).toMatchObject({oldestRevision:4,nextRevision:LIMIT.pageSize+3,hasEarlier:true,hasMore:false});
  const earlier=await app.inject({method:'GET',url,query:{beforeRevision:'4'},cookies:cookies(ownerCookie)});
  expect(earlier.json().messages.map((m:{revision:number})=>m.revision)).toEqual([2,3]);
  const following=await app.inject({method:'GET',url,query:{afterRevision:'3'},cookies:cookies(ownerCookie)});
  expect(following.json().messages).toEqual(latest.json().messages);
});
