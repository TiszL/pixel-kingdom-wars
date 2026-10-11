import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
const base = { DATABASE_URL: 'postgres://x:y@localhost:5433/shardkeep_test',
  JWT_SECRET: 'test-secret-test-secret-test-secret!', WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test' };
describe('default-off SKR faucet config', () => {
  it('leaves both keys undefined by default', () => {
    const config = loadConfig(base);
    expect(config.DEVNET_SKR_FAUCET_AUTHORITY).toBeUndefined();
    expect(config.DEVNET_SKR_FAUCET_ENABLED).toBeUndefined(); expect(config.DEVNET_SKR_FAUCET_KEYPAIR_PATH).toBeUndefined();
  });
  it.each([{ DEVNET_SKR_FAUCET_ENABLED: 'true' }, { DEVNET_SKR_FAUCET_ENABLED: 'false' },
    { DEVNET_SKR_FAUCET_KEYPAIR_PATH: '' }, { DEVNET_SKR_FAUCET_AUTHORITY: '11111111111111111111111111111111' },
    { DEVNET_SKR_FAUCET_DEEDLESS_OK: 'true' }, { DEVNET_SKR_FAUCET_DEEDLESS_OK: 'false' }])('refuses declared faucet config on mainnet: %j', (input) => {
    expect(() => loadConfig({ ...base, SOLANA_CLUSTER: 'mainnet-beta',
      SOLANA_RPC_URL: 'https://mainnet.provider-a.example', SOLANA_RPC_URL_2: 'https://mainnet.provider-b.example',
      SOLANA_RPC_PROVIDER: 'a', SOLANA_RPC_PROVIDER_2: 'b', ...input })).toThrow(/DEVNET_SKR_FAUCET_/);
  });
  it('requires a canonical authority when enabled', () => {
    for (const authority of [undefined, '', 'not-a-key']) {
      expect(() => loadConfig({ ...base, DEVNET_SKR_FAUCET_ENABLED: 'true', DEVNET_SKR_FAUCET_KEYPAIR_PATH: '/keys/test-only',
        ...(authority === undefined ? {} : { DEVNET_SKR_FAUCET_AUTHORITY: authority }) })).toThrow(/DEVNET_SKR_FAUCET_AUTHORITY/);
    }
  });
  it('requires a dedicated path when explicitly enabled', () => {
    expect(() => loadConfig({ ...base, DEVNET_SKR_FAUCET_ENABLED: 'true' })).toThrow(/DEVNET_SKR_FAUCET_KEYPAIR_PATH/);
    for (const key of ['ADMIN_KEYPAIR_PATH', 'HOT_WALLET_KEYPAIR_PATH', 'DEVNET_FAUCET_KEYPAIR_PATH']) {
      expect(() => loadConfig({ ...base, DEVNET_SKR_FAUCET_ENABLED: 'true', DEVNET_SKR_FAUCET_KEYPAIR_PATH: '/keys/same', [key]: '/keys/same' })).toThrow(/DEVNET_SKR_FAUCET_KEYPAIR_PATH/);
    }
    expect(loadConfig({ ...base, DEVNET_SKR_FAUCET_ENABLED: 'true', DEVNET_SKR_FAUCET_KEYPAIR_PATH: '/keys/test-only', DEVNET_SKR_FAUCET_AUTHORITY: '11111111111111111111111111111111' }).DEVNET_SKR_FAUCET_ENABLED).toBe('true');
  });
});

it('ignores empty unrelated signer paths while retaining the dedicated-path check', () => {
  const config = loadConfig({ ...base, DEVNET_SKR_FAUCET_ENABLED: 'true', DEVNET_SKR_FAUCET_KEYPAIR_PATH: '.',
    DEVNET_SKR_FAUCET_AUTHORITY: '11111111111111111111111111111111', ADMIN_KEYPAIR_PATH: '', HOT_WALLET_KEYPAIR_PATH: '', DEVNET_FAUCET_KEYPAIR_PATH: '' });
  expect(config.DEVNET_SKR_FAUCET_ENABLED).toBe('true');
});

// Owner N-045 (6 Oct 2026): deedless SKR faucet claims on the QA chain lane only; production rule D153.290 ("a deedless
// player cannot claim") is unchanged. Why these pins matter: this switch relaxes a player-eligibility gate, so a production
// host (NODE_ENV=production) or a non-devnet cluster must fail boot rather than silently serve deedless claims.
describe('N-045 DEVNET_SKR_FAUCET_DEEDLESS_OK', () => {
  const production = { ...base, NODE_ENV: 'production', SOLANA_RPC_URL: 'https://devnet.helius-rpc.com/?api-key=test',
    TWOFA_ENCRYPTION_KEYS: 'test:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=', RESEND_API_KEY: 're_test', EMAIL_FROM: 'test@example.com' };
  it('is unset by default, so the deed gate stays D153.290', () => {
    expect(loadConfig(base).DEVNET_SKR_FAUCET_DEEDLESS_OK).toBeUndefined();
    expect(loadConfig(production).DEVNET_SKR_FAUCET_DEEDLESS_OK).toBeUndefined();
  });
  it('accepts exactly true|false on a devnet non-production host and refuses anything else', () => {
    for (const value of ['true', 'false'] as const) expect(loadConfig({ ...base, DEVNET_SKR_FAUCET_DEEDLESS_OK: value }).DEVNET_SKR_FAUCET_DEEDLESS_OK).toBe(value);
    for (const value of ['TRUE', '1', 'yes', '']) {
      expect(() => loadConfig({ ...base, DEVNET_SKR_FAUCET_DEEDLESS_OK: value }), value).toThrow(/DEVNET_SKR_FAUCET_DEEDLESS_OK/);
    }
  });
  it('FAILS BOOT under NODE_ENV=production, whatever its value', () => {
    for (const value of ['true', 'false']) {
      expect(() => loadConfig({ ...production, DEVNET_SKR_FAUCET_DEEDLESS_OK: value }), value)
        .toThrow(/DEVNET_SKR_FAUCET_DEEDLESS_OK is refused in production/);
    }
  });
  it('loads on the QA chain lane, whose harness validates with NODE_ENV=development (scripts/candidate/api.mjs)', () => {
    expect(loadConfig({ ...production, NODE_ENV: 'development', DEVNET_SKR_FAUCET_DEEDLESS_OK: 'true' }).DEVNET_SKR_FAUCET_DEEDLESS_OK).toBe('true');
  });
});
