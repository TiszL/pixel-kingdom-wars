/** Execute source marker matching and command completion without network or timers. */
export async function captureDeployHaptics(ts,read,compile) {
  const text=await read('apps/web/src/game/scenes/BattleScene.ts');
  const ast=ts.createSourceFile('BattleScene.ts',text,ts.ScriptTarget.Latest,true);
  const uiText=await read('apps/web/src/ui/RaidUI.tsx');
  const ui=ts.createSourceFile('RaidUI.tsx',uiText,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='BattleScene');
  const method=name=>{const n=cls.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)===name);
    if(!n)throw new Error(`Missing deploy source ${name}`);return n.getText(ast).replace(/^private\s+/,'');};
  const variable=(file,name)=>{let found;const visit=n=>{if(ts.isVariableDeclaration(n)&&n.name.getText(file)===name)found=n.initializer;ts.forEachChild(n,visit);};visit(file);
    if(!found)throw new Error(`Missing deploy source value ${name}`);return found;};
  const fn=name=>{const n=ui.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);if(!n)throw new Error(`Missing deploy function ${name}`);return n.getText(ui).replace(/^export\s+/,'');};
  const previewFn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='deployPreviewOffset');
  if(!previewFn)throw new Error('Missing source deployment preview offsets');
  const directions=compile(`return ${variable(ast,'PREVIEW_DIRECTIONS').getText(ast)};`);
  const offset=compile(`const PREVIEW_DIRECTIONS=${JSON.stringify(directions)};${previewFn.getText(ast).replace(/^export\s+/,'')}return deployPreviewOffset;`);
  const seats=[],badges=[];
  const refresh=compile(`class Preview {${method('refreshDeployStack')}}return Preview.prototype.refreshDeployStack;`,
    {T:64,deployPreviewOffset:offset,actorDepth:y=>y,overlayDepth:n=>n});
  const sprite=index=>({setPosition(x,y){seats[index]={x,y};return this;},setAlpha(alpha){seats[index].alpha=alpha;return this;},setDepth(depth){seats[index].depth=depth;return this;}});
  refresh.call({marks:Array.from({length:3},(_,index)=>({tx:1,ty:2,sprite:sprite(index)})),markBadges:new Map(),add:{text(x,y,text,style){
    const badge={x,y,text,style};badges.push(badge);return {setOrigin(x,y){badge.origin=[x,y];return this;},setDepth(depth){badge.depth=depth;return this;}};
  }}},1,2);
  const firstRadius=Math.abs(offset(0,2).x),radiusStep=Math.abs(offset(directions.length,9).x)-firstRadius;
  const maxRadius=Math.abs(offset(directions.length*100,1000).x);
  const depthStep=seats[1].depth-seats[1].y;
  const samples=Array.from({length:80},(_,i)=>({index:i,total:80,...offset(i,80)}));
  for(const sample of samples) {
    const direction=directions[sample.index%directions.length],radius=Math.min(maxRadius,firstRadius+Math.floor(sample.index/directions.length)*radiusStep);
    if(sample.x!==direction[0]*radius||sample.y!==direction[1]*radius)throw new Error('Source pending fan is no longer represented by the native policy');
  }
  const badge=badges[0];
  if(seats.some(s=>s.alpha!==1)||badge.text!=='×3'||badge.origin.join()!=='1,0')throw new Error('Source pending opacity/count badge changed');
  const preview={version:1,lifetime:'scene',directions,firstRadius,radiusStep,maxRadius,depthStep,
    badge:{rightInset:128-badge.x,topInset:badge.y-128,fontSize:parseFloat(badge.style.fontSize),color:badge.style.color,background:badge.style.backgroundColor,
      paddingX:badge.style.padding.x,paddingY:badge.style.padding.y,fontFamily:badge.style.fontFamily,stroke:badge.style.stroke,strokeThickness:badge.style.strokeThickness}};
  const cases=[];
  const run=(name,steps)=>{
    const calls=[],destroyed=[],rendered=[];
    const fx=()=>({sprite:{setPosition(){return this;},setAlpha(){return this;},setDepth(){return this;},once(){return this;}},setNearestBuildingFn(){},setMeleeDriven(){},onDeath(){},destroy(){}});
    const owner=compile(`const VERDICT_STATE_EVENTS=${variable(ast,'VERDICT_STATE_EVENTS').getText(ast)};
      class BattleScene{${['apply','onDeploy','onSpawn','onTroopSpawn','onTroopDeath','addDeployMark','removeDeployMark'].map(method).join('\n')}}return BattleScene.prototype;`,{
      freezeTroopArtFamily(){},TroopFx:class{constructor(){return fx();}},HeroFx:class{constructor(){return fx();}},
      HpBar:class{destroy(){}},actorDepth:n=>n,overlayDepth:n=>n,battleUnitMaxHp:()=>1,
      troopMaxHp:()=>1,haptic:strength=>calls.push(strength),playSfxFamily(){},troopDeploySfxFamily:()=> 'fixture',
    });
    const scene=Object.assign(Object.create(owner),{jumping:false,troops:new Map(),buildings:new Map(),retiredTroops:new Set(),marks:[],ux:n=>n,uy:n=>n,armyLevels:{},heroLevels:{},meleeDrivenIds:new Set(),
      v2TroopDepsOf(){},v2TroopFallbackOf(){},wareHatchlingDepsOf(){},stopLoop(){},nearestBuildingX(){},refreshDeployStack(){},
      createDeployMark:spec=>({...spec,fx:fx()}),destroyDeployMark:mark=>destroyed.push(mark.ticket)});
    for(const step of steps) {
      if(step.kind==='mark')scene.addDeployMark(step.spec);
      else if(step.kind==='unmark')scene.removeDeployMark(step.spec);
      else if(step.kind==='cold')scene.jumping=step.value;
      else {scene.apply(step.event);rendered.push(step.event.id);}
    }
    const value={name,steps,calls,remaining:scene.marks.map(m=>m.ticket),destroyed,actors:[...scene.troops.keys()]};cases.push(value);return value;
  };
  const spec=(ticket,troop='giant',hero,tx=1,ty=2)=>({ticket,troop,...(hero?{hero}:{}),tx,ty});
  const mark=s=>({kind:'mark',spec:s});const unmark=s=>({kind:'unmark',spec:s});
  const deploy=(id,troop='giant',hero,x=384,y=640)=>({kind:'deploy',event:{e:'deploy',t:1,id,troop,...(hero?{hero}:{}),x,y}});
  const normal=run('unmarked',[deploy(1)]);
  run('matched',[mark(spec('a')),deploy(1)]);
  run('stack-fifo',[mark(spec('a')),mark(spec('b')),deploy(1)]);
  run('refusal-newest',[mark(spec('a')),mark(spec('b')),unmark(spec('unused'))]);
  run('duplicate-does-not-consume-next',[mark(spec('a')),deploy(1),mark(spec('b')),deploy(1)]);
  run('hero-distinct',[mark(spec('a','giant','theodor')),deploy(1),deploy(2,'giant','theodor')]);
  run('wrong-troop',[mark(spec('a')),deploy(1,'archer')]);
  run('wrong-tile',[mark(spec('a')),deploy(1,'giant',undefined,640,640)]);
  run('negative-tile',[mark(spec('a','giant',undefined,-1,-2)),deploy(1,'giant',undefined,-1,-257)]);
  run('cold-matched',[mark(spec('a')),{kind:'cold',value:true},deploy(1)]);
  run('cold-unmarked',[{kind:'cold',value:true},deploy(1)]);
  run('same-id-after-death',[deploy(1),{event:{e:'troopDeath',t:2,id:1}},{event:{...deploy(1).event,t:3}}]);
  run('spawn-is-not-deploy',[{event:{e:'spawn',t:0,id:1,troop:'wyrmling',x:384,y:640}},deploy(1)]);
  run('brood-is-not-deploy',[{event:{e:'troopSpawn',t:0,id:1,troop:'barrowling',x:384,y:640}},deploy(1)]);
  run('ignored-brood-does-not-own-actor',[{event:{e:'troopSpawn',t:0,id:1,troop:'archer',x:384,y:640}},deploy(1)]);
  // Exact cleanup statements; all other mark writes are constrained below so a
  // future timer/expiry or replay reset cannot silently change this contract.
  const cleanup=cls.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)==='cleanupBattle');
  const clear=cleanup.body.statements.filter(n=>n.getText(ast).startsWith('this.marks.')).map(n=>n.getText(ast))
    .concat(cleanup.body.statements.filter(n=>n.getText(ast).startsWith('this.marks =')).map(n=>n.getText(ast))).join('\n');
  const destroyed=[];const clearOwner={marks:[{ticket:'a'},{ticket:'b'}],destroyDeployMark:m=>destroyed.push(m.ticket)};
  compile(`return function(){${clear}}`,{sceneCleanup:(_label,work)=>work()}).call(clearOwner);
  if(clearOwner.marks.length||destroyed.join()!=='a,b')throw new Error('Source mark cleanup changed');
  const writers=[];
  for(const m of cls.members.filter(ts.isMethodDeclaration)) {
    const visit=n=>{
      if(ts.isBinaryExpression(n)&&n.left.getText(ast)==='this.marks')writers.push(m.name.getText(ast));
      if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.expression.getText(ast)==='this.marks'
        &&['push','splice','pop','shift','unshift','sort','reverse'].includes(n.expression.name.text))writers.push(m.name.getText(ast));
      ts.forEachChild(n,visit);
    };visit(m);
  }
  const writeOwners=[...new Set(writers)].sort();
  const expected=['addDeployMark','cleanupBattle','onDeploy','removeDeployMark','rebuildDeployMarks'].sort();
  if(JSON.stringify(writeOwners)!==JSON.stringify(expected))throw new Error(`Source mark lifetime changed: ${writeOwners}`);
  // Run the actual React callback queue: unknown responses retain the mark and
  // wait/reconcile; only a terminal current-session rejection calls onDone(false).
  const request=fn('liveRaidCommandRequest'),uncertain=fn('potentiallyCommittedLiveCommand');
  const queueNode=variable(ui,'queueLiveCommand');
  if(!ts.isCallExpression(queueNode))throw new Error('Source command queue changed');
  const queueBody=queueNode.arguments[0].getText(ui);
  const cadence=compile(`return ${variable(ui,'LIVE_COMMAND_RECONCILE_MS').getText(ui)};`);
  const queues=[];
  for(const name of ['accepted','refused','unknown-retained','unknown-recovered','unknown-refused','replaced-session']) {
    let posts=0,reads=0;const done=[],waits=[];const mounted={current:true};
    const session={raidId:'raid',queue:Promise.resolve(),localMarkedCommandIds:new Set(),accepted:new Map(),hydrated:true};
    const sessionRef={current:session};const command={sequence:0,clientCommandId:'id',kind:'deploy',payload:{troop:'giant',tx:1,ty:2}};
    class ApiError extends Error{constructor(status){super(String(status));this.status=status;}}
    const queue=compile(`${request}\n${uncertain}\nreturn ${queueBody};`,{
      ApiError,liveCommandSessionRef:sessionRef,raidRef:{current:{id:'raid'}},mountedRef:mounted,
      useApp:{getState:()=>({screen:'battle'})},idemKey:()=> 'id',LIVE_COMMAND_RECONCILE_MS:cadence,
      api:{postRaw:async()=>{posts++;
        if(name==='replaced-session'){sessionRef.current={...session};return {command};}
        if(name==='accepted'||name==='unknown-recovered'&&posts>1)return {command};
        throw new ApiError(name==='refused'||name==='unknown-refused'&&posts>1?422:0);
      }},readCanonicalLiveCommands:async()=>{reads++;if(name==='unknown-refused')return {commands:new Map(),view:{}};throw new ApiError(0);},
      setTimeout:(resolve,ms)=>{waits.push(ms);mounted.current=false;resolve();},
      liveCommandModeRef:{current:true},batchJournalModeRef:{current:false},phaseRef:{current:'deploying'},
      applyAcceptedLiveCommands(){},adoptClock(){},setErr(){},toast(){},playSfx(){},
    });
    queue({id:'raid'},{kind:'deploy',payload:command.payload},accepted=>done.push(accepted),true);await session.queue;
    queues.push({name,posts,reads,waits,done,marked:[...session.localMarkedCommandIds]});
  }
  return {policy:{haptic:normal.calls[0],matching:'troopHeroTile',echo:'firstActor',lifetime:'scene'},preview,previewSamples:samples,cases,
    cleanup:{destroyed,remaining:clearOwner.marks,writeOwners},queues};
}
