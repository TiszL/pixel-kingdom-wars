import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { assertDevnetOnlyAbsentOnMainnet, loadDevnetOnlyJobs, loadDevnetOnlyRoutes } from '../src/devnetOnlyLoader';

describe('devnet-only import boundary', () => {
  it.each([{ cluster: 'mainnet-beta' as const, enabled: 'true' },
    { cluster: 'devnet' as const, enabled: undefined }, { cluster: 'devnet' as const, enabled: 'false' }])(
    'does not import, register routes or start jobs for %j', async (context) => {
      const app = Fastify(); const importer = vi.fn();
      await loadDevnetOnlyRoutes(app, { ...context, importer });
      expect(await loadDevnetOnlyJobs({ ...context, importer })).toBeNull();
      expect(importer).not.toHaveBeenCalled();
      expect((await app.inject('/devnet-skr-faucet/status')).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/devnet-skr-faucet/claim', payload: {} })).statusCode).toBe(404);
      await app.close();
    },
  );
  it('imports only after explicit devnet enablement', async () => {
    const app = Fastify(); const registerDevnetOnly = vi.fn(); const registerDevnetOnlyJobs = vi.fn(async () => null);
    const importer = vi.fn(async () => ({ registerDevnetOnly, registerDevnetOnlyJobs }));
    await loadDevnetOnlyRoutes(app, { cluster: 'devnet', enabled: 'true', importer });
    await loadDevnetOnlyJobs({ cluster: 'devnet', enabled: 'true', importer });
    expect(importer).toHaveBeenCalledTimes(2); expect(registerDevnetOnly).toHaveBeenCalledOnce();
    expect(registerDevnetOnlyJobs).toHaveBeenCalledOnce(); await app.close();
  });
  it('refuses a shipped devnet-only directory before a mainnet boot', () => {
    expect(() => assertDevnetOnlyAbsentOnMainnet('mainnet-beta', () => true, {})).toThrow(/devnet-only/);
    expect(() => assertDevnetOnlyAbsentOnMainnet('mainnet-beta', () => false, {})).not.toThrow();
  });
  it.each(['DEVNET_SKR_FAUCET_ENABLED', 'DEVNET_SKR_FAUCET_KEYPAIR_PATH', 'DEVNET_SKR_FAUCET_UNKNOWN'])('refuses raw mainnet env key %s even if empty', (key) => {
    expect(() => assertDevnetOnlyAbsentOnMainnet('mainnet-beta', () => false, { [key]: '' })).toThrow();
    expect(() => assertDevnetOnlyAbsentOnMainnet('devnet', () => true, { [key]: '' })).not.toThrow();
  });
});
