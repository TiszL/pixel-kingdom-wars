/** Pure history checks; isolated PostgreSQL cases live only in the dedicated .fixture.ts. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../drizzle/', import.meta.url));
const ORIGINAL_TAG = '0146_starter_common_access';
const ORIGINAL_SHA = 'b1aec76ffa99064fba9c360674f5dd2be600b540292ad8a7ce7174fb629d6fcb';
const EDITED_SHA = '19060892465b69208b5da649fec9a6e1379743651aa0c5617e7c9571cd3e2629';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it('restores applied 0146 byte for byte to the independent original fixture', () => {
  const original = readFileSync(new URL('./fixtures/migration-0146-original.sql', import.meta.url));
  expect(digest(original)).toBe(ORIGINAL_SHA);
  expect(readFileSync(join(MIGRATIONS, `${ORIGINAL_TAG}.sql`))).toEqual(original);
});

it('retains the original journal identity and paid successor without relocating the rejected guard', () => {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  expect(journal.entries.filter(entry => entry.tag === ORIGINAL_TAG)).toEqual([
    { idx: 148, version: '7', when: 1790007000000, tag: ORIGINAL_TAG, breakpoints: true },
  ]);
  const paid = journal.entries.filter(entry => entry.tag === '0185_starter_paid_access');
  expect(paid).toHaveLength(1);
  expect(paid[0]!.idx).toBeGreaterThan(148);
  expect(journal.entries.map(entry => entry.idx)).toEqual(journal.entries.map((_, index) => index));
  for (let index = 1; index < journal.entries.length; index++) {
    expect(journal.entries[index]!.when).toBeGreaterThan(journal.entries[index - 1]!.when);
  }
  // review 1ac7628a rejects the relocated no-op/downgrade migration. No ordinal is needed.
  expect(journal.entries.filter(entry => digest(readFileSync(join(MIGRATIONS, `${entry.tag}.sql`))) === EDITED_SHA))
    .toEqual([]);
});
