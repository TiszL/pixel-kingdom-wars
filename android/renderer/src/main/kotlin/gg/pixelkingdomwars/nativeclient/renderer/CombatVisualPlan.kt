package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import kotlin.math.ceil
import kotlin.math.abs
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.roundToInt

/** Authored presentation metadata. None of these fields determine damage or legal orders. */
data class AuthoredClip(val key: String, val atlasPath: String, val frames: List<List<String>>,
    val rowOrder: List<String>, val fps: Float, val anchorX: Float, val anchorY: Float,
    val scale: Float, val cellWidth: Float, val cellHeight: Float, val loop: Boolean,
    val emitters: JsonValue?, val fxCues: Map<String, List<Int>>,
    val effectByCue: Map<String, String> = emptyMap(), val flipX: List<Boolean> = emptyList()) {
    val durationMs: Float get() = if (fps > 0) frames.first().size * 1000f / fps else 0f
    fun row(facing: String): Int {
        val resolved = if (facing !in rowOrder && "e" in rowOrder && facing in setOf("w", "nw", "sw")) "e" else facing
        return rowOrder.indexOf(resolved).coerceAtLeast(0).coerceAtMost(frames.lastIndex)
    }
    fun frame(elapsedMs: Float, row: Int, looping: Boolean = loop): String {
        val sequence = frames[row.coerceIn(frames.indices)]
        val step = (elapsedMs.coerceAtLeast(0f) * fps / 1000).toInt()
        return sequence[if (looping) step % sequence.size else step.coerceAtMost(sequence.lastIndex)]
    }
    fun emitter(name: String, row: Int, frame: Int): Pair<Float, Float> {
        val table = emitters?.get(name)
        val point = (table?.get(row) ?: table?.get(0))?.takeIf { it.size > 0 }?.let { it.get(frame.coerceAtMost(it.size - 1)) }
        return if (point != null && point.size == 2) Pair(point.getFloat(0), point.getFloat(1))
        else Pair(cellWidth / 2, cellHeight / 2)
    }
    companion object {
        fun parse(v: JsonValue): AuthoredClip {
            val frames = v.get("frames").map { row -> row.map { it.asString() } }
            require(frames.isNotEmpty() && frames.all { it.isNotEmpty() })
            require(v.getFloat("cellWidth").isFinite() && v.getFloat("cellWidth") > 0 && v.getFloat("cellHeight").isFinite() && v.getFloat("cellHeight") > 0)
            val fps = v.getFloat("fps", 0f); val scale = v.getFloat("scale")
            require(fps.isFinite() && fps >= 0 && (fps > 0 || v.getBoolean("static", false)) && scale.isFinite() && scale > 0)
            val fxCues = linkedMapOf<String, MutableList<Int>>()
            val effectByCue = linkedMapOf<String, String>()
            v.get("fxCues")?.forEach { cue ->
                val name = cue.getString("fx")
                // Source fxAt can repeat a name (Leap dust, Lunge rend). Every
                // authored entry contributes its frames in encounter order.
                fxCues.getOrPut(name) { mutableListOf() }.addAll(cue.get("frames").map { it.asInt() })
                if(cue.has("effectKey")) {
                    val key = cue.getString("effectKey")
                    require(effectByCue[name]?.let { it == key } != false) { "Conflicting effect keys for cue $name" }
                    effectByCue[name] = key
                }
            }
            return AuthoredClip(v.getString("key"), v.getString("atlasPath"), frames,
                v.get("rowOrder")?.map { it.asString() } ?: emptyList(), fps,
                v.get("anchor").getFloat(0), v.get("anchor").getFloat(1), scale,
                v.getFloat("cellWidth"), v.getFloat("cellHeight"), v.getBoolean("loop", false), v.get("emitters"),
                fxCues.mapValues { it.value.toList() }, effectByCue,
                v.get("flipX")?.map { it.asBoolean() } ?: emptyList())
        }
    }
}

data class ProjectileProfile(val travel: AuthoredClip?, val impact: AuthoredClip?, val shadow: AuthoredClip?,
    val travelMs: Float, val arc: Float, val yForeshorten: Float, val shadowDrop: Float,
    val shadowFrames: List<Pair<Float, Int>> = emptyList(), val shadowDefaultFrame: Int = 1,
    val projectileDepth: Float = Float.MAX_VALUE, val shadowDepth: Float = Float.MAX_VALUE, val impactDepth: Float = Float.MAX_VALUE,
    val stroke: StrokeProfile? = null)
data class StrokeLayer(val width: Float,val color: Int,val alpha: Float)
data class StrokeProfile(val durationMs: Float,val depth: Float,val layers: List<StrokeLayer>) {
    companion object { fun parse(v: JsonValue): StrokeProfile {
        require(v.getString("fade") == "linear")
        val duration = v.getFloat("durationMs");val depth = v.getFloat("depth")
        require(duration.isFinite() && duration > 0 && depth.isFinite())
        val layers = v.get("layers").map { layer ->
            val width = layer.getFloat("width");val color = layer.getInt("color");val alpha = layer.getFloat("alpha")
            require(width.isFinite() && width > 0 && color in 0..0xffffff && alpha.isFinite() && alpha in 0f..1f)
            StrokeLayer(width,color,alpha)
        }
        require(layers.isNotEmpty())
        return StrokeProfile(duration,depth,layers)
    } }
}
data class ChainArt(val stroke: StrokeProfile,val originHeightFactor: Float,val targetOffsetY: Float,val impact: AuthoredClip)
data class HeroSweep(val clip: AuthoredClip,val lifetimeMs: Float,val depth: Float,val travelTailMs: Float? = null,
    val travelOffset: Pair<Float,Float>? = null,val rangePx: Float? = null,val targetActorCenterAtCast: Boolean = false,val actorToEventFallbackMs: Float? = null)
data class HeroEffectPhase(val effects: List<HeroSweep>,val sensoryPending: Boolean, val sensory:List<HeroSensory> = emptyList())
data class BreathArt(val minRange: Float, val root: AuthoredClip, val mid: AuthoredClip, val tip: AuthoredClip,
    val pointBlank: AuthoredClip, val impact: AuthoredClip)
data class FirestormArt(val bodyState: String,val emitter: String,val pinFrames: List<Int>,val reachPx: Float,
    val depthOffset: Float,val clip: AuthoredClip)
data class MaulArt(val bodyState: String,val releaseFrame: Int,val secondDelayMs: Float,
    val leftOffsetX: Float,val rightOffsetX: Float,val groundOffsetY: Float,val depthOffset: Float,val clip: AuthoredClip)
data class HowlAimArt(val minimumDeltaSquared:Float,val retainWithinDegrees:Float) {
    init {
        require(minimumDeltaSquared.isFinite() && minimumDeltaSquared>0)
        require(retainWithinDegrees.isFinite() && retainWithinDegrees>=0 && retainWithinDegrees<180)
    }
    fun facing(dx:Float,dy:Float,current:String):String {
        if(dx*dx+dy*dy<minimumDeltaSquared)return current
        val heading=listOf("e","se","s","sw","w","nw","n","ne").indexOf(current)
        require(heading>=0)
        var difference=abs(atan2(dy.toDouble(),dx.toDouble())*180/PI-heading*45)%360
        if(difference>180)difference=360-difference
        return if(difference<=retainWithinDegrees) current else CombatVisualPlan.facing(dx,dy)
    }
}
data class HowlArt(val bodyState:String,val releaseFrame:Int,val offsetX:Float,val offsetY:Float,
    val depthOffset:Float,val clip:AuthoredClip,val aim:HowlAimArt)
data class BurnfieldArt(val clip: AuthoredClip, val liveFrames: List<Int>, val extinguishFrames: List<Int>)
data class SpawnWorkArt(val state: String, val durationMs: Float) {
    init { require(state == "work" && durationMs.isFinite() && durationMs > 0) }
}
data class DamagedBodyArt(val maxHp: Long?, val healthRatio: Double) {
    init { require((maxHp==null || maxHp > 0) && healthRatio.isFinite() && healthRatio > 0 && healthRatio <= 1) }
}
data class CombatArt(val clips: Map<String, AuthoredClip>, val profile: JsonValue,
    val projectiles: Map<String, ProjectileProfile>, val effects: Map<String, AuthoredClip>,
    val deathHoldMs: Float, val deathFadeMs: Float, val fxEmitters: Map<String, String> = emptyMap(),
    val fxFacingRotationDeg: Map<String, Float> = emptyMap(), val slamOffset: Pair<Float, Float>? = null,
    val heroBodyDefaultTicks: Map<String, Int> = emptyMap(), val breathStream: BreathArt? = null, val burnfield: BurnfieldArt? = null,
    val chain: ChainArt? = null,val heroEffects: Map<String,HeroEffectPhase> = emptyMap(),
    val firestorm: FirestormArt? = null,val buildingTarget: Pair<Float,Float>? = null,val maul: MaulArt? = null,val howl: HowlArt? = null,
    val leap:LeapMotionArt?=null,val lunge:LungeMotionArt?=null,val burrowMotion:BurrowMotionArt?=null,
    val spawnWork:SpawnWorkArt?=null,val damagedBody:DamagedBodyArt?=null,val bodyMoveSnapTiles:Float?=null,
    val bodyFacingAim:HowlAimArt?=null) {
    val atlases: Set<String> get() = (clips.values + effects.values + projectiles.values.flatMap {
        listOfNotNull(it.travel, it.impact, it.shadow) } +
        listOfNotNull(breathStream?.root, breathStream?.mid, breathStream?.tip, breathStream?.pointBlank, breathStream?.impact, burnfield?.clip, chain?.impact,firestorm?.clip,maul?.clip,howl?.clip) +
        heroEffects.values.flatMap { it.effects.map(HeroSweep::clip) }).map { it.atlasPath }.toSet()
    companion object {
        fun parse(v: JsonValue) = CombatArt(requireNotNull(v.get("clips")) { "Combat clips missing" }.associate { it.name to AuthoredClip.parse(it) },
            v.get("profile"), v.get("projectiles")?.associate { p -> p.name to ProjectileProfile(
                p.get("travel")?.let(AuthoredClip::parse), p.get("impact")?.let(AuthoredClip::parse),
                p.get("shadow")?.let(AuthoredClip::parse), p.getFloat("travelMs"), p.getFloat("arc"),
                p.getFloat("yForeshorten", 1f), p.getFloat("shadowDrop", 0f),
                p.get("shadowFrames")?.map { it.getFloat("above") to it.getInt("frame") } ?: emptyList(),
                p.getInt("shadowDefaultFrame", 1), p.get("depths")?.getFloat("DEPTH_PROJ") ?: Float.MAX_VALUE,
                p.get("depths")?.getFloat("DEPTH_SHADOW") ?: Float.MAX_VALUE, p.get("depths")?.getFloat("DEPTH_IMPACT") ?: Float.MAX_VALUE,
                p.get("stroke")?.let(StrokeProfile::parse)) } ?: emptyMap(),
            v.get("effects")?.associate { it.name to AuthoredClip.parse(it) } ?: emptyMap(),
            v.getFloat("deathHoldMs", 0f), v.getFloat("deathFadeMs", 0f),
            v.get("fxEmitters")?.associate { it.name to it.asString() } ?: emptyMap(),
            v.get("fxFacingRotationDeg")?.associate { it.name to it.asFloat() } ?: emptyMap(),
            v.get("slamOffset")?.let { it.getFloat(0) to it.getFloat(1) },
            v.get("heroBodyDefaultTicks")?.associate { it.name to it.asInt() } ?: emptyMap(),
            v.get("breathStream")?.let { b -> BreathArt(b.getFloat("minRange"), AuthoredClip.parse(b.get("root")),
                AuthoredClip.parse(b.get("mid")).copy(anchorX = 0f, anchorY = .5f), AuthoredClip.parse(b.get("tip")),
                AuthoredClip.parse(b.get("pointBlank")), AuthoredClip.parse(b.get("impact"))) },
            v.get("burnfield")?.let { b -> BurnfieldArt(AuthoredClip.parse(b.get("clip")),
                b.get("liveFrames").map { it.asInt() }, b.get("extinguishFrames").map { it.asInt() }) },
            v.get("chain")?.let { c -> ChainArt(StrokeProfile.parse(c.get("stroke")),c.getFloat("originHeightFactor"),
                c.getFloat("targetOffsetY"),AuthoredClip.parse(c.get("impact"))).also {
                    require(it.originHeightFactor.isFinite() && it.targetOffsetY.isFinite())
                } },
            v.get("heroEffects")?.associate { phase -> phase.name to HeroEffectPhase(phase.get("effects").map { effect ->
                HeroSweep(AuthoredClip.parse(effect.get("clip")),effect.getFloat("lifetimeMs"),effect.getFloat("depth"),effect.get("travel")?.let { travel ->
                    require(travel.getString("mode") in setOf("eventFromTo","eventOffset","eventDirectionRange","actorToEvent"));travel.getFloat("tailMs").also { require(it.isFinite() && it >= 0) }
                },effect.get("travel")?.takeIf { it.getString("mode") == "eventOffset" }?.let { travel ->
                    (travel.getFloat("offsetX") to travel.getFloat("offsetY")).also { require(it.first.isFinite() && it.second.isFinite()) }
                },effect.get("travel")?.takeIf { it.getString("mode") == "eventDirectionRange" }?.getFloat("rangePx")?.also { require(it.isFinite() && it>0) },
                    effect.getString("placement",null)?.let { require(it=="targetActorCenterAtCast");true } ?: false,
                    effect.get("travel")?.takeIf { it.getString("mode")=="actorToEvent" }?.getFloat("absentActorLifetimeMs")?.also { require(it.isFinite() && it>0) }).also {
                    require(it.lifetimeMs.isFinite() && it.lifetimeMs > 0 && it.depth.isFinite())
                }
            },phase.get("sensory")?.size?.let { it > 0 } ?: false, phase.get("sensory")?.map(HeroSensory::parse) ?: emptyList()) } ?: emptyMap(),
            v.get("firestorm")?.let { f ->
                require(f.getString("target")=="visibleBuildingCenterOrEvent")
                FirestormArt(f.getString("bodyState"),f.getString("emitter"),f.get("pinFrames").map { it.asInt() },
                    f.getFloat("reachPx"),f.getFloat("depthOffset"),AuthoredClip.parse(f.get("clip"))).also {
                    require(it.pinFrames.isNotEmpty() && it.pinFrames.all { n->n>0 } && it.pinFrames.zipWithNext().all { (a,b)->a<b })
                    require(it.reachPx.isFinite() && it.reachPx>0 && it.depthOffset.isFinite())
                }
            },v.get("buildingTarget")?.let { (it.getFloat("offsetX") to it.getFloat("offsetY")).also { p->require(p.first.isFinite()&&p.second.isFinite()) } },v.get("maul")?.let { m ->
                require(m.getString("target")=="currentActorXAtReleaseCapturedGroundY")
                MaulArt(m.getString("bodyState"),m.getInt("releaseFrame"),m.getFloat("secondDelayMs"),
                    m.getFloat("leftOffsetX"),m.getFloat("rightOffsetX"),m.getFloat("groundOffsetY"),
                    m.getFloat("depthOffset"),AuthoredClip.parse(m.get("clip"))).also { a ->
                    require(a.bodyState=="maul" && a.releaseFrame>0 && a.secondDelayMs.isFinite() && a.secondDelayMs>0)
                    require(listOf(a.leftOffsetX,a.rightOffsetX,a.groundOffsetY,a.depthOffset).all { it.isFinite() })
                    require(a.clip.fps>0 && !a.clip.loop)
                    val body=AuthoredClip.parse(requireNotNull(v.get("clips").get(a.bodyState)) { "Maul body clip missing: ${a.bodyState}" })
                    require(body.fps>0 && body.frames.all { a.releaseFrame<=it.size })
                }
            },v.get("howl")?.let { h ->
                require(h.getString("target")=="currentActorAtRelease" && h.getString("facing")=="retainUnlessAimed" && h.getBoolean("ownedCancellation"))
                HowlArt(h.getString("bodyState"),h.getInt("releaseFrame"),h.getFloat("offsetX"),h.getFloat("offsetY"),
                    h.getFloat("depthOffset"),AuthoredClip.parse(requireNotNull(h.get("clip")) { "Howl effect clip missing" }),
                    requireNotNull(h.get("aim")) { "Howl aim contract missing" }.let {
                        HowlAimArt(it.getFloat("minimumDeltaSquared"),it.getFloat("retainWithinDegrees"))
                    }).also { a ->
                    require(a.bodyState=="howl" && a.releaseFrame>0)
                    require(listOf(a.offsetX,a.offsetY,a.depthOffset).all { it.isFinite() })
                    require(a.clip.fps>0 && !a.clip.loop)
                    val body=AuthoredClip.parse(requireNotNull(v.get("clips").get(a.bodyState)) { "Howl body clip missing: ${a.bodyState}" })
                    require(body.fps>0 && body.frames.all { a.releaseFrame<=it.size })
                }
            },v.get("leap")?.let { LeapMotionArt.parse(it,v.get("clips")) },
            v.get("lunge")?.let { LungeMotionArt.parse(it,v.get("clips")) },
            v.get("burrowMotion")?.let { BurrowMotionArt.parse(it,v) },
            v.get("spawnWork")?.let { SpawnWorkArt(it.getString("state"),it.getFloat("durationMs")) },
            v.get("damagedBody")?.let { DamagedBodyArt(null,it.getDouble("healthRatio")) },
            v.get("bodyMoveSnapTiles")?.asFloat()?.also { require(it.isFinite() && it>0) },
            v.get("bodyFacingAim")?.let { HowlAimArt(it.getFloat("minimumDeltaSquared"),it.getFloat("retainWithinDegrees")) })
        fun catalogue(root: JsonValue): Map<String, CombatArt> {
            require(root.getInt("rendererContractVersion",2) in 2..17) { "Unsupported combat renderer contract" } // 17 inherits 16's combat metadata unchanged (N-C5 CONTENT-MOUNT)
            val profiles = root.get("combatProfiles")?.associate { it.name to parse(it) } ?: emptyMap()
            return listOf("actors", "entries", "walls").flatMap { root.get(it)?.toList() ?: emptyList() }.mapNotNull { entry ->
                val profile = entry.get("combat")?.let(::parse) ?: profiles[entry.getString("combatKey", "")]
                val combat = profile?.damagedBody?.let { health ->
                    profile.copy(damagedBody=health.copy(maxHp=entry.getLong("damagedBodyMaxHp")))
                } ?: profile
                if(root.getInt("rendererContractVersion",2)>=8 && entry.getString("type","")=="direwyvern")
                    require(combat?.firestorm!=null) { "Firestorm contract missing from admitted Direwyvern" }
                if(root.getInt("rendererContractVersion",2)>=9 && entry.getString("type","")=="direwyvern")
                    require(combat?.maul!=null) { "Maul contract missing from admitted Direwyvern" }
                if(root.getInt("rendererContractVersion",2)>=10 && entry.getString("type","")=="gloamfang")
                    require(combat?.howl!=null) { "Howl contract missing from admitted Gloamfang" }
                if(root.getInt("rendererContractVersion",2)>=11 && entry.getString("type","")=="gloamfang") {
                    require(combat?.leap!=null && combat.lunge!=null) { "Motion contracts missing from admitted Gloamfang" }
                    require(combat.howl?.aim==combat.leap.aim && combat.lunge.aim==combat.leap.aim) { "Gloamfang shared facing contract mismatch" }
                    val stand=combat.profile.getString("stand",null)
                    val move=combat.profile.getString("battleMove",null) ?: combat.profile.getString("move",null)
                    require(stand!=null && move!=null && stand in combat.clips && move in combat.clips) { "Gloamfang locomotion clips missing" }
                }
                if(root.getInt("rendererContractVersion",2)>=12 && entry.getString("type","") in setOf("tunneler","bilgewraith"))
                    require(combat?.burrowMotion!=null) { "Burrow contract missing from admitted actor" }
                combat?.let { entry.getString("frameKey") to it }
            }.toMap()
        }
    }
}

data class CombatSprite(val clip: AuthoredClip, val frameKey: String, val x: Float, val y: Float,
    val depth: Float, val alpha: Float = 1f, val rotation: Float = 0f, val flipX: Boolean = false, val cropWidth: Float = Float.POSITIVE_INFINITY, val hit: Boolean = false,
    val horizontalScale: Float = clip.scale, val kegPrime: KegPrimePresentation? = null,
    /** Classpath rest cell drawn INSTEAD of frameKey once a sink collapse has played (BuildingRuinArt). */
    val ruin: String? = null,
    /** Internal cue ownership for optional successful-draw diagnostics only. */
    val serviceHit: HitFeedbackCue? = null)
private data class Action(val startMs: Float, val endMs: Float, val states: List<AuthoredClip>, val facing: String,
    val priority: Int = 1, val looping: Boolean = false, val once: Boolean = false,
    val phaseStartMs: Float = startMs, val origin: Pair<Float, Float>? = null, val target: Pair<Float, Float>? = null,
    val sourceStartMs: Float = startMs, var eventOrdinal: Int = Int.MAX_VALUE)
private data class KegPrimeCue(val clip: AuthoredClip, val startTick: Float, val detonateTick: Int, val order: Int, val deathTick: Int?)
private data class Flight(val startMs: Float, val fromX: Float, val fromY: Float, val toX: Float, val toY: Float,
    val profile: ProjectileProfile)
private data class BodyFeedbackPose(val at:Float,val facing:String,val moving:Boolean)
data class CombatStroke(val fromX: Float,val fromY: Float,val toX: Float,val toY: Float,val depth: Float,
    val width: Float,val color: Int,val alpha: Float)
private data class StrokeCue(val start: Float,val fromX: Float,val fromY: Float,val toX: Float,val toY: Float,val profile: StrokeProfile)

/** An immutable, random-access presentation schedule. Sampling at a seek, after backgrounding, or
 * after replacing a revision reconstructs ongoing sprites; it never fires callbacks, audio or orders.
 * Construction and JSON decoding happen on the existing presentation executor, away from GL. */
class CombatVisualPlan(private val scene: BattleScene, private val model: BattleVisualModel,
    private val artByFrame: Map<String, CombatArt>, buildingDamageThreshold: Float? = null,
    private val walls: WallVisualModel? = null, val sensoryPolicy:SensoryPolicy? = null,
    private val hitPolicy:HitFeedbackPolicy? = null, private val archivePolicy:ArchivedMeleePolicy?=null, private val checkpoint: () -> Unit = {},
    /** The pack's actor band (`basePresentation.jobs.actorDepthOffset`, web WORLD_DEPTH.actor) for flying bodies;
     * 0 leaves every actor on the shared screen-Y axis the structures sort on. */
    private val flyingDepthOffset: Float = 0f) {
    private val buildingHealth = BuildingHealthVisualModel(scene.base.buildings, scene.revision.events, buildingDamageThreshold, checkpoint)
    private val actorHealth = ActorHealthVisualModel(scene.actorMaxHp, scene.revision.events, checkpoint)
    private val buildingsById = scene.base.buildings.associateBy { it.id }
    private val actions = mutableMapOf<Int, MutableList<Action>>()
    private val buildingActions = mutableMapOf<String, MutableList<Action>>()
    private val flights = mutableListOf<Flight>()
    private val kegPrimes = mutableMapOf<Int, KegPrimeCue>()
    // The catalogue already exports this shared v2 facing helper for Howl/Leap/Lunge.
    private val sharedFacingAim=artByFrame.values.mapNotNull { it.howl?.aim }.distinct().also {
        require(it.size<=1) { "Inconsistent admitted shared v2 facing contract" }
    }.singleOrNull()
    private val strokes = mutableListOf<StrokeCue>()
    private var longestStrokeMs = 0f
    private val effects = mutableListOf<Effect>()
    private val pendingHowlEffects = mutableListOf<Triple<Int,Action,Effect>>()
    private data class GiantCommand(val id:Int,val event:JsonValue,val order:Int,val tick:Int,val dx:Float,val dy:Float,val flight:Flight?=null)
    private val giantCommands=java.util.IdentityHashMap<Action,GiantCommand>()
    private val trapSpentAt = mutableMapOf<String, Float>()
    private val buildingWork = mutableMapOf<String,List<Action>>()
    private val actorDamagedAt = mutableMapOf<Int,Float>()
    private val damagedRestStarts = mutableMapOf<Int,List<Float>>()
    private val feedbackActors = mutableSetOf<Int>()
    private val feedbackPoses = mutableMapOf<Int,List<BodyFeedbackPose>>()
    private val streams = mutableListOf<Stream>()
    private val fans = mutableListOf<Fan>()
    private val fields = mutableListOf<Field>()
    private val unknown = linkedSetOf<String>()
    private val builtSensoryCues=mutableListOf<HeroSensoryCue>()
    private val deployedSensoryActors=mutableSetOf<Int>()
    val sensoryCues:List<HeroSensoryCue> get()=builtSensoryCues
    private val hitCues=mutableListOf<HitFeedbackCue>()
    val hitFeedback:HitFeedbackPlan?
    private val unitScale = scene.base.tilePixels / scene.simUnitsPerTile
    /** Web `actorDepth` for a body whose admitted V2 troop profile says `flying` (dragon, direwyvern, hatchling): the
     * body and every effect seated on it leave the shared screen-Y axis for the actor band, so a wall ring or keep
     * it passes over can never cover it. A ground body keeps 0 and its existing wall/building interleave. The set
     * comes from the pack's profiles, never a troop list here. */
    private val flyingLift: Map<Int,Float> = if(flyingDepthOffset==0f) emptyMap() else
        model.actorIds.filter { actorArt(it)?.profile?.getBoolean("flying",false)==true }.associateWith { flyingDepthOffset }
    private fun lift(id:Int): Float = flyingLift[id] ?: 0f
    private val indexedEvents=scene.revision.events.mapIndexed { ordinal,event -> checkpoint(); ordinal to JsonReader().parse(event.json) }
    private val indexedActorEvents=indexedEvents.filter { it.second.get("id")?.isNumber==true }.groupBy { it.second.getInt("id") }
    private val indexedBurrowEvents=indexedEvents.mapNotNull { pair ->
        checkpoint()
        val e=pair.second
        val id=if(e.getString("e")=="hit")e.get("target") else e.get("id")
        id?.takeIf { it.isNumber }?.asInt()?.let { it to pair }
    }.groupBy({ it.first },{ it.second })
    private val hitBuildings=scene.base.buildings.associateBy { it.id }
    private val firstHitTerminal=buildMap<String,Int> {
        indexedEvents.forEach { (order,e)->if(e.getString("e") in setOf("destroyed","trap"))
            putIfAbsent(e.getString("id"),order) }
    }
    private val indexedDestructions=indexedEvents.filter { it.second.getString("e")=="destroyed" }.groupBy { it.second.getString("id") }
    private val automaticArchiveActors=if(archivePolicy==null)emptySet() else model.actorIds.filter { id->actorArt(id)?.let {
        archivePolicy.automatic(scene.revision.simVersion,id,indexedActorEvents[id].orEmpty(),it)
    }==true }.toSet()
    private var legacyMelee=emptyMap<Int,LegacyMeleeTimeline>()
    private fun nearestStandTarget(ms:Float,ordinal:Int,x:Float,y:Float):Pair<Float,Float>? {
        var nearest:Pair<Float,Float>?=null;var distance=Float.POSITIVE_INFINITY
        for(building in scene.base.buildings) {
            if(indexedDestructions[building.id]?.any { (order,event)->
                val at=atMs(event.getInt("t"));at<ms || (at==ms && order<ordinal)
            }==true)continue
            val bx=(building.tileX+building.footprintWidth/2)*scene.base.tilePixels
            val by=(building.tileY+building.footprintHeight)*scene.base.tilePixels
            val next=(bx-x)*(bx-x)+(by-y)*(by-y)
            if(next<distance) { distance=next;nearest=bx to by }
        }
        return nearest
    }
    private val burrowMotion=run {
        val admitted=model.actorIds.mapNotNull { id->actorArt(id)?.takeIf {
            model.actorIdentity(id) in setOf("tunneler","bilgewraith") && it.burrowMotion!=null
        }?.let { id to it } }
        if(admitted.isEmpty())emptyMap() else {
            val boundary=(scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick ?: 0f
            val deliveries=PositionDelivery.compile(scene.revision.events,scene.positionCadenceTicks,
                scene.summonedPositionCadenceTicks,scene.tickDurationMs,fromTick=boundary)
            admitted.associate { (id,art)->checkpoint(); id to BurrowMotionTimeline(scene.revision.events,indexedBurrowEvents[id].orEmpty(),
                deliveries,art,scene.tickDurationMs,unitScale,scene.presentationStart,::nearestStandTarget,
                indexedDestructions.values.flatten(),legacyAutomatic=id in automaticArchiveActors) }
        }
    }
    private val gloamfangMotion = run {
        val admitted=model.actorIds.mapNotNull { id -> actorArt(id)?.takeIf {
            model.actorIdentity(id)=="gloamfang" && it.leap!=null && it.lunge!=null
        }?.let { id to it } }
        if(admitted.isEmpty()) emptyMap() else {
            val deliveries=PositionDelivery.compile(scene.revision.events,scene.positionCadenceTicks,
                scene.summonedPositionCadenceTicks,scene.tickDurationMs)
            admitted.associate { (id,art) -> checkpoint(); id to GloamfangMotionTimeline(scene.revision.events,id,deliveries,art,
                scene.tickDurationMs,unitScale,actorEvents=indexedBurrowEvents[id].orEmpty(),nearestStandTarget=::nearestStandTarget,
                legacyAutomatic=id in automaticArchiveActors,idleFacingEvents=indexedDestructions.values.flatten(),
                hitFromTick=(scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick ?: 0f) }
        }
    }
    private val heroMotion=run {
        val admitted=model.actorIds.filter { id->model.actorIdentity(id) in setOf("vex","theodor") &&
            actorArt(id)?.heroBodyDefaultTicks?.containsKey("default")==true && indexedActorEvents[id].orEmpty().any { (_,e)->
                e.getString("e")=="heroSkill" && e.getString("skill") in setOf("crimsonDash","cannonball")
            } }
        val boundary=(scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick ?: 0f
        val deliveries=if(admitted.isEmpty())emptyMap() else PositionDelivery.compile(scene.revision.events,
            scene.positionCadenceTicks,scene.summonedPositionCadenceTicks,scene.tickDurationMs,boundary)
        admitted.associateWith { id->checkpoint(); HeroBodyMotion(indexedActorEvents[id].orEmpty(),deliveries,
            requireNotNull(actorArt(id)),scene.tickDurationMs,unitScale,scene.presentationStart) }
    }
    val missingCoverage: Set<String> get() = unknown
    val requiredAtlases: Set<String> = (scene.actorFrames.values + scene.base.buildings.map { it.frameKey })
        .distinct().flatMap { artByFrame[it]?.atlases ?: emptySet() }.toSet() + listOfNotNull(hitPolicy?.star?.atlasPath)
    val flightCount: Int get() = flights.size
    val playbackExtent: BattlePlaybackExtent
    private var longestFlightMs = 0f

    init {
        val parsed = indexedEvents.map { it.second }
        val runs = parsed.filter { it.getString("e") == "attackRun" }
        val legacyKeys = hashSetOf<Pair<Int, Int>>()
        for (event in runs) {
            checkpoint()
            val count = event.getInt("count"); val cadence = event.getInt("cadenceTicks")
            require(count > 0 && cadence > 0)
            // A run cannot describe more starts than fit its own event stream plus one cycle.
            require(count.toLong() * cadence <= (model.finalTick.toLong() + cadence))
            repeat(count) { checkpoint(); legacyKeys += event.getInt("id") to Math.addExact(event.getInt("t"), Math.multiplyExact(it, cadence)) }
        }
        val cues = parsed.flatMapIndexed { order,event -> if (event.getString("e") == "attackRun")
            List(event.getInt("count")) { Triple(event,event.getInt("t") + it * event.getInt("cadenceTicks"),order) }
            else listOf(Triple(event,event.getInt("t"),order)) }.sortedBy { it.second }
        for ((event, tick, order) in cues) when (val type = event.getString("e").also { checkpoint() }) {
            "attackRun" -> if (event.getString("technique") !in setOf("firestorm", "maul", "howl", "detonate")) actorAttack(event, tick,order)
            "troopAttack", "troopFire", "heroAttack" -> if (event.getInt("id") to tick !in legacyKeys) actorAttack(event, tick,order)
            "fire" -> buildingAttack(event,order)
            "chain" -> { chain(event,order);captureHit(event,order) }
            "hit" -> captureHit(event,order)
            "troopAbility" -> ability(event,order,parsed)
            "heroSkill" -> heroSkill(event,order)
            "burnfield" -> burnfield(event)
            "trap" -> { trap(event);eventHaptic(event,order) }
            "detonate" -> detonate(event,order)
            "rally", "star", "destroyed" -> eventHaptic(event,order)
            "deploy" -> deploySensory(event,order)
            "spawn" -> deployedSensoryActors.add(event.getInt("id"))
            "troopSpawn" -> if(event.getString("troop")=="barrowling")deployedSensoryActors.add(event.getInt("id"))
            "troopDeath" -> deployedSensoryActors.remove(event.getInt("id"))
            "pos", "heal", "burrow", "emerge" -> Unit
            else -> unknown += type
        }
        actions.values.forEach { it.sortBy { action -> action.startMs } }
        settleGiantThrows()
        compileActorBodyFeedback()
        actions.values.forEach { it.sortBy { action -> action.startMs } }
        if(automaticArchiveActors.isNotEmpty()) {
            val deliveries=PositionDelivery.compile(scene.revision.events,scene.positionCadenceTicks,scene.summonedPositionCadenceTicks,scene.tickDurationMs)
            legacyMelee=automaticArchiveActors.filter { it !in gloamfangMotion && it !in burrowMotion }.associateWith { id->
                LegacyMeleeTimeline(indexedBurrowEvents[id].orEmpty(),deliveries,requireNotNull(actorArt(id)),scene.tickDurationMs,unitScale,
                    requireNotNull(archivePolicy),actions[id].orEmpty().map { LegacyMeleeVerb(it.startMs,it.endMs,it.facing) },atMs(model.finalTick),
                    indexedDestructions.values.flatten(),::nearestStandTarget)
            }
            legacyMelee.forEach { (id,timeline)->legacyMeleeEffects(timeline,requireNotNull(actorArt(id))) }
        }
        // Replacing the body unregisters its keyed callback. Once emitted, the
        // owned ring survives ordinary later attacks and ends only at expiry/death.
        pendingHowlEffects.forEach { (id,action,effect) ->
            if(actionAt(actions[id],effect.start)===action) effects+=effect
        }
        pendingHowlEffects.clear()
        gloamfangMotion.forEach { (id,timeline) -> gloamfangEffects(id,timeline,requireNotNull(actorArt(id))) }
        burrowMotion.forEach { (id,timeline)->burrowEffects(timeline,requireNotNull(actorArt(id))) }
        buildingActions.values.forEach { it.sortBy { action -> action.startMs } }
        compileSpawnWork()
        flights.sortBy { it.startMs }
        strokes.sortBy { it.start }
        longestStrokeMs = strokes.maxOfOrNull { it.profile.durationMs } ?: 0f
        longestFlightMs = flights.maxOfOrNull { it.profile.travelMs + (it.profile.impact?.durationMs ?: 0f) } ?: 0f
        hitFeedback=hitPolicy?.let { HitFeedbackPlan(it,hitCues,scene.tickDurationMs) }
        playbackExtent = finitePlaybackExtent()
    }

    private fun finitePlaybackExtent(): BattlePlaybackExtent {
        var end = maxOf(atMs(model.finalTick),(hitFeedback?.endTick ?: 0f)*scene.tickDurationMs)
        fun include(value: Float) {
            require(value.isFinite() && value >= 0) { "Unbounded combat presentation" }
            end = maxOf(end, value)
        }
        actions.values.forEach { list -> list.forEach { include(it.endMs) } }
        heroMotion.values.forEach { include(it.endMs) }
        gloamfangMotion.values.forEach { timeline ->
            include(timeline.motionEndMs)
            timeline.bodyActions.filterNot { it.looping || it.automatic }.forEach { include(it.endMs) }
        }
        burrowMotion.values.forEach { timeline->
            include(timeline.motionEndMs)
            timeline.bodyActions.filterNot { it.looping || it.automatic }.forEach { include(it.endMs) }
        }
        buildingActions.values.forEach { list -> list.forEach { include(it.endMs) } }
        flights.forEach { include(it.startMs + it.profile.travelMs + (it.profile.impact?.durationMs ?: 0f)) }
        strokes.forEach { include(it.start + it.profile.durationMs) }
        streams.forEach { include(it.end) }
        fans.forEach { include(it.end) }
        effects.forEach { include(it.start + it.lifetimeMs) }
        fields.forEach {
            require(it.art.clip.fps > 0)
            include(minOf(it.replacedAt, it.until + it.art.extinguishFrames.size * 1000f / it.art.clip.fps))
        }
        model.actorIds.forEach { id -> model.deathTick(id)?.let { tick ->
            actorArt(id)?.let { art -> art.clips[art.profile.getString("death", "death")]?.let { clip ->
                include(atMs(tick) + clip.durationMs + art.deathHoldMs + art.deathFadeMs)
            } }
        } }
        scene.base.buildings.forEach { building -> model.destroyedTick(building.id)?.let { tick ->
            val frame = walls?.frameAt(building.id, tick.toFloat()) ?: building.frameKey
            artByFrame[frame]?.let { art -> art.clips[art.profile.getString("death", "collapse")]?.let { clip ->
                include(atMs(tick) + clip.durationMs)
            } }
        } }
        // Idle, damaged and other indefinite loops do not prolong terminal playback.
        var visualEndTick = maxOf(model.finalTick.toFloat(),end / scene.tickDurationMs)
        // Float division can round below the expiry when sampling multiplies back to milliseconds.
        if(visualEndTick * scene.tickDurationMs < end) visualEndTick = Math.nextUp(visualEndTick)
        return BattlePlaybackExtent(model.finalTick.toFloat(),visualEndTick)
    }

    /** Canonical apply() suppresses transient events in a cold prefix. Destruction/trap
     * require an existing building, even if an earlier event already changed its state. */
    private fun eventHaptic(event:JsonValue,order:Int) {
        val type=event.getString("e");val tick=event.getInt("t")
        if(tick<((scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick ?: 0f))return
        if(type in setOf("destroyed","trap") && event.getString("id") !in hitBuildings)return
        // Canonical 427381a2 onDestroyed plays the light collapse haptic for every live building, service buildings
        // included, before its Market/berth routing; it does not depend on whether service artwork is admitted.
        val contract=sensoryPolicy?.eventHaptics ?: return
        val strength=contract.strength(event) ?: return
        builtSensoryCues+=HeroSensoryCue(order,tick,listOf(HeroSensory.Haptic(strength)))
    }

    private fun deploySensory(event:JsonValue,order:Int) {
        val strength=sensoryPolicy?.eventHaptics?.deployment ?: return
        val id=event.getInt("id");if(!deployedSensoryActors.add(id))return
        val key=DeployMarkerKey(event.getString("troop"),event.getString("hero",null),
            kotlin.math.floor(event.getFloat("x")/scene.simUnitsPerTile).toInt(),
            kotlin.math.floor(event.getFloat("y")/scene.simUnitsPerTile).toInt())
        // Include cold entries for silent marker/id hydration. Cursor admission
        // determines whether a current unmarked event may produce feedback.
        builtSensoryCues+=HeroSensoryCue(order,event.getInt("t").toFloat(),listOf(HeroSensory.Haptic(strength)),deployment=DeployHaptic(id,key,scene.revision.events[order]))
    }

    /** Capture before later source events at this tick can change the victim's body or life. */
    private fun captureHit(event:JsonValue,order:Int) {
        val policy=hitPolicy ?: return
        val tick=event.getInt("t");val at=tick.toFloat()
        if(at<((scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick ?: 0f))return
        fun actor(id:Int) {
            val pose=model.poseBeforeEvent(id,at,order) ?: return
            actorArt(id) ?: return
            val body=requireNotNull(actorPose(id,at,pose,order)) { "Missing admitted actor hit geometry: $id" }
            hitCues+=HitFeedbackCue(HitTarget.Actor(id),tick,order,body.x,
                body.y-body.clip.cellHeight*body.clip.scale*policy.actorHeightFactor)
        }
        if(event.getString("e")=="chain") {
            if(event.getString("id") !in hitBuildings)return
            event.get("targets")?.forEachIndexed { index,target->
                if((event.get("dmg")?.get(index)?.asDouble() ?: 0.0)>0)actor(target.asInt())
            }
        } else {
            val target=event.get("target")
            if(target.isNumber)actor(target.asInt()) else {
                val id=target.asString();val b=hitBuildings[id] ?: return
                if(firstHitTerminal[id]?.let { it<order }==true)return
                if(b.service!=null) {
                    val health=buildingHealth.afterEvent(id,order)
                    // Match the actual painter: absent health retains its neutral IDLE body, not invented HP.
                    val state=if(health?.damagedSinceTick!=null)ServiceCombatState.DAMAGED else ServiceCombatState.IDLE
                    hitCues+=HitFeedbackCue(HitTarget.Building(id),tick,order,
                        (b.tileX+b.footprintWidth/2)*scene.base.tilePixels,
                        (b.tileY+b.footprintHeight)*scene.base.tilePixels,ServiceHitAnchor(id,state))
                    return
                }
                // All admitted current building body states share one display height. A later
                // source exception must provide its exact state geometry, never a guessed anchor.
                val heights=artByFrame[b.frameKey]?.clips?.values?.map { it.cellHeight*it.scale }?.distinct().orEmpty()
                require(heights.size<=1) { "Building hit anchor needs state-specific admitted geometry" }
                val height=heights.singleOrNull() ?: policy.staticHeights[b.frameKey]
                    ?: error("Missing admitted building hit height: ${b.frameKey}")
                val x=(b.tileX+b.footprintWidth/2)*scene.base.tilePixels
                val y=(b.tileY+b.footprintHeight)*scene.base.tilePixels
                hitCues+=HitFeedbackCue(HitTarget.Building(id),tick,order,x,y-minOf(height*policy.buildingHeightFactor,policy.buildingLiftMax))
            }
        }
    }

    private fun actorArt(id: Int) = artByFrame[scene.actorFrames["#$id"] ?: scene.actorFrames[model.actorIdentity(id)]]
    private fun atMs(tick: Int) = tick * scene.tickDurationMs
    private fun actorAttack(event: JsonValue, tick: Int,order:Int) {
        val id = event.getInt("id")
        if(id in gloamfangMotion || id in burrowMotion)return
        val pose = model.pose(id, tick.toFloat()) ?: return
        val art = actorArt(id) ?: run { unknown += "combat:${pose.identity}"; return }
        val technique = event.getString("technique", "")
        val stateNames = when {
            technique == "boulder" || event.getString("proj", "") == "boulder" -> listOf("throw")
            technique == "breath" && pose.identity == "dragon" -> listOf("breath")
            event.getString("e") == "heroAttack" -> art.profile.get("attack")?.map { it.asString() } ?: emptyList()
            event.getString("e") == "troopAttack" || event.getString("mode", "") == "melee" ->
                listOfNotNull(art.profile.get("melee")?.getString(event.getString("targetKind", if (event.get("target")?.isNumber == true) "troop" else "building"), null))
            else -> art.profile.get("attack")?.map { it.asString() } ?: emptyList()
        }
        val clips = stateNames.mapNotNull { art.clips[it] }
        if (clips.isEmpty()) { unknown += "attack:${pose.identity}:$technique"; return }
        val motion=heroMotion[id]
        if(motion!=null && atMs(tick)<motion.boundaryMs && motion.resumeStart(order)==null)return
        val requestedStart = motion?.resumeStart(order) ?: atMs(tick)
        // Legacy ranged cues queue complete authored sequences; compact SIM9 runs already own cadence.
        val start = if (event.getString("e") == "troopFire" && art.profile.has("ranged"))
            maxOf(requestedStart, actions[id]?.maxOfOrNull { it.endMs } ?: requestedStart) else requestedStart
        val firingPose = if (start > requestedStart) model.pose(id, start / scene.tickDurationMs) ?: return else pose
        val visible=motion?.sample(start,order)
        val x = visible?.x ?: (firingPose.x * unitScale); val y = visible?.y ?: (firingPose.y * unitScale)
        val tx = event.getFloat("ix") * unitScale; val ty = event.getFloat("iy") * unitScale
        val facing = facing(tx - x, ty - y)
        val endMs = if (event.getString("e") == "heroAttack" && event.has("recoveryUntil"))
            atMs(event.getInt("recoveryUntil")) else start + clips.sumOf { it.durationMs.toDouble() }.toFloat()
        val action=Action(start, endMs, clips, facing, priority = if (event.getString("e") == "heroAttack") 2 else 1,
            looping = event.getString("e") == "heroAttack", origin = if (event.getString("e") == "heroAttack") x to y else null)
        addAction(id,action,order)
        if(pose.identity=="giant"&&sensoryPolicy?.giantLanding!=null)
            giantCommands[action]=GiantCommand(id,event,order,tick,tx-x,ty-y)
        authoredEffects(art, clips, start, x, y, facing, model.deathTick(id)?.let(::atMs), towardX = tx, lift = lift(id))
        val ranged = art.profile.get("ranged")
        val kind = when { technique == "boulder" || event.getString("proj", "") == "boulder" -> "boulder"
            else -> ranged?.getString("projectile", null) }
        if (kind != null && (event.getString("e") == "troopFire" || event.getString("mode", "") == "projectile")) {
            val projectile = art.projectiles[kind] ?: run { unknown += "projectile:${pose.identity}:$kind"; return }
            val releaseClip = if (kind == "boulder") clips.first() else art.clips[ranged?.getString("state", null)] ?: clips.first()
            val releaseFrame = releaseClip.fxCues[if (kind == "boulder") kind else ranged?.getString("fx", null)]?.firstOrNull() ?: ranged?.takeIf { it.has("releaseFrame") }?.getInt("releaseFrame")
            if (releaseFrame == null) { unknown += "release:${pose.identity}:$kind"; return }
            val prefix = clips.takeWhile { it !== releaseClip }.sumOf { it.durationMs.toDouble() }.toFloat()
            val releaseMs = start + if (event.has("releaseOffsetMs")) event.getFloat("releaseOffsetMs") else prefix + (releaseFrame - 1) * 1000f / releaseClip.fps
            val ownedGiant=pose.identity=="giant"&&kind=="boulder"&&sensoryPolicy?.giantLanding!=null
            if (!ownedGiant&&model.deathTick(id)?.let { atMs(it) <= releaseMs } == true) return
            val emitter = releaseClip.emitter(if (kind == "boulder") "center" else ranged?.getString("emitter", "center") ?: "center", releaseClip.row(facing), releaseFrame - 1)
            val ex = x + (emitter.first - releaseClip.cellWidth * releaseClip.anchorX) * releaseClip.scale
            val ey = y + (emitter.second - releaseClip.cellHeight * releaseClip.anchorY) * releaseClip.scale
            if(!ownedGiant)addStroke(projectile,kind,releaseMs,ex,ey,tx,ty)
            val flight=Flight(releaseMs, ex, ey, tx, ty, projectile)
            if(ownedGiant)giantCommands[action]=requireNotNull(giantCommands[action]).copy(flight=flight)
            else flights+=flight
        } else if (pose.identity == "dragon" && (technique == "breath" || event.getString("e") == "troopFire")) {
            val breath = art.breathStream ?: run { unknown += "effect:dragon:breathStream"; return }
            val body = art.clips["breath"] ?: return
            val window = body.fxCues["breath"].orEmpty()
            if (window.isEmpty()) { unknown += "release:dragon:breath"; return }
            val onset = start + (window.first() - 1) * 1000f / body.fps
            val end = minOf(start + window.last() * 1000f / body.fps, model.deathTick(id)?.let(::atMs) ?: Float.POSITIVE_INFINITY)
            if (onset >= end) return
            if (hypot(tx - x, ty - y) < breath.minRange) {
                val launchPose = model.pose(id, onset / scene.tickDurationMs) ?: return
                val maw = body.emitter("maw", body.row(facing), window.first() - 1)
                val ex = launchPose.x * unitScale + (maw.first - body.cellWidth * body.anchorX) * body.scale
                val ey = launchPose.y * unitScale + (maw.second - body.cellHeight * body.anchorY) * body.scale
                effects += Effect(onset, breath.pointBlank, ex, ey, (atan2(ty - ey, tx - ex) * 180 / PI).toFloat(), Float.MAX_VALUE)
            } else {
                streams += Stream(id, start, onset, end, body, facing, tx, ty, breath, false)
                // The assembled tip owns its contact flame; only one onset impact is emitted.
                effects += Effect(onset, breath.impact, tx, ty, 0f, Float.MAX_VALUE)
            }
        }
    }

    private fun buildingAttack(event: JsonValue,order:Int) {
        val id = event.getString("id"); val building = scene.base.buildings.firstOrNull { it.id == id } ?: return
        if (model.isDestroyed(id, event.getInt("t").toFloat())) return
        val art = artByFrame[building.frameKey] ?: run { unknown += "combat:${building.frameKey}"; return }
        val eventProjectile = event.getString("proj")
        val firePlan = art.profile.get("firePlans")?.get("$eventProjectile:${if (art.profile.has("nearKeepRangePx") && hypot(event.getFloat("ix") * unitScale - (building.tileX + building.footprintWidth / 2) * scene.base.tilePixels, event.getFloat("iy") * unitScale - (building.tileY + building.footprintHeight) * scene.base.tilePixels) <= art.profile.getFloat("nearKeepRangePx")) "near" else "far"}")
        val names = firePlan?.get("states")?.map { it.asString() }
            ?: art.profile.get("attack")?.map { it.asString() } ?: listOf("fire", "reload")
        val clips = names.mapNotNull { art.clips[it] }
        if (clips.isEmpty()) { unknown += "fire:${building.frameKey}"; return }
        val x = (building.tileX + building.footprintWidth / 2) * scene.base.tilePixels
        val y = (building.tileY + building.footprintHeight) * scene.base.tilePixels
        val tx = event.getFloat("ix") * unitScale; val ty = event.getFloat("iy") * unitScale
        val direction = facing(tx - x, ty - y); val start = atMs(event.getInt("t"))
        buildingActions.getOrPut(id) { mutableListOf() } += Action(start, start + clips.sumOf { it.durationMs.toDouble() }.toFloat(), clips, direction)
        authoredEffects(art, clips, start, x, y, direction, model.destroyedTick(id)?.let(::atMs), building = true)
        val kind = firePlan?.getString("shot") ?: art.profile.getString("projectile", eventProjectile)
        val projectile = art.projectiles[kind] ?: run { unknown += "projectile:${building.frameKey}:$kind"; return }
        val firing = art.clips[firePlan?.getString("releaseState", null)] ?: clips.first()
        val cue = firePlan?.getInt("releaseFrame") ?: firing.fxCues[kind]?.firstOrNull()
        if (cue == null) { unknown += "release:${building.frameKey}"; return }
        val prefix = clips.takeWhile { it !== firing }.sumOf { it.durationMs.toDouble() }.toFloat()
        val releaseMs = start + if (event.has("releaseOffsetMs")) event.getFloat("releaseOffsetMs") else prefix + (cue - 1) * 1000f / firing.fps
        if (model.destroyedTick(id)?.let { atMs(it) <= releaseMs } == true) return
        val muzzle = firing.emitter("muzzle", firing.row(direction), cue - 1)
        val ex = x + (muzzle.first - firing.cellWidth * firing.anchorX) * firing.scale
        val ey = y + (muzzle.second - firing.cellHeight) * firing.scale
        addStroke(projectile,kind,releaseMs,ex,ey,tx,ty)
        val flight=Flight(releaseMs, ex, ey, tx, ty, if (event.has("flightMs")) projectile.copy(travelMs = event.getFloat("flightMs")) else projectile)
        flights += flight
        if(building.type=="mortar"&&kind=="shell")landingSensory(event,order,flight,sensoryPolicy?.mortarLanding)
    }


    /** Source V2Ticker keeps an identical throw registration, preserves phase while
     * replacing a row callback, and cancels it when a different body takes over. */
    private fun settleGiantThrows() {
        for(id in giantCommands.values.filter {it.flight!=null}.map {it.id}.distinct()) {
            val commands=actions[id] ?: continue
            val resolved=mutableListOf<Action>()
            var registration:Action?=null
            var pending:GiantCommand?=null
            val coldFloor=(scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick?.let {it*scene.tickDurationMs}
            var crossedCold=coldFloor==null
            fun finish() {
                val shot=pending ?: return
                val flight=requireNotNull(shot.flight)
                if(model.deathTick(id)?.let {atMs(it)<=flight.startMs}!=true) {
                    flights+=flight
                    addStroke(flight.profile,"boulder",flight.startMs,flight.fromX,flight.fromY,flight.toX,flight.toY)
                    landingSensory(shot.event,shot.order,flight,sensoryPolicy?.giantLanding?.effects,shot.tick)
                }
                pending=null
            }
            for(sourceCommand in commands) {
                val record=giantCommands[sourceCommand]
                if(!crossedCold && sourceCommand.startMs>=requireNotNull(coldFloor)) {
                    // Historical body reconstruction is visual-only: source cold apply
                    // never registered its ticker callback for a future cue to inherit.
                    finish();registration=null;crossedCold=true
                }
                val movement=model.facingBeforeEvent(id,sourceCommand.startMs/scene.tickDurationMs,record?.order ?: Int.MAX_VALUE)
                // Movement preserves an active verb. Once it finishes, a later walk
                // can own facing; an endpoint received during the throw cannot.
                val prior=registration
                val retained=if(prior!=null && (prior.endMs>sourceCommand.startMs ||
                    movement.second*scene.tickDurationMs<prior.endMs)) prior.facing else movement.first
                val command=record?.let {sourceCommand.copy(facing=requireNotNull(sensoryPolicy?.giantLanding).aim.facing(it.dx,it.dy,retained))} ?: sourceCommand
                // A command at the release boundary runs before that frame's callback.
                if(pending?.flight?.startMs?.let {it<command.startMs}==true)finish()
                val previous=registration?.takeIf {it.endMs>command.startMs}
                if(previous==null) {finish();registration=null}
                val shot=record?.takeIf {it.flight!=null}
                val oldClip=previous?.states?.singleOrNull()
                val clip=command.states.singleOrNull()
                val sameThrow=shot!=null&&previous!=null&&oldClip!=null&&clip!=null&&oldClip.key==clip.key&&
                    oldClip.frames[oldClip.row(previous.facing)].size==clip.frames[clip.row(command.facing)].size
                if(sameThrow) {
                    val oldFrames=oldClip!!.frames[oldClip.row(previous!!.facing)]
                    val newFrames=clip!!.frames[clip.row(command.facing)]
                    if(oldFrames==newFrames)continue // actual ticker keeps the original callback too
                    val phase=previous.phaseStartMs
                    val replacement=command.copy(phaseStartMs=phase,endMs=previous.endMs)
                    resolved+=replacement;registration=replacement
                    val releasedAt=phase+(requireNotNull(shot!!.flight).startMs-command.startMs)
                    // Row replacement does not synchronously re-enter the current frame.
                    pending=shot.takeIf {releasedAt>command.startMs}?.copy(flight=requireNotNull(shot.flight).copy(startMs=releasedAt))
                } else {
                    pending=shot;registration=command;resolved+=command
                }
            }
            finish();actions[id]=resolved
        }
        giantCommands.clear()
    }

    private fun landingSensory(event:JsonValue,order:Int,flight:Flight,sensory:List<HeroSensory>?,sourceTick:Int=event.getInt("t")) {
        val floor=(scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick ?: 0f
        if(sensory==null||flight.profile.travel==null||sourceTick<floor)return
        // Same admitted flight as the visible projectile. Optional landing art never
        // owns source onLand; the observed source start and release do.
        fun boundary(ms:Float):Float {val tick=ms/scene.tickDurationMs
            return if(tick*scene.tickDurationMs<ms)Math.nextUp(tick) else tick}
        val landing=flight.startMs+flight.profile.travelMs
        if(flight.profile.travelMs.isFinite()&&flight.profile.travelMs>0)
            builtSensoryCues+=HeroSensoryCue(order,boundary(landing),sensory,
                SensoryFlight(sourceTick.toFloat(),boundary(flight.startMs),scene.revision.events[order]))
    }

    private fun addStroke(projectile: ProjectileProfile,kind: String,start: Float,x: Float,y: Float,tx: Float,ty: Float) {
        projectile.stroke?.let { strokes += StrokeCue(start,x,y,tx,ty,it) }
        if(projectile.travel == null && kind == "laser" && projectile.stroke == null) unknown += "laserBeamStroke"
    }
    private fun chain(event: JsonValue,order:Int) {
        val building = scene.base.buildings.firstOrNull { it.id == event.getString("id") } ?: return
        val art = artByFrame[building.frameKey]
        val chain = art?.chain ?: run { unknown += "chain"; return }
        val body = art.clips[art.profile.getString("stand","idle")] ?: return
        var x = (building.tileX + building.footprintWidth / 2) * scene.base.tilePixels
        var y = (building.tileY + building.footprintHeight) * scene.base.tilePixels - body.cellHeight * body.scale * chain.originHeightFactor
        val tick = event.getInt("t");val start = atMs(tick)
        for(target in event.get("targets")) {
            val point=if(target.asInt() in gloamfangMotion) {
                val pose=gloamfangMotion.getValue(target.asInt()).sample(tick.toFloat(),order) ?: continue
                pose.x to pose.y
            } else if(target.asInt() in burrowMotion) {
                val pose=burrowMotion.getValue(target.asInt()).sample(tick.toFloat(),order) ?: continue
                pose.x to pose.y
            } else {
                val pose=model.pose(target.asInt(),tick.toFloat(),includeDead=true) ?: continue
                pose.x*unitScale to pose.y*unitScale
            }
            val tx=point.first;val ty=point.second+chain.targetOffsetY
            strokes += StrokeCue(start,x,y,tx,ty,chain.stroke)
            effects += Effect(start,chain.impact,tx,ty,0f,art.projectiles["tesla"]?.impactDepth ?: chain.stroke.depth)
            x = tx;y = ty
        }
    }

    /** Canonical hop endpoints are frozen at the event time, even when targets later move or die. */
    fun transientStrokes(tick: Float,output: MutableList<CombatStroke>) {
        output.clear();val now = tick * scene.tickDurationMs
        var low = 0;var high = strokes.size
        while(low < high) { val mid = (low + high) ushr 1;if(strokes[mid].start < now - longestStrokeMs) low = mid + 1 else high = mid }
        for(index in low until strokes.size) {
            val cue = strokes[index];val elapsed = now - cue.start
            if(elapsed < 0) break
            if(elapsed >= cue.profile.durationMs) continue
            for(layer in cue.profile.layers) output += CombatStroke(cue.fromX,cue.fromY,cue.toX,cue.toY,cue.profile.depth,
                layer.width,layer.color,layer.alpha * (1 - elapsed / cue.profile.durationMs))
        }
    }

    private fun ability(event: JsonValue,order: Int,events: List<JsonValue>) {
        val id = event.getInt("id"); val art = actorArt(id) ?: return
        if(id in gloamfangMotion || id in burrowMotion)return
        val name = event.getString("ability"); val clip = art.clips[name]
        if (clip == null) { unknown += "ability:${model.actorIdentity(id)}:$name"; return }
        val x = event.getFloat("x"); val y = event.getFloat("y")
        val direction = facing(event.getFloat("ix", x) - x, event.getFloat("iy", y) - y)
        val start = atMs(event.getInt("t"))
        if(name=="howl" && art.howl!=null) {
            if(model.poseBeforeEvent(id,event.getInt("t").toFloat(),order)==null)return
            val howl=art.howl
            require(howl.bodyState==name && howl.releaseFrame<=clip.frames.first().size && clip.fps>0)
            val retained=retainedFacing(id,event.getInt("t").toFloat(),order)
            val aimed=if(event.has("ix") && event.has("iy")) howl.aim.facing(
                (event.getFloat("ix")-x)*unitScale,(event.getFloat("iy")-y)*unitScale,retained) else retained
            val action=Action(start,start+clip.durationMs,listOf(clip),aimed)
            addAction(id,action,order)
            val release=start+(howl.releaseFrame-1)*1000f/clip.fps
            val pose=model.pose(id,release/scene.tickDurationMs) ?: return
            val end=minOf(release+howl.clip.durationMs,model.deathTick(id)?.let(::atMs) ?: Float.POSITIVE_INFINITY)
            if(end>release) pendingHowlEffects+=Triple(id,action,Effect(release,howl.clip,pose.x*unitScale+howl.offsetX,pose.y*unitScale+howl.offsetY,
                0f,pose.y*unitScale+howl.depthOffset,end-release))
            return
        }
        if(name=="maul" && art.maul!=null) {
            if(model.poseBeforeEvent(id,event.getInt("t").toFloat(),order)==null)return
            val maul=art.maul
            require(maul.bodyState==name && maul.releaseFrame<=clip.frames.first().size && clip.fps>0)
            val retained=retainedFacing(id,event.getInt("t").toFloat(),order)
            val aimed=if(event.has("ix") && event.has("iy") && (event.getFloat("ix")!=x || event.getFloat("iy")!=y)) direction else retained
            addAction(id,Action(start,start+clip.durationMs,listOf(clip),aimed),order)
            val first=start+(maul.releaseFrame-1)*1000f/clip.fps
            val firstPose=model.pose(id,first/scene.tickDurationMs) ?: return
            val ground=firstPose.y*unitScale+maul.groundOffsetY
            val death=model.deathTick(id)?.let(::atMs) ?: Float.POSITIVE_INFINITY
            for((release,offset) in listOf(first to maul.leftOffsetX,(first+maul.secondDelayMs) to maul.rightOffsetX)) {
                if(release>=death)continue
                val pose=model.pose(id,release/scene.tickDurationMs) ?: continue
                effects+=Effect(release,maul.clip,pose.x*unitScale+offset,ground,0f,
                    pose.y*unitScale+maul.depthOffset+lift(id),minOf(maul.clip.durationMs,death-release))
            }
            return
        }
        if(name=="firestorm" && art.firestorm!=null) {
            if(model.poseBeforeEvent(id,event.getInt("t").toFloat(),order)==null || !event.has("ix") || !event.has("iy"))return
            val fan=art.firestorm
            require(fan.bodyState==name && fan.pinFrames.last()<=clip.frames.first().size && clip.fps>0)
            var target=event.getFloat("ix")*unitScale to event.getFloat("iy")*unitScale
            event.getString("targetBuildingId",null)?.let { targetId ->
                val destroyed=events.take(order).any { it.getString("e")=="destroyed" && it.getString("id")==targetId }
                val building=scene.base.buildings.firstOrNull { it.id==targetId }
                if(!destroyed && building!=null) artByFrame[building.frameKey]?.buildingTarget?.let { offset ->
                    target=(building.tileX+building.footprintWidth/2)*scene.base.tilePixels+offset.first to
                        (building.tileY+building.footprintHeight)*scene.base.tilePixels+offset.second
                }
            }
            val facing=facing(target.first-x*unitScale,target.second-y*unitScale)
            addAction(id,Action(start,start+clip.durationMs,listOf(clip),facing),order)
            val release=start+(fan.pinFrames.first()-1)*1000f/clip.fps
            val end=minOf(release+fan.clip.durationMs,model.deathTick(id)?.let(::atMs) ?: Float.POSITIVE_INFINITY)
            if(end>release)fans+=Fan(id,start,release,end,clip,facing,target.first,target.second,fan)
            return
        }
        addAction(id, Action(start, start + clip.durationMs, listOf(clip), direction),order)
        authoredEffects(art, listOf(clip), start, x * unitScale, y * unitScale, direction, model.deathTick(id)?.let(::atMs), lift = lift(id))
        unknown += "abilityController:${model.actorIdentity(id)}:$name"
    }

    private fun detonate(event: JsonValue, order: Int) {
        val id = event.getInt("id"); val art = actorArt(id)
        detonateSensory(event,order,art)
        if(art==null)return
        if(model.actorIdentity(id)=="kegrunner")art.clips["prime"]?.takeIf { it.fps>0 }?.let { prime ->
            val detonation=event.getInt("t")
            val lead=maxOf(1f,ceil(prime.durationMs/scene.tickDurationMs))
            val start=maxOf((model.deployTick(id) ?: detonation).toFloat(),detonation-lead)
            val death=indexedActorEvents[id].orEmpty().mapNotNull { (_,e)->
                e.getInt("t").takeIf { e.getString("e") in setOf("troopDeath","detonate") }
            }.minOrNull()
            // Historical renderer2..9 has prime art but no exported stable-facing helper.
            // Preserve its body/blast fallback; never invent thresholds or fail later on GL.
            if(sharedFacingAim==null)unknown+="kegPrimeFacing"
            else if(start<detonation)kegPrimes[id]=KegPrimeCue(prime,start,detonation,order,death)
        }
        val clip = art.clips[art.profile.getString("detonate", "")] ?: return
        val key = clip.effectByCue["keg_blast"]; val effect = art.effects[key]
        val frame = clip.fxCues["keg_blast"]?.firstOrNull()
        if (effect == null || frame == null) { unknown += "detonateFx"; return }
        val tick = event.getInt("t"); val direction = model.motion(id, tick.toFloat()).facing
        val at = clip.emitter("keg", clip.row(direction), frame - 1)
        val x = event.getFloat("x") * unitScale + (at.first - clip.cellWidth * clip.anchorX) * clip.scale
        val y = event.getFloat("y") * unitScale + (at.second - clip.cellHeight * clip.anchorY) * clip.scale
        effects += Effect(atMs(tick) + (frame - 1) * 1000f / clip.fps, effect, x, y, 0f, Float.MAX_VALUE)
    }

    private fun detonateSensory(event:JsonValue,order:Int,art:CombatArt?) {
        val contract=sensoryPolicy?.kegDetonation ?: return
        val tick=event.getInt("t").toFloat()
        val floor=(scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick ?: 0f
        if(tick<floor)return
        val history=indexedActorEvents[event.getInt("id")].orEmpty()
        val birth=history.firstOrNull { (ordinal,e)->ordinal<order&&e.getString("e") in setOf("deploy","spawn","troopSpawn") }?.first
        // A same-tick death AFTER detonate cannot cancel its already-dying body.
        // Historical detonate is suppressed by source cold apply; ordinary death is durable.
        val ended=birth!=null&&history.any { (ordinal,e)->ordinal in (birth+1) until order&&
            (e.getString("e")=="troopDeath"||e.getString("e")=="detonate"&&e.getInt("t")>=floor) }
        val clip=if(birth==null||ended)null else art?.clips?.get(art.profile.getString("detonate",""))
        val frames=clip?.let { it.fxCues["keg_blast"] ?: listOf(contract.fallbackFrame) }.orEmpty()
        val frame=clip?.let { c->frames.filter { it in 1..c.frames.first().size }.minOrNull() }
        val delay=when {
            clip==null->0f
            clip.fps<=0->if(frame==1)0f else return // source static ticker never completes
            frame!=null->(frame-1)*1000f/clip.fps
            else->clip.durationMs // unentered/re-authored cue still completes exactly once
        }
        val atMs=tick*scene.tickDurationMs+delay
        val at=atMs/scene.tickDurationMs
        val boundary=if(at*scene.tickDurationMs<atMs)Math.nextUp(at) else at
        builtSensoryCues+=HeroSensoryCue(order,boundary,contract.effects,
            body=if(delay>0)SensoryBody(tick,scene.revision.events[order])else null)
    }

    private fun burnfield(event: JsonValue) {
        val id = event.getInt("id"); val art = actorArt(id)?.burnfield
        if (art == null) { unknown += "burnfield"; return }
        val start = atMs(event.getInt("t")); val until = atMs(event.getInt("until"))
        if (until <= start) return
        fields.filter { it.actorId == id && it.start != start && it.until > start && it.replacedAt > start }.forEach { it.replacedAt = start }
        val x = event.getFloat("x") * unitScale; val y = event.getFloat("y") * unitScale
        if (fields.none { it.actorId == id && it.start == start && it.x == x && it.y == y }) fields += Field(id, start, until, x, y, art)
    }

    private fun addAction(id: Int, command: Action, order: Int = Int.MAX_VALUE) {
        command.eventOrdinal=order
        val next = command
        val list = actions.getOrPut(id) { mutableListOf() }
        val previous = list.filter { it.startMs <= next.startMs }.maxByOrNull { it.startMs }
        if (previous != null && previous.endMs > next.startMs && previous.priority > next.priority) return
        if (previous != null && next.sourceStartMs > previous.sourceStartMs)
            list.removeAll { it.sourceStartMs == previous.sourceStartMs && it.startMs > next.startMs }
        val continuing = previous != null && previous.endMs >= next.startMs && next.looping && previous.looping && previous.states == next.states
        list += if (continuing) next.copy(phaseStartMs = previous!!.phaseStartMs) else next
    }
    private fun heroSkill(event: JsonValue, order: Int) {
        val id = event.getInt("id")
        val actorArt = actorArt(id)
        val art = actorArt ?: artByFrame[scene.actorFrames[event.getString("hero", "")]] ?: return
        val skill = event.getString("skill"); val phase = event.getString("phase", "impact")
        heroEffects(event,art,skill,phase,atMs(event.getInt("t")),order)
        if(actorArt==null) return
        val motion=heroMotion[id]
        if(motion!=null && atMs(event.getInt("t"))<motion.boundaryMs && motion.resumeStart(order)==null)return
        val spec = art.profile.get("heroSkills")?.let { it.get("$skill:$phase") ?: it.get("$skill:*") }
        if (spec == null) { unknown += "heroSkill:$skill:$phase"; return }
        val sourceClip = art.clips[spec.getString("state")] ?: run { unknown += "heroBody:$skill:$phase"; return }
        val tick = event.getInt("t"); val start = motion?.resumeStart(order) ?: atMs(tick)
        val until = if (phase in setOf("windup", "fakeDeath") && event.getInt("until", tick) > tick) event.getInt("until")
            else tick + (art.heroBodyDefaultTicks[skill] ?: art.heroBodyDefaultTicks["default"] ?: run { unknown += "heroClock:$skill"; return })
        val end = atMs(until); val pose = model.pose(id, tick.toFloat()) ?: return
        val visible=motion?.sample(start,order)
        val from = visible?.let { it.x to it.y } ?: ((event.getFloat("fromX", pose.x) * unitScale) to (event.getFloat("fromY", pose.y) * unitScale))
        val target = if (skill in setOf("cannonball", "crimsonDash") && event.has("toX") && event.has("toY"))
            event.getFloat("toX") * unitScale to event.getFloat("toY") * unitScale else null
        val direction = visible?.facing ?: target?.let { facing(it.first - from.first, it.second - from.second) } ?: model.motion(id, tick.toFloat()).facing
        val originalStart=atMs(tick);val phaseElapsed=start-originalStart
        val transitions = spec.get("transitions")?.toList().orEmpty()
        val activeTransition=transitions.lastOrNull { it.getFloat("atMs")<=phaseElapsed }
        var clip=activeTransition?.let { art.clips[it.getString("state")] } ?: sourceClip
        // resumeHeroSkillPhase forwards elapsed time: fake death holds its final frame, and
        // an already eaten Silent But Deadly prefix resumes its bloat stage immediately.
        if(phaseElapsed>0 && skill=="rageQuit" && phase=="fakeDeath")clip=clip.copy(frames=clip.frames.map { listOf(it.last()) })
        val upcoming=transitions.filter { originalStart+it.getFloat("atMs")>start }
        val firstEnd = upcoming.firstOrNull()?.getFloat("atMs")?.let { minOf(end, originalStart + it) } ?: end
        addAction(id, Action(start, firstEnd, listOf(clip), direction, spec.getInt("priority"),
            looping = !(activeTransition?.getBoolean("once") ?: spec.getBoolean("once")),
            once = activeTransition?.getBoolean("once") ?: spec.getBoolean("once"), origin = from, target = target,sourceStartMs=originalStart))
        for ((index, transition) in upcoming.withIndex()) {
            val at = originalStart + transition.getFloat("atMs"); if (at >= end) continue
            val body = art.clips[transition.getString("state")] ?: continue
            val phaseEnd = upcoming.getOrNull(index + 1)?.getFloat("atMs")?.let { minOf(end, originalStart + it) } ?: end
            addAction(id, Action(at, phaseEnd, listOf(body), direction, spec.getInt("priority"),
                looping = !transition.getBoolean("once"), once = transition.getBoolean("once"), origin = from, sourceStartMs = originalStart))
        }
    }
    private fun heroEffects(event: JsonValue,art: CombatArt,skill: String,phase: String,start: Float,order: Int) {
        val fx = art.heroEffects["$skill:$phase"] ?: art.heroEffects["$skill:*"]
        if(fx == null) unknown += "heroEffects:$skill:$phase"
        else {
            // Source sweep images own a final-frame hold beyond their animation. They survive
            // body-state changes independently and never replay callbacks when the clock seeks.
            if(fx.effects.isNotEmpty()) {
                val x = event.getFloat("x") * unitScale;val y = event.getFloat("y") * unitScale
                for(effect in fx.effects) {
                    if(effect.targetActorCenterAtCast) {
                        val target=event.get("target")?.takeIf { it.isNumber }?.asInt() ?: continue
                        val pose=model.poseBeforeEvent(target,event.getInt("t").toFloat(),order) ?: continue
                        val victim=actorPose(target,event.getInt("t").toFloat(),pose,order) ?: continue
                        val clip=victim.clip
                        // Phaser getCenter uses the sprite's unmirrored origin and cell bounds.
                        effects += Effect(start,effect.clip,victim.x+(.5f-clip.anchorX)*clip.cellWidth*clip.scale,
                            victim.y+(.5f-clip.anchorY)*clip.cellHeight*clip.scale,0f,effect.depth,effect.lifetimeMs)
                        continue
                    }
                    val caster = effect.actorToEventFallbackMs?.let {
                        model.poseBeforeEvent(event.getInt("id"),event.getInt("t").toFloat(),order)?.let { pose ->
                            actorPose(event.getInt("id"),event.getInt("t").toFloat(),pose,order)
                        }
                    }
                    if(effect.actorToEventFallbackMs!=null && caster==null) {
                        effects += Effect(start,effect.clip,x,y,0f,effect.depth,effect.actorToEventFallbackMs)
                        continue
                    }
                    val tail = effect.travelTailMs
                    if(tail == null) effects += Effect(start,effect.clip,x,y,0f,effect.depth,effect.lifetimeMs)
                    else {
                        val tick=event.getInt("t")
                        val ticks=if(phase in setOf("windup","fakeDeath") && event.getInt("until",tick)>tick) event.getInt("until")-tick
                            else art.heroBodyDefaultTicks[skill] ?: art.heroBodyDefaultTicks["default"]
                        if(ticks == null) { unknown += "heroClock:$skill";continue }
                        val duration=atMs(ticks)
                        // Authored radial offsets are already render pixels. Event coordinates
                        // alone use unitScale; facing must not mirror world-space spokes.
                        val offset = effect.travelOffset
                        val from = if(caster!=null) caster.x to caster.y else if(offset == null && effect.rangePx==null) event.getFloat("fromX",x/unitScale)*unitScale to event.getFloat("fromY",y/unitScale)*unitScale else x to y
                        var to = if(caster!=null) x to y else if(offset == null) event.getFloat("toX",x/unitScale)*unitScale to event.getFloat("toY",y/unitScale)*unitScale else x+offset.first to y+offset.second
                        effect.rangePx?.let { range ->
                            val dx=to.first-x;val dy=to.second-y;val length=hypot(dx,dy)
                            if(length>0) to=x+dx*range/length to y+dy*range/length
                        }
                        effects += Effect(start,effect.clip,from.first,from.second,0f,effect.depth,
                            maxOf(duration,effect.clip.durationMs)+tail,to,duration)
                    }
                }
            }
            if(fx.sensoryPending) {
                if(sensoryPolicy==null || fx.sensory.isEmpty())unknown += "heroSensory:$skill:$phase"
                else builtSensoryCues+=HeroSensoryCue(order,event.getInt("t"),fx.sensory)
            }
        }
    }
    private fun trap(event: JsonValue) {
        val id = event.getString("id"); val building = buildingsById[id] ?: return
        // The source controller consumes one episode, including traps already
        // spent in the frozen snapshot. Repeated events cannot re-arm it.
        if (building.trapSpent || id in trapSpentAt) return
        val start = atMs(event.getInt("t"))
        val boundary = (scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick ?: 0f
        if (event.getInt("t") < boundary) { trapSpentAt[id] = start; return }
        val art = artByFrame[building.frameKey] ?: return
        val clips = art.profile.get("attack")?.mapNotNull { art.clips[it.asString()] }.orEmpty()
        if (clips.isEmpty()) { unknown += "trap:${building.frameKey}"; return }
        val end = start + clips.sumOf { it.durationMs.toDouble() }.toFloat()
        buildingActions.getOrPut(id) { mutableListOf() } += Action(start, end, clips, "s")
        trapSpentAt[id] = end
    }

    private fun compileSpawnWork() {
        // Each source spawn schedules its own stop callback. A second spawn
        // while working does not restart the body or extend an earlier timer.
        val transitions = mutableMapOf<String,MutableList<Pair<Float,Boolean>>>()
        for ((_,event) in indexedEvents) {
            checkpoint()
            if (event.getString("e") != "spawn") continue
            val id = event.getString("from",null) ?: continue
            val building = buildingsById[id]?.takeIf { it.type == "dragonnest" } ?: continue
            val work = artByFrame[building.frameKey]?.spawnWork ?: continue
            val tick = event.getInt("t")
            if(tick < ((scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick ?: 0f))continue
            if (model.isDestroyed(id,tick.toFloat())) continue
            val start = atMs(tick)
            transitions.getOrPut(id) { mutableListOf() }.apply {
                add(start to true); add(start + work.durationMs to false)
            }
        }
        for ((id,values) in transitions) {
            checkpoint()
            val art = requireNotNull(artByFrame[buildingsById.getValue(id).frameKey])
            val clip = requireNotNull(art.clips[requireNotNull(art.spawnWork).state]) { "Admitted Dragon Nest work clip missing" }
            var began:Float? = null
            buildingWork[id] = buildList {
                for ((at,working) in values.sortedWith(compareBy<Pair<Float,Boolean>> { it.first }.thenBy { if(it.second)0 else 1 })) {
                    if (working && began == null) began = at
                    if (!working && began != null) {
                        if (at > began!!) add(Action(began!!,at,listOf(clip),"s",looping=true))
                        began = null
                    }
                }
            }
        }
    }

    private fun compileActorBodyFeedback() {
        data class Cue(val ms:Float,val order:Int,val event:JsonValue?=null,val action:Action?=null,
            val damage:Double?=null,val flinch:Boolean=false,val reset:Boolean=false)
        data class Move(val x:Float,val y:Float,val tx:Float,val ty:Float,val start:Float,val end:Float)
        val admitted=model.actorIds.filter { id ->
            id !in automaticArchiveActors && id !in burrowMotion && id !in gloamfangMotion &&
                actorArt(id)?.let { it.bodyMoveSnapTiles!=null && it.profile.has("kind") && (it.profile.has("hit") || it.damagedBody!=null) }==true
        }.toSet()
        if(admitted.isEmpty())return
        feedbackActors+=admitted
        val boundary=(scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick?.times(scene.tickDurationMs) ?: 0f
        val deliveries=PositionDelivery.compile(scene.revision.events,scene.positionCadenceTicks,scene.summonedPositionCadenceTicks,scene.tickDurationMs,boundary/scene.tickDurationMs)
        val byActor=admitted.associateWith { mutableListOf<Cue>() }
        for((order,event) in indexedEvents) {
            checkpoint()
            val type=event.getString("e");val at=atMs(event.getInt("t"))
            if(type=="chain") {
                if(event.getString("id") !in hitBuildings)continue
                event.get("targets")?.forEachIndexed { index,target ->
                    val damage=event.get("dmg")?.get(index)?.asDouble() ?: 0.0
                    if(damage>0)byActor[target.asInt()]?.add(Cue(at,order,damage=damage))
                }
                continue
            }
            val id=event.get(if(type=="hit")"target" else "id")?.takeIf { it.isNumber }?.asInt() ?: continue
            val list=byActor[id] ?: continue
            when(type) {
                "hit"->list+=Cue(at,order,damage=event.getDouble("dmg",0.0),flinch=true)
                "deploy","spawn","troopSpawn","heal","troopDeath","detonate"->list+=Cue(at,order,event)
                "pos"->if(at<boundary)list+=Cue(at,order,event) else deliveries[order]?.takeUnless { it.skip }?.let { list+=Cue(it.startTick*scene.tickDurationMs,order,event) }
            }
        }
        for(id in admitted) {
            checkpoint()
            val art=requireNotNull(actorArt(id));val list=byActor.getValue(id)
            val moveTolerance=requireNotNull(art.bodyMoveSnapTiles)*scene.base.tilePixels
            val aim=requireNotNull(art.bodyFacingAim) { "Admitted body facing contract missing" }
            for(action in actions[id].orEmpty())list+=Cue(action.startMs,action.eventOrdinal,action=action)
            if(boundary>0)list+=Cue(boundary,Int.MIN_VALUE,reset=true)
            list.sortWith(compareBy<Cue> { it.ms }.thenBy { it.order })
            val maximum=scene.actorMaxHp[id]?.toDouble() ?: art.damagedBody?.maxHp?.toDouble()
            var hp=maximum;var alive=false;var x=0f;var y=0f;var facing="s"
            var move:Move?=null;var body:Action?=null;var resting=false
            val flinches=mutableListOf<Action>();val rests=mutableListOf<Float>();val poses=mutableListOf<BodyFeedbackPose>()
            fun publish(at:Float) { if(alive)poses+=BodyFeedbackPose(at,facing,move!=null) }
            fun position(at:Float) { move?.let { m ->
                val ratio=if(m.end<=m.start)1f else ((at-m.start)/(m.end-m.start)).coerceIn(0f,1f)
                x=m.x+(m.tx-m.x)*ratio;y=m.y+(m.ty-m.y)*ratio
            } }
            fun rest(at:Float) {
                val idle=alive && body==null && move==null
                if(idle && !resting) {
                    nearestStandTarget(at,Int.MAX_VALUE,x,y)?.let { target ->
                        facing=aim.facing((target.first-x)/scene.base.tilePixels,(target.second-y)/scene.base.tilePixels,facing)
                    }
                    if(id in actorDamagedAt)rests+=at
                }
                resting=idle
                publish(at)
            }
            fun advance(at:Float) {
                while(true) {
                    val next=minOf(body?.endMs ?: Float.POSITIVE_INFINITY,move?.end ?: Float.POSITIVE_INFINITY)
                    // Canonical events at the release boundary run before that
                    // frame's completion callbacks; an equal-time hit cannot
                    // borrow idle ownership from an attack or move still ending.
                    if(next>=at || !next.isFinite())break
                    position(next)
                    if(move?.end==next)move=null
                    if(body?.endMs==next)body=null
                    rest(next)
                }
                position(at)
            }
            for(cue in list) {
                checkpoint();advance(cue.ms)
                if(cue.reset) { body=null;move=null;resting=false;rest(cue.ms) }
                cue.action?.let { action ->
                    if(alive) {
                        if(body in flinches) {
                            val index=flinches.indexOf(body)
                            flinches[index]=flinches[index].copy(endMs=cue.ms)
                        }
                        body=action;facing=action.facing;resting=false
                    }
                }
                val event=cue.event
                when(event?.getString("e")) {
                    "deploy","spawn","troopSpawn"->{
                        alive=true;x=event.getFloat("x")*unitScale;y=event.getFloat("y")*unitScale
                        val spawn=art.clips[art.profile.getString("spawn","")]
                        body=spawn?.let { Action(cue.ms,cue.ms+it.durationMs,listOf(it),facing) }
                        rest(cue.ms)
                    }
                    "troopDeath","detonate"->{alive=false;body=null;move=null;resting=false}
                    "heal"->if(alive && hp!=null && maximum!=null)hp=minOf(maximum,hp!!+event.getDouble("amount",0.0).coerceAtLeast(0.0))
                    "pos"->if(alive) {
                        val tx=event.getFloat("x")*unitScale;val ty=event.getFloat("y")*unitScale
                        val duration=deliveries[cue.order]?.durationMs ?: 0f
                        if(abs(tx-x)<moveTolerance && abs(ty-y)<moveTolerance || duration<=0) { x=tx;y=ty;move=null }
                        else {
                            if(body==null)facing=aim.facing((tx-x)/scene.base.tilePixels,(ty-y)/scene.base.tilePixels,facing)
                            move=Move(x,y,tx,ty,cue.ms,cue.ms+duration)
                        }
                        rest(cue.ms)
                    }
                }
                if(cue.damage!=null && alive) {
                    if(hp!=null)hp=(hp!!-cue.damage).coerceAtLeast(0.0)
                    val damaged=art.damagedBody?.let { hp!=null && maximum!=null && hp!!/maximum<=it.healthRatio }==true
                    if(damaged && id !in actorDamagedAt) {
                        actorDamagedAt[id]=cue.ms
                        if(resting) { resting=false;rest(cue.ms) }
                    }
                    // Persistent damage is restored from the full canonical prefix;
                    // transient flinches begin only in the currently owned interval.
                    if(cue.flinch && cue.ms>=boundary && !damaged && body==null && move==null) {
                        art.clips[art.profile.getString("hit","")]?.let { clip ->
                            val hit=Action(cue.ms,cue.ms+clip.durationMs,listOf(clip),facing,eventOrdinal=cue.order)
                            flinches+=hit;body=hit;resting=false
                        }
                    }
                }
                publish(cue.ms)
            }
            advance(Float.POSITIVE_INFINITY)
            actions.getOrPut(id) { mutableListOf() }+=flinches.filter { it.endMs>it.startMs }
            damagedRestStarts[id]=rests
            feedbackPoses[id]=poses
        }
    }

    private fun authoredEffects(art: CombatArt, clips: List<AuthoredClip>, start: Float, x: Float, y: Float,
        facing: String, canceledAt: Float?, building: Boolean = false, towardX: Float = x, lift: Float = 0f) {
        var prefix = 0f
        for (clip in clips) {
            checkpoint()
            for ((cue, key) in clip.effectByCue) {
                if (cue == "breath") continue // The stream owns this cue and its one contact impact.
                val effect = art.effects[key] ?: continue
                for (frame1 in clip.fxCues[cue].orEmpty()) {
                    val whenMs = start + prefix + (frame1 - 1) * 1000f / clip.fps
                    if (canceledAt != null && canceledAt <= whenMs) continue
                    val emitterName = art.fxEmitters[cue] ?: if (building) "muzzle" else null
                    val point = when {
                        cue == "dust" || cue == "soil" -> x to y
                        cue == "slam" && art.slamOffset != null -> (x + kotlin.math.sign(towardX - x) * art.slamOffset.first) to (y + art.slamOffset.second)
                        emitterName != null -> clip.emitter(emitterName, clip.row(facing), frame1 - 1).let { point ->
                            (x + (point.first - clip.cellWidth * clip.anchorX) * clip.scale) to
                                (y + (point.second - clip.cellHeight * if (building) 1f else clip.anchorY) * clip.scale)
                        }
                        else -> { unknown += "effectPlacement:$cue"; continue }
                    }
                    val rotation = if (building) clip.emitters?.get("axis")?.get(clip.row(facing))?.let { row -> row.getFloat((frame1 - 1).coerceAtMost(row.size - 1)) } ?: 0f
                        else if (emitterName != null) art.fxFacingRotationDeg[facing] ?: 0f else 0f
                    effects += Effect(whenMs, effect, point.first, point.second, rotation,
                        (if (cue == "dust" || cue == "soil") y - 1 else y + 1) + lift)
                }
            }
            prefix += clip.durationMs
        }
    }

    /** Keyed body callbacks are compiled once. A later body can suppress a future
     * cue, but a scene-pooled dust/rend already emitted owns its remaining lifetime. */
    private fun gloamfangEffects(id:Int,timeline:GloamfangMotionTimeline,art:CombatArt) {
        for(action in timeline.bodyActions) {
            if(action.looping)continue
            val clip=art.clips[action.state] ?: continue
            val howl=art.howl?.takeIf { it.bodyState==action.state }
            if(howl!=null) {
                val release=action.phaseStartMs+(howl.releaseFrame-1)*1000f/clip.fps
                val pose=timeline.sample(release/scene.tickDurationMs) ?: continue
                if(pose.bodyOwner!=action.owner)continue
                val end=minOf(release+howl.clip.durationMs,model.deathTick(id)?.let(::atMs) ?: Float.POSITIVE_INFINITY)
                if(end>release)effects+=Effect(release,howl.clip,pose.x+howl.offsetX,pose.y+howl.offsetY,
                    0f,pose.groundY+howl.depthOffset,end-release)
                continue
            }
            for((cue,key) in clip.effectByCue) {
                val effect=art.effects[key] ?: continue
                for(frame1 in clip.fxCues[cue].orEmpty()) {
                    val release=action.phaseStartMs+(frame1-1)*1000f/clip.fps
                    val pose=timeline.sample(release/scene.tickDurationMs) ?: continue
                    if(pose.bodyOwner!=action.owner)continue
                    val groundContact=cue=="dust" || cue=="soil"
                    val emitter=art.fxEmitters[cue]
                    val point=if(groundContact) pose.x to pose.y else if(emitter!=null) {
                        clip.emitter(emitter,clip.row(pose.controllerFacing),frame1-1).let { at ->
                            pose.x+(at.first-clip.cellWidth*clip.anchorX)*clip.scale to
                                pose.y+(at.second-clip.cellHeight*clip.anchorY)*clip.scale
                        }
                    } else { unknown+="effectPlacement:$cue";continue }
                    effects+=Effect(release,effect,point.first,point.second,
                        if(groundContact) 0f else art.fxFacingRotationDeg[pose.controllerFacing] ?: 0f,
                        pose.groundY+if(groundContact) -1 else 1)
                }
            }
        }
    }

    private fun burrowEffects(timeline:BurrowMotionTimeline,art:CombatArt) {
        for(action in timeline.bodyActions) {
            if(action.looping)continue
            val clip=art.clips.getValue(action.state)
            for((cue,key) in clip.effectByCue) for(frame in clip.fxCues[cue].orEmpty()) {
                val release=action.phaseStartMs+(frame-1)*1000f/clip.fps
                if(release<timeline.startMs || release<action.startMs || (release>=action.endMs && !(frame==1 && release==action.startMs)))continue
                // Frame one dispatches during registration; later keys run after same-time events.
                val pose=timeline.sampleMs(release,if(frame==1 && action.eventOrdinal<Int.MAX_VALUE)action.eventOrdinal+1 else null) ?: continue
                if(pose.bodyOwner!=action.owner || !pose.alive)continue
                val effect=art.effects[key] ?: continue
                val ground=cue=="soil" || cue=="dust"
                val emitter=art.fxEmitters[cue]
                val point=if(ground)pose.x to pose.y else if(emitter!=null) {
                    clip.emitter(emitter,clip.row(pose.controllerFacing),frame-1).let {
                        pose.x+(it.first-clip.cellWidth*clip.anchorX)*clip.scale to pose.y+(it.second-clip.cellHeight*clip.anchorY)*clip.scale }
                } else { unknown+="effectPlacement:$cue";continue }
                effects+=Effect(release,effect,point.first,point.second,if(ground)0f else art.fxFacingRotationDeg[pose.controllerFacing] ?: 0f,
                    pose.y+if(cue=="soil")art.burrowMotion!!.soilDepthOffset else if(ground)-1f else 1f)
            }
        }
    }

    private fun legacyMeleeEffects(timeline:LegacyMeleeTimeline,art:CombatArt) {
        for(body in timeline.bodies.filter { it.automatic }) {
            val clip=art.clips.getValue(body.state)
            for((cue,key) in clip.effectByCue)for(frame in clip.fxCues[cue].orEmpty()) {
                val release=body.phaseStartMs+(frame-1)*1000f/clip.fps
                val pose=timeline.sample(release) ?: continue
                if(pose.body.owner!=body.owner || !pose.alive)continue
                val effect=art.effects[key] ?: continue;val ground=cue=="dust" || cue=="soil"
                val emitter=art.fxEmitters[cue]
                val point=when {
                    ground->pose.x to pose.y
                    cue=="slam" && art.slamOffset!=null->{val target=nearestStandTarget(release,Int.MAX_VALUE,pose.x,pose.y)
                        pose.x+kotlin.math.sign((target?.first ?: pose.x)-pose.x)*art.slamOffset.first to pose.y+art.slamOffset.second}
                    emitter!=null->clip.emitter(emitter,clip.row(pose.controllerFacing),frame-1).let {
                        pose.x+(it.first-clip.cellWidth*clip.anchorX)*clip.scale to pose.y+(it.second-clip.cellHeight*clip.anchorY)*clip.scale }
                    else->{unknown+="effectPlacement:$cue";continue}
                }
                effects+=Effect(release,effect,point.first,point.second,if(ground || emitter==null)0f else art.fxFacingRotationDeg[pose.controllerFacing] ?: 0f,
                    pose.y+if(ground)-1f else 1f)
            }
        }
    }

    fun actor(id: Int, tick: Float, hitCueTicks: Float = 0f, afterCueTick: Float = Float.NEGATIVE_INFINITY): CombatSprite? =
        actorPose(id, tick, primeFloor=afterCueTick)?.let { it.copy(hit = model.wasHit(id.toString(), tick, hitCueTicks, afterCueTick), depth = it.depth + lift(id)) }

    private fun retainedFacing(id:Int,tick:Float,order:Int=Int.MAX_VALUE):String {
        val movement=model.facingBeforeEvent(id,tick,order)
        val prior=actions[id]?.lastOrNull { it.startMs<=tick*scene.tickDurationMs }
        return if(prior!=null && prior.startMs>=movement.second*scene.tickDurationMs) prior.facing else movement.first
    }

    private fun actorPose(id: Int, tick: Float, eventPose: ActorPose? = null, beforeEventOrdinal:Int?=null, primeFloor:Float=Float.NEGATIVE_INFINITY): CombatSprite? {
        val art = actorArt(id) ?: return null
        burrowMotion[id]?.let { timeline->
            val pose=timeline.sample(tick,beforeEventOrdinal) ?: return null
            val clip=art.clips.getValue(pose.clipState);val elapsed=tick*scene.tickDurationMs-pose.phaseStartMs
            var alpha=1f
            if(!pose.alive) {
                val hold=clip.durationMs+art.deathHoldMs
                if(elapsed>=hold+art.deathFadeMs)return null
                if(elapsed>hold)alpha=(1-(elapsed-hold)/art.deathFadeMs).coerceIn(0f,1f)
            }
            return sprite(clip,elapsed,pose.facing,pose.x,pose.y,alpha,looping=pose.alive && pose.looping)
        }
        gloamfangMotion[id]?.let { timeline ->
            val pose=timeline.sample(tick,beforeEventOrdinal) ?: return null
            val clip=art.clips[pose.clipState] ?: return null
            val elapsed=tick*scene.tickDurationMs-pose.phaseStartMs
            var alpha=1f
            if(!pose.alive) {
                val holdUntil=clip.durationMs+art.deathHoldMs
                if(elapsed>=holdUntil+art.deathFadeMs)return null
                if(elapsed>holdUntil)alpha=(1-(elapsed-holdUntil)/art.deathFadeMs).coerceIn(0f,1f)
            }
            return sprite(clip,elapsed,pose.facing,pose.x,pose.y,alpha,depth=pose.groundY,
                looping=pose.alive && pose.looping)
        }
        val death = if(eventPose==null) model.deathTick(id) else null; val now = tick * scene.tickDurationMs
        val pose = eventPose ?: model.pose(id, minOf(tick, death?.toFloat() ?: tick), includeDead = true) ?: return null
        val heroPose=heroMotion[id]?.sample(now,beforeEventOrdinal)
        val legacyPose=legacyMelee[id]?.sample(now,beforeEventOrdinal)
        val x = heroPose?.x ?: legacyPose?.x ?: (pose.x * unitScale); val y = heroPose?.y ?: legacyPose?.y ?: (pose.y * unitScale)
        if (death != null && tick >= death) {
            val clip = art.clips[art.profile.getString("death", "death")] ?: return null
            val elapsed = now - atMs(death); val holdUntil = clip.durationMs + art.deathHoldMs
            if (elapsed >= holdUntil + art.deathFadeMs) return null
            val alpha = if (elapsed <= holdUntil) 1f else (1 - (elapsed - holdUntil) / art.deathFadeMs).coerceIn(0f, 1f)
            return sprite(clip, elapsed, legacyPose?.body?.facing ?: heroPose?.facing ?: model.motion(id, death.toFloat()).facing, x, y, alpha, looping = false)
        }
        if (!pose.visible) return null
        kegPrimes[id]?.let { prime ->
            val cold=(scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick ?: 0f
            val start=maxOf(prime.startTick,cold,primeFloor)
            if(tick>=start && tick<prime.detonateTick && (prime.deathTick==null || tick<prime.deathTick)) {
                val origin=model.pose(id,start,includeDead=true) ?: return@let
                val ox=origin.x*unitScale;val oy=origin.y*unitScale
                val prior=model.facingBeforeEvent(id,start,prime.order).first
                val target=nearestStandTarget(start*scene.tickDurationMs,prime.order,ox,oy)
                val direction=target?.let { requireNotNull(sharedFacingAim).facing(it.first-ox,it.second-oy,prior) } ?: prior
                return sprite(prime.clip,(tick-start)*scene.tickDurationMs,direction,x,y,looping=true)
                    .copy(kegPrime=KegPrimePresentation(start,prime.detonateTick))
            }
        }
        (if(beforeEventOrdinal==null)actionAt(actions[id],now) else actionBeforeCapture(actions[id],now))
            ?.takeUnless { id in feedbackActors && it.startMs < ((scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick?.times(scene.tickDurationMs) ?: 0f) }
            ?.let { return actionSprite(it,now,x,y,heroPose) }
        legacyPose?.let { return sprite(art.clips.getValue(it.body.state),now-it.body.phaseStartMs,it.body.facing,x,y,looping=it.body.looping) }
        val spawnedAt = model.deployTick(id)?.let(::atMs) ?: now
        art.clips[art.profile.getString("spawn", "")]?.let { spawn ->
            val restored=id in feedbackActors && spawnedAt < ((scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick?.times(scene.tickDurationMs) ?: 0f)
            if (!restored && now - spawnedAt < spawn.durationMs) return sprite(spawn, now - spawnedAt, model.motion(id, tick).facing, x, y, looping = false)
        }
        val motion = heroPose?.let { ActorMotion(it.facing,it.moving) }
            ?: bodyFeedbackPose(id,now)?.let { ActorMotion(it.facing,it.moving) } ?: model.motion(id, tick)
        val damaged=actorDamagedAt[id]?.let { now>=it }==true
        val state = if (motion.moving) art.profile.getString("battleMove", art.profile.getString("move", "walk"))
            else if(damaged) art.profile.getString("damaged",art.profile.getString("stand","idle")) else art.profile.getString("stand", "idle")
        val clip = art.clips[state] ?: return null
        // These cast-origin samples have no heading. Source stand() keeps the
        // last rendered direction until a newer move or attack turns the actor.
        val maulBody=art.maul?.let { art.clips[it.bodyState] };val howlBody=art.howl?.let { art.clips[it.bodyState] }
        val afterControlledAbility=(maulBody!=null || howlBody!=null) && actions[id]?.any {
            it.startMs<=now && (maulBody in it.states || howlBody in it.states)
        } == true
        // Source Howl completion registers a fresh prowl loop. Its later row
        // changes keep that phase; a newer body action owns its own transition.
        val lastAction=actions[id]?.lastOrNull { it.startMs<=now }
        val loopElapsed=if(damaged && !motion.moving)now-(lastTimeAt(damagedRestStarts[id],now) ?: actorDamagedAt.getValue(id))
            else if(howlBody!=null && lastAction!=null && howlBody in lastAction.states && lastAction.endMs<=now) now-lastAction.endMs else now
        return sprite(clip, loopElapsed, if(afterControlledAbility) retainedFacing(id,tick) else motion.facing, x, y, looping = true)
    }
    fun hasActorArt(id: Int) = actorArt(id) != null
    /** Display health for the floating HP bars (HpBars): the same ledgers the damaged-body art reads;
     * null when the server or the app supplied no maximum for that entity. */
    fun buildingHealthAt(id: String, tick: Float): BuildingHealthVisualModel.Health? = buildingHealth.at(id, tick)
    fun actorHealthAt(id: Int, tick: Float): ActorHealthVisualModel.Health? = actorHealth.at(id, tick)
    fun building(id: String, tick: Float, hitCueTicks: Float = 0f, afterCueTick: Float = Float.NEGATIVE_INFINITY, frameKey: String? = null, frameSinceTick: Int = 0): CombatSprite? =
        buildingPose(id, tick, frameKey, frameSinceTick)?.let { it.copy(hit = model.wasHit(id, tick, hitCueTicks, afterCueTick)) }

    private fun buildingPose(id: String, tick: Float, frameKey: String? = null, frameSinceTick: Int = 0): CombatSprite? {
        val b = buildingsById[id] ?: return null
        val art = artByFrame[frameKey ?: b.frameKey] ?: return null
        val x = (b.tileX + b.footprintWidth / 2) * scene.base.tilePixels
        val y = (b.tileY + b.footprintHeight) * scene.base.tilePixels
        val now = tick * scene.tickDurationMs
        model.destroyedTick(id)?.takeIf { tick >= it }?.let { destroyed ->
            val clip = art.clips[art.profile.getString("death", "collapse")] ?: return null
            val elapsed = now - atMs(destroyed)
            // Source ware/building.ts collapse(): the authored sink plays in full, then the
            // sprite rests on the ruin cell rather than the sliver in the last frame.
            val ruin = BuildingRuinArt.forBuilding(b.type, b.frameKey)?.takeIf { elapsed >= clip.durationMs }
            return sprite(clip, elapsed, "s", x, y, looping = false).copy(ruin = ruin)
        }
        val action = actionStartedAt(buildingActions[id], now)
        if (action != null && now < action.endMs) return actionSprite(action, now, x, y)
        // Source defense controllers retain the last selected aim row after
        // fire/reload, including the damaged resting loop. Seeking must use
        // only shots at or before this time, rather than the final battle aim.
        val aim = action?.facing ?: "s"
        if (b.trapSpent || trapSpentAt[id]?.let { now >= it } == true) {
            val spent = art.clips[art.profile.getString("death", "sprung")] ?: return null
            return sprite(spent, Float.MAX_VALUE, "s", x, y, looping = false)
        }
        buildingHealth.at(id,tick)?.damagedSinceTick?.let { since ->
            val damaged=art.clips[art.profile.getString("damaged","damaged")]
            if(damaged != null) return sprite(damaged,now-atMs(maxOf(since,frameSinceTick)),aim,x,y,looping=true)
        }
        actionAt(buildingWork[id],now)?.let { return actionSprite(it,now,x,y) }
        // battleStand is exported from the defender-view source controller;
        // owner/home rest remains profile.stand. Retained packs may omit it.
        val idle = art.clips[art.profile.getString("battleStand", art.profile.getString("stand", "idle"))] ?: return null
        return sprite(idle, now, aim, x, y, looping = true)
    }
    /** A reused output list bounds frame allocations; shot lifetime is sampled, never rescheduled. */
    fun transientSprites(tick: Float, output: MutableList<CombatSprite>, afterCueTick:Float=Float.NEGATIVE_INFINITY,
        serviceHitY:((HitFeedbackCue)->Float)?=null) {
        output.clear();hitFeedback?.sprites(tick,afterCueTick,output,serviceHitY); val now = tick * scene.tickDurationMs
        val maxLifetime = longestFlightMs
        var low = 0; var high = flights.size
        while (low < high) { val mid = (low + high) ushr 1; if (flights[mid].startMs < now - maxLifetime) low = mid + 1 else high = mid }
        for (index in low until flights.size) {
            val flight = flights[index]
            if (flight.startMs > now) break
            val p = flight.profile; val elapsed = now - flight.startMs
            if (elapsed < p.travelMs) {
                val t = elapsed / p.travelMs; val dx = flight.toX - flight.fromX; val dy = flight.toY - flight.fromY
                val x = flight.fromX + dx * t; val groundY = flight.fromY + dy * t
                val lift = p.arc * 4 * t * (1 - t)
                p.shadow?.let { shadow ->
                    val frame = p.shadowFrames.firstOrNull { lift > it.first }?.second ?: p.shadowDefaultFrame
                    output += CombatSprite(shadow, shadow.frames.first()[(frame - 1).coerceIn(shadow.frames.first().indices)], x, groundY + p.shadowDrop, p.shadowDepth, 0.7f)
                }
                p.travel?.let { travel ->
                    val heading = (-atan2(dy * p.yForeshorten, dx) / (PI / 4)).roundToInt().mod(travel.frames.size)
                    output += CombatSprite(travel, travel.frame(elapsed, heading, true), x, groundY - lift * hypot(dx, dy), p.projectileDepth)
                }
            } else p.impact?.let { impact ->
                val age = elapsed - p.travelMs
                if (age < impact.durationMs) output += sprite(impact, age, "s", flight.toX, flight.toY, depth = p.impactDepth, looping = false)
            }
        }
        for (stream in streams) if (now >= stream.start && now < stream.end) sampleStream(stream, now, output)
        for(fan in fans) if(now>=fan.start && now<fan.end) {
            // Source pins only on keyed body frames; after the last pin the fan
            // finishes its own one-shot clock at that last attachment.
            val frame1=fan.art.pinFrames.last { fan.actionStart+(it-1)*1000f/fan.body.fps<=now }
            val pinMs=fan.actionStart+(frame1-1)*1000f/fan.body.fps
            val pose=model.pose(fan.actorId,pinMs/scene.tickDurationMs,includeDead=true) ?: continue
            val emitter=fan.body.emitter(fan.art.emitter,fan.body.row(fan.facing),frame1-1)
            val x=pose.x*unitScale+(emitter.first-fan.body.cellWidth*fan.body.anchorX)*fan.body.scale
            val y=pose.y*unitScale+(emitter.second-fan.body.cellHeight*fan.body.anchorY)*fan.body.scale
            val dx=fan.toX-x;val dy=fan.toY-y
            output+=sprite(fan.art.clip,now-fan.start,"s",x,y,depth=(model.pose(fan.actorId,fan.start/scene.tickDurationMs,includeDead=true)?.y ?: pose.y)*unitScale+fan.art.depthOffset+lift(fan.actorId),looping=false)
                .copy(rotation=(atan2(dy,dx)*180/PI).toFloat(),horizontalScale=hypot(dx,dy)/fan.art.reachPx)
        }
        for (field in fields) {
            if (now < field.start || now >= field.replacedAt) continue
            val clip = field.art.clip; val frames = clip.frames.first()
            val frame1 = if (now < field.until) field.art.liveFrames[((now - field.start) * clip.fps / 1000).toInt() % field.art.liveFrames.size]
                else field.art.extinguishFrames.getOrNull(((now - field.until) * clip.fps / 1000).toInt()) ?: continue
            output += CombatSprite(clip, frames[frame1 - 1], field.x, field.y, field.y - 1)
        }
        for (effect in effects) if (now >= effect.start && now < effect.start + effect.lifetimeMs) {
            val progress=if(effect.travelMs>0) ((now-effect.start)/effect.travelMs).coerceIn(0f,1f) else 0f
            val x=effect.target?.let { effect.x+(it.first-effect.x)*progress } ?: effect.x
            val y=effect.target?.let { effect.y+(it.second-effect.y)*progress } ?: effect.y
            output += sprite(effect.clip, now - effect.start, "s", x, y, depth = effect.depth, looping = false).copy(rotation = effect.rotation)
        }
    }
    private fun sampleStream(stream: Stream, now: Float, output: MutableList<CombatSprite>) {
        val pose = model.pose(stream.actorId, now / scene.tickDurationMs) ?: return
        val frame0 = ((now - stream.actionStart) * stream.body.fps / 1000).toInt()
        val emitter = stream.body.emitter("maw", stream.body.row(stream.facing), frame0)
        val x = pose.x * unitScale + (emitter.first - stream.body.cellWidth * stream.body.anchorX) * stream.body.scale
        val y = pose.y * unitScale + (emitter.second - stream.body.cellHeight * stream.body.anchorY) * stream.body.scale
        val dx = stream.toX - x; val dy = stream.toY - y; val length = hypot(dx, dy)
        val angle = (atan2(dy, dx) * 180 / PI).toFloat(); val age = now - stream.start
        val art = stream.art
        if (stream.pointBlank) {
            // One-piece onset clip ends on its own authored clock, rather than looping for the stream window.
            if (age < art.pointBlank.durationMs) output += sprite(art.pointBlank, age, "s", x, y, depth = Float.MAX_VALUE, looping = false).copy(rotation = angle)
            return
        }
        output += sprite(art.root, age, "s", x, y, depth = Float.MAX_VALUE, looping = true).copy(rotation = angle)
        val rootEnd = (art.root.cellWidth * (1 - art.root.anchorX) * art.root.scale).coerceAtLeast(0f)
        val middleWidth = (length - rootEnd).coerceAtLeast(0f)
        val tileWidth = art.mid.cellWidth * art.mid.scale
        var offset = 0f
        while (offset < middleWidth) {
            val position = rootEnd + offset
            output += sprite(art.mid, age, "s", x + dx * position / length, y + dy * position / length,
                depth = Float.MAX_VALUE, looping = true).copy(rotation = angle, cropWidth = minOf(tileWidth, middleWidth - offset))
            offset += tileWidth
        }
        output += sprite(art.tip, age, "s", stream.toX, stream.toY, depth = Float.MAX_VALUE, looping = true).copy(rotation = angle)
    }

    private fun actionSprite(action: Action, now: Float, x: Float, y: Float,heroPose:HeroBodyMotion.Pose?=null): CombatSprite {
        val origin = action.origin ?: (x to y)
        val progress = ((now - action.startMs) / (action.endMs - action.startMs)).coerceIn(0f, 1f)
        val drawX = heroPose?.x ?: (action.target?.let { origin.first + (it.first - origin.first) * progress } ?: origin.first)
        val drawY = heroPose?.y ?: (action.target?.let { origin.second + (it.second - origin.second) * progress } ?: origin.second)
        val direction=heroPose?.facing ?: action.facing
        var elapsed = now - action.phaseStartMs
        if (action.once || action.looping) {
            val clip = action.states.first()
            val sample = if (action.once) elapsed * maxOf(1f, clip.durationMs / (action.endMs - action.startMs)) else elapsed
            return sprite(clip, sample, direction, drawX, drawY, looping = action.looping)
        }
        for (clip in action.states) { if (elapsed < clip.durationMs) return sprite(clip, elapsed, direction, drawX, drawY, looping = false); elapsed -= clip.durationMs }
        return sprite(action.states.last(), Float.MAX_VALUE, direction, drawX, drawY, looping = false)
    }
    /** Preparation has already admitted earlier source cues, including future transitions.
     * It is not sorted yet; equal-time replacements select the last executed body command. */
    private fun actionBeforeCapture(values:List<Action>?,now:Float):Action? {
        var latest:Action?=null
        values?.forEach { if(it.startMs<=now && (latest==null || it.startMs>=latest!!.startMs))latest=it }
        return latest?.takeIf { now<it.endMs }
    }
    private fun actionAt(values: List<Action>?, now: Float): Action? =
        actionStartedAt(values, now)?.takeIf { now < it.endMs }

    private fun actionStartedAt(values: List<Action>?, now: Float): Action? {
        if (values == null) return null
        var low = 0; var high = values.size
        while (low < high) { val mid = (low + high) ushr 1; if (values[mid].startMs <= now) low = mid + 1 else high = mid }
        return values.getOrNull(low - 1)
    }
    private fun lastTimeAt(values:List<Float>?,now:Float):Float? {
        if(values==null)return null
        var low=0;var high=values.size
        while(low<high) { val mid=(low+high) ushr 1; if(values[mid]<=now)low=mid+1 else high=mid }
        return values.getOrNull(low-1)
    }
    private fun bodyFeedbackPose(id:Int,now:Float):BodyFeedbackPose? {
        val values=feedbackPoses[id] ?: return null
        var low=0;var high=values.size
        while(low<high) { val mid=(low+high) ushr 1; if(values[mid].at<=now)low=mid+1 else high=mid }
        return values.getOrNull(low-1)
    }
    private fun sprite(clip: AuthoredClip, elapsed: Float, facing: String, x: Float, y: Float, alpha: Float = 1f,
        depth: Float = y, looping: Boolean) = CombatSprite(clip, clip.frame(elapsed, clip.row(facing), looping), x, y, depth, alpha, flipX = clip.flipX.getOrElse(clip.row(facing)) { false } || (clip.rowOrder.size < 8 && facing in setOf("w", "nw", "sw") && ("e" in clip.rowOrder || clip.key.startsWith("hero_"))))
    private data class Stream(val actorId: Int, val actionStart: Float, val start: Float, val end: Float,
        val body: AuthoredClip, val facing: String, val toX: Float, val toY: Float, val art: BreathArt, val pointBlank: Boolean)
    private data class Fan(val actorId: Int,val actionStart: Float,val start: Float,val end: Float,
        val body: AuthoredClip,val facing: String,val toX: Float,val toY: Float,val art: FirestormArt)
    private data class Field(val actorId: Int, val start: Float, val until: Float, val x: Float, val y: Float,
        val art: BurnfieldArt, var replacedAt: Float = Float.POSITIVE_INFINITY)
    private data class Effect(val start: Float, val clip: AuthoredClip, val x: Float, val y: Float, val rotation: Float, val depth: Float,
        val lifetimeMs: Float = clip.durationMs,val target: Pair<Float,Float>? = null,val travelMs: Float = 0f)
    companion object {
        fun facing(dx: Float, dy: Float): String = listOf("e", "se", "s", "sw", "w", "nw", "n", "ne")[(atan2(dy, dx) / (PI / 4)).roundToInt().mod(8)]
    }
}
