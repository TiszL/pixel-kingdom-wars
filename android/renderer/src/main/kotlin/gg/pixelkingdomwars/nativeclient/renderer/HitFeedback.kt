package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue

/** Presentation-only source policy. Missing metadata leaves historical packs unchanged. */
data class HitFeedbackPolicy(val flashMs:Float,val star:AuthoredClip,val starFrameTimes:List<Float>,
    val starMs:Float,val depth:Float,val actorHeightFactor:Float,val buildingHeightFactor:Float,
    val buildingLiftMax:Float,val staticHeights:Map<String,Float>) {
    companion object {
        fun parse(value:JsonValue?):HitFeedbackPolicy?=value?.let { v->
            require(v.getInt("version")==1)
            val flash=v.get("flash");require(flash.getString("mode")=="fill" && flash.getInt("color")==0xffffff)
            val s=v.get("star");val frames=s.get("frames").toList()
            require(frames.isNotEmpty())
            val times=frames.map { it.getFloat("atMs") }
            require(times.first()==0f && times.zipWithNext().all { (a,b)->a<b })
            val clip=AuthoredClip("canonical-hit",s.getString("atlasPath"),listOf(frames.map { it.getString("key") }),
                listOf("s"),0f,s.get("anchor").getFloat(0),s.get("anchor").getFloat(1),s.getFloat("scale"),
                frames.first().getFloat("width"),frames.first().getFloat("height"),false,null,emptyMap())
            require(frames.all { it.getFloat("width")==clip.cellWidth && it.getFloat("height")==clip.cellHeight })
            HitFeedbackPolicy(flash.getFloat("durationMs"),clip,times,s.getFloat("durationMs"),s.getFloat("depth"),
                v.getFloat("actorHeightFactor"),v.getFloat("buildingHeightFactor"),v.getFloat("buildingLiftMax"),
                v.get("staticHeights")?.associate { it.name to it.asFloat() } ?: emptyMap()).also { p->
                require(listOf(p.flashMs,p.starMs,p.actorHeightFactor,p.buildingHeightFactor,p.buildingLiftMax,
                    clip.scale,clip.cellWidth,clip.cellHeight).all { it.isFinite() && it>0 })
                require(p.depth.isFinite() && p.starFrameTimes.all { it.isFinite() && it<p.starMs })
                require(p.staticHeights.values.all { it.isFinite() && it>0 })
            }
        }
    }
}
sealed interface HitTarget {
    data class Actor(val id:Int):HitTarget
    data class Building(val id:String):HitTarget
}
data class ServiceHitAnchor(val buildingId:String,val state:ServiceCombatState?)
data class HitFeedbackCue(val target:HitTarget,val tick:Int,val ordinal:Int,val x:Float,val y:Float,
    /** Service y is the south edge until current pixel admission binds its height. */
    val service:ServiceHitAnchor?=null)

/** Canonical 427381a2 spawns a service body whose family art is not resident as a hidden, frameless sprite on its
 * unloaded atlas key; Phaser 4.1.0 resolves that to __MISSING (Config images.missing, 32×32) at seat scale 1, and the
 * hit star lifts by half its displayHeight. Source-bound PNG dimensions are tested (hidden-service-body.json). */
internal const val HIDDEN_SERVICE_BODY_HEIGHT = 32f

/** GL-owned emission positions, separate from the immutable random-access plan. */
internal class ServiceHitCursor {
    private data class Bound(val cue:HitFeedbackCue,val y:Float)
    private val positions=mutableMapOf<Int,Bound>()
    private var request:Any?=null
    /** Refresh keeps the same request owner; external scenes cannot inherit emitted anchors. */
    fun adopt(next:Any?):Boolean {
        val continuing=next!=null && request===next
        if(!continuing)clear()
        request=next
        return continuing
    }
    fun clear() = positions.clear()
    fun retainVisible(tick:Float,fromTick:Float,tickMs:Float,lifetimeMs:Float) {
        positions.entries.removeAll { (_,value)->value.cue.tick<fromTick || (tick-value.cue.tick)*tickMs>=lifetimeMs }
    }
    fun y(cue:HitFeedbackCue,policy:HitFeedbackPolicy,height:(ServiceHitAnchor)->Float):Float {
        val anchor=requireNotNull(cue.service)
        positions[cue.ordinal]?.takeIf { it.cue==cue }?.let { return it.y }
        val body=height(anchor);require(body.isFinite() && body>0)
        val y=cue.y-minOf(body*policy.buildingHeightFactor,policy.buildingLiftMax)
        positions[cue.ordinal]=Bound(cue,y)
        return y
    }
}

/** Exact event-origin sparks persist independently after a victim dies or moves. Flash timers
 * are not debounced: the source's earlier clear callback can end a newer overlapping flash. */
class HitFeedbackPlan(val policy:HitFeedbackPolicy,val cues:List<HitFeedbackCue>,private val tickMs:Float) {
    private val byTarget=cues.groupBy { it.target }
    fun flashing(target:HitTarget,tick:Float,fromTick:Float):Boolean {
        val records=byTarget[target] ?: return false
        val index=lastAt(records,tick);val latest=records.getOrNull(index) ?: return false
        if(latest.tick<fromTick)return false
        val now=tick*tickMs;val start=latest.tick*tickMs
        if(now>=start+policy.flashMs)return false
        for(i in index-1 downTo 0) {
            val previous=records[i];val clearAt=previous.tick*tickMs+policy.flashMs
            if(previous.tick<fromTick || clearAt<start)break
            if(clearAt<=now)return false
        }
        return true
    }
    fun sprites(tick:Float,fromTick:Float,output:MutableList<CombatSprite>,serviceY:((HitFeedbackCue)->Float)?=null) {
        // Work is bounded to the visible lifetime, not the complete accepted replay.
        for(index in lastAt(cues,tick-policy.starMs/tickMs).coerceAtLeast(0) until cues.size) {
            val cue=cues[index];if(cue.tick>tick)break
            val elapsed=tick*tickMs-cue.tick*tickMs
            if(cue.tick<fromTick || elapsed<0 || elapsed>=policy.starMs)continue
            val frame=policy.starFrameTimes.indexOfLast { it<=elapsed }
            val y=if(cue.service==null)cue.y else serviceY?.invoke(cue) ?: continue
            output+=CombatSprite(policy.star,policy.star.frames.single()[frame],cue.x,y,policy.depth,serviceHit=cue.takeIf { it.service!=null })
        }
    }
    private fun lastAt(values:List<HitFeedbackCue>,tick:Float):Int {
        var low=0;var high=values.size
        while(low<high) { val mid=(low+high) ushr 1;if(values[mid].tick<=tick)low=mid+1 else high=mid }
        return low-1
    }
    val endTick:Float get()=cues.maxOfOrNull { it.tick+policy.starMs/tickMs } ?: 0f
}
