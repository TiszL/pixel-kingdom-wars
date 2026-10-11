/** Explicit local instrumentation overlay, never a release pack. The harness
 * passes its manifest through BundledContent and the ordinary SceneHost lease. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {manifestVersion, sha256, verifiedBytes} from './pack.mjs';
const args=process.argv.slice(2), value=name=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw Error(`Missing ${name}`);return args[i+1];};
const source=path.resolve(value('--source')), output=path.resolve(value('--out')), realm=value('--realm');
const native=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(!output.startsWith(path.join(native,'.reports')+path.sep))throw Error('GL fixtures belong only under native .reports');
if(!process.env.PKW_LAYERED_FIXTURE_LOADER){const result=spawnSync(process.execPath,['--import',path.join(source,'scripts/node_modules/tsx/dist/loader.mjs'),fileURLToPath(import.meta.url),...args],{stdio:'inherit',env:{...process.env,PKW_LAYERED_FIXTURE_LOADER:'1'}});process.exit(result.status??1);}
const {BASE_LAYERED_GROUND_V3}=await import(pathToFileURL(path.join(source,'packages/shared/src/layeredGroundCatalogue.ts')).href);
const {assertLayeredGroundManifest}=await import(pathToFileURL(path.join(source,'packages/shared/src/layeredGround.ts')).href);
const descriptor=BASE_LAYERED_GROUND_V3[realm];if(!descriptor)throw Error('Realm artwork has not passed accepted pinning');
const publicRoot=path.join(source,'apps/web/public'), bundled=path.join(native,'app/src/main/assets/native');
const manifest=JSON.parse(await fs.readFile(path.join(bundled,'manifest.json'),'utf8'));
if(manifestVersion(manifest)!==manifest.contentVersion)throw Error('Bundled fixture base is not an admitted pack');
const files=new Map(manifest.files.map(row=>[row.path,row]));
const render=JSON.parse(await verifiedBytes(bundled,files.get('render-catalog.json')));
// The local generated atlas may be a deliberate symlink. Its frozen
// digest, not that mutable cache location, authorizes the copied bytes.
async function published(file){const bytes=await fs.readFile(path.join(publicRoot,file.path));if(bytes.length!==file.size||sha256(bytes)!==file.sha256)throw Error('Published layered bytes changed');return bytes;}
const manifestBytes=await published({path:descriptor.manifestPath,sha256:descriptor.sha256,size:descriptor.size});
const layered=JSON.parse(manifestBytes);assertLayeredGroundManifest(layered);
if(layered.realmId!==realm||layered.status!=='accepted')throw Error('Accepted realm descriptor changed');
const additions=[];
for(const asset of layered.assets)additions.push({path:asset.path,bytes:await published(asset)});
additions.push({path:descriptor.manifestPath,bytes:manifestBytes});
render.layeredGround={version:1,status:'accepted',manifests:[descriptor]};
additions.push({path:'render-catalog.json',bytes:Buffer.from(JSON.stringify(render)+'\n')});
for(const row of additions){files.set(row.path,{path:row.path,sha256:sha256(row.bytes),size:row.bytes.length,tier:'core'});}
manifest.files=[...files.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
manifest.contentVersion=manifestVersion(manifest);const bytes=Buffer.from(JSON.stringify(manifest)+'\n');
for(const row of additions){const filename=path.join(output,row.path);await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,row.bytes);}
await fs.writeFile(path.join(output,'manifest.json'),bytes);
await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify({privateFixtureOnly:true,realm,manifestSha256:sha256(bytes),descriptor,artworkBytesChanged:false,sourceCommit:manifest.sourceCommit},null,2)+'\n');
console.log(`Private GL fixture ${sha256(bytes)} at ${output}`);
