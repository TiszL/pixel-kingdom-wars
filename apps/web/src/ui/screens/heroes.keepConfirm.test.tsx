/** @vitest-environment happy-dom */
/** Every Hero payment needs fresh, explicit consent for its original base,
 * level/recovery episode, ceiling and currency. The legacy speed-up preference
 * cannot bypass that review, including after a cheaper recovery. */
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heroProgressionBody, type HeroProgressionIntent } from '@shardkeep/shared/heroProgression';
import { authCookies } from '../../auth/authCookieCoordinator';
import { api } from '../../lib/api';
import { heroProgressionIdentity } from '../../lib/heroProgression/browser';
import { useHeroProgressionView, type HeroProgressionView } from '../../lib/heroProgression/context';
import { id, identity, proof } from '../../lib/heroProgression/fixtures.test-support';
import { HeroProgressionJournalStore } from '../../lib/heroProgression/journal';
import { KEEP_CONFIRM_KEY } from '../../lib/keepConfirm';
import { useApp } from '../../state/store';
import { HeroProgressionProvider } from '../HeroProgression';
import { HeroTray, type HeroDto } from './heroes';

vi.mock('../sheets', () => ({ reloadBase: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));

let host: HTMLDivElement, root: Root, view: HeroProgressionView;
let rows: HeroDto[], gems: string, keep: string;
const accepted = new Map<string, HeroProgressionIntent>();
function Probe() { view = useHeroProgressionView()!; return null; }
const until = async (check: () => void | Promise<void>) => {
  let failure: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    try { await check(); return; } catch (error) { failure = error; }
  }
  throw failure;
};
const idle = () => until(() => expect(view.state.loaded && !view.state.busy).toBe(true));
const saved = async () => {
  const store = new HeroProgressionJournalStore(heroProgressionIdentity(identity.wallet));
  try { return await store.read(); } finally { await store.close(); }
};
const mount = async () => {
  await act(async () => root.render(<HeroProgressionProvider actionsEnabled><Probe /><HeroTray /></HeroProgressionProvider>));
  await idle();
};
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"][aria-label="Confirm Hero payment"]');
function button(label: string, container: HTMLElement = host): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(node => node.textContent?.includes(label));
  if (!found) throw new Error(`Missing ${label} button: ${container.textContent}`);
  return found as HTMLButtonElement;
}
async function review(label: string) {
  await until(() => expect(button(label).disabled).toBe(false));
  await act(async () => button(label).click());
  await until(() => { expect(dialog()).not.toBeNull(); expect(view.state.busy).toBe(false); });
}
async function confirm(currency: 'KEEP' | 'GEMS', double = false) {
  const confirm = button(`CONFIRM ${currency}`, dialog()!);
  expect(confirm.disabled).toBe(false);
  await act(async () => { confirm.click(); if (double) confirm.click(); });
  await idle();
  expect(view.state.journal?.operation?.proof?.status).toBe('accepted');
}
async function finish() {
  await act(async () => button('ARCHIVE CONFIRMED RECEIPT', document.body).click()); await idle();
  expect(view.state.journal?.operation).toBeNull();
  await act(async () => button('CLOSE', document.body).click());
}
function downedVex(overrides: Partial<HeroDto> = {}): HeroDto {
  return {
    hero: 'vex', name: 'Vex', title: 'Blade of Dawn', altar: 'heroaltar',
    unlockKeepLevel: 5, recruitCostKeep: '3000', recruitItemId: 'item_hero_vex',
    recruited: true, level: 4, tier: 1, tierName: 'Initiate', hp: 1_400, dps: 95,
    recoveryUntil: new Date(Date.now() + 85_000).toISOString(), available: false, gear: null,
    recoveryFinishNow: { remainingSec: 85, costKeep: '4321', affordable: true }, maxLevel: 20,
    next: { level: 5, tier: 1, tierName: 'Initiate', hp: 1_600, dps: 110, costKeep: '1000' },
    affordable: true, ...overrides,
  };
}
function readyVex(overrides: Partial<HeroDto> = {}): HeroDto {
  return { ...downedVex(), level: 11, tierName: 'Moonsunder', hp: 2_800, dps: 190,
    recoveryUntil: null, available: true, recoveryFinishNow: null,
    next: { level: 12, tier: 3, tierName: 'Moonsunder', hp: 3_000, dps: 205, costKeep: '532000' },
    ...overrides };
}
const roster = () => ({ keepBalance: keep, keepLevel: 10, heroes: rows,
  features: { heroConsent: { version: 1 }, heroReceipts: { version: 1 } } });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  const held = new Set<string>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (key: string, _options: unknown, run: (lock: object | null) => Promise<unknown>) => {
      if (held.has(key)) return run(null); held.add(key);
      try { return await run({}); } finally { held.delete(key); }
    },
  } });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session');
  vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  localStorage.clear(); accepted.clear(); rows = [downedVex()]; gems = '0'; keep = '9999999';
  useApp.getState().setAuth(identity.wallet, true);
  useApp.setState({ screen: 'build', selectedBaseId: id(1), baseSelectionEpoch: 0, selectedBuildingId: null, buildCategory: 'her' });
  vi.spyOn(api, 'get').mockImplementation(async (path, options) => {
    options?.isCurrent?.();
    if (path.includes('/receipt?')) {
      const key = new URL(path, 'https://test.invalid').searchParams.get('idempotencyKey')!;
      const intent = accepted.get(key);
      return (intent ? proof(intent, true) : { version: 1, status: 'unknown', idempotencyKey: key }) as never;
    }
    if (path === '/me') return { wallet: identity.wallet } as never;
    if (path === '/bases') return { enabled: true, capabilities: { baseScopedReads: true, baseScopedMutations: true }, bases: [{ id: id(1), status: 'active', slot: 1 }] } as never;
    if (path.startsWith('/base?')) return { baseId: id(1), player: { wallet: identity.wallet, keepLevel: 10 }, buildings: [], army: [], jobs: [], obstacles: [], heroes: rows } as never;
    if (path.startsWith('/balances?')) return { keep, gems, shards: '500', keepRate: 1,
      features: { gems: { version: 1, receipts: 1 }, gameCurrency: { version: 1, exactSpendCurrency: 1 } } } as never;
    if (path.startsWith('/heroes?')) return roster() as never;
    throw new Error(`Unexpected ${path}`);
  });
  vi.spyOn(api, 'postRaw').mockImplementation(async (_path, body, options) => {
    expect(options?.isCurrent).toBeTypeOf('function'); options!.isCurrent!();
    const operation = (await saved()).operation!;
    expect(operation.attempted).toBe(true);
    expect(body).toEqual(heroProgressionBody(operation.intent));
    expect(options?.expectedCurrency).toBe(operation.intent.expectedCurrency);
    accepted.set(operation.intent.idempotencyKey, operation.intent);
    return {} as never;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'locks'); Reflect.deleteProperty(document, 'visibilityState');
  useApp.getState().setAuth(null); useApp.setState({ base: null, selectedBaseId: null });
});

describe('Hero roster recovery requires exact payment consent', () => {
  it('reviews the server ceiling, original base and recovery episode before one KEEP payment', async () => {
    await mount(); await review('REVIEW RECOVERY');
    expect(api.postRaw).not.toHaveBeenCalled();
    expect(dialog()!.textContent).toContain('UP TO 4,321');
    expect(dialog()!.textContent).toContain('only KEEP');
    expect(dialog()!.textContent).toContain('VEX'); expect(dialog()!.textContent).toContain(id(1));
    expect(dialog()!.textContent).toContain(rows[0]!.recoveryUntil!);
    await confirm('KEEP');
    expect(api.postRaw).toHaveBeenCalledOnce();
    expect(api.postRaw).toHaveBeenCalledWith('/heroes/vex/recovery/speedup', expect.objectContaining({
      baseId: id(1), consent: { recoveryUntil: rows[0]!.recoveryUntil, maxCostKeep: '4321' },
    }), expect.objectContaining({ expectedCurrency: 'KEEP' }));
  });

  it('CANCEL REVIEW spends nothing and retains the unattempted draft', async () => {
    await mount(); await review('REVIEW RECOVERY');
    await act(async () => button('CANCEL REVIEW', dialog()!).click()); await idle();
    expect(dialog()).toBeNull(); expect(api.postRaw).not.toHaveBeenCalled();
    expect((await saved()).operation?.attempted).toBe(false);
  });

  it('the old opt-out cannot suppress recovery review and a double confirmation spends once', async () => {
    localStorage.setItem(KEEP_CONFIRM_KEY, '0'); await mount(); await review('REVIEW RECOVERY');
    expect(dialog()!.textContent).not.toContain("DON'T ASK"); expect(api.postRaw).not.toHaveBeenCalled();
    await confirm('KEEP', true); expect(api.postRaw).toHaveBeenCalledOnce();
  });
});

describe('Hero roster upgrades require exact payment consent', () => {
  beforeEach(() => { rows = [readyVex({ affordable: false })]; gems = '9999999'; keep = '0'; });

  it('names the Hero and purchased level with the fresh Gems ceiling even when legacy KEEP is unaffordable', async () => {
    await mount(); await review('REVIEW UPGRADE · L12');
    expect(api.postRaw).not.toHaveBeenCalled(); expect(dialog()!.textContent).toContain('UP TO 532,000');
    expect(dialog()!.textContent).toContain('only GEMS');
    expect(dialog()!.textContent).toContain('VEX'); expect(dialog()!.textContent).toContain('12');
    expect(dialog()!.textContent).toContain(id(1));
    await confirm('GEMS'); expect(api.postRaw).toHaveBeenCalledOnce();
    expect(api.postRaw).toHaveBeenCalledWith('/heroes/vex/upgrade', expect.objectContaining({
      baseId: id(1), consent: { expectedLevel: 11, maxCostKeep: '532000' },
    }), expect.objectContaining({ expectedCurrency: 'GEMS' }));
  });

  it('CANCEL REVIEW buys no level', async () => {
    await mount(); await review('REVIEW UPGRADE · L12');
    await act(async () => button('CANCEL REVIEW', dialog()!).click()); await idle();
    expect(dialog()).toBeNull(); expect(api.postRaw).not.toHaveBeenCalled();
  });

  it('the old opt-out cannot suppress upgrade review and a double confirmation buys once', async () => {
    localStorage.setItem(KEEP_CONFIRM_KEY, '0'); await mount(); await review('REVIEW UPGRADE · L12');
    expect(dialog()!.textContent).not.toContain("DON'T ASK"); expect(api.postRaw).not.toHaveBeenCalled();
    await confirm('GEMS', true); expect(api.postRaw).toHaveBeenCalledOnce();
  });

  it('a recovery and the shared speed-up preference cannot bypass the next expensive upgrade review', async () => {
    localStorage.setItem(KEEP_CONFIRM_KEY, '0');
    rows = [downedVex(), readyVex({ hero: 'theodor', name: 'Theodor' })];
    await mount(); await review('REVIEW RECOVERY'); await confirm('GEMS'); await finish();
    await review('REVIEW UPGRADE · L12');
    expect(api.postRaw).toHaveBeenCalledOnce(); expect(dialog()!.textContent).toContain('THEODOR');
    await confirm('GEMS'); expect(api.postRaw).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.postRaw).mock.calls[1]![0]).toBe('/heroes/theodor/upgrade');
  });
});
