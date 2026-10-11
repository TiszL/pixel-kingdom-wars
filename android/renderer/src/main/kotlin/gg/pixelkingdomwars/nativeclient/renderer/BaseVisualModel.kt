package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue
import kotlin.math.atan2
import kotlin.math.PI
import kotlin.math.roundToInt

/** Contract 13 `builder` section (source `apps/web/src/game/world/jobs.ts`, D-130): one civilian
 * Builder Workman serves every Keep level. Clip rows follow V2_DIRS order; offsets are world pixels
 * at the base presentation's tile size, exactly like the legacy job rules they replace. */
data class BuilderPresentation(val walk: AuthoredClip, val work: AuthoredClip, val idle: AuthoredClip?, val travelMs: Float,
    val gateTileX: Float, val gateX: Float, val gateY: Float, val siteX: Float, val siteY: Float, val siteGapWorldPx: Float) {
    val atlasPath: String get() = walk.atlasPath
    companion object {
        private val directions = setOf("s", "sw", "w", "nw", "n", "ne", "e", "se")
        fun parse(v: JsonValue): BuilderPresentation {
            require(v.getInt("version") == 1) { "Unsupported builder section" }
            val clips = v.get("clips"); val states = v.get("states"); val facing = v.get("facing")
            require(facing.getString("walk") == "gateToSite" && facing.getString("work") == "siteToTargetCenter") { "Builder facing rules changed" }
            fun body(state: String): AuthoredClip {
                val clip = AuthoredClip.parse(clips.get(states.getString(state)))
                require(clip.frames.size == directions.size && clip.rowOrder.toSet() == directions && clip.fps > 0) { "Builder $state clip is not a complete eight-row body" }
                require(clip.atlasPath == v.getString("atlasPath")) { "Builder clips split across atlases" }
                return clip
            }
            val walk = body("travel"); val work = body("working")
            val idle = clips.get(states.getString("rest"))?.let(AuthoredClip::parse)
            require(walk.scale == v.getFloat("scale") && work.scale == v.getFloat("scale")) { "Builder draw scale disagrees with its clips" }
            val gate = v.get("gate"); val site = v.get("site"); val travelMs = v.getFloat("travelMs")
            require(travelMs.isFinite() && travelMs > 0)
            return BuilderPresentation(walk, work, idle, travelMs, gate.getFloat("tileX"), gate.getFloat("offsetX"), gate.getFloat("offsetY"),
                site.getFloat("offsetX"), site.getFloat("offsetY"), v.getFloat("siteGapWorldPx"))
        }
    }
}

/** `facing8` (`apps/web/src/game/v2/clips.ts`): nearest of eight facings; y grows down. */
internal fun facing8(dx: Double, dy: Double): String {
    val k = Math.round(atan2(dy, dx) / (PI / 4)).toInt()
    return FACING_SEQUENCE[Math.floorMod(k, 8)]
}
private val FACING_SEQUENCE = listOf("e", "se", "s", "sw", "w", "nw", "n", "ne")

/** Source-generated home presentation. All coordinates are visual pixels; no costs,
 * completion, production or research state is inferred by this catalogue. */
data class BasePresentation(val tilePixels: Float,val workingTypes: Set<String>,val wareTypes: Set<String>,
    val legacyIdleTypes: Set<String>,val idleState: String,val workState: String,val buildState: String,
    val levelupState: String,val buildLoop: Boolean,val jobs: JobPresentation,val buildingLoopSpeed: Float = 1f) {
    init { require(buildingLoopSpeed.isFinite() && buildingLoopSpeed > 0) }
    companion object {
        fun parse(v: JsonValue): BasePresentation {
            require(v.getInt("version") == 1)
            fun set(key: String)=v.get(key).map { it.asString() }.toSet()
            val jobs=v.get("jobs");val gate=jobs.get("gate");val site=jobs.get("site")
            return BasePresentation(v.getFloat("tilePixels"),set("workingTypes"),set("wareTypes"),set("legacyIdleTypes"),
                v.getString("idleState"),v.getString("workState"),v.getString("buildState"),v.getString("levelupState"),v.getBoolean("buildLoop"),
                JobPresentation(jobs.getFloat("travelMs"),gate.getFloat("tileX"),gate.getFloat("offsetX"),gate.getFloat("offsetY"),
                    site.getFloat("offsetX"),site.getFloat("offsetY"),AuthoredClip.parse(jobs.get("scaffold")),
                    jobs.get("builderByKeepLevel").associate { it.name.toInt() to (AuthoredClip.parse(it.get("walk")) to AuthoredClip.parse(it.get("attack"))) },
                    jobs.getFloat("actorDepthOffset"),jobs.getFloat("structureDepthOffset"),jobs.getFloat("structureDepthScale")), v.getFloat("buildingLoopSpeed", 1f))
        }
    }
}
data class JobPresentation(val travelMs: Float,val gateTileX: Float,val gateX: Float,val gateY: Float,
    val siteX: Float,val siteY: Float,val scaffold: AuthoredClip,val builders: Map<Int,Pair<AuthoredClip,AuthoredClip>>,
    val actorDepthOffset: Float,val structureDepthOffset: Float,val structureDepthScale: Float)
data class BaseVisualSprite(val clip: AuthoredClip,val frameKey: String,val x: Float,val y: Float,
    val width: Float,val height: Float,val anchorX: Float,val anchorY: Float,val depth: Float)

/** The server jobs the home scene gives a scaffold and ONE Builder Workman each: every job except one on a Phase E service
 * building, whose construction draws neither here. A footprint's size never adds a body. The Compose construction layer
 * reads this same set, so a site the scene already walks a Workman to never gets a second, still builder beside it
 * (owner 2026-10-06: "when building something big builders second one appears"). One builder per job on screen. */
fun BaseScene.workmanJobs(): List<RenderJob> = jobs.filter { job -> buildings.none { it.id == job.buildingId && it.service != null } }

/** Immutable random-access view of a received base snapshot. Refreshes preserve phase by
 * base/building/job identity; local deadlines never delete jobs or create buildings. */
class BaseVisualModel(val scene: BaseScene,private val art: Map<String,CombatArt>,private val rules: BasePresentation,
    observedAtMs: Long,previous: BaseVisualModel? = null,private val seatOffsets: Map<String,Pair<Float,Float>> = emptyMap(),
    /** Contract 13 single-body Workman; absent on older packs, which keep the per-level stand-in. */
    private val builder: BuilderPresentation? = null) {
    private data class Phase(val building: RenderBuilding,val jobId: String?,val jobKind: String?,val startMs: Long,val flashMs: Long?)
    private val phases: Map<String,Phase>
    val requiredAtlases: Set<String>
    private val legacyJobs = scene.workmanJobs()
    init {
        require(rules.tilePixels.isFinite() && rules.tilePixels>0 && rules.jobs.travelMs.isFinite() && rules.jobs.travelMs>0)
        require(scene.jobs.map { it.id }.distinct().size==scene.jobs.size)
        scene.jobs.forEach { job ->
            require(job.finishesAtMs>=job.startedAtMs && listOf(job.targetX,job.targetY,job.footprintWidth,job.footprintHeight).all { it.isFinite() })
            require(job.footprintWidth>0 && job.footprintHeight>0)
        }
        val old=previous?.takeIf { scene.baseId!=null && it.scene.baseId==scene.baseId }
        phases=scene.buildings.associate { building ->
            val job=scene.jobs.firstOrNull { it.buildingId==building.id && it.kind in setOf("build","upgrade") }
            val prior=old?.phases?.get(building.id)
            val same=prior!=null && prior.building.frameKey==building.frameKey && prior.jobId==job?.id && prior.building.underConstruction==building.underConstruction && prior.building.trapSpent==building.trapSpent
            val completed=prior?.jobKind=="upgrade" && job==null && !building.underConstruction &&
                prior.building.level!=null && building.level!=null && building.level>prior.building.level
            building.id to Phase(building,job?.id,job?.kind,if(same) prior!!.startMs else job?.startedAtMs ?: observedAtMs,
                if(completed) observedAtMs else if(same && job==null) prior?.flashMs else null)
        }
        requiredAtlases=buildSet {
            phases.values.filter { admitted(it.building) }.forEach { phase ->
                val clips=art[phase.building.frameKey]?.clips ?: return@forEach
                (clips[restState(phase)] ?: clips[rules.idleState])?.let { add(it.atlasPath) }
                // The received upgrade transition can still enter its resting state without
                // another snapshot. Combat-only projectiles, death and hit FX stay unloaded.
                if(phase.flashMs!=null) clips[rules.levelupState]?.let { add(it.atlasPath) }
            }
            if(legacyJobs.isNotEmpty()) {
                add(rules.jobs.scaffold.atlasPath)
                if(builder!=null) add(builder.atlasPath)
                else rules.jobs.builders[scene.keepLevel]?.let { add(it.first.atlasPath);add(it.second.atlasPath) }
            }
        }
    }
    // Older packs already carry the source controller's explicit looping stand body.
    // Admit that authored rest only; an attack/death clip must never become a home loop.
    private fun authoredRest(b: RenderBuilding): String? {
        val body=art[b.frameKey] ?: return null
        val state=body.profile.getString("stand",null) ?: return null
        return state.takeIf { body.clips[it]?.loop == true }
    }
    private fun admitted(b: RenderBuilding)=b.service == null && (b.type in rules.wareTypes || b.type in rules.legacyIdleTypes || authoredRest(b)!=null)
    private fun restState(phase: Phase)=when {
        phase.jobId!=null || phase.building.underConstruction -> rules.buildState
        phase.building.type in rules.workingTypes -> rules.workState
        authoredRest(phase.building)!=null -> if(phase.building.trapSpent)
            art[phase.building.frameKey]!!.profile.getString("death",rules.idleState) else authoredRest(phase.building)!!
        else -> rules.idleState
    }
    fun structureDepth(south: Float)=rules.jobs.structureDepthOffset+south*rules.jobs.structureDepthScale
    private fun frame(clip: AuthoredClip,age: Long,row: Int,loop: Boolean,speed: Float = 1f): String {
        val scaled = age.coerceAtLeast(0).toDouble() * speed
        val elapsed=if(loop && clip.durationMs>0) scaled%clip.durationMs else scaled
        return clip.frame(elapsed.toFloat(),row,loop)
    }
    fun building(id: String,nowMs: Long): BaseVisualSprite? {
        val phase=phases[id] ?: return null;val b=phase.building
        if(!admitted(b)) return null
        val clips=art[b.frameKey]?.clips ?: return null
        var state=restState(phase)
        var start=phase.startMs;var loop=(phase.jobId==null && !b.underConstruction || rules.buildLoop) && !b.trapSpent
        phase.flashMs?.let { flash ->
            clips[rules.levelupState]?.let { clip -> if(nowMs-flash<clip.durationMs) { state=rules.levelupState;start=flash;loop=false }
                else start=flash+clip.durationMs.toLong() }
        }
        val clip=clips[state] ?: clips[rules.idleState]?.also { loop=true } ?: return null
        val offset=seatOffsets[b.frameKey]
        val south=(b.tileY+b.footprintHeight)*scene.tilePixels
        val x=(b.tileX+b.footprintWidth/2)*scene.tilePixels+(offset?.first ?: 0f);val y=south+(offset?.second ?: 0f)
        val speed = if (loop && b.type in rules.wareTypes) rules.buildingLoopSpeed else 1f
        return BaseVisualSprite(clip,frame(clip,nowMs-start,0,loop,speed),x,y,clip.cellWidth*clip.scale,clip.cellHeight*clip.scale,
            clip.anchorX,if(b.type !in rules.wareTypes && b.type !in rules.legacyIdleTypes) clip.anchorY else 1f,structureDepth(south))
    }
    fun jobs(nowMs: Long,output: MutableList<BaseVisualSprite>) {
        output.clear();val j=rules.jobs;val tile=scene.tilePixels;val scale=tile/rules.tilePixels
        val keep=scene.buildings.firstOrNull { it.type=="keep" }
        for(job in legacyJobs) {
            val age=(nowMs-job.startedAtMs).coerceAtLeast(0)
            val left=job.targetX*tile;val south=(job.targetY+job.footprintHeight)*tile
            output+=BaseVisualSprite(j.scaffold,frame(j.scaffold,age,0,true),left,job.targetY*tile,
                job.footprintWidth*tile,job.footprintHeight*tile,0f,0f,structureDepth(south))
            if(keep==null) continue
            val workman=builder
            if(workman!=null) {
                // jobs.ts: keep gate → site over travelMs facing the walk; then the hammer loop faces the target centre.
                val sx=(keep.tileX+workman.gateTileX)*tile+workman.gateX*scale;val sy=(keep.tileY+keep.footprintHeight)*tile+workman.gateY*scale
                val ex=left+workman.siteX*scale;val ey=south+workman.siteY*scale
                val progress=(age/workman.travelMs).coerceIn(0f,1f);val walking=progress<1f
                val clip=if(walking) workman.walk else workman.work
                val facing=if(walking) facing8((ex-sx).toDouble(),(ey-sy).toDouble())
                    else facing8(((job.targetX+job.footprintWidth/2)*tile-ex).toDouble(),((job.targetY+job.footprintHeight/2)*tile-ey).toDouble())
                val x=sx+(ex-sx)*progress;val y=sy+(ey-sy)*progress;val bodyScale=clip.scale*scale
                output+=BaseVisualSprite(clip,frame(clip,if(walking) age else age-workman.travelMs.toLong(),clip.row(facing),true),x,y,
                    clip.cellWidth*bodyScale,clip.cellHeight*bodyScale,clip.anchorX,clip.anchorY,j.actorDepthOffset+y)
                continue
            }
            val builder=j.builders[scene.keepLevel] ?: continue
            val sx=(keep.tileX+j.gateTileX)*tile+j.gateX*scale;val sy=(keep.tileY+keep.footprintHeight)*tile+j.gateY*scale
            val ex=left+j.siteX*scale;val ey=south+j.siteY*scale
            val progress=(age/j.travelMs).coerceIn(0f,1f);val walking=progress<1f
            val clip=if(walking) builder.first else builder.second
            val facing=if(walking) listOf("e","se","s","sw","w","nw","n","ne")[(atan2(ey-sy,ex-sx)/(PI/4)).roundToInt().mod(8)] else "e"
            val row=clip.row(facing);val x=sx+(ex-sx)*progress;val y=sy+(ey-sy)*progress
            output+=BaseVisualSprite(clip,frame(clip,if(walking) age else age-j.travelMs.toLong(),row,true),x,y,
                clip.cellWidth*clip.scale,clip.cellHeight*clip.scale,clip.anchorX,clip.anchorY,j.actorDepthOffset+y)
        }
    }
}
