/** Private thread routes must preserve the existing SIWS/alpha session boundary. */
import { randomUUID } from 'node:crypto';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { testerFeedback, feedbackAttachments } from '../src/db/schema';
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

const draft = () => ({requestId:randomUUID(),title:'Reviewed public title',summary:'Sanitized issue summary',category:'bug',workaround:null,fixedRelease:null,status:'open',published:false,reason:'Private curation reason'});
it('requires real admin auth and strict bodies for curation',async()=>{
 for(const cookie of [undefined,otherCookie]) {
  const response=await app.inject({method:'POST',url:'/admin/tester/issues',...(cookie?{cookies:cookies(cookie)}:{}),payload:draft()});
  expect(response.statusCode).toBe(cookie?403:401);expect(response.headers['cache-control']).toBe('private, no-store');
 }
 const invalid=await app.inject({method:'POST',url:'/admin/tester/issues',cookies:cookies(adminCookie),payload:{...draft(),issueId:randomUUID()}});
 expect(invalid.statusCode).toBe(400);
});
it('keeps drafts private and publishes only curated DTOs; authenticated confirmations never expose identities',async()=>{
 const payload=draft(),request={method:'POST' as const,url:'/admin/tester/issues',cookies:cookies(adminCookie),payload};
 const created=await app.inject(request);expect(created.statusCode).toBe(200);
 expect((await app.inject(request)).json()).toEqual(created.json());
 const id=created.json().issueId;
 const currentDraft=await app.inject({method:'GET',url:`/admin/tester/issues/${id}`,cookies:cookies(adminCookie)});expect(currentDraft.statusCode).toBe(200);expect(currentDraft.json()).toMatchObject({id,revision:1,publishedAt:null});
 expect((await app.inject({method:'GET',url:`/admin/tester/issues/${id}`,cookies:cookies(ownerCookie)})).statusCode).toBe(403);
 expect((await app.inject({method:'GET',url:'/admin/tester/issues',cookies:cookies(ownerCookie)})).statusCode).toBe(403);
 const listed=await app.inject({method:'GET',url:'/admin/tester/issues',query:{query:payload.title,published:'false'},cookies:cookies(adminCookie)});expect(listed.statusCode).toBe(200);expect(listed.body).toContain(id);
 expect((await app.inject({method:'GET',url:`/tester/issues/${id}`})).statusCode).toBe(404);
 const published=await app.inject({method:'PATCH',url:`/admin/tester/issues/${id}`,cookies:cookies(adminCookie),payload:{...draft(),expectedRevision:1,published:true}});expect(published.statusCode).toBe(200);
 const visible=await app.inject({method:'GET',url:`/tester/issues/${id}`});expect(visible.statusCode).toBe(200);
 expect(Object.keys(visible.json()).sort()).toEqual(['id','title','summary','category','status','workaround','fixedRelease','affectedPlayerCount'].sort());
 const audit=await app.inject({method:'GET',url:`/admin/tester/issues/${id}/history`,cookies:cookies(adminCookie)});expect(audit.statusCode).toBe(200);expect(audit.json().actions).toHaveLength(2);expect(audit.headers['cache-control']).toBe('private, no-store');
 expect((await app.inject({method:'GET',url:`/admin/tester/issues/${id}/history`,cookies:cookies(ownerCookie)})).statusCode).toBe(403);
 expect(visible.body).not.toContain(admin);expect(visible.body).not.toContain('Private curation reason');
 expect((await app.inject({method:'POST',url:`/tester/issues/${id}/confirm`})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:`/tester/issues/${id}/confirm`,cookies:cookies(ownerCookie),payload:{wallet:admin}})).statusCode).toBe(400);
 const confirm={method:'POST' as const,url:`/tester/issues/${id}/confirm`,cookies:cookies(ownerCookie),payload:{}};
 expect((await app.inject(confirm)).json().affectedPlayerCount).toBe(1);expect((await app.inject(confirm)).json().affectedPlayerCount).toBe(1);
 const found=await app.inject({method:'GET',url:'/tester/issues',query:{query:payload.title}});expect(found.statusCode).toBe(200);expect(found.body).toContain(id);
});
it('authorizes link/reward/lock and keeps private reviewer evidence out of reporter reads',async()=>{
 const issue=await app.inject({method:'POST',url:'/admin/tester/issues',cookies:cookies(adminCookie),payload:draft()});expect(issue.statusCode).toBe(200);
 const base=`/admin/tester/feedback/${reportId}`;
 const link={requestId:randomUUID(),issueId:issue.json().issueId,expectedIssueRevision:1,expectedReportRevision:1,reason:'Private duplicate diagnosis'};
 expect((await app.inject({method:'POST',url:`${base}/link`,cookies:cookies(ownerCookie),payload:link})).statusCode).toBe(403);
 const linked=await app.inject({method:'POST',url:`${base}/link`,cookies:cookies(adminCookie),payload:link});expect(linked.statusCode).toBe(200);
 const adminThread=await app.inject({method:'GET',url:`${base}/thread`,cookies:cookies(adminCookie)});expect(adminThread.json().report.linkedIssue).toMatchObject({id:issue.json().issueId,publishedAt:null});
 const review={requestId:randomUUID(),expectedRevision:linked.json().revision,status:'accepted',verdict:'actionable',award:'first_actionable',importance:'medium',reason:'Verified independently',verificationEvidence:'Private verifier location'};
 const rewarded=await app.inject({method:'POST',url:`${base}/review`,cookies:cookies(adminCookie),payload:review});expect(rewarded.statusCode).toBe(200);
 expect((await app.inject({method:'POST',url:`${base}/review`,cookies:cookies(adminCookie),payload:review})).json()).toEqual(rewarded.json());
 const locked=await app.inject({method:'POST',url:`${base}/lock`,cookies:cookies(adminCookie),payload:{requestId:randomUUID(),locked:true,reason:'Investigation completed'}});expect(locked.statusCode).toBe(200);
 const thread=await app.inject({method:'GET',url:`/tester/feedback/${reportId}/thread`,cookies:cookies(ownerCookie)});
 expect(thread.json().report).not.toHaveProperty('linkedIssue');expect(thread.body).not.toContain(issue.json().issueId);
 expect(thread.json().report.locked).toBe(true);expect(thread.body).not.toContain('Private verifier location');expect(thread.body).not.toContain('Private duplicate diagnosis');
});

it('quick acceptance uses the same admin-only review route, exact receipt and private issue boundary',async()=>{
 const [report]=await conn.db.insert(testerFeedback).values({wallet:owner,category:'bug',title:'Private quick report',body:'Private report diagnosis'}).returning();
 const url=`/admin/tester/feedback/${report!.id}/review`,payload={requestId:randomUUID(),expectedRevision:1,status:'accepted',verdict:'actionable',award:'first_actionable',importance:'medium',reason:'Admin accepted this report as actionable using quick review.',verificationEvidence:'Admin reviewed this report and accepted it as actionable using quick review.',preparePrivateIssue:true};
 for(const cookie of [undefined,ownerCookie])expect((await app.inject({method:'POST',url,...(cookie?{cookies:cookies(cookie)}:{}),payload})).statusCode).toBe(cookie?403:401);
 expect((await app.inject({method:'POST',url,cookies:cookies(adminCookie),payload:{...payload,preparePrivateIssue:'true'}})).statusCode).toBe(400);
 const request={method:'POST' as const,url,cookies:cookies(adminCookie),payload};
 const accepted=await app.inject(request);expect(accepted.statusCode).toBe(200);expect(accepted.headers['cache-control']).toBe('private, no-store');
 expect(accepted.json()).toMatchObject({status:'accepted',revision:3});expect(accepted.json().delta).toBeGreaterThan(0);
 expect((await app.inject(request)).json()).toEqual(accepted.json());
 expect((await app.inject({method:'GET',url:`/tester/issues/${accepted.json().issueId}`})).statusCode).toBe(404);
 const thread=await app.inject({method:'GET',url:`/tester/feedback/${report!.id}/thread`,cookies:cookies(ownerCookie)});
 expect(thread.body).not.toContain(accepted.json().issueId);expect(thread.body).not.toContain(payload.verificationEvidence);
});

it('accepts evidence only after signed login and never returns another reporter thread',async()=>{
 const created=await app.inject({method:'POST',url:'/admin/tester/issues',cookies:cookies(adminCookie),payload:{...draft(),published:true}});expect(created.statusCode).toBe(200);
 const id=created.json().issueId,url=`/tester/issues/${id}/evidence`;
 const payload={requestId:randomUUID(),mode:'evidence',title:'Private details',body:'Actual private reproduction steps'};
 expect((await app.inject({method:'POST',url,payload})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url,cookies:cookies(ownerCookie),payload:{...payload,wallet:admin}})).statusCode).toBe(400);
 const request={method:'POST' as const,url,cookies:cookies(ownerCookie),payload};
 const sent=await app.inject(request);expect(sent.statusCode).toBe(200);expect(sent.headers['cache-control']).toBe('private, no-store');
 expect((await app.inject(request)).json()).toEqual(sent.json());
 const second=await app.inject({method:'POST',url,cookies:cookies(otherCookie),payload:{...payload,requestId:randomUUID()}});expect(second.statusCode).toBe(200);expect(second.json().reportId).not.toBe(sent.json().reportId);
 const next=await app.inject({method:'POST',url,cookies:cookies(ownerCookie),payload:{...payload,requestId:randomUUID(),body:'Additional evidence saved in the same thread'}});expect(next.statusCode).toBe(200);expect(next.json()).toMatchObject({reused:true,reportId:sent.json().reportId});
 const thread=await app.inject({method:'GET',url:`/tester/feedback/${sent.json().reportId}/thread`,cookies:cookies(ownerCookie)});expect(thread.body).toContain('Additional evidence saved in the same thread');
 const publicIssue=await app.inject({method:'GET',url:`/tester/issues/${id}`});expect(publicIssue.body).not.toContain(payload.body);expect(publicIssue.body).not.toContain(sent.json().reportId);
});

it('authorizes merge and resolves old public URLs to the approved target without accepting stale writes',async()=>{
 const create=()=>app.inject({method:'POST',url:'/admin/tester/issues',cookies:cookies(adminCookie),payload:{...draft(),published:true}});
 const source=await create(),target=await create();expect(source.statusCode).toBe(200);expect(target.statusCode).toBe(200);
 const id=source.json().issueId,targetId=target.json().issueId,url=`/admin/tester/issues/${id}/merge`;
 const payload={requestId:randomUUID(),targetIssueId:targetId,expectedSourceRevision:1,expectedTargetRevision:1,reason:'Private merge reason'};
 expect((await app.inject({method:'POST',url,cookies:cookies(ownerCookie),payload})).statusCode).toBe(403);
 const merged=await app.inject({method:'POST',url,cookies:cookies(adminCookie),payload});expect(merged.statusCode).toBe(200);
 expect((await app.inject({method:'POST',url,cookies:cookies(adminCookie),payload})).json()).toEqual(merged.json());
 const redirected=await app.inject({method:'GET',url:`/tester/issues/${id}`});expect(redirected.statusCode).toBe(200);expect(redirected.json().id).toBe(targetId);expect(redirected.body).not.toContain(payload.reason);
 expect((await app.inject({method:'POST',url:`/tester/issues/${id}/confirm`,cookies:cookies(ownerCookie),payload:{}})).statusCode).toBe(409);
});

it('gates split and reopen behind admin sessions and exact reviewed revisions',async()=>{
 const source=await app.inject({method:'POST',url:'/admin/tester/issues',cookies:cookies(adminCookie),payload:draft()});expect(source.statusCode).toBe(200);
 const [report]=await conn.db.insert(testerFeedback).values({wallet:owner,category:'bug',title:'Private split report',body:'Detailed private report'}).returning();
 const link=await app.inject({method:'POST',url:`/admin/tester/feedback/${report!.id}/link`,cookies:cookies(adminCookie),payload:{requestId:randomUUID(),issueId:source.json().issueId,expectedIssueRevision:1,expectedReportRevision:1,reason:'Verified initial classification'}});expect(link.statusCode).toBe(200);
 const payload={requestId:randomUUID(),expectedSourceRevision:1,reason:'Separate verified problem',reports:[{id:report!.id,expectedRevision:link.json().revision}],target:{title:'Separate curated title',summary:'Reviewed separate issue',category:'bug',status:'fixed',published:true,workaround:null,fixedRelease:'earlier-release'}};
 const url=`/admin/tester/issues/${source.json().issueId}/split`;
 expect((await app.inject({method:'POST',url,cookies:cookies(ownerCookie),payload})).statusCode).toBe(403);
 const split=await app.inject({method:'POST',url,cookies:cookies(adminCookie),payload});expect(split.statusCode).toBe(200);
 const reopened=await app.inject({method:'POST',url:`/admin/tester/issues/${split.json().targetIssueId}/reopen`,cookies:cookies(adminCookie),payload:{requestId:randomUUID(),expectedRevision:1,reason:'Issue recurred after the release'}});expect(reopened.statusCode).toBe(200);expect(reopened.json()).toMatchObject({revision:2,status:'open',previousFixedRelease:'earlier-release',fixedRelease:null});
});

it('serves issue-filtered admin report pages with exact selection revisions and no reporter access',async()=>{
 const url='/admin/tester/feedback/page';
 expect((await app.inject({method:'GET',url,cookies:cookies(ownerCookie)})).statusCode).toBe(403);
 const response=await app.inject({method:'GET',url,cookies:cookies(adminCookie),query:{issueId:randomUUID()}});expect(response.statusCode).toBe(200);expect(response.json()).toEqual({feedback:[],nextCursor:null});expect(response.headers['cache-control']).toBe('private, no-store');
 const current=await app.inject({method:'GET',url,cookies:cookies(adminCookie)});expect(current.statusCode).toBe(200);expect(current.json().feedback.length).toBeGreaterThan(0);expect(current.json().feedback[0]).toHaveProperty('revision');expect(current.json().feedback[0]).toHaveProperty('lastExportedRevision');
 expect((await app.inject({method:'GET',url,cookies:cookies(adminCookie),query:{cursor:'bad!'}})).statusCode).toBe(400);
});

it('protects closure and preservation routes and hides preservation audit activity from reporters',async()=>{
 const [report]=await conn.db.insert(testerFeedback).values({wallet:owner,category:'bug',title:'Closure test',body:'Private screenshot evidence'}).returning();const id=report!.id;
 const [attachment]=await conn.db.insert(feedbackAttachments).values({reportId:id,wallet:owner,requestId:randomUUID(),state:'attached',expiresAt:new Date(),objectKey:'private-test-object',sha256:'a'.repeat(64),byteLength:10,width:1,height:1,contentType:'image/webp'}).returning();
 const base=`/admin/tester/feedback/${id}`,url=`${base}/closure`,payload={requestId:randomUUID(),closed:true,expectedRevision:1,reason:'Resolved with reporter'};
 for(const cookie of [undefined,ownerCookie])expect((await app.inject({method:'POST',url,...(cookie?{cookies:cookies(cookie)}:{}),payload})).statusCode).toBe(cookie?403:401);
 expect((await app.inject({method:'POST',url,cookies:cookies(adminCookie),payload:{...payload,wallet:owner}})).statusCode).toBe(400);
 const closed=await app.inject({method:'POST',url,cookies:cookies(adminCookie),payload});expect(closed.statusCode).toBe(200);expect(closed.headers['cache-control']).toBe('private, no-store');
 expect((await app.inject({method:'POST',url,cookies:cookies(adminCookie),payload})).json()).toEqual(closed.json());
 const threadUrl=`/tester/feedback/${id}/thread`,before=await app.inject({method:'GET',url:threadUrl,cookies:cookies(ownerCookie)});
 const preservationUrl=`${base}/screenshots/${attachment!.id}/preservation`,preservation={requestId:randomUUID(),expectedRevision:2,preserved:true,reason:'Private legal investigation detail'};
 expect((await app.inject({method:'POST',url:preservationUrl,cookies:cookies(ownerCookie),payload:preservation})).statusCode).toBe(403);
 const kept=await app.inject({method:'POST',url:preservationUrl,cookies:cookies(adminCookie),payload:preservation});expect(kept.statusCode).toBe(200);expect(kept.headers['cache-control']).toBe('private, no-store');
 expect((await app.inject({method:'POST',url:preservationUrl,cookies:cookies(adminCookie),payload:preservation})).json()).toEqual(kept.json());
 const after=await app.inject({method:'GET',url:threadUrl,cookies:cookies(ownerCookie)});expect(after.json()).toEqual(before.json());expect(after.body).not.toContain(preservation.reason);
 const reopened=await app.inject({method:'POST',url,cookies:cookies(adminCookie),payload:{...payload,requestId:randomUUID(),closed:false,expectedRevision:3}});expect(reopened.statusCode).toBe(200);expect(reopened.json().closedAt).toBeNull();
});
