/** Committed-failure evidence for the separately admitted league validator suite.
 * The caller must already hold owner admission for this run and the supplied
 * existing AnchorProvider wallet. Receiving a provider or a fixture string does
 * not grant authorization. No key generation, secret access or signer import.
 * This helper is test source; only Cedar3 executes it in the admitted queue. */
import { AnchorError, utils, type AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, Transaction, TransactionInstruction, type AccountInfo, type TransactionResponse } from "@solana/web3.js";

export type CommittedFailureStage = "INPUT" | "FINALITY" | "WALLET" | "TRANSACTION" | "ERROR" | "FEE" | "STATE";
export class CommittedFailureEvidenceError extends Error {
  constructor(readonly stage: CommittedFailureStage, detail: string) {
    super(`Committed failure evidence ${stage}: ${detail}`);
    this.name = "CommittedFailureEvidenceError";
  }
}
export interface CommittedFailureInput {
  provider: AnchorProvider;
  instruction: TransactionInstruction;
  programId: PublicKey;
  expectedCustomError: number;
  expectedErrorName: string;
  /** Affected state and token accounts, including expected-absent init accounts.
   * The fee payer must not be here; its fee-only exception is checked separately. */
  watchedAccounts: readonly PublicKey[];
}
export interface CommittedFailureRetry {
  maxAttempts: number;
  delayMs: number;
  /** Unit transport doubles can replace waiting; they cannot replace evidence checks. */
  wait: (milliseconds: number) => Promise<void>;
}
export interface CommittedFailureReceipt {
  readonly signature: string;
  readonly slot: number;
  readonly fee: bigint;
  readonly beforeSlot: number;
  readonly afterSlot: number;
  readonly expectedCustomError: number;
  readonly expectedErrorName: string;
  readonly logs: readonly string[];
}
interface AccountSnapshot {
  readonly owner: string;
  readonly lamports: bigint;
  readonly executable: boolean;
  readonly data: string;
}
function need(condition: unknown, stage: CommittedFailureStage, detail: string): asserts condition {
  if (!condition) throw new CommittedFailureEvidenceError(stage, detail);
}
function safeInteger(value: unknown, stage: CommittedFailureStage, detail: string): asserts value is number {
  need(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, stage, detail);
}
function key(value: PublicKey): PublicKey {
  need(value instanceof PublicKey, "INPUT", "Expected a public account address");
  return new PublicKey(value.toBytes());
}
function snapshot(value: AccountInfo<Buffer> | null): AccountSnapshot | null {
  if (value === null) return null;
  need(value && value.owner instanceof PublicKey && typeof value.executable === "boolean" && Buffer.isBuffer(value.data), "STATE", "Malformed RPC account fields");
  safeInteger(value.lamports, "STATE", "Account lamports must be losslessly representable");
  return Object.freeze({ owner: value.owner.toBase58(), lamports: BigInt(value.lamports), executable: value.executable, data: value.data.toString("hex") });
}
function equalState(left: AccountSnapshot | null, right: AccountSnapshot | null): boolean {
  if (left === null || right === null) return left === right;
  return left.owner === right.owner && left.lamports === right.lamports && left.executable === right.executable && left.data === right.data;
}
function exactCustomError(value: unknown, expectedCode: number): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) return false;
  const failure = (value as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(failure) || failure.length !== 2 || failure[0] !== 0) return false;
  const detail: unknown = failure[1];
  return detail !== null && typeof detail === "object" && !Array.isArray(detail)
    && Object.keys(detail).length === 1 && (detail as { Custom?: unknown }).Custom === expectedCode;
}
const defaults: CommittedFailureRetry = {
  maxAttempts: 240,
  delayMs: 250,
  wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
};

/** Submits exactly one legacy instruction through an already admitted existing
 * wallet. Unlike sendAndConfirm, confirmation errors are retained as evidence:
 * the finalized transaction, fee and all watched accounts must prove rollback. */
export async function assertCommittedFailure(input: CommittedFailureInput, retry: CommittedFailureRetry = defaults): Promise<Readonly<CommittedFailureReceipt>> {
  need(input && input.provider && input.provider.wallet && input.provider.connection, "INPUT", "An existing admitted provider is required");
  const wallet = input.provider.wallet, connection = input.provider.connection;
  const payer = key(wallet.publicKey), programId = key(input.programId);
  need(typeof wallet.signTransaction === "function", "INPUT", "Existing wallet signing capability is required");
  need(input.instruction instanceof TransactionInstruction && input.instruction.programId.equals(programId), "INPUT", "Instruction must target the expected program");
  safeInteger(input.expectedCustomError, "INPUT", "Custom error must be a u32 integer");
  need(input.expectedCustomError <= 0xffff_ffff, "INPUT", "Custom error must be a u32 integer");
  need(typeof input.expectedErrorName === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(input.expectedErrorName), "INPUT", "An exact Anchor error name is required");
  const expectedCustomError = input.expectedCustomError, expectedErrorName = input.expectedErrorName;
  // Copy all caller-supplied addresses and instruction bytes before awaiting.
  // Neither caller mutation nor wallet mutation may change the requested message.
  const instruction = new TransactionInstruction({
    programId,
    keys: input.instruction.keys.map(meta => {
      need(typeof meta.isSigner === "boolean" && typeof meta.isWritable === "boolean", "INPUT", "Canonical account flags are required");
      const pubkey = key(meta.pubkey);
      need(!meta.isSigner || pubkey.equals(payer), "INPUT", "Only the supplied existing wallet may sign");
      return { pubkey, isSigner: meta.isSigner, isWritable: meta.isWritable };
    }),
    data: Buffer.from(input.instruction.data),
  });
  need(Array.isArray(input.watchedAccounts) && input.watchedAccounts.length > 0, "INPUT", "Affected state accounts must be watched");
  const watched = [...new Map(input.watchedAccounts.map(address => {
    const copied = key(address); need(!copied.equals(payer), "INPUT", "Fee payer cannot receive the unchanged-state exception");
    return [copied.toBase58(), copied] as const;
  })).values()];
  const watchedKeys = new Set(watched.map(address => address.toBase58()));
  need(instruction.keys.every(meta => !meta.isWritable || meta.pubkey.equals(payer) || watchedKeys.has(meta.pubkey.toBase58())),
    "INPUT", "Every writable instruction account must be watched");
  safeInteger(retry.maxAttempts, "INPUT", "Retry attempts must be a positive bounded integer");
  safeInteger(retry.delayMs, "INPUT", "Retry delay must be a bounded integer");
  need(retry.maxAttempts > 0 && retry.maxAttempts <= 240 && retry.delayMs <= 1000 && typeof retry.wait === "function", "INPUT", "Invalid retry policy");
  const attempts = retry.maxAttempts, delayMs = retry.delayMs, wait = retry.wait;
  const addresses = [...watched, payer];

  // Existing suite setup may have used confirmed commitment. Finalize its slot
  // before the baseline, or its pending writes could masquerade as failed-tx writes.
  const barrier = await connection.getSlot("confirmed"); safeInteger(barrier, "FINALITY", "Invalid confirmed setup slot");
  let ready = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const finalized = await connection.getSlot("finalized"); safeInteger(finalized, "FINALITY", "Invalid finalized slot");
    if (finalized >= barrier) { ready = true; break; }
    if (attempt + 1 < attempts) await wait(delayMs);
  }
  need(ready, "FINALITY", "Earlier confirmed setup did not reach finalized commitment");
  const beforeResponse = await connection.getMultipleAccountsInfoAndContext(addresses, { commitment: "finalized", minContextSlot: barrier });
  safeInteger(beforeResponse.context.slot, "FINALITY", "Invalid baseline slot");
  need(beforeResponse.context.slot >= barrier, "FINALITY", "RPC returned a stale baseline");
  need(beforeResponse.value.length === addresses.length, "STATE", "Incomplete baseline snapshot");
  const before = addresses.map((_, index) => snapshot(beforeResponse.value[index])), beforePayer = before[watched.length];
  need(beforePayer !== null && beforePayer !== undefined, "FEE", "Existing fee payer is absent");

  const blockhash = await connection.getLatestBlockhash({ commitment: "finalized", minContextSlot: beforeResponse.context.slot });
  const transaction = new Transaction({ feePayer: payer, ...blockhash }).add(instruction);
  const requestedMessage = Buffer.from(transaction.serializeMessage());
  const signed = await wallet.signTransaction(transaction);
  need(signed instanceof Transaction && signed.serializeMessage().equals(requestedMessage), "WALLET", "Wallet changed the requested legacy transaction message");
  need(signed.signatures.length === 1 && signed.signatures[0].publicKey.equals(payer)
    && signed.signatures[0].signature !== null && signed.signatures[0].signature.length === 64, "WALLET", "Exactly the existing fee payer signature is required");
  const signatureBytes = signed.signatures[0].signature;
  need(signatureBytes !== null, "WALLET", "Existing wallet signature is absent");
  const walletSignature = utils.bytes.bs58.encode(signatureBytes);
  // The normal SDK serializer verifies the actual signature before broadcast.
  const wire = signed.serialize({ requireAllSignatures: true, verifySignatures: true });
  const signature = await connection.sendRawTransaction(wire, { skipPreflight: true, preflightCommitment: "finalized" });
  need(signature === walletSignature, "TRANSACTION", "RPC submission signature differs from the wallet's transaction");
  let confirmationError: unknown;
  try {
    const confirmation = await connection.confirmTransaction({ signature, ...blockhash }, "finalized");
    confirmationError = confirmation.value.err;
  } catch (error) {
    // web3.js 1.98.4's subscription branch resolves value.err, but its parallel
    // status-check branch rejects the raw instruction error before checking
    // finality. Treat ONLY the exact expected error as provisional evidence.
    // Transport/expiry errors and different failures remain failures of this run.
    if (!exactCustomError(error, expectedCustomError)) throw error;
    confirmationError = error;
  }
  // Neither a resolved error nor that narrow rejection proves finality. Require
  // independently fetched FINALIZED metadata and every rollback check below.
  let finalized: TransactionResponse | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    finalized = await connection.getTransaction(signature, { commitment: "finalized" });
    if (finalized !== null) break;
    if (attempt + 1 < attempts) await wait(delayMs);
  }
  need(finalized !== null, "FINALITY", "Finalized transaction metadata is unavailable");
  safeInteger(finalized.slot, "FINALITY", "Invalid finalized transaction slot");
  need(finalized.slot >= beforeResponse.context.slot, "FINALITY", "Transaction predates the baseline");
  const message = finalized.transaction.message, metadata = finalized.meta;
  need(metadata !== null && message.version === "legacy" && finalized.transaction.signatures.length === 1
    && finalized.transaction.signatures[0] === signature, "TRANSACTION", "Finalized legacy transaction identity mismatch");
  need(message.header.numRequiredSignatures === 1 && message.staticAccountKeys[0]?.equals(payer)
    && message.instructions.length === 1 && message.accountKeys[message.instructions[0].programIdIndex]?.equals(programId)
    && message.serialize().equals(requestedMessage), "TRANSACTION", "Finalized instruction, accounts, data or fee payer differ from request");
  need(exactCustomError(confirmationError, expectedCustomError) && exactCustomError(metadata.err, expectedCustomError), "ERROR", "Confirmation and finalized metadata must report the exact instruction-zero custom error");
  const logs = metadata.logMessages ?? [];
  const anchorError = AnchorError.parse(logs);
  need(anchorError !== null && anchorError.error.errorCode.code === expectedErrorName
    && anchorError.error.errorCode.number === expectedCustomError, "ERROR", "Finalized Anchor logs must report the exact expected error name and number");
  safeInteger(metadata.fee, "FEE", "Transaction fee must be losslessly representable");
  need(metadata.fee > 0, "FEE", "A committed failure must charge a positive transaction fee");
  need(metadata.preBalances.length === message.accountKeys.length && metadata.postBalances.length === message.accountKeys.length, "FEE", "Incomplete finalized balance metadata");
  safeInteger(metadata.preBalances[0], "FEE", "Invalid metadata payer pre-balance");
  safeInteger(metadata.postBalances[0], "FEE", "Invalid metadata payer post-balance");
  const fee = BigInt(metadata.fee);
  need(BigInt(metadata.preBalances[0]) - BigInt(metadata.postBalances[0]) === fee, "FEE", "Finalized transaction payer debit is not fee-only");

  for (let index = 1; index < metadata.preBalances.length; index++) {
    safeInteger(metadata.preBalances[index], "FEE", "Invalid non-payer pre-balance");
    safeInteger(metadata.postBalances[index], "FEE", "Invalid non-payer post-balance");
    need(metadata.preBalances[index] === metadata.postBalances[index], "FEE", "Failed transaction changed a non-payer lamport balance");
  }

  const afterResponse = await connection.getMultipleAccountsInfoAndContext(addresses, { commitment: "finalized", minContextSlot: finalized.slot });
  safeInteger(afterResponse.context.slot, "FINALITY", "Invalid after-state slot");
  need(afterResponse.context.slot >= finalized.slot, "FINALITY", "After-state predates the finalized transaction");
  need(afterResponse.value.length === addresses.length, "STATE", "Incomplete after-state snapshot");
  const after = addresses.map((_, index) => snapshot(afterResponse.value[index])), afterPayer = after[watched.length];
  need(afterPayer !== null && afterPayer !== undefined && beforePayer.owner === afterPayer.owner && beforePayer.executable === afterPayer.executable
    && beforePayer.data === afterPayer.data && beforePayer.lamports - afterPayer.lamports === fee
    && beforePayer.lamports === BigInt(metadata.preBalances[0]) && afterPayer.lamports === BigInt(metadata.postBalances[0]),
  "FEE", "Finalized payer snapshot changed beyond the exact metadata fee");
  for (let index = 0; index < watched.length; index++) {
    need(equalState(before[index], after[index]), "STATE", `Failed instruction changed finalized account ${watched[index].toBase58()}`);
  }
  return Object.freeze({ signature, slot: finalized.slot, fee, beforeSlot: beforeResponse.context.slot, afterSlot: afterResponse.context.slot,
    expectedCustomError, expectedErrorName, logs: Object.freeze([...logs]) });
}
