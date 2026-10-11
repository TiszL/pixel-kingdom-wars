package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue
import kotlin.math.floor
import kotlin.random.Random

/** Source on/off durations begin with ON. Android adds its leading zero-delay OFF segment. */
data class HapticPattern(val timings:List<Long>) {
    init { require(timings.isNotEmpty() && timings.size%2==1 && timings.all { it>0 }) }
}
data class EventHaptics(val patterns:Map<String,HapticPattern>,val mediumAt:Double,val heavyAt:Double,
                        val fixed:Map<String,String>,val deployment:String?=null) {
    fun strength(event:JsonValue):String? = if(event.getString("e")=="star") {
        val n=event.get("n")?.takeUnless { it.isNull }?.asDouble() ?: 0.0
        if(n>=heavyAt)"heavy" else if(n==mediumAt)"medium" else "light"
    } else fixed[event.getString("e")]
    companion object {
        fun parse(value:JsonValue?):EventHaptics?=value?.let { v->
            require(v.getString("overlap")=="replace" && v.getString("budget")=="none")
            val patterns=listOf("light","medium","heavy").associateWith { key->
                val times=v.get("patterns").get(key);require(times.isArray)
                HapticPattern(times.map { require(it.isNumber && it.asDouble()==it.asLong().toDouble());it.asLong() })
            }
            val star=v.get("star");val medium=star.getDouble("mediumAt");val heavy=star.getDouble("heavyAt")
            require(medium.isFinite() && heavy.isFinite() && medium>0 && heavy>medium)
            val fixed=listOf("rally","destroyed","trap").associateWith { v.get("fixed").getString(it) }
            require(fixed.values.all { it in patterns })
            val deployment=v.get("deployment")?.let { d->
                require(d.getString("matching")=="troopHeroTile"&&d.getString("echo")=="firstActor"&&d.getString("lifetime")=="scene")
                d.getString("haptic").also { require(it in patterns) }
            }
            EventHaptics(patterns,medium,heavy,fixed,deployment)
        }
    }
}

data class GiantLanding(val effects:List<HeroSensory>,val aim:HowlAimArt)
data class KegDetonation(val effects:List<HeroSensory>,val fallbackFrame:Int)

/** Optional source-derived policy. Historical packs keep their explicit sensory coverage gap. */
data class SensoryPolicy(val concurrentShakeCap:Int,val mediumHapticMs:Long,val eventHaptics:EventHaptics?=null,
                         val mortarLanding:List<HeroSensory>?=null,val giantLanding:GiantLanding?=null,
                         val kegDetonation:KegDetonation?=null) {
    fun pattern(strength:String):HapticPattern?=eventHaptics?.patterns?.get(strength)
        ?: if(strength=="medium")HapticPattern(listOf(mediumHapticMs)) else null
    companion object {
        fun parse(value:JsonValue?):SensoryPolicy?=value?.let { v->
            require(v.getInt("version")==1)
            val camera=v.get("camera")
            require(camera.getString("overlap")=="ignore" && camera.getString("offset")=="uniformViewportZoom" &&
                camera.getBoolean("roundPixels") && camera.getString("clock")=="frameDelta")
            fun landing(name:String)=v.get(name)?.let { m->
                require(m.getString("clock")=="sceneTimeScale"&&m.getString("owner")=="releasedFlight"&&
                    m.getBoolean("requiresTravel")&&!m.getBoolean("requiresImpact"))
                if(name=="giantLanding")require(m.getBoolean("requiresRichThrow"))
                m.get("effects").map(HeroSensory::parse).also { cues->
                    require(cues.size==2&&cues[0] is HeroSensory.Shake&&cues[1] is HeroSensory.Haptic)
                }
            }
            val giant=landing("giantLanding")?.let { effects->
                val aim=v.get("giantLanding").get("aim")
                GiantLanding(effects,HowlAimArt(aim.getFloat("minimumDeltaSquared"),aim.getFloat("retainWithinDegrees")))
            }
            val keg=v.get("kegDetonation")?.let { k->
                require(k.getString("clock")=="sceneTimeScale"&&k.getString("owner")=="detonateBody"&&
                    k.getString("unenteredCue")=="completion"&&k.getString("missingBody")=="immediate"&&k.getString("missingEffect")=="callback")
                val effects=k.get("effects").map(HeroSensory::parse)
                require(effects.size==2&&effects[0] is HeroSensory.Shake&&effects[1] is HeroSensory.Haptic)
                val frame=k.get("fallbackFrame");require(frame.isNumber&&frame.asDouble()==frame.asInt().toDouble()&&frame.asInt()>0)
                KegDetonation(effects,frame.asInt())
            }
            SensoryPolicy(v.getInt("concurrentShakeCap"),v.getLong("mediumHapticMs"),EventHaptics.parse(v.get("eventHaptics")),landing("mortarLanding"),giant,keg).also {
                require(it.concurrentShakeCap>0 && it.mediumHapticMs>0)
                require(it.eventHaptics?.patterns?.get("medium")?.timings?.let { times->times==listOf(it.mediumHapticMs) } != false)
            }
        }
    }
}
sealed interface HeroSensory {
    data class Shake(val durationMs:Float,val intensity:Float):HeroSensory
    data class Haptic(val strength:String):HeroSensory
    companion object {
        fun parse(value:JsonValue):HeroSensory=when(value.getString("kind")) {
            "shake"->Shake(value.getFloat("duration"),value.getFloat("intensity")).also {
                require(it.durationMs.isFinite() && it.durationMs>0 && it.intensity.isFinite() && it.intensity>=0)
            }
            "haptic"->Haptic(value.getString("strength")).also { require(it.strength=="medium") }
            else->error("Unsupported hero sensory cue")
        }
    }
}
/** A delayed landing belongs to both its admitted source start and authored release. */
data class SensoryFlight(val sourceTick:Float,val releaseTick:Float,val source:PresentationEvent)
/** A delayed body callback requires its original registration to have been presented. */
data class SensoryBody(val sourceTick:Float,val source:PresentationEvent)
data class DeployMarkerKey(val troop:String,val hero:String?,val tx:Int,val ty:Int)
data class DeployHaptic(val actorId:Int,val key:DeployMarkerKey,val source:PresentationEvent)
data class HeroSensoryCue(val ordinal:Int,val atTick:Float,val effects:List<HeroSensory>,val flight:SensoryFlight?=null,
                          val body:SensoryBody?=null,val deployment:DeployHaptic?=null) {
    constructor(ordinal:Int,atTick:Int,effects:List<HeroSensory>):this(ordinal,atTick.toFloat(),effects)
}
data class SensoryFrame(val epoch:Long,val sequence:Long,val haptics:List<HapticPattern>,val token:Long)
data class SensoryOffset(val x:Float=0f,val y:Float=0f)

/** GL-owned cursor and cosmetic camera effect. Control/identity/visibility changes discard
 * pending sensory work. Source camera duration uses frame delta, independently of replay rate. */
class BattleSensoryPlayback(private val deploymentHandled:(DeployHaptic)->Boolean={false},
                            private val random:()->Float={Random.nextFloat()}) {
    private var epoch=-1L
    private var control=-1L
    private var position:Float?=null
    private var wasPlaying=false
    private var elapsedMs=0f
    private var shake:HeroSensory.Shake?=null
    private val budgets=mutableListOf<Float>()
    private var next=0
    private var cues=emptyList<HeroSensoryCue>()
    private data class Ownership(val tick:Float,val cue:Int,val release:Boolean)
    private var ownership=emptyList<Ownership>()
    private var nextOwnership=0
    private val started=mutableSetOf<Int>()
    private val released=mutableSetOf<Int>()
    private var fresh=false
    private var continued=false
    var offset=SensoryOffset();private set
    fun replace(value:List<HeroSensoryCue>,freshStart:Boolean) {
        clear();cues=value.sortedWith(compareBy<HeroSensoryCue>{it.atTick}.thenBy{it.ordinal});fresh=freshStart
        ownership=cues.flatMapIndexed { i,cue->
            require(cue.flight==null||cue.body==null)
            cue.flight?.let { flight->
            require(flight.sourceTick.isFinite()&&flight.sourceTick>=0&&flight.releaseTick.isFinite()&&
                flight.releaseTick>=flight.sourceTick&&cue.atTick.isFinite()&&cue.atTick>flight.releaseTick)
            listOf(Ownership(flight.sourceTick,i,false),Ownership(flight.releaseTick,i,true))
        } ?: cue.body?.let { body->
            require(body.sourceTick.isFinite()&&body.sourceTick>=0&&cue.atTick.isFinite()&&cue.atTick>body.sourceTick)
            listOf(Ownership(body.sourceTick,i,false))
        } ?: emptyList() }.sortedWith(compareBy<Ownership>{it.tick}.thenBy{cues[it.cue].ordinal}.thenBy{it.release})
    }
    /** An unchanged live suffix replacement keeps only already-owned exact flights.
     * Equality through the last actual frame is deliberately stricter than actor-only history. */
    fun continueRevision(value:List<HeroSensoryCue>,previous:BattleScene,nextScene:BattleScene,nextTick:Float):Boolean {
        val through=position ?: return false
        if(!wasPlaying || !nextScene.playing || nextTick<through || previous.revision.raidId!=nextScene.revision.raidId ||
            previous.revision.simVersion!=nextScene.revision.simVersion || nextScene.revision.lastSequence<previous.revision.lastSequence ||
            previous.copy(revision=nextScene.revision,playheadTick=nextScene.playheadTick,retainPlaybackTick=nextScene.retainPlaybackTick)!=nextScene)
            return false
        val before=previous.revision.events;val after=nextScene.revision.events
        var i=0
        while(i<before.size&&before[i].t<=through) {
            if(after.getOrNull(i)!=before[i])return false
            i++
        }
        if(after.getOrNull(i)?.t?.let { it<=through }==true)return false
        val starts=started.mapTo(hashSetOf()) { cues[it] }
        val releases=released.mapTo(hashSetOf()) { cues[it] }
        replace(value,false)
        position=through;continued=true
        cues.forEachIndexed { index,cue->
            if(cue in starts)started+=index
            if(cue in releases)released+=index
        }
        return true
    }
    fun clear() { position=null;continued=false;next=0;nextOwnership=0;started.clear();released.clear();shake=null;elapsedMs=0f;budgets.clear();offset=SensoryOffset();fresh=false }
    fun interrupted() { val waiting=position==null && fresh;clear();fresh=waiting }
    fun advance(tick:Float,deltaMs:Float,rate:Float,playing:Boolean,admissionEpoch:Long,controlToken:Long,
                policy:SensoryPolicy?,width:Float,height:Float,zoom:Float,currentScene:Boolean=true):List<HapticPattern> {
        // A newer scene is decoding. The visible clock is already frozen; no old
        // token may emit, and only its eventual history proof may retain this flight.
        if(!currentScene) {offset=SensoryOffset();return emptyList()}
        require(tick.isFinite() && tick>=0 && deltaMs.isFinite() && deltaMs>=0 && rate.isFinite() && rate>0)
        val initial=position==null && fresh && tick==0f
        val reset=position==null || tick<requireNotNull(position) || epoch!=admissionEpoch || control!=controlToken || wasPlaying!=playing
        if(reset || admissionEpoch<0 || policy==null) {
            shake=null;elapsedMs=0f;budgets.clear();offset=SensoryOffset();next=0
            nextOwnership=0;started.clear();released.clear()
        }
        val allowed=admissionEpoch>=0 && playing && policy!=null && (!reset || initial)
        val haptics=mutableListOf<HapticPattern>()
        if(allowed) {
            for(i in budgets.indices)budgets[i]-=deltaMs*rate // source scene timer follows playback scale
            budgets.removeAll { it<=0 }
            shake?.let { elapsedMs+=deltaMs;if(elapsedMs>=it.durationMs) { shake=null;offset=SensoryOffset() } }
        }
        fun crossed(at:Float)=initial&&at==0f||position?.let { it<at }==true
        while(nextOwnership<ownership.size&&ownership[nextOwnership].tick<=tick) {
            val marker=ownership[nextOwnership++]
            if(!allowed||!crossed(marker.tick))continue
            if(!marker.release)started+=marker.cue
            else if(started.remove(marker.cue))released+=marker.cue
        }
        while(next<cues.size && cues[next].atTick<=tick) {
            val index=next++;val cue=cues[index]
            // Hydration consumes source markers silently too. The app scopes this
            // observation to the exact raid/account/pack and deduplicates actor IDs.
            val localEcho=cue.deployment?.let(deploymentHandled) ?: false
            val owned=when {cue.flight!=null->released.remove(index);cue.body!=null->started.remove(index);else->true}
            if(!allowed || !crossed(cue.atTick)||!owned || localEcho || continued&&cue.flight==null&&cue.body==null)continue
            for(effect in cue.effects)when(effect) {
                is HeroSensory.Haptic->requireNotNull(policy).pattern(effect.strength)?.let { haptics+=it }
                is HeroSensory.Shake->if(budgets.size<requireNotNull(policy).concurrentShakeCap) {
                    budgets+=effect.durationMs
                    // Phaser camera.shake(force=false) leaves the already-running effect alone.
                    if(shake==null) {shake=effect;elapsedMs=0f}
                }
            }
        }
        if(allowed)shake?.let {
            // JS Math.round ties toward +infinity. Pixel projection only; input camera stays fixed.
            offset=SensoryOffset(floor(((random()*2-1)*it.intensity*width*zoom)+.5f),
                floor(((random()*2-1)*it.intensity*height*zoom)+.5f))
        }
        position=tick;epoch=admissionEpoch;control=controlToken;wasPlaying=playing;fresh=false;continued=false
        return haptics
    }
}
