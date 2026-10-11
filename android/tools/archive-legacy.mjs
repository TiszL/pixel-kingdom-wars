// Execute the current controller's old-log fallback. These probes describe body ownership only.
export function captureLegacyMelee(ts,troopText,profiles,{facing8Stable,actorDepth,BATTLE_BODY_PRESENTATION}) {
  const ast=ts.createSourceFile('troop.ts',troopText,ts.ScriptTarget.Latest,true);
  const owner=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V2TroopFx');
  const names=['alive','stand','playAttack','faceTarget','onPos','setMeleeDriven','tickAttack','onMeleeAttack','onHit'];
  const methods=names.map(name=>{
    const node=owner?.members.find(n=>n.name?.getText(ast)===name);
    if(!node)throw new Error(`Missing archived controller ${name}`);
    return node.getText(ast).replace(/^private\s+/,'');
  });
  // Current onHit delegates its persistent state to the canonical helper. Older
  // sources keep their original inline path; never replace a present helper with a stub.
  const syncHealth=owner?.members.find(n=>n.name?.getText(ast)==='syncHealth');
  if(syncHealth)methods.push(syncHealth.getText(ast).replace(/^private\s+/,''));
  let positionSnapDistance;
  const inspect=node=>{
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.LessThanToken&&
      node.left.getText(ast)==='Math.abs(dx)'&&ts.isNumericLiteral(node.right))positionSnapDistance=Number(node.right.text);
    ts.forEachChild(node,inspect);
  };
  inspect(owner.members.find(n=>n.name?.getText(ast)==='onPos'));
  if(!(positionSnapDistance>0))throw new Error('Missing source legacy position threshold');
  const Controller=new Function('facing8Stable','actorDepth','BATTLE_BODY_PRESENTATION',ts.transpile(
    `class ArchiveController {${methods.join('\n')}};return ArchiveController;`,{target:ts.ScriptTarget.ES2022}))(facing8Stable,actorDepth,BATTLE_BODY_PRESENTATION);
  function actor(unit,{driven=false,target=true,missing=false}={}) {
    const registrations=[];let done,transform,targetPoint=target?{x:100,y:0}:null;
    const sprite={x:0,y:0,setPosition(x,y){this.x=x;this.y=y;return this;},setDepth(){return this;}};
    const controller=Object.assign(new Controller(),{profile:profiles[unit],state:'idle',facing:'s',meleeDriven:driven,moving:false,
      moveGeneration:0,snapNextPos:false,damaged:false,sprite,nearest:()=>targetPoint,deps:{ticker:{unregister(){}}},
      clip:state=>missing&&profiles[unit].attack.includes(state)?undefined:{},
      playLoop(state){done=undefined;registrations.push({kind:'loop',state,facing:this.facing});},
      playOnce(state,complete){done=complete;registrations.push({kind:'once',state,facing:this.facing});},
      scene:{tweens:{killTweensOf(){transform=undefined;},add(value){transform=value;}}}});
    return {controller,registrations,step:()=>done?.(),target:value=>{targetPoint=value;},
      arrive(){if(transform){sprite.setPosition(transform.x,transform.y);const complete=transform.onComplete;transform=undefined;complete();}},
      snapshot:()=>({state:controller.state,moving:controller.moving,facing:controller.facing,body:registrations.at(-1),count:registrations.length})};
  }
  const eligible=Object.entries(profiles).filter(([,p])=>p.melee&&p.autoAttack!==false).map(([unit])=>unit);
  const cases=eligible.map(unit=>{
    const a=actor(unit);a.controller.stand();const first=a.snapshot();a.step();const repeat=a.snapshot();
    a.controller.onPos(100,100,1000);const moving=a.snapshot();a.arrive();const arrived=a.snapshot();
    a.target(null);a.step();const empty=a.snapshot();
    const armed=actor(unit,{driven:true});armed.controller.stand();
    const missing=actor(unit,{missing:true});missing.controller.stand();
    const zero=actor(unit);zero.controller.stand();zero.controller.onPos(0,0,100);const correction=zero.snapshot();
    const rotated=actor(unit);rotated.controller.stand();rotated.target({x:-100,y:0});rotated.controller.tickAttack();
    const rowRetained=rotated.snapshot();rotated.step();const nextRow=rotated.snapshot();
    const cued=actor(unit);cued.controller.stand();cued.controller.onMeleeAttack('building',100,0);cued.step();const afterCue=cued.snapshot();
    const hit=actor(unit);hit.controller.stand();hit.controller.onHit();const flinch=hit.snapshot();hit.step();const afterHit=hit.snapshot();
    const turnedHit=actor(unit);turnedHit.controller.stand();turnedHit.target({x:-100,y:0});turnedHit.controller.tickAttack();turnedHit.controller.onHit();
    const afterTurnHit=turnedHit.snapshot();
    const sameClockHit=actor(unit);sameClockHit.controller.stand();sameClockHit.target({x:-100,y:0});sameClockHit.controller.onHit();
    const beforeTurnHit=sameClockHit.snapshot();
    if(first.state!=='idle'||first.body.kind!=='once'||repeat.count!==2||moving.state!=='walking'||moving.body.kind!=='loop'||
      arrived.state!=='idle'||arrived.body.kind!=='once'||empty.body.state!==profiles[unit].stand||
      armed.snapshot().body.kind!=='loop'||missing.snapshot().body.kind!=='loop'||correction.count!==1||
      rowRetained.count!==1||rowRetained.body.facing===rowRetained.facing||nextRow.body.facing!==nextRow.facing||
      !cued.controller.meleeDriven||afterCue.body.kind!=='loop'||flinch.state!=='acting'||flinch.body.state!==profiles[unit].hit||afterHit.state!=='idle'||afterHit.body.kind!=='once'||
      afterTurnHit.body.facing!==nextRow.facing||beforeTurnHit.body.facing!==first.body.facing)
      throw new Error(`Unsupported legacy melee ownership: ${unit}`);
    return {unit,first,repeat,moving,arrived,empty,armed:armed.snapshot(),missing:missing.snapshot(),correction,rowRetained,nextRow,afterCue,flinch,afterHit,afterTurnHit,beforeTurnHit};
  });
  return {mode:'sourceIdleAttack',positionSnapDistance,cases};
}
