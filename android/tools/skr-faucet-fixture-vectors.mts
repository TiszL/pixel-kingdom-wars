/**
 * Night 2026-10-06 (K-night-A1): writes the four SKR faucet vector files the native `SkrFaucet*` tests read, from the
 * SERVER's own offline faucet fixture (apps/api/test/skr-faucet-fixtures.ts) driven through the real service
 * (apps/api/src/devnet-only/skrFaucet.ts: status, claim, prepare, submit, the cosign worker, listGrants, readGrant).
 * These are the route bodies the server's route tests assert (Fastify serialises the service's return value with
 * JSON.stringify), and every page and grant is re-checked here by the server's port of the phone's own decoder
 * (apps/api/test/skr-faucet-native-decoder.ts). The player-signed wire is signed by the fixture's deterministic test
 * player key (Keypair.fromSeed(fill 81), public test code, no secret) and accepted by the service's own
 * assertPlayerSignedFaucetTransfer during submit.
 *
 * They are FIXTURE-DERIVED, not live captures. Re-capture from a live chain lane with
 * scripts/candidate/capture-skr-faucet-vectors.mjs (server repo) where it can: status and claim today; prepare,
 * submit and the signed wire need the tester's phone; the grant reads need GET /devnet-skr-faucet/grants[?after=] and
 * /grants/:grantId. `newerPage` (a full page of requested grants NEWER than the lost claim) can never come from a live
 * server (one grant per wallet per UTC day), so it stays fixture-derived on purpose.
 *
 * Run (read-only against the server checkout; writes only into --out):
 *   cd <server>/apps/api && ./node_modules/.bin/tsx <android>/tools/skr-faucet-fixture-vectors.mts <server> <out dir>
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [server, out] = process.argv.slice(2);
if (!server || !out) throw new Error('usage: skr-faucet-fixture-vectors.mts <server checkout> <out dir>');
const api = join(server, 'apps/api');
const fx = await import(join(api, 'test/skr-faucet-fixtures.ts'));
const svc = await import(join(api, 'src/devnet-only/skrFaucet.ts'));
const dec = await import(join(api, 'test/skr-faucet-native-decoder.ts'));
const { SKR_FAUCET } = await import(join(server, 'packages/shared/src/constants.ts'));

const size: number = SKR_FAUCET.devnet.grantReadPageSize, grantSkr: number = SKR_FAUCET.devnet.grantSkr;
const pin = { mint: fx.mint as string, decimals: 6 };
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
const DAY = 86_400_000;
function service(at: () => Date) {
  const db = fx.testStore(at()), chain = fx.testRpc();
  const s = svc.makeSkrFaucetService(fx.policy, db.store, chain.rpc, { now: at, reference: db.reference,
    eligibility: async () => ({ reason: 'ok', deed: 'fixture-deed' }), refreshDeed: async () => 'fixture-deed', enqueue: async () => {} });
  return { db, chain, s };
}
const need = (ok: unknown, why: string) => { if (!ok) throw new Error(`vector self-check failed: ${why}`); };

// ---- One claim, end to end (skr-faucet-api-vectors.json, skr-faucet-signed-vector.json, grant reads) ----
let clock = new Date('2026-10-06T12:00:00.000Z');
const now = () => new Date(clock);
const a = service(now); await a.s.prime();
const baseId = randomUUID(), wallet: string = fx.wallet;
const status = wire(await a.s.status(wallet, baseId));
need(status.reason === 'ok' && status.eligible && status.today === null, 'status ok');
const claim = wire(await a.s.claim(wallet, baseId));
const grantId: string = claim.grant.id;
const statusSignRequired = wire(await a.s.status(wallet, baseId));
need(statusSignRequired.reason === 'sign_required', 'sign_required after claim');
const grantsAfterClaim = wire(await a.s.listGrants(wallet));
dec.nativeDiscoveryScan([grantsAfterClaim], size, pin, grantSkr);
const prepare = wire(await a.s.prepare(wallet, grantId));
const statusPending = wire(await a.s.status(wallet, baseId));
need(statusPending.reason === 'pending', 'pending after prepare');
const signedTransaction: string = fx.signPrepared(prepare.unsignedTransaction);
const submit = wire(await a.s.submit(wallet, prepare.grant.attempt.id, signedTransaction));
const statusSubmitted = wire(await a.s.status(wallet, baseId));
need(statusSubmitted.reason === 'submitted', 'submitted after submit');
await svc.processSkrFaucetGrant(fx.policy, a.db.store, a.chain.rpc, fx.faucet, grantId, now);
const grantSubmitted = wire(await a.s.readGrant(wallet, grantId));
need(grantSubmitted.grant.attempt.phase === 'submitted', 'cosigned attempt is submitted');
a.chain.methods.getSignatureStatuses.mockResolvedValue({ context: { slot: 105 },
  value: [{ slot: 101, confirmations: null, err: null, confirmationStatus: 'finalized' }] });
await svc.processSkrFaucetGrant(fx.policy, a.db.store, a.chain.rpc, fx.faucet, grantId, now);
const grantSent = wire(await a.s.readGrant(wallet, grantId));
need(grantSent.grant.status === 'sent' && grantSent.grant.attempt.phase === 'finalized', 'finalized grant is sent');
const statusClaimed = wire(await a.s.status(wallet, baseId));
need(statusClaimed.reason === 'daily_limit' && statusClaimed.today.status === 'sent', 'daily_limit after sent');
for (const grant of [claim.grant, prepare.grant, submit.grant, grantSubmitted.grant, grantSent.grant]) dec.nativeCheckGrant(dec.nativeGrant(grant), pin, grantSkr);
clock = new Date(clock.getTime() + DAY);
const priorDayStatus = wire(await a.s.status(wallet, baseId));
need(priorDayStatus.reason === 'ok' && priorDayStatus.today === null, 'next day is open');

// ---- Lost-claim discovery: 21 requested grants, newest first, the lost claim 21 days back ----
const nowN = new Date('2026-10-06T12:00:00.000Z'), dayN = (back: number) => svc.utcWindow(new Date(nowN.getTime() - back * DAY)).day;
const atD = new Date(nowN.getTime() - (size + 1) * DAY);
const d = service(() => atD); await d.s.prime();
const beforeClaimStatus = wire(await d.s.status(wallet, baseId));
need(beforeClaimStatus.day === dayN(size + 1) && beforeClaimStatus.reason === 'ok', 'claim-day status');
const n = service(() => nowN); await n.s.prime();
const grants = Array.from({ length: size + 1 }, (_, back) => n.db.makeGrant(wallet, dayN(back + 1), `deed-${back}`));
const target = grants[size];
// The grant-read route test's own attempt row shape, latest phase prepared (apps/api/test/devnet-skr-faucet-grant-reads.test.ts).
const attemptId = randomUUID();
n.db.attempts.set(attemptId, { id: attemptId, grantId: target.id, attemptNo: 1, phase: 'prepared', message: Buffer.from([1]),
  reference: n.db.reference(), recentBlockhash: n.db.reference(), lastValidBlockHeight: 200n, playerWire: null, signature: null,
  mutation: null, faucetWire: null, landedSignature: null, createdAt: nowN, settledAt: null });
const newerPage = wire(await n.s.listGrants(wallet));
const pendingPage = wire(await n.s.listGrants(wallet, newerPage.nextCursor));
const emptyPage = wire(await service(() => nowN).s.listGrants(wallet));
const nextDayStatus = wire(await n.s.status(wallet, baseId));
need(newerPage.items.length === size && newerPage.nextCursor === newerPage.items[size - 1].id, 'newer page is full with a cursor');
need(pendingPage.items.length === 1 && pendingPage.items[0].id === target.id && pendingPage.nextCursor === null, 'pending page is the lost claim');
need(pendingPage.items[0].requestedAt.startsWith(beforeClaimStatus.day), 'lost claim is on the claim day');
need(nextDayStatus.reason === 'ok' && nextDayStatus.today === null && nextDayStatus.day > beforeClaimStatus.day, 'server day is past the claim day');
dec.nativeDiscoveryScan([newerPage, pendingPage], size, pin, grantSkr);
dec.nativeDiscoveryScan([emptyPage], size, pin, grantSkr);

// ---- Files ----
const provenance = (what: string) => ({
  source: 'FIXTURE-DERIVED, not a live capture (night 2026-10-06, K-night-A1)',
  what,
  server: 'TiszL server night/server ca7fe4d7d: apps/api/test/skr-faucet-fixtures.ts through apps/api/src/devnet-only/skrFaucet.ts; checked by apps/api/test/skr-faucet-native-decoder.ts',
  generator: 'tools/skr-faucet-fixture-vectors.mts',
  recapture: 'Re-capture from a live chain lane with scripts/candidate/capture-skr-faucet-vectors.mjs (server repo) and the tester phone; newerPage cannot come from a live server and stays fixture-derived.',
  pin: { ...pin, grantSkr, grantReadPageSize: size },
});
mkdirSync(out, { recursive: true });
const write = (name: string, body: object) => writeFileSync(join(out, name), JSON.stringify(body, null, 2) + '\n');
write('skr-faucet-api-vectors.json', { _provenance: provenance('One claim on 2026-10-06 through the four P5 routes, then the status after each step and the owned grants page after the claim.'),
  status, claim, prepare, submit, statusSignRequired, statusPending, statusSubmitted, statusClaimed, grantsAfterClaim });
write('skr-faucet-signed-vector.json', { _provenance: provenance('The fixture test player\'s signature over api vectors prepare.unsignedTransaction; accepted by the service submit (assertPlayerSignedFaucetTransfer).'),
  wallet, attemptId: prepare.grant.attempt.id, signedTransaction });
write('skr-faucet-grant-read-vectors.json', { _provenance: provenance('GET /devnet-skr-faucet/grants/:grantId for the api-vectors claim once cosigned (submitted) and once finalized (sent), and the next day\'s status.'),
  submitted: grantSubmitted, sent: grantSent, nextDayStatus: priorDayStatus });
write('skr-faucet-discovery-vectors.json', { _provenance: provenance('GET /devnet-skr-faucet/grants head-to-tail over 21 requested grants (newerPage = the full first page, pendingPage = the lost claim), an empty wallet page, and the status on the claim day and today.'),
  beforeClaimStatus, nextDayStatus, newerPage, pendingPage, emptyPage });
console.log('wrote 4 vector files to', out);
