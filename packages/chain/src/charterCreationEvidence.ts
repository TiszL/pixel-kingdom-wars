/** Original mint observations keep the B6j nonempty permit-ID contract. */
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { LOADER, MAX_PROGRAM_BYTES, MAX_CORE_BYTES, DEADLINE_MS, MAX_PENDING, need, safeSlot,
  record, ownArray, copyKey, uuid, copyTrust, copySaved, attestProgram, mintEvidence,
  CharterCreationEvidenceError, type OwnedAccount, type CharterCreationSavedRecord,
  type CharterCreationEvidenceTrust, type CharterCreationEvidenceRpc, type CharterCreationEvidence } from './charterCreationAccounts';
export { CharterCreationEvidenceError } from './charterCreationAccounts';
export type { CharterCreationSavedRecord, CharterCreationProgramTrust, CharterCreationEvidenceTrust,
  CharterCreationRawAccount, CharterCreationEvidenceRpc, CharterCreationEvidenceErrorCode,
  CharterCreationEvidence } from './charterCreationAccounts';

/** Only a private application loader over original committed records belongs
 * here. Never connect an HTTP-supplied expectation/loader or treat saved pins as
 * funding proof. Missing/malformed records hold; they never authorize a refund. */
export function createCharterCreationEvidenceReader(
  connect: (signal: AbortSignal) => CharterCreationEvidenceRpc,
  inputTrust: CharterCreationEvidenceTrust,
  loadSavedCreation: (creationIntentId: string) => Promise<CharterCreationSavedRecord | null>,
  options: { deadlineMs?: number } = {},
): (creationIntentId: string) => Promise<CharterCreationEvidence> {
  need(typeof connect === 'function' && typeof loadSavedCreation === 'function', 'INPUT');
  const trust = copyTrust(inputTrust), settings = record(options, '', 'deadlineMs');
  const deadlineMs = settings.deadlineMs ?? DEADLINE_MS;
  need(safeSlot(deadlineMs) && deadlineMs > 0 && deadlineMs <= DEADLINE_MS, 'INPUT');
  const programs = Object.freeze([trust.economy, trust.craft, trust.core]);
  const floor = Math.max(...programs.map(p => p.reviewedDeploymentSlot));
  let pending = 0;
  return async function read(creationIntentId: string): Promise<CharterCreationEvidence> {
    const requested = uuid(creationIntentId, 'INPUT'); need(pending < MAX_PENDING, 'BUSY'); pending++;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, done = false, released = false;
    const outstanding = new Set<Promise<unknown>>();
    const release = () => { if (done && !released && outstanding.size === 0) { released = true; pending--; } };
    const active = () => need(!controller.signal.aborted, 'DEADLINE');
    async function call<T>(operation: () => Promise<T>): Promise<T> {
      active(); const work = Promise.resolve().then(() => { active(); return operation(); }); outstanding.add(work);
      try { const result = await work; active(); return result; } finally { outstanding.delete(work); release(); }
    }
    const work = (async () => {
      const original = await call(() => loadSavedCreation(requested));
      // Own every saved primitive before opening transport or awaiting again.
      const saved = copySaved(original, requested, trust), c = saved.chain;
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
      const observedSlot = response.context.slot;
      const values = ownArray(response.value, addresses.length, 'ACCOUNTS'); need(values.length === addresses.length, 'ACCOUNTS');
      const rows = values.map((value, i): OwnedAccount => {
        // Missing data is never an independently authenticated cancellation.
        const row = record(value, 'address owner executable data', '', 'ACCOUNTS');
        need(typeof row.executable === 'boolean' && row.data instanceof Uint8Array && row.data.byteLength <= caps[i]!, 'ACCOUNTS');
        const address = copyKey(row.address, 'ACCOUNTS'); need(address.equals(addresses[i]!), 'IDENTITY');
        return { address, owner: copyKey(row.owner, 'ACCOUNTS'), executable: row.executable, data: Buffer.from(row.data) };
      });
      const closing = await call(() => rpc.getSlot('finalized')); need(safeSlot(closing) && closing >= observedSlot, 'ACCOUNTS');
      need(await call(() => rpc.getGenesisHash()) === trust.expectedGenesisHash, 'IDENTITY');
      programs.forEach((program, i) => attestProgram(rows[i * 2]!, rows[i * 2 + 1]!, program));
      active();
      return mintEvidence(rows, saved, observedSlot, trust);
    })();
    // A timed-out loader/provider that ignores abort still occupies its work
    // slot until it settles. Never accumulate unbounded abandoned operations.
    void work.then(() => { done = true; release(); }, () => { done = true; release(); });
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new CharterCreationEvidenceError('DEADLINE')); }, deadlineMs);
      })]);
    } catch (error) {
      if (error instanceof CharterCreationEvidenceError) throw error;
      throw new CharterCreationEvidenceError('UNAVAILABLE');
    } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  };
}
