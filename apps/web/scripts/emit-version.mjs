/**
 * Writes dist/version.json — what build is DEPLOYED as the web bundle.
 *
 * The update banner used to compare the client's baked gitSha against the API's
 * /version. That is the wrong axis: the whole deployment model is that web
 * assets ship far more often than the API (a TWA game updates by deploying web
 * assets), so the two shas legitimately differ almost always — which made the
 * banner PERMANENT, and pressing RELOAD could never clear it because the freshly
 * loaded bundle still disagreed with the API. The honest question for a soft
 * update is "is a NEWER WEB BUILD deployed than the one I am running", and only
 * the origin can answer it — via this file, written at build time next to the
 * assets it describes.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const clean = (v) => (v === undefined || v.trim() === '' ? undefined : v);

const payload = {
  version: clean(process.env.APP_VERSION) ?? '0.0.0-dev',
  gitSha: clean(process.env.GIT_SHA) ?? 'dev',
  builtAt: clean(process.env.BUILD_TIME) ?? null,
};
writeFileSync(join(DIST, 'version.json'), JSON.stringify(payload) + '\n');
console.log(`  version.json: ${payload.version} (${payload.gitSha})`);
