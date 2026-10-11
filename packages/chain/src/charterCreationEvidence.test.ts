import { describe, expect, it, vi } from 'vitest';
import { hashCharterMetadata } from './charterProtocol';
import { createCharterCreationEvidenceReader, type CharterCreationSavedRecord, type CharterCreationEvidenceTrust } from './charterCreationEvidence';
import { fixture, key, sha, clanId, intent } from './testFixtures/charterCreation';

describe('original Charter creation finalized account evidence', () => {
  it('recovers the original active mint without a signature or time-closeable generic receipt', async () => {
    const f = fixture(), result = await f.read()(intent);
    expect(result).toMatchObject({ version: 1, creationIntentId: intent, clanId, payer: f.saved.payer, asset: f.saved.chain.asset,
      admissionCommitment: f.saved.admissionCommitment, permitId: '00'.repeat(16), slot: 150, createdAt: 1_800_000_000n,
      finalizedMintObserved: true, transactionProofVerified: false, paymentAuthorized: false, activationAuthorized: false, reservationReleaseAuthorized: false });
    expect(f.load).toHaveBeenCalledWith(intent);
    expect(f.rpc.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.rpc.getMultipleAccountsInfoAndContext).mock.calls[0]![1]).toEqual({ commitment: 'finalized', minContextSlot: 150 });
    expect(result.source.accounts).toHaveLength(14);
    expect(result.source.programs).toHaveLength(3);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.source.accounts[0])).toBe(true);
  });
  it('keeps completed mint recovery available after pause and later collection mints', async () => {
    const f = fixture(); f.get('craftControl').data[137] = 1;
    const collection = f.get('collection').data; collection.writeUInt32LE(50, collection.length - 8); collection.writeUInt32LE(49, collection.length - 4);
    expect((await f.read()(intent)).creationIntentId).toBe(intent);
  });
  it('refuses missing saved consent and never consults chain for it', async () => {
    const f = fixture(); const connect = vi.fn(() => f.rpc);
    await expect(createCharterCreationEvidenceReader(connect, f.trust, async () => null)(intent)).rejects.toMatchObject({ code: 'RESERVATION', reservationReleaseAuthorized: false });
    expect(connect).not.toHaveBeenCalled();
  });
  it('refuses query aliases and rebound saved original records before RPC', async () => {
    for (const value of [intent.toUpperCase(), intent.slice(0, -1), '0'.repeat(100_000)]) await expect(fixture().read()(value)).rejects.toMatchObject({ code: 'INPUT' });
    const f = fixture(); Object.assign(f.saved, { creationIntentId: '87654321-4321-4321-8abc-def012345679' });
    await expect(f.read()(intent)).rejects.toMatchObject({ code: 'RESERVATION' });
  });
  it('binds every saved canonical address, metadata hash and issued permit inventory', async () => {
    for (const field of Object.keys(fixture().saved.chain) as Array<keyof CharterCreationSavedRecord['chain']>) {
      const f = fixture(); Object.assign(f.saved.chain, { [field]: key(99).toBase58() }); await expect(f.read()(intent)).rejects.toThrow();
    }
    for (const change of [{ admissionCommitment: '00'.repeat(32) }, { issuedPermitIds: [] }, { issuedPermitIds: ['ff'.repeat(16)] },
      { issuedPermitIds: ['00'.repeat(16), '00'.repeat(16)] }, { metadata: { ...fixture().saved.metadata, hash: 'aa'.repeat(32) } }]) {
      const f = fixture(); Object.assign(f.saved, change); await expect(f.read()(intent)).rejects.toThrow();
    }
  });
  it('requires each complete reviewed loader identity in the same finalized bank', async () => {
    for (let i = 0; i < 6; i++) for (const mutation of ['owner', 'executable', 'byte', 'missing']) {
      const f = fixture(), row = f.rows[i]!;
      if (mutation === 'owner') row.owner = key(99);
      if (mutation === 'executable') row.executable = !row.executable;
      if (mutation === 'byte') row.data[row.data.length - 1] = row.data[row.data.length - 1]! ^ 1;
      if (mutation === 'missing') f.rows.splice(i, 1);
      await expect(f.read()(intent)).rejects.toThrow();
    }
  });
  it('rejects malformed deployment policy and retained-state provenance without opening RPC', () => {
    for (const mutate of [(t: CharterCreationEvidenceTrust) => Object.assign(t, { stateProvenance: 'retained-upgrade' }),
      (t: CharterCreationEvidenceTrust) => Object.assign(t.core, { programId: key(99).toBase58() }),
      (t: CharterCreationEvidenceTrust) => Object.assign(t.economy, { reviewedProgramDataSha256: 'AA'.repeat(32) }),
      (t: CharterCreationEvidenceTrust) => Object.assign(t.craft, { reviewedDeploymentSlot: -1 })]) {
      const f = fixture(); mutate(f.trust); expect(f.read).toThrow();
    }
  });
  it('brackets genesis and finalized slots and binds actual same-bank Clock', async () => {
    for (const mode of ['genesis', 'closing-genesis', 'opening', 'context', 'closing', 'clock', 'clock-owner', 'future-created']) {
      const f = fixture(); let calls = 0;
      if (mode === 'genesis') f.rpc.getGenesisHash = async () => key(99).toBase58();
      if (mode === 'closing-genesis') f.rpc.getGenesisHash = async () => ++calls === 1 ? f.genesis.toBase58() : key(99).toBase58();
      if (mode === 'opening') f.rpc.getSlot = async () => 89;
      if (mode === 'closing') f.rpc.getSlot = async () => ++calls === 1 ? 150 : 149;
      if (mode === 'context') f.rpc.getMultipleAccountsInfoAndContext = async () => ({ context: { slot: 149 }, value: f.rows });
      if (mode === 'clock') f.rows.at(-1)!.data.writeBigUInt64LE(149n);
      if (mode === 'clock-owner') f.rows.at(-1)!.owner = key(99);
      if (mode === 'future-created') f.get('charter').data.writeBigInt64LE(1_800_000_011n, 271);
      await expect(f.read()(intent)).rejects.toThrow();
    }
  });
  it('missing permanent data holds rather than proving cancellation', async () => {
    for (const label of ['charter', 'creationReceipt', 'assetBinding', 'asset', 'collection'] as const) {
      const f = fixture(); f.rows.splice(f.rows.indexOf(f.get(label)), 1);
      await expect(f.read()(intent)).rejects.toMatchObject({ code: 'ACCOUNTS', reservationReleaseAuthorized: false });
    }
  });
  it('requires exact account runtime owners, identities, widths, versions and bumps', async () => {
    for (const label of ['config', 'craftControl', 'charter', 'creationReceipt', 'assetBinding'] as const) for (const mode of ['owner', 'address', 'executable', 'version', 'bump', 'truncate', 'trailing']) {
      const f = fixture(), row = f.get(label);
      if (mode === 'owner') row.owner = key(99);
      if (mode === 'address') row.address = key(99);
      if (mode === 'executable') row.executable = true;
      if (mode === 'version') row.data[8] = 2;
      if (mode === 'bump') row.data[row.data.length - 1] = row.data[row.data.length - 1]! ^ 1;
      if (mode === 'truncate') row.data = row.data.subarray(0, row.data.length - 1);
      if (mode === 'trailing') row.data = Buffer.concat([row.data, Buffer.of(0)]);
      await expect(f.read()(intent)).rejects.toThrow();
    }
  });
  it('authenticates each Charter and permanent receipt field including UUID second halves', async () => {
    for (const [label, offsets] of [['charter', [9, 49, 57, 89, 121, 153, 157, 158, 159, 183, 191, 223, 255]],
      ['creationReceipt', [17, 33, 41, 73, 105, 137]], ['assetBinding', [9, 49, 57]], ['config', [9, 41, 73, 105, 137]],
      ['craftControl', [41, 73, 105, 137]]] as const) for (const offset of offsets) {
      const f = fixture(); f.get(label).data[offset] = f.get(label).data[offset]! ^ (offset === 137 && label === 'craftControl' ? 2 : 1);
      await expect(f.read()(intent)).rejects.toThrow();
    }
  });
  it('accepts another saved opaque permit but requires the same ID in both permanent accounts', async () => {
    const f = fixture(), permit = Buffer.from(f.saved.issuedPermitIds[1]!, 'hex');
    permit.copy(f.get('charter').data, 255); permit.copy(f.get('creationReceipt').data, 137);
    expect((await f.read()(intent)).permitId).toBe(permit.toString('hex'));
    f.get('creationReceipt').data[137] = 0;
    await expect(f.read()(intent)).rejects.toThrow();
  });
  it('requires the exact fresh frozen Core asset with original owner and metadata', async () => {
    const base = fixture();
    for (const offset of [0, 1, 33, 34, 66, 70, base.baseEnd - 1, base.baseEnd, base.baseEnd + 1, base.pluginAt, base.pluginAt + 1,
      base.registryAt, base.registryAt + 1, base.registryAt + 5, base.registryAt + 6, base.registryAt + 7, base.registryAt + 39, base.registryAt + 47]) {
      const f = fixture(); f.get('asset').data[offset] = f.get('asset').data[offset]! ^ 1; await expect(f.read()(intent)).rejects.toThrow();
    }
    for (const mode of ['owner', 'executable', 'trailing', 'huge']) {
      const f = fixture(), a = f.get('asset');
      if (mode === 'owner') a.owner = key(99); if (mode === 'executable') a.executable = true;
      if (mode === 'trailing') a.data = Buffer.concat([a.data, Buffer.of(0)]); if (mode === 'huge') a.data = Buffer.alloc(4097);
      await expect(f.read()(intent)).rejects.toThrow();
    }
  });
  it('requires a plugin-free collection with the original craft capability and sane positive counters', async () => {
    for (const mode of ['owner', 'authority', 'zero', 'overminted', 'trailing', 'bad-utf8', 'huge-length']) {
      const f = fixture(), c = f.get('collection');
      if (mode === 'owner') c.owner = key(99); if (mode === 'authority') c.data[1] = 99;
      if (mode === 'zero') c.data.writeUInt32LE(0, c.data.length - 4); if (mode === 'overminted') c.data.writeUInt32LE(5, c.data.length - 4);
      if (mode === 'trailing') c.data = Buffer.concat([c.data, Buffer.of(0)]); if (mode === 'bad-utf8') c.data[37] = 255;
      if (mode === 'huge-length') c.data.writeUInt32LE(0xffffffff, 33);
      await expect(f.read()(intent)).rejects.toThrow();
    }
  });
  it('owns saved expectation and bank bytes before further provider awaits', async () => {
    const f = fixture(); let calls = 0, slotCalls = 0;
    f.rpc.getGenesisHash = async () => { if (++calls === 1) Object.assign(f.saved.metadata, { name: 'Rebound' }); return f.genesis.toBase58(); };
    f.rpc.getSlot = async () => { if (++slotCalls === 2) f.get('charter').data.fill(0); return 150; };
    const result = await f.read()(intent);
    expect(result.metadataHash).toBe(hashCharterMetadata({ name: 'First Charter', uri: f.saved.metadata.uri }).toString('hex'));
    const digest = result.source.accounts.find(a => a.address === f.saved.chain.charter)!.dataSha256;
    f.get('charter').data.fill(0); expect(digest).not.toBe(sha(f.get('charter').data));
  });
  it('maps provider failures to unavailable and never authorizes refund', async () => {
    const f = fixture(); f.rpc.getGenesisHash = async () => { throw new Error('offline'); };
    await expect(f.read()(intent)).rejects.toMatchObject({ code: 'UNAVAILABLE', reservationReleaseAuthorized: false });
  });
  it('bounds even a private loader timeout and retains busy slots until abandoned work settles', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let release!: () => void;
      const hanging = new Promise<CharterCreationSavedRecord>(resolve => { release = () => resolve(f.saved); });
      const connect = vi.fn(() => f.rpc), read = createCharterCreationEvidenceReader(connect, f.trust, async () => hanging, { deadlineMs: 10 });
      const pending = Array.from({ length: 8 }, () => read(intent).catch(e => e));
      await vi.advanceTimersByTimeAsync(11);
      expect((await Promise.all(pending)).every(e => e.code === 'DEADLINE')).toBe(true);
      await expect(read(intent)).rejects.toMatchObject({ code: 'BUSY' });
      release(); await vi.advanceTimersByTimeAsync(0);
      expect(connect).not.toHaveBeenCalled();
      const recovered = read(intent); await vi.advanceTimersByTimeAsync(0); expect((await recovered).finalizedMintObserved).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
