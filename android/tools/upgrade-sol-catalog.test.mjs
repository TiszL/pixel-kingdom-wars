import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {buildUpgradeSolLamports,assertUpgradeSolLamports,canonicalMaxLevel,upgradableTypes} from './upgrade-sol-catalog.mjs';
const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
const load=relative=>import(pathToFileURL(path.join(source,relative)).href);
const {tsImport}=await load('scripts/node_modules/tsx/dist/esm/api/index.mjs');
const constants=await tsImport(pathToFileURL(path.join(source,'packages/shared/src/constants.ts')).href,import.meta.url);
const table=buildUpgradeSolLamports(constants);
// The derivation every published pack was exported with (owner incident 2026-09-18), kept only as the regression input.
const legacyTable=()=>Object.fromEntries(Object.entries({...constants.STRUCTURES,...constants.DEFENSES}).map(([type,settings])=>[type,
  Object.fromEntries(Array.from({length:settings.maxLevel},(_,index)=>[String(index+1),String(constants.upgradeSolLamports(type,index+1))]))]));

test('every structure, defence, trap and wall exports one string entry per level 1..max, priced by the canonical function',()=>{
  // WHY: the native client reads display.upgradeSolLamports[type][level] to decide whether an upgrade is a
  // SHARDS order or a SOL purchase. An absent level is not "free" to a reader that was never told the ceiling;
  // 0.5.3 dimmed UPGRADE on every defence, trap and wall because their tables were exported empty.
  const types=[...Object.keys(constants.STRUCTURES),...Object.keys(constants.DEFENSES)];
  assert.deepEqual(Object.keys(table),types);
  for(const type of types){
    const max=canonicalMaxLevel(constants,type);
    assert.deepEqual(Object.keys(table[type]),Array.from({length:max},(_,index)=>String(index+1)),type);
    for(const [level,lamports] of Object.entries(table[type])){
      assert.equal(typeof lamports,'string',`${type} L${level}`);
      assert.match(lamports,/^(0|[1-9][0-9]*)$/,`${type} L${level}`);
      assert.equal(lamports,String(constants.upgradeSolLamports(type,Number(level))),`${type} L${level}`);
      assert.equal(BigInt(lamports)>0n,constants.upgradeSolLamports(type,Number(level))>0,`${type} L${level}`);
    }
  }
  for(const type of ['cannon','archertower','mortar','airdefence','electrictower','magetower','lasertower','dragonnest','spiketrap','powdermine','pitfall','airmine','wall'])
    assert.equal(Object.keys(table[type]).length,constants.UPGRADE_COSTS[type].length+1,`${type} must reach its last UPGRADE_COSTS step`);
});

test('only the D-057 SOL-gated steps carry a positive price: Mine and Gold Forge, exactly their canonical target levels',()=>{
  const priced=Object.fromEntries(Object.entries(table).map(([type,levels])=>[type,Object.keys(levels).filter((level)=>levels[level]!=='0').map(Number)]).filter(([,levels])=>levels.length>0));
  assert.deepEqual(Object.keys(priced).sort(),['goldforge','mine']);
  assert.deepEqual(priced.mine,Object.keys(constants.MINING.UPGRADE_SOL_LAMPORTS_BY_TARGET_LEVEL).map(Number));
  assert.deepEqual(priced.goldforge,Object.keys(constants.FORGE.UPGRADE_SOL_LAMPORTS_BY_TARGET_LEVEL).map(Number));
  for(const level of priced.mine) assert.equal(table.mine[level],String(constants.MINING.UPGRADE_SOL_LAMPORTS_BY_TARGET_LEVEL[level]));
  for(const level of priced.goldforge) assert.equal(table.goldforge[level],String(constants.FORGE.UPGRADE_SOL_LAMPORTS_BY_TARGET_LEVEL[level]));
});

test('the ceiling is the canonical one the server enforces, and a disagreement between its two sources refuses the export',()=>{
  // apps/api MAX_LEVEL is built from exactly these fields; UPGRADE_COSTS has one step per level below the ceiling.
  for(const type of Object.keys(constants.DEFENSES)) assert.equal(canonicalMaxLevel(constants,type),constants.DEFENSE_LEVELING.maxLevel,type);
  assert.equal(canonicalMaxLevel(constants,'wall'),constants.STRUCTURES.wall.maxTier);
  assert.equal(canonicalMaxLevel(constants,'keep'),constants.STRUCTURES.keep.maxLevel);
  assert.equal(canonicalMaxLevel(constants,'heroaltar'),1);
  for(const type of Object.keys(constants.UPGRADE_COSTS)) assert.equal(canonicalMaxLevel(constants,type),constants.UPGRADE_COSTS[type].length+1,type);
  assert.throws(()=>canonicalMaxLevel(constants,'not-a-building'),/No canonical max level for building type: not-a-building/);
  assert.throws(()=>canonicalMaxLevel({...constants,DEFENSE_LEVELING:{maxLevel:21}},'cannon'),/Max level 21 of cannon disagrees with its 19 UPGRADE_COSTS steps/);
  assert.throws(()=>canonicalMaxLevel({...constants,DEFENSE_LEVELING:{}},'cannon'),/No canonical max level for building type: cannon/);
  assert.throws(()=>buildUpgradeSolLamports({...constants,UPGRADE_COSTS:{...constants.UPGRADE_COSTS,ballista:[1]}}),/UPGRADE_COSTS type has no canonical max level: ballista/);
});

test('the export guard refuses the table every published pack shipped, and any other incomplete or drifted table',()=>{
  const legacy=legacyTable();
  const empty=Object.keys(legacy).filter((type)=>Object.keys(legacy[type]).length===0);
  assert.deepEqual(empty.sort(),['airdefence','airmine','archertower','cannon','dragonnest','electrictower','lasertower','magetower','mortar','pitfall','powdermine','spiketrap','wall']);
  assert.throws(()=>assertUpgradeSolLamports(legacy,constants),/upgradeSolLamports table is empty for wall/);
  const without=(type,level)=>{const copy=structuredClone(table); if(level===undefined) delete copy[type]; else delete copy[type][level]; return copy;};
  assert.throws(()=>assertUpgradeSolLamports(without('cannon'),constants),/types differ from STRUCTURES \+ DEFENSES/);
  assert.throws(()=>assertUpgradeSolLamports(without('cannon','20'),constants),/levels of cannon are not 1\.\.20/);
  assert.throws(()=>assertUpgradeSolLamports({...table,cannon:{}},constants),/table is empty for cannon/);
  const paid=Object.keys(constants.MINING.UPGRADE_SOL_LAMPORTS_BY_TARGET_LEVEL)[0];
  assert.throws(()=>assertUpgradeSolLamports({...table,mine:{...table.mine,[paid]:'0'}},constants),new RegExp(`mine L${paid} is "0", canonical ${constants.upgradeSolLamports('mine',Number(paid))}$`));
  assert.throws(()=>assertUpgradeSolLamports({...table,keep:{...table.keep,2:0}},constants),/keep L2 is 0, canonical 0/);
  assert.equal(assertUpgradeSolLamports(table,constants),table);
  assert.deepEqual(upgradableTypes(constants),Object.keys(table));
});

test('candidate15 uses the guarded builder while historical14 retains its explicitly frozen byte replay',async()=>{
  const exporter=await readFile(fileURLToPath(new URL('./export-client-pack.mjs',import.meta.url)),'utf8');
  assert.match(exporter,/if \(phaseEServices\) return \{ upgradeSolLamports: buildUpgradeSolLamports\(constants\) \}/);
  assert.match(exporter,/\.\.\.upgradeDisplay\(constants, phaseEServices\)/);
  assert.equal((exporter.match(/settings\.maxLevel/g)??[]).length,1,'the historical-only branch is the sole retained old derivation');
});

test('actual exporter branches reproduce default14 and deliver the complete canonical15 table without expanding single-level structures',async()=>{
  const exporter=await readFile(fileURLToPath(new URL('./export-client-pack.mjs',import.meta.url)),'utf8');
  const ts=(await load('scripts/node_modules/typescript/lib/typescript.js')).default;
  const ast=ts.createSourceFile('export-client-pack.mjs',exporter,ts.ScriptTarget.Latest,true);
  const declaration=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='upgradeDisplay');
  assert.ok(declaration,'exercise the actual exporter function, not a test copy');
  const select=new Function('buildUpgradeSolLamports',`${declaration.getText(ast)}; return upgradeDisplay;`)(buildUpgradeSolLamports);
  assert.deepEqual(select(constants,false),{upgradeSolLamports:legacyTable()});
  assert.deepEqual(select(constants,true),{upgradeSolLamports:table});
  for(const type of Object.keys(constants.STRUCTURES)){
    assert.equal(Object.keys(select(constants,true).upgradeSolLamports[type]).length,canonicalMaxLevel(constants,type),type);
  }
  assert.equal(Object.keys(select(constants,false).upgradeSolLamports.cannon).length,0,'frozen old bug must not silently repin14');
  assert.ok(Object.keys(select(constants,true).upgradeSolLamports.cannon).length>0,'candidate15 fixes the old defense hole');
  assert.equal(Object.keys(select(constants,true).upgradeSolLamports.heroaltar).length,1);
  assert.equal(Object.keys(select(constants,true).upgradeSolLamports.siegestool).length,1);
});
