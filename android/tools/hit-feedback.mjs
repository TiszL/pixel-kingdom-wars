import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

/** One standalone depth module per source. Every tsImport call registers another namespaced
 * loader hook and each later import walks the whole chain: the fifth standalone capture in one
 * process took 9 s and the sixth 130 s (2026-10-10). The imported module is the same code. */
const standaloneDepth=new Map();

/** Execute the canonical handlers with observed sprites, never combat simulation. */
export async function captureHitFeedback(source,loadTs,readSource=readFile) {
  const load=name=>import(pathToFileURL(path.join(source,name)).href);
  const ts=(await load('scripts/node_modules/typescript/lib/typescript.js')).default;
  // A full exporter already owns a global tsx loader. Registering a second namespaced
  // hook here breaks its subsequent extensionless imports; standalone probes own theirs.
  const importTs=loadTs ?? (async relative=>{
    const {tsImport}=await load('scripts/node_modules/tsx/dist/esm/api/index.mjs');
    return tsImport(pathToFileURL(path.join(source,relative)).href,import.meta.url);
  });
  const depthName='apps/web/src/game/world/depth.ts';
  let depth=loadTs?importTs(depthName):standaloneDepth.get(source);
  if(!depth)standaloneDepth.set(source,depth=importTs(depthName).catch(error=>{standaloneDepth.delete(source);throw error;}));
  const {overlayDepth}=await depth;
  const req=createRequire(path.join(source,'apps/web/package.json'));
  const phaser=path.dirname(req.resolve('phaser/package.json'));
  const texts={};const read=async(name,file=path.join(source,name))=>texts[name]=await readSource(file,'utf8');
  const parse=(text)=>ts.createSourceFile('source.ts',text,ts.ScriptTarget.Latest,true);
  const battle=parse(await read('apps/web/src/game/scenes/BattleScene.ts'));
  const juice=parse(await read('apps/web/src/lib/juice.ts'));
  const troop=parse(await read('apps/web/src/game/fx/troop.ts'));
  await read('apps/web/src/game/v2/troop.ts');
  await read('apps/web/src/game/world/depth.ts');
  await read('apps/web/src/game/world/walls.ts');
  await read('packages/shared/src/wallRender.ts');
  const declaration=(ast,name)=>{
    const n=ast.statements.filter(ts.isVariableStatement).flatMap(s=>[...s.declarationList.declarations]).find(d=>d.name.getText(ast)===name);
    if(!n?.initializer)throw new Error(`Missing hit feedback constant ${name}`);return n.initializer.getText(ast);
  };
  const compile=(code,bindings={})=>new Function(...Object.keys(bindings),ts.transpile(code,{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
  const method=(name,ast=battle,owner='BattleScene')=>{
    const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text===owner);
    const m=cls?.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)===name);
    if(!m)throw new Error(`Missing hit handler ${name}`);return m.getText(ast).replace(/^private\s+/,'');
  };
  const hero=compile(`class Owner {${['onHeroSkill','playHeroBody','named'].map(n=>method(n,troop,'TroopFx')).join('\n')}}return Owner.prototype;`,{HERO_SKILLS:{}});
  const actorBody=Object.assign(Object.create(hero),{skin:'hero_theo',state:'idle',heroLocked:false,heroLockToken:0,
    heroVisualPriority:0,stopFallbackMotion(){},anim:{sequence(){},unregister(){}},
    scene:{time:{delayedCall(){}}},playHeroFramesOnce(frames){this.frames=frames;}});
  const bodyOrdering=['cheekQuake','snotRocket'].map(skill=>{
    actorBody.onHeroSkill(skill,'impact',1000);return {skill,frames:actorBody.frames};
  });
  const flashNode=juice.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='flash');
  if(!flashNode)throw new Error('Missing source flash');
  const flash=compile(`const FLASH_MS=${declaration(juice,'FLASH_MS')};${flashNode.getText(juice).replace(/^export\s+/,'')}return flash;`);
  const timer=[],imageEvents=[];
  const origin=req(path.join(phaser,'src/gameobjects/components/Origin.js'));
  const transform=req(path.join(phaser,'src/gameobjects/components/Transform.js'));
  for(const relative of ['gameobjects/components/Origin.js','gameobjects/components/Transform.js','gameobjects/image/Image.js','renderer/webgl/shaders/ApplyTint-glsl.js'])
    await read(`phaser/${relative}`,path.join(phaser,'src',relative));
  const victim={active:true,setTint(color){this.color=color;return this;},setTintMode(mode){this.mode=mode;return this;},clearTint(){this.cleared=true;}};
  const image={active:true,setDepth(depth){this.depth=depth;return this;},setTexture(atlas,frame){imageEvents.push({at:now,atlas,frame});return this;},destroy(){this.active=false;this.until=now;}};
  const own={prototype:{ownTransientFx:value=>value,destroyTransientFx:value=>value.destroy()}};
  const hitStar=compile(`class Owner {${method('hitStar')}}return Owner.prototype.hitStar;`,{BattleScene:own,overlayDepth,flash});
  let now=0;
  const scene={add:{image:(x,y,atlas,frame)=>{imageEvents.push({at:now,atlas,frame});return image;}},time:{delayedCall:(at,fn)=>timer.push({at,fn})}};
  hitStar.call(scene,17,23,victim);
  const color=victim.color,mode=victim.mode;
  let flashMs=null;for(const t of timer.sort((a,b)=>a.at-b.at)) {now=t.at;t.fn();if(victim.cleared&&flashMs===null)flashMs=now;}
  const lift=compile(`return ${declaration(battle,'HIT_LIFT_MAX_PX')};`);
  // Preserve historical14 capture bytes: only newer handlers read and bind this
  // canonical predicate, and both actual inputs participate in sourceHashes.
  let phaseE;
  if(method('onHit').includes('isPhaseEBuilding')) {
    const constants=parse(await read('packages/shared/src/constants.ts'));
    const presentation=parse(await read('apps/web/src/game/phaseE/presentation.ts'));
    const predicate=presentation.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='isPhaseEBuilding');
    if(!predicate)throw new Error('Missing canonical service hit predicate');
    const buildings=compile(`return ${declaration(constants,'PHASE_E_BUILDINGS')};`);
    const isPhaseEBuilding=compile(`${predicate.getText(presentation).replace(/^export\s+/,'')};return isPhaseEBuilding;`,{PHASE_E_BUILDINGS:buildings});
    if(!Array.isArray(buildings.types)||!buildings.types.length||buildings.types.some(type=>typeof type!=='string'||!isPhaseEBuilding(type)))
      throw new Error('Invalid canonical service hit identities');
    phaseE={types:buildings.types,isPhaseEBuilding};
  }
  const handlerNames=['onHit','onChain'];
  let marketBindings={};
  // Current damage routing uses the same source-owned Market predicate as
  // collapse. Bind its method and dependencies without changing older captures.
  if(method('onHit').includes('this.ownsMarketArt(')) {
    const market=parse(await read('apps/web/src/game/world/marketArt.ts'));
    const family=market.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='marketArtFamilyOf');
    if(!family)throw new Error('Missing canonical Market hit ownership dependency');
    marketBindings=compile(`${family.getText(market).replace(/^export\s+/,'')};const MARKET_FRAME_KEY=${declaration(market,'MARKET_FRAME_KEY')};return {marketArtFamilyOf,MARKET_FRAME_KEY};`);
    // r12 (night 2026-10-06): ownsMarketArt also reads the harvester sentinel key from world/harvesterArt.ts.
    if(method('ownsMarketArt').includes('HARVESTER_UNPRESENTED_KEY')) {
      const harvester=ts.createSourceFile('harvesterArt.ts',await read('apps/web/src/game/world/harvesterArt.ts'),ts.ScriptTarget.Latest,true);
      const sentinel=harvester.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations])
        .find(n=>n.name.getText(harvester)==='HARVESTER_UNPRESENTED_KEY')?.initializer;
      if(!sentinel||!ts.isStringLiteral(sentinel))throw new Error('Missing canonical harvester sentinel key dependency');
      marketBindings={...marketBindings,HARVESTER_UNPRESENTED_KEY:sentinel.text};
    }
    handlerNames.push('ownsMarketArt');
  }
  // 427381a2 (night server line, what production deploys) has no service predicate: onHit routes a
  // service body by the Market seam (ownsMarketArt) or its berth type, through the body's controller
  // or the static fallback. Probe every canonical type through the actual handler. The type list and
  // its provenance live outside the policy so the exported pack's hitFeedback bytes stay unchanged.
  let services;const serviceTexts={};
  if(!phaseE&&handlerNames.includes('ownsMarketArt')) {
    const name='packages/shared/src/constants.ts';
    const constants=parse(serviceTexts[name]=await readSource(path.join(source,name),'utf8'));
    const buildings=compile(`return ${declaration(constants,'PHASE_E_BUILDINGS')};`);
    const hit=method('onHit');
    services=(Array.isArray(buildings.types)?buildings.types:[]).map(type=>{
      if(typeof type!=='string')throw new Error('Invalid canonical service hit identities');
      if(marketBindings.marketArtFamilyOf(type)!==null) {
        const rest=`pe_${type==='harvester'?'harvester_frostveil':type}_t1_idle_f1`;
        if(!marketBindings.MARKET_FRAME_KEY.test(rest))throw new Error(`Canonical Market frame grammar no longer names ${type}`);
        const bodies=[['controller',{artMode:'market',key:rest,controller:'market'}],['pending',{key:rest}]];
        bodies.push(type==='harvester'?['unpresented',{key:marketBindings.HARVESTER_UNPRESENTED_KEY}]:['ordinary',{key:`bld_${type}_l1`}]);
        return {type,bodies};
      }
      if(type===buildings.berthType&&hit.includes(`b.type === '${type}'`))
        return {type,bodies:[['controller',{artMode:'berth',controller:'berth'}],['pending',{}]]};
      throw new Error(`Unrouted canonical service hit type ${type}`);
    });
    if(!services.length)throw new Error('Invalid canonical service hit identities');
  }
  let output=[];
  const handlers=compile(`class Owner {${handlerNames.map(name=>method(name)).join('\n')}}return Owner.prototype;`,
    {HIT_LIFT_MAX_PX:lift,T:1,floatText(){},isWareBuildingUnit:()=>false,muzzleY:()=>0,zapBolt(){},playWareFx(){},BattleScene:own,overlayDepth,...(phaseE?{isPhaseEBuilding:phaseE.isPhaseEBuilding}:{}),...marketBindings});
  const cases=[];
  const probe=(name,kind,damage,{alive=true,jumping=false,destroyed=false,missing=false,height=200,type,variant,body={}}={})=>{
    output=[];const sprite={x:17,y:23,displayHeight:height};
    const troop={hp:100,maxHp:100,fx:{alive,sprite,onHit(){}}};
    let damageUpdates=0,syncs=0;const routes=[];
    const controller=route=>({setDamaged(value){routes.push([route,'setDamaged',value]);}});
    const building={type,hp:100,maxHp:100,tx:4,ty:5,fw:2,fh:3,sprite,destroyed,damage:{update(){damageUpdates++;}},
      ...(body.key===undefined?{}:{key:body.key}),...(body.artMode?{artMode:body.artMode}:{}),
      ...(body.controller?{[body.controller]:controller(body.controller)}:{})};
    const target=kind==='building'?'base':1;
    const owner=Object.assign(Object.create(handlers),{jumping,troops:new Map(missing?[]:[[1,troop]]),
      buildings:new Map(missing?[]:[['base',building],['tower',{sprite:{x:0,y:0},type:'electrictower'}]]),
      hitStar:(x,y)=>output.push({x,y}),emitProgress(){},syncPhaseEServices(){syncs++;},
      // The static fallbacks only re-key art once the family is resident; record which one the handler chose.
      applyMarketFallbackState(id,b,state){routes.push(['marketFallback',state]);},
      applyBerthFallbackState(id,b,state){routes.push(['berthFallback',state]);}});
    if(kind==='chain')owner.onChain({id:'tower',targets:[1],dmg:damage===null?[]:[damage]});
    else owner.onHit({target,...(damage===null?{}:{dmg:damage})});
    cases.push({name,kind,damage,alive,jumping,destroyed,missing,height,stars:[...output],
      ...(type&&variant?{type,variant,hp:building.hp,damageUpdates,routes}:type?{type,hp:building.hp,combat:building.phaseECombat,syncs,damageUpdates}:{})});
    return output;
  };
  const actor=probe('actor-hit','actor',8)[0];
  const structure=probe('building-hit','building',8)[0];
  const short=probe('short-building','building',8,{height:80})[0];
  for(const kind of ['actor','building','chain']) {
    probe(`${kind}-zero`,kind,0);probe(`${kind}-missing-damage`,kind,null);
    probe(`${kind}-cold`,kind,8,{jumping:true});probe(`${kind}-missing`,kind,8,{missing:true});
  }
  probe('actor-dead','actor',8,{alive:false});probe('chain-dead','chain',8,{alive:false});
  probe('chain-positive','chain',8);probe('building-destroyed','building',8,{destroyed:true});
  for(const type of phaseE?.types??[])for(const jumping of [false,true])for(const damage of [0,49,50,51,200])
    probe(`service-${type}-${jumping?'cold':'live'}-${damage}`,'building',damage,{type,jumping});
  for(const type of phaseE?.types??[])for(const absent of ['destroyed','missing'])
    probe(`service-${type}-${absent}`,'building',51,{type,[absent]:true});
  for(const {type,bodies} of services??[]) {
    for(const [variant,body] of bodies)for(const jumping of [false,true])for(const damage of [0,49,50,51,200])
      probe(`service-${type}-${variant}-${jumping?'cold':'live'}-${damage}`,'building',damage,{type,variant,body,jumping});
    for(const absent of ['destroyed','missing'])
      probe(`service-${type}-${absent}`,'building',51,{type,variant:bodies[0][0],body:bodies[0][1],[absent]:true});
  }
  const actorHeightFactor=(23-actor.y)/200,buildingHeightFactor=(8-short.y)/80;
  if(structure.x!==5||structure.y!==8-lift||short.x!==5)throw new Error('Source hit anchors changed');
  if(color!==0xffffff||mode!==1||!(flashMs>0)||imageEvents.length!==2||!(image.until>imageEvents[1].at))throw new Error('Unsupported source hit feedback');
  const atlas=JSON.parse(await read('apps/web/public/atlas/fx@1x.json'));
  const frames=atlas.textures.flatMap(t=>t.frames);
  const starFrames=imageEvents.map(e=>{
    if(e.atlas!=='fx')throw new Error('Source hit atlas changed');
    const f=frames.find(f=>f.filename===e.frame);if(!f||f.pivot)throw new Error('Missing/default-pivot source hit frame');
    return {key:e.frame,atMs:e.at,width:f.sourceSize.w,height:f.sourceSize.h};
  });
  return {policy:{version:1,flash:{durationMs:flashMs,color,mode:'fill'},
    star:{atlasPath:'atlas/fx@1x.json',frames:starFrames,durationMs:image.until,depth:image.depth,
      anchor:[origin.originX,origin.originY],scale:transform._scaleX},
    actorHeightFactor,buildingHeightFactor,buildingLiftMax:lift,
    sourceHashes:Object.fromEntries(Object.entries(texts).map(([name,text])=>[name,createHash('sha256').update(text).digest('hex')]))},cases,bodyOrdering,
    ...(services?{serviceSourceHashes:Object.fromEntries(Object.entries(serviceTexts).map(([name,text])=>[name,createHash('sha256').update(text).digest('hex')]))}:{})};
}

/** Static fallbacks have no rich body clip, so preserve their admitted full-cell height. */
export function hitStaticHeights(entries,atlasFrames,walls5=null) {
  return Object.fromEntries(entries.map(e=>{
    if(e.type==='wall' && walls5) {
      const h=walls5.constants.contextFrameHeight*walls5.constants.drawScale;
      if(!(h>0))throw new Error('Missing admitted wall context height');
      return [e.frameKey,h];
    }
    const h=atlasFrames.get(e.atlasPath)?.get(e.frameKey)?.h;
    if(!(h>0)||!(e.scale>0))throw new Error(`Missing admitted hit body height ${e.frameKey}`);
    return [e.frameKey,h*e.scale];
  }));
}
