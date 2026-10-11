/**
 * PROFILE › WALLET on-chain balance reads, SERVER-SIDE (owner 2026-08-16:
 * "does not load balances except devnet sol" — browser reads of the public
 * mainnet RPC die on CORS/rate limits, so the api reads instead: no browser
 * origin, retryable, and one 30s cache entry per wallet keeps the RPC load
 * bounded no matter how often the tab is opened).
 *
 * Shape discipline (mirrors the client's old rule, now enforced here): a mint
 * the wallet does not hold is 0; a cluster whose read FAILED is null — an RPC
 * hiccup must never render as an empty wallet.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { SEEKER, WALLET_HUB } from '@shardkeep/shared';
import { SPL_TOKEN_PROGRAM_ID } from '../money/reserves';

/** Classic SPL Token + Token-2022 — both queried so a Token-2022 asset can
 * never silently read as zero. */
const TOKEN_PROGRAM_IDS = [
  SPL_TOKEN_PROGRAM_ID.toBase58(),
  SEEKER.sgt.tokenProgram,
] as const;

export interface ParsedTokenAccountLike {
  account: {
    data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } };
  };
}

/** Sum parsed token accounts per mint (a wallet can hold several accounts of
 * one mint across the two token programs). Pure; pinned by wallet-balances.test.ts. */
export function sumByMint(accounts: ParsedTokenAccountLike[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of accounts) {
    const info = a.account.data.parsed.info;
    out[info.mint] = (out[info.mint] ?? 0) + (info.tokenAmount.uiAmount ?? 0);
  }
  return out;
}

export interface WalletBalancesDto {
  /** Game-cluster SOL, or null when the read failed. */
  sol: number | null;
  /** symbol → balance (0 = not held) or null (that cluster's read failed /
   * mainnet is not configured). Symbols come from WALLET_HUB.tokens, plus any
   * `extraGameTokens` the host configured (the QA chain lane's test SKR). */
  tokens: Record<string, number | null>;
  /** Unix ms the entry was computed — clients may show staleness. */
  asOf: number;
}

async function clusterMints(conn: Connection, owner: PublicKey): Promise<Record<string, number> | null> {
  try {
    const lists = await Promise.all(TOKEN_PROGRAM_IDS.map((pid) =>
      conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(pid) })
        .then((r) => r.value as ParsedTokenAccountLike[])));
    return sumByMint(lists.flat());
  } catch {
    return null; // whole-cluster failure → null, never a fake zero
  }
}

interface WalletBalanceDeps {
  /** Test seam; production always uses a normal web3 Connection. */
  connectionFactory?: ((rpcUrl: string) => Connection) | undefined;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, WalletBalancesDto>();
const cacheEpochs = new Map<string, symbol>();

/** A finalized direct payment changes both wallets outside our balance ledger. */
export function invalidateWalletBalances(wallet: string): void {
  cache.delete(wallet);
  cacheEpochs.delete(wallet);
}

/** Extra game-cluster rows a host adds beside WALLET_HUB.tokens. Only the QA chain
 * lane sets one (scripts/candidate/api.mjs: test SKR = the pinned SEEKER_AUCTION_MINT);
 * production passes none. A row may not reuse a catalogue symbol or mint. */
export interface ExtraGameToken { readonly symbol: string; readonly mint: string }

export function assertExtraGameTokens(extra: readonly ExtraGameToken[]): void {
  const symbols = new Set<string>(WALLET_HUB.tokens.map((t) => t.symbol));
  const mints = new Set<string>(WALLET_HUB.tokens.map((t) => t.mint));
  for (const t of extra) {
    if (!/^[A-Za-z0-9]{1,12}$/.test(t.symbol) || symbols.has(t.symbol)) throw new Error(`wallet balance row ${t.symbol} clashes or is malformed`);
    if (new PublicKey(t.mint).toBase58() !== t.mint || mints.has(t.mint)) throw new Error(`wallet balance mint for ${t.symbol} clashes or is malformed`);
    symbols.add(t.symbol); mints.add(t.mint);
  }
}

export async function getWalletBalances(
  wallet: string,
  rpc: { gameRpcUrl: string; mainnetRpcUrl?: string | undefined; extraGameTokens?: readonly ExtraGameToken[] | undefined },
  now = Date.now(),
  deps: WalletBalanceDeps = {},
): Promise<WalletBalancesDto> {
  const hit = cache.get(wallet);
  if (hit && now - hit.asOf < CACHE_TTL_MS) return hit;
  const epoch = cacheEpochs.get(wallet) ?? Symbol();
  cacheEpochs.set(wallet, epoch);

  const owner = new PublicKey(wallet);
  const makeConnection = deps.connectionFactory
    ?? ((rpcUrl: string): Connection => new Connection(rpcUrl, 'confirmed'));
  const game = makeConnection(rpc.gameRpcUrl);
  const sol = await game.getBalance(owner).then((l) => l / 1e9).catch(() => null);
  const gameMints = await clusterMints(game, owner);
  const mainMints = rpc.mainnetRpcUrl
    ? await clusterMints(makeConnection(rpc.mainnetRpcUrl), owner)
    : null;

  const tokens: Record<string, number | null> = {};
  for (const t of WALLET_HUB.tokens) {
    const src = t.cluster === 'game' ? gameMints : mainMints;
    tokens[t.symbol] = src === null ? null : src[t.mint] ?? 0;
  }
  for (const t of rpc.extraGameTokens ?? []) tokens[t.symbol] = gameMints === null ? null : gameMints[t.mint] ?? 0;
  const dto: WalletBalancesDto = { sol, tokens, asOf: now };
  // Cache even a partial failure: it stops a dead RPC from being hammered by
  // the 30s client poll, and the client renders null as retryable, not as 0.
  // An older RPC read may finish after a payment invalidated this wallet.
  // It remains an asOf snapshot for its caller, but cannot repopulate the cache.
  if (cacheEpochs.get(wallet) === epoch) cache.set(wallet, dto);
  return dto;
}

/** Test seam. */
export function clearWalletBalancesCache(): void {
  cache.clear();
  cacheEpochs.clear();
}
