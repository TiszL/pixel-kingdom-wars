/** Execute the actual scene route, rich/compact wrapper and ticker callback.
 * Texture/drawing fixtures are inert; no callback timing is replaced. */
export async function captureKegDetonation(ts,read,compile) {
  const parse=async relative=>ts.createSourceFile(relative,await read(relative),ts.ScriptTarget.Latest,true);
  const troop=await parse('apps/web/src/game/v2/troop.ts');
  const wrapper=await parse('apps/web/src/game/fx/troop.ts');
  const sceneAst=await parse('apps/web/src/game/scenes/BattleScene.ts');
  const projectiles=await parse('apps/web/src/game/fx/projectiles.ts');
  const clips=await parse('apps/web/src/game/v2/clips.ts');
  const tickerAst=await parse('apps/web/src/game/v2/ticker.ts');
  const node=(ast,name)=>{
    const n=ast.statements.find(n=>(ts.isClassDeclaration(n)||ts.isFunctionDeclaration(n))&&n.name?.text===name);
    if(!n)throw new Error(`Missing Keg source ${name}`);return n.getText(ast).replace(/^export\s+/,'');
  };
  const initializer=(ast,name)=>{
    const n=ast.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations])
      .find(n=>n.name.getText(ast)===name)?.initializer;
    if(!n)throw new Error(`Missing Keg source value ${name}`);return n.getText(ast);
  };
  const method=(ast,owner,name)=>{
    const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text===owner);
    const n=cls?.members.find(n=>(ts.isMethodDeclaration(n)||ts.isGetAccessorDeclaration(n))&&n.name.getText(ast)===name);
    if(!n)throw new Error(`Missing Keg method ${owner}.${name}`);return n.getText(ast).replace(/^private\s+/,'');
  };
  const Ticker=compile(`${node(tickerAst,'V2Ticker')};return V2Ticker;`,{
    SCENE_UPDATE:compile(`return ${initializer(tickerAst,'SCENE_UPDATE')};`),
    SCENE_SHUTDOWN:compile(`return ${initializer(tickerAst,'SCENE_SHUTDOWN')};`),
  });
  const parseFxAt=compile(`${node(clips,'parseFxAt')};return parseFxAt;`);
  const atlas=JSON.parse(await read('apps/web/public/atlas/meta.json'));
  const sourceClip=atlas.v2Clips.v2_trp_kegrunner_t1_detonate;
  if(!sourceClip)throw new Error('Missing exact Keg source detonate clip');
  const detonate=method(troop,'V2TroopFx','onDetonate');
  const detonateAst=ts.createSourceFile('detonate.ts',`class Owner{${detonate}}`,ts.ScriptTarget.Latest,true);
  let fallbackFrame;
  const visit=n=>{if(ts.isVariableDeclaration(n)&&n.name.getText(detonateAst)==='frames') {
    const raw=n.initializer;
    if(!ts.isBinaryExpression(raw)||!ts.isParenthesizedExpression(raw.right)||!ts.isConditionalExpression(raw.right.expression))
      throw new Error('Keg fallback selector changed');
    const fallback=raw.right.expression.whenFalse;
    if(!ts.isArrayLiteralExpression(fallback)||fallback.elements.length!==1)throw new Error('Keg fallback frame changed');
    fallbackFrame=compile(`return ${fallback.elements[0].getText(detonateAst)};`);
  }ts.forEachChild(n,visit);};visit(detonateAst);
  if(!Number.isSafeInteger(fallbackFrame)||fallbackFrame<1)throw new Error('Invalid Keg source fallback');
  const cases=[];
  const run=(name,{mode='rich',missing='',death='',cold=false,duplicate=false,onlyDeath=false,rate=1,cue='source',wakeAt=0}={})=>{
    let elapsed=0;const calls=[],effects=[],positions=[];let finished=0;
    const sprite=()=>{const s={active:true,x:10,y:20,depth:1,destroy(){this.active=false;},once(){}};
      for(const key of ['setDepth','setOrigin','setScale','setTexture','setAlpha','setVisible'])s[key]=()=>s;
      s.setPosition=(x,y)=>{s.x=x;s.y=y;positions.push({x,y});return s;};return s;};
    const scene={events:{on(){},once(){}},textures:{exists:()=>true},
      time:{delayedCall(){}},add:{image:()=>sprite()},tweens:{killTweensOf(){}}};
    const ticker=new Ticker();ticker.setTimeScale(rate);
    const feedback={shake:(_,duration,intensity)=>calls.push({at:elapsed,kind:'shake',duration,intensity}),
      haptic:strength=>calls.push({at:elapsed,kind:'haptic',strength})};
    const explode=compile(`${node(projectiles,'explode')};return explode;`,
      {...feedback,trackFx:(_,s)=>s,overlayDepth:n=>n,destroyFx:(_,s)=>s.destroy()});
    const owner=compile(`class Owner{${['alive','onDetonate','playOnce','playEffect','onDeath','destroy'].map(n=>method(troop,'V2TroopFx',n)).join('\n')}}return Owner.prototype;`,
      {parseFxAt,emitterWorld:s=>({x:s.x,y:s.y}),playV2Fx:(_scene,_clips,base,x,y)=>{effects.push([base,x,y]);return null;}});
    const clip={...sourceClip,...(cue==='missing'?{fxAt:undefined}:cue==='outside'?{fxAt:'keg_blast@999'}:{})};
    const actor=Object.assign(Object.create(owner),{state:'idle',moveGeneration:0,scene,sprite:sprite(),
      deps:{unit:'kegrunner',tier:1,ticker},profile:{death:'detonate',...(missing==='profile'?{}:{detonate:'detonate'})},
      clip:()=>missing==='clip'?undefined:clip,base:s=>s,frames:(_,c)=>Array.from({length:c.frames},(_,i)=>`f${i}`),
      applyBodyScale(){},isOptionalDireState:()=>false,fxAtHandler:()=>undefined,atlasFor:()=> 'body',row:()=>0,emitterScale:()=>1,
      fxBase:base=>missing==='effect'?null:base,finishDeath:()=>{finished++;},clearAbilityVisuals(){},
    });
    const facade=Object.assign(Object.create(compile(`class TroopFx{${method(wrapper,'TroopFx','onDetonate')}}return TroopFx.prototype;`)),
      {sprite:actor.sprite,v2:mode==='rich'?actor:undefined,usesCurrentV2Art:mode!=='legacy'});
    const sceneOwner=compile(`const VERDICT_STATE_EVENTS=${initializer(sceneAst,'VERDICT_STATE_EVENTS')};
      class BattleScene{${['apply','onDetonate'].map(n=>method(sceneAst,'BattleScene',n)).join('\n')}}return BattleScene.prototype;`,
      {...feedback,actorDepth:n=>n,explode});
    const battle=Object.assign(Object.create(sceneOwner),scene,{jumping:cold,ux:n=>n,uy:n=>n,stopLoop(){},
      troops:new Map(missing==='actor'?[]:[[1,{fx:facade}]])});
    if(death==='before'||onlyDeath)actor.onDeath();
    const event={e:'detonate',t:0,id:1,x:300,y:400};
    if(!onlyDeath)battle.apply(event);
    if(wakeAt){elapsed=wakeAt/rate;ticker.tick(elapsed);battle.jumping=false;battle.apply({...event,t:1});}
    if(duplicate)battle.apply(event);
    if(death==='after')actor.onDeath();
    if(death==='destroy')actor.destroy();
    const immediate=[...calls];
    const frame=cue==='outside'?clip.frames+1:cue==='missing'?fallbackFrame:parseFxAt(sourceClip.fxAt).find(e=>e.fx==='keg_blast')?.frames[0]??Number(/keg_blast@(\d+)/.exec(sourceClip.fxAt)[1])+1;
    const release=(wakeAt+(frame-1)*1000/clip.fps)/rate;
    const prior=elapsed;elapsed=release-1;ticker.tick(elapsed-prior);const early=[...calls];elapsed=release;ticker.tick(1);
    const atRelease=[...calls];elapsed+=clip.frames*1000/clip.fps/rate;ticker.tick(clip.frames*1000/clip.fps/rate);
    const result={name,mode,missing,death,cold,duplicate,onlyDeath,rate,cue,wakeAt,release,immediate,early,atRelease,calls,effects,positions,finished};
    cases.push(result);return result;
  };
  const normal=run('keg-rich');
  for(const mode of ['compact','legacy'])run(`keg-${mode}`,{mode});
  for(const missing of ['actor','profile','clip','effect'])run(`keg-missing-${missing}`,{missing});
  for(const death of ['before','after','destroy'])run(`keg-death-${death}`,{death});
  run('keg-cold-then-live',{cold:true,wakeAt:40});
  run('keg-ordinary-death',{onlyDeath:true});run('keg-duplicate',{duplicate:true});run('keg-cold',{cold:true});run('keg-double-rate',{rate:2});
  for(const cue of ['missing','outside'])run(`keg-cue-${cue}`,{cue});
  if(normal.immediate.length||normal.early.length||normal.calls.length!==2)throw new Error('Keg authored callback timing changed');
  return {policy:{effects:normal.calls.map(({at,...effect})=>effect),clock:'sceneTimeScale',owner:'detonateBody',
    fallbackFrame,unenteredCue:'completion',missingBody:'immediate',missingEffect:'callback'},cases};
}
