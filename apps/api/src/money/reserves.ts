/**
 * KEEP custody-reserve inspection.
 *
 * A wallet address, treasury balance, or LP position is not proof that SHARDKEEP
 * can honor player withdrawals. Until a reviewed custody registry exists, the
 * only eligible reserve is the standard SPL KEEP associated-token account
 * derived from the configured hot-wallet owner and the configured KEEP mint.
 * This module validates that account from one finalized RPC response before any
 * observed balance is allowed into the solvency comparison.
 */
import { keepAta } from '@shardkeep/chain';
import { TOKEN } from '@shardkeep/shared';
import {
  PublicKey, type AccountInfo, type RpcResponseAndContext,
} from '@solana/web3.js';

/** Standard SPL Token program. Token-2022 accounts are deliberately ineligible
 * until the KEEP mint and custody policy are explicitly migrated and reviewed. */
export const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const TOKEN_ACCOUNT_BYTES = 165;
const RPC_TIMEOUT_MS = 5_000;
const MINT_OFFSET = 0;
const AUTHORITY_OFFSET = 32;
const AMOUNT_OFFSET = 64;
const DELEGATE_OPTION_OFFSET = 72;
const DELEGATE_OFFSET = 76;
const STATE_OFFSET = 108;
const DELEGATED_AMOUNT_OFFSET = 121;

export type CustodyReserveIneligibility =
  | 'account_missing'
  | 'wrong_token_program'
  | 'invalid_token_account_data'
  | 'wrong_mint'
  | 'wrong_authority'
  | 'uninitialized'
  | 'frozen'
  | 'invalid_account_state'
  | 'delegate_present'
  | 'delegated_amount_nonzero';

export interface CustodyReserveEvidence {
  /** This is a liquidity check for the payout hot wallet, not a claim about LP
   * positions, generic treasuries, or hypothetical cold storage. */
  role: 'liquid_hot_custody';
  commitment: 'finalized';
  account: string;
  /** SPL token-account authority, distinct from tokenProgram (the account's
   * on-chain program owner). */
  owner: string;
  mint: string;
  tokenProgram: string | null;
  canonicalAta: boolean;
  slot: number;
  state: 'missing' | 'uninitialized' | 'initialized' | 'frozen' | 'invalid';
  delegate: string | null;
  delegatedAmountBaseUnits: bigint | null;
  observedBalanceBaseUnits: bigint | null;
  observedBalanceKeep: bigint | null;
  eligible: boolean;
  ineligibilityReason: CustodyReserveIneligibility | null;
}

/** Narrow RPC shape so the validator can be unit-tested without a validator. */
export interface FinalizedAccountReader {
  getAccountInfoAndContext(
    address: PublicKey,
    commitment: 'finalized',
  ): Promise<RpcResponseAndContext<AccountInfo<Buffer> | null>>;
}

function readU64(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

function pubkeyAt(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function stateName(value: number): CustodyReserveEvidence['state'] {
  if (value === 0) return 'uninitialized';
  if (value === 1) return 'initialized';
  if (value === 2) return 'frozen';
  return 'invalid';
}

function ineligible(
  base: Omit<CustodyReserveEvidence, 'eligible' | 'ineligibilityReason'>,
  reason: CustodyReserveIneligibility,
): CustodyReserveEvidence {
  return { ...base, eligible: false, ineligibilityReason: reason };
}

/**
 * Inspect exactly one canonical KEEP custody account at finalized commitment.
 * The returned observed balance is evidence, not automatically an eligible
 * reserve: callers MUST require `eligible === true` before totaling it.
 */
export async function inspectFinalizedHotKeepCustody(
  rpc: FinalizedAccountReader,
  hotWallet: PublicKey,
  keepMint: PublicKey,
): Promise<CustodyReserveEvidence> {
  const account = keepAta(hotWallet, keepMint);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let response: RpcResponseAndContext<AccountInfo<Buffer> | null>;
  try {
    response = await Promise.race([
      rpc.getAccountInfoAndContext(account, 'finalized'),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('finalized KEEP custody read timed out (5s)')),
          RPC_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  const info = response.value;
  const expected = {
    role: 'liquid_hot_custody' as const,
    commitment: 'finalized' as const,
    account: account.toBase58(),
    owner: hotWallet.toBase58(),
    mint: keepMint.toBase58(),
    canonicalAta: true,
    slot: response.context.slot,
  };
  if (!info) {
    return ineligible({
      ...expected,
      tokenProgram: null,
      state: 'missing',
      delegate: null,
      delegatedAmountBaseUnits: null,
      observedBalanceBaseUnits: null,
      observedBalanceKeep: null,
    }, 'account_missing');
  }
  const tokenProgram = info.owner.toBase58();
  const unknown = {
    ...expected,
    tokenProgram,
    state: 'invalid' as const,
    delegate: null,
    delegatedAmountBaseUnits: null,
    observedBalanceBaseUnits: null,
    observedBalanceKeep: null,
  };
  if (!info.owner.equals(SPL_TOKEN_PROGRAM_ID)) return ineligible(unknown, 'wrong_token_program');
  if (info.data.length !== TOKEN_ACCOUNT_BYTES) return ineligible(unknown, 'invalid_token_account_data');

  const mint = pubkeyAt(info.data, MINT_OFFSET);
  const authority = pubkeyAt(info.data, AUTHORITY_OFFSET);
  const amountBaseUnits = readU64(info.data, AMOUNT_OFFSET);
  const delegateOption = info.data.readUInt32LE(DELEGATE_OPTION_OFFSET);
  if (delegateOption !== 0 && delegateOption !== 1) {
    return ineligible(unknown, 'invalid_token_account_data');
  }
  const delegate = delegateOption === 1 ? pubkeyAt(info.data, DELEGATE_OFFSET).toBase58() : null;
  const state = stateName(info.data[STATE_OFFSET]!);
  const delegatedAmountBaseUnits = readU64(info.data, DELEGATED_AMOUNT_OFFSET);
  // The ledger denominates whole KEEP. Flooring a fractional on-chain remainder
  // is conservative: dust can never make an under-reserved wallet look covered.
  const observedBalanceKeep = amountBaseUnits / 10n ** BigInt(TOKEN.decimals);
  const decoded = {
    ...expected,
    tokenProgram,
    state,
    delegate,
    delegatedAmountBaseUnits,
    observedBalanceBaseUnits: amountBaseUnits,
    observedBalanceKeep,
  };

  if (!mint.equals(keepMint)) return ineligible(decoded, 'wrong_mint');
  if (!authority.equals(hotWallet)) return ineligible(decoded, 'wrong_authority');
  if (state === 'uninitialized') return ineligible(decoded, 'uninitialized');
  if (state === 'frozen') return ineligible(decoded, 'frozen');
  if (state !== 'initialized') return ineligible(decoded, 'invalid_account_state');
  // A delegated token account is encumbered even when the current delegated
  // amount is zero: the delegate can become usable after a later approval.
  if (delegateOption !== 0 || delegate !== null) return ineligible(decoded, 'delegate_present');
  if (delegatedAmountBaseUnits !== 0n) return ineligible(decoded, 'delegated_amount_nonzero');
  return { ...decoded, eligible: true, ineligibilityReason: null };
}

export class IneligibleCustodyReserveError extends Error {
  constructor(readonly evidence: CustodyReserveEvidence) {
    super(`canonical KEEP custody account is ineligible: ${evidence.ineligibilityReason ?? 'unknown'}`);
    this.name = 'IneligibleCustodyReserveError';
  }
}

/** Production adapter for the existing ReserveReader seam. Invalid custody
 * evidence throws, so the payout gate holds and /por reports coverage unknown. */
export function makeFinalizedHotKeepReserveReader(
  rpc: FinalizedAccountReader,
  hotWallet: PublicKey,
  keepMint: PublicKey,
): () => Promise<CustodyReserveEvidence> {
  return async () => inspectFinalizedHotKeepCustody(rpc, hotWallet, keepMint);
}

/** JSON-safe public evidence. `eligibleBalanceKeep` is the only amount callers
 * may total; it is zero whenever any custody invariant fails. */
export function publicCustodyReserveEvidence(evidence: CustodyReserveEvidence) {
  return {
    role: evidence.role,
    commitment: evidence.commitment,
    account: evidence.account,
    owner: evidence.owner,
    mint: evidence.mint,
    tokenProgram: evidence.tokenProgram,
    canonicalAta: evidence.canonicalAta,
    slot: evidence.slot,
    state: evidence.state,
    delegate: evidence.delegate,
    delegatedAmountBaseUnits: evidence.delegatedAmountBaseUnits?.toString() ?? null,
    observedBalanceBaseUnits: evidence.observedBalanceBaseUnits?.toString() ?? null,
    observedBalanceKeep: evidence.observedBalanceKeep?.toString() ?? null,
    eligibleBalanceKeep: evidence.eligible && evidence.observedBalanceKeep !== null
      ? evidence.observedBalanceKeep.toString()
      : '0',
    eligible: evidence.eligible,
    ineligibilityReason: evidence.ineligibilityReason,
  };
}
