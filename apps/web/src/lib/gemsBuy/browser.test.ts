/** @vitest-environment happy-dom */
import { TOKEN } from '@shardkeep/shared';
import { PublicKey, type Connection } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api } from '../api';
import { expectedSolanaGenesis, SOLANA_CLUSTER } from '../cluster';
import { createGemsBuyBrowserPorts, gemsBuyBinding, gemsBuyIdentity, hydrateGemsBuyReceipt } from './browser';
import { gemsBuySourceAta, parseGemsBuyAdmission } from './contracts';
import { address, binding, connection, credited, owner, policy, request, response, wallet } from './fixtures.test-support';
const base = '00000000-0000-4000-8000-000000000004';
const view = () => ({ active: true, visible: true, epoch: 0, actionsEnabled: true });
const overview = () => ({ features: { gems: { version: 1, receipts: 1, exactConsent: 1 } }, gems: '10', sources: ['wallet-keep'],
  gemsPerKeep: 1, shardsPerGem: 1, minConvertKeep: 1, maxConvertKeepPerTx: 100, serverNow: response().serverNow, tasks: [] });
const capabilities = () => ({ protocolVersion: 1, economy: { gems: { enabled: true, sources: ['wallet-keep'], destinationAta: policy.destinationAta,
  gemsPerKeep: 1, minConvertKeep: 1, maxConvertKeepPerTx: 100 } } });
const directory = () => ({ enabled: true, capabilities: { baseScopedReads: true }, bases: [{ id: base, status: 'active', slot: 1 }] });
const funds = { keep: '10', shards: '20', gems: '12', keepRate: 1 };
const read = async (path: string): Promise<unknown> => path === '/gems' ? overview() : path === '/native/capabilities' ? capabilities()
  : path === '/me' ? { wallet: binding.wallet } : path === '/bases' ? directory() : funds;
const proof = () => credited().receipt as Parameters<typeof hydrateGemsBuyReceipt>[1];
beforeEach(() => {
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(binding.wallet, true); useApp.setState({ selectedBaseId: base, baseSelectionEpoch: 0 });
  vi.spyOn(api, 'get').mockImplementation(read as typeof api.get);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useApp.getState().setAuth(null); });
const setup = () => {
  const page = view(), rpc = connection(), signer = wallet(), identity = gemsBuyIdentity(binding.wallet);
  rpc.getGenesisHash.mockResolvedValue(expectedSolanaGenesis(SOLANA_CLUSTER));
  rpc.getTokenAccountBalance.mockResolvedValue({ context: { slot: 1 }, value: { amount: String(10n * 10n ** BigInt(TOKEN.decimals)), decimals: TOKEN.decimals, uiAmount: 10 } });
  let currentWallet = signer;
  const ports = createGemsBuyBrowserPorts({ identity, connection: rpc as unknown as Connection, wallet: () => currentWallet, lifecycle: () => page });
  const admit = () => { const frozen = gemsBuyBinding(binding.wallet); return parseGemsBuyAdmission({ ...response(), ...frozen, source: gemsBuySourceAta(frozen.wallet, frozen.mint) }, request, frozen, policy,
    { requestStartedAt: 0, requestStartedWall: 0, now: () => 0, wall: () => 0 }); };
  return { page, rpc, signer, identity, ports, admit, changeWallet: (next: typeof signer) => { currentWallet = next; } };
};
describe('wallet Gems browser transport and capability fence', () => {
  it('canonical origin/API/cluster and current wallet session are mandatory; base selection alone does not invalidate wallet funding', () => {
    const { ports, page } = setup(); const guard = ports.capture(true);
    useApp.getState().setSelectedBaseId(null, false); expect(guard).not.toThrow();
    page.actionsEnabled = false; expect(guard).toThrow('view changed'); page.actionsEnabled = true;
    page.epoch++; expect(guard).toThrow();
    const s = setup(); useApp.setState({ wallet: address(40) }); expect(s.ports.capture(false)).toThrow();
    const foreign = createGemsBuyBrowserPorts({ identity: { ...s.identity, api: 'https://other.test/api' }, connection: s.rpc as unknown as Connection, wallet: () => s.signer, lifecycle: view });
    expect(() => foreign.capture(false)).toThrow('origin, server or network');
  });
  it('both GET and exact POST retain cookie admission guards and reject stale response or generation', async () => {
    const { ports } = setup(), guard = ports.capture(true), body = { kind: 'gems_buy', keepIn: 10, idempotencyKey: 'original-key' };
    const post = vi.spyOn(api, 'postRaw').mockResolvedValue({}); await ports.post('/deposits', body, guard); await ports.get('/gems', guard);
    expect(post.mock.calls[0]?.[1]).toBe(body); expect(post.mock.calls[0]?.[2]?.isCurrent?.()).toBe(true);
    useApp.setState({ wallet: address(40) }); expect(post.mock.calls[0]?.[2]?.isCurrent).toThrow();
    const current = setup(); vi.spyOn(authCookies, 'current').mockReturnValue(false); expect(current.ports.capture(false)).toThrow();
  });
  it('requires agreeing fresh Gems/native wallet source, enabled state, destination and locked one-to-one terms', async () => {
    const { ports } = setup(), guard = ports.capture(true), original = gemsBuyBinding(binding.wallet);
    expect(await ports.policy(original, guard)).toEqual(policy);
    for (const change of [{ enabled: false }, { sources: ['ledger-keep'] }, { destinationAta: 'invalid' }, { gemsPerKeep: 2 }, { minConvertKeep: 2 }]) {
      vi.mocked(api.get).mockImplementation(async path => path === '/native/capabilities' ? { ...capabilities(), economy: { gems: { ...capabilities().economy.gems, ...change } } } as never : await read(path) as never);
      await expect(ports.policy(original, guard)).rejects.toThrow();
    }
    await expect(ports.policy({ ...original, mint: address(40) }, guard)).rejects.toThrow('mint configuration');
  });
  it('captures sign-only original provider; provider replacement or identity change cannot open an unrelated wallet', async () => {
    const s = setup(), guard = s.ports.capture(true), prepared = await s.ports.prepare(s.admit(), guard);
    s.changeWallet({ ...wallet(), publicKey: new PublicKey(address(40)) });
    await expect(s.ports.sign(prepared)).rejects.toThrow('signer changed'); expect(s.signer.signTransaction).not.toHaveBeenCalled();
    s.changeWallet(s.signer); const signed = await s.ports.sign(prepared); expect(signed.signature).toBeTruthy();
    expect(s.signer.signTransaction).toHaveBeenCalledOnce();
  });
  it('does not discard an exact original signature when the account changes while the captured wallet is open', async () => {
    const s = setup(); s.signer.signTransaction.mockImplementation(async tx => { tx.sign(owner); useApp.setState({ wallet: address(40) }); return tx; });
    const prepared = await s.ports.prepare(s.admit(), s.ports.capture(true));
    expect((await s.ports.sign(prepared)).signature).toBeTruthy();
    await expect(s.ports.live(prepared, () => { throw new Error('stale'); })).rejects.toThrow('stale');
  });
  it('RPC or capability response after a hidden view fails before wallet or subsequent network reads', async () => {
    const s = setup(), guard = s.ports.capture(true);
    s.rpc.getGenesisHash.mockImplementation(async () => { s.page.visible = false; return expectedSolanaGenesis(SOLANA_CLUSTER); });
    await expect(s.ports.prepare(s.admit(), guard)).rejects.toThrow('view changed'); expect(s.rpc.getLatestBlockhash).not.toHaveBeenCalled();
    expect(s.signer.signTransaction).not.toHaveBeenCalled();
  });
});
describe('wallet credit hydration', () => {
  it('proves wallet before refreshing selected-base balances and supports paused Gems responses', async () => {
    await hydrateGemsBuyReceipt(gemsBuyIdentity(binding.wallet), proof(), () => undefined);
    expect(useApp.getState().balances).toMatchObject(funds); expect(api.get).toHaveBeenCalledWith(`/balances?baseId=${base}`, expect.anything());
    expect(api.get).not.toHaveBeenCalledWith('/gems', expect.anything());
  });
  it('missing ownership keeps historical receipt without inventing another base stock', async () => {
    vi.mocked(api.get).mockImplementation(async path => path === '/bases' ? { ...directory(), bases: [] } as never : await read(path) as never);
    await hydrateGemsBuyReceipt(gemsBuyIdentity(binding.wallet), proof(), () => undefined);
    expect(vi.mocked(api.get).mock.calls.some(([path]) => path.startsWith('/balances'))).toBe(false);
  });
  it('balance epoch rejects a late old-base answer and wallet misbinding never reaches balances', async () => {
    useApp.getState().setBalances({ ...funds, shards: '999' });
    vi.mocked(api.get).mockImplementation(async path => {
      if (path.startsWith('/balances')) useApp.getState().setSelectedBaseId(null, false);
      return await read(path) as never;
    });
    await hydrateGemsBuyReceipt(gemsBuyIdentity(binding.wallet), proof(), () => undefined);
    expect(useApp.getState().balances?.shards).toBe('999');
    await expect(hydrateGemsBuyReceipt(gemsBuyIdentity(binding.wallet), { ...proof(), wallet: address(40) }, () => undefined)).rejects.toThrow('another account');
  });
});
