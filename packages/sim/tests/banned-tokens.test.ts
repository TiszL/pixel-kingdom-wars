/**
 * Determinism guard (CLAUDE.md hard rule): no wall-clock, no built-in RNG,
 * no transcendental Math.* anywhere in packages/sim/src.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
// sqrt/fround stay whitelisted (ARCHITECTURE.md §sim: IEEE-exact, deterministic).
// The `?`-suffixed forms catch the hyperbolics (sinh/asinh/…) that a bare `sin`
// alternation silently skips — \b never matches between "sin" and "h", so
// Math.sinh slipped the old guard entirely. crypto.* is RNG in disguise.
const BANNED = /\b(?:Math\s*\.\s*(?:random|sinh?|cosh?|tanh?|atan2?|atanh|asinh?|acosh?|pow|exp(?:m1)?|log\w*|hypot|cbrt)|Date\s*\.\s*now|performance\s*\.\s*now|new\s+Date|crypto\s*\.\s*(?:randomUUID|getRandomValues))\b/;

// This test is the ONLY mechanical enforcement of the determinism hard rule
// (no CI, no git hooks — CLAUDE.md). It must therefore see every source file:
// recursive, so a future src/**/ subdirectory cannot silently drop out of scope.
const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
// Shared modules the simulator executes at runtime (battlefield geometry). They
// live outside packages/sim/src, so list them explicitly: a banned token there
// would break replay determinism exactly as one inside src would.
const SHARED_SRC = join(__dirname, '..', '..', 'shared', 'src');
const SHARED_RUNTIME = ['battlefield.ts', 'plotGeometry.ts'];

/**
 * ROLE-LEAK GUARD (owner 2026-07-29, after Theodor-the-wall-chewer).
 *
 * Heroes ride a DONOR troop, so any behaviour branch keyed on the troop's TYPE
 * silently hands a hero its donor's role. Three such branches survived the
 * first fix (keg wall-selection, keg detonation, plunderer resource multiplier)
 * and adversarial verification proved the behavioural tests could NOT lock the
 * selection branch — with detonation fixed, a wrongly-assigned keg wall simply
 * never explodes, so the leak has no observable signature to assert.
 *
 * This is therefore a SOURCE invariant, in the same spirit as the determinism
 * scan above and enforced the same way: a unit's role must come from the
 * behaviour lookup, never from `tr.type ===`. Building types are exempt — a
 * building's identity IS its type; there is no donor indirection for buildings.
 */
const TROOP_TYPE_BRANCH = /\btr\s*\.\s*type\s*===/;

describe('unit role never comes from the troop type string', () => {
  for (const f of files) {
    it(`${f} branches on ROLE data, not on tr.type`, () => {
      const text = readFileSync(join(SRC, f), 'utf8');
      const m = TROOP_TYPE_BRANCH.exec(text);
      expect(
        m,
        m ? `found "${m[0]}" in ${f} — read the trait off behaviorOf(tr) instead, or a hero with this donor inherits the role` : undefined,
      ).toBeNull();
    });
  }
});

describe('hero skills target by relative side', () => {
  it('contains no attacker-only foe filter in the hero skill pass', () => {
    const text = readFileSync(join(SRC, 'sim.ts'), 'utf8');
    const pass = text.slice(text.indexOf('// 4b) hero skills'), text.indexOf('// 4c) lingering DoTs'));
    expect(pass.length).toBeGreaterThan(1_000);
    expect(pass).not.toContain("side !== 'defender'");
  });
});

describe('banned tokens', () => {
  it('scans a sane number of files (guard against a broken glob scanning nothing)', () => {
    expect(files.length).toBeGreaterThanOrEqual(7); // src currently holds 7 files
  });
  for (const f of files) {
    it(`${f} contains no nondeterministic built-ins`, () => {
      const text = readFileSync(join(SRC, f), 'utf8');
      const m = BANNED.exec(text);
      expect(m, m ? `found "${m[0]}" in ${f}` : undefined).toBeNull();
    });
  }
  for (const f of SHARED_RUNTIME) {
    it(`shared/${f} (executed by the simulator) contains no nondeterministic built-ins`, () => {
      const text = readFileSync(join(SHARED_SRC, f), 'utf8');
      const m = BANNED.exec(text);
      expect(m, m ? `found "${m[0]}" in shared/${f}` : undefined).toBeNull();
    });
  }
});
