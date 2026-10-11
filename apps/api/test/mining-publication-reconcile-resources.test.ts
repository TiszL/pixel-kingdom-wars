/** Pure dispatch/recovery tests; actual SQL custody and finality remain in the queued integration suites. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { Db } from '../src/db/client';
import type { MiningPublicationOutbox } from '../src/mining/publicationOutbox';
const mock = vi.hoisted(() => ({
  enabled: vi.fn(), get: vi.fn(), admitBroadcast: vi.fn(),
  ingots: vi.fn(), resources: vi.fn(), ingotFactory: vi.fn(), resourceFactory: vi.fn(),
}));
vi.mock('../src/config', () => ({ phaseEMiningEnabled: mock.enabled }));
vi.mock('../src/mining/publicationOutbox', () => ({
  createMiningPublicationOutbox: () => ({ get: mock.get, admitBroadcast: mock.admitBroadcast }),
}));
vi.mock('../src/mining/publicationSettlement', () => ({
  createMiningPublicationSettlement: mock.ingotFactory,
  createResourceMiningPublicationSettlement: mock.resourceFactory,
}));
import { createMiningPublicationReconciler, type MiningPublicationTransport } from '../src/mining/publicationReconcile';

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const trust = {
  programId: key(1), keepMint: key(2), reserveOwner: key(3),
  expectedGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1', reviewedDeploymentSlot: 10,
  reviewedProgramDataSha256: 'a'.repeat(64),
};
const request = { epochId: '00000000-0000-4000-8000-000000000001', attemptKey: 'original-resource-1' };
const signature = 's'.repeat(64), originalWire = Uint8Array.from([1, 17, 64, 255]);
const original: MiningPublicationOutbox = {
  ...request, genesisHash: trust.expectedGenesisHash, programId: trust.programId.toBase58(),
  configAddress: key(4).toBase58(), sequence: '1', signer: key(5).toBase58(),
  intentHex: '0011', intentSha256: 'a'.repeat(64), blockhashContextSlot: 20,
  lastValidBlockHeight: 120, backing: { slot: 21 }, reservedAt: '2026-10-03T00:00:00Z',
  signingAuthorized: false, signed: { signature, signedTransactionHex: Buffer.from(originalWire).toString('hex'),
    wireSha256: 'b'.repeat(64), messageSha256: 'a'.repeat(64), acceptedAt: '2026-10-03T00:00:01Z' },
};
const contributions = [{ id: 'original-basket', baseId: 'original-base', actorWallet: key(6).toBase58(),
  totalValue: '12', outcome: 'consumed', lines: [{ resourceId: 'wood', quantity: '3', unitValue: '4', value: '12' }] }];
const resourceSettlement = Object.freeze({ epochId: request.epochId, signature, messageSha256: 'a'.repeat(64),
  wireSha256: 'b'.repeat(64), receipt: { finalizedSlot: 25 }, finalizedAt: '2026-10-03T00:00:02Z', contributions });
let storedDomain: 'ingots' | 'resources', finalized: boolean;
let rpc: {
  getGenesisHash: ReturnType<typeof vi.fn<MiningPublicationTransport['getGenesisHash']>>;
  getSignatureStatuses: ReturnType<typeof vi.fn<MiningPublicationTransport['getSignatureStatuses']>>;
  getBlockHeight: ReturnType<typeof vi.fn<MiningPublicationTransport['getBlockHeight']>>;
  sendRawTransaction: ReturnType<typeof vi.fn<MiningPublicationTransport['sendRawTransaction']>>;
};
const sources = (domain?: 'ingots' | 'resources') => ({
  backing: { reader: {} as never, trust }, settlement: { reader: {} as never, trust },
  transport: () => rpc, ...(domain === undefined ? {} : { domain }),
});
const db = {} as Db;
beforeEach(() => {
  vi.resetAllMocks(); storedDomain = 'resources'; finalized = false;
  mock.enabled.mockReturnValue(true); mock.get.mockResolvedValue(original);
  mock.admitBroadcast.mockResolvedValue({ outbox: original, signedTransaction: originalWire, signature, backing: { slot: 22 } });
  mock.ingotFactory.mockReturnValue(mock.ingots); mock.resourceFactory.mockReturnValue(mock.resources);
  const settle = (domain: 'ingots' | 'resources') => async () => {
    if (storedDomain !== domain) throw { code: 'NOT_PREPARED' };
    if (!finalized) throw { code: 'RECEIPT_UNAVAILABLE' };
    return domain === 'resources' ? resourceSettlement : { ...resourceSettlement, contributions: undefined, dispositions: [] };
  };
  mock.ingots.mockImplementation(settle('ingots')); mock.resources.mockImplementation(settle('resources'));
  rpc = {
    getGenesisHash: vi.fn<MiningPublicationTransport['getGenesisHash']>(async () => trust.expectedGenesisHash),
    getSignatureStatuses: vi.fn<MiningPublicationTransport['getSignatureStatuses']>(async () => ({ context: { slot: 24 }, value: [null] })),
    getBlockHeight: vi.fn<MiningPublicationTransport['getBlockHeight']>(async () => 100),
    sendRawTransaction: vi.fn<MiningPublicationTransport['sendRawTransaction']>(async () => signature),
  };
});

describe('resource mining publication reconciliation domain', () => {
  it('R1 defaults to ingots and holds a resource original before admission or send', async () => {
    expect(await createMiningPublicationReconciler(db, sources())(request)).toMatchObject({ status: 'held', reason: 'SETTLEMENT_HELD', signature });
    expect(mock.ingotFactory).toHaveBeenCalledOnce(); expect(mock.resourceFactory).not.toHaveBeenCalled();
    expect(mock.admitBroadcast).not.toHaveBeenCalled(); expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('R2 explicitly selects resources and submits only the saved original wire', async () => {
    const result = await createMiningPublicationReconciler(db, sources('resources'))(request);
    expect(result).toEqual({ status: 'submitted', epochId: request.epochId, signature,
      wireSha256: original.signed!.wireSha256, publicationFinalized: false });
    expect(mock.resourceFactory).toHaveBeenCalledOnce(); expect(mock.ingotFactory).not.toHaveBeenCalled();
    expect(mock.resources).toHaveBeenCalledWith({ ...request, signature, signedTransaction: Buffer.from(originalWire) });
    expect(mock.admitBroadcast).toHaveBeenCalledWith(request);
    expect(rpc.sendRawTransaction).toHaveBeenCalledExactlyOnceWith(originalWire,
      { skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0, minContextSlot: 22 });
  });
  it('R3 returns the resource settlement unchanged and delegates replay of the same original', async () => {
    finalized = true;
    const step = createMiningPublicationReconciler(db, sources('resources'));
    for (let n = 0; n < 2; n++) {
      const result = await step(request);
      expect(result.status).toBe('settled');
      if (result.status === 'settled') expect(result.settlement).toBe(resourceSettlement);
    }
    expect(mock.resources).toHaveBeenCalledTimes(2);
    for (const call of mock.resources.mock.calls) expect(call[0]).toEqual({ ...request, signature, signedTransaction: Buffer.from(originalWire) });
    expect(resourceSettlement.contributions).toEqual(contributions);
    expect(mock.admitBroadcast).not.toHaveBeenCalled(); expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('R4 holds an ingot original under the resource selector without falling back', async () => {
    storedDomain = 'ingots';
    expect(await createMiningPublicationReconciler(db, sources('resources'))(request)).toMatchObject({ status: 'held', reason: 'SETTLEMENT_HELD', signature });
    expect(mock.resourceFactory).toHaveBeenCalledOnce(); expect(mock.ingotFactory).not.toHaveBeenCalled();
    expect(mock.admitBroadcast).not.toHaveBeenCalled(); expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('R5 pauses resource sends while allowing finalized original recovery', async () => {
    mock.enabled.mockReturnValue(false);
    const step = createMiningPublicationReconciler(db, sources('resources'));
    expect(await step(request)).toMatchObject({ status: 'held', reason: 'PAUSED', signature });
    finalized = true;
    expect(await step(request)).toMatchObject({ status: 'settled', signature, settlement: resourceSettlement });
    expect(mock.admitBroadcast).not.toHaveBeenCalled(); expect(rpc.getGenesisHash).not.toHaveBeenCalled();
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('R6 recovers a lost send reply through a fresh instance without sending a replacement', async () => {
    rpc.sendRawTransaction.mockRejectedValueOnce(Error('reply lost after original send'));
    expect(await createMiningPublicationReconciler(db, sources('resources'))(request)).toMatchObject({ status: 'held', reason: 'SEND_UNCERTAIN', signature });
    finalized = true; mock.enabled.mockReturnValue(false);
    expect(await createMiningPublicationReconciler(db, sources('resources'))(request)).toMatchObject({ status: 'settled', signature, settlement: resourceSettlement });
    expect(rpc.sendRawTransaction).toHaveBeenCalledOnce();
    expect(rpc.sendRawTransaction.mock.calls[0]![0]).toEqual(originalWire);
    expect(mock.get).toHaveBeenNthCalledWith(1, request.epochId); expect(mock.get).toHaveBeenNthCalledWith(2, request.epochId);
    expect(mock.resources.mock.calls[1]![0]).toEqual(mock.resources.mock.calls[0]![0]);
  });
  it.each([null, '', 'resource', 'INGOTS', 0, false, []].map(domain => ({ domain })))('R7 rejects invalid application domain $domain synchronously before I/O', ({ domain }) => {
    expect(() => createMiningPublicationReconciler(db, { ...sources(), domain } as never)).toThrow('Invalid mining reconciliation domain');
    expect(mock.get).not.toHaveBeenCalled(); expect(mock.ingotFactory).not.toHaveBeenCalled();
    expect(mock.resourceFactory).not.toHaveBeenCalled(); expect(rpc.getGenesisHash).not.toHaveBeenCalled();
  });
});
