/**
 * THE DEEDLESS RAID CHOOSER, AND THE LANDOWNER'S UNCHANGED ONE.
 *
 * LOCKED OWNER DECISION 2026-08-09: a deedless player gets AUTO-MATCH ONLY — no
 * map target-picking, no scouting — because they have no parcel, therefore no row
 * in the valley roster, therefore literally nothing on the map to aim at. The
 * world map survives as a look-only preview, since the world is the reason to buy
 * land and a hidden button cannot sell it.
 *
 * Two failures these pin:
 *   1. offering target-picking to a deedless player = a button whose only possible
 *      outcome is a 402 (the "dead toast" the whole change is meant to remove);
 *   2. drifting the LANDOWNER's chooser while editing the deedless one — the
 *      landowner shape is pinned literally, so any edit to it must be deliberate.
 *
 * There is no jsdom in this package (see admin.test.tsx / mapChromeUI.test.tsx):
 * the rules live in pure exported functions, and hook-free components are called
 * DIRECTLY and their returned element trees read.
 */
import { describe, expect, it, vi } from 'vitest';
import { raidChoices } from './RaidChooser';
import { LandGateSheet, NoLandPrompt } from './LandGate';

/** Flatten every string in a returned React element tree. JSX splits an
 *  interpolated sentence into many children, so runs of whitespace are collapsed
 *  — otherwise `{fee} SOL` reads as "0.2  SOL" and no copy assertion can match. */
function textOf(node: unknown): string {
  return rawText(node).replace(/\s+/g, ' ').trim();
}
function rawText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(rawText).join('');
  const el = node as { props?: { children?: unknown; title?: unknown; sub?: unknown } };
  if (!el.props) return '';
  return [el.props.title, el.props.sub, el.props.children].map(rawText).join(' ');
}

describe('raidChoices — landowner (must not drift)', () => {
  it('puts campaign first for a newly landed player still on the first raid quest', () => {
    const choices = raidChoices(true, true);
    expect(choices[0]).toMatchObject({ id: 'campaign', gold: true });
    expect(choices.filter((choice) => choice.gold)).toHaveLength(1);
    expect(choices.find((choice) => choice.id === 'map')?.preview).toBe(false);
  });
  it('is exactly the three rows that shipped, with the original copy', () => {
    expect(raidChoices(true)).toEqual([
      {
        id: 'auto', icon: 'attack', gold: true, title: 'FIND ME A TARGET',
        sub: 'Auto-match a base near your trophies — the fastest fight.',
      },
      {
        id: 'map', icon: 'map', title: 'WORLD MAP',
        sub: 'Pick any base on the globe and scout it first — distance never matters.',
      },
      {
        id: 'campaign', icon: 'star', title: 'CAMPAIGN',
        sub: 'Single-player stages. Free, no energy, your base is never at risk.',
      },
    ]);
  });
});

describe('raidChoices — deedless (auto-match only)', () => {
  const rows = raidChoices(false);

  it('offers auto-match and the campaign — the two the server will actually run', () => {
    expect(rows.map((r) => r.id)).toEqual(['campaign', 'auto', 'map']);
    expect(rows.find((r) => r.id === 'auto')?.sub).toMatch(/landless/i);
  });

  /**
   * F10. The landless matchmaking pool STARTS EMPTY, so the first free player to
   * press FIND ME A TARGET is guaranteed a 404 — and it was the gold CTA. These
   * two pin that the chooser leads with the fight that always works and does not
   * over-promise the one that may not.
   *
   * Both fail against the shape that shipped (auto first, auto gold, and a sub
   * reading "the only PvP open to you yet" with no condition on it).
   */
  it('leads with CAMPAIGN — the only row the server can ALWAYS run', () => {
    expect(rows[0]).toMatchObject({ id: 'campaign', gold: true });
    // Exactly one primary. Two gold rows would make "the fight on offer" ambiguous
    // again, which is the thing being fixed.
    expect(rows.filter((r) => r.gold).map((r) => r.id)).toEqual(['campaign']);
  });

  it('keeps FIND ME A TARGET, but says it needs somebody to be there', () => {
    const auto = rows.find((r) => r.id === 'auto');
    // Still reachable: the pool fills as players arrive, and hiding PvP from a
    // player whose one PvP this is would hide the game.
    expect(auto).toBeDefined();
    expect(auto?.gold).toBeUndefined();
    // The condition must be stated, not discovered by failing.
    expect(auto?.sub).toMatch(/only when there is one free to fight/i);
    // And it must not invent a pool size the server never returns.
    expect(auto?.sub).not.toMatch(/\d/);
  });

  it('demotes WORLD MAP to a preview and never promises picking or scouting', () => {
    const map = rows.find((r) => r.id === 'map');
    expect(map?.preview).toBe(true);
    expect(map?.title).toMatch(/LOOK ONLY/);
    // The landowner row says "Pick your own target, scout it first". Saying that
    // to a deedless player advertises two 402s.
    expect(map?.sub).not.toMatch(/^Pick your own target/);
    expect(map?.sub).toMatch(/Buying land/i);
  });

  it('marks the preview ONLY for the deedless map row', () => {
    expect(raidChoices(true).some((r) => r.preview)).toBe(false);
    expect(rows.filter((r) => r.preview).map((r) => r.id)).toEqual(['map']);
  });
});

describe('LandGateSheet — the refusal explains itself', () => {
  const sheet = (reason: 'refused' | 'browse'): string =>
    textOf(LandGateSheet({ entryFeeSol: 0.2, reason, onBuy: vi.fn(), onClose: vi.fn() }));

  it('renders the price it is GIVEN — the number is never a second source', () => {
    // If this ever hardcoded 0.2 it would be a third home for a price that must
    // agree with the deployed on-chain Config PDA (plan R13).
    expect(sheet('refused')).toContain('0.2 SOL');
    expect(textOf(LandGateSheet({ entryFeeSol: 1.5, reason: 'refused', onBuy: vi.fn(), onClose: vi.fn() })))
      .toContain('1.5 SOL');
  });

  it('says "that needs land" only when something was actually REFUSED', () => {
    expect(sheet('refused')).toMatch(/needs land you do not own/i);
    expect(sheet('browse')).not.toMatch(/needs land you do not own/i);
  });

  it('always names what land unlocks AND what stays free — a tier, not a trial', () => {
    for (const r of ['refused', 'browse'] as const) {
      expect(sheet(r)).toMatch(/GOLD FORGE/);
      expect(sheet(r)).toMatch(/RAID LANDOWNERS/);
      expect(sheet(r)).toMatch(/Free already/i);
      // Dismissible: there is a base to go back to, which is the point.
      expect(sheet(r)).toMatch(/KEEP BUILDING FOR NOW/);
    }
  });
});

describe('NoLandPrompt — the limited state is visible before anything refuses you', () => {
  it('names the three locked systems rather than just "locked"', () => {
    const t = textOf(NoLandPrompt({ onOpen: vi.fn() }));
    expect(t).toMatch(/NO LAND YET/);
    expect(t).toMatch(/FORGE/);
    expect(t).toMatch(/MARKET/);
    expect(t).toMatch(/RAIDS/);
  });
});
