import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildConstantsCatalogue,constantFunctionExports,assertJsonCarriable,CATALOGUE_CONSTANT_ALLOWLIST,KNOWN_NESTED_FUNCTIONS} from './constants-catalog.mjs';
const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
const load=relative=>import(pathToFileURL(path.join(source,relative)).href);
const {tsImport}=await load('scripts/node_modules/tsx/dist/esm/api/index.mjs');
const constants=await tsImport(pathToFileURL(path.join(source,'packages/shared/src/constants.ts')).href,import.meta.url);
// Same replacer as the exporter's `serial`: what the pack file carries.
const serial=(value)=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?item.toString():item);
const catalogue=buildConstantsCatalogue(constants);

test('app-shell rules arrive through the catalogue with the source values, never from a Kotlin copy',()=>{
  // Review finding: LAND_CHECKOUT_RECOVERY, MOBILE_BACK, WORLD and ECONOMY had been copied into
  // Kotlin as fallbacks because the allowlist did not carry them (native CLAUDE.md "Authority").
  for(const key of ['LAND_CHECKOUT_RECOVERY','MOBILE_BACK','WORLD','ECONOMY','BASE_CAMERA','TRAINING_SCHEDULE']){
    assert.ok(Object.hasOwn(catalogue,key),`${key} missing from catalogue.constants`);
    assert.equal(serial(catalogue[key]),serial(constants[key]),key);
  }
  // Source-anchored spot values: a renamed or relocated rule fails here, not on a device.
  assert.equal(catalogue.ECONOMY.speedupKeepPer30Sec,constants.ECONOMY.speedupKeepPer30Sec);
  assert.ok(Number.isInteger(catalogue.ECONOMY.speedupGranularitySec)&&catalogue.ECONOMY.speedupGranularitySec>0);
  assert.ok(Object.keys(catalogue.LAND_CHECKOUT_RECOVERY).length>0&&Object.keys(catalogue.MOBILE_BACK).length>0&&Object.keys(catalogue.WORLD).length>0);
});

test('every top-level value export of constants.ts is carried by export name and every function export is skipped',()=>{
  const values=Object.keys(constants).filter((key)=>typeof constants[key]!=='function').sort();
  assert.deepEqual(Object.keys(catalogue).sort(),values);
  const functions=constantFunctionExports(constants);
  for(const name of ['upgradeSolLamports','speedupCostKeep','isTrainableTroop','wallCapForKeepLevel']) assert.ok(functions.includes(name),name);
  for(const name of functions) assert.ok(!Object.hasOwn(catalogue,name),`${name} is a function and must not be carried as data`);
  assert.equal(Object.keys(catalogue).length+functions.length,Object.keys(constants).length);
});

test('allowlisted keys keep their position and value shape for the existing renderer/network readers',()=>{
  const keys=Object.keys(catalogue);
  assert.deepEqual(keys.slice(0,CATALOGUE_CONSTANT_ALLOWLIST.length),CATALOGUE_CONSTANT_ALLOWLIST);
  for(const key of CATALOGUE_CONSTANT_ALLOWLIST) assert.equal(serial(catalogue[key]),serial(constants[key]),key);
  const rest=keys.slice(CATALOGUE_CONSTANT_ALLOWLIST.length);
  assert.deepEqual(rest,[...rest].sort(),'additive keys are name-ordered so re-exports stay byte-stable');
  assert.ok(rest.length>0);
});

test('HEROES is the only source constant with nested functions; any other nested function or uncarriable value fails the export',()=>{
  for(const key of Object.keys(catalogue)){
    if(KNOWN_NESTED_FUNCTIONS.has(key)) assert.throws(()=>assertJsonCarriable(constants[key],key),/hpAt is not JSON-carriable: function/);
    else assert.doesNotThrow(()=>assertJsonCarriable(constants[key],key),key);
  }
  const base={GRID:{tilePx:32}};
  assert.throws(()=>buildConstantsCatalogue({...base,BAD:{rate:()=>1}},['GRID']),/BAD\.rate is not JSON-carriable: function/);
  assert.throws(()=>buildConstantsCatalogue({...base,BAD:{cap:Infinity}},['GRID']),/BAD\.cap is not JSON-carriable: Infinity/);
  assert.throws(()=>buildConstantsCatalogue({...base,BAD:{ids:new Set([1])}},['GRID']),/BAD\.ids is not a plain object: Set/);
  assert.throws(()=>buildConstantsCatalogue({...base,BAD:{limit:undefined}},['GRID']),/BAD\.limit is not JSON-carriable: undefined/);
  assert.throws(()=>buildConstantsCatalogue(base,['GRID','MISSING']),/Canonical constant missing: MISSING/);
  assert.deepEqual(buildConstantsCatalogue({...base,helper:()=>1,ZED:[1n],ALPHA:'a'},['GRID']),{GRID:{tilePx:32},ALPHA:'a',ZED:[1n]});
});
