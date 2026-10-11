// Capture the admitted V2 burrow controller. These probes describe rendering;
// they neither run the simulator nor calculate underground travel or outcomes.
export function compileBurrowController(ts,source,tickerSource,bindings) {
  const ast=ts.createSourceFile('troop.ts',source,ts.ScriptTarget.Latest,true);
  const owner=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V2TroopFx');
  const method=name=>{
    const n=owner?.members.find(n=>n.name?.getText(ast)===name);
    if(!n)throw new Error(`Missing canonical Burrow method ${name}`);
    return n.getText(ast).replace(/^private\s+/,'');
  };
  let positionSnapDistance;
  const inspect=n=>{
    if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken) {
      const pair=[n.left,n.right];
      if(pair.every((p,i)=>ts.isBinaryExpression(p)&&p.operatorToken.kind===ts.SyntaxKind.LessThanToken&&
        p.left.getText(ast)===`Math.abs(${i?'dy':'dx'})`&&ts.isNumericLiteral(p.right))) {
        const [x,y]=pair.map(p=>Number(p.right.text));
        if(x===y&&x>0&&Number.isFinite(x))positionSnapDistance=x;
      }
    }
    ts.forEachChild(n,inspect);
  };
  const onPos=owner?.members.find(n=>n.name?.getText(ast)==='onPos');
  if(onPos)inspect(onPos);
  if(positionSnapDistance===undefined)throw new Error('Missing canonical Burrow position snap distance');
  const methods=['alive','playLoop','playOnce','fxAtHandler','playEffect','stand','faceTarget','playAttack',
    'onPos','onBurrow','onEmerge','seekBurrowed','seekEmerged','snapPosition','finishSeek',
    'cancelPrime','cancelReplayAction','clearAbilityVisuals','onDeath'];
  // Production main has no owned Leap counter helper (web commit 7374477c); the
  // burrow controller neither needs nor stubs it. Compile it only when present.
  if(owner?.members.some(n=>n.name?.getText(ast)==='cancelLeapMotion'))methods.push('cancelLeapMotion');
  const tickerAst=ts.createSourceFile('ticker.ts',tickerSource,ts.ScriptTarget.Latest,true);
  const ticker=tickerAst.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V2Ticker');
  if(!ticker)throw new Error('Missing canonical V2Ticker');
  const result=new Function(...Object.keys(bindings),ts.transpile(
    `${ticker.getText(tickerAst).replace(/^export\s+/,'')}\nclass BurrowOwner {${methods.map(method).join('\n')}};`+
    'return {controller:BurrowOwner.prototype,Ticker:V2Ticker};',{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
  return {...result,positionSnapDistance,parseFxAt:bindings.parseFxAt};
}
const requirePlan=(ok,message)=>{if(!ok)throw new Error(`Unsupported Burrow motion: ${message}`);};
const close=(a,b)=>Number.isFinite(a)&&Math.abs(a-b)<1e-7;
export function captureBurrowMotion({controller,Ticker,positionSnapDistance,parseFxAt},{unit,tier,profile,clips,fit,drawScale,aim,actorDepth}) {
  requirePlan(['tunneler','bilgewraith'].includes(unit)&&profile?.burrow,'unadmitted profile');
  requirePlan(Number.isFinite(fit)&&fit>0&&Number.isFinite(drawScale)&&drawScale>0,'invalid fit');
  requirePlan(Number.isFinite(aim?.minimumDeltaSquared)&&Number.isFinite(aim?.retainWithinDegrees),'missing canonical facing plan');
  const {enter,tunnel,surface}=profile.burrow;
  const base=state=>`v2_${profile.kind}_${unit}_t${tier}_${state}`;
  const body=state=>clips[base(state)];
  const valid=c=>Number.isInteger(c?.frames)&&c.frames>0&&Number.isFinite(c.fps)&&c.fps>0;
  for(const state of [enter,tunnel,surface,profile.stand,profile.battleMove??profile.move,profile.death])
    requirePlan(valid(body(state)),`missing or invalid body ${state}`);
  const soil=clips[`v2_fx_soil_t${tier}`];
  requirePlan(valid(soil)&&soil.loop!==true,'missing finite soil');
  for(const state of [enter,surface]) {
    const cues=parseFxAt(body(state).fxAt);
    requirePlan(cues.length>0&&cues.every(c=>c.fx==='soil'&&c.frames.length>0&&c.frames.every(f=>
      Number.isInteger(f)&&f>1&&f<=body(state).frames)),'unsupported body cue');
  }
  function actor(x=20,y=30) {
    const ticker=new Ticker(),effects=[],transforms=[],released=[],sprite={active:true,x,y,depth:actorDepth(y),visible:true,alpha:1,
      once(){},setTexture(atlas,frame){this.atlas=atlas;this.frame=frame;return this;},
      setPosition(x,y){this.x=x;this.y=y;return this;},setDepth(d){this.depth=d;return this;},
      setOrigin(x,y){this.origin=[x,y];return this;},setScale(s){this.scale=s;return this;},
      setRotation(r){this.rotation=r;return this;},setVisible(v){this.visible=v;return this;},setAlpha(a){this.alpha=a;return this;},
      destroy(){this.active=false;}};
    let kills=0;
    const scene={textures:{exists:()=>true},pool:{add(duration,update,finish,cancel){released.push({duration,update,finish,cancel});}},
      add:{image(x,y,atlas,frame){const image={...sprite,x,y,atlas,frame,active:true};effects.push(image);return image;}},
      tweens:{killTweensOf(){kills++;transforms.length=0;},add(options){transforms.push(options);return {};}},time:{delayedCall(){}}};
    const a=Object.assign(Object.create(controller),{scene,sprite,deps:{unit,tier,clips,ticker},profile,
      state:'idle',facing:'nw',moving:false,moveGeneration:0,meleeDriven:true,damaged:false,nearest:null,
      snapNextPos:false,leapGeneration:0,leapTween:null,abilityTimers:new Set(),ownedSprites:new Set(),ownedAbilityFx:new Set(),
      base,clip:body,frames(state,c){return Array.from({length:c.frames},(_,i)=>`${base(state)}_${this.facing}_${i+1}`);},
      atlasFor:()=>unit,applyBodyScale(){sprite.setScale(fit*drawScale);},emitterScale:()=>fit,fxBase:x=>x,
      isOptionalDireState:()=>false,finishDeath(){this.state='dead';}});
    a.stand();
    return {a,ticker,sprite,effects,transforms,released,get kills(){return kills;},entry:()=>ticker.entries.get(sprite),
      advance(ms){ticker.tick(ms);},complete(state){ticker.tick(1000*body(state).frames/body(state).fps+1e-5);}};
  }
  let soilDepthOffset;
  for(const [x,y] of [[20,30],[620,-330]])for(const state of [enter,surface]) {
    const e=actor(x,y),a=e.a;
    a.onPos(x+100,y+40,9000);const generation=a.moveGeneration,kills=e.kills;
    if(state===enter)a.onBurrow();else a.onEmerge();
    requirePlan(e.kills===kills&&a.moveGeneration===generation&&a.moving&&e.transforms.length===1,'entry/legacy emerge retains movement');
    requirePlan(e.sprite.visible&&e.sprite.alpha===1,'opaque authored body');
    const registration=e.entry(),phase=e.ticker.phase(e.sprite),callback=registration.onComplete,frameCallback=registration.onFrame;
    if(state===enter)a.onBurrow();else a.onEmerge();
    requirePlan(e.entry()===registration&&e.entry().onComplete===callback&&e.entry().onFrame===frameCallback&&
      JSON.stringify(e.ticker.phase(e.sprite))===JSON.stringify(phase),'identical registration preserves phase and callbacks');
    // Move before the keyed release; cue position must be sampled at release.
    e.sprite.setPosition(x+17,y+29).setDepth(actorDepth(y+29));
    const cues=parseFxAt(body(state).fxAt).flatMap(c=>c.frames);
    for(let frame=2;frame<=body(state).frames;frame++) {
      e.advance(1000/body(state).fps+1e-7);
      requirePlan(e.effects.length===cues.filter(f=>f<=frame).length,'authored one-based soil release timing');
    }
    e.advance(1000/body(state).fps+1e-7);
    requirePlan(e.entry()?.i===0&&e.entry()?.acc===0,'chained body starts on next ticker update');
    requirePlan(e.effects.length>0&&e.effects.length===e.released.length,'soil uses scene pool');
    for(const fx of e.effects) {
      requirePlan(fx.x===x+17&&fx.y===y+29&&fx.scale===fit*drawScale&&!fx.rotation,'soil placement/fit');
      const offset=fx.depth-e.sprite.depth;
      if(soilDepthOffset===undefined)soilDepthOffset=offset;
      requirePlan(close(offset,soilDepthOffset),'translation-independent soil depth');
    }
    requirePlan(a.ownedSprites.size===0&&a.ownedAbilityFx.size===0,'scene soil ownership');
    requirePlan(a.state===(state===enter?'burrowed':'walking'),'completion follows state and retained moving flag');
    const released=[...e.effects];a.onDeath();
    requirePlan(e.transforms.length===0&&e.sprite.visible&&e.sprite.alpha===1&&released.every(f=>f.active),'death preserves released soil');
    requirePlan(e.released.every(f=>close(f.duration,soil.frames*1000/soil.fps)),'soil finite authored lifetime');
    e.released.forEach(f=>f.finish());requirePlan(released.every(f=>!f.active),'soil expiry');
  }
  for(const mode of ['entry','tunnel','surface']) {
    const e=actor(),a=e.a;a.onBurrow();if(mode!=='entry')e.complete(enter);if(mode==='surface')a.onEmerge();
    const heading=a.facing,registration=e.entry();a.onPos(300,250,900);
    requirePlan(a.facing===heading&&e.entry()===registration&&e.transforms.length===1,'position preserves verb and facing');
    const t=e.transforms[0],oldGeneration=a.moveGeneration;
    requirePlan(t.ease==='Linear'&&t.duration===900&&t.x===300&&t.y===250,'linear delivered endpoint');
    e.sprite.y=45;t.onUpdate();requirePlan(e.sprite.depth===actorDepth(45),'movement depth');
    a.onPos(400,350,1100);t.onComplete();requirePlan(a.moving&&a.moveGeneration===oldGeneration+1,'stale movement completion fence');
    e.transforms[0].onComplete();requirePlan(!a.moving,'current movement completion');
    for(const coords of [[700,800],[undefined,800],[700,undefined],[undefined,undefined]]) {
      a.onPos(900,950,1200);const kills=e.kills,generation=a.moveGeneration;
      a.onEmerge(...coords);const snaps=coords.every(v=>v!==undefined);
      requirePlan(e.kills===kills+(snaps?1:0)&&a.moveGeneration===generation&&a.moving,'coordinate emerge kills only transform');
      if(snaps)requirePlan(e.sprite.x===700&&e.sprite.y===800&&e.sprite.depth===actorDepth(800),'coordinate emerge exact snap');
    }
  }
  for(const [dx,dy] of [[0,0],[.5,.5],[-.5,-.5],[1,0],[0,1],[-1,0],[0,-1]]) {
    const e=actor(),a=e.a;a.onBurrow();const registration=e.entry();
    a.onPos(20+dx*positionSnapDistance,30+dy*positionSnapDistance,900);
    requirePlan(e.transforms.length===(Math.abs(dx)<1&&Math.abs(dy)<1?0:1)&&e.entry()===registration,'strict per-axis snap retaining body');
  }
  for(const action of ['seekBurrowed','seekEmerged','cancelPrime','cancelReplayAction','onDeath']) {
    const e=actor(),a=e.a;a.onPos(900,800,5000);a.onBurrow();const entry=e.entry(),generation=a.moveGeneration,kills=e.kills;
    a[action](700,800);
    if(action==='cancelPrime'||action==='cancelReplayAction') {
      requirePlan(e.entry()===entry&&a.moving&&a.moveGeneration===generation&&e.kills===kills+(action==='cancelReplayAction'?1:0),'distinct cancellation behavior');
      e.complete(enter);requirePlan(e.effects.length>0,'direct cancellation retains pending burrow soil');
    } else {
      requirePlan(e.entry()!==entry&&e.effects.length===0,'cold/death cancels historical body cues');
      if(action.startsWith('seek')) {
        requirePlan(!a.moving&&a.moveGeneration===generation+1,'cold seek clears movement');
        a.finishSeek();requirePlan(a.state===(action==='seekBurrowed'?'burrowed':'idle'),'stable cold hydration');
      }
      e.advance(1000*body(enter).frames/body(enter).fps+1);
      requirePlan(e.effects.length===0,'replaced entry cannot emit historical soil');
    }
  }
  const repeated=actor();repeated.a.onBurrow();repeated.advance(50);
  const repeatedEntry=repeated.entry(),repeatedPhase=repeated.ticker.phase(repeated.sprite);
  repeated.a.onBurrow();
  requirePlan(repeated.entry()===repeatedEntry&&JSON.stringify(repeated.ticker.phase(repeated.sprite))===JSON.stringify(repeatedPhase),
    'identical registration retains elapsed phase');
  const row=actor();row.a.onBurrow();row.advance(50);const old=row.entry(),frame=old.onFrame,done=old.onComplete,i=old.i,acc=old.acc;
  row.a.facing='se';row.a.onBurrow();
  requirePlan(row.entry()===old&&old.i===i&&old.acc===acc&&old.onFrame!==frame&&old.onComplete!==done,'row registration preserves phase replaces callbacks');
  requirePlan(Number.isFinite(soilDepthOffset),'missing soil depth');
  return {controller:'v2Burrow',enterState:enter,tunnelState:tunnel,surfaceState:surface,positionSnapDistance,aim,soilDepthOffset,
    movement:'linearPreserveVerb',enterMovement:'retain',emergeMovement:'coordinatesKillRetainMovingFlagOtherwiseRetain',
    identicalRegistration:'preservePhaseAndCallbacks',rowRegistration:'preservePhaseReplaceCallbacks',soilOwnership:'scene',
    coldPrefix:'stableBurrowOrEmergeWithoutHistoricalCues'};
}
