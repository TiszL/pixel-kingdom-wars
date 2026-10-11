import { Connection, Keypair, SystemProgram, Transaction, type PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import {
  CORE_PROGRAM_ID, coreProgram, encodePostRootArgs, epochRootPda,
  EpochRootMismatchError, EpochRootRecoverySignatureError,
  EpochRootSignatureIndeterminateError, makeProvider, postEpochRootIdempotently,
} from './programs';

const ACCOUNT_DISCRIMINATOR = [84, 115, 245, 96, 45, 165, 224, 31];

function epochRootAccount(epoch: bigint, root: Uint8Array, total: bigint): Buffer {
  const data = Buffer.alloc(65);
  data.set(ACCOUNT_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(epoch, 8);
  data.set(root, 16);
  data.writeBigUInt64LE(total, 48);
  data.writeBigInt64LE(1_700_000_000n, 56);
  data[64] = 255;
  return data;
}

function compileMessage(instruction: Parameters<Transaction['add']>[0], feePayer: PublicKey) {
  return new Transaction({
    feePayer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(instruction).compileMessage();
}

describe('epoch-root Anchor serialization', () => {
  it('constructs u64 arguments through Anchor BN in the production dependency shape', () => {
    const root = new Uint8Array(32);
    root.set([0, 1, 127, 255]);
    const [epoch, encodedRoot, totalBalance] = encodePostRootArgs(
      18_446_744_073_709_551_615n,
      root,
      9_007_199_254_740_993n,
    );

    // Decimal strings preserve u64 values beyond JS's safe integer range. This
    // regression fails at construction if the CommonJS package is read through
    // the former undefined dynamic-import `.default.BN` boundary.
    expect(epoch.toString()).toBe('18446744073709551615');
    expect(encodedRoot).toEqual(Array.from(root));
    expect(totalBalance.toString()).toBe('9007199254740993');
  });

  it('rejects values Anchor would otherwise reinterpret, pad, or truncate', () => {
    const root = new Uint8Array(32);
    const overflow = 1n << 64n;
    expect(() => encodePostRootArgs(-1n, root, 0n)).toThrow('epoch must fit u64');
    expect(() => encodePostRootArgs(overflow, root, 0n)).toThrow('epoch must fit u64');
    expect(() => encodePostRootArgs(0n, root, -1n)).toThrow('total balance must fit u64');
    expect(() => encodePostRootArgs(0n, root, overflow)).toThrow('total balance must fit u64');
    expect(() => encodePostRootArgs(0n, new Uint8Array(31), 0n)).toThrow('exactly 32 bytes');
    expect(() => encodePostRootArgs(0n, new Uint8Array(33), 0n)).toThrow('exactly 32 bytes');
  });

  it('produces the exact post_root Borsh instruction bytes', async () => {
    const admin = Keypair.generate();
    const epoch = 0x0102_0304_0506_0708n;
    const total = 0x1112_1314_1516_1718n;
    const root = Uint8Array.from({ length: 32 }, (_, i) => i);
    const program = coreProgram(makeProvider(new Connection('http://127.0.0.1:8899'), admin));
    const instruction = await program.methods['postRoot']!(...encodePostRootArgs(epoch, root, total))
      .accounts({ admin: admin.publicKey })
      .instruction();

    const expected = Buffer.alloc(56);
    expected.set([154, 210, 156, 158, 199, 27, 174, 35], 0);
    expected.writeBigUInt64LE(epoch, 8);
    expected.set(root, 16);
    expected.writeBigUInt64LE(total, 48);
    expect(instruction.data).toEqual(expected);
  });

  it('submits through a dust-prefunded PDA and reconciles a lost RPC response', async () => {
    const admin = Keypair.generate();
    const epoch = 17n;
    const total = 123_456_789n;
    const root = new Uint8Array(32).fill(0xab);
    const pda = epochRootPda(epoch);
    const exactInstruction = await coreProgram(
      makeProvider(new Connection('http://127.0.0.1:8899'), admin),
    ).methods['postRoot']!(...encodePostRootArgs(epoch, root, total))
      .accounts({ admin: admin.publicKey })
      .instruction();
    const fundingInstruction = SystemProgram.transfer({
      fromPubkey: admin.publicKey, toPubkey: pda, lamports: 1,
    });
    const getAccountInfo = vi.fn()
      .mockResolvedValueOnce({
        data: Buffer.alloc(0), owner: SystemProgram.programId,
        executable: false, lamports: 890_880, rentEpoch: 0,
      })
      .mockResolvedValueOnce({
        data: epochRootAccount(epoch, root, total), owner: CORE_PROGRAM_ID,
        executable: false, lamports: 1, rentEpoch: 0,
      });
    const getSignaturesForAddress = vi.fn(async (
      _pda: PublicKey, _opts: { limit: number },
    ) => [
      { signature: 'landed-signature', err: null, memo: null, blockTime: 2, slot: 2 },
      { signature: 'attacker-prefund', err: null, memo: null, blockTime: 1, slot: 1 },
    ]);
    const getTransactions = vi.fn(async () => [
      {
        transaction: { message: compileMessage(exactInstruction, admin.publicKey) },
        // Anchor can initialize a pre-funded PDA, so the exact instruction—not
        // a zero pre-balance—is what proves this is the posting transaction.
        meta: { err: null, preBalances: [10, 1], postBalances: [9, 2] },
      },
      {
        transaction: { message: compileMessage(fundingInstruction, admin.publicKey) },
        meta: { err: null, preBalances: [10, 0], postBalances: [9, 1] },
      },
    ]);
    const connection = { getAccountInfo, getSignaturesForAddress, getTransactions } as unknown as Connection;
    const submit = vi.fn(async () => { throw new Error('RPC response lost'); });

    await expect(postEpochRootIdempotently(
      connection, epoch, root, total, submit,
    )).resolves.toBe('landed-signature');
    expect(submit).toHaveBeenCalledOnce();
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(1);
    expect(getSignaturesForAddress.mock.calls[0]?.[1]).toEqual({ limit: 20 });
    expect(getTransactions).toHaveBeenCalledTimes(1);
  });

  it('uses a guarded exact recovery signature after history spam and admin rotation', async () => {
    const historicalAdmin = Keypair.generate();
    const epoch = 21n;
    const total = 77n;
    const root = new Uint8Array(32).fill(5);
    const exactInstruction = await coreProgram(
      makeProvider(new Connection('http://127.0.0.1:8899'), historicalAdmin),
    ).methods['postRoot']!(...encodePostRootArgs(epoch, root, total))
      .accounts({ admin: historicalAdmin.publicKey })
      .instruction();
    const getTransaction = vi.fn(async () => ({
      transaction: { message: compileMessage(exactInstruction, historicalAdmin.publicKey) },
      meta: { err: null },
    }));
    const connection = {
      getAccountInfo: vi.fn(async () => ({
        data: epochRootAccount(epoch, root, total), owner: CORE_PROGRAM_ID,
        executable: false, lamports: 1, rentEpoch: 0,
      })),
      getTransaction,
      getSignaturesForAddress: vi.fn(async () => { throw new Error('must not scan'); }),
    } as unknown as Connection;
    const submit = vi.fn(async () => 'must-not-send');

    await expect(postEpochRootIdempotently(
      connection, epoch, root, total, submit, 'operator-supplied-signature',
    )).resolves.toBe('operator-supplied-signature');
    expect(getTransaction).toHaveBeenCalledWith('operator-supplied-signature', {
      commitment: 'confirmed', maxSupportedTransactionVersion: 0,
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('never treats an exact-looking transaction without success metadata as proof', async () => {
    const admin = Keypair.generate();
    const epoch = 22n;
    const total = 88n;
    const root = new Uint8Array(32).fill(6);
    const exactInstruction = await coreProgram(
      makeProvider(new Connection('http://127.0.0.1:8899'), admin),
    ).methods['postRoot']!(...encodePostRootArgs(epoch, root, total))
      .accounts({ admin: admin.publicKey })
      .instruction();
    const exactLooking = {
      transaction: { message: compileMessage(exactInstruction, admin.publicKey) },
      meta: null,
    };
    const account = {
      data: epochRootAccount(epoch, root, total), owner: CORE_PROGRAM_ID,
      executable: false, lamports: 1, rentEpoch: 0,
    };
    const automatic = {
      getAccountInfo: vi.fn(async () => account),
      getSignaturesForAddress: vi.fn(async () => [{
        signature: 'metadata-missing', err: null, memo: null, blockTime: 1, slot: 1,
      }]),
      getTransactions: vi.fn(async () => [exactLooking]),
    } as unknown as Connection;
    await expect(postEpochRootIdempotently(
      automatic, epoch, root, total, async () => 'must-not-send',
    )).rejects.toBeInstanceOf(EpochRootSignatureIndeterminateError);

    const configured = {
      getAccountInfo: vi.fn(async () => account),
      getTransaction: vi.fn(async () => exactLooking),
    } as unknown as Connection;
    await expect(postEpochRootIdempotently(
      configured, epoch, root, total, async () => 'must-not-send', 'metadata-missing',
    )).rejects.toBeInstanceOf(EpochRootRecoverySignatureError);
  });

  it('never accepts a successful spoof transfer as post_root proof', async () => {
    const admin = Keypair.generate();
    const epoch = 19n;
    const root = new Uint8Array(32).fill(3);
    const pda = epochRootPda(epoch);
    const spoof = SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: pda, lamports: 1 });
    const connection = {
      getAccountInfo: vi.fn(async () => ({
        data: epochRootAccount(epoch, root, 8n), owner: CORE_PROGRAM_ID,
        executable: false, lamports: 1, rentEpoch: 0,
      })),
      getSignaturesForAddress: vi.fn(async () => [{
        signature: 'spoof-transfer', err: null, memo: null, blockTime: 1, slot: 1,
      }]),
      getTransactions: vi.fn(async () => [{
        transaction: { message: compileMessage(spoof, admin.publicKey) },
        meta: { err: null, preBalances: [10, 0], postBalances: [9, 1] },
      }]),
    } as unknown as Connection;
    const submit = vi.fn(async () => 'must-not-send');

    await expect(postEpochRootIdempotently(
      connection, epoch, root, 8n, submit,
    )).rejects.toBeInstanceOf(EpochRootSignatureIndeterminateError);
    expect(submit).not.toHaveBeenCalled();
  });

  it('uses one bounded batch and fails loud when exact history is outside it', async () => {
    const admin = Keypair.generate();
    const epoch = 20n;
    const root = new Uint8Array(32).fill(4);
    const pda = epochRootPda(epoch);
    const spoof = compileMessage(SystemProgram.transfer({
      fromPubkey: admin.publicKey, toPubkey: pda, lamports: 1,
    }), admin.publicKey);
    const signatures = Array.from({ length: 20 }, (_, i) => ({
      signature: `spam-${i}`, err: null, memo: null, blockTime: i, slot: i,
    }));
    const getSignaturesForAddress = vi.fn(async () => signatures);
    const getTransactions = vi.fn(async () => signatures.map(() => ({
      transaction: { message: spoof }, meta: { err: null },
    })));
    const connection = {
      getAccountInfo: vi.fn(async () => ({
        data: epochRootAccount(epoch, root, 9n), owner: CORE_PROGRAM_ID,
        executable: false, lamports: 1, rentEpoch: 0,
      })),
      getSignaturesForAddress,
      getTransactions,
    } as unknown as Connection;

    await expect(postEpochRootIdempotently(
      connection, epoch, root, 9n, async () => 'must-not-send',
    )).rejects.toThrow('operator recovery is required');
    expect(getSignaturesForAddress).toHaveBeenCalledOnce();
    expect(getTransactions).toHaveBeenCalledOnce();
  });

  it('fails loud when an immutable epoch PDA contains different data', async () => {
    const epoch = 18n;
    const expectedRoot = new Uint8Array(32).fill(1);
    const connection = {
      getAccountInfo: vi.fn(async (_pda: PublicKey) => ({
        data: epochRootAccount(epoch, new Uint8Array(32).fill(2), 5n),
        owner: CORE_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0,
      })),
    } as unknown as Connection;
    const submit = vi.fn(async () => 'must-not-send');

    await expect(postEpochRootIdempotently(
      connection, epoch, expectedRoot, 5n, submit,
    ))
      .rejects.toBeInstanceOf(EpochRootMismatchError);
    expect(submit).not.toHaveBeenCalled();
  });
});
