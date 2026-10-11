import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {captureSensoryPolicy,captureEventHaptics} from './sensory-policy.mjs';
import {sourcePaths} from './source-layout.mjs';
const expected=JSON.parse(await readFile(new URL('../renderer/src/test/resources/sensory/source-reference.json',import.meta.url),'utf8'));
test('sensory policy and camera samples execute the pinned juice and installed Phaser implementations',async()=>{
  assert.deepEqual(await captureSensoryPolicy(path.resolve(process.env.PKW_NATIVE_SOURCE??'.source')),expected);
});
test('source proof covers dependency locks and juice outside the game directory dirty gate',()=>{
  for(const name of ['apps/web/src/lib/juice.ts','apps/web/package.json','pnpm-lock.yaml'])assert.ok(sourcePaths.includes(name));
  assert.ok(expected.policy.sourceHashes['phaser/Shake.js']);assert.ok(expected.policy.sourceHashes['phaser/Config.js']);
});
test('random extrema scale with viewport and inverse native camera zoom without an invented damping envelope',()=>{
  for(const zoom of [.5,1,2]) {
    const samples=expected.samples.filter(s=>s.zoom===zoom);
    assert.equal(samples.find(s=>s.random===.5).x,0);
    assert.ok(samples.find(s=>s.random===0).x<0);
    assert.ok(samples.find(s=>s.random===.999).x>0);
  }
});

test('event haptics preserve source patterns and ordering without a shake-budget or strength priority',()=>{
  assert.deepEqual(expected.policy.eventHaptics.patterns,{light:[10],medium:[25],heavy:[35,30,45]});
  assert.deepEqual(expected.eventCases.find(c=>c.name==='same-time-source-order').calls,['heavy','medium','light','light']);
  for(const name of ['destroyed-repeated','trap-repeated'])assert.deepEqual(expected.eventCases.find(c=>c.name===name).calls,['light','light']);
  for(const name of ['star-cold','rally-cold','destroyed-cold','trap-cold','destroyed-missing','trap-missing'])assert.deepEqual(expected.eventCases.find(c=>c.name===name).calls,[]);
});

test('service destroyed events keep the ordinary light collapse haptic and follow the canonical Market and berth routes',async()=>{
  // Rewritten 2026-10-10 (D21, native parity with the lock source 427381a2, the night server line production deploys).
  // The earlier version injected the codex line's service branch (isPhaseEBuilding ... return before haptic('light'),
  // backend 0f07cd39) into the pinned dispatcher. 427381a2 has no such branch: onDestroyed plays haptic('light') for
  // EVERY live collapse, service buildings included, before the Market/berth routing; a cold (jumping) collapse stays
  // silent. The native renderer must therefore buzz once on a live service collapse; every type and body is executed.
  const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
  const ts=(await import(pathToFileURL(path.join(source,'scripts/node_modules/typescript/lib/typescript.js')).href)).default;
  const reads=[],serviceReads=[];
  const read=async name=>{reads.push(name);return readFile(path.join(source,name),'utf8');};
  const readService=async name=>{serviceReads.push(name);return readFile(path.join(source,name),'utf8');};
  const compile=(text,bindings={})=>new Function(...Object.keys(bindings),ts.transpile(text,{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
  const battle=await readFile(path.join(source,'apps/web/src/game/scenes/BattleScene.ts'),'utf8');
  assert.ok(battle.includes('this.ownsMarketArt(')&&!battle.includes('isPhaseEBuilding'),'selected source is the Market/berth controller line');
  const captured=await captureEventHaptics(ts,read,compile,expected.policy.eventHaptics.patterns,readService);
  // Only the type list is read through the separate provenance reader, so the policy hashes (and the pack) do not move.
  assert.deepEqual(serviceReads,['packages/shared/src/constants.ts']);assert.ok(!reads.includes('packages/shared/src/constants.ts'));
  const bodies={workshop:['controller','pending','ordinary'],lodge:['controller','pending','ordinary'],market:['controller','pending','ordinary'],
    harvester:['controller','pending','unpresented'],berth:['controller','pending']};
  for(const [type,variants] of Object.entries(bodies))for(const variant of variants)for(const live of [true,false]) {
    const name=`service-${type}-${variant}-${live?'live':'cold'}`;
    const record=captured.cases.find(c=>c.name===name);assert.ok(record,name);
    assert.deepEqual(record.calls,live?['light']:[],`${name}: the ordinary collapse haptic`);
    const owner=type==='berth'?'berth':'market';
    const routes=live
      ?(variant==='controller'?[[owner,'collapse']]:variant==='ordinary'?[['damage','collapse']]:[[`${owner}Fallback`,'destroyed']])
      :[['damage','destroy'],...(variant==='controller'?[[owner,'destroy']]:[]),...(variant==='ordinary'?[]:[[`${owner}Fallback`,'destroyed']])];
    assert.deepEqual(record.routes,routes,name);
  }
  assert.equal(captured.cases.filter(c=>c.name.startsWith('service-')).length,Object.values(bodies).flat().length*2,'no canonical service probe is dropped');
  assert.deepEqual(captured.cases,expected.eventCases);
  assert.deepEqual(captured.policy.fixed,expected.policy.eventHaptics.fixed);
  const constants=await readFile(path.join(source,'packages/shared/src/constants.ts'),'utf8');
  assert.deepEqual(expected.serviceSourceHashes,{'packages/shared/src/constants.ts':createHash('sha256').update(constants).digest('hex')});
});

test('event haptics execute the selected BattleScene with its authentic Market ownership dependency',async()=>{
  const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
  const ts=(await import(pathToFileURL(path.join(source,'scripts/node_modules/typescript/lib/typescript.js')).href)).default;
  const texts={};let owner;
  const read=async name=>texts[name]=await readFile(path.join(source,name),'utf8');
  const compile=(text,bindings={})=>{
    const value=new Function(...Object.keys(bindings),ts.transpile(text,{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
    if(text.includes('return BattleScene.prototype;'))owner=value;
    return value;
  };
  // This is the unmodified selected source, including current onDestroyed.
  // Historical source-reference remains untouched: compare only its event
  // haptic contract, not unrelated source hashes or rendering sample captures.
  const captured=await captureEventHaptics(ts,read,compile,expected.policy.eventHaptics.patterns);
  const {deployment,...eventPolicy}=expected.policy.eventHaptics;
  assert.deepEqual(captured.policy,eventPolicy);
  assert.deepEqual(captured.cases.filter(c=>!c.name.startsWith('service-')),
    expected.eventCases.filter(c=>!c.name.startsWith('service-')));
  if(texts['apps/web/src/game/scenes/BattleScene.ts'].includes('this.ownsMarketArt(')) {
    assert.equal(typeof owner.ownsMarketArt,'function');
    assert.ok(texts['apps/web/src/game/world/marketArt.ts']);
    // Both positive and negative inputs guard against replacing the authentic
    // method, family predicate or frame grammar with a constant probe stub.
    assert.equal(owner.ownsMarketArt({type:'cannon',key:'bld_cannon',artMode:'market'}),true);
    for(const type of ['market','workshop','lodge']) {
      assert.equal(owner.ownsMarketArt({type,key:`pe_${type}_t1_idle_f1`}),true,type);
      assert.equal(owner.ownsMarketArt({type,key:`bld_${type}`}),false,type);
      assert.equal(owner.ownsMarketArt({type,key:`pe_${type}_t1_idle_f1_bad`}),false,type);
    }
    assert.equal(owner.ownsMarketArt({type:'cannon',key:'pe_market_t1_idle_f1'}),false);
    for(const missing of ['marketArtFamilyOf','MARKET_FRAME_KEY']) {
      const brokenRead=async name=>name==='apps/web/src/game/world/marketArt.ts'
        ?texts[name].replaceAll(missing,`${missing}_removed`):texts[name];
      await assert.rejects(captureEventHaptics(ts,brokenRead,compile,expected.policy.eventHaptics.patterns),
        /Missing canonical Market ownership dependency/);
    }
  }
});

test('mortar landing uses the actual released projectile callback once and survives later collapse',()=>{
  const cases=Object.fromEntries(expected.mortarCases.map(c=>[c.name,c]));
  assert.deepEqual(expected.policy.mortarLanding.effects,[{kind:'shake',duration:150,intensity:.004},{kind:'haptic',strength:'medium'}]);
  const normal=cases['mortar-landing'];assert.equal(normal.launches,1);assert.deepEqual(normal.before,[]);assert.deepEqual(normal.early,[]);
  assert.deepEqual(normal.calls,cases['collapse-after-release'].calls);
  for(const name of ['missing-fire','missing-travel','missing-texture','collapse-before-release','cleared-flight-never-completes','cannon-has-no-heavy-callback'])
    assert.deepEqual(cases[name].calls,[],name);
  assert.deepEqual(cases['double-rate-landing'].calls.map(c=>c.at),normal.calls.map(c=>c.at/2));
  for(const name of ['defense','projectiles','clips','effects'])assert.ok(expected.policy.sourceHashes[`apps/web/src/game/v2/${name}.ts`]);
});

test('actual live replacement guard preserves unchanged in-flight pools and clears corrected rendered actor history',()=>{
  const cases=Object.fromEntries(expected.mortarRevisions.map(c=>[c.name,c]));
  for(const name of ['append-before-release','append-after-release','future-correction'])assert.equal(cases[name].clears,0,name);
  for(const name of ['corrected-fire','inserted-rendered-hit','reordered-rendered-actor']) {
    assert.equal(cases[name].clears,1,name);assert.deepEqual(cases[name].changed,['mortar']);
  }
});

test('Giant rich throw owns one landing after its actual ticker release and keeps the source fallback silence',()=>{
  const cases=Object.fromEntries(expected.giantCases.map(c=>[c.name,c]));
  assert.deepEqual(expected.policy.giantLanding.effects,expected.policy.mortarLanding.effects);
  assert.equal(expected.policy.giantLanding.requiresRichThrow,true);
  const normal=cases['giant-landing'];assert.equal(normal.launches,1);assert.deepEqual(normal.before,[]);assert.deepEqual(normal.early,[]);
  for(const name of ['giant-after','giant-destroy-after','giant-hit-keeps-throw'])assert.deepEqual(cases[name].calls,normal.calls,name);
  for(const name of ['giant-missing-actor','giant-missing-throw','giant-missing-travel','giant-missing-texture',
    'giant-already','giant-before','giant-destroy-before','giant-compact-no-feedback','giant-hero-no-feedback',
    'giant-cleared-pool','giant-cold-dispatch'])assert.deepEqual(cases[name].calls,[],name);
  assert.equal(cases['giant-compact-no-feedback'].launches,1);assert.equal(cases['giant-hero-no-feedback'].legacy,1);
  assert.deepEqual(cases['giant-double-rate'].calls.map(c=>c.at),normal.calls.map(c=>c.at/2));
  for(const name of ['troop','ticker'])assert.ok(expected.policy.sourceHashes[`apps/web/src/game/v2/${name}.ts`]);
});

test('actual Giant ticker registration owns target and phase through melee interruption and repeated throw cues',()=>{
  const cases=Object.fromEntries(expected.giantCases.map(c=>[c.name,c]));const normal=cases['giant-landing'];
  assert.equal(cases['giant-melee-before-release'].launches,0);assert.deepEqual(cases['giant-melee-before-release'].calls,[]);
  for(const name of ['giant-identical-throw-keeps-first','giant-hysteresis-keeps-callback','giant-row-throw-keeps-phase','giant-same-after-release','giant-row-after-release','giant-melee-after-release']) {
    assert.equal(cases[name].launches,1,name);assert.deepEqual(cases[name].calls,normal.calls,name);
  }
  assert.deepEqual(cases['giant-row-throw-keeps-phase'].impacts,[{x:-300,y:200}]);
  for(const name of ['giant-identical-throw-keeps-first','giant-hysteresis-keeps-callback','giant-same-after-release','giant-row-after-release','giant-melee-after-release'])
    assert.deepEqual(cases[name].impacts,[{x:100,y:200}],name);
});

test('actual source onPos changes facing after throw completion before the next hysteresis decision',()=>{
  const walk=expected.giantCases.find(c=>c.name==='giant-completed-throw-walk-facing');
  assert.deepEqual(walk.facings,['s','w','w']);
});

test('cold dispatcher never donates a suppressed throw phase to a later live throw',()=>{
  const normal=expected.giantCases.find(c=>c.name==='giant-landing');
  for(const name of ['giant-cold-then-live-throw','giant-cold-then-live-row']) {
    const future=expected.giantCases.find(c=>c.name===name);
    assert.equal(future.launches,1);assert.deepEqual(future.before,[]);assert.deepEqual(future.early,[]);
    assert.deepEqual(future.calls,normal.calls.map(c=>({...c,at:c.at+future.wakeAt})));
    assert.deepEqual(future.impacts,[{x:future.wakeRow?-300:100,y:200}]);
  }
});

test('actual Keg scene and wrapper keep authored rich release distinct from immediate fallbacks',()=>{
  const cases=Object.fromEntries(expected.kegCases.map(c=>[c.name,c]));const normal=cases['keg-rich'];
  assert.deepEqual(normal.immediate,[]);assert.deepEqual(normal.early,[]);
  assert.deepEqual(expected.policy.kegDetonation.effects,expected.policy.mortarLanding.effects);
  for(const name of ['keg-compact','keg-legacy','keg-missing-actor','keg-missing-profile','keg-missing-clip','keg-death-before'])
    assert.deepEqual(cases[name].calls.map(c=>c.at),[0,0],name);
  assert.deepEqual(cases['keg-missing-effect'].calls,normal.calls);assert.deepEqual(cases['keg-missing-effect'].effects,[]);
  assert.deepEqual(cases['keg-cue-missing'].calls,normal.calls);
  assert.ok(cases['keg-cue-outside'].release>normal.release);
  assert.deepEqual(cases['keg-cue-outside'].early,[]);assert.equal(cases['keg-cue-outside'].calls.length,2);
});
test('actual Keg dying callback survives later ordinary death but teardown and cold suppress it',()=>{
  const cases=Object.fromEntries(expected.kegCases.map(c=>[c.name,c]));const normal=cases['keg-rich'];
  assert.deepEqual(cases['keg-death-after'].calls,normal.calls);
  for(const name of ['keg-ordinary-death','keg-death-destroy','keg-cold'])assert.deepEqual(cases[name].calls,[],name);
  assert.deepEqual(cases['keg-double-rate'].calls.map(c=>c.at),normal.calls.map(c=>c.at/2));
  assert.deepEqual(cases['keg-duplicate'].calls,[...normal.calls.map(c=>({...c,at:0})),...normal.calls]);
  const wake=cases['keg-cold-then-live'];assert.deepEqual(wake.calls,normal.calls.map(c=>({...c,at:c.at+wake.wakeAt})));
});

test('deployment source markers match FIFO troop hero tile and duplicate actor deliveries do not consume another tap',()=>{
  const cases=expected.deployment.cases;
  const value=name=>cases.find(c=>c.name===name);
  assert.deepEqual(expected.policy.eventHaptics.deployment,{haptic:'light',matching:'troopHeroTile',echo:'firstActor',lifetime:'scene'});
  assert.deepEqual(value('stack-fifo').remaining,['b']);
  assert.deepEqual(value('refusal-newest').remaining,['a']);
  assert.deepEqual(value('duplicate-does-not-consume-next').remaining,['b']);
  for(const name of ['wrong-troop','wrong-tile'])assert.deepEqual(value(name).remaining,['a']);
  for(const name of ['hero-distinct','negative-tile','cold-matched'])assert.deepEqual(value(name).remaining,[]);
  assert.deepEqual(value('cold-unmarked').calls,[]);
  for(const name of ['spawn-is-not-deploy','brood-is-not-deploy'])assert.deepEqual(value(name).calls,[]);
  assert.deepEqual(value('same-id-after-death').calls,['light','light']);
});
test('source markers have scene lifetime with no timeout or playback correction expiry',()=>{
  assert.deepEqual(expected.deployment.cleanup,{destroyed:['a','b'],remaining:[],writeOwners:
    ['addDeployMark','cleanupBattle','onDeploy','rebuildDeployMarks','removeDeployMark']});
  const queue=name=>expected.deployment.queues.find(c=>c.name===name);
  assert.deepEqual(queue('accepted').done,[true]);assert.deepEqual(queue('refused').done,[false]);
  assert.deepEqual(queue('unknown-retained').done,[]);assert.equal(queue('unknown-retained').waits.length,1);
  assert.deepEqual(queue('unknown-recovered').done,[true]);assert.deepEqual(queue('unknown-refused').done,[false]);
  assert.deepEqual(queue('replaced-session').done,[]);
});
