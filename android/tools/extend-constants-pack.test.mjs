import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {VEHICLE_KEYS, serial, extendConstantsCatalogue, extendConstantsPack} from './extend-constants-pack.mjs';
import {sha256, manifestVersion, verifyPack, metadataPaths} from './pack.mjs';
const values=()=>Object.fromEntries(VEHICLE_KEYS.map((key,index)=>[key,{version:1,count:BigInt(index+1)}]));

test('adds exactly five JSON-carriable keys without changing prior catalogue fields',()=>{
  const base={sourceCommit:'a'.repeat(40),presentation:{existing:true},constants:{GRID:{size:1}}};
  const result=extendConstantsCatalogue(base,values());
  assert.deepEqual(Object.keys(result.constants),['GRID',...VEHICLE_KEYS]);
  assert.deepEqual(result.presentation,base.presentation);assert.equal(result.sourceCommit,base.sourceCommit);
  assert.equal(result.constants[VEHICLE_KEYS[0]].count,'1');assert.deepEqual(Object.keys(base.constants),['GRID']);
  assert.deepEqual(extendConstantsCatalogue(result,values()),result);
});
test('existing conflicting value and every unsupported value refuse',()=>{
  assert.throws(()=>extendConstantsCatalogue({constants:{[VEHICLE_KEYS[0]]:{wrong:true}}},values()),/Conflicting/);
  for(const bad of [undefined,()=>1,NaN,Infinity,new Map(),new Date(),Symbol('x')]) {
    const source=values();source[VEHICLE_KEYS[0]]=bad;
    assert.throws(()=>extendConstantsCatalogue({constants:{}},source),/JSON-carriable|plain object/);
  }
  const cycle={};cycle.self=cycle;assert.throws(()=>extendConstantsCatalogue({constants:{}},{...values(),[VEHICLE_KEYS[0]]:cycle}),/circular/);
  assert.throws(()=>extendConstantsCatalogue({constants:{}},{}),/Missing source/);
});
test('fresh pack is verified and every non-catalogue payload is byte-identical',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'pkw-constant-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const basePack=path.join(root,'base'),output=path.join(root,'next');await mkdir(basePack);
  const contents={'catalogue.json':serial({sourceCommit:'a'.repeat(40),constants:{GRID:1}}),
    'render-catalog.json':serial({rendererContractVersion:17,phaseE:{groups:[]},boundCosmetics:{groups:[]},fleetJourneys:{groups:[]}}),
    'atlas/meta.json':'{}\n','contracts.json':'{}\n','kotlin/NativeContracts.kt':'// immutable generated model\n','fixture.bin':'fixture bytes'};
  const files=[];for(const name of Object.keys(contents).sort()) {await mkdir(path.dirname(path.join(basePack,name)),{recursive:true});await writeFile(path.join(basePack,name),contents[name]);files.push({path:name,sha256:sha256(contents[name]),size:Buffer.byteLength(contents[name]),tier:'core'});}
  const manifest={schemaVersion:1,sourceCommit:'a'.repeat(40),simVersion:18,rendererContractVersion:17,...metadataPaths,files};manifest.contentVersion=manifestVersion(manifest);
  const pinned=serial(manifest);await writeFile(path.join(basePack,'manifest.json'),pinned);
  const options={basePack,output,constants:values(),constantsSource:'b'.repeat(40),expectedBaseManifest:sha256(pinned)};
  await assert.rejects(extendConstantsPack({...options,expectedBaseManifest:'0'.repeat(64)}),/pin mismatch/);
  const result=await extendConstantsPack(options);const next=await verifyPack(output);
  assert.equal(next.rendererContractVersion,17);assert.equal(next.sourceCommit,manifest.sourceCommit);
  assert.notEqual(next.contentVersion,manifest.contentVersion);assert.equal(result.unchangedFiles,files.length-1);
  for(const file of files)if(file.path!=='catalogue.json')assert.deepEqual(await readFile(path.join(output,file.path)),await readFile(path.join(basePack,file.path)));
  assert.equal(await readFile(path.join(basePack,'manifest.json'),'utf8'),pinned);
  await assert.rejects(extendConstantsPack(options),/already exists/);
});
test('five real PRIMARY constants equal a fresh tsx evaluation byte-for-byte',()=>{
  const source=process.env.PKW_NATIVE_SOURCE;if(!source)throw new Error('PKW_NATIVE_SOURCE required');
  const script=`import {pathToFileURL} from 'node:url';import {extendConstantsCatalogue,VEHICLE_KEYS,serial} from ${JSON.stringify(import.meta.url.replace('extend-constants-pack.test.mjs','extend-constants-pack.mjs'))};const c=await import(pathToFileURL(${JSON.stringify(source+'/packages/shared/src/constants.ts')}).href);const next=extendConstantsCatalogue({constants:{}},c);for(const key of VEHICLE_KEYS)if(serial(next.constants[key])!==serial(c[key]))throw new Error(key);console.log(JSON.stringify(VEHICLE_KEYS));`;
  const r=spawnSync(process.execPath,['--import',pathToFileURL(source+'/scripts/node_modules/tsx/dist/loader.mjs').href,'--input-type=module','-e',script],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),VEHICLE_KEYS);
});
