package gg.pixelkingdomwars.nativeclient.renderer.world

import java.util.concurrent.ConcurrentLinkedQueue

/** What an intent points at. Ids are server ids (realm ids from `/globe/fantasy`, deed columns/rows of the catalog). */
sealed interface WorldTarget {
    data class Realm(val realmId: String) : WorldTarget
    data class Island(val islandId: String) : WorldTarget
    data class Deed(val realmId: String, val deedX: Int, val deedY: Int) : WorldTarget
    data class Tile(val realmId: String, val tileX: Int, val tileY: Int) : WorldTarget
}

/** The approved realm-map chips (D-169). CLAN and ATTACKABLE stay hidden in the HUD until the feed carries their
 *  fields (OQ-1); the kinds exist so the engine side is ready. UNSHIELDED (SHARDKEEP D-191, replacing SHIELDED: a player
 *  searches the map for a raid target, so the chip keeps the kingdoms a raid can reach) passes only a kingdom whose shield
 *  bit the read carried as false ([WorldBases.shieldKnown]). [levels] comes from the chip, never a constant. */
enum class WorldFilterKind { ALL, MINE, CLAN, ATTACKABLE, UNSHIELDED, LEVEL }
data class WorldFilter(val kind: WorldFilterKind, val levels: IntRange? = null)

/**
 * A bases snapshot for the realm map (provisional shape until N2's `RealmUiModel`): parallel arrays, one entry per
 * occupied deed of [realmId]. [flags] carries the web's base-state `FLAG` bits (generated from `contracts.js`).
 * [shieldKnown]: whether the base's read carried a shield bit at all (the feed's `shielded` is true, false or absent,
 * and `FLAG` has no bit for "absent"); null means no base's is known. Only a known, clear bit passes UNSHIELDED
 * (SHARDKEEP D-191; D-169 / D-181: an absent bit is hidden, never read as unshielded). Immutable once offered: the UI
 * thread builds a new one per server update.
 */
class WorldBases(val epoch: Long, val realmId: String, val deedX: IntArray, val deedY: IntArray, val level: IntArray, val flags: IntArray,
                 val shieldKnown: BooleanArray? = null) {
    init {
        require(deedX.size == deedY.size && deedX.size == level.size && deedX.size == flags.size) { "Ragged bases snapshot" }
        require(shieldKnown == null || shieldKnown.size == deedX.size) { "Ragged bases snapshot" }
    }
    val size: Int get() = deedX.size
}

/**
 * UI → GL messages (GLOBE-NATIVE-PLAN §3.4): immutable, created on the UI thread, applied by the GL thread at frame
 * start. They replace `LaunchedEffect(camera) → setView`, whose round trip rewound the camera and recomposed the world
 * screen on every pan frame.
 */
sealed interface WorldIntent {
    /** Fly to a target; [d] is the realm map's device px per deed at arrival (null: the engine's default for it). */
    data class FlyTo(val target: WorldTarget, val d: Double? = null) : WorldIntent
    data class Select(val target: WorldTarget?) : WorldIntent
    data class SetFilter(val filter: WorldFilter) : WorldIntent
    class SetBases(val bases: WorldBases) : WorldIntent
    /** Every HUD control's bounds in VIEW px, (x, y, w, h) × [count]; the GL side converts them with [InputScale]. */
    class SetUiRects(val viewRects: FloatArray, val count: Int) : WorldIntent {
        init { require(count >= 0 && viewRects.size >= count * 4) { "Rects array too small" } }
    }
    data class Dive(val realmId: String) : WorldIntent
    data object Leave : WorldIntent
    data class SetNight(val night: Boolean) : WorldIntent
    data class SetReducedMotion(val reduced: Boolean) : WorldIntent
}

fun interface WorldIntentSink { fun apply(intent: WorldIntent) }

/**
 * The lock-free UI → GL intent queue. [offer] (any thread) enqueues and marks the pacer dirty through [onEnqueue], so
 * a frame follows; [drain] (GL thread, frame start) hands every queued intent to the sink in order and never
 * allocates. Conflation is the engine's job (the latest SetUiRects wins when it applies them).
 */
class WorldIntents(private val onEnqueue: Runnable) {
    private val queue = ConcurrentLinkedQueue<WorldIntent>()

    fun offer(intent: WorldIntent) { queue.offer(intent); onEnqueue.run() }

    fun drain(sink: WorldIntentSink): Int {
        var n = 0
        while (true) {
            val intent = queue.poll() ?: return n
            sink.apply(intent); n++
        }
    }

    val isEmpty: Boolean get() = queue.isEmpty()
}
