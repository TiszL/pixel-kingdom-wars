/**
 * Pinned caller enumeration for the Gems currency (D-152; E2-GEMS-CONTRACT §3,
 * §7). WHY: the sink shim `spendGameCurrency` is the ONLY place a system sink
 * may charge a player, and `gems_mint` is the ONLY Gems source. A new caller
 * that posts `player_keep → emission_pool` by hand, resurrects `spendKeep`, or
 * debits `gems_mint` from an unnamed module silently re-opens either the
 * custodial-KEEP spend path (which the custody retirement must be able to fence)
 * or an unbacked Gems mint (invariant G-3). This test reads the SOURCE, not the
 * ledger, so it fails at the commit that introduces the bypass — before any
 * money moves. Static scan; no database.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const files = walk(SRC).map((full) => ({ path: relative(SRC, full).split('\\').join('/'), text: readFileSync(full, 'utf8') }));
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

describe('Gems caller enumeration (E2-GEMS-CONTRACT §3, §7)', () => {
  it('has ZERO spendKeep / rewardKeep callers left in the API', () => {
    // The legacy KEEP leg survives only as the non-exported `legacySpendKeep`
    // inside spend.ts, reachable through the shim alone.
    const offenders = files
      .filter((f) => /\bspendKeep\(|\brewardKeep\(/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
    const spend = files.find((f) => f.path === 'game/spend.ts')!;
    expect(spend.text).not.toMatch(/export async function spendKeep\b/);
    expect(spend.text).not.toMatch(/export async function rewardKeep\b/);
    expect(spend.text).toMatch(/^async function legacySpendKeep\(/m);
  });

  it('routes exactly the twelve system sinks through spendGameCurrency', () => {
    // One entry per contract §3 site. A thirteenth caller, or a site that
    // dropped back to a raw posting, changes this map and must be reviewed.
    const sites = Object.fromEntries(files
      .filter((f) => f.path !== 'game/spend.ts')
      .map((f) => [f.path, count(f.text, /\bspendGameCurrency\(/g)] as const)
      .filter(([, n]) => n > 0));
    expect(sites).toEqual({
      'game/base.ts': 3,      // hero.recruit, build.mine, build.speedup
      'game/army.ts': 4,      // research.speedup ×2, train.speedup ×2
      'game/heroes.ts': 2,    // hero.recovery.speedup, hero.upgrade
      'game/items.ts': 1,     // item.buy
      'game/raids.ts': 1,     // raid.buffs (settlement)
      'game/liveRaids.ts': 1, // raid.buffs (live command)
    });
    expect(Object.values(sites).reduce((a, b) => a + b, 0)).toBe(12);
  });

  it('debits gems_mint only from the named Gems modules (G-3 backing lives there)', () => {
    // Track both bootstrap account IDs and explicit posting-leg selectors.
    // The fixture journal resolves its mint ID by kind, so a dot-only scan
    // would silently miss that source. Ledger G-3 still checks actual postings.
    const allowed = new Set([
      'game/gems.ts',              // KEEP → Gems (ledger source)
      'game/gemsGrants.ts',        // grants against the reward budget
      'money/deposits.ts',         // wallet KEEP → Gems (gems_buy credit)
      'db/keepCustodyRetire.ts',   // the E3 retirement tool
      'db/keepCustodyJournal.ts',  // fixture L1 execution, exact journaled receipts
    ]);
    const minters = files
      .filter((f) => /\.gems_mint\b|\bkind\s*:\s*['"]gems_mint['"]/.test(f.text) && f.path !== 'ledger/accounts.ts')
      .map((f) => f.path);
    expect(minters.filter((p) => !allowed.has(p))).toEqual([]);
    expect(minters).toContain('game/gems.ts');
    expect(minters).toContain('game/gemsGrants.ts');
    expect(minters).toContain('db/keepCustodyJournal.ts');
  });

  it('marks the legacy KEEP sink shape (`recycled: true`) only where it is allowed', () => {
    // `recycled: true` is the metadata marker of the legacy player_keep →
    // emission_pool sink posting; receipts key on it. Only the shim's KEEP leg
    // (spend.ts) and the retired SOL-paid mine credit (base.ts, dormant: the
    // MINE_BUILD_SOL deposit path, K-147) may write it. A new writer means a
    // sink that bypassed the shim.
    const writers = files
      .filter((f) => /recycled: true\b/.test(f.text.replace(/^\s*(\/\/|\*).*$/gm, '')))
      .map((f) => f.path).sort();
    expect(writers).toEqual(['game/base.ts', 'game/spend.ts']);
  });
});
