import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {captureGiantLanding} from './giant-sensory.mjs';
import {captureKegDetonation} from './keg-sensory.mjs';
import {captureDeployHaptics} from './deploy-sensory.mjs';

/** Optional renderer policy captured from the unchanged juice module and installed Phaser. */
export async function captureSensoryPolicy(source) {
  const ts=(await import(pathToFileURL(path.join(source,'scripts/node_modules/typescript/lib/typescript.js')).href)).default;
  const req=createRequire(path.join(source,'apps/web/package.json'));
  const phaser=path.dirname(req.resolve('phaser/package.json'));
  const texts={};
  const read=async(name,file=path.join(source,name))=>texts[name]=await readFile(file,'utf8');
  const juice=await read('apps/web/src/lib/juice.ts');
  const ast=ts.createSourceFile('juice.ts',juice,ts.ScriptTarget.Latest,true);
  const declaration=name=>{
    const node=ast.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations]).find(n=>n.name.getText(ast)===name);
    if(!node?.initializer)throw new Error(`Missing sensory source ${name}`);
    return node.initializer.getText(ast);
  };
  const compile=(text,bindings={})=>new Function(...Object.keys(bindings),ts.transpile(text,{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
  const cap=compile(`return ${declaration('CONCURRENT_SHAKE_CAP')};`);
  const patterns=compile(`return (${declaration('PATTERN')});`);
  if(!Number.isSafeInteger(cap)||cap<=0||!Number.isSafeInteger(patterns.medium)||patterns.medium<=0)throw new Error('Unsupported sensory policy bounds');
  const functionText=name=>{
    const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
    if(!node)throw new Error(`Missing sensory function ${name}`);
    return node.getText(ast).replace(/^export\s+/,'');
  };
  const shake=compile(`const CONCURRENT_SHAKE_CAP=${cap};let activeShakes=0;${functionText('shake')} return shake;`,{reduceMotionOn:()=>false});
  const timers=[],calls=[];
  const scene={cameras:{main:{shake:(...args)=>calls.push(args)}},time:{delayedCall:(...args)=>timers.push(args)}};
  for(let n=0;n<cap+1;n++)shake(scene,123,.007);
  if(calls.length!==cap||calls.some(c=>JSON.stringify(c)!=='[123,0.007]')||timers.length!==cap)throw new Error('Source shake admission/force changed');
  timers[0][1]();shake(scene,123,.007);
  if(calls.length!==cap+1)throw new Error('Source shake budget release changed');
  const hapticCalls=[];
  const haptic=compile(`const PATTERN=(${declaration('PATTERN')});${functionText('haptic')}return haptic;`,
    {reduceMotionOn:()=>false,hapticsOn:()=>true,navigator:{vibrate:p=>hapticCalls.push(p)}});
  for(const kind of ['heavy','medium',...Array(cap+1).fill('light')])haptic(kind);
  if(JSON.stringify(hapticCalls)!==JSON.stringify([patterns.heavy,patterns.medium,...Array(cap+1).fill(patterns.light)]))
    throw new Error('Source haptic ordering, pattern or independent budget changed');
  await read('phaser/Shake.js',path.join(phaser,'src/cameras/2d/effects/Shake.js'));
  const config=await read('phaser/Config.js',path.join(phaser,'src/core/Config.js'));
  const game=await read('apps/web/src/game/PhaserGame.tsx');
  const gameAst=ts.createSourceFile('game.tsx',game,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let pixelArt=false;const visit=n=>{if(ts.isPropertyAssignment(n)&&n.name.getText(gameAst)==='pixelArt'&&n.initializer.kind===ts.SyntaxKind.TrueKeyword)pixelArt=true;ts.forEachChild(n,visit);};visit(gameAst);
  if(!pixelArt||!config.includes('if (this.pixelArt)')||!config.includes('this.roundPixels = true;'))throw new Error('Source camera pixel rounding changed');
  const Shake=req(path.join(phaser,'src/cameras/2d/effects/Shake.js'));
  const samples=[];
  // Probe the actual library. Injection is confined to these synchronous test calls.
  const originalRandom=Math.random;
  try {
    for(const zoom of [.5,1,2])for(const random of [0,.25,.5,.75,.999]) {
      const camera={width:801,height:603,zoom,roundPixels:true,emit(){},matrix:{translate(){}}};
      const effect=new Shake(camera);effect.start(150,.004);Math.random=()=>random;
      effect.update(0,10);
      const x=Math.round((random*.004*camera.width*2-.004*camera.width)*zoom);
      const y=Math.round((random*.004*camera.height*2-.004*camera.height)*zoom);
      if(effect._offsetX!==x||effect._offsetY!==y)throw new Error('Source shake viewport/zoom algorithm changed');
      effect.start(900,.8);if(effect.duration!==150)throw new Error('Source shake now replaces an active effect');
      samples.push({zoom,random,x,y});effect.update(0,140);
      if(effect.isRunning||effect._offsetX!==0||effect._offsetY!==0)throw new Error('Source shake expiry changed');
    }
  } finally {Math.random=originalRandom;}
  // Service probe inputs are recorded apart from the policy hashes: the exported pack's sensoryPolicy stays byte-identical.
  const serviceTexts={};
  const events=await captureEventHaptics(ts,read,compile,patterns,async name=>serviceTexts[name]=await readFile(path.join(source,name),'utf8'));
  const mortar=await captureMortarLanding(ts,read,compile);
  const mortarRevisions=await captureMortarRevisions(ts,read,compile);
  const giant=await captureGiantLanding(ts,read,compile);
  const keg=await captureKegDetonation(ts,read,compile);
  const deploy=await captureDeployHaptics(ts,read,compile);
  return {policy:{version:1,concurrentShakeCap:cap,mediumHapticMs:patterns.medium,eventHaptics:{...events.policy,deployment:deploy.policy},deploymentPreview:deploy.preview,mortarLanding:mortar.policy,giantLanding:giant.policy,kegDetonation:keg.policy,camera:{overlap:'ignore',offset:'uniformViewportZoom',roundPixels:true,clock:'frameDelta'},
    sourceHashes:Object.fromEntries(Object.entries(texts).map(([n,t])=>[n,createHash('sha256').update(t).digest('hex')]))},samples,eventCases:events.cases,
    ...(Object.keys(serviceTexts).length?{serviceSourceHashes:Object.fromEntries(Object.entries(serviceTexts).map(([n,t])=>[n,createHash('sha256').update(t).digest('hex')]))}:{}),mortarCases:mortar.cases,mortarRevisions,giantCases:giant.cases,kegCases:keg.cases,deployment:{cases:deploy.cases,cleanup:deploy.cleanup,queues:deploy.queues,previewSamples:deploy.previewSamples}};
}

/** Execute the actual fire token, projectile admission/completion, and pool cancellation.
 * Test sprites/heading are inert; they never replace the source callback or scheduler. */
async function captureMortarLanding(ts,read,compile) {
  const parse=async relative=>{const text=await read(relative);return ts.createSourceFile(relative,text,ts.ScriptTarget.Latest,true);};
  const defense=await parse('apps/web/src/game/v2/defense.ts');
  const projectile=await parse('apps/web/src/game/v2/projectiles.ts');
  const clips=await parse('apps/web/src/game/v2/clips.ts');
  const effects=await parse('apps/web/src/game/v2/effects.ts');
  const node=(ast,name)=>{
    const value=ast.statements.find(n=>(ts.isClassDeclaration(n)||ts.isFunctionDeclaration(n))&&n.name?.text===name);
    if(!value)throw new Error(`Missing mortar source ${name}`);return value.getText(ast).replace(/^export\s+/,'');
  };
  const value=(ast,name)=>{
    const n=ast.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations]).find(n=>n.name.getText(ast)===name)?.initializer;
    if(!n)throw new Error(`Missing mortar source value ${name}`);return compile(`return ${n.getText(ast)};`);
  };
  const Pool=compile(`${node(effects,'CombatEffectPool')};return CombatEffectPool;`,{UPDATE:value(effects,'UPDATE'),SHUTDOWN:value(effects,'SHUTDOWN')});
  const profiles=value(clips,'V2_PROJ');const tickMs=value(clips,'V2_TICK_MS');
  const parseFxAt=compile(`${node(clips,'parseFxAt')};return parseFxAt;`);
  const cls=defense.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V2DefenseFx');
  const methods=['fire','collapse','destroy'].map(name=>{
    const method=cls?.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(defense)===name);
    if(!method)throw new Error(`Missing mortar controller ${name}`);return method.getText(defense);
  }).join('\n');
  const durationMs=profiles.shell.travelTicks*tickMs;
  const cases=[];
  const run=(name,{kind='shell',missing='',collapse='',clear=false,rate=1}={})=>{
    let elapsed=0,registration;const calls=[];let launches=0;
    const sprite=()=>{const s={active:true,x:10,y:20,depth:1,destroy(){this.active=false;}};
      for(const name of ['setDepth','setOrigin','setScale','setPosition','setTexture','setAlpha'])s[name]=()=>s;return s;};
    const scene={events:{on(){},once(){}},textures:{exists:()=>missing!=='texture'},add:{image:()=>{launches++;return sprite();}}};
    const pool=new Pool(scene);pool.setTimeScale(rate);
    const launch=compile(`${node(projectile,'launchV2Projectile')};return launchV2Projectile;`,{
      V2_PROJ:profiles,V2_TICK_MS:tickMs,V2_DRAW_SCALE:1,PROJ_Y_FORESHORTEN:value(clips,'PROJ_Y_FORESHORTEN'),
      DEPTH_PROJ:1,DEPTH_SHADOW:0,atlasGroupFor:()=> 'travel',frameName:base=>base,
      headingRow:()=>0,clipFrames:()=>['travel'],shadowFrame:()=>1,toWorldPx:n=>n,
      combatEffectPool:()=>pool,playV2Fx:()=>null,
    });
    const owner=compile(`class Owner {${methods}};return Owner.prototype;`,{
      facingRow:()=>0,facing8:()=>0,parseFxAt,clipFrames:()=>['f1','f2','f3'],v2BldArtFit:()=>1,
      emitterWorld:()=>({x:10,y:20,axisDeg:0}),playV2MuzzleFx(){},launchV2Projectile:launch,
      shake:(_,duration,intensity)=>calls.push({at:elapsed,kind:'shake',duration,intensity}),
      haptic:strength=>calls.push({at:elapsed,kind:'haptic',strength}),
    });
    const actor=Object.assign(Object.create(owner),{token:0,collapsed:false,sprite:sprite(),scene,
      deps:{unit:kind==='shell'?'mortar':'cannon',tier:1,clips:missing==='travel'?{}:{[`v2_fx_${kind}_t1`]:{fps:12}},
        ticker:{play:(_,p)=>{registration=p;},unregister(){}}},base:s=>s,
      clip:s=>s==='fire'&&missing!=='fire'?{fxAt:`${kind}@2`,fps:14}:undefined});
    actor.fire(100,200);
    const shot=registration;
    if(collapse==='before')actor.collapse();
    // Repeating the authored frame must not release a second projectile.
    for(const frame of [1,2,3,3])shot?.onFrame(frame);
    if(collapse==='after')actor.collapse();
    if(clear)pool.clear();
    const before=[...calls];elapsed=durationMs/rate-1;pool.tick(elapsed);
    const early=[...calls];elapsed+=1;pool.tick(1);pool.tick(durationMs);
    const record={name,kind,missing,collapse,clear,rate,launches,before,early,calls};cases.push(record);return record;
  };
  const normal=run('mortar-landing');
  for(const missing of ['fire','travel','texture'])run(`missing-${missing}`,{missing});
  run('cannon-has-no-heavy-callback',{kind:'cannonball'});
  run('collapse-before-release',{collapse:'before'});run('collapse-after-release',{collapse:'after'});
  run('cleared-flight-never-completes',{clear:true});run('double-rate-landing',{rate:2});
  if(normal.launches!==1||normal.before.length||normal.early.length||normal.calls.length!==2||normal.calls.some(c=>c.at!==durationMs))
    throw new Error('Mortar source callback timing changed');
  return {policy:{effects:normal.calls.map(({at,...cue})=>cue),clock:'sceneTimeScale',owner:'releasedFlight',requiresTravel:true,requiresImpact:false},cases};
}



/** The actual live-replacement guard retains pools until rendered actor history changes. */
async function captureMortarRevisions(ts,read,compile) {
  const text=await read('apps/web/src/game/scenes/BattleScene.ts');
  const ast=ts.createSourceFile('BattleScene.ts',text,ts.ScriptTarget.Latest,true);
  const history=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='changedPlaybackActors');
  const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='BattleScene');
  const start=cls?.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)==='startPlayback');
  const guards=[];let resets=0;
  const visit=n=>{
    if(ts.isIfStatement(n)&&n.thenStatement.getText(ast).includes('resetPlaybackActors.call'))guards.push(n);
    if(ts.isCallExpression(n)&&n.expression.getText(ast)==='BattleScene.prototype.resetPlaybackActors.call')resets++;
    ts.forEachChild(n,visit);
  };
  if(!history||!start)throw new Error('Missing source playback continuity contract');
  visit(start);
  if(guards.length!==1||resets!==1)throw new Error('Source playback reset ownership changed');
  const probe=compile(`${history.getText(ast).replace(/^export\s+/,'')};return function(previous,events,fromTick) {
    const changed=changedPlaybackActors(previous,events,fromTick);let clears=0;
    const BattleScene={prototype:{resetPlaybackActors(){clears++;},applyPlaybackStateRange(){}}};
    (function(){${guards[0].getText(ast)}}).call({});return {changed:[...changed],clears};
  };`);
  const fire={e:'fire',t:1,id:'mortar',proj:'shell',ix:1024,iy:1024};
  const hit={e:'hit',t:1,id:'other',target:'mortar',dmg:1};
  return [
    ['append-before-release',[fire],[fire,{e:'star',t:20,n:1}],1.5],
    ['append-after-release',[fire],[fire,{e:'star',t:20,n:1}],5],
    ['corrected-fire',[fire],[{...fire,ix:2048}],5],
    ['inserted-rendered-hit',[fire],[fire,hit],5],
    ['reordered-rendered-actor',[fire,hit],[hit,fire],5],
    ['future-correction',[fire,{...hit,t:20}],[fire,{...hit,t:20,dmg:2}],5],
  ].map(([name,previous,next,through])=>({name,...probe(previous,next,through)}));
}

export async function captureEventHaptics(ts,read,compile,patterns,readService=read) {
  const text=await read('apps/web/src/game/scenes/BattleScene.ts');
  const ast=ts.createSourceFile('BattleScene.ts',text,ts.ScriptTarget.Latest,true);
  const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='BattleScene');
  const method=name=>{
    const node=cls?.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)===name);
    if(!node)throw new Error(`Missing event haptic source ${name}`);
    return node;
  };
  const thresholds={};
  const visit=n=>{
    if(ts.isBinaryExpression(n)&&n.left.getText(ast)==='n'&&ts.isNumericLiteral(n.right)) {
      if(n.operatorToken.kind===ts.SyntaxKind.GreaterThanEqualsToken)thresholds.heavyAt=Number(n.right.text);
      if(n.operatorToken.kind===ts.SyntaxKind.EqualsEqualsEqualsToken)thresholds.mediumAt=Number(n.right.text);
    }
    ts.forEachChild(n,visit);
  };
  visit(method('onStar'));
  if(!(thresholds.heavyAt>thresholds.mediumAt&&thresholds.mediumAt>0))throw new Error('Source star haptic thresholds changed');
  const verdict=ast.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations])
    .find(n=>n.name.getText(ast)==='VERDICT_STATE_EVENTS')?.initializer;
  if(!verdict)throw new Error('Missing cold-event dispatcher state contract');
  // New service scenes import this predicate; old pinned14 sources neither read
  // these inputs nor acquire new provenance hashes/cases. Bind the source itself,
  // not a false stub that would accidentally probe the legacy collapse branch.
  let phaseE;
  if(method('onDestroyed').getText(ast).includes('isPhaseEBuilding')) {
    const constants=ts.createSourceFile('constants.ts',await read('packages/shared/src/constants.ts'),ts.ScriptTarget.Latest,true);
    const declaration=constants.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations])
      .find(n=>n.name.getText(constants)==='PHASE_E_BUILDINGS')?.initializer;
    const presentation=ts.createSourceFile('presentation.ts',await read('apps/web/src/game/phaseE/presentation.ts'),ts.ScriptTarget.Latest,true);
    const predicate=presentation.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='isPhaseEBuilding');
    if(!declaration||!predicate)throw new Error('Missing canonical service building predicate');
    const buildings=compile(`return ${declaration.getText(constants)};`);
    const isPhaseEBuilding=compile(`${predicate.getText(presentation).replace(/^export\s+/,'')};return isPhaseEBuilding;`,{PHASE_E_BUILDINGS:buildings});
    if(!Array.isArray(buildings.types)||!buildings.types.length||buildings.types.some(type=>typeof type!=='string'||!isPhaseEBuilding(type)))
      throw new Error('Invalid canonical service building identities');
    phaseE={types:buildings.types,isPhaseEBuilding};
  }
  const ownerMethods=['apply','onStar','onRally','onDestroyed','onTrap'];
  let marketBindings={};
  // Current collapse routing asks the scene whether this body owns Market art.
  // Keep its actual method and both source dependencies; a constant predicate
  // would silently change the branch being measured. Older scenes read neither.
  if(method('onDestroyed').getText(ast).includes('this.ownsMarketArt(')) {
    const market=ts.createSourceFile('marketArt.ts',await read('apps/web/src/game/world/marketArt.ts'),ts.ScriptTarget.Latest,true);
    const family=market.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='marketArtFamilyOf');
    const frame=market.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations])
      .find(n=>n.name.getText(market)==='MARKET_FRAME_KEY')?.initializer;
    if(!family||!frame)throw new Error('Missing canonical Market ownership dependency');
    marketBindings=compile(`${family.getText(market).replace(/^export\s+/,'')};const MARKET_FRAME_KEY=${frame.getText(market)};return {marketArtFamilyOf,MARKET_FRAME_KEY};`);
    // r12 (night 2026-10-06): ownsMarketArt also reads the harvester sentinel key from world/harvesterArt.ts.
    // Bind the source's own literal so the measured branch keeps its real predicate; older scenes never name it.
    if(method('ownsMarketArt').getText(ast).includes('HARVESTER_UNPRESENTED_KEY')) {
      const harvester=ts.createSourceFile('harvesterArt.ts',await read('apps/web/src/game/world/harvesterArt.ts'),ts.ScriptTarget.Latest,true);
      const sentinel=harvester.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations])
        .find(n=>n.name.getText(harvester)==='HARVESTER_UNPRESENTED_KEY')?.initializer;
      if(!sentinel||!ts.isStringLiteral(sentinel))throw new Error('Missing canonical harvester sentinel key dependency');
      marketBindings={...marketBindings,HARVESTER_UNPRESENTED_KEY:sentinel.text};
    }
    ownerMethods.push('ownsMarketArt');
  }
  // 427381a2 (night server line, what production deploys) has no service predicate: onDestroyed plays
  // the ordinary light collapse haptic for every live building, then routes a service body by the Market
  // seam (ownsMarketArt) or its berth type to its controller or static fallback. Probe every canonical
  // type and body through the actual dispatcher.
  let services;
  if(!phaseE&&ownerMethods.includes('ownsMarketArt')) {
    const constants=ts.createSourceFile('constants.ts',await readService('packages/shared/src/constants.ts'),ts.ScriptTarget.Latest,true);
    const declaration=constants.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations])
      .find(n=>n.name.getText(constants)==='PHASE_E_BUILDINGS')?.initializer;
    if(!declaration)throw new Error('Missing canonical service building identities');
    const buildings=compile(`return ${declaration.getText(constants)};`);
    const destroyed=method('onDestroyed').getText(ast);
    services=(Array.isArray(buildings.types)?buildings.types:[]).map(type=>{
      if(typeof type!=='string')throw new Error('Invalid canonical service building identities');
      if(marketBindings.marketArtFamilyOf(type)!==null) {
        const rest=`pe_${type==='harvester'?'harvester_frostveil':type}_t1_idle_f1`;
        if(!marketBindings.MARKET_FRAME_KEY.test(rest))throw new Error(`Canonical Market frame grammar no longer names ${type}`);
        const bodies=[['controller',{artMode:'market',key:rest,controller:'market'}],['pending',{key:rest}]];
        bodies.push(type==='harvester'?['unpresented',{key:marketBindings.HARVESTER_UNPRESENTED_KEY}]:['ordinary',{key:`bld_${type}_l1`}]);
        return {type,bodies};
      }
      if(type===buildings.berthType&&destroyed.includes(`b.type === '${type}'`))
        return {type,bodies:[['controller',{artMode:'berth',controller:'berth'}],['pending',{}]]};
      throw new Error(`Unrouted canonical service building type ${type}`);
    });
    if(!services.length)throw new Error('Invalid canonical service building identities');
  }
  const calls=[];
  const owner=compile(`const VERDICT_STATE_EVENTS=${verdict.getText(ast)};class BattleScene {${ownerMethods.map(n=>method(n).getText(ast).replace(/^private\s+/,'' )).join('\n')}}return BattleScene.prototype;`,
    {haptic:kind=>calls.push(kind),isWareBuildingUnit:()=>false,isWareTrapUnit:()=>false,cancelDefenceFire(){},...(phaseE?{isPhaseEBuilding:phaseE.isPhaseEBuilding}:{}),...marketBindings});
  const routes=[];
  const instance=(present=true,jumping=false,type='cannon',body={})=>{
    const sprite={setTexture(){return this;},setOrigin(){return this;},clearTint(){return this;}};
    const record=(route,...actions)=>Object.fromEntries(actions.map(action=>[action,()=>routes.push([route,action])]));
    const building={type,fw:1,fh:1,sprite,damage:body.routed?record('damage','collapse','destroy'):{collapse(){},destroy(){}},
      ...(body.key===undefined?{}:{key:body.key}),...(body.artMode?{artMode:body.artMode}:{}),
      ...(body.controller?{[body.controller]:record(body.controller,'collapse','destroy')}:{})};
    return Object.assign(Object.create(owner),{jumping,buildings:new Map(present?[['base',building]]:[]),
      meta:{},anim:{unregister(){}},emitProgress(){},syncPhaseEServices(){this.phaseESyncs=(this.phaseESyncs??0)+1;},
      // The static fallbacks only re-key art once the family is resident; record which one the dispatcher chose.
      applyMarketFallbackState(id,b,state){routes.push(['marketFallback',state]);},
      applyBerthFallbackState(id,b,state){routes.push(['berthFallback',state]);}});
  };
  const cases=[];
  const probe=(name,events,{present=true,jumping=false,type,variant,body}={})=>{
    calls.length=0;routes.length=0;const scene=instance(present,jumping,type,variant?{...body,routed:true}:undefined);
    for(const e of events)scene.apply(e);
    cases.push({name,events,present,jumping,calls:[...calls],...(type&&variant?{type,variant,routes:[...routes]}:
      type?{type,combat:scene.buildings.get('base')?.phaseECombat,syncs:scene.phaseESyncs??0}:{})});return [...calls];
  };
  const event=(e,n)=>({e,t:1,...(e==='star'?(n===undefined?{}:{n}):e==='rally'?{}:{id:'base'})});
  for(const n of [undefined,0,thresholds.mediumAt,thresholds.mediumAt+.5,thresholds.heavyAt,thresholds.heavyAt+1])
    probe(`star-${n??'missing'}`,[event('star',n)]);
  const fixed=Object.fromEntries(['rally','destroyed','trap'].map(e=>[e,probe(e,[event(e)])[0]]));
  for(const e of ['destroyed','trap']) {
    probe(`${e}-missing`,[event(e)],{present:false});probe(`${e}-cold`,[event(e)],{jumping:true});
    probe(`${e}-repeated`,[event(e),event(e)]);
  }
  for(const e of ['star','rally'])probe(`${e}-cold`,[event(e,thresholds.heavyAt)],{jumping:true});
  probe('same-time-source-order',[event('star',thresholds.heavyAt),event('rally'),event('trap'),event('star',0)]);
  for(const type of phaseE?.types??[])for(const jumping of [false,true])
    probe(`service-${type}-${jumping?'cold':'live'}`,[event('destroyed')],{type,jumping});
  for(const {type,bodies} of services??[])for(const [variant,body] of bodies)for(const jumping of [false,true])
    probe(`service-${type}-${variant}-${jumping?'cold':'live'}`,[event('destroyed')],{type,variant,body,jumping});
  const normalized=Object.fromEntries(Object.entries(patterns).map(([kind,p])=>[kind,Array.isArray(p)?p:[p]]));
  for(const kind of ['light','medium','heavy'])if(!normalized[kind]?.length||normalized[kind].length%2!==1||
    normalized[kind].some(n=>!Number.isSafeInteger(n)||n<=0))throw new Error('Unsupported source haptic pattern');
  for(const c of cases)for(const kind of c.calls)if(!normalized[kind])throw new Error('Unknown source haptic strength');
  return {policy:{patterns:normalized,star:thresholds,fixed,overlap:'replace',budget:'none'},cases};
}
