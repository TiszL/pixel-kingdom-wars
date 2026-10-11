import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLayeredGroundSection, buildAcceptedLayeredGroundSection, realmKitVerifier } from './layered-ground-catalog.mjs';
test('normal exports neither load nor admit preview ground', async () => {
  const fail = () => { throw new Error('must not run'); };
  assert.equal(await buildLayeredGroundSection({ readFile: fail, put: fail, verifySources: fail }), undefined);
});
test('preview export verifies the whole source before optional writes and preserves metadata', async () => {
  let verified = false; const writes = [], manifest = { status: 'preview-only', groundRevision: 3 };
  const result = await buildLayeredGroundSection({ source: '/source', previewManifest: '/source/art/pilot/layered-preview.json',
    readFile: async p => JSON.stringify(p.endsWith('layered-sources.json') ? [] : manifest),
    verifySources: async (_root, m) => { verified = true; return { manifest: m, rows: [{ asset: { path: 'verified.webp' }, bytes: Buffer.from('verified') }] }; },
    put: async (p, b, tier) => { assert.ok(verified); writes.push({ p, b, tier }); } });
  assert.equal(writes.length, 2); assert.ok(writes.every(w => w.tier === 'optional'));
  assert.deepEqual(result.manifest, manifest); assert.match(result.manifestPath, /^atlas\/fantasy\/layered-ground\/[a-f0-9]{64}\/manifest.json$/);
  await assert.rejects(buildLayeredGroundSection({ source: '/source', previewManifest: '/tmp/layered-preview.json' }), /explicit source-art/);
});

test('accepted realms verify together before publishing and preserve realm-scoped manifest identity', async () => {
  const registry = {schemaVersion:1, status:'accepted', manifests:['thornwake','frostveil'].map(realmId => ({realmId,manifest:`art/${realmId}/layered-manifest.json`}))};
  let verified = 0; const writes = [];
  const args = {source:'/source', registry,
    readFile:async p => JSON.stringify(p.endsWith('layered-sources.json') ? [] : {status:'accepted',realmId:p.split('/')[3]}),
    verifySources:async (_s,manifest) => {verified++; return {manifest,rows:[]};},
    put:async (p,_b,tier) => {assert.equal(verified,2);assert.equal(tier,'core');writes.push(p);} };
  const result = await buildAcceptedLayeredGroundSection(args);
  assert.equal(result.status,'accepted'); assert.equal(result.manifests.length,2);
  assert.notEqual(result.manifests[0].sha256,result.manifests[1].sha256); assert.equal(writes.length,2);
  assert.equal(await buildAcceptedLayeredGroundSection({...args,registry:{...registry,manifests:[]}}),undefined);
  await assert.rejects(buildAcceptedLayeredGroundSection({...args,registry:{...registry,manifests:[registry.manifests[0],registry.manifests[0]]}}),/Duplicate/);
  let writeCount = 0;
  await assert.rejects(buildAcceptedLayeredGroundSection({...args,put:async()=>{writeCount++;},verifySources:async(_s,m)=>{
    if(m.realmId==='frostveil') throw Error('corrupt realm');return{manifest:m,rows:[]};
  }}),/corrupt/); assert.equal(writeCount,0);
});

test('revision four registry remains separate and rejects a historical manifest before publication', async () => {
  let writes = 0;
  const args = {source:'/source', groundRevision:4, registry:{schemaVersion:1,status:'accepted',manifests:[{realmId:'thornwake',manifest:'art/v6/thornwake/layered-manifest.json'}]},
    readFile:async p=>JSON.stringify(p.endsWith('layered-sources.json')?[]:{status:'accepted',realmId:'thornwake',groundRevision:4}),
    verifySources:async(_s,manifest)=>({manifest,rows:[]}),put:async()=>{writes++;}};
  assert.equal((await buildAcceptedLayeredGroundSection(args)).manifests.length,1);
  assert.equal(writes,1);writes=0;
  await assert.rejects(buildAcceptedLayeredGroundSection({...args,
    readFile:async p=>JSON.stringify(p.endsWith('layered-sources.json')?[]:{status:'accepted',realmId:'thornwake',groundRevision:3})}),/admission mismatch/);
  assert.equal(writes,0);
  assert.equal(await buildAcceptedLayeredGroundSection({...args,registry:{...args.registry,manifests:[]},pinnedCatalogue:{}}),undefined);
});

// The revision-5 registry (scripts/src/layered-ground.ts RealmKitRegistry) has no root status and a status per row;
// `art/realm-kit-v1/accepted.json` ships with the owner's preview-only Crownlands row, so the export must read that
// shape as-is or no contract-15 pack can be produced from source at all.
test('revision five realm kit registry stays separate, publishes core, refuses historical manifests and exports nothing when empty', async () => {
  let writes = [];
  const args = {source:'/source', groundRevision:5, registry:{schemaVersion:1,manifests:[{realmId:'crownlands',manifest:'art/realm-kit-v1/crownlands/layered-manifest.json',status:'accepted'}]},
    readFile:async p=>JSON.stringify(p.endsWith('layered-sources.json')?[]:{status:'accepted',realmId:'crownlands',groundRevision:5,schemaVersion:3}),
    verifySources:async(_s,manifest)=>({manifest,rows:[{asset:{path:'atlas/fantasy/layered-ground/assets/a.png'},bytes:Buffer.from('sheet')}]}),put:async(p,_b,tier)=>{writes.push({p,tier});}};
  const section = await buildAcceptedLayeredGroundSection(args);
  assert.equal(section.version,1); assert.equal(section.status,'accepted'); assert.equal(section.manifests.length,1);
  assert.equal(section.manifests[0].realmId,'crownlands'); assert.match(section.manifests[0].manifestPath,/^atlas\/fantasy\/layered-ground\/[a-f0-9]{64}\/manifest\.json$/);
  assert.deepEqual(writes.map(w=>w.tier),['core','core'],'realm kit ground ships bundled, never on demand');
  writes = [];
  for (const revision of [3,4]) await assert.rejects(buildAcceptedLayeredGroundSection({...args,
    readFile:async p=>JSON.stringify(p.endsWith('layered-sources.json')?[]:{status:'accepted',realmId:'crownlands',groundRevision:revision})}),/admission mismatch/);
  assert.equal(writes.length,0);
  await assert.rejects(buildAcceptedLayeredGroundSection({...args,pinnedCatalogue:{crownlands:{realmId:'crownlands',manifestPath:'x',sha256:'0'.repeat(64),size:1}}}),/frozen source catalogue/);
  assert.equal(await buildAcceptedLayeredGroundSection({...args,registry:{...args.registry,manifests:[]},pinnedCatalogue:{}}),undefined,'an empty registry is a valid contract-15 pack without the section');
  // The shipped registry: one preview-only row, no root status. It is the owner's review material, so it is neither
  // read, verified nor published, and the pack simply carries no realm-kit section (the pinned V5 catalogue is empty).
  const fail = () => { throw new Error('preview-only rows must never be read, verified or written'); };
  const shipped = {schemaVersion:1,manifests:[{realmId:'crownlands',manifest:'art/realm-kit-v1/crownlands/layered-manifest.json',status:'preview-only'}]};
  assert.equal(await buildAcceptedLayeredGroundSection({...args,registry:shipped,pinnedCatalogue:{},readFile:fail,verifySources:fail,put:fail}),undefined);
  // Mixed registry: only the accepted row is prepared and published; the preview row still needs a valid realm id.
  const mixed = {schemaVersion:1,manifests:[shipped.manifests[0],{realmId:'thornwake',manifest:'art/realm-kit-v1/thornwake/layered-manifest.json',status:'accepted'}]};
  const partial = await buildAcceptedLayeredGroundSection({...args,registry:mixed,readFile:async p=>{ assert.ok(!p.includes('crownlands'),'preview-only manifest read');
    return JSON.stringify(p.endsWith('layered-sources.json')?[]:{status:'accepted',realmId:'thornwake',groundRevision:5,schemaVersion:3}); }});
  assert.deepEqual(partial.manifests.map(m=>m.realmId),['thornwake']); assert.deepEqual(writes.map(w=>w.tier),['core','core']); writes = [];
  await assert.rejects(buildAcceptedLayeredGroundSection({...args,registry:{schemaVersion:1,manifests:[{...shipped.manifests[0],realmId:'moonhollow'}]},pinnedCatalogue:{}}),/Invalid accepted layered realm/);
  // A row without a recognised status is neither silently accepted nor silently dropped.
  for (const status of [undefined,'accepted ','draft']) await assert.rejects(buildAcceptedLayeredGroundSection({...args,
    registry:{schemaVersion:1,manifests:[{...args.registry.manifests[0],status}]}}),/Invalid realm kit registry status/);
  assert.equal(writes.length,0);
  // Historical revisions keep the root-status contract: the r5 shape is not admitted as an r4 registry.
  await assert.rejects(buildAcceptedLayeredGroundSection({...args,groundRevision:4,registry:shipped}),/Invalid accepted layered registry/);
  // A debug preview of a revision-5 kit is admitted only as preview-only and only at revision 5.
  const preview = await buildLayeredGroundSection({source:'/source',previewManifest:'/source/art/realm-kit-v1/crownlands/layered-preview.json',groundRevision:5,
    readFile:async p=>JSON.stringify(p.endsWith('layered-sources.json')?[]:{status:'preview-only',realmId:'crownlands',groundRevision:5}),
    verifySources:async(_s,manifest)=>({manifest,rows:[]}),put:async(p,_b,tier)=>{writes.push({p,tier});}});
  assert.equal(preview.status,'preview-only'); assert.equal(preview.manifest.groundRevision,5); assert.deepEqual(writes.map(w=>w.tier),['optional']);
  await assert.rejects(buildLayeredGroundSection({source:'/source',previewManifest:'/source/art/realm-kit-v1/crownlands/layered-preview.json',groundRevision:5,
    readFile:async p=>JSON.stringify(p.endsWith('layered-sources.json')?[]:{status:'preview-only',realmId:'crownlands',groundRevision:4}),
    verifySources:async(_s,manifest)=>({manifest,rows:[]}),put:async()=>{}}),/admission mismatch/);
});
test('revision five manifests verify with the realm-kit validator in layered-ground.ts, never the r3/r4 one', async () => {
  // Mirrors the source layout: scripts/src/realm-kit.ts is the kit builder and exports no verifier, while both validators
  // live in scripts/src/layered-ground.ts and the r3/r4 one rejects every schemaVersion-3 manifest. Looking for a verifier on
  // realm-kit.ts and falling back to the r3/r4 validator therefore fails every export that carries a revision-5 manifest.
  const manifest = { schemaVersion: 3, groundRevision: 5, realmId: 'crownlands', status: 'preview-only' }, sources = [];
  const requested = [], calls = [];
  const load = async (relative) => {
    requested.push(relative);
    if (relative === 'scripts/src/realm-kit.ts') return { assertKit: () => {} };
    if (relative === 'scripts/src/layered-ground.ts') return {
      verifyLayeredGroundSources: async () => { throw new Error('Invalid layered ground manifest'); },
      verifyRealmKitSources: async (root, value, s) => { calls.push({ root, sources: s }); return { manifest: value, rows: [{ asset: { path: 'atlas/fantasy/layered-ground/assets/tileset.png' }, bytes: Buffer.from('sheet') }] }; } };
    throw Object.assign(new Error(`Cannot find module ${relative}`), { code: 'ERR_MODULE_NOT_FOUND' });
  };
  const verified = await realmKitVerifier(load)('/source', manifest, sources);
  assert.equal(verified.manifest, manifest); assert.deepEqual(calls, [{ root: '/source', sources }]); assert.equal(verified.rows.length, 1);
  assert.deepEqual(requested, ['scripts/src/layered-ground.ts']);
  // The debug lane exactly as the exporter wires it (--realm-kit-preview): the manifest reaches the pack unchanged.
  const writes = [];
  const preview = await buildLayeredGroundSection({ source: '/source', previewManifest: '/source/art/realm-kit-v1/crownlands/layered-manifest.json', groundRevision: 5,
    readFile: async p => JSON.stringify(p.endsWith('layered-sources.json') ? sources : manifest), verifySources: realmKitVerifier(load), put: async (p, _b, tier) => { writes.push({ p, tier }); } });
  assert.equal(preview.status, 'preview-only'); assert.equal(preview.manifest.schemaVersion, 3); assert.deepEqual(writes.map(w => w.tier), ['optional', 'optional']);
});
