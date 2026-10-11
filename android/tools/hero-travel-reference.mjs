// Execute the canonical controller, scene restore method and Phaser easing for test evidence only.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

export async function heroTravelReference(source) {
  const load = (name) => import(pathToFileURL(path.join(source,name)).href);
  const {tsImport}=await load('scripts/node_modules/tsx/dist/esm/api/index.mjs');
  const typed=(name)=>tsImport(pathToFileURL(path.join(source,name)).href,import.meta.url);
  const ts=(await load('scripts/node_modules/typescript/lib/typescript.js')).default;
  const constants=await typed('packages/shared/src/constants.ts');
  const {TICKS_PER_SEC}=await typed('packages/sim/src/stats.ts');
  const {SIM_VERSION}=await typed('packages/sim/src/version.ts');
  const depth=await typed('apps/web/src/game/world/depth.ts');
  const {facing8Stable}=await typed('apps/web/src/game/v2/clips.ts');
  const tickMs=1000/TICKS_PER_SEC;
  const texts={};const read=async name=>texts[name]=await readFile(path.join(source,name),'utf8');
  const parse=text=>ts.createSourceFile('source.ts',text,ts.ScriptTarget.Latest,true);
  const compile=(code,bindings={})=>new Function(...Object.keys(bindings),ts.transpile(code,{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
  const troopText=await read('apps/web/src/game/fx/troop.ts'),troopAst=parse(troopText);
  const battleText=await read('apps/web/src/game/scenes/BattleScene.ts'),battleAst=parse(battleText);
  const animText=await read('apps/web/src/game/anim.ts'),animAst=parse(animText);
  const fn=(ast,name)=>{const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
    if(!node)throw new Error(`Missing source function ${name}`);return node.getText(ast).replace(/^export\s+/,'');};
  const method=(ast,owner,name)=>{const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text===owner);
    const node=cls?.members.find(n=>(ts.isMethodDeclaration(n)||ts.isGetAccessorDeclaration(n))&&n.name.getText(ast)===name);
    if(!node)throw new Error(`Missing source method ${owner}.${name}`);return node.getText(ast).replace(/^private\s+/,'');};
  const bodyUntil=compile(`${fn(battleAst,'heroSkillBodyUntilTick')};return heroSkillBodyUntilTick;`);
  const positionPlayback=compile(`${fn(battleAst,'positionPlayback')};return positionPlayback;`,{...constants,TICK_MS:tickMs});
  const facing=compile(`${fn(animAst,'facing')};return facing;`);
  const names=['alive','onPos','snapPosition','finishSeek','onHeroSkill','onHeroAttack','onHeroTravel','playHeroBody','invalidateHeroLock','onDeath'];
  // Presentation death constants affect only cleanup after our positional samples, not combat numbers.
  const deathConstants=troopAst.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations])
    .filter(n=>['DEATH_STEP_MS','DEATH_HOLD_MS'].includes(n.name.getText(troopAst)))
    .map(n=>`const ${n.getText(troopAst)};`).join('\n');
  const owner=compile(`${deathConstants} class Owner {${names.map(name=>method(troopAst,'TroopFx',name)).join('\n')}};return Owner.prototype;`,
    {HERO_SKILLS:constants.HERO_SKILLS,...depth,facing,facing8Stable});
  const sceneOwner={applyHeroSkillState(){},ownTransientFx:image=>image,destroyTransientFx:image=>image.destroy()};
  const sceneNames=['onHeroSkill','resumeHeroSkillPhase','applyPlaybackStateRange'];
  // Class prototype methods are nonenumerable.
  const sceneProto=compile(`class SceneOwner {${sceneNames.map(name=>method(battleAst,'BattleScene',name)).join('\n')}};return SceneOwner.prototype;`,
    {BattleScene:{prototype:sceneOwner},heroSkillBodyUntilTick:bodyUntil,TICK_MS:tickMs,...depth,HERO_SKILLS:constants.HERO_SKILLS,
      shake(){},haptic(){}});
  for(const name of sceneNames)sceneOwner[name]=sceneProto[name];
  const req=createRequire(path.join(source,'apps/web/package.json'));
  const sinePath=path.join(path.dirname(req.resolve('phaser/package.json')),'src/math/easing/sine/InOut.js');
  const sine=req(sinePath);
  texts['phaser/src/math/easing/sine/InOut.js']=await readFile(sinePath,'utf8');
  const deploy=hero=>({t:0,e:'deploy',id:1,troop:'giant',hero,x:0,y:0});
  const cast=(hero,t=3,toX=200,toY=100)=>({t,e:'heroSkill',id:1,hero,skill:hero==='vex'?'crimsonDash':'cannonball',phase:'impact',
    x:toX,y:toY,fromX:-900,fromY:-800,toX,toY});
  const pos=(t,x,y)=>({t,e:'pos',id:1,x,y});
  const cases=[];
  for(const hero of ['vex','theodor']) {
    const event=cast(hero),end=bodyUntil(event);
    const basic=[deploy(hero),event,pos(5,100,40),pos(6,250,120),pos(7,300,160)];
    for(const [name,extra] of [['queued',[]],['replace',[cast(hero,4,-100,200)]],
      ['death',[{t:5,e:'troopDeath',id:1}]],['sameTickDeath',[{t:3,e:'troopDeath',id:1}]],
      ['nonTravel',[{t:4,e:'heroSkill',id:1,hero,skill:hero==='vex'?'doubleOrNothingHeads':'rageQuit',phase:hero==='vex'?'heads':'fakeDeath',until:10,x:200,y:100}]]])
      cases.push({name:`${hero}-${name}`,hero,fromTick:0,events:[...basic,...extra].sort((a,b)=>a.t-b.t),ticks:[0,2.5,3,3.25,4,4.25,5,6,7,end,end+.5,end+1,14]});
    for(const fromTick of [4,end,12])cases.push({name:`${hero}-cold-${fromTick}`,hero,fromTick,events:basic,ticks:[fromTick,fromTick+.25,fromTick+1,14]});
    cases.push({name:`${hero}-retainedTarget`,hero,fromTick:0,events:[deploy(hero),event],ticks:[3,4,end,end+1,14]});
    cases.push({name:`${hero}-zeroTravel`,hero,fromTick:0,events:[deploy(hero),cast(hero,3,60,24),pos(5,100,40)],ticks:[3,4,5,end,end+1,14]});
    const guard={t:2,e:'heroSkill',id:1,hero,skill:hero==='vex'?'doubleOrNothingHeads':'rageQuit',phase:hero==='vex'?'heads':'fakeDeath',until:10,x:0,y:0};
    cases.push({name:`${hero}-priorityGuard`,hero,fromTick:0,events:[...basic,guard].sort((a,b)=>a.t-b.t),ticks:[2,3,4,5,7,8,9,10,11,14]});
  }
  const eatTicks=constants.HERO_SKILLS.theodor.silentButDeadly.eatWindupSec*TICKS_PER_SEC;
  for(const [name,skill,phase,fromTick] of [
    ['eat','silentButDeadly','windup',10+eatTicks-1],['bloat','silentButDeadly','windup',10+eatTicks+1],
    ['fakeDeath','rageQuit','fakeDeath',40]]) {
    cases.push({name:`theodor-cold-body-${name}`,hero:'theodor',fromTick,bodyCase:true,
      events:[deploy('theodor'),cast('theodor',1,20,10),
        {t:10,e:'heroSkill',id:1,hero:'theodor',skill,phase,until:100,x:20,y:10},
        {t:20,e:'heroAttack',id:1,hero:'theodor',ix:-100,iy:30,recoveryUntil:100},pos(30,123,87)],
      ticks:[fromTick,fromTick+.25,fromTick+2]});
  }
  function capture(value) {
    let now=value.fromTick*tickMs,move=null,actor=null;const timers=[];
    const image=()=>({active:true,setDepth(){return this;},setScale(){return this;},setTexture(){return this;},destroy(){this.active=false;}});
    const scene={jumping:false,ux:n=>n,uy:n=>n,troops:new Map(),add:{image},time:{delayedCall:(delay,callback)=>timers.push({at:now+delay,callback})},
      tweens:{killTweensOf(target){if(target===actor?.sprite)move=null;},add(spec){if(spec.targets!==actor?.sprite||spec.x===undefined)return;
        if(!['Linear','Sine.easeInOut'].includes(spec.ease))throw new Error('Unknown source easing');
        move={...spec,start:now,fromX:actor.sprite.x,fromY:actor.sprite.y};}},resumeHeroSkillPhase:sceneOwner.resumeHeroSkillPhase};
    const sample=ms=>{if(!move)return;const p=Math.min(1,Math.max(0,(ms-move.start)/move.duration));
      const eased=move.ease==='Sine.easeInOut'?sine(p):p;
      actor.sprite.x=move.fromX+(move.x-move.fromX)*eased;actor.sprite.y=move.fromY+(move.y-move.fromY)*eased;
      move.onUpdate?.();if(p===1){const old=move;move=null;old.onComplete?.();}};
    function spawn(e) {
      const sprite={x:e.x,y:e.y,depth:depth.actorDepth(e.y),active:true,setPosition(x,y){this.x=x;this.y=y;return this;},
        setDepth(d){this.depth=d;return this;},setTexture(){return this;},setFlipX(){return this;},setVisible(){return this;},setAlpha(){return this;},destroy(){this.active=false;}};
      actor=Object.assign(Object.create(owner),{skin:value.hero==='vex'?'hero_vex':'hero_theo',sprite,state:'idle',scene,heroLocked:false,heroLockToken:0,
        heroVisualPriority:0,moveGeneration:0,meleeGeneration:0,pendingHeroPos:null,anim:{register(_sprite,_atlas,frames){actor.bodyFrames=frames;},unregister(){},sequence(){}},
        named:(base,count)=>Array.from({length:count},(_,i)=>`${base}_f${i+1}`),attackFrames:()=>[],walkFrames:()=>[],playHeroFramesOnce(frames){this.bodyFrames=frames;},
        stopFallbackMotion(){},clearCompactContact(){},playFallbackMotion:()=>false,playIdleAttack(){this.state='idle';}});
      scene.troops.set(e.id,{fx:actor});
    }
    scene.apply=e=>{if(e.e==='deploy')spawn(e);else if(e.e==='pos')actor.snapPosition(e.x,e.y);else if(e.e==='troopDeath')actor.onDeath();};
    scene.onHeroAttack=e=>actor.onHeroAttack(e.ix,e.iy,Math.max(1,(e.recoveryUntil-e.t)*tickMs));
    if(value.fromTick)sceneOwner.applyPlaybackStateRange.call(scene,value.events,0,value.fromTick);
    const positions=positionPlayback(value.events,value.fromTick),commands=[];
    for(const [order,e] of value.events.entries()) {
      if(e.e==='pos') {
        const position=positions.get(e);
        if(position&&!position.skip)commands.push({at:position.startTick*tickMs,order,e,duration:position.durationMs});
      } else if(e.t>=value.fromTick)commands.push({at:e.t*tickMs,order,e});
    }
    commands.sort((a,b)=>a.at-b.at||a.order-b.order);
    const results=[];let boundaryBody;
    for(const tick of [...new Set(value.ticks)].sort((a,b)=>a-b)) {
      const until=tick*tickMs;
      while(true) {
        timers.sort((a,b)=>a.at-b.at);
        const next=Math.min(commands[0]?.at??Infinity,timers[0]?.at??Infinity);
        if(next>until)break;
        sample(next);now=next;
        if(commands[0]?.at===next) {
          const {e,duration}=commands.shift();
          if(e.e==='deploy')spawn(e);
          else if(e.e==='pos')actor.onPos(e.x,e.y,duration);
          else if(e.e==='troopDeath')actor.onDeath();
          else if(e.e==='heroAttack')scene.onHeroAttack(e);
          else sceneOwner.onHeroSkill.call(scene,e);
        } else timers.shift().callback();
      }
      sample(until);now=until;
      if(value.bodyCase&&boundaryBody===undefined)boundaryBody=[...actor.bodyFrames];
      results.push({tick,x:actor.sprite.x,y:actor.sprite.y,depth:actor.sprite.depth-depth.actorDepth(0),alive:actor.alive});
    }
    return {...value,...(boundaryBody ? {boundaryBody} : {}),samples:results};
  }
  return {sourceCommit:execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    sourceHashes:Object.fromEntries(Object.entries(texts).map(([name,text])=>[name,createHash('sha256').update(text).digest('hex')])),
    simVersion:SIM_VERSION,tickMs,positionCadenceTicks:constants.RAID_RULES.troopFireVisualTicks,cases:cases.map(capture)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=await heroTravelReference(path.resolve(process.argv[2])),output=path.resolve(process.argv[3]);
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(`Wrote ${result.cases.length} source hero body-travel cases from ${result.sourceCommit}`);
}
