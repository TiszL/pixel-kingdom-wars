import {captureFacing8StablePlan} from './combat-catalog.mjs';

/** Execute the source rich Giant controller, scene route, ticker and released pool.
 * Drawing helpers are inert; callback admission and cancellation remain source code. */
export async function captureGiantLanding(ts,read,compile) {
  const parse=async relative=>ts.createSourceFile(relative,await read(relative),ts.ScriptTarget.Latest,true);
  const troop=await parse('apps/web/src/game/v2/troop.ts');
  const sceneAst=await parse('apps/web/src/game/scenes/BattleScene.ts');
  const projectile=await parse('apps/web/src/game/v2/projectiles.ts');
  const clips=await parse('apps/web/src/game/v2/clips.ts');
  const effects=await parse('apps/web/src/game/v2/effects.ts');
  const tickerAst=await parse('apps/web/src/game/v2/ticker.ts');
  const declaration=(ast,name)=>{
    const n=ast.statements.find(n=>(ts.isClassDeclaration(n)||ts.isFunctionDeclaration(n))&&n.name?.text===name);
    if(!n)throw new Error(`Missing Giant source ${name}`);return n.getText(ast).replace(/^export\s+/,'');
  };
  const initializer=(ast,name)=>{
    const n=ast.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations])
      .find(n=>n.name.getText(ast)===name)?.initializer;
    if(!n)throw new Error(`Missing Giant source value ${name}`);return n.getText(ast);
  };
  const value=(ast,name)=>compile(`return ${initializer(ast,name)};`);
  const hasSyncHealth=troop.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V2TroopFx')?.members
    .some(n=>ts.isMethodDeclaration(n)&&n.name.getText(troop)==='syncHealth');
  // Current onHit delegates to this canonical helper. Keep older controllers'
  // inline behavior, and capture the shared policy rather than stubbing health.
  const bodyPolicy=hasSyncHealth?value(await parse('packages/shared/src/constants.ts'),'BATTLE_BODY_PRESENTATION'):undefined;
  const methods=(ast,owner,names)=>{
    const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text===owner);
    return names.map(name=>{
      const n=cls?.members.find(n=>(ts.isMethodDeclaration(n)||ts.isGetAccessorDeclaration(n))&&n.name.getText(ast)===name);
      if(!n)throw new Error(`Missing Giant method ${owner}.${name}`);
      return n.getText(ast).replace(/^private\s+/,'');
    }).join('\n');
  };
  const Pool=compile(`${declaration(effects,'CombatEffectPool')};return CombatEffectPool;`,
    {UPDATE:value(effects,'UPDATE'),SHUTDOWN:value(effects,'SHUTDOWN')});
  const Ticker=compile(`${declaration(tickerAst,'V2Ticker')};return V2Ticker;`,
    {SCENE_UPDATE:value(tickerAst,'SCENE_UPDATE'),SCENE_SHUTDOWN:value(tickerAst,'SCENE_SHUTDOWN')});
  const profiles=value(clips,'V2_PROJ');const tickMs=value(clips,'V2_TICK_MS');
  const hysteresis=value(clips,'FACING8_HYSTERESIS_DEG');
  const stable=compile(`const FACING8_HYSTERESIS_DEG=${hysteresis};const FACING_ANGLE=${initializer(clips,'FACING_ANGLE')};
    ${declaration(clips,'facing8')};${declaration(clips,'facing8Stable')};return facing8Stable;`);
  const aim=captureFacing8StablePlan(ts,clips.text,stable,{FACING8_HYSTERESIS_DEG:hysteresis});
  const initialFacing=troop.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V2TroopFx')?.members
    .find(n=>ts.isPropertyDeclaration(n)&&n.name.getText(troop)==='facing')?.initializer?.getText(troop);
  if(!initialFacing)throw new Error('Missing source Giant initial facing');
  const parseFxAt=compile(`${declaration(clips,'parseFxAt')};return parseFxAt;`);
  const atlas=JSON.parse(await read('apps/web/public/atlas/meta.json'));
  const throwClip=atlas.v2Clips.v2_trp_giant_t1_throw;
  if(!throwClip)throw new Error('Missing exact Giant source throw clip');
  const cases=[];
  const run=(name,{missing='',mode='rich',death='',clear=false,rate=1,cold=false,flinch=false,replace='',replaceAt=100,wakeAt=0,wakeRow=false}={})=>{
    let elapsed=0,launches=0,legacy=0;const calls=[],impacts=[],facings=[];
    const sprite=()=>{const s={active:true,x:10,y:20,depth:1,displayHeight:128,destroy(){this.active=false;},once(){}};
      for(const method of ['setDepth','setOrigin','setScale','setPosition','setTexture','setAlpha','setVisible'])s[method]=()=>s;return s;};
    const scene={events:{on(){},once(){}},textures:{exists:()=>missing!=='texture'},
      add:{image:()=>{launches++;return sprite();}},tweens:{killTweensOf(){},add(){}}};
    const pool=new Pool(scene);pool.setTimeScale(rate);const ticker=new Ticker();ticker.setTimeScale(rate);
    const launch=compile(`${declaration(projectile,'launchV2Projectile')};return launchV2Projectile;`,{
      V2_PROJ:profiles,V2_TICK_MS:tickMs,V2_DRAW_SCALE:1,PROJ_Y_FORESHORTEN:value(clips,'PROJ_Y_FORESHORTEN'),
      DEPTH_PROJ:1,DEPTH_SHADOW:0,atlasGroupFor:()=> 'travel',frameName:base=>base,
      headingRow:()=>0,clipFrames:()=>['travel'],shadowFrame:()=>1,toWorldPx:n=>n,
      combatEffectPool:()=>pool,playV2Fx:(_scene,_clips,_base,x,y)=>{impacts.push({x,y});return null;},
    });
    const owner=compile(`class Owner {${methods(troop,'V2TroopFx',['alive','onSiegeThrow','playOnce','onHit','onMeleeAttack','onPos','playLoop','onDeath','destroy',...(hasSyncHealth?['syncHealth']:[])])}};return Owner.prototype;`,{
      BATTLE_BODY_PRESENTATION:bodyPolicy,
      facing8Stable:stable,parseFxAt,toWorldPx:n=>n,actorDepth:n=>n,launchV2Projectile:launch,
      shake:(_,duration,intensity)=>calls.push({at:elapsed,kind:'shake',duration,intensity}),
      haptic:strength=>calls.push({at:elapsed,kind:'haptic',strength}),
    });
    // Exact unchanged published clip; native tests additionally exercise all admitted tiers.
    const actor=Object.assign(Object.create(owner),{state:death==='already'?'dead':'idle',facing:compile(`return ${initialFacing};`),moveGeneration:0,scene,sprite:sprite(),
      deps:{unit:'giant',tier:1,ticker,clips:missing==='travel'?{}:{v2_fx_boulder_t1:{fps:12}}},
      profile:{death:'death',hit:'hit',move:'walk',melee:{troop:'attack',building:'attack'}},clip:state=>state==='throw'?(missing==='throw'?undefined:throwClip):{fps:12,frames:2},
      base:state=>state,frames(state,clip){return Array.from({length:clip.frames},(_,i)=>`${state}:${this.facing}:${i}`);},atlasFor:()=> 'body',
      applyBodyScale(){},isOptionalDireState:()=>false,fxAtHandler:()=>undefined,emitterScale:()=>1,
      stand(){},finishDeath(){},clearAbilityVisuals(){},
    });
    const sceneOwner=compile(`const VERDICT_STATE_EVENTS=${initializer(sceneAst,'VERDICT_STATE_EVENTS')};
      class BattleScene {${methods(sceneAst,'BattleScene',['apply','onTroopFire'])}}return BattleScene.prototype;`,
      {launchV2Projectile:launch,launchProjectile:()=>{legacy++;},artTierOfLevel:()=>1});
    const battle=Object.assign(Object.create(sceneOwner),scene,{jumping:cold,ux:n=>n,uy:n=>n,armyLevels:{giant:1},
      v2meta:{clips:actor.deps.clips},fallbackProjectileArt:()=>({baseFor:meta=>meta}),
      troops:new Map(missing==='actor'?[]:[[1,{troop:'giant',hero:mode==='hero'?'donor':undefined,
        fx:{sprite:actor.sprite,v2:mode==='rich'?actor:undefined,artFit:1}}]])});
    battle.apply({e:'troopFire',t:0,id:1,proj:'boulder',ix:100,iy:200});
    if(death==='before')actor.onDeath();
    if(death==='destroy-before')actor.destroy();
    if(flinch)actor.onHit();
    const releaseMs=(parseFxAt(throwClip.fxAt)[0].frames[0]-1)*1000/throwClip.fps;
    const tickTo=ms=>{const delta=ms-elapsed;elapsed=ms;pool.tick(delta);ticker.tick(delta);};
    const replaceBody=()=>{if(replace==='walk') {
        facings.push(actor.facing);actor.onPos(-90,20,100);facings.push(actor.facing);
        actor.onSiegeThrow(-90,80);facings.push(actor.facing);
      } else if(replace==='melee')actor.onMeleeAttack('building',200,200,'strike');
      else actor.onSiegeThrow(replace==='row'?-300:replace==='near'?114:100,200);};
    if(wakeAt) {tickTo(wakeAt/rate);battle.jumping=false;battle.apply({e:'troopFire',t:1,id:1,proj:'boulder',ix:wakeRow?-300:100,iy:200});}
    const releasedAt=wakeAt+releaseMs;
    if(replace&&replaceAt<releaseMs) {tickTo(replaceAt/rate);replaceBody();}
    tickTo(releasedAt/rate);
    if(replace&&replaceAt>=releaseMs) {tickTo(replaceAt/rate);replaceBody();}
    if(replace==='walk')tickTo((replaceAt+releaseMs)/rate);
    if(death==='after')actor.onDeath();
    if(death==='destroy-after')actor.destroy();
    if(clear)pool.clear();
    const before=[...calls];const flightMs=profiles.boulder.travelTicks*tickMs;
    tickTo((releasedAt+flightMs)/rate-1);const early=[...calls];
    tickTo((releasedAt+flightMs)/rate);tickTo(elapsed+flightMs/rate);
    const record={name,missing,mode,death,clear,rate,cold,flinch,replace,replaceAt,wakeAt,wakeRow,launches,legacy,impacts,facings,before,early,calls};cases.push(record);return record;
  };
  const normal=run('giant-landing');
  for(const missing of ['actor','throw','travel','texture'])run(`giant-missing-${missing}`,{missing});
  for(const death of ['already','before','after','destroy-before','destroy-after'])run(`giant-${death}`,{death});
  for(const mode of ['compact','hero'])run(`giant-${mode}-no-feedback`,{mode});
  run('giant-hit-keeps-throw',{flinch:true});run('giant-cleared-pool',{clear:true});
  run('giant-cold-dispatch',{cold:true});run('giant-double-rate',{rate:2});
  run('giant-melee-before-release',{replace:'melee'});
  run('giant-identical-throw-keeps-first',{replace:'same'});
  run('giant-row-throw-keeps-phase',{replace:'row'});
  run('giant-hysteresis-keeps-callback',{replace:'near'});
  for(const replace of ['same','row','melee'])run(`giant-${replace}-after-release`,{replace,replaceAt:300});
  run('giant-cold-then-live-throw',{cold:true,wakeAt:100});
  run('giant-cold-then-live-row',{cold:true,wakeAt:100,wakeRow:true});
  run('giant-completed-throw-walk-facing',{replace:'walk',replaceAt:600});
  if(normal.launches!==1||normal.before.length||normal.early.length||normal.calls.length!==2)
    throw new Error('Giant source callback timing changed');
  return {policy:{effects:normal.calls.map(({at,...cue})=>cue),clock:'sceneTimeScale',owner:'releasedFlight',
    requiresTravel:true,requiresImpact:false,requiresRichThrow:true,aim},cases};
}
