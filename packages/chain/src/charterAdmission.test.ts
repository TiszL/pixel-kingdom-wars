/** Synthetic finalized banks pin observations, not signing or funding authority. */
import { createHash } from 'node:crypto';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { createCharterAdmissionReader } from './charterAdmission';
import { fixture, key, intent, sha } from './testFixtures/charterCreation';

const NOW = 1_800_000_010n;
function admissionFixture(options: { pending?: boolean; previous?: boolean; paused?: boolean; padding?: number } = {}) {
  const f = fixture(), economy = new PublicKey(f.trust.economy.programId), current = key(71), previous = key(72);
  const [authority, bump] = PublicKey.findProgramAddressSync([Buffer.from('seeker_authority')], economy);
  const pieces: Buffer[] = [createHash('sha256').update('account:SeekerAuthority').digest().subarray(0, 8), Buffer.of(1)];
  const offsets: Record<string, number> = { version: 8 };
  const put = (name: string, bytes: Buffer) => { offsets[name] = pieces.reduce((n, b) => n + b.length, 0); pieces.push(bytes); };
  put('admin', key(73).toBuffer()); put('pendingTag', Buffer.of(options.pending ? 1 : 0));
  if (options.pending) put('pending', key(74).toBuffer());
  put('guardian', key(75).toBuffer()); put('current', current.toBuffer()); put('previousTag', Buffer.of(options.previous ? 1 : 0));
  if (options.previous) put('previous', previous.toBuffer());
  const deadline = Buffer.alloc(8); deadline.writeBigInt64LE(options.previous ? NOW + 50n : 0n);
  put('deadline', deadline); put('genesis', new PublicKey(f.trust.expectedGenesisHash).toBuffer());
  put('paused', Buffer.of(options.paused ? 1 : 0)); put('bump', Buffer.of(bump));
  const data = Buffer.alloc(213, options.padding ?? 0); Buffer.concat(pieces).copy(data);
  const row = { address: authority, owner: economy, executable: false, data }; f.rows.push(row);
  const connect = vi.fn((_signal: AbortSignal) => f.rpc);
  const read = (settings: { deadlineMs?: number } = {}, signer = current.toBase58()) => createCharterAdmissionReader(connect, f.trust, signer, settings);
  const clock = () => f.rows.find(r => r.address.equals(SYSVAR_CLOCK_PUBKEY))!;
  return { ...f, row, current, previous, offsets, connect, read, clock };
}

describe('current Charter policy observation', () => {
  it('reads exactly one ten-account finalized bank and returns detached facts with every authority false', async () => {
    const f = admissionFixture(), result = await f.read()();
    expect(result).toMatchObject({ version: 1, domain: { genesisHash: f.trust.expectedGenesisHash,
      economyProgram: f.trust.economy.programId, craftProgram: f.trust.craft.programId },
      authority: { address: f.row.address.toBase58(), currentPolicyKey: f.current.toBase58(), previousPolicyKey: null,
        previousValidUntil: 0n, admissionPaused: false }, craftControl: { address: f.saved.chain.craftControl, admissionPaused: false },
      expectedCurrentSigner: f.current.toBase58(), currentSignerObserved: true, slot: 150, unixTimestamp: NOW,
      mintAuthorized: false, paymentAuthorized: false, signingAuthorized: false, activationAuthorized: false,
      refundAuthorized: false, reservationReleaseAuthorized: false, transactionProofVerified: false });
    const calls = vi.mocked(f.rpc.getMultipleAccountsInfoAndContext).mock.calls;
    expect(calls).toHaveLength(1); expect(calls[0]![1]).toEqual({ commitment: 'finalized', minContextSlot: 150 });
    expect(calls[0]![0].map(k => k.toBase58())).toEqual([
      ...f.rows.slice(0, 6).map(r => r.address.toBase58()), f.row.address.toBase58(),
      f.saved.chain.config, f.saved.chain.craftControl, SYSVAR_CLOCK_PUBKEY.toBase58(),
    ]);
    expect(result.source.accounts).toHaveLength(10); expect(result.source.programs).toEqual([f.trust.economy, f.trust.craft, f.trust.core]);
    expect(result.source.accounts[6]).toMatchObject({ dataSha256: sha(f.row.data), owner: f.row.owner.toBase58(), executable: false });
    for (const v of [result, result.domain, result.authority, result.craftControl, result.source, result.source.accounts,
      result.source.accounts[0], result.source.programs[0]]) expect(Object.isFrozen(v)).toBe(true);
  });

  it('parses both variable Options and ignores historical nonzero allocation padding', async () => {
    for (const pending of [false, true]) for (const previous of [false, true]) {
      const f = admissionFixture({ pending, previous, padding: 0xac });
      expect((await f.read()()).authority).toMatchObject({ currentPolicyKey: f.current.toBase58(),
        previousPolicyKey: previous ? f.previous.toBase58() : null, previousValidUntil: previous ? NOW + 50n : 0n });
    }
  });

  it('refuses malformed authority versions, keys, Options, booleans, bumps and genesis', async () => {
    for (const mode of ['version', 'admin', 'guardian', 'current', 'pendingTag', 'previousTag', 'paused', 'bump', 'genesis',
      'pending-equals-admin', 'previous-equals-current', 'pending-default', 'previous-default', 'no-previous-deadline']) {
      const f = admissionFixture({ pending: true, previous: mode !== 'no-previous-deadline' });
      if (['admin', 'guardian', 'current'].includes(mode)) f.row.data.fill(0, f.offsets[mode]!, f.offsets[mode]! + 32);
      else if (mode === 'pending-equals-admin') key(73).toBuffer().copy(f.row.data, f.offsets['pending']);
      else if (mode === 'previous-equals-current') f.current.toBuffer().copy(f.row.data, f.offsets['previous']);
      else if (mode === 'pending-default') PublicKey.default.toBuffer().copy(f.row.data, f.offsets['pending']);
      else if (mode === 'previous-default') PublicKey.default.toBuffer().copy(f.row.data, f.offsets['previous']);
      else if (mode === 'no-previous-deadline') f.row.data.writeBigInt64LE(1n, f.offsets['deadline']);
      else f.row.data[f.offsets[mode]!] = mode.endsWith('Tag') || mode === 'paused' ? 2 : f.row.data[f.offsets[mode]!]! ^ 1;
      await expect(f.read()()).rejects.toMatchObject({ code: 'ACCOUNTS', signingAuthorized: false });
    }
  });

  it('requires the exact canonical authority address, owner, allocation and discriminator', async () => {
    for (const mode of ['missing', 'address', 'owner', 'executable', 'short', 'long', 'discriminator']) {
      const f = admissionFixture();
      if (mode === 'missing') f.rows.splice(f.rows.indexOf(f.row), 1);
      if (mode === 'address') f.row.address = key(90); if (mode === 'owner') f.row.owner = key(90);
      if (mode === 'executable') f.row.executable = true;
      if (mode === 'short') f.row.data = f.row.data.subarray(0, 212);
      if (mode === 'long') f.row.data = Buffer.concat([f.row.data, Buffer.of(0)]);
      if (mode === 'discriminator') f.row.data[0] = f.row.data[0]! ^ 1;
      await expect(f.read()()).rejects.toMatchObject({ code: 'ACCOUNTS' });
    }
  });

  it('refuses either current admission pause', async () => {
    const economy = admissionFixture({ paused: true }); await expect(economy.read()()).rejects.toMatchObject({ code: 'PAUSED' });
    const craft = admissionFixture(); craft.get('craftControl').data[137] = 1;
    await expect(craft.read()()).rejects.toMatchObject({ code: 'PAUSED' });
  });

  it('requires the configured current signer even while the previous signer remains in grace', async () => {
    const f = admissionFixture({ previous: true });
    for (const signer of [f.previous.toBase58(), key(99).toBase58()])
      await expect(f.read({}, signer)()).rejects.toMatchObject({ code: 'SIGNER' });
    expect((await f.read()()).authority.previousValidUntil).toBe(NOW + 50n);
    f.row.data.writeBigInt64LE(NOW - 1n, f.offsets['deadline']);
    expect((await f.read()()).authority.previousValidUntil).toBe(NOW - 1n);
  });

  it('authenticates config and control links, versions, canonical bumps and bootstrap identity', async () => {
    for (const [label, offsets] of [['config', [0, 8, 9, 41, 73, 105, 137, 169]], ['craftControl', [0, 8, 41, 73, 105, 138, 139, 140]]] as const) {
      for (const offset of offsets) {
        const f = admissionFixture(), row = f.get(label); row.data[offset] = row.data[offset]! ^ 1;
        await expect(f.read()()).rejects.toMatchObject({ code: 'ACCOUNTS' });
      }
      for (const mode of ['owner', 'executable']) { const f = admissionFixture(), row = f.get(label);
        if (mode === 'owner') row.owner = key(99); else row.executable = true;
        await expect(f.read()()).rejects.toMatchObject({ code: 'ACCOUNTS' }); }
    }
    const f = admissionFixture(); f.get('craftControl').data.fill(0, 9, 41);
    await expect(f.read()()).rejects.toMatchObject({ code: 'ACCOUNTS' });
    const malformedPause = admissionFixture(); malformedPause.get('craftControl').data[137] = 2;
    await expect(malformedPause.read()()).rejects.toMatchObject({ code: 'ACCOUNTS' });
  });

  it('authenticates all three reviewed executable and ProgramData pairs', async () => {
    for (let index = 0; index < 6; index++) for (const mode of ['owner', 'executable', 'bytes', 'missing']) {
      const f = admissionFixture(), row = f.rows[index]!;
      if (mode === 'owner') row.owner = key(99); if (mode === 'executable') row.executable = !row.executable;
      if (mode === 'bytes') row.data[row.data.length - 1] = row.data[row.data.length - 1]! ^ 1;
      if (mode === 'missing') f.rows.splice(index, 1);
      await expect(f.read()()).rejects.toThrow();
    }
  });

  it('rejects malformed bank cardinality, address order and oversized rows', async () => {
    for (const mode of ['short', 'extra', 'swapped', 'oversized']) {
      const f = admissionFixture(), actual = f.rpc.getMultipleAccountsInfoAndContext.bind(f.rpc);
      f.rpc.getMultipleAccountsInfoAndContext = async (keys, opts) => { const bank = await actual(keys, opts);
        if (mode === 'short') bank.value.pop(); if (mode === 'extra') bank.value.push(null);
        if (mode === 'swapped') [bank.value[7], bank.value[8]] = [bank.value[8]!, bank.value[7]!];
        if (mode === 'oversized') Object.assign(bank.value[1]!, { data: Buffer.alloc(8 * 1024 * 1024 + 1) }); return bank; };
      await expect(f.read()()).rejects.toThrow();
    }
  });

  it('requires coherent exact Clock data and positive chain time', async () => {
    for (const mode of ['slot', 'zero', 'negative', 'length', 'owner', 'executable']) {
      const f = admissionFixture(), c = f.clock();
      if (mode === 'slot') c.data.writeBigUInt64LE(151n); if (mode === 'zero') c.data.writeBigInt64LE(0n, 32);
      if (mode === 'negative') c.data.writeBigInt64LE(-1n, 32); if (mode === 'length') c.data = Buffer.alloc(39);
      if (mode === 'owner') c.owner = key(99); if (mode === 'executable') c.executable = true;
      await expect(f.read()()).rejects.toMatchObject({ code: 'ACCOUNTS' });
    }
  });

  it('brackets the one bank with finalized slots and unchanged genesis', async () => {
    for (const mode of ['opening', 'bank', 'closing', 'first-genesis', 'last-genesis']) {
      const f = admissionFixture(); let slots = 0, geneses = 0;
      f.rpc.getSlot = async () => ++slots === 1 ? mode === 'opening' ? 89 : mode === 'bank' ? 151 : 150 : mode === 'closing' ? 149 : 150;
      f.rpc.getGenesisHash = async () => ++geneses === 1
        ? mode === 'first-genesis' ? key(99).toBase58() : f.genesis.toBase58()
        : mode === 'last-genesis' ? key(99).toBase58() : f.genesis.toBase58();
      await expect(f.read()()).rejects.toThrow();
    }
  });

  it('accepts a coherent bank between advancing opening and closing finalized slots', async () => {
    const f = admissionFixture(), actual = f.rpc.getMultipleAccountsInfoAndContext.bind(f.rpc);
    f.clock().data.writeBigUInt64LE(151n);
    f.rpc.getSlot = vi.fn().mockResolvedValueOnce(150).mockResolvedValueOnce(152);
    f.rpc.getMultipleAccountsInfoAndContext = vi.fn(async (keys, options) => {
      const bank = await actual(keys, options); return { ...bank, context: { slot: 151 } };
    });
    const observed = await f.read()();
    expect(observed).toMatchObject({ slot: 151, unixTimestamp: NOW, currentSignerObserved: true });
    expect(f.rpc.getSlot).toHaveBeenCalledTimes(2);
    expect(f.rpc.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(1);
    expect(f.rpc.getMultipleAccountsInfoAndContext).toHaveBeenCalledWith(expect.any(Array),
      { commitment: 'finalized', minContextSlot: 150 });
  });

  it('rejects malformed private trust, signer and bounded deadline options before transport', () => {
    for (const signer of ['', PublicKey.default.toBase58(), 'x'.repeat(100_000)]) {
      const f = admissionFixture(); expect(() => f.read({}, signer)).toThrow(); expect(f.connect).not.toHaveBeenCalled();
    }
    for (const deadlineMs of [0, -1, NaN, 60_001]) expect(() => admissionFixture().read({ deadlineMs })).toThrow();
    const f = admissionFixture(); Object.assign(f.trust, { stateProvenance: 'retained-upgrade' }); expect(f.read).toThrow();
  });

  it('copies factory trust and every bank byte before a later provider await', async () => {
    const f = admissionFixture(), originalHash = sha(f.row.data), read = f.read();
    Object.assign(f.trust.economy, { reviewedProgramDataSha256: 'ff'.repeat(32) });
    let slotCalls = 0; f.rpc.getSlot = async () => { if (++slotCalls === 2) f.row.data.fill(0); return 150; };
    const result = await read(); expect(result.authority.currentPolicyKey).toBe(f.current.toBase58());
    expect(result.source.accounts[6]!.dataSha256).toBe(originalHash);
  });

  it('does not change completed mint recovery when current admission is paused', async () => {
    const f = admissionFixture({ paused: true }); f.get('craftControl').data[137] = 1;
    await expect(f.read()()).rejects.toMatchObject({ code: 'PAUSED' });
    const { createCharterCreationEvidenceReader } = await import('./charterCreationEvidence');
    const old = createCharterCreationEvidenceReader(() => f.rpc, f.trust, f.load);
    expect((await old(intent)).finalizedMintObserved).toBe(true);
  });

  it('bounds the whole RPC sequence and retains all eight ignored calls until they settle', async () => {
    vi.useFakeTimers();
    try { for (const stage of ['accounts', 'closing']) {
      const f = admissionFixture(); let release!: () => void;
      const hanging = new Promise<void>(resolve => { release = resolve; });
      const actual = f.rpc.getMultipleAccountsInfoAndContext.bind(f.rpc), geneses = vi.fn(async () => f.genesis.toBase58());
      f.connect.mockImplementation(() => { let slots = 0; return { ...f.rpc,
        getGenesisHash: geneses,
        getSlot: async () => { if (++slots === 1) await new Promise(resolve => setTimeout(resolve, 6));
          else if (stage === 'closing') await hanging; return 150; },
        getMultipleAccountsInfoAndContext: async (keys, opts) => { if (stage === 'accounts') await hanging; return actual(keys, opts); },
      }; });
      const read = f.read({ deadlineMs: 10 }), pending = Array.from({ length: 8 }, () => read().catch(e => e));
      await vi.advanceTimersByTimeAsync(7); await vi.advanceTimersByTimeAsync(4);
      expect((await Promise.all(pending)).every(e => e.code === 'DEADLINE')).toBe(true);
      await expect(read()).rejects.toMatchObject({ code: 'BUSY' }); expect(geneses).toHaveBeenCalledTimes(8);
      release(); await vi.advanceTimersByTimeAsync(0); expect(geneses).toHaveBeenCalledTimes(8);
      const recovery = read(); await vi.advanceTimersByTimeAsync(7); expect((await recovery).currentSignerObserved).toBe(true);
    } } finally { vi.useRealTimers(); }
  });

  it('maps provider errors to unavailable without granting signing authority', async () => {
    const f = admissionFixture(); f.rpc.getGenesisHash = async () => { throw Error('offline'); };
    await expect(f.read()()).rejects.toMatchObject({ code: 'UNAVAILABLE', signingAuthorized: false });
  });
});
