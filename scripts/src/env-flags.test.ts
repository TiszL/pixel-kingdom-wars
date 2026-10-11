import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Owner incident 2026-09-18: players could not place walls from the Android app. The API gates the
// wall-stroke command on WALL_BATCH_V1_ENABLED; every sibling flag had been added to production for
// 0.5.0, this one had not, because infra/.env.prod.example never listed it. A flag the API reads but
// the production example does not name is a feature that silently stays off after a release.
const root = path.resolve(__dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sources(file);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [file] : [];
  });
}

describe('production env example', () => {
  it('names every *_ENABLED flag the API reads from process.env', () => {
    const read = new Set<string>();
    for (const file of sources(path.join(root, 'apps/api/src'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/process\.env\['([A-Z0-9_]+_ENABLED)'\]/g)) read.add(match[1]!);
    }
    expect(read.size).toBeGreaterThan(5);
    const example = readFileSync(path.join(root, 'infra/.env.prod.example'), 'utf8');
    const listed = new Set([...example.matchAll(/^#?\s?([A-Z0-9_]+_ENABLED)=/gm)].map((match) => match[1]!));
    expect([...read].filter((flag) => !listed.has(flag)).sort()).toEqual([]);
  });
});

// CLAUDE.md hard rule: update .env.example when adding config. VITE_REALM_KIT_PREVIEW_MANIFEST
// (the REALM-KIT-PLAN §6.3 local-verification switch) shipped without an entry, so a developer
// following the documented env surface could not discover why a local kit still reported
// "Realm kit artwork is not published". A key the web bundle reads must at least be named there —
// as an assignment, or in a comment for a key that must never be set by hand.
describe('development env example', () => {
  it('names every VITE_* key the web app reads from import.meta.env', () => {
    const read = new Set<string>();
    for (const file of sources(path.join(root, 'apps/web/src'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/import\.meta\.env(?:\.|\[')(VITE_[A-Z0-9_]+)/g)) read.add(match[1]!);
    }
    expect(read.size).toBeGreaterThan(5);
    const example = readFileSync(path.join(root, '.env.example'), 'utf8');
    const named = new Set([...example.matchAll(/\b(VITE_[A-Z0-9_]+)\b/g)].map((match) => match[1]!));
    expect([...read].filter((key) => !named.has(key)).sort()).toEqual([]);
  });
});
