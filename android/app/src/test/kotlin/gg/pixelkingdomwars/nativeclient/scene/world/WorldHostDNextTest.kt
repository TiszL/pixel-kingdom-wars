package gg.pixelkingdomwars.nativeclient.scene.world

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * D-NEXT (amends D-173, "overview first, live") and P0 at the host: the owner must not wait more than about a second
 * for a realm map, and a World session must give back each realm's memory. The rules live in pure code the renderer's
 * tests pin (GlobeApproach, DiveCoverClock); only these host lines put them to work, and the host is Android-bound, so
 * its wiring is checked in its source, as `WorldEngineIntegrationTest` checks its other hooks.
 */
class WorldHostDNextTest {
    private val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
    private fun between(from: String, to: String): String = host.substring(host.indexOf(from), host.indexOf(to, host.indexOf(from)))

    @Test fun `the earlier of two wakes wins, and none means none`() {
        assertEquals(-1.0, WorldEngineHost.earliestWake(-1.0, -1.0), 0.0)
        assertEquals(250.0, WorldEngineHost.earliestWake(-1.0, 250.0), 0.0)
        assertEquals(250.0, WorldEngineHost.earliestWake(250.0, -1.0), 0.0)
        assertEquals(0.0, WorldEngineHost.earliestWake(4_000.0, 0.0), 0.0)
    }

    @Test fun `the approach asks the engine for the realm's core alone, only on the globe and never over the open realm`() {
        // the owner pinch-dives without the panel: without this every dive was cold (2.6–5.7 s on the Seeker, 0.47 s warm)
        val events = between("private val globeEvents = object : GlobeEvents {", "private fun target(pick: GlobePickV2)")
        assertTrue("override fun approach(realmId: String) = prefetchApproach(realmId)" in events)
        val approach = between("private fun prefetchApproach(realmId: String)", "/** The realm panel opened")
        assertTrue("only on the globe, a realm with a map, and never over the open realm",
            "if (mode != MODE_GLOBE || realmId !in mapIds || r.active) return" in approach)
        assertTrue("the core FAR set alone: ~8 MB of GL, no lanes", "r.prepare(realmId, /* lanes = */ false)" in approach)
        assertFalse("a realm already resident is the engine's to keep (a re-approach restarts its eviction)", "r.realmId == realmId" in approach)
        assertTrue("the hang marker is set after the prepare, off the GL thread (the approach fires mid-pinch)",
            approach.indexOf("memory.realm(realmMarked(), background = true)") > approach.indexOf("r.prepare(realmId, /* lanes = */ false)"))
    }

    @Test fun `no realm GPU work runs before the approach's hang marker is on disk`() {
        // The approach's commit() moved off the GL thread (an fsync mid-pinch stuttered the globe), but a driver SIGSEGV in
        // the realm's first GPU work kills the process at once: the marker must be on disk before that work, whatever the
        // frame. The realm's adoption, the globe's idle rehearsal and the dive's rehearsal and entry all wait for it.
        val frame = between("private fun frame(c: Gl3Core", "private fun beginDive")
        assertTrue("val realmWork = work && memory.onDisk" in frame)
        assertTrue("the realm adopts its load only then", "r?.update(now, realmWork)" in frame)
        assertTrue("the globe's idle rehearsal only then",
            "else if (r != null && r.realmId != null && (!r.ready || r.prefetchDue) && realmWork && now - lastMotionMs >= GpuSafe.REHEARSE_IDLE_MS) r.rehearseStep(now)" in frame)
        val step = between("private fun diveStep", "private fun failDive")
        val wait = step.indexOf("if (!memory.onDisk) return")
        assertTrue("the dive waits before its first rehearsal and its entry", wait in 0 until step.indexOf("r.rehearseStep(now)") && wait < step.indexOf("r.enter("))
        assertEquals("only the approach writes in the background", 1, Regex("""background = true""").findAll(host).count())
    }

    @Test fun `a left realm is freed on time and a preparing one rehearses at every vsync once the camera rests`() {
        // P0: at 0 fps nothing ran the engine's eviction, so a left realm's GL (57–83 MB) stayed until the next touch
        val wake = between("private fun globeWake(", "// ---------------------------------------------------------------- touch")
        assertTrue("the engine's eviction time is a wake", "r?.evictAtMs()" in wake)
        assertTrue("and so is the approach's rest", "g.approachWakeInMs(now)" in wake)
        val schedule = between("private fun schedule", "private fun status")
        assertTrue("both only on the globe", "if (mode == MODE_GLOBE && g != null) globeWake(g, r, now) else -1.0" in schedule)
        assertTrue("a realm prefetching after its core is ready keeps frames coming", "|| r.prefetchDue)" in schedule)
        assertTrue("preparing: vsync frames once rested, one frame at the rest's end before", "preparing -> { pacer.setContinuous(false); pacer.requestAfterRest(now, delay) }" in schedule)
        val rest = between("private fun gg.pixelkingdomwars.nativeclient.scene.FramePacer.requestAfterRest", "/**")
        assertTrue("GpuSafe.REHEARSE_IDLE_MS - (now - lastMotionMs)" in rest && "if (rest <= 0.0) markDirty()" in rest)
        assertFalse("no fixed 50 ms cadence is left (9 core pairs took ~450 ms at it)", "PREPARE_FRAME_MS" in host)
    }

    @Test fun `the dive's clouds rise only over a dive that waits, and part over the live realm or onto the globe`() {
        val begin = between("private fun beginDive", "private fun diveStep")
        assertTrue("the wait starts the clock", "cover.start(frameNow)" in begin)
        val step = between("private fun diveStep", "private fun failDive")
        assertTrue("READY stops the rise before the snapshot fade starts", step.indexOf("cover.ready(now)") in 0 until step.indexOf("r.fade.start(RealmDiveFade.DIVE, now)"))
        assertTrue("a failed dive parts them onto the globe", "cover.failed(now)" in between("private fun failDive", "private fun drawCover"))
        assertTrue("a leave never has them", "cover.reset()" in between("private fun startLeave", "private fun logBand"))
        val realmMode = between("            MODE_REALM -> {", "// ---------------------------------------------------------------- dive and leave")
        // and a resume's only once its own ground drew the saved spot (owner 2026-09-26: no grey hard-edged squares;
        // WorldEngineRemountTest, RealmResumeLandingTest)
        assertTrue("they part only over the live realm", realmMode.indexOf("if (!rr.waiting && !landingHeld) cover.live(now)") in 0 until realmMode.indexOf("drawCover(g, now)"))
        assertTrue("drawn after the realm frame, in its screen pass", realmMode.indexOf("rr.frame(") < realmMode.indexOf("drawCover(g, now)"))
        val globeMode = between("MODE_GLOBE, MODE_DIVE_WAIT -> {", "MODE_FADE_IN, MODE_FADE_OUT -> {")
        assertTrue("over the globe, after the fade's first composite", globeMode.indexOf("drawCover(g, now)") > globeMode.indexOf("if (mode == MODE_FADE_IN) r?.compositeFade(now)"))
        val fades = between("MODE_FADE_IN, MODE_FADE_OUT -> {", "MODE_REALM -> {")
        assertTrue("the snapshot fade runs under them, and a leave's fade has none", "if (mode == MODE_FADE_IN) drawCover(g, now)" in fades &&
            fades.indexOf("rr.compositeFade(now)") < fades.indexOf("drawCover(g, now)"))
        assertTrue("on the globe they only ever part", "if (mode == MODE_GLOBE) cover.failed(now)" in between("private fun drawCover", "private fun enteredRealm"))
        assertTrue("frames keep coming while they move", "seamWait.pending || cover.animating" in between("private fun schedule", "private fun status"))
    }

    @Test fun `the seam keeps its 12 s wait for TRUE ground when the dive's bound goes to 8 s`() {
        assertEquals(12_000.0, WorldEngineHost.SEAM_WAIT_MS, 0.0)
        assertTrue("private val seamWait = SeamWait(if (emulator) EMULATOR_DIVE_STALL_MS else SEAM_WAIT_MS)" in host)
    }

    @Test fun `the host calls the engine's own D-NEXT members, never a stand-in that could shadow them`() {
        // (ENGINE lane, 48c6ca8): a lanes-less prepare with its own eviction, the eviction time, and the prefetch flag. A
        // host-side stand-in of the same name would silently turn the approach prefetch or the eviction wake off.
        val members = gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMapEngine::class.java.methods.map { it.name to it.parameterTypes.toList() }
        assertTrue(("prepare" to listOf<Class<*>>(String::class.java, Boolean::class.javaPrimitiveType!!)) in members)
        assertTrue(("evictAtMs" to emptyList<Class<*>>()) in members)
        assertTrue(("getPrefetchDue" to emptyList<Class<*>>()) in members)
        assertFalse("no extension on the engine in the host", "fun RealmMapEngine." in host || "val RealmMapEngine." in host)
    }

    @Test fun `the surface drops only its own host's controls and exchange from the HUD bridge`() {
        val surface = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineSurface.kt").readText()
        val destroy = surface.substring(surface.indexOf("override fun onDestroyView()"))
        assertTrue("if (b.controls === h.controls) b.controls = null; if (b.exchange === h.exchange) b.exchange = null" in destroy)
        assertTrue("before the host reference goes", destroy.indexOf("b.controls = null") < destroy.indexOf("epoch = null; host = null"))
    }
}
