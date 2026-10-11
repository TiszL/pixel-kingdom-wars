/** Where the server finds a published revision-5 realm kit (docs/REALM-KIT-PLAN.md
 * §2, §5). The builder pins each accepted kit by manifest hash in the shared
 * catalogue as `BASE_LAYERED_GROUND_V5`, the revision-5 twin of the r3/r4 tables.
 * That block does not exist on this branch until the first Crownlands kit is
 * pinned, so the read is typed-optional: when it appears the deed renderer picks
 * it up without an edit here, and until then every realm is unpublished and a
 * revision-5 deed refuses loudly instead of painting older ground. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isRealmId, isRealmKitBaseVisualContext, type BaseVisualContext, type RealmId } from '@shardkeep/shared/baseVisual';
import * as layeredCatalogue from '@shardkeep/shared/layeredGroundCatalogue';
import type { LayeredGroundDescriptor } from '@shardkeep/shared/layeredGroundCatalogue';

type DescriptorTable = Readonly<Partial<Record<RealmId, LayeredGroundDescriptor>>>;
/** DEV/QA ONLY (REALM-KIT-PLAN §6.3, the server twin of VITE_REALM_KIT_PREVIEW_MANIFESTS):
 * `REALM_KIT_PREVIEW_MANIFESTS=crownlands=atlas/fantasy/layered-ground/<sha>/manifest.json`
 * lets this host serve an UNPINNED kit (preview-only status allowed) for realms it
 * previews at revision 5, so expansion obstacles, deeds and the native client can be
 * checked against the real revision-5 path before the catalogue pin exists. The
 * descriptor is derived from the published bytes (size + sha256) once per process.
 * Refused outright under NODE_ENV=production: the catalogue pin is the only way a
 * production host learns a kit. */
export function previewRealmKitDescriptors(env: NodeJS.ProcessEnv = process.env): DescriptorTable {
  const raw = env['REALM_KIT_PREVIEW_MANIFESTS']?.trim();
  if (!raw) return {};
  if (env['NODE_ENV'] === 'production') throw new Error('REALM_KIT_PREVIEW_MANIFESTS is refused in production');
  const repoRoot = env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
  const out: Partial<Record<RealmId, LayeredGroundDescriptor>> = {};
  for (const entry of raw.split(',')) {
    const [realmId, manifestPath] = entry.split('=').map(s => s.trim());
    if (!realmId || !isRealmId(realmId) || !manifestPath || !/^atlas\/fantasy\/layered-ground\/[0-9a-f]{64}\/manifest\.json$/.test(manifestPath)) {
      throw new Error(`REALM_KIT_PREVIEW_MANIFESTS entry is not <realmId>=atlas/fantasy/layered-ground/<sha256>/manifest.json: ${entry}`);
    }
    const bytes = readFileSync(path.join(repoRoot, 'apps/web/public', manifestPath));
    out[realmId] = { realmId, manifestPath, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  }
  return out;
}
let previewTable: DescriptorTable | undefined;
function publishedRealmKits(): DescriptorTable {
  const table = (layeredCatalogue as unknown as { BASE_LAYERED_GROUND_V5?: DescriptorTable }).BASE_LAYERED_GROUND_V5;
  previewTable ??= previewRealmKitDescriptors();
  // A catalogue pin always wins over the preview switch: production never reads the switch.
  return { ...previewTable, ...(table ?? {}) };
}
/** True when the descriptor for this context came from the dev/QA preview switch
 * rather than the catalogue — the one case a preview-only manifest may be served. */
export function realmKitDescriptorIsPreview(context: BaseVisualContext): boolean {
  if (!isRealmKitBaseVisualContext(context)) return false;
  const table = (layeredCatalogue as unknown as { BASE_LAYERED_GROUND_V5?: DescriptorTable }).BASE_LAYERED_GROUND_V5;
  previewTable ??= previewRealmKitDescriptors();
  return !table?.[context.realmId] && !!previewTable[context.realmId];
}

/** The lookup rule against an explicit table (tests pin it against an empty one). */
export function realmKitDescriptorFrom(table: DescriptorTable, context: BaseVisualContext): LayeredGroundDescriptor {
  if (!isRealmKitBaseVisualContext(context)) throw new Error('A realm kit descriptor requires an explicit revision5 context');
  const row = table[context.realmId];
  if (!row) throw new Error(`Realm kit artwork is not published: ${context.realmId}`);
  return row;
}
export function realmKitDescriptor(context: BaseVisualContext): LayeredGroundDescriptor {
  return realmKitDescriptorFrom(publishedRealmKits(), context);
}
