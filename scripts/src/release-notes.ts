/**
 * Release-notes fragments (M47 §5): schema, public-wording lint and loaders.
 *
 * Every player-visible change ships a small Markdown fragment under
 * release-notes/ (voice guide: release-notes/README.md). infra/deploy.sh collects
 * the fragments present at the deployed sha (release-notes-collect.ts) and the
 * API records them in the public changelog. This file is the ONE place the
 * fragment rules live; CI (`release-notes:lint`), the deploy-time collector and
 * the tests all call it, so a fragment CI accepted is exactly one deploy accepts.
 *
 * Layout:
 *   release-notes/unreleased/YYYY-MM-DD-<slug>.md   shipped by the next deploy carrying it
 *   release-notes/history/YYYY-MM-DD-<slug>.md      curated backfill; `date` + `sha` required
 *   release-notes/android/<versionCode>.md          the Android app's notes (anchor #android-<code>)
 *
 * Usage:
 *   tsx src/release-notes.ts lint [--root <repo>] [--check-git]
 *   tsx src/release-notes.ts history-json [--root <repo>]   (fallback feed for the website)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { RELEASE_FEED } from '@shardkeep/shared';

export const RELEASE_NOTES_DIR = 'release-notes';
export const FRAGMENT_KINDS = ['unreleased', 'history', 'android'] as const;
export type FragmentKind = typeof FRAGMENT_KINDS[number];
export const CATEGORIES = ['new', 'improved', 'fixed', 'balance', 'android', 'world'] as const;
export const PLATFORMS = ['all', 'web', 'android'] as const;
/** Reading order inside one release on the public page. */
const CATEGORY_ORDER: Record<Category, number> = { new: 0, world: 1, improved: 2, balance: 3, fixed: 4, android: 5 };
export type Category = typeof CATEGORIES[number];
export type Platforms = typeof PLATFORMS[number];

export interface Fragment {
  kind: FragmentKind;
  /** Repo-relative path, e.g. release-notes/unreleased/2026-09-27-new-website.md */
  path: string;
  /** `YYYY-MM-DD-<slug>` or `android-<versionCode>`; the public anchor. */
  id: string;
  title: string;
  category: Category;
  platforms: Platforms;
  /** `none` or the production env flag that must be exactly `true`. */
  requires: string;
  date?: string;
  sha?: string;
  /** Plain text folded onto one line. */
  body: string;
}

export interface ReleaseEntry { id: string; category: Category; platforms: Platforms; title: string; body: string }
export interface LintIssue { path: string; message: string }
export interface SourceFile { path: string; text: string }

const FIELDS = new Set(['title', 'category', 'platforms', 'requires', 'date', 'sha']);
const SLUG_FILE = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const ANDROID_FILE = /^([1-9]\d{0,5})\.md$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const FLAG = /^[A-Z][A-Z0-9_]{2,63}$/;
const MAX_ID = 96;

/**
 * Public wording rules (M47 §1). Each pattern names what to write instead. They
 * are deliberately conservative: a false positive costs a rewording, a false
 * negative publishes internal jargon or a promise to players.
 */
export const WORDING_RULES: ReadonlyArray<{ pattern: RegExp; message: string; titleOnly?: boolean }> = [
  { pattern: /\bphase[\s-]*e\b/i, message: 'the internal name "Phase E" is never public: say "onchain gameplay"' },
  { pattern: /\bE[1-7][a-z]?\b/, message: 'internal track ids (E1–E7) are never public' },
  { pattern: /\bon[\s-]chain\s+gameplay\b/i, message: 'write "onchain gameplay" (one word, lower case in prose)' },
  { pattern: /\bdark\b/i, message: '"dark" is internal launch jargon: say what players can do, or "coming"' },
  { pattern: /\bheld\b/i, message: '"held" is internal status jargon: say "coming" or leave it out' },
  { pattern: /\bSIM\b|\bSIM\s?\d+|\bsim(?:ulator)?\s+version\b/i, message: 'never publish SIM or simulator versions' },
  { pattern: /\b[DKM]-\d{1,4}\b|\bM\d{1,3}\b/, message: 'decision, issue and milestone ids (D-123, K-45, M47) are internal' },
  { pattern: /\bPR\s?#?\d+|#\d+/i, message: 'pull-request and ticket numbers are internal' },
  { pattern: /custody\s+retirement/i, message: '"custody retirement" is internal: describe the player change instead' },
  { pattern: /\b(?:[Cc]utover|[Pp]hase|[Tt]rack|[Ll]ane|[Gg]ate|[Ww]ave)\s+(?:[A-Z]\d?|D0)\b|\bD0\b/,
    message: 'internal cutover letters (F, W, D0, gate A…) are never public' },
  { pattern: /play[\s-]*(?:to|2)[\s-]*earn|\bP2E\b/i, message: '"play-to-earn" is never used' },
  { pattern: /\bearn(?:s|ed|ing|ings)?\b/i, message: '"earn" reads as a promise: say "win", "collect" or "receive"' },
  { pattern: /\b(?:buy|buys|buying|bought|purchas\w*)\s+(?:\w+\s+)?gems\b/i, message: 'never "buy Gems": say "convert KEEP to Gems"' },
  { pattern: /\b(?:profit\w*|ROI|passive\s+income|guarantee\w*|invest(?:ment|ments|or|ors|ing)?)\b/i, message: 'no financial promises in release notes' },
  { pattern: /\b(?:raids?|attacks?|armies|army|troops?)\b[^.!?]{0,40}\b(?:travel\w*|march\w*|en route|on (?:the|their) way|arriv\w*)\b/i,
    message: 'raids are instant: never imply travel or marching time' },
  { pattern: /\b(?:worktree|handoff|feature flag|QA host)\b/i, message: 'internal tooling and process names are never public' },
  { pattern: /https?:\/\//i, message: 'no links: the page adds its own' },
  { pattern: /side-?load/i, message: 'headings say "Android APK", never "sideload"', titleOnly: true },
];

/** Plain text only: the public pages render these strings as text. */
const MARKUP: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  { pattern: /[<>]/, message: 'no HTML or angle brackets' },
  { pattern: /\*\*|__|`|\]\(|!\[/, message: 'plain text only: no Markdown emphasis, code or links' },
  { pattern: /^\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s)/m, message: 'plain sentences only: no headings or lists' },
  { pattern: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/, message: 'no control characters' },
];

export function wordingIssues(text: string, where: 'title' | 'body'): string[] {
  const issues: string[] = [];
  for (const rule of WORDING_RULES) {
    if (rule.titleOnly && where !== 'title') continue;
    const match = rule.pattern.exec(text);
    if (match) issues.push(`${where}: ${rule.message} (found "${match[0]}")`);
  }
  for (const rule of MARKUP) if (rule.pattern.test(text)) issues.push(`${where}: ${rule.message}`);
  return issues;
}

/** Sentence count: terminal punctuation followed by whitespace or the end. */
export function countSentences(body: string): number {
  return (body.match(/[.!?]["')”]?(?=\s|$)/g) ?? []).length;
}

function validCalendarDate(date: string): boolean {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}

/** The public timestamp of a history fragment: exact when given, else noon UTC. */
export function deployedAtOf(date: string): string {
  return new Date(DATE.test(date) ? `${date}T12:00:00Z` : date).toISOString();
}

function splitFrontMatter(text: string): { fields: Array<[string, string]>; body: string } | string {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') return 'must start with a "---" front-matter line';
  const end = lines.indexOf('---', 1);
  if (end < 0) return 'front matter is not closed with "---"';
  const fields: Array<[string, string]> = [];
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') continue;
    const match = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!match) return `front-matter line is not "key: value": ${JSON.stringify(line.slice(0, 60))}`;
    let value = match[2]!.trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    fields.push([match[1]!, value]);
  }
  return { fields, body: lines.slice(end + 1).join('\n') };
}

/** Validates one fragment file in isolation. */
export function parseFragment(file: SourceFile, now: Date = new Date()): { fragment?: Fragment; issues: LintIssue[] } {
  const issues: LintIssue[] = [];
  const fail = (message: string) => { issues.push({ path: file.path, message }); };
  const parts = file.path.split('/');
  const kind = parts[1] as FragmentKind;
  const name = parts[2] ?? '';
  if (parts.length !== 3 || parts[0] !== RELEASE_NOTES_DIR || !FRAGMENT_KINDS.includes(kind)) {
    fail(`fragments live in ${RELEASE_NOTES_DIR}/{${FRAGMENT_KINDS.join(',')}}/`);
    return { issues };
  }
  let id: string; let fileDate: string | undefined;
  if (kind === 'android') {
    const match = ANDROID_FILE.exec(name);
    if (!match) { fail('Android notes are named <versionCode>.md (1..999999, no leading zero)'); return { issues }; }
    id = `android-${match[1]}`;
  } else {
    const match = SLUG_FILE.exec(name);
    if (!match) { fail('fragments are named YYYY-MM-DD-<lower-case-slug>.md'); return { issues }; }
    if (!validCalendarDate(match[1]!)) { fail(`${match[1]} is not a calendar date`); return { issues }; }
    id = name.slice(0, -3); fileDate = match[1]!;
  }
  if (id.length > MAX_ID) fail(`id is longer than ${MAX_ID} characters`);

  const split = splitFrontMatter(file.text);
  if (typeof split === 'string') { fail(split); return { issues }; }
  const fields = new Map<string, string>();
  for (const [key, value] of split.fields) {
    if (!FIELDS.has(key)) fail(`unknown front-matter key "${key}" (allowed: ${[...FIELDS].join(', ')})`);
    else if (fields.has(key)) fail(`front-matter key "${key}" appears twice`);
    else fields.set(key, value);
  }
  for (const key of ['title', 'category', 'platforms', 'requires']) if (!fields.get(key)) fail(`"${key}" is required`);

  const title = fields.get('title') ?? '';
  if (title.length > RELEASE_FEED.titleMaxChars) fail(`title is ${title.length} characters; the limit is ${RELEASE_FEED.titleMaxChars}`);
  for (const issue of wordingIssues(title, 'title')) fail(issue);

  const category = fields.get('category') ?? '';
  if (category && !(CATEGORIES as readonly string[]).includes(category)) fail(`category must be one of ${CATEGORIES.join('|')}`);
  const platforms = fields.get('platforms') ?? '';
  if (platforms && !(PLATFORMS as readonly string[]).includes(platforms)) fail(`platforms must be one of ${PLATFORMS.join('|')}`);
  const requires = fields.get('requires') ?? '';
  if (requires && requires !== 'none' && !FLAG.test(requires)) fail('requires must be "none" or an ENV_FLAG name');

  const date = fields.get('date');
  if (date !== undefined) {
    const day = date.slice(0, 10);
    if ((!DATE.test(date) && !DATETIME.test(date)) || !validCalendarDate(day) || Number.isNaN(Date.parse(deployedAtOf(date)))) {
      fail('date must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ');
    } else {
      if (fileDate && day !== fileDate) fail(`date ${day} does not match the file name date ${fileDate}`);
      if (Date.parse(deployedAtOf(date)) > now.getTime() + 86_400_000) fail('date is in the future');
    }
  }
  const sha = fields.get('sha');
  if (sha !== undefined && !/^[0-9a-f]{40}$/.test(sha)) fail('sha must be the full 40-character lower-case git sha');

  if (kind === 'history') {
    if (!date) fail('history fragments need the deploy "date"');
    if (!sha) fail('history fragments need the deployed "sha"');
    if (requires && requires !== 'none') fail('history already shipped: requires must be "none"');
  } else if (sha !== undefined) {
    fail(`${kind} fragments never carry a sha: the deploy that ships them records it`);
  }
  if (kind === 'android') {
    if (category && category !== 'android') fail('Android notes use category: android');
    if (platforms && platforms !== 'android') fail('Android notes use platforms: android');
  }

  const rawBody = split.body.trim();
  if (/\n\s*\n/.test(rawBody)) fail('body is one paragraph (1–3 sentences)');
  const body = rawBody.replace(/\s+/g, ' ');
  if (!body) fail('body is empty');
  if (body.length > RELEASE_FEED.bodyMaxChars) fail(`body is ${body.length} characters; the limit is ${RELEASE_FEED.bodyMaxChars}`);
  const sentences = countSentences(body);
  if (body && (sentences < 1 || sentences > RELEASE_FEED.bodyMaxSentences)) {
    fail(`body has ${sentences} sentences; write 1–${RELEASE_FEED.bodyMaxSentences}`);
  }
  if (body && !/[.!?]["')”]?$/.test(body)) fail('body ends with ".", "!" or "?"');
  for (const issue of wordingIssues(rawBody, 'body')) fail(issue);

  if (issues.length) return { issues };
  return {
    issues,
    fragment: {
      kind, path: file.path, id, title, category: category as Category, platforms: platforms as Platforms, requires,
      ...(date !== undefined ? { date } : {}), ...(sha !== undefined ? { sha } : {}), body,
    },
  };
}

/** Whole-set rules on top of per-file ones: unique ids, one date per history sha. */
export function lintFragments(files: SourceFile[], now: Date = new Date()): { fragments: Fragment[]; issues: LintIssue[] } {
  const issues: LintIssue[] = [];
  const fragments: Fragment[] = [];
  for (const file of files) {
    const result = parseFragment(file, now);
    issues.push(...result.issues);
    if (result.fragment) fragments.push(result.fragment);
  }
  const byId = new Map<string, Fragment[]>();
  for (const fragment of fragments) byId.set(fragment.id, [...(byId.get(fragment.id) ?? []), fragment]);
  const rejected = new Set<string>();
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    for (const fragment of group) {
      issues.push({ path: fragment.path, message: `id ${id} is used by ${group.length} fragments` });
      rejected.add(fragment.path);
    }
  }
  const dates = new Map<string, Fragment[]>();
  for (const fragment of fragments) {
    if (fragment.kind === 'history' && fragment.sha) dates.set(fragment.sha, [...(dates.get(fragment.sha) ?? []), fragment]);
  }
  for (const [sha, group] of dates) {
    const distinct = new Set(group.map((fragment) => deployedAtOf(fragment.date!)));
    if (distinct.size > 1) {
      for (const fragment of group) {
        issues.push({ path: fragment.path, message: `history for ${sha.slice(0, 8)} uses ${distinct.size} different dates` });
        rejected.add(fragment.path);
      }
    }
    if (group.length > RELEASE_FEED.maxEntriesPerRelease) {
      for (const fragment of group) {
        issues.push({ path: fragment.path, message: `history for ${sha.slice(0, 8)} has more than ${RELEASE_FEED.maxEntriesPerRelease} entries` });
        rejected.add(fragment.path);
      }
    }
  }
  return { fragments: fragments.filter((fragment) => !rejected.has(fragment.path)), issues };
}

/** Every file under release-notes/<kind>/ in the working tree (README and .gitkeep excluded). */
export function readWorkingTree(root: string): { files: SourceFile[]; issues: LintIssue[] } {
  const base = path.join(root, RELEASE_NOTES_DIR);
  const files: SourceFile[] = [];
  const issues: LintIssue[] = [];
  if (!existsSync(base)) return { files, issues: [{ path: RELEASE_NOTES_DIR, message: 'directory is missing' }] };
  for (const entry of readdirSync(base)) {
    const full = path.join(base, entry);
    if (statSync(full).isFile()) {
      if (entry !== 'README.md') issues.push({ path: `${RELEASE_NOTES_DIR}/${entry}`, message: 'only README.md lives at the top level' });
      continue;
    }
    if (!(FRAGMENT_KINDS as readonly string[]).includes(entry)) {
      issues.push({ path: `${RELEASE_NOTES_DIR}/${entry}`, message: `unknown directory (allowed: ${FRAGMENT_KINDS.join(', ')})` });
      continue;
    }
    for (const name of readdirSync(full).sort()) {
      const relative = `${RELEASE_NOTES_DIR}/${entry}/${name}`;
      if (name === '.gitkeep') continue;
      if (!statSync(path.join(full, name)).isFile() || !name.endsWith('.md')) {
        issues.push({ path: relative, message: 'only .md fragments belong here' });
        continue;
      }
      files.push({ path: relative, text: readFileSync(path.join(full, name), 'utf8') });
    }
  }
  return { files, issues };
}

/** The wire entry the API stores (apps/api/src/releases/contracts.ts ReleaseEntrySchema). */
export function toEntry(fragment: Fragment): ReleaseEntry {
  return { id: fragment.id, category: fragment.category, platforms: fragment.platforms, title: fragment.title, body: fragment.body };
}

export function byReadingOrder(a: { category: Category; id: string }, b: { category: Category; id: string }): number {
  return CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Release identity at a historical sha, read from git (package.json, sim version). */
export function identityAt(root: string, sha: string): { version: string; simVersion: number } {
  const show = (file: string) => execFileSync('git', ['-C', root, 'show', `${sha}:${file}`],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const version = (JSON.parse(show('package.json')) as { version?: unknown }).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json at ${sha.slice(0, 8)} has no x.y.z version`);
  const sim = /export const SIM_VERSION = (\d+);/.exec(show('packages/sim/src/version.ts'));
  if (!sim) throw new Error(`packages/sim/src/version.ts at ${sha.slice(0, 8)} has no SIM_VERSION`);
  return { version, simVersion: Number(sim[1]) };
}

export interface HistoryGroup { gitSha: string; version: string; simVersion: number; deployedAt: string; entries: ReleaseEntry[] }

/** Curated history grouped per deployed sha, oldest first. A group whose sha git
 * cannot resolve is reported and left out (it is never guessed). */
export function historyGroups(root: string, fragments: Fragment[]): { groups: HistoryGroup[]; issues: LintIssue[] } {
  const bySha = new Map<string, Fragment[]>();
  for (const fragment of fragments) {
    if (fragment.kind === 'history' && fragment.sha) bySha.set(fragment.sha, [...(bySha.get(fragment.sha) ?? []), fragment]);
  }
  const groups: HistoryGroup[] = [];
  const issues: LintIssue[] = [];
  for (const [sha, group] of bySha) {
    try {
      groups.push({ gitSha: sha, ...identityAt(root, sha), deployedAt: deployedAtOf(group[0]!.date!),
        entries: [...group].sort(byReadingOrder).map(toEntry) });
    } catch (error) {
      for (const fragment of group) issues.push({ path: fragment.path, message: `cannot read the release at ${sha.slice(0, 8)}: ${(error as Error).message.split('\n')[0]}` });
    }
  }
  groups.sort((a, b) => Date.parse(a.deployedAt) - Date.parse(b.deployedAt) || (a.gitSha < b.gitSha ? -1 : 1));
  return { groups, issues };
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Returns the process exit code: 0 clean, 1 lint issues, 2 usage. */
export function main(argv: string[], io: { print: (line: string) => void; printError: (line: string) => void } = {
  print: (line) => console.log(line), printError: (line) => console.error(line),
}): number {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true,
      options: { root: { type: 'string' }, 'check-git': { type: 'boolean' } } });
  } catch (error) {
    io.printError(`${(error as Error).message}\nusage: release-notes lint [--root <repo>] [--check-git] | history-json [--root <repo>]`);
    return 2;
  }
  const [command, ...extra] = parsed.positionals;
  if ((command !== 'lint' && command !== 'history-json') || extra.length) {
    io.printError('usage: release-notes lint [--root <repo>] [--check-git] | history-json [--root <repo>]');
    return 2;
  }
  const root = path.resolve(parsed.values.root ?? REPO_ROOT);
  const tree = readWorkingTree(root);
  const linted = lintFragments(tree.files);
  const issues = [...tree.issues, ...linted.issues];
  if (command === 'history-json' || parsed.values['check-git']) {
    const history = historyGroups(root, linted.fragments);
    issues.push(...history.issues);
    if (command === 'history-json') {
      if (issues.length) {
        for (const issue of issues) io.printError(`${issue.path}: ${issue.message}`);
        return 1;
      }
      const android = linted.fragments.filter((fragment) => fragment.kind === 'android')
        .map((fragment) => ({ versionCode: Number(fragment.id.slice('android-'.length)), ...toEntry(fragment) }))
        .sort((a, b) => b.versionCode - a.versionCode);
      const releases = [...history.groups].reverse().map((group) => ({
        gitSha: group.gitSha, shortSha: group.gitSha.slice(0, 8), version: group.version, simVersion: group.simVersion,
        deployedAt: group.deployedAt, kind: 'backfill' as const, entries: group.entries,
      }));
      io.print(JSON.stringify({ releases, android }, null, 2));
      return 0;
    }
  }
  for (const issue of issues) io.printError(`${issue.path}: ${issue.message}`);
  const counts = FRAGMENT_KINDS.map((kind) => `${linted.fragments.filter((fragment) => fragment.kind === kind).length} ${kind}`).join(', ');
  if (issues.length) {
    io.printError(`release-notes: ${issues.length} problem(s); see release-notes/README.md`);
    return 1;
  }
  io.print(`release-notes: ${linted.fragments.length} fragments OK (${counts})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
