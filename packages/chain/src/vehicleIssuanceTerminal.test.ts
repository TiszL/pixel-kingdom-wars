import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { createVehicleIssuanceTerminalReader, type VehicleIssuanceEvidenceRpc } from './vehicleIssuanceTerminal';
import { createVehicleIssuanceEvidenceReader, normalizeVehicleIssuanceOriginal } from './vehicleIssuanceEvidence';
import { vehicleIssuanceTerminalFixture } from './testFixtures/vehicleIssuanceTerminal';
import { vehicleIssuanceFixture } from './testFixtures/vehicleIssuance';
import { vehicleSha256, vehicleWins, VEHICLE_VRF_QUEUE } from './vehicleIssuanceProtocol';
const read = (f: ReturnType<typeof vehicleIssuanceTerminalFixture>) => createVehicleIssuanceTerminalReader(() => f.rpc, f.trust, async () => f.original)(f.original.rootId);
const attempt = (f: ReturnType<typeof vehicleIssuanceTerminalFixture>) => f.rows[8]!.data as Buffer;

describe('paid original vehicle normal-result source', () => {
  it.each(['won', 'lost'] as const)('proves an authenticated paid %s without any Core mint account or mint-acquisition authority', async outcome => {
    const f = vehicleIssuanceTerminalFixture(outcome, { oddsBps: 5000 }), reader = vi.spyOn(f.rpc, 'getMultipleAccountsInfoAndContext'), proof = await read(f);
    expect(proof).toMatchObject({ version: 1, rootId: f.original.rootId, attemptId: f.original.attemptId, buyer: f.original.buyer,
      permitId: f.original.permitId, originalHash: f.original.originalHash, outcome, paid: true, minted: false, mintSlot: 0,
      requestSlot: 10, resultSlot: 11, settlementSlot: 12, slot: 20, finalizedNormalResultObserved: true, finalizedMintObserved: false,
      transactionProofVerified: false, paymentAuthorized: false, activationAuthorized: false, reservationReleaseAuthorized: false });
    expect(proof.source.profile).toBe('paid-normal-result-12-v1'); expect(proof.source.accounts).toHaveLength(12);
    expect(reader.mock.calls[0]![0]).toHaveLength(12);
    expect(reader.mock.calls[0]![0].some(key => key.toBase58() === f.original.identity.assetId || key.toBase58() === f.original.identity.collection)).toBe(false);
    expect(vehicleWins(Buffer.from(proof.randomness, 'hex'), f.original.terms.oddsBps)).toBe(outcome === 'won');
    expect(Object.isFrozen(proof)).toBe(true); expect(Object.isFrozen(proof.source.accounts)).toBe(true);
    await expect(createVehicleIssuanceEvidenceReader(() => f.rpc, f.trust, async () => f.original)(f.original.rootId)).rejects.toThrow();
  });

  it('retains the exact existing minted proof while the terminal profile remains independently limited', async () => {
    const f = vehicleIssuanceFixture(), terminal = await read(f);
    const minted = await createVehicleIssuanceEvidenceReader(() => f.rpc, f.trust, async () => f.original)(f.original.rootId);
    expect(terminal).toMatchObject({ outcome: 'won', minted: true, mintSlot: 13, finalizedMintObserved: false });
    expect(minted).toMatchObject({ finalizedMintObserved: true, originalHash: terminal.originalHash, termsHash: terminal.termsHash,
      requestHash: terminal.requestHash, randomness: terminal.randomness, settlementSlot: terminal.settlementSlot, mintSlot: terminal.mintSlot });
    expect(minted.source.accounts).toHaveLength(14); expect(minted.source).not.toHaveProperty('profile');
    const bank = f.rpc.getMultipleAccountsInfoAndContext; f.rpc.getMultipleAccountsInfoAndContext = async (keys, options) => { const result = await bank(keys, options); f.rows[10]!.data = Buffer.of(0); return result; };
    // A result reader deliberately does not claim current Core mint validity.
    expect((await read(f)).outcome).toBe('won');
    await expect(createVehicleIssuanceEvidenceReader(() => f.rpc, f.trust, async () => f.original)(f.original.rootId)).rejects.toThrow();
  });

  it.each(['pending', 'pendingPaid', 'wonUnpaid', 'lostUnpaid'] as const)('keeps missing mint and %s state held rather than inventing normal loss', async state => {
    const f = vehicleIssuanceTerminalFixture(state === 'lostUnpaid' ? 'lost' : 'won');
    if (state.startsWith('pending')) { attempt(f)[513] = 0; attempt(f).writeBigUInt64LE(0n, 532); }
    attempt(f)[514] = state === 'pendingPaid' ? 1 : 0;
    await expect(read(f)).rejects.toMatchObject({ code: 'HELD', reservationReleaseAuthorized: false });
  });

  it.each(['lossMarkedWin', 'winMarkedLoss', 'lossMinted', 'unmintedSlot', 'invalidOutcome', 'invalidPaid', 'invalidMinted'] as const)('rejects an impossible normal-result state: %s', async state => {
    const f = vehicleIssuanceTerminalFixture(state === 'lossMarkedWin' || state === 'lossMinted' ? 'lost' : 'won');
    if (state === 'lossMarkedWin') attempt(f)[513] = 2;
    if (state === 'winMarkedLoss') attempt(f)[513] = 1;
    if (state === 'lossMinted') { attempt(f)[515] = 1; attempt(f).writeBigUInt64LE(13n, 548); }
    if (state === 'unmintedSlot') attempt(f).writeBigUInt64LE(13n, 548);
    if (state === 'invalidOutcome') attempt(f)[513] = 3;
    if (state === 'invalidPaid') attempt(f)[514] = 2;
    if (state === 'invalidMinted') attempt(f)[515] = 2;
    await expect(read(f)).rejects.toMatchObject({ code: 'ACCOUNTS', reservationReleaseAuthorized: false });
  });

  it.each([[524, 4], [532, 9], [540, 10], [540, 21], [548, 11], [548, 21]])('rejects an invalid paid/mint slot at %i=%i', async (offset, value) => {
    const f = vehicleIssuanceTerminalFixture('won', { minted: offset === 548 });
    attempt(f).writeBigUInt64LE(BigInt(value), offset);
    await expect(read(f)).rejects.toMatchObject({ code: 'ACCOUNTS' });
  });

  it.each([9, 41, 57, 73, 105, 121, 153, 185, 393, 425, 457, 465, 473, 516, 556])('binds every original attempt identity, full terms, fee and permit-consumption field (offset %i)', async offset => {
    const f = vehicleIssuanceTerminalFixture(); attempt(f)[offset] = attempt(f)[offset]! ^ 1;
    await expect(read(f)).rejects.toThrow();
  });

  it.each([6, 7, 8, 9])('rejects padding or a foreign owner of source account %i', async index => {
    const padded = vehicleIssuanceTerminalFixture(); padded.rows[index]!.data = Buffer.concat([padded.rows[index]!.data, Buffer.of(0)]);
    await expect(read(padded)).rejects.toThrow();
    const foreign = vehicleIssuanceTerminalFixture(); foreign.rows[index]!.owner = new PublicKey(foreign.original.buyer);
    await expect(read(foreign)).rejects.toMatchObject({ code: 'ACCOUNTS' });
  });

  it.each([1, 3, 5])('pins reviewed program code and excludes original requests before deployment %i', async index => {
    const f = vehicleIssuanceTerminalFixture(); f.rows[index]!.data[45] = f.rows[index]!.data[45]! ^ 1;
    await expect(read(f)).rejects.toMatchObject({ code: 'DEPLOYMENT' });
    const late = vehicleIssuanceTerminalFixture(), kind = index === 1 ? 'craft' : index === 3 ? 'provider' : 'core', bytes = Buffer.from(late.rows[index]!.data);
    bytes.writeBigUInt64LE(12n, 4); late.rows[index]!.data = bytes;
    late.trust[kind] = { ...late.trust[kind], reviewedDeploymentSlot: 12, reviewedProgramDataSha256: vehicleSha256(bytes) };
    await expect(read(late)).rejects.toMatchObject({ code: 'ACCOUNTS' });
  });

  it('holds missing source accounts, foreign queue/network, stale context and contradictory clock', async () => {
    const missing = vehicleIssuanceTerminalFixture(); missing.rows.splice(9, 1); await expect(read(missing)).rejects.toThrow();
    const queue = vehicleIssuanceTerminalFixture(); queue.rows.find(row => row.address.toBase58() === VEHICLE_VRF_QUEUE)!.owner = new PublicKey(queue.original.buyer); await expect(read(queue)).rejects.toThrow();
    const identity = vehicleIssuanceTerminalFixture(); identity.rpc.getGenesisHash = async () => identity.original.buyer; await expect(read(identity)).rejects.toMatchObject({ code: 'IDENTITY' });
    const stale = vehicleIssuanceTerminalFixture(), bank = stale.rpc.getMultipleAccountsInfoAndContext;
    stale.rpc.getMultipleAccountsInfoAndContext = async (keys, options) => ({ ...await bank(keys, options), context: { slot: 19 } }); await expect(read(stale)).rejects.toMatchObject({ code: 'ACCOUNTS' });
    const clock = vehicleIssuanceTerminalFixture(); (clock.rows.find(row => row.address.equals(SYSVAR_CLOCK_PUBKEY))!.data as Buffer).writeBigUInt64LE(19n); await expect(read(clock)).rejects.toThrow();
    const unavailable = vehicleIssuanceTerminalFixture(); unavailable.rpc.getGenesisHash = async () => { throw Error('provider offline'); }; await expect(read(unavailable)).rejects.toMatchObject({ code: 'UNAVAILABLE', reservationReleaseAuthorized: false });
  });

  it('binds the saved original and detaches the entire bank before later provider callbacks', async () => {
    const changed = vehicleIssuanceTerminalFixture(), { originalHash, ...raw } = changed.original;
    const other = normalizeVehicleIssuanceOriginal({ ...raw, terms: { ...raw.terms, materialHash: '22'.repeat(32) } });
    expect(other.originalHash).not.toBe(originalHash);
    await expect(createVehicleIssuanceTerminalReader(() => changed.rpc, changed.trust, async () => other)(other.rootId)).rejects.toThrow();
    const f = vehicleIssuanceTerminalFixture(), original = f.original.originalHash; let slots = 0;
    f.rpc.getSlot = async () => { if (++slots === 2) { attempt(f)[514] = 0; f.rows[1]!.data[45] = 0; } return 20; };
    expect((await read(f)).originalHash).toBe(original);
  });

  it('retains ignored-abort requests against bounded admission until their real work drains', async () => {
    const f = vehicleIssuanceTerminalFixture(); let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
    const rpc: VehicleIssuanceEvidenceRpc = { ...f.rpc, getGenesisHash: async () => { calls++; await wait; return f.original.genesisHash; } };
    const reader = createVehicleIssuanceTerminalReader(() => rpc, f.trust, async () => f.original, { deadlineMs: 5 });
    const timedOut = await Promise.allSettled(Array.from({ length: 8 }, () => reader(f.original.rootId)));
    expect(timedOut.every(result => result.status === 'rejected')).toBe(true);
    await expect(reader(f.original.rootId)).rejects.toMatchObject({ code: 'BUSY' }); expect(calls).toBe(8); release();
  });
});
