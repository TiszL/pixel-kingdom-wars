import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildGroundSection,buildFantasySection} from './realm-catalog.mjs';
const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
const load=relative=>import(pathToFileURL(path.join(source,relative)).href);
const {tsImport}=await load('scripts/node_modules/tsx/dist/esm/api/index.mjs');
const typed=relative=>tsImport(pathToFileURL(path.join(source,relative)).href,import.meta.url);
const constants=await typed('packages/shared/src/constants.ts');
const baseVisual=await typed('packages/shared/src/baseVisual.ts');
const groundEnvironment=await typed('packages/shared/src/groundEnvironment.ts');
const fantasyWorld=await typed('packages/shared/src/fantasyWorld.ts');
const sharp=createRequire(path.join(source,'scripts/package.json'))('sharp');
const decodePng=async(bytes)=>{const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});return {data,width:info.width,height:info.height};};
const publicRoot=path.join(source,'apps/web/public');
const sha=(bytes)=>createHash('sha256').update(bytes).digest('hex');
// Executed from the web skirt module in the exporter; here the same rule is
// bound directly so the test does not depend on the TypeScript transpiler.
const underlay=await typed('apps/web/src/game/world/underlay.ts').catch(()=>null);
const skirtTint=underlay?.skirtTint??((key,context)=>{const v=baseVisual.resolveBaseVisualContext(context);if(v.artVersion===1)return 0xffffff;
  const stone=key.includes('rock')||key.includes('boulder');
  return {frostveil:stone?0xc6e4f0:0xafd1db,elderwood:stone?0xd8d5bd:0xc8d68d,sunscar:stone?0xefd0a4:0xd3b77c,'seeker-reach':stone?0xd2bbed:0xa9e6d5,
    stormcairn:stone?0xb0bccb:0xa2b6b4,thornwake:stone?0xb8c7b9:0x9cc6aa,cinderfall:stone?0xbca5a3:0xa59e97}[v.realmId]??0xffffff;});
const collect=()=>{const files=[];return {files,put:async(relative,bytes,tier)=>files.push({path:relative,size:bytes.length,sha256:sha(bytes),tier})};};
const groundOptions=(overrides={})=>({constants,baseVisual,groundEnvironment,publicRoot,readFile,decodePng,skirtTint,...overrides});
const fantasyOptions=(overrides={})=>({constants,fantasyWorld,baseVisual,source,publicRoot,readFile,...overrides});

test('ground section retains every shipped painting and excludes the rejected unshipped studies',async()=>{
  const out=collect();
  const section=await buildGroundSection(groundOptions({put:out.put}));
  assert.deepEqual(section.currentVisual,baseVisual.CURRENT_BASE_VISUAL,'retained rejected studies never force current selection');
  assert.equal(out.files.length,4+2*baseVisual.REALM_IDS.length);
  assert.ok(out.files.every((file)=>file.tier==='optional'&&file.path.startsWith('atlas/fantasy/ground')));
  for(const realm of baseVisual.REALM_IDS) {
    assert.equal(section.art[2].sources[realm].sha256,baseVisual.BASE_GROUND_ART_V2.sources[realm].sha256);
    assert.equal(section.art[1].sources[realm].sha256,baseVisual.BASE_GROUND_ART.sources[realm].sha256);
    assert.equal(section.art[2].sources[realm].width,baseVisual.BASE_GROUND_ART_V2.sourceSize);
    assert.ok(section.skirtTints[realm].stone>0&&section.skirtTints[realm].other>0);
  }
  assert.equal(section.skirtTints.crownlands.stone,0xffffff,'Crownlands keeps the untinted skirt');
  assert.deepEqual(section.worldGeometry,constants.BASE_GROUND_WORLD_GEOMETRY);
  assert.deepEqual(section.motion,constants.BASE_GROUND_MOTION);
  assert.deepEqual(section.campaignRealmByAct,Array.from({length:constants.CAMPAIGN.totalStages/constants.CAMPAIGN.stagesPerAct},(_,i)=>baseVisual.campaignBaseVisualForAct(i+1).realmId));
  assert.equal(section.vectors.length,(2*baseVisual.REALM_IDS.length+1)*3+1);
  const vector=section.vectors.find((v)=>v.artVersion===2&&v.realm==='crownlands'&&v.originX===0);
  const pixels=await decodePng(await readFile(path.join(publicRoot,'atlas/fantasy/ground-v2/crownlands.png')));
  const data=baseVisual.renderGroundPixels(pixels,{version:1,realmId:'crownlands',artVersion:2},vector.width,vector.height,vector.originX,vector.originY);
  assert.equal(sha(data),vector.rgbaSha256,'goldens are reproducible from createGroundRaster');
  assert.notEqual(section.vectors.find((v)=>v.artVersion===1&&v.realm==='crownlands'&&v.originX===0).rgbaSha256,vector.rgbaSha256);
  const revision = section.revisions[0];
  assert.deepEqual(revision.visual, {version:1,realmId:'crownlands',artVersion:2,groundRevision:1});
  assert.equal(revision.art.sources.crownlands.sha256, baseVisual.BASE_GROUND_ART_V3.sources.crownlands.sha256);
  assert.equal(revision.art.sources.crownlands.path, 'atlas/fantasy/ground-v3/crownlands.png');
  assert.deepEqual(Object.keys(revision.art.sources), ['crownlands'], 'other seven paintings keep their exact v2 identity');
  assert.equal(revision.art.features,undefined,'frozen Crownlands correction retains its original motion');
  assert.equal(section.revisions.length,1);
  assert.ok(!out.files.some(file=>file.path.includes('/ground-v4/')),'rejected artwork must never inflate or enter the installable pack');
  assert.ok(section.vectors.every(vector=>vector.groundRevision!==2));
  const currentVector=section.vectors.find(v=>v.purpose==='revision-correction');
  const currentPixels=await decodePng(await readFile(path.join(publicRoot,revision.art.sources.crownlands.path)));
  assert.equal(sha(baseVisual.renderGroundPixels(currentPixels,revision.visual,currentVector.width,currentVector.height,currentVector.originX,currentVector.originY)),currentVector.rgbaSha256);
  const historicalPatch=baseVisual.renderGroundPixels(pixels,{version:1,realmId:'crownlands',artVersion:2},currentVector.width,currentVector.height,currentVector.originX,currentVector.originY);
  assert.notEqual(currentVector.rgbaSha256,sha(historicalPatch),'current clearing differs from frozen v2 replay pixels at the same world location');
});
test('a painting whose bytes differ from the accepted hash refuses the export instead of shipping unverified terrain',async()=>{
  const corruptRead=async(file,...rest)=>{const bytes=await readFile(file,...rest);if(String(file).endsWith('ground-v2/sunscar.png')){const copy=Buffer.from(bytes);copy[copy.length-20]^=1;return copy;}return bytes;};
  await assert.rejects(buildGroundSection(groundOptions({put:collect().put,readFile:corruptRead})),/sunscar.png does not match the accepted painting hash/);
  const shiftedManifest=async(file,...rest)=>{const bytes=await readFile(file,...rest);if(String(file).endsWith('ground-v2/manifest.json')){const m=JSON.parse(bytes);m.worldOriginTiles=-1;return Buffer.from(JSON.stringify(m));}return bytes;};
  await assert.rejects(buildGroundSection(groundOptions({put:collect().put,readFile:shiftedManifest})),/disagrees with BASE_GROUND_ART/);
  const corruptRevision=async(file,...rest)=>{const bytes=await readFile(file,...rest);if(String(file).endsWith('ground-v3/crownlands.png')){const copy=Buffer.from(bytes);copy[copy.length-20]^=1;return copy;}return bytes;};
  await assert.rejects(buildGroundSection(groundOptions({put:collect().put,readFile:corruptRevision})),/crownlands.png does not match the accepted painting hash/);
  const rejectStudyRead=async(file,...rest)=>{if(String(file).includes('/ground-v4/'))throw new Error('rejected study was read');return readFile(file,...rest);};
  await buildGroundSection(groundOptions({put:collect().put,readFile:rejectStudyRead}));
});
test('fantasy section proves the frozen catalog hash and copies the pinned globe rasters as optional files',async()=>{
  const out=collect();
  const section=await buildFantasySection(fantasyOptions({put:out.put}));
  assert.equal(section.catalogHash,fantasyWorld.FANTASY_CATALOG_HASH);
  assert.equal(section.counts.total,constants.FANTASY_WORLD.totalTiles);
  assert.equal(section.counts.byAllocation.seeker,constants.FANTASY_WORLD.seekerTiles);
  assert.deepEqual(section.world,constants.FANTASY_WORLD);
  const catalog=out.files.find((file)=>file.path==='fantasy/world-v1.json');
  assert.equal(catalog.tier,'core');assert.equal(catalog.sha256,section.catalogSha256);
  assert.equal(out.files.find((file)=>file.path==='fantasy/campaign-presentation.json').tier,'core');
  const globe=out.files.filter((file)=>file.path.startsWith('atlas/fantasy/globe/'));
  assert.equal(globe.length,section.globe.files.length);
  assert.ok(globe.every((file)=>file.tier==='optional'));
  assert.ok(!out.files.some((file)=>file.path.includes('retired-deeds')),'server-only deed archive never enters a pack');
  const [first]=section.vectors.tiles;assert.deepEqual(first.tile,fantasyWorld.getFantasyTile(first.tileId));
  assert.equal(section.vectors.tileAt.at(-1).tile.realmId,'crownlands');
  const world = await load('apps/web/src/ui/fantasy/runtime/world.mjs');
  const details = await load('apps/web/src/ui/fantasy/runtime/details.mjs');
  assert.deepEqual(section.presentation.regions, world.REGIONS);
  assert.deepEqual(section.presentation.chains, world.ARCHIPELAGOS);
  assert.deepEqual(section.presentation.regionalDetails, details.REGIONAL_DETAILS);
  assert.ok(section.presentation.chains.every(chain => chain.locked), 'exploration stays dormant as in production');
});
test('globe rasters that disagree with the web art manifest pins refuse the export',async()=>{
  const drift=async(file,...rest)=>{const bytes=await readFile(file,...rest);if(String(file).endsWith('ui/fantasy/art-manifest.json')){const m=JSON.parse(bytes);m.files[0].sha256='0'.repeat(64);return Buffer.from(JSON.stringify(m));}return bytes;};
  await assert.rejects(buildFantasySection(fantasyOptions({put:collect().put,readFile:drift})),/disagrees with the web art manifest/);
  const membership=async(file,...rest)=>{const bytes=await readFile(file,...rest);if(String(file).endsWith('data/fantasy-world-v1.json')){const m=JSON.parse(bytes);m.membershipSha256='1'.repeat(64);return Buffer.from(JSON.stringify(m));}return bytes;};
  await assert.rejects(buildFantasySection(fantasyOptions({put:collect().put,readFile:membership})),/membership hash drifted/);
});
