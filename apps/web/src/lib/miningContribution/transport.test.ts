import { beforeEach, expect, it, vi } from 'vitest';
import { requestUnpaidOriginal } from '../api';
import { miningContributionOriginal } from './transport';
import { command, deferred, identity, proof, start } from './fixtures.test-support';
vi.mock('../api', () => ({ requestUnpaidOriginal: vi.fn() }));
let status: number, body: unknown;
beforeEach(() => { status = 200; body = proof(start, true); vi.mocked(requestUnpaidOriginal).mockReset().mockImplementation(async input => await input.observe(status, body) as never); });
const input = () => ({ wallet: identity.wallet, request: start.request, method: 'POST' as 'GET' | 'POST', firstAttempt: true,
  isCurrent: () => true, retainAccepted: vi.fn(async () => undefined), retainRefusal: vi.fn(async () => undefined) });
it.each(['GET', 'POST'] as const)('binds %s to the exact original endpoint, request and durable callback', async method => {
  const options = { ...input(), method, firstAttempt: method === 'POST' }; await miningContributionOriginal(options);
  const sent = vi.mocked(requestUnpaidOriginal).mock.calls[0]![0];
  expect(sent.path).toBe(method === 'POST' ? '/mining/contributions' : `/mining/contributions/by-key/${start.request.idempotencyKey}`);
  expect(sent.body).toEqual(method === 'POST' ? start.request : undefined); expect(options.retainAccepted).toHaveBeenCalledWith(body);
});
it('does not resolve acceptance before its owned durable write completes', async () => {
  const entered = deferred(), release = deferred(); let finished = false;
  const options = { ...input(), retainAccepted: async () => { entered.resolve(); await release.promise; } };
  const pending = miningContributionOriginal(options).then(() => { finished = true; }); await entered.promise;
  expect(finished).toBe(false); release.resolve(); await pending; expect(finished).toBe(true);
});
it.each(['unknown', 'foreign-body', 'future', 'partial'] as const)('rejects %s response without granting false acceptance', async kind => {
  if (kind === 'unknown') body = proof(); else if (kind === 'foreign-body') body = proof(command('2'), true);
  else if (kind === 'future') body = { ...proof(start, true), serverNow: '2026-09-29T00:00:00.000Z' }; else body = { status: 'accepted' };
  const options = input(); await expect(miningContributionOriginal(options)).rejects.toThrow(); expect(options.retainAccepted).not.toHaveBeenCalled();
});
it.each(['first', 'retry', 'GET', '503', 'conflict'] as const)('only known first refusals can be retained, classification=%s', async kind => {
  status = kind === '503' ? 503 : kind === 'conflict' ? 409 : 422;
  body = { error: { code: kind === '503' ? 'PHASE_E_DISABLED' : kind === 'conflict' ? 'IDEMPOTENCY_BODY_MISMATCH' : 'INSUFFICIENT_MINING_RESOURCES', message: 'Refused' } };
  const options = input(); if (kind === 'GET') options.method = 'GET'; if (kind === 'GET' || kind === 'retry') options.firstAttempt = false;
  await miningContributionOriginal(options); expect(options.retainRefusal).toHaveBeenCalledTimes(kind === 'first' ? 1 : 0); expect(options.retainAccepted).not.toHaveBeenCalled();
});
