/** Actual browser controller/crypto/IndexedDB + authenticated API + owner-only
 * persisted receipts over synthetic finalized chain evidence. No public RPC. */
import { describe, expect, it } from 'vitest';
import { SOLANA_GENESIS_HASH } from '../../../packages/chain/src/cluster';
import { withMiningTaxWebFixture } from './fixtures/miningTaxWeb';

describe('paired browser original KEEP tax claim', () => {
 it('preserves one exact signature and submit through lost replies and paused providerless recovery, then archives the bound payment', () => withMiningTaxWebFixture(async f => {
  expect(f.preparation.identity.genesisHash).toBe(SOLANA_GENESIS_HASH.devnet);
  let client = f.client();
  await client.controller.begin(f.preparation.round, f.preparation.spot, f.preparation.caps);
  expect(client.controller.snapshot().error).toContain('lost prepare reply');
  expect(f.posts).toHaveLength(1); expect(f.posts[0]!.journal.operation).toMatchObject({ prepareAttempted: true, preparation: null });
  client = f.client(); await client.controller.open(); expect(client.controller.snapshot().error).toBeNull();
  expect((await client.store.read()).operation?.preparation).toEqual(f.preparation);
  await client.controller.review(); expect(client.controller.snapshot().error).toBeNull();
  await client.controller.sign(); expect(client.controller.snapshot().error).toBeNull(); expect(f.sign).toHaveBeenCalledOnce();
  const original = (await client.store.read()).operation!.transactions[0]!.signed!;
  await client.controller.submit(); expect(client.controller.snapshot().error).toContain('lost submit reply');
  expect(f.posts).toHaveLength(2); expect(f.posts[1]!.journal.operation?.transactions[0]).toMatchObject({ submitAttempted: true, signed: original });
  expect(f.sent).toEqual([original.wire]); expect(f.broadcast).not.toHaveBeenCalled();
  expect(await f.rows('mining_tax_claim_signed_wires')).toEqual([{ ordinal: 0 }]);
  const admissionCalls = f.chain.calls.connect;
  await f.restartPaused(); client = f.client(false); await client.controller.open();
  expect(client.controller.snapshot().error).toBeNull(); expect((await client.store.read()).operation!.transactions[0]!.signed).toEqual(original);
  await client.controller.review(); await client.controller.sign(); await client.controller.submit(); await client.controller.archive();
  expect((await client.store.read()).operation).not.toBeNull(); expect(f.sign).toHaveBeenCalledOnce(); expect(f.posts).toHaveLength(2); expect(f.sent).toHaveLength(1);
  expect(f.chain.calls.connect).toBe(admissionCalls);
  await f.complete(); await client.controller.open(); expect(client.controller.snapshot().error).toBeNull();
  const paid = (await client.store.read()).operation!;
  expect(paid.settlement?.settlement?.receipt.paidKeepBaseUnits).toBe(f.preparation.intended.claimBaseUnits);
  expect(paid.settlement?.settlement?.claimFinalized).toBe(true); expect(await f.rows('mining_tax_claim_receipts')).toEqual([{ ordinal: 0 }]);
  await client.controller.archive(); expect(client.controller.snapshot().error).toBeNull(); expect((await client.store.read()).operation).toBeNull();
  const archived = (await client.store.archived(f.preparation.idempotencyKey))!.operation!;
  expect(archived.request.caps).toEqual(f.preparation.caps); expect(archived.transactions[0]!.signed).toEqual(original); expect(archived.settlement).toEqual(paid.settlement);
  await f.client(false).controller.open(); expect(f.posts).toHaveLength(2); expect(f.sent).toHaveLength(1); expect(f.sign).toHaveBeenCalledOnce();
 }, { mode: 'combined', genesisHash: SOLANA_GENESIS_HASH.devnet, losePrepare: true, loseSubmit: true, loseRelay: true }), 120_000);

 it('keeps actual split setup nonterminal and requires a separate fresh ordinal1 review, approval and exact submit before archival', () => withMiningTaxWebFixture(async f => {
  const client = f.client(); await client.controller.begin(f.preparation.round, f.preparation.spot, f.preparation.caps);
  expect(client.controller.snapshot().error).toBeNull(); await client.controller.review(1); expect(client.controller.snapshot().review).toBeNull();
  expect(f.sign).not.toHaveBeenCalled();
  await client.controller.review(0); await client.controller.sign(); expect(client.controller.snapshot().error).toBeNull();
  await client.controller.submit(0); expect(client.controller.snapshot().error).toBeNull(); expect(f.sign).toHaveBeenCalledOnce(); expect(f.sent).toHaveLength(1);
  await f.settle({ key: f.preparation.idempotencyKey, ordinal: 0, setupFee: 6 });
  await client.controller.open(); expect(client.controller.snapshot().error).toBeNull();
  const setup = (await client.store.read()).operation!;
  expect(setup.setup?.status).toBe('setup'); expect(setup.setup?.settlement?.receipt.feeLamports).toBe('6'); expect(setup.settlement).toBeNull();
  await client.controller.archive(); expect((await client.store.read()).operation).not.toBeNull();
  await client.controller.sign(); expect(f.sign).toHaveBeenCalledOnce();
  await client.controller.review(1); expect(client.controller.snapshot().error).toBeNull(); expect(client.controller.snapshot().review?.ordinal).toBe(1);
  expect(client.controller.snapshot().review?.current.review).toMatchObject({ paidFeeLamports: '6', feeLamports: '4', paidRentLamports: f.preparation.fees.rentLamports });
  await client.controller.sign(); expect(client.controller.snapshot().error).toBeNull(); expect(f.sign).toHaveBeenCalledTimes(2); expect(f.sent).toHaveLength(1);
  await client.controller.submit(1); expect(client.controller.snapshot().error).toBeNull(); expect(f.sent).toHaveLength(2);
  await f.complete(); await f.restartPaused(); const recovered = f.client(false); await recovered.controller.open(); expect(recovered.controller.snapshot().error).toBeNull();
  const paid = (await recovered.store.read()).operation!;
  expect(paid.setup).toEqual(setup.setup); expect(paid.settlement?.settlement?.receipt.transactions).toHaveLength(2);
  expect(paid.settlement?.settlement?.receipt.feeLamports).toBe('10'); expect(paid.request.caps).toEqual(f.preparation.caps);
  await recovered.controller.archive(); expect(recovered.controller.snapshot().error).toBeNull(); expect((await recovered.store.read()).operation).toBeNull();
  const history = (await recovered.store.archived(f.preparation.idempotencyKey))!.operation!;
  expect(history.setup).toEqual(setup.setup); expect(history.settlement).toEqual(paid.settlement); expect(history.transactions.map(t => t.signed?.wire)).toEqual(f.sent);
  expect(await f.rows('mining_tax_claim_signed_wires')).toEqual([{ ordinal: 0 }, { ordinal: 1 }]);
  expect(await f.rows('mining_tax_claim_receipts')).toEqual([{ ordinal: 0 }, { ordinal: 1 }]);
  expect(await f.inspect()).toMatchObject({ preparePosts: 1, submitPosts: 2, signatures: [0, 1], sends: [0, 1] });
  expect(f.posts.filter(p => p.path.endsWith('/prepare'))).toHaveLength(1); expect(f.posts.filter(p => p.path.endsWith('/submit'))).toHaveLength(2); expect(f.sign).toHaveBeenCalledTimes(2);
 }, { mode: 'split', genesisHash: SOLANA_GENESIS_HASH.devnet }), 120_000);
});
