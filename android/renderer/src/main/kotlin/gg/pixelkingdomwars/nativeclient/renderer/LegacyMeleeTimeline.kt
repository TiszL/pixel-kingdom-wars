package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue
import kotlin.math.abs

data class LegacyMeleeVerb(val startMs:Float,val endMs:Float,val facing:String)
data class LegacyMeleeBody(val owner:Int,val state:String,val startMs:Float,val endMs:Float,
    val phaseStartMs:Float,val facing:String,val automatic:Boolean,val looping:Boolean)
data class LegacyMeleePose(val x:Float,val y:Float,val body:LegacyMeleeBody,val alive:Boolean,val controllerFacing:String=body.facing)

/** Old logs omit ordinary melee cues. These are presentation-only idle clips, interruptible by movement.
 * Stored explicit verbs keep their existing owner; no attacks, hits, projectiles or orders are invented. */
class LegacyMeleeTimeline(actorEvents:List<Pair<Int,JsonValue>>,deliveries:Map<Int,PositionDelivery>,
    private val art:CombatArt,private val tickMs:Float,private val unitScale:Float,
    private val policy:ArchivedMeleePolicy,verbs:List<LegacyMeleeVerb>,terminalMs:Float,
    idleFacingEvents:List<Pair<Int,JsonValue>> = emptyList(),
    private val nearest:((Float,Int,Float,Float)->Pair<Float,Float>?),
) {
    private data class Point(val x:Float,val y:Float)
    private data class Move(val start:Float,val end:Float,val from:Point,val to:Point) {
        fun point(ms:Float):Point { val p=if(end==start)1f else ((ms-start)/(end-start)).coerceIn(0f,1f)
            return Point(from.x+(to.x-from.x)*p,from.y+(to.y-from.y)*p) }
    }
    private data class State(val fixed:Point,val body:LegacyMeleeBody,val mode:String,
        val move:Move?=null,val alive:Boolean=true) { fun point(ms:Float)=move?.point(ms) ?: fixed }
    private data class Checkpoint(val ms:Float,val ordinal:Int,val state:State)
    private data class Cue(val ms:Float,val ordinal:Int,val event:JsonValue?=null,val verb:LegacyMeleeVerb?=null)
    private val checkpoints=mutableListOf<Checkpoint>()
    private val idleFacing=IdleFacingHistory()
    val bodies:List<LegacyMeleeBody>
    init {
        require(tickMs.isFinite()&&tickMs>0&&unitScale.isFinite()&&unitScale>0&&terminalMs.isFinite()&&terminalMs>=0)
        val cues=(actorEvents+idleFacingEvents).mapNotNull { (ordinal,e)->
            if(e.getString("e") !in setOf("deploy","spawn","troopSpawn","pos","troopDeath","troopAttack","hit","destroyed"))return@mapNotNull null
            val delivery=deliveries[ordinal]
            if(e.getString("e")=="pos" && (delivery==null || delivery.skip))return@mapNotNull null
            Cue((delivery?.startTick ?: e.getInt("t").toFloat())*tickMs,ordinal,e)
        }.toMutableList()
        verbs.forEach { cues+=Cue(it.startMs,Int.MAX_VALUE-1,verb=it) }
        cues.sortWith(compareBy<Cue> { it.ms }.thenBy { it.ordinal })
        val actions=mutableListOf<LegacyMeleeBody>();var current:State?=null;var meleeDriven=false
        val attack=art.profile.get("attack").map { it.asString() }
        fun facing(s:State,ms:Float)=idleFacing.before(s.body.owner,ms,s.body.facing)
        require(attack.isNotEmpty() && attack.all { art.clips[it]?.durationMs?.let { n->n>0&&n.isFinite() }==true })
        fun body(state:String,ms:Float,facing:String,loop:Boolean,automatic:Boolean=false,end:Float?=null):LegacyMeleeBody {
            val clip=art.clips.getValue(state);val old=current?.body
            if(old!=null)actions[old.owner]=old.copy(endMs=minOf(old.endMs,ms))
            val phase=if(loop && old?.looping==true && old.state==state)old.phaseStartMs else ms
            return LegacyMeleeBody(actions.size,state,ms,end ?: if(loop)Float.POSITIVE_INFINITY else ms+clip.durationMs,
                phase,facing,automatic,loop).also { actions+=it }
        }
        fun stand(s:State,ms:Float,ordinal:Int):State {
            val p=s.point(ms);val target=if(s.move==null)nearest(ms,ordinal,p.x,p.y) else null
            val retained=facing(s,ms)
            val direction=target?.let { policy.aim.facing(it.first-p.x,it.second-p.y,retained) } ?: retained
            val auto=!meleeDriven && s.move==null && target!=null && ms<terminalMs
            return s.copy(mode=if(s.move!=null)"walking" else "idle",body=body(
                if(s.move!=null)art.profile.getString("battleMove",art.profile.getString("move")) else if(auto)attack.first() else art.profile.getString("stand"),
                ms,direction,!auto,auto))
        }
        fun finish(until:Float,inclusive:Boolean) {
            while(true) {
                val s=current ?: return
                val end=minOf(s.move?.end ?: Float.POSITIVE_INFINITY,if(s.alive&&!s.body.looping)s.body.endMs else Float.POSITIVE_INFINITY)
                if(!end.isFinite() || if(inclusive)end>until else end>=until)return
                var next=s
                if(s.move?.end==end)next=next.copy(fixed=s.move.to,move=null)
                current=next
                if(s.body.endMs==end) {
                    val index=if(s.body.automatic)attack.indexOf(s.body.state)+1 else attack.size
                    next=if(s.body.automatic && index<attack.size)next.copy(body=body(attack[index],end,facing(s,end),false,true))
                    else stand(next,end,Int.MAX_VALUE)
                } else if(s.move?.end==end && s.mode=="walking")next=stand(next,end,Int.MAX_VALUE)
                current=next;checkpoints+=Checkpoint(end,Int.MAX_VALUE,next)
            }
        }
        for((cueIndex,cue) in cues.withIndex()) {
            finish(cue.ms,false);var s=current;val ms=cue.ms;val e=cue.event
            if(e?.getString("e") in setOf("deploy","spawn","troopSpawn")) {
                if(s!=null)continue
                val spawn=art.profile.getString("spawn",null)?.takeIf { it in art.clips }
                s=State(Point(e!!.getFloat("x")*unitScale,e.getFloat("y")*unitScale),
                    body(spawn ?: art.profile.getString("stand"),ms,"s",spawn==null),if(spawn==null)"idle" else "spawning")
            } else if(s==null || !s.alive)continue
            else if(cue.verb!=null) {
                // Existing explicit actionSprite owns these frames; this body is only a completion clock.
                s=s.copy(mode="acting",body=body(art.profile.getString("stand"),ms,cue.verb.facing,false,end=cue.verb.endMs))
            } else when(e!!.getString("e")) {
                "pos"->{
                    val p=s.point(ms);val to=Point(e.getFloat("x")*unitScale,e.getFloat("y")*unitScale)
                    s=s.copy(fixed=p,move=null);current=s
                    if(abs(to.x-p.x)<policy.positionSnapDistance && abs(to.y-p.y)<policy.positionSnapDistance) {
                        s=s.copy(fixed=to)
                        if(s.mode=="walking")s=stand(s,ms,cue.ordinal)
                    } else {
                        val idle=s.mode in setOf("idle","walking")
                        val retained=facing(s,ms)
                        val direction=if(idle)policy.aim.facing(to.x-p.x,to.y-p.y,retained) else retained
                        s=s.copy(move=Move(ms,ms+deliveries.getValue(cue.ordinal).durationMs,p,to));current=s
                        if(idle)s=s.copy(mode="walking",body=body(art.profile.getString("battleMove",art.profile.getString("move")),ms,direction,true))
                    }
                }
                "troopDeath"->{s=s.copy(fixed=s.point(ms),move=null,alive=false,mode="dying",body=body(art.profile.getString("death"),ms,facing(s,ms),false))}
                "troopAttack"->meleeDriven=true
                "hit"->{val hit=art.profile.getString("hit",null)
                    if(s.mode=="idle" && hit!=null && hit in art.clips)s=s.copy(mode="acting",body=body(hit,ms,facing(s,ms),false))}
            }
            current=s;checkpoints+=Checkpoint(ms,cue.ordinal,s)
            if(cues.getOrNull(cueIndex+1)?.ms!=ms) {
                finish(ms,true)
                current?.takeIf { it.alive && it.mode=="idle" }?.let { idle->
                    val p=idle.point(ms);val target=nearest(ms,Int.MAX_VALUE,p.x,p.y)
                    val direction=target?.let { policy.aim.facing(it.first-p.x,it.second-p.y,facing(idle,ms)) } ?: facing(idle,ms)
                    idleFacing.record(idle.body.owner,ms,direction)
                    if(meleeDriven && idle.body.looping && direction!=idle.body.facing) {
                        current=idle.copy(body=body(idle.body.state,ms,direction,true));checkpoints+=Checkpoint(ms,Int.MAX_VALUE,current!!)
                    }
                }
            }
        }
        // Automatic repeats stop at the saved terminal time, so idle art never makes an infinite schedule.
        finish(maxOf(terminalMs,verbs.maxOfOrNull { it.endMs } ?: terminalMs),true)
        bodies=actions.toList()
    }
    fun sample(ms:Float,beforeOrdinal:Int?=null):LegacyMeleePose? {
        var low=0;var high=checkpoints.size
        while(low<high) { val mid=(low+high) ushr 1;val c=checkpoints[mid]
            if(c.ms<ms || (c.ms==ms && (beforeOrdinal==null || c.ordinal<beforeOrdinal)))low=mid+1 else high=mid }
        val s=checkpoints.getOrNull(low-1)?.state ?: return null;val p=s.point(ms)
        return LegacyMeleePose(p.x,p.y,s.body,s.alive,idleFacing.before(s.body.owner,ms,s.body.facing))
    }
}
