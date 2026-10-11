/**
 * THE THREE MONEY-SURFACE GATES THIS FILE EXISTS TO KEEP HONEST
 * (adversarial security review 2026-08-09, findings F1 · F10 · F8).
 *
 *  F1 — the quest board advertised KEEP and paid SHARDS. KEEP is the ONLY
 *       withdrawable currency (money/withdrawals.ts touches player_keep and
 *       nothing else), so the board was promising a withdrawal for a reward that
 *       can never leave the game. Pinned by reading the ICON, because the icon is
 *       what a player actually reads.
 *  F10 — a deedless tap on a land-gated screen produced TWO refusals: the global
 *       buy-land sheet (api.ts setLandGatedHandler) plus the screen's own
 *       `toast + sfx_error` underneath it. Pinned on the suppression, which must
 *       fire ONLY for the coded 402 and never swallow a real failure.
 *  F8 — nothing about reaching your own private key may read as purchase-gated.
 *
 * No jsdom in this package (see admin.test.tsx / RaidChooser.test.tsx): hook-free
 * components are CALLED and their returned element trees read.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { bus } from '../lib/events';
import { failToast, isHandledGlobally } from './actionError';
import { LandLocked } from './LandGate';
import { Icon } from './primitives';

/**
 * menu.tsx reaches Privy's Solana bundle two ways — the key-export section and
 * `useGameWallet` (via the four payment hooks) — and that bundle imports
 * `@solana-program/memo`, which only resolves through the shim alias in
 * vite.config's `resolve.alias`. Vitest externalises node_modules instead of
 * transforming them, so the alias never applies and the import throws.
 *
 * Nothing under test signs anything, so the two boundaries are stubbed rather than
 * a wallet SDK dragged into a copy assertion. `vi.mock` is hoisted above the
 * import below, which is why that import is not at the top of the file.
 */
vi.mock('./screens/exportKey', () => ({
  PRIVY_ENABLED: false,
  ExportKeySection: () => null,
}));
vi.mock('../auth/useGameWallet', () => ({
  useGameWallet: () => ({ publicKey: null, sendTransaction: null, connection: null }),
}));

// Imported AFTER the mocks above: `vi.mock` is hoisted, so this is the order the
// module graph actually loads in.
// The quest board moved out of menu.tsx into its own screen (2026-08-28,
// quest-onboarding lane). Same hook-free QuestRow, same contract — these
// assertions are about the CURRENCY a money surface advertises and they follow
// the component, not the file.
import { QuestRow } from './screens/quests';

// --- element-tree readers ---------------------------------------------------

type El = { type?: unknown; props?: Record<string, unknown> };

function walk(node: unknown, visit: (el: El) => void): void {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, visit)); return; }
  const el = node as El;
  visit(el);
  if (el.props) for (const v of Object.values(el.props)) walk(v, visit);
}

/** Every `<Icon name=…>` in the tree, in encounter order. */
function iconNames(node: unknown): string[] {
  const out: string[] = [];
  walk(node, (el) => { if (el.type === Icon && typeof el.props?.['name'] === 'string') out.push(el.props['name'] as string); });
  return out;
}

/** All text in the tree, whitespace collapsed. */
function textOf(node: unknown): string {
  let s = '';
  const push = (v: unknown): void => {
    if (typeof v === 'string' || typeof v === 'number') s += ` ${v}`;
    else walk(v, () => { /* handled by walk below */ });
  };
  const rec = (node: unknown): void => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') { push(node); return; }
    if (Array.isArray(node)) { node.forEach(rec); return; }
    const el = node as El;
    if (!el.props) return;
    rec(el.props['title']); rec(el.props['why']); rec(el.props['children']);
  };
  rec(node);
  return s.replace(/\s+/g, ' ').trim();
}

// --- F1: the quest board ----------------------------------------------------

const QUEST = {
  id: 'q1', scope: 'daily', templateCode: 'upgrade_any', target: 1,
  progress: 0, completed: false, claimed: false,
};

describe('F1 — the quest board shows the currency quests actually pay', () => {
  it('renders the SHARD icon, never the KEEP icon', () => {
    // apps/api game/quests.ts claimQuest → rewardShards() → shard_genesis. A KEEP
    // icon here advertises the withdrawable currency for a reward that is not.
    const row = QuestRow({ q: { ...QUEST, rewardShards: 20, rewardKeep: 20 }, busy: false, onClaim: vi.fn() });
    expect(iconNames(row)).toContain('shard');
    expect(iconNames(row)).not.toContain('keep');
  });

  it('reads the honest field, and falls back to the legacy wire name', () => {
    // The server sends both names for the SAME value ("so the client can migrate
    // without a flag day"), so the number must be right against either shape.
    expect(textOf(QuestRow({ q: { ...QUEST, rewardShards: 20, rewardKeep: 20 }, busy: false, onClaim: vi.fn() })))
      .toMatch(/\b20\b/);
    // An older server that predates rewardShards: same number, still rendered.
    expect(textOf(QuestRow({ q: { ...QUEST, rewardKeep: 15 }, busy: false, onClaim: vi.fn() })))
      .toMatch(/\b15\b/);
    // A newer server that has dropped the deprecated alias.
    expect(textOf(QuestRow({ q: { ...QUEST, rewardShards: 35 }, busy: false, onClaim: vi.fn() })))
      .toMatch(/\b35\b/);
  });

  it('shows the reward on the WEEKLY row in every state', () => {
    // The weekly chip always carries its reward inline (App L1160), so the icon
    // fix has to hold on the branch that renders it twice.
    const row = QuestRow({ q: { ...QUEST, scope: 'weekly', rewardShards: 100 }, weekly: true, busy: false, onClaim: vi.fn() });
    expect(iconNames(row)).not.toContain('keep');
    expect(textOf(row)).toMatch(/100/);
  });

  it('counted dailies (target > 1) show X/target progress; single-shot ones stay bare (M23 a15)', () => {
    // The expanded pool is mostly counted quests (train 5, steal 1,500, deploy
    // 20 …). A bare label hides how close the player is, so target > 1 renders
    // the weekly-style `label · progress/target` suffix.
    const counted = QuestRow({
      q: { ...QUEST, templateCode: 'train_5_troops', target: 5, progress: 2, rewardShards: 15 },
      busy: false, onClaim: vi.fn(),
    });
    expect(textOf(counted)).toContain('2/5');
    const single = QuestRow({ q: { ...QUEST, rewardShards: 15 }, busy: false, onClaim: vi.fn() });
    expect(textOf(single)).not.toContain('0/1');
  });
});

// --- F10: one refusal per tap ----------------------------------------------

describe('F10 — the land gate refuses ONCE', () => {
  const landErr = new ApiError(402, 'buy your land to unlock this', 'LAND_NOT_OWNED');

  it('suppresses the toast for LAND_NOT_OWNED — the sheet is already up', () => {
    const seen: string[] = [];
    const off = bus.on('ui:toast', ({ msg }) => { seen.push(msg); });
    failToast(landErr, 'BUY YOUR LAND TO UNLOCK THIS');
    off();
    expect(seen).toEqual([]);
  });

  it('still surfaces every OTHER failure — it must not swallow real errors', () => {
    const seen: string[] = [];
    const off = bus.on('ui:toast', ({ msg }) => { seen.push(msg); });
    failToast(new ApiError(422, 'not enough shards'), 'NOT ENOUGH SHARDS');
    failToast(new Error('network down'), 'NETWORK DOWN');
    // A CODELESS 402 is the pre-free-onboarding paywall and the non-`entry`
    // deposit refusal. Neither raises the sheet, so neither may be suppressed.
    failToast(new ApiError(402, 'entry not paid'), 'ENTRY NOT PAID');
    off();
    expect(seen).toEqual(['NOT ENOUGH SHARDS', 'NETWORK DOWN', 'ENTRY NOT PAID']);
  });

  it('scopes the suppression to exactly the coded 402', () => {
    expect(isHandledGlobally(landErr)).toBe(true);
    expect(isHandledGlobally(new ApiError(402, 'entry payment required'))).toBe(false);
    expect(isHandledGlobally(new ApiError(403, 'x', 'ALPHA_GATED'))).toBe(false);
    expect(isHandledGlobally(new Error('boom'))).toBe(false);
  });
});

describe('F10 — a locked screen states its own purpose', () => {
  const panel = (o?: { children?: React.ReactNode }): string => textOf(LandLocked({
    title: 'CLANS NEED LAND', why: 'A clan chest pays out to every member.',
    entryFeeSol: 0.2, onBuy: vi.fn(), ...o,
  }));

  it('names the screen, the reason, the price it is GIVEN, and what stays free', () => {
    const t = panel();
    expect(t).toMatch(/CLANS NEED LAND/);
    expect(t).toMatch(/clan chest pays out/);
    expect(t).toMatch(/0\.2 SOL/);
    // The free tier is named on every locked door: a refusal that does not say
    // what is still playable reads as the end of the session.
    expect(t).toMatch(/Free already/i);
  });

  it('renders the price it is given and never a second copy of it', () => {
    // ECONOMY.entryFeeSol must agree with the deployed on-chain Config PDA, so a
    // hardcoded 0.2 in here would be a third home for that number (plan R13).
    expect(textOf(LandLocked({
      title: 'X', why: 'y', entryFeeSol: 1.5, onBuy: vi.fn(),
    }))).toContain('1.5 SOL');
  });

  it('keeps the doors it is handed OPEN — this is how key export stays reachable', () => {
    // WithdrawScreen's locked state passes the SECURITY & KEY EXPORT row through
    // as children; SecurityScreen is reachable from nowhere else in the app.
    expect(panel({ children: 'SECURITY & KEY EXPORT' })).toMatch(/SECURITY & KEY EXPORT/);
  });
});

// --- F8: custody -----------------------------------------------------------

/**
 * A SOURCE GUARD, on the App.test.ts / platform.test.ts instrument: the rule is
 * about which ROUTES this module is allowed to touch, and there is no React
 * harness in this package to drive the component with (ui/screens/admin.test.tsx).
 */
describe('F8 — nothing land-gated may stand between a player and their own key', () => {
  const src = readFileSync(new URL('./screens/exportKey.tsx', import.meta.url), 'utf8');
  /** the code, minus comments — the comments name the forbidden routes by design */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('runs entirely on the auth-only /auth/export/* routes', () => {
    for (const r of ['/auth/export/status', '/auth/export/send-code', '/auth/export/challenge']) {
      expect(code, r).toContain(r);
    }
  });

  it('touches NO land-gated route — /2fa/* and /withdrawals/* are `owned`', () => {
    // Reading /2fa/status here is the original bug: it 402s for a landless wallet
    // and the global handler answers a key export with "buy your land".
    expect(code).not.toMatch(/['"`]\/2fa\//);
    expect(code).not.toMatch(/['"`]\/withdrawals/);
  });

  it('never consults land ownership, and cannot render a buy-land prompt', () => {
    expect(code).not.toMatch(/entryPaid|landOwned|LAND_|setLandPrompt|LandGate|LandLocked/);
  });

  it('does not let a failed status read block the export', () => {
    // The arm button must not be disabled on a missing status: that is what left a
    // landless player staring at "CHECKING 2FA STATUS…" forever.
    expect(code).not.toMatch(/disabled=\{!status\}/);
    expect(code).not.toMatch(/CHECKING 2FA STATUS/);
  });
});
