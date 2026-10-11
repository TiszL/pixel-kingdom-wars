// Execute canonical controller methods against a deliberately small capture surface.
// This records presentation only; no simulator, damage, or landing-time calculation.
import { CARRIED_LEAP_CANCELLATION } from './carried-motion-metadata.mjs';

export function compileGloamfangMotion(ts,source,bindings) {
  const ast=ts.createSourceFile('troop.ts',source,ts.ScriptTarget.Latest,true);
  const owner=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V2TroopFx');
  const onPos=owner?.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)==='onPos');
  let positionSnapDistance;
  const inspect=node=>{
    if(ts.isIfStatement(node)&&ts.isBinaryExpression(node.expression)&&node.expression.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken) {
      const pair=[node.expression.left,node.expression.right];
      if(pair.every((part,i)=>ts.isBinaryExpression(part)&&part.operatorToken.kind===ts.SyntaxKind.LessThanToken&&
        part.left.getText(ast)===`Math.abs(${i===0?'dx':'dy'})`&&ts.isNumericLiteral(part.right))) {
        const values=pair.map(part=>Number(part.right.text));
        if(values[0]!==values[1]||!(values[0]>0)||!Number.isFinite(values[0]))throw new Error('Unsupported Gloamfang position snap distance');
        positionSnapDistance=values[0];
      }
    }
    ts.forEachChild(node,inspect);
  };
  if(onPos)inspect(onPos);
  if(positionSnapDistance===undefined)throw new Error('Missing canonical Gloamfang position snap distance');
  const names=['alive','onAbility','playLeap','onPos','snapPosition','clearAbilityVisuals','cancelReplayAction','onDeath','destroy'];
  const methods=names.map(name=>{
    const node=owner?.members.find(n=>(ts.isMethodDeclaration(n)||ts.isGetAccessorDeclaration(n))&&n.name.getText(ast)===name);
    if(!node)throw new Error(`Missing canonical Gloamfang motion method ${name}`);
    return node.getText(ast).replace(/^private\s+/,'');
  });
  // Production main (origin/main) runs an unowned Leap counter; web commit 7374477c
  // added cancelLeapMotion(). Compile whichever the source has and record which,
  // so the capture can prove ownership from source or carry the fixed policy.
  const cancelLeap=owner?.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)==='cancelLeapMotion');
  if(cancelLeap)methods.push(cancelLeap.getText(ast).replace(/^private\s+/,''));
  const controller=new Function(...Object.keys(bindings),ts.transpile(`class MotionOwner {${methods.join('\n')}};return MotionOwner.prototype;`,{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
  return Object.assign(controller,{positionSnapDistance,ownsLeapCounter:!!cancelLeap});
}
const requireMotion=(ok,message)=>{if(!ok)throw new Error(`Unsupported Gloamfang motion: ${message}`);};
const close=(a,b)=>Number.isFinite(a)&&Math.abs(a-b)<1e-8;
export function captureGloamfangMotion(controller,{body,actorDepth,facing8Stable,carried=CARRIED_LEAP_CANCELLATION}) {
  requireMotion(Number.isInteger(body?.frames)&&body.frames>0&&Number.isFinite(body?.fps)&&body.fps>0,'missing or invalid Leap body');
  const positionSnapDistance=controller.positionSnapDistance;
  requireMotion(Number.isFinite(positionSnapDistance)&&positionSnapDistance>0,'invalid position snap distance');
  const owns=controller.ownsLeapCounter===true;
  function actor() {
    const counters=[],transforms=[],bodies=[],sprite={active:true,x:-200,y:-300,depth:0,
      setPosition(x,y){this.x=x;this.y=y;return this;},setDepth(d){this.depth=d;return this;},
      setVisible(){return this;},setAlpha(){return this;},destroy(){this.active=false;}};
    const ctx=Object.assign(Object.create(controller),{sprite,state:'standing',moving:false,facing:'nw',moveGeneration:0,
      leapGeneration:0,leapTween:null,snapNextPos:false,abilityTimers:new Set(),ownedSprites:new Set(),ownedAbilityFx:new Set(),
      deps:{unit:'gloamfang',tier:1,ticker:{unregister(){}}},profile:{death:'death'},
      clip(state){return ['leap','lunge'].includes(state)?body:null;},
      playOnce(state,done){bodies.push(state);this.bodyDone=done;},
      playAbilityOnce(state){this.state='acting';bodies.push(state);},
      stand(){this.state='standing';bodies.push('stand');},
      scene:{tweens:{killTweensOf(){},add(options){transforms.push(options);return {};},
        addCounter(options){const handle={removed:false,remove(){this.removed=true;}};counters.push({options,handle});return handle;}}}});
    return {ctx,sprite,counters,transforms,bodies};
  }
  let durationMs,heightRatio;
  for(const [x,y,tx,ty] of [[0,0,100,0],[123,-40,-77,260],[50,80,50,80]]) {
    const a=actor();controller.onAbility.call(a.ctx,'leap',x,y,tx,ty);
    requireMotion(a.sprite.x===x&&a.sprite.y===y,'cast must snap to source event origin');
    requireMotion(a.ctx.facing===facing8Stable(tx-x,ty-y,'nw'),'aimed facing');
    requireMotion(a.counters.length===1&&a.bodies.join(',')==='leap','one Leap body/counter');
    const {options:o,handle}=a.counters[0];
    requireMotion(o.from===0&&o.to===1&&o.ease==='Linear'&&Number.isFinite(o.duration)&&o.duration>0,'finite Linear progress');
    if(durationMs===undefined)durationMs=o.duration;
    requireMotion(durationMs===o.duration,'origin-independent duration');
    const dx=tx-x,dy=ty-y,range=Math.hypot(dx,dy);
    o.onUpdate({getValue:()=>.25});
    if(range>0&&heightRatio===undefined)heightRatio=(y+dy*.25-a.sprite.y)/(range*4*.25*.75);
    for(const progress of [0,.125,.25,.5,.75,1]) {
      o.onUpdate({getValue:()=>progress});
      requireMotion(close(a.sprite.x,x+dx*progress)&&close(a.sprite.y,y+dy*progress-range*heightRatio*4*progress*(1-progress)), 'parabolic position');
      requireMotion(close(a.sprite.depth,actorDepth(y+dy*progress)),'ground depth, not elevated sprite depth');
    }
    if(owns)requireMotion(a.ctx.leapTween===handle,'owned counter');
    o.onComplete();requireMotion(a.sprite.x===tx&&a.sprite.y===ty,'exact completion');
    if(owns)requireMotion(a.ctx.leapTween===null,'ownership release');
  }
  requireMotion(Number.isFinite(heightRatio)&&heightRatio>=0,'finite visual height');
  for(const [dx,dy] of [[0,0],[.5,.5],[-.5,-.5],[1,0],[0,1],[-1,0],[0,-1],[2,2]]) {
    const a=actor();controller.onAbility.call(a.ctx,'leap',0,0,100,0);
    controller.onPos.call(a.ctx,dx*positionSnapDistance,dy*positionSnapDistance,100);
    const snaps=Math.abs(dx)<1&&Math.abs(dy)<1;
    requireMotion(a.transforms.length===(snaps?0:1),'position snap boundary');
    requireMotion(!a.counters[0].handle.removed&&a.bodies.join(',')==='leap','ordinary position correction preserves owned counter/body');
  }
  // A counter is not a sprite-target tween. Verify actual removal and stale
  // callback fences independently of killTweensOf, including replay replacement.
  for(const stop of ['onDeath','cancelReplayAction','destroy','snapPosition','onAbility']) {
    const a=actor();controller.onAbility.call(a.ctx,'leap',10,20,210,120);
    const {options:o,handle}=a.counters[0];o.onUpdate({getValue:()=>.25});
    if(stop==='snapPosition')controller[stop].call(a.ctx,800,460);
    else if(stop==='onAbility')controller[stop].call(a.ctx,'lunge',800,460,900,460);
    else controller[stop].call(a.ctx);
    if(!owns) {
      // Production main leaves the counter running: that is the defect 7374477c
      // fixed, carried below. Any other cancellation mechanism is unknown art.
      requireMotion(!handle.removed,'unowned counter cancelled by an unknown mechanism');
      continue;
    }
    const at=[a.sprite.x,a.sprite.y,a.sprite.depth],generation=a.ctx.leapGeneration;
    requireMotion(handle.removed&&a.ctx.leapTween===null,'counter cancellation');
    // Reactivate only the capture sprite: death's active flag must not mask a
    // missing generation fence in either already-queued callback.
    a.sprite.active=true;o.onUpdate({getValue:()=>.9});o.onComplete();
    requireMotion(at.every((v,i)=>v===[a.sprite.x,a.sprite.y,a.sprite.depth][i])&&generation===a.ctx.leapGeneration,'stale callback cancellation');
  }
  const moving=actor();controller.onAbility.call(moving.ctx,'leap',10,20,210,120);
  const direction=moving.ctx.facing;
  controller.onPos.call(moving.ctx,-300,-400,1000);
  requireMotion(moving.transforms.length===1&&!moving.counters[0].handle.removed&&(!owns||moving.ctx.leapTween===moving.counters[0].handle)&&
    moving.ctx.facing===direction&&moving.ctx.state==='acting'&&moving.bodies.join(',')==='leap','ordinary position preserves body and counter');
  const missing=actor();controller.onAbility.call(missing.ctx,'leap',50,60);
  requireMotion(missing.counters.length===0&&missing.bodies.length===0&&missing.sprite.x===50&&missing.sprite.y===60&&missing.ctx.facing==='nw','missing-target snap-only facing');
  const lunge=actor();controller.onAbility.call(lunge.ctx,'lunge',10,20,200,300);
  requireMotion(lunge.ctx.snapNextPos&&lunge.counters.length===0&&lunge.bodies.join(',')==='lunge','Lunge waits for delivered position');
  controller.onPos.call(lunge.ctx,777,444,98765);
  requireMotion(lunge.transforms.length===0&&!lunge.ctx.snapNextPos&&lunge.sprite.x===777&&lunge.sprite.y===444&&lunge.ctx.state==='standing'&&lunge.bodies.at(-1)==='stand','delivered position snaps and stands without a landing timer');
  requireMotion(close(lunge.sprite.depth,actorDepth(444)),'Lunge landing depth');
  if(!owns)requireMotion(carried?.ownedCancellation===true&&carried.ordinaryPosition==='preserveBodyAndCounter'&&/^[0-9a-f]{40}$/.test(carried.sourceCommit??''),'missing carried cancellation contract');
  return {leap:{bodyState:'leap',durationMs,heightRatio,positionSnapDistance,easing:'linear',position:'castToEventTargetParabola',
    depth:'groundY',ordinaryPosition:'preserveBodyAndCounter',facing:'retainUnlessAimed',missingTarget:'snapOnly',ownedCancellation:true,
    cancellationSource:owns?'source':`carried:${carried.sourceCommit.slice(0,8)}`},
    lunge:{bodyState:'lunge',position:'nextDeliveredPositionSnap',landing:'standOnDelivery',
      facing:'retainUnlessAimed',missingTarget:'snapOnly'}};
}
