import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCombatCatalogue, captureHeroTransitions, assertCanonicalSlamOffset, captureGraphicsStroke, captureImageSweeps, normalizeRadialSweeps, normalizeMoonsunderSweeps, normalizeActorToEventSweeps, captureFirestormPlan } from './combat-catalog.mjs';

test('fan capture preserves one keyed attachment, finite expiry and independent reach/thickness',()=>{
  const options={body:{frames:8},fx:{},tier:1,fit:.25,drawScale:2};
  function controller(ix,iy){let fan;this.playAbilityOnce('firestorm',(frame)=>{
    if(![2,3,4].includes(frame))return;
    const maw=this.probeEmitter(this.sprite,this.clip('firestorm'),'maw',0,frame-1,this.emitterScale());
    if(!fan){fan=this.scene.add.sprite(maw.x,maw.y,'atlas','fan1').setOrigin(.1,.5).setDepth(this.sprite.depth+1);
      this.deps.ticker.play(fan,{fps:11,loop:false,onComplete:()=>fan.destroy()});}
    fan.setPosition(maw.x,maw.y).setScale(Math.hypot(ix-maw.x,iy-maw.y)/90,.5).setRotation(Math.atan2(iy-maw.y,ix-maw.x));
  });}
  const p=captureFirestormPlan(controller,options);assert.deepEqual(p.pinFrames,[2,3,4]);assert.equal(p.emitter,'maw');
  assert.equal(p.reachPx,90);assert.equal(p.scale,.5);assert.equal(p.depthOffset,1);assert.equal(p.fps,11);
  assert.throws(()=>captureFirestormPlan(controller,{...options,fit:.5}),/thickness/);
  assert.throws(()=>captureFirestormPlan(function(ix,iy){controller.call(this,ix+1,iy);},options),/facing/);
  assert.throws(()=>captureFirestormPlan(function(){this.playAbilityOnce('firestorm',()=>{});},options),/finite/);
});

test('actor projectile capture separates caster origin from target and retains absent-caster expiry',()=>{
  const art={frames:['fx_theo_snot_f1','fx_theo_snot_f2'],stepMs:90,scale:1.7,anchor:[.5,.5],depth:91};
  const active={...art,x:3,y:7,lifetimeMs:700,travel:{toX:101,toY:203,durationMs:500}};
  const fallback={...art,x:101,y:203,lifetimeMs:380};
  const probe={actorX:3,actorY:7,x:101,y:203,durationMs:500};
  assert.deepEqual(normalizeActorToEventSweeps([active],[fallback],probe)[0].travel,{mode:'actorToEvent',tailMs:200,absentActorLifetimeMs:380});
  assert.throws(()=>normalizeActorToEventSweeps([{...active,x:101}],[fallback],probe),/origin/);
  assert.throws(()=>normalizeActorToEventSweeps([active],[{...fallback,scale:2}],probe),/art/);
  assert.throws(()=>normalizeActorToEventSweeps([active],[{...fallback,lifetimeMs:700}],probe),/clock/);
  assert.throws(()=>normalizeActorToEventSweeps([active],[],probe),/probe/);
});

test('Brown Note actor projectile exports its own cadence and fallback rather than generic gas-loop timing',()=>{
  const capture=(active)=>captureImageSweeps((scene)=>{
    const image=scene.add.image(active?3:101,active?7:203,'fx','fx_theo_gasburst_f1').setScale(2);
    for(let frame=2;frame<=4;frame++) scene.time.delayedCall((frame-1)*100,()=>image.setTexture('fx',`fx_theo_gasburst_f${frame}`));
    scene.time.delayedCall(active?700:600,()=>image.destroy());
    if(active) scene.tweens.add({targets:image,x:101,y:203,duration:500,ease:'Linear'});
  },true);
  const [effect]=normalizeActorToEventSweeps(capture(true),capture(false),{actorX:3,actorY:7,x:101,y:203,durationMs:500});
  assert.equal(effect.stepMs,100);assert.equal(effect.scale,2);assert.equal(effect.frames.length,4);
  assert.equal(effect.travel.absentActorLifetimeMs,600);assert.equal(effect.lifetimeMs,700);
  assert.throws(()=>normalizeActorToEventSweeps(capture(true),capture(false).map(s=>({...s,stepMs:260})),{actorX:3,actorY:7,x:101,y:203,durationMs:500}),/clock/);
});

test('Moonsunder capture distinguishes full-range travel from a stationary troop-center cue',()=>{
  const origin={x:10,y:20,towardX:13,towardY:24,rangePx:100,durationMs:500,targetCenter:{x:71,y:83}};
  const wave={x:10,y:20,frames:['fx_vex_crescent_f1'],stepMs:90,lifetimeMs:700,travel:{toX:70,toY:100,durationMs:500}};
  const bleed={x:71,y:83,frames:['fx_vex_bleed_f1'],stepMs:120,lifetimeMs:440};
  const normalized=normalizeMoonsunderSweeps([wave,bleed],origin);
  assert.deepEqual(normalized[0].travel,{mode:'eventDirectionRange',rangePx:100,tailMs:200});
  assert.equal(normalized[1].placement,'targetActorCenterAtCast');
  assert.throws(()=>normalizeMoonsunderSweeps([wave,bleed],{...origin,targetCenter:null}),/routing/);
  assert.throws(()=>normalizeMoonsunderSweeps([{...wave,travel:{...wave.travel,toX:13}},bleed],origin),/range/);
  assert.throws(()=>normalizeMoonsunderSweeps([wave,{...bleed,x:10}],origin),/troop center/);
  const zero={...wave,travel:{...wave.travel,toX:10,toY:20}};
  assert.equal(normalizeMoonsunderSweeps([zero],{...origin,towardX:10,towardY:20,targetCenter:null})[0].travel.rangePx,100);
});

test('hero sweep capture preserves final-frame hold and refuses moving choreography as stationary', () => {
  const capture=(moving)=>captureImageSweeps((scene)=>{
    const image=scene.add.image(2,3,'fx','fx_theo_test_f1').setScale(1.7).setDepth(123);
    scene.time.delayedCall(90,()=>image.setTexture('fx','fx_theo_test_f2'));
    scene.time.delayedCall(380,()=>image.destroy());
    if(moving) scene.tweens.add({targets:image,x:99,duration:200});
  });
  assert.deepEqual(capture(false),[{x:2,y:3,frames:['fx_theo_test_f1','fx_theo_test_f2'],stepMs:90,lifetimeMs:380,depth:123,scale:1.7,anchor:[0.5,0.5]}]);
  assert.equal(capture(true),null);
});

test('travel capture preserves authored endpoints and rejects unsupported easing', () => {
  const invoke=(ease)=>(scene)=>{
    const image=scene.add.image(3,7,'fx','fx_vex_dashtrail_f1');
    scene.time.delayedCall(80,()=>image.setTexture('fx','fx_vex_dashtrail_f2'));
    scene.time.delayedCall(600,()=>image.destroy());
    scene.tweens.add({targets:image,x:103,y:207,duration:400,ease});
  };
  const [image]=captureImageSweeps(invoke('Linear'),true);
  assert.deepEqual(image.travel,{toX:103,toY:207,durationMs:400});
  assert.equal(image.stepMs,80);assert.equal(image.lifetimeMs,600);
  assert.throws(()=>captureImageSweeps(invoke('Quad.easeIn'),true),/Unsupported canonical hero travel/);
});

test('radial capture retains authored spokes and refuses a shifted origin or changed hero clock', () => {
  const origin={x:31,y:-47,durationMs:500};
  const stationary={x:31,y:-47,frames:['fx_vex_shardnova_f1'],stepMs:0,lifetimeMs:560};
  const crescent={...stationary,frames:['fx_vex_crescent_f1','fx_vex_crescent_f2'],stepMs:90,lifetimeMs:700,
    travel:{toX:-71,toY:84,durationMs:500}};
  const normalized=normalizeRadialSweeps([stationary,crescent],origin);
  assert.equal(normalized[0],stationary);
  assert.deepEqual(normalized[1].travel,{mode:'eventOffset',offsetX:-102,offsetY:131,tailMs:200});
  assert.throws(()=>normalizeRadialSweeps([{...crescent,x:0}],origin),/event origin/);
  assert.throws(()=>normalizeRadialSweeps([{...crescent,travel:{...crescent.travel,durationMs:501}}],origin),/clock/);
  assert.throws(()=>normalizeRadialSweeps([{...crescent,lifetimeMs:499}],origin),/clock/);
});

test('graphics stroke capture preserves authored styles and fails when source fade stops being linear', () => {
  const invoke = (nonlinear) => (scene) => {
    const image = scene.add.graphics().setDepth(123);
    image.lineStyle(7,0xabc123,0.3).lineBetween(1,2,3,4);
    scene.pool.add(456,(_elapsed,progress) => image.setAlpha(nonlinear ? 1-progress*progress : 1-progress));
  };
  assert.deepEqual(captureGraphicsStroke(invoke(false)),{ stroke:{ durationMs:456,depth:123,fade:'linear',layers:[{width:7,color:0xabc123,alpha:0.3}] },fromX:1,fromY:2,toX:3,toY:4 });
  assert.throws(() => captureGraphicsStroke(invoke(true)),/Unsupported canonical stroke fade/);
});

test('a lock-rejected hero callback cannot retime an earlier accepted body transition', () => {
  const transitions = [];
  captureHeroTransitions([
    { atMs: 12, callback() {} },
    { atMs: 34, callback() { transitions.push({ state: 'cast' }); } },
    { atMs: 56, callback() {} },
  ], transitions);
  assert.deepEqual(transitions, [{ state: 'cast', atMs: 34 }]);
});

test('all body transitions created by one callback receive its authored time only', () => {
  const transitions = [{ state: 'windup', atMs: 7 }];
  captureHeroTransitions([{ atMs: 23, callback() { transitions.push({ state: 'cast' }, { state: 'recover' }); } }], transitions);
  assert.deepEqual(transitions, [{ state: 'windup', atMs: 7 }, { state: 'cast', atMs: 23 }, { state: 'recover', atMs: 23 }]);
});

test('nonfinite source slam placements fail before JSON can silently turn them into null', () => {
  for (const value of [NaN, Infinity, -Infinity, '4', undefined]) {
    assert.throws(() => assertCanonicalSlamOffset([value, 0]), /Canonical giant slam placement/);
    assert.throws(() => assertCanonicalSlamOffset([0, value]), /Canonical giant slam placement/);
  }
  assert.throws(() => assertCanonicalSlamOffset([1]), /Canonical giant slam placement/);
  const offset = [9, -3];
  assertCanonicalSlamOffset(offset);
  assert.deepEqual(offset, [9, -3]);
});

function fixture() {
  const index = new Map();
  const atlasFrames = new Map([['atlas/body@1x.json', new Map()], ['atlas/fx@1x.json', new Map()]]);
  const meta = { v2Clips: {}, wareClips: {}, families: {}, sprites: {} };
  const frameName = (key, clip, row, frame) => `${key}${clip.rows > 1 ? `_d${row}` : ''}_f${Math.min(clip.frames, frame)}`;
  const add = (key, data = {}, atlasPath = 'atlas/body@1x.json') => {
    const clip = { frames: 2, rows: 2, cellW: 20, cellH: 30, fps: 10, anchorPx: [10, 25], rowOrder: ['s', 'n'], ...data };
    (key.startsWith('ware_') ? meta.wareClips : meta.v2Clips)[key] = clip;
    for (let row = 0; row < clip.rows; row++) for (let frame = 1; frame <= clip.frames * (clip.variants ?? 1); frame++) {
      const keyFrame = frameName(key, { ...clip, frames: clip.frames * (clip.variants ?? 1) }, row, frame);
      index.set(keyFrame, atlasPath); atlasFrames.get(atlasPath).set(keyFrame, { w: clip.cellW, h: clip.cellH });
    }
    return clip;
  };
  const profiles = { barrowling: { kind: 'trp', stand: 'scurry', move: 'scurry', attack: ['claw'], death: 'death' } };
  for (const state of ['scurry', 'claw', 'death']) add(`v2_trp_barrowling_t1_${state}`, { variants: 4, variantStride: 2 });
  const helpers = { frameName, V2_DIRS: ['s', 'n'], V2_DRAW_SCALE: 2, bodyMoveSnapTiles: .125,
    bodyFacingAim: { minimumDeltaSquared: .001, retainWithinDegrees: 32.5 },
    parseFxAt: (value) => value ? [{ fx: 'dust', frames: [1] }] : [],
    V2_PROJ: {}, V2_TICK_MS: 99, PROJ_Y_FORESHORTEN: 0.5, shadowDropAtFitOne: 10,
    DEATH_HOLD_MS: 123, DEATH_FADE_MS: 456, ANIM_TICK_MS: 250, HERO_DEATH_STEP_MS: 200,
    isWareBuildingUnit: () => false, isWareTrapUnit: () => false };
  return { meta, index, atlasFrames, profiles, helpers, add, shared: { artTierOfLevel: () => 1 },
    constants: { HERO_KEYS: [] }, entries: [], actors: [{ type: 'barrowling', level: 1, variant: 3, scale: 0.75 }] };
}

test('column variants retain every authored frame instead of clamping to the first block', () => {
  const data = fixture();
  const result = buildCombatCatalogue(data);
  const combat = result.combatProfiles[data.actors[0].combatKey];
  assert.deepEqual(combat.clips.claw.frames[0], ['v2_trp_barrowling_t1_claw_d0_f7', 'v2_trp_barrowling_t1_claw_d0_f8']);
  assert.deepEqual(combat.clips.claw.anchor, [0.5, 25 / 30]);
  assert.equal(combat.clips.claw.scale, 0.75);
  assert.equal(combat.deathHoldMs, 123);
});

test('Dragon Nest spawn work requires the source duration and its admitted work cells', () => {
  const data = fixture();
  for (const state of ['idle', 'work', 'damaged', 'collapse']) data.add(`ware_bld_dragonnest_t1_${state}`, { rows: 1, rowOrder: ['s'] });
  data.helpers.isWareBuildingUnit = (type) => type === 'dragonnest';
  data.helpers.wareBuildingClipKey = (type, _level, state) => `ware_bld_${type}_t1_${state}`;
  data.helpers.wareFirePlan = () => null;
  data.constants.BATTLE_BODY_PRESENTATION = { dragonNestWorkMs: 713 };
  data.entries.push({ type: 'dragonnest', level: 1, frameKey: 'ware_bld_dragonnest_t1_idle_f1', atlasPath: 'atlas/body@1x.json', scale: 1, anchor: [.5, 1] });
  const result = buildCombatCatalogue(data);
  assert.deepEqual(result.combatProfiles[data.entries[0].combatKey].spawnWork, { state: 'work', durationMs: 713 });
  delete data.constants.BATTLE_BODY_PRESENTATION;
  assert.throws(() => buildCombatCatalogue(data), /Dragon Nest spawn work/);
});

test('persistent damaged body exports exact source level HP and the source health boundary', () => {
  const data = fixture();
  data.profiles.barrowling.damaged = 'damaged';
  data.add('v2_trp_barrowling_t1_damaged', { variants: 4, variantStride: 2 });
  data.actors.push({ ...data.actors[0], level: 2 });
  data.helpers.troopMaxHp = (type, level) => { assert.equal(type, 'barrowling'); return level === 1 ? 987 : 1234; };
  data.constants.BATTLE_BODY_PRESENTATION = { damagedTroopHealthRatio: .37 };
  const result = buildCombatCatalogue(data);
  assert.equal(data.actors[0].damagedBodyMaxHp,987);
  assert.equal(data.actors[1].damagedBodyMaxHp,1234);
  assert.equal(data.actors[0].combatKey,data.actors[1].combatKey,'Level health must not duplicate authored clip metadata');
  assert.deepEqual(result.combatProfiles[data.actors[0].combatKey].damagedBody, { healthRatio: .37 });
  data.helpers.troopMaxHp = () => NaN;
  assert.throws(() => buildCombatCatalogue(data), /damaged body health/);
});

test('body facing export rejects values the native admission cannot accept', () => {
  for (const bad of [{minimumDeltaSquared:0,retainWithinDegrees:32.5}, {minimumDeltaSquared:.1,retainWithinDegrees:-1},
    {minimumDeltaSquared:.1,retainWithinDegrees:180}, {minimumDeltaSquared:NaN,retainWithinDegrees:32.5}]) {
    const data=fixture();data.profiles.barrowling.hit='hit';data.add('v2_trp_barrowling_t1_hit',{variants:4,variantStride:2});
    data.helpers.bodyFacingAim=bad;
    assert.throws(()=>buildCombatCatalogue(data),/source body facing/);
  }
});

test('equivalent levels share one immutable combat profile to bound decoded catalogue memory', () => {
  const data = fixture();
  data.actors.push({ ...data.actors[0], level: 2 });
  const result = buildCombatCatalogue(data);
  assert.equal(Object.keys(result.combatProfiles).length, 1);
  assert.equal(data.actors[0].combatKey, data.actors[1].combatKey);
  assert.equal(data.actors[0].combat, undefined);
});

test('a missing late variant frame rejects the complete contract rather than shipping a silent pose', () => {
  const data = fixture();
  data.index.delete('v2_trp_barrowling_t1_claw_d1_f8');
  assert.throws(() => buildCombatCatalogue(data), /missing or split atlas/);
});

test('profile-required action absent from metadata fails export', () => {
  const data = fixture();
  data.profiles.barrowling.abilities = ['howl'];
  assert.throws(() => buildCombatCatalogue(data), /needs howl/);
});

test('release cues preserve raw emitters and canonical frame conversion while resolving actual FX dependencies', () => {
  const data = fixture();
  data.add('v2_fx_dust', { rows: 1, fps: 8 }, 'atlas/fx@1x.json');
  const attack = data.meta.v2Clips.v2_trp_barrowling_t1_claw;
  attack.fxAt = 'dust@0';
  attack.emitters = { palm: [[[2, 3], [4, 5]], [[6, 7], [8, 9]]] };
  const result = buildCombatCatalogue(data);
  const combat = result.combatProfiles[data.actors[0].combatKey];
  assert.deepEqual(combat.clips.claw.fxCues, [{ fx: 'dust', frames: [1], effectKey: 'v2_fx_dust' }]);
  assert.deepEqual(combat.clips.claw.emitters, attack.emitters);
  assert.equal(combat.effects.v2_fx_dust.scale, data.actors[0].scale);
  assert.deepEqual(result.requiredAtlases, ['atlas/body@1x.json', 'atlas/fx@1x.json']);
});

test('non-variant auxiliary states remain valid when the actor selects another body variant', () => {
  const data = fixture();
  data.add('v2_trp_barrowling_t1_auxiliary', { variants: undefined, variantStride: undefined });
  const result = buildCombatCatalogue(data);
  const combat = result.combatProfiles[data.actors[0].combatKey];
  assert.deepEqual(combat.clips.auxiliary.frames[0], ['v2_trp_barrowling_t1_auxiliary_d0_f1', 'v2_trp_barrowling_t1_auxiliary_d0_f2']);
});

test('five-tier walls export the wall5 damaged stages statically and the finite collapse family per level tier', () => {
  // Rewritten for D-126: the WARE 16-row wall sheets are retired; each mask now
  // resolves a wall5 family whose damaged cells are stages (light, heavy), not
  // an animation, and whose collapse cells play once at WALL_ART.collapseFps.
  const data = fixture();
  data.actors = [];
  data.helpers.wallTierOfLevel = (level) => Math.min(5, Math.ceil(level / 4));
  data.helpers.wallShapes = ['post', 'end_n'];
  data.helpers.wallArt = { collapseFps: 12, collapseFrames: 4 };
  const addFamily = (key, count, height) => {
    const frames = Array.from({ length: count }, (_, i) => `${key}_f${i + 1}`);
    data.meta.families[key] = { frames, sequence: frames };
    for (const frame of frames) {
      data.meta.sprites[frame] = { anchor: [0.5, 1], footprint: [1, 1], sourceScale: 1 };
      data.index.set(frame, 'atlas/wall5@1x.json');
      data.atlasFrames.set('atlas/wall5@1x.json', (data.atlasFrames.get('atlas/wall5@1x.json') ?? new Map()).set(frame, { w: 32, h: height }));
    }
    return frames;
  };
  const [intact] = addFamily('wall5_t2_end_n_intact', 1, 48);
  addFamily('wall5_t2_end_n_damaged', 2, 48);
  addFamily('wall5_t2_end_n_collapse', 4, 48);
  data.walls = [{ type: 'wall', mask: 1, level: 5, scale: 2, frameKey: intact, atlasPath: 'atlas/wall5@1x.json', anchor: [.5, 1] }];
  const result = buildCombatCatalogue(data);
  const combat = result.combatProfiles[data.walls[0].combatKey];
  assert.deepEqual(combat.clips.damaged.frames, [['wall5_t2_end_n_damaged_f1', 'wall5_t2_end_n_damaged_f2']]);
  assert.equal(combat.clips.damaged.static, true);
  assert.equal(combat.clips.damaged.fps, 0, 'Damage stages are selected by health, never advanced by time');
  assert.deepEqual(combat.clips.collapse.frames, [['wall5_t2_end_n_collapse_f1', 'wall5_t2_end_n_collapse_f2', 'wall5_t2_end_n_collapse_f3', 'wall5_t2_end_n_collapse_f4']]);
  assert.equal(combat.clips.collapse.fps, 12);
  assert.equal(combat.clips.collapse.loop, false);
  assert.deepEqual(combat.clips.collapse.anchor, [0.5, 1]);
  assert.equal(combat.clips.collapse.cellHeight, 48, 'Cells keep the tier height (T2 = 48px)');
  assert.deepEqual(combat.buildingTarget, { offsetX: 0, offsetY: -48 });
  assert.deepEqual(combat.profile, { damaged: 'damaged', death: 'collapse' });
  assert.ok(result.requiredAtlases.includes('atlas/wall5@1x.json'), 'wall5 is a core dependency of every wall');
  data.meta.families.wall5_t2_end_n_damaged.sequence = ['wall5_t2_end_n_damaged_f1'];
  assert.throws(() => buildCombatCatalogue(data), /light and heavy stages/);
  delete data.meta.families.wall5_t2_end_n_damaged;
  assert.throws(() => buildCombatCatalogue(data), /missing wall5 family/);
});

test('WARE fire plans carry canonical release ordering and projectile timing into one dependency-complete profile', () => {
  const data = fixture();
  data.actors = [];
  data.entries = [{ type: 'archertower', level: 1, scale: 1.25 }];
  data.helpers.isWareBuildingUnit = () => true;
  data.helpers.wareBuildingClipKey = (_type, _level, state) => `ware_bld_archer_t1_${state}`;
  data.helpers.wareFirePlan = () => ({ states: ['fire', 'reload'], releaseState: 'fire', releaseFrame: 2, shot: 'arrow' });
  data.helpers.wareProjectileSpec = () => ({ base: 'ware_fx_arrow', impact: 'ware_fx_arrow_hit', durationMs: 321 });
  data.helpers.wareArc = () => 0.123;
  for (const state of ['idle', 'fire', 'reload', 'collapse']) data.add(`ware_bld_archer_t1_${state}`);
  data.add('ware_fx_arrow', {}, 'atlas/fx@1x.json');
  data.add('ware_fx_arrow_hit', {}, 'atlas/fx@1x.json');
  const frameKey='ware_bld_archer_t1_idle_d0_f1';const atlasPath=data.index.get(frameKey);
  data.atlasFrames.get(atlasPath).set(frameKey,{w:30,h:40});
  Object.assign(data.entries[0],{frameKey,atlasPath,anchor:[.25,1],offsetX:2,offsetY:3});
  const result = buildCombatCatalogue(data);
  const combat = result.combatProfiles[data.entries[0].combatKey];
  assert.equal(combat.projectiles.arrow.travelMs, 321);
  assert.equal(combat.projectiles.arrow.arc, 0.123);
  assert.equal(combat.projectiles.arrow.travel.scale, data.helpers.V2_DRAW_SCALE, 'Canonical launchWareShot keeps authored projectile scale independent of building fit');
  assert.equal(combat.projectiles.arrow.impact.scale, data.helpers.V2_DRAW_SCALE, 'Canonical playWareFx keeps impact scale independent of building fit');
  assert.equal(combat.clips.fire.scale, data.entries[0].scale, 'Body and release-emitter fit remain unchanged');
  assert.deepEqual(combat.buildingTarget,{offsetX:11.375,offsetY:-22});
  assert.deepEqual(combat.profile.firePlans['arrow:far'].states, ['fire', 'reload']);
  assert.equal(combat.profile.firePlans['arrow:far'].releaseFrame, 2);
  assert.ok(result.requiredAtlases.includes('atlas/fx@1x.json'));
});

test('battle trap rest preserves defender visibility without changing owner rest or trigger clips', () => {
  const f=fixture(); f.actors=[];
  f.shared.WARE_TRAP_ART={spiketrap:'armed',powdermine:'armed',pitfall:'armed',airmine:'drift'};
  f.helpers.isWareTrapUnit=(unit)=>unit in f.shared.WARE_TRAP_ART;
  f.helpers.wareTrapClipKey=(unit,_level,state)=>`ware_${unit}_t1_${state}`;
  f.helpers.trapBattleStand={spiketrap:'hidden',powdermine:'hidden',pitfall:'hidden',airmine:'drift'};
  f.helpers.trapStates={};
  for(const unit of Object.keys(f.shared.WARE_TRAP_ART)) {
    for(const state of ['hidden','armed','drift','arm','trigger','sprung']) f.add(`ware_${unit}_t1_${state}`,{rows:1,rowOrder:['s']});
    f.helpers.trapStates[unit]=unit==='airmine'?['arm','trigger','sprung']:['trigger','sprung'];
    f.entries.push({type:unit,level:1,scale:1,frameKey:`ware_${unit}_t1_armed_f1`,atlasPath:'atlas/body@1x.json',anchor:[.5,1]});
  }
  const result=buildCombatCatalogue(f);
  for(const entry of f.entries) {
    const profile=result.combatProfiles[entry.combatKey].profile;
    assert.equal(profile.stand,f.shared.WARE_TRAP_ART[entry.type]);
    assert.equal(profile.battleStand,f.helpers.trapBattleStand[entry.type]);
    assert.deepEqual(profile.attack,f.helpers.trapStates[entry.type]);
  }
  f.helpers.trapBattleStand.spiketrap='not_authored';
  assert.throws(()=>buildCombatCatalogue(f),/canonical battle trap rest/);
});
