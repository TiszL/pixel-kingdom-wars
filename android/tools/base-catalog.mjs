/** Execute checked canonical presentation expressions; never synthesize art names. */
export function canonicalMethod(ts, text, className, methodName, bindings = {}) {
  const ast = ts.createSourceFile(className, text, ts.ScriptTarget.Latest, true);
  const type = ast.statements.find((n) => ts.isClassDeclaration(n) && n.name?.text === className);
  const method = type?.members.find((n) => ts.isMethodDeclaration(n) && n.name.getText(ast) === methodName);
  if (!method) throw new Error(`Base contract missing ${className}.${methodName}`);
  const code = method.getText(ast).replace(/^(?:private|public|protected)\s+/, '');
  return new Function(...Object.keys(bindings), ts.transpile(`function ${code};return ${methodName};`, { target:ts.ScriptTarget.ES2022 }))(...Object.values(bindings));
}

export function captureBuildingRules(rest, setJob, operating, types) {
  const sample = (jobKind, working, pending = false) => {
    let captured;
    rest.call({collapsed:false,sprite:{active:true},damaged:false,jobKind,working,levelupPending:pending,
      levelupToken:0,aimRow:0,deps:{unit:'mine'},play(state,row,loop) { captured={state,loop};return true; }});
    if (!captured || typeof captured.state !== 'string' || typeof captured.loop !== 'boolean') throw new Error('Unsupported base rest state');
    return captured;
  };
  const idle=sample(null,false),work=sample(null,true),build=sample('build',false),upgrade=sample('upgrade',false),flash=sample(null,false,true);
  if(JSON.stringify(build)!==JSON.stringify(upgrade) || build.loop || !idle.loop || !work.loop || flash.loop) throw new Error('Unsupported base job loop transition');
  const transition={jobKind:'upgrade',levelupToken:0,acting:true};setJob.call(transition,null);
  if(transition.levelupPending!==true) throw new Error('Unsupported base upgrade completion');
  const workingTypes=types.filter((type)=>operating({type},null));
  if(types.some((type)=>operating({type},'build') || operating({type},'upgrade'))) throw new Error('Canonical work no longer yields to jobs');
  return {workingTypes,idleState:idle.state,workState:work.state,buildState:build.state,levelupState:flash.state,buildLoop:build.loop};
}

/** Capture the owner-visible trap rest controller, including its persisted spent state. */
export function captureTrapRestStates(setSpent, trapArt) {
  const states={};
  for(const unit of Object.keys(trapArt)) {
    const sample=(spent)=>{
      let result;
      setSpent.call({spent:!spent,token:0,ownerView:true,deps:{unit},play(state,loop){result={state,loop};}},spent);
      if(!result || typeof result.state!=='string' || typeof result.loop!=='boolean') throw new Error('Unsupported trap rest controller');
      return result;
    };
    const ready=sample(false),spent=sample(true);
    if(spent.loop) throw new Error('Spent trap must not loop');
    if(ready.loop) states[unit]=ready.state;
  }
  return states;
}

export function checkedClip(index, atlasFrames, spec) {
  const paths=new Set(spec.frames.flat().map((frame)=>index.get(frame)));
  if(paths.size!==1 || paths.has(undefined)) throw new Error(`Base clip missing or split atlas: ${spec.key}`);
  const atlasPath=[...paths][0], sizes=spec.frames.flat().map((frame)=>atlasFrames.get(atlasPath)?.get(frame));
  if(sizes.some((size)=>!size || size.w!==sizes[0].w || size.h!==sizes[0].h)) throw new Error(`Base clip inconsistent canvas: ${spec.key}`);
  if(!Number.isFinite(spec.fps) || spec.fps<=0 || !Number.isFinite(spec.scale) || spec.scale<=0 || !Array.isArray(spec.anchor) || spec.anchor.length!==2 || !spec.anchor.every(Number.isFinite)) throw new Error(`Base clip invalid geometry: ${spec.key}`);
  return {...spec,atlasPath,cellWidth:sizes[0].w,cellHeight:sizes[0].h,static:false};
}

/** The source controller applies this only to base building loops, never combat or one-shots. */
export function baseBuildingLoopSpeed(constants) {
  const speed = constants.AMBIENCE?.baseBuildingLoopSpeed;
  if (!Number.isFinite(speed) || speed <= 0) throw new Error('Missing canonical base building loop speed');
  return speed;
}

export async function buildBasePresentation({ts,texts,sourceFunction,sourceExpression,shared,constants,clipHelpers,depthHelpers,meta,index,atlasFrames}) {
  const jobsPath='apps/web/src/game/world/jobs.ts';
  const ast=ts.createSourceFile('BaseScene.ts',texts.base,ts.ScriptTarget.Latest,true),calls=[];
  const visit=(n)=>{if(ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text==='setWorking') calls.push(n);ts.forEachChild(n,visit);};visit(ast);
  if(calls.length!==1 || calls[0].arguments.length!==1) throw new Error('Canonical operating controller changed');
  const operating=new Function('b','jobKind',ts.transpile(`return (${calls[0].arguments[0].getText(ast)});`,{target:ts.ScriptTarget.ES2022}));
  const types=Object.keys({...constants.STRUCTURES,...constants.DEFENSES});
  const rules=captureBuildingRules(canonicalMethod(ts,texts.ware,'WareBuildingFx','rest'),canonicalMethod(ts,texts.ware,'WareBuildingFx','setJob'),operating,types);
  // Contract14 already exports these bodies through combatProfiles. Validate the
  // source rest controller without changing the installed pack's byte identity.
  captureTrapRestStates(canonicalMethod(ts,texts.ware,'WareTrapFx','setSpent',
    {WARE_TRAP_ART:shared.WARE_TRAP_ART}),shared.WARE_TRAP_ART);
  const tilePixels=constants.GRID.tilePx*clipHelpers.V2_DRAW_SCALE;
  const jobAst=ts.createSourceFile('jobs.ts',texts.jobs,ts.ScriptTarget.Latest,true);
  const jobClass=jobAst.statements.find((n)=>ts.isClassDeclaration(n)&&n.name?.text==='JobLayer');
  const sync=jobClass?.members.find((n)=>ts.isMethodDeclaration(n)&&n.name.getText(jobAst)==='sync');
  const syncVariables=[];
  const findVariables=(n)=>{if(ts.isVariableDeclaration(n)&&n.initializer)syncVariables.push(n);ts.forEachChild(n,findVariables);};
  if(!sync) throw new Error('Missing canonical job sync');findVariables(sync);
  const expr=(name,bindings={})=>{
    const found=syncVariables.filter((n)=>n.name.getText(jobAst)===name);
    if(found.length!==1) throw new Error(`Ambiguous canonical job expression ${name}`);
    return new Function(...Object.keys(bindings),ts.transpile(`return (${found[0].initializer.getText(jobAst)});`,{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
  };
  const walkMs=await sourceExpression(jobsPath,'WALK_MS');
  if(!Number.isFinite(walkMs)||walkMs<=0) throw new Error('Invalid builder travel');
  async function geometry(T,keep,rect) {
    const bindings={T,s:expr('s',{T}),keep,rect,left:rect.tx*T,top:rect.ty*T,kFp:{fw:keep?.fw,fh:keep?.fh},AMBIENCE:constants.AMBIENCE};
    return Object.fromEntries(await Promise.all(['kx','ky','ex','ey'].map(async(name)=>[name,await sourceExpression(jobsPath,name,bindings)])));
  }
  const origin=await geometry(tilePixels,{tx:0,ty:0,fw:0,fh:0},{tx:0,ty:0,fw:0,fh:0});
  for(const ratio of [0.5,1,2]) {
    const T=tilePixels*ratio,value=await geometry(T,{tx:7,ty:11,fw:3,fh:5},{tx:13,ty:17,fw:2,fh:4});
    if(value.kx!==7*T+origin.kx*ratio || value.ky!==16*T+origin.ky*ratio || value.ex!==13*T+origin.ex*ratio || value.ey!==21*T+origin.ey*ratio) throw new Error('Nonlinear canonical builder placement');
  }
  const scaffolds=[];
  const findScaffold=(n)=>{if(ts.isCallExpression(n) && n.expression.getText(jobAst)==='this.ticker.register' && n.arguments[0]?.getText(jobAst)==='scaffold') scaffolds.push(n.arguments[2]);ts.forEachChild(n,findScaffold);};findScaffold(jobAst);
  if(scaffolds.length!==1 || !ts.isArrayLiteralExpression(scaffolds[0]) || scaffolds[0].elements.some((n)=>!ts.isStringLiteral(n))) throw new Error('Canonical scaffold frame family changed');
  const scaffoldFrames=scaffolds[0].elements.map((n)=>n.text),stepMs=await sourceExpression('apps/web/src/game/anim.ts','ANIM_TICK_MS');
  const scaffoldDecl=syncVariables.filter((n)=>n.name.getText(jobAst)==='scaffold');
  if(scaffoldDecl.length!==1) throw new Error('Canonical scaffold changed');
  const scaffoldSource=scaffoldDecl[0].initializer.getText(jobAst).replace(/\s+/g,'');
  if(!scaffoldSource.includes('.setOrigin(0,0).setDisplaySize(rect.fw*T,rect.fh*T).setDepth(buildingDepth((rect.ty+rect.fh)*T))')) throw new Error('Canonical scaffold placement changed');
  const scaffold=checkedClip(index,atlasFrames,{key:'base:scaffold',frames:[scaffoldFrames],rowOrder:['s'],fps:1000/stepMs,loop:true,anchor:[0,0],scale:1});
  const builder=await captureBuilder({ts,jobAst,jobClass,texts,sourceFunction,constants,clipHelpers,meta,index,atlasFrames,tilePixels,jobsPath});
  // Legacy contract view (renderer <= 12 reads walk/attack per Keep level): the
  // accepted Builder Workman serves every Keep level, so each level carries the
  // same single body. The explicit one-body contract is the `builder` section.
  const builderByKeepLevel={};
  for(let level=1;level<=constants.LEVEL_STEP_BUILDING.length;level++) builderByKeepLevel[level]={walk:builder.clips.walk,attack:builder.clips.work};
  const legacyIdleTypes=[...await sourceExpression('apps/web/src/game/world/ambience.ts','WORK_SWAP',{B13_DEFENCES:shared.B13_DEFENCES})];
  const obstacles={};
  const targetRect=canonicalMethod(ts,texts.jobs,'JobLayer','targetRect');
  for(const [key,sprite] of Object.entries(meta.sprites).filter(([key])=>key.startsWith('dec_'))) {
    if(!index.has(key)) continue;
    const target=targetRect.call({meta:meta.sprites},{obstacleId:'probe'},[],[{id:'probe',spriteKey:key.slice(4),tx:3,ty:5}]);
    if(!target || target.tx!==3 || target.ty!==5 || ![target.fw,target.fh].every((n)=>Number.isFinite(n)&&n>0)) throw new Error(`Invalid canonical obstacle footprint ${key}`);
    obstacles[key.slice(4)]={frameKey:key,atlasPath:index.get(key),footprintWidth:target.fw,footprintHeight:target.fh,
      anchor:sprite.anchor??[0.5,1],scale:clipHelpers.V2_DRAW_SCALE*(sprite.sourceScale??1)};
  }
  // The server's pine1/pine2 keys intentionally differ from their authored
  // aliases. Read the same mapping as BaseScene instead of rejecting live trees.
  const obstacleAliases=await sourceExpression('apps/web/src/game/scenes/BaseScene.ts','fix');
  for(const [serverKey,artKey] of Object.entries(obstacleAliases)) {
    if(typeof artKey!=='string' || !obstacles[artKey]) throw new Error(`Missing canonical obstacle alias ${serverKey}`);
    obstacles[serverKey]=obstacles[artKey];
  }
  for(const kind of Object.values(constants.OBSTACLES.tiers).flatMap((tier)=>tier.kinds)) {
    if(!obstacles[kind]) throw new Error(`Missing live obstacle artwork ${kind}`);
  }
  const chipOffset=await sourceFunction('apps/web/src/game/world/worldChipGeometry.ts','jobChipTextTopOffset');
  const presentation={version:1,tilePixels,...rules,buildingLoopSpeed:baseBuildingLoopSpeed(constants),wareTypes:Object.keys(shared.WARE_BUILDING_ART),legacyIdleTypes,obstacles,
    jobs:{travelMs:walkMs,gate:{tileX:0,offsetX:origin.kx,offsetY:origin.ky},site:{offsetX:origin.ex,offsetY:origin.ey},
      scaffold,builderByKeepLevel,chip:{textTopOffset:chipOffset(tilePixels),depth:await sourceExpression(jobsPath,'CHIP_DEPTH',depthHelpers)},
      actorDepthOffset:depthHelpers.actorDepth(0),structureDepthOffset:depthHelpers.buildingDepth(0),structureDepthScale:depthHelpers.buildingDepth(1)-depthHelpers.buildingDepth(0)}};
  return {presentation,builder:{version:1,...builder,travelMs:walkMs,gate:presentation.jobs.gate,site:presentation.jobs.site,
    siteGapPx:constants.AMBIENCE.builderSiteGapPx,siteGapWorldPx:-origin.ex}};
}

/** Builder Workman (D-130): one civilian body for every Keep level, read from
 * meta.builderClips exactly as JobLayer does. Scale, facing rules and the site
 * gap are executed from jobs.ts rather than restated here. */
async function captureBuilder({ts,jobAst,jobClass,texts,sourceFunction,constants,clipHelpers,meta,index,atlasFrames,tilePixels,jobsPath}) {
  const clips=meta.builderClips;
  if(!clips || typeof clips!=='object') throw new Error('Missing canonical builderClips metadata');
  const spec=await sourceFunction(jobsPath,'builderSpec',{V2_DIRS:clipHelpers.V2_DIRS,clipFrames:clipHelpers.clipFrames,facingRow:clipHelpers.facingRow});
  const required=await sourceFunction(jobsPath,'requiredBuilderAtlasGroups',{builderSpec:spec});
  const groups=required(clips);
  if(JSON.stringify(groups)!==JSON.stringify(['builder'])) throw new Error('Canonical builder atlas group changed');
  // The world draw scale is the same expression at creation and every replay.
  const scaleTexts=new Set();
  for(const name of ['createBuilder','playBuilder']) {
    const method=jobClass?.members.find((n)=>ts.isMethodDeclaration(n)&&n.name.getText(jobAst)===name);
    if(!method) throw new Error(`Missing canonical builder method ${name}`);
    const visit=(n)=>{if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='setScale'&&n.arguments.length===1) scaleTexts.add(n.arguments[0].getText(jobAst));ts.forEachChild(n,visit);};
    visit(method);
  }
  if(scaleTexts.size!==1) throw new Error('Ambiguous canonical builder scale');
  const scale=new Function('AMBIENCE',ts.transpile(`return (${[...scaleTexts][0]});`,{target:ts.ScriptTarget.ES2022})).call({T:tilePixels},constants.AMBIENCE);
  if(!Number.isFinite(scale)||scale<=0) throw new Error('Invalid canonical builder scale');
  // Facing: walk faces gate->site, work faces site->target centre. Probe the
  // controller with a recording facing8 instead of restating the vectors.
  const facing=canonicalMethod(ts,texts.jobs,'JobLayer','builderFacing',{facing8:(dx,dy)=>`${dx},${dy}`});
  const probe={sx:3,sy:5,ex:70,ey:110,rect:{tx:2,ty:3,fw:3,fh:2}};
  const T=tilePixels;
  if(facing.call({T},probe,'walk')!==`${probe.ex-probe.sx},${probe.ey-probe.sy}`) throw new Error('Canonical builder walk facing changed');
  if(facing.call({T},probe,'work')!==`${(probe.rect.tx+probe.rect.fw/2)*T-probe.ex},${(probe.rect.ty+probe.rect.fh/2)*T-probe.ey}`) throw new Error('Canonical builder work facing changed');
  const body=(state,loop)=>{
    const directions=clipHelpers.V2_DIRS,rows=directions.map((facing8)=>spec(clips,state,facing8));
    if(rows.some((row)=>!row) || rows.some((row)=>row.atlas!==rows[0].atlas || row.base!==rows[0].base || row.fps!==rows[0].fps || JSON.stringify(row.origin)!==JSON.stringify(rows[0].origin))) throw new Error(`Incomplete canonical builder clip ${state}`);
    return checkedClip(index,atlasFrames,{key:rows[0].base,frames:rows.map((row)=>row.seq),rowOrder:directions,fps:rows[0].fps,loop,anchor:rows[0].origin,scale});
  };
  const walk=body('walk',true),work=body('work',true),idle=body('idle',clips.builder_idle?.loop===true);
  if(new Set([walk.atlasPath,work.atlasPath,idle.atlasPath]).size!==1) throw new Error('Builder body split across atlases');
  return {atlasPath:walk.atlasPath,atlasGroups:groups,clips:{idle,walk,work},states:{travel:'walk',working:'work',rest:'idle'},
    facing:{walk:'gateToSite',work:'siteToTargetCenter'},scale,anchor:walk.anchor,
    frameIndexing:'rows are zero-based d0..d7 in rowOrder; frames are one-based f1..; padding cells are never keyed'};
}
