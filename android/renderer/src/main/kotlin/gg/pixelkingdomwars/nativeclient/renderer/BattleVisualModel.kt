package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import kotlin.math.atan2
import kotlin.math.PI
import kotlin.math.roundToInt

/** Replay reconstruction and live recovery have different historical cue ownership.
 * The boundary is fixed when a live scene is first prepared, not on every clock update. */
sealed interface BattlePresentationStart {
    data object Continuous : BattlePresentationStart
    data class ColdPrefix(val fromTick: Float) : BattlePresentationStart {
        init { require(fromTick.isFinite() && fromTick >= 0) }
    }
}

data class BattleScene(
    val base: BaseScene,
    val revision: PresentationRevision,
    /** Troop names/hero identifiers map to generated frame keys. Optional #<actorId> keys
     * preserve frozen summoned/defender level overrides supplied by the application adapter. */
    val actorFrames: Map<String, String>,
    val simUnitsPerTile: Float,
    val tickDurationMs: Float,
    val positionCadenceTicks: Int,
    val summonedPositionCadenceTicks: Int,
    val playheadTick: Float = 0f,
    val rate: Float = 1f,
    val playing: Boolean = true,
    /** A terminal replacement may retain already rendered time, never old future predictions. */
    val retainPlaybackTick: Boolean = false,
    val presentationStart: BattlePresentationStart = BattlePresentationStart.Continuous,
    /** Original attacker art for pending placements; never used for authoritative actors or simulation. */
    val deploymentFrames: Map<String,String> = emptyMap(),
    /** Frozen display maxima for bodies with persistent damage states, including accepted army gear. */
    val actorMaxHp: Map<Int,Long> = emptyMap(),
    /** Exact-revision local aliases for optional body-submission diagnostics; never simulation input. */
    val commandDrawPlan: BattleCommandDrawPlan? = null,
    val preparationTrace: LocalPreparationTrace? = null,
    /** A live battle's playhead follows the moving server clock, so a small correction eases in instead of seeking
     * (owner 2026-10-11). Replay and trial seeks (restart, skip to end) stay exact. */
    val liveClock: Boolean = false,
) {
    init {
        require(simUnitsPerTile.isFinite() && simUnitsPerTile > 0)
        require(tickDurationMs.isFinite() && tickDurationMs > 0)
        require(positionCadenceTicks > 0 && summonedPositionCadenceTicks > 0)
        require(playheadTick.isFinite() && playheadTick >= 0 && rate.isFinite() && rate > 0)
        require(revision.replaceFromTick == 0) { "Unsupported incremental battle protocol" }
    }
}

data class ActorPose(val identity: String, val x: Float, val y: Float, val visible: Boolean)
data class ActorMotion(val facing: String, val moving: Boolean)

/** A render-only index of canonical events. It neither runs combat nor guesses damage, pathing,
 * outcomes or rewards. All interpolation lies between authoritative position keyframes. */
class BattleVisualModel(events: List<PresentationEvent>, private val positionCadenceTicks: Int,
                        private val summonedPositionCadenceTicks: Int = positionCadenceTicks,
                        checkpoint: () -> Unit = {}) {
    private val tracks = linkedMapOf<Int, ActorTrack>()
    private val destroyedAt = mutableMapOf<String, Int>()
    private val hits = mutableMapOf<String, MutableList<Int>>()
    private val unsupported = linkedSetOf<String>()
    val actorIds: Set<Int> get() = tracks.keys
    val actorIdentities: Set<String> get() = tracks.values.map { it.identity }.toSet()
    val unsupportedEventTypes: Set<String> get() = unsupported.toSet()
    val finalTick: Int = events.lastOrNull()?.t ?: 0
    fun actorIdentity(id: Int): String? = tracks[id]?.identity

    init {
        require(positionCadenceTicks > 0 && summonedPositionCadenceTicks > 0)
        val reader = JsonReader()
        for ((order,event) in events.withIndex()) {
            checkpoint()
            require(order == 0 || events[order - 1].t <= event.t)
            val data = reader.parse(event.json)
            require(data.getInt("t") == event.t && data.getString("e") == event.e)
            when (event.e) {
                "deploy", "spawn", "troopSpawn" -> {
                    val identity = data.getString("hero", null) ?: data.getString("troop")
                    val track = ActorTrack(identity, event.t,
                        if (event.e == "troopSpawn") summonedPositionCadenceTicks else positionCadenceTicks)
                    track.positions += Position(event.t, data.getFloat("x"), data.getFloat("y"), order=order)
                    tracks[data.getInt("id")] = track
                }
                "pos", "emerge" -> tracks[data.getInt("id")]?.let { track ->
                    if (data.has("x") && data.has("y")) {
                        track.positions += Position(event.t, data.getFloat("x"), data.getFloat("y"), teleport = event.e == "emerge", order=order)
                    }
                    if (event.e == "emerge") track.visibility += Visibility(event.t, true)
                }
                // The canonical ability controller cancels the prior move and
                // snaps to the supplied cast origin before pinning the fan.
                "troopAbility" -> if(data.getString("ability") in setOf("firestorm","maul","howl")) tracks[data.getInt("id")]?.let { track ->
                    track.positions+=Position(event.t,data.getFloat("x"),data.getFloat("y"),teleport=true,order=order)
                } else unsupported+=event.e
                "burrow" -> tracks[data.getInt("id")]?.visibility?.add(Visibility(event.t, false))
                "troopDeath", "detonate" -> tracks[data.getInt("id")]?.let {
                    if (event.e == "detonate" && data.has("x") && data.has("y"))
                        it.positions += Position(event.t, data.getFloat("x"), data.getFloat("y"), teleport = true, order=order)
                    it.deathTick = event.t
                    it.deathOrder = order
                }
                "destroyed" -> destroyedAt[data.getString("id")] = event.t
                "hit" -> hits.getOrPut(data.get("target").asString()) { mutableListOf() }.add(event.t)
                // Star/reward display belongs to the server result UI. Healing needs no position update.
                "star", "heal" -> Unit
                else -> unsupported += event.e
            }
        }
    }

    fun deathTick(actorId: Int): Int? = tracks[actorId]?.deathTick?.takeIf { it != Int.MAX_VALUE }
    fun deployTick(actorId: Int): Int? = tracks[actorId]?.deployTick
    fun destroyedTick(buildingId: String): Int? = destroyedAt[buildingId]

    /** A transient captures the displayed sprite at its event boundary. Normal
     * endpoints have already started their cadence-limited tween; instantaneous
     * same-tick teleports, births and deaths retain original event ordering. */
    fun poseBeforeEvent(actorId: Int, tick: Float, order: Int): ActorPose? {
        val track=tracks[actorId] ?: return null
        if(track.deathOrder<order || track.positions.first().order>=order) return null
        var index=lastAtOrBefore(track.positions,tick) { it.tick }
        while(index>=0) {
            val position=track.positions[index]
            val prior=track.positions.getOrNull(index-1)
            val tweenStart=prior?.let { maxOf(it.tick,position.tick-track.cadence) } ?: position.tick
            if(position.order<order || (!position.teleport && tweenStart<tick)) break
            index--
        }
        val from=track.positions.getOrNull(index) ?: return null
        val to=track.positions.getOrNull(index+1)
        val start=to?.let { maxOf(from.tick,it.tick-track.cadence) } ?: from.tick
        val progress=if(to!=null && !to.teleport && to.tick>start)
            ((tick-start)/(to.tick-start)).coerceIn(0f,1f) else 0f
        return ActorPose(track.identity,from.x+((to?.x ?: from.x)-from.x)*progress,
            from.y+((to?.y ?: from.y)-from.y)*progress,true)
    }

    fun pose(actorId: Int, tick: Float, interpolate: Boolean = true, includeDead: Boolean = false): ActorPose? {
        val track = tracks[actorId] ?: return null
        if (tick < track.deployTick || (!includeDead && tick >= track.deathTick)) return null
        val index = lastAtOrBefore(track.positions, tick) { it.tick }
        if (index < 0) return null
        val from = track.positions[index]
        val to = track.positions.getOrNull(index + 1)
        val segmentStart = if (to == null) from.tick else maxOf(from.tick, to.tick - track.cadence)
        val progress = if (interpolate && to != null && !to.teleport && to.tick > segmentStart)
            ((tick - segmentStart) / (to.tick - segmentStart)).coerceIn(0f, 1f) else 0f
        val visibleIndex = lastAtOrBefore(track.visibility, tick) { it.tick }
        return ActorPose(track.identity, from.x + ((to?.x ?: from.x) - from.x) * progress,
            from.y + ((to?.y ?: from.y) - from.y) * progress,
            visibleIndex < 0 || track.visibility[visibleIndex].visible)
    }

    /** Facing immediately before an instantaneous cast snap. Teleports and
     * repeated stationary endpoints do not turn an already facing actor. */
    fun facingBeforeEvent(actorId: Int,tick: Float,order: Int): Pair<String,Float> {
        val track=tracks[actorId] ?: return "s" to Float.NEGATIVE_INFINITY
        var result="s" to Float.NEGATIVE_INFINITY
        for(index in 1 until track.positions.size) {
            val from=track.positions[index-1];val to=track.positions[index]
            if(to.teleport || (from.x==to.x && from.y==to.y))continue
            val start=maxOf(from.tick,to.tick-track.cadence).toFloat()
            if(start>tick || (start==tick && to.order>=order))continue
            result=CombatVisualPlan.facing(to.x-from.x,to.y-from.y) to start
        }
        return result
    }

    fun motion(actorId: Int, tick: Float): ActorMotion {
        val track = tracks[actorId] ?: return ActorMotion("s", false)
        val index = lastAtOrBefore(track.positions, tick) { it.tick }
        if (index < 0) return ActorMotion("s", false)
        val current = track.positions[index]
        val next = track.positions.getOrNull(index + 1)
        val segmentStart = next?.let { maxOf(current.tick, it.tick - track.cadence) }
        val moving = next != null && !next.teleport && segmentStart != null && tick >= segmentStart &&
            (next.x != current.x || next.y != current.y)
        val from = if (moving) current else track.positions.getOrNull(index - 1) ?: current
        val to = if (moving) next!! else current
        if (from.x == to.x && from.y == to.y) return ActorMotion("s", moving)
        val index8 = (atan2(to.y - from.y, to.x - from.x) / (PI / 4)).roundToInt().mod(8)
        return ActorMotion(listOf("e", "se", "s", "sw", "w", "nw", "n", "ne")[index8], moving)
    }

    fun isDestroyed(buildingId: String, tick: Float) = destroyedAt[buildingId]?.let { tick >= it } ?: false
    fun wasHit(targetId: String, tick: Float, cueTicks: Float, afterTick: Float = Float.NEGATIVE_INFINITY): Boolean {
        val targetHits = hits[targetId] ?: return false
        val index = lastAtOrBefore(targetHits, tick) { it }
        return index >= 0 && targetHits[index] > afterTick && tick - targetHits[index] < cueTicks
    }

    private fun <T> lastAtOrBefore(values: List<T>, tick: Float, time: (T) -> Int): Int {
        var low = 0; var high = values.size
        while (low < high) { val mid = (low + high) ushr 1; if (time(values[mid]) <= tick) low = mid + 1 else high = mid }
        return low - 1
    }

    private class ActorTrack(val identity: String, val deployTick: Int, val cadence: Int) {
        val positions = mutableListOf<Position>()
        val visibility = mutableListOf<Visibility>()
        var deathTick = Int.MAX_VALUE
        var deathOrder = Int.MAX_VALUE
    }
    private data class Position(val tick: Int, val x: Float, val y: Float, val teleport: Boolean = false, val order: Int)
    private data class Visibility(val tick: Int, val visible: Boolean)
}
