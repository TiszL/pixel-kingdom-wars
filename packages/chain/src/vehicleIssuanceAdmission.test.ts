import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { createVehicleIssuanceAdmissionReader } from './vehicleIssuanceAdmission';
import { normalizeVehicleIssuanceOriginal } from './vehicleIssuanceAccounts';
import { vehiclePda, vehicleSha256, VEHICLE_CRAFT_PROGRAM, VEHICLE_CORE_PROGRAM, VEHICLE_VRF_PROGRAM, VEHICLE_VRF_QUEUE } from './vehicleIssuanceProtocol';
import { vehicleIssuanceAdmissionFixture } from './testFixtures/vehicleIssuanceAdmission';
const read = (f: ReturnType<typeof vehicleIssuanceAdmissionFixture>) => createVehicleIssuanceAdmissionReader(() => f.rpc, f.trust, f.policyAuthority)(f.original);
const bytes = (f: ReturnType<typeof vehicleIssuanceAdmissionFixture>, index: number) => f.rows[index]!.data as Buffer;
const changedOriginal = (f: ReturnType<typeof vehicleIssuanceAdmissionFixture>, update: Record<string, unknown>) => {
  const { originalHash: _hash, ...original } = f.original;
  f.original = normalizeVehicleIssuanceOriginal({ ...original, ...update });
};

describe('private finalized vehicle pre-request admission', () => {
  it('binds the committed original to a coherent reviewed bank/current signer without granting funding or dispatch authority', async () => {
    const f = vehicleIssuanceAdmissionFixture(), bank = vi.spyOn(f.rpc, 'getMultipleAccountsInfoAndContext'), genesis = vi.spyOn(f.rpc, 'getGenesisHash');
    const proof = await read(f);
    expect(proof).toMatchObject({ version: 1, originalHash: f.original.originalHash, rootId: f.original.rootId, attemptId: f.original.attemptId,
      permitId: f.original.permitId, buyer: f.original.buyer, policyAuthority: f.policyAuthority, genesisHash: f.original.genesisHash,
      unixTimestamp: '1700000020', openingSlot: 20, slot: 20, closingSlot: 20, emptyAccountRentLamports: '890880',
      transactionProofVerified: false, paymentAuthorized: false, activationAuthorized: false, reservationReleaseAuthorized: false });
    expect(bank).toHaveBeenCalledOnce(); expect(genesis).toHaveBeenCalledTimes(2);
    expect(bank.mock.calls[0]![1]).toEqual({ commitment: 'finalized', minContextSlot: 20 });
    expect(proof.source.accounts).toHaveLength(17);
    expect(proof.source.accounts.slice(10)).toEqual(['identity', 'vehicle_root', 'vehicle_attempt', 'vehicle_permit', 'vehicle_app', 'vehicle_oracle', 'vehicle_asset'].map((seed, i) => ({
      address: vehiclePda(seed, i === 0 ? undefined : i === 2 ? f.original.attemptId : i === 3 ? f.original.permitId : f.original.rootId)[0].toBase58(), absent: true,
    })));
    expect(Object.isFrozen(proof.source.programs)).toBe(true); expect(Object.isFrozen(proof.source.accounts[0])).toBe(true);
  });

  it('permits external recipient aliases and empty System PDAs because admission must follow the actual request program', async () => {
    const f = vehicleIssuanceAdmissionFixture(); changedOriginal(f, { terms: { ...f.original.terms, site: f.original.buyer, operator: f.original.buyer, project: f.original.buyer } });
    const proof = await read(f);
    for (const row of proof.source.accounts.slice(10)) f.rows.push({ address: new PublicKey(row.address), owner: SystemProgram.programId, executable: false, data: Buffer.alloc(0) });
    expect((await read(f)).source.accounts.slice(10).every(row => !row.absent)).toBe(true);
  });

  it.each([0, 1, 2, 3, 4, 5])('refuses altered reviewed deployment account %i', async index => {
    const f = vehicleIssuanceAdmissionFixture(), offset = index % 2 ? 45 : 4; bytes(f, index)[offset] = bytes(f, index)[offset]! ^ 1;
    await expect(read(f)).rejects.toMatchObject({ code: 'DEPLOYMENT' });
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])('never treats missing prerequisite %i as future-account absence', async index => {
    const f = vehicleIssuanceAdmissionFixture(); f.rows.splice(index, 1);
    await expect(read(f)).rejects.toMatchObject({ code: 'ACCOUNTS' });
  });

  it.each([0, 8, 9, 41, 113, 145, 178, 186, 187, 188])('rejects changed VehicleControl binding at byte %i', async offset => {
    const f = vehicleIssuanceAdmissionFixture(); bytes(f, 6)[offset] = bytes(f, 6)[offset]! ^ 1;
    await expect(read(f)).rejects.toThrow();
  });

  it('requires current policy key, refuses paused and malformed grace state, and never accepts a previous signer for new issuance', async () => {
    const paused = vehicleIssuanceAdmissionFixture(); bytes(paused, 6)[177] = 1; await expect(read(paused)).rejects.toMatchObject({ code: 'HELD' });
    const invalidPause = vehicleIssuanceAdmissionFixture(); bytes(invalidPause, 6)[177] = 2; await expect(read(invalidPause)).rejects.toMatchObject({ code: 'ACCOUNTS' });
    const previous = vehicleIssuanceAdmissionFixture(); new PublicKey(previous.policyAuthority).toBuffer().copy(bytes(previous, 6), 73);
    new PublicKey(previous.original.buyer).toBuffer().copy(bytes(previous, 6), 41); bytes(previous, 6).writeBigInt64LE(1700001000n, 105);
    await expect(read(previous)).rejects.toMatchObject({ code: 'IDENTITY' });
    const malformed = vehicleIssuanceAdmissionFixture(); bytes(malformed, 6).writeBigInt64LE(1n, 105); await expect(read(malformed)).rejects.toMatchObject({ code: 'ACCOUNTS' });
    const legitimate = vehicleIssuanceAdmissionFixture(); new PublicKey(legitimate.original.buyer).toBuffer().copy(bytes(legitimate, 6), 73); bytes(legitimate, 6).writeBigInt64LE(1n, 105);
    expect((await read(legitimate)).policyAuthority).toBe(legitimate.policyAuthority);
  });

  it.each([10, 11, 12, 13, 14, 15, 16])('holds every occupied future account %i instead of reauthorizing an original request', async index => {
    for (const kind of ['owner', 'executable', 'data'] as const) {
      const f = vehicleIssuanceAdmissionFixture(), proof = await read(f);
      f.rows.push({ address: new PublicKey(proof.source.accounts[index]!.address), owner: kind === 'owner' ? new PublicKey(VEHICLE_CRAFT_PROGRAM) : SystemProgram.programId,
        executable: kind === 'executable', data: kind === 'data' ? Buffer.of(1) : Buffer.alloc(0) });
      await expect(read(f)).rejects.toThrow();
    }
  });

  it.each(['buyer', 'site', 'operator', 'project'] as const)('rejects %s aliases against each request internal address', async external => {
    const f = vehicleIssuanceAdmissionFixture(), proof = await read(f);
    const internals = [...proof.source.accounts.slice(10).map(row => row.address), vehiclePda('vehicle_control')[0].toBase58(), VEHICLE_VRF_QUEUE,
      VEHICLE_CRAFT_PROGRAM, VEHICLE_VRF_PROGRAM, VEHICLE_CORE_PROGRAM, SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(), SYSVAR_SLOT_HASHES_PUBKEY.toBase58(),
      f.original.identity.collection, vehiclePda('vehicle_authority')[0].toBase58()];
    for (const address of internals) {
      const other = vehicleIssuanceAdmissionFixture(); changedOriginal(other, external === 'buyer' ? { buyer: address } : { terms: { ...other.original.terms, [external]: address } });
      await expect(read(other)).rejects.toMatchObject({ code: 'ORIGINAL' });
    }
  });

  it('refuses zero terms, overflowing funding and mismatched saved original/genesis before granting admission', async () => {
    for (const terms of [{ recipeVersion: 0 }, { recipeHash: '00'.repeat(32) }, { materialHash: '00'.repeat(32) }, { oracleBudget: '0' }, { oracleBudget: '18446744073709551615' }]) {
      const f = vehicleIssuanceAdmissionFixture(); changedOriginal(f, { terms: { ...f.original.terms, ...terms } });
      await expect(read(f)).rejects.toMatchObject({ code: 'ORIGINAL' });
    }
    const altered = vehicleIssuanceAdmissionFixture(); altered.original = { ...altered.original, buyer: altered.policyAuthority };
    await expect(read(altered)).rejects.toMatchObject({ code: 'ORIGINAL' });
    const foreign = vehicleIssuanceAdmissionFixture(); changedOriginal(foreign, { genesisHash: foreign.original.buyer }); await expect(read(foreign)).rejects.toMatchObject({ code: 'ORIGINAL' });
  });

  it.each(['opening', 'context', 'closing', 'clock', 'genesis-before', 'genesis-after', 'address', 'row-owner', 'queue-executable', 'queue-owner', 'length', 'unavailable'])('holds %s source incoherence', async kind => {
    const f = vehicleIssuanceAdmissionFixture(), getBank = f.rpc.getMultipleAccountsInfoAndContext; let calls = 0;
    if (kind === 'opening') f.rpc.getSlot = async () => 4;
    if (kind === 'closing') f.rpc.getSlot = async () => ++calls === 1 ? 20 : 19;
    if (kind === 'context') f.rpc.getMultipleAccountsInfoAndContext = async (keys, options) => ({ ...await getBank(keys, options), context: { slot: 19 } });
    if (kind === 'clock') bytes(f, 8).writeBigUInt64LE(19n);
    if (kind === 'genesis-before') f.rpc.getGenesisHash = async () => f.original.buyer;
    if (kind === 'genesis-after') f.rpc.getGenesisHash = async () => ++calls === 1 ? f.original.genesisHash : f.original.buyer;
    if (kind === 'address') f.rpc.getMultipleAccountsInfoAndContext = async (keys, options) => { const bank = await getBank(keys, options); bank.value[6] = { ...bank.value[6]!, address: new PublicKey(f.original.buyer) }; return bank; };
    if (kind === 'row-owner') f.rows[6]!.owner = SystemProgram.programId;
    if (kind === 'queue-executable') f.rows[7]!.executable = true;
    if (kind === 'queue-owner') f.rows[7]!.owner = SystemProgram.programId;
    if (kind === 'length') f.rpc.getMultipleAccountsInfoAndContext = async (keys, options) => { const bank = await getBank(keys, options); bank.value.pop(); return bank; };
    if (kind === 'unavailable') f.rpc.getGenesisHash = async () => { throw Error('offline'); };
    await expect(read(f)).rejects.toMatchObject({ reservationReleaseAuthorized: false });
  });

  it('pins the exact Rent sysvar, bound permit interval and unchanged escrow reserve', async () => {
    for (const mutate of [(f: ReturnType<typeof vehicleIssuanceAdmissionFixture>) => bytes(f, 9).writeDoubleLE(NaN, 8),
      (f: ReturnType<typeof vehicleIssuanceAdmissionFixture>) => bytes(f, 9).writeDoubleLE(-1, 8),
      (f: ReturnType<typeof vehicleIssuanceAdmissionFixture>) => bytes(f, 9).writeDoubleLE(3, 8),
      (f: ReturnType<typeof vehicleIssuanceAdmissionFixture>) => bytes(f, 9).writeBigUInt64LE(0xffffffffffffffffn),
      (f: ReturnType<typeof vehicleIssuanceAdmissionFixture>) => { f.rows[9]!.owner = SystemProgram.programId; },
      (f: ReturnType<typeof vehicleIssuanceAdmissionFixture>) => bytes(f, 8).writeBigInt64LE(1700000060n, 32),
      (f: ReturnType<typeof vehicleIssuanceAdmissionFixture>) => bytes(f, 8).writeBigInt64LE(1n, 32)]) {
      const f = vehicleIssuanceAdmissionFixture(); mutate(f); await expect(read(f)).rejects.toThrow();
    }
    const edge = vehicleIssuanceAdmissionFixture(); bytes(edge, 8).writeBigInt64LE(1700000059n, 32); expect((await read(edge)).unixTimestamp).toBe('1700000059');
  });

  it('detaches source bytes and configured trust before asynchronous closing callbacks can mutate them', async () => {
    const f = vehicleIssuanceAdmissionFixture(), hash = vehicleSha256(bytes(f, 6)), reader = createVehicleIssuanceAdmissionReader(() => f.rpc, f.trust, f.policyAuthority); let slots = 0;
    f.trust.craft.reviewedProgramDataSha256 = '00'.repeat(32);
    f.rpc.getSlot = async () => { if (++slots === 2) { bytes(f, 6)[177] = 1; bytes(f, 1)[45] = bytes(f, 1)[45]! ^ 1; } return 20; };
    const proof = await reader(f.original); expect(proof.source.accounts[6]).toMatchObject({ dataSha256: hash });
  });

  it.each(['deadline', 'cancel'] as const)('counts ignored %s RPC until actual work drains and admits no ninth abandoned request', async kind => {
    const f = vehicleIssuanceAdmissionFixture(); let release!: () => void, calls = 0;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.rpc.getGenesisHash = async () => { calls++; await blocked; return f.original.genesisHash; };
    const reader = createVehicleIssuanceAdmissionReader(() => f.rpc, f.trust, f.policyAuthority, { deadlineMs: kind === 'deadline' ? 50 : 1000 });
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const pending = controllers.map(c => reader(f.original, c.signal)), settled = Promise.allSettled(pending);
    await new Promise(resolve => setTimeout(resolve, 0)); if (kind === 'cancel') controllers.forEach(c => c.abort());
    const results = await settled; expect(results.every(r => r.status === 'rejected' && r.reason.code === 'DEADLINE')).toBe(true);
    await expect(reader(f.original)).rejects.toMatchObject({ code: 'BUSY' }); expect(calls).toBe(8); release();
    await new Promise(resolve => setTimeout(resolve, 0)); expect((await reader(f.original)).originalHash).toBe(f.original.originalHash);
  });

  it('never connects for pre-canceled calls, stops subsequent reads after caller cancellation, and rejects malformed options', async () => {
    const f = vehicleIssuanceAdmissionFixture(), controller = new AbortController(), connect = vi.fn(() => f.rpc);
    const reader = createVehicleIssuanceAdmissionReader(connect, f.trust, f.policyAuthority); controller.abort();
    await expect(reader(f.original, controller.signal)).rejects.toMatchObject({ code: 'DEADLINE' }); expect(connect).not.toHaveBeenCalled();
    const second = new AbortController(), slot = vi.spyOn(f.rpc, 'getSlot'); f.rpc.getGenesisHash = async () => { second.abort(); return f.original.genesisHash; };
    await expect(reader(f.original, second.signal)).rejects.toMatchObject({ code: 'DEADLINE' }); expect(slot).not.toHaveBeenCalled();
    for (const deadlineMs of [0, -1, NaN, 60001]) expect(() => createVehicleIssuanceAdmissionReader(connect, f.trust, f.policyAuthority, { deadlineMs })).toThrow();
  });
});
