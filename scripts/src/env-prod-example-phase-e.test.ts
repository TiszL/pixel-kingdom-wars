/**
 * Production hardening (2026-10-10) — the owner builds infra/.env.prod by copying
 * infra/.env.prod.example. A Phase E variable the API reads but the template omits
 * is a variable nobody sets on release day: a whole reviewed pin group (the seven
 * Seeker auction pins, the KEEP identity) was missing until this date. These tests
 * pin that every Phase E setting apps/api/src/config.ts parses appears exactly once
 * in the production template, dark (blank, false or disabled), and that the separate
 * Charter issuer template lists every variable that process reads.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');

// Prefixes of the Phase E groups parsed by the API config schema.
const PHASE_E_PREFIXES = ['PHASE_E_', 'SEEKER_AUCTION_', 'SEEKER_REALM_SALE_', 'MINING_CLAIM_', 'MINING_PUBLICATION_',
  'MINING_TAX_', 'MINING_TRANSPARENCY_', 'CHARTER_RECOVERY_', 'CHARTER_POLICY_ISSUER_', 'CHARTER_WORKFLOW_',
  'VEHICLE_CORE_', 'KEEP_MARKET_'];

function schemaKeys(): string[] {
  const config = read('apps/api/src/config.ts');
  const keys = new Set<string>();
  for (const match of config.matchAll(/^\s+([A-Z][A-Z0-9_]+)\s*:/gm)) {
    if (PHASE_E_PREFIXES.some(prefix => match[1]!.startsWith(prefix))) keys.add(match[1]!);
  }
  return [...keys].sort();
}

function assignments(file: string, key: string): string[] {
  return [...file.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))].map(match => match[1]!);
}

describe('infra/.env.prod.example carries every Phase E setting, dark', () => {
  const example = read('infra/.env.prod.example');
  const keys = schemaKeys();

  it('finds the Phase E groups in config.ts (guards the parser itself)', () => {
    for (const key of ['PHASE_E_KEEP_IDENTITY', 'PHASE_E_SEEKER_AUCTION_ENABLED', 'SEEKER_AUCTION_PROGRAM_ID',
      'SEEKER_AUCTION_CRANK_KEYPAIR_FILE', 'SEEKER_REALM_SALE_ROUND', 'MINING_CLAIM_LOOKUP_TABLE', 'PHASE_E_SERVICE_DATABASE_URL']) {
      expect(keys).toContain(key);
    }
  });

  it.each(schemaKeys())('%s appears exactly once, blank or off', (key) => {
    const values = assignments(example, key);
    expect(values, `${key} must be assigned exactly once in infra/.env.prod.example`).toHaveLength(1);
    expect(['', 'false', 'disabled']).toContain(values[0]);
  });
});

describe('infra/charter-issuer.env.example carries every variable the issuer reads', () => {
  it('lists each CHARTER_ISSUER_* name once', () => {
    const sources = ['apps/api/src/charterPolicyIssuerConfig.ts', 'apps/api/src/charterPolicyIssuerServer.ts'].map(read).join('\n');
    const names = new Set<string>();
    for (const match of sources.matchAll(/required\(env,\s*'([A-Z0-9_]+)'\)/g)) names.add(`CHARTER_ISSUER_${match[1]}`);
    for (const match of sources.matchAll(/required\(env,\s*family\s*\+\s*'([A-Z0-9_]+)'\)/g)) {
      for (const family of ['ECONOMY', 'CRAFT', 'CORE']) names.add(`CHARTER_ISSUER_${family}${match[1]}`);
    }
    for (const match of sources.matchAll(/env\.(CHARTER_ISSUER_[A-Z0-9_]+)/g)) names.add(match[1]!);
    expect(names).toContain('CHARTER_ISSUER_SEEKER_AUCTION_MINT');
    expect(names).toContain('CHARTER_ISSUER_ECONOMY_PROGRAM_ID');
    const example = read('infra/charter-issuer.env.example');
    for (const name of names) expect(assignments(example, name), name).toHaveLength(1);
  });
});
