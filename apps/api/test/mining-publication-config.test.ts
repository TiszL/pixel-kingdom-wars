/** Candidate config contract; no connections, signing or secrets. */
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { loadConfig } from '../src/config';
const base = { DATABASE_URL: 'postgres://request:x@localhost:5433/example',
  JWT_SECRET: 'test-secret-test-secret-test-secret!', WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test' };
const operator = 'AvsebCwRDs63UMwKv2xSVCRKB8cxUS4W3B4sNR9SHpKv';
const reserve = 'CVKo5i8ax2kiKe9nSB4LfCpBEbyfaLcq8S8bWXsvKo1Q';
const hot = new PublicKey(new Uint8Array(32).fill(7)).toBase58(), gems = 'GV1DHT162yYFfFeZh7yXcPyCYamMj7bmDa77tNTupMXb';
const recovery = { ...base, SOLANA_CLUSTER: 'devnet', MINING_PUBLICATION_TESTER_STACK: 'true',
  MINING_PUBLICATION_RECOVERY_ENABLED: 'true', PHASE_E_KEEP_IDENTITY: 'keep-v4', PHASE_E_KEEP_RESERVE_OWNER: reserve, PHASE_E_SERVICE_DATABASE_URL: 'postgres://owner:x@localhost:5433/example',
  MINING_CLAIM_PROGRAM_ID: '11111111111111111111111111111112', MINING_CLAIM_DEPLOYMENT_SLOT: '1',
  MINING_CLAIM_PROGRAM_DATA_SHA256: 'a'.repeat(64), GEMS_RESERVE_OWNER: gems, HOT_WALLET_PUBKEY: hot };

describe('private mining publication configuration', () => {
  it('defaults every publication mount gate off and the public operator identity unset', () => {
    const config = loadConfig(base);
    expect(config.PHASE_E_KEEP_IDENTITY).toBe('disabled'); expect(config.PHASE_E_KEEP_RESERVE_OWNER).toBeUndefined();
    expect(config.MINING_PUBLICATION_TESTER_STACK).toBe('false');
    expect(config.MINING_PUBLICATION_RECOVERY_ENABLED).toBe('false');
    expect(config.MINING_PUBLICATION_JOB_ENABLED).toBe('false');
    expect(config.MINING_PUBLICATION_OPERATOR_PUBKEY).toBeUndefined();
  });
  it.each(['MINING_PUBLICATION_TESTER_STACK', 'MINING_PUBLICATION_RECOVERY_ENABLED', 'MINING_PUBLICATION_JOB_ENABLED'])(
    'rejects a misspelled %s flag', field => { expect(() => loadConfig({ ...base, [field]: 'TRUE' })).toThrow(); });
  it('requires an explicit devnet tester stack, private database and reviewed claim pins for recovery', () => {
    expect(loadConfig(recovery).MINING_PUBLICATION_RECOVERY_ENABLED).toBe('true');
    for (const patch of [{ SOLANA_CLUSTER: 'mainnet-beta' }, { MINING_PUBLICATION_TESTER_STACK: 'false' },
      { PHASE_E_SERVICE_DATABASE_URL: undefined }, { MINING_CLAIM_PROGRAM_DATA_SHA256: undefined }]) {
      expect(() => loadConfig({ ...recovery, ...patch })).toThrow();
    }
  });
  it('keeps recovery independent from mining admission and signing identity', () => {
    const config = loadConfig({ ...recovery, PHASE_E_MINING_ENABLED: 'false' });
    expect(config.MINING_PUBLICATION_RECOVERY_ENABLED).toBe('true');
    expect(config.MINING_PUBLICATION_OPERATOR_PUBKEY).toBeUndefined();
  });
  it('requires the named v4 selection and reserve without accepting KEEP_MINT as a substitute', () => {
    for (const patch of [{ PHASE_E_KEEP_IDENTITY: 'disabled' }, { PHASE_E_KEEP_IDENTITY: 'KEEP-V4' },
      { PHASE_E_KEEP_RESERVE_OWNER: undefined }, { PHASE_E_KEEP_RESERVE_OWNER: operator }, { HOT_WALLET_PUBKEY: undefined }]) {
      expect(() => loadConfig({ ...recovery, ...patch, KEEP_MINT: operator })).toThrow();
    }
    expect(loadConfig({ ...recovery, KEEP_MINT: operator }).PHASE_E_KEEP_RESERVE_OWNER).toBe(reserve);
  });
  it('does not couple publication recovery to legacy claim pins or Gems reserve', () => {
    const independent = { ...recovery, MINING_CLAIM_PROGRAM_ID: undefined, MINING_CLAIM_DEPLOYMENT_SLOT: undefined,
      MINING_CLAIM_PROGRAM_DATA_SHA256: undefined, GEMS_RESERVE_OWNER: undefined };
    expect(loadConfig(independent).MINING_PUBLICATION_RECOVERY_ENABLED).toBe('true');
  });
  it('allows selected v4 claim and transparency pins without a legacy Gems reserve, while retaining the legacy prerequisite', () => {
    const selected = { ...recovery, GEMS_RESERVE_OWNER: undefined,
      MINING_TRANSPARENCY_PROGRAM_ID: recovery.MINING_CLAIM_PROGRAM_ID,
      MINING_TRANSPARENCY_DEPLOYMENT_SLOT: recovery.MINING_CLAIM_DEPLOYMENT_SLOT,
      MINING_TRANSPARENCY_PROGRAM_DATA_SHA256: recovery.MINING_CLAIM_PROGRAM_DATA_SHA256 };
    const loaded = loadConfig(selected);
    expect(loaded.PHASE_E_KEEP_IDENTITY).toBe('keep-v4'); expect(loaded.GEMS_RESERVE_OWNER).toBeUndefined();
    expect(() => loadConfig({ ...selected, MINING_PUBLICATION_RECOVERY_ENABLED: 'false', PHASE_E_KEEP_IDENTITY: 'disabled' })).toThrow('GEMS_RESERVE_OWNER');
  });
  // G7 (2026-10-10): boot used to demand GEMS_RESERVE_OWNER for tax pins even with keep-v4 selected,
  // although taxRuntime.ts (like claims and transparency) takes the selected v4 RESERVE. A v4-only
  // production env would then refuse to boot on a valid tax policy. The three groups share one rule.
  it('allows selected v4 tax pins without a legacy Gems reserve, while retaining the legacy prerequisite', () => {
    const tax = { MINING_TAX_PROGRAM_ID: recovery.MINING_CLAIM_PROGRAM_ID, MINING_TAX_DEPLOYMENT_SLOT: '1',
      MINING_TAX_PROGRAM_DATA_SHA256: 'b'.repeat(64), MINING_TAX_UPGRADE_AUTHORITY: 'none',
      MINING_TAX_AUCTION_MINT: operator, MINING_TAX_PRIZE_OWNER: gems, MINING_TAX_STATE_PROVENANCE: 'fresh-reviewed-deployment' };
    const selected = { ...recovery, ...tax, GEMS_RESERVE_OWNER: undefined };
    const loaded = loadConfig(selected);
    expect(loaded.PHASE_E_KEEP_IDENTITY).toBe('keep-v4'); expect(loaded.GEMS_RESERVE_OWNER).toBeUndefined();
    expect(loaded.MINING_TAX_PROGRAM_ID).toBe(recovery.MINING_CLAIM_PROGRAM_ID);
    const legacyOnly = { ...selected, MINING_PUBLICATION_RECOVERY_ENABLED: 'false', PHASE_E_KEEP_IDENTITY: 'disabled',
      MINING_CLAIM_PROGRAM_ID: undefined, MINING_CLAIM_DEPLOYMENT_SLOT: undefined, MINING_CLAIM_PROGRAM_DATA_SHA256: undefined };
    expect(() => loadConfig(legacyOnly)).toThrow('Mining tax requires complete reviewed deployment, auction and reserve identity');
    expect(loadConfig({ ...legacyOnly, GEMS_RESERVE_OWNER: gems }).MINING_TAX_PROGRAM_ID).toBe(recovery.MINING_CLAIM_PROGRAM_ID);
    for (const patch of [{ HOT_WALLET_PUBKEY: undefined }, { MINING_TAX_STATE_PROVENANCE: undefined }]) {
      expect(() => loadConfig({ ...selected, ...patch })).toThrow();
    }
  });
  it('rejects mixing OPERATOR, RESERVE, Gems reserve or hot custody roles', () => {
    const job = { ...recovery, MINING_PUBLICATION_JOB_ENABLED: 'true', MINING_PUBLICATION_OPERATOR_PUBKEY: operator };
    for (const patch of [{ MINING_PUBLICATION_OPERATOR_PUBKEY: reserve }, { MINING_PUBLICATION_OPERATOR_PUBKEY: hot },
      { MINING_PUBLICATION_OPERATOR_PUBKEY: gems }, { HOT_WALLET_PUBKEY: reserve }, { GEMS_RESERVE_OWNER: reserve }]) {
      expect(() => loadConfig({ ...job, ...patch })).toThrow('distinct');
    }
  });
  it('requires an explicit valid public operator identity for the publisher job', () => {
    const job = { ...recovery, MINING_PUBLICATION_JOB_ENABLED: 'true' };
    expect(() => loadConfig(job)).toThrow();
    for (const value of ['', '/run/secrets/key.json', '11111111111111111111111111111111']) {
      expect(() => loadConfig({ ...job, MINING_PUBLICATION_OPERATOR_PUBKEY: value })).toThrow();
    }
    expect(loadConfig({ ...job, MINING_PUBLICATION_OPERATOR_PUBKEY: operator }).MINING_PUBLICATION_OPERATOR_PUBKEY).toBe(operator);
  });
});
