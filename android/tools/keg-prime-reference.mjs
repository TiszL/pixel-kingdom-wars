// Test evidence executes unchanged canonical scheduling and v2 body methods.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';

export async function kegPrimeReference(source) {
  const load=name=>import(pathToFileURL(path.join(source,name)).href);
  const {tsImport}=await load('scripts/node_modules/tsx/dist/esm/api/index.mjs');
  const typed=name=>tsImport(pathToFileURL(path.join(source,name)).href,import.meta.url);
  const ts=(await load('scripts/node_modules/typescript/lib/typescript.js')).default;
  const {TICKS_PER_SEC}=await typed('packages/sim/src/stats.ts');
  const {SIM_VERSION}=await typed('packages/sim/src/version.ts');
  const {facing8Stable,clipKey}=await typed('apps/web/src/game/v2/clips.ts');
  const {actorDepth}=await typed('apps/web/src/game/world/depth.ts');
  const tickMs=1000/TICKS_PER_SEC,texts={};
  const read=async name=>texts[name]=await readFile(path.join(source,name),'utf8');
  const parse=text=>ts.createSourceFile('source.ts',text,ts.ScriptTarget.Latest,true);
  const compile=(code,bindings={})=>new Function(...Object.keys(bindings),ts.transpile(code,{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
  const battle=parse(await read('apps/web/src/game/scenes/BattleScene.ts'));
  const troop=parse(await read('apps/web/src/game/v2/troop.ts'));
  await read('apps/web/src/game/v2/clips.ts');
  const method=(ast,owner,name)=>{
    const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text===owner);
    const m=cls?.members.find(n=>(ts.isMethodDeclaration(n)||ts.isGetAccessorDeclaration(n))&&n.name.getText(ast)===name);
    if(!m)throw new Error(`Missing ${owner}.${name}`);
    return m.getText(ast).replace(/^private\s+/,'');
  };
  const lead=compile(`class Owner {${method(battle,'BattleScene','kegPrimeLeadTicks')}};return Owner.prototype.kegPrimeLeadTicks;`,{clipKey,TICK_MS:tickMs});
  const nearest=compile(`class Owner {${method(battle,'BattleScene','nearestBuildingX')}};return Owner.prototype.nearestBuildingX;`,{T:1});
  let scheduleIf;
  const visit=node=>{
    if(ts.isIfStatement(node)&&node.expression.getText(battle)==="ev.e === 'detonate'") {
      if(scheduleIf)throw new Error('Ambiguous prime schedule');scheduleIf=node.getText(battle);
    }
    ts.forEachChild(node,visit);
  };visit(battle);
  if(!scheduleIf?.includes('this.kegPrimeLeadTicks()'))throw new Error('Missing source prime schedule');
  const schedulePrime=compile(`return function(ev,fromTick,deployTicks,schedule){${scheduleIf}};`,{TICK_MS:tickMs,playSfxFamily(){}});
  const names=['alive','faceTarget','onPrime','cancelPrime','onPos'];
  const proto=compile(`class Owner {${names.map(n=>method(troop,'V2TroopFx',n)).join('\n')}};return Owner.prototype;`,{facing8Stable,actorDepth});
  const meta=JSON.parse(await read('apps/web/public/atlas/meta.json')).v2Clips;
  const tiers=[1,2,3,4].map(tier=>{
    const key=clipKey('trp','kegrunner',tier,'prime'),clip=meta[key];
    if(!clip)throw new Error(`Missing source clip ${key}`);
    return {tier,key,frames:clip.frames,fps:clip.fps,lead:lead.call({v2TroopTiers:new Map([['kegrunner',tier]]),v2meta:{clips:meta}})};
  });
  const cases=[];
  for(const [name,fromTick,deployTick,detonateTick,deathTick] of [
    ['ordinary',0,0,10,null],['cold-inside',8,0,10,null],['fractional-cold',8.5,0,10,null],
    ['late-deploy',0,8,10,null],['born-at-blast',0,10,10,null],['cold-at-blast',10,0,10,null],
    ['dead-before-prime',0,0,10,4],['dead-during-prime',0,0,10,7],['dead-at-prime',0,0,10,5],
    ['fresh-zero',0,0,3,null],['replacement-inside',7,0,10,null]]) {
    const ev={e:'detonate',t:detonateTick,id:1,x:0,y:0};let start=null;
    schedulePrime.call({kegPrimeLeadTicks:()=>tiers[0].lead},ev,fromTick,new Map([[1,deployTick]]),(delay)=>{start=fromTick+delay/tickMs;});
    cases.push({name,fromTick,deployTick,detonateTick,deathTick,startTick:start,
      ticks:[...new Set([fromTick,Math.max(fromTick,(start??detonateTick)-.01),...(start===null?[]:[start,start+.5,start+4.5]),...(deathTick===null?[]:[deathTick]),detonateTick])]
        .filter(t=>t>=fromTick&&t<=detonateTick).sort((a,b)=>a-b).map(tick=>({tick,priming:start!==null&&tick>=start&&tick<detonateTick&&(deathTick===null||tick<deathTick),
          frame1:start===null?null:Math.floor(Math.max(0,tick-start)*tickMs*tiers[0].fps/1000)%tiers[0].frames+1}))});
  }
  const bodies=[];
  for(const [name,current,point] of [['nearest-standing','s',{x:100,y:0}],['hysteresis','e',{x:100,y:50}],['near-zero','w',{x:.1,y:.1}],['no-standing','nw',null],['native-hysteresis','s',{x:100,y:173}],['native-near-zero','s',{x:.1,y:.1}]]) {
    let movement=null,now=0;
    const sprite={x:0,y:0,setPosition(x,y){this.x=x;this.y=y;return this;},setDepth(){return this;}};
    const actor=Object.assign(Object.create(proto),{deps:{unit:'kegrunner'},state:'walking',moving:true,facing:current,sprite,
      profile:{move:'run'},moveGeneration:0,snapNextPos:false,clip:()=>meta[tiers[0].key],nearest:()=>point,
      playLoop(state){this.clipState=state;this.clipSince=now;},stand(){this.state='idle';this.clipState='idle';},
      scene:{tweens:{killTweensOf(){movement=null;},add(spec){movement=spec;}}}});
    actor.onPrime();const first={state:actor.state,facing:actor.facing,clip:actor.clipState};
    now=100;actor.onPos(-100,100,300);
    if(!movement||actor.clipSince!==0)throw new Error('Source prime no longer preserves its moving loop');
    const continued={state:actor.state,facing:actor.facing,clip:actor.clipState,ease:movement.ease};
    actor.cancelPrime();const cancelled={state:actor.state,clip:actor.clipState};
    bodies.push({name,current,point,first,continued,cancelled});
  }
  const buildings=[{id:'dead',tx:0,ty:0,fw:2,fh:2,destroyed:true},{id:'standing',tx:10,ty:2,fw:2,fh:2,destroyed:false}];
  return {sourceCommit:execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    sourceHashes:Object.fromEntries(Object.entries(texts).map(([name,text])=>[name,createHash('sha256').update(text).digest('hex')])),
    simVersion:SIM_VERSION,tickMs,tiers,cases,bodies,nearest:{buildings,point:nearest.call({buildings:new Map(buildings.map(b=>[b.id,b]))},0,0)}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=await kegPrimeReference(path.resolve(process.argv[2])),out=path.resolve(process.argv[3]);
  await mkdir(path.dirname(out),{recursive:true});await writeFile(out,JSON.stringify(result,null,2)+'\n');
  console.log(`Wrote ${result.cases.length} Keg schedules, ${result.bodies.length} body cases and ${result.tiers.length} source tiers`);
}
