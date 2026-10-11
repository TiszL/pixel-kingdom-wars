package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue
import kotlin.math.abs

data class BurrowBodyAction(val owner:Int,val eventOrdinal:Int,val state:String,val startMs:Float,val endMs:Float,
    val phaseStartMs:Float,val facing:String,val looping:Boolean,val completion:String,val automatic:Boolean=false)
data class BurrowMotionPose(val x:Float,val y:Float,val facing:String,val clipState:String,val phaseStartMs:Float,
    val bodyOwner:Int,val alive:Boolean,val moving:Boolean,val looping:Boolean,val controllerFacing:String=facing)

/** Full-reset reconstruction. It deliberately does not retain removed predictions across warm revisions.
 * The ordinary transform and controller moving flag are separate: coordinate emerge kills only the former. */
class BurrowMotionTimeline(
    events:List<PresentationEvent>,actorEvents:List<Pair<Int,JsonValue>>,deliveries:Map<Int,PositionDelivery>,
    private val art:CombatArt,private val tickDurationMs:Float,private val unitScale:Float,
    start:BattlePresentationStart=BattlePresentationStart.Continuous,
    private val nearestStandTarget:((Float,Int,Float,Float)->Pair<Float,Float>?)?=null,
    idleFacingEvents:List<Pair<Int,JsonValue>> = emptyList(),
    private val legacyAutomatic:Boolean=false,
) {
    private val contract=requireNotNull(art.burrowMotion)
    private data class Point(val x:Float,val y:Float)
    private data class Move(val start:Float,val end:Float,val from:Point,val to:Point) {
        fun at(ms:Float):Point { val p=if(end==start)1f else ((ms-start)/(end-start)).coerceIn(0f,1f)
            return Point(from.x+(to.x-from.x)*p,from.y+(to.y-from.y)*p) }
    }
    private data class State(val fixed:Point,val body:BurrowBodyAction,val state:String,val move:Move?=null,
        val moving:Boolean=false,val alive:Boolean=true) { fun point(ms:Float)=move?.at(ms) ?: fixed }
    private data class Checkpoint(val ms:Float,val ordinal:Int,val state:State)
    private data class Cue(val ms:Float,val ordinal:Int,val event:JsonValue,val cold:Boolean=false)
    private val checkpoints=mutableListOf<Checkpoint>()
    private val idleFacing=IdleFacingHistory()
    val bodyActions:List<BurrowBodyAction>
    val startMs:Float=if(start is BattlePresentationStart.ColdPrefix) start.fromTick*tickDurationMs else 0f
    val motionEndMs:Float get()=checkpoints.lastOrNull()?.ms ?: startMs
    init {
        require(tickDurationMs.isFinite() && tickDurationMs>0 && unitScale.isFinite() && unitScale>0)
        val coldTick=(start as? BattlePresentationStart.ColdPrefix)?.fromTick ?: 0f
        require(coldTick>=0)
        val runTicks=mutableSetOf<Int>();val cues=mutableListOf<Cue>()
        (actorEvents+idleFacingEvents).forEach { (ordinal,e)->
            require(e.getInt("t")==events[ordinal].t && e.getString("e")==events[ordinal].e)
            val tick=e.getInt("t");val type=e.getString("e")
            if(type=="attackRun") {
                val count=e.getInt("count");val cadence=e.getInt("cadenceTicks")
                require(count>0 && cadence>0 && count.toLong()*cadence <= (events.lastOrNull()?.t ?: 0).toLong()+cadence)
                repeat(count) { i->val t=Math.addExact(tick,Math.multiplyExact(i,cadence))
                    if(t>=coldTick) { runTicks+=t;cues+=Cue(t*tickDurationMs,ordinal,e) } }
            } else if(tick<coldTick) {
                if(type in setOf("deploy","spawn","troopSpawn","pos","burrow","emerge","troopDeath","destroyed"))
                    cues+=Cue(startMs,ordinal,e,true)
            } else if(type!="pos" || deliveries[ordinal]?.skip==false) {
                cues+=Cue((deliveries[ordinal]?.startTick ?: tick.toFloat())*tickDurationMs,ordinal,e)
            }
        }
        cues.removeAll { !it.cold && it.event.getString("e") in setOf("troopAttack","troopFire") && it.event.getInt("t") in runTicks }
        cues.sortWith(compareBy<Cue> { it.ms }.thenBy { !it.cold }.thenBy { it.ordinal })
        val actions=mutableListOf<BurrowBodyAction>();var current:State?=null;var automatic=legacyAutomatic
        fun controllerFacing(s:State,ms:Float)=idleFacing.before(s.body.owner,ms,s.body.facing)
        fun body(state:String,ms:Float,ordinal:Int,facing:String,loop:Boolean,completion:String,force:Boolean=false,automatic:Boolean=false):BurrowBodyAction {
            val clip=requireNotNull(art.clips[state]);val old=current?.body
            if(!force && old!=null && old.state==state && (old.looping || ms<=old.endMs) && old.facing==facing)return old
            if(old!=null)actions[old.owner]=old.copy(endMs=minOf(old.endMs,ms))
            val preserve=!force && old?.state==state && (old.looping || ms<=old.endMs)
            val phase=if(preserve)old!!.phaseStartMs else ms
            return BurrowBodyAction(actions.size,ordinal,state,ms,if(loop)Float.POSITIVE_INFINITY else phase+clip.durationMs,
                phase,facing,loop,completion,automatic).also { actions+=it }
        }
        fun stand(s:State,ms:Float,ordinal:Int):State {
            val p=s.point(ms);val target=if(s.moving)null else nearestStandTarget?.invoke(ms,ordinal,p.x,p.y)
            val retained=controllerFacing(s,ms)
            val facing=target?.let { contract.aim.facing(it.first-p.x,it.second-p.y,retained) } ?: retained
            val auto=automatic && !s.moving && target!=null && ms<(events.lastOrNull()?.t ?: 0)*tickDurationMs
            val attacks=if(auto)art.profile.get("attack").map { it.asString() } else emptyList()
            require(!auto || attacks.size==1) { "Legacy burrow needs source-authored attack sequencing" }
            return s.copy(state=if(s.moving)"walking" else "idle",body=body(
                if(s.moving)art.profile.getString("battleMove",null) ?: art.profile.getString("move") else if(auto)attacks.single() else art.profile.getString("stand"),
                ms,ordinal,facing,!auto,if(auto)"stand" else "none",force=auto,automatic=auto))
        }
        fun finish(until:Float,inclusive:Boolean) {
            while(true) {
                val s=current ?: return
                val end=minOf(s.move?.end ?: Float.POSITIVE_INFINITY,if(s.alive && !s.body.looping)s.body.endMs else Float.POSITIVE_INFINITY)
                if(!end.isFinite() || if(inclusive)end>until else end>=until)return
                var next=s
                if(s.move?.end==end)next=next.copy(fixed=s.move.to,move=null,moving=false)
                current=next
                if(s.body.endMs==end) {
                    next=when(s.body.completion) {
                        "enter"->if(s.state=="burrowing")next.copy(state="burrowed",body=body(contract.tunnelState,end,Int.MAX_VALUE,s.body.facing,true,"none")) else next
                        "surface"->if(s.state=="emerging")stand(next,end,Int.MAX_VALUE) else next
                        "stand"->stand(next,end,Int.MAX_VALUE)
                        else->next
                    }
                } else if(s.move?.end==end && s.state=="walking")next=stand(next,end,Int.MAX_VALUE)
                current=next;checkpoints+=Checkpoint(end,Int.MAX_VALUE,next)
            }
        }
        var prefixFinished=coldTick==0f
        var prefixLastOrdinal=Int.MIN_VALUE
        for((cueIndex,cue) in cues.withIndex()) {
            if(!cue.cold && !prefixFinished) {
                current?.takeIf { it.alive && it.state!="burrowed" }?.let {
                    current=it.copy(moving=false,move=null);current=stand(current!!,startMs,Int.MIN_VALUE)
                    checkpoints+=Checkpoint(startMs,prefixLastOrdinal,current!!)
                }
                prefixFinished=true
            }
            finish(cue.ms,false)
            val e=cue.event;val type=e.getString("e");val ms=cue.ms;val ordinal=cue.ordinal
            fun point()=Point(e.getFloat("x")*unitScale,e.getFloat("y")*unitScale)
            var s=current
            if(type in setOf("deploy","spawn","troopSpawn")) {
                if(s!=null)continue
                val spawn=art.profile.getString("spawn",null)?.takeIf { !cue.cold && it in art.clips }
                s=State(point(),body(spawn ?: art.profile.getString("stand"),ms,ordinal,"s",spawn==null,"stand"),if(spawn==null)"idle" else "spawning")
            } else if(s==null || !s.alive)continue
            else when(type) {
                "pos"->{
                    val target=point();val visible=s.point(ms)
                    s=s.copy(fixed=visible,move=null)
                    if(cue.cold || (abs(target.x-visible.x)<contract.positionSnapDistance && abs(target.y-visible.y)<contract.positionSnapDistance)) {
                        s=s.copy(fixed=target,moving=false);current=s
                        if(s.state=="walking")s=stand(s,ms,ordinal)
                    } else {
                        val keepVerb=s.state !in setOf("idle","walking")
                        val retained=controllerFacing(s,ms)
                        val direction=if(keepVerb)retained else contract.aim.facing(target.x-visible.x,target.y-visible.y,retained)
                        s=s.copy(move=Move(ms,ms+requireNotNull(deliveries[ordinal]).durationMs,visible,target),moving=true);current=s
                        if(s.state=="burrowed")s=s.copy(body=body(contract.tunnelState,ms,ordinal,direction,true,"none"))
                        else if(!keepVerb)s=s.copy(state="walking",body=body(art.profile.getString("battleMove",null) ?: art.profile.getString("move"),ms,ordinal,direction,true,"none"))
                    }
                }
                "burrow"->{
                    if(cue.cold)s=s.copy(fixed=s.point(ms),move=null,moving=false,state="burrowed",body=body(contract.tunnelState,ms,ordinal,controllerFacing(s,ms),true,"none"))
                    else s=s.copy(state="burrowing",body=body(contract.enterState,ms,ordinal,controllerFacing(s,ms),false,"enter"))
                }
                "emerge"->{
                    if(e.has("x") && e.has("y"))s=s.copy(fixed=point(),move=null,moving=if(cue.cold)false else s.moving)
                    current=s
                    s=if(cue.cold)stand(s,ms,ordinal) else s.copy(state="emerging",body=body(contract.surfaceState,ms,ordinal,controllerFacing(s,ms),false,"surface"))
                }
                "troopDeath"->{
                    s=s.copy(fixed=s.point(ms),move=null,alive=false,moving=false,state="dying",
                        body=body(art.profile.getString("death"),if(cue.cold)e.getInt("t")*tickDurationMs else ms,ordinal,controllerFacing(s,ms),false,"none",true))
                }
                "troopAttack","troopFire","attackRun"->{
                    val technique=e.getString("technique","")
                    val kind=e.getString("targetKind",if(e.get("target")?.isNumber==true)"troop" else "building")
                    val state=art.profile.get("melee")?.getString(kind,null)
                    if(state!=null && state in art.clips && technique !in setOf("rend","howl","leap","lunge","firestorm","maul")) {
                        automatic=false
                        val p=s.point(ms);val facing=contract.aim.facing(e.getFloat("ix")*unitScale-p.x,e.getFloat("iy")*unitScale-p.y,controllerFacing(s,ms))
                        s=s.copy(state="melee",body=body(state,ms,ordinal,facing,false,"stand",true))
                    }
                }
                "hit"->{
                    val hit=art.profile.getString("hit",null)
                    if(s.state=="idle" && hit!=null && hit in art.clips)s=s.copy(state="acting",body=body(hit,ms,ordinal,controllerFacing(s,ms),false,"stand"))
                }
            }
            current=s;checkpoints+=Checkpoint(ms,ordinal,s)
            if(cue.cold)prefixLastOrdinal=ordinal
            if(cues.getOrNull(cueIndex+1)?.ms!=ms) {
                // Clock commands precede body/idle updates. A same-time burrow or
                // hit must preserve the old heading before idle targeting runs.
                finish(ms,true)
                current?.takeIf { it.alive && it.state=="idle" }?.let { idle->
                    if(legacyAutomatic) {
                        val p=idle.point(ms);val target=nearestStandTarget?.invoke(ms,Int.MAX_VALUE,p.x,p.y)
                        val direction=target?.let { contract.aim.facing(it.first-p.x,it.second-p.y,controllerFacing(idle,ms)) } ?: controllerFacing(idle,ms)
                        idleFacing.record(idle.body.owner,ms,direction)
                    }
                    if(!automatic) {
                        current=stand(idle,ms,Int.MAX_VALUE)
                        checkpoints+=Checkpoint(ms,Int.MAX_VALUE,current!!)
                    }
                }
            }
        }
        if(!prefixFinished)current?.takeIf { it.alive && it.state!="burrowed" }?.let {
            current=it.copy(moving=false,move=null);current=stand(current!!,startMs,Int.MAX_VALUE)
            checkpoints+=Checkpoint(startMs,Int.MAX_VALUE,current!!)
        }
        finish(if(legacyAutomatic)maxOf((events.lastOrNull()?.t ?: 0)*tickDurationMs,
            current?.body?.takeUnless { it.automatic }?.endMs?.takeIf { it.isFinite() } ?: 0f) else Float.POSITIVE_INFINITY,true)
        bodyActions=actions.toList()
        checkpoints.sortWith(compareBy<Checkpoint> { it.ms }.thenBy { it.ordinal })
    }
    fun sampleMs(ms:Float,beforeEventOrdinal:Int?=null):BurrowMotionPose? {
        require(ms.isFinite() && ms>=0)
        var lo=0;var hi=checkpoints.size
        while(lo<hi) { val mid=(lo+hi) ushr 1;val c=checkpoints[mid]
            if(c.ms<ms || (c.ms==ms && (beforeEventOrdinal==null || c.ordinal<beforeEventOrdinal)))lo=mid+1 else hi=mid }
        val s=checkpoints.getOrNull(lo-1)?.state ?: return null;val p=s.point(ms);val b=s.body
        return BurrowMotionPose(p.x,p.y,b.facing,b.state,b.phaseStartMs,b.owner,s.alive,s.moving,b.looping,idleFacing.before(b.owner,ms,b.facing))
    }
    fun sample(tick:Float,beforeEventOrdinal:Int?=null)=sampleMs(tick*tickDurationMs,beforeEventOrdinal)
}
