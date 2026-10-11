package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.PI

/** TroopFx's sprite transform is independent of its body clip. In particular, a new
 * non-travelling skill does not cancel travel, and locked pos deliveries keep only the last target. */
internal class HeroBodyMotion(
    actorEvents:List<Pair<Int,JsonValue>>,deliveries:Map<Int,PositionDelivery>,private val art:CombatArt,
    private val tickMs:Float,private val unitScale:Float,start:BattlePresentationStart,
) {
    data class Pose(val x:Float,val y:Float,val facing:String,val moving:Boolean)
    private data class Move(val from:Pose,val x:Float,val y:Float,val start:Float,val end:Float,val hero:Boolean) {
        fun at(ms:Float):Pose {
            val p=if(end<=start)1f else ((ms-start)/(end-start)).coerceIn(0f,1f)
            // Canonical TroopFx.onHeroTravel uses Phaser Sine.easeInOut. Ordinary pos stays Linear.
            val eased=if(hero)((1-cos(PI*p))/2).toFloat() else p
            return from.copy(x=from.x+(x-from.x)*eased,y=from.y+(y-from.y)*eased,moving=!hero && ms<end)
        }
    }
    private data class Pending(val x:Float,val y:Float,val duration:Float)
    private data class State(val fixed:Pose,val move:Move?=null,val lockUntil:Float=Float.NEGATIVE_INFINITY,
        val priority:Int=0,val pending:Pending?=null,val alive:Boolean=true) {
        fun at(ms:Float)=(move?.at(ms) ?: fixed).copy(facing=fixed.facing)
    }
    private data class Checkpoint(val ms:Float,val order:Int,val state:State,val prefix:Boolean=false)
    private data class Cue(val ms:Float,val order:Int,val event:JsonValue,val cold:Boolean=false,val resume:Boolean=false)
    private val checkpoints=mutableListOf<Checkpoint>()
    private val resumed=mutableMapOf<Int,Float>()
    private val beforeCue=mutableMapOf<Int,Pair<Float,Int>>()
    val boundaryMs=(start as? BattlePresentationStart.ColdPrefix)?.fromTick?.times(tickMs) ?: 0f
    val endMs:Float
    fun resumeStart(ordinal:Int):Float?=resumed[ordinal]
    private fun until(e:JsonValue):Float {
        val tick=e.getInt("t")
        if(e.getString("e")=="heroAttack")return e.getInt("recoveryUntil",tick)*tickMs
        val phase=e.getString("phase","impact")
        return if(phase in setOf("windup","fakeDeath") && e.getInt("until",tick)>tick)e.getInt("until")*tickMs
            else (tick+(art.heroBodyDefaultTicks[e.getString("skill")] ?: art.heroBodyDefaultTicks.getValue("default")))*tickMs
    }
    init {
        val cues=mutableListOf<Cue>();var activeSkill:Pair<Int,JsonValue>?=null;var activeAttack:Pair<Int,JsonValue>?=null
        for((order,e) in actorEvents) {
            val type=e.getString("e");val at=e.getInt("t")*tickMs
            if(at<boundaryMs) {
                when(type) {
                    "heroSkill"->activeSkill=if(until(e)>boundaryMs)order to e else null
                    "heroAttack"->if(until(e)>boundaryMs)activeAttack=order to e
                    "deploy","spawn","troopSpawn","pos","troopDeath"->cues+=Cue(boundaryMs,order,e,cold=true)
                }
            } else if(type in setOf("deploy","spawn","troopSpawn","pos","heroSkill","heroAttack","troopDeath")) {
                val delivery=deliveries[order]
                if(delivery?.skip!=true)cues+=Cue(delivery?.startTick?.times(tickMs) ?: at,order,e)
            }
        }
        // applyPlaybackStateRange restores an active attack first, then the latest active skill.
        for((order,e) in listOfNotNull(activeAttack,activeSkill))cues+=Cue(boundaryMs,order,e,resume=true)
        cues.sortWith(compareBy<Cue> { it.ms }.thenBy { if(it.cold)0 else if(it.resume)1 else 2 }
            .thenBy { if(it.resume && it.event.getString("e")=="heroAttack")Int.MIN_VALUE else it.order })
        var state:State?=null
        fun position(s:State,target:Pending,ms:Float):State {
            val visible=s.at(ms)
            // Canonical onPos stops a sub-pixel segment without snapping the sprite to its target.
            if(abs(target.x-visible.x)<1f && abs(target.y-visible.y)<1f)return s.copy(fixed=visible.copy(moving=false),move=null,pending=null)
            val dx=target.x-visible.x;val dy=target.y-visible.y
            // The legacy hero facade uses anim.facing's three rows plus horizontal flip.
            val facing=if(abs(dx)>=abs(dy)) { if(dx<0)"w" else "e" } else if(dy>0)"s" else "n"
            val from=visible.copy(facing=facing)
            return s.copy(fixed=from,move=Move(from,target.x,target.y,ms,ms+target.duration,false),pending=null)
        }
        fun finish(to:Float,inclusive:Boolean) {
            while(true) {
                val s=state ?: return
                val next=minOf(s.move?.end ?: Float.POSITIVE_INFINITY,
                    if(s.lockUntil.isFinite())s.lockUntil else Float.POSITIVE_INFINITY)
                if(!next.isFinite() || if(inclusive)next>to else next>=to)return
                var current=s
                if(s.move?.end==next)current=current.copy(fixed=s.at(next).copy(moving=false),move=null)
                if(s.lockUntil==next) {
                    current=current.copy(lockUntil=Float.NEGATIVE_INFINITY,priority=0,pending=null)
                    s.pending?.let { current=position(current,it,next) }
                }
                state=current;checkpoints+=Checkpoint(next,Int.MAX_VALUE,current)
            }
        }
        for((index,cue) in cues.withIndex()) {
            finish(cue.ms,false)
            beforeCue[cue.order]=cue.ms to checkpoints.size
            val e=cue.event;val ms=cue.ms;val type=e.getString("e");var s=state
            if(type in setOf("deploy","spawn","troopSpawn")) {
                if(s!=null)continue
                s=State(Pose(e.getFloat("x")*unitScale,e.getFloat("y")*unitScale,"s",false))
            } else if(s==null || !s.alive)continue
            else when(type) {
                "pos"->{
                    val target=Pending(e.getFloat("x")*unitScale,e.getFloat("y")*unitScale,deliveries[cue.order]?.durationMs ?: 0f)
                    s=if(cue.cold)s.copy(fixed=s.at(ms).copy(x=target.x,y=target.y,moving=false),move=null,pending=null)
                        else if(s.lockUntil>=ms)s.copy(pending=target) else position(s,target,ms)
                }
                "troopDeath"->s=s.copy(fixed=s.at(ms).copy(moving=false),move=null,alive=false,pending=null,priority=0,lockUntil=Float.NEGATIVE_INFINITY)
                "heroSkill","heroAttack"->{
                    val phase=e.getString("phase","impact")
                    val priority=if(type=="heroAttack")2 else if(phase in setOf("heads","revive","fakeDeath"))4 else 3
                    if(s.lockUntil<ms || s.priority<=priority) {
                        s=s.copy(lockUntil=maxOf(ms+1f,until(e)),priority=priority)
                        if(type=="heroAttack")s=s.copy(fixed=s.fixed.copy(facing=if(e.getFloat("ix")*unitScale<s.at(ms).x)"w" else "e"))
                        if(cue.resume)resumed[cue.order]=ms
                    }
                    // BattleScene dispatches travel even when a higher-priority body rejected this skill.
                    if(type=="heroSkill" && e.getString("skill") in setOf("crimsonDash","cannonball") && e.has("toX") && e.has("toY")) {
                        val from=s.at(ms)
                        s=s.copy(fixed=from,move=Move(from,e.getFloat("toX")*unitScale,e.getFloat("toY")*unitScale,
                            ms,maxOf(ms+1f,until(e)),true))
                    }
                }
            }
            state=s;checkpoints+=Checkpoint(ms,cue.order,s,cue.cold || cue.resume)
            if(cues.getOrNull(index+1)?.ms!=ms)finish(ms,true)
        }
        finish(Float.POSITIVE_INFINITY,true)
        endMs=checkpoints.lastOrNull()?.ms ?: 0f
        // Construction already follows time and source execution order. Cold state hydration,
        // attack restoration and then skill restoration deliberately do not follow source ordinals.
    }
    fun sample(ms:Float,beforeOrdinal:Int?=null):Pose? {
        var lo=0;var hi=checkpoints.size
        while(lo<hi) { val mid=(lo+hi) ushr 1
            if(checkpoints[mid].ms<=ms)lo=mid+1 else hi=mid }
        if(beforeOrdinal!=null) {
            val exact=beforeCue[beforeOrdinal]?.takeIf { it.first==ms }
            if(exact!=null)lo=minOf(lo,exact.second)
            else while(lo>0) {
                val c=checkpoints[lo-1]
                if(c.ms!=ms || c.prefix || c.order<beforeOrdinal)break
                lo--
            }
        }
        return checkpoints.getOrNull(lo-1)?.state?.at(ms)
    }
}
