import { mkdtemp, writeFile, chmod, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { createCharterRecoveryRuntime } from '../src/game/clanCharterRecoveryRuntime';
import { createConfiguredCharterWorkflowRuntime } from '../src/game/charterConfiguredRuntime';
import { TEST_CONFIG } from './helpers';
const address = () => Keypair.generate().publicKey.toBase58();
const env = { NODE_ENV: 'test', DATABASE_URL: TEST_CONFIG.DATABASE_URL, JWT_SECRET: TEST_CONFIG.JWT_SECRET, WEB_ORIGIN: TEST_CONFIG.WEB_ORIGIN[0] };
const issuer = { CHARTER_POLICY_ISSUER_URL: 'https://charter.example.invalid', CHARTER_POLICY_ISSUER_PUBLIC_KEY: address(), CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE: '/unavailable/token' };
const pins = { CHARTER_RECOVERY_ECONOMY_PROGRAM_ID: address(), CHARTER_RECOVERY_ECONOMY_DEPLOYMENT_SLOT: '1', CHARTER_RECOVERY_ECONOMY_PROGRAM_DATA_SHA256: 'a'.repeat(64), CHARTER_RECOVERY_ECONOMY_UPGRADE_AUTHORITY: 'none',
  CHARTER_RECOVERY_CRAFT_PROGRAM_ID: address(), CHARTER_RECOVERY_CRAFT_DEPLOYMENT_SLOT: '1', CHARTER_RECOVERY_CRAFT_PROGRAM_DATA_SHA256: 'b'.repeat(64), CHARTER_RECOVERY_CRAFT_UPGRADE_AUTHORITY: 'none',
  CHARTER_RECOVERY_CORE_DEPLOYMENT_SLOT: '1', CHARTER_RECOVERY_CORE_PROGRAM_DATA_SHA256: 'c'.repeat(64), CHARTER_RECOVERY_CORE_UPGRADE_AUTHORITY: 'none', CHARTER_RECOVERY_STATE_PROVENANCE: 'fresh-reviewed-deployment' };
const current = { CHARTER_WORKFLOW_METADATA_URI_PREFIX: 'https://metadata.example.invalid/charter/', CHARTER_WORKFLOW_SALE_TREASURY: address(), CHARTER_WORKFLOW_LOOKUP_TABLE_ADDRESS: address(), CHARTER_WORKFLOW_LOOKUP_TABLE_SHA256: 'd'.repeat(64),
  CHARTER_WORKFLOW_CORE_COST_PROFILE: 'mpl-core-0.15.2-charter-pfd-seq-none', CHARTER_WORKFLOW_MAX_NETWORK_FEE_LAMPORTS: '5000', CHARTER_WORKFLOW_MAX_RENT_LAMPORTS: '9000000', CHARTER_WORKFLOW_MAX_TOTAL_LAMPORTS: '10000000', CHARTER_WORKFLOW_MAX_ADDITIONAL_LAMPORTS: '10000000' };
it('requires complete independent client/current authority; blank or recovery-only cannot grant new actions', async () => {
  const defaults = await createConfiguredCharterWorkflowRuntime(loadConfig(env));
  expect(defaults.client.creation?.issuer).toBeNull(); expect(defaults.client.creation?.newCreation).toBeUndefined(); expect(defaults.tournaments.chain).toBeUndefined(); defaults.close();
  for (const key of Object.keys(issuer)) expect(() => loadConfig({ ...env, ...issuer, [key]: undefined })).toThrow();
  expect(() => loadConfig({ ...env, ...issuer })).not.toThrow();
  for (const key of [...Object.keys(current), ...Object.keys(pins), ...Object.keys(issuer)]) expect(() => loadConfig({ ...env, ...issuer, ...pins, ...current, [key]: undefined })).toThrow();
  for (const patch of [{ CHARTER_WORKFLOW_MAX_TOTAL_LAMPORTS: '18446744073709551616' }, { CHARTER_WORKFLOW_CORE_COST_PROFILE: 'unknown' }, { CHARTER_WORKFLOW_METADATA_URI_PREFIX: 'http://untrusted/' }, { CHARTER_POLICY_ISSUER_ALLOW_PRIVATE_HTTP: 'TRUE' }])
    expect(() => loadConfig({ ...env, ...issuer, ...pins, ...current, ...patch })).toThrow();
  const config = loadConfig({ ...env, ...pins }), recovery = createCharterRecoveryRuntime(config)!;
  const readonly = await createConfiguredCharterWorkflowRuntime(config, recovery.source);
  expect(readonly.client.creation?.newCreation).toBeUndefined(); expect(readonly.client.sales?.newSaleDomain).toBeUndefined();
  expect(readonly.tournaments.recovery?.trust).toEqual(recovery.source.trust); expect(readonly.tournaments.chain).toBeUndefined(); readonly.close(); recovery.close();
});
it('refuses issuer userinfo, path, query, fragment, nonprivate HTTP and implicit loopback HTTP', () => {
  for (const url of ['https://user:secret@issuer.example.invalid', 'https://issuer.example.invalid/v1', 'https://issuer.example.invalid?token=secret', 'https://issuer.example.invalid#secret', 'http://public.example.invalid', 'http://127.0.0.1:3004'])
    expect(() => loadConfig({ ...env, ...issuer, CHARTER_POLICY_ISSUER_URL: url })).toThrow();
  for (const url of ['http://127.0.0.1:3004', 'http://localhost:3004', 'http://charter-issuer:3004'])
    expect(() => loadConfig({ ...env, ...issuer, CHARTER_POLICY_ISSUER_URL: url, CHARTER_POLICY_ISSUER_ALLOW_PRIVATE_HTTP: 'true' })).not.toThrow();
  expect(() => loadConfig({ ...env, CHARTER_WORKFLOW_RELAY_RPC_URL: 'https://relay.example.invalid' })).toThrow();
});
it('loads only protected token files and captures read-only quote authority without issuing or sending at startup', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'charter-current-')), token = path.join(dir, 'token'), other = path.join(dir, 'link');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  try {
    await writeFile(token, 't'.repeat(32) + '\n', { mode: 0o600 });
    const config = loadConfig({ ...env, ...issuer, ...pins, ...current, CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE: token }), recovery = createCharterRecoveryRuntime(config)!;
    const runtime = await createConfiguredCharterWorkflowRuntime(config, recovery.source);
    expect(runtime.client.creation?.newCreation?.metadataUriPrefix).toBe(current.CHARTER_WORKFLOW_METADATA_URI_PREFIX);
    expect(runtime.client.sales?.newSaleDomain?.treasury).toBe(current.CHARTER_WORKFLOW_SALE_TREASURY); expect(runtime.client.delivery).toBeNull(); expect(runtime.tournaments.delivery).toBeNull();
    const chain = runtime.client.sales!.chain!, captured = chain.connect(new AbortController().signal);
    expect(Object.keys(captured)).toContain('getTransaction'); expect(captured).not.toHaveProperty('sendRawTransaction'); expect(fetch).not.toHaveBeenCalled();
    config.CHARTER_WORKFLOW_SALE_TREASURY = address(); expect(runtime.client.sales?.newSaleDomain?.treasury).toBe(current.CHARTER_WORKFLOW_SALE_TREASURY);
    runtime.close(); expect(() => chain.connect(new AbortController().signal)).toThrow(); recovery.close();
    await chmod(token, 0o644); await expect(createConfiguredCharterWorkflowRuntime(config)).rejects.toThrow('token file unavailable'); await chmod(token, 0o600);
    await symlink(token, other); await expect(createConfiguredCharterWorkflowRuntime({ ...config, CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE: other })).rejects.toThrow('token file unavailable'); await rm(other);
    await link(token, other); await expect(createConfiguredCharterWorkflowRuntime(config)).rejects.toThrow('token file unavailable'); await rm(other);
    for (const text of ['short', 't'.repeat(1025), 't'.repeat(32) + '\n\n']) { await writeFile(token, text); await expect(createConfiguredCharterWorkflowRuntime(config)).rejects.toThrow('token file unavailable'); }
  } finally { vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); }
});
