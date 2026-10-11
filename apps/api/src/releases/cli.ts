/** Release-notes recorder (M47 §5): the ONLY writer of release_history.
 * infra/deploy.sh runs it inside the NEW api container after the release is
 * publicly verified, exactly like the native update-channel CLI:
 *   node --import tsx src/releases/cli.ts record [--manifest <path>|-] [--recorded-by <name>]
 *   node --import tsx src/releases/cli.ts show [--limit N]
 * The manifest (JSON on stdin) is built on the host by
 * scripts/src/release-notes-collect.ts; the recorded identity is this image's own
 * BUILD (version.ts), never the manifest's. `record` prints one JSON summary line,
 * including the `deferred` ids left over the per-release cap (deploy.sh greps
 * `"generic":true` and a non-empty `"deferred":[` for its notices); a refusal prints
 * `CODE: message` and exits 1; usage errors exit 2. */
import { readFile } from 'node:fs/promises';
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { RELEASE_FEED } from '@shardkeep/shared';
import { loadConfig } from '../config';
import { createDb } from '../db/client';
import { BUILD } from '../version';
import { listPublicReleases } from './reader';
import { recordRelease, ReleaseRecordError, type ReleaseIdentity } from './recorder';

const USAGE = 'usage: releases record [--manifest <path>|-] [--recorded-by <name>] | show [--limit N]';

export interface ReleaseCliIo {
  readStdin: () => Promise<string>;
  print: (line: string) => void;
  printError: (line: string) => void;
  /** The running image's identity; tests inject one, production uses BUILD. */
  identity: ReleaseIdentity;
}
const DEFAULT_IO: ReleaseCliIo = {
  readStdin: () => text(process.stdin), print: (line) => console.log(line), printError: (line) => console.error(line),
  identity: { gitSha: BUILD.gitSha, version: BUILD.version, simVersion: BUILD.simVersion, builtAt: BUILD.builtAt },
};

/** Returns the process exit code: 0 done, 1 refused, 2 usage. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: ReleaseCliIo = DEFAULT_IO): Promise<number> {
  let args: Parsed;
  try { args = parse(argv); } catch (error) {
    io.printError(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const config = loadConfig(env);
  const connection = createDb(config.DATABASE_URL, { max: 1 });
  try {
    if (args.command === 'record') {
      let manifest: unknown;
      try {
        manifest = JSON.parse(args.manifest === '-' ? await io.readStdin() : await readFile(args.manifest, 'utf8'));
      } catch (error) {
        throw new ReleaseRecordError('INVALID_MANIFEST', `manifest is not readable JSON (${(error as Error).name})`);
      }
      const result = await recordRelease(connection.db, manifest, { identity: io.identity, recordedBy: args.recordedBy });
      io.print(JSON.stringify(result));
    } else {
      const rows = await listPublicReleases(connection.db, args.limit, (details, message) => io.printError(`${message} ${JSON.stringify(details)}`));
      io.print(JSON.stringify(rows, null, 2));
    }
    return 0;
  } catch (error) {
    if (!(error instanceof ReleaseRecordError)) throw error;
    io.printError(`${error.code}: ${error.message}`);
    return 1;
  } finally {
    await connection.sql.end();
  }
}

type Parsed = { command: 'record'; manifest: string; recordedBy: string } | { command: 'show'; limit: number };
function parse(argv: string[]): Parsed {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    manifest: { type: 'string' }, 'recorded-by': { type: 'string' }, limit: { type: 'string' },
  } });
  const [command, ...extra] = positionals;
  if (extra.length) throw new Error(`unexpected argument: ${extra[0]}`);
  if (command === 'record' && values.limit === undefined) {
    const recordedBy = values['recorded-by'] ?? 'deploy.sh';
    if (!/^[\w.@:-]{1,200}$/.test(recordedBy)) throw new Error('--recorded-by must be 1-200 word characters');
    return { command, manifest: values.manifest ?? '-', recordedBy };
  }
  if (command === 'show' && values.manifest === undefined && values['recorded-by'] === undefined) {
    const limit = values.limit ?? String(RELEASE_FEED.defaultLimit);
    if (!/^[1-9]\d{0,1}$/.test(limit) || Number(limit) > RELEASE_FEED.maxLimit) {
      throw new Error(`show --limit must be 1..${RELEASE_FEED.maxLimit}`);
    }
    return { command, limit: Number(limit) };
  }
  throw new Error(command ? `invalid options for ${command}` : 'missing command');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
