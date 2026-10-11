package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * D-NEXT (amends D-173), owner 2026-09-26 after code 29.1 on the Seeker: D-173's automatic zoom-in to MAP after the dive
 * felt "strange" (on QA the MAP floor view is mostly empty), "not as smooth as my last Seeker tests of the globe to surf
 * and check bases", and "zoom out goes to globe too early from map". Chosen: "overview first, live":
 * - the dive lands on the realm's overview at the globe's own scale (the N1/N2 continuity landing the owner praised),
 *   d = clamp(sStart·dpr, fit·dpr, farEnd), and NOTHING moves the camera after it: the player zooms in themselves;
 * - the engine never sets the camera's floor (`RealmCamera.floorD` stays 0: the rest floor is the whole-realm fit); the
 *   camera keeps its floor support only so the web's stage-B traces still replay ([RealmGoldenTest]);
 * - a pinch-out leaves for the globe only below 0.7 × the fit (the pre-D-173 rule), never from MAP's start: 0.75 × the
 *   fit rests back on it, and − at the fit stays on the whole realm;
 * - MAP then TRUE sharpen as the player zooms: the zoom waits at a band's edge (the "detail N%" cue) only while a lane
 *   that is IN has that band's pipelines unbuilt, so no pipeline is ever drawn live for the first time; D-177: a lane
 *   still loading never holds it (the core's chart holds the view until the lane is in);
 * - a realm no lane can draw MAP for lands and rests exactly like one with detail (only its zoom is clamped to FAR).
 * Every test here was rewritten from a D-173 test (none deleted); each says which rule it now pins.
 */
class RealmMapFloorTest {
    private val rig = RealmGlRig()
    private val sources = RealmPrograms.load()
    private val bands = RealmWebPin.BANDS
    private val hold = RealmWebPin.REHEARSAL.mapReadyHoldMs
    private val exits = ArrayList<DoubleArray>()
    private val gates = ArrayList<DoubleArray>()

    private fun engineWith(vararg lanes: RealmLane): RealmMapEngine = RealmMapEngine(
        rig.core, RealmWebPin.CONFIG, RealmTestData.plots, RealmWebPin.DEED_ART,
        RealmLoader(FixturePack("overview"), PNG_DECODER), null, rig.uploads, DirectExecutor, { rig.nowMs }, RealmDiveFade.PLAN_FADE_MS,
        shaderSources = { sources }, lanes = lanes.toList(),
    ).apply {
        listener = object : RealmMapListener {
            override fun onExit(lon: Double, lat: Double) { exits += doubleArrayOf(lon, lat) }
            override fun onGate(held: Boolean, band: Int, progress: Double) { gates += doubleArrayOf(if (held) 1.0 else 0.0, band.toDouble(), progress) }
        }
        setViewport(240, 520, 2.0) // the 12 × 8 fixture realm fits below FAR (d 19.4), like a real realm on the Seeker
    }

    private fun lane(vararg programs: String, create: Boolean = true) =
        FakeLane(rig.core, "detail", programs.toList()).apply { if (create) createOnOpen = sources }

    /** An idle globe frame as the host runs it (the core's rehearsal, then the lanes' prefetch once READY). */
    private fun globeFrame(e: RealmMapEngine) {
        rig.compiler.runAll(); rig.nowMs += 16.667
        check(rig.begin()); e.update(rig.nowMs, true); rig.uploads.poll(rig.core); e.rehearseStep(rig.nowMs)
        rig.core.beginScreen(0f, 0f, 0f, 1f); rig.end()
    }

    private fun realmFrame(e: RealmMapEngine): Boolean {
        rig.compiler.runAll(); rig.nowMs += 16.667
        check(rig.begin()); e.update(rig.nowMs, true); rig.uploads.poll(rig.core)
        if (e.waiting) e.rehearseStep(rig.nowMs)
        val moving = e.frame(rig.nowMs, rig.nowMs.toLong(), false)
        rig.end()
        return moving
    }

    private fun ready(e: RealmMapEngine, max: Int = 300): Int {
        assertTrue(e.prepare("alpha"))
        var n = 0
        while (!e.ready && n < max) { globeFrame(e); n++ }
        assertTrue(e.ready, "dive-ready (status ${e.status})")
        return n
    }

    /** The host's dive: enter at the globe's scale [sStart] (CSS px per deed), the snapshot, the 450 ms fade over the
     *  globe (no realm frame, no work). */
    private fun dive(e: RealmMapEngine, deedX: Double, deedY: Double, sStart: Double = 10.0) {
        val g = e.grid!!
        assertTrue(e.enter(g.lonAt(deedX), g.latAt(deedY), sStart))
        rig.nowMs += 16.667; check(rig.begin()); e.update(rig.nowMs, false)
        assertTrue(e.renderSnapshot(rig.nowMs.toLong(), false))
        rig.core.beginScreen(0f, 0f, 0f, 1f); e.fade.start(RealmDiveFade.DIVE, rig.nowMs); e.compositeFade(rig.nowMs); rig.end()
        while (!e.fade.done(rig.nowMs)) {
            rig.nowMs += 16.667; check(rig.begin()); e.update(rig.nowMs, false)
            rig.core.beginScreen(0f, 0f, 0f, 1f); e.compositeFade(rig.nowMs); rig.end()
        }
        e.fade.finish()
    }

    /** Back to the globe and a globe frame (the realm stays resident: a warm re-dive). */
    private fun leave(e: RealmMapEngine) { e.leave(rig.nowMs); e.fade.finish(); globeFrame(e) }

    /** Frames until the camera rests. */
    private fun settle(e: RealmMapEngine, max: Int = 400) {
        var n = 0
        do { realmFrame(e); n++ } while ((e.cam.moving || n < 2) && n < max)
        assertFalse(e.cam.moving, "still moving after $max frames")
    }

    /** [n] frames with no input: the camera must not move at all, and the engine sets no floor (D-NEXT). */
    private fun idle(e: RealmMapEngine, n: Int, each: () -> Unit = {}) {
        val x = e.cam.x; val y = e.cam.y; val s = e.cam.s
        repeat(n) {
            realmFrame(e); each()
            assertEquals(x, e.cam.x, 0.0, "frame $it moved x"); assertEquals(y, e.cam.y, 0.0, "frame $it moved y")
            assertEquals(s, e.cam.s, 0.0, "frame $it zoomed: d ${e.cam.d}")
            assertEquals(0.0, e.cam.floorD, "the engine set a camera floor"); assertEquals(0.0, e.stats.floorD)
        }
    }

    /** The whole-realm fit, device px per deed: min(120 / 12, 260 / 8) · 0.97 CSS px at dpr 2 = d 19.4. */
    private fun fit(e: RealmMapEngine): Double = e.cam.sMin() * 2.0

    private fun pinch(e: RealmMapEngine, from: Double, to: Double, release: Boolean = true) {
        var t = rig.nowMs; val cx = 60.0; val cy = 130.0
        e.touchDown(1, cx - from / 2, cy, t); e.touchDown(2, cx + from / 2, cy, t)
        val steps = 10
        for (i in 1..steps) {
            val w = from + (to - from) * i / steps; t += 16.0
            e.touchMove(1, cx - w / 2, cy, t); e.touchMove(2, cx + w / 2, cy, t)
            realmFrame(e)
        }
        if (release) { t += 16.0; e.touchUp(2, cx + to / 2, cy, t); e.touchUp(1, cx - to / 2, cy, t) }
    }

    private fun release(e: RealmMapEngine, w: Double) {
        val t = rig.nowMs + 16; e.touchUp(2, 60.0 + w / 2, 130.0, t); e.touchUp(1, 60.0 - w / 2, 130.0, t)
    }

    @Test fun `the dive lands on the overview at the globe's scale and nothing zooms it in, even with MAP ready to draw`() {
        // was D-173's "the dive lands on MAP ... in map.js diveMs": exactly the case that flew the camera to MAP. A lane
        // that draws the MAP ground, its MAP set built and its data in (the D-173 floor's trigger): the camera stays where
        // the dive put it, and the lanes' work (their MAP and TRUE sets) goes on behind the overview meanwhile
        val l = lane("rm-map", "rm-true").apply { groundBands = 1; basesAt = 1 }
        val e = engineWith(l)
        ready(e)
        dive(e, 4.5, 3.5) // off the realm's centre
        assertEquals(20.0, e.cam.d, 1e-9, "the globe's own scale (sStart 10 at dpr 2)")
        val g = e.grid!!
        assertEquals(g.xAtLon(g.lonAt(4.5)), e.cam.x, 1e-9); assertEquals(g.yAtLat(g.latAt(3.5)), e.cam.y, 1e-9)
        idle(e, 120)
        assertEquals(RealmBand.FAR, e.stats.band, "the overview: the player has not zoomed in")
        assertEquals(4, e.stats.lanePairsRehearsed, "MAP and TRUE were built behind the overview, in idle frames")
        assertTrue(exits.isEmpty())
        assertEquals(0L, rig.core.stats.liveFirstDraws, "no pipeline drawn live for the first time")
    }

    @Test fun `only a pinch-out below 0·7 × the whole-realm fit leaves, once, and 0·75 × the fit rests back on it`() {
        // was D-173's "only a pinch-out below 0.7 × MAP's start leaves": measured from MAP's start (d 33.6 here) the exit sat
        // ABOVE the landing itself (d 20), the owner's "zoom out goes to globe too early from map"
        val l = lane("rm-map").apply { groundBands = 1 }
        val e = engineWith(l)
        ready(e)
        dive(e, 6.0, 4.0)
        val fitD = fit(e)
        assertEquals(19.4, fitD, 1e-9)
        e.zoomBy(1 / 2.2); settle(e)
        assertEquals(fitD, e.cam.d, 1e-9, "− rests on the whole-realm fit")
        pinch(e, 100.0, 75.0, release = false)
        assertEquals(0.75 * fitD, e.cam.d, 1e-9, "the fingers hold it at 0.75 × the fit")
        assertTrue(exits.isEmpty(), "0.75 × the fit is no exit")
        release(e, 75.0); settle(e)
        assertEquals(fitD, e.cam.d, 1e-9, "released: back on the whole realm")
        assertTrue(exits.isEmpty())
        pinch(e, 100.0, 65.0, release = false)
        assertEquals(1, exits.size, "0.65 × the fit leaves")
        pinch(e, 65.0, 40.0, release = false)
        assertEquals(1, exits.size, "once per visit")
        assertTrue(e.cam.d >= 0.6 * fitD - 1e-9, "the gesture floor holds at 0.6 × the fit: d ${e.cam.d}")
        release(e, 40.0)
        // a new visit may leave again
        leave(e); dive(e, 6.0, 4.0)
        pinch(e, 100.0, 60.0, release = false)
        assertEquals(2, exits.size)
    }

    @Test fun `− at the whole-realm fit stays on the realm, and + then − come back through the overview`() {
        // was D-173's "− at the floor leaves" (map.js zoomBy): the whole realm is where − ends, never the globe
        val l = lane("rm-map").apply { groundBands = 1 }
        val e = engineWith(l)
        ready(e)
        dive(e, 6.0, 4.0)
        idle(e, 30) // the MAP set is built behind the overview
        e.zoomBy(2.2); settle(e)
        assertEquals(bands.mapStart, e.cam.d, 1e-9, "+ from the overview (d 44 by the rest rule) rests at MAP's start")
        e.zoomBy(1 / 2.2); settle(e)
        assertEquals(bands.mapStart / 2.2, e.cam.d, 1e-9, "− from MAP back to the overview, below MAP (no floor there)")
        repeat(3) { e.zoomBy(1 / 2.2); settle(e); assertEquals(fit(e), e.cam.d, 1e-9, "− at the fit stays on the fit") }
        assertTrue(exits.isEmpty(), "no − ever went to the globe")
        assertEquals(0.0, e.cam.floorD)
    }

    @Test fun `the landing rests at clamp(sStart·dpr, fit·dpr, farEnd) at every globe scale and never moves`() {
        // was D-173's "the landing flight is map js diveMs": there is no landing flight now; the entry IS the landing
        val l = lane("rm-map").apply { groundBands = 1; mapReadyValue = false } // its MAP data never in: the edge's hold arms
        val e = engineWith(l)
        ready(e)
        for (sStart in doubleArrayOf(3.0, 10.0, 11.5, 12.0, 40.0)) {
            dive(e, 6.0, 4.0, sStart)
            val want = minOf(bands.farEnd, maxOf(fit(e), sStart * 2))
            assertEquals(want, e.cam.d, 1e-9, "sStart $sStart")
            assertEquals(want, e.landingD(sStart), 1e-9)
            idle(e, 40) // d 23 and 24 sit in the MAP edge's window: its hold never moves the camera either
            leave(e)
        }
        assertTrue(exits.isEmpty())
    }

    @Test fun `a pinch-in before the lanes are in is never held, and MAP sharpens under it once the lane is in and built`() {
        // D-177 (owner 2026-09-26: smoothness first; he likes the web's behaviour). Was "a zoom-in before the lanes are in
        // waits at farEnd with the cue": D-NEXT kept core.js bandLimit's D-173 'loading' hold after the landing, so the
        // first pinch-in of every cold visit stood at farEnd until the lanes' load landed (a critic confirmed it; 04b0dc7
        // and c6c73b8 only shortened it). The web withdrew it (197d753c: "a lane still loading never closes the zoom"). The
        // pinch follows the fingers over the core's chart; the lane, once in, is held until its MAP pipelines are built,
        // then draws. A loading GROUND's mapReady() is false (no MAP data yet): that must not hold the pinch either.
        // (like GROUND before its MAP data: no programs, no band, draws no ground, mapReady false)
        val l = lane("rm-map", create = false).apply { settledValue = false; bandSetValue = 0; readySets = intArrayOf(); groundBands = 0; mapReadyValue = false }
        val e = engineWith(l)
        ready(e)
        dive(e, 6.0, 4.0)
        realmFrame(e)
        assertEquals(1, l.opened.size, "the lane opened at the entry")
        assertNotEquals(RealmMapEngine.GATE_LOADING, e.stats.gateReason, "no loading hold")
        val d0 = e.cam.d
        pinch(e, 100.0, 250.0, release = false) // the first pinch-in of the visit, while the lane still loads
        assertEquals(d0 * 2.5, e.cam.d, 1e-6, "the fingers took the camera past farEnd into MAP: d ${e.cam.d}")
        assertTrue(gates.none { it[0] == 1.0 }, "no detail cue: nothing held the pinch")
        release(e, 250.0); settle(e)
        assertTrue(e.cam.d > bands.farEnd, "it rests in MAP over the chart: d ${e.cam.d}")
        assertEquals(RealmBand.MAP, e.stats.band)
        assertEquals(0, l.groundDraws, "the lane is not in: the core's chart is the ground")
        val rest = e.cam.d
        l.settledValue = true; l.bandSetValue = 2; l.readySets = intArrayOf(1, 2); l.mapReadyValue = true; l.groundBands = 1; l.create(sources) // its load lands
        var n = 0
        while (l.groundDraws == 0 && n < 400) {
            realmFrame(e); n++
            if (e.stats.lanePairsRehearsed < 2) assertEquals(0, l.groundDraws, "the lane drew MAP before its pipelines were built")
        }
        assertTrue(l.groundDraws > 0, "MAP sharpened under the player's zoom: the lane draws the ground")
        assertEquals(rest, e.cam.d, 0.0, "the lane coming in moved nothing")
        assertEquals(0L, rig.core.stats.liveFirstDraws)
        assertTrue(exits.isEmpty())
    }

    @Test fun `a realm prefetched from its panel lands on the overview too, and the player's zoom then goes straight to MAP`() {
        // was D-173's "the prefetch updates lanes on the whole realm in idle globe frames": the prefetch stays (after READY,
        // behind the globe), it just no longer holds the dive or lands it at MAP
        val l = lane("rm-map").apply { mapReadyAfterUpdates = 3; groundBands = 1 } // like GROUND: its lattice resolves over frames
        val held = lane("life-stand").apply { settledValue = false; hookDraws = false; readySets = intArrayOf() }
        val e = engineWith(l, held)
        ready(e)
        assertTrue(e.prefetchDue, "READY with lane work left: the host keeps prefetching behind the globe")
        repeat(60) { globeFrame(e) }
        val g = e.grid!!
        assertTrue(l.updates >= 3 && l.offscreens >= 3, "the lane was prefetched behind the globe: ${l.updates} updates")
        assertTrue(l.updateRect[0] <= 0.0 && l.updateRect[1] <= 0.0 && l.updateRect[2] >= g.cols && l.updateRect[3] >= g.rows,
            "on a whole-realm view: ${l.updateRect.joinToString()}")
        assertEquals(2, e.stats.lanePairsRehearsed, "its MAP set was built behind the globe")
        assertEquals(0, held.updates, "a lane with an un-rehearsed pair is held: never updated")
        dive(e, 4.5, 3.5)
        assertEquals(20.0, e.cam.d, 1e-9)
        idle(e, 120)
        e.zoomBy(2.2); val t0 = rig.nowMs; settle(e)
        assertEquals(bands.mapStart, e.cam.d, 1e-9)
        assertTrue(rig.nowMs - t0 <= 380 + 4 * 16.667, "no gate on the way: ${rig.nowMs - t0} ms")
        assertEquals(0L, rig.core.stats.liveFirstDraws); assertEquals(0L, rig.core.stats.orderViolations)
    }

    // ---- the camera and band gate alone, as the engine now drives them ----------------------------------------------------
    private val rules = RealmBandRules(bands, RealmWebPin.DEED_ART)
    /** camera.test.mjs PHONE and DESK: W, H, dpr. */
    private val webViewports = listOf(doubleArrayOf(390.0, 844.0, 2.0), doubleArrayOf(1280.0, 800.0, 1.0))

    /**
     * Was camera.test.mjs 'D-173 zoom floor' at MAP's start. D-NEXT: the engine never sets the floor, so the camera's own
     * rule is the pinned pre-D-173 one: nothing rests below the fit, a pinch undershoots to 0.6 × the fit and reads as the
     * exit only below 0.7 × it. The camera's floor support itself stays for the web's stage-B traces.
     */
    @Test fun `with no floor set nothing rests below the fit and only a pinch below 0·7 × the fit reads as the exit`() {
        for (vp in webViewports) {
            var t = 0.0
            val cam = RealmCamera(rules) { t }
            cam.setViewport(vp[0], vp[1], vp[2]); cam.setGrid(178, 131)
            fun run(ms: Double) { val end = t + ms; while (t < end) { t += 16.0; cam.step(t) } }
            val fit = cam.sMin() * vp[2]; val w = "${vp[0]}"
            cam.set(89.0, 65.5, minOf(bands.farEnd, fit * 4) / vp[2]) // the overview landing (d 17 on the phone, 22 on the desk)
            assertEquals(0.0, cam.floorD, "$w: no floor"); assertEquals(fit, cam.sRest() * vp[2], 1e-9, "$w: the rest is the fit")
            cam.beginGesture(); cam.zoomAt(vp[0] / 2, vp[1] / 2, 0.75 * fit / cam.d)
            assertTrue(cam.s >= cam.sRest() * 0.7, "$w: 0.75 × the fit is no exit gesture")
            cam.endGesture(); run(400.0); assertEquals(fit, cam.d, 1e-6, "$w: rests on the fit")
            cam.beginGesture(); cam.zoomAt(vp[0] / 2, vp[1] / 2, 0.05)
            assertEquals(0.6 * fit, cam.d, 1e-6, "$w: a gesture undershoots at most to 0.6 × the fit")
            assertTrue(cam.s < cam.sRest() * 0.7, "$w: a deep pinch reads as the exit gesture")
            cam.endGesture(); run(400.0); assertEquals(fit, cam.d, 1e-6, "$w: rests at the fit")
            repeat(20) { cam.wheel(vp[0] / 2, vp[1] / 2, 0.8) }; run(600.0); assertEquals(fit, cam.d, 1e-6, "$w: a wheel burst rests at the fit")
            cam.flyToD(cam.x, cam.y, fit / 3, 300.0); run(400.0); assertEquals(fit, cam.d, 1e-6, "$w: a flight rests at the fit")
            cam.floorD = bands.mapStart; assertEquals(bands.mapStart, cam.sRest() * vp[2], 1e-9, "$w: the web traces' floor still works")
            cam.floorD = 0.0
        }
    }

    /**
     * Was camera.test.mjs 'D-173 dive' (core.js bandLimit's dive rule under the landing flight), then D-NEXT's live
     * 'loading' hold. D-177 (web 197d753c) withdrew it: the band gate as the engine now drives it (no dive rule) keeps MAP
     * out only while a lane that is IN has its MAP set unbuilt. A push (+) while the lanes still load reaches MAP at once
     * (the owner must never feel a freeze while pinching in), and a lane that comes in after the camera passed the edge
     * never pulls it back; a push once the lanes are in waits at the edge for the MAP set and resumes when it is built; a
     * camera the player left alone stays exactly where it was: opening a gate never flies anything.
     */
    @Test fun `a push while the lanes load goes straight to MAP, only a loaded lane's MAP set holds the edge, and opening it flies nothing`() {
        val out = RealmGateLimit(); val state = RealmBandState()
        // (viewport, lanes in at, MAP set built at): the push, if any, starts at t 0
        val cases = listOf(Triple(webViewports[0], 3000.0, 6000.0), Triple(webViewports[1], 3000.0, 6000.0),
            Triple(webViewports[0], 0.0, 1500.0), Triple(webViewports[1], 0.0, 120.0), Triple(webViewports[1], 0.0, 0.0))
        for ((vp, inAt, builtAt) in cases) {
            for (push in booleanArrayOf(true, false)) {
                var t = 0.0
                val cam = RealmCamera(rules) { t }
                cam.setViewport(vp[0], vp[1], vp[2]); cam.setGrid(178, 131)
                val d0 = minOf(bands.farEnd, cam.sMin() * vp[2] * 4); cam.set(89.0, 65.0, d0 / vp[2]) // the overview landing
                var lanesIn = false; var mapLeft = true
                // the engine's call (D-177): no dive / lanesIn; a pair gates only once its lane is in
                fun gate() = cam.limitD(RealmBandLimit.limit(out, bands, n = 1, set = { 1 }, gating = { lanesIn && mapLeft }).lim)
                var firstMap = -1.0; var landed = -1.0
                while (t < 8000) {
                    if (t >= inAt) lanesIn = true; if (t >= builtAt) mapLeft = false
                    gate()
                    if (push && t == 0.0) cam.flyToD(89.0, 65.0, bands.mapStart, 380.0) // the + tool, aimed at MAP's start
                    cam.step(t)
                    if (rules.bands(cam.d, state).map > 0 && firstMap < 0) firstMap = t
                    if (firstMap >= 0 && !cam.moving && landed < 0) landed = t
                    t += 16.0
                }
                val w = "${vp[0]} in at $inAt built at $builtAt push $push"
                if (!push) { assertEquals(-1.0, firstMap, "$w: nothing zoomed in by itself"); assertEquals(d0, cam.d, 1e-9, "$w: unmoved"); continue }
                assertEquals(bands.mapStart, cam.d, 1e-6, "$w: the push reached MAP and stayed there")
                if (inAt > 0) assertTrue(landed in 0.0..(380.0 + 32), "$w: loading lanes held the push: landed at $landed ms")
                else if (builtAt > 0) {
                    assertTrue(firstMap >= builtAt, "$w: a MAP-band frame at $firstMap ms, before the loaded lane's MAP set was built")
                    assertTrue(landed - builtAt <= 450 + 380 + 32, "$w: resumed ${landed - builtAt} ms after the gate opened")
                } else assertTrue(landed in 0.0..(380.0 + 32), "$w: nothing to wait for: landed at $landed ms")
            }
        }
    }

    @Test fun `a lane whose hook cannot draw while its arrays upload never delays the dive and stays held until its MAP pipelines are built`() {
        // was D-173's "... holds the dive until its MAP pipelines are built": LIFE settles when its build lands, while its
        // texture arrays still fill on the worker, and its hooks answer false until they are resident. The dive no longer
        // waits for it; LIFE draws nothing on the map until its pairs rehearse (a detail pops in late, never a hitch)
        val ground = lane("rm-map").apply { groundBands = 1 }
        val life = lane("life-stand").apply { hookDraws = false }
        val e = engineWith(ground, life)
        val frames = ready(e)
        assertTrue(frames < 40, "READY with the core's set alone: $frames frames")
        dive(e, 6.0, 4.0)
        repeat(60) { realmFrame(e) }
        assertEquals(2, e.stats.lanePairsNothing, "its hooks answered false")
        assertEquals(0, life.draws, "held while its pipelines are not built")
        assertTrue(e.stats.lanesHeld and 2 != 0, "LIFE is held: ${e.stats.lanesHeld}")
        assertTrue(e.wakeInMs(rig.nowMs) >= 0.0, "LIFE's retry asks for a frame (at rest the idle policy may draw none)")
        life.hookDraws = true // the arrays are resident: the retry draws
        var n = 0; while (life.draws == 0 && n < 600) { realmFrame(e); n++ }
        assertTrue(life.draws > 0, "drawn once its pairs rehearsed")
        assertEquals(listOf("life-stand|0", "life-stand|1"), life.rehearsed, "both MAP pairs were built before its first draw")
        assertEquals(0L, rig.core.stats.liveFirstDraws)
    }

    @Test fun `on the map a lane whose programs arrive late stays held, and draws only once its pipelines are built`() {
        // the same race after the landing: LIFE's programs arrive on the map and its arrays are still uploading. Taken as
        // "nothing", LIFE was drawn with pipelines never built; held, it draws nothing until its pairs rehearse
        val ground = lane("rm-map").apply { groundBands = 1 }
        val life = lane("life-stand", create = false).apply { hookDraws = false }
        val e = engineWith(ground, life)
        ready(e)
        dive(e, 6.0, 4.0); settle(e)
        life.create(sources)
        var n = 0; while (e.stats.lanePairsNothing < 2 && n < 200) { realmFrame(e); n++ }
        assertEquals(2, e.stats.lanePairsNothing, "its hooks answered false")
        life.draws = 0 // (a lane with no programs yet has no pair to wait for: it was "drawn" until now, as a no-op)
        repeat(30) { realmFrame(e) }
        assertEquals(0, life.draws, "held while its pipelines are not built")
        assertTrue(e.stats.lanesHeld and 2 != 0, "LIFE is held: ${e.stats.lanesHeld}")
        assertTrue(e.wakeInMs(rig.nowMs) >= 0.0, "LIFE's retry asks for a frame")
        life.hookDraws = true
        n = 0; while (life.draws == 0 && n < 600) { realmFrame(e); n++ }
        assertTrue(life.draws > 0, "drawn once its pairs rehearsed")
        assertEquals(listOf("life-stand|0", "life-stand|1"), life.rehearsed, "both of its MAP pairs were built before its first draw")
        assertEquals(0L, rig.core.stats.liveFirstDraws)
    }

    @Test fun `a realm no lane can draw MAP for lands and rests exactly like one with detail, its zoom clamped to FAR`() {
        // was "keeps the pre-D-173 overview": the two used to differ (the detail realm flew to MAP); now only the clamp does
        fun failedGround() = FakeLane(rig.core, "ground", emptyList(), bandSetValue = 0).apply { readySets = intArrayOf(); mapReadyValue = false }
        fun visit(e: RealmMapEngine): DoubleArray {
            val frames = ready(e); assertTrue(frames < 40, "no wait for a lane: $frames frames")
            dive(e, 6.0, 4.0); idle(e, 40)
            return doubleArrayOf(e.cam.x, e.cam.y, e.cam.d)
        }
        val detail = visit(engineWith(lane("rm-map").apply { groundBands = 1 }))
        val none = engineWith(failedGround())
        val bare = visit(none)
        assertTrue(detail.contentEquals(bare), "the same landing: ${detail.joinToString()} vs ${bare.joinToString()}")
        assertTrue(none.stats.overviewClamp, "no lane can draw past FAR: the zoom is clamped there")
        none.zoomBy(2.2); settle(none)
        assertEquals(bands.farEnd, none.cam.d, 1e-9, "+ stops at FAR: the painted chart is never stretched to MAP scale")
        // the same failed GROUND next to LIFE (its build landed: bandSet 2, no ground of its own): LIFE may be zoomed into,
        // the realm still lands and rests on the overview like the others
        val e2 = engineWith(failedGround(), lane("life-stand").apply { bandSetValue = 2 })
        assertTrue(bare.contentEquals(visit(e2)))
        assertFalse(e2.stats.overviewClamp, "LIFE may still be zoomed into")
        assertEquals(RealmEngineConfig.PASS_CHART, e2.stats.groundPass)
        assertTrue(exits.isEmpty())
    }

    @Test fun `the MAP-edge hold waits for the player's push, holds at most mapReadyHoldMs, and every push holds afresh`() {
        // was D-173's two MAP-edge hold tests. The overview often lands inside the edge's window (sStart 12 → d 24 here,
        // the Seeker's d 21–22 against 0.9 × farEnd = 21.6): map.js's clock would start at the landing, be spent before the
        // player's first pinch, and MAP would then open over an unresolved lattice. The clock starts with the push
        val g = lane("rm-map").apply { groundBands = 1; mapReadyRegion = doubleArrayOf(3.0, -2.0, 9.0, 10.0) }
        val e = engineWith(g)
        ready(e)
        dive(e, 1.0, 4.0, sStart = 12.0) // off-centre: this view's lattice is not resolved
        assertEquals(bands.farEnd, e.cam.d, 1e-9)
        idle(e, 180) // three seconds on the overview, inside the edge's window
        assertEquals(2, e.stats.lanePairsRehearsed)
        assertEquals(RealmMapEngine.GATE_MAP_DATA, e.stats.gateReason, "the edge waits for this view's MAP data")
        assertEquals(-1.0, e.wakeInMs(rig.nowMs), "at rest nothing is due: the idle policy owns the cadence")
        fun push(): Double {
            e.zoomBy(2.2); val t0 = rig.nowMs
            var k = 0; while (e.cam.d <= bands.farEnd * 1.01 && k < 400) { realmFrame(e); k++ }
            val held = rig.nowMs - t0
            settle(e)
            assertTrue(e.cam.d >= bands.mapStart, "the push reached MAP: d ${e.cam.d}")
            return held
        }
        val first = push()
        assertTrue(first >= hold - 50, "held for its MAP data from the push, not from the landing: $first ms")
        assertTrue(first <= hold + 600, "then released, once: $first ms")
        repeat(3) { realmFrame(e) }
        assertEquals(-1.0, e.wakeInMs(rig.nowMs), "a spent hold asks for no frame")
        rig.nowMs += 120_000.0
        assertEquals(-1.0, e.wakeInMs(rig.nowMs), "two minutes later still nothing due")
        e.zoomBy(1 / 2.2); settle(e) // back into the edge's window, then a new push holds afresh
        assertTrue(e.cam.d >= bands.farEnd * 0.9 && e.cam.d <= bands.farEnd * 1.001, "d ${e.cam.d}")
        idle(e, 120)
        assertTrue(push() >= hold - 50, "a later push in the same visit holds for its own view again")
        // a warm re-dive: a new visit's first push holds for its own view too
        leave(e); repeat(10) { globeFrame(e) }
        dive(e, 1.0, 4.0, sStart = 12.0); idle(e, 30)
        assertTrue(push() >= hold - 50)
        assertTrue(exits.isEmpty())
    }
}
