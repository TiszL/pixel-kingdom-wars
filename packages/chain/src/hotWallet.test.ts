import { TOKEN } from '@shardkeep/shared';
import { Keypair, PublicKey, Transaction, type Connection } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import {
  makeHotWalletKeepSender,
  makeRemotePolicyKeepSender,
  PolicySignerRequestRefusedError,
  PolicySignerUnavailableError,
  prepareKeepWithdrawalWithKeypair,
  serializePreparedKeepWithdrawal,
  validatePreparedKeepWithdrawal,
} from './hotWallet';

const blockhash = Keypair.generate().publicKey.toBase58();

function preparation(
  withdrawalId: string,
  destination: string,
  netAmountKeep: bigint,
  grossAmountKeep = netAmountKeep,
) {
  return {
    withdrawalId,
    playerWallet: Keypair.generate().publicKey.toBase58(),
    destination,
    grossAmountKeep,
    netAmountKeep,
    authorizationDigest: 'a'.repeat(64),
    walletRolling24hCapKeep: grossAmountKeep,
  };
}

function rpc(source: string, overrides: Record<string, unknown> = {}): Connection {
  return {
    rpcEndpoint: source,
    getLatestBlockhash: vi.fn(async () => ({ blockhash, lastValidBlockHeight: 100 })),
    sendRawTransaction: vi.fn(async (bytes: Buffer | Uint8Array) => {
      const tx = Transaction.from(Buffer.from(bytes));
      if (!tx.signature) throw new Error('missing signature');
      const { default: bs58 } = await import('bs58');
      return bs58.encode(tx.signature);
    }),
    getSignatureStatuses: vi.fn(async () => ({ value: [null] })),
    getTransaction: vi.fn(async () => null),
    getBlockHeight: vi.fn(async () => 50),
    ...overrides,
  } as unknown as Connection;
}

describe('durable hot-wallet withdrawal transport', () => {
  it('signs without broadcasting, embeds the withdrawal UUID, and rebroadcasts identical bytes', async () => {
    const primary = rpc('https://primary.test');
    const secondary = rpc('https://secondary.test');
    const sender = makeHotWalletKeepSender(
      primary, Keypair.generate(), Keypair.generate().publicKey,
      [{ source: 'secondary.test', connection: secondary }],
    );
    const id = 'a0000000-0000-4000-8000-000000000001';
    const destination = Keypair.generate().publicKey.toBase58();
    const prepared = await sender.prepare(preparation(id, destination, 4_900n, 5_000n));

    expect(primary.sendRawTransaction).not.toHaveBeenCalled();
    expect(prepared.transfer).toMatchObject({
      withdrawalId: id,
      destinationOwner: destination,
      amountKeep: '4900',
      amountBaseUnits: (4_900n * 10n ** BigInt(TOKEN.decimals)).toString(),
      memo: `SHARDKEEP withdrawal ${id}`,
    });
    expect(() => validatePreparedKeepWithdrawal(prepared)).not.toThrow();

    await sender.broadcast(prepared);
    await sender.broadcast(prepared);
    const sent = vi.mocked(primary.sendRawTransaction).mock.calls;
    const secondarySent = vi.mocked(secondary.sendRawTransaction).mock.calls;
    expect(Buffer.from(sent[0]![0] as Uint8Array)).toEqual(Buffer.from(prepared.transactionBytes));
    expect(Buffer.from(sent[1]![0] as Uint8Array)).toEqual(Buffer.from(prepared.transactionBytes));
    expect(Buffer.from(secondarySent[0]![0] as Uint8Array)).toEqual(Buffer.from(prepared.transactionBytes));
    expect(Buffer.from(secondarySent[1]![0] as Uint8Array)).toEqual(Buffer.from(prepared.transactionBytes));
  });

  it('succeeds when either RPC accepts the exact persisted bytes', async () => {
    const primary = rpc('https://primary.test', {
      sendRawTransaction: vi.fn(async () => { throw new Error('primary unavailable'); }),
    });
    const secondary = rpc('https://secondary.test');
    const sender = makeHotWalletKeepSender(
      primary, Keypair.generate(), Keypair.generate().publicKey,
      [{ source: 'secondary.test', connection: secondary }],
    );
    const prepared = await sender.prepare(preparation(
      'a0000000-0000-4000-8000-000000000005', Keypair.generate().publicKey.toBase58(), 490n, 500n,
    ));

    await expect(sender.broadcast(prepared)).resolves.toBe(prepared.signature);
    expect(primary.sendRawTransaction).toHaveBeenCalledOnce();
    expect(secondary.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it('does not call one expired endpoint proof definitive', async () => {
    const primary = rpc('https://primary.test', { getBlockHeight: vi.fn(async () => 101) });
    const unavailable = rpc('https://secondary.test', {
      getSignatureStatuses: vi.fn(async () => { throw new Error('secondary down'); }),
    });
    const sender = makeHotWalletKeepSender(
      primary, Keypair.generate(), new PublicKey(Keypair.generate().publicKey),
      [{ source: 'secondary.test', connection: unavailable }],
    );
    const prepared = await sender.prepare(preparation(
      'a0000000-0000-4000-8000-000000000002', Keypair.generate().publicKey.toBase58(), 490n, 500n,
    ));
    await expect(sender.reconcile(prepared)).resolves.toMatchObject({
      status: 'pending', expired: true,
    });
  });

  it('holds two expired non-archival null observations as unresolved', async () => {
    const primary = rpc('https://primary.test', { getBlockHeight: vi.fn(async () => 101) });
    const secondary = rpc('https://secondary.test', { getBlockHeight: vi.fn(async () => 102) });
    const sender = makeHotWalletKeepSender(
      primary, Keypair.generate(), Keypair.generate().publicKey,
      [{ source: 'secondary.test', connection: secondary }],
    );
    const prepared = await sender.prepare(preparation(
      'a0000000-0000-4000-8000-000000000003', Keypair.generate().publicKey.toBase58(), 490n, 500n,
    ));
    await expect(sender.reconcile(prepared)).resolves.toEqual({
      status: 'expired_unresolved', sources: ['primary.test', 'secondary.test'],
    });
  });

  it('does not let one RPC make a signed payout refundable', async () => {
    const primary = rpc('https://primary.test', {
      getSignatureStatuses: vi.fn(async () => ({
        value: [{ confirmationStatus: 'finalized', err: { InstructionError: [1, 'Custom'] } }],
      })),
    });
    const secondary = rpc('https://secondary.test', {
      getSignatureStatuses: vi.fn(async () => { throw new Error('secondary unavailable'); }),
    });
    const sender = makeHotWalletKeepSender(
      primary, Keypair.generate(), Keypair.generate().publicKey,
      [{ source: 'secondary.test', connection: secondary }],
    );
    const prepared = await sender.prepare(preparation(
      'a0000000-0000-4000-8000-000000000004', Keypair.generate().publicKey.toBase58(), 490n, 500n,
    ));
    await expect(sender.reconcile(prepared)).resolves.toMatchObject({
      status: 'pending', expired: false,
    });
  });

  it('requires two independent finalized error observations', async () => {
    const finalizedError = vi.fn(async () => ({
      value: [{ confirmationStatus: 'finalized', err: { InstructionError: [1, 'Custom'] } }],
    }));
    const primary = rpc('https://primary.test', { getSignatureStatuses: finalizedError });
    const secondary = rpc('https://secondary.test', { getSignatureStatuses: finalizedError });
    const sender = makeHotWalletKeepSender(
      primary, Keypair.generate(), Keypair.generate().publicKey,
      [{ source: 'secondary.test', connection: secondary }],
    );
    const prepared = await sender.prepare(preparation(
      'a0000000-0000-4000-8000-000000000006', Keypair.generate().publicKey.toBase58(), 490n, 500n,
    ));
    await expect(sender.reconcile(prepared)).resolves.toMatchObject({
      status: 'finalized_error', source: 'primary.test',
    });
  });

  it('requires two independent finalized success observations when two RPCs are configured', async () => {
    const primary = rpc('https://primary.test', {
      getSignatureStatuses: vi.fn(async () => ({
        value: [{ confirmationStatus: 'finalized', err: null }],
      })),
    });
    const secondary = rpc('https://secondary.test', {
      getSignatureStatuses: vi.fn(async () => { throw new Error('secondary unavailable'); }),
    });
    const sender = makeHotWalletKeepSender(
      primary, Keypair.generate(), Keypair.generate().publicKey,
      [{ source: 'secondary.test', connection: secondary }],
    );
    const prepared = await sender.prepare(preparation(
      'a0000000-0000-4000-8000-000000000007', Keypair.generate().publicKey.toBase58(), 490n, 500n,
    ));

    await expect(sender.reconcile(prepared)).resolves.toMatchObject({
      status: 'pending', expired: false,
    });
  });

  it('falls back to a healthy secondary RPC for the finalized blockhash', async () => {
    const primary = rpc('https://primary.test', {
      getLatestBlockhash: vi.fn(async () => { throw new Error('primary unavailable'); }),
    });
    const secondary = rpc('https://secondary.test');
    const sender = makeHotWalletKeepSender(
      primary, Keypair.generate(), Keypair.generate().publicKey,
      [{ source: 'secondary.test', connection: secondary }],
    );

    await expect(sender.prepare(preparation(
      'a0000000-0000-4000-8000-000000000008', Keypair.generate().publicKey.toBase58(), 490n, 500n,
    ))).resolves.toMatchObject({ recentBlockhash: blockhash });
    expect(secondary.getLatestBlockhash).toHaveBeenCalledOnce();
  });
});

describe('remote withdrawal policy signer client', () => {
  it('sends policy context privately and validates the returned signed artifact', async () => {
    const connection = rpc('https://primary.test');
    const hotWallet = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const local = makeHotWalletKeepSender(connection, hotWallet, mint);
    const request = preparation(
      'a0000000-0000-4000-8000-000000000009',
      Keypair.generate().publicKey.toBase58(),
      980n,
      1_000n,
    );
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${'t'.repeat(32)}` });
      const wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(wire).toMatchObject({
        withdrawalId: request.withdrawalId,
        playerWallet: request.playerWallet,
        grossAmountKeep: '1000',
        netAmountKeep: '980',
        authorizationDigest: request.authorizationDigest,
        walletRolling24hCapKeep: '1000',
        cluster: 'devnet',
        mint: mint.toBase58(),
        sourceOwner: hotWallet.publicKey.toBase58(),
      });
      return new Response(JSON.stringify(serializePreparedKeepWithdrawal(
        await local.prepare(request),
      )), { status: 200 });
    });
    const remote = makeRemotePolicyKeepSender(connection, {
      endpoint: 'http://withdrawal-signer:3003',
      authToken: 't'.repeat(32),
      cluster: 'devnet',
      sourceOwner: hotWallet.publicKey,
      keepMint: mint,
      fetch: fetchMock,
    });

    const prepared = await remote.prepare(request);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(prepared.transfer).toMatchObject({
      withdrawalId: request.withdrawalId,
      destinationOwner: request.destination,
      amountKeep: '980',
      mint: mint.toBase58(),
      feePayer: hotWallet.publicKey.toBase58(),
    });
  });

  it('rejects a valid signature for a different destination before persistence or broadcast', async () => {
    const connection = rpc('https://primary.test');
    const hotWallet = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const local = makeHotWalletKeepSender(connection, hotWallet, mint);
    const request = preparation(
      'a0000000-0000-4000-8000-000000000010',
      Keypair.generate().publicKey.toBase58(),
      980n,
      1_000n,
    );
    const wrong = { ...request, destination: Keypair.generate().publicKey.toBase58() };
    const remote = makeRemotePolicyKeepSender(connection, {
      endpoint: 'http://withdrawal-signer:3003',
      authToken: 't'.repeat(32),
      cluster: 'devnet',
      sourceOwner: hotWallet.publicKey,
      keepMint: mint,
      fetch: async () => new Response(JSON.stringify(serializePreparedKeepWithdrawal(
        await local.prepare(wrong),
      )), { status: 200 }),
    });

    await expect(remote.prepare(request)).rejects.toThrow(/destination owner mismatch/);
  });

  it('fails closed on refusal, malformed JSON, and oversized responses', async () => {
    const connection = rpc('https://primary.test');
    const hotWallet = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const request = preparation(
      'a0000000-0000-4000-8000-000000000011',
      Keypair.generate().publicKey.toBase58(), 490n, 500n,
    );
    const options = {
      endpoint: 'http://withdrawal-signer:3003', authToken: 't'.repeat(32),
      cluster: 'devnet' as const, sourceOwner: hotWallet.publicKey, keepMint: mint,
    };
    const refused = makeRemotePolicyKeepSender(connection, {
      ...options, fetch: async () => new Response('{}', { status: 422 }),
    }).prepare(request);
    await expect(refused).rejects.toBeInstanceOf(PolicySignerRequestRefusedError);
    await refused.catch((error: PolicySignerRequestRefusedError) => expect(error.retryable).toBe(false));
    const unavailable = makeRemotePolicyKeepSender(connection, {
      ...options, fetch: async () => new Response('{}', { status: 503 }),
    }).prepare(request);
    await expect(unavailable).rejects.toBeInstanceOf(PolicySignerUnavailableError);
    await unavailable.catch((error: PolicySignerUnavailableError) => expect(error.retryable).toBe(true));
    await expect(makeRemotePolicyKeepSender(connection, {
      ...options, fetch: async () => new Response('not-json', { status: 200 }),
    }).prepare(request)).rejects.toThrow(/invalid JSON/);
    await expect(makeRemotePolicyKeepSender(connection, {
      ...options, fetch: async () => new Response('x'.repeat(100_001), { status: 200 }),
    }).prepare(request)).rejects.toThrow(/response is too large/);
    await expect(makeRemotePolicyKeepSender(connection, {
      ...options,
      fetch: async () => new Response('{}', {
        status: 200, headers: { 'content-length': '100001' },
      }),
    }).prepare(request)).rejects.toThrow(/response is too large/);
  });

  it('accepts the signer\'s older exact artifact when the first response was lost', async () => {
    const newest = Keypair.generate().publicKey.toBase58();
    const connection = rpc('https://primary.test', {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: newest, lastValidBlockHeight: 999 })),
    });
    const hotWallet = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const request = preparation(
      'a0000000-0000-4000-8000-000000000012', Keypair.generate().publicKey.toBase58(), 980n, 1_000n,
    );
    const older = prepareKeepWithdrawalWithKeypair(request, hotWallet, mint, {
      blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100,
    });
    const remote = makeRemotePolicyKeepSender(connection, {
      endpoint: 'http://withdrawal-signer:3003', authToken: 't'.repeat(32), cluster: 'devnet',
      sourceOwner: hotWallet.publicKey, keepMint: mint,
      fetch: async () => new Response(JSON.stringify(serializePreparedKeepWithdrawal(older))),
    });
    await expect(remote.prepare(request)).resolves.toMatchObject({
      signature: older.signature, recentBlockhash: older.recentBlockhash,
    });
  });

  it('keeps the request deadline active while a response body is stalled', async () => {
    vi.useFakeTimers();
    try {
      const connection = rpc('https://primary.test');
      const hotWallet = Keypair.generate();
      const mint = Keypair.generate().publicKey;
      const request = preparation(
        'a0000000-0000-4000-8000-000000000013', Keypair.generate().publicKey.toBase58(), 980n, 1_000n,
      );
      const remote = makeRemotePolicyKeepSender(connection, {
        endpoint: 'http://withdrawal-signer:3003', authToken: 't'.repeat(32), cluster: 'devnet',
        sourceOwner: hotWallet.publicKey, keepMint: mint, requestTimeoutMs: 1_000,
        fetch: async (_input, init) => new Response(new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
          },
        })),
      });
      const pending = expect(remote.prepare(request)).rejects.toBeInstanceOf(
        PolicySignerUnavailableError,
      );
      await vi.advanceTimersByTimeAsync(1_001);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});
