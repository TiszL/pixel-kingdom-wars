/**
 * PROFILE › WALLET server-side balance aggregation (M23 round-3). These pins
 * moved here from the web package when the reads moved server-side: a wallet
 * balance that sums wrong, or renders an RPC failure as 0, is money-adjacent
 * misinformation.
 */
import { Keypair, type Connection, type PublicKey } from '@solana/web3.js';
import { SEEKER, WALLET_HUB } from '@shardkeep/shared';
import { SPL_TOKEN_PROGRAM_ID } from '../src/money/reserves';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertExtraGameTokens, clearWalletBalancesCache, getWalletBalances, invalidateWalletBalances, sumByMint, type ParsedTokenAccountLike,
} from '../src/game/walletBalances';

function acct(mint: string, uiAmount: number | null): ParsedTokenAccountLike {
  return { account: { data: { parsed: { info: { mint, tokenAmount: { uiAmount } } } } } };
}

describe('sumByMint', () => {
  it('sums multiple accounts of one mint (classic + token-2022 can both hold it)', () => {
    expect(sumByMint([acct('A', 1.5), acct('A', 2), acct('B', 7)])).toEqual({ A: 3.5, B: 7 });
  });

  it('treats a null uiAmount as 0 rather than NaN-poisoning the sum', () => {
    expect(sumByMint([acct('A', null), acct('A', 4)])).toEqual({ A: 4 });
  });

  it('omits unheld mints — the caller maps a FAILED cluster to null, so absence stays distinguishable from zero', () => {
    expect(sumByMint([])).toEqual({});
  });
});

describe('getWalletBalances RPC containment', () => {
  beforeEach(() => clearWalletBalancesCache());

  it('does not let an older in-flight read restore a balance invalidated by settlement', async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    let release!: (value: number) => void;
    const getBalance = vi.fn().mockImplementationOnce(() => new Promise<number>((resolve) => { release = resolve; }))
      .mockResolvedValue(999_000_000);
    const connection = { getBalance, getParsedTokenAccountsByOwner: async () => ({ value: [] }) } as unknown as Connection;
    const read = (now: number) => getWalletBalances(wallet, { gameRpcUrl: 'https://game.invalid' }, now, { connectionFactory: () => connection });
    const old = read(1);
    invalidateWalletBalances(wallet);
    expect((await read(2)).sol).toBe(0.999);
    release(1_000_000_000); await old;
    expect((await read(3)).sol).toBe(0.999);
    expect(getBalance).toHaveBeenCalledTimes(2);
  });

  it('reads KEEP from canonical classic and Token-2022 programs without a lookalike address', async () => {
    const programIds: string[] = [];
    const keepMint = WALLET_HUB.tokens.find(token => token.symbol === 'KEEP')!.mint;
    const connection = {
      getBalance: vi.fn(async () => 1_000_000_000),
      getParsedTokenAccountsByOwner: vi.fn(async (
        _owner: PublicKey, filter: { programId: PublicKey },
      ) => {
        programIds.push(filter.programId.toBase58());
        if (filter.programId.equals(SPL_TOKEN_PROGRAM_ID)) return { value: [acct(keepMint, 7)] };
        if (filter.programId.toBase58() === SEEKER.sgt.tokenProgram) return { value: [acct(keepMint, 3)] };
        throw new Error('Invalid param: unrecognized Token program id');
      }),
    } as unknown as Connection;

    const result = await getWalletBalances(
      Keypair.generate().publicKey.toBase58(),
      { gameRpcUrl: 'https://game.invalid' },
      1,
      { connectionFactory: () => connection },
    );

    expect(result.sol).toBe(1);
    expect(result.tokens.KEEP).toBe(10);
    expect(programIds).toEqual([
      SPL_TOKEN_PROGRAM_ID.toBase58(),
      SEEKER.sgt.tokenProgram,
    ]);
  });

  it('contains a rejected token-account RPC and reports that cluster as unavailable', async () => {
    const connection = {
      getBalance: vi.fn(async () => 2_000_000_000),
      getParsedTokenAccountsByOwner: vi.fn(async () => {
        throw new Error('Invalid param: unrecognized Token program id');
      }),
    } as unknown as Connection;

    await expect(getWalletBalances(
      Keypair.generate().publicKey.toBase58(),
      { gameRpcUrl: 'https://game.invalid' },
      2,
      { connectionFactory: () => connection },
    )).resolves.toMatchObject({ sol: 2, tokens: { KEEP: null } });
  });

  // Owner 2026-10-06: "showing onchain is important including test skr". The QA chain lane passes the pinned
  // test SKR mint as an extra game-cluster row; it must read the same devnet RPC as KEEP and keep the
  // null-is-unavailable rule, and production (no extra rows) must keep exactly the catalogue symbols.
  it('adds a host-configured test SKR row from the game cluster, null on a failed read, absent without one', async () => {
    const tskr = Keypair.generate().publicKey.toBase58();
    const holding = {
      getBalance: vi.fn(async () => 1_000_000_000),
      getParsedTokenAccountsByOwner: vi.fn(async (_owner: PublicKey, filter: { programId: PublicKey }) =>
        ({ value: filter.programId.equals(SPL_TOKEN_PROGRAM_ID) ? [acct(tskr, 1000)] : [] })),
    } as unknown as Connection;
    const lane = { gameRpcUrl: 'https://game.invalid', extraGameTokens: [{ symbol: 'tSKR', mint: tskr }] };
    const read = (connection: Connection, rpc: Parameters<typeof getWalletBalances>[1] = lane) =>
      getWalletBalances(Keypair.generate().publicKey.toBase58(), rpc, 1, { connectionFactory: () => connection });
    expect((await read(holding)).tokens.tSKR).toBe(1000);
    const empty = { getBalance: vi.fn(async () => 0), getParsedTokenAccountsByOwner: vi.fn(async () => ({ value: [] })) } as unknown as Connection;
    expect((await read(empty)).tokens.tSKR).toBe(0);
    const failing = { getBalance: vi.fn(async () => 0),
      getParsedTokenAccountsByOwner: vi.fn(async () => { throw new Error('rpc down'); }) } as unknown as Connection;
    expect((await read(failing)).tokens.tSKR).toBeNull();
    expect(Object.keys((await read(holding, { gameRpcUrl: 'https://game.invalid' })).tokens))
      .toEqual(WALLET_HUB.tokens.map(token => token.symbol));
  });

  it('refuses an extra row that would shadow a catalogue symbol or mint, or is malformed', () => {
    const fresh = Keypair.generate().publicKey.toBase58();
    expect(() => assertExtraGameTokens([{ symbol: 'tSKR', mint: fresh }])).not.toThrow();
    const skr = WALLET_HUB.tokens.find(token => token.symbol === 'SKR')!.mint;
    for (const extra of [[{ symbol: 'SKR', mint: fresh }], [{ symbol: 'tSKR', mint: skr }], [{ symbol: 't SKR', mint: fresh }],
      [{ symbol: 'tSKR', mint: 'not-a-key' }], [{ symbol: 'tSKR', mint: fresh }, { symbol: 'tSKR', mint: Keypair.generate().publicKey.toBase58() }]]) {
      expect(() => assertExtraGameTokens(extra)).toThrow();
    }
  });
});
