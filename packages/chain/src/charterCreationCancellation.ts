/** Original Charter cancellation observations only. A private application loader
 * must supply the complete protected inventory of every potentially exposed
 * permit, including uncertain/failed submissions and retries. Version1 appends
 * immutable messages only: revision equals count, and an explicit revision0
 * head records the loader's never-issued claim. These supplied fields are not
 * authenticated funding, protected-inventory, signing or refund authority here. */
import type { CharterCreationEvidence, CharterCreationEvidenceRpc, CharterCreationEvidenceTrust,
  CharterCreationSavedRecord } from './charterCreationEvidence';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { CHARTER_REGISTRATION_PERMIT_BYTES, decodeCharterRegistrationPermit, hashCharterRegistrationPayload } from './charterProtocol';
import { LOADER, MAX_PROGRAM_BYTES, MAX_CORE_BYTES, MAX_PERMITS, DEADLINE_MS, MAX_PENDING,
  safeSlot, record, ownArray, copyKey, uuid, copyTrust, copyOriginal, digest,
  attestProgram, verifyCommon, verifyCollection, mintEvidence, CharterCreationEvidenceError,
  type OwnedAccount } from './charterCreationAccounts';

export type CharterCreationCancellationOriginal = Omit<CharterCreationSavedRecord, 'issuedPermitIds'>;
export interface CharterCreationCancellationSavedRecord {
  readonly original: CharterCreationCancellationOriginal;
  readonly permitInventory: {
    readonly version: 1; readonly revision: string; readonly count: number;
    readonly messages: readonly Uint8Array[];
  };
}
export interface CharterCreationCancellationInventory {
  readonly version: 1; readonly revision: string; readonly count: number;
  readonly messages: readonly Readonly<{ messageHex: string; permitId: string; expiry: bigint }>[];
}
export type CharterCreationCancellationErrorCode = 'INPUT' | 'RESERVATION' | 'INVENTORY' | 'IDENTITY' | 'DEPLOYMENT'
  | 'ACCOUNTS' | 'LIVE_PERMIT' | 'UNAVAILABLE' | 'DEADLINE' | 'BUSY';
export class CharterCreationCancellationError extends Error {
  readonly reservationReleaseAuthorized = false;
  constructor(readonly code: CharterCreationCancellationErrorCode) {
    super(`Charter cancellation observation refused: ${code}`); this.name = 'CharterCreationCancellationError';
  }
}
export type CharterCreationCancellationSource = Omit<CharterCreationEvidence['source'], 'accounts'> & {
  readonly accounts: readonly Readonly<{ address: string; owner: string | null; executable: boolean | null; dataSha256: string | null }>[];
};
interface ObservationBase {
  readonly version: 1;
  readonly original: CharterCreationCancellationOriginal;
  readonly inventory: CharterCreationCancellationInventory;
  readonly slot: number; readonly unixTimestamp: bigint;
  readonly source: CharterCreationCancellationSource;
  readonly inventoryAuthenticated: false; readonly transactionProofVerified: false;
  readonly paymentAuthorized: false; readonly activationAuthorized: false;
  readonly signingAuthorized: false; readonly refundAuthorized: false;
  readonly reservationReleaseAuthorized: false;
}
export type CharterCreationCancellationObservation = ObservationBase & (
  { readonly outcome: 'minted'; readonly mint: CharterCreationEvidence }
  | { readonly outcome: 'absent-after-expiry' }
);

function need(value: unknown, code: CharterCreationCancellationErrorCode): asserts value {
  if (!value) throw new CharterCreationCancellationError(code);
}
function translated<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof CharterCreationEvidenceError) throw new CharterCreationCancellationError(error.code);
    throw error;
  }
}
function copyInventory(value: unknown, original: CharterCreationCancellationOriginal): CharterCreationCancellationInventory {
  try {
    const r = record(value, 'version revision count messages', '', 'RESERVATION');
    // Count is bounded before any parsing/allocation. v1 has no tombstones or
    // mutable issuance rows: one immutable append advances both count and head.
    need(r.version === 1 && safeSlot(r.count) && r.count <= MAX_PERMITS && r.revision === String(r.count), 'INVENTORY');
    const inputs = ownArray(r.messages, MAX_PERMITS, 'RESERVATION'); need(inputs.length === r.count, 'INVENTORY');
    const c = original.chain, key = (v: string) => new PublicKey(v);
    const payloadHash = hashCharterRegistrationPayload({ config: key(c.config), craftProgram: key(c.craftProgram), craftControl: key(c.craftControl),
      collection: key(c.collection), collectionAuthority: key(c.collectionAuthority), charter: key(c.charter), asset: key(c.asset),
      assetBinding: key(c.assetBinding), freezeAuthority: key(c.freezeAuthority), executor: key(c.executor), creationReceipt: key(c.creationReceipt),
      clanId: original.clanId, leader: key(original.payer), creationIntentId: original.creationIntentId,
      metadataHash: Buffer.from(original.metadata.hash, 'hex'), admissionCommitment: Buffer.from(original.admissionCommitment, 'hex') });
    const messages = inputs.map(value => {
      need(value instanceof Uint8Array && value.byteLength === CHARTER_REGISTRATION_PERMIT_BYTES, 'INVENTORY');
      const bytes = Buffer.from(value), permit = decodeCharterRegistrationPermit(bytes);
      need(permit.genesisHash.toBase58() === c.genesisHash && permit.programId.toBase58() === c.economyProgram
        && permit.wallet.toBase58() === original.payer && Buffer.from(permit.payloadHash).equals(payloadHash), 'INVENTORY');
      return Object.freeze({ messageHex: bytes.toString('hex'), permitId: Buffer.from(permit.permitId).toString('hex'), expiry: permit.expiry });
    });
    need(new Set(messages.map(m => m.permitId)).size === messages.length, 'INVENTORY');
    return Object.freeze({ version: 1, revision: r.revision as string, count: r.count, messages: Object.freeze(messages) });
  } catch { throw new CharterCreationCancellationError('INVENTORY'); }
}

/** Future consumers must atomically recheck this exact original and inventory
 * against their protected durable head. No consumer or issuer is mounted here. */
export function createCharterCreationCancellationReader(
  connect: (signal: AbortSignal) => CharterCreationEvidenceRpc,
  inputTrust: CharterCreationEvidenceTrust,
  load: (creationIntentId: string) => Promise<CharterCreationCancellationSavedRecord | null>,
  options: { deadlineMs?: number } = {},
): (creationIntentId: string) => Promise<CharterCreationCancellationObservation> {
  need(typeof connect === 'function' && typeof load === 'function', 'INPUT');
  const trust = translated(() => copyTrust(inputTrust)), settings = translated(() => record(options, '', 'deadlineMs'));
  const deadlineMs = settings.deadlineMs ?? DEADLINE_MS;
  need(safeSlot(deadlineMs) && deadlineMs > 0 && deadlineMs <= DEADLINE_MS, 'INPUT');
  const programs = Object.freeze([trust.economy, trust.craft, trust.core]);
  const floor = Math.max(...programs.map(p => p.reviewedDeploymentSlot));
  let pending = 0;
  return async function read(creationIntentId: string): Promise<CharterCreationCancellationObservation> {
    const requested = translated(() => uuid(creationIntentId, 'INPUT')); need(pending < MAX_PENDING, 'BUSY'); pending++;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, done = false, released = false;
    const outstanding = new Set<Promise<unknown>>();
    const release = () => { if (done && !released && outstanding.size === 0) { released = true; pending--; } };
    const active = () => need(!controller.signal.aborted, 'DEADLINE');
    async function call<T>(operation: () => Promise<T>): Promise<T> {
      active(); const work = Promise.resolve().then(() => { active(); return operation(); }); outstanding.add(work);
      try { const result = await work; active(); return result; } finally { outstanding.delete(work); release(); }
    }
    const work = (async (): Promise<CharterCreationCancellationObservation> => {
      const input = await call(() => load(requested));
      const saved = record(input, 'original', 'permitInventory', 'RESERVATION');
      // Copy every saved primitive and full message before opening transport.
      const original = copyOriginal(saved.original, requested, trust), inventory = copyInventory(saved.permitInventory, original), c = original.chain;
      const rpc = connect(controller.signal);
      need(await call(() => rpc.getGenesisHash()) === trust.expectedGenesisHash, 'IDENTITY');
      const opening = await call(() => rpc.getSlot('finalized')); need(safeSlot(opening) && opening >= floor, 'DEPLOYMENT');
      const addresses = programs.flatMap(p => {
        const id = new PublicKey(p.programId); return [id, PublicKey.findProgramAddressSync([id.toBuffer()], LOADER)[0]];
      });
      addresses.push(...[c.config, c.craftControl, c.charter, c.creationReceipt, c.assetBinding, c.asset, c.collection].map(p => new PublicKey(p)), SYSVAR_CLOCK_PUBKEY);
      const caps = [36, MAX_PROGRAM_BYTES, 36, MAX_PROGRAM_BYTES, 36, MAX_PROGRAM_BYTES, 170, 141, 280, 154, 90, MAX_CORE_BYTES, MAX_CORE_BYTES, 40];
      const response = await call(() => rpc.getMultipleAccountsInfoAndContext(addresses.map(p => new PublicKey(p.toBytes())), { commitment: 'finalized', minContextSlot: opening }));
      need(response && safeSlot(response.context?.slot) && response.context.slot >= opening, 'ACCOUNTS');
      const observedSlot = response.context.slot, values = ownArray(response.value, addresses.length, 'ACCOUNTS');
      need(values.length === addresses.length, 'ACCOUNTS');
      const rows = values.map((value, i): OwnedAccount | null => {
        if (value === null && i >= 8 && i <= 11) return null;
        const row = record(value, 'address owner executable data', '', 'ACCOUNTS');
        need(typeof row.executable === 'boolean' && row.data instanceof Uint8Array && row.data.byteLength <= caps[i]!, 'ACCOUNTS');
        const address = copyKey(row.address, 'ACCOUNTS'); need(address.equals(addresses[i]!), 'IDENTITY');
        return { address, owner: copyKey(row.owner, 'ACCOUNTS'), executable: row.executable, data: Buffer.from(row.data) };
      });
      // Detached bank bytes are final before either closing provider await.
      const closing = await call(() => rpc.getSlot('finalized')); need(safeSlot(closing) && closing >= observedSlot, 'ACCOUNTS');
      need(await call(() => rpc.getGenesisHash()) === trust.expectedGenesisHash, 'IDENTITY');
      programs.forEach((program, i) => attestProgram(rows[i * 2]!, rows[i * 2 + 1]!, program));
      const unixTimestamp = verifyCommon(rows[6]!, rows[7]!, rows[13]!, original, observedSlot);
      const base = { version: 1 as const, original, inventory, slot: observedSlot, unixTimestamp,
        inventoryAuthenticated: false as const, transactionProofVerified: false as const, paymentAuthorized: false as const,
        activationAuthorized: false as const, signingAuthorized: false as const, refundAuthorized: false as const, reservationReleaseAuthorized: false as const };
      if (rows[9] !== null) {
        need(rows.every((row): row is OwnedAccount => row !== null), 'ACCOUNTS');
        const mint = mintEvidence(rows as OwnedAccount[], { ...original, issuedPermitIds: inventory.messages.map(m => m.permitId) }, observedSlot, trust);
        active(); return Object.freeze({ ...base, outcome: 'minted' as const, mint, source: mint.source });
      }
      need(rows.slice(8, 12).every(row => row === null), 'ACCOUNTS');
      verifyCollection(rows[12]!, original, false);
      need(inventory.messages.every(message => unixTimestamp > message.expiry), 'LIVE_PERMIT');
      const source = Object.freeze({ trust: 'trusted-finalized-rpc-reviewed-program' as const, stateProvenance: trust.stateProvenance,
        genesisHash: trust.expectedGenesisHash, programs, accounts: Object.freeze(rows.map((row, i) => Object.freeze({ address: addresses[i]!.toBase58(),
          owner: row?.owner.toBase58() ?? null, executable: row?.executable ?? null, dataSha256: row ? digest(row.data) : null }))) });
      active(); return Object.freeze({ ...base, outcome: 'absent-after-expiry' as const, source });
    })();
    // One budget spans loader and transport. Ignored aborts keep their bounded
    // slots until the abandoned operation settles, including closing calls.
    void work.then(() => { done = true; release(); }, () => { done = true; release(); });
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new CharterCreationCancellationError('DEADLINE')); }, deadlineMs);
      })]);
    } catch (error) {
      if (error instanceof CharterCreationCancellationError) throw error;
      if (error instanceof CharterCreationEvidenceError) throw new CharterCreationCancellationError(error.code);
      throw new CharterCreationCancellationError('UNAVAILABLE');
    } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  };
}
