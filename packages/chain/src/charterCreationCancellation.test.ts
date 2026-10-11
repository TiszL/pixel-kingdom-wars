import { describe, expect, it, vi } from 'vitest';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { encodeCharterRegistrationPermit, hashCharterRegistrationPayload } from './charterProtocol';
import { createCharterCreationCancellationReader, type CharterCreationCancellationSavedRecord } from './charterCreationCancellation';
import { fixture, key, intent } from './testFixtures/charterCreation';

const NOW = 1_800_000_010n;
const creationKeys = ['charter', 'creationReceipt', 'assetBinding', 'asset'] as const;
function cancellationFixture(minted = false) {
  const f = fixture(), { issuedPermitIds, ...original } = f.saved, c = original.chain;
  const p = (field: keyof typeof c) => new PublicKey(c[field]);
  const payloadHash = hashCharterRegistrationPayload({ config: p('config'), craftProgram: p('craftProgram'), craftControl: p('craftControl'),
    collection: p('collection'), collectionAuthority: p('collectionAuthority'), charter: p('charter'), asset: p('asset'),
    assetBinding: p('assetBinding'), freezeAuthority: p('freezeAuthority'), executor: p('executor'), creationReceipt: p('creationReceipt'),
    clanId: original.clanId, leader: new PublicKey(original.payer), creationIntentId: original.creationIntentId,
    metadataHash: Buffer.from(original.metadata.hash, 'hex'), admissionCommitment: Buffer.from(original.admissionCommitment, 'hex') });
  const messages = issuedPermitIds.map((id, i) => encodeCharterRegistrationPermit({ genesisHash: p('genesisHash'), programId: p('economyProgram'),
    kind: 5, permitId: Buffer.from(id, 'hex'), wallet: new PublicKey(original.payer), expiry: NOW - BigInt(i + 1), payloadHash }));
  const saved: CharterCreationCancellationSavedRecord = { original, permitInventory: { version: 1, revision: '2', count: 2, messages } };
  const creationRows = creationKeys.map(label => f.get(label));
  if (!minted) for (const row of creationRows) f.rows.splice(f.rows.indexOf(row), 1);
  const load = vi.fn(async () => saved), connect = vi.fn(() => f.rpc);
  const read = (options: { deadlineMs?: number } = {}) => createCharterCreationCancellationReader(connect, f.trust, load, options);
  const zero = () => Object.assign(saved.permitInventory, { revision: '0', count: 0, messages: [] });
  return { ...f, saved, messages, creationRows, load, connect, read, zero };
}

describe('original Charter cancellation finalized observations', () => {
  it('binds every potentially exposed permit and the exact durable head to one finalized absence observation', async () => {
    const f = cancellationFixture(), result = await f.read()(intent);
    expect(result).toMatchObject({ version: 1, outcome: 'absent-after-expiry', original: f.saved.original, slot: 150, unixTimestamp: NOW,
      inventory: { version: 1, revision: '2', count: 2, messages: f.messages.map((b, i) => ({ messageHex: b.toString('hex'),
        permitId: b.subarray(73, 89).toString('hex'), expiry: NOW - BigInt(i + 1) })) },
      inventoryAuthenticated: false, transactionProofVerified: false, paymentAuthorized: false, activationAuthorized: false,
      signingAuthorized: false, refundAuthorized: false, reservationReleaseAuthorized: false });
    expect(f.load).toHaveBeenCalledWith(intent); expect(f.rpc.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.rpc.getMultipleAccountsInfoAndContext).mock.calls[0]![1]).toEqual({ commitment: 'finalized', minContextSlot: 150 });
    expect(result.source.accounts).toHaveLength(14); expect(result.source.programs).toHaveLength(3);
    for (const label of creationKeys) expect(result.source.accounts.find(a => a.address === f.saved.original.chain[label]))
      .toEqual({ address: f.saved.original.chain[label], owner: null, executable: null, dataSha256: null });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.original.chain)).toBe(true);
    expect(Object.isFrozen(result.inventory.messages)).toBe(true); expect(Object.isFrozen(result.inventory.messages[0])).toBe(true);
    expect(Object.isFrozen(result.source.accounts[0])).toBe(true);
  });

  it('accepts an explicit never-issued zero head and an empty plain collection while paused', async () => {
    const f = cancellationFixture(); f.zero(); f.get('craftControl').data[137] = 1;
    const collection = f.get('collection').data; collection.writeUInt32LE(0, collection.length - 8); collection.writeUInt32LE(0, collection.length - 4);
    expect(await f.read()(intent)).toMatchObject({ outcome: 'absent-after-expiry', inventory: { revision: '0', count: 0, messages: [] }, reservationReleaseAuthorized: false });
  });

  it('lets an exact permanent mint win both expired and live-permit cases, including pause', async () => {
    for (const expiry of [NOW - 1n, NOW, NOW + 1n]) {
      const f = cancellationFixture(true); f.messages[0]!.writeBigInt64LE(expiry, 121); f.get('craftControl').data[137] = 1;
      const result = await f.read()(intent); expect(result.outcome).toBe('minted');
      if (result.outcome !== 'minted') throw Error('Expected mint precedence');
      expect(result.mint).toMatchObject({ finalizedMintObserved: true, permitId: '00'.repeat(16), creationIntentId: intent,
        reservationReleaseAuthorized: false, activationAuthorized: false });
      expect(f.rpc.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(1);
      expect(result.mint.slot).toBe(result.slot); expect(result.mint.unixTimestamp).toBe(result.unixTimestamp);
      expect(result.mint.source).toEqual(result.source);
    }
  });

  it('requires Clock strictly beyond every inventory expiry rather than a selected transaction deadline', async () => {
    for (const expiry of [NOW, NOW + 1n]) {
      const f = cancellationFixture(); f.messages[1]!.writeBigInt64LE(expiry, 121);
      await expect(f.read()(intent)).rejects.toMatchObject({ code: 'LIVE_PERMIT', reservationReleaseAuthorized: false });
      f.messages[1]!.writeBigInt64LE(NOW - 1n, 121); expect((await f.read()(intent)).outcome).toBe('absent-after-expiry');
    }
  });

  it('holds any partial creation state instead of interpreting null permanent receipt as no mint', async () => {
    for (const rowIndex of [0, 1, 2, 3]) {
      const f = cancellationFixture(); f.rows.push(f.creationRows[rowIndex]!);
      await expect(f.read()(intent)).rejects.toMatchObject({ code: 'ACCOUNTS', reservationReleaseAuthorized: false });
    }
    const prefunded = cancellationFixture(); const asset = prefunded.creationRows[3]!;
    asset.owner = PublicKey.default; asset.data = Buffer.alloc(0); prefunded.rows.push(asset);
    await expect(prefunded.read()(intent)).rejects.toMatchObject({ code: 'ACCOUNTS' });
  });

  it('refuses absent, partial, duplicate or inconsistent inventory heads before opening RPC', async () => {
    const changes = [undefined, { version: 1, revision: '0', count: 1, messages: [] }, { version: 1, revision: '1', count: 0, messages: [] },
      { version: 1, revision: '00', count: 0, messages: [] }, { version: 2, revision: '0', count: 0, messages: [] },
      { version: 1, revision: '0'.repeat(100_000), count: 0, messages: [] }];
    for (const value of changes) {
      const f = cancellationFixture(); Object.assign(f.saved, { permitInventory: value });
      await expect(f.read()(intent)).rejects.toMatchObject({ code: 'INVENTORY' }); expect(f.connect).not.toHaveBeenCalled();
    }
    for (const mode of ['partial', 'duplicate', 'oversized', 'status-filter', 'id-list']) {
      const f = cancellationFixture();
      if (mode === 'partial') Object.assign(f.saved.permitInventory, { messages: [f.messages[0]] });
      if (mode === 'duplicate') Object.assign(f.saved.permitInventory, { messages: [f.messages[0], f.messages[0]] });
      if (mode === 'oversized') Object.assign(f.saved.permitInventory, { count: 257, revision: '257', messages: Array(257).fill(f.messages[0]) });
      if (mode === 'status-filter') Object.assign(f.saved.permitInventory, { status: 'failed' });
      if (mode === 'id-list') Object.assign(f.saved.permitInventory, { issuedPermitIds: ['ff'.repeat(16)] });
      await expect(f.read()(intent)).rejects.toMatchObject({ code: 'INVENTORY' }); expect(f.connect).not.toHaveBeenCalled();
    }
  });

  it('decodes full messages and binds domain, kind, original payer, genesis, program and full payload', async () => {
    // Permit ID is deliberately opaque; allzero is valid. Every other authority
    // field must match the original, not just a reported ID or expiry column.
    for (const offset of [0, 8, 40, 72, 89, 129, 160]) {
      const f = cancellationFixture(); f.messages[0]![offset] = f.messages[0]![offset]! ^ 1;
      await expect(f.read()(intent)).rejects.toMatchObject({ code: 'INVENTORY' }); expect(f.connect).not.toHaveBeenCalled();
    }
    for (const message of [Buffer.alloc(160), Buffer.alloc(162), Buffer.alloc(100_000), '00'.repeat(161)]) {
      const f = cancellationFixture(); Object.assign(f.saved.permitInventory, { messages: [message, f.messages[1]] });
      await expect(f.read()(intent)).rejects.toMatchObject({ code: 'INVENTORY' }); expect(f.connect).not.toHaveBeenCalled();
    }
  });

  it('recomputes original registration payload including the second halves of both UUIDs and immutable consent', async () => {
    for (const change of [{ clanId: '12345678-1234-5678-9abc-def012345679' }, { creationIntentId: '87654321-4321-4321-8abc-def012345679' },
      { payer: key(99).toBase58() }, { admissionCommitment: 'ac'.repeat(32) }, { metadata: { name: 'Changed', uri: 'x', hash: 'aa'.repeat(32) } }]) {
      const f = cancellationFixture(); Object.assign(f.saved.original, change);
      await expect(f.read()(intent)).rejects.toThrow(); expect(f.connect).not.toHaveBeenCalled();
    }
    for (const field of Object.keys(cancellationFixture().saved.original.chain)) {
      const f = cancellationFixture(); Object.assign(f.saved.original.chain, { [field]: key(99).toBase58() });
      await expect(f.read()(intent)).rejects.toMatchObject({ code: 'RESERVATION' }); expect(f.connect).not.toHaveBeenCalled();
    }
  });

  it('requires exact permanent mint bytes and membership in the message-derived ID set', async () => {
    for (const label of creationKeys) {
      const f = cancellationFixture(true); f.get(label).data[0] = f.get(label).data[0]! ^ 1;
      await expect(f.read()(intent)).rejects.toMatchObject({ code: 'ACCOUNTS' });
    }
    const f = cancellationFixture(true); f.messages[0]!.fill(0xef, 73, 89);
    await expect(f.read()(intent)).rejects.toMatchObject({ code: 'ACCOUNTS' });
    f.zero(); await expect(f.read()(intent)).rejects.toMatchObject({ code: 'ACCOUNTS' });
    for (const mode of ['leader', 'thawed']) {
      const malformed = cancellationFixture(true);
      if (mode === 'leader') malformed.get('charter').data[121] = 99;
      else malformed.get('asset').data[malformed.pluginAt + 1] = 0;
      await expect(malformed.read()(intent)).rejects.toMatchObject({ code: 'ACCOUNTS' });
    }
  });

  it('authenticates every reviewed executable and ProgramData account even when all creation rows are absent', async () => {
    for (let i = 0; i < 6; i++) for (const mode of ['missing', 'owner', 'executable', 'bytes']) {
      const f = cancellationFixture(), row = f.rows[i]!;
      if (mode === 'missing') f.rows.splice(i, 1); if (mode === 'owner') row.owner = key(99);
      if (mode === 'executable') row.executable = !row.executable; if (mode === 'bytes') row.data[row.data.length - 1] = row.data[row.data.length - 1]! ^ 1;
      await expect(f.read()(intent)).rejects.toThrow();
    }
  });

  it('requires canonical config/control and a plain controlled collection, allowing zero but never malformed counters', async () => {
    for (const label of ['config', 'craftControl', 'collection'] as const) for (const mode of ['missing', 'owner', 'executable', 'trailing']) {
      const f = cancellationFixture(), row = f.get(label);
      if (mode === 'missing') f.rows.splice(f.rows.indexOf(row), 1); if (mode === 'owner') row.owner = key(99);
      if (mode === 'executable') row.executable = true; if (mode === 'trailing') row.data = Buffer.concat([row.data, Buffer.of(0)]);
      await expect(f.read()(intent)).rejects.toMatchObject({ code: 'ACCOUNTS' });
    }
    for (const mode of ['authority', 'overminted', 'bad-utf8', 'huge-length']) {
      const f = cancellationFixture(), bytes = f.get('collection').data;
      if (mode === 'authority') bytes[1] = 99; if (mode === 'overminted') bytes.writeUInt32LE(5, bytes.length - 4);
      if (mode === 'bad-utf8') bytes[37] = 255; if (mode === 'huge-length') bytes.writeUInt32LE(0xffffffff, 33);
      await expect(f.read()(intent)).rejects.toMatchObject({ code: 'ACCOUNTS' });
    }
  });

  it('brackets finalized genesis/slots and uses the same-bank exact Clock instead of wall time', async () => {
    for (const mode of ['genesis', 'closing-genesis', 'opening', 'context', 'closing', 'clock-slot', 'clock-owner', 'clock-width', 'clock-zero']) {
      const f = cancellationFixture(); let calls = 0;
      if (mode === 'genesis') f.rpc.getGenesisHash = async () => key(99).toBase58();
      if (mode === 'closing-genesis') f.rpc.getGenesisHash = async () => ++calls === 1 ? f.genesis.toBase58() : key(99).toBase58();
      if (mode === 'opening') f.rpc.getSlot = async () => 89;
      if (mode === 'closing') f.rpc.getSlot = async () => ++calls === 1 ? 150 : 149;
      if (mode === 'context') f.rpc.getMultipleAccountsInfoAndContext = async addresses => ({ context: { slot: 149 }, value: addresses.map(p => f.rows.find(r => r.address.equals(p)) ?? null) });
      const clock = f.rows.find(r => r.address.equals(SYSVAR_CLOCK_PUBKEY))!;
      if (mode === 'clock-slot') clock.data.writeBigUInt64LE(149n); if (mode === 'clock-owner') clock.owner = key(99);
      if (mode === 'clock-width') clock.data = Buffer.concat([clock.data, Buffer.of(0)]); if (mode === 'clock-zero') clock.data.writeBigInt64LE(0n, 32);
      await expect(f.read()(intent)).rejects.toThrow();
    }
  });

  it('detaches original, full inventory and bank bytes before subsequent provider awaits', async () => {
    const f = cancellationFixture(), originalMessages = f.messages.map(b => b.toString('hex')); let genesisCalls = 0, slotCalls = 0;
    f.rpc.getGenesisHash = async () => {
      if (++genesisCalls === 1) { f.messages[0]!.fill(0); Object.assign(f.saved.original.metadata, { name: 'Rebound' }); }
      return f.genesis.toBase58();
    };
    f.rpc.getSlot = async () => { if (++slotCalls === 2) f.get('config').data.fill(0); return 150; };
    const result = await f.read()(intent);
    expect(result.inventory.messages.map(m => m.messageHex)).toEqual(originalMessages); expect(result.original.metadata.name).toBe('First Charter');
    expect(result.outcome).toBe('absent-after-expiry');
  });

  it('requires the private saved record and never treats missing inventory as never-issued', async () => {
    const f = cancellationFixture();
    await expect(createCharterCreationCancellationReader(f.connect, f.trust, async () => null)(intent))
      .rejects.toMatchObject({ code: 'RESERVATION', reservationReleaseAuthorized: false });
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('refuses aliases, malformed settings and retained-deployment trust before RPC', async () => {
    for (const id of [intent.toUpperCase(), intent.slice(0, -1), '0'.repeat(100_000)]) {
      const f = cancellationFixture(); await expect(f.read()(id)).rejects.toMatchObject({ code: 'INPUT' }); expect(f.connect).not.toHaveBeenCalled();
    }
    for (const deadlineMs of [0, -1, 60_001, NaN]) expect(() => cancellationFixture().read({ deadlineMs })).toThrow();
    const f = cancellationFixture(); Object.assign(f.trust, { stateProvenance: 'retained-upgrade' }); expect(f.read).toThrow();
  });

  it('maps provider failure to unavailable without a cancellation or release assertion', async () => {
    const f = cancellationFixture(); f.rpc.getGenesisHash = async () => { throw Error('offline'); };
    await expect(f.read()(intent)).rejects.toMatchObject({ code: 'UNAVAILABLE', reservationReleaseAuthorized: false });
  });

  it('bounds loader deadlines and retains timed-out work slots until ignored work actually settles', async () => {
    vi.useFakeTimers();
    try {
      const f = cancellationFixture(); let release!: () => void;
      const hanging = new Promise<CharterCreationCancellationSavedRecord>(resolve => { release = () => resolve(f.saved); });
      const read = createCharterCreationCancellationReader(f.connect, f.trust, async () => hanging, { deadlineMs: 10 });
      const pending = Array.from({ length: 8 }, () => read(intent).catch(e => e));
      await vi.advanceTimersByTimeAsync(11); expect((await Promise.all(pending)).every(e => e.code === 'DEADLINE')).toBe(true);
      await expect(read(intent)).rejects.toMatchObject({ code: 'BUSY' }); release(); await vi.advanceTimersByTimeAsync(0);
      expect(f.connect).not.toHaveBeenCalled(); const recovered = read(intent); await vi.advanceTimersByTimeAsync(0);
      expect((await recovered).outcome).toBe('absent-after-expiry');
    } finally { vi.useRealTimers(); }
  });

  it('shares one deadline across loader and RPC and retains slots until ignored account or closing calls settle', async () => {
    vi.useFakeTimers();
    try {
      for (const stage of ['accounts', 'closing']) {
        const f = cancellationFixture(true); let release!: () => void;
        const hanging = new Promise<void>(resolve => { release = resolve; });
        const accounts = f.rpc.getMultipleAccountsInfoAndContext.bind(f.rpc);
        const genesis = vi.fn(f.rpc.getGenesisHash); f.rpc.getGenesisHash = genesis;
        const slots = vi.fn(async () => 150);
        f.rpc.getMultipleAccountsInfoAndContext = vi.fn(async (addresses, options) => {
          if (stage === 'accounts') await hanging;
          return accounts(addresses, options);
        });
        f.connect.mockImplementation(() => {
          let slotCount = 0;
          return { ...f.rpc, getSlot: async () => {
            const slot = await slots();
            if (stage === 'closing' && ++slotCount === 2) await hanging;
            return slot;
          } };
        });
        const read = createCharterCreationCancellationReader(f.connect, f.trust,
          async () => { await new Promise(resolve => setTimeout(resolve, 6)); return f.saved; }, { deadlineMs: 10 });
        let completed = 0;
        const pending = Array.from({ length: 8 }, () => read(intent).catch(error => { completed++; return error; }));
        await vi.advanceTimersByTimeAsync(7); expect(completed).toBe(0);
        expect(f.rpc.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(8);
        await vi.advanceTimersByTimeAsync(4);
        expect((await Promise.all(pending)).every(error => error.code === 'DEADLINE')).toBe(true);
        await expect(read(intent)).rejects.toMatchObject({ code: 'BUSY' });
        const slotCalls = slots.mock.calls.length;
        release(); await vi.advanceTimersByTimeAsync(0);
        expect(slots).toHaveBeenCalledTimes(slotCalls); expect(genesis).toHaveBeenCalledTimes(8);
        expect(f.rpc.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(8);
        const recovered = read(intent); await vi.advanceTimersByTimeAsync(7);
        expect((await recovered).outcome).toBe('minted');
      }
    } finally { vi.useRealTimers(); }
  });
});
