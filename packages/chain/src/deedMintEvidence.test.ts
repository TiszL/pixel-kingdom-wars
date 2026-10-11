import bs58 from 'bs58';
import { MINT_INVENTORY } from '@shardkeep/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, SolanaJSONRPCError, TransactionMessage, VersionedTransaction, type Connection, type VersionedTransactionResponse } from '@solana/web3.js';
import { Key, getCreateV2InstructionDataSerializer } from '@metaplex-foundation/mpl-core';
import { getCollectionV1AccountDataSerializer } from '@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData';
import { publicKey } from '@metaplex-foundation/umi';
import { PublicKey } from '@solana/web3.js';
import { DeedMintInventoryError, DeedMintTransportError, makeDeedMintInventoryConnection, originalDeedOwner, readDeedMintInventory, readDeedMintProof } from './deedMintEvidence';
const wallet = () => Keypair.generate().publicKey;
const owner = wallet(), asset = wallet(), collection = wallet(), payer = wallet();
const core = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
function fixture(): VersionedTransactionResponse {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: wallet().toBase58(), instructions: [{
    programId: core, keys: [asset,collection,payer,payer,owner,core,core,core].map(pubkey => ({ pubkey, isWritable: false, isSigner: false })),
    data: Buffer.from(getCreateV2InstructionDataSerializer().serialize({ name: 'Deed', uri: 'https://example.org/deed', dataState: 0 })),
  }] }).compileToV0Message();
  return { slot: 42, blockTime: 100, transaction: new VersionedTransaction(message), meta: { err: null, fee: 0, preBalances: [], postBalances: [] } } as unknown as VersionedTransactionResponse;
}
describe('original minter evidence', () => {
  it('uses the creation recipient even when present owner changed', () => {
    expect(originalDeedOwner(fixture(), asset.toBase58(), collection.toBase58())).toBe(owner.toBase58());
  });
  it('rejects a different asset or collection and failed transactions', () => {
    expect(originalDeedOwner(fixture(), wallet().toBase58(), collection.toBase58())).toBeNull();
    expect(originalDeedOwner(fixture(), asset.toBase58(), wallet().toBase58())).toBeNull();
    const tx = fixture(); tx.meta!.err = { InstructionError: [0, 'InvalidArgument'] };
    expect(originalDeedOwner(tx, asset.toBase58(), collection.toBase58())).toBeNull();
  });
  it('rejects an attempted inner mint whose failure may have been caught', () => {
    const t=fixture(), ix=t.transaction.message.compiledInstructions[0]!;
    t.meta!.innerInstructions=[{ index:0, instructions:[{programIdIndex:ix.programIdIndex,accounts:[...ix.accountKeyIndexes],data:bs58.encode(ix.data)}]}];
    expect(()=>originalDeedOwner(t,asset.toBase58(),collection.toBase58())).toThrow('CPI mint execution');
  });
  it('uses block order rather than signature lexicographic order', async () => {
    const rpc = { getSignaturesForAddress: vi.fn().mockResolvedValue([{ signature: 'mint', err: null }]), getTransaction: vi.fn().mockResolvedValue(fixture()), getBlockSignatures: vi.fn().mockResolvedValue({ signatures: ['other','mint'] }) };
    expect(await readDeedMintProof(rpc as unknown as Connection, asset.toBase58(), collection.toBase58())).toMatchObject({ originalWallet: owner.toBase58(), slot: '42', transactionIndex: 1, confirmedAt: new Date(100000) });
    expect(rpc.getTransaction).toHaveBeenCalledWith('mint', { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  });
  it('fails closed on missing transaction, timestamp or block position', async () => {
    const rpc = { getSignaturesForAddress: vi.fn().mockResolvedValue([{ signature: 'mint', err: null }]), getTransaction: vi.fn().mockResolvedValue(null), getBlockSignatures: vi.fn().mockResolvedValue({ signatures: [] }) };
    await expect(readDeedMintProof(rpc as unknown as Connection, asset.toBase58(), collection.toBase58())).rejects.toThrow('history unavailable');
    rpc.getTransaction.mockResolvedValue({ ...fixture(), blockTime: null });
    await expect(readDeedMintProof(rpc as unknown as Connection, asset.toBase58(), collection.toBase58())).rejects.toThrow('time unavailable');
    rpc.getTransaction.mockResolvedValue(fixture());
    await expect(readDeedMintProof(rpc as unknown as Connection, asset.toBase58(), collection.toBase58())).rejects.toThrow('order unavailable');
  });
  it('finishes paginated history before selecting the oldest successful mint', async () => {
    const failedPage = Array.from({ length: 1000 }, (_, index) => ({ signature: `failed-${index}`, err: { InstructionError: [0, 'InvalidArgument'] } }));
    const rpc = {
      getSignaturesForAddress: vi.fn().mockResolvedValueOnce(failedPage).mockResolvedValueOnce([{ signature: 'original-mint', err: null }]),
      getTransaction: vi.fn().mockResolvedValue(fixture()),
      getBlockSignatures: vi.fn().mockResolvedValue({ signatures: ['zzz-before', 'original-mint', 'aaa-after'] }),
    };
    expect(await readDeedMintProof(rpc as unknown as Connection, asset.toBase58(), collection.toBase58())).toMatchObject({ signature: 'original-mint', transactionIndex: 1 });
    expect(rpc.getSignaturesForAddress).toHaveBeenNthCalledWith(2, asset, { limit: 1000, before: 'failed-999' }, 'finalized');
    expect(rpc.getTransaction).toHaveBeenCalledExactlyOnceWith('original-mint', { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  });
  it('rejects a repeated full history page instead of finalizing truncated evidence', async () => {
    const repeatedPage = Array.from({ length: 1000 }, (_, index) => ({ signature: `signature-${index}`, err: null }));
    const rpc = { getSignaturesForAddress: vi.fn().mockResolvedValue(repeatedPage), getTransaction: vi.fn() };
    await expect(readDeedMintProof(rpc as unknown as Connection, asset.toBase58(), collection.toBase58())).rejects.toThrow('pagination incomplete');
    expect(rpc.getTransaction).not.toHaveBeenCalled();
  });
});

describe('complete original-mint inventory', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const contextLag = () => new SolanaJSONRPCError({ code: -32016, message: 'Minimum context slot has not been reached' });
  function collectionAccount(numMinted: number, currentSize: number) {
    return {
      owner: core,
      data: Buffer.from(getCollectionV1AccountDataSerializer().serialize({
        key: Key.CollectionV1, updateAuthority: publicKey(owner.toBase58()), name: 'Land deeds', uri: '', numMinted, currentSize,
      })),
    };
  }
  function inventoryRpc(before: [number, number], after: [number, number], assets: PublicKey[]) {
    let reads = 0;
    return {
      getAccountInfoAndContext: vi.fn().mockImplementation(async () => {
        const index = reads++, round = Math.floor(index / 2);
        return { context: { slot: round * 200 + (index % 2 ? 150 : 100) }, value: collectionAccount(...(index % 2 ? after : before)) };
      }),
      getProgramAccounts: vi.fn().mockImplementation(async () => ({ context: { slot: Math.floor((reads - 1) / 2) * 200 + 120 }, value: assets.map(pubkey => ({ pubkey })) })),
    };
  }
  it('certifies a stable complete collection only through the inventory slot', async () => {
    const assets = [wallet(), wallet()];
    const rpc = inventoryRpc([2, 2], [2, 2], assets);
    expect(await readDeedMintInventory(rpc as unknown as Connection, collection.toBase58())).toMatchObject({ throughSlot: '120', assets: assets.map(key => key.toBase58()) });
    expect(rpc.getAccountInfoAndContext).toHaveBeenNthCalledWith(1, collection, 'finalized');
    expect(rpc.getProgramAccounts).toHaveBeenCalledExactlyOnceWith(core, {
      commitment: 'finalized', withContext: true, minContextSlot: 100,
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.of(Key.AssetV1)) } },
        { memcmp: { offset: 33, bytes: bs58.encode(Buffer.concat([Buffer.from([2]), collection.toBuffer()])) } }],
      dataSlice: { offset: 0, length: 0 },
    });
    expect(rpc.getAccountInfoAndContext).toHaveBeenNthCalledWith(2, collection, { commitment: 'finalized', minContextSlot: 120 });
  });
  it('accepts an empty inventory only when both stable counters are zero', async () => {
    const rpc = inventoryRpc([0, 0], [0, 0], []);
    expect(await readDeedMintInventory(rpc as unknown as Connection, collection.toBase58())).toMatchObject({ throughSlot: '120', assets: [] });
  });
  it('waits for a lagging closing read without lowering its finalized floor or rescanning', async () => {
    vi.useFakeTimers();
    const rpc = inventoryRpc([1, 1], [1, 1], [asset]);
    rpc.getProgramAccounts.mockResolvedValue({ context: { slot: 120 }, value: [{ pubkey: asset }] });
    rpc.getAccountInfoAndContext.mockReset()
      .mockResolvedValueOnce({ context: { slot: 100 }, value: collectionAccount(1, 1) })
      .mockRejectedValueOnce(contextLag()).mockRejectedValueOnce(contextLag())
      .mockResolvedValueOnce({ context: { slot: 150 }, value: collectionAccount(1, 1) });
    const result = readDeedMintInventory(rpc as unknown as Connection, collection.toBase58());
    await vi.advanceTimersByTimeAsync(399);
    expect(rpc.getAccountInfoAndContext).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.getAccountInfoAndContext).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(800);
    await expect(result).resolves.toMatchObject({ throughSlot: '120', assets: [asset.toBase58()] });
    expect(rpc.getProgramAccounts).toHaveBeenCalledTimes(1);
    for (const call of rpc.getAccountInfoAndContext.mock.calls.slice(1)) {
      expect(call).toEqual([collection, { commitment: 'finalized', minContextSlot: 120 }]);
    }
  });
  it('retries a lagging inventory read with the same filters and floor before checking collection counters', async () => {
    vi.useFakeTimers();
    const rpc = inventoryRpc([1, 1], [1, 1], [asset]);
    rpc.getProgramAccounts.mockRejectedValueOnce(contextLag());
    const result = readDeedMintInventory(rpc as unknown as Connection, collection.toBase58());
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ throughSlot: '120' });
    expect(rpc.getProgramAccounts).toHaveBeenCalledTimes(2);
    expect(rpc.getProgramAccounts.mock.calls[1]).toEqual(rpc.getProgramAccounts.mock.calls[0]);
    expect(rpc.getProgramAccounts.mock.calls[1]?.[1]).toMatchObject({ commitment: 'finalized', minContextSlot: 100 });
    expect(rpc.getAccountInfoAndContext).toHaveBeenCalledTimes(2);
  });
  it('bounds repeated context lag without returning an unchecked receipt', async () => {
    vi.useFakeTimers();
    const rpc = inventoryRpc([1, 1], [1, 1], [asset]), error = contextLag();
    rpc.getProgramAccounts.mockResolvedValue({ context: { slot: 120 }, value: [{ pubkey: asset }] });
    rpc.getAccountInfoAndContext.mockReset()
      .mockResolvedValueOnce({ context: { slot: 100 }, value: collectionAccount(1, 1) })
      .mockImplementation(async () => { throw error; });
    const assertion = expect(readDeedMintInventory(rpc as unknown as Connection, collection.toBase58())).rejects.toMatchObject({ diagnostics: { reason: 'context_lag', attempts: MINT_INVENTORY.maxScanAttempts } });
    const start = Date.now();
    await vi.runAllTimersAsync(); await assertion;
    expect(Date.now() - start).toBeLessThan(MINT_INVENTORY.scanDeadlineMs);
    expect(rpc.getAccountInfoAndContext).toHaveBeenCalledTimes(7);
    expect(rpc.getProgramAccounts).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    { error: new SolanaJSONRPCError({ code: -32005, message: 'Node is unhealthy' }), attempts: 3, reason: 'rpc_unavailable' },
    { error: new SolanaJSONRPCError({ code: -32602, message: 'Invalid params' }), attempts: 1, reason: 'rpc_error' },
    { error: new Error('Minimum context slot has not been reached'), attempts: 1, reason: 'rpc_error' },
  ])('classifies errors without retrying untyped matching messages', async ({ error, attempts, reason }) => {
    vi.useFakeTimers();
    const rpc = inventoryRpc([1, 1], [1, 1], [asset]);
    rpc.getProgramAccounts.mockRejectedValue(error);
    const assertion = expect(readDeedMintInventory(rpc as unknown as Connection, collection.toBase58())).rejects.toMatchObject({ diagnostics: { reason, attempts } });
    await vi.runAllTimersAsync(); await assertion;
    expect(rpc.getProgramAccounts).toHaveBeenCalledTimes(attempts);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('restarts all finalized reads after a typed generic server failure instead of discarding healthy evidence', async () => {
    vi.useFakeTimers();
    const second = wallet();
    const rpc = inventoryRpc([1, 1], [1, 1], [asset]);
    rpc.getAccountInfoAndContext.mockReset()
      .mockResolvedValueOnce({ context: { slot: 100 }, value: collectionAccount(1, 1) })
      .mockResolvedValueOnce({ context: { slot: 200 }, value: collectionAccount(2, 2) })
      .mockResolvedValueOnce({ context: { slot: 250 }, value: collectionAccount(2, 2) });
    rpc.getProgramAccounts.mockReset()
      .mockRejectedValueOnce(new SolanaJSONRPCError({ code: -32000, message: 'server error' }))
      .mockResolvedValueOnce({ context: { slot: 220 }, value: [{ pubkey: asset }, { pubkey: second }] });
    const result = readDeedMintInventory(rpc as unknown as Connection, collection.toBase58()).catch(error => error);
    await vi.runAllTimersAsync();
    const receipt = await result;
    expect(receipt).not.toBeInstanceOf(DeedMintInventoryError);
    expect(receipt).toMatchObject({ throughSlot: '220', assets: [asset.toBase58(), second.toBase58()],
      diagnostics: { attempts: 2, beforeSize: 2, afterSize: 2, assetCount: 2, contextRetries: 0 } });
    expect(rpc.getAccountInfoAndContext).toHaveBeenCalledTimes(3);
    expect(rpc.getProgramAccounts).toHaveBeenCalledTimes(2);
    // Restart from the collection, preserving the prior finalized floor. The
    // failed attempt's counter must not be combined with the recovered inventory.
    expect(rpc.getAccountInfoAndContext).toHaveBeenNthCalledWith(2, collection, { commitment: 'finalized', minContextSlot: 100 });
    expect(rpc.getProgramAccounts.mock.calls[1]?.[1]).toMatchObject({ commitment: 'finalized', minContextSlot: 200 });
    expect(rpc.getAccountInfoAndContext).toHaveBeenNthCalledWith(3, collection, { commitment: 'finalized', minContextSlot: 220 });
    const order = [rpc.getAccountInfoAndContext.mock.invocationCallOrder[0]!, rpc.getProgramAccounts.mock.invocationCallOrder[0]!,
      rpc.getAccountInfoAndContext.mock.invocationCallOrder[1]!, rpc.getProgramAccounts.mock.invocationCallOrder[1]!,
      rpc.getAccountInfoAndContext.mock.invocationCallOrder[2]!];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds persistent typed generic server failures and retains only their numeric diagnostic', async () => {
    vi.useFakeTimers();
    const rpc = inventoryRpc([1, 1], [1, 1], [asset]);
    rpc.getProgramAccounts.mockRejectedValue(new SolanaJSONRPCError({ code: -32000,
      message: 'https://rpc.invalid/?token=private signed-body-secret', data: { token: 'private' } }));
    const result = readDeedMintInventory(rpc as unknown as Connection, collection.toBase58()).catch(error => error);
    const start = Date.now();
    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).toBeInstanceOf(DeedMintInventoryError);
    expect(error.diagnostics).toMatchObject({ reason: 'upstream_unknown', stage: 'assets', rpcCode: -32000,
      attempts: MINT_INVENTORY.maxScanAttempts });
    expect(rpc.getAccountInfoAndContext).toHaveBeenCalledTimes(MINT_INVENTORY.maxScanAttempts);
    expect(rpc.getProgramAccounts).toHaveBeenCalledTimes(MINT_INVENTORY.maxScanAttempts);
    expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toMatch(/private|signed-body|rpc.invalid/);
    expect(Date.now() - start).toBeLessThan(MINT_INVENTORY.scanDeadlineMs);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('restarts the entire scan when a genuine mint changes counters after a context retry', async () => {
    vi.useFakeTimers();
    const second = wallet();
    const rpc = inventoryRpc([1, 1], [2, 2], [asset]);
    rpc.getProgramAccounts.mockResolvedValue({ context: { slot: 120 }, value: [{ pubkey: asset }] });
    rpc.getAccountInfoAndContext.mockReset()
      .mockResolvedValueOnce({ context: { slot: 100 }, value: collectionAccount(1, 1) })
      .mockRejectedValueOnce(contextLag())
      .mockResolvedValueOnce({ context: { slot: 150 }, value: collectionAccount(2, 2) })
      .mockResolvedValueOnce({ context: { slot: 200 }, value: collectionAccount(2, 2) })
      .mockResolvedValueOnce({ context: { slot: 250 }, value: collectionAccount(2, 2) });
    rpc.getProgramAccounts.mockReset()
      .mockResolvedValueOnce({ context: { slot: 120 }, value: [{ pubkey: asset }] })
      .mockResolvedValueOnce({ context: { slot: 220 }, value: [{ pubkey: asset }, { pubkey: second }] });
    const result = readDeedMintInventory(rpc as unknown as Connection, collection.toBase58());
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ throughSlot: '220', assets: [asset.toBase58(), second.toBase58()], diagnostics: { attempts: 2, contextRetries: 1 } });
    expect(rpc.getAccountInfoAndContext.mock.calls[3]?.[1]).toEqual({ commitment: 'finalized', minContextSlot: 150 });
    expect(rpc.getProgramAccounts).toHaveBeenCalledTimes(2);
  });
  it.each([
    { reason: 'missing RPC assets', before: [3, 3], after: [3, 3], count: 2 },
    { reason: 'burned or removed original deeds', before: [3, 2], after: [3, 2], count: 2 },
    { reason: 'imported assets without collection mint evidence', before: [2, 3], after: [2, 3], count: 3 },
    { reason: 'all previously minted deeds missing', before: [1, 0], after: [1, 0], count: 0 },
    { reason: 'mint counter changed during the scan', before: [2, 2], after: [3, 2], count: 2 },
    { reason: 'current size changed during the scan', before: [2, 2], after: [2, 1], count: 2 },
    { reason: 'new mint during the scan', before: [2, 2], after: [3, 3], count: 3 },
  ])('withholds a completeness receipt for $reason', async ({ before, after, count }) => {
    vi.useFakeTimers();
    const rpc = inventoryRpc(before as [number, number], after as [number, number], Array.from({ length: count }, wallet));
    const changed = before[0] !== after[0] || before[1] !== after[1];
    const assertion = expect(readDeedMintInventory(rpc as unknown as Connection, collection.toBase58())).rejects.toMatchObject({ diagnostics: { reason: changed ? 'collection_changed' : 'inventory_incomplete', attempts: changed ? 3 : 1 } });
    await vi.runAllTimersAsync(); await assertion;
  });
  it('withholds a receipt when the collection disappears before the closing check', async () => {
    const rpc = inventoryRpc([1, 1], [1, 1], [asset]);
    rpc.getProgramAccounts.mockResolvedValue({ context: { slot: 120 }, value: [{ pubkey: asset }] });
    rpc.getAccountInfoAndContext.mockReset()
      .mockResolvedValueOnce({ context: { slot: 100 }, value: collectionAccount(1, 1) })
      .mockResolvedValueOnce({ context: { slot: 150 }, value: null });
    await expect(readDeedMintInventory(rpc as unknown as Connection, collection.toBase58())).rejects.toMatchObject({ diagnostics: { reason: 'collection_unavailable' } });
  });
  it('aborts actual transport at the shared deadline and ignores a late result', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined, finish: (() => void) | undefined;
    const rpc = inventoryRpc([1, 1], [1, 1], [asset]);
    rpc.getAccountInfoAndContext.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ context: { slot: 100 }, value: collectionAccount(1, 1) });
    }));
    const result = readDeedMintInventory(s => { signal = s; return rpc as unknown as Connection; }, collection.toBase58());
    const assertion = expect(result).rejects.toMatchObject({ diagnostics: { reason: 'deadline', attempts: 1, attemptLog: [{ attempt: 1, stage: 'collection_before', reason: 'deadline', durationMs: MINT_INVENTORY.scanDeadlineMs }] } });
    await vi.advanceTimersByTimeAsync(MINT_INVENTORY.scanDeadlineMs); await assertion;
    expect(signal?.aborted).toBe(true);
    finish!(); await vi.runAllTimersAsync();
    expect(rpc.getProgramAccounts).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([429, 503])('bounds HTTP %s retries and retains only safe status', async status => {
    vi.useFakeTimers();
    const rpc = inventoryRpc([1, 1], [1, 1], [asset]);
    rpc.getAccountInfoAndContext.mockRejectedValue(new DeedMintTransportError(status));
    const assertion = expect(readDeedMintInventory(rpc as unknown as Connection, collection.toBase58())).rejects.toMatchObject({ diagnostics: { httpStatus: status, attempts: 3 } });
    await vi.runAllTimersAsync(); await assertion;
    expect(rpc.getAccountInfoAndContext).toHaveBeenCalledTimes(3);
  });
  it('does not leak an unknown error URL, token or body into diagnostics', async () => {
    const rpc = inventoryRpc([1, 1], [1, 1], [asset]);
    rpc.getProgramAccounts.mockRejectedValue(new Error('https://rpc.invalid/?token=private signed-body-secret'));
    const error = await readDeedMintInventory(rpc as unknown as Connection, collection.toBase58()).catch(e => e);
    expect(error).toBeInstanceOf(DeedMintInventoryError);
    expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toMatch(/private|signed-body|rpc.invalid/);
    expect(error.diagnostics).toMatchObject({ reason: 'rpc_error', stage: 'assets', attempts: 1 });
  });

  it('cancels the production Connection HTTP request at the shared deadline', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      requestSignal = init.signal as AbortSignal;
      requestSignal.addEventListener('abort', () => reject(requestSignal!.reason), { once: true });
    })));
    const assertion = expect(readDeedMintInventory(signal => makeDeedMintInventoryConnection('https://rpc.invalid/?token=private', signal), collection.toBase58()))
      .rejects.toMatchObject({ diagnostics: { reason: 'deadline', attempts: 1, attemptLog: [{ attempt: 1, stage: 'collection_before', reason: 'deadline', durationMs: MINT_INVENTORY.scanDeadlineMs }] } });
    await vi.advanceTimersByTimeAsync(MINT_INVENTORY.scanDeadlineMs); await assertion;
    expect(requestSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('captures HTTP refusal before web3 reads the private response body or retries outside the budget', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private response body', { status: 429 })));
    const errorPromise = readDeedMintInventory(signal => makeDeedMintInventoryConnection('https://rpc.invalid/?token=private', signal), collection.toBase58()).catch(error => error);
    await vi.runAllTimersAsync();
    const error = await errorPromise;
    expect(error.diagnostics).toMatchObject({ reason: 'rpc_rate_limit', httpStatus: 429, attempts: 3 });
    expect(fetch).toHaveBeenCalledTimes(MINT_INVENTORY.maxScanAttempts);
    expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toContain('private');
  });

  it('retains a bounded record of mixed failures and the successful attempt without mixing chain evidence', async () => {
    vi.useFakeTimers();
    const rpc = inventoryRpc([1, 1], [1, 1], [asset]);
    rpc.getAccountInfoAndContext.mockReset()
      .mockRejectedValueOnce(new DeedMintTransportError(429))
      .mockResolvedValueOnce({ context: { slot: 100 }, value: collectionAccount(1, 1) })
      .mockResolvedValueOnce({ context: { slot: 120 }, value: collectionAccount(1, 1) })
      .mockResolvedValueOnce({ context: { slot: 140 }, value: collectionAccount(1, 1) });
    rpc.getProgramAccounts.mockReset()
      .mockRejectedValueOnce(new SolanaJSONRPCError({ code: -32000, message: 'PRIVATE_UPSTREAM_DATA' }))
      .mockResolvedValueOnce({ context: { slot: 130 }, value: [{ pubkey: asset }] });
    const pending = readDeedMintInventory(rpc as unknown as Connection, collection.toBase58());
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.diagnostics.attemptLog).toEqual([
      { attempt: 1, stage: 'collection_before', durationMs: 0, reason: 'rpc_rate_limit', httpStatus: 429 },
      { attempt: 2, stage: 'assets', durationMs: 0, reason: 'upstream_unknown', rpcCode: -32000, requestedContextSlot: 100 },
      { attempt: 3, stage: 'collection_after', durationMs: 0, reason: 'complete', requestedContextSlot: 130, returnedContextSlot: 140 },
    ]);
    expect(result.throughSlot).toBe('130');
    expect(JSON.stringify(result.diagnostics)).not.toContain('PRIVATE');
  });

});
