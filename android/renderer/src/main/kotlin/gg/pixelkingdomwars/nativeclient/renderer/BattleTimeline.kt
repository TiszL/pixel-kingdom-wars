package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader

/** Preserve each canonical flat SIM event verbatim. No Kotlin simulation or economy logic. */
data class PresentationEvent(val t: Int, val e: String, val json: String) {
    init { require(t >= 0 && e.isNotBlank()) }
    companion object {
        fun fromJson(json: String): PresentationEvent {
            val data = JsonReader().parse(json)
            return PresentationEvent(data.getInt("t"), data.getString("e"), json)
        }
    }
}

data class PresentationRevision(
    val raidId: String,
    val revision: String,
    val simVersion: Int,
    val lastSequence: Long,
    val replaceFromTick: Int,
    val events: List<PresentationEvent>,
)

data class PlaybackUpdate(
    val tick: Int,
    /** True means rebuild persistent actor state from events; never replay past sounds or FX. */
    val reset: Boolean,
    val stateEvents: List<PresentationEvent>,
    val transientEvents: List<PresentationEvent>,
)

/** Full-reset presentation protocol v1. HTTP requests must be serial per raid; request generations
 * below additionally reject a canceled request that completes after its successor. */
class BattleTimeline(private val supportedSimVersions: Set<Int>) {
    var revision: String? = null; private set
    var raidId: String? = null; private set
    var playheadTick: Int = 0; private set
    private var lastSequence = -1L
    private var requestGeneration = -1L
    private var events = emptyList<PresentationEvent>()
    private var cursor = 0

    fun replace(next: PresentationRevision, playhead: Int, generation: Long = requestGeneration + 1): PlaybackUpdate? {
        require(playhead >= 0 && generation >= 0)
        require(next.simVersion in supportedSimVersions) { "Unsupported simulation presentation version" }
        require(next.replaceFromTick == 0) { "Incremental event replacement requires a newer client" }
        require(next.raidId.isNotBlank() && next.revision.isNotBlank() && next.lastSequence >= 0)
        require(next.events.zipWithNext().all { (a, b) -> a.t <= b.t }) { "Events must retain canonical stable order" }
        if (generation < requestGeneration) return null
        if (raidId == next.raidId && next.lastSequence < lastSequence) return null
        requestGeneration = generation
        if (raidId == next.raidId && revision == next.revision) return null
        raidId = next.raidId
        revision = next.revision
        lastSequence = next.lastSequence
        events = next.events.toList()
        playheadTick = playhead
        cursor = upperBound(playhead)
        return PlaybackUpdate(playhead, true, events.subList(0, cursor).toList(), emptyList())
    }

    fun advanceTo(tick: Int): PlaybackUpdate {
        require(tick >= 0)
        val nextCursor = upperBound(tick)
        val rewind = tick < playheadTick
        val delta = if (rewind) events.subList(0, nextCursor).toList() else events.subList(cursor, nextCursor).toList()
        playheadTick = tick
        cursor = nextCursor
        return PlaybackUpdate(tick, rewind, delta, if (rewind) emptyList() else delta)
    }

    private fun upperBound(tick: Int): Int {
        var low = 0; var high = events.size
        while (low < high) {
            val mid = (low + high) ushr 1
            if (events[mid].t <= tick) low = mid + 1 else high = mid
        }
        return low
    }
}
