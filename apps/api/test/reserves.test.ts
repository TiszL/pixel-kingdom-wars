import { keepAta } from '@shardkeep/chain';
import { TOKEN } from '@shardkeep/shared';
import { Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import {
  inspectFinalizedHotKeepCustody,
  SPL_TOKEN_PROGRAM_ID,
  type FinalizedAccountReader,
} from '../src/money/reserves';

interface TokenAccountOpts {
  mint?: PublicKey;
  authority?: PublicKey;
  amountBaseUnits?: bigint;
  state?: number;
  delegate?: PublicKey | null;
  delegatedAmountBaseUnits?: bigint;
  program?: PublicKey;
  dataLength?: number;
}

function tokenAccount(
  expectedMint: PublicKey,
  expectedAuthority: PublicKey,
  opts: TokenAccountOpts = {},
): AccountInfo<Buffer> {
  const data = Buffer.alloc(opts.dataLength ?? 165);
  if (data.length >= 165) {
    (opts.mint ?? expectedMint).toBuffer().copy(data, 0);
    (opts.authority ?? expectedAuthority).toBuffer().copy(data, 32);
    data.writeBigUInt64LE(opts.amountBaseUnits ?? 25_000_000_123n, 64);
    const delegate = opts.delegate ?? null;
    data.writeUInt32LE(delegate ? 1 : 0, 72);
    if (delegate) delegate.toBuffer().copy(data, 76);
    data[108] = opts.state ?? 1;
    data.writeBigUInt64LE(opts.delegatedAmountBaseUnits ?? 0n, 121);
  }
  return {
    data,
    executable: false,
    lamports: 2_039_280,
    owner: opts.program ?? SPL_TOKEN_PROGRAM_ID,
    rentEpoch: 1,
  };
}

function reader(value: AccountInfo<Buffer> | null, slot = 99) {
  const calls: Array<{ address: string; commitment: string }> = [];
  const rpc: FinalizedAccountReader = {
    async getAccountInfoAndContext(address, commitment) {
      calls.push({ address: address.toBase58(), commitment });
      return { context: { slot }, value };
    },
  };
  return { rpc, calls };
}

describe('finalized KEEP custody eligibility', () => {
  const hot = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;

  it('counts only the canonical finalized initialized unencumbered hot-wallet ATA', async () => {
    const amount = 25n * 10n ** BigInt(TOKEN.decimals) + 123n;
    const { rpc, calls } = reader(tokenAccount(mint, hot, { amountBaseUnits: amount }), 456);
    const evidence = await inspectFinalizedHotKeepCustody(rpc, hot, mint);

    expect(calls).toEqual([{
      address: keepAta(hot, mint).toBase58(), commitment: 'finalized',
    }]);
    expect(evidence).toMatchObject({
      role: 'liquid_hot_custody', commitment: 'finalized',
      account: keepAta(hot, mint).toBase58(), owner: hot.toBase58(),
      mint: mint.toBase58(), tokenProgram: SPL_TOKEN_PROGRAM_ID.toBase58(),
      canonicalAta: true, slot: 456, state: 'initialized', delegate: null,
      observedBalanceBaseUnits: amount, observedBalanceKeep: 25n,
      delegatedAmountBaseUnits: 0n, eligible: true, ineligibilityReason: null,
    });
  });

  it('clears the RPC deadline after a prompt finalized response', async () => {
    vi.useFakeTimers();
    try {
      const { rpc } = reader(tokenAccount(mint, hot));
      await inspectFinalizedHotKeepCustody(rpc, hot, mint);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the canonical ATA is missing or is not a classic SPL token account', async () => {
    const missing = await inspectFinalizedHotKeepCustody(reader(null, 12).rpc, hot, mint);
    expect(missing).toMatchObject({
      slot: 12, state: 'missing', observedBalanceKeep: null,
      eligible: false, ineligibilityReason: 'account_missing',
    });

    const wrongProgram = await inspectFinalizedHotKeepCustody(
      reader(tokenAccount(mint, hot, { program: Keypair.generate().publicKey })).rpc, hot, mint,
    );
    expect(wrongProgram).toMatchObject({ eligible: false, ineligibilityReason: 'wrong_token_program' });

    const malformed = await inspectFinalizedHotKeepCustody(
      reader(tokenAccount(mint, hot, { dataLength: 64 })).rpc, hot, mint,
    );
    expect(malformed).toMatchObject({ eligible: false, ineligibilityReason: 'invalid_token_account_data' });
  });

  it('rejects the wrong mint or token authority even at the canonical address', async () => {
    const wrongMint = await inspectFinalizedHotKeepCustody(
      reader(tokenAccount(mint, hot, { mint: Keypair.generate().publicKey })).rpc, hot, mint,
    );
    expect(wrongMint).toMatchObject({ eligible: false, ineligibilityReason: 'wrong_mint' });

    const wrongAuthority = await inspectFinalizedHotKeepCustody(
      reader(tokenAccount(mint, hot, { authority: Keypair.generate().publicKey })).rpc, hot, mint,
    );
    expect(wrongAuthority).toMatchObject({ eligible: false, ineligibilityReason: 'wrong_authority' });
  });

  it.each([
    [0, 'uninitialized'],
    [2, 'frozen'],
    [7, 'invalid_account_state'],
  ] as const)('rejects token-account state %i (%s)', async (state, reason) => {
    const evidence = await inspectFinalizedHotKeepCustody(
      reader(tokenAccount(mint, hot, { state })).rpc, hot, mint,
    );
    expect(evidence).toMatchObject({ eligible: false, ineligibilityReason: reason });
  });

  it('rejects both an active delegate and a non-zero delegated amount', async () => {
    const delegate = Keypair.generate().publicKey;
    const delegated = await inspectFinalizedHotKeepCustody(
      reader(tokenAccount(mint, hot, { delegate })).rpc, hot, mint,
    );
    expect(delegated).toMatchObject({
      eligible: false, ineligibilityReason: 'delegate_present', delegate: delegate.toBase58(),
    });

    const encumbered = await inspectFinalizedHotKeepCustody(
      reader(tokenAccount(mint, hot, { delegatedAmountBaseUnits: 1n })).rpc, hot, mint,
    );
    expect(encumbered).toMatchObject({
      eligible: false, ineligibilityReason: 'delegated_amount_nonzero',
      delegatedAmountBaseUnits: 1n,
    });

    const invalidOption = tokenAccount(mint, hot);
    invalidOption.data.writeUInt32LE(2, 72);
    const malformed = await inspectFinalizedHotKeepCustody(reader(invalidOption).rpc, hot, mint);
    expect(malformed).toMatchObject({
      eligible: false, ineligibilityReason: 'invalid_token_account_data',
    });
  });
});
