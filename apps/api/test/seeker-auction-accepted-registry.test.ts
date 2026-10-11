/** 2026-10-11 (release/p-registry): the accepted devnet Seeker auction pins against the TRACKED registry.
 *
 * WHY this matters: auctionRuntime.ts refuses to start the API unless infra/devnet.addresses.json carries
 * skrMint/skrDecimals and that mint equals SEEKER_AUCTION_MINT ("complete registry SKR identity required").
 * Production applies the seven SEEKER_AUCTION_* pins (Group 2 of chain/accepted/devnet/server-env.production.public)
 * only after this registry pair is merged. If the pair is missing the API crash-loops at boot; if it drifts to another
 * mint, the auction denomination silently changes. These tests read the real tracked file, so a registry edit that
 * drops or changes the accepted tSKR pair fails here before it reaches a deploy. */
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { loadAddresses } from '@shardkeep/chain';
import { SKR_FAUCET } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { assertSkrMintPinsAgree, resolveSkrMint } from '../src/money/skrIdentity';
import { createSeekerAuctionRuntime } from '../src/seeker/auctionRuntime';
import { createRealmSaleRuntime } from '../src/seeker/realmSaleRuntime';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** The accepted devnet test SKR (tSKR) mint, created by the owner in Block S on 2026-10-10; 6 decimals. */
const ACCEPTED_TSKR = 'GhGdHTMAorprWg1YNtjw7z72owJyGKE5KbFi1fW1j9eB';
/** The 17 public lines of server-env.production.public (pins.ts --identities accepted, 2026-10-11T05:56Z), verbatim. */
const ACCEPTED_SEEKER_PINS = Object.freeze({
  SEEKER_REALM_SALE_PROGRAM_ID: '5qyN1Xbe2L16t7MPwwcD5QGmLYAnGF4VjN9BXtazvzkr',
  SEEKER_REALM_SALE_DEPLOYMENT_SLOT: '509790748',
  SEEKER_REALM_SALE_PROGRAM_DATA_SHA256: 'f1a4e1735950d9c3e5e427916ba44c53eb7da357215b2d5a255cc9439b0688cd',
  SEEKER_REALM_SALE_UPGRADE_AUTHORITY: 'Ce5HrbPJ2naKQAbQ6Xga55WeFwVDavHhBzc2AsWd6KY8',
  SEEKER_REALM_SALE_AUCTION_MINT: ACCEPTED_TSKR,
  SEEKER_REALM_SALE_PRIZE_OWNER: '9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q',
  SEEKER_REALM_SALE_DEVELOPER: '9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q',
  SEEKER_REALM_SALE_ROUND: '0',
  SEEKER_REALM_SALE_POLICY_REVISION: 'phase-e-devnet-r12-2026-10',
  SEEKER_REALM_SALE_STATE_PROVENANCE: 'fresh-reviewed-deployment',
  SEEKER_AUCTION_PROGRAM_ID: '5qyN1Xbe2L16t7MPwwcD5QGmLYAnGF4VjN9BXtazvzkr',
  SEEKER_AUCTION_DEPLOYMENT_SLOT: '509790748',
  SEEKER_AUCTION_PROGRAM_DATA_SHA256: 'f1a4e1735950d9c3e5e427916ba44c53eb7da357215b2d5a255cc9439b0688cd',
  SEEKER_AUCTION_UPGRADE_AUTHORITY: 'Ce5HrbPJ2naKQAbQ6Xga55WeFwVDavHhBzc2AsWd6KY8',
  SEEKER_AUCTION_MINT: ACCEPTED_TSKR,
  SEEKER_AUCTION_PRIZE_OWNER: '9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q',
  SEEKER_AUCTION_STATE_PROVENANCE: 'fresh-reviewed-deployment',
});
const env = { DATABASE_URL: 'postgres://x:y@localhost:5433/example', JWT_SECRET: 'test-secret-test-secret-test-secret!',
  WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test', SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  PHASE_E_SEEKER_ENABLED: 'true', PHASE_E_SEEKER_AUCTION_ENABLED: 'true', ...ACCEPTED_SEEKER_PINS };
const tracked = () => {
  const registry = loadAddresses(ROOT, 'devnet');
  if (!registry) throw new Error('infra/devnet.addresses.json is missing');
  return registry;
};

describe('accepted Seeker auction pins and the tracked devnet registry', () => {
  it('carries the accepted tSKR pair, which the devnet SKR rules (faucet refusedMints) accept', () => {
    const registry = tracked();
    expect(registry).toMatchObject({ cluster: 'devnet', skrMint: ACCEPTED_TSKR, skrDecimals: 6 });
    // Both pin groups name the same mint as the registry: one denomination for realm sales and auctions.
    expect(ACCEPTED_SEEKER_PINS.SEEKER_AUCTION_MINT).toBe(registry.skrMint);
    expect(ACCEPTED_SEEKER_PINS.SEEKER_REALM_SALE_AUCTION_MINT).toBe(registry.skrMint);
    // The test mint must never be one of the real SKR identities devnet refuses (constants.ts SKR_FAUCET.devnet).
    expect(SKR_FAUCET.devnet.refusedMints as readonly string[]).not.toContain(ACCEPTED_TSKR);
    // resolveSkrMint is the faucet's identity source (devnet-only/index.ts policy()) and applies that refusal on devnet.
    expect(resolveSkrMint(registry)).toEqual({ mint: ACCEPTED_TSKR, decimals: 6 });
    expect(new PublicKey(ACCEPTED_TSKR).toBase58()).toBe(ACCEPTED_TSKR);
  });

  it('admits all 17 accepted pins in the server.ts boot order and pins the auction trust to them', () => {
    const registry = tracked(), config = loadConfig(env);
    expect(() => assertSkrMintPinsAgree(registry, config)).not.toThrow();
    const realmSales = createRealmSaleRuntime(config);
    const auctions = createSeekerAuctionRuntime(config, registry);
    try {
      expect(realmSales).toBeTruthy();
      expect(auctions?.source.trust).toEqual({
        programId: ACCEPTED_SEEKER_PINS.SEEKER_AUCTION_PROGRAM_ID, genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
        mint: ACCEPTED_TSKR, decimals: 6, prizeOwner: ACCEPTED_SEEKER_PINS.SEEKER_AUCTION_PRIZE_OWNER, deploymentSlot: 509790748,
        programDataSha256: ACCEPTED_SEEKER_PINS.SEEKER_AUCTION_PROGRAM_DATA_SHA256,
        upgradeAuthority: ACCEPTED_SEEKER_PINS.SEEKER_AUCTION_UPGRADE_AUTHORITY, stateProvenance: 'fresh-reviewed-deployment',
      });
    } finally { realmSales?.close(); auctions?.close(); }
  });

  it('is the registry pair, not the env, that admits the auction: without it or with another mint the API refuses', () => {
    const { skrMint: _mint, skrDecimals: _decimals, ...withoutPair } = tracked(), config = loadConfig(env);
    expect(() => createSeekerAuctionRuntime(config, withoutPair)).toThrow(/complete registry SKR identity required/);
    const other = new PublicKey(Buffer.alloc(32, 9)).toBase58();
    expect(() => createSeekerAuctionRuntime(config, { ...tracked(), skrMint: other })).toThrow(/mint differs from registry/);
    expect(() => assertSkrMintPinsAgree({ ...tracked(), skrMint: other }, config)).toThrow(/disagrees with registry/);
  });
});
