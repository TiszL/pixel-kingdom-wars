import { createHash } from 'node:crypto';

// Renderer7 actor-origin effects whose complete source branches must be exported.
export const ACTOR_TO_EVENT_HERO_SKILLS=Object.freeze(['snotRocket','brownNote']);

/** Extract only the canonical Maul and ownership methods; do not initialize Phaser. */
export function compileMaulController(ts, source, bindings) {
  const ast=ts.createSourceFile('troop.ts',source,ts.ScriptTarget.Latest,true);
  const owner=ast.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text==='V2TroopFx');
  const methods=['playMaul','playEffect','fxBase','ownAbilityImage','delayedAbilityCall','clearAbilityVisuals','cancelReplayAction','onDeath','alive'].map(name=>{
    const member=owner?.members.find(node=>(ts.isMethodDeclaration(node)||ts.isGetAccessorDeclaration(node))&&node.name.getText(ast)===name);
    if(!member)throw new Error(`Missing canonical Maul ownership method ${name}`);
    return member.getText(ast).replace(/^private\s+/,'');
  });
  // Newer canonical controllers own Leap's counter separately. Older pinned
  // sources have no such method; never replace a present helper with a stub.
  const cancelLeap=owner?.members.find(node=>ts.isMethodDeclaration(node)&&node.name.getText(ast)==='cancelLeapMotion');
  if(cancelLeap)methods.push(cancelLeap.getText(ast).replace(/^private\s+/,''));
  return new Function(...Object.keys(bindings),ts.transpile(`class MaulOwner {${methods.join('\n')}};return MaulOwner.prototype;`,{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
}

/** Maul preserves its current facing: the canonical simulator emits no aimed endpoint. */
export function assertTargetlessMaulEvents(ts, source) {
  const ast=ts.createSourceFile('sim.ts',source,ts.ScriptTarget.Latest,true);let found=0;
  function visit(node) {
    if(ts.isObjectLiteralExpression(node)) {
      const properties=node.properties.filter(ts.isPropertyAssignment);
      const literal=(name)=>properties.find(p=>p.name.getText(ast)===name)?.initializer;
      const ability=literal('ability'),kind=literal('e');
      if(ability&&ts.isStringLiteral(ability)&&ability.text==='maul'&&kind&&ts.isStringLiteral(kind)&&kind.text==='troopAbility') {
        const keys=properties.map(p=>p.name.getText(ast));
        if(keys.length!==node.properties.length||keys.some(key=>!['t','e','id','ability','x','y'].includes(key)))
          throw new Error('Canonical Maul event is no longer targetless');
        found++;
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);if(!found)throw new Error('Missing canonical targetless Maul event');
}

/** Probe both releases at distinct actor positions, plus actual source cancellation
 * paths. Only this finite, translation-invariant two-impact choreography is admitted. */
export function captureMaulPlan(controller,{body,fx,tier,fit,drawScale}) {
  if(!body||!fx||![body.fps,body.frames,fx.fps,fx.frames,fit,drawScale].every(n=>Number.isFinite(n)&&n>0))
    throw new Error('Invalid canonical Maul timing or fit');
  let reference;
  for(const shift of [0,103]) for(const stop of ['none','death-before','replace-before','death-after','replace-after']) {
    let clock=0,callback;
    const images=[],timers=[],pools=[];
    const actor={x:17+shift,y:29-shift,depth:137+shift,setVisible(){return this;},setAlpha(){return this;}};
    const first={x:47+shift,y:-13+shift,depth:211-shift},second={x:-61-shift,y:109-shift,depth:-13+shift};
    const context=Object.assign(Object.create(controller),{sprite:actor,state:'acting',profile:{death:'death'},rangedQueue:[],
      deps:{unit:'direwyvern',tier,clips:{[`v2_fx_impact_slam_t${tier}`]:fx}},
      ownedSprites:new Set(),ownedAbilityFx:new Set(),abilityTimers:new Set(),leapTween:null,leapGeneration:0,
      clip(state){if(state!=='maul')throw new Error('Unsupported Maul body');return body;},emitterScale(){return fit;},
      playAbilityOnce(state,onFrame){if(state!=='maul')throw new Error('Unsupported Maul state');callback=onFrame;},
      playOnce(state){if(state!=='death')throw new Error('Unsupported Maul death');},stand(){this.state='idle';},
      scene:{textures:{exists(){return true;}},tweens:{killTweensOf(){}},
        add:{image(x,y,atlas,frame){const listeners=[];const image={x,y,atlas,frame,atMs:clock,active:true,
          setDepth(depth){this.depth=depth;return this;},setOrigin(x,y){this.anchor=[x,y];return this;},
          setScale(scale){this.scale=scale;return this;},setTexture(atlas,frame){this.atlas=atlas;this.frame=frame;return this;},
          once(event,fn){if(event!=='destroy')throw new Error('Unsupported Maul image listener');listeners.push(fn);},
          destroy(){if(!this.active)return;this.active=false;for(const fn of listeners)fn();}};images.push(image);return image;}},
        time:{delayedCall(delay,fn){if(!Number.isFinite(delay)||delay<=0)throw new Error('Invalid Maul timer');
          const timer={atMs:clock+delay,delay,fn,removed:false,remove(){this.removed=true;}};timers.push(timer);return timer;}},
        pool:{add(duration,update,complete,cancel){if(!Number.isFinite(duration)||duration<=0)throw new Error('Nonfinite Maul impact');pools.push({duration,update,complete,cancel});}}
      }});
    controller.playMaul.call(context);
    if(typeof callback!=='function')throw new Error('Missing canonical Maul callback');
    Object.assign(actor,first);
    let releaseFrame;
    for(let frame=1;frame<=body.frames;frame++) {
      clock=(frame-1)*1000/body.fps;const before=images.length;callback(frame);
      if(images.length>before) {if(releaseFrame!==undefined)throw new Error('Maul repeats first impact');releaseFrame=frame;}
    }
    if(images.length!==1||timers.length!==1||pools.length!==1||!context.ownedAbilityFx.has(images[0])||!context.abilityTimers.has(timers[0]))
      throw new Error('Maul first impact and timer must be source-owned exactly once');
    const firstImage=images[0],timer=timers[0];
    const cancel=()=>{if(stop.startsWith('death'))controller.onDeath.call(context);else controller.cancelReplayAction.call(context);};
    if(stop.endsWith('before')) {
      cancel();
      if(firstImage.active||!timer.removed||context.ownedAbilityFx.size||context.abilityTimers.size)throw new Error('Maul cancellation leaves an owned impact or timer');
      continue;
    }
    Object.assign(actor,second);clock=timer.atMs;timer.fn();
    if(images.length!==2||timers.length!==1||pools.length!==2||context.abilityTimers.size||images.some(image=>!context.ownedAbilityFx.has(image)))
      throw new Error('Maul must produce two source-owned impacts and release its timer');
    const last=images[1];
    const firstDepth=firstImage.depth-first.depth,secondDepth=last.depth-second.depth;
    const left=firstImage.x-first.x,right=last.x-second.x;
    if(![left,right,firstDepth,secondDepth,firstImage.y].every(Number.isFinite)||left>=0||right<=0||Math.abs(left+right)>1e-8||
      firstImage.y!==last.y||firstDepth!==secondDepth||timer.delay!==1000/body.fps||last.atMs!==firstImage.atMs+timer.delay)
      throw new Error('Unsupported Maul release geometry or body-frame delay');
    for(let i=0;i<images.length;i++) {
      const image=images[i],pool=pools[i];
      if(image.frame!==`v2_direwyvern_fx_impact_slam_t${tier}_f1`||image.scale!==drawScale*fit||!image.anchor?.every(Number.isFinite)||
        pool.duration!==fx.frames*1000/fx.fps)throw new Error('Unsupported Maul impact art or finite lifetime');
    }
    const plan={bodyState:'maul',releaseFrame,secondDelayMs:timer.delay,leftOffsetX:left,rightOffsetX:right,
      groundOffsetY:firstImage.y-first.y,depthOffset:firstDepth,target:'currentActorXAtReleaseCapturedGroundY',
      fps:fx.fps,scale:firstImage.scale,anchor:firstImage.anchor};
    if(stop.endsWith('after')) {
      cancel();if(images.some(image=>image.active)||context.ownedAbilityFx.size||context.abilityTimers.size)throw new Error('Maul cancellation leaves released impacts');
    } else {
      for(const pool of pools) {pool.update(pool.duration);pool.complete();}
      if(images.some(image=>image.active)||context.ownedAbilityFx.size)throw new Error('Maul impact does not expire');
    }
    const comparable=JSON.stringify(plan,(_key,v)=>typeof v==='number'?Number(v.toFixed(8)):v);
    if(reference&&reference.comparable!==comparable)throw new Error('Maul metadata changes with actor position or cancellation');
    reference={plan,comparable};
  }
  return reference.plan;
}

/** Decode the source's two facing thresholds, then prove the admitted policy
 * against its actual helper across near-zero vectors and both angular edges. */
export function captureFacing8StablePlan(ts,source,stable,bindings) {
  const ast=ts.createSourceFile('clips.ts',source,ts.ScriptTarget.Latest,true);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='facing8Stable');
  const conditions=fn?.body?.statements.filter(ts.isIfStatement).map(n=>n.expression);
  const threshold=(left,operator)=>{
    const node=conditions?.find(n=>ts.isBinaryExpression(n)&&n.left.getText(ast)===left&&n.operatorToken.kind===operator);
    if(!node||node.operatorToken.kind!==operator)throw new Error('Unsupported canonical facing threshold');
    return new Function(...Object.keys(bindings),`return (${node.right.getText(ast)});`)(...Object.values(bindings));
  };
  const minimumDeltaSquared=threshold('dx * dx + dy * dy',ts.SyntaxKind.LessThanToken);
  const retainWithinDegrees=threshold('diff',ts.SyntaxKind.LessThanEqualsToken);
  if(!Number.isFinite(minimumDeltaSquared)||minimumDeltaSquared<=0||!Number.isFinite(retainWithinDegrees)||retainWithinDegrees<0||retainWithinDegrees>=180)
    throw new Error('Invalid canonical facing limits');
  const dirs=['e','se','s','sw','w','nw','n','ne'];
  for(let current=0;current<dirs.length;current++) {
    const heading=(current>4?current-8:current)*45;
    const angles=[...Array.from({length:720},(_,i)=>i/2),...[-1,1].flatMap(sign=>[-1e-6,0,1e-6].map(e=>heading+sign*(retainWithinDegrees+e)))];
    for(const radius of [0,Math.sqrt(minimumDeltaSquared)*(1-1e-6),Math.sqrt(minimumDeltaSquared),Math.sqrt(minimumDeltaSquared)*(1+1e-6),100])for(const angle of angles) {
      const dx=radius*Math.cos(angle*Math.PI/180),dy=radius*Math.sin(angle*Math.PI/180);
      const deg=Math.atan2(dy,dx)*180/Math.PI;
      let diff=Math.abs(deg-heading)%360;if(diff>180)diff=360-diff;
      const nearest=dirs[((Math.round(deg/45)%8)+8)%8];
      const expected=dx*dx+dy*dy<minimumDeltaSquared||diff<=retainWithinDegrees?dirs[current]:nearest;
      if(stable(dx,dy,dirs[current])!==expected)throw new Error('Canonical facing helper cannot be represented by captured Howl aim');
    }
  }
  return {minimumDeltaSquared,retainWithinDegrees};
}

/** Capture the complete Howl dispatch and ownership path without starting Phaser. */
export function compileHowlController(ts,source,bindings) {
  const ast=ts.createSourceFile('troop.ts',source,ts.ScriptTarget.Latest,true);
  const owner=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V2TroopFx');
  const methods=['onAbility','playAbilityOnce','playEffect','fxBase','ownAbilityImage','clearAbilityVisuals','cancelReplayAction','onDeath','alive'].map(name=>{
    const member=owner?.members.find(n=>(ts.isMethodDeclaration(n)||ts.isGetAccessorDeclaration(n))&&n.name.getText(ast)===name);
    if(!member)throw new Error(`Missing canonical Howl method ${name}`);
    return member.getText(ast).replace(/^private\s+/,'');
  });
  // Newer canonical controllers own Leap's counter separately. Older pinned
  // sources have no such method; never replace a present helper with a stub.
  const cancelLeap=owner?.members.find(node=>ts.isMethodDeclaration(node)&&node.name.getText(ast)==='cancelLeapMotion');
  if(cancelLeap)methods.push(cancelLeap.getText(ast).replace(/^private\s+/,''));
  return new Function(...Object.keys(bindings),ts.transpile(`class HowlOwner {${methods.join('\n')}};return HowlOwner.prototype;`,{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
}

/** Admit one finite, source-owned ring sampled once at the keyed actor position. */
export function captureHowlPlan(controller,{body,fx,tier,fit,drawScale}) {
  if(!body||!fx||![body.fps,body.frames,fx.fps,fx.frames,fx.cellW,fx.cellH,fit,drawScale].every(n=>Number.isFinite(n)&&n>0)||
    !Number.isInteger(body.frames)||!Number.isInteger(fx.frames))throw new Error('Invalid canonical Howl timing or fit');
  let reference;
  for(const shift of [0,103])for(const initial of ['s','sw','w','nw','n','ne','e','se'])for(const aimed of [false,true])
  for(const stop of ['none','death-before','replace-before','death-after','replace-after']) {
    let clock=0,callback=null,complete=null,bodyStarts=0,killed=0;
    const images=[],pools=[];
    const actor={x:17+shift,y:29-shift,depth:137+shift,setPosition(x,y){this.x=x;this.y=y;return this;},
      setDepth(v){this.depth=v;return this;},setVisible(){return this;},setAlpha(){return this;}};
    const context=Object.assign(Object.create(controller),{sprite:actor,facing:initial,state:'idle',profile:{death:'death'},rangedQueue:[],
      deps:{unit:'gloamfang',tier,clips:{[`v2_fx_howl_t${tier}`]:fx},ticker:{unregister(){callback=null;complete=null;}}},
      ownedSprites:new Set(),ownedAbilityFx:new Set(),abilityTimers:new Set(),leapTween:null,leapGeneration:0,
      clip(state){if(state!=='howl')throw new Error('Unsupported Howl body');return body;},emitterScale(){return fit;},
      playOnce(state,done,onFrame){callback=null;complete=null;if(state==='death')return;
        if(state!=='howl')throw new Error('Unsupported Howl body action');bodyStarts++;callback=onFrame;complete=done;callback?.(1);},
      stand(){this.state='idle';callback=null;complete=null;},
      scene:{textures:{exists(){return true;}},tweens:{killTweensOf(target){if(target!==actor)throw new Error('Unsupported Howl cancellation target');killed++;}},
        add:{image(x,y,atlas,frame){const listeners=[];const image={x,y,atlas,frame,atMs:clock,active:true,
          setDepth(v){this.depth=v;return this;},setOrigin(x,y){this.anchor=[x,y];return this;},setScale(v){this.scale=v;return this;},
          setTexture(atlas,frame){this.atlas=atlas;this.frame=frame;return this;},
          once(event,fn){if(event!=='destroy')throw new Error('Unsupported Howl listener');listeners.push(fn);},
          destroy(){if(!this.active)return;this.active=false;for(const fn of listeners)fn();}};images.push(image);return image;}},
        pool:{add(duration,update,finish,cancel){pools.push({duration,update,finish,cancel});}}
      }});
    const cast={x:37+shift,y:-19-shift};
    controller.onAbility.call(context,'howl',cast.x,cast.y,...(aimed?[cast.x+200,cast.y]:[]));
    if(actor.x!==cast.x||actor.y!==cast.y||killed!==1||bodyStarts!==1||typeof callback!=='function'||context.facing!==(aimed?'e':initial))
      throw new Error('Howl must snap cast origin, cancel movement, and retain or explicitly aim facing');
    const cancel=()=>stop.startsWith('death')?controller.onDeath.call(context):controller.cancelReplayAction.call(context);
    if(stop.endsWith('before')) {
      cancel();if(callback||images.length||context.ownedAbilityFx.size)throw new Error('Howl cancellation leaves an unreleased body callback');continue;
    }
    const releasePose={x:-47-shift,y:89+shift,depth:211-shift};Object.assign(actor,releasePose);
    let releaseFrame;
    for(let frame=2;frame<=body.frames;frame++) {
      clock=(frame-1)*1000/body.fps;const before=images.length;callback?.(frame);
      if(images.length>before){if(releaseFrame!==undefined)throw new Error('Howl repeats release');releaseFrame=frame;}
    }
    if(releaseFrame===undefined||images.length!==1||pools.length!==1||!context.ownedAbilityFx.has(images[0]))
      throw new Error('Howl must create exactly one source-owned keyed image');
    const image=images[0],pool=pools[0],anchor=image.anchor;
    if(image.frame!==`v2_fx_howl_t${tier}_f1`||image.scale!==drawScale*fit||!Array.isArray(anchor)||anchor.length!==2||!anchor.every(Number.isFinite)||
      pool.duration!==fx.frames*1000/fx.fps||!Number.isFinite(pool.duration)||pool.duration<=0)
      throw new Error('Unsupported Howl art or finite lifetime');
    const offsetX=image.x-releasePose.x,offsetY=image.y-releasePose.y,depthOffset=image.depth-releasePose.depth;
    if(![offsetX,offsetY,depthOffset].every(Number.isFinite))throw new Error('Invalid Howl geometry');
    Object.assign(actor,{x:301,y:-501,depth:901});
    pool.update(pool.duration/2);
    if(image.x!==releasePose.x+offsetX||image.y!==releasePose.y+offsetY)throw new Error('Howl image unexpectedly follows actor');
    if(stop.endsWith('after')) {
      cancel();if(image.active||context.ownedAbilityFx.size)throw new Error('Howl cancellation leaves a released image');
    } else {
      pool.update(pool.duration);pool.finish();if(image.active||context.ownedAbilityFx.size)throw new Error('Howl image does not expire');
      complete?.();if(context.state!=='idle')throw new Error('Howl body does not return to stand');
    }
    const plan={bodyState:'howl',releaseFrame,target:'currentActorAtRelease',offsetX,offsetY,depthOffset,
      facing:'retainUnlessAimed',ownedCancellation:true,fps:fx.fps,scale:image.scale,anchor};
    const comparable=JSON.stringify(plan,(_key,v)=>typeof v==='number'?Number(v.toFixed(8)):v);
    if(reference&&reference.comparable!==comparable)throw new Error('Howl metadata depends on actor position or facing');reference={plan,comparable};
  }
  return reference.plan;
}

/** Execute the authored fan controller. Infer its attachment/geometry and reject any
 * choreography that cannot be reconstructed from a single frame-pinned sprite. */
export function captureFirestormPlan(controller, {body, fx, tier, fit, drawScale}) {
  let reference;
  for (const [targetX,targetY] of [[301,409],[-101,409],[301,-209],[17,29],[20,27]]) {
    const sprites=[],pins=[];let callback,emitter;
    const actor={x:17,y:29,depth:137};
    const context={sprite:actor,deps:{tier,clips:{[`v2_fx_firestorm_t${tier}`]:fx},ticker:{play(sprite,spec){sprite.spec=spec;}}},
      clip(state){if(state!=='firestorm')throw new Error('Unsupported fan body');return body;},row(){return 0;},emitterScale(){return fit;},
      ownedSprites:new Set(),playAbilityOnce(state,onFrame){if(state!=='firestorm')throw new Error('Unsupported fan state');callback=onFrame;},
      scene:{add:{sprite(x,y,atlas,frame){const s={x,y,atlas,frame,active:true,
        setOrigin(x,y){this.anchor=[x,y];return this;},setScale(x,y=x){this.scaleX=x;this.scaleY=y;return this;},
        setDepth(depth){this.depth=depth;return this;},once(){},destroy(){this.active=false;},
        setPosition(x,y){this.x=x;this.y=y;return this;},setRotation(rotation){this.rotation=rotation;return this;}};sprites.push(s);return s;}}},
      probeEmitter(_sprite,clip,name,row,frame,scale){
        if(clip!==body || row!==0 || scale!==fit)throw new Error('Unsupported fan emitter geometry');
        emitter=name;return {x:actor.x+frame*3,y:actor.y-frame*2};
      }};
    controller.call(context,targetX,targetY);
    if(typeof callback!=='function')throw new Error('Missing canonical fan callback');
    for(let frame=1;frame<=body.frames;frame++) {
      const before=sprites[0] && [sprites[0].x,sprites[0].y];callback(frame);
      const s=sprites[0];if(!s)continue;
      if(sprites.length!==1)throw new Error('Canonical fan creates duplicate sprites');
      if(!before || s.x!==before[0] || s.y!==before[1])pins.push(frame);
      const length=Math.hypot(targetX-s.x,targetY-s.y);
      if(Math.abs(s.rotation-Math.atan2(targetY-s.y,targetX-s.x))>1e-8 || s.scaleY!==drawScale*fit)
        throw new Error('Canonical fan facing or thickness changed');
      if(length===0) { if(s.scaleX!==0)throw new Error('Canonical zero-length fan is not collapsed');continue; }
      const reach=length/s.scaleX;
      if(!Number.isFinite(reach)||reach<=0)throw new Error('Invalid canonical fan reach');
      if(s.reach!==undefined && Math.abs(s.reach-reach)>1e-8)throw new Error('Canonical fan reach is not linear');s.reach=reach;
    }
    const s=sprites[0];if(!s || !pins.length || s.spec.loop!==false || typeof s.spec.onComplete!=='function')throw new Error('Missing finite canonical fan');
    s.spec.onComplete();if(s.active)throw new Error('Canonical fan does not expire');
    const plan={bodyState:'firestorm',emitter,pinFrames:pins,reachPx:s.reach,depthOffset:s.depth-actor.depth,
      target:'visibleBuildingCenterOrEvent',fps:s.spec.fps,scale:s.scaleY,anchor:s.anchor};
    if(!Number.isFinite(plan.fps)||plan.fps<=0||!plan.anchor.every(Number.isFinite))throw new Error('Invalid canonical fan art');
    const comparable=JSON.stringify(plan,(_key,v)=>typeof v==='number'?Number(v.toFixed(8)):v);
    if(reference && reference.comparable!==comparable)throw new Error('Canonical fan metadata varies by direction');
    reference={plan,comparable};
  }
  return reference.plan;
}

/** Capture source sweep timing and linear travel; other tween choreography fails closed. */
export function captureImageSweeps(invoke, allowTravel = false) {
  let clock = 0;
  const images = [], delayed = [], tweens = [];
  const scene = { add: { image(x,y,atlas,frame) {
    const image = { x,y,atlas,active:true,depth:0,scale:1,origin:[0.5,0.5],frames:[{atMs:clock,frame}],
      setDepth(depth) { this.depth=depth;return this; },setScale(scale) { this.scale=scale;return this; },
      setOrigin(x,y=x) { this.origin=[x,y];return this; },
      setTexture(atlas,frame) { if(atlas !== this.atlas) throw new Error('Hero sweep changes atlas');this.frames.push({atMs:clock,frame});return this; },
      destroy() { this.active=false;this.lifetimeMs=clock; } };
    images.push(image);return image;
  } }, time: { delayedCall(delay,callback) { delayed.push({atMs:clock+delay,callback}); } },
  tweens: { add(spec) { tweens.push(spec); } } };
  invoke(scene);
  if(tweens.length && !allowTravel) return null;
  for(const tween of tweens) {
    if(!images.includes(tween.targets) || tween.ease !== 'Linear' || ![tween.x,tween.y,tween.duration].every(Number.isFinite) || tween.duration<=0 || tween.targets.travel) throw new Error('Unsupported canonical hero travel');
    tween.targets.travel={toX:tween.x,toY:tween.y,durationMs:tween.duration};
  }
  while(delayed.length) {
    delayed.sort((a,b) => a.atMs-b.atMs);
    const next=delayed.shift();clock=next.atMs;next.callback();
  }
  return images.map((image) => {
    const stepMs=image.frames[1]?.atMs ?? 0;
    if(![image.x,image.y,image.depth,image.scale,image.lifetimeMs,...image.origin].every(Number.isFinite) || image.scale<=0 || image.lifetimeMs<=0 ||
      image.frames.some((frame,index) => frame.atMs !== index*stepMs || !/^fx_(?:theo|vex)_.*_f\d+$/.test(frame.frame)) ||
      (image.frames.length>1 && stepMs<=0) || image.frames.at(-1).atMs>=image.lifetimeMs) throw new Error('Unsupported canonical hero sweep timing or geometry');
    return { x:image.x,y:image.y,frames:image.frames.map((entry) => entry.frame),stepMs,lifetimeMs:image.lifetimeMs,
      depth:image.depth,scale:image.scale,anchor:image.origin,...(image.travel ? {travel:image.travel} : {}) };
  });
}

/** Radial sweeps keep source pixel offsets, not native copies of radii or spoke counts.
 * The exporter supplies an origin probe and the canonical hero body duration. */
export function normalizeRadialSweeps(sweeps, { x, y, durationMs }) {
  if (!Array.isArray(sweeps) || ![x,y,durationMs].every(Number.isFinite) || durationMs <= 0) throw new Error('Unsupported canonical radial sweep');
  return sweeps.map((sweep) => {
    if (sweep.x !== x || sweep.y !== y) throw new Error('Canonical radial sweep does not start at the event origin');
    if (!sweep.travel) return sweep;
    const {toX,toY,durationMs:travelMs} = sweep.travel;
    const tailMs = sweep.lifetimeMs - Math.max(durationMs,sweep.stepMs*sweep.frames.length);
    if (travelMs !== durationMs || ![toX,toY,tailMs].every(Number.isFinite) || tailMs < 0) throw new Error('Unsupported canonical radial sweep clock');
    return {...sweep,travel:{mode:'eventOffset',offsetX:toX-x,offsetY:toY-y,tailMs}};
  });
}

/** The canonical controller is probed with directional and target-kind changes.
 * Only its range projection and one named troop-center cue are admitted. */
export function normalizeMoonsunderSweeps(sweeps, { x, y, towardX, towardY, rangePx, durationMs, targetCenter }) {
  if(!Array.isArray(sweeps) || ![x,y,towardX,towardY,rangePx,durationMs].every(Number.isFinite) || rangePx<=0 || durationMs<=0)
    throw new Error('Unsupported canonical Moonsunder probe');
  const dx=towardX-x,dy=towardY-y,length=Math.hypot(dx,dy);
  const end=length>0 ? [x+dx*rangePx/length,y+dy*rangePx/length] : [towardX,towardY];
  const travel=sweeps.filter((s)=>s.travel),markers=sweeps.filter((s)=>!s.travel);
  if(travel.length!==1 || markers.length!==(targetCenter ? 1 : 0)) throw new Error('Canonical Moonsunder target routing changed');
  return sweeps.map((s)=>{
    if(!s.travel) {
      if(s.x!==targetCenter.x || s.y!==targetCenter.y) throw new Error('Canonical bleed is not placed at the troop center');
      return {...s,x:0,y:0,placement:'targetActorCenterAtCast'};
    }
    const tailMs=s.lifetimeMs-Math.max(durationMs,s.stepMs*s.frames.length);
    if(s.x!==x || s.y!==y || s.travel.durationMs!==durationMs || !Number.isFinite(tailMs) || tailMs<0 ||
      Math.abs(s.travel.toX-end[0])>1e-8 || Math.abs(s.travel.toY-end[1])>1e-8)
      throw new Error('Canonical Moonsunder direction, range or clock changed');
    return {...s,x:0,y:0,travel:{mode:'eventDirectionRange',rangePx,tailMs}};
  });
}

/** Actor-origin projectiles have a distinct stationary branch when the caster is absent.
 * Capture both branches so event target coordinates can never become a fabricated origin. */
export function normalizeActorToEventSweeps(active, fallback, { actorX, actorY, x, y, durationMs }) {
  if(active?.length!==1 || fallback?.length!==1 || ![actorX,actorY,x,y,durationMs].every(Number.isFinite) || durationMs<=0)
    throw new Error('Unsupported canonical actor projectile probe');
  const shot=active[0],rest=fallback[0];
  const tailMs=shot.lifetimeMs-Math.max(durationMs,shot.stepMs*shot.frames.length);
  const appearance=({x,y,lifetimeMs,travel,...art})=>art;
  if(shot.x!==actorX || shot.y!==actorY || shot.travel?.toX!==x || shot.travel?.toY!==y || shot.travel?.durationMs!==durationMs ||
    rest.x!==x || rest.y!==y || rest.travel || !Number.isFinite(tailMs) || tailMs<0 ||
    rest.lifetimeMs!==rest.stepMs*rest.frames.length+tailMs || JSON.stringify(appearance(shot))!==JSON.stringify(appearance(rest)))
    throw new Error('Canonical actor projectile origin, fallback art or clock changed');
  return [{...shot,x:0,y:0,travel:{mode:'actorToEvent',tailMs,absentActorLifetimeMs:rest.lifetimeMs}}];
}

/** Execute source Graphics choreography against a strict capture surface. Changes to the
 * renderer's fade/geometry must fail export instead of becoming handwritten native defaults. */
export function captureGraphicsStroke(invoke) {
  const drawings = [];
  let durationMs, update;
  const pool = { add(duration, draw) { durationMs = duration; update = draw; } };
  const scene = { pool, add: { graphics() {
    const graphic = { active: true, alpha: 1, depth: undefined, layers: [],
      setDepth(depth) { this.depth = depth; return this; },
      lineStyle(width, color, alpha) { this.style = { width, color, alpha }; return this; },
      lineBetween(fromX, fromY, toX, toY) { this.layers.push({ ...this.style, fromX, fromY, toX, toY }); return this; },
      setAlpha(alpha) { this.alpha = alpha; return this; }, destroy() { this.active = false; } };
    drawings.push(graphic); return graphic;
  } }, tweens: { add(spec) {
    if (spec.alpha !== 0 || (spec.ease !== undefined && spec.ease !== 'Linear')) throw new Error('Unsupported canonical stroke fade');
    durationMs = spec.duration; update = (_elapsed, progress) => spec.targets.setAlpha(1 - progress);
  } } };
  invoke(scene);
  if(drawings.length !== 1 || !Number.isFinite(durationMs) || durationMs <= 0 || typeof update !== 'function') throw new Error('Unsupported canonical stroke lifecycle');
  const drawing = drawings[0];
  if(!Number.isFinite(drawing.depth) || drawing.layers.length === 0) throw new Error('Missing canonical stroke geometry');
  for(const progress of [0,0.25,0.5,0.75,1]) {
    update(progress * durationMs,progress);
    if(drawing.alpha !== 1 - progress) throw new Error('Unsupported canonical stroke fade');
  }
  const { fromX,fromY,toX,toY } = drawing.layers[0];
  const layers = drawing.layers.map((layer) => {
    if(!Object.values(layer).every(Number.isFinite) || layer.width <= 0 || !Number.isInteger(layer.color) || layer.color < 0 || layer.color > 0xffffff || layer.alpha < 0 || layer.alpha > 1 ||
      layer.fromX !== fromX || layer.fromY !== fromY || layer.toX !== toX || layer.toY !== toY) throw new Error('Unsupported canonical stroke geometry');
    return { width: layer.width, color: layer.color, alpha: layer.alpha };
  });
  return { stroke: { durationMs, depth: drawing.depth, fade: 'linear', layers }, fromX,fromY,toX,toY };
}

export function captureHeroTransitions(delayed, transitions) {
  for (const pending of delayed) {
    const before = transitions.length;
    pending.callback();
    for (let index = before; index < transitions.length; index++) transitions[index].atMs = pending.atMs;
  }
}

export function assertCanonicalSlamOffset(offset) {
  if (!Array.isArray(offset) || offset.length !== 2 || !offset.every(Number.isFinite)) {
    throw new Error('Canonical giant slam placement is not numeric; update the contract exporter');
  }
}

/** Resolve source-authored combat data into renderer-ready clips. All timing,
 * routing and geometry inputs are supplied by the canonical source exporter. */
export function buildCombatCatalogue({ meta, index, atlasFrames, shared, constants, helpers, profiles, entries, actors, walls = [] }) {
  const requiredAtlases = new Set();
  const clips = { ...meta.v2Clips, ...meta.wareClips };
  const fail = (message) => { throw new Error(`Combat contract: ${message}`); };
  function resolveFrames(key, frames, data) {
    const paths = new Set(frames.flat().map((frame) => index.get(frame)));
    if (paths.has(undefined) || paths.size !== 1) fail(`missing or split atlas for ${key}`);
    const atlasPath = [...paths][0];
    if (!frames.flat().every((frame) => atlasFrames.get(atlasPath)?.has(frame))) fail(`incomplete frames for ${key}`);
    requiredAtlases.add(atlasPath);
    return { key, atlasPath, frames, ...data };
  }
  function resolveClip(key, scale, variant = 0) {
    const clip = clips[key];
    if (!clip) fail(`missing authored clip ${key}`);
    if (![clip.frames, clip.rows, clip.cellW, clip.cellH].every((n) => Number.isInteger(n) && n > 0)) fail(`invalid grid for ${key}`);
    if (!Number.isFinite(scale) || scale <= 0 || (clip.fps !== undefined && (!Number.isFinite(clip.fps) || clip.fps < 0))) fail(`invalid scale/cadence for ${key}`);
    const stride = clip.variants ? clip.variantStride : clip.frames;
    if (!clip.variants) variant = 0;
    if (!Number.isInteger(stride) || stride <= 0 || (clip.variants && (variant < 0 || variant >= clip.variants || stride !== clip.frames))) fail(`invalid variant block for ${key}`);
    // Source V2TroopFx.frames treats clip.frames as one variant's count; the
    // generic frameName clamp must see the complete packed column extent.
    const packedClip = clip.variants ? { ...clip, frames: stride * clip.variants } : clip;
    const frames = Array.from({ length: clip.rows }, (_, row) => Array.from({ length: stride }, (_, frame) => helpers.frameName(key, packedClip, row, variant * stride + frame + 1)));
    const anchorPx = clip.anchorPx ?? [clip.cellW / 2, clip.cellH / 2];
    if (anchorPx.length !== 2 || !anchorPx.every(Number.isFinite)) fail(`invalid anchor for ${key}`);
    const fractional = key.startsWith('ware_') && anchorPx.every((n) => n >= 0 && n <= 1);
    const anchor = fractional ? anchorPx : [anchorPx[0] / clip.cellW, anchorPx[1] / clip.cellH];
    return resolveFrames(key, frames, { rowOrder: clip.rowOrder ?? (clip.rows > 1 ? helpers.V2_DIRS : ['s']),
      fps: clip.fps ?? 0, static: !clip.fps, loop: clip.loop === true, anchor, scale, cellWidth: clip.cellW, cellHeight: clip.cellH,
      ...(clip.emitters ? { emitters: clip.emitters } : {}), ...(clip.fxAt ? { fxAt: clip.fxAt } : {}),
      fxCues: helpers.parseFxAt(clip.fxAt), travel: clip.travel === true, variant });
  }
  const effects = {};
  for (const key of Object.keys(clips).filter((key) => /^(?:v2|ware)_fx_/.test(key)).sort()) effects[key] = resolveClip(key, helpers.V2_DRAW_SCALE);
  function legacyClip(key, scale, fps = 1000 / helpers.ANIM_TICK_MS) {
    const family = meta.families[key];
    const frames = family?.sequence ?? family?.frames;
    if (!Array.isArray(frames) || !frames.length) fail(`missing legacy family ${key}`);
    const sprite = meta.sprites[frames[0]];
    const atlas = atlasFrames.get(index.get(frames[0]));
    const cell = atlas?.get(frames[0]);
    if (!sprite?.anchor?.every(Number.isFinite) || !cell) fail(`missing legacy geometry ${key}`);
    return resolveFrames(key, [frames], { rowOrder: ['s'], fps, loop: true, anchor: sprite.anchor, scale,
      cellWidth: cell.w, cellHeight: cell.h, fxCues: [] });
  }
  for (const key of Object.keys(meta.families).filter((key) => /^fx_(?:theo|vex)_/.test(key)).sort()) effects[key] = legacyClip(key, helpers.V2_DRAW_SCALE);
  function effectSet(bodyClips, tier, scale) {
    const result = {};
    for (const body of Object.values(bodyClips)) for (const cue of body.fxCues) {
      if (helpers.V2_PROJ[cue.fx]) continue; // The projectile controller owns its release, never a second stationary FX.
      const key = [`v2_fx_${cue.fx}_t${tier}`, `v2_fx_${cue.fx}`, `v2_fx_impact_${cue.fx}_t${tier}`, `ware_fx_${cue.fx}_t${tier}`, `ware_fx_${cue.fx}`].find((key) => effects[key]);
      if (key) { result[key] = { ...effects[key], scale }; cue.effectKey = key; }
    }
    return result;
  }
  function v2Projectiles(kinds, tier, scale) {
    const result = {};
    for (const kind of kinds) {
      const profile = helpers.V2_PROJ[kind];
      if (!profile) continue;
      const impactKey = profile.impact === 'bolt_hit' ? `v2_fx_bolt_hit_t${tier}` : `v2_fx_impact_${profile.impact}_t${tier}`;
      result[kind] = { travel: resolveClip(`v2_fx_${kind}_t${tier}`, scale),
        ...(profile.impact ? { impact: resolveClip(impactKey, scale) } : {}),
        ...(profile.shadow ? { shadow: resolveClip('v2_fx_shadow', scale) } : {}),
        travelMs: profile.travelTicks * helpers.V2_TICK_MS, arc: profile.arc,
        yForeshorten: helpers.PROJ_Y_FORESHORTEN, shadowDrop: helpers.shadowDropAtFitOne * scale / helpers.V2_DRAW_SCALE,
        shadowFrames: helpers.shadowFrames, shadowDefaultFrame: helpers.shadowDefaultFrame, depths: helpers.depths };
    }
    return result;
  }
  function wareProjectiles(plans, tier) {
    const result = {};
    for (const kind of new Set(Object.values(plans).filter(Boolean).map((plan) => plan.shot))) {
      const spec = helpers.wareProjectileSpec(kind, tier);
      if (!spec) fail(`missing WARE projectile ${kind}`);
      // launchWareShot/playWareFx use global artwork scale. Only the release emitter
      // inherits the fitted building's scale; shrinking the shot would diverge from web.
      result[kind] = { ...(spec.base ? { travel: resolveClip(spec.base, helpers.V2_DRAW_SCALE) } : { beam: true }),
        ...(kind === 'laser' ? { stroke: helpers.wareBeamStroke } : {}),
        ...(spec.impact ? { impact: resolveClip(spec.impact, helpers.V2_DRAW_SCALE) } : {}),
        travelMs: spec.durationMs, arc: helpers.wareArc(kind), yForeshorten: helpers.PROJ_Y_FORESHORTEN,
        shadowDrop: 0, depths: helpers.depths, ...(spec.emitter ? { emitter: spec.emitter } : {}) };
    }
    return result;
  }
  function bodySet(prefix, scale, variant) {
    return Object.fromEntries(Object.keys(clips).filter((key) => key.startsWith(prefix)).sort().map((key) => [key.slice(prefix.length), resolveClip(key, scale, variant)]));
  }
  for (const actor of actors) {
    const tier = shared.artTierOfLevel(actor.level);
    const profile = profiles[actor.type];
    if (profile) {
      const bodyClips = bodySet(`v2_${profile.kind}_${actor.type}_t${tier}_`, actor.scale, actor.variant ?? 0);
      const requiredStates = new Set([profile.move, profile.battleMove, profile.stand, ...profile.attack,
        ...profile.abilities ?? [], profile.spawn, profile.hit, profile.damaged, profile.death,
        ...Object.values(profile.burrow ?? {}), ...Object.values(profile.melee ?? {})].filter(Boolean));
      for (const state of requiredStates) if (!bodyClips[state]) fail(`profile ${actor.type} needs ${state}`);
      const projectileKinds = new Set([profile.ranged?.projectile, ...Object.values(bodyClips).flatMap((clip) => clip.fxCues.map((cue) => cue.fx))]);
      actor.combat = { clips: bodyClips, profile, fxEmitters: { ...helpers.MELEE_FX_EMITTER?.[actor.type],
        ...(profile.ranged?.flash ? { [profile.ranged.flash]: profile.ranged.emitter } : {}) },
        fxFacingRotationDeg: helpers.FACING_ROTATION_DEG ?? {}, slamOffset: helpers.slamOffset,
        projectiles: v2Projectiles(projectileKinds, tier, actor.scale),
        effects: effectSet(bodyClips, tier, actor.scale), deathHoldMs: helpers.DEATH_HOLD_MS, deathFadeMs: helpers.DEATH_FADE_MS };
      if (profile.hit || profile.damaged) {
        if (!Number.isFinite(helpers.bodyMoveSnapTiles) || helpers.bodyMoveSnapTiles <= 0) fail('invalid source body movement threshold');
        actor.combat.bodyMoveSnapTiles = helpers.bodyMoveSnapTiles;
        if (!Number.isFinite(helpers.bodyFacingAim?.minimumDeltaSquared) || helpers.bodyFacingAim.minimumDeltaSquared <= 0 ||
            !Number.isFinite(helpers.bodyFacingAim?.retainWithinDegrees) || helpers.bodyFacingAim.retainWithinDegrees < 0 ||
            helpers.bodyFacingAim.retainWithinDegrees >= 180) fail('invalid source body facing');
        actor.combat.bodyFacingAim = helpers.bodyFacingAim;
      }
      if (profile.damaged) {
        const maxHp = helpers.troopMaxHp(actor.type, actor.level);
        const healthRatio = constants.BATTLE_BODY_PRESENTATION?.damagedTroopHealthRatio;
        if (!Number.isSafeInteger(maxHp) || maxHp <= 0 || !Number.isFinite(healthRatio) || healthRatio <= 0 || healthRatio > 1)
          fail(`invalid damaged body health for ${actor.type}`);
        actor.damagedBodyMaxHp = maxHp;
        actor.combat.damagedBody = { healthRatio };
      }
      if(profile.burrow) actor.combat.burrowMotion=helpers.burrowMotion(actor.type,tier,profile,actor.scale/helpers.V2_DRAW_SCALE);
      if (actor.type === 'dragon') {
        actor.combat.breathStream = { ...meta.breathStream,
          ...Object.fromEntries(['root', 'mid', 'tip'].map((part) => [part, resolveClip(`v2_fx_stream_${part}_t${tier}`, helpers.V2_DRAW_SCALE)])),
          pointBlank: resolveClip(`v2_fx_breath_t${tier}`, actor.scale), impact: resolveClip(`v2_fx_impact_burn_t${tier}`, actor.scale) };
      }
      if(actor.type==='gloamfang') {
        const motion=helpers.gloamfangMotion(clips[`v2_trp_gloamfang_t${tier}_leap`]);
        actor.combat.leap=motion.leap;
        actor.combat.lunge=motion.lunge;
        const {fps,scale,anchor,...howl}=helpers.howlPlan(clips[`v2_trp_gloamfang_t${tier}_howl`],
          clips[`v2_fx_howl_t${tier}`],tier,actor.scale/helpers.V2_DRAW_SCALE);
        actor.combat.howl={...howl,clip:{...resolveClip(`v2_fx_howl_t${tier}`,scale),fps,anchor,loop:false}};
      }
      if (actor.type === 'direwyvern') {
        const body=clips[`v2_trp_direwyvern_t${tier}_firestorm`],fx=clips[`v2_fx_firestorm_t${tier}`];
        const {fps,scale,anchor,...fan}=helpers.firestormPlan(body,fx,tier,actor.scale/helpers.V2_DRAW_SCALE);
        actor.combat.firestorm={...fan,clip:{...resolveClip(`v2_fx_firestorm_t${tier}`,scale),fps,anchor}};
        const {fps:maulFps,scale:maulScale,anchor:maulAnchor,...maul}=helpers.maulPlan(
          clips[`v2_trp_direwyvern_t${tier}_maul`],clips[`v2_fx_impact_slam_t${tier}`],tier,actor.scale/helpers.V2_DRAW_SCALE);
        actor.combat.maul={...maul,clip:{...resolveClip(`v2_fx_impact_slam_t${tier}`,maulScale),fps:maulFps,anchor:maulAnchor,loop:false}};
        const framePlan = helpers.burnfieldFrames(meta.v2Clips, tier);
        if (!framePlan) fail(`missing canonical burnfield frame plan tier ${tier}`);
        const clip = resolveClip(`v2_fx_burnfield_t${tier}`, helpers.V2_DRAW_SCALE);
        const frameIndices = (frames) => frames.map((frame) => { const index = clip.frames[0].indexOf(frame); if (index < 0) fail(`missing burnfield frame ${frame}`); return index + 1; });
        actor.combat.burnfield = { clip, liveFrames: frameIndices(framePlan.live), extinguishFrames: frameIndices(framePlan.extinguish), stepMs: framePlan.stepMs };
      }
    } else if (actor.type === 'wyrmling') {
      // WARE hatchling deliberately uses its own body scale, without troop fit.
      actor.scale = helpers.V2_DRAW_SCALE;
      const bodyClips = bodySet(`ware_unt_hatchling_t${tier}_`, actor.scale, 0);
      for (const state of helpers.hatchlingStates) if (!bodyClips[state]) fail(`hatchling needs ${state}`);
      actor.combat = { clips: bodyClips, profile: { stand: 'hover', move: 'fly', attack: ['attack'], spawn: 'spawn', hit: 'hit', death: 'death', flying: true,
        ranged: { state: 'attack', emitter: 'maw', projectile: 'hatchfire', releaseFrame: constants.AUTHORED_ATTACK_TIMINGS.wyrmling.releaseFrame } },
        projectiles: wareProjectiles({ attack: { shot: 'hatchfire' } }, tier), effects: {}, deathHoldMs: helpers.DEATH_HOLD_MS, deathFadeMs: helpers.DEATH_FADE_MS };
    } else if (constants.HERO_KEYS.includes(actor.type)) {
      const skin = `hero_${actor.type === 'theodor' ? 'theo' : actor.type}`;
      const bodyClips = Object.fromEntries(Object.keys(meta.families).filter((key) => key.startsWith(`${skin}_`)).sort().map((key) => [key.slice(skin.length + 1), legacyClip(key, actor.scale)]));
      if (!bodyClips.idle || !bodyClips.walk_s || !bodyClips.attack_e || !bodyClips.defeat) fail(`incomplete hero ${actor.type}`);
      bodyClips.defeat = { ...bodyClips.defeat, fps: 1000 / helpers.HERO_DEATH_STEP_MS, loop: false };
      bodyClips.walk = { ...bodyClips.walk_s, frames: ['s', 'n', 'e'].map((dir) => bodyClips[`walk_${dir}`].frames[0]), rowOrder: ['s', 'n', 'e'], mirrorWestFrom: 'e' };
      const heroSkills = helpers.heroBodyPlans?.[actor.type] ?? {};
      for (const plan of Object.values(heroSkills)) for (const phase of [plan, ...plan.transitions ?? []]) if (!bodyClips[phase.state]) fail(`missing hero phase ${actor.type}:${phase.state}`);
      actor.combat = { clips: bodyClips, profile: { stand: 'idle', move: 'walk', attack: ['attack_e'], hit: 'hit', death: 'defeat', mirrorWestFrom: 'e', heroSkills },
        heroBodyDefaultTicks: helpers.heroBodyDefaultTicks,
        projectiles: {}, effects: Object.fromEntries(Object.entries(effects).filter(([key]) => key.startsWith(`fx_${actor.type === 'theodor' ? 'theo' : actor.type}_`))),
        deathHoldMs: helpers.DEATH_HOLD_MS, deathFadeMs: helpers.DEATH_FADE_MS };
      actor.combat.heroEffects = Object.fromEntries(Object.entries(helpers.heroSweepPlans?.[actor.type] ?? {}).map(([key,plan]) => [key,
        { effects:plan.effects.map((effect) => {
          const frame=effect.frames[0];const cell=atlasFrames.get(index.get(frame))?.get(frame);
          if(!cell) fail(`missing hero sweep frame ${frame}`);
          return { lifetimeMs:effect.lifetimeMs,depth:effect.depth,...(effect.travel ? {travel:effect.travel} : {}),...(effect.placement ? {placement:effect.placement} : {}),clip:resolveFrames(frame.replace(/_f\d+$/,''),[effect.frames],{
            rowOrder:['s'],fps:effect.stepMs>0 ? 1000/effect.stepMs : 0,static:effect.stepMs===0,loop:false,anchor:effect.anchor,scale:effect.scale,
            cellWidth:cell.w,cellHeight:cell.h,fxCues:[] }) };
        }),sensory:plan.sensory } ]));
    } else fail(`unhandled actor ${actor.type}`);
  }
  for (const building of entries) {
    const tier = shared.artTierOfLevel(building.level);
    const v2Prefix = `v2_bld_${building.type}_t${tier}_`;
    const ware = helpers.isWareBuildingUnit(building.type);
    const trap = helpers.isWareTrapUnit(building.type);
    const prefix = ware ? helpers.wareBuildingClipKey(building.type, building.level, '')
      : trap ? helpers.wareTrapClipKey(building.type, building.level, '') : v2Prefix;
    const bodyClips = bodySet(prefix, building.scale, 0);
    if (!Object.keys(bodyClips).length) continue;
    const firePlans = {};
    const unavailableFirePlans = [];
    if (ware) for (const projectile of ['cannonball', 'arrow', 'shell', 'beam']) for (const nearKeep of [false, true]) {
      const plan = helpers.wareFirePlan(building.type, projectile, nearKeep);
      if (plan) {
        // The canonical WARE controller rejects unavailable states; lower
        // Keep levels intentionally have no unlocked weapon animation.
        if (plan.states.some((state) => !bodyClips[state])) { unavailableFirePlans.push(`${projectile}:${nearKeep ? 'near' : 'far'}`); continue; }
        firePlans[`${projectile}:${nearKeep ? 'near' : 'far'}`] = plan;
      }
    }
    const battleStand = trap ? helpers.trapBattleStand?.[building.type] : undefined;
    if (trap && (typeof battleStand !== 'string' || !bodyClips[battleStand])) fail(`missing canonical battle trap rest ${building.type}`);
    const projectileKinds = new Set(Object.values(bodyClips).flatMap((clip) => clip.fxCues.map((cue) => cue.fx)));
    building.combat = { clips: bodyClips, profile: { stand: trap ? shared.WARE_TRAP_ART[building.type] : 'idle',
      ...(trap ? { battleStand } : {}),
      attack: trap ? helpers.trapStates[building.type] : bodyClips.fire ? ['fire', ...(bodyClips.reload ? ['reload'] : [])] : [], death: trap ? 'sprung' : 'collapse', damaged: 'damaged', firePlans, unavailableFirePlans,
      ...(building.type === 'keep' ? { nearKeepRangePx: helpers.nearKeepRangePx } : {}) },
      projectiles: ware ? wareProjectiles(firePlans, tier) : v2Projectiles(projectileKinds, tier, building.scale),
      effects: effectSet(bodyClips, tier, building.scale), deathHoldMs: helpers.DEATH_HOLD_MS, deathFadeMs: helpers.DEATH_FADE_MS };
    if (ware && building.type === 'dragonnest') {
      const durationMs = constants.BATTLE_BODY_PRESENTATION?.dragonNestWorkMs;
      if (!bodyClips.work || !Number.isFinite(durationMs) || durationMs <= 0) fail('invalid Dragon Nest spawn work');
      building.combat.spawnWork = { state: 'work', durationMs };
    }
    if(ware && building.type === 'electrictower') building.combat.chain = {
      ...helpers.wareChain, impact: resolveClip(helpers.wareChain.impactKey,helpers.V2_DRAW_SCALE) };
  }
  // Five-tier walls (D-126): the retired WARE 16-row sheets are gone. Each wall
  // carries its wall5 baseline damaged (light/heavy stage cells, shown static)
  // and collapse families; the compositor contract lives in the walls5 section.
  for (const wall of walls) {
    const tier = helpers.wallTierOfLevel(wall.level);
    const shape = helpers.wallShapes[wall.mask];
    if (!shape) fail(`missing canonical wall shape for mask ${wall.mask}`);
    const wallClips = {};
    for (const [state, fps] of [['damaged', 0], ['collapse', helpers.wallArt.collapseFps]]) {
      const key = `wall5_t${tier}_${shape}_${state}`;
      const family = meta.families[key];
      const frames = family?.sequence ?? family?.frames;
      if (!Array.isArray(frames) || !frames.length) fail(`missing wall5 family ${key}`);
      const cell = atlasFrames.get(index.get(frames[0]))?.get(frames[0]);
      const anchor = meta.sprites[frames[0]]?.anchor;
      if (!cell || !anchor?.every(Number.isFinite)) fail(`missing wall5 geometry ${key}`);
      wallClips[state] = resolveFrames(key, [frames], { rowOrder: ['s'], fps, static: fps === 0, loop: false, anchor, scale: wall.scale,
        cellWidth: cell.w, cellHeight: cell.h, fxCues: [] });
    }
    if (wallClips.damaged.frames[0].length !== 2) fail(`wall5 damaged family must carry light and heavy stages for level ${wall.level}`);
    if (wallClips.collapse.frames[0].length !== helpers.wallArt.collapseFrames) fail(`wall5 collapse family length changed for level ${wall.level}`);
    wall.combat = { clips: wallClips, profile: { damaged: 'damaged', death: 'collapse' }, projectiles: {}, effects: {},
      deathHoldMs: helpers.DEATH_HOLD_MS, deathFadeMs: helpers.DEATH_FADE_MS };
  }
  const combatProfiles = {};
  // The canonical south-seat sprite bounds are also the Firestorm target. Export
  // the rendered centre rather than reproducing atlas dimensions in Android.
  for(const building of [...entries,...walls]) if(building.combat) {
    const cell=atlasFrames.get(building.atlasPath)?.get(building.frameKey);
    if(!cell)fail(`missing target bounds ${building.frameKey}`);
    building.combat.buildingTarget={offsetX:(.5-building.anchor[0])*cell.w*building.scale+(building.offsetX??0),
      offsetY:-cell.h*building.scale/2+(building.offsetY??0)};
  }
  for (const entry of [...actors, ...entries, ...walls]) if (entry.combat) {
    const key = createHash('sha256').update(JSON.stringify(entry.combat)).digest('hex');
    combatProfiles[key] ??= entry.combat;
    entry.combatKey = key;
    delete entry.combat;
  }
  return { effects, combatProfiles, requiredAtlases: [...requiredAtlases].sort(), coverage: { actorEntries: actors.filter((actor) => actor.combatKey).length,
    buildingEntries: entries.filter((entry) => entry.combatKey).length, wallEntries: walls.length, uniqueProfiles: Object.keys(combatProfiles).length, effectClips: Object.keys(effects).length,
    sourceProfileCount: Object.keys(profiles).length, heroEventPhaseRouting: 'source controller-derived body phases; effect choreography remains renderer-owned' } };
}
