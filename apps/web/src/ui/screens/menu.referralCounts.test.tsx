/**
 * Profile referral counts (D-103): INVITED / QUALIFIED / ACTIVE TODAY beside
 * the referral code, from the shared /tester/me read — never a new endpoint,
 * never a number the server did not send.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./exportKey', () => ({ PRIVY_ENABLED: false, ExportKeySection: () => null }));
vi.mock('../../auth/useGameWallet', () => ({
  useGameWallet: () => ({ publicKey: null, sendTransaction: null, connection: null }),
}));

import { ReferralCounts } from './menu';

type El = { props?: Record<string, unknown> };

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf((node as El).props?.['children']);
}

describe('Profile referral counts', () => {
  it('renders the three server counts, and nothing at all before the server has sent them', () => {
    // WHY: a referrer's daily points depend on QUALIFIED friends who ACTED
    // today (deed + Keep 3, then a real action). Showing all three next to the
    // code is what turns "share your link" into a loop the player can read.
    // With no counts (older API cut, read still in flight) the chip is absent
    // rather than rendering zeros the server never asserted.
    expect(ReferralCounts({ referrals: null })).toBeNull();
    const row = ReferralCounts({ referrals: { invited: 4, qualified: 2, activeToday: 1 } });
    expect(row).not.toBeNull();
    expect(textOf(row).replace(/\s+/g, ' ')).toBe('INVITED 4 QUALIFIED 2 ACTIVE TODAY 1');
  });

  it('sits beside the referral code chip and reads the shared tester snapshot, not an endpoint of its own', () => {
    const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
    const profile = source.slice(source.indexOf('export function ProfileScreen'), source.indexOf('// CLANS ('));
    const codeChip = profile.indexOf('<ReferralCodeChip code={code} />');
    const counts = profile.indexOf('<ReferralCounts referrals={testerMe?.referrals ?? null} />');
    expect(codeChip).toBeGreaterThan(0);
    expect(counts).toBeGreaterThan(codeChip);
    expect(profile).toContain('useTesterMe()');
    expect(profile).not.toMatch(/api\.get[^\n]*\/tester\/(me|referrals)/);
  });
});
