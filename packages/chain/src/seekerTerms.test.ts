/** Transport/orchestration tests only. Mocked account and settlement acceptance
 * below is NOT genuine authority; their real ABI/proof tests are separate. */
import { createHash } from 'node:crypto';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import { PublicKey, Keypair, SYSVAR_CLOCK_PUBKEY, TransactionMessage,
  type AccountInfo, type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seekerAuctionConfigPda, seekerAuctionPda, seekerAuthorityPda, seekerRegistryPda, seekerTermPda } from './seekerAuctionProtocol';
import type { VerifiedSeekerTermAccounts, SeekerTermAccountPolicy } from './seekerTermAccounts';
import type { SeekerSettlementExpectation } from './seekerSettlementEvidence';
import { makeSeekerTermRpc, readFinalizedSeekerTerm, type ReviewedSeekerTermPolicy, type SeekerTermRpc } from './seekerTerms';

const helpers = vi.hoisted(() => ({ accounts: vi.fn(), settlement: vi.fn() }));
vi.mock('./seekerTermAccounts', () => ({ verifySeekerTermAccounts: helpers.accounts }));
vi.mock('./seekerSettlementEvidence', () => ({ seekerSettlementEvidence: helpers.settlement }));
const key = () => Keypair.generate().publicKey;
const program = key(), genesis = key(), mint = key(), prizeOwner = key(), prizeAta = key(), upgrader = key();
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const sysvarOwner = new PublicKey('Sysvar1111111111111111111111111111111111111');
const config = seekerAuctionConfigPda(program), registry = seekerRegistryPda(program), term = seekerTermPda(program, config, 0n);
const programDataAddress = PublicKey.findProgramAddressSync([program.toBuffer()], loader)[0];
const signature = (index: number) => { const b = Buffer.alloc(64, 9); b.writeUInt32LE(index, 0); return bs58.encode(b); };
const operatingStart = 1000n, operatingEnd = operatingStart + BigInt(PHASE_E_POLICY.seekerIsland.operatingTermSec);
const account = (data: Buffer, owner = program, executable = false): AccountInfo<Buffer> => ({ data, owner, executable, lamports: 1, rentEpoch: 0 });
type ReadResponse = { context: { slot: number }; value: Array<AccountInfo<Buffer> | null> };
function harness() {
  const programBytes = Buffer.alloc(36); programBytes.writeUInt32LE(2); programDataAddress.toBuffer().copy(programBytes, 4);
  const data = Buffer.alloc(49, 7); data.writeUInt32LE(3); data.writeBigUInt64LE(100n, 4); data[12] = 1; upgrader.toBuffer().copy(data, 13);
  const clock = Buffer.alloc(40); clock.writeBigUInt64LE(120n); clock.writeBigInt64LE(operatingStart + 1n, 32);
  const deployment = { programDataAddress: programDataAddress.toBase58(),
    programDataSha256: createHash('sha256').update(data).digest('hex'), upgradeAuthority: upgrader.toBase58() };
  const policy: ReviewedSeekerTermPolicy = { programId: program, config, round: 0n, mint, prizeOwner, prizeAta,
    genesisHash: genesis, stateProvenance: 'fresh-reviewed-deployment', deployment };
  const store = new Map<string, AccountInfo<Buffer>>([
    [program.toBase58(), account(programBytes, loader, true)], [programDataAddress.toBase58(), account(data, loader)],
    [seekerAuthorityPda(program).toBase58(), account(Buffer.from([1]))], [config.toBase58(), account(Buffer.from([2]))],
    [registry.toBase58(), account(Buffer.from([3]))], [term.toBase58(), account(Buffer.from([4]))],
    [SYSVAR_CLOCK_PUBKEY.toBase58(), account(clock, sysvarOwner)],
  ]);
  const auctions = Array.from({ length: PHASE_E_POLICY.seekerIsland.totalSpots }, (_, spotId) => {
    const auction = seekerAuctionPda(program, config, spotId, 0n).toBase58(); store.set(auction, account(Buffer.from([spotId])));
    return Object.freeze({ terms: Object.freeze({ config: config.toBase58(), registry: registry.toBase58(), term: term.toBase58(), auction,
      registryHash: 'ab'.repeat(32), spotId, class: 0 as const, realmMask: 15, round: 0n,
      auctionStart: 0n, auctionEnd: operatingStart, operatingStart, operatingEnd, mint: mint.toBase58(),
      tokenProgram: key().toBase58(), vault: key().toBase58(), prizeOwner: prizeOwner.toBase58(), prizeAta: prizeAta.toBase58(),
      prizeBps: 10000, grace: 1n, openingBid: 1n, registryVersion: 1, auctionFormat: 1, termsFormat: 1 }),
      termsHash: 'cd'.repeat(32), winner: null, highBid: 0n, settledAt: operatingStart, settledSlot: 110n });
  });
  const decoded: VerifiedSeekerTermAccounts = Object.freeze({ source: Object.freeze({ programId: program.toBase58(),
    genesisHash: genesis.toBase58(), config: config.toBase58(), round: 0n }),
    authority: Object.freeze({ address: seekerAuthorityPda(program).toBase58(), admissionPaused: true }),
    registry: registry.toBase58(), registryHash: 'ab'.repeat(32), term: term.toBase58(), previousTerm: null,
    decimals: 0, auctionStart: 0n, auctionEnd: operatingStart, operatingStart, operatingEnd,
    completedAt: operatingStart, completedSlot: 110n, winnerCount: 0, auctions: Object.freeze(auctions) });
  let facts = decoded;
  helpers.accounts.mockImplementation((p: SeekerTermAccountPolicy) => {
    if (p.operatingAt < operatingStart || p.operatingAt >= operatingEnd) throw new Error('mock decoder: inactive term');
    return facts;
  });
  const bodies = new Map<string, VersionedTransactionResponse | null>();
  const acceptance = new WeakMap<object, Set<string>>();
  function body(sig: string, ids: readonly number[]): VersionedTransactionResponse {
    const tx: VersionedTransactionResponse = { slot: 110, blockTime: null,
      transaction: { signatures: [sig], message: new TransactionMessage({ payerKey: upgrader,
        recentBlockhash: key().toBase58(), instructions: ids.map(i => ({ programId: program, data: Buffer.alloc(8),
          keys: [upgrader, config, term, new PublicKey(auctions[i]!.terms.auction)]
            .map((pubkey, position) => ({ pubkey, isSigner: position === 0, isWritable: position >= 2 })) })) }).compileToLegacyMessage() },
      meta: { err: null, fee: 0, preBalances: [], postBalances: [], innerInstructions: [] } };
    // Real compiled message/key shape exercises the discovery prefilter. The
    // zero discriminator/incomplete accounts are NOT valid settlement semantics.
    acceptance.set(tx.transaction, new Set(ids.map(i => auctions[i]!.terms.auction))); return tx;
  }
  for (let i = 0; i < auctions.length; i++) bodies.set(signature(i), body(signature(i), [i]));
  helpers.settlement.mockImplementation((tx: VersionedTransactionResponse | null, expected: SeekerSettlementExpectation, observed: PublicKey) => {
    if (!tx || tx.meta?.err !== null || tx.slot !== Number(expected.settledSlot)
      || tx.transaction.signatures[0] !== expected.signature || !observed.equals(genesis)
      || !acceptance.get(tx.transaction)?.has(expected.terms.auction.toBase58())) throw new Error('mock proof refused');
    return Object.freeze({ signature: expected.signature, slot: expected.settledSlot, instructionIndex: 0,
      method: 'permissionless' as const, settler: upgrader.toBase58(), policyKey: null, requiresFinalizedAccountsAndReviewedDeployment: true as const });
  });
  let readIndex = 0;
  let editRead: ((index: number, response: ReadResponse) => void) | undefined;
  const rpc = {
    getGenesisHash: vi.fn(async () => genesis.toBase58()),
    getMultipleAccountsInfoAndContext: vi.fn(async (addresses: PublicKey[], _options: unknown) => {
      const index = readIndex++;
      const response: ReadResponse = { context: { slot: 120 + index },
        value: addresses.map(a => { const found = store.get(a.toBase58()); return found ? { ...found, data: Buffer.from(found.data) } : null; }) };
      editRead?.(index, response); return response;
    }),
    getSignaturesForAddress: vi.fn(async (address: PublicKey, _options: unknown, _commitment: unknown) => {
      const index = auctions.findIndex(a => a.terms.auction === address.toBase58());
      return [{ signature: signature(index), slot: 110, err: null, memo: null, confirmationStatus: 'finalized' as const }];
    }),
    getTransaction: vi.fn(async (sig: string, _options: unknown) => bodies.get(sig) ?? null),
    getBlock: vi.fn(async (slot: number, _options: unknown) => ({ parentSlot: slot - 1, blockTime: null,
      blockhash: key().toBase58(), previousBlockhash: key().toBase58(),
      transactions: [...bodies.values()].filter(x => x !== null && x.slot === slot) })),
  };
  const hints = new Map(auctions.map((_, i) => [i, signature(i)]));
  const connect = vi.fn((_signal: AbortSignal) => rpc as unknown as SeekerTermRpc);
  return { policy, deployment, store, rpc, connect, bodies, body, hints, decoded,
    edit: (fn: typeof editRead) => { editRead = fn; }, setFacts: (next: VerifiedSeekerTermAccounts) => { facts = next; } };
}
beforeEach(() => { helpers.accounts.mockReset(); helpers.settlement.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('finalized Seeker RPC orchestration with explicitly mocked semantic authority', () => {
  it('resolves all100 originals, brackets reads and delegates exact proof inputs', async () => {
    const h = harness(), before = Date.now();
    const result = await readFinalizedSeekerTerm(h.connect, h.policy);
    expect(result.auctions).toHaveLength(PHASE_E_POLICY.seekerIsland.totalSpots);
    expect(helpers.accounts).toHaveBeenCalledTimes(2); expect(helpers.settlement).toHaveBeenCalledTimes(100);
    expect(h.rpc.getMultipleAccountsInfoAndContext.mock.calls.map(c => c[1])).toEqual([120, 121, 122, 123].map((_, i) =>
      ({ commitment: 'finalized', minContextSlot: i === 0 ? 0 : 119 + i })));
    expect(h.rpc.getMultipleAccountsInfoAndContext.mock.calls[1]![0]).toHaveLength(100);
    expect(helpers.settlement.mock.calls[0]![1]).toMatchObject({ signature: signature(0), programId: program,
      genesisHash: genesis, termsHash: Buffer.from('cd'.repeat(32), 'hex'), highBid: 0n, winner: null, settledSlot: 110n, settledAt: operatingStart });
    expect(h.rpc.getTransaction).toHaveBeenCalledWith(signature(0), { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    expect(result.finality).toMatchObject({ commitment: 'finalized', contextSlot: 123n });
    expect(Date.parse(result.finality.observedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(result.finality.observedAt)).toBeLessThanOrEqual(Date.now());
    expect(Object.isFrozen(result) && Object.isFrozen(result.auctions) && Object.isFrozen(result.auctions[0]!.terms)).toBe(true);
    expect(Object.isFrozen(result.auctions[0]!.settlement) && Object.isFrozen(result.deployment) && Object.isFrozen(result.finality)).toBe(true);
    h.deployment.programDataSha256 = '00'.repeat(32);
    expect(result.deployment.programDataSha256).not.toBe(h.policy.deployment.programDataSha256);
    expect(h.connect.mock.calls[0]![0].aborted).toBe(true);
  });
  it('requires explicit fresh deployment provenance and rejects wrong or changing genesis', async () => {
    const h = harness();
    await expect(readFinalizedSeekerTerm(h.connect, { ...h.policy, stateProvenance: undefined } as never)).rejects.toThrow('retained state');
    expect(h.connect).not.toHaveBeenCalled();
    h.rpc.getGenesisHash.mockResolvedValueOnce(key().toBase58());
    await expect(readFinalizedSeekerTerm(h.connect, h.policy)).rejects.toThrow('unavailable');
    const changed = harness(); changed.rpc.getGenesisHash.mockResolvedValueOnce(genesis.toBase58()).mockResolvedValueOnce(key().toBase58());
    await expect(readFinalizedSeekerTerm(changed.connect, changed.policy)).rejects.toThrow('unavailable');
  });
  it('rejects wrong reviewed full hash, upgrader, program pointer and deployment beyond context', async () => {
    for (const variation of ['hash', 'upgrader', 'pointer', 'slot'] as const) {
      const h = harness();
      if (variation === 'hash') h.deployment.programDataSha256 = '00'.repeat(32);
      if (variation === 'upgrader') h.deployment.upgradeAuthority = key().toBase58();
      if (variation === 'pointer') h.store.get(program.toBase58())!.data.set(key().toBuffer(), 4);
      if (variation === 'slot') {
        const d = h.store.get(programDataAddress.toBase58())!.data; d.writeBigUInt64LE(121n, 4);
        h.deployment.programDataSha256 = createHash('sha256').update(d).digest('hex');
      }
      await expect(readFinalizedSeekerTerm(h.connect, h.policy)).rejects.toThrow('unavailable');
      expect(helpers.settlement).not.toHaveBeenCalled(); helpers.settlement.mockClear();
    }
  });
  it('rejects missing accounts, incomplete batches and regressing or unsafe context slots', async () => {
    for (const mutation of ['missing', 'short', 'regressed', 'unsafe'] as const) {
      const h = harness(); h.edit((index, response) => { if (index !== 1) return;
        if (mutation === 'missing') response.value[0] = null;
        if (mutation === 'short') response.value.pop();
        if (mutation === 'regressed') response.context.slot = 119;
        if (mutation === 'unsafe') response.context.slot = Number.MAX_SAFE_INTEGER + 1;
      });
      await expect(readFinalizedSeekerTerm(h.connect, h.policy)).rejects.toThrow('unavailable');
    }
  });
  it('rejects immutable term/config/registry and reviewed program changes across either bracket', async () => {
    for (const index of [2, 3]) for (const position of [0, 1, 3, 4, 5]) {
      const h = harness(); h.edit((at, response) => { if (at === index) {
        const data = response.value[position]!.data; data[0] = data[0]! ^ 1;
      } });
      await expect(readFinalizedSeekerTerm(h.connect, h.policy)).rejects.toThrow('unavailable');
    }
  });
  it('uses actual Clock again at completion and permits authority rotation without rewriting immutable history', async () => {
    const h = harness(); h.edit((index, response) => { if (index === 3) response.value[6]!.data.writeBigInt64LE(operatingEnd, 32); });
    await expect(readFinalizedSeekerTerm(h.connect, h.policy)).rejects.toThrow('unavailable');
    expect(helpers.accounts.mock.calls.at(-1)![0].operatingAt).toBe(operatingEnd);
    const rotation = harness(); rotation.edit((index, response) => { if (index === 2 || index === 3) response.value[2]!.data[0] = index; });
    expect((await readFinalizedSeekerTerm(rotation.connect, rotation.policy)).auctions).toHaveLength(100);
  });
  it('refuses malformed Clock owner/layout/executable/slot even when mocked account verification would accept it', async () => {
    for (const mutate of [(a: AccountInfo<Buffer>) => { a.owner = program; },
      (a: AccountInfo<Buffer>) => { a.executable = true; }, (a: AccountInfo<Buffer>) => { a.data = Buffer.alloc(39); },
      (a: AccountInfo<Buffer>) => { a.data.writeBigUInt64LE(999n); }]) {
      const h = harness(); h.edit((index, response) => { if (index === 2) mutate(response.value[6]!); });
      await expect(readFinalizedSeekerTerm(h.connect, h.policy)).rejects.toThrow('unavailable');
    }
  });
  it('rejects settlements at/before deployment or above the finalized account context', async () => {
    for (const settledSlot of [99n, 100n, 123n]) {
      const h = harness(); h.setFacts({ ...h.decoded, auctions: [{ ...h.decoded.auctions[0]!, settledSlot }, ...h.decoded.auctions.slice(1)] });
      await expect(readFinalizedSeekerTerm(h.connect, h.policy)).rejects.toThrow('unavailable');
      expect(h.rpc.getTransaction).not.toHaveBeenCalledWith(signature(0), expect.anything());
      // Invalid account provenance is refused before any history/body RPC work.
      expect(h.rpc.getTransaction).not.toHaveBeenCalled();
    }
    const completion = harness(); completion.setFacts({ ...completion.decoded, completedSlot: 123n });
    await expect(readFinalizedSeekerTerm(completion.connect, completion.policy)).rejects.toThrow('unavailable');
    expect(completion.rpc.getTransaction).not.toHaveBeenCalled();
  });
  it('revalidates every supplied hint without reading account history or inventing a fallback', async () => {
    const h = harness(); await readFinalizedSeekerTerm(h.connect, h.policy, { settlementSignatures: h.hints });
    expect(h.rpc.getSignaturesForAddress).not.toHaveBeenCalled(); expect(h.rpc.getBlock).not.toHaveBeenCalled();
    expect(helpers.settlement).toHaveBeenCalledTimes(100);
    const missing = harness(); missing.bodies.set(signature(0), null);
    await expect(readFinalizedSeekerTerm(missing.connect, missing.policy, { settlementSignatures: missing.hints })).rejects.toThrow('unavailable');
    expect(missing.rpc.getBlock).not.toHaveBeenCalled();
    const failed = harness(); failed.bodies.get(signature(0))!.meta!.err = { InstructionError: [0, 'InvalidArgument'] };
    await expect(readFinalizedSeekerTerm(failed.connect, failed.policy, { settlementSignatures: failed.hints })).rejects.toThrow('unavailable');
    expect(helpers.settlement).toHaveBeenCalledWith(failed.bodies.get(signature(0)), expect.anything(), genesis);
  });
  it('caches a batch transaction body but separately verifies all100 auction bindings', async () => {
    const h = harness(), sig = signature(500); h.bodies.set(sig, h.body(sig, Array.from({ length: 100 }, (_, i) => i)));
    const hints = new Map(Array.from({ length: 100 }, (_, i) => [i, sig]));
    const result = await readFinalizedSeekerTerm(h.connect, h.policy, { settlementSignatures: hints });
    expect(h.rpc.getTransaction).toHaveBeenCalledTimes(1); expect(helpers.settlement).toHaveBeenCalledTimes(100);
    expect(result.auctions.every(a => a.settlement.signature === sig)).toBe(true);
  });
  for (const noise of ['no hits', 'recent poisoning', 'history error', 'too many same-slot mentions', 'duplicate hints', 'unrelated body'] as const) {
    it(`finds original settlement in finalized block after ${noise}`, async () => {
      const h = harness();
      if (noise === 'history error') h.rpc.getSignaturesForAddress.mockRejectedValue(new Error('history unavailable'));
      else h.rpc.getSignaturesForAddress.mockImplementation(async () => {
        if (noise === 'no hits') return [];
        const count = noise === 'recent poisoning' ? 32 : noise === 'too many same-slot mentions' ? 9 : noise === 'duplicate hints' ? 2 : 1;
        return Array.from({ length: count }, (_, i) => ({ signature: signature(noise === 'duplicate hints' ? 999 : 999 + i),
          slot: noise === 'recent poisoning' ? 119 : 110, err: null, memo: null, confirmationStatus: 'finalized' as const }));
      });
      const result = await readFinalizedSeekerTerm(h.connect, h.policy);
      expect(result.auctions).toHaveLength(100);
      expect(h.rpc.getBlock).toHaveBeenCalledWith(110, { commitment: 'finalized', maxSupportedTransactionVersion: 0,
        transactionDetails: 'full', rewards: false });
      expect(h.rpc.getBlock).toHaveBeenCalledTimes(1); // Shared original slot is fetched once despite100 noisy histories.
      expect(result.auctions[0]!.settlement.signature).toBe(signature(0));
    });
  }
  it('groups mixed original slots for one block fetch each and restores canonical spot order', async () => {
    const h = harness(); h.rpc.getSignaturesForAddress.mockResolvedValue([]);
    const auctions = h.decoded.auctions.map((a, i) => ({ ...a, settledSlot: i % 2 === 0 ? 110n : 111n }));
    for (let i = 0; i < auctions.length; i++) h.bodies.get(signature(i))!.slot = Number(auctions[i]!.settledSlot);
    h.setFacts({ ...h.decoded, auctions: auctions.reverse() });
    const result = await readFinalizedSeekerTerm(h.connect, h.policy);
    expect(h.rpc.getBlock.mock.calls.map(call => call[0])).toEqual([110, 111]);
    expect(result.auctions.map(a => a.terms.spotId)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });
  it('recovers from an unhinted provider body error through the original block, while explicit hints still refuse', async () => {
    const h = harness(); h.rpc.getTransaction.mockRejectedValue(new Error('body provider unavailable'));
    const result = await readFinalizedSeekerTerm(h.connect, h.policy);
    expect(result.auctions).toHaveLength(100); expect(h.rpc.getBlock).toHaveBeenCalledTimes(1);
    expect(result.auctions[0]!.settlement.signature).toBe(signature(0));
    const explicit = harness(); explicit.rpc.getTransaction.mockRejectedValue(new Error('body provider unavailable'));
    await expect(readFinalizedSeekerTerm(explicit.connect, explicit.policy, { settlementSignatures: explicit.hints })).rejects.toThrow('unavailable');
    expect(explicit.rpc.getBlock).not.toHaveBeenCalled();
  });
  it('refuses missing original block, no accepted body or ambiguous block settlements', async () => {
    for (const variant of ['missing', 'empty', 'ambiguous'] as const) {
      const h = harness(); h.rpc.getSignaturesForAddress.mockResolvedValue([]);
      if (variant === 'missing') h.rpc.getBlock.mockResolvedValue(null as never);
      if (variant === 'empty') h.rpc.getBlock.mockResolvedValue({ parentSlot: 109, blockTime: null, blockhash: '', previousBlockhash: '', transactions: [] });
      if (variant === 'ambiguous') h.bodies.set(signature(999), h.body(signature(999), [0]));
      await expect(readFinalizedSeekerTerm(h.connect, h.policy)).rejects.toThrow('unavailable');
    }
  });
  it('does not turn a refused semantic account proof into a term', async () => {
    const h = harness(); helpers.accounts.mockImplementation(() => { throw new Error('account proof rejected'); });
    await expect(readFinalizedSeekerTerm(h.connect, h.policy)).rejects.toThrow('unavailable');
    expect(h.rpc.getTransaction).not.toHaveBeenCalled();
  });
  it('aborts the supplied transport signal at the bounded deadline without publishing partial results', async () => {
    vi.useFakeTimers(); const h = harness(); h.rpc.getTransaction.mockImplementation(() => new Promise(() => {}));
    const failed = expect(readFinalizedSeekerTerm(h.connect, h.policy, { deadlineMs: 10 })).rejects.toThrow('unavailable');
    await vi.advanceTimersByTimeAsync(11); await failed;
    expect(h.connect.mock.calls[0]![0].aborted).toBe(true);
    expect(h.rpc.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(3);
  });
});

describe('Seeker HTTP body transport (mock fetch; no network)', () => {
  it('uses finalized RPC with the original abort signal and no redirect following', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: genesis.toBase58() }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await makeSeekerTermRpc('http://127.0.0.1:8899', controller.signal).getGenesisHash()).toBe(genesis.toBase58());
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ signal: controller.signal, redirect: 'error' });
  });
  it('cancels refused bodies without exposing an upstream response in the error', async () => {
    const cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }), { status: 503 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(makeSeekerTermRpc('http://127.0.0.1:8899', new AbortController().signal).getGenesisHash()).rejects.toThrow('transport refused');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('enforces the full streamed body size bound and cancels the reader', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(c) {
      c.enqueue(new Uint8Array(32 * 1024 * 1024 + 1));
    }, cancel }))));
    await expect(makeSeekerTermRpc('http://127.0.0.1:8899', new AbortController().signal).getGenesisHash()).rejects.toThrow('work bound');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('keeps cancellation attached after headers while a body is still streaming', async () => {
    const controller = new AbortController(); let started!: () => void;
    const bodyStarted = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream({ start(c) {
      init!.signal!.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')), { once: true });
      c.enqueue(new TextEncoder().encode('{')); started();
    } }))));
    const failed = expect(makeSeekerTermRpc('http://127.0.0.1:8899', controller.signal).getGenesisHash()).rejects.toThrow('Aborted');
    await bodyStarted; controller.abort(); await failed;
  });
});
