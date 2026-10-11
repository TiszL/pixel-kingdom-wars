/**
 * M47 §5 release-notes fragments: schema, public wording and the deploy-time collector.
 *
 * WHY: these strings go straight onto pixelkingdomwars.com/changelog on every
 * ordinary deploy, with no human in between. The lint is the only editor. It must
 * refuse the internal vocabulary the owner banned from public copy ("Phase E",
 * ids, SIM, dark/held, "earn", "buy Gems", travelling raids) and anything that is
 * not plain text, and the collector must publish exactly what the deployed commit
 * contains — never the working tree, never a fragment whose feature flag is off,
 * and never pass fragment text through a shell.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RELEASE_FEED } from '@shardkeep/shared';
import {
  collect, enabledFlags, main as collectMain,
} from './release-notes-collect';
import {
  countSentences, historyGroups, lintFragments, main as lintMain, parseFragment, readWorkingTree, toEntry,
  wordingIssues, type SourceFile,
} from './release-notes';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = new Date('2026-09-27T12:00:00Z');

function file(relative: string, fields: Record<string, string>, body = 'Walls now show five tiers as they level up.'): SourceFile {
  const front = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n');
  return { path: `release-notes/${relative}`, text: `---\n${front}\n---\n${body}\n` };
}
const base = { title: 'Five-tier walls', category: 'world', platforms: 'all', requires: 'none' };
const messages = (candidate: SourceFile) => parseFragment(candidate, NOW).issues.map((issue) => issue.message).join('\n');

describe('the repository fragments', () => {
  it('all pass the lint CI runs', () => {
    const tree = readWorkingTree(ROOT);
    const linted = lintFragments(tree.files);
    expect([...tree.issues, ...linted.issues]).toEqual([]);
    expect(linted.fragments.length).toBe(tree.files.length);
    // The backfill and the two notes this lane ships are part of the contract.
    expect(linted.fragments.filter((fragment) => fragment.kind === 'history').length).toBeGreaterThanOrEqual(60);
    expect(linted.fragments.map((fragment) => fragment.id)).toEqual(expect.arrayContaining(['android-26', '2026-09-27-new-website']));
  });

  it('every entry is accepted by the API wire schema the recorder applies', async () => {
    // WHY: the lint and the API validate independently; a fragment CI accepts but the
    // recorder refuses would silently drop from the changelog at deploy time.
    const contracts = await import(new URL('../../apps/api/src/releases/contracts.ts', import.meta.url).href) as {
      ReleaseEntrySchema: { parse: (value: unknown) => unknown };
    };
    for (const fragment of lintFragments(readWorkingTree(ROOT).files).fragments) {
      expect(() => contracts.ReleaseEntrySchema.parse(toEntry(fragment)), fragment.path).not.toThrow();
    }
  });
});

describe('public wording', () => {
  it.each([
    ['Phase E', 'Phase E brings new buildings.'],
    ['phase-e', 'Coming with phase-e soon.'],
    ['a track id', 'E2 currency lands today.'],
    ['on-chain gameplay spelling', 'On-chain gameplay is coming.'],
    ['dark', 'Gems are dark on production.'],
    ['held', 'The update is held for now.'],
    ['SIM', 'The battle engine moved to SIM 17.'],
    ['sim-tested', 'Fortresses were sim-tested.'],
    ['a decision id', 'As decided in D-152, walls change.'],
    ['an issue id', 'Fixes K-45 for good.'],
    ['a milestone id', 'M47 ships the website.'],
    ['a PR number', 'Merged in PR #149.'],
    ['a ticket number', 'Fixes #12.'],
    ['custody retirement', 'Custody retirement begins.'],
    ['a cutover letter', 'Cutover W starts after gate A.'],
    ['D0', 'The D0 switch is next.'],
    ['play-to-earn', 'A play-to-earn loop.'],
    ['earn', 'You earn more KEEP now.'],
    ['earnings', 'Your earnings grow.'],
    ['buy Gems', 'You can buy Gems in the shop.'],
    ['purchase gems', 'Purchase more gems today.'],
    ['a profit promise', 'Guaranteed profit every day.'],
    ['investment', 'A great investment.'],
    ['travelling raids', 'Your troops travel to the target.'],
    ['arriving attacks', 'The attack arrives in an hour.'],
    ['internal tooling', 'Built in a worktree.'],
    ['a link', 'Read more at https://example.com today.'],
  ])('refuses %s', (_label, text) => {
    expect(wordingIssues(text, 'body').length).toBeGreaterThan(0);
  });

  it('refuses "sideload" in a title but not in a body', () => {
    expect(wordingIssues('How to sideload the app', 'title').length).toBeGreaterThan(0);
    expect(wordingIssues('You can sideload the Android APK.', 'body')).toEqual([]);
  });

  it.each([
    'Walls now show five tiers as they level up.',
    'Onchain gameplay is in development on devnet; dates will be announced.',
    'Convert KEEP to Gems at 1:1 when the switch comes.',
    'Raids are instant: pick a target and fight.',
    'Learn the new Gold Forge and try the Campaign.',
    'Heroes investigate nothing; they fight.',
    'Stage 1 of the Campaign got easier.',
  ])('accepts plain player-facing copy: %s', (text) => {
    expect(wordingIssues(text, 'body')).toEqual([]);
  });

  it.each([
    ['HTML', 'A <b>bold</b> change.'],
    ['Markdown emphasis', 'A **bold** change.'],
    ['inline code', 'Run `this` now.'],
    ['a Markdown link', 'See [the docs](/docs).'],
    ['a heading', '# Heading\nText.'],
    ['a list', '- one thing.'],
  ])('refuses %s: the page renders text, never markup', (_label, text) => {
    expect(wordingIssues(text, 'body').length).toBeGreaterThan(0);
  });
});

describe('fragment schema', () => {
  it('accepts a minimal unreleased fragment and folds the body onto one line', () => {
    const result = parseFragment(file('unreleased/2026-09-27-walls.md', base, 'Walls now show five\ntiers as they level up.'), NOW);
    expect(result.issues).toEqual([]);
    expect(result.fragment).toMatchObject({ id: '2026-09-27-walls', kind: 'unreleased', body: 'Walls now show five tiers as they level up.' });
  });

  it.each([
    ['a missing title', file('unreleased/2026-09-27-a.md', { ...base, title: '' }), '"title" is required'],
    ['a long title', file('unreleased/2026-09-27-a.md', { ...base, title: 'x'.repeat(RELEASE_FEED.titleMaxChars + 1) }), 'the limit is 80'],
    ['a long body', file('unreleased/2026-09-27-a.md', base, `${'Word '.repeat(130)}end.`), 'the limit is 600'],
    ['four sentences', file('unreleased/2026-09-27-a.md', base, 'One. Two. Three. Four.'), 'write 1–3'],
    ['no closing punctuation', file('unreleased/2026-09-27-a.md', base, 'No full stop'), 'ends with'],
    ['two paragraphs', file('unreleased/2026-09-27-a.md', base, 'One.\n\nTwo.'), 'one paragraph'],
    ['an unknown key', file('unreleased/2026-09-27-a.md', { ...base, author: 'me' }), 'unknown front-matter key "author"'],
    ['a bad category', file('unreleased/2026-09-27-a.md', { ...base, category: 'secret' }), 'category must be one of'],
    ['a bad platform', file('unreleased/2026-09-27-a.md', { ...base, platforms: 'ios' }), 'platforms must be one of'],
    ['a lower-case flag', file('unreleased/2026-09-27-a.md', { ...base, requires: 'gems' }), 'requires must be'],
    ['a sha on an unreleased note', file('unreleased/2026-09-27-a.md', { ...base, sha: 'a'.repeat(40) }), 'never carry a sha'],
    ['a date that disagrees with the name', file('unreleased/2026-09-27-a.md', { ...base, date: '2026-09-26' }), 'does not match'],
    ['a future date', file('unreleased/2026-12-01-a.md', { ...base, date: '2026-12-01' }), 'in the future'],
    ['a bad file name', file('unreleased/Walls.md', base), 'YYYY-MM-DD-<lower-case-slug>'],
    ['an impossible date', file('unreleased/2026-02-30-a.md', base), 'not a calendar date'],
    ['history without a sha', file('history/2026-09-01-a.md', { ...base, date: '2026-09-01' }), 'need the deployed "sha"'],
    ['history without a date', file('history/2026-09-01-a.md', { ...base, sha: 'a'.repeat(40) }), 'need the deploy "date"'],
    ['gated history', file('history/2026-09-01-a.md', { ...base, requires: 'GEMS_ENABLED', date: '2026-09-01', sha: 'a'.repeat(40) }), 'requires must be "none"'],
    ['a short sha', file('history/2026-09-01-a.md', { ...base, date: '2026-09-01', sha: 'abc1234' }), 'full 40-character'],
    ['an Android note in another category', file('android/27.md', { ...base, platforms: 'android' }), 'category: android'],
    ['an Android file with a leading zero', file('android/027.md', { ...base, category: 'android', platforms: 'android' }), '<versionCode>.md'],
    ['a stray folder', file('drafts/2026-09-27-a.md', base), 'fragments live in'],
  ])('refuses %s', (_label, candidate, expected) => {
    expect(messages(candidate)).toContain(expected);
  });

  it('counts sentences by terminal punctuation, not by version dots', () => {
    expect(countSentences('Version 0.6.0 is out. It needs Android 9!')).toBe(2);
    expect(countSentences('One (really).')).toBe(1);
  });

  it('refuses one id used twice and one sha dated twice', () => {
    const history = { ...base, date: '2026-09-01', sha: 'a'.repeat(40) };
    const result = lintFragments([
      file('unreleased/2026-09-01-walls.md', base), file('history/2026-09-01-walls.md', history),
      file('history/2026-09-01-other.md', { ...history, date: '2026-09-01T10:00:00Z' }),
    ], NOW);
    expect(result.fragments).toEqual([]);
    expect(result.issues.map((issue) => issue.message).join('\n')).toMatch(/is used by 2 fragments[\s\S]*different dates/);
  });
});

describe('deploy-time collector', () => {
  let repo: string; let oldSha: string; let sha: string;
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const write = (relative: string, text: string) => {
    mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    writeFileSync(path.join(repo, relative), text);
  };
  // Shell metacharacters must reach the API byte for byte and never execute.
  const HOSTILE = 'Walls now $(touch pwned) show `five` tiers; "quoted" & $HOME stays text.';

  beforeAll(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'pkw-release-notes-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
    write('package.json', JSON.stringify({ version: '0.3.3' }));
    write('packages/sim/src/version.ts', 'export const SIM_VERSION = 14;\n');
    git('add', '.'); git('commit', '-q', '-m', 'old release');
    oldSha = git('rev-parse', 'HEAD');
    write('package.json', JSON.stringify({ version: '0.5.8' }));
    write('packages/sim/src/version.ts', 'export const SIM_VERSION = 17;\n');
    const note = (fields: Record<string, string>, body: string) => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`;
    write('release-notes/README.md', '# not a fragment\n');
    write('release-notes/unreleased/2026-09-27-walls.md', note(base, HOSTILE.replace(' `five` ', ' five ')));
    write('release-notes/unreleased/2026-09-27-hostile.md', note({ ...base, title: 'Shell $(id) text' }, 'Shell text $(touch pwned2) stays text; it is only data.'));
    write('release-notes/unreleased/2026-09-27-gems.md', note({ ...base, title: 'Gems', category: 'new', requires: 'GEMS_ENABLED' }, 'Convert KEEP to Gems in the Workshop.'));
    write('release-notes/unreleased/2026-09-27-bad.md', note({ ...base, title: 'Phase E arrives' }, 'Phase E is dark.'));
    write('release-notes/android/26.md', note({ ...base, title: 'Android app 0.6.0', category: 'android', platforms: 'android' }, 'Version 0.6.0 is here.'));
    write('release-notes/history/2026-09-03-old.md', note({ ...base, title: 'Old release', date: '2026-09-03', sha: oldSha }, 'Something shipped long ago.'));
    write('release-notes/history/2026-09-02-ghost.md', note({ ...base, title: 'Ghost release', date: '2026-09-02', sha: 'f'.repeat(40) }, 'This commit does not exist.'));
    git('add', '.'); git('commit', '-q', '-m', 'notes');
    sha = git('rev-parse', 'HEAD');
    // Uncommitted edits after the deployed commit must be invisible.
    write('release-notes/unreleased/2026-09-27-uncommitted.md', note(base, 'Never shipped.'));
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('publishes exactly the committed, valid, enabled fragments at the sha', () => {
    const warnings: string[] = [];
    const manifest = collect({ root: repo, sha, envText: 'GEMS_ENABLED=false\n', warn: (line) => warnings.push(line) });
    expect(manifest.gitSha).toBe(sha);
    // Reading order: new/world/improved/balance/fixed first, android last.
    expect(manifest.fragments.map((entry) => entry.id)).toEqual(['2026-09-27-hostile', '2026-09-27-walls', 'android-26']);
    expect(manifest.skipped).toEqual([{ id: '2026-09-27-gems', requires: 'GEMS_ENABLED' }]);
    expect(manifest.history).toEqual([{ gitSha: oldSha, version: '0.3.3', simVersion: 14, deployedAt: '2026-09-03T12:00:00.000Z',
      entries: [{ id: '2026-09-03-old', category: 'world', platforms: 'all', title: 'Old release', body: 'Something shipped long ago.' }] }]);
    expect(warnings.join('\n')).toContain('SKIPPED release-notes/unreleased/2026-09-27-bad.md');
    expect(warnings.join('\n')).toContain('SKIPPED release-notes/history/2026-09-02-ghost.md');
    expect(JSON.stringify(manifest)).not.toContain('uncommitted');
  });

  it('claims a flag-gated fragment only when the production flag is exactly true', () => {
    const on = collect({ root: repo, sha, envText: 'OTHER=1\nGEMS_ENABLED="true"\n', warn: () => undefined });
    expect(on.fragments.map((entry) => entry.id)).toContain('2026-09-27-gems');
    expect(on.skipped).toEqual([]);
    for (const envText of [null, '', 'GEMS_ENABLED=TRUE', 'GEMS_ENABLED=1', 'GEMS_ENABLED=true\nGEMS_ENABLED=true', '# GEMS_ENABLED=true']) {
      expect(enabledFlags(envText, ['GEMS_ENABLED']).has('GEMS_ENABLED')).toBe(false);
    }
  });

  it('main prints one JSON line with the text byte for byte, and nothing ran', () => {
    const out: string[] = []; const err: string[] = [];
    const envFile = path.join(repo, 'prod.env');
    writeFileSync(envFile, 'GEMS_ENABLED=true\nSECRET_TOKEN=do-not-print\n');
    const code = collectMain(['--sha', sha, '--root', repo, '--env-file', envFile], { print: (line) => out.push(line), printError: (line) => err.push(line) });
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const manifest = JSON.parse(out[0]!) as { fragments: Array<{ id: string; title: string; body: string }> };
    expect(manifest.fragments.find((entry) => entry.id === '2026-09-27-hostile')).toMatchObject({
      title: 'Shell $(id) text', body: 'Shell text $(touch pwned2) stays text; it is only data.' });
    expect(`${out.join('')}${err.join('')}`).not.toContain('do-not-print');
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).not.toContain('pwned');
  });

  it('usage errors exit 2; an unreadable env file only makes gated notes wait', () => {
    const io = () => { const err: string[] = []; return { err, io: { print: () => undefined, printError: (line: string) => err.push(line) } }; };
    for (const argv of [[], ['--sha', 'abc'], ['--sha', sha, 'extra'], ['--bogus']]) expect(collectMain(argv, io().io)).toBe(2);
    const missing = io(); const out: string[] = [];
    expect(collectMain(['--sha', sha, '--root', repo, '--env-file', path.join(repo, 'nope.env')],
      { print: (line) => out.push(line), printError: missing.io.printError })).toBe(0);
    expect(missing.err.join('\n')).toContain('cannot read the env file');
    expect((JSON.parse(out[0]!) as { skipped: unknown[] }).skipped).toHaveLength(1);
    const unknown = io();
    expect(collectMain(['--sha', 'e'.repeat(40), '--root', repo], unknown.io)).toBe(1);
  });
});

describe('lint command', () => {
  it('exits 0 on the repository and 1 with a pointer to the README on a bad tree', () => {
    const out: string[] = [];
    expect(lintMain(['lint', '--root', ROOT], { print: (line) => out.push(line), printError: (line) => out.push(line) })).toBe(0);
    expect(out.join('\n')).toMatch(/fragments OK/);
    const bad = mkdtempSync(path.join(os.tmpdir(), 'pkw-release-notes-bad-'));
    try {
      mkdirSync(path.join(bad, 'release-notes', 'unreleased'), { recursive: true });
      writeFileSync(path.join(bad, 'release-notes', 'unreleased', '2026-09-27-x.md'), '---\ntitle: Phase E\ncategory: new\nplatforms: all\nrequires: none\n---\nPhase E is dark.\n');
      writeFileSync(path.join(bad, 'release-notes', 'notes.txt'), 'stray');
      const err: string[] = [];
      expect(lintMain(['lint', '--root', bad], { print: () => undefined, printError: (line) => err.push(line) })).toBe(1);
      expect(err.join('\n')).toContain('see release-notes/README.md');
      expect(err.join('\n')).toContain('only README.md lives at the top level');
    } finally { rmSync(bad, { recursive: true, force: true }); }
    expect(lintMain(['publish'], { print: () => undefined, printError: () => undefined })).toBe(2);
  });
});
