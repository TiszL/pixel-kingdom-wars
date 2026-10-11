import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {captureResultPresentation} from './result-presentation.mjs';
import {sourcePaths} from './source-layout.mjs';
const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
const expected=JSON.parse(await readFile(new URL('../app/src/test/resources/results/source-reference.json',import.meta.url),'utf8'));
test('actual React result functions and exact deterministic rasterizer reproduce every captured field and PNG',async()=>{
  const actual=await captureResultPresentation(source);assert.deepEqual(actual.proof,expected);assert.equal(actual.outputs.length,expected.fx.length);
});
test('live victory clamp and normal legacy sound priority remain distinct from in-battle critical star events',()=>{
  assert.deepEqual(expected.policy.victory.map(c=>[c.stars,c.audio[0].legacy,c.audio[0].priority,c.haptics[0]]),[
    [0,'sfx_star_1','normal','light'],[1,'sfx_star_1','normal','light'],[2,'sfx_star_2','normal','medium'],[3,'sfx_star_3','normal','heavy'],[4,'sfx_star_3','normal','heavy']]);
  assert.deepEqual(expected.policy.defeat,{audio:[{legacy:'sfx_shield_up',family:'sfx_battle_shield_up',gain:.8,priority:'normal'}],haptics:[]});
});
test('the six literal React SVG pixels are exported without silently substituting the newer game-v4 atlas art',async()=>{
  const actual=await captureResultPresentation(source);const sharp=createRequire(path.join(source,'scripts/package.json'))('sharp');
  for(const image of expected.fx) {
    const bytes=actual.outputs.find(o=>o.path.endsWith(`/${image.name}.png`)).bytes;
    const rgba=await sharp(bytes).ensureAlpha().raw().toBuffer();
    const svg=await sharp(path.join(source,image.source)).ensureAlpha().raw().toBuffer();
    assert.deepEqual(rgba,svg,image.name);
    const newer=await sharp(path.join(source,`art/game-v4/fx/legacy-${image.name}.png`)).ensureAlpha().raw().toBuffer();
    assert.notDeepEqual(rgba,newer,image.name);
  }
});
test('all result code and art inputs participate in the clean source gate',()=>{
  for(const file of Object.keys(expected.policy.sourceHashes))assert.ok(sourcePaths.some(p=>file===p||file.startsWith(p+'/')),file);
});
test('result capture does not register a competing TS loader or disturb the next shared barrel import',()=>{
  const helper=pathToFileURL(path.resolve('tools/result-presentation.mjs')).href;
  const result=spawnSync(process.execPath,['--import',pathToFileURL(path.join(source,'scripts/node_modules/tsx/dist/loader.mjs')).href,
    '--input-type=module','-e',`import {captureResultPresentation} from ${JSON.stringify(helper)}; await captureResultPresentation(${JSON.stringify(source)}); const shared=await import(${JSON.stringify(pathToFileURL(path.join(source,'packages/shared/src/index.ts')).href)});if(!shared.GRID)throw new Error('Missing shared barrel');`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
