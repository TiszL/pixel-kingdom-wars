import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildWalls5Section,captureWallDamageStages} from './walls5-catalog.mjs';
const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
const load=relative=>import(pathToFileURL(path.join(source,relative)).href);
const {tsImport}=await load('scripts/node_modules/tsx/dist/esm/api/index.mjs');
const typed=relative=>tsImport(pathToFileURL(path.join(source,relative)).href,import.meta.url);
const ts=(await load('scripts/node_modules/typescript/lib/typescript.js')).default;
const constants=await typed('packages/shared/src/constants.ts');
const wallArt=await typed('packages/shared/src/wallArt.ts');
const wallRender=await typed('packages/shared/src/wallRender.ts');
const wallConnect=await typed('packages/shared/src/wallConnect.ts');
const publicRoot=path.join(source,'apps/web/public');
const meta=JSON.parse(await readFile(path.join(publicRoot,'atlas/meta.json'),'utf8'));
const atlas=JSON.parse(await readFile(path.join(publicRoot,'atlas/wall5@1x.json'),'utf8'));
const entries=atlas.textures.flatMap((texture)=>texture.frames.map((frame)=>[frame.filename,frame.sourceSize??frame.frame]));
const index=new Map(entries.map(([key])=>[key,'atlas/wall5@1x.json']));
const atlasFrames=new Map([['atlas/wall5@1x.json',new Map(entries)]]);
const wallRenderText=await readFile(path.join(source,'packages/shared/src/wallRender.ts'),'utf8');
function expression(name) {
  const ast=ts.createSourceFile('wallRender.ts',wallRenderText,ts.ScriptTarget.Latest,true);const found=[];
  const visit=(node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)===name&&node.initializer)found.push(node.initializer.getText(ast));ts.forEachChild(node,visit);};
  visit(ast);assert.equal(found.length,1,name);
  return new Function(ts.transpile(`return (${found[0]});`,{target:ts.ScriptTarget.ES2022}))();
}
const expressions=Object.fromEntries(['PALETTES','DIR','DIAG','edgeWeight'].map((name)=>[name,expression(name)]));
const options=()=>({constants,wallArt,wallRender,wallConnect,meta,index,atlasFrames,levelCount:constants.LEVEL_STEP_BUILDING.length,expressions});

test('walls5 section carries every wall5 cell, the five-tier level mapping and WALL_ART thresholds from source',()=>{
  const section=buildWalls5Section(options());
  const {WALL_ART}=constants;
  assert.equal(section.atlasPath,'atlas/wall5@1x.json');
  assert.deepEqual(section.constants,WALL_ART);
  assert.deepEqual(section.tierOfLevel,Array.from({length:constants.LEVEL_STEP_BUILDING.length},(_,i)=>Math.min(WALL_ART.tiers,Math.ceil((i+1)/WALL_ART.levelsPerTier))));
  assert.equal(section.shapesByMask.length,16);assert.equal(section.shapesByMask[10],'straight');assert.equal(section.shapesByMask[3],'corner_sw');
  let keys=0;for(const tier of Object.values(section.frames))for(const shape of Object.values(tier))for(const [state,list] of Object.entries(shape)){keys+=list.length;assert.equal(list.length,section.frameCounts[state]);}
  assert.equal(keys,WALL_ART.tiers*16*(1+2+WALL_ART.collapseFrames));
  assert.equal(section.frames[5].cross.collapse.at(-1),'wall5_t5_cross_collapse_f4');
  assert.deepEqual(section.cells[5],{width:WALL_ART.sourceTileSize,height:WALL_ART.sourceFrameHeights[4]});
  assert.equal(section.damageStages.light.below,WALL_ART.lightDamageBelow);
  assert.equal(section.damageStages.heavy.below,WALL_ART.heavyDamageBelow);
  assert.equal(section.collapse.durationMs,1000*WALL_ART.collapseFrames/WALL_ART.collapseFps);
  assert.deepEqual(section.seat,{anchor:[0.5,1],scale:WALL_ART.drawScale,offsetX:0,offsetY:0,contextFrame:{width:WALL_ART.sourceTileSize,height:WALL_ART.contextFrameHeight}});
});
test('compositor inputs are executed from wallRender rather than restated, and goldens hash the canonical frames',()=>{
  const section=buildWalls5Section(options());
  const c=section.compositor;
  assert.equal(c.palettes.length,constants.WALL_ART.tiers);
  assert.deepEqual(c.bodyHeights,constants.WALL_ART.sourceFrameHeights.map((h)=>h-constants.WALL_ART.sourceBodyOffset));
  assert.equal(c.shoulderEdgeWeights.length,32);assert.equal(c.shoulderEdgeWeights[0],c.shoulderEdgeWeights[31]);
  assert.ok(c.radius.corner>c.radius.isolated&&c.radius.isolated>c.radius.straight,'radius classes come from resolveWall probes');
  assert.ok(c.vectors.length>=20);
  for(const vector of c.vectors) {
    assert.match(vector.rgbaSha256,/^[0-9a-f]{64}$/);
    assert.equal(vector.width,constants.WALL_ART.sourceTileSize);assert.equal(vector.height,constants.WALL_ART.contextFrameHeight);
    assert.deepEqual(vector.anchor,[constants.WALL_ART.sourceTileSize/2,constants.WALL_ART.contextFrameHeight]);
  }
  const post=c.vectors.find((v)=>v.name==='post_t1');
  const grid=new Map(post.grid.map(([x,y,tier])=>[`${x},${y}`,{tier}]));
  const frame=wallRender.composeWall(grid,0,0);
  assert.equal(createHash('sha256').update(frame.data).digest('hex'),post.rgbaSha256,'goldens are reproducible from the canonical compositor');
  assert.notEqual(c.vectors.find((v)=>v.name==='light_damage_t3').rgbaSha256,c.vectors.find((v)=>v.name==='heavy_damage_t3').rgbaSha256);
  assert.notEqual(c.vectors.find((v)=>v.name==='collapse_t3_p0').rgbaSha256,c.vectors.find((v)=>v.name==='collapse_t3_p1').rgbaSha256);
});
test('a missing atlas cell, a changed sprite seat or a mask table disagreement refuses the section',()=>{
  const missing=options();missing.index=new Map(index);missing.index.delete('wall5_t3_tee_w_damaged_f2');
  assert.throws(()=>buildWalls5Section(missing),/missing atlas cell wall5_t3_tee_w_damaged_f2/);
  const seat=options();seat.meta={...meta,sprites:{...meta.sprites,wall5_t1_post_intact_f1:{...meta.sprites.wall5_t1_post_intact_f1,anchor:[0.5,0.5]}}};
  assert.throws(()=>buildWalls5Section(seat),/sprite metadata changed/);
  const table=options();table.wallConnect={wallShape:(n)=>n.n&&n.e&&!n.s&&!n.w?'corner_ne':wallConnect.wallShape(n)};
  assert.throws(()=>buildWalls5Section(table),/mask 3 selects corner_ne/);
  const sized=options();sized.atlasFrames=new Map([['atlas/wall5@1x.json',new Map([...atlasFrames.get('atlas/wall5@1x.json')].map(([k,v])=>[k,k==='wall5_t2_ns_intact_f1'?{w:32,h:44}:v]))]]);
  assert.throws(()=>buildWalls5Section(sized),/expected 32x48/);
});
test('damage stage capture proves both thresholds and the collapsed/intact fallbacks from the canonical helper',()=>{
  assert.deepEqual(captureWallDamageStages(wallArt.wallDamageStage,constants.WALL_ART),{
    intact:{stage:0,when:`hp >= maxHp * ${constants.WALL_ART.lightDamageBelow}`},light:{stage:1,below:constants.WALL_ART.lightDamageBelow,frame:1},
    heavy:{stage:2,below:constants.WALL_ART.heavyDamageBelow,frame:2},collapsed:{stage:3,when:'hp <= 0'}});
  assert.throws(()=>captureWallDamageStages((hp,max)=>hp<max*0.5?1:0,constants.WALL_ART),/damage stage rule changed/);
  assert.throws(()=>captureWallDamageStages((hp,max)=>hp<=0?3:hp<max*0.25?2:hp<=max*0.5?1:0,constants.WALL_ART),/damage stage rule changed/);
});
