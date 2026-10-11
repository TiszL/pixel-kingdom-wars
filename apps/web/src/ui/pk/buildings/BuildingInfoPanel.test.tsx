/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILDINGS_INFO_SOURCE } from '../../../lib/phaseEActivity/panelIds';
import type { BasePanel } from '../basePanel';
import { createPanelSession, type PanelAction } from '../panelSession';
import BuildingInfoPanel, { type BuildingInfoPanelInput, type BuildingInfoPanelProps } from './BuildingInfoPanel';
import type { BuildingSnapshotFacts } from './buildingSnapshot';

// Presentation fixtures only; all real catalogue/server values remain supplier-owned.
const facts = (patch: Partial<BuildingSnapshotFacts> = {}): BuildingSnapshotFacts => ({
  buildingId: 'tower-fixture', type: 'archertower', name: 'Archer Tower', level: 4, maxLevel: 10,
  artNow: 'tower-tier-one', artNext: 'tower-tier-two', role: 'Guards the kingdom.', category: 'DEFENCE',
  stats: [{ key: 'HP', now: '340', next: '430' }],
  canShowUpgrade: true, enabled: true, upgradeCurrency: 'SHARDS', upgradeCost: '521', upgradeCostRaw: '521',
  upgradePriced: true, upgradeTime: '1h 30m', upgradeDetail: 'Server builder detail', paidStep: false, paidOfferReady: false,
  job: null, repair: null, shardsBalance: '900', freeBuilders: 1, totalBuilders: 2, nextBuilderFreeIn: null,
  heroReady: null, wallRow: false, blockedReason: 'Orders are paused here', readOnly: false, constructionBlocked: false,
  busy: false, mine: { mineBuildingId: null, accrued: null }, ...patch,
});
const job = { id: 'job-fixture', kind: 'upgrade', remaining: '1h 12m', freeFinish: false, canReview: true, cancelRefund: null };
let host: HTMLDivElement;
let root: Root;
let input: BuildingInfoPanelInput;
let props: BuildingInfoPanelProps;
let craft: ReturnType<typeof vi.fn<() => void>>;
let admitted: boolean;

const render = (next: BuildingInfoPanelProps = props) => act(async () => root.render(<BuildingInfoPanel {...next} />));
const findButton = (name: string): HTMLButtonElement | undefined => [...host.querySelectorAll('button')]
  .find(button => button.getAttribute('aria-label')?.startsWith(name) || button.textContent?.trim() === name);
const button = (name: string): HTMLButtonElement => {
  const found = findButton(name);
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
};
const click = (name: string) => act(async () => button(name).click());
const sensitive = () => [input.actions.onUpgrade, input.actions.onFinish, input.actions.onGetMore, input.actions.onExtra, craft];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  admitted = true; craft = vi.fn();
  input = {
    facts: facts(), renderArt: vi.fn(key => <span data-supplied-art={key} />),
    actions: {
      onUpgrade: vi.fn(), onFinish: vi.fn(), onGetMore: vi.fn(), onExtra: vi.fn(),
      onAllLevels: vi.fn(), onRetry: vi.fn(), onExplain: vi.fn(),
    },
  };
  props = {
    panel: { ...BUILDINGS_INFO_SOURCE, buildingId: input.facts.buildingId },
    onClose: vi.fn(), actionsEnabled: true, input,
    session: {
      setDismissPolicy: vi.fn(() => () => undefined),
      dispatch: vi.fn((_kind: PanelAction, action: () => void) => {
        if (!admitted) return false;
        action(); return true;
      }),
    },
  };
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('BuildingInfoPanel', () => {
  it.each(['omitted', 'null'] as const)('is inert when supplier input is %s', async missing => {
    const { input: _input, ...base } = props;
    await render(missing === 'null' ? { ...base, input: null } : base);
    expect(host.childElementCount).toBe(0);
    expect(input.renderArt).not.toHaveBeenCalled();
    expect(props.session.dispatch).not.toHaveBeenCalled();
    expect(props.session.setDismissPolicy).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'build', featureId: BUILDINGS_INFO_SOURCE.featureId, buildingId: 'tower-fixture' },
    { kind: BUILDINGS_INFO_SOURCE.kind, featureId: 'unrelated.info', buildingId: 'tower-fixture' },
    { ...BUILDINGS_INFO_SOURCE, buildingId: 'different-building' },
    { ...BUILDINGS_INFO_SOURCE },
  ] satisfies BasePanel[])('refuses a mismatched panel identity %j before reading supplied art or invoking callbacks', async panel => {
    await render({ ...props, panel });
    expect(host.childElementCount).toBe(0);
    expect(input.renderArt).not.toHaveBeenCalled();
    expect(props.session.dispatch).not.toHaveBeenCalled();
    for (const action of Object.values(input.actions)) expect(action).not.toHaveBeenCalled();
  });

  it('renders the accepted INFO body from supplied facts and art without invoking any action', async () => {
    await render();
    expect(host.querySelector('[role="region"][aria-label="ARCHER TOWER info"]')?.getAttribute('data-sheet-size')).toBe('HALF');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain('Guards the kingdom.');
    expect(host.textContent).toContain('GUARDING');
    expect(host.querySelector('[aria-label="Hitpoints: 340, next level 430"]')).not.toBeNull();
    expect(host.querySelector('[data-supplied-art="tower-tier-one"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Takes 1h 30m"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Builders 1/2 free"]')).not.toBeNull();
    expect(button('UPGRADE TO LV 5').textContent).toContain('Server builder detail');
    expect(props.session.dispatch).not.toHaveBeenCalled();
    expect(props.session.setDismissPolicy).not.toHaveBeenCalled();
    for (const action of Object.values(input.actions)) expect(action).not.toHaveBeenCalled();
  });

  it('does not change supplied facts when narrowing host capability and restores the original presentation', async () => {
    input.facts = Object.freeze(facts());
    const before = JSON.stringify(input.facts);
    await render({ ...props, actionsEnabled: false });
    expect(button('UPGRADE TO LV 5').getAttribute('aria-disabled')).toBe('true');
    expect(JSON.stringify(input.facts)).toBe(before);
    expect(input.facts.enabled).toBe(true);
    await render();
    expect(button('UPGRADE TO LV 5').getAttribute('aria-disabled')).not.toBe('true');
    expect(JSON.stringify(input.facts)).toBe(before);
  });

  it('does not expose a Workshop control when the owner supplies no craft callback', async () => {
    input.facts = facts({ type: 'workshop', category: 'ARMY' });
    await render();
    expect(findButton('WORKSHOP')).toBeUndefined();
    expect(props.session.dispatch).not.toHaveBeenCalled();
  });

  it('opens Workshop only on an explicit click and never during render or rerender', async () => {
    input.facts = facts({ type: 'workshop', category: 'ARMY' });
    await render({ ...props, onCraft: craft });
    await render({ ...props, onCraft: craft });
    expect(craft).not.toHaveBeenCalled(); expect(props.session.dispatch).not.toHaveBeenCalled();
    await click('WORKSHOP');
    expect(craft).toHaveBeenCalledOnce();
    expect(props.session.dispatch).toHaveBeenCalledExactlyOnceWith('read', expect.any(Function));
  });

  it.each([
    ['not a Workshop', { type: 'archertower' }],
    ['unbuilt', { level: 0 }],
    ['running job', { job }],
    ['repair', { repair: { cost: '125', time: '2m' } }],
    ['busy', { busy: true }],
    ['supplier disabled', { enabled: false }],
    ['read only', { readOnly: true }],
  ] satisfies [string, Partial<BuildingSnapshotFacts>][])('does not expose craft for %s facts', async (_label, patch) => {
    input.facts = facts({ type: 'workshop', ...patch });
    await render({ ...props, onCraft: craft });
    expect(findButton('WORKSHOP')).toBeUndefined(); expect(craft).not.toHaveBeenCalled();
  });

  it('does not turn the supplied construction-only gate into a new blanket Workshop restriction', async () => {
    input.facts = facts({ type: 'workshop', constructionBlocked: true });
    await render({ ...props, onCraft: craft });
    await click('WORKSHOP');
    expect(craft).toHaveBeenCalledOnce();
  });

  it.each([
    ['UPGRADE TO LV 5', {}, 'onUpgrade'],
    ['REVIEW FINISH', { job }, 'onFinish'],
    ['Costs 521 Shards, not enough. See where to get more', { shardsBalance: '0' }, 'onGetMore'],
    ['Select whole row', { type: 'wall' }, 'onExtra'],
    ['WORKSHOP', { type: 'workshop' }, 'onCraft'],
  ] satisfies [string, Partial<BuildingSnapshotFacts>, 'onUpgrade' | 'onFinish' | 'onGetMore' | 'onExtra' | 'onCraft'][])
  ('routes %s through its host admission and never invokes the owner after session refusal', async (label, patch, target) => {
    input.facts = facts(patch);
    const action = target === 'onCraft' ? craft : input.actions[target];
    const kind = target === 'onFinish' || target === 'onExtra' ? 'mutate' : 'read';
    await render({ ...props, onCraft: craft });
    admitted = false;
    await click(label);
    expect(action).not.toHaveBeenCalled();
    expect(props.session.dispatch).toHaveBeenLastCalledWith(kind, expect.any(Function));
    admitted = true;
    await click(label);
    expect(action).toHaveBeenCalledOnce();
    if (target === 'onGetMore') expect(action).toHaveBeenCalledWith('SHARDS');
    expect(props.session.dispatch).toHaveBeenCalledTimes(2);
  });

  it('uses the real host session to refuse unbound mutations and retired reads while current navigation works', async () => {
    // The unbound definition supplies no canMutate predicate; the real host therefore refuses mutation.
    const session = createPanelSession({
      panel: props.panel, isCurrent: () => true, canMutate: () => false, canRecover: () => false, controlled: false,
    });
    const retire = session.mount();
    const dispatch = vi.spyOn(session, 'dispatch'); props.session = session;
    try {
      input.facts = facts({ job });
      await render(); await click('REVIEW FINISH');
      expect(input.actions.onFinish).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenLastCalledWith('mutate', expect.any(Function));
      input.facts = facts({ type: 'wall' });
      await render(); await click('Select whole row');
      expect(input.actions.onExtra).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenLastCalledWith('mutate', expect.any(Function));
      input.facts = facts();
      await render(); await click('UPGRADE TO LV 5');
      expect(input.actions.onUpgrade).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenLastCalledWith('read', expect.any(Function));
      input.facts = facts({ type: 'workshop' });
      await render({ ...props, onCraft: craft });
      retire();
      await click('WORKSHOP');
      expect(craft).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenLastCalledWith('read', expect.any(Function));
    } finally { retire(); }
  });

  it.each([
    ['host capability', false, {}],
    ['supplier enabled', true, { enabled: false }],
    ['supplier read only', true, { readOnly: true }],
    ['supplier busy', true, { busy: true }],
  ] satisfies [string, boolean, Partial<BuildingSnapshotFacts>][])
  ('blocks sensitive callbacks under lost %s even when rendered price or wall controls remain tappable', async (_gate, actionsEnabled, gatePatch) => {
    for (const patch of [{ type: 'workshop', shardsBalance: '0' }, { job }, { type: 'wall' }]) {
      input.facts = facts({ ...patch, ...gatePatch });
      await render({ ...props, actionsEnabled, onCraft: craft });
      for (const label of ['UPGRADE TO LV 5', 'REVIEW FINISH', 'Costs 521 Shards, not enough. See where to get more', 'Select whole row']) {
        const control = findButton(label);
        if (control) await act(async () => control.click());
      }
      expect(findButton('WORKSHOP')).toBeUndefined();
    }
    for (const action of sensitive()) expect(action).not.toHaveBeenCalled();
  });

  it('keeps All levels and explanations as admitted read callbacks while host actions are disabled', async () => {
    input.facts = facts({ stats: Array.from({ length: 6 }, (_, index) => ({ key: `Stat ${index}`, now: `${index}`, next: null })) });
    await render({ ...props, actionsEnabled: false });
    await click('All levels: 1 more stats');
    await click('UPGRADE TO LV 5');
    expect(input.actions.onAllLevels).toHaveBeenCalledOnce();
    expect(input.actions.onExplain).toHaveBeenCalledExactlyOnceWith('Orders are paused here');
    expect(props.session.dispatch).toHaveBeenCalledTimes(2);
    for (const [kind] of vi.mocked(props.session.dispatch).mock.calls) expect(kind).toBe('read');
    for (const action of sensitive()) expect(action).not.toHaveBeenCalled();
    admitted = false;
    await click('All levels: 1 more stats'); await click('UPGRADE TO LV 5');
    expect(input.actions.onAllLevels).toHaveBeenCalledOnce(); expect(input.actions.onExplain).toHaveBeenCalledOnce();
  });

  it('keeps Close on the host callback without inventing a dismissal policy or input close owner', async () => {
    await render({ ...props, actionsEnabled: false });
    admitted = false;
    await click('Close ARCHER TOWER info');
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.session.dispatch).not.toHaveBeenCalled();
    expect(props.session.setDismissPolicy).not.toHaveBeenCalled();
  });
});
