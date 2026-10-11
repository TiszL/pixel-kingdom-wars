/** REALM_KIT_PREVIEW_MANIFESTS (REALM-KIT-PLAN §6.3): the dev/QA host serves an UNPINNED
 * kit for its preview realms so the real revision-5 path (deeds, expansion obstacles,
 * native content) can be checked before the catalogue pin exists. WHY these pins:
 * the descriptor must be derived from the published bytes (a hand-typed hash could
 * admit a manifest the clients would refuse), a catalogue pin must always win over the
 * switch, and a production host must never read it. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { previewRealmKitDescriptors } from '../src/game/realmKitCatalogue';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

describe('REALM_KIT_PREVIEW_MANIFESTS descriptors', () => {
  it('derives size and sha256 from the published bytes and refuses production', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kit-preview-')); dirs.push(root);
    const sha = 'b'.repeat(64), rel = `atlas/fantasy/layered-ground/${sha}/manifest.json`;
    const bytes = Buffer.from('{"schemaVersion":3}\n');
    await mkdir(path.dirname(path.join(root, 'apps/web/public', rel)), { recursive: true });
    await writeFile(path.join(root, 'apps/web/public', rel), bytes);
    const table = previewRealmKitDescriptors({ REALM_KIT_PREVIEW_MANIFESTS: `crownlands=${rel}`, REPO_ROOT: root, NODE_ENV: 'development' });
    expect(table.crownlands).toEqual({ realmId: 'crownlands', manifestPath: rel, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
    // Two realms under review at once (REALM-THEMES-PLAN §3 P0): every entry of the comma map lands in the table.
    const sha2 = 'd'.repeat(64), rel2 = `atlas/fantasy/layered-ground/${sha2}/manifest.json`, bytes2 = Buffer.from('{"schemaVersion":3,"realmId":"frostveil"}\n');
    await mkdir(path.dirname(path.join(root, 'apps/web/public', rel2)), { recursive: true });
    await writeFile(path.join(root, 'apps/web/public', rel2), bytes2);
    const both = previewRealmKitDescriptors({ REALM_KIT_PREVIEW_MANIFESTS: `crownlands=${rel}, frostveil=${rel2}`, REPO_ROOT: root, NODE_ENV: 'development' });
    expect(Object.keys(both).sort()).toEqual(['crownlands', 'frostveil']);
    expect(both.frostveil).toEqual({ realmId: 'frostveil', manifestPath: rel2, sha256: createHash('sha256').update(bytes2).digest('hex'), size: bytes2.length });
    expect(previewRealmKitDescriptors({ REPO_ROOT: root })).toEqual({});
    expect(() => previewRealmKitDescriptors({ REALM_KIT_PREVIEW_MANIFESTS: `crownlands=${rel}`, REPO_ROOT: root, NODE_ENV: 'production' })).toThrow(/refused in production/);
    expect(() => previewRealmKitDescriptors({ REALM_KIT_PREVIEW_MANIFESTS: 'crownlands=../../etc/passwd', REPO_ROOT: root })).toThrow(/REALM_KIT_PREVIEW_MANIFESTS/);
    expect(() => previewRealmKitDescriptors({ REALM_KIT_PREVIEW_MANIFESTS: `crownlands=atlas/fantasy/layered-ground/${'c'.repeat(64)}/manifest.json`, REPO_ROOT: root })).toThrow(/ENOENT/);
  });
});
