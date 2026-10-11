/** Current Charter policy observation only. No issuer, expiry policy or funded
 * admission authority. Past mint/cancellation recovery uses separate readers.
 * This bank does not inspect collection readiness, target assets or payer SOL;
 * later pause/key changes remain authoritative when a transaction executes. */
import type { CharterCreationEvidence, CharterCreationEvidenceRpc, CharterCreationEvidenceTrust } from './charterCreationEvidence';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { LOADER, MAX_PROGRAM_BYTES, DEADLINE_MS, MAX_PENDING, copyTrust, address, record, safeSlot,
  ownArray, copyKey, attestProgram, verifyCommon, digest, CharterCreationEvidenceError, type OwnedAccount } from './charterCreationAccounts';
import { decodeSeekerAuthority, SEEKER_AUTHORITY_ACCOUNT_BYTES } from './seekerAuthorityAccount';
export type CharterAdmissionErrorCode = 'INPUT' | 'IDENTITY' | 'DEPLOYMENT' | 'ACCOUNTS' | 'PAUSED' | 'SIGNER'
  | 'UNAVAILABLE' | 'DEADLINE' | 'BUSY';
export class CharterAdmissionError extends Error {
  readonly signingAuthorized = false;
  constructor(readonly code: CharterAdmissionErrorCode) { super(`Charter admission observation refused: ${code}`); this.name = 'CharterAdmissionError'; }
}
export interface CharterAdmissionObservation {
  readonly version: 1;
  readonly domain: Readonly<{ genesisHash: string; economyProgram: string; craftProgram: string }>;
  readonly authority: Readonly<{ address: string; currentPolicyKey: string; previousPolicyKey: string | null;
    previousValidUntil: bigint; admissionPaused: false }>;
  readonly craftControl: Readonly<{ address: string; admissionPaused: false }>;
  readonly expectedCurrentSigner: string; readonly currentSignerObserved: true;
  readonly slot: number; readonly unixTimestamp: bigint;
  readonly source: CharterCreationEvidence['source'];
  readonly transactionProofVerified: false; readonly mintAuthorized: false; readonly paymentAuthorized: false;
  readonly signingAuthorized: false; readonly activationAuthorized: false; readonly refundAuthorized: false;
  readonly reservationReleaseAuthorized: false;
}
function need(value: unknown, code: CharterAdmissionErrorCode): asserts value {
  if (!value) throw new CharterAdmissionError(code);
}
function fail(error: unknown): never {
  if (error instanceof CharterAdmissionError) throw error;
  if (error instanceof CharterCreationEvidenceError) throw new CharterAdmissionError(error.code === 'RESERVATION' ? 'INPUT' : error.code);
  throw new CharterAdmissionError('UNAVAILABLE');
}
function configured<T>(read: () => T): T { try { return read(); } catch (error) { return fail(error); } }

/** Trust and signer are application-owned inputs, copied once at construction.
 * This observes current policy facts only: no TTL/freshness choice, original
 * funding lookup, message persistence, signer call or mint-feasibility claim. */
export function createCharterAdmissionReader(
  connect: (signal: AbortSignal) => CharterCreationEvidenceRpc,
  inputTrust: CharterCreationEvidenceTrust, inputExpectedCurrentSigner: string, options: { deadlineMs?: number } = {},
): () => Promise<CharterAdmissionObservation> {
  need(typeof connect === 'function', 'INPUT');
  const trust = configured(() => copyTrust(inputTrust)), expectedCurrentSigner = configured(() => address(inputExpectedCurrentSigner));
  const settings = configured(() => record(options, '', 'deadlineMs')), deadlineMs = settings.deadlineMs ?? DEADLINE_MS;
  need(safeSlot(deadlineMs) && deadlineMs > 0 && deadlineMs <= DEADLINE_MS, 'INPUT');
  const programs = Object.freeze([trust.economy, trust.craft, trust.core]);
  const floor = Math.max(...programs.map(p => p.reviewedDeploymentSlot));
  const derive = (program: string, seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], new PublicKey(program))[0];
  const authorityAddress = derive(trust.economy.programId, 'seeker_authority');
  const configAddress = derive(trust.economy.programId, 'charter_config');
  const controlAddress = derive(trust.craft.programId, 'charter_control');
  const chain = Object.freeze({ economyProgram: trust.economy.programId, craftProgram: trust.craft.programId,
    craftControl: controlAddress.toBase58(), collection: derive(trust.craft.programId, 'charter_collection').toBase58(),
    collectionAuthority: derive(trust.craft.programId, 'charter_collection_authority').toBase58() });
  const addresses = programs.flatMap(p => {
    const id = new PublicKey(p.programId); return [id, PublicKey.findProgramAddressSync([id.toBuffer()], LOADER)[0]];
  });
  addresses.push(authorityAddress, configAddress, controlAddress, SYSVAR_CLOCK_PUBKEY);
  const caps = [36, MAX_PROGRAM_BYTES, 36, MAX_PROGRAM_BYTES, 36, MAX_PROGRAM_BYTES, SEEKER_AUTHORITY_ACCOUNT_BYTES, 170, 141, 40];
  let pending = 0;
  return async function read(): Promise<CharterAdmissionObservation> {
    need(pending < MAX_PENDING, 'BUSY'); pending++;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, done = false, released = false;
    const outstanding = new Set<Promise<unknown>>();
    const release = () => { if (done && !released && outstanding.size === 0) { released = true; pending--; } };
    const active = () => need(!controller.signal.aborted, 'DEADLINE');
    async function call<T>(operation: () => Promise<T>): Promise<T> {
      active(); const work = Promise.resolve().then(() => { active(); return operation(); }); outstanding.add(work);
      try { const result = await work; active(); return result; } finally { outstanding.delete(work); release(); }
    }
    const work = (async (): Promise<CharterAdmissionObservation> => {
      const rpc = connect(controller.signal);
      need(await call(() => rpc.getGenesisHash()) === trust.expectedGenesisHash, 'IDENTITY');
      const opening = await call(() => rpc.getSlot('finalized')); need(safeSlot(opening) && opening >= floor, 'DEPLOYMENT');
      const response = await call(() => rpc.getMultipleAccountsInfoAndContext(addresses.map(p => new PublicKey(p.toBytes())),
        { commitment: 'finalized', minContextSlot: opening }));
      need(response && safeSlot(response.context?.slot) && response.context.slot >= opening, 'ACCOUNTS');
      const observedSlot = response.context.slot, values = ownArray(response.value, addresses.length, 'ACCOUNTS');
      need(values.length === addresses.length, 'ACCOUNTS');
      // Copy the complete coherent bank before either closing provider await.
      const rows = values.map((value, i): OwnedAccount => {
        const row = record(value, 'address owner executable data', '', 'ACCOUNTS');
        need(typeof row.executable === 'boolean' && row.data instanceof Uint8Array && row.data.byteLength <= caps[i]!, 'ACCOUNTS');
        const rowAddress = copyKey(row.address, 'ACCOUNTS'); need(rowAddress.equals(addresses[i]!), 'IDENTITY');
        return { address: rowAddress, owner: copyKey(row.owner, 'ACCOUNTS'), executable: row.executable, data: Buffer.from(row.data) };
      });
      const closing = await call(() => rpc.getSlot('finalized')); need(safeSlot(closing) && closing >= observedSlot, 'ACCOUNTS');
      need(await call(() => rpc.getGenesisHash()) === trust.expectedGenesisHash, 'IDENTITY');
      programs.forEach((program, i) => attestProgram(rows[i * 2]!, rows[i * 2 + 1]!, program));
      const unixTimestamp = verifyCommon(rows[7]!, rows[8]!, rows[9]!, { chain }, observedSlot);
      let authority: ReturnType<typeof decodeSeekerAuthority>;
      try { authority = decodeSeekerAuthority(chain.economyProgram, trust.expectedGenesisHash, rows[6]!); }
      catch { throw new CharterAdmissionError('ACCOUNTS'); }
      need(!authority.admissionPaused && rows[8]!.data[137] === 0, 'PAUSED');
      // The chain accepts its previous key during grace. This reader's stricter
      // new-admission policy intentionally observes only the configured current key.
      need(authority.currentPolicyKey === expectedCurrentSigner, 'SIGNER');
      const source = Object.freeze({ trust: 'trusted-finalized-rpc-reviewed-program' as const, stateProvenance: trust.stateProvenance,
        genesisHash: trust.expectedGenesisHash, programs, accounts: Object.freeze(rows.map(row => Object.freeze({
          address: row.address.toBase58(), owner: row.owner.toBase58(), executable: row.executable, dataSha256: digest(row.data),
        }))) });
      active();
      return Object.freeze({ version: 1, domain: Object.freeze({ genesisHash: trust.expectedGenesisHash,
        economyProgram: chain.economyProgram, craftProgram: chain.craftProgram }),
        authority: Object.freeze({ address: authority.address, currentPolicyKey: authority.currentPolicyKey,
          previousPolicyKey: authority.previousPolicyKey, previousValidUntil: authority.previousValidUntil, admissionPaused: false }),
        craftControl: Object.freeze({ address: controlAddress.toBase58(), admissionPaused: false }),
        expectedCurrentSigner, currentSignerObserved: true, slot: observedSlot, unixTimestamp, source,
        transactionProofVerified: false, mintAuthorized: false, paymentAuthorized: false, signingAuthorized: false,
        activationAuthorized: false, refundAuthorized: false, reservationReleaseAuthorized: false });
    })();
    // One transport budget, eight outstanding operations maximum. Ignoring an
    // abort retains its slot until settlement and cannot launch later RPC stages.
    void work.then(() => { done = true; release(); }, () => { done = true; release(); });
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new CharterAdmissionError('DEADLINE')); }, deadlineMs);
      })]);
    } catch (error) { return fail(error); }
    finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  };
}
