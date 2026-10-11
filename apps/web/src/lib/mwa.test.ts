import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { mwaAppIdentity } from './mwa';

const source = readFileSync(new URL('./mwa.ts', import.meta.url), 'utf8');

describe('Solana Mobile wallet identity', () => {
  it('registers the wallet-selected chain from the validated shared cluster config', () => {
    expect(source).toContain("import { SOLANA_CHAIN } from './cluster';");
    expect(source).toContain('chains: [SOLANA_CHAIN]');
    expect(source).not.toContain("chains: ['solana:devnet']");
  });

  it('presents a RELATIVE build-bound icon — the MWA spec requires it and Seeker wallets refuse absolute (live report 2026-08-16)', () => {
    const identity = mwaAppIdentity('https://play.pixelkingdomwars.com');
    expect(identity).toEqual({
      name: 'Pixel Kingdom Wars',
      uri: 'https://play.pixelkingdomwars.com',
      // Relative to `uri`, no leading slash, still build-versioned. An
      // absolute href here broke CONNECT WALLET APP on-device with
      // "identity.icon must be a relative uri".
      icon: expect.stringMatching(/^icons\/icon-192\.png\?v=/),
    });
    expect(identity.icon).not.toMatch(/^https?:/);
    expect(identity.icon).not.toMatch(/^\//);
    expect(identity.icon).not.toContain('brand_app_icon');
  });
});
