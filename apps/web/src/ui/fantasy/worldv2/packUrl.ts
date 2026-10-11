/**
 * Where the world v2 pack is served (D-186). `pnpm assets:world` publishes the tracked export
 * art/world-v2/<packVersion>/ (native's 166-file selection, verified by sha256) to
 * apps/web/public/atlas/world-v2/<packVersion>/. The concept engines take a pack root and append
 * pack-relative paths (`./pack/` in the concept): hand them WORLD_V2_PACK_ROOT.
 *
 * The URL deliberately carries no `?v=<build>`: the pack is outside the build's asset inventory (the
 * offline pack skips /atlas/world-v2/), so it is not in a release snapshot either. Caddy serves a
 * `?v=<sha>` URL only from that snapshot (a 404 here), and the service worker answers an older build's
 * `?v=` with 503. The pack version in the path is the cache key instead: the files stay cached across
 * deploys and change only with a re-pin. Never send `x-pkw-ground-stream` for these files either: the
 * worker reserves it for inventoried terrain and answers anything else with 503.
 */
export const WORLD_V2_PACK_VERSION = 'pm1-cb8faa56909faa31';
export const WORLD_V2_PACK_ROOT = `/atlas/world-v2/${WORLD_V2_PACK_VERSION}/`;

const PACK_PATH = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|webp|json)$/;

/** The served URL of one pack file, from its pack-relative path (e.g. `realm/crownlands/realm.json`). */
export function worldPackUrl(packPath: string): string {
  if (!PACK_PATH.test(packPath)) throw new Error(`not a world pack path: ${packPath}`);
  return `${WORLD_V2_PACK_ROOT}${packPath}`;
}
