import { getBase58Decoder } from '@solana/kit';
import { Keypair, type Connection } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import {
  isCanonicalSolanaSignature, keepAta, ReferenceSignatureScanIndeterminateError,
  selectSolPaymentCandidate, verifyKeepDeposit, verifyKeepDepositCommit,
  verifySolPayment, verifySolPaymentCommit, verifySplitPayment,
  verifySplitPaymentCommit,
} from './keepDeposit';

const signatureOf = (byte: number): string => getBase58Decoder().decode(new Uint8Array(64).fill(byte));

describe('selectSolPaymentCandidate', () => {
  it('prefers the exact frozen quote across retry orderings', () => {
    const under = { txSignature: 'under', lamports: 749_999_999n };
    const exact = { txSignature: 'exact', lamports: 750_000_000n };
    const over = { txSignature: 'over', lamports: 750_000_001n };

    expect(selectSolPaymentCandidate([under, exact, over], exact.lamports)).toBe(exact);
    expect(selectSolPaymentCandidate([over, exact, under], exact.lamports)).toBe(exact);
  });

  it('retains a wrong paid attempt for audit when no exact quote exists', () => {
    const newest = { txSignature: 'newest', lamports: 1n };
    expect(selectSolPaymentCandidate([newest], 2n)).toBe(newest);
  });

  it('finds an exact payment at position 17 instead of letting one page of retries bury it', async () => {
    const reference = Keypair.generate().publicKey;
    const signer = Keypair.generate().publicKey;
    const destination = Keypair.generate().publicKey;
    const wrong = Array.from({ length: 16 }, (_, i) => ({
      signature: `wrong-${i}`, err: null, blockTime: 2_000,
    }));
    const getSignaturesForAddress = vi.fn(async (_ref, opts: { before?: string }) => (
      opts.before ? [{ signature: 'exact-17', err: null, blockTime: 2_000 }] : wrong
    ));
    const getTransaction = vi.fn(async (signature: string) => ({
      transaction: { message: { staticAccountKeys: [signer, reference, destination] } },
      meta: {
        err: null, preBalances: [1_000_000_000, 0, 1_000_000_000],
        postBalances: [1_000_000_000, 0, signature === 'exact-17' ? 1_750_000_000 : 1_749_999_999],
      },
    }));
    const connection = { getSignaturesForAddress, getTransaction } as unknown as Connection;

    await expect(verifySolPayment(connection, {
      reference, destination, expectedSigner: signer, expectedLamports: 750_000_000n,
      notBefore: new Date(1_999_000),
    })).resolves.toEqual({ txSignature: 'exact-17', lamports: 750_000_000n });
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(2);
  });

  it('fails indeterminate when the bounded history is full, never reports unpaid', async () => {
    const reference = Keypair.generate().publicKey;
    const signer = Keypair.generate().publicKey;
    const destination = Keypair.generate().publicKey;
    let page = 0;
    const connection = {
      getSignaturesForAddress: vi.fn(async () => Array.from({ length: 16 }, (_, i) => ({
        signature: `spam-${page++}-${i}`, err: null, blockTime: 2_000,
      }))),
      getTransaction: vi.fn(async () => null),
    } as unknown as Connection;
    await expect(verifySolPayment(connection, {
      reference, destination, expectedSigner: signer, expectedLamports: 1n,
      notBefore: new Date(1_999_000),
    })).rejects.toBeInstanceOf(ReferenceSignatureScanIndeterminateError);
  });

  it('finds a KEEP custody deposit behind more than 16 third-party reference spams', async () => {
    const reference = Keypair.generate().publicKey;
    const signer = Keypair.generate().publicKey;
    const spammer = Keypair.generate().publicKey;
    const keepMint = Keypair.generate().publicKey;
    const hotWallet = Keypair.generate().publicKey;
    const hot = keepAta(hotWallet, keepMint);
    const spam = Array.from({ length: 16 }, (_, i) => ({
      signature: `keep-spam-${i}`, err: null, blockTime: 2_000,
    }));
    const connection = {
      getSignaturesForAddress: vi.fn(async (_ref, opts: { before?: string }) => (
        opts.before ? [{ signature: 'keep-paid-17', err: null, blockTime: 2_000 }] : spam
      )),
      getTransaction: vi.fn(async (signature: string) => ({
        transaction: { message: { staticAccountKeys: [
          signature === 'keep-paid-17' ? signer : spammer, reference, hot,
        ] } },
        meta: {
          err: null,
          preTokenBalances: [{ accountIndex: 2, mint: keepMint.toBase58(), uiTokenAmount: { amount: '100' } }],
          postTokenBalances: [{ accountIndex: 2, mint: keepMint.toBase58(), uiTokenAmount: { amount: '125' } }],
        },
      })),
    } as unknown as Connection;
    await expect(verifyKeepDeposit(connection, {
      reference, keepMint, destination: hot, expectedSigner: signer, notBefore: new Date(1_999_000),
    })).resolves.toEqual({ txSignature: 'keep-paid-17', amountBaseUnits: 25n });
  });

  it('finds a marketplace split behind more than 16 third-party reference spams', async () => {
    const reference = Keypair.generate().publicKey;
    const buyer = Keypair.generate().publicKey;
    const spammer = Keypair.generate().publicKey;
    const seller = Keypair.generate().publicKey;
    const feeTreasury = Keypair.generate().publicKey;
    const spam = Array.from({ length: 16 }, (_, i) => ({
      signature: `market-spam-${i}`, err: null, blockTime: 2_000,
    }));
    const connection = {
      getSignaturesForAddress: vi.fn(async (_ref, opts: { before?: string }) => (
        opts.before ? [{ signature: 'market-paid-17', err: null, blockTime: 2_000 }] : spam
      )),
      getTransaction: vi.fn(async (signature: string) => ({
        transaction: { message: { staticAccountKeys: [
          signature === 'market-paid-17' ? buyer : spammer, reference, seller, feeTreasury,
        ], header: { numRequiredSignatures: 1 } } },
        meta: {
          err: null, preBalances: [1_000, 0, 1_000, 1_000],
          postBalances: [1_000, 0, 1_095, 1_005],
        },
      })),
    } as unknown as Connection;
    await expect(verifySplitPayment(connection, {
      reference, buyer, seller, feeTreasury, sellerLamports: 95n, feeLamports: 5n,
      notBefore: new Date(1_999_000),
    })).resolves.toEqual({ txSignature: 'market-paid-17' });
  });

  it('verifies a committed marketplace signature directly before public history', async () => {
    const reference = Keypair.generate().publicKey;
    const buyer = Keypair.generate().publicKey;
    const seller = Keypair.generate().publicKey;
    const feeTreasury = Keypair.generate().publicKey;
    const paymentSignature = signatureOf(7);
    const getSignaturesForAddress = vi.fn();
    const connection = {
      getSignaturesForAddress,
      getTransaction: vi.fn(async () => ({
        transaction: { message: {
          staticAccountKeys: [buyer, reference, seller, feeTreasury],
          header: { numRequiredSignatures: 1 },
        } },
        meta: { err: null, preBalances: [1_000, 0, 1_000, 1_000], postBalances: [1_000, 0, 1_095, 1_005] },
      })),
    } as unknown as Connection;
    await expect(verifySplitPayment(connection, {
      reference, buyer, seller, feeTreasury, sellerLamports: 95n, feeLamports: 5n,
      paymentSignature, notBefore: new Date(1_999_000),
    })).resolves.toEqual({ txSignature: paymentSignature });
    expect(getSignaturesForAddress).not.toHaveBeenCalled();
  });

  it('proves an exact direct-SOL signature at confirmed without consulting spammed reference history', async () => {
    const reference = Keypair.generate().publicKey;
    const signer = Keypair.generate().publicKey;
    const destination = Keypair.generate().publicKey;
    const paymentSignature = signatureOf(21);
    const getSignaturesForAddress = vi.fn();
    const getTransaction = vi.fn(async () => ({
      transaction: { message: { staticAccountKeys: [signer, reference, destination] } },
      meta: { err: null, preBalances: [1_000, 0, 500], postBalances: [900, 0, 750] },
    }));
    await expect(verifySolPaymentCommit({ getTransaction, getSignaturesForAddress } as unknown as Connection, {
      reference, destination, expectedSigner: signer, expectedLamports: 250n, paymentSignature,
    })).resolves.toEqual({ txSignature: paymentSignature, lamports: 250n });
    expect(getTransaction).toHaveBeenCalledWith(paymentSignature, {
      commitment: 'confirmed', maxSupportedTransactionVersion: 0,
    });
    expect(getSignaturesForAddress).not.toHaveBeenCalled();
  });

  it('proves an exact KEEP custody signature at confirmed without accepting a public signature hint', async () => {
    const reference = Keypair.generate().publicKey;
    const signer = Keypair.generate().publicKey;
    const keepMint = Keypair.generate().publicKey;
    const hotWallet = Keypair.generate().publicKey;
    const hot = keepAta(hotWallet, keepMint);
    const paymentSignature = signatureOf(22);
    const getTransaction = vi.fn(async () => ({
      transaction: { message: { staticAccountKeys: [signer, reference, hot] } },
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 2, mint: keepMint.toBase58(), uiTokenAmount: { amount: '100' } }],
        postTokenBalances: [{ accountIndex: 2, mint: keepMint.toBase58(), uiTokenAmount: { amount: '125' } }],
      },
    }));
    await expect(verifyKeepDepositCommit({ getTransaction } as unknown as Connection, {
      reference, keepMint, destination: hot, expectedSigner: signer, paymentSignature,
    })).resolves.toEqual({ txSignature: paymentSignature, amountBaseUnits: 25n });
  });

  it('accepts only canonical 64-byte base58 transaction signatures', () => {
    const canonical = signatureOf(9);
    expect(isCanonicalSolanaSignature(canonical)).toBe(true);
    expect(isCanonicalSolanaSignature('not-base58-0OIl')).toBe(false);
    expect(isCanonicalSolanaSignature(getBase58Decoder().decode(new Uint8Array(63).fill(9)))).toBe(false);
    expect(isCanonicalSolanaSignature(getBase58Decoder().decode(new Uint8Array(65).fill(9)))).toBe(false);
  });

  it('proves the exact submitted split at confirmed before a reservation can be extended', async () => {
    const reference = Keypair.generate().publicKey;
    const buyer = Keypair.generate().publicKey;
    const seller = Keypair.generate().publicKey;
    const feeTreasury = Keypair.generate().publicKey;
    const paymentSignature = signatureOf(11);
    const getTransaction = vi.fn(async () => ({
      transaction: { message: {
        staticAccountKeys: [buyer, reference, seller, feeTreasury],
        header: { numRequiredSignatures: 1 },
      } },
      meta: {
        err: null,
        preBalances: [1_000, 0, 1_000, 1_000],
        postBalances: [900, 0, 1_095, 1_005],
      },
    }));
    const connection = { getTransaction } as unknown as Connection;

    await expect(verifySplitPaymentCommit(connection, {
      reference, buyer, seller, feeTreasury, sellerLamports: 95n, feeLamports: 5n,
      paymentSignature,
    })).resolves.toEqual({ txSignature: paymentSignature });
    expect(getTransaction).toHaveBeenCalledWith(paymentSignature, {
      commitment: 'confirmed', maxSupportedTransactionVersion: 0,
    });
  });

  it('rejects malformed, wrong-party, wrong-reference, and non-exact commit proofs', async () => {
    const reference = Keypair.generate().publicKey;
    const buyer = Keypair.generate().publicKey;
    const seller = Keypair.generate().publicKey;
    const feeTreasury = Keypair.generate().publicKey;
    const stranger = Keypair.generate().publicKey;
    const paymentSignature = signatureOf(12);
    const cases = [
      { keys: [stranger, reference, seller, feeTreasury], post: [900, 0, 1_095, 1_005] },
      { keys: [buyer, stranger, seller, feeTreasury], post: [900, 0, 1_095, 1_005] },
      { keys: [buyer, reference, seller, feeTreasury], post: [900, 0, 1_096, 1_005] },
      { keys: [buyer, reference, seller, feeTreasury], post: [900, 0, 1_095, 1_004] },
    ];
    for (const candidate of cases) {
      const connection = {
        getTransaction: vi.fn(async () => ({
          transaction: { message: {
            staticAccountKeys: candidate.keys,
            header: { numRequiredSignatures: 1 },
          } },
          meta: { err: null, preBalances: [1_000, 0, 1_000, 1_000], postBalances: candidate.post },
        })),
      } as unknown as Connection;
      await expect(verifySplitPaymentCommit(connection, {
        reference, buyer, seller, feeTreasury, sellerLamports: 95n, feeLamports: 5n,
        paymentSignature,
      })).resolves.toBeNull();
    }

    const getTransaction = vi.fn();
    await expect(verifySplitPaymentCommit({ getTransaction } as unknown as Connection, {
      reference, buyer, seller, feeTreasury, sellerLamports: 95n, feeLamports: 5n,
      paymentSignature: 'malformed',
    })).resolves.toBeNull();
    expect(getTransaction).not.toHaveBeenCalled();
  });
});

/**
 * Explicit-destination KEEP transfers (E2-GEMS-CONTRACT §2, §7; GEMS-CURRENCY §4).
 * WHY: the same verifier now backs two rails — custody `keep_deposit` (hot
 * wallet ATA) and `gems_buy` (emission-reserve ATA). A transfer that lands in
 * ANY other token account, including one the same owner controls, must never
 * credit, or the credit would be unbacked off the tracked reserve. A v0 tx may
 * carry the reserve ATA in an address lookup table (refuter R9) and must still
 * verify. The verifier reports the RAW observed delta: the API floors it to
 * whole KEEP, so sub-KEEP dust is reported, disclosed and never rounded up.
 */
describe('explicit destination token account', () => {
  const keepDelta = (index: number, mint: string, pre: string, post: string) => ({
    preTokenBalances: [{ accountIndex: index, mint, uiTokenAmount: { amount: pre } }],
    postTokenBalances: [{ accountIndex: index, mint, uiTokenAmount: { amount: post } }],
  });

  it('never credits a transfer that landed anywhere but the explicit destination (same owner included)', async () => {
    const reference = Keypair.generate().publicKey;
    const signer = Keypair.generate().publicKey;
    const keepMint = Keypair.generate().publicKey;
    const reserveOwner = Keypair.generate().publicKey;
    const reserve = keepAta(reserveOwner, keepMint);
    // An auxiliary token account owned by the same reserve wallet: NOT the destination.
    const auxiliary = Keypair.generate().publicKey;
    const paymentSignature = signatureOf(40);
    const getTransaction = vi.fn(async () => ({
      transaction: { message: { staticAccountKeys: [signer, reference, auxiliary] } },
      meta: { err: null, ...keepDelta(2, keepMint.toBase58(), '0', '5000000000') },
    }));
    const connection = { getTransaction, getSignaturesForAddress: vi.fn(async () => []) } as unknown as Connection;
    await expect(verifyKeepDepositCommit(connection, {
      reference, keepMint, destination: reserve, expectedSigner: signer, paymentSignature,
    })).resolves.toBeNull();
    await expect(verifyKeepDeposit(connection, {
      reference, keepMint, destination: reserve, expectedSigner: signer, paymentSignature, notBefore: new Date(1_999_000),
    })).resolves.toBeNull();
    // The very same transaction credits when the reserve ATA is the destination in question.
    await expect(verifyKeepDepositCommit(connection, {
      reference, keepMint, destination: auxiliary, expectedSigner: signer, paymentSignature,
    })).resolves.toEqual({ txSignature: paymentSignature, amountBaseUnits: 5_000_000_000n });
  });

  it('credits a v0 transaction whose destination ATA is resolved from an address lookup table', async () => {
    const reference = Keypair.generate().publicKey;
    const signer = Keypair.generate().publicKey;
    const keepMint = Keypair.generate().publicKey;
    const reserve = keepAta(Keypair.generate().publicKey, keepMint);
    const unrelatedWritable = Keypair.generate().publicKey;
    const paymentSignature = signatureOf(41);
    // Static keys: [signer, reference]; loaded (LUT) keys: writable [unrelated, reserve].
    // accountIndex 3 = 2 static + index 1 of the writable loaded list.
    const getTransaction = vi.fn(async () => ({
      transaction: { message: { staticAccountKeys: [signer, reference] } },
      meta: {
        err: null,
        loadedAddresses: { writable: [unrelatedWritable, reserve], readonly: [] },
        ...keepDelta(3, keepMint.toBase58(), '1000000000', '13000000000'),
      },
    }));
    const getSignaturesForAddress = vi.fn(async () => [{ signature: paymentSignature, err: null, blockTime: 2_000 }]);
    const connection = { getTransaction, getSignaturesForAddress } as unknown as Connection;
    await expect(verifyKeepDepositCommit(connection, {
      reference, keepMint, destination: reserve, expectedSigner: signer, paymentSignature,
    })).resolves.toEqual({ txSignature: paymentSignature, amountBaseUnits: 12_000_000_000n });
    // The reference-history path resolves the same loaded keys.
    await expect(verifyKeepDeposit(connection, {
      reference, keepMint, destination: reserve, expectedSigner: signer, notBefore: new Date(1_999_000),
    })).resolves.toEqual({ txSignature: paymentSignature, amountBaseUnits: 12_000_000_000n });
    // A static-only reading of the same message would not find the destination.
    const staticOnly = { getTransaction: vi.fn(async () => ({
      transaction: { message: { staticAccountKeys: [signer, reference] } },
      meta: { err: null, ...keepDelta(3, keepMint.toBase58(), '1000000000', '13000000000') },
    })) } as unknown as Connection;
    await expect(verifyKeepDepositCommit(staticOnly, {
      reference, keepMint, destination: reserve, expectedSigner: signer, paymentSignature,
    })).resolves.toBeNull();
  });

  it('reports sub-KEEP dust as the raw observed delta and never rounds it up to a whole KEEP', async () => {
    const reference = Keypair.generate().publicKey;
    const signer = Keypair.generate().publicKey;
    const keepMint = Keypair.generate().publicKey;
    const reserve = keepAta(Keypair.generate().publicKey, keepMint);
    const paymentSignature = signatureOf(42);
    const dust = 999_999_999n; // one base unit short of 1 KEEP at 9 decimals
    const getTransaction = vi.fn(async () => ({
      transaction: { message: { staticAccountKeys: [signer, reference, reserve] } },
      meta: { err: null, ...keepDelta(2, keepMint.toBase58(), '0', dust.toString()) },
    }));
    const connection = { getTransaction } as unknown as Connection;
    // Reported (so the deposit row can disclose it), exactly as observed: the
    // whole-KEEP floor — and the refusal to credit 0 — is the API's job.
    await expect(verifyKeepDepositCommit(connection, {
      reference, keepMint, destination: reserve, expectedSigner: signer, paymentSignature,
    })).resolves.toEqual({ txSignature: paymentSignature, amountBaseUnits: dust });
    expect(dust / 1_000_000_000n).toBe(0n);
    // A zero or negative delta at the destination is not a deposit at all.
    const drained = { getTransaction: vi.fn(async () => ({
      transaction: { message: { staticAccountKeys: [signer, reference, reserve] } },
      meta: { err: null, ...keepDelta(2, keepMint.toBase58(), '5', '5') },
    })) } as unknown as Connection;
    await expect(verifyKeepDepositCommit(drained, {
      reference, keepMint, destination: reserve, expectedSigner: signer, paymentSignature,
    })).resolves.toBeNull();
  });
});

describe('marketplace strict uncertainty', () => {
  const terms = () => ({ reference: Keypair.generate().publicKey, buyer: Keypair.generate().publicKey,
    seller: Keypair.generate().publicKey, feeTreasury: Keypair.generate().publicKey, sellerLamports: 95n, feeLamports: 5n });
  it.each([null, { transaction: { message: {} }, meta: null }])('does not turn an unavailable finalized body into permission to reclaim', async (body) => {
    const connection = { getSignaturesForAddress: vi.fn(async () => [{ signature: signatureOf(60), err: null, blockTime: 2_000 }]),
      getTransaction: vi.fn(async () => body) } as unknown as Connection;
    const quote = terms();
    await expect(verifySplitPayment(connection, { ...quote, strictUncertainty: true })).rejects.toThrow(/body is unavailable/);
    // Existing non-market callers keep their previous opt-in boundary.
    await expect(verifySplitPayment(connection, quote)).resolves.toBeNull();
  });
  it('never swallows a direct committed-proof RPC failure into an empty history scan', async () => {
    const history = vi.fn(async () => []);
    const connection = { getSignaturesForAddress: history, getTransaction: vi.fn(async () => { throw new Error('RPC unavailable'); }) } as unknown as Connection;
    const quote = { ...terms(), paymentSignature: signatureOf(61) };
    await expect(verifySplitPayment(connection, { ...quote, strictUncertainty: true })).rejects.toThrow('RPC unavailable');
    expect(history).not.toHaveBeenCalled();
    await expect(verifySplitPayment(connection, quote)).resolves.toBeNull();
  });
  it('holds a direct signature whose transaction is unavailable even if reference history is empty', async () => {
    const history = vi.fn(async () => []);
    const connection = { getSignaturesForAddress: history, getTransaction: vi.fn(async () => null) } as unknown as Connection;
    await expect(verifySplitPayment(connection, { ...terms(), paymentSignature: signatureOf(62), strictUncertainty: true })).rejects.toThrow(/proof is unavailable/);
    expect(history).not.toHaveBeenCalled();
  });
  it('permits a complete empty observation only when no committed signature needs proving', async () => {
    const connection = { getSignaturesForAddress: vi.fn(async () => []), getTransaction: vi.fn() } as unknown as Connection;
    await expect(verifySplitPayment(connection, { ...terms(), strictUncertainty: true })).resolves.toBeNull();
    expect(connection.getTransaction).not.toHaveBeenCalled();
  });
});
