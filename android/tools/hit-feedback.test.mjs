import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {captureHitFeedback,hitStaticHeights} from './hit-feedback.mjs';
const expected=JSON.parse(await readFile(new URL('../renderer/src/test/resources/hit-feedback/source-reference.json',import.meta.url),'utf8'));
test('exact canonical ordinary and chain handlers generate policy and all boundary cases',async()=>{
  // Persisted JSON omits the absent combat state of missing/destroyed services.
  // The direct service probes below still assert that those handlers leave it undefined.
  const actual=await captureHitFeedback(path.resolve(process.env.PKW_NATIVE_SOURCE??'.source'));
  assert.deepEqual(JSON.parse(JSON.stringify(actual)),expected);
});
test('hit feedback executes the selected BattleScene with its authentic Market ownership dependency',async()=>{
  const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
  const captured=await captureHitFeedback(source);
  const {sourceHashes,...policy}=captured.policy;
  const {sourceHashes:historicalHashes,...historicalPolicy}=expected.policy;
  // Current source hashes differ legitimately. Keep the historical fixture
  // unchanged while comparing every policy value and ordinary boundary case.
  assert.deepEqual(policy,historicalPolicy);
  assert.deepEqual(captured.cases.filter(c=>!c.name.startsWith('service-')),
    expected.cases.filter(c=>!c.name.startsWith('service-')));
  assert.deepEqual(captured.bodyOrdering,expected.bodyOrdering);
  const battleName='apps/web/src/game/scenes/BattleScene.ts';
  const battle=await readFile(path.join(source,battleName),'utf8');
  assert.equal(sourceHashes[battleName],createHash('sha256').update(battle).digest('hex'));
  if(battle.includes('this.ownsMarketArt(')) {
    const marketName='apps/web/src/game/world/marketArt.ts';
    const market=await readFile(path.join(source,marketName),'utf8');
    assert.equal(sourceHashes[marketName],createHash('sha256').update(market).digest('hex'));
    const ts=(await import(pathToFileURL(path.join(source,'scripts/node_modules/typescript/lib/typescript.js')).href)).default;
    const battleAst=ts.createSourceFile(battleName,battle,ts.ScriptTarget.Latest,true);
    const cls=battleAst.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='BattleScene');
    const owns=cls.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(battleAst)==='ownsMarketArt');
    const marketAst=ts.createSourceFile(marketName,market,ts.ScriptTarget.Latest,true);
    const family=marketAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='marketArtFamilyOf');
    // A source-body sentinel proves the actual method and nested predicate run;
    // a substituted false stub would swallow these expected failures.
    for(const [file,text,ast,node,marker] of [
      [battleName,battle,battleAst,owns,'canonical-market-owner-executed'],
      [marketName,market,marketAst,family,'canonical-market-family-executed'],
    ]) {
      assert.ok(node?.body);
      const at=node.body.getStart(ast)+1;
      const changed=text.slice(0,at)+`throw new Error('${marker}');`+text.slice(at);
      await assert.rejects(captureHitFeedback(source,undefined,(name,encoding)=>
        path.relative(source,name)===file?Promise.resolve(changed):readFile(name,encoding)),new RegExp(marker));
    }
    await assert.rejects(captureHitFeedback(source,undefined,(name,encoding)=>
      path.relative(source,name)===marketName?Promise.resolve(market.replaceAll('MARKET_FRAME_KEY','REMOVED_MARKET_FRAME_KEY')):readFile(name,encoding)),
      /Missing hit feedback constant MARKET_FRAME_KEY/);
  }
});
test('service hits follow the canonical Market and berth routes and keep the ordinary hit cue',async()=>{
  // Rewritten 2026-10-10 (D21, native parity with the lock source 427381a2, the night server line production deploys).
  // The earlier version injected the codex line's service predicate (isPhaseEBuilding, phaseECombat, syncPhaseEServices,
  // 6f7a9e81) into the pinned scene. 427381a2 has no such predicate: a service body takes the ordinary star and HP
  // mirror, and below half HP its Market or berth controller, or the static fallback, shows the damaged cell. Only a
  // body that is NOT Market-art owned (a legacy bld_ key) still takes the generic damage overlay. Native parity means
  // the native renderer must keep exactly these cues, so every type, body, mode and HP boundary is executed here.
  const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
  const battle=await readFile(path.join(source,'apps/web/src/game/scenes/BattleScene.ts'),'utf8');
  assert.ok(battle.includes('this.ownsMarketArt(')&&!battle.includes('isPhaseEBuilding'),'selected source is the Market/berth controller line');
  const captured=await captureHitFeedback(source);
  const constants=await readFile(path.join(source,'packages/shared/src/constants.ts'),'utf8');
  assert.deepEqual(captured.serviceSourceHashes,{'packages/shared/src/constants.ts':createHash('sha256').update(constants).digest('hex')});
  const types=['workshop','lodge','market','harvester','berth'];
  const bodies={workshop:['controller','pending','ordinary'],lodge:['controller','pending','ordinary'],market:['controller','pending','ordinary'],
    harvester:['controller','pending','unpresented'],berth:['controller','pending']};
  for(const type of types)for(const variant of bodies[type])for(const jumping of [false,true])for(const damage of [0,49,50,51,200]) {
    const name=`service-${type}-${variant}-${jumping?'cold':'live'}-${damage}`;
    const record=captured.cases.find(c=>c.name===name);assert.ok(record,name);
    assert.equal(record.hp,Math.max(0,100-damage),name);
    assert.deepEqual(record.stars,jumping?[]:[{x:5,y:8-expected.policy.buildingLiftMax}],`${name}: the ordinary live hit cue`);
    assert.equal(record.damageUpdates,variant==='ordinary'?1:0,`${name}: only a bld_-keyed body takes the generic damage overlay`);
    const below=damage>50;const owner=type==='berth'?'berth':'market';
    assert.deepEqual(record.routes,!below||variant==='ordinary'?[]:variant==='controller'?[[owner,'setDamaged',true]]:[[`${owner}Fallback`,'damaged']],name);
  }
  for(const type of types)for(const absent of ['destroyed','missing']) {
    const record=captured.cases.find(c=>c.name===`service-${type}-${absent}`);
    assert.equal(record.hp,100);assert.equal(record.damageUpdates,0);assert.deepEqual(record.routes,[]);assert.deepEqual(record.stars,[]);
  }
  assert.equal(captured.cases.filter(c=>c.name.startsWith('service-')).length,
    types.reduce((n,type)=>n+bodies[type].length*2*5+2,0),'no canonical service probe is dropped');
  assert.deepEqual(captured.cases.filter(c=>!c.name.startsWith('service-')),expected.cases.filter(c=>!c.name.startsWith('service-')));
  // The service type list comes from the source constant, never a local copy.
  await assert.rejects(captureHitFeedback(source,undefined,(name,encoding)=>
    path.relative(source,name)==='packages/shared/src/constants.ts'?Promise.resolve(constants.replaceAll('PHASE_E_BUILDINGS','REMOVED_PHASE_E_BUILDINGS')):readFile(name,encoding)),
    /Missing hit feedback constant PHASE_E_BUILDINGS/);
});
test('the production flash and hit spark are distinct from the unrelated three-frame v2 hit',()=>{
  assert.deepEqual(expected.policy.star.frames.map(x=>x.key),['fx_hit_f1','fx_hit_f2']);
  assert.equal(expected.cases.find(x=>x.name==='actor-zero').stars.length,1);
  assert.equal(expected.cases.find(x=>x.name==='chain-zero').stars.length,0);
  assert.equal(expected.cases.find(x=>x.name==='chain-positive').stars.length,1);
});
test('static fallback uses full untrimmed admitted height and cannot guess missing art',()=>{
  const e=[{frameKey:'frame',atlasPath:'atlas',scale:2}];
  assert.deepEqual(hitStaticHeights(e,new Map([['atlas',new Map([['frame',{w:10,h:20}]])]])),{frame:40});
  assert.throws(()=>hitStaticHeights(e,new Map()),/Missing admitted/);
});

test('wall hit anchors use the drawn context canvas rather than the smaller tier baseline',()=>{
  const entries=[{type:'wall',frameKey:'wall',atlasPath:'atlas',scale:2}];
  const frames=new Map([['atlas',new Map([['wall',{w:32,h:20}]])]]);
  assert.deepEqual(hitStaticHeights(entries,frames,{constants:{contextFrameHeight:60,drawScale:2}}),{wall:120});
  assert.deepEqual(hitStaticHeights(entries,frames),{wall:40});
});


test('source captures preserve the exporter global TypeScript loader for later shared barrel imports',()=>{
  const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
  const script=`
    import assert from 'node:assert/strict';
    import {pathToFileURL} from 'node:url';
    import path from 'node:path';
    import {captureSensoryPolicy} from ${JSON.stringify(new URL('./sensory-policy.mjs',import.meta.url).href)};
    import {captureHitFeedback} from ${JSON.stringify(new URL('./hit-feedback.mjs',import.meta.url).href)};
    const source=${JSON.stringify(source)};
    const load=relative=>import(pathToFileURL(path.join(source,relative)).href);
    const sensory=await captureSensoryPolicy(source);
    const hit=await captureHitFeedback(source,load);
    const shared=await load('packages/shared/src/index.ts');
    assert.equal(typeof shared.atlasGroupFor,'function');
    assert.equal(sensory.policy.version,1);
    assert.deepEqual(hit.policy,${JSON.stringify(expected.policy)});
    process.stdout.write('global-loader-preserved');
  `;
  // The real exporter installs this loader once. Namespaced tsImport registration inside
  // a capture previously broke the later extensionless shared barrel imports.
  const result=spawnSync(process.execPath,['--import',pathToFileURL(path.join(source,'scripts/node_modules/tsx/dist/loader.mjs')).href,
    '--input-type=module','--eval',script],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr||String(result.error));
  assert.equal(result.stdout,'global-loader-preserved');
});

test('hidden service hit height is bound to the installed Phaser missing PNG and the canonical pending spawn',async()=>{
  // Rewritten 2026-10-10 (D21): the old pin bound the codex line's phaseE/building.ts, which reset held art to the
  // 4x4 __WHITE image; 427381a2 has no such controller. There, a service body whose family art is not resident is
  // spawned hidden and frameless on its unloaded atlas key (BattleScene.spawnBuilding `pending`), Phaser resolves an
  // unknown texture key to __MISSING (Config images.missing, one __BASE frame) at seat scale 1, and the hit star lifts
  // by half that displayHeight. The native renderer uses these pinned dimensions while service pixels are not current.
  const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
  const pinned=JSON.parse(await readFile(new URL('../renderer/src/test/resources/hit-feedback/hidden-service-body.json',import.meta.url),'utf8'));
  const req=createRequire(path.join(source,'apps/web/package.json'));
  const phaser=path.dirname(req.resolve('phaser/package.json'));
  const files={
    'phaser/src/core/Config.js':path.join(phaser,'src/core/Config.js'),
    'phaser/src/textures/TextureManager.js':path.join(phaser,'src/textures/TextureManager.js'),
    'apps/web/src/game/scenes/BattleScene.ts':path.join(source,'apps/web/src/game/scenes/BattleScene.ts'),
    'apps/web/src/game/world/atlasLoader.ts':path.join(source,'apps/web/src/game/world/atlasLoader.ts'),
  };
  const text=Object.fromEntries(await Promise.all(Object.entries(files).map(async([name,file])=>[name,await readFile(file,'utf8')])));
  const config=text['phaser/src/core/Config.js'];
  const prefix=config.match(/var pngPrefix = 'data:image\/png;base64,([^']+)'/)[1];
  const png=Buffer.from(prefix+config.match(/this\.missingImage = GetValue\(config, 'images\.missing', pngPrefix \+ '([^']+)'\)/)[1],'base64');
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.subarray(12,16).toString(),'IHDR');
  assert.equal(pinned.image,'images.missing');
  assert.equal(png.readUInt32BE(16),pinned.width);assert.equal(png.readUInt32BE(20),pinned.height);
  assert.match(text['phaser/src/textures/TextureManager.js'],/return this\.list\['__MISSING'\];/);
  const battle=text['apps/web/src/game/scenes/BattleScene.ts'];
  for(const line of ["&& !isV2AtlasLoaded(this, atlasFor(key)));","? this.add.sprite((b.tx + fw / 2) * T + seat.offsetGamePx[0] * V2_DRAW_SCALE, 0, spawnAtlas)",
    "if (pending) s.setVisible(false);"])assert.ok(battle.includes(line),line);
  assert.match(text['apps/web/src/game/world/atlasLoader.ts'],/return scene\.textures\.exists\(group\);/);
  assert.equal(req('phaser/package.json').version,pinned.phaserVersion);
  for(const [name,value] of Object.entries(text))assert.equal(createHash('sha256').update(value).digest('hex'),pinned.sourceHashes[name],name);
  assert.deepEqual(Object.keys(pinned.sourceHashes).sort(),Object.keys(files).sort());
});
