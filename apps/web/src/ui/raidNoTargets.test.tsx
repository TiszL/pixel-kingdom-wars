/**
 * F10 — THE FIRST FREE PLAYER'S PRIMARY CTA MUST NOT DEAD-END.
 *
 * The defect these pin: `POST /raids` answers `404 no_targets_deedless` when a
 * DEEDLESS player's matchmaking pool is empty, and the pool STARTS EMPTY — so the
 * very first free player to press FIND ME A TARGET hits it, guaranteed. The client
 * matched only `no_targets` and only the ladder's message text, so the deedless
 * answer fell through to `null` and the generic dead-end panel (one red line and
 * BACK TO BASE) rendered instead of an exit.
 *
 * Three failures pinned here:
 *   1. classifying a deedless empty pool as `null` — the dead end itself;
 *   2. classifying it as 'ladder' — that panel offers WORLD MAP and PvE, both of
 *      which a landless keep gets a 402 for (LAND_NOT_OWNED);
 *   3. drifting the LANDOWNER's classification, which must keep resolving to
 *      'ladder' from either the code or the old message.
 *
 * No jsdom in this package (see mapChromeUI.test.tsx / RaidChooser.test.tsx): the
 * rule is a pure exported function, and the panel is hook-free so it can be CALLED
 * and its returned element tree read.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import {
  DeedlessNoTargets, NO_SETTLERS_TITLE, NO_SETTLERS_WHY, noTargetsPool,
} from './raidNoTargets';

/** Flatten every string in a returned React element tree (RaidChooser.test.tsx). */
function textOf(node: unknown): string {
  return rawText(node).replace(/\s+/g, ' ').trim();
}
function rawText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(rawText).join('');
  const el = node as { props?: { children?: unknown } };
  if (!el.props) return '';
  return rawText(el.props.children);
}
/** Every clickable in the returned tree, as { label, onClick }. */
function buttonsOf(node: unknown): Array<{ label: string; onClick?: () => void }> {
  const out: Array<{ label: string; onClick?: () => void }> = [];
  const walk = (n: unknown): void => {
    if (n === null || n === undefined || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const el = n as { type?: unknown; props?: { children?: unknown; onClick?: () => void } };
    if (!el.props) return;
    if (typeof el.props.onClick === 'function') {
      out.push({ label: textOf(el.props.children), onClick: el.props.onClick });
    }
    walk(el.props.children);
  };
  walk(node);
  return out;
}

describe('noTargetsPool — which empty pool, and never "no idea"', () => {
  it('routes the deedless code to the deedless panel', () => {
    // THE F10 REGRESSION. Before the fix this returned null and the player got the
    // dead end; returning 'ladder' would offer them two 402s instead.
    expect(noTargetsPool(new ApiError(404, 'no other settlers to raid right now', 'no_targets_deedless')))
      .toBe('deedless');
  });

  it('keeps the landowner on the ladder panel — from the code AND from the old message', () => {
    expect(noTargetsPool(new ApiError(404, 'no eligible targets — try the world map or PvE', 'no_targets')))
      .toBe('ladder');
    // An api build older than the codes still gets routes, not the dead end.
    expect(noTargetsPool(new ApiError(404, 'no eligible targets — try the world map or PvE')))
      .toBe('ladder');
  });

  it('reads an OLDER deedless build from its message rather than mistaking it for the ladder', () => {
    expect(noTargetsPool(new ApiError(404, 'no other settlers to raid right now — try CAMPAIGN, or buy your land to join the world')))
      .toBe('deedless');
  });

  it('routes the D-099 messages — which name the Keep restriction — by their codes', () => {
    // WHY: D-099 reworded both empty-pool messages to state the rule ("KEEP ≥ 6")
    // and RaidUI shows the ladder's line verbatim. The ladder message no longer
    // contains "no eligible targets", so a classifier that still leaned on the
    // text would send a landowner to the dead end the moment the API deployed.
    expect(noTargetsPool(new ApiError(
      404, 'no deeded base at KEEP ≥ 6 without a shield or a recent raid right now — try the world map or PvE', 'no_targets',
    ))).toBe('ladder');
    expect(noTargetsPool(new ApiError(
      404, 'no other settlers at KEEP ≥ 6 to raid right now — try CAMPAIGN, or buy your land to join the world', 'no_targets_deedless',
    ))).toBe('deedless');
  });

  it('claims nothing about any other failure', () => {
    // Out-of-energy and the daily cap own their own UI; a 404 for something else
    // is not an empty pool; and a non-ApiError has no code at all.
    expect(noTargetsPool(new ApiError(422, 'out of raid energy'))).toBeNull();
    expect(noTargetsPool(new ApiError(404, 'player not found'))).toBeNull();
    expect(noTargetsPool(new ApiError(402, 'buy your land', 'LAND_NOT_OWNED'))).toBeNull();
    expect(noTargetsPool(new Error('offline'))).toBeNull();
  });
});

describe('DeedlessNoTargets — honest, and it goes somewhere', () => {
  const panel = (fee = 0.2): React.JSX.Element => DeedlessNoTargets({
    entryFeeSol: fee, onCampaign: vi.fn(), onBuyLand: vi.fn(),
  });

  it('says the pool is empty, and does not blame the player', () => {
    const t = textOf(panel());
    expect(t).toContain(NO_SETTLERS_TITLE);
    expect(t).toContain(NO_SETTLERS_WHY.replace(/\s+/g, ' '));
    expect(t).toMatch(/pool is empty/i);
    // "no eligible targets" reads as a failed search; this is a fact about a world
    // with nobody in it yet.
    expect(t).not.toMatch(/no eligible targets/i);
  });

  it('never invents a pool size the server does not return', () => {
    // The ONLY number allowed in this panel is the price it was handed.
    expect(textOf(panel()).replace('0.2 SOL', '')).not.toMatch(/\d/);
  });

  it('renders the price it is GIVEN — the number is never a second source', () => {
    expect(textOf(panel(0.2))).toContain('0.2 SOL');
    expect(textOf(panel(1.5))).toContain('1.5 SOL');
  });

  it('offers exactly the two exits the server will honour, and CAMPAIGN first', () => {
    const labels = buttonsOf(panel()).map((b) => b.label);
    expect(labels).toEqual(['PLAY CAMPAIGN', 'BUY YOUR LAND · 0.2 SOL']);
    // WORLD MAP and PvE are the LANDOWNER's exits. Both 402 for a landless keep
    // (no roster row to pick from; /raids/pve is `owned`), so offering them here
    // would be the dead toast this panel exists to remove.
    expect(labels.join(' ')).not.toMatch(/WORLD MAP|SCOUT|BOUNTY|PVE/i);
  });

  it('wires each exit to its own handler', () => {
    const onCampaign = vi.fn();
    const onBuyLand = vi.fn();
    const btns = buttonsOf(DeedlessNoTargets({ entryFeeSol: 0.2, onCampaign, onBuyLand }));
    btns[0]?.onClick?.();
    expect(onCampaign).toHaveBeenCalledOnce();
    expect(onBuyLand).not.toHaveBeenCalled();
    btns[1]?.onClick?.();
    expect(onBuyLand).toHaveBeenCalledOnce();
  });
});
