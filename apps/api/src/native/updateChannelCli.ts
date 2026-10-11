/** Operator command only (M45 §2): the ONLY writer of native_update_channel.
 * Run inside the API container over ssh exactly like `pnpm db:migrate`:
 *   native:update-channel publish [--manifest <path>|-] [--skip-origin-check] [--created-by <name>]
 *   native:update-channel mark-published --code N
 *   native:update-channel show
 * Prints rows as JSON; a refusal prints `CODE: message` and exits non-zero. */
import { readFile } from 'node:fs/promises';
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config';
import { createDb } from '../db/client';
import {
  listNativeUpdates, markNativeUpdatePublished, NativeUpdateChannelError, publishNativeUpdate, type NativeUpdateOriginCheck,
} from './updateChannel';

const USAGE = 'usage: native:update-channel publish [--manifest <path>|-] [--skip-origin-check] [--created-by <name>]'
  + ' | mark-published --code N | show';

/** The public origin must already serve the exact bytes before any device is told about them.
 * Every failure (non-2xx, redirect, timeout, DNS) is the ORIGIN_UNAVAILABLE refusal, never a stack trace. */
export async function headContentLength(url: string, timeoutMs = 10_000): Promise<number | null> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new NativeUpdateChannelError('ORIGIN_UNAVAILABLE', `origin ${url} did not answer (${(error as Error).name})`);
  }
  if (!response.ok) throw new NativeUpdateChannelError('ORIGIN_UNAVAILABLE', `origin ${url} answered HTTP ${response.status}`);
  const length = response.headers.get('content-length');
  return length !== null && /^\d+$/.test(length) ? Number(length) : null;
}

export interface UpdateChannelCliIo {
  readStdin: () => Promise<string>;
  print: (line: string) => void;
  printError: (line: string) => void;
  originCheck: Exclude<NativeUpdateOriginCheck, false>;
}
const DEFAULT_IO: UpdateChannelCliIo = {
  readStdin: () => text(process.stdin), print: (line) => console.log(line), printError: (line) => console.error(line),
  originCheck: headContentLength,
};

/** Returns the process exit code: 0 done, 1 refused, 2 usage. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: UpdateChannelCliIo = DEFAULT_IO): Promise<number> {
  let args: Parsed;
  try { args = parse(argv); } catch (error) {
    io.printError(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const config = loadConfig(env);
  const connection = createDb(config.DATABASE_URL, { max: 1 });
  try {
    const origin = { PLAY_URL: config.PLAY_URL, WEB_ORIGIN: config.WEB_ORIGIN };
    if (args.command === 'publish') {
      let manifest: unknown;
      try {
        manifest = JSON.parse(args.manifest === '-' ? await io.readStdin() : await readFile(args.manifest, 'utf8'));
      } catch (error) {
        throw new NativeUpdateChannelError('INVALID_MANIFEST', `manifest is not readable JSON (${(error as Error).name})`);
      }
      if (args.createdBy !== undefined && manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
        manifest = { ...manifest, createdBy: args.createdBy };
      }
      const row = await publishNativeUpdate(connection.db, manifest,
        { config: origin, originCheck: args.skipOriginCheck ? false : io.originCheck });
      io.print(JSON.stringify(row, null, 2));
    } else if (args.command === 'mark-published') {
      io.print(JSON.stringify(await markNativeUpdatePublished(connection.db, args.code, origin), null, 2));
    } else {
      io.print(JSON.stringify(await listNativeUpdates(connection.db, origin), null, 2));
    }
    return 0;
  } catch (error) {
    if (!(error instanceof NativeUpdateChannelError)) throw error;
    io.printError(`${error.code}: ${error.message}`);
    return 1;
  } finally {
    await connection.sql.end();
  }
}

type Parsed = { command: 'publish'; manifest: string; skipOriginCheck: boolean; createdBy?: string }
  | { command: 'mark-published'; code: number } | { command: 'show' };
function parse(argv: string[]): Parsed {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    manifest: { type: 'string' }, 'skip-origin-check': { type: 'boolean' }, 'created-by': { type: 'string' },
    code: { type: 'string' },
  } });
  const [command, ...extra] = positionals;
  if (extra.length) throw new Error(`unexpected argument: ${extra[0]}`);
  const publishOnly = values.manifest !== undefined || values['skip-origin-check'] !== undefined || values['created-by'] !== undefined;
  if (command === 'publish' && values.code === undefined) {
    return { command, manifest: values.manifest ?? '-', skipOriginCheck: values['skip-origin-check'] === true,
      ...(values['created-by'] !== undefined ? { createdBy: values['created-by'] } : {}) };
  }
  if (command === 'mark-published' && !publishOnly) {
    if (!values.code || !/^[1-9]\d{0,5}$/.test(values.code)) throw new Error('mark-published requires --code N');
    return { command, code: Number(values.code) };
  }
  if (command === 'show' && !publishOnly && values.code === undefined) return { command };
  throw new Error(command ? `invalid options for ${command}` : 'missing command');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
