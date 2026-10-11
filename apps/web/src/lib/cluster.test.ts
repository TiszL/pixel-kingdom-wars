import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import devnetAddresses from '../../../../infra/devnet.addresses.json';
import { explorerUrl, expectedSolanaGenesis, resolveWebSolanaConfig, rpcWebSocketUrl } from './cluster';

const MAINNET_ENV = {
  VITE_SOLANA_CLUSTER: 'mainnet-beta',
  VITE_SOLANA_RPC_URL: 'https://rpc.mainnet.example',
  VITE_CORE_PROGRAM_ID: 'mainnet-core',
  VITE_CORE_CONFIG_PDA: 'mainnet-config',
  VITE_KEEP_MINT: 'mainnet-keep-mint',
  VITE_TREASURY_LIQUIDITY: 'mainnet-liquidity',
  VITE_TREASURY_DEV: 'mainnet-dev',
  VITE_TREASURY_OPS: 'mainnet-ops',
};
const overlaySource = readFileSync(new URL('../ui/Overlay.tsx', import.meta.url), 'utf8');
const tutorialSource = readFileSync(new URL('../ui/tutorial/TutorialOverlay.tsx', import.meta.url), 'utf8');
const walletSource = readFileSync(new URL('../auth/useGameWallet.ts', import.meta.url), 'utf8');

describe('public Solana cluster configuration', () => {
  it('pins each payment network to the actual public genesis, independent of endpoint URL', () => {
    expect(expectedSolanaGenesis('devnet')).toBe('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
    expect(expectedSolanaGenesis('mainnet-beta')).toBe('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  });
  it('requires the credential-free same-origin relay in production, including devnet', () => {
    const options = { production: true, origin: 'https://game.example' };
    const relay = 'https://game.example/api/rpc/solana/devnet';
    expect(resolveWebSolanaConfig({ VITE_SOLANA_RPC_URL: relay }, options).rpcUrl).toBe(relay);
    for (const rpc of [undefined, 'https://api.devnet.solana.com',
      'https://devnet.helius-rpc.com/?api-key=secret', relay + '?api-key=secret',
      relay + '#secret', 'https://foreign.example/api/rpc/solana/devnet',
      'https://game.example/api/rpc/solana/mainnet-beta',
      'https://game.example/api/rpc/solana/devnet/']) {
      expect(() => resolveWebSolanaConfig({ VITE_SOLANA_RPC_URL: rpc }, options)).toThrow(/relay/);
    }
    // Wallet Standard infers the chain from this segment before SIWS.
    expect(relay).toMatch(/\bdevnet\b/i);
  });

  it('keeps HTTP and WebSocket relay traffic on the same explicit port', () => {
    expect(rpcWebSocketUrl('http://localhost:5173/api/rpc/solana/devnet'))
      .toBe('ws://localhost:5173/api/rpc/solana/devnet');
    expect(rpcWebSocketUrl('https://game.example/api/rpc/solana/devnet'))
      .toBe('wss://game.example/api/rpc/solana/devnet');
  });
  it('preserves the current devnet defaults and checked-in public addresses', () => {
    expect(resolveWebSolanaConfig({})).toEqual({
      cluster: 'devnet',
      chain: 'solana:devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      addresses: {
        coreProgram: devnetAddresses.coreProgram,
        config: devnetAddresses.config,
        keepMint: devnetAddresses.keepMint,
        treasuries: devnetAddresses.treasuries,
      },
    });
  });

  it('fails closed on an unknown cluster instead of letting wallet libraries guess', () => {
    expect(() => resolveWebSolanaConfig({ VITE_SOLANA_CLUSTER: 'testnet' }))
      .toThrow(/Unsupported VITE_SOLANA_CLUSTER/);
  });

  it('requires an explicit RPC and every payment address for mainnet-beta', () => {
    const resolved = resolveWebSolanaConfig(MAINNET_ENV);
    expect(resolved).toEqual({
      cluster: 'mainnet-beta',
      chain: 'solana:mainnet-beta',
      rpcUrl: MAINNET_ENV.VITE_SOLANA_RPC_URL,
      addresses: {
        coreProgram: MAINNET_ENV.VITE_CORE_PROGRAM_ID,
        config: MAINNET_ENV.VITE_CORE_CONFIG_PDA,
        keepMint: MAINNET_ENV.VITE_KEEP_MINT,
        treasuries: {
          liquidity: MAINNET_ENV.VITE_TREASURY_LIQUIDITY,
          dev: MAINNET_ENV.VITE_TREASURY_DEV,
          ops: MAINNET_ENV.VITE_TREASURY_OPS,
        },
      },
    });
    expect(resolved.addresses).not.toEqual({
      coreProgram: devnetAddresses.coreProgram,
      config: devnetAddresses.config,
      keepMint: devnetAddresses.keepMint,
      treasuries: devnetAddresses.treasuries,
    });
    for (const key of [
      'VITE_SOLANA_RPC_URL', 'VITE_CORE_PROGRAM_ID', 'VITE_CORE_CONFIG_PDA',
      'VITE_KEEP_MINT',
      'VITE_TREASURY_LIQUIDITY', 'VITE_TREASURY_DEV', 'VITE_TREASURY_OPS',
    ] as const) {
      expect(() => resolveWebSolanaConfig({ ...MAINNET_ENV, [key]: '' }), key)
        .toThrow(new RegExp(key));
    }
  });

  it('accepts only web-safe RPC protocols and requires TLS on mainnet', () => {
    expect(() => resolveWebSolanaConfig({ VITE_SOLANA_RPC_URL: 'file:///tmp/rpc' }))
      .toThrow(/http or https/);
    expect(resolveWebSolanaConfig({ VITE_SOLANA_RPC_URL: 'http://127.0.0.1:8899' }).rpcUrl)
      .toBe('http://127.0.0.1:8899');
    expect(() => resolveWebSolanaConfig({
      ...MAINNET_ENV, VITE_SOLANA_RPC_URL: 'http://rpc.mainnet.example',
    })).toThrow(/https for mainnet-beta/);
    expect(() => resolveWebSolanaConfig({
      ...MAINNET_ENV, VITE_SOLANA_RPC_URL: 'https://key:secret@rpc.mainnet.example',
    })).toThrow(/must not contain URL credentials/);
  });

  it('formats Explorer links for the selected cluster', () => {
    expect(explorerUrl('tx', 'abc/123', 'devnet'))
      .toBe('https://explorer.solana.com/tx/abc%2F123?cluster=devnet');
    expect(explorerUrl('address', 'abc', 'mainnet-beta'))
      .toBe('https://explorer.solana.com/address/abc');
  });

  it('keeps faucet copy devnet-only and gives every wallet path the validated chain id', () => {
    // The rule: a MAINNET build must never tell a player to go and get free SOL.
    expect(overlaySource).toContain("SOLANA_CLUSTER !== 'devnet'");
    // The tutorial used to carry that copy on its CLAIM YOUR LAND card, behind a
    // `SOLANA_CLUSTER === 'devnet'` branch. That card was retired on 2026-08-28
    // when land became a quest (owner: onboarding is quest driven), so the
    // assertion became the STRONGER one available: the deck says nothing about
    // faucets or clusters at all, which cannot be got wrong by a future edit the
    // way a hand-written branch can. PlaytestWelcome (Overlay, asserted above) is
    // now the single place a devnet player is told about free SOL.
    expect(tutorialSource).not.toContain('faucet');
    expect(tutorialSource).not.toContain('SOLANA_CLUSTER');
    // D-098: the CLAIM DEVNET SOL control (Overlay's DevnetSolClaim, also on the
    // land screen) derives everything from the server DTO and short-circuits
    // off devnet — devnetSolClaim.test.tsx renders the non-devnet case — and
    // the public faucet is a plain-text caveat, never a link the game sends a
    // player to.
    expect(overlaySource).toContain("if (SOLANA_CLUSTER !== 'devnet' || !s) return null;");
    expect(overlaySource).not.toContain('href="https://faucet.solana.com"');
    expect(walletSource).toContain('const CHAIN = SOLANA_CHAIN');
    expect(walletSource).not.toContain('VITE_SOLANA_CLUSTER as string');
  });
});
