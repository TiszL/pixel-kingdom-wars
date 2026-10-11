package gg.pixelkingdomwars.nativeclient.scene.world

import android.content.Context
import android.content.SharedPreferences
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GpuSafe
import gg.pixelkingdomwars.nativeclient.renderer.world.GpuSafePolicy
import gg.pixelkingdomwars.nativeclient.renderer.world.HangGuard
import gg.pixelkingdomwars.nativeclient.renderer.world.HangRecord
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger

/**
 * The hang guard's crash record as the device keeps it between sessions (the web's `localStorage['rm-gpu-safe']`): the
 * guard's [HangRecord] (its level is [HangGuard.SAFE_LEVEL] while it holds a real freeze, [HangGuard.hazard]) plus the
 * facts [WorldEngineAdmission] reads before any GL exists: whether the guard [stopped] the realm map (`lossStop` lost
 * contexts), and how many [stops] this device has already served (each later stop holds twice as long, [HangMemory.holdMs]).
 * [clean]: the clean realm-map visits that have followed the stored freeze ([HangMemory.realm]); 0 without one.
 */
data class StoredHang(val record: HangRecord, val stopped: Boolean, val stops: Int = 0, val clean: Int = 0)

/**
 * One small JSON string in the app's private preferences. Device-wide, not per account or API origin: it records what
 * this phone's GPU did. Reads and writes never throw: an unreadable or corrupt record is no record, a failed write is
 * dropped (the guard still protects the running session).
 */
class HangRecordStore(private val read: (String) -> String?, private val write: (key: String, value: String?, durable: Boolean) -> Unit) {
    /** Null too for a record of another [VERSION]'s rule (the next save replaces it). */
    fun load(): StoredHang? = runCatching { read(KEY)?.let { JSON.decodeFromString(Wire.serializer(), it) }?.takeIf { it.v == VERSION }?.stored() }.getOrNull()

    /** Null removes the record (a healthy session with the realm map closed leaves none). [durable]: on disk before this
     *  returns (the pending marker, which realm-map GPU work follows at once); otherwise the write is queued. */
    fun save(value: StoredHang?, durable: Boolean = false) {
        runCatching { write(KEY, value?.let { JSON.encodeToString(Wire.serializer(), Wire.of(it)) }, durable) }
    }

    @Serializable private class Wire(val v: Int = 0, val level: Int, val atMs: Long, val reason: String? = null, val pendingSinceMs: Long? = null,
                                     val stopped: Boolean = false, val stops: Int = 0, val clean: Int = 0) {
        fun stored() = StoredHang(HangRecord(level, atMs, reason, pendingSinceMs), stopped, stops, clean)
        companion object {
            fun of(s: StoredHang) = Wire(VERSION, s.record.level, s.record.atMs, s.record.reason, s.record.pendingSinceMs, s.stopped, s.stops, s.clean)
        }
    }

    companion object {
        const val STORE = "pkw-world-hang"
        const val KEY = "record"
        /**
         * The record's rule. 2: only a real freeze is stored and a stored level is not a floor. A record without it (code
         * 30 and before: every slow-frame trip stored, and the next session floored at the safe level for a day) is no
         * record, so a phone holding one of those, the owner's Seeker among them, starts at full quality.
         */
        const val VERSION = 2
        private val JSON = Json { ignoreUnknownKeys = true }

        /** The app's store. */
        fun of(context: Context): HangRecordStore = of(context.applicationContext.getSharedPreferences(STORE, Context.MODE_PRIVATE))

        /**
         * A durable write is `commit()`, on disk before the caller's (GL) thread goes on: the pending marker, set just
         * before the realm map's first GPU work. `apply()` queues its disk write (~100 ms on API 26+), and a driver
         * SIGSEGV in that work kills the process at once, so the marker would be lost and the next session start at L0
         * again. Every other write (a level change, a clear) is `apply()`: it leaves the GL thread at once.
         */
        internal fun of(prefs: SharedPreferences): HangRecordStore = HangRecordStore({ prefs.getString(it, null) }, { key, value, durable ->
            val edit = prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }
            if (durable) edit.commit() else edit.apply()
        })
    }
}

/**
 * The world host's crash memory for one session (N5; GLOBE-NATIVE-PLAN §5.4). GL thread. Until N5 the host never persisted
 * the guard, so a phone that hung or crashed inside the realm map started the next visit at L0 again.
 *
 * - [start], before the first frame: the guard starts from the stored record ([HangGuard.start]: a stored freeze or a
 *   young pending marker starts at the safe level, which lets go after steady frames as a trip does), and the record is
 *   rewritten (an aged-out or other-version one goes).
 * - What is stored is a real freeze only ([HangGuard.hazard]): a lost context or a frozen frame ([incident]), and a
 *   visit that ended inside the realm map (the pending marker). A slow-frame trip and every recovery stay in the session.
 * - [incident] on a lost context or a frozen frame; [realm] when realm-map GPU work begins (a realm the panel prepares
 *   behind the globe, a dive) or ends (the realm ready behind the globe, back on the globe, a pause, a dispose): the
 *   pending marker, cleared on every clean leave. It is on disk before that work runs (a durable write), so a process
 *   that dies with it set (a crash, a freeze, a kill in the foreground) leaves it behind for the next session. Each is
 *   one small write, never per frame.
 * - Clean visits clear a stored freeze before its day is out (the web's `gpuRecord.leave`, `GPU_SAFE.crash`): a realm-map
 *   visit ([realm]) is clean when it drew [GpuSafe.CRASH_STEADY] steady samples at full quality (the guard let go) with
 *   the map on screen in its MAP set or deeper ([sampled]), and neither froze nor lost the context. After
 *   [GpuSafe.CRASH_CLEAN] of them the guard [HangGuard.forget]s the freeze; [stops] stay. Nearly every realm visit is a
 *   fresh host, so the count is stored ([StoredHang.clean]); a new freeze or a served stop starts it again. Without it one
 *   freeze started every host safe for a day (⅓-scale ground at each dive; code 30 built ten hosts in five minutes) and
 *   kept the record armed, so any later death inside the map (an unrelated crash) stopped the realm map.
 * - A stop that has aged out ([stopReason]) is not a clean slate: that session starts at the safe level with the stop
 *   stored as a fresh freeze, so one more visit that dies inside the map stops it again, and the next stop holds twice
 *   as long ([holdMs]). Without it a phone whose realm map freezes at every level froze at L0, then at the safe level,
 *   and was stopped again, every day.
 * - Wall clock ([wallMs]) only dates the record, never a game rule or a frame. A stored freeze keeps the time of the
 *   incident that caused it (a frozen frame, a lost context, the crashed visit), not of the last write: a record
 *   rewritten by every later visit would otherwise never age out, and one crash would start an active player's world
 *   safe for good.
 */
class HangMemory(private val guard: HangGuard, private val store: HangRecordStore?, private val wallMs: () -> Long,
                 private val writer: Executor = WRITER) {
    private var incidentAtMs = 0L
    private var openSinceMs: Long? = null
    private var stops = 0
    /** Clean realm-map visits since the stored freeze ([StoredHang.clean]). */
    private var clean = 0
    /** The open visit's steady full-quality samples in the map ([sampled]), and whether it froze or lost the context. */
    private var visitSteady = 0
    private var visitDirty = false
    /** Writes handed to [writer] that have not landed yet. */
    private val queued = AtomicInteger()

    /** Every write handed to the [writer] has landed (a background [realm] set is on disk). The host runs no realm-map
     *  GPU work before. */
    val onDisk: Boolean get() = queued.get() == 0

    fun start() {
        val stored = store?.load()
        val now = wallMs()
        stops = stored?.stops ?: 0
        // a served stop restarts as a freeze dated now (the guard alone would read the older one as expired)
        val served = stored?.let { servedStop(it, now) }?.also { stops++ }
        val record = served?.let { HangRecord(HangGuard.SAFE_LEVEL, now, it, null) } ?: stored?.record
        guard.start(record, now)
        incidentAtMs = record?.takeIf { guard.hazard != null }?.let { maxOf(it.atMs, it.pendingSinceMs ?: it.atMs) } ?: now
        clean = if (served == null) stored?.clean ?: 0 else 0 // a served stop is a fresh freeze: the visits before it proved nothing
        save()
    }

    /** A real freeze in this session: a lost context or a frozen frame ([HangGuard.FREEZE]). It is stored, dated now. A
     *  slow-frame trip or a recovery is never one: the guard answers those within the session. */
    fun incident() {
        incidentAtMs = wallMs(); clean = 0; visitDirty = true
        save()
    }

    /** One GPU sample the guard took ([HangGuard.sample]; the host feeds every one, after storing a freeze). [map]: drawn
     *  with the realm map on screen in its MAP set or deeper. Only a steady sample at full quality there counts toward a
     *  clean visit: the stored start level is not the visit's floor, so only full quality proves the freeze gone. */
    fun sampled(cold: Boolean, map: Boolean) {
        if (map && !cold && openSinceMs != null && guard.level == 0) visitSteady++
    }

    /** Realm-map GPU work is running (a realm preparing, a dive, a fade or the map on screen) or not; writes only when
     *  that changes, and the set is durable (on disk before the work that follows it). [background]: the set's commit
     *  runs on the [writer], not the calling GL thread (the globe's approach, which fires mid-pinch); the caller holds
     *  the work until [onDisk]. While a write waits on the writer every later one follows it there, so a clear never
     *  lands before the set it clears. */
    fun realm(open: Boolean, background: Boolean = false) {
        if (open == (openSinceMs != null)) return
        if (open) { visitSteady = 0; visitDirty = false }
        else if (guard.hazard != null && !visitDirty && visitSteady >= GpuSafe.CRASH_STEADY && ++clean >= GpuSafe.CRASH_CLEAN) { guard.forget(); clean = 0 }
        openSinceMs = if (open) wallMs() else null
        save(durable = open, background = open && background)
    }

    private fun save(durable: Boolean = false, background: Boolean = false) {
        val s = store ?: return
        val now = wallMs()
        // a device that served a stop keeps its count (a level-0 record) after its safe level ages out
        val record = guard.record(now, openSinceMs) ?: if (stops > 0) HangRecord(0, now, null, null) else null
        val value = record?.let { if (it.level > 0) StoredHang(it.copy(atMs = incidentAtMs), guard.stopped, stops, clean) else StoredHang(it, guard.stopped, stops) }
        val d = durable && value != null
        if (!background && queued.get() == 0) { s.save(value, d); return }
        val q = queued
        q.incrementAndGet()
        try { writer.execute { try { s.save(value, d) } finally { q.decrementAndGet() } } }
        catch (e: RejectedExecutionException) { q.decrementAndGet(); s.save(value, d) }
    }

    companion object {
        /** How long a stored record counts (the guard's `storeMs`). Lead bound, not a web number: one day, as the web's
         *  first contract pinned it. The web now keeps its record until clean visits follow (ported: [realm]) or the
         *  player's TRY AGAIN; native has no TRY AGAIN (a stopped map is the legacy globe), so the day bounds a record no
         *  clean visit cleared, and a repeated stop holds longer ([holdMs]). */
        const val STORE_MS = 24L * 3600 * 1000

        /** Lead bound (D-NEXT, not a web number): a stop holds [STORE_MS] doubled per stop served before it, at most this
         *  many times (2^6 days ≈ two months). */
        const val STOP_DOUBLINGS = 6

        /** The one thread background [realm] sets are written on: device-wide like the record, started by its first
         *  write, a daemon that holds nothing of a host between writes. */
        val WRITER: Executor by lazy { Executors.newSingleThreadExecutor { r -> Thread(r, "world-hang-writer").apply { isDaemon = true } } }

        private const val LOSS_STOP = "repeated lost graphics contexts stopped the realm map"
        private const val SAFE_MODE_CRASH = "a visit ended inside the realm map after an earlier freeze"

        /** How long a stop holds after [stops] served ones: [storeMs], doubled per served stop (at most [STOP_DOUBLINGS]). */
        fun holdMs(stops: Int, storeMs: Long = STORE_MS): Long = storeMs shl stops.coerceIn(0, STOP_DOUBLINGS)

        /** GPU_SAFE from the generated constants, with [STORE_MS]: the policy the host's guard runs with. */
        val POLICY = GpuSafePolicy(GpuSafe.SLOW_MS.toDouble(), GpuSafe.SEVERE_MS.toDouble(), GpuSafe.WINDOW, GpuSafe.NEED,
            GpuSafe.SEVERE_NEED, GpuSafe.UP_MS.toDouble(), GpuSafe.UP_AFTER, GpuSafe.COLD_UPLOAD_BYTES.toLong(), GpuSafe.LOSS_STOP, STORE_MS)

        /**
         * Why the GL30 world must not run on this device now, or null ([WorldEngineAdmission]; the legacy globe runs):
         * - the guard stopped the realm map (`lossStop` lost contexts in one session);
         * - a visit ended inside the realm map while the record already held a freeze (the web's "a crash while the stored
         *   level was already 2 holds the realm map": a repeated freeze is never re-run automatically).
         * Both hold for [holdMs] from their time; a record dated in the future (the clock went back) does not hold.
         */
        fun stopReason(stored: StoredHang?, nowMs: Long, storeMs: Long = STORE_MS): String? {
            if (stored == null) return null
            val hold = holdMs(stored.stops, storeMs)
            fun young(atMs: Long) = nowMs - atMs in 0 until hold
            if (stored.stopped && young(stored.record.atMs)) return LOSS_STOP
            val pending = stored.record.pendingSinceMs
            if (pending != null && stored.record.level >= HangGuard.SAFE_LEVEL && young(pending)) return SAFE_MODE_CRASH
            return null
        }

        /** The stop [stored] records once it no longer holds (why it stopped), or null (none, or it still holds). */
        private fun servedStop(stored: StoredHang, nowMs: Long): String? {
            if (stopReason(stored, nowMs) != null) return null
            return when {
                stored.stopped -> LOSS_STOP
                stored.record.pendingSinceMs != null && stored.record.level >= HangGuard.SAFE_LEVEL -> SAFE_MODE_CRASH
                else -> null
            }
        }
    }
}
