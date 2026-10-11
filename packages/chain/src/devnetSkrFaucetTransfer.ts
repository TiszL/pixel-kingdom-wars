/** Server-only subpath. D153.290/Amendment 1: player signs first; faucet signs
 * the exact verified message last. No token issuance and no faucet SOL spending. */
import { createPublicKey, verify } from 'node:crypto';
import { ComputeBudgetProgram, Message, PublicKey, TransactionMessage, VersionedTransaction,
  type Connection, type Signer, type VersionedMessage, type VersionedTransactionResponse } from '@solana/web3.js';
import { ACCOUNT_SIZE, MINT_SIZE, TOKEN_PROGRAM_ID, unpackAccount, unpackMint,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction } from '@solana/spl-token';
import bs58 from 'bs58';
import { SKR_FAUCET } from '@shardkeep/shared';
import { SOLANA_GENESIS_HASH } from './cluster';

export class SkrFaucetTransferError extends Error {
  constructor(readonly code: string) { super(`SKR faucet transfer refused: ${code}`); }
}
function need(value: unknown, code: string): asserts value {
  if (!value) throw new SkrFaucetTransferError(code);
}
const bytesEqual = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const safe = (n: number) => Number.isSafeInteger(n) && n >= 0;
const zero = (bytes: Uint8Array) => bytes.length === 64 && bytes.every((byte) => byte === 0);
function key(value: string): PublicKey {
  const result = new PublicKey(value); need(result.toBase58() === value, 'KEY'); return result;
}
function signatureValid(signature: Uint8Array, message: Uint8Array, signer: PublicKey): boolean {
  if (signature.length !== 64) return false;
  const publicKey = createPublicKey({ key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), signer.toBuffer(),
  ]), format: 'der', type: 'spki' });
  return verify(null, message, publicKey, signature);
}
export interface SkrClaimTerms {
  wallet: string; authority: string; mint: string; decimals: number; amountRaw: string;
  reference: string; recentBlockhash: string; lastValidBlockHeight: number;
}
export function skrGrantAmount(decimals: number): bigint {
  need(safe(decimals) && decimals <= 19, 'DECIMALS');
  const raw = BigInt(SKR_FAUCET.devnet.grantSkr) * 10n ** BigInt(decimals);
  need(raw <= (1n << 64n) - 1n, 'AMOUNT'); return raw;
}
export function buildDevnetSkrClaimMessage(terms: SkrClaimTerms) {
  const player = key(terms.wallet), authority = key(terms.authority), mint = key(terms.mint), reference = key(terms.reference);
  need(PublicKey.isOnCurve(player.toBytes()) && PublicKey.isOnCurve(authority.toBytes()) && !player.equals(authority), 'SIGNERS');
  need(!(SKR_FAUCET.devnet.refusedMints as readonly string[]).includes(terms.mint), 'REFUSED_MINT');
  need(safe(terms.lastValidBlockHeight) && terms.lastValidBlockHeight > 0, 'HEIGHT'); key(terms.recentBlockhash);
  const amount = skrGrantAmount(terms.decimals); need(terms.amountRaw === amount.toString(), 'AMOUNT');
  const destination = getAssociatedTokenAddressSync(mint, player), source = getAssociatedTokenAddressSync(mint, authority);
  const ata = createAssociatedTokenAccountIdempotentInstruction(player, destination, player, mint);
  const transfer = createTransferCheckedInstruction(source, mint, destination, authority, amount, terms.decimals);
  const used = new Set([player, authority, mint, source, destination, ata.programId, transfer.programId,
    ...ata.keys.map((item) => item.pubkey)].map((item) => item.toBase58()));
  need(!used.has(reference.toBase58()) && !reference.equals(ComputeBudgetProgram.programId), 'REFERENCE');
  transfer.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
  const message = new TransactionMessage({ payerKey: player, recentBlockhash: terms.recentBlockhash,
    instructions: [ata, transfer] }).compileToLegacyMessage();
  need(message.header.numRequiredSignatures === 2 && message.header.numReadonlySignedAccounts === 1
    && message.accountKeys[0]!.equals(player) && message.accountKeys[1]!.equals(authority), 'SIGNERS');
  const tx = new VersionedTransaction(message); const wire = tx.serialize(); need(wire.length <= 1232, 'WIRE');
  return { message: Buffer.from(message.serialize()), unsignedWire: Buffer.from(wire).toString('base64') };
}
function decodeWire(wire: string): VersionedTransaction {
  need(typeof wire === 'string' && wire.length <= 1644 && /^[A-Za-z0-9+/]+={0,2}$/.test(wire), 'WIRE');
  const bytes = Buffer.from(wire, 'base64');
  need(bytes.length <= 1232 && bytes.toString('base64') === wire, 'WIRE');
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(bytes); } catch { throw new SkrFaucetTransferError('WIRE'); }
  need(bytesEqual(tx.serialize(), bytes) && tx.message.version === 'legacy', 'WIRE'); return tx;
}
function privileges(message: VersionedMessage, index: number) {
  need(safe(index) && index < message.staticAccountKeys.length, 'ACCOUNTS');
  return { key: message.staticAccountKeys[index]!.toBase58(), signer: message.isAccountSigner(index), writable: message.isAccountWritable(index) };
}
function resolvedInstruction(message: VersionedMessage, index: number) {
  const ix = message.compiledInstructions[index]; need(ix, 'INSTRUCTION');
  const program = privileges(message, ix.programIdIndex);
  return { program, accounts: ix.accountKeyIndexes.map((at) => privileges(message, at)), data: Buffer.from(ix.data).toString('hex') };
}
function sameInstruction(a: VersionedMessage, ai: number, b: VersionedMessage, bi: number) {
  return JSON.stringify(resolvedInstruction(a, ai)) === JSON.stringify(resolvedInstruction(b, bi));
}
export function assertPlayerSignedFaucetTransfer(terms: SkrClaimTerms, retainedMessage: Uint8Array, wire: string) {
  const rebuilt = buildDevnetSkrClaimMessage(terms);
  need(bytesEqual(rebuilt.message, retainedMessage), 'RETAINED_MESSAGE');
  const original = Message.from(retainedMessage), tx = decodeWire(wire), message = tx.message;
  need(tx.signatures.length === 2 && message.header.numRequiredSignatures === 2
    && message.header.numReadonlySignedAccounts === 1, 'SIGNERS');
  need(message.staticAccountKeys[0]?.toBase58() === terms.wallet
    && message.staticAccountKeys[1]?.toBase58() === terms.authority, 'SIGNERS');
  need(message.recentBlockhash === terms.recentBlockhash, 'BLOCKHASH_CHANGED');
  const keys = message.staticAccountKeys.map((item) => item.toBase58());
  need(new Set(keys).size === keys.length, 'ACCOUNTS');
  const expected = new Set(original.staticAccountKeys.map((item) => item.toBase58()));
  const cb = ComputeBudgetProgram.programId.toBase58();
  need(keys.length === expected.size || keys.length === expected.size + 1, 'ACCOUNTS');
  for (const item of expected) need(keys.includes(item), 'ACCOUNTS');
  for (let i = 0; i < keys.length; i++) {
    if (expected.has(keys[i]!)) {
      const oi = original.staticAccountKeys.findIndex((item) => item.toBase58() === keys[i]);
      need(JSON.stringify(privileges(message, i)) === JSON.stringify(privileges(original, oi)), 'PRIVILEGES');
    } else need(keys[i] === cb && !message.isAccountSigner(i) && !message.isAccountWritable(i), 'ACCOUNTS');
  }
  let wanted = 0, limit: number | undefined, price: bigint | undefined, extras = 0;
  for (let i = 0; i < message.compiledInstructions.length; i++) {
    if (wanted < original.compiledInstructions.length && sameInstruction(message, i, original, wanted)) { wanted++; continue; }
    const ix = message.compiledInstructions[i]!;
    need(message.staticAccountKeys[ix.programIdIndex]?.equals(ComputeBudgetProgram.programId)
      && ix.accountKeyIndexes.length === 0, 'EXTRA_INSTRUCTION');
    const data = Buffer.from(ix.data);
    if (data[0] === 2) {
      need(data.length === 5 && limit === undefined, 'COMPUTE_BUDGET'); limit = data.readUInt32LE(1);
      need(limit > 0 && limit <= 1_400_000, 'COMPUTE_BUDGET');
    } else if (data[0] === 3) {
      need(data.length === 9 && price === undefined, 'COMPUTE_BUDGET'); price = data.readBigUInt64LE(1);
    } else throw new SkrFaucetTransferError('COMPUTE_BUDGET');
    extras++;
  }
  need(wanted === original.compiledInstructions.length, 'INSTRUCTION');
  need(keys.length === expected.size + (extras ? 1 : 0), 'ACCOUNTS');
  const priorityFeeLamports = ((price ?? 0n) * BigInt(limit ?? 1_400_000) + 999_999n) / 1_000_000n;
  need(priorityFeeLamports <= BigInt(SKR_FAUCET.devnet.maxWalletAddedPriorityFeeLamports), 'PRIORITY_FEE');
  const bytes = message.serialize();
  need(zero(tx.signatures[1]!) && signatureValid(tx.signatures[0]!, bytes, key(terms.wallet)), 'SIGNATURE');
  return { transaction: tx, signature: bs58.encode(tx.signatures[0]!),
    mutation: extras ? 'compute_budget_added' as const : 'none' as const, priorityFeeLamports };
}
export function faucetCosign(terms: SkrClaimTerms, retainedMessage: Uint8Array, playerWire: string, signer: Signer): string {
  need(signer.publicKey.toBase58() === terms.authority, 'AUTHORITY');
  const { transaction: tx } = assertPlayerSignedFaucetTransfer(terms, retainedMessage, playerWire);
  const message = tx.message.serialize(), playerSignature = Uint8Array.from(tx.signatures[0]!);
  tx.sign([signer]); // VersionedTransaction signs its parsed message without recompiling it.
  need(bytesEqual(tx.message.serialize(), message) && bytesEqual(tx.signatures[0]!, playerSignature), 'MESSAGE_CHANGED');
  for (let i = 0; i < 2; i++) need(signatureValid(tx.signatures[i]!, message, tx.message.staticAccountKeys[i]!), 'SIGNATURE');
  return Buffer.from(tx.serialize()).toString('base64');
}
export type SkrFaucetRpc = Pick<Connection, 'getGenesisHash' | 'getAccountInfoAndContext' | 'getLatestBlockhash'
  | 'getBalance' | 'getFeeForMessage' | 'getMinimumBalanceForRentExemption' | 'getSignatureStatuses'
  | 'getBlockHeight' | 'getSignaturesForAddress' | 'sendRawTransaction'> & {
    getTransaction(signature: string, options: { commitment: 'finalized'; maxSupportedTransactionVersion: 0 }): Promise<VersionedTransactionResponse | null>;
  };
export async function assertDevnetSkrGenesis(rpc: Pick<SkrFaucetRpc, 'getGenesisHash'>) {
  need(await rpc.getGenesisHash() === SOLANA_GENESIS_HASH.devnet, 'GENESIS');
}
export async function readDevnetSkrMint(rpc: SkrFaucetRpc, mint: string) {
  await assertDevnetSkrGenesis(rpc); const address = key(mint);
  need(!(SKR_FAUCET.devnet.refusedMints as readonly string[]).includes(mint), 'REFUSED_MINT');
  const response = await rpc.getAccountInfoAndContext(address, { commitment: 'finalized' });
  const account = response.value;
  need(safe(response.context.slot) && account && !account.executable && account.owner.equals(TOKEN_PROGRAM_ID)
    && account.data.length === MINT_SIZE, 'MINT');
  const decoded = unpackMint(address, account, TOKEN_PROGRAM_ID); need(decoded.isInitialized && decoded.mintAuthority === null && decoded.freezeAuthority === null, 'MINT');
  skrGrantAmount(decoded.decimals); return { mint, decimals: decoded.decimals, finalized: true as const };
}
export async function readDevnetSkrTreasury(rpc: SkrFaucetRpc, mint: string, authority: string) {
  await assertDevnetSkrGenesis(rpc); const mintKey = key(mint), owner = key(authority);
  const address = getAssociatedTokenAddressSync(mintKey, owner);
  const response = await rpc.getAccountInfoAndContext(address, { commitment: 'finalized' }), account = response.value;
  need(safe(response.context.slot) && account && !account.executable && account.owner.equals(TOKEN_PROGRAM_ID)
    && account.data.length === ACCOUNT_SIZE, 'TREASURY');
  const token = unpackAccount(address, account, TOKEN_PROGRAM_ID);
  need(token.isInitialized && !token.isFrozen && !token.isNative && token.mint.equals(mintKey) && token.owner.equals(owner)
    && token.delegate === null && (token.closeAuthority === null || token.closeAuthority.equals(owner)), 'TREASURY');
  return { balanceRaw: token.amount, finalized: true as const };
}
/** Read-only quote for the PLAYER. The faucet authority's SOL is never read. */
export async function skrPlayerCost(rpc: SkrFaucetRpc, terms: SkrClaimTerms, message: VersionedMessage, priorityFeeLamports = 0n) {
  await assertDevnetSkrGenesis(rpc);
  const player = key(terms.wallet), mint = key(terms.mint), ata = getAssociatedTokenAddressSync(mint, player);
  const [fee, balance, account, rent] = await Promise.all([rpc.getFeeForMessage(message, 'confirmed'),
    rpc.getBalance(player, 'confirmed'), rpc.getAccountInfoAndContext(ata, { commitment: 'confirmed' }),
    rpc.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'confirmed')]);
  need(fee.value !== null && safe(fee.value) && safe(balance) && safe(rent) && safe(account.context.slot), 'PLAYER_COST');
  if (account.value) {
    need(account.value.owner.equals(TOKEN_PROGRAM_ID) && account.value.data.length === ACCOUNT_SIZE && !account.value.executable, 'PLAYER_ATA');
    const token = unpackAccount(ata, account.value, TOKEN_PROGRAM_ID);
    need(token.isInitialized && !token.isFrozen && token.owner.equals(player) && token.mint.equals(mint), 'PLAYER_ATA');
  }
  const accountRentLamports = account.value ? 0n : BigInt(rent);
  // RPC may already include priority fees; this conservative extra reserve is
  // explicitly accepted by Amendment 1's residual-risk note.
  const networkFeeLamports = BigInt(fee.value) + priorityFeeLamports;
  return { networkFeeLamports, accountRentLamports, sufficient: BigInt(balance) >= networkFeeLamports + accountRentLamports };
}
export type SkrClaimOutcome = { state: 'unknown' | 'expired' } | { state: 'finalized' | 'failed'; landedSignature: string };
function finalizedOutcome(error: unknown): 'finalized' | 'failed' {
  need(error === null || typeof error === 'string' || typeof error === 'object' && error !== null && !Array.isArray(error), 'TRANSACTION_ERROR');
  return error === null ? 'finalized' : 'failed';
}
/** A stored fee-payer signature is not every possible tx id for a faucet
 * signature. Before expiry, exhaust the reference index and match signature[1]. */
export async function skrClaimOutcome(rpc: SkrFaucetRpc, input: {
  signature: string; reference: string; lastValidBlockHeight: number; faucetWire: string;
}, reportUnknown?: (reason: 'pending' | 'capped' | 'incomplete' | 'unavailable') => void): Promise<SkrClaimOutcome> {
  const unknown = (reason: 'pending' | 'capped' | 'incomplete' | 'unavailable'): SkrClaimOutcome => { reportUnknown?.(reason); return { state: 'unknown' }; };
  try {
    await assertDevnetSkrGenesis(rpc);
    const original = decodeWire(input.faucetWire), message = original.message.serialize();
    need(original.signatures.length === 2 && original.message.header.numRequiredSignatures === 2
      && bs58.encode(original.signatures[0]!) === input.signature && safe(input.lastValidBlockHeight) && input.lastValidBlockHeight > 0, 'ORIGINAL');
    for (let i = 0; i < 2; i++) need(signatureValid(original.signatures[i]!, message, original.message.staticAccountKeys[i]!), 'ORIGINAL');
    const faucetSignature = bs58.encode(original.signatures[1]!);
    const result = await rpc.getSignatureStatuses([input.signature], { searchTransactionHistory: true });
    need(safe(result.context.slot) && result.value.length === 1, 'STATUS'); const status = result.value[0];
    if (status?.confirmationStatus === 'finalized') return { state: finalizedOutcome(status.err), landedSignature: input.signature };
    if (status !== null) return unknown('pending');
    const height = await rpc.getBlockHeight('finalized'); need(safe(height), 'HEIGHT');
    if (height <= input.lastValidBlockHeight) return unknown('pending');
    const reference = key(input.reference);
    need(original.message.staticAccountKeys.some((item) => item.equals(reference)), 'REFERENCE');
    let before: string | undefined, scanned = 0, incomplete = false;
    const seen = new Set<string>();
    while (scanned < SKR_FAUCET.devnet.referenceScanCap) {
      const limit = Math.min(SKR_FAUCET.devnet.referenceScanPageSize, SKR_FAUCET.devnet.referenceScanCap - scanned);
      const page = await rpc.getSignaturesForAddress(reference, { limit, ...(before ? { before } : {}) }, 'finalized');
      need(Array.isArray(page) && page.length <= limit, 'REFERENCE_SCAN');
      if (page.length === 0) return incomplete ? unknown('incomplete') : { state: 'expired' };
      for (const entry of page) {
        need(!seen.has(entry.signature), 'REFERENCE_SCAN'); seen.add(entry.signature); scanned++;
        const found = await rpc.getTransaction(entry.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
        if (!found || !found.meta) { incomplete = true; continue; }
        if (found.transaction.signatures[1] !== faucetSignature) continue;
        need(found.version === 'legacy' && found.transaction.message.version === 'legacy'
          && found.transaction.signatures.length === 2 && found.transaction.signatures[0] === entry.signature
          && bytesEqual(found.transaction.message.serialize(), message), 'REFERENCE_TRANSACTION');
        for (let i = 0; i < 2; i++) need(signatureValid(bs58.decode(found.transaction.signatures[i]!), message,
          original.message.staticAccountKeys[i]!), 'REFERENCE_SIGNATURE');
        return { state: finalizedOutcome(found.meta.err), landedSignature: entry.signature };
      }
      before = page[page.length - 1]!.signature;
      if (page.length < limit) return incomplete ? unknown('incomplete') : { state: 'expired' };
    }
    return unknown('capped'); // A capped index is never evidence of absence.
  } catch { return unknown('unavailable'); }
}
