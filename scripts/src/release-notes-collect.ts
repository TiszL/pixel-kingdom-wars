/**
 * Deploy-time release-notes collector (M47 §5). infra/deploy.sh runs it on the
 * host after the release is publicly verified and pipes its stdout, unchanged,
 * into the API container's recorder:
 *
 *   pnpm --filter @shardkeep/scripts run --silent release-notes:collect \
 *     --sha "$SHA" --root "$ROOT" --env-file "$ROOT/$ENV_FILE" \
 *   | $COMPOSE exec -T api node --import tsx src/releases/cli.ts record --manifest -
 *
 * - Fragments are read from git AT THE DEPLOYED SHA (never the working tree), so
 *   what is recorded is exactly what shipped.
 * - Every fragment passes the same lint as CI (release-notes.ts). One that fails
 *   is reported and left unclaimed, so a later fixed deploy can still publish it.
 * - A fragment whose `requires` flag is not exactly `true` in the production env
 *   file is listed as waiting and never claimed. Flag VALUES are never printed.
 * - JSON is built here in node: no fragment text ever passes through a shell.
 * Output: one JSON line on stdout; warnings on stderr. Exit 1 only when the tree
 * at the sha cannot be read at all, 2 on usage errors.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  byReadingOrder, FRAGMENT_KINDS, historyGroups, lintFragments, RELEASE_NOTES_DIR, toEntry,
  type HistoryGroup, type ReleaseEntry, type SourceFile,
} from './release-notes';

export interface CollectedManifest {
  gitSha: string;
  fragments: ReleaseEntry[];
  skipped: Array<{ id: string; requires: string }>;
  history: HistoryGroup[];
}

const git = (root: string, args: string[]) => execFileSync('git', ['-C', root, ...args],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/** Fragment files exactly as committed at `sha`. */
export function readTreeAt(root: string, sha: string): SourceFile[] {
  const listing = git(root, ['ls-tree', '-r', '-z', '--name-only', sha, '--', `${RELEASE_NOTES_DIR}/`]);
  const files: SourceFile[] = [];
  for (const file of listing.split('\0')) {
    const parts = file.split('/');
    if (parts.length !== 3 || !(FRAGMENT_KINDS as readonly string[]).includes(parts[1]!) || !file.endsWith('.md')) continue;
    files.push({ path: file, text: git(root, ['show', `${sha}:${file}`]) });
  }
  return files;
}

/** Names whose value is exactly `true` (quotes allowed) on exactly one line. The
 * file holds secrets: only the requested names are looked at, and no value is
 * ever returned or printed. */
export function enabledFlags(envText: string | null, names: string[]): Set<string> {
  const on = new Set<string>();
  if (envText === null) return on;
  const lines = envText.split(/\r?\n/);
  for (const name of names) {
    const matches = lines.filter((line) => line.startsWith(`${name}=`));
    if (matches.length !== 1) continue;
    let value = matches[0]!.slice(name.length + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value === 'true') on.add(name);
  }
  return on;
}

export function collect(opts: { root: string; sha: string; envText: string | null; warn: (line: string) => void }): CollectedManifest {
  const { root, sha, warn } = opts;
  const linted = lintFragments(readTreeAt(root, sha));
  for (const issue of linted.issues) warn(`release-notes: SKIPPED ${issue.path}: ${issue.message}`);
  const current = linted.fragments.filter((fragment) => fragment.kind !== 'history');
  const flags = enabledFlags(opts.envText, [...new Set(current.map((fragment) => fragment.requires).filter((flag) => flag !== 'none'))]);
  const ready = current.filter((fragment) => fragment.requires === 'none' || flags.has(fragment.requires));
  const skipped = current.filter((fragment) => !ready.includes(fragment))
    .map((fragment) => ({ id: fragment.id, requires: fragment.requires }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const history = historyGroups(root, linted.fragments);
  for (const issue of history.issues) warn(`release-notes: SKIPPED ${issue.path}: ${issue.message}`);
  return { gitSha: sha, fragments: [...ready].sort(byReadingOrder).map(toEntry), skipped, history: history.groups };
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const USAGE = 'usage: release-notes-collect --sha <40-hex> [--root <repo>] [--env-file <path>]';

export function main(argv: string[], io: { print: (line: string) => void; printError: (line: string) => void } = {
  print: (line) => process.stdout.write(`${line}\n`), printError: (line) => console.error(line),
}): number {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false,
      options: { sha: { type: 'string' }, root: { type: 'string' }, 'env-file': { type: 'string' } } }));
  } catch (error) {
    io.printError(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (!values.sha || !/^[0-9a-f]{40}$/.test(values.sha)) {
    io.printError(`--sha must be the full 40-character sha\n${USAGE}`);
    return 2;
  }
  const root = path.resolve(values.root ?? REPO_ROOT);
  let envText: string | null = null;
  if (values['env-file']) {
    try { envText = readFileSync(values['env-file'], 'utf8'); } catch (error) {
      io.printError(`release-notes: WARNING cannot read the env file (${(error as NodeJS.ErrnoException).code ?? 'error'}); every flag-gated fragment waits`);
    }
  }
  let manifest: CollectedManifest;
  try {
    manifest = collect({ root, sha: values.sha, envText, warn: io.printError });
  } catch (error) {
    io.printError(`release-notes: cannot read ${RELEASE_NOTES_DIR}/ at ${values.sha.slice(0, 8)}: ${(error as Error).message.split('\n')[0]}`);
    return 1;
  }
  io.print(JSON.stringify(manifest));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
