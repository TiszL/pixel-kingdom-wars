/** Finalized pre-request state only. No balance/fee quote, signature or activation. */
import { PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js';
import { PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { vehicleAddress, vehiclePda, vehicleSha256, vehicleDiscriminator, vehicleTermsHash, vehicleFees, VEHICLE_CRAFT_PROGRAM, VEHICLE_VRF_PROGRAM, VEHICLE_VRF_QUEUE, type VehicleIssuanceOriginal } from './vehicleIssuanceProtocol';
import { need, safe, fields, copyTrust, attest, LOADER, normalizeVehicleIssuanceOriginal, VehicleIssuanceEvidenceError, type VehicleIssuanceEvidenceRpc, type VehicleIssuanceRawAccount, type VehicleIssuanceTrust, type VehicleIssuanceProgramTrust } from './vehicleIssuanceAccounts';
export { VehicleIssuanceEvidenceError } from './vehicleIssuanceAccounts';
export type { VehicleIssuanceEvidenceRpc, VehicleIssuanceTrust } from './vehicleIssuanceAccounts';

export interface VehicleIssuanceAdmissionEvidence {
  version: 1; originalHash: string; rootId: string; attemptId: string; permitId: string; buyer: string;
  termsHash: string; policyAuthority: string; genesisHash: string; unixTimestamp: string;
  openingSlot: number; slot: number; closingSlot: number; emptyAccountRentLamports: string;
  source: { profile: 'pre-request-17-v1'; trust: 'trusted-finalized-rpc-reviewed-program';
    stateProvenance: 'fresh-reviewed-deployment'; genesisHash: string;
    programs: readonly VehicleIssuanceProgramTrust[];
    accounts: readonly ({ address: string; absent: true } | { address: string; absent: false; owner: string; executable: boolean; dataSha256: string })[] };
  transactionProofVerified: false; paymentAuthorized: false; activationAuthorized: false; reservationReleaseAuthorized: false;
}
const DEADLINE_MS = 60_000, MAX_PENDING = 8;
const SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';

/** solana-rent 2.2.1 Rent::minimum_balance(0) from the same bank, using its 128-byte storage
 * overhead and exact bincode Rent layout. Refuse values outside safe f64/u64
 * conversion bounds; this is not a quote for all initialized account rents. */
function emptyRent(row: VehicleIssuanceRawAccount): bigint {
  need(!row.executable && row.owner.toBase58() === SYSVAR_OWNER && row.data.length === 17, 'ACCOUNTS');
  const bytes = Buffer.from(row.data), annual = bytes.readBigUInt64LE() * 128n, threshold = bytes.readDoubleLE(8);
  need(annual <= BigInt(Number.MAX_SAFE_INTEGER) && Number.isFinite(threshold) && threshold >= 0 && bytes[16]! <= 100, 'ACCOUNTS');
  const balance = Number(annual) * threshold;
  need(Number.isFinite(balance) && balance >= 0 && balance <= Number.MAX_SAFE_INTEGER, 'ACCOUNTS');
  return BigInt(Math.floor(balance));
}

export function createVehicleIssuanceAdmissionReader(
  connect: (signal: AbortSignal) => VehicleIssuanceEvidenceRpc,
  inputTrust: VehicleIssuanceTrust,
  inputPolicyAuthority: string,
  options: { deadlineMs?: number } = {},
) {
  need(typeof connect === 'function');
  const trust = copyTrust(inputTrust), policyAuthority = vehicleAddress(inputPolicyAuthority);
  const settings = fields(options, '', 'deadlineMs'), deadline = settings.deadlineMs ?? DEADLINE_MS;
  need(safe(deadline) && deadline > 0 && deadline <= DEADLINE_MS);
  const programs = [trust.craft, trust.provider, trust.core], floor = Math.max(...programs.map(p => p.reviewedDeploymentSlot));
  let pending = 0;
  return async (inputOriginal: VehicleIssuanceOriginal, signal?: AbortSignal): Promise<VehicleIssuanceAdmissionEvidence> => {
    const original = normalizeVehicleIssuanceOriginal(inputOriginal);
    need(original.genesisHash === trust.expectedGenesisHash, 'ORIGINAL');
    need(!signal?.aborted, 'DEADLINE'); need(pending < MAX_PENDING, 'BUSY'); pending++;
    const controller = new AbortController(), outstanding = new Set<Promise<unknown>>(), started = performance.now();
    let done = false, released = false, timer: ReturnType<typeof setTimeout> | undefined;
    const active = () => need(!controller.signal.aborted && performance.now() - started < deadline, 'DEADLINE');
    const release = () => { if (done && !released && outstanding.size === 0) { released = true; pending--; } };
    async function call<T>(fn: () => Promise<T>): Promise<T> {
      active(); const task = Promise.resolve().then(() => { active(); return fn(); }); outstanding.add(task);
      try { const result = await task; active(); return result; } finally { outstanding.delete(task); release(); }
    }
    let cancel!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      cancel = () => { controller.abort(); reject(new VehicleIssuanceEvidenceError('DEADLINE')); };
      signal?.addEventListener('abort', cancel, { once: true }); timer = setTimeout(cancel, deadline);
    });
    const work = (async (): Promise<VehicleIssuanceAdmissionEvidence> => {
      const rpc = connect(controller.signal); active();
      need(await call(() => rpc.getGenesisHash()) === trust.expectedGenesisHash, 'IDENTITY');
      const openingSlot = await call(() => rpc.getSlot('finalized')); need(safe(openingSlot) && openingSlot >= floor, 'DEPLOYMENT');
      const addresses = programs.flatMap(p => { const id = new PublicKey(p.programId); return [id, PublicKey.findProgramAddressSync([id.toBuffer()], LOADER)[0]]; });
      addresses.push(vehiclePda('vehicle_control')[0], new PublicKey(VEHICLE_VRF_QUEUE), SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY,
        vehiclePda('identity')[0], vehiclePda('vehicle_root', original.rootId)[0], vehiclePda('vehicle_attempt', original.attemptId)[0],
        vehiclePda('vehicle_permit', original.permitId)[0], vehiclePda('vehicle_app', original.rootId)[0],
        vehiclePda('vehicle_oracle', original.rootId)[0], new PublicKey(original.identity.assetId));
      const internals = [addresses[0]!, addresses[2]!, addresses[4]!, addresses[6]!, addresses[7]!, ...addresses.slice(10),
        SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY, SystemProgram.programId,
        new PublicKey(original.identity.collection), vehiclePda('vehicle_authority')[0]];
      for (const external of [original.buyer, original.terms.site, original.terms.operator, original.terms.project])
        need(!internals.some(key => key.toBase58() === external), 'ORIGINAL');
      need(original.terms.recipeVersion > 0 && [original.terms.recipeHash, original.terms.materialHash, original.terms.metadataHash].every(hash => !/^0+$/.test(hash)) && BigInt(original.terms.oracleBudget) > 0n, 'ORIGINAL');
      const reserve = BigInt(original.escrowRentReserve);
      need(reserve + BigInt(original.terms.oracleBudget) <= 0xffffffffffffffffn && reserve + vehicleFees().application <= 0xffffffffffffffffn, 'ORIGINAL');
      const caps = [36, 8 * 1024 * 1024, 36, 8 * 1024 * 1024, 36, 8 * 1024 * 1024, 189, 65536, 40, 17, 0, 0, 0, 0, 0, 0, 0];
      const response = await call(() => rpc.getMultipleAccountsInfoAndContext(addresses.map(a => new PublicKey(a.toBytes())), { commitment: 'finalized', minContextSlot: openingSlot }));
      need(response && safe(response.context?.slot) && response.context.slot >= openingSlot && Array.isArray(response.value) && response.value.length === addresses.length, 'ACCOUNTS');
      const slot = response.context.slot, rows = response.value.map((value, i): VehicleIssuanceRawAccount | null => {
        if (value === null) { need(i >= 10, 'ACCOUNTS'); return null; }
        const row = fields(value, 'address owner executable data');
        need(row.address instanceof PublicKey && row.owner instanceof PublicKey && typeof row.executable === 'boolean' && row.data instanceof Uint8Array && row.data.length <= caps[i]!, 'ACCOUNTS');
        const address = new PublicKey(row.address.toBytes()); need(address.equals(addresses[i]!), 'IDENTITY');
        return { address, owner: new PublicKey(row.owner.toBytes()), executable: row.executable, data: Buffer.from(row.data) };
      });
      const closingSlot = await call(() => rpc.getSlot('finalized')); need(safe(closingSlot) && closingSlot >= slot, 'ACCOUNTS');
      need(await call(() => rpc.getGenesisHash()) === trust.expectedGenesisHash, 'IDENTITY');
      programs.forEach((p, i) => attest(rows[i * 2]!, rows[i * 2 + 1]!, p));
      const control = rows[6]!, c = Buffer.from(control.data);
      need(!control.executable && control.owner.toBase58() === VEHICLE_CRAFT_PROGRAM && c.length === 189 && c.subarray(0, 8).equals(vehicleDiscriminator('account', 'VehicleControl')) && c[8] === 1, 'ACCOUNTS');
      need(c.subarray(9, 41).equals(new PublicKey(original.genesisHash).toBuffer()) && c.subarray(41, 73).equals(new PublicKey(policyAuthority).toBuffer()), 'IDENTITY');
      const previous = new PublicKey(c.subarray(73, 105)), previousUntil = c.readBigInt64LE(105);
      need(previousUntil >= 0n && (!previous.equals(PublicKey.default) || previousUntil === 0n), 'ACCOUNTS');
      need(c.subarray(113, 145).equals(new PublicKey(original.identity.collection).toBuffer()) && c.subarray(145, 177).equals(vehiclePda('vehicle_authority')[0].toBuffer()), 'IDENTITY');
      need(c[177] === 0 || c[177] === 1, 'ACCOUNTS'); need(c[177] === 0, 'HELD');
      need(c.readBigUInt64LE(178) === reserve && c[186] === vehiclePda('vehicle_control')[1] && c[187] === vehiclePda('vehicle_collection')[1] && c[188] === vehiclePda('vehicle_authority')[1], 'ACCOUNTS');
      const queue = rows[7]!, clock = rows[8]!;
      need(!queue.executable && queue.owner.toBase58() === VEHICLE_VRF_PROGRAM, 'ACCOUNTS');
      need(!clock.executable && clock.owner.toBase58() === SYSVAR_OWNER && clock.data.length === 40, 'ACCOUNTS');
      const clockBytes = Buffer.from(clock.data), unixTimestamp = clockBytes.readBigInt64LE(32), expiry = BigInt(original.permitExpiry);
      need(clockBytes.readBigUInt64LE() === BigInt(slot) && unixTimestamp > 0n, 'ACCOUNTS');
      need(expiry > unixTimestamp && expiry - unixTimestamp <= BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec), 'HELD');
      const emptyAccountRentLamports = emptyRent(rows[9]!); need(reserve >= emptyAccountRentLamports, 'HELD');
      // Anchor init accepts a pre-funded empty System PDA; empty_system likewise
      // does not require zero lamports. Balances are deliberately not a quote.
      rows.slice(10).forEach(row => need(row === null || (!row.executable && row.owner.equals(SystemProgram.programId) && row.data.length === 0), 'HELD'));
      active();
      return Object.freeze({ version: 1, originalHash: original.originalHash, rootId: original.rootId, attemptId: original.attemptId,
        permitId: original.permitId, buyer: original.buyer, termsHash: vehicleTermsHash(original), policyAuthority,
        genesisHash: trust.expectedGenesisHash, unixTimestamp: unixTimestamp.toString(), openingSlot, slot, closingSlot, emptyAccountRentLamports: emptyAccountRentLamports.toString(),
        source: Object.freeze({ profile: 'pre-request-17-v1', trust: 'trusted-finalized-rpc-reviewed-program', stateProvenance: trust.stateProvenance, genesisHash: trust.expectedGenesisHash,
          programs: Object.freeze(programs), accounts: Object.freeze(rows.map((row, i) => row === null ? Object.freeze({ address: addresses[i]!.toBase58(), absent: true as const }) : Object.freeze({ address: row.address.toBase58(), absent: false as const, owner: row.owner.toBase58(), executable: row.executable, dataSha256: vehicleSha256(row.data) }))) }),
        transactionProofVerified: false, paymentAuthorized: false, activationAuthorized: false, reservationReleaseAuthorized: false });
    })();
    void work.then(() => { done = true; release(); }, () => { done = true; release(); });
    try { return await Promise.race([work, stopped]); }
    catch (error) { if (error instanceof VehicleIssuanceEvidenceError) throw error; throw new VehicleIssuanceEvidenceError('UNAVAILABLE'); }
    finally { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); }
  };
}
