package gg.pixelkingdomwars.nativeclient.scene.world

import android.content.SharedPreferences
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GpuSafe
import gg.pixelkingdomwars.nativeclient.renderer.gl3.DirectProgramCompiler
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramBuilder
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMapEngine
import gg.pixelkingdomwars.nativeclient.renderer.world.HangGuard
import gg.pixelkingdomwars.nativeclient.renderer.world.HangRecord
import gg.pixelkingdomwars.nativeclient.renderer.world.HangRecovery
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * N5: the hang guard's crash record survives the process. Until N5 the host never persisted it, so a phone that hung or
 * crashed inside the realm map (a freeze, a GPU reset, a kill in the foreground) started the next visit at L0 and ran the
 * same view again. These tests run the host's own [HangMemory] with the guard and policy the host uses.
 */
class HangMemoryTest {
    private class Disk {
        val values = mutableMapOf<String, String>()
        var writes = 0
        val store = HangRecordStore({ values[it] }, { key, value, _ -> writes++; if (value == null) values.remove(key) else values[key] = value })
    }

    /** The app's SharedPreferences as [HangRecordStore.of] drives them: which writes were `commit()` (on disk before the
     *  caller goes on) and which `apply()` (queued ~100 ms on API 26+, lost when a driver SIGSEGV kills the process). */
    private class Prefs : SharedPreferences {
        val values = mutableMapOf<String, String>()
        val writes = mutableListOf<String>()
        override fun getString(key: String?, defValue: String?): String? = values[key] ?: defValue
        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            val puts = mutableMapOf<String, String?>()
            override fun putString(key: String?, value: String?): SharedPreferences.Editor { puts[key!!] = value; return this }
            override fun remove(key: String?): SharedPreferences.Editor { puts[key!!] = null; return this }
            override fun commit(): Boolean { flush(); writes += "commit"; return true }
            override fun apply() { flush(); writes += "apply" }
            private fun flush() { for ((k, v) in puts) if (v == null) values.remove(k) else values[k] = v }
            override fun putStringSet(key: String?, values: MutableSet<String>?): SharedPreferences.Editor = error("unused")
            override fun putInt(key: String?, value: Int): SharedPreferences.Editor = error("unused")
            override fun putLong(key: String?, value: Long): SharedPreferences.Editor = error("unused")
            override fun putFloat(key: String?, value: Float): SharedPreferences.Editor = error("unused")
            override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor = error("unused")
            override fun clear(): SharedPreferences.Editor = error("unused")
        }
        override fun getAll(): MutableMap<String, *> = values
        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? = error("unused")
        override fun getInt(key: String?, defValue: Int): Int = error("unused")
        override fun getLong(key: String?, defValue: Long): Long = error("unused")
        override fun getFloat(key: String?, defValue: Float): Float = error("unused")
        override fun getBoolean(key: String?, defValue: Boolean): Boolean = error("unused")
        override fun contains(key: String?): Boolean = key in values
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
    }
    private class Clock(var ms: Long) { val read: () -> Long = { ms } }

    private val day = HangMemory.STORE_MS
    private val t0 = 1_800_000_000_000L // a wall-clock date: the record must survive the process, so no monotonic clock

    /** One session: the host builds a fresh guard and memory per World entry, as [WorldEngineHost] does. */
    private fun session(disk: Disk, clock: Clock): Pair<HangGuard, HangMemory> {
        val guard = HangGuard(HangMemory.POLICY)
        return guard to HangMemory(guard, disk.store, clock.read).also { it.start() }
    }

    /** Slow GPU frames until the guard trips (frame time is the guard's own monotonic ms, never the wall clock). */
    private fun trip(guard: HangGuard) { var f = 0L; repeat(10) { guard.sample(400.0, cold = false, frameMs = f); f += 16 } }

    /** One frozen frame, as the host handles it: the guard trips and the memory stores the freeze. */
    private fun freeze(guard: HangGuard, memory: HangMemory) {
        assertEquals(HangGuard.FREEZE, guard.sample(HangRecovery.NATIVE.freezeMs, cold = false, frameMs = 0L)); memory.incident()
    }

    /** [n] ms of steady 60 fps frames from frame time [fromMs]. */
    private fun steady(guard: HangGuard, fromMs: Long, n: Long) {
        var f = fromMs; while (f < fromMs + n) { guard.sample(8.0, cold = false, frameMs = f); f += 16 }
        guard.sample(8.0, cold = false, frameMs = fromMs + n)
    }

    /** [n] GPU samples of [ms], one per 16 ms from frame time [fromMs], fed as the host's quality() feeds each one: the
     *  guard, a frozen frame stored, then the memory ([map]: the realm map on screen in its MAP set or deeper). Returns the
     *  next frame time. */
    private fun draw(guard: HangGuard, memory: HangMemory, fromMs: Long, n: Int, map: Boolean, ms: Double = 8.0, cold: Boolean = false): Long {
        var f = fromMs
        repeat(n) { if (guard.sample(ms, cold, frameMs = f) == HangGuard.FREEZE) memory.incident(); memory.sampled(cold, map); f += 16 }
        return f
    }

    /** One World host (every realm visit is a fresh one on the Seeker): it starts from the record, its guard lets go on
     *  the globe (6.4 s of steady frames), then it visits the realm map for [n] samples and leaves. Returns the level the
     *  host started at. */
    private fun visitAtFullQuality(disk: Disk, clock: Clock, n: Int = GpuSafe.CRASH_STEADY, map: Boolean = true, cold: Boolean = false): Int {
        val (guard, memory) = session(disk, clock)
        val start = guard.level
        val f = draw(guard, memory, 0L, 400, map = false)
        assertEquals("the guard let go before the visit", 0, guard.level)
        memory.realm(true); draw(guard, memory, f, n, map, cold = cold); memory.realm(false)
        clock.ms += 60_000
        return start
    }

    @Test fun `the record round-trips through the store, and an unreadable one is no record`() {
        val disk = Disk()
        val stored = StoredHang(HangRecord(2, t0, "a frozen GPU frame", t0 - 5), stopped = true)
        disk.store.save(stored)
        assertEquals(stored, disk.store.load())
        assertTrue("written under the current rule", "\"v\":${HangRecordStore.VERSION}" in disk.values.getValue(HangRecordStore.KEY))
        disk.store.save(StoredHang(HangRecord(0, t0, null, t0), stopped = false))
        assertEquals(StoredHang(HangRecord(0, t0, null, t0), false), disk.store.load())
        disk.store.save(null)
        assertTrue("null removes the record", disk.values.isEmpty())
        disk.values[HangRecordStore.KEY] = "{not json"
        assertNull("a corrupt record is no record (never a crash on the World tab)", disk.store.load())
        assertNull(HangRecordStore({ error("unreadable") }, { _, _, _ -> }).load())
        HangRecordStore({ null }, { _, _, _ -> error("disk full") }).save(stored) // a failed write is dropped, never thrown on the GL thread
    }

    @Test fun `a visit that dies inside the realm map starts the next session safe`() {
        val disk = Disk(); val clock = Clock(t0)
        val (guard, memory) = session(disk, clock)
        assertEquals(0, guard.level)
        assertTrue("a healthy start leaves no record", disk.values.isEmpty())
        clock.ms += 1_000; memory.realm(true) // a dive: the pending marker is written before the map's GPU work
        assertEquals(t0 + 1_000, disk.store.load()!!.record.pendingSinceMs)
        // the process dies here (no leave, no pause): the next session reads the marker before its first frame
        clock.ms += 60_000
        val (next, nextMemory) = session(disk, clock)
        assertEquals("the stored crash starts the next session safe", HangGuard.SAFE_LEVEL, next.level)
        // Why (owner, Seeker code 30): a stored level used to floor the whole session, so the ground stayed at 1/3 scale
        // with no way back. It is a start: 5 s of steady frames let it go, as after an in-session trip.
        assertEquals("not a floor", 0, next.floor)
        steady(next, 7_000_000L, 5_000L)
        assertEquals("full quality after 5 s of steady frames", 0, next.level)
        nextMemory.realm(true); nextMemory.realm(false) // a clean visit after the release rewrites the record
        assertEquals("the freeze stays stored, dated by the visit that died", HangGuard.SAFE_LEVEL to t0 + 1_000,
            disk.store.load()!!.record.let { it.level to it.atMs })
        clock.ms += 60_000
        assertEquals("so the session after starts safe again", HangGuard.SAFE_LEVEL, session(disk, clock).first.level)
    }

    /**
     * Why (owner, Seeker code 30, 2026-09-26 12:28:28): an ordinary slow-frame trip at MAP entry was stored, and every later
     * World session started at 1/3-scale ground. The web stores no watchdog step ("a slow-but-alive GPU is not a hazard"):
     * the guard and the ladder answer it within the session. Only a real freeze is stored: a lost context, a frozen frame.
     */
    @Test fun `a slow-frame trip is never stored and a frozen frame or a lost context is`() {
        val disk = Disk(); val clock = Clock(t0)
        val (guard, memory) = session(disk, clock)
        trip(guard)
        assertEquals(HangGuard.SAFE_LEVEL, guard.level)
        memory.realm(true); memory.realm(false) // the visit's own writes after the trip
        assertTrue("a slow-frame trip leaves nothing behind", disk.values.isEmpty())
        clock.ms += 60_000
        assertEquals("the next session starts at full quality", 0, session(disk, clock).first.level)

        val (g2, m2) = session(disk, clock)
        freeze(g2, m2)
        val frozen = requireNotNull(disk.store.load())
        assertEquals(HangGuard.SAFE_LEVEL, frozen.record.level); assertEquals("a frozen GPU frame", frozen.record.reason)
        assertNull("the realm map is closed", frozen.record.pendingSinceMs)
        clock.ms += 3_600_000
        assertEquals(HangGuard.SAFE_LEVEL, session(disk, clock).first.level)

        val lost = Disk(); val (g3, m3) = session(lost, clock)
        g3.contextLost(); m3.incident()
        assertEquals("a lost graphics context", lost.store.load()!!.record.reason)
        assertEquals(HangGuard.SAFE_LEVEL, session(lost, clock).first.level)
    }

    /**
     * Why: the owner's Seeker holds a code-30 record of an ordinary slow-frame trip, and so may any phone that ran code 30.
     * Under that rule the record floors the session at the safe level for a day; the next build must start those phones
     * clean instead of honouring a record the new rule would never have written.
     */
    @Test fun `a record written by code 30's rule is no record and the first start removes it`() {
        val disk = Disk()
        // what code 30 wrote after a session that started from its own stored trip (the floor field, no version)
        disk.values[HangRecordStore.KEY] = """{"level":2,"atMs":$t0,"reason":"slow GPU frames","floor":2}"""
        assertNull(disk.store.load())
        assertEquals("full quality on the next build", 0, session(disk, Clock(t0 + 60_000)).first.level)
        assertTrue("and the old record is gone", disk.values.isEmpty())
        disk.values[HangRecordStore.KEY] = """{"level":2,"atMs":$t0,"reason":"a lost graphics context","floor":2,"stopped":true,"stops":1}"""
        assertNull("its stops too", HangMemory.stopReason(disk.store.load(), t0 + 1))
    }

    @Test fun `a clean leave and a pause clear the pending marker`() {
        val disk = Disk(); val clock = Clock(t0)
        val (_, memory) = session(disk, clock)
        memory.realm(true); assertNotNull(disk.store.load())
        memory.realm(false)
        assertTrue("a clean leave at L0 leaves no record", disk.values.isEmpty())
        assertEquals("the next session starts at full quality", 0, session(disk, clock).first.level)
        // the host marks the realm on every frame; the store is written only when that changes (never per frame)
        val (_, again) = session(disk, clock)
        val before = disk.writes
        repeat(100) { again.realm(true) }
        assertEquals(before + 1, disk.writes)
        repeat(100) { again.realm(false) }
        assertEquals(before + 2, disk.writes)
    }

    @Test fun `a stored freeze ages out by the guard's storeMs from its incident, however often it is rewritten`() {
        val disk = Disk(); val clock = Clock(t0)
        val (guard, memory) = session(disk, clock)
        memory.realm(true); freeze(guard, memory); memory.realm(false)
        // later sessions start safe and rewrite the record at every dive and leave; the incident's date must not move, or
        // one crash would start an active player's world safe for good
        repeat(3) {
            clock.ms += day / 4
            val (g, m) = session(disk, clock)
            assertEquals(HangGuard.SAFE_LEVEL, g.level)
            m.realm(true); m.realm(false)
            assertEquals(t0, disk.store.load()!!.record.atMs)
        }
        clock.ms = t0 + day - 1
        assertEquals("still inside storeMs", HangGuard.SAFE_LEVEL, session(disk, clock).first.level)
        clock.ms = t0 + day
        assertEquals("an old record expires: full quality again", 0, session(disk, clock).first.level)
        assertTrue("and the expired record is dropped at that start", disk.values.isEmpty())
    }

    @Test fun `a young pending marker counts from the visit that died`() {
        val disk = Disk()
        disk.store.save(StoredHang(HangRecord(0, t0, null, t0), stopped = false))
        assertEquals(HangGuard.SAFE_LEVEL, session(disk, Clock(t0 + day - 1)).first.level)
        disk.store.save(StoredHang(HangRecord(0, t0, null, t0), stopped = false))
        assertEquals("a marker older than storeMs is not a recent crash", 0, session(disk, Clock(t0 + day)).first.level)
    }

    @Test fun `the realm map stops after a repeated freeze or the guard's lost-context stop`() {
        assertNull(HangMemory.stopReason(null, t0))
        // a first crash only starts the next session safe; the map still runs
        val firstCrash = StoredHang(HangRecord(0, t0, null, t0), stopped = false)
        assertNull(HangMemory.stopReason(firstCrash, t0 + 1))
        // the session after it starts safe and dies inside the map again: a repeated freeze is never re-run automatically,
        // at whatever level the guard had let it go to by then
        val disk = Disk(); disk.store.save(firstCrash); val clock = Clock(t0 + 60_000)
        val (guard, memory) = session(disk, clock)
        assertEquals(HangGuard.SAFE_LEVEL, guard.level)
        steady(guard, 0L, 5_000L); assertEquals(0, guard.level)
        clock.ms += 1_000; memory.realm(true)
        val reason = HangMemory.stopReason(disk.store.load(), clock.ms + 5_000)
        assertEquals("a visit ended inside the realm map after an earlier freeze", reason)
        assertNull("until storeMs has passed since that visit", HangMemory.stopReason(disk.store.load(), clock.ms + day))
        assertNull("a clean leave of that session stops nothing", HangMemory.stopReason(disk.store.load()!!.copy(record = disk.store.load()!!.record.copy(pendingSinceMs = null)), clock.ms + 5_000))
        // lossStop lost contexts in one session stop the map, and the stored record keeps later visits on the legacy globe
        val lost = Disk(); val lostClock = Clock(t0)
        val (g2, m2) = session(lost, lostClock)
        repeat(HangMemory.POLICY.lossStop) { g2.contextLost(); m2.incident() }
        assertTrue(g2.stopped)
        m2.realm(false)
        assertEquals("repeated lost graphics contexts stopped the realm map", HangMemory.stopReason(lost.store.load(), t0 + day - 1))
        assertNull(HangMemory.stopReason(lost.store.load(), t0 + day))
        assertNull("a record dated in the future (the clock went back) holds nothing", HangMemory.stopReason(lost.store.load(), t0 - 1))
    }

    @Test fun `the host starts the guard from the record before the first frame and stores every real freeze`() {
        // The persistence only works through these host lines: without start() every session is L0 again; without the
        // realm marker a crash inside the map is invisible; without the pause a background kill reads as a crash.
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
        assertTrue("the host's guard runs the policy with the record's store window", "private val hang = HangGuard(HangMemory.POLICY)" in host)
        assertTrue("private val memory = HangMemory(hang, inputs.hangStore, System::currentTimeMillis)" in host)
        val create = host.substring(host.indexOf("override fun create()"), host.indexOf("private fun start(world: WorldGraphics"))
        assertTrue("read before the first frame", create.indexOf("memory.start()") in 0 until create.indexOf("start(world, choice.paths)"))
        val render = host.substring(host.indexOf("override fun render()"), host.indexOf("private fun frame(c: Gl3Core"))
        val marks = Regex("""memory\.realm\(realmMarked\(\)\)""").findAll(render).map { it.range.first }.toList()
        assertEquals("the frame marks before its GL work and clears after it", 2, marks.size)
        assertTrue("set before the frame's first realm draw (the one after a resume too)", marks[0] < render.indexOf("frame(c, now)"))
        assertTrue("cleared only once the frame's work is done", marks[1] > render.indexOf("frame(c, now)"))
        val pause = host.substring(host.indexOf("override fun pause()"), host.indexOf("override fun resume()"))
        assertTrue("a pause is a clean leave", "memory.realm(false)" in pause)
        val dispose = host.substring(host.indexOf("override fun dispose()"), host.indexOf("override fun render()"))
        assertTrue("so is a dispose", "memory.realm(false)" in dispose)
        val quality = host.substring(host.indexOf("private fun quality("), host.indexOf("fun thermal("))
        assertTrue("a lost context is an incident", "val stop = hang.contextLost(); memory.incident()" in quality)
        assertTrue("so is a frozen frame", "if (step == HangGuard.FREEZE) memory.incident()" in quality)
        assertEquals("and nothing else is stored: a slow-frame trip and a recovery stay in the session", 2,
            Regex("""memory\.incident\(\)""").findAll(quality).count())
        assertTrue("the guard's stop rule hands the tab back to the legacy globe", Regex("""if \(stop\) fail\(""").containsMatchIn(quality))
        val surface = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineSurface.kt").readText()
        assertTrue("the World tab's host gets the device's store", "lease, HangRecordStore.of(context))" in surface)
    }

    @Test fun `the pending marker is on disk before the realm map's GPU work, and every other write is queued`() {
        // A driver SIGSEGV in the realm's first draws kills the process at once: an apply() queued ~100 ms earlier never
        // reaches the disk, the next session starts at L0 and the same draw crashes again.
        val prefs = Prefs(); val clock = Clock(t0)
        val guard = HangGuard(HangMemory.POLICY)
        val memory = HangMemory(guard, HangRecordStore.of(prefs), clock.read)
        memory.start(); memory.realm(true)
        assertEquals("the marker's set is a commit()", listOf("apply", "commit"), prefs.writes)
        assertEquals(t0, HangRecordStore.of(prefs).load()!!.record.pendingSinceMs)
        freeze(guard, memory); memory.realm(false)
        assertEquals("a stored freeze and a clear stay off the GL thread", listOf("apply", "commit", "apply", "apply"), prefs.writes)
    }

    @Test fun `the approach's marker goes to disk off the GL thread, in order, and says when it has landed`() {
        // The globe's approach fires mid-pinch (a pinch aiming below alt 0.5), and its commit() was an fsync on the GL
        // thread with the fingers down. The marker must still be on disk before the realm's first GPU work (a driver
        // SIGSEGV there kills the process at once), so the host holds that work until [HangMemory.onDisk].
        val prefs = Prefs(); val clock = Clock(t0)
        val queue = ArrayList<Runnable>()
        val memory = HangMemory(HangGuard(HangMemory.POLICY), HangRecordStore.of(prefs), clock.read, writer = { queue += it })
        memory.start()
        assertEquals(listOf("apply"), prefs.writes)
        memory.realm(true, background = true)
        assertEquals("nothing written on the calling (GL) thread", listOf("apply"), prefs.writes)
        assertFalse("not on disk yet: the realm's GPU work waits", memory.onDisk)
        memory.realm(true) // the frame's own mark after it: already set
        clock.ms += 5; memory.realm(false) // cleared before the writer ran (a pause): it must land after the set, never first
        assertEquals("the clear queues behind the set", listOf("apply"), prefs.writes)
        assertEquals(2, queue.size)
        queue.removeAt(0).run()
        assertEquals("the set is still a commit(), on the writer", listOf("apply", "commit"), prefs.writes)
        assertEquals(t0, HangRecordStore.of(prefs).load()!!.record.pendingSinceMs)
        assertFalse("the clear has not landed yet", memory.onDisk)
        queue.removeAt(0).run()
        assertEquals(listOf("apply", "commit", "apply"), prefs.writes)
        assertNull("the last write wins on disk", HangRecordStore.of(prefs).load())
        assertTrue(memory.onDisk)
        memory.realm(true) // a dive's own mark: on disk before it returns, as before
        assertEquals(listOf("apply", "commit", "apply", "commit"), prefs.writes)
        assertTrue(queue.isEmpty())
        // a writer that refuses the job never loses the marker: it is written at once, as before
        val refused = Prefs()
        val m2 = HangMemory(HangGuard(HangMemory.POLICY), HangRecordStore.of(refused), clock.read,
            writer = { throw java.util.concurrent.RejectedExecutionException("stopped") })
        m2.start(); m2.realm(true, background = true)
        assertEquals(listOf("apply", "commit"), refused.writes)
        assertTrue(m2.onDisk)
    }

    @Test fun `a stop that ages out resumes at the safe level, and the next stop holds twice as long`() {
        // A phone whose realm map freezes at every level. Until this rule the day-old stop expired to L0: it froze at L0,
        // then at the safe level, was stopped for a day, and did it all again every day, silently in release.
        val disk = Disk(); val clock = Clock(t0)
        fun freezeInsideTheMap(): HangGuard { val (g, m) = session(disk, clock); m.realm(true); clock.ms += 1_000; return g } // the process dies
        assertEquals(0, freezeInsideTheMap().level)
        clock.ms += 3_600_000
        assertEquals("the first freeze starts the next session safe", HangGuard.SAFE_LEVEL, freezeInsideTheMap().level)
        val firstStop = clock.ms
        assertEquals("a visit ended inside the realm map after an earlier freeze", HangMemory.stopReason(disk.store.load(), firstStop))
        assertNotNull("the first stop holds a day", HangMemory.stopReason(disk.store.load(), firstStop + day - 2_000))
        clock.ms = firstStop + day
        assertNull(HangMemory.stopReason(disk.store.load(), clock.ms))
        val back = freezeInsideTheMap()
        assertEquals("a served stop comes back at the safe level, never L0", HangGuard.SAFE_LEVEL, back.level)
        assertEquals("stored as a fresh freeze, so one more death inside the map stops it again",
            "a visit ended inside the realm map after an earlier freeze", back.hazard)
        val secondStop = clock.ms
        assertNotNull("it froze again at the safe level: the stop now holds two days",
            HangMemory.stopReason(disk.store.load(), secondStop + 2 * day - 2_000))
        assertNull(HangMemory.stopReason(disk.store.load(), secondStop + 2 * day))
        clock.ms = secondStop + 2 * day
        assertEquals(HangGuard.SAFE_LEVEL, freezeInsideTheMap().level)
        assertNotNull("and four after that", HangMemory.stopReason(disk.store.load(), clock.ms + 4 * day - 2_000))
        assertEquals("the hold stops doubling at the cap", day shl HangMemory.STOP_DOUBLINGS, HangMemory.holdMs(HangMemory.STOP_DOUBLINGS + 3))
        // the lost-context stop is served the same way
        val lost = Disk()
        lost.store.save(StoredHang(HangRecord(HangGuard.SAFE_LEVEL, t0, "a lost graphics context", null), stopped = true))
        val (g, _) = session(lost, Clock(t0 + day))
        assertEquals(HangGuard.SAFE_LEVEL, g.level)
        assertEquals(1, lost.store.load()!!.stops)
    }

    @Test fun `a served stop's count outlives its safe level, so the next stop still holds longer`() {
        val disk = Disk(); val clock = Clock(t0)
        disk.store.save(StoredHang(HangRecord(HangGuard.SAFE_LEVEL, t0, null, t0), stopped = false))
        clock.ms = t0 + day
        assertEquals(HangGuard.SAFE_LEVEL, session(disk, clock).first.level)
        clock.ms += day // no visit for a day: the safe level ages out
        val (idle, _) = session(disk, clock)
        assertEquals("full quality again", 0, idle.level)
        assertEquals("but the device's stop count stays", 1, disk.store.load()?.stops)
        val (_, m) = session(disk, clock); m.realm(true) // freezes at L0
        clock.ms += 60_000
        val (safe, m2) = session(disk, clock); m2.realm(true) // and again at the safe level
        assertEquals(HangGuard.SAFE_LEVEL, safe.level)
        assertNotNull("a second stop holds two days, not one", HangMemory.stopReason(disk.store.load(), clock.ms + 2 * day - 1))
    }

    @Test fun `the pending marker spans every stretch of realm-map GPU work, the panel's rehearsal behind the globe included`() {
        // Opening a realm's panel prepares it behind the globe: adoption creates its programs and textures and idle globe
        // frames first-draw every pair (D-173 rehearsal), the driver stall GPU_SAFE exists for. Unmarked, a driver that
        // hangs there was never recorded, and every panel open hung again at L0.
        val globe = WorldEngineHost.MODE_GLOBE
        for (status in listOf(RealmMapEngine.STATUS_LOADING, RealmMapEngine.STATUS_UPLOADING, RealmMapEngine.STATUS_REHEARSING))
            assertTrue("a realm preparing behind the globe ($status)", WorldEngineHost.realmMarked(globe, "frostveil", status))
        assertFalse("a ready realm waits behind the globe with no GPU work", WorldEngineHost.realmMarked(globe, "frostveil", RealmMapEngine.STATUS_READY))
        // D-NEXT: a realm whose core is ready still prefetches its lanes behind the globe (programs, uploads, pairs)
        assertTrue("a ready core whose lanes still prefetch", WorldEngineHost.realmMarked(globe, "frostveil", RealmMapEngine.STATUS_READY, prefetch = true))
        assertFalse("a failed one does none", WorldEngineHost.realmMarked(globe, "frostveil", RealmMapEngine.STATUS_FAILED))
        assertFalse("nor does the globe alone", WorldEngineHost.realmMarked(globe, null, RealmMapEngine.STATUS_NONE))
        for (mode in listOf(WorldEngineHost.MODE_DIVE_WAIT, WorldEngineHost.MODE_FADE_IN, WorldEngineHost.MODE_REALM, WorldEngineHost.MODE_FADE_OUT))
            assertTrue("a dive, a fade, the map on screen ($mode)", WorldEngineHost.realmMarked(mode, "frostveil", RealmMapEngine.STATUS_READY))
        // and it is written before the work, in the frame that starts it
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
        val prepare = host.substring(host.indexOf("private fun prepare(realmId: String)"), host.indexOf("private fun flyToDeed("))
        assertTrue("the panel's prepare marks before this frame's update adopts the load",
            prepare.indexOf("memory.realm(realmMarked())") > prepare.indexOf("r.prepare(realmId)"))
        val dive = host.substring(host.indexOf("private fun beginDive"), host.indexOf("private fun diveStep"))
        assertTrue("a dive marks before the same frame's diveStep draws", dive.indexOf("memory.realm(true)") in dive.indexOf("mode = MODE_DIVE_WAIT") until dive.indexOf("r.prepare(realmId)"))
        val frame = host.substring(host.indexOf("private fun frame(c: Gl3Core"), host.indexOf("private fun beginDive"))
        assertTrue("the globe rehearses only a realm that is not ready or still prefetching, which the marker covers",
            "else if (r != null && r.realmId != null && (!r.ready || r.prefetchDue) && realmWork && now - lastMotionMs >= GpuSafe.REHEARSE_IDLE_MS) r.rehearseStep(now)" in frame)
        assertTrue("the marker is told about the prefetch", "realmMarked(mode, realm?.realmId, realm?.status ?: RealmMapEngine.STATUS_NONE, realm?.prefetchDue == true)" in host)
        assertEquals("no other realm GPU work on the globe", 1, Regex("""rehearseStep\(""").findAll(frame.substring(0, frame.indexOf("MODE_FADE_IN, MODE_FADE_OUT ->"))).count())
    }

    /**
     * Why (review of 93dbe6e): a GPU sample runs from a frame's fence to the last poll that still saw it unsignalled. The
     * host stamped the fence with the frame's START, so a frame that held the GL thread for a second on the CPU (a durable
     * commit on slow flash, a blocking GC near the heap cap, a compositor wait) and left a few ms of GPU work in flight
     * read as a one-second GPU frame: a freeze, stored for a day, on a phone whose GPU never froze. The web stamps at
     * submit (core.js gpuEnd: a main-thread stall never inflates the bound).
     */
    @Test fun `a long CPU frame is never stored as a GPU freeze, because the fence is stamped when it is inserted`() {
        fun longCpuFrame(stampAtStart: Boolean): Pair<HangGuard, Disk> {
            val world = RecordingGl3("world")
            val core = Gl3Core(world.gl, DirectProgramCompiler(ProgramBuilder(world.gl, null, "RealmView", 0)), 256 * 1024L, strict = true).apply { resize(8, 8) }
            val disk = Disk()
            val (guard, memory) = session(disk, Clock(t0))
            var t = 1_000_000_000L
            // one frame [cpuMs] long on the GL thread, then the swap; its report's samples go to the guard as in quality()
            fun frame(cpuMs: Long, gpuTailInFlight: Boolean = false) {
                val start = t
                world.signalled = { !gpuTailInFlight }
                check(core.beginFrame(start, 1L))
                t += cpuMs * 1_000_000L
                val report = core.endFrame(if (stampAtStart) start else t)
                for (i in 0 until report.gpuSampleCount)
                    if (guard.sample(report.gpuSamplesMs[i], report.gpuSamplesCold[i], frameMs = t / 1_000_000L) == HangGuard.FREEZE) memory.incident()
                t += 2_000_000L
            }
            repeat(3) { frame(8) }
            frame(1_100) // a second on the CPU; its few ms of GPU work are still in flight when the next frame starts
            frame(8, gpuTailInFlight = true)
            repeat(3) { frame(8) }
            return guard to disk
        }
        assertEquals("the scenario: stamped with the frame's start, the CPU second reads as a frozen GPU frame",
            "a frozen GPU frame", longCpuFrame(stampAtStart = true).second.store.load()?.record?.reason)
        val (guard, disk) = longCpuFrame(stampAtStart = false)
        assertEquals("stamped when inserted, the sample is the GPU tail alone: no trip", 0, guard.level)
        assertTrue("and nothing is stored", disk.values.isEmpty())
        // the host stamps each fence when endFrame inserts it, never with the frame's start
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
        val render = host.substring(host.indexOf("override fun render()"), host.indexOf("private fun frame(c: Gl3Core"))
        assertTrue("endFrame reads the clock when it inserts the fence", "report = c.endFrame(System.nanoTime())" in render)
        assertEquals("the only endFrame of the frame", 1, Regex("""endFrame\(""").findAll(render).count())
    }

    /**
     * Why (review of 93dbe6e): one stored freeze started every World host at the safe level for a day, and the owner's
     * Seeker built ten hosts in five minutes (code 30): the blocky 1/3-scale ground at the start of every realm visit and
     * a still globe, all day. The record also stayed armed, so any later death inside the map (an unrelated crash) stopped
     * the GL30 world for a day. The web clears a stored level after `GPU_SAFE.crash.clean` clean visits (core.js
     * gpuRecord.leave): visits that drew `crash.steady` steady frames in the map with nothing frozen or lost. Native
     * counts them at full quality (the guard let go), because its stored level is a start, not the visit's floor.
     */
    @Test fun `clean realm-map visits at full quality clear a stored freeze before its day is out`() {
        val disk = Disk(); val clock = Clock(t0)
        val (guard, memory) = session(disk, clock)
        memory.realm(true); freeze(guard, memory); memory.realm(false)
        clock.ms += 60_000
        val starts = List(GpuSafe.CRASH_CLEAN) { visitAtFullQuality(disk, clock) }
        assertEquals("each of those hosts started safe", List(GpuSafe.CRASH_CLEAN) { HangGuard.SAFE_LEVEL }, starts)
        assertTrue("then the freeze is no longer stored", disk.values.isEmpty())
        assertTrue("well inside its day", clock.ms - t0 < day / 100)
        assertEquals("the next host starts at full quality", 0, session(disk, clock).first.level)
        // a death inside the map after that is a first crash again, never the stop an armed record makes
        val (_, next) = session(disk, clock); next.realm(true)
        assertNull(HangMemory.stopReason(disk.store.load(), clock.ms + 1_000))
    }

    /** The stored freeze of the clean-visit tests is still there: the host starts safe from it. */
    private fun assertStillSafe(why: String, disk: Disk, clock: Clock) = assertEquals(why, HangGuard.SAFE_LEVEL to "a frozen GPU frame",
        session(disk, clock).first.let { it.level to it.hazard })

    /** A visit proves the freeze gone only by drawing the realm map itself, at full quality, for long enough: the web's "a
     *  few seconds at FAR proved nothing about a MAP freeze" (W1 fix pass 2 #6). Each visit proves it on its own. */
    @Test fun `a visit is clean only with enough steady full-quality frames drawn in the map itself`() {
        val disk = Disk(); val clock = Clock(t0)
        session(disk, clock).let { (g, m) -> freeze(g, m) }
        clock.ms += 60_000
        repeat(GpuSafe.CRASH_CLEAN) { visitAtFullQuality(disk, clock, n = GpuSafe.CRASH_STEADY - 1) }
        assertStillSafe("too few steady frames", disk, clock)
        repeat(GpuSafe.CRASH_CLEAN) { visitAtFullQuality(disk, clock, n = 10 * GpuSafe.CRASH_STEADY, map = false) }
        assertStillSafe("frames off the map (the globe, a dive, the FAR band)", disk, clock)
        repeat(GpuSafe.CRASH_CLEAN) { visitAtFullQuality(disk, clock, n = 10 * GpuSafe.CRASH_STEADY, cold = true) }
        assertStillSafe("cold frames (one-off driver work)", disk, clock)
        repeat(GpuSafe.CRASH_CLEAN) {
            val (g, m) = session(disk, clock)
            m.realm(true); draw(g, m, 0L, 2 * GpuSafe.CRASH_STEADY, map = true); m.realm(false) // left before the guard let go
            assertEquals(HangGuard.SAFE_LEVEL, g.level)
            clock.ms += 60_000
        }
        assertStillSafe("frames at the safe level", disk, clock)
        run {
            val (g, m) = session(disk, clock)
            var f = draw(g, m, 0L, 400, map = false)
            repeat(2 * GpuSafe.CRASH_CLEAN) { m.realm(true); f = draw(g, m, f, GpuSafe.CRASH_STEADY - 1, map = true); m.realm(false) }
            clock.ms += 60_000
        }
        assertStillSafe("short visits of one host never add up", disk, clock)
        repeat(GpuSafe.CRASH_CLEAN) { visitAtFullQuality(disk, clock) }
        assertEquals("while enough full-quality frames in the map clear it", 0, session(disk, clock).first.level)
    }

    @Test fun `a visit that froze counts nothing, the host's later visits do, and a new freeze restarts the count`() {
        val disk = Disk(); val clock = Clock(t0)
        session(disk, clock).let { (g, m) -> freeze(g, m) }
        clock.ms += 60_000
        run {
            val (g, m) = session(disk, clock)
            var f = draw(g, m, 0L, 400, map = false)
            m.realm(true)
            f = draw(g, m, f, GpuSafe.CRASH_STEADY, map = true)
            f = draw(g, m, f, 1, map = true, ms = HangRecovery.NATIVE.freezeMs)
            f = draw(g, m, f, 400, map = true)
            assertEquals("the guard let go again inside the visit", 0, g.level)
            f = draw(g, m, f, GpuSafe.CRASH_STEADY, map = true)
            m.realm(false)
            repeat(GpuSafe.CRASH_CLEAN - 1) { m.realm(true); f = draw(g, m, f, GpuSafe.CRASH_STEADY, map = true); m.realm(false) }
            clock.ms += 60_000
        }
        assertStillSafe("the visit that froze counted nothing, however long it drew afterwards", disk, clock)
        visitAtFullQuality(disk, clock)
        assertEquals("the same host's later visits did count", 0, session(disk, clock).first.level)
        // a new freeze one clean visit short of the count (here on the globe) starts it again
        session(disk, clock).let { (g, m) -> freeze(g, m) }
        clock.ms += 60_000
        repeat(GpuSafe.CRASH_CLEAN - 1) { visitAtFullQuality(disk, clock) }
        session(disk, clock).let { (g, m) -> freeze(g, m) }
        clock.ms += 60_000
        repeat(GpuSafe.CRASH_CLEAN - 1) { visitAtFullQuality(disk, clock) }
        assertStillSafe("the count restarted at the new freeze", disk, clock)
        visitAtFullQuality(disk, clock)
        assertEquals("and the full count clears it", 0, session(disk, clock).first.level)
    }

    /** The clear keeps the device's served stops, so the next stop still holds longer; and a served stop, which restarts
     *  as a fresh freeze, needs its own full count of clean visits (a visit before the stop proved nothing about it). */
    @Test fun `clearing a freeze keeps the device's stop count, and a served stop needs its own clean visits`() {
        val disk = Disk(); val clock = Clock(t0)
        val (g, m) = session(disk, clock); freeze(g, m)
        clock.ms += 60_000
        repeat(GpuSafe.CRASH_CLEAN - 1) { visitAtFullQuality(disk, clock) }
        session(disk, clock).second.realm(true) // one clean visit short, a visit dies inside the map: the stop
        assertNotNull(HangMemory.stopReason(disk.store.load(), clock.ms + 1_000))
        clock.ms += day
        assertNull("served", HangMemory.stopReason(disk.store.load(), clock.ms))
        repeat(GpuSafe.CRASH_CLEAN - 1) { visitAtFullQuality(disk, clock) }
        assertEquals("the served stop is a fresh freeze: the visits before it do not count", HangGuard.SAFE_LEVEL, session(disk, clock).first.level)
        visitAtFullQuality(disk, clock)
        val cleared = requireNotNull(disk.store.load()) { "the device keeps its stop count" }
        assertEquals("cleared", 0 to null, cleared.record.level to cleared.record.reason)
        assertEquals("the served stop still counts", 1, cleared.stops)
        assertEquals(0, session(disk, clock).first.level)
    }

    @Test fun `the host feeds every GPU sample to the clean-visit count, with the realm map's band`() {
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
        val quality = host.substring(host.indexOf("private fun quality("), host.indexOf("fun thermal("))
        assertTrue("only the map on screen in its MAP set or deeper counts",
            "val inMap = mode == MODE_REALM && RealmBand.set(realm?.stats?.band ?: RealmBand.FAR) >= RealmBand.set(RealmBand.MAP)" in quality)
        val loop = quality.substring(quality.indexOf("for (i in 0 until report.gpuSampleCount)"), quality.indexOf("ladder.hangLevel("))
        val fed = loop.indexOf("memory.sampled(report.gpuSamplesCold[i], inMap)")
        assertTrue("every sample, after the guard took it and a freeze was stored", fed > loop.indexOf("if (step == HangGuard.FREEZE) memory.incident()"))
    }
}
