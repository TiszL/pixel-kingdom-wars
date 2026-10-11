/** @vitest-environment happy-dom */
/**
 * THE REBUILT QUEST BOARD (owner 2026-08-28: "improve quest UI because it was
 * awful", and onboarding "should be quest driven").
 *
 * What these pin is the READING ORDER and the ACTION — the two things the old
 * board got wrong. Colours and 9-slice plates are verified by looking at the
 * rendered screen, not asserted here; what a test can hold is:
 *
 *  - the first-run chain is FIRST, in its authored order, and it disappears the
 *    moment it is finished (a veteran must not carry five DONE rows forever);
 *  - exactly ONE chain step is live at a time, and it is the first unclaimed one
 *    — the same rule the server uses (getOnboardingStep), so the board and the
 *    base-screen strip can never disagree about where the player is;
 *  - a finished step offers CLAIM and a live one offers its own verb, so there
 *    is always exactly one obvious tap;
 *  - claiming posts the real quest route with the deed bound.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUESTS } from '@shardkeep/shared';
import { api } from '../../lib/api';
import { bus } from '../../lib/events';
import { useApp } from '../../state/store';

/**
 * The board calls `reloadBase()` after a claim, which lives in sheets.tsx, which
 * reaches Privy's Solana bundle through `useSolPurchase`. That bundle imports
 * `@solana-program/memo`, which only resolves through the shim alias in
 * vite.config's `resolve.alias`; vitest externalises node_modules instead of
 * transforming them, so the alias never applies and the import throws.
 *
 * Same boundary landLocked.test.tsx stubs, for the same reason: nothing here
 * signs anything, so the payment hook is stubbed rather than a wallet SDK
 * dragged into a rendering assertion. `vi.mock` is hoisted above the import
 * below, which is why that import is not with the others.
 */
vi.mock('../../auth/useSolPurchase', () => ({
  useSolPurchase: () => ({ buy: () => undefined, busy: false, error: null }),
}));

vi.mock('../../state/baseSnapshot', () => ({
  reloadBase: vi.fn().mockResolvedValue(undefined),
  reloadCurrentBaseSnapshot: vi.fn().mockResolvedValue(true),
}));

import { QuestsScreen } from './quests';

let host: HTMLDivElement;
let root: Root;

const chainQuest = (templateCode: string, over: Partial<{
  completed: boolean; claimed: boolean; progress: number;
}> = {}) => ({
  id: `q-${templateCode}`, scope: 'onboarding', templateCode, target: 1,
  rewardShards: 15, progress: 0, completed: false, claimed: false, ...over,
});

const board = (quests: unknown[]) => ({ day: '2026-08-28', allThreeBonus: 25, quests });

/** The full chain, with the first `claimedCount` steps already taken. */
const chainWith = (claimedCount: number) =>
  QUESTS.onboardingTemplates.map((t, i) =>
    chainQuest(t.id, i < claimedCount ? { completed: true, claimed: true, progress: 1 } : {}));

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  useApp.setState({ selectedBaseId: null, screen: 'quests', base: null, placing: null, entryPaid: false });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(<QuestsScreen />);
    await Promise.resolve();
  });
  // useFetch resolves on a microtask; give it a beat to commit.
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    if (host.textContent && host.textContent.length > 20) break;
  }
};

const buttons = (): string[] =>
  [...host.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');

describe('quest board — the first-run chain', () => {
  it('renders the chain FIRST and in QUESTS.onboardingTemplates order', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(board([
      // Deliberately shuffled on the wire: the board owns the order, not the
      // server's row order, or a re-seeded database would reorder onboarding.
      ...chainWith(0).slice().reverse(),
      { id: 'w', scope: 'weekly', templateCode: 'earn_8_stars', target: 8, rewardShards: 100, progress: 0, completed: false, claimed: false },
    ]));
    await render();
    const text = host.textContent ?? '';
    expect(text).toContain('YOUR FIRST STEPS');
    const positions = QUESTS.onboardingTemplates.map((t) => {
      const label = t.name.toUpperCase();
      return text.indexOf(label);
    });
    for (const p of positions) expect(p).toBeGreaterThan(-1);
    // Strictly ascending → the chain reads top to bottom in its authored order.
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]!, `${QUESTS.onboardingTemplates[i]!.id} is out of order`)
        .toBeGreaterThan(positions[i - 1]!);
    }
    // And the chain sits above the weekly.
    expect(text.indexOf('YOUR FIRST STEPS')).toBeLessThan(text.indexOf('THIS WEEK'));
  });

  it('offers the LIVE step its own verb — the "direct them to do things" tap', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(board(chainWith(3)));
    await render();
    // Three claimed → the live step is CLAIM YOUR LAND, whose verb is CLAIM…
    expect(host.textContent).toContain('CLAIM YOUR LAND');
    // …and the later step still shows its own verb so the path stays visible.
    expect(buttons()).toContain('RAID');
  });

  it('a completed-but-unclaimed step offers CLAIM and posts the real quest route', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(board([
      chainQuest('first_camp', { completed: true, progress: 1 }),
    ]));
    const post = vi.spyOn(api, 'post').mockResolvedValue({});
    await render();
    const claim = [...host.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'CLAIM');
    expect(claim, 'a finished step must offer CLAIM').toBeTruthy();
    await act(async () => {
      claim!.click();
      await Promise.resolve();
    });
    expect(post).toHaveBeenCalledWith('/quests/q-first_camp/claim', expect.any(Object));
  });

  it('hides the whole section once every step is claimed', async () => {
    // A veteran's board must not carry five permanent DONE rows.
    vi.spyOn(api, 'get').mockResolvedValue(board(chainWith(QUESTS.onboardingTemplates.length)));
    await render();
    expect(host.textContent).not.toContain('YOUR FIRST STEPS');
    // The rest of the board is still there.
    expect(host.textContent).toContain('TODAY');
  });

  it('every control is at least 44px on its short side', async () => {
    // Mobile-first is a constraint, not a preference: this board is played on a
    // 360px phone and a 44px minimum is what makes its buttons tappable.
    vi.spyOn(api, 'get').mockResolvedValue(board(chainWith(0)));
    await render();
    for (const b of host.querySelectorAll('button')) {
      const style = (b as HTMLElement).style;
      const min = style.minHeight || style.height;
      expect(min, `${b.textContent?.trim()} has no 44px floor`).toMatch(/^44px$/);
    }
  });
});

describe('quest board — the daily and weekly bands', () => {
  it('sorts claimable dailies to the top and claimed ones to the bottom', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(board([
      { id: 'd1', scope: 'daily', templateCode: 'scout_1', target: 1, rewardShards: 10, progress: 0, completed: false, claimed: false },
      { id: 'd2', scope: 'daily', templateCode: 'upgrade_any', target: 1, rewardShards: 15, progress: 1, completed: true, claimed: true },
      { id: 'd3', scope: 'daily', templateCode: 'collect_mines', target: 1, rewardShards: 10, progress: 1, completed: true, claimed: false },
    ]));
    await render();
    const text = host.textContent ?? '';
    // The one that can PAY YOU is first; the spent one is last. That ordering is
    // the whole reason a 50-row board is usable at all.
    expect(text.indexOf('COLLECT FROM YOUR MINES')).toBeLessThan(text.indexOf('SCOUT AN ENEMY BASE'));
    expect(text.indexOf('SCOUT AN ENEMY BASE')).toBeLessThan(text.indexOf('UPGRADE ANY BUILDING'));
  });

  it('shows the all-three bonus with the shard reward the server reports', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(board([]));
    await render();
    expect(host.textContent).toContain(`CLAIM ANY ${QUESTS.dailyBonusAt}`);
    expect(host.textContent).toContain('25');
  });
});

it('a server completion refresh updates the open quest board without leaving and returning', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue(board([chainQuest('first_camp')]));
  await render();
  expect(buttons()).not.toContain('CLAIM');
  get.mockResolvedValue(board([chainQuest('first_camp', { completed: true, progress: 1 })]));
  await act(async () => { bus.emit('onboarding:refresh', undefined); });
  expect(buttons()).toContain('CLAIM');
});

const readyQuest = (id: string) => ({ ...chainQuest(id, { completed: true, progress: 1 }), id, scope: 'daily' });
const clickAll = async () => act(async () => {
  [...host.querySelectorAll('button')].find(b => b.textContent?.includes('CLAIM ALL READY'))!.click();
});

it('claims only the reviewed ready quests sequentially and keeps each request on its deed', async () => {
  useApp.setState({ selectedBaseId: 'base-a' });
  vi.spyOn(api, 'get').mockResolvedValue(board([readyQuest('one'), readyQuest('two'), chainQuest('unfinished')]));
  let release!: () => void;
  const post = vi.spyOn(api, 'post').mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }))
    .mockResolvedValue({});
  await render();
  await clickAll();
  expect(post).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('CLAIMING…');
  await act(async () => release());
  expect(post.mock.calls).toEqual([
    ['/quests/one/claim', { baseId: 'base-a' }], ['/quests/two/claim', { baseId: 'base-a' }],
  ]);
});

it('stops bulk claims on a lost response and refreshes instead of blindly repeating a possible payment', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue(board([readyQuest('one'), readyQuest('two'), readyQuest('three')]));
  const post = vi.spyOn(api, 'post').mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('response lost'));
  const messages: string[] = [];
  const off = bus.on('ui:toast', ({ msg }) => messages.push(msg));
  try {
    await render(); await clickAll();
    expect(post).toHaveBeenCalledTimes(2);
    expect(get.mock.calls.length).toBeGreaterThan(1);
    expect(messages).toContain('1 CLAIMS CONFIRMED — REFRESHING; RETRY REMAINING QUESTS');
  } finally { off(); }
});

it('does not send remaining claims to a base selected while a response is pending', async () => {
  useApp.setState({ selectedBaseId: 'base-a' });
  vi.spyOn(api, 'get').mockResolvedValue(board([readyQuest('one'), readyQuest('two')]));
  let release!: () => void;
  const post = vi.spyOn(api, 'post').mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  await render(); await clickAll();
  await act(async () => { useApp.setState({ selectedBaseId: 'base-b' }); release(); });
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]?.[1]).toEqual({ baseId: 'base-a' });
});

it('disables individual and bulk claims while the first request is unresolved', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(board([readyQuest('one'), readyQuest('two')]));
  let release!: () => void;
  const post = vi.spyOn(api, 'post').mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }))
    .mockResolvedValue({});
  await render(); await clickAll();
  const actions = [...host.querySelectorAll('button')].filter(b => b.textContent?.includes('CLAIM'));
  expect(actions.every(b => b.disabled)).toBe(true);
  await act(async () => { actions.forEach(b => b.click()); });
  expect(post).toHaveBeenCalledTimes(1);
  await act(async () => release());
  expect(post).toHaveBeenCalledTimes(2);
});
