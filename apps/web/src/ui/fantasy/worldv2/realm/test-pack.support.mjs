// Where the realm tests read the world pack (worldv2/realm/patches.md P5). The concept read its gitignored
// ../../pack/; the web serves the same bytes from apps/web/public/atlas/world-v2/<packVersion>/ (lane L2's
// `pnpm assets:world`). WV2_PACK_ROOT overrides it, e.g. the concept's full pack while L2 is not merged:
//   WV2_PACK_ROOT=<path to a world v2 pack>/ node --test …
// Test-only: nothing the engine ships imports this file. A test that needs a pack file and finds none fails loudly
// (ENOENT), as the concept's did; nothing is skipped here.
import { resolve } from 'node:path';

export const PACK_VERSION = 'pm1-cb8faa56909faa31';
const env = process.env.WV2_PACK_ROOT;
export const PACK_ROOT = (env ? resolve(env) : new URL(`../../../../../public/atlas/world-v2/${PACK_VERSION}`, import.meta.url).pathname).replace(/\/?$/, '/');
