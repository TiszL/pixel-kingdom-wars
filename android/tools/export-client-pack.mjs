#!/usr/bin/env node
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { sha256, manifestVersion, promoteCatalogueReferences, recordPackFile } from './pack.mjs';
import { endpoints, schemas, kotlinModels } from './wire-contracts.mjs';
import { nativeWireContracts, nativeContractMetadata } from './native-wire-contracts.mjs';
import { buildCombatCatalogue, captureHeroTransitions, assertCanonicalSlamOffset, captureGraphicsStroke, captureImageSweeps, normalizeRadialSweeps, normalizeMoonsunderSweeps, normalizeActorToEventSweeps, ACTOR_TO_EVENT_HERO_SKILLS, captureFirestormPlan, captureFacing8StablePlan, compileHowlController,captureHowlPlan,compileMaulController, captureMaulPlan, assertTargetlessMaulEvents } from './combat-catalog.mjs';
import { buildBasePresentation } from './base-catalog.mjs';
import { compileGloamfangMotion,captureGloamfangMotion } from './gloamfang-motion.mjs';
import { compileBurrowController,captureBurrowMotion } from './burrow-motion.mjs';
import { CARRIED_FIRESTORM_EMITTERS, loadCarriedFirestormEmitters, checkedFirestormEmitterTable } from './carried-motion-metadata.mjs';
import { buildWalls5Section } from './walls5-catalog.mjs';
import { buildGroundSection, buildFantasySection } from './realm-catalog.mjs';
import { buildLayeredGroundSection, buildAcceptedLayeredGroundSection, realmKitVerifier } from './layered-ground-catalog.mjs';
import { buildCampAtlases } from './camp-atlases.mjs';
import { buildConstantsCatalogue } from './constants-catalog.mjs';
import { buildUpgradeSolLamports } from './upgrade-sol-catalog.mjs';
import { buildServiceCatalogue, buildComposedServiceCatalogue, craftSuccessImage, serviceAssetEntries, serviceBuildingEntry, assertServiceOptionalFiles } from './service-catalog.mjs';
import { sourcePaths } from './source-layout.mjs';
import { nonServicesBuildingKinds, PHASE_E_FLAG_SCHEMA } from './phase-e-buildings.mjs';
import { emittedHeroVocabulary } from './hero-event-contract.mjs';
import { captureResultPresentation } from './result-presentation.mjs';
import { captureSensoryPolicy } from './sensory-policy.mjs';
import { captureHitFeedback, hitStaticHeights } from './hit-feedback.mjs';
import { captureArchivePresentation } from './archive-presentation.mjs';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}`); return path.resolve(args[i + 1]); };
const source = arg('--source');
const output = arg('--out');
const layeredPreviewManifest = args.includes('--layered-ground-preview') ? arg('--layered-ground-preview') : undefined;
// A revision-5 realm kit manifest (docs/REALM-KIT-PLAN.md) for a debug/instrumentation host; never an accepted default.
const realmKitPreviewManifest = args.includes('--realm-kit-preview') ? arg('--realm-kit-preview') : undefined;
// The released code-26/32 exporter refused `--phase-e-services` (D-153.48 kept Phase E out of those APKs); this merged
// exporter carries the Phase E service catalogue (service-catalog.mjs), so the flag is supported again (D-N1 union).
if (!process.env.PKW_EXPORT_TS_LOADER) {
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(source, 'scripts/node_modules/tsx/dist/loader.mjs')).href,
    fileURLToPath(import.meta.url), ...args], { stdio: 'inherit', env: { ...process.env, PKW_EXPORT_TS_LOADER: '1' } });
  process.exit(result.status ?? 1);
}
// Explicit candidate generation only: native compatibility/activation is separate.
const phaseEServices = args.includes('--phase-e-services');
// 2026-10-06 (owner: production art in the test build): `--phase-e-core` ships the Phase E service atlases in the core tier,
// so a build draws Workshop, Lodge, Market, Harvester and Berth from its own bundle even when the server it talks to
// advertises another pack (optional art must otherwise match the server's manifest). Default stays optional.
const phaseECore = phaseEServices && args.includes('--phase-e-core');
// Contract 15 (docs/REALM-KIT-PLAN.md E-8) is the released baseline for every pack: the additive `layeredGroundV5`
// realm-kit section, every section up to 14 keeping its shape. `--phase-e-services` adds the optional `phaseE`
// section at the same contract (D-N1 union: the pre-release contract-14 replay branch is retired with the
// released revision-5 repin; native compatibility/activation remains separate).
const RENDERER_CONTRACT_VERSION = 15;
function upgradeDisplay(constants, phaseEServices) {
  if (phaseEServices) return { upgradeSolLamports: buildUpgradeSolLamports(constants) };
  // Without the services flag the released baseline table reproduces exactly (release 32 inlines this same
  // mapping). This branch is not a current economic authority or a new-pack fallback.
  return { upgradeSolLamports: Object.fromEntries(Object.entries({ ...constants.STRUCTURES, ...constants.DEFENSES }).map(([type, settings]) => [type,
    Object.fromEntries(Array.from({ length: settings.maxLevel }, (_, index) => [String(index + 1), String(constants.upgradeSolLamports(type, index + 1))]))])) };
}
const sourceCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
// Source inputs must be committed; unrelated additive native backend work may be in progress.
// The pathspec list lives in source-layout.mjs so source-layout.test.mjs can pin every entry exists.
if (execFileSync('git', ['-C', source, 'status', '--porcelain', '--', ...sourcePaths], { encoding: 'utf8' }).trim()) {
  throw new Error('Commit source art/rules/renderer inputs before exporting a release pack');
}
const load = (relative) => import(pathToFileURL(path.join(source, relative)).href);
const sensoryPolicy=(await captureSensoryPolicy(source)).policy;
const hitFeedbackPolicy=(await captureHitFeedback(source,load)).policy;
const resultCapture=await captureResultPresentation(source);
const shared = await load('packages/shared/src/index.ts');
const constants = await load('packages/shared/src/constants.ts');
// Subpath modules: data-heavy or render-only, deliberately outside the shared barrel.
const wallArt = await load('packages/shared/src/wallArt.ts');
const wallRender = await load('packages/shared/src/wallRender.ts');
const baseVisual = await load('packages/shared/src/baseVisual.ts');
const groundEnvironment = await load('packages/shared/src/groundEnvironment.ts');
const layeredGroundCatalogue = await load('packages/shared/src/layeredGroundCatalogue.ts');
const fantasyWorld = await load('packages/shared/src/fantasyWorld.ts');
// Dark Phase E types leave the building catalogue only while the committed source default keeps them dark (the
// released guarded helper). An explicit --phase-e-services candidate exports the FULL STRUCTURES + DEFENSES set — its
// Phase E kinds become service entries below — and records no omission, so the manifest carries no omitted marker.
const buildingKinds = phaseEServices
  ? { kinds: { ...constants.STRUCTURES, ...constants.DEFENSES } }
  : nonServicesBuildingKinds(constants,
    () => execFileSync('git', ['-C', source, 'show', `${sourceCommit}:${PHASE_E_FLAG_SCHEMA}`], { encoding: 'utf8' }));
const sharp = createRequire(path.join(source, 'scripts/package.json'))('sharp');
const decodePng = async (bytes) => { const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, width: info.width, height: info.height }; };
const { SIM_VERSION } = await load('packages/sim/src/version.ts');
const { UNITS_PER_TILE } = await load('packages/sim/src/fixed.ts');
const { TICKS_PER_SEC } = await load('packages/sim/src/stats.ts');
const { troopMaxHp } = await load('apps/web/src/game/fx/stats.ts');
const clipHelpers = await load('apps/web/src/game/v2/clips.ts');
const { v2BldSeat, V2_DRAW_SCALE, clipFrames, frameName, V2_DIRS } = clipHelpers;
const wareHelpers = await load('apps/web/src/game/ware/clips.ts');
const { wareSeat } = wareHelpers;
const ts = (await load('scripts/node_modules/typescript/lib/typescript.js')).default;
async function sourceConstant(relative, name) {
  const text = await readFile(path.join(source, relative), 'utf8');
  const ast = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(ast) === name) return declaration.initializer.getText(ast);
    }
  }
  throw new Error(`Missing source declaration ${name}`);
}
const profiles = new Function(ts.transpile(`const value = ${await sourceConstant('apps/web/src/game/v2/troop.ts', 'V2_TROOP_PROFILES')}; return value;`, { target: ts.ScriptTarget.ES2022 }))();
async function sourceExpression(relative, name, bindings = {}, thisArg = null) {
  const text = await readFile(path.join(source, relative), 'utf8');
  const ast = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) found.push(node.initializer.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (found.length !== 1) throw new Error(`Expected one canonical expression ${relative}:${name}`);
  return new Function(...Object.keys(bindings), ts.transpile(`return (${found[0]});`, { target: ts.ScriptTarget.ES2022 })).call(thisArg, ...Object.values(bindings));
}
async function sourceFunction(relative, name, bindings = {}) {
  const text = await readFile(path.join(source, relative), 'utf8');
  const ast = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!fn) throw new Error(`Missing canonical pure function ${relative}:${name}`);
  const sourceCode = fn.getText(ast).replace(/^export\s+/, '');
  return new Function(...Object.keys(bindings), ts.transpile(`${sourceCode}; return ${name};`, { target: ts.ScriptTarget.ES2022 }))(...Object.values(bindings));
}
const wareSource = 'apps/web/src/game/ware/building.ts';
const wareFirePlan = await sourceFunction(wareSource, 'wareFirePlan');
const wareProjectileSpec = await sourceFunction(wareSource, 'wareProjectileSpec', {
  DEFENSE_PROJECTILE_TIMINGS: constants.DEFENSE_PROJECTILE_TIMINGS, AUTHORED_ATTACK_TIMINGS: constants.AUTHORED_ATTACK_TIMINGS });
const wareArc = {};
for (const kind of ['arrow', 'magebolt', 'tesla', 'laser', 'harpoon', 'trebuchet', 'keepoil', 'keepbolt', 'hatchfire']) {
  wareArc[kind] = await sourceExpression(wareSource, 'lift', { release: { kind, targetX: 1, targetY: 0 }, fromX: 0, fromY: 0, t: 0.5 });
}
const depthHelpers = await load('apps/web/src/game/world/depth.ts');
const drawWareBeam = await sourceFunction(wareSource,'drawWareBeam',{ ...depthHelpers, combatEffectPool: (scene) => scene.pool });
const beamCapture = captureGraphicsStroke((scene) => drawWareBeam(scene,17,29,83,107));
if(beamCapture.fromX !== 17 || beamCapture.fromY !== 29 || beamCapture.toX !== 83 || beamCapture.toY !== 107) throw new Error('Canonical laser endpoint rule changed');
const chainText = await readFile(path.join(source,'apps/web/src/game/scenes/BattleScene.ts'),'utf8');
const chainAst = ts.createSourceFile('BattleScene.ts',chainText,ts.ScriptTarget.Latest,true);
const chainClass = chainAst.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'BattleScene');
const chainMethod = chainClass?.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(chainAst) === 'onChain');
if(!chainMethod) throw new Error('Missing canonical chain controller');
let chainImpact;
const chainBindings = { ...depthHelpers, BattleScene: { prototype: { ownTransientFx: (graphic) => graphic, destroyTransientFx() {} } },
  playWareFx: (_scene,_clips,base,x,y) => { chainImpact = { base,x,y }; }, floatText() {} };
const chainController = new Function(...Object.keys(chainBindings),ts.transpile(`function ${chainMethod.getText(chainAst).replace(/^(?:private|protected|public)\s+/,'')}; return onChain;`,{target:ts.ScriptTarget.ES2022}))(...Object.values(chainBindings));
function captureChain(height) {
  const capture = captureGraphicsStroke((scene) => chainController.call({ ...scene, jumping: false, waremeta: { clips: {} },
    buildings: new Map([['tower',{ ware: true, sprite: { x:17,y:29,displayHeight:height } }]]),
    troops: new Map([[1,{ fx: { alive: false, sprite: { x:83,y:107 } } }]]) },{ id:'tower',targets:[1],dmg:[0] }));
  if(capture.fromX !== 17 || capture.toX !== 83 || chainImpact?.x !== capture.toX || chainImpact?.y !== capture.toY) throw new Error('Canonical chain endpoint rule changed');
  return { stroke:capture.stroke,originHeightFactor:(29-capture.fromY)/height,targetOffsetY:capture.toY-107,impactKey:chainImpact.base };
}
const wareChain = captureChain(200);
const secondChain = captureChain(80);
if(JSON.stringify(wareChain) !== JSON.stringify(secondChain)) throw new Error('Canonical chain geometry is no longer a linear height anchor');
const shadowSource = await readFile(path.join(source, 'apps/web/src/game/v2/clips.ts'), 'utf8');
const shadowAst = ts.createSourceFile('clips.ts', shadowSource, ts.ScriptTarget.Latest, true);
const shadowFunction = shadowAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'shadowFrame');
const shadowReturn = shadowFunction?.body.statements.find((node) => ts.isReturnStatement(node))?.expression;
const shadowFrames = [];
let shadowCondition = shadowReturn;
while (shadowCondition && ts.isConditionalExpression(shadowCondition)) {
  const condition = shadowCondition.condition;
  if (!ts.isBinaryExpression(condition) || condition.left.getText(shadowAst) !== 'lift' || condition.operatorToken.kind !== ts.SyntaxKind.GreaterThanToken
    || !ts.isNumericLiteral(condition.right) || !ts.isNumericLiteral(shadowCondition.whenTrue)) throw new Error('Canonical shadow frame rule changed; update the contract exporter');
  shadowFrames.push({ above: Number(condition.right.text), frame: Number(shadowCondition.whenTrue.text) });
  shadowCondition = shadowCondition.whenFalse;
}
if (!shadowCondition || !ts.isNumericLiteral(shadowCondition)) throw new Error('Missing canonical ground shadow frame');
const shadowDefaultFrame = Number(shadowCondition.text);
const heroBodyUntil = await sourceFunction('apps/web/src/game/scenes/BattleScene.ts', 'heroSkillBodyUntilTick');
const heroText = await readFile(path.join(source, 'apps/web/src/game/fx/troop.ts'), 'utf8');
const heroAst = ts.createSourceFile('hero.ts', heroText, ts.ScriptTarget.Latest, true);
const heroClass = heroAst.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'TroopFx');
const heroMethod = heroClass?.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(heroAst) === 'onHeroSkill');
if (!heroMethod) throw new Error('Missing canonical hero body phase controller');
const heroBody = new Function('HERO_SKILLS', ts.transpile(`function ${heroMethod.getText(heroAst)}; return onHeroSkill;`, { target: ts.ScriptTarget.ES2022 }))(constants.HERO_SKILLS);
const heroSkills = new Set(Object.values(constants.HERO_SKILLS).flatMap((skills) => Object.keys(skills)));
const heroPhases = new Set(['*']);
const findHeroConditions = (node) => {
  if (ts.isBinaryExpression(node) && ts.isStringLiteral(node.right)) {
    if (node.left.getText(heroAst) === 'skill') heroSkills.add(node.right.text);
    if (node.left.getText(heroAst) === 'phase') heroPhases.add(node.right.text);
  }
  ts.forEachChild(node, findHeroConditions);
};
findHeroConditions(heroMethod);
const simText = await readFile(path.join(source, 'packages/sim/src/sim.ts'), 'utf8');
const emittedHero = emittedHeroVocabulary(ts, simText);
for (const skill of emittedHero.skills) heroSkills.add(skill);
for (const phase of emittedHero.phases) heroPhases.add(phase);
const heroBodyPlans = {};
for (const hero of constants.HERO_KEYS) {
  const skin = `hero_${hero === 'theodor' ? 'theo' : hero}`;
  heroBodyPlans[hero] = {};
  for (const skill of heroSkills) for (const phase of heroPhases) {
    const transitions = []; const delayed = []; let first;
    const stateOf = (seq) => {
      if (!seq[0]?.startsWith(`${skin}_`)) return null;
      return seq[0].slice(skin.length + 1).replace(/_f\d+$/, '');
    };
    const instance = { skin, state: 'idle', heroLocked: false, heroVisualPriority: 0, alive: true, heroLockToken: 1,
      named: (base, count) => Array.from({ length: count }, (_, i) => `${base}_f${i + 1}`),
      attackFrames: () => [`${skin}_attack_e_f1`],
      playHeroBody: (seq, _lock, priority, once = false) => { first = { state: stateOf(seq), once, priority }; return 1; },
      playHeroFramesOnce: (seq) => transitions.push({ state: stateOf(seq), once: true }),
      anim: { unregister() {} }, sprite: {}, scene: { time: { delayedCall: (atMs, callback) => delayed.push({ atMs, callback }) } } };
    // Probe the controller's authored transition boundaries; this technical
    // horizon is never serialized as a skill duration or gameplay rule.
    heroBody.call(instance, skill, phase, 60_000, 0);
    captureHeroTransitions(delayed, transitions);
    if (first?.state && first.state !== 'attack_e') heroBodyPlans[hero][`${skill}:${phase}`] = { ...first, ...(transitions.length ? { transitions } : {}) };
  }
}
// This threshold belongs to the canonical render controller, not combat damage rules.
const damageThresholds=new Set();
const findDamageThreshold=(node)=>{
  if(ts.isBinaryExpression(node) && node.operatorToken.kind===ts.SyntaxKind.LessThanToken &&
    ['frac','wall.hp / wall.maxHp'].includes(node.left.getText(chainAst)) && ts.isNumericLiteral(node.right))
    damageThresholds.add(Number(node.right.text));
  ts.forEachChild(node,findDamageThreshold);
};
findDamageThreshold(chainClass);
if(damageThresholds.size!==1 || ![...damageThresholds].every((n)=>n>0 && n<1)) throw new Error('Canonical building damage visual threshold changed');
const buildingDamageThreshold=[...damageThresholds][0];
// Context wall frames (wallctx_*) take one hard-coded seat in both scenes; the
// legacy walls section and the walls5 section must both describe that seat.
function captureContextWallSeat(text,name) {
  const ast=ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true);
  const seats=[];
  const visit=(node)=>{
    if(ts.isIfStatement(node) && node.expression.getText(ast)==='isContextWallFrame(frame)' && ts.isReturnStatement(node.thenStatement) && node.thenStatement.expression)
      seats.push(new Function(ts.transpile(`return (${node.thenStatement.expression.getText(ast)});`,{target:ts.ScriptTarget.ES2022}))());
    ts.forEachChild(node,visit);
  };
  visit(ast);
  if(seats.length!==1) throw new Error(`Canonical context wall seat missing in ${name}`);
  return seats[0];
}
const contextWallSeat=captureContextWallSeat(chainText,'BattleScene.ts');
if(JSON.stringify(contextWallSeat)!==JSON.stringify(captureContextWallSeat(await readFile(path.join(source,'apps/web/src/game/scenes/BaseScene.ts'),'utf8'),'BaseScene.ts'))) throw new Error('Base and battle context wall seats differ');
if(JSON.stringify(contextWallSeat)!==JSON.stringify({origin:[0.5,1],scale:constants.WALL_ART.drawScale,offsetGamePx:[0,0]})) throw new Error('Canonical context wall seat changed');
// The legacy walls section shows the light-damage cell below the shared building
// threshold; that is only truthful while both thresholds coincide.
if(constants.WALL_ART.lightDamageBelow!==buildingDamageThreshold) throw new Error('Wall light-damage stage no longer matches the shared damage threshold');
const heroEffectMethod = chainClass?.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(chainAst) === 'onHeroSkill');
if(!heroEffectMethod) throw new Error('Missing canonical external hero effect controller');
let sensory = [];
const heroEffectBindings = { ...depthHelpers,HERO_SKILLS:constants.HERO_SKILLS,heroSkillBodyUntilTick:heroBodyUntil,TICK_MS:1000/TICKS_PER_SEC,
  T:constants.GRID.tilePx*V2_DRAW_SCALE,BattleScene:{prototype:{applyHeroSkillState(){},ownTransientFx:(image)=>image,destroyTransientFx:(image)=>image.destroy()}},
  shake:(_scene,duration,intensity)=>sensory.push({kind:'shake',duration,intensity}),haptic:(kind)=>sensory.push({kind:'haptic',strength:kind}) };
const heroEffectController = new Function(...Object.keys(heroEffectBindings),ts.transpile(`function ${heroEffectMethod.getText(chainAst).replace(/^(?:private|protected|public)\s+/,'')}; return onHeroSkill;`,{target:ts.ScriptTarget.ES2022}))(...Object.values(heroEffectBindings));
const { QUEST_LABELS } = await load('apps/web/src/ui/copy.ts');
const heroSweepPlans = {};
for(const [hero,plans] of Object.entries(heroBodyPlans)) {
  heroSweepPlans[hero]={};
  const skills=[...heroSkills].filter((skill)=>Object.keys(constants.HERO_SKILLS[hero]).some((base)=>skill.startsWith(base)));
  for(const skill of skills) for(const phase of heroPhases) {
    const key=`${skill}:${phase}`;sensory=[];
    let sweeps=captureImageSweeps((scene)=>heroEffectController.call({...scene,jumping:false,ux:(n)=>n,uy:(n)=>n,
      troops:new Map([[1,{fx:{onHeroSkill(){},onHeroTravel(){},sprite:{active:true,x:31,y:47}}}],
        [2,{fx:{sprite:{active:true,getCenter:()=>({x:73,y:89})}}}]])},
      {e:'heroSkill',t:0,id:1,skill,phase,x:101,y:203,fromX:31,fromY:47,toX:307,toY:409,target:2,until:600}),['crimsonDash','omegaShardstorm','moonsunderWave',...ACTOR_TO_EVENT_HERO_SKILLS].includes(skill));
    if(sweeps===null) continue;
    if(skill === 'crimsonDash') {
      const durationMs=heroBodyUntil({t:0,skill,phase,until:600})*(1000/TICKS_PER_SEC);
      if(sweeps.length!==1 || sweeps[0].x!==31 || sweeps[0].y!==47 || sweeps[0].travel?.toX!==307 || sweeps[0].travel?.toY!==409 || sweeps[0].travel.durationMs!==durationMs) throw new Error(`Hero dash choreography changed: ${key}`);
      for(const sweep of sweeps) sweep.travel={mode:'eventFromTo',tailMs:sweep.lifetimeMs-Math.max(durationMs,sweep.stepMs*sweep.frames.length)};
    } else if(ACTOR_TO_EVENT_HERO_SKILLS.includes(skill)) {
      const durationMs=heroBodyUntil({t:0,skill,phase,until:600})*(1000/TICKS_PER_SEC);
      const capture=(actorX,actorY,x,y,presence)=>captureImageSweeps((scene)=>heroEffectController.call({...scene,jumping:false,ux:(n)=>n,uy:(n)=>n,
        troops:new Map(presence==='missing' ? [] : [[1,{fx:{onHeroSkill(){},onHeroTravel(){},sprite:{active:presence==='active',x:actorX,y:actorY}}}]])},
        {e:'heroSkill',t:0,id:1,skill,phase,x,y,fromX:-997,fromY:-991,toX:-983,toY:-977,until:600}),true);
      sweeps=normalizeActorToEventSweeps(sweeps,capture(31,47,101,203,'missing'),{actorX:31,actorY:47,x:101,y:203,durationMs});
      for(const [actorX,actorY,x,y] of [[-61,79,601,703],[809,907,601,703],[601,703,601,703]]) for(const presence of ['missing','inactive']) {
        const normalized=normalizeActorToEventSweeps(capture(actorX,actorY,x,y,'active'),capture(actorX,actorY,x,y,presence),{actorX,actorY,x,y,durationMs});
        if(JSON.stringify(normalized)!==JSON.stringify(sweeps)) throw new Error(`Canonical actor projectile art varies with facing or caster availability: ${key}`);
      }
    } else if(skill === 'moonsunderWave') {
      const durationMs=heroBodyUntil({t:0,skill,phase,until:600})*(1000/TICKS_PER_SEC);
      const rangePx=constants.HERO_SKILLS.vex.moonsunderWave.rangeTiles*heroEffectBindings.T;
      sweeps=normalizeMoonsunderSweeps(sweeps,{x:101,y:203,towardX:307,towardY:409,rangePx,durationMs,targetCenter:{x:73,y:89}});
      // Probe every world-facing direction, zero distance and both target kinds.
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1],[0,0]]) for(const troopTarget of [true,false]) {
        const x=601,y=703,targetCenter={x:809,y:907};
        const probe=captureImageSweeps((scene)=>heroEffectController.call({...scene,jumping:false,ux:(n)=>n,uy:(n)=>n,
          troops:new Map([[1,{fx:{onHeroSkill(){},onHeroTravel(){},sprite:{active:true,x:31,y:47}}}],
            [2,{fx:{sprite:{active:true,getCenter:()=>targetCenter}}}]])},
          {e:'heroSkill',t:0,id:1,skill,phase,x,y,toX:x+dx,toY:y+dy,target:troopTarget ? 2 : 'keep',until:600}),true);
        const normalized=normalizeMoonsunderSweeps(probe,{x,y,towardX:x+dx,towardY:y+dy,rangePx,durationMs,targetCenter:troopTarget ? targetCenter : null});
        if(JSON.stringify(normalized)!==JSON.stringify(troopTarget ? sweeps : sweeps.filter((s)=>!s.placement))) throw new Error(`Canonical Moonsunder art varies with facing or target: ${key}`);
      }
    } else if(skill === 'omegaShardstorm') {
      const durationMs=heroBodyUntil({t:0,skill,phase,until:600})*(1000/TICKS_PER_SEC);
      const first=normalizeRadialSweeps(sweeps,{x:101,y:203,durationMs});
      const shifted=captureImageSweeps((scene)=>heroEffectController.call({...scene,jumping:false,ux:(n)=>n,uy:(n)=>n,
        troops:new Map([[1,{fx:{onHeroSkill(){},onHeroTravel(){},sprite:{active:true,x:31,y:47}}}]])},
        {e:'heroSkill',t:0,id:1,skill,phase,x:601,y:703,until:600}),true);
      const second=normalizeRadialSweeps(shifted,{x:601,y:703,durationMs});
      const relative=(items,x,y)=>items.map((s)=>({...s,x:s.x-x,y:s.y-y}));
      // Translation can change the last binary float bit after source addition/subtraction.
      // Compare at subpixel precision without rounding the exported authored coordinates.
      const comparable=(items,x,y)=>JSON.stringify(relative(items,x,y),(_key,value)=>typeof value==='number' ? Number(value.toFixed(8)) : value);
      if(comparable(first,101,203)!==comparable(second,601,703)) throw new Error(`Hero radial sweep is not translation invariant: ${key}`);
      sweeps=first;
    } else if(sweeps.some((s)=>s.x!==101 || s.y!==203)) throw new Error(`Hero stationary sweep changed placement: ${key}`);
    heroSweepPlans[hero][key]={effects:sweeps,sensory};
  }
}
const troopText = await readFile(path.join(source, 'apps/web/src/game/v2/troop.ts'), 'utf8');
const troopAst = ts.createSourceFile('troop.ts', troopText, ts.ScriptTarget.Latest, true);
const troopClass=troopAst.statements.find((node)=>ts.isClassDeclaration(node)&&node.name?.text==='V2TroopFx');
const fanMethod=troopClass?.members.find((node)=>ts.isMethodDeclaration(node)&&node.name.getText(troopAst)==='playFirestorm');
if(!fanMethod)throw new Error('Missing canonical Firestorm controller');
const fanBindings={V2_DRAW_SCALE,parseFxAt:clipHelpers.parseFxAt,clipFrames,
  v2DirewyvernFxBaseKey:shared.v2DirewyvernFxBaseKey,atlasGroupFor:shared.atlasGroupFor};
// Bind attachment capture to the controller receiver without importing Phaser.
const fanBody=fanMethod.getText(troopAst).replace(/^private\s+/,'').replace(/emitterWorld\(/g,'this.probeEmitter(');
const fanController=new Function(...Object.keys(fanBindings),ts.transpile(`function ${fanBody}; return playFirestorm;`,{target:ts.ScriptTarget.ES2022}))(...Object.values(fanBindings));
const firestormPlan=(body,fx,tier,fit)=>captureFirestormPlan(fanController,{body,fx,tier,fit,drawScale:V2_DRAW_SCALE});
assertTargetlessMaulEvents(ts,await readFile(path.join(source,'packages/sim/src/sim.ts'),'utf8'));
const playV2Fx=await sourceFunction('apps/web/src/game/v2/projectiles.ts','playV2Fx',{
  frameName:clipHelpers.frameName,atlasGroupFor:shared.atlasGroupFor,V2_DRAW_SCALE,
  DEPTH_IMPACT:await sourceExpression('apps/web/src/game/v2/projectiles.ts','DEPTH_IMPACT',depthHelpers),
  combatEffectPool:(scene)=>scene.pool });
const maulController=compileMaulController(ts,troopText,{parseFxAt:clipHelpers.parseFxAt,toWorldPx:clipHelpers.toWorldPx,
  v2DirewyvernFxBaseKey:shared.v2DirewyvernFxBaseKey,playV2Fx});
const maulPlan=(body,fx,tier,fit)=>captureMaulPlan(maulController,{body,fx,tier,fit,drawScale:V2_DRAW_SCALE});
const howlAim=captureFacing8StablePlan(ts,await readFile(path.join(source,'apps/web/src/game/v2/clips.ts'),'utf8'),clipHelpers.facing8Stable,clipHelpers);
const howlController=compileHowlController(ts,troopText,{parseFxAt:clipHelpers.parseFxAt,facing8Stable:clipHelpers.facing8Stable,
  actorDepth:depthHelpers.actorDepth,playV2Fx});
const howlPlan=(body,fx,tier,fit)=>({...captureHowlPlan(howlController,{body,fx,tier,fit,drawScale:V2_DRAW_SCALE}),aim:howlAim});
const gloamfangController=compileGloamfangMotion(ts,troopText,{TROOP_ABILITIES:shared.TROOP_ABILITIES,
  actorDepth:depthHelpers.actorDepth,facing8Stable:clipHelpers.facing8Stable});
const gloamfangMotion=(body)=>{
  const plan=captureGloamfangMotion(gloamfangController,{body,actorDepth:depthHelpers.actorDepth,facing8Stable:clipHelpers.facing8Stable});
  return {leap:{...plan.leap,aim:howlAim},lunge:{...plan.lunge,aim:howlAim}};
};
const burrowBindings={parseFxAt:clipHelpers.parseFxAt,facing8Stable:clipHelpers.facing8Stable,
  actorDepth:depthHelpers.actorDepth,playV2Fx,
  MELEE_FX_EMITTER:await sourceExpression('apps/web/src/game/v2/troop.ts','MELEE_FX_EMITTER'),
  FACING_ROTATION_DEG:await sourceExpression('apps/web/src/game/v2/troop.ts','FACING_ROTATION_DEG')};
const burrowController=compileBurrowController(ts,troopText,
  await readFile(path.join(source,'apps/web/src/game/v2/ticker.ts'),'utf8'),burrowBindings);
const burrowMotion=(unit,tier,profile,fit)=>captureBurrowMotion(burrowController,
  {unit,tier,profile,clips:meta.v2Clips,fit,drawScale:V2_DRAW_SCALE,aim:howlAim,actorDepth:depthHelpers.actorDepth});
let slamCall;
const findSlam = (node) => {
  if (ts.isCallExpression(node) && node.expression.getText(troopAst) === 'this.playEffect'
    && node.arguments[0]?.getText(troopAst).startsWith('`v2_fx_impact_slam_t')) slamCall = node;
  ts.forEachChild(node, findSlam);
};
const fxHandler = troopClass?.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(troopAst) === 'fxAtHandler');
if (!fxHandler) throw new Error('Missing canonical troop FX handler');
findSlam(fxHandler);
if (!slamCall) throw new Error('Missing canonical giant slam placement');
const slamOffset = [slamCall.arguments[1], slamCall.arguments[2]].map((node) =>
  new Function('dx', `return (${node.getText(troopAst)});`).call({ sprite: { x: 0, y: 0 } }, 1));
assertCanonicalSlamOffset(slamOffset);
const archivePresentation=(await captureArchivePresentation(source,SIM_VERSION)).policy;
const combatHelpers = { ...clipHelpers, ...wareHelpers, troopMaxHp,
  bodyMoveSnapTiles: archivePresentation.legacyMelee.positionSnapDistance / (constants.GRID.tilePx * V2_DRAW_SCALE),
  bodyFacingAim: { ...archivePresentation.legacyMelee.aim,
    minimumDeltaSquared: archivePresentation.legacyMelee.aim.minimumDeltaSquared / (constants.GRID.tilePx * V2_DRAW_SCALE) ** 2 },
  wareFirePlan, wareProjectileSpec, wareArc: (kind) => wareArc[kind],
  heroSweepPlans, firestormPlan, maulPlan, howlPlan, gloamfangMotion, burrowMotion,
  wareBeamStroke: beamCapture.stroke, wareChain,
  heroBodyPlans, heroBodyDefaultTicks: { default: heroBodyUntil({ t: 0, phase: 'cast', skill: '' }), cannonball: heroBodyUntil({ t: 0, phase: 'cast', skill: 'cannonball' }) },
  wallTierOfLevel: wallArt.wallTierOfLevel, wallShapes: wallRender.SHAPES, wallArt: constants.WALL_ART,
  burnfieldFrames: await sourceFunction('apps/web/src/game/v2/burnfield.ts', 'burnfieldFrames', { frameName: clipHelpers.frameName,
    atlasGroupFor: shared.atlasGroupFor, v2DirewyvernFxBaseKey: shared.v2DirewyvernFxBaseKey }),
  MELEE_FX_EMITTER: burrowBindings.MELEE_FX_EMITTER,
  FACING_ROTATION_DEG: burrowBindings.FACING_ROTATION_DEG,
  slamOffset, nearKeepRangePx: constants.DEFENSES.mortar.rangeMinTiles * constants.GRID.tilePx * V2_DRAW_SCALE,
  trapStates: Object.fromEntries(await Promise.all(Object.keys(shared.WARE_TRAP_ART).map(async (unit) => [unit,
    await sourceExpression(wareSource, 'states', {}, { deps: { unit } })]))),
  trapBattleStand: Object.fromEntries(await Promise.all(Object.keys(shared.WARE_TRAP_ART).map(async (unit) => [unit,
    await sourceExpression(wareSource, 'initial', { initiallySpent: false, ownerView: false, deps: { unit }, WARE_TRAP_ART: shared.WARE_TRAP_ART })]))),
  shadowFrames, shadowDefaultFrame,
  depths: Object.fromEntries(await Promise.all(['DEPTH_PROJ', 'DEPTH_SHADOW', 'DEPTH_IMPACT'].map(async (name) => [name, await sourceExpression('apps/web/src/game/v2/projectiles.ts', name, depthHelpers)]))),
  ANIM_TICK_MS: await sourceExpression('apps/web/src/game/anim.ts', 'ANIM_TICK_MS'),
  HERO_DEATH_STEP_MS: await sourceExpression('apps/web/src/game/fx/troop.ts', 'DEATH_STEP_MS'),
  DEATH_HOLD_MS: await sourceExpression('apps/web/src/game/v2/troop.ts', 'DEATH_HOLD_MS'),
  DEATH_FADE_MS: await sourceExpression('apps/web/src/game/v2/troop.ts', 'DEATH_FADE_MS'),
  hatchlingStates: await sourceExpression('apps/web/src/game/ware/hatchling.ts', 'RICH_STATES'),
  shadowDropAtFitOne: await sourceExpression('apps/web/src/game/v2/projectiles.ts', 'SHADOW_DROP', { toWorldPx: clipHelpers.toWorldPx, fit: 1 }) };
const publicRoot = path.join(source, 'apps/web/public');
const meta = JSON.parse(await readFile(path.join(publicRoot, 'atlas/meta.json'), 'utf8'));
// The composed server has source-bound family tables instead of phaseEArt.ts.
// Keep the historical path only for historical packs; never import it for r3+.
const composedServices = phaseEServices && ['peServiceBuildings', 'peHarvesters', 'peMarket', 'peStarterFleet', 'peAdvancedFleet'].some(key => key in meta);
const phaseEArt = phaseEServices && !composedServices ? await load('packages/shared/src/phaseEArt.ts') : undefined;
// Firestorm maw pins: production packs the selected game-v4 Direwyvern pixels with
// the legacy procedural emitter table (web commit 5e4b2e21 is not on main). Apply
// the carried hash-bound sidecar only after proving the bound overlay PNG is what
// the atlas actually packed for that clip.
const carriedMetadata = { firestormEmitters: { sourceCommit: CARRIED_FIRESTORM_EMITTERS.sourceCommit, keys: [] } };
{
  const sidecar = await loadCarriedFirestormEmitters();
  const atlasJson = new Map();
  for (const runtimeKey of Object.keys(sidecar.bindings)) {
    const overlayPath = CARRIED_FIRESTORM_EMITTERS.overlayPath(runtimeKey);
    const clip = meta.v2Clips[runtimeKey];
    if (!overlayPath || !clip) throw new Error(`Carried Firestorm binding has no source clip: ${runtimeKey}`);
    const overlayBytes = await readFile(path.join(source, overlayPath));
    const table = checkedFirestormEmitterTable(sidecar, runtimeKey, overlayBytes, clip);
    const frame = clipHelpers.frameName(runtimeKey, clip, 0, 1);
    const atlasName = shared.atlasGroupFor(frame);
    if (!atlasJson.has(atlasName)) atlasJson.set(atlasName, JSON.parse(await readFile(path.join(publicRoot, `atlas/${atlasName}@1x.json`), 'utf8')));
    const texture = atlasJson.get(atlasName).textures.find((t) => t.frames.some((f) => f.filename === frame));
    const packed = texture?.frames.find((f) => f.filename === frame);
    if (!packed) throw new Error(`Carried Firestorm binding frame is not packed: ${frame}`);
    const overlay = await decodePng(overlayBytes);
    const atlasPixels = await decodePng(await readFile(path.join(publicRoot, 'atlas', texture.image)));
    const { x: sx, y: sy } = packed.spriteSourceSize ?? { x: 0, y: 0 };
    if (overlay.width < clip.cellW || overlay.height < clip.cellH) throw new Error(`Overlay sheet smaller than one cell: ${runtimeKey}`);
    for (let py = 0; py < packed.frame.h; py++) for (let px = 0; px < packed.frame.w; px++) {
      const a = ((packed.frame.y + py) * atlasPixels.width + packed.frame.x + px) * 4;
      const b = ((sy + py) * overlay.width + sx + px) * 4;
      const alpha = atlasPixels.data[a + 3];
      if (alpha !== overlay.data[b + 3] || (alpha > 0 && (atlasPixels.data[a] !== overlay.data[b] || atlasPixels.data[a + 1] !== overlay.data[b + 1] || atlasPixels.data[a + 2] !== overlay.data[b + 2])))
        throw new Error(`Packed Firestorm pixels are not the sidecar-bound overlay: ${runtimeKey}`);
    }
    clip.emitters = { ...clip.emitters, ...table };
    carriedMetadata.firestormEmitters.keys.push(runtimeKey);
  }
  if (carriedMetadata.firestormEmitters.keys.length !== Object.keys(sidecar.bindings).length) throw new Error('Carried Firestorm bindings incompletely applied');
}
const serial = (data) => JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n';
const stage = `${output}.stage-${process.pid}`;
await mkdir(stage, { recursive: true });
const files = [];
async function put(relative, bytes, tier = 'core') {
  const entry = { path: relative, sha256: sha256(bytes), size: Buffer.byteLength(bytes), tier };
  if (recordPackFile(files, entry) !== entry) return; // identical bytes already staged by another section
  await mkdir(path.dirname(path.join(stage, relative)), { recursive: true });
  await writeFile(path.join(stage, relative), bytes);
}
try {
  for(const output of resultCapture.outputs)await put(output.path,output.bytes);
  const catalogue = { schemaVersion: 1, sourceCommit, simVersion: SIM_VERSION,
    presentation: { worldScale: V2_DRAW_SCALE, tilePixels: constants.GRID.tilePx * V2_DRAW_SCALE,
      unitsPerTile: UNITS_PER_TILE, tickMs: 1000 / TICKS_PER_SEC },
    display: { questLabels: QUEST_LABELS,
      research: { troops: shared.TROOP_TYPES.filter(constants.isTrainableTroop), darkTroops: constants.DARK_ATTACKER_TROOPS,
        eliteItems: constants.ELITE_TROOP_UNLOCKS.itemByTroop,
        speedup: { rate: constants.ECONOMY.speedupKeepPer30Sec, granularitySec: constants.ECONOMY.speedupGranularitySec,
          quadraticSoftUnits: constants.ECONOMY.speedupQuadraticSoftUnits } },
      ...upgradeDisplay(constants, phaseEServices) },
    // Allowlisted keys first (existing readers), then every other top-level value export of constants.ts.
    constants: buildConstantsCatalogue(constants),
    // Subpath modules are data-only exports; functions are described by the render catalogue sections that execute them.
    modules: {
      baseVisual: { REALM_IDS: baseVisual.REALM_IDS, REALM_NAMES: baseVisual.REALM_NAMES, DEFAULT_BASE_VISUAL: baseVisual.DEFAULT_BASE_VISUAL,
        CURRENT_BASE_VISUAL: baseVisual.CURRENT_BASE_VISUAL, BASE_GROUND_ART: baseVisual.BASE_GROUND_ART, BASE_GROUND_ART_V2: baseVisual.BASE_GROUND_ART_V2,
        BASE_GROUND_ART_V3: baseVisual.BASE_GROUND_ART_V3 },
      wallArt: { WALL_ART: constants.WALL_ART, tierOfLevel: Array.from({ length: constants.LEVEL_STEP_BUILDING.length }, (_, i) => wallArt.wallTierOfLevel(i + 1)) },
      wallRender: { TILE: wallRender.TILE, TIER_HEIGHTS: wallRender.TIER_HEIGHTS, CONTEXT_FRAME_HEIGHT: wallRender.CONTEXT_FRAME_HEIGHT,
        COLLAPSE_DURATION: wallRender.COLLAPSE_DURATION, SHAPES: wallRender.SHAPES },
      fantasyWorld: { FANTASY_WORLD_ID: fantasyWorld.FANTASY_WORLD_ID, FANTASY_CATALOG_HASH: fantasyWorld.FANTASY_CATALOG_HASH,
        FANTASY_MEMBERSHIP_HASH: fantasyWorld.FANTASY_MEMBERSHIP_HASH },
    } };
  await put('catalogue.json', serial(catalogue));
  const nativeSchemas = await nativeWireContracts(source);
  const nativeMetadata = nativeContractMetadata(nativeSchemas);
  // Optional receipt sources are absent in older pins. Once exported, they are
  // committed inputs just like the always-present schemas in sourcePaths.
  if (execFileSync('git', ['-C', source, 'status', '--porcelain', '--', ...nativeMetadata.zod], { encoding: 'utf8' }).trim()) {
    throw new Error('Commit canonical native schema inputs before exporting a release pack');
  }
  await put('contracts.json', serial({ schemaVersion: 1, sourceCommit, coverage: 'curated-foundation-and-canonical-native-presentation',
    schemaSources: { curated: 'tools/wire-contracts.mjs', native: 'apps/api/src/native/contracts.ts',
      zod: nativeMetadata.zod },
    endpoints: [...endpoints, ...nativeMetadata.endpoints], schemas: { ...schemas, ...nativeSchemas } }));
  await put('kotlin/NativeContracts.kt', kotlinModels(sourceCommit, nativeSchemas));
  // Root @1x atlases only. atlas/fantasy/** is copied by the realm sections with
  // per-file digest proofs; atlas/retired-deeds/** is a server-only deed archive
  // (D-128) and must never enter a client pack.
  const atlasNames = (await readdir(path.join(publicRoot, 'atlas'))).filter((f) => /@1x\.(png|json)$/.test(f)).sort();
  const coreGroups = new Set(shared.ATLAS_PREFIXES);
  const index = new Map();
  const atlasFrames = new Map();
  const serviceAssets = new Map();
  for (const name of atlasNames) {
    const bytes = await readFile(path.join(publicRoot, 'atlas', name));
    if (phaseEServices && name.startsWith('pe_')) serviceAssets.set(`atlas/${name}`, bytes);
    if (name.endsWith('.json')) {
      const atlas = JSON.parse(bytes);
      const frameEntries = atlas.textures ? atlas.textures.flatMap((texture) => texture.frames.map((frame) => [frame.filename, frame])) : Object.entries(atlas.frames);
      const keys = frameEntries.map(([key]) => key);
      for (const key of keys) {
        if (phaseEServices && key.startsWith('pe_') && (index.has(key) || `atlas/${name}` !== `atlas/${shared.atlasGroupFor(key)}@1x.json`))
          throw new Error(`Duplicate or misrouted service sprite ${key}`);
        index.set(key, `atlas/${name}`);
      }
      atlasFrames.set(`atlas/${name}`, new Map(frameEntries.map(([key, value]) => [key, value.sourceSize ?? value.frame])));
    }
    // Service normalization can reuse source group names. Defer their writes
    // until collisions have been planned, while indexing the authentic source.
    if (!(phaseEServices && name.startsWith('pe_')))
      await put(`atlas/${name}`, bytes, coreGroups.has(name.replace(/@1x\.(png|json)$/, '')) ? 'core' : 'optional');
  }
  const inspectServicePng = bytes => sharp(bytes, { limitInputPixels: 4096 * 4096, sequentialRead: true, failOn: 'warning' }).metadata();
  let phaseE;
  let projectedServiceAssets = new Map();
  if (composedServices) {
    const fxManifest = JSON.parse(await readFile(path.join(source, 'art/source/phase-e/shared-fx/manifest.json'), 'utf8'));
    const still = await readFile(path.join(source, 'art/source/phase-e/shared-fx/craft-success/frames/frame-00.png'));
    const reducedMotionImage = craftSuccessImage(fxManifest, still, await inspectServicePng(still));
    const composed = await buildComposedServiceCatalogue({ meta, reducedMotionImage, assets: serviceAssets, inspectPng: inspectServicePng,
      decodePng, encodePng: ({ data, width, height }) => sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer() });
    phaseE = composed.phaseE;
    projectedServiceAssets = composed.assets;
    await put(reducedMotionImage.path, still, 'optional');
    await put('atlas/source-phase-e/projection.json', serial({ version: 1, sourceCommit,
      sourceFiles: [...serviceAssets].map(([name, bytes]) => ({ sourcePath: name,
        path: projectedServiceAssets.has(name) ? name.replace('atlas/', 'atlas/source-phase-e/') : name,
        sha256: sha256(bytes), size: bytes.length })) }), 'optional');
  } else if (phaseEServices) {
    phaseE = await buildServiceCatalogue({ meta, parsePhaseEArt: phaseEArt.parsePhaseEArt,
      atlasGroupFor: shared.atlasGroupFor, isPhaseEServiceAtlasGroup: shared.isPhaseEServiceAtlasGroup,
      assets: serviceAssets, inspectPng: inspectServicePng });
  }
  for (const [name, bytes] of serviceAssetEntries(serviceAssets, projectedServiceAssets)) await put(name, bytes, phaseECore ? 'core' : 'optional');
  await put('atlas/meta.json', await readFile(path.join(publicRoot, 'atlas/meta.json')));
  const entries = [];
  for (const [type, properties] of Object.entries(buildingKinds.kinds)) {
    for (let level = 1; level <= constants.LEVEL_STEP_BUILDING.length; level++) {
      const service = phaseE && serviceBuildingEntry(type, level, constants, shared.artTierOfLevel);
      if (service) { entries.push(service); continue; }
      if (constants.PHASE_E_BUILDINGS?.types.includes(type)) throw new Error('Service buildings require explicit --phase-e-services candidate contract 15');
      // Walls use the five-tier family (wallTierOfLevel), never ART_V2's four tiers.
      let frameKey = type === 'wall' ? wallArt.wallFrameKey(level, 'straight')
        : ['heroaltar', 'siegestool'].includes(type) ? `bld_${type}` : `bld_${type}_l${level}`;
      if (constants.ART_V2.buildings.includes(type)) frameKey = shared.v2BuildingFallbackFrameKey(type, shared.artTierOfLevel(level), 1);
      const atlasPath = index.get(frameKey);
      if (!atlasPath) throw new Error(`Missing canonical building sprite ${frameKey}`);
      const sprite = meta.sprites[frameKey];
      const footprint = properties.footprint ?? sprite?.footprint;
      if (!footprint) throw new Error(`Missing canonical footprint for ${type}`);
      const seat = v2BldSeat(meta.v2Clips, frameKey) ?? wareSeat(meta.wareClips, frameKey);
      const offset = seat?.offsetGamePx ?? sprite?.offsetGamePx ?? [0, 0];
      const entry = { type, level, frameKey, atlasPath, footprintWidth: footprint[0], footprintHeight: footprint[1],
        anchor: seat?.origin ?? sprite?.anchor ?? [0.5, 1],
        scale: seat?.scale ?? V2_DRAW_SCALE * (sprite?.sourceScale ?? 1),
        offsetX: offset[0] * V2_DRAW_SCALE, offsetY: offset[1] * V2_DRAW_SCALE };
      if (type === 'wall' && (entry.scale !== contextWallSeat.scale || JSON.stringify(entry.anchor) !== JSON.stringify(contextWallSeat.origin) || entry.offsetX || entry.offsetY))
        throw new Error('wall5 baseline seat differs from the context wall seat');
      entries.push(entry);
    }
  }
  // Masks are generated from the exact web wall vocabulary (N=1 E=2 S=4 W=8 ->
  // wallRender.SHAPES); connectivity is presentation only. Frames are the wall5
  // intact baseline cells the web shows until the compositor batch is ready.
  const walls = [];
  for (let level = 1; level <= constants.LEVEL_STEP_BUILDING.length; level++) {
    for (const [mask, shape] of wallRender.SHAPES.entries()) {
      const frameKey = wallArt.wallFrameKey(level, shape);
      if (!index.has(frameKey)) throw new Error(`Missing canonical wall baseline ${frameKey}`);
      const model = entries.find((e) => e.type === 'wall' && e.level === level);
      walls.push({ ...model, mask, frameKey, atlasPath: index.get(frameKey) });
    }
  }
  const terrainFrame = 'tile_grass_1';
  if (!index.has(terrainFrame)) throw new Error('Missing authored terrain');
  const actors = [];
  for (const type of shared.TROOP_TYPES) {
    for (let level = 1; level <= constants.LEVEL_STEP_TROOP.length; level++) {
      const tier = shared.artTierOfLevel(level);
      const isWare = type === 'wyrmling';
      const frameKey = isWare ? shared.wareHatchlingFallbackKey(tier) : shared.v2FallbackFrameKey(type, tier);
      if (!index.has(frameKey)) throw new Error(`Missing current actor ${frameKey}`);
      const clip = isWare ? meta.wareClips[`ware_unt_hatchling_t${tier}_hover`]
        : meta.v2Clips[`v2_trp_${type}_t${tier}_${shared.V2_FALLBACK_STAND_STATES[type]}`]
          ?? meta.v2Clips[`v2_bld_${type}_t${tier}_${shared.V2_FALLBACK_STAND_STATES[type]}`];
      if (!clip?.anchorPx) throw new Error(`Missing authored actor anchor ${frameKey}`);
      const profile = profiles[type];
      const moveKey = profile && `v2_${profile.kind}_${type}_t${tier}_${profile.battleMove ?? profile.move}`;
      const movement = moveKey && meta.v2Clips[moveKey];
      let motion;
      if (movement) {
        const frames = Array.from({ length: movement.rows ?? movement.rowOrder?.length ?? 1 }, (_, row) => clipFrames(moveKey, movement, row));
        const atlasPath = `atlas/${shared.v2LocomotionAtlasGroup(type, tier)}@1x.json`;
        const frameData = JSON.parse(await readFile(path.join(stage, atlasPath), 'utf8'));
        const available = new Set(frameData.textures.flatMap((texture) => texture.frames.map((frame) => frame.filename)));
        if (!frames.flat().every((frame) => available.has(frame))) throw new Error(`Incomplete authored motion ${type}`);
        motion = { atlasPath, frames, rowOrder: movement.rowOrder ?? V2_DIRS, fps: movement.fps,
          anchor: [movement.anchorPx[0] / movement.cellW, movement.anchorPx[1] / movement.cellH],
          scale: V2_DRAW_SCALE * (constants.ART_V2.troopSourceScale[type] ?? 1) * constants.BATTLE_SCALE.troop };
        // First-frame troop movement is essential content. GL still admits only active scene groups.
        for (const file of files) if (file.path === atlasPath || file.path === atlasPath.replace(/\.json$/, '.png')) file.tier = 'core';
      }
      const actor = { type, level, ...(movement?.variants ? { variant: 0 } : {}), frameKey, atlasPath: index.get(frameKey), ...(motion ? { motion } : {}),
        anchor: [clip.anchorPx[0] / clip.cellW, clip.anchorPx[1] / clip.cellH],
        scale: V2_DRAW_SCALE * (constants.ART_V2.troopSourceScale[type] ?? 1) * constants.BATTLE_SCALE.troop };
      actors.push(actor);
      for (let variant = 1; variant < (movement?.variants ?? 1); variant++) {
        const stride = movement.variantStride ?? movement.frames;
        const packedMovement = { ...movement, frames: stride * movement.variants };
        const variantFrames = motion.frames.map((_, row) => Array.from({ length: stride }, (_, i) => frameName(moveKey, packedMovement, row, variant * stride + i + 1)));
        if (!variantFrames.flat().every((frame) => atlasFrames.get(motion.atlasPath)?.has(frame))) throw new Error(`Incomplete authored movement variant ${type}:${variant}`);
        actors.push({ ...actor, variant, frameKey: variantFrames[0][0], atlasPath: motion.atlasPath,
          anchor: motion.anchor, scale: motion.scale, motion: { ...motion, frames: variantFrames } });
      }
    }
  }
  for (const type of constants.HERO_KEYS) {
    // BattleScene/TroopFx retain the owner pack's 'theo' art namespace.
    const frameKey = `hero_${type === 'theodor' ? 'theo' : type}_idle_f1`;
    if (!index.has(frameKey)) throw new Error(`Missing hero ${frameKey}`);
    const anchor = meta.sprites[frameKey]?.anchor;
    if (!Array.isArray(anchor) || anchor.length !== 2 || !anchor.every(Number.isFinite)) throw new Error(`Missing authored hero anchor ${frameKey}`);
    actors.push({ type, level: 1, frameKey, atlasPath: index.get(frameKey),
      anchor, scale: V2_DRAW_SCALE * constants.BATTLE_SCALE.hero });
  }
  const legacyEntries = entries.filter(entry => !entry.phaseE);
  const combat = buildCombatCatalogue({ meta, index, atlasFrames, shared, constants, helpers: combatHelpers, profiles, entries: legacyEntries, actors, walls });
  const { presentation: basePresentation, builder } = await buildBasePresentation({ts,sourceFunction,sourceExpression,shared,constants,clipHelpers,depthHelpers,meta,index,atlasFrames,
    texts:{base:await readFile(path.join(source,'apps/web/src/game/scenes/BaseScene.ts'),'utf8'),ware:await readFile(path.join(source,wareSource),'utf8'),
      jobs:await readFile(path.join(source,'apps/web/src/game/world/jobs.ts'),'utf8')}});
  const wallRenderPath='packages/shared/src/wallRender.ts';
  const walls5=buildWalls5Section({constants,wallArt,wallRender,wallConnect:shared,meta,index,atlasFrames,levelCount:constants.LEVEL_STEP_BUILDING.length,
    expressions:Object.fromEntries(await Promise.all(['PALETTES','DIR','DIAG','edgeWeight'].map(async (name)=>[name,await sourceExpression(wallRenderPath,name)])))});
  const ground=await buildGroundSection({constants,baseVisual,groundEnvironment,publicRoot,readFile,put,decodePng,
    skirtTint:await sourceFunction('apps/web/src/game/world/underlay.ts','skirtTint',{resolveBaseVisualContext:baseVisual.resolveBaseVisualContext})});
  const fantasy=await buildFantasySection({constants,fantasyWorld,baseVisual,source,publicRoot,readFile,put});
  const layeredGround = await buildAcceptedLayeredGroundSection({ source,
    registry: JSON.parse(await readFile(path.join(source, 'art/realm-environments-v5/accepted.json'), 'utf8')), readFile, put,
    pinnedCatalogue: layeredGroundCatalogue.BASE_LAYERED_GROUND_V3,
    verifySources: async (...values) => (await load('scripts/src/layered-ground.ts')).verifyLayeredGroundSources(...values) });
  const layeredGroundV4 = await buildAcceptedLayeredGroundSection({ source,
    registry: JSON.parse(await readFile(path.join(source, 'art/realm-environments-v6/accepted.json'), 'utf8')
      .catch(error => { if (error.code !== 'ENOENT') throw error; return '{"schemaVersion":1,"status":"accepted","manifests":[]}'; })), readFile, put,
    pinnedCatalogue: layeredGroundCatalogue.BASE_LAYERED_GROUND_V4, groundRevision: 4,
    verifySources: async (...values) => (await load('scripts/src/layered-ground.ts')).verifyLayeredGroundSources(...values) });
  const layeredGroundPreview = await buildLayeredGroundSection({ source, previewManifest: layeredPreviewManifest, readFile, put,
    verifySources: async (...values) => (await load('scripts/src/layered-ground.ts')).verifyLayeredGroundSources(...values) });
  // Revision 5 (schemaVersion 3, docs/REALM-KIT-PLAN.md §2): the same hash-addressed registry pattern as r3/r4, pinned to
  // BASE_LAYERED_GROUND_V5 when the shared catalogue publishes it. A source without the pin (or with an empty registry)
  // exports no section, which contract 15 admits as valid. Both validators live in scripts/src/layered-ground.ts.
  const verifyRealmKitSources = realmKitVerifier(load);
  const layeredGroundV5 = layeredGroundCatalogue.BASE_LAYERED_GROUND_V5 === undefined ? undefined : await buildAcceptedLayeredGroundSection({ source,
    registry: JSON.parse(await readFile(path.join(source, 'art/realm-kit-v1/accepted.json'), 'utf8')
      .catch(error => { if (error.code !== 'ENOENT') throw error; return '{"schemaVersion":1,"status":"accepted","manifests":[]}'; })), readFile, put,
    pinnedCatalogue: layeredGroundCatalogue.BASE_LAYERED_GROUND_V5, groundRevision: 5, verifySources: verifyRealmKitSources });
  const layeredGroundV5Preview = await buildLayeredGroundSection({ source, previewManifest: realmKitPreviewManifest, readFile, put, verifySources: verifyRealmKitSources, groundRevision: 5 });
  const campPresentation = await buildCampAtlases({ actors, combatProfiles: combat.combatProfiles, publicRoot, readFile, put, decodePng,
    encodePng: ({data,width,height}) => sharp(data,{raw:{width,height,channels:4}}).png().toBuffer() });
  const baseAtlases = new Set([basePresentation.jobs.scaffold.atlasPath,...Object.values(basePresentation.jobs.builderByKeepLevel).flatMap((clips)=>Object.values(clips).map((clip)=>clip.atlasPath)),
    ...Object.values(basePresentation.obstacles).map((obstacle)=>obstacle.atlasPath)]);
  for (const file of files) if (baseAtlases.has(file.path) || baseAtlases.has(file.path.replace(/\.png$/, '.json'))) file.tier = 'core';
  for (const file of files) if (combat.requiredAtlases.includes(file.path) || combat.requiredAtlases.includes(file.path.replace(/\.png$/, '.json'))) file.tier = 'core';
  const leapSources = new Set(Object.values(combat.combatProfiles).filter((profile) => profile.leap).map((profile) => profile.leap.cancellationSource));
  if (leapSources.size !== 1) throw new Error('Leap cancellation provenance differs across tiers');
  carriedMetadata.leapCancellation = { source: [...leapSources][0] };
  // Contract 14 keeps historical ground art and adds revision-specific surfaces,
  // canonical home-loop speed and phone visibility. Legacy wall/builder views
  // retain their production baseline; SIM is unchanged. Contract 15 adds the optional
  // `layeredGroundV5` realm-kit section (published core, like r3/r4) and, with
  // --phase-e-services, the optional `phaseE` section; static heights come from the
  // legacy (non-Phase-E) entries, which equal `entries` when no service building is exported.
  const hitFeedback={...hitFeedbackPolicy,staticHeights:hitStaticHeights(legacyEntries,atlasFrames,walls5)};
  // Startup reads only the first 256 bytes for admission; identity precedes optional metadata.
  const renderCatalogue = { schemaVersion: 1, rendererContractVersion: RENDERER_CONTRACT_VERSION, sensoryPolicy, hitFeedback, archivePresentation, resultPresentation:resultCapture.policy, buildingDamageThreshold, entries, walls, actors, basePresentation, combatProfiles: combat.combatProfiles, combatEffects: combat.effects, combatCoverage: { ...combat.coverage, actorToEventHeroSkills: ACTOR_TO_EVENT_HERO_SKILLS, troopAbilityControllers: ['direwyvern:firestorm', 'direwyvern:maul', 'gloamfang:howl','gloamfang:leap','gloamfang:lunge'], burrowControllers: ['tunneler','bilgewraith'], carried: carriedMetadata },
    terrain: { frameKey: terrainFrame, atlasPath: index.get(terrainFrame), scale: V2_DRAW_SCALE, anchor: [0, 0] },
    walls5, builder, ground, fantasy, campPresentation, ...(phaseE ? { phaseE } : {}), ...(layeredGround ? { layeredGround } : {}), ...(layeredGroundV4 ? { layeredGroundV4 } : {}), ...(layeredGroundPreview ? { layeredGroundPreview } : {}),
    ...(layeredGroundV5 ? { layeredGroundV5 } : {}), ...(layeredGroundV5Preview ? { layeredGroundV5Preview } : {}) };
  await put('render-catalog.json', serial(renderCatalogue));
  // Preserve original animation/anchor metadata and audio bytes, never re-encode masters here.
  async function copyOptionalTree(relative) {
    const entries = (await readdir(path.join(publicRoot, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Generated content cannot contain symlinks: ${child}`);
      if (entry.isDirectory()) await copyOptionalTree(child);
      else if (entry.isFile() && /\.(ogg|mp3|wav|png|json)$/.test(entry.name)) await put(child, await readFile(path.join(publicRoot, child)), 'optional');
    }
  }
  // atlas/fantasy/** was copied by the realm sections above with digest proofs;
  // atlas/retired-deeds/** is excluded from every client pack (server-only archive).
  for (const dir of ['audio', 'brand']) await copyOptionalTree(dir);
  // Extract the canonical scenario factories without importing the Vitest runner.
  // Inputs and complete events are regenerated with the source simulator, then
  // checked against its committed goldens. They are debug assets, never player data.
  const goldenSource = await readFile(path.join(source, 'packages/sim/tests/golden.test.ts'), 'utf8');
  const parsed = ts.createSourceFile('golden.ts', goldenSource, ts.ScriptTarget.Latest, true);
  let initializer;
  for (const statement of parsed.statements) {
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(parsed) === 'SCENARIOS') initializer = declaration.initializer.getText(parsed);
    }
  }
  if (!initializer) throw new Error('Canonical golden scenario export needs updating');
  const helpers = await load('packages/sim/tests/helpers.ts');
  const { simulateRaid } = await load('packages/sim/src/sim.ts');
  let captured;
  const capture = (...input) => { captured = input; return simulateRaid(...input); };
  const expression = ts.transpile(`const scenarios = ${initializer}; return scenarios;`, { target: ts.ScriptTarget.ES2022 });
  const factories = new Function('BuildingType', 'b', 'base', 'deploy', 'orders', 'wallLine', 'wallRing', 'simulateRaid', expression)(
    shared.BuildingType, helpers.b, helpers.base, helpers.deploy, helpers.orders, helpers.wallLine, helpers.wallRing, capture);
  for (const [name, run] of Object.entries(factories)) {
    helpers.resetIds();
    const simulation = run();
    const expected = JSON.parse(await readFile(path.join(source, `packages/sim/tests/fixtures/${name}.json`), 'utf8'));
    if (helpers.fnv1a(JSON.stringify(simulation.events)) !== expected.hash) throw new Error(`Golden divergence: ${name}`);
    await put(`fixtures/${name}.json`, serial({ schemaVersion: 1, sourceCommit, simVersion: SIM_VERSION,
      snapshot: captured[0], orders: captured[1], seed: captured[2], options: captured[3] ?? {}, ...simulation }), 'optional');
    if (name === 'mixed_assault') {
      await put('fixtures/base.json', serial({ ...captured[0],
        buildings: captured[0].buildings.map((building) => ({ ...building, underConstruction: false })) }), 'optional');
      await put('fixtures/replay.json', serial({ id: 'fixture-mixed-assault', snapshot: captured[0],
        simVersion: SIM_VERSION, events: simulation.events, result: simulation.outcome,
        armySnapshot: { levels: captured[3]?.troopLevels ?? {} }, timeline: { sha256: sha256(JSON.stringify(simulation.events)),
          durationMs: Math.max(...simulation.events.map((event) => event.t)) * (1000 / TICKS_PER_SEC) } }), 'optional');
    }
  }
  // The ground section's realm paintings live under atlas/fantasy and were copied as optional;
  // the renderer reads them straight from the catalogue, so they must be installed (core).
  // The fantasy (globe) section stays optional until the globe renders on device.
  // The layered sections (r3/r4/r5) publish their own files core-tier in layered-ground-catalog.mjs; the
  // promotion list below covers sections whose files were copied optional first.
  const promotedGround = promoteCatalogueReferences(files, renderCatalogue, ['terrain', 'walls5', 'builder', 'ground']);
  assertServiceOptionalFiles(phaseE, files, phaseECore ? 'core' : 'optional');
  console.log(`Promoted ${promotedGround.length} catalogue-referenced files to core`);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest = { schemaVersion: 1, sourceCommit, simVersion: SIM_VERSION, rendererContractVersion: RENDERER_CONTRACT_VERSION, cataloguePath: 'catalogue.json',
    renderCataloguePath: 'render-catalog.json', atlasMetadataPath: 'atlas/meta.json', contractPath: 'contracts.json',
    kotlinModelsPath: 'kotlin/NativeContracts.kt',
    ...(buildingKinds.omitted ? { phaseEBuildings: 'omitted', phaseEOmittedTypes: buildingKinds.omitted } : {}), files };
  manifest.contentVersion = manifestVersion(manifest);
  await writeFile(path.join(stage, 'manifest.json'), serial(manifest));
  // Refuse overwrite: a contract pack is an immutable release artifact.
  try { await readFile(path.join(output, 'manifest.json')); throw new Error('Output pack already exists'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  await rename(stage, output);
  console.log(`Exported ${files.length} files (${files.filter((f) => f.tier === 'core').length} core); source ${sourceCommit}; pack ${manifest.contentVersion}`);
} finally { await rm(stage, { recursive: true, force: true }); }
