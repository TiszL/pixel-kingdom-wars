/** Historical SGT facts, conditional on a configured trusted archival RPC's
 * exhaustive finalized address index. A genesis hash does not authenticate a
 * provider. This reader neither discovers a linked wallet nor grants mining
 * eligibility. Unknown history is unavailable, never a negative holding.
 *
 * Narrow support: a direct createAccount + InitializeAccount3 generation and
 * no successful writable reference to the mint OR token account from interval
 * start through the sampled bank. Canonical ATA creation is supported with a complete, exact level-2 CPI trace; other CPI creation and recycled accounts refuse.
 */
import { PublicKey, SystemProgram, SystemInstruction, SYSVAR_RENT_PUBKEY, TransactionInstruction, VersionedMessage, type AccountInfo, type Connection, type ConfirmedSignatureInfo, type VersionedTransactionResponse } from '@solana/web3.js';
import { unpackMint, unpackAccount, getMetadataPointerState, getTokenGroupMemberState, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, ExtensionType, TokenInstruction, decodeInitializeMintInstruction, decodeInitializeMint2Instruction, createInitializeMintInstruction, createInitializeMint2Instruction } from '@solana/spl-token';
import { SEEKER } from '@shardkeep/shared';
import bs58 from 'bs58';
import { checkSgtMint } from './seeker';

export type MiningSeekerHoldingReader = Pick<Connection, 'getGenesisHash' | 'getSlot' | 'getMultipleAccountsInfoAndContext' | 'getSignaturesForAddress' | 'getTransaction' | 'getBlockTime' | 'getBlockSignatures'>;
export type MiningSeekerHoldingSource = MiningSeekerHoldingReader | ((signal: AbortSignal) => MiningSeekerHoldingReader);
export interface MiningSeekerHoldingInput { linkedWallet: string; mint: string; tokenAccount: string; startAt: Date; endAt: Date }
/** Canonical Token-2022 account for the private mining qualification adapter. */
export function miningSeekerTokenAccount(linkedWallet: string, mint: string): string {
  return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(linkedWallet), true, TOKEN_2022_PROGRAM_ID).toBase58();
}
type Code = 'INVALID_INPUT' | 'GENESIS_MISMATCH' | 'CONTEXT_INVALID' | 'ACCOUNT_INVALID' | 'HISTORY_INCOMPLETE' | 'EVIDENCE_CONFLICT' | 'UNSUPPORTED_HISTORY' | 'INTERVAL_NOT_CLOSED' | 'HOLDING_CHANGED' | 'BIRTH_OUTSIDE_COVERAGE' | 'SOURCE_DISAGREEMENT' | 'TOO_LARGE' | 'TIMEOUT' | 'READER_UNAVAILABLE';
export class MiningSeekerHoldingError extends Error {
  constructor(readonly code: Code) { super(`Historical SGT holding unavailable: ${code}`); this.name = 'MiningSeekerHoldingError'; }
}
function fail(code: Code): never { throw new MiningSeekerHoldingError(code); }
/** Transport/storage ceilings, not game policy. Exhaustion never truncates. */
export const MINING_SEEKER_HOLDING_LIMITS = Object.freeze({ maxCalls: 8192, maxSignatureRows: 4096, maxTransactions: 2048, maxBlockSignatures: 65536, maxAccountBytes: 65536, maxEvidenceBytes: 16 * 1024 * 1024, timeoutMs: 20000 });
const PAGE_SIZE = 1000;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const time = (v: unknown): v is number => integer(v) && Number.isSafeInteger(v * 1000);
function key(v: unknown): v is string { try { return typeof v === 'string' && v.length <= 44 && new PublicKey(v).toBase58() === v; } catch { return false; } }
function signature(v: unknown): v is string { try { return typeof v === 'string' && v.length <= 88 && bs58.decode(v).length === 64 && bs58.encode(bs58.decode(v)) === v; } catch { return false; } }
function inputFacts(input: MiningSeekerHoldingInput) {
  if (!input || Object.keys(input).some(k => !['linkedWallet', 'mint', 'tokenAccount', 'startAt', 'endAt'].includes(k)) || ![input.linkedWallet, input.mint, input.tokenAccount].every(key)
    || new Set([input.linkedWallet, input.mint, input.tokenAccount]).size !== 3 || !(input.startAt instanceof Date) || !(input.endAt instanceof Date)
    || !integer(input.startAt.getTime()) || !integer(input.endAt.getTime()) || input.startAt >= input.endAt) fail('INVALID_INPUT');
  return { linkedWallet: input.linkedWallet, mint: input.mint, tokenAccount: input.tokenAccount, startMs: input.startAt.getTime(), endMs: input.endAt.getTime() };
}
type Facts = ReturnType<typeof inputFacts>;
interface AccountWire { owner: string; executable: boolean; lamports: number; data: string }
interface BodyWire { signature: string; slot: number; blockTime: number; message: string; signatures: string[]; err: unknown; preBalances: number[]; loadedAddresses: { writable: string[]; readonly: string[] } | null; innerInstructions: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string; stackHeight?: number | null }[] }[] | null }
interface BlockWire { slot: number; blockTime: number; signatures: string[] }
interface Transcript { version: 1; facts: Facts; genesisBefore: string; genesisAfter: string; finalizedBefore: number; finalizedAfter: number; bank: number; bankTime: number; accounts: AccountWire[]; histories: { address: string; pages: ConfirmedSignatureInfo[][] }[]; blocks: BlockWire[]; bodies: BodyWire[] }
function accountWire(info: AccountInfo<Buffer> | null): AccountWire {
  if (!info || !(info.owner instanceof PublicKey) || !Buffer.isBuffer(info.data) || info.executable !== false || !integer(info.lamports)) fail('ACCOUNT_INVALID');
  if (info.data.length > MINING_SEEKER_HOLDING_LIMITS.maxAccountBytes) fail('TOO_LARGE');
  return { owner: info.owner.toBase58(), executable: false, lamports: info.lamports, data: info.data.toString('base64') };
}
function bytes(value: string, maximum: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4) fail('TOO_LARGE');
  const raw = Buffer.from(value, 'base64'); if (raw.toString('base64') !== value || raw.length > maximum) fail('EVIDENCE_CONFLICT'); return raw;
}
function checkTlv(tlv: Buffer) {
  const types = new Set<number>(); let offset = 0;
  while (offset < tlv.length) {
    if (tlv.subarray(offset).every(byte => byte === 0)) break;
    if (offset + 4 > tlv.length) fail('ACCOUNT_INVALID');
    const type = tlv.readUInt16LE(offset), size = tlv.readUInt16LE(offset + 2);
    if (type === 0 || types.has(type) || offset + 4 + size > tlv.length) fail('ACCOUNT_INVALID');
    if ((type === ExtensionType.MetadataPointer && size !== 64) || (type === ExtensionType.TokenGroupMember && size !== 72)) fail('ACCOUNT_INVALID');
    types.add(type); offset += 4 + size;
  }
}
function checkAccounts(t: Transcript) {
  if (!Array.isArray(t.accounts) || t.accounts.length !== 2) fail('ACCOUNT_INVALID');
  const unpack = (a: AccountWire): AccountInfo<Buffer> => {
    if (!a || a.owner !== SEEKER.sgt.tokenProgram || a.executable !== false || !integer(a.lamports) || a.lamports === 0) fail('ACCOUNT_INVALID');
    return { owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: a.lamports, data: bytes(a.data, MINING_SEEKER_HOLDING_LIMITS.maxAccountBytes), rentEpoch: 0 };
  };
  try {
    const mintInfo = unpack(t.accounts[0]!), tokenInfo = unpack(t.accounts[1]!);
    if (mintInfo.data.length < 166 || mintInfo.data.readUInt32LE(0) !== 1 || mintInfo.data[45] !== 1 || ![0, 1].includes(mintInfo.data.readUInt32LE(46)) || !mintInfo.data.subarray(82, 165).every(byte => byte === 0)
      || tokenInfo.data.length < 165 || ![1, 2].includes(tokenInfo.data[108]!) || ![0, 1].includes(tokenInfo.data.readUInt32LE(72)) || tokenInfo.data.readUInt32LE(109) !== 0 || ![0, 1].includes(tokenInfo.data.readUInt32LE(129))) fail('ACCOUNT_INVALID');
    const mint = unpackMint(new PublicKey(t.facts.mint), mintInfo, TOKEN_2022_PROGRAM_ID); checkTlv(mint.tlvData);
    const pointer = getMetadataPointerState(mint), member = getTokenGroupMemberState(mint);
    if (!mint.isInitialized || !checkSgtMint(t.facts.mint, { owner: SEEKER.sgt.tokenProgram, data: { parsed: { type: 'mint', info: {
      decimals: mint.decimals, supply: String(mint.supply), mintAuthority: mint.mintAuthority?.toBase58() ?? null,
      extensions: [{ extension: 'metadataPointer', state: { authority: pointer?.authority?.toBase58() ?? null, metadataAddress: pointer?.metadataAddress?.toBase58() ?? null } },
        { extension: 'tokenGroupMember', state: { group: member?.group?.toBase58() ?? null } }],
    } } } })) fail('ACCOUNT_INVALID');
    if (member?.mint?.toBase58() !== t.facts.mint) fail('ACCOUNT_INVALID');
    const account = unpackAccount(new PublicKey(t.facts.tokenAccount), tokenInfo, TOKEN_2022_PROGRAM_ID); checkTlv(account.tlvData);
    if (!account.isInitialized || account.mint.toBase58() !== t.facts.mint || account.owner.toBase58() !== t.facts.linkedWallet || account.amount !== 1n) fail('ACCOUNT_INVALID');
  } catch (error) { if (error instanceof MiningSeekerHoldingError) throw error; fail('ACCOUNT_INVALID'); }
}
function bodyWire(tx: VersionedTransactionResponse | null): BodyWire {
  if (!tx) fail('HISTORY_INCOMPLETE');
  if (!tx.meta || !time(tx.blockTime) || (tx.version !== undefined && tx.version !== 0 && tx.version !== 'legacy')) fail('EVIDENCE_CONFLICT');
  return { signature: tx.transaction.signatures[0]!, slot: tx.slot, blockTime: tx.blockTime, message: Buffer.from(tx.transaction.message.serialize()).toString('base64'), signatures: [...tx.transaction.signatures],
    err: structuredClone(tx.meta.err), preBalances: [...tx.meta.preBalances], loadedAddresses: tx.meta.loadedAddresses ? { writable: tx.meta.loadedAddresses.writable.map(k => k.toBase58()), readonly: tx.meta.loadedAddresses.readonly.map(k => k.toBase58()) } : null,
    innerInstructions: tx.meta.innerInstructions == null ? null : structuredClone(tx.meta.innerInstructions) };
}
function decodeBody(body: BodyWire) {
  if (!body || !signature(body.signature) || !integer(body.slot) || !time(body.blockTime) || !Array.isArray(body.signatures) || !body.signatures.every(signature) || body.signatures[0] !== body.signature
    || (body.err !== null && (typeof body.err !== 'object' || body.err === undefined))) fail('EVIDENCE_CONFLICT');
  const msg = VersionedMessage.deserialize(bytes(body.message, 65536));
  if (msg.header.numRequiredSignatures < 1 || body.signatures.length !== msg.header.numRequiredSignatures) fail('EVIDENCE_CONFLICT');
  const loaded = body.loadedAddresses;
  if (loaded && (!Array.isArray(loaded.writable) || !Array.isArray(loaded.readonly) || ![...loaded.writable, ...loaded.readonly].every(key))) fail('EVIDENCE_CONFLICT');
  const keys = msg.getAccountKeys({ accountKeysFromLookups: loaded ? { writable: loaded.writable.map(k => new PublicKey(k)), readonly: loaded.readonly.map(k => new PublicKey(k)) } : null });
  if (keys.length > 256 || new Set(Array.from({ length: keys.length }, (_, i) => keys.get(i)!.toBase58())).size !== keys.length || msg.header.numRequiredSignatures > keys.staticAccountKeys.length
    || !Array.isArray(body.preBalances) || body.preBalances.length !== keys.length || !body.preBalances.every(integer)) fail('EVIDENCE_CONFLICT');
  const validIndex = (v: number) => integer(v) && v < keys.length;
  if (msg.compiledInstructions.length > 256) fail('TOO_LARGE');
  for (const ix of msg.compiledInstructions) if (!validIndex(ix.programIdIndex) || !ix.accountKeyIndexes.every(validIndex)) fail('EVIDENCE_CONFLICT');
  if (body.err === null && !Array.isArray(body.innerInstructions)) fail('UNSUPPORTED_HISTORY');
  const groups = body.innerInstructions ?? [];
  if (!Array.isArray(groups) || groups.length > 256 || new Set(groups.map(g => g.index)).size !== groups.length) fail('EVIDENCE_CONFLICT');
  for (const g of groups) {
    if (!integer(g.index) || g.index >= msg.compiledInstructions.length || !Array.isArray(g.instructions) || g.instructions.length > 256) fail('EVIDENCE_CONFLICT');
    for (const ix of g.instructions) if (!validIndex(ix.programIdIndex) || !Array.isArray(ix.accounts) || !ix.accounts.every(validIndex) || typeof ix.data !== 'string' || ix.data.length > 90000) fail('EVIDENCE_CONFLICT');
  }
  return { body, msg, keys, groups };
}
/** Replay validates preserved RPC evidence, not its authenticity. Only evidence
 * captured from configured archival providers and an integrity-protected store
 * may feed this verifier. User-supplied transcripts are never mining authority. */
export function replayMiningSeekerHoldingEvidence(evidenceJson: string, expected: MiningSeekerHoldingInput) {
  const facts = inputFacts(expected);
  if (typeof evidenceJson !== 'string' || Buffer.byteLength(evidenceJson) > MINING_SEEKER_HOLDING_LIMITS.maxEvidenceBytes) fail('TOO_LARGE');
  try {
    const t = JSON.parse(evidenceJson) as Transcript;
    if (t.version !== 1 || JSON.stringify(t.facts) !== JSON.stringify(facts)) fail('EVIDENCE_CONFLICT');
    if (t.genesisBefore !== SEEKER.mainnetGenesisHash || t.genesisAfter !== t.genesisBefore) fail('GENESIS_MISMATCH');
    if (!integer(t.finalizedBefore) || !integer(t.bank) || !integer(t.finalizedAfter) || t.bank < t.finalizedBefore || t.finalizedAfter < t.bank || !time(t.bankTime)) fail('CONTEXT_INVALID');
    if (t.bankTime * 1000 < facts.endMs) fail('INTERVAL_NOT_CLOSED');
    checkAccounts(t);
    if (!Array.isArray(t.blocks) || !Array.isArray(t.bodies) || t.bodies.length > MINING_SEEKER_HOLDING_LIMITS.maxTransactions || !Array.isArray(t.histories) || t.histories.length !== 2) fail('TOO_LARGE');
    let blockRows = 0;
    const blocks = new Map<number, BlockWire>();
    for (const b of t.blocks) {
      if (!integer(b.slot) || b.slot > t.bank || !time(b.blockTime) || b.blockTime > t.bankTime || blocks.has(b.slot) || !Array.isArray(b.signatures) || !b.signatures.every(signature) || new Set(b.signatures).size !== b.signatures.length) fail('EVIDENCE_CONFLICT');
      blockRows += b.signatures.length; if (blockRows > MINING_SEEKER_HOLDING_LIMITS.maxBlockSignatures) fail('TOO_LARGE'); blocks.set(b.slot, b);
    }
    const orderedBlocks = [...blocks.values()].sort((a, b) => a.slot - b.slot);
    if (orderedBlocks.some((b, i) => i > 0 && b.blockTime < orderedBlocks[i - 1]!.blockTime)) fail('EVIDENCE_CONFLICT');
    const bodies = new Map<string, ReturnType<typeof decodeBody>>();
    for (const body of t.bodies) {
      const decoded = decodeBody(body), block = blocks.get(body.slot);
      if (bodies.has(body.signature) || !block || block.blockTime !== body.blockTime || !block.signatures.includes(body.signature)) fail('EVIDENCE_CONFLICT');
      bodies.set(body.signature, decoded);
    }
    const rowsByAddress = new Map<string, Set<string>>(); let totalRows = 0;
    for (const h of t.histories) {
      if (![facts.mint, facts.tokenAccount].includes(h.address) || rowsByAddress.has(h.address) || !Array.isArray(h.pages) || !h.pages.length) fail('HISTORY_INCOMPLETE');
      const seen = new Set<string>(); let previous = Number.MAX_SAFE_INTEGER;
      for (let p = 0; p < h.pages.length; p++) {
        const page = h.pages[p]!;
        if (!Array.isArray(page) || page.length > PAGE_SIZE || (p < h.pages.length - 1 ? page.length !== PAGE_SIZE : page.length >= PAGE_SIZE)) fail('HISTORY_INCOMPLETE');
        totalRows += page.length; if (totalRows > MINING_SEEKER_HOLDING_LIMITS.maxSignatureRows) fail('TOO_LARGE');
        for (const row of page) {
          if (!signature(row.signature) || !integer(row.slot) || row.slot > previous || seen.has(row.signature) || row.confirmationStatus !== 'finalized') fail('EVIDENCE_CONFLICT');
          previous = row.slot; seen.add(row.signature);
          if (row.slot > t.bank) continue;
          const d = bodies.get(row.signature);
          if (!d) fail('HISTORY_INCOMPLETE');
          if (row.slot !== d.body.slot || (row.blockTime != null && row.blockTime !== d.body.blockTime) || JSON.stringify(row.err) !== JSON.stringify(d.body.err)
            || !Array.from({ length: d.keys.length }, (_, i) => d.keys.get(i)!.toBase58()).includes(h.address)) fail('EVIDENCE_CONFLICT');
        }
      }
      if (![...seen].some(s => bodies.has(s))) fail('HISTORY_INCOMPLETE'); rowsByAddress.set(h.address, seen);
    }
    let generation: { signature: string; slot: number; blockTime: number; transactionIndex: number } | undefined;
    for (const d of bodies.values()) {
      const { body, keys, msg, groups } = d;
      const index = Array.from({ length: keys.length }, (_, i) => i).find(i => keys.get(i)!.toBase58() === facts.tokenAccount);
      const references = [facts.mint, facts.tokenAccount].filter(a => Array.from({ length: keys.length }, (_, i) => keys.get(i)!.toBase58()).includes(a));
      for (const a of references) if (!rowsByAddress.get(a)?.has(body.signature)) fail('HISTORY_INCOMPLETE');
      if (body.err !== null) continue;
      if (body.blockTime * 1000 >= facts.startMs && Array.from({ length: keys.length }, (_, i) => i).some(i => [facts.mint, facts.tokenAccount].includes(keys.get(i)!.toBase58()) && msg.isAccountWritable(i))) fail('HOLDING_CHANGED');
      if (index === undefined) continue;
      const generationCodes = [TokenInstruction.InitializeAccount, TokenInstruction.InitializeAccount2, TokenInstruction.InitializeAccount3, TokenInstruction.CloseAccount] as number[];
      const tokenIxs = msg.compiledInstructions.filter(ix => keys.get(ix.programIdIndex)!.equals(TOKEN_2022_PROGRAM_ID) && ix.accountKeyIndexes[0] === index);
      const direct = tokenIxs.filter(ix => generationCodes.includes(ix.data[0]!));
      const nested = groups.flatMap(g => g.instructions.map(ix => ({ ...ix, outer: g.index, decoded: bs58.decode(ix.data) }))).filter(ix => keys.get(ix.programIdIndex)!.equals(TOKEN_2022_PROGRAM_ID) && ix.accounts[0] === index && generationCodes.includes(ix.decoded[0]!));
      if (!direct.length && !nested.length) continue;
      if (generation || direct.length + nested.length !== 1 || body.blockTime * 1000 >= facts.startMs || body.preBalances[index] !== 0 || !msg.isAccountWritable(index)) fail('UNSUPPORTED_HISTORY');
      let initData: Uint8Array, initKeys: number[], create: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array };
      if (direct.length) {
        const init = direct[0]!; initData = init.data; initKeys = init.accountKeyIndexes;
        if (!msg.isAccountSigner(index)) fail('UNSUPPORTED_HISTORY');
        const creates = msg.compiledInstructions.filter(ix => keys.get(ix.programIdIndex)!.equals(SystemProgram.programId) && ix.accountKeyIndexes.includes(index));
        if (creates.length !== 1 || msg.compiledInstructions.indexOf(creates[0]!) >= msg.compiledInstructions.indexOf(init)) fail('UNSUPPORTED_HISTORY');
        create = creates[0]!;
      } else {
        const init = nested[0]!, outer = msg.compiledInstructions[init.outer]!;
        initData = init.decoded; initKeys = init.accounts;
        const expectedAta = getAssociatedTokenAddressSync(new PublicKey(facts.mint), new PublicKey(facts.linkedWallet), true, TOKEN_2022_PROGRAM_ID);
        const outerKeys = outer.accountKeyIndexes.map(i => keys.get(i)!.toBase58());
        if (!expectedAta.equals(new PublicKey(facts.tokenAccount)) || !keys.get(outer.programIdIndex)!.equals(ASSOCIATED_TOKEN_PROGRAM_ID)
          || !(outer.data.length === 0 || (outer.data.length === 1 && (outer.data[0] === 0 || outer.data[0] === 1))) || outerKeys.length !== 6
          || outerKeys[1] !== facts.tokenAccount || outerKeys[2] !== facts.linkedWallet || outerKeys[3] !== facts.mint
          || outerKeys[4] !== SystemProgram.programId.toBase58() || outerKeys[5] !== SEEKER.sgt.tokenProgram
          || !msg.isAccountSigner(outer.accountKeyIndexes[0]!) || !msg.isAccountWritable(outer.accountKeyIndexes[0]!)) fail('UNSUPPORTED_HISTORY');
        const trace = groups.find(g => g.index === init.outer)!.instructions;
        // Canonical Token-2022 ATA creation: size query, system allocation,
        // immutable owner, account initialization. No missing/deeper CPI trace.
        if (trace.length !== 4 || trace.some(ix => ix.stackHeight !== 2)) fail('UNSUPPORTED_HISTORY');
        const [size, alloc, immutable, initialize] = trace;
        const sizeData = bs58.decode(size!.data), immutableData = bs58.decode(immutable!.data);
        if (!keys.get(size!.programIdIndex)!.equals(TOKEN_2022_PROGRAM_ID) || size!.accounts.length !== 1 || keys.get(size!.accounts[0]!)!.toBase58() !== facts.mint
          || sizeData.length !== 3 || sizeData[0] !== TokenInstruction.GetAccountDataSize || sizeData[1] !== ExtensionType.ImmutableOwner || sizeData[2] !== 0
          || !keys.get(alloc!.programIdIndex)!.equals(SystemProgram.programId) || alloc!.accounts.length !== 2 || alloc!.accounts[0] !== outer.accountKeyIndexes[0] || alloc!.accounts[1] !== index
          || !keys.get(immutable!.programIdIndex)!.equals(TOKEN_2022_PROGRAM_ID) || immutable!.accounts.length !== 1 || immutable!.accounts[0] !== index || immutableData.length !== 1 || immutableData[0] !== TokenInstruction.InitializeImmutableOwner
          || initialize!.programIdIndex !== init.programIdIndex || initialize!.data !== init.data || initialize!.accounts.join(',') !== init.accounts.join(',')) fail('UNSUPPORTED_HISTORY');
        create = { programIdIndex: alloc!.programIdIndex, accountKeyIndexes: alloc!.accounts, data: bs58.decode(alloc!.data) };
      }
      if (initData.length !== 33 || initData[0] !== TokenInstruction.InitializeAccount3 || initKeys.length !== 2 || keys.get(initKeys[1]!)!.toBase58() !== facts.mint || new PublicKey(initData.slice(1)).toBase58() !== facts.linkedWallet) fail('UNSUPPORTED_HISTORY');
      if (create.accountKeyIndexes.length !== 2 || create.accountKeyIndexes[1] !== index || !msg.isAccountSigner(create.accountKeyIndexes[0]!) || !msg.isAccountWritable(create.accountKeyIndexes[0]!)) fail('UNSUPPORTED_HISTORY');
      const decoded = SystemInstruction.decodeCreateAccount(new TransactionInstruction({ programId: SystemProgram.programId, keys: create.accountKeyIndexes.map(i => ({ pubkey: keys.get(i)!, isSigner: msg.isAccountSigner(i), isWritable: msg.isAccountWritable(i) })), data: Buffer.from(create.data) }));
      if (!decoded.newAccountPubkey.equals(new PublicKey(facts.tokenAccount)) || !decoded.programId.equals(TOKEN_2022_PROGRAM_ID) || decoded.lamports <= 0 || decoded.space < 165) fail('UNSUPPORTED_HISTORY');
      generation = { signature: body.signature, slot: body.slot, blockTime: body.blockTime, transactionIndex: blocks.get(body.slot)!.signatures.indexOf(body.signature) };
    }
    if (!generation) fail('HISTORY_INCOMPLETE');
    // The entire generation block is reconciled against both address indexes.
    for (const sig of blocks.get(generation.slot)!.signatures) if (!bodies.has(sig)) fail('HISTORY_INCOMPLETE');
    return Object.freeze({ linkedWallet: facts.linkedWallet, mint: facts.mint, tokenAccount: facts.tokenAccount, startMs: facts.startMs, endMs: facts.endMs, throughSlot: String(t.bank), throughBlockTime: t.bankTime,
      continuouslyHeld: true as const, eligibilityAuthorized: false as const, generation: Object.freeze(generation), trust: 'trusted-finalized-rpc' as const, addressIndexCompleteness: 'configured-provider-trust' as const, evidenceJson });
  } catch (error) { if (error instanceof MiningSeekerHoldingError) throw error; return fail('EVIDENCE_CONFLICT'); }
}

async function readHoldingEvidence(source: MiningSeekerHoldingSource, input: MiningSeekerHoldingInput, includeMintBirth = false) {
  const facts = inputFacts(input), copiedInput = { linkedWallet: facts.linkedWallet, mint: facts.mint, tokenAccount: facts.tokenAccount, startAt: new Date(facts.startMs), endAt: new Date(facts.endMs) };
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, calls = 0, signatureRows = 0, blockRows = 0;
  const run = async () => {
    const reader = typeof source === 'function' ? source(controller.signal) : source;
    const read = async <T>(fn: () => Promise<T>): Promise<T> => {
      controller.signal.throwIfAborted(); if (++calls > MINING_SEEKER_HOLDING_LIMITS.maxCalls) fail('TOO_LARGE');
      try { const result = await fn(); controller.signal.throwIfAborted(); return result; } catch (error) { if (error instanceof MiningSeekerHoldingError) throw error; return fail('READER_UNAVAILABLE'); }
    };
    const genesisBefore = await read(() => reader.getGenesisHash()); if (genesisBefore !== SEEKER.mainnetGenesisHash) fail('GENESIS_MISMATCH');
    const finalizedBefore = await read(() => reader.getSlot('finalized')); if (!integer(finalizedBefore)) fail('CONTEXT_INVALID');
    const accounts = await read(() => reader.getMultipleAccountsInfoAndContext([new PublicKey(facts.mint), new PublicKey(facts.tokenAccount)], { commitment: 'finalized', minContextSlot: finalizedBefore }));
    const bank = accounts?.context?.slot; if (!integer(bank) || bank < finalizedBefore || !Array.isArray(accounts.value) || accounts.value.length !== 2) fail('CONTEXT_INVALID');
    const accountRows = accounts.value.map(accountWire);
    const bankTime = await read(() => reader.getBlockTime(bank)); if (!time(bankTime)) fail('CONTEXT_INVALID');
    const t: Transcript = { version: 1, facts, genesisBefore, genesisAfter: '', finalizedBefore, finalizedAfter: 0, bank, bankTime, accounts: accountRows, histories: [], blocks: [], bodies: [] };
    checkAccounts(t); if (bankTime * 1000 < facts.endMs) fail('INTERVAL_NOT_CLOSED');
    const blocks = new Map<number, BlockWire>(), bodies = new Map<string, BodyWire>();
    const block = async (slot: number) => {
      const existing = blocks.get(slot); if (existing) return existing;
      const [at, order] = await Promise.all([read(() => reader.getBlockTime(slot)), read(() => reader.getBlockSignatures(slot, 'finalized'))]);
      if (!time(at) || !order || !Array.isArray(order.signatures) || (order.blockTime != null && order.blockTime !== at)) fail('EVIDENCE_CONFLICT');
      blockRows += order.signatures.length; if (blockRows > MINING_SEEKER_HOLDING_LIMITS.maxBlockSignatures) fail('TOO_LARGE');
      const result = { slot, blockTime: at, signatures: [...order.signatures] }; blocks.set(slot, result); return result;
    };
    const body = async (sig: string) => {
      const existing = bodies.get(sig); if (existing) return existing;
      if (bodies.size >= MINING_SEEKER_HOLDING_LIMITS.maxTransactions) fail('TOO_LARGE');
      const result = bodyWire(await read(() => reader.getTransaction(sig, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })));
      if (result.signature !== sig || result.slot > bank) fail('EVIDENCE_CONFLICT'); bodies.set(sig, result); await block(result.slot); return result;
    };
    for (const address of [facts.mint, facts.tokenAccount]) {
      const pages: ConfirmedSignatureInfo[][] = []; let before: string | undefined; const seen = new Set<string>();
      for (;;) {
        const page = await read(() => reader.getSignaturesForAddress(new PublicKey(address), { limit: PAGE_SIZE, minContextSlot: bank, ...(before ? { before } : {}) }, 'finalized'));
        if (!Array.isArray(page) || page.length > PAGE_SIZE) fail('EVIDENCE_CONFLICT');
        signatureRows += page.length; if (signatureRows > MINING_SEEKER_HOLDING_LIMITS.maxSignatureRows) fail('TOO_LARGE');
        const ownedPage = structuredClone(page); pages.push(ownedPage);
        for (const row of ownedPage) {
          if (!signature(row.signature) || !integer(row.slot) || seen.has(row.signature)) fail('EVIDENCE_CONFLICT'); seen.add(row.signature);
          if (row.slot <= bank) await body(row.signature);
        }
        if (ownedPage.length < PAGE_SIZE) break; before = ownedPage.at(-1)!.signature;
      }
      t.histories.push({ address, pages });
    }
    // Fetch complete blocks for possible token-account initialization and,
    // only for the birth API, mint initialization. Replay authenticates them.
    const generationSlots = new Set<number>();
    for (const b of bodies.values()) {
      const d = decodeBody(b);
      if (b.err === null && (d.msg.compiledInstructions.some(ix => d.keys.get(ix.programIdIndex)!.equals(TOKEN_2022_PROGRAM_ID) && d.keys.get(ix.accountKeyIndexes[0]!)?.toBase58() === facts.tokenAccount && ix.data[0] === TokenInstruction.InitializeAccount3) || d.groups.some(g => g.instructions.some(ix => d.keys.get(ix.programIdIndex)!.equals(TOKEN_2022_PROGRAM_ID) && d.keys.get(ix.accounts[0]!)?.toBase58() === facts.tokenAccount && bs58.decode(ix.data)[0] === TokenInstruction.InitializeAccount3)))) generationSlots.add(b.slot);
      if (includeMintBirth && b.err === null && d.msg.compiledInstructions.some(ix => d.keys.get(ix.programIdIndex)!.equals(TOKEN_2022_PROGRAM_ID) && d.keys.get(ix.accountKeyIndexes[0]!)?.toBase58() === facts.mint && [TokenInstruction.InitializeMint, TokenInstruction.InitializeMint2].includes(ix.data[0]!))) generationSlots.add(b.slot);
    }
    for (const slot of generationSlots) for (const sig of (await block(slot)).signatures) await body(sig);
    t.blocks = [...blocks.values()]; t.bodies = [...bodies.values()];
    t.finalizedAfter = await read(() => reader.getSlot('finalized')); t.genesisAfter = await read(() => reader.getGenesisHash());
    return replayMiningSeekerHoldingEvidence(JSON.stringify(t), copiedInput);
  };
  try { return await Promise.race([run(), new Promise<never>((_, reject) => { timer = setTimeout(() => { const e = new MiningSeekerHoldingError('TIMEOUT'); controller.abort(e); reject(e); }, MINING_SEEKER_HOLDING_LIMITS.timeoutMs); })]); }
  catch (error) { if (error instanceof MiningSeekerHoldingError) throw error; return fail('READER_UNAVAILABLE'); }
  finally { clearTimeout(timer); controller.abort(); }
}

/** Backward-compatible v1 holding reader; mint birth is a separate assertion. */
export async function readMiningSeekerHoldingEvidence(source: MiningSeekerHoldingSource, input: MiningSeekerHoldingInput) {
  return readHoldingEvidence(source, input);
}

export interface MiningSeekerMintBirthInput extends MiningSeekerHoldingInput { coverageFloor: Date }
function birthInput(input: MiningSeekerMintBirthInput) {
  if (!input || Object.keys(input).some(k => !['linkedWallet', 'mint', 'tokenAccount', 'startAt', 'endAt', 'coverageFloor'].includes(k))
    || !(input.coverageFloor instanceof Date) || !integer(input.coverageFloor.getTime())) fail('INVALID_INPUT');
  const holding = { linkedWallet: input.linkedWallet, mint: input.mint, tokenAccount: input.tokenAccount, startAt: input.startAt, endAt: input.endAt };
  const facts = inputFacts(holding), floor = input.coverageFloor.getTime();
  if (floor >= facts.startMs) fail('INVALID_INPUT');
  return { holding: { ...holding, startAt: new Date(facts.startMs), endAt: new Date(facts.endMs) }, floor };
}
/** Original mint-address birth, NOT the token-account generation. The existing
 * v1 transcript can carry the additional complete mint-birth block without a
 * format change; old holding evidence remains valid but need not prove birth.
 * Coverage is the caller's authenticated database floor, never inferred here.
 * Strictly later block time avoids claiming equality establishes coverage. */
export function replayMiningSeekerMintBirthEvidence(evidenceJson: string, expected: MiningSeekerMintBirthInput) {
  const { holding, floor } = birthInput(expected);
  const proof = replayMiningSeekerHoldingEvidence(evidenceJson, holding);
  try {
    const t = JSON.parse(evidenceJson) as Transcript;
    const blocks = new Map(t.blocks.map(b => [b.slot, b]));
    const bodies = t.bodies.map(decodeBody).sort((a, b) => a.body.slot - b.body.slot || blocks.get(a.body.slot)!.signatures.indexOf(a.body.signature) - blocks.get(b.body.slot)!.signatures.indexOf(b.body.signature));
    const successful = bodies.filter(d => d.body.err === null && Array.from({ length: d.keys.length }, (_, i) => d.keys.get(i)!.toBase58()).includes(holding.mint));
    const first = successful[0]; if (!first) fail('HISTORY_INCOMPLETE');
    let birth: { signature: string; slot: number; blockTime: number; transactionIndex: number; createInstructionIndex: number; initializeInstructionIndex: number } | undefined;
    const generationCodes: number[] = [TokenInstruction.InitializeMint, TokenInstruction.InitializeMint2, TokenInstruction.CloseAccount];
    for (const d of successful) {
      const { msg, keys, body, groups } = d;
      const mintIndex = Array.from({ length: keys.length }, (_, i) => i).find(i => keys.get(i)!.toBase58() === holding.mint)!;
      const token = msg.compiledInstructions.filter(ix => keys.get(ix.programIdIndex)!.equals(TOKEN_2022_PROGRAM_ID) && ix.accountKeyIndexes[0] === mintIndex);
      // Arbitrary CPI initialization cannot authenticate this direct creation
      // contract. Every successful close/reinitialize, including same-tx reuse,
      // refuses even when the final bytes look like the same original SGT.
      for (const group of groups) for (const ix of group.instructions) {
        if (keys.get(ix.programIdIndex)!.equals(TOKEN_2022_PROGRAM_ID) && ix.accounts[0] === mintIndex && generationCodes.includes(bs58.decode(ix.data)[0]!)) fail('UNSUPPORTED_HISTORY');
        if (keys.get(ix.programIdIndex)!.equals(SystemProgram.programId) && ix.accounts.includes(mintIndex) && msg.isAccountWritable(mintIndex)) fail('UNSUPPORTED_HISTORY');
      }
      const inits = token.filter(ix => generationCodes.includes(ix.data[0]!));
      const system = msg.compiledInstructions.filter(ix => keys.get(ix.programIdIndex)!.equals(SystemProgram.programId) && ix.accountKeyIndexes.includes(mintIndex) && msg.isAccountWritable(mintIndex));
      if (!inits.length) { if (!birth || system.length) fail('UNSUPPORTED_HISTORY'); continue; }
      if (birth || d !== first || inits.length !== 1 || system.length !== 1 || ![TokenInstruction.InitializeMint, TokenInstruction.InitializeMint2].includes(inits[0]!.data[0]!)) fail('UNSUPPORTED_HISTORY');
      const init = inits[0]!, create = system[0]!;
      const createIndex = msg.compiledInstructions.indexOf(create), initIndex = msg.compiledInstructions.indexOf(init);
      if (createIndex >= initIndex || !msg.isAccountSigner(mintIndex) || !msg.isAccountWritable(mintIndex) || body.preBalances[mintIndex] !== 0
        || create.accountKeyIndexes.length !== 2 || create.accountKeyIndexes[1] !== mintIndex || create.data.length !== 52
        || !msg.isAccountSigner(create.accountKeyIndexes[0]!) || !msg.isAccountWritable(create.accountKeyIndexes[0]!)) fail('UNSUPPORTED_HISTORY');
      const instruction = (ix: typeof init) => new TransactionInstruction({ programId: keys.get(ix.programIdIndex)!, keys: ix.accountKeyIndexes.map(i => ({ pubkey: keys.get(i)!, isSigner: msg.isAccountSigner(i), isWritable: msg.isAccountWritable(i) })), data: Buffer.from(ix.data) });
      const creation = SystemInstruction.decodeCreateAccount(instruction(create));
      if (!creation.newAccountPubkey.equals(new PublicKey(holding.mint)) || !creation.programId.equals(TOKEN_2022_PROGRAM_ID) || !integer(creation.lamports) || creation.lamports === 0
        || !integer(creation.space) || creation.space < 82 || creation.space > MINING_SEEKER_HOLDING_LIMITS.maxAccountBytes) fail('UNSUPPORTED_HISTORY');
      const original = init.data[0] === TokenInstruction.InitializeMint;
      if (init.accountKeyIndexes.length !== (original ? 2 : 1) || (original && (!keys.get(init.accountKeyIndexes[1]!)!.equals(SYSVAR_RENT_PUBKEY) || msg.isAccountWritable(init.accountKeyIndexes[1]!)))) fail('UNSUPPORTED_HISTORY');
      const decoded = original ? decodeInitializeMintInstruction(instruction(init), TOKEN_2022_PROGRAM_ID) : decodeInitializeMint2Instruction(instruction(init), TOKEN_2022_PROGRAM_ID);
      if (decoded.data.decimals !== 0 || decoded.data.mintAuthority.toBase58() !== SEEKER.sgt.mintAuthority) fail('UNSUPPORTED_HISTORY');
      const canonical = (original ? createInitializeMintInstruction : createInitializeMint2Instruction)(new PublicKey(holding.mint), 0, decoded.data.mintAuthority, decoded.data.freezeAuthority, TOKEN_2022_PROGRAM_ID);
      if (!canonical.data.equals(Buffer.from(init.data))) fail('UNSUPPORTED_HISTORY');
      const transactionIndex = blocks.get(body.slot)!.signatures.indexOf(body.signature);
      if (body.blockTime * 1000 <= floor || body.blockTime * 1000 >= proof.startMs) fail('BIRTH_OUTSIDE_COVERAGE');
      if (body.slot > proof.generation.slot || (body.slot === proof.generation.slot && transactionIndex > proof.generation.transactionIndex) || body.blockTime > proof.generation.blockTime) fail('EVIDENCE_CONFLICT');
      birth = { signature: body.signature, slot: body.slot, blockTime: body.blockTime, transactionIndex, createInstructionIndex: createIndex, initializeInstructionIndex: initIndex };
    }
    if (!birth) fail('HISTORY_INCOMPLETE');
    const known = new Set(t.bodies.map(b => b.signature));
    for (const sig of blocks.get(birth.slot)!.signatures) if (!known.has(sig)) fail('HISTORY_INCOMPLETE');
    return Object.freeze({ ...proof, coverageFloorMs: floor, mintBirth: Object.freeze(birth) });
  } catch (error) { if (error instanceof MiningSeekerHoldingError) throw error; return fail('UNSUPPORTED_HISTORY'); }
}

export async function readMiningSeekerMintBirthEvidence(source: MiningSeekerHoldingSource, input: MiningSeekerMintBirthInput) {
  const { holding, floor } = birthInput(input);
  const proof = await readHoldingEvidence(source, holding, true);
  return replayMiningSeekerMintBirthEvidence(proof.evidenceJson, { ...holding, coverageFloor: new Date(floor) });
}

/** Both independent configured providers must authenticate the same original
 * mint birth. The database coverage and lifetime-unique link proof are separate. */
export async function readAgreedMiningSeekerMintBirthEvidence(sources: readonly [MiningSeekerHoldingSource, MiningSeekerHoldingSource], input: MiningSeekerMintBirthInput) {
  if (!Array.isArray(sources) || sources.length !== 2 || sources[0] === sources[1]) fail('INVALID_INPUT');
  const { holding, floor } = birthInput(input), copied = { ...holding, coverageFloor: new Date(floor) };
  const [first, second] = await Promise.all(sources.map(source => readMiningSeekerMintBirthEvidence(source, copied)));
  const a = JSON.parse(first!.evidenceJson) as Transcript, b = JSON.parse(second!.evidenceJson) as Transcript;
  if (a.accounts.some((account, index) => account.owner !== b.accounts[index]?.owner || account.data !== b.accounts[index]?.data)
    || JSON.stringify(first!.generation) !== JSON.stringify(second!.generation) || JSON.stringify(first!.mintBirth) !== JSON.stringify(second!.mintBirth)) fail('SOURCE_DISAGREEMENT');
  return Object.freeze({ linkedWallet: holding.linkedWallet, mint: holding.mint, tokenAccount: holding.tokenAccount, startMs: holding.startAt.getTime(), endMs: holding.endAt.getTime(), coverageFloorMs: floor,
    continuouslyHeld: true as const, eligibilityAuthorized: false as const, sources: 2 as const, proofs: Object.freeze([first!, second!] as const) });
}

/** Callers configure two independent archival providers; provider independence
 * is configuration, not something a matching genesis hash can establish. Both
 * must succeed. Each proves its own bank, so ordinary finalized-slot drift is
 * harmless; raw token/mint bytes and generation must still agree exactly.
 * Production integration must also bound concurrent readers across requests. */
export async function readAgreedMiningSeekerHoldingEvidence(sources: readonly [MiningSeekerHoldingSource, MiningSeekerHoldingSource], input: MiningSeekerHoldingInput) {
  if (!Array.isArray(sources) || sources.length !== 2 || sources[0] === sources[1]) fail('INVALID_INPUT');
  const facts = inputFacts(input), copied = { linkedWallet: facts.linkedWallet, mint: facts.mint, tokenAccount: facts.tokenAccount, startAt: new Date(facts.startMs), endAt: new Date(facts.endMs) };
  const [first, second] = await Promise.all(sources.map(source => readMiningSeekerHoldingEvidence(source, copied)));
  const a = JSON.parse(first!.evidenceJson) as Transcript, b = JSON.parse(second!.evidenceJson) as Transcript;
  if (a.accounts.some((account, index) => account.owner !== b.accounts[index]?.owner || account.data !== b.accounts[index]?.data) || JSON.stringify(first!.generation) !== JSON.stringify(second!.generation)) fail('SOURCE_DISAGREEMENT');
  return Object.freeze({ linkedWallet: facts.linkedWallet, mint: facts.mint, tokenAccount: facts.tokenAccount, startMs: facts.startMs, endMs: facts.endMs, continuouslyHeld: true as const, eligibilityAuthorized: false as const, sources: 2 as const, proofs: Object.freeze([first!, second!] as const) });
}
