/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CandidateExpandScreen } from './candidateExpansion';
import { CAPS } from '@shardkeep/shared';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { CANDIDATE_ORIGIN, type ExpansionRequest, type ExpansionState } from '../../lib/candidateExpansion';
import { useApp, type BaseStateDto } from '../../state/store';
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), refresh: vi.fn(), enabled: true }));
vi.mock('../../lib/api', () => ({ API_URL: '/api', api: { get: h.get, postRaw: h.post } }));
vi.mock('../../lib/version', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/version')>(), BUILD: { gitSha: 'a'.repeat(40) },
}));
vi.mock('../../state/baseSnapshot', () => ({ reloadBase: h.refresh }));
vi.mock('../../lib/candidateExpansion', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/candidateExpansion')>(), candidateExpansionBuild: () => h.enabled,
}));
const wallet = '1'.repeat(32); const baseId = '00000000-0000-4000-8000-000000000001';
let root: Root; let host: HTMLDivElement; let remote: ExpansionState | null;
const base = { baseId, player: { expansions: 0, wallet, keepLevel: 20 } } as BaseStateDto;
function btn(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(b => b.textContent === label);
  expect(found, label).toBeDefined(); return found!;
}
async function click(label: string): Promise<void> {
  expect(btn(label).disabled).toBe(false); await act(async () => btn(label).click());
}
async function render(): Promise<void> { await act(async () => root.render(<CandidateExpandScreen />)); }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubEnv('VITE_PKW_CANDIDATE_ORIGIN', CANDIDATE_ORIGIN);
  localStorage.clear(); h.enabled = true; remote = null; h.get.mockReset(); h.post.mockReset(); h.refresh.mockReset();
  let serial = Promise.resolve<unknown>(null);
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: (_name: string, work: () => Promise<unknown>) => { const next = serial.then(work); serial = next.catch(() => null); return next; },
  } });
  h.get.mockImplementation(async (path: string) => path.includes('/capability')
    ? { version: 1, mode: 'candidate-expansion', enabled: true, origin: CANDIDATE_ORIGIN,
      sourceSha: 'a'.repeat(40), wallet, baseId } : structuredClone(remote));
  h.post.mockImplementation(async (path: string, body: unknown) => {
    if (path.endsWith('/quote')) {
      const request = body as ExpansionRequest;
      remote = { version: 1, mode: 'candidate-expansion', wallet, idempotencyKey: request.idempotencyKey,
        status: 'quoted', receipt: null, quote: { version: 1, mode: 'candidate-expansion', wallet, origin: CANDIDATE_ORIGIN,
          sourceSha: 'a'.repeat(40), fixtureId: baseId, request,
          baseEpoch: { landPaidAt: '2026-09-15T00:00:00Z', deedAssetId: null },
          offer: { expectedExpansions: request.expectedExpansions,
            fromClaimTiles: CAPS.claimTilesByExpansion[request.expectedExpansions]!,
            toClaimTiles: CAPS.claimTilesByExpansion[request.expectedExpansions + 1]!,
            requiredKeepLevel: CAPS.expansionReqKeepLevel[request.expectedExpansions]!,
            referencePriceLamports: String(CAPS.expansionPriceSolByIndex[request.expectedExpansions]! * LAMPORTS_PER_SOL), chargedLamports: '0' }, createdAt: '2026-09-15T00:00:00Z', quoteHash: 'b'.repeat(64) } };
    } else remote = { ...remote!, status: 'granted', receipt: { version: 1, mode: 'candidate-expansion', wallet, baseId,
      id: baseId, idempotencyKey: remote!.idempotencyKey, quoteHash: remote!.quote!.quoteHash, fromExpansions: remote!.quote!.request.expectedExpansions,
      toExpansions: remote!.quote!.request.expectedExpansions + 1,
      fromClaimTiles: remote!.quote!.offer.fromClaimTiles, toClaimTiles: remote!.quote!.offer.toClaimTiles, chargedLamports: '0', acceptedAt: '2026-09-15T00:01:00Z' } };
    return structuredClone(remote);
  });
  useApp.setState({ wallet, authed: true, base, selectedBaseId: baseId, baseSelectionEpoch: 0 });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('shows exact reference price and free-test consent, never wallet payment controls', async () => {
  await render(); await click('REVIEW EXPANSION');
  expect(host.textContent).toContain('Game price: 0.15 SOL. This test expansion is free.');
  await click('APPLY TEST EXPANSION');
  expect(host.textContent).toContain('Test expansion applied'); expect(host.textContent).toContain('No SOL was charged.');
  expect(h.post.mock.calls.every(([path]) => String(path).startsWith('/candidate/expansions/v1/'))).toBe(true);
});
it('keeps success and prevents another step when the base refresh fails', async () => {
  h.refresh.mockRejectedValue(new Error('offline')); await render(); await click('REVIEW EXPANSION'); await click('APPLY TEST EXPANSION');
  expect(host.textContent).toContain('Test expansion applied');
  expect(host.textContent).toContain('Your expansion succeeded. The base view has not refreshed yet.');
  expect(btn('REVIEW EXPANSION').disabled).toBe(true);
  await click('REFRESH BASE'); expect(h.post).toHaveBeenCalledTimes(2);
});
it('reopening reads the receipt and never repeats a grant', async () => {
  await render(); await click('REVIEW EXPANSION'); await click('APPLY TEST EXPANSION');
  await act(async () => root.unmount()); root = createRoot(host); await render();
  expect(host.textContent).toContain('Test expansion applied'); expect(h.post).toHaveBeenCalledTimes(2);
});
it('candidate mode fails closed when the build or capability is unavailable', async () => {
  h.enabled = false; await render(); expect(host.textContent).toContain('unavailable in this build');
  expect(h.get).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled();
});
it('late quote responses never populate a newly selected account', async () => {
  let resolve!: (value: unknown) => void;
  h.post.mockImplementation(() => new Promise(r => { resolve = r; }));
  await render(); await act(async () => { btn('REVIEW EXPANSION').click(); });
  await act(async () => useApp.setState({ wallet: '2'.repeat(32), base: null, selectedBaseId: null, baseSelectionEpoch: 1 }));
  await act(async () => resolve({}));
  expect(host.textContent).not.toContain('APPLY TEST EXPANSION'); expect(h.post).toHaveBeenCalledTimes(1);
});

// Owner September16: the six appended steps must remain reachable in the same
// original-request flow; a hidden old six-expansion UI cap would fail these cases.
it.each([6, 7, 8, 9, 10, 11])('reviews and recovers expansion index %i beyond the historical cap without payment', async index => {
  useApp.setState({ base: { ...base, player: { ...base.player, expansions: index } } });
  const from = CAPS.claimTilesByExpansion[index]!; const to = CAPS.claimTilesByExpansion[index + 1]!;
  await render(); expect(host.textContent).toContain(`Current building area · ${from} × ${from}`);
  await click('REVIEW EXPANSION');
  const request = h.post.mock.calls[0]![1] as ExpansionRequest;
  expect(request.expectedExpansions).toBe(index);
  expect(host.textContent).toContain(`${from} × ${from} → ${to} × ${to}`);
  expect(host.textContent).toContain(`Game price: ${CAPS.expansionPriceSolByIndex[index]} SOL. This test expansion is free.`);
  await click('APPLY TEST EXPANSION');
  expect(host.textContent).toContain('Test expansion applied');
  expect(host.textContent).toContain(`${from} × ${from} → ${to} × ${to}`);
  // A stale base read cannot reopen another grant after the receipt succeeds.
  expect(btn('REVIEW EXPANSION').disabled).toBe(true);
  await act(async () => root.unmount()); root = createRoot(host); await render();
  expect(host.textContent).toContain(`${from} × ${from} → ${to} × ${to}`);
  expect(h.post).toHaveBeenCalledTimes(2);
  expect(h.post.mock.calls.every(([path]) => String(path).startsWith('/candidate/expansions/v1/'))).toBe(true);
});
it('shows the final approved claim without offering an impossible next purchase', async () => {
  useApp.setState({ base: { ...base, player: { ...base.player, expansions: CAPS.expansionsMax } } });
  await render();
  const size = CAPS.claimTilesByExpansion[CAPS.expansionsMax];
  expect(host.textContent).toContain(`Current building area · ${size} × ${size}`);
  expect(host.textContent).toContain('Your kingdom has reached its largest building area.');
  expect([...host.querySelectorAll('button')].some(b => b.textContent === 'REVIEW EXPANSION')).toBe(false);
  expect(h.post).not.toHaveBeenCalled();
});
