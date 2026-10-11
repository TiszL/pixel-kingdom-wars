import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {captureGiantLanding} from './giant-sensory.mjs';

const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
const ts=(await import(pathToFileURL(path.join(source,'scripts/node_modules/typescript/lib/typescript.js')).href)).default;
const compile=(text,bindings={})=>new Function(...Object.keys(bindings),ts.transpile(text,{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
const expected=JSON.parse(await readFile(new URL('../renderer/src/test/resources/sensory/source-reference.json',import.meta.url),'utf8'));
const sourceRead=name=>readFile(path.join(source,name),'utf8');

test('actual Giant health delegation preserves every pinned throw release and landing case',async()=>{
  const reads=new Set();
  const result=await captureGiantLanding(ts,async name=>{reads.add(name);return sourceRead(name);},compile);
  assert.deepEqual(result.policy,expected.policy.giantLanding);
  assert.deepEqual(result.cases,expected.giantCases);
  const troop=await sourceRead('apps/web/src/game/v2/troop.ts');
  if(troop.includes('syncHealth('))assert.ok(reads.has('packages/shared/src/constants.ts'),'Shared health policy must enter source-hash provenance');
  const normal=result.cases.find(c=>c.name==='giant-landing');
  assert.deepEqual(result.cases.find(c=>c.name==='giant-hit-keeps-throw').calls,normal.calls);
});

test('capture executes a present canonical health helper instead of dropping or stubbing the hit',async()=>{
  const troop=await sourceRead('apps/web/src/game/v2/troop.ts');
  const ast=ts.createSourceFile('troop.ts',troop,ts.ScriptTarget.Latest,true);
  const owner=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V2TroopFx');
  const hit=owner.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)==='onHit');
  const sync=owner.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)==='syncHealth');
  // Legacy sources had inline health handling. Inject the same delegation only
  // in this in-memory failure probe; no source/master or expected fixture changes.
  const edited=sync
    ? troop.slice(0,sync.body.pos)+' { throw new Error("canonical-health-helper-executed"); }'+troop.slice(sync.body.end)
    : troop.slice(0,hit.body.pos)+' { this.syncHealth(); }\n syncHealth() { throw new Error("canonical-health-helper-executed"); }'+troop.slice(hit.body.end);
  const read=async name=>name==='apps/web/src/game/v2/troop.ts'?edited:
    name==='packages/shared/src/constants.ts'&&!sync?'export const BATTLE_BODY_PRESENTATION = {};':sourceRead(name);
  await assert.rejects(captureGiantLanding(ts,read,compile),/canonical-health-helper-executed/);
});
