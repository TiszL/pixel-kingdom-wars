/** A reviewed allocation and its exact unsigned message must be durable together. */
import { createHash, randomUUID } from 'node:crypto';
import { Keypair, PublicKey, VersionedMessage } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { createInitialFreePublicationPreparer } from '../src/mining/publicationPreparation';
import { withInitialFreePublicationFixture as fixture } from './fixtures/initialFreePublication';
const oversizedKeyConstruction = vi.hoisted(() => [] as number[]);
vi.mock('@solana/web3.js', async original => {
  const actual = await original<typeof import('@solana/web3.js')>();
  return { ...actual, PublicKey: new Proxy(actual.PublicKey, { construct(target, args, newTarget) {
    if (typeof args[0] === 'string' && args[0].length > 44) oversizedKeyConstruction.push(args[0].length);
    return Reflect.construct(target, args, newTarget);
  } }) };
});
type Fixture = Parameters<Parameters<typeof fixture>[0]>[0];
async function ready(f: Fixture) {
  f.backing.model.flags = 0; await f.backing.config();
  const rpc = {
    getGenesisHash: vi.fn(async () => f.sources.backing.trust.expectedGenesisHash),
    getLatestBlockhashAndContext: vi.fn(async () => ({ context: { slot: 2000 }, value: {
      blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 2200,
    } })),
  };
  const options = { sources: f.sources, signer: new PublicKey(f.backing.model.publisher), blockhashSource: () => rpc };
  return { rpc, options, prepare: createInitialFreePublicationPreparer(f.conn.db, options), input: { ...f.request, attemptKey: randomUUID() } };
}
async function empty(f: Fixture) {
  for (const name of ['mining_publication_attempts', 'mining_publication_manifests'])
    expect((await f.conn.sql.unsafe(`select count(*)::int n from ${name}`))[0]!.n).toBe(0);
}
describe('first-free publication preparation', () => {
  it('pins the complete paid source and unsigned publication atomically, then replays without RPC after pause', async () => fixture(async f => {
    const h = await ready(f), saved = await h.prepare(h.input);
    expect(saved.status).toBe('prepared'); if (saved.status !== 'prepared') throw Error('Expected publication');
    const bytes = Buffer.from(saved.intentHex, 'hex'), message = VersionedMessage.deserialize(bytes);
    expect(Buffer.from(message.serialize()).equals(bytes)).toBe(true);
    expect(saved.intentSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(saved.sourceHash).toBe(createHash('sha256').update(saved.manifestJson).digest('hex'));
    expect(message.header.numRequiredSignatures).toBe(1);
    expect(saved.publication.signer).toBe(h.options.signer.toBase58());
    expect((await f.conn.sql`select reservation_count from mining_publication_attempts`)[0]!.reservation_count).toBe(3);
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); h.rpc.getGenesisHash.mockRejectedValue(Error('Must not retry RPC'));
    expect(await h.prepare(h.input)).toEqual(saved); expect(h.rpc.getGenesisHash).toHaveBeenCalledTimes(2);
    await expect(h.prepare({ ...h.input, attemptKey: randomUUID() })).rejects.toMatchObject({ code: 'IDEMPOTENCY_BODY_MISMATCH' });
    expect((await f.conn.sql`select count(*)::int n from mining_publication_manifests`)[0]!.n).toBe(1);
  }, { quantities: [1, 1, 1] }));
  it('refuses request-supplied publisher or allocation fields before source reads', async () => fixture(async f => {
    const h = await ready(f);
    for (const extra of [{ signer: h.options.signer.toBase58() }, { budgetGross: '1' }, { manifestJson: '{}' }])
      await expect(h.prepare({ ...h.input, ...extra })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(h.rpc.getGenesisHash).not.toHaveBeenCalled(); await empty(f);
  }));
  it('never pins a paused publication or an application key that is not the current publisher', async () => fixture(async f => {
    const h = await ready(f); f.backing.model.flags = 2; await f.backing.config();
    await expect(h.prepare(h.input)).rejects.toMatchObject({ code: 'PUBLISHER_UNAVAILABLE' });
    f.backing.model.flags = 0; await f.backing.config();
    const wrong = createInitialFreePublicationPreparer(f.conn.db, { ...h.options, signer: Keypair.generate().publicKey });
    await expect(wrong(h.input)).rejects.toMatchObject({ code: 'PUBLISHER_UNAVAILABLE' }); await empty(f);
  }));
  it('keeps a zero-useful-award epoch unfenced for ordinary abort', async () => fixture(async f => {
    const h = await ready(f);
    expect(await h.prepare(h.input)).toMatchObject({ status: 'abort-proposed', consumptionAuthorized: false });
    expect(h.rpc.getGenesisHash).not.toHaveBeenCalled(); await empty(f);
  }, { budgetGross: 1n }));
  it('rolls back the attempt when reservations change after scoring but before the lock', async () => fixture(async f => {
    const h = await ready(f);
    h.rpc.getLatestBlockhashAndContext.mockImplementationOnce(async () => {
      await f.reserve(f.request.day);
      return { context: { slot: 2000 }, value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 2200 } };
    });
    await expect(h.prepare(h.input)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' }); await empty(f);
  }));
  it('refuses the wrong chain or a regressed blockhash context without fencing custody', async () => fixture(async f => {
    const h = await ready(f); h.rpc.getGenesisHash.mockResolvedValueOnce(Keypair.generate().publicKey.toBase58());
    await expect(h.prepare(h.input)).rejects.toMatchObject({ code: 'BLOCKHASH_UNAVAILABLE' });
    h.rpc.getLatestBlockhashAndContext.mockResolvedValueOnce({ context: { slot: 1 }, value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 2200 } });
    await expect(h.prepare(h.input)).rejects.toMatchObject({ code: 'BLOCKHASH_UNAVAILABLE' }); await empty(f);
  }));
  it('bounds a provider blockhash before invoking base58 public-key decoding', async () => fixture(async f => {
    const h = await ready(f);
    h.rpc.getLatestBlockhashAndContext.mockResolvedValueOnce({ context: { slot: 2000 }, value: { blockhash: '1'.repeat(100_000), lastValidBlockHeight: 2200 } });
    await expect(h.prepare(h.input)).rejects.toMatchObject({ code: 'BLOCKHASH_UNAVAILABLE' });
    expect(oversizedKeyConstruction).toEqual([]); await empty(f);
  }));
});
