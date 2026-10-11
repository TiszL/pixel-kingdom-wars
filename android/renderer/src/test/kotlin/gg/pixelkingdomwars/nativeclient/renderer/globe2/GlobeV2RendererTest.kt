package gg.pixelkingdomwars.nativeclient.renderer.globe2

import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.world.FrameLadder
import gg.pixelkingdomwars.nativeclient.renderer.world.IdleScheduler
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderPolicy
import gg.pixelkingdomwars.nativeclient.renderer.world.WebPin
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntent
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldTarget
import java.lang.management.ManagementFactory
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import org.junit.Assume
import org.junit.Test

/**
 * The flat globe engine on the recording fake GL (GLOBE-NATIVE-PLAN §8.2): what it does is what the owner will see on
 * the Seeker, so each test pins one promise of the plan — nothing reaches the screen before every first-frame texture
 * and program is resident (no black or half-drawn World tab; the upload fallback stays legal), the first frame never
 * waits for the 1024² cube (the N1 first-frame bar) but does wait, within a bound, for the islands, so the first frame
 * on screen draws them (owner 2026-10-06), and whatever comes late arrives without a live first draw,
 * the loading meter moves, a late part that fails leaves the globe running, the draws are the pinned programs, ladder L2
 * draws the sphere at half scale (a real motion-frame cut), every uniform it sets exists in those stages (a typo would
 * silently draw wrong on the device), taps pick and select, the dive fires once and backs off after a failure, a
 * context loss restores from the content, reduced motion stops idle animation, the Phase E layer stays inert, and a
 * steady frame allocates nothing.
 */
class GlobeV2RendererTest {

    @Test fun `nothing binds the screen until the globe is ready, then ready fires once`() {
        val rig = GlobeRig()
        rig.renderer.start()
        assertTrue(rig.frame())
        assertFalse(rig.renderer.ready, "the first frame adopts content; programs are adopted on the next frame")
        assertEquals(0, rig.world.clears, "no screen clear before ready: the GL-thread uploads stay legal")
        assertTrue(rig.world.draws.isEmpty())
        rig.untilReady()
        assertEquals(1, rig.events.ready); assertTrue(rig.events.unavailable.isEmpty())
        rig.frame()
        assertTrue(rig.world.clears > 0, "the screen is bound once ready")
        assertEquals(1, rig.events.ready)
    }

    @Test fun `a frame draws the sphere once, the 32 islands in one instanced draw, and blends only the islands`() {
        val rig = GlobeRig(); rig.renderer.start(); rig.untilReady()
        rig.world.draws.clear(); rig.frame()
        val draws = rig.world.draws
        val flat = rig.world.group.programs.indexOfFirst { it?.fs?.contains("uniform highp sampler2DArray uSsg") == true }
        val isles = rig.world.group.programs.indexOfFirst { it?.fs?.contains("uIsleArt") == true }
        assertTrue(flat > 0 && isles > 0)
        assertEquals(1, draws.count { it.program == flat }, "one full-screen ray–sphere pass")
        val isleDraw = draws.single { it.program == isles }
        assertEquals(32, isleDraw.instances, "every exploration island in one instanced draw (the vertex stage culls)")
        assertTrue(draws.all { it.framebuffer == 0 }, "straight to the screen: no offscreen pass in a globe frame")
        // every pair the globe draws was rehearsed behind the loading state: the first visible frame builds no variant
        // (D-NEXT: the dive's cloud cover is one of them, so a dive that waits never builds its variant on screen)
        assertEquals(6L, rig.core.stats.rehearsedFirstDraws, "flat, half-scale flat, its blit, the dive cover, isles and fx rehearsed into 1×1 scratch targets")
        assertEquals(0L, rig.core.stats.liveFirstDraws, "no (program, state) pair is drawn for the first time on screen")
    }

    /**
     * Owner 2026-10-06 (rewritten from "the 1024 cube and the islands arrive after it"): the islands appeared seconds after
     * the globe because the first frame waited only for the small set. The rule now: the first frame waits for the small
     * set AND the islands (they decode right behind the first stage), never for the 1024² cube, and the frame in which the
     * globe first reaches the screen already draws the 32 exploration islands, from a rehearsed pair.
     */
    @Test fun `the first frame waits for the small set and the islands, never for the 1024 cube, and draws the islands`() {
        val pool = HeldExecutor()
        val rig = GlobeRig(withIdle = true, decode = pool)
        rig.renderer.start()
        assertTrue(pool.runNext(), "one task reads the stages and plans the load")
        repeat(2) { assertTrue(pool.runNext(), "the first stage fans out over the two decode threads") }
        assertEquals(2, pool.tasks.size, "the islands and the 1024² cube are still queued")
        repeat(30) { rig.frame() } // the small set is resident: the old rule showed the globe here, without its islands
        assertFalse(rig.renderer.ready, "no globe without its islands")
        assertEquals(0, rig.events.ready); assertEquals(0, rig.world.clears, "nothing reached the screen")
        assertTrue(pool.runNext(), "the islands decode next, ahead of the 1024² cube")
        assertEquals(1, pool.tasks.size, "only the cube is left")
        val first = firstScreenFrame(rig)
        assertEquals(1, rig.events.ready)
        assertTrue(rig.renderer.islandsShown, "live at ready")
        assertEquals(GlobeRig.SMALL, rig.renderer.albedoSize, "ready on the small cube: the 1024² cube never holds the first frame")
        val isles = rig.world.group.programs.indexOfFirst { it?.fs?.contains("uIsleArt") == true }
        assertEquals(listOf(32), first.filter { it.program == isles }.map { it.instances }, "the globe's first frame on screen draws the 32 exploration islands")
        assertEquals(0L, rig.core.stats.liveFirstDraws, "their pairs were rehearsed behind the loading state")
        pool.runAll() // the cube finishes while the globe is on screen
        repeat(120) { rig.frame() }
        assertEquals(GlobeRig.LARGE, rig.renderer.albedoSize, "the 1024² cube replaced the small one once resident")
        assertEquals(0L, rig.core.stats.liveFirstDraws)
        assertTrue(rig.events.parts.isEmpty() && rig.events.unavailable.isEmpty())
    }

    /** Frames until ready; the screen draws of the frame in which the globe first reached the screen (the rehearsals
     *  into 1×1 scratch targets left out). */
    private fun firstScreenFrame(rig: GlobeRig, max: Int = 20): List<gg.pixelkingdomwars.nativeclient.renderer.gl3.FakeDraw> {
        var n = 0
        while (!rig.renderer.ready && n < max) { rig.world.draws.clear(); rig.frame(); n++ }
        check(rig.renderer.ready) { "not ready after $n frames: ${rig.renderer.failure}" }
        return rig.world.draws.filter { it.framebuffer == 0 }
    }

    @Test fun `a late part that cannot load is reported and the globe keeps running without it`() {
        val rig = GlobeRig(content = { GlobeRig.assets(it, failIslands = true) })
        rig.renderer.start(); rig.untilReady()
        repeat(60) { rig.frame() }
        assertEquals(listOf("islands"), rig.events.parts, "reported once for the host's log")
        assertTrue(rig.events.unavailable.isEmpty(), "the globe itself stays available")
        assertTrue(rig.renderer.ready); assertFalse(rig.renderer.islandsShown)
        assertEquals(GlobeRig.LARGE, rig.renderer.albedoSize, "the other late part still arrives")
        rig.world.draws.clear(); rig.frame()
        assertEquals(1, rig.world.draws.size, "the sphere alone")
    }

    @Test fun `a GL-thread-only uploader loads the late parts before the first frame instead`() {
        val rig = GlobeRig(direct = true)
        rig.renderer.start(); rig.untilReady()
        assertEquals(GlobeRig.LARGE, rig.renderer.albedoSize)
        assertTrue(rig.renderer.islandsShown, "islands live at ready: nothing can be uploaded after the first frame")
        assertEquals(0L, rig.core.stats.orderViolations, "no GL-thread upload after the first world frame")
    }

    @Test fun `the loading meter moves from 0 to 1 and never goes back`() {
        val pool = HeldExecutor()
        val rig = GlobeRig(decode = pool)
        rig.renderer.start()
        val seen = arrayListOf(rig.renderer.loadProgress)
        pool.runNext(); seen += rig.renderer.loadProgress
        pool.runAll(); seen += rig.renderer.loadProgress
        var n = 0
        while (!rig.renderer.ready && n < 20) { rig.frame(); seen += rig.renderer.loadProgress; n++ }
        assertEquals(0f, seen.first())
        assertEquals(1f, seen.last())
        assertTrue(seen.zipWithNext().all { (a, b) -> b >= a }, "never backwards: $seen")
        assertTrue(seen.count { it > 0f && it < 1f } >= 3, "intermediate steps the meter can show: $seen")
    }

    @Test fun `ladder L2 draws the sphere at half scale and upscales it, L0 and L1 draw it at full scale`() {
        val rig = GlobeRig(); rig.renderer.start(); rig.untilReady()
        val ladder = FrameLadder(LadderPolicy.PLAN, WebPin.LADDER_INPUTS)
        val flat = rig.world.group.programs.indexOfFirst { it?.fs?.contains("uniform highp sampler2DArray uSsg") == true }
        val blit = rig.world.group.programs.indexOfFirst { it?.fs?.contains("uniform sampler2D uLow") == true }
        assertTrue(blit > 0, "the realm engine's pinned blit is linked for the half-scale step")
        for (level in 0..1) {
            rig.world.draws.clear(); rig.frame(ladder = ladder.knobs[level])
            assertTrue(rig.world.draws.all { it.framebuffer == 0 }, "L$level: straight to the screen")
            assertEquals(1, rig.world.draws.count { it.program == flat })
        }
        val before = rig.core.stats.gpuBytes(Gl3Pool.GLOBE)
        rig.world.draws.clear(); rig.frame(ladder = ladder.knobs[2])
        val sphere = rig.world.draws.single { it.program == flat }
        assertTrue(sphere.framebuffer != 0, "L2: the sphere goes into the globe's own offscreen target")
        assertEquals(0, rig.world.draws.single { it.program == blit }.framebuffer, "then one upscale onto the screen")
        assertEquals(((rig.w + 1) / 2).toLong() * ((rig.h + 1) / 2) * 4, rig.core.stats.gpuBytes(Gl3Pool.GLOBE) - before, "a half-size RGBA8 target")
        assertEquals(0L, rig.core.stats.liveFirstDraws, "the half-scale pass and its blit were rehearsed before ready")
        rig.world.draws.clear(); rig.frame(ladder = ladder.knobs[1])
        assertTrue(rig.world.draws.all { it.framebuffer == 0 }, "back at L1 the sphere is drawn at full scale again")
    }

    @Test fun `every uniform the renderer sets is declared by the pinned stages`() {
        val rig = GlobeRig(); rig.renderer.start(); rig.untilReady()
        rig.renderer.selectRealm(3, rig.now, fly = false)
        repeat(3) { rig.frame() }
        val declared = Regex("""uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?\w+\s+([^;]+);""")
        var checked = 0
        for ((program, names) in rig.gl.asked) {
            val p = rig.world.group.program(program) ?: continue
            val text = p.vs + "\n" + p.fs
            val have = declared.findAll(text).flatMap { m -> m.groupValues[1].split(',').map { it.trim().substringBefore('[').substringBefore(' ') } }.toSet()
            for (n in names) { assertTrue(n.substringBefore('[') in have, "uniform $n is not declared by program $program"); checked++ }
        }
        assertTrue(checked >= 40, "the check covers the three programs' uniforms ($checked)")
    }

    @Test fun `a tap on a realm selects it and frames it, a tap on the open sea deselects`() {
        val rig = GlobeRig(); rig.renderer.start(); rig.untilReady(); rig.frame()
        val cam = rig.renderer.camera
        val (geography, _) = GlobeRig.geography()
        // find a realm's label anchor on screen that lies on its own land
        val xy = DoubleArray(2)
        val r = GlobeV2Pin.REALMS.indices.first { i -> val s = GlobeV2Pin.REALMS[i]; cam.projectDir(V.dirOf(s.lon, s.lat), 0.0, xy) && geography.realmAt(s.lon, s.lat) == i }
        val spec = GlobeV2Pin.REALMS[r]
        cam.projectDir(V.dirOf(spec.lon, spec.lat), 0.0, xy)
        tap(rig, xy[0], xy[1])
        assertEquals(spec.id, assertIs<GlobePickV2.Realm>(rig.events.picks.last()).id)
        assertEquals(spec.id, rig.events.selections.last())
        assertEquals(r, rig.renderer.selectedRealm)
        assertTrue(cam.flying, "a selection frames the realm")
        // off the sphere: deselect
        repeat(200) { rig.frame() }
        tap(rig, 2.0, 2.0)
        assertEquals(null, rig.events.selections.last()); assertEquals(-1, rig.renderer.selectedRealm)
    }

    @Test fun `zooming in over a realm with a map dives once, a failed dive backs off 5 s, no map means the floor and a hint`() {
        val rig = GlobeRig(); rig.renderer.start(); rig.untilReady()
        val crown = GlobeV2Pin.REALMS.indexOfFirst { it.id == "crownlands" }
        val (_, geoms) = GlobeRig.geography()
        val cam = rig.renderer.camera
        // no map: the floor holds and the hint fires once
        V.copy(cam.t, geoms[crown].c); cam.z = cam.zOf(0.5); cam.zT = cam.zOf(0.2)
        repeat(120) { rig.frame() }
        assertTrue(rig.events.dives.isEmpty(), "no dive without a map")
        assertTrue(cam.altOf(cam.z) >= GlobeV2Pin.ALT_MIN_ATLAS - 1e-9, "the atlas floor holds")
        assertEquals(listOf<String?>("crownlands"), rig.events.noMaps)
        // with a map: one dive
        rig.renderer.divable = setOf("crownlands")
        cam.zT = cam.zOf(0.2)
        repeat(120) { rig.frame() }
        assertEquals(listOf("crownlands"), rig.events.dives)
        // the host could not open it: back off 5 s (main.js enterRealm catch), then dive again
        rig.renderer.diveResult(false, "crownlands", rig.now)
        cam.zT = cam.zOf(0.2)
        repeat(60) { rig.frame() } // 1 s
        assertEquals(1, rig.events.dives.size, "no retry inside the block")
        repeat(300) { rig.frame() } // past the 5 s block
        cam.zT = cam.zOf(0.2)
        repeat(120) { rig.frame() }
        assertEquals(2, rig.events.dives.size, "after the block the dive is offered again")
        // a successful dive puts the globe to sleep: nothing is drawn under the realm map
        rig.renderer.diveResult(true, "crownlands", rig.now)
        rig.world.draws.clear(); rig.frame()
        assertTrue(rig.world.draws.isEmpty(), "asleep under the realm map")
        assertTrue(rig.renderer.asleep)
    }

    /** Enter map on crownlands (a realm with a map), framed first as its panel frames it; returns that framing's z. */
    private fun enterMapFlight(rig: GlobeRig): Double {
        rig.renderer.start(); rig.untilReady()
        rig.renderer.divable = setOf("crownlands")
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Realm("crownlands")), rig.now)
        repeat(200) { rig.frame() }
        val cam = rig.renderer.camera
        assertFalse(cam.flying, "the panel's framing settled")
        val framed = cam.z
        assertEquals(null, rig.renderer.cancelDive(rig.now), "no dive committed: nothing to withdraw")
        rig.renderer.apply(WorldIntent.Dive("crownlands"), rig.now)
        repeat(10) { rig.frame() } // 160 ms into the 700 ms approach
        assertTrue(cam.flying, "Enter map's approach flight"); assertTrue(rig.events.dives.isEmpty(), "no dive before the flight ends")
        return framed
    }

    @Test fun `Back during Enter map's approach flight withdraws the dive, so the flight's end never enters the realm`() {
        // Owner rule (2026-09-26): Back never leaves a HUD-less screen. The integration review traced this Back: the host,
        // still on the globe, answered NothingToLeave and the HUD showed the globe and the realm panel again, then the
        // flight's end fired the globe's pending dive and pulled the player into the map anyway ("Back looked like it
        // worked"). The host withdraws the dive with cancelDive before it answers.
        val rig = GlobeRig()
        val framed = enterMapFlight(rig)
        val cam = rig.renderer.camera
        val crown = GlobeV2Pin.REALMS.indexOfFirst { it.id == "crownlands" }
        assertEquals("crownlands", rig.renderer.cancelDive(rig.now))
        assertEquals(crown, rig.renderer.selectedRealm, "the realm stays selected: its panel is back on the HUD")
        assertTrue(cam.flying, "the camera turns back at once, not frozen mid-dive")
        assertEquals(framed, cam.flightZ, 1e-6, "to the realm's own framing, not the dive's altitude")
        repeat(300) { rig.frame() } // 5 s: past the approach's end
        assertTrue(rig.events.dives.isEmpty(), "the withdrawn dive never fires: ${rig.events.dives}")
        assertEquals(crown, rig.renderer.selectedRealm)

        // Enter map again dives as before: the withdrawn dive left nothing half-set
        rig.renderer.apply(WorldIntent.Dive("crownlands"), rig.now)
        repeat(120) { rig.frame() }
        assertEquals(listOf("crownlands"), rig.events.dives)
        assertEquals(null, rig.renderer.cancelDive(rig.now), "a dive already handed to the host is the host's to cancel")
    }

    @Test fun `a pinch right after that Back waits out the leave's block before it dives`() {
        // as after a leave (LEAVE_BLOCK_MS): the fingers that pressed Back and pinch at once never re-enter the realm the
        // player just backed out of
        val rig = GlobeRig()
        enterMapFlight(rig)
        val cam = rig.renderer.camera
        val (_, geoms) = GlobeRig.geography()
        val crown = GlobeV2Pin.REALMS.indexOfFirst { it.id == "crownlands" }
        assertEquals("crownlands", rig.renderer.cancelDive(rig.now))
        cam.stopMotion(); V.copy(cam.t, geoms[crown].c); cam.z = cam.zOf(0.2); cam.zT = cam.z // below the dive altitude
        repeat(60) { rig.frame() } // 1 s, inside the 1.5 s block
        assertTrue(rig.events.dives.isEmpty(), "no dive inside the block: ${rig.events.dives}")
        repeat(60) { rig.frame() } // past it
        cam.zT = cam.zOf(0.2)
        repeat(120) { rig.frame() }
        assertEquals(listOf("crownlands"), rig.events.dives, "after the block a pinch dives again")
    }

    @Test fun `a context loss re-decodes the verified content and comes back ready`() {
        val rig = GlobeRig(strictCore = false); rig.renderer.start(); rig.untilReady(); rig.frame()
        val decodes = rig.decodes
        rig.context = 2L
        rig.frame()
        assertFalse(rig.renderer.ready, "a new context means new textures")
        rig.untilReady(20)
        assertEquals(decodes + 1, rig.decodes, "restored from the content, not a RAM copy")
        assertEquals(2, rig.events.ready)
    }

    @Test fun `reduced motion stops the idle animations, motion keeps the water and clouds ticking`() {
        val rig = GlobeRig(withIdle = true); rig.renderer.start(); rig.untilReady()
        repeat(200) { rig.frame() } // flights and fades settle
        val idle = rig.idle!!
        assertTrue(idle.delayMs(rig.now.toLong()) < IdleScheduler.NEVER, "water and cloud drift animate at the idle cadence")
        rig.renderer.reducedMotion = true
        repeat(3) { rig.frame() }
        assertEquals(IdleScheduler.NEVER, idle.delayMs(rig.now.toLong()), "reduced motion: nothing asks for a frame")
    }

    @Test fun `the Phase E layer is inert by default (RG-3)`() {
        val rig = GlobeRig(); rig.renderer.start(); rig.untilReady()
        rig.renderer.selectIsland("seeker-island", rig.now)
        assertEquals(null, rig.renderer.selectedIsland)
        assertFalse(rig.renderer.camera.phaseE)
        assertTrue(rig.renderer.phaseE.islands.isEmpty())
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("solana-island")), rig.now)
        assertEquals(null, rig.renderer.selectedIsland)
    }

    // ---- Phase E islands (D-172: on in debug/test builds through the world bundle's flag; RG-3: off everywhere else) ----

    private fun isleDraws(rig: GlobeRig): List<gg.pixelkingdomwars.nativeclient.renderer.gl3.FakeDraw> {
        val isles = rig.world.group.programs.indexOfFirst { it?.fs?.contains("uIsleArt") == true }
        return rig.world.draws.filter { it.program == isles }
    }

    @Test fun `without the world bundle's flag the Phase E islands never load, draw, pick or lower the floor (RG-3)`() {
        // the stage runs (as GlobeContent plans it) and yields null: a release build has no bundle, a bundle without the flag
        val rig = GlobeRig(content = { GlobeRig.assets(it, phaseE = GlobeRig.phaseE(on = false)) })
        rig.renderer.start(); rig.untilReady()
        repeat(120) { rig.frame() }
        assertFalse(rig.renderer.phaseE.enabled); assertFalse(rig.renderer.camera.phaseE)
        assertTrue(rig.renderer.phaseE.islands.isEmpty())
        rig.world.draws.clear(); rig.frame()
        assertTrue(isleDraws(rig).none { it.instances == GlobeV2Pin.PHASE_E.size }, "no Phase E draw")
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("seeker-island")), rig.now)
        assertEquals(null, rig.renderer.selectedIsland)
        assertTrue(rig.events.parts.isEmpty(), "an absent flag is not a failure")
        assertFalse(rig.renderer.lateWork, "nothing is left pending: the idle cadence can reach 0 fps")
    }

    /**
     * Owner 2026-10-06: Solana Island, Seeker Island and the Divine Isle must be on the globe in the very first frame it
     * shows. With their content decoded behind the first stage, ready waits for them: the fields go up whole before the
     * first world frame (where a GL-thread upload is legal), the art is resident, the pair is rehearsed with the globe's
     * own, and the frame in which the globe first reaches the screen draws the 32 exploration islands and the three.
     */
    @Test fun `with the flag the Phase E islands are live in the very first frame the globe draws`() {
        val pool = HeldExecutor()
        val rig = GlobeRig(withIdle = true, decode = pool, content = { GlobeRig.assets(it, phaseE = GlobeRig.phaseE(on = true)) })
        rig.renderer.start()
        repeat(3) { pool.runNext() } // stages + plan, then the first stage's two tasks
        assertEquals(3, pool.tasks.size, "the exploration islands, the Phase E islands, then the 1024² cube")
        repeat(30) { rig.frame() }
        assertFalse(rig.renderer.ready, "held for the islands")
        repeat(2) { pool.runNext() } // the two island stages; the cube stays queued
        val first = firstScreenFrame(rig)
        assertTrue(rig.renderer.phaseE.enabled, "live when the globe first reaches the screen: ${rig.renderer.lateFailure}")
        assertTrue(rig.renderer.camera.phaseE, "the camera may come closer over the art from the start")
        assertEquals(GlobeV2Pin.PHASE_E.map { it.id }, rig.renderer.phaseE.islands.map { it.id }, "the HUD may offer and pick them at once")
        val isles = rig.world.group.programs.indexOfFirst { it?.fs?.contains("uIsleArt") == true }
        assertEquals(listOf(32, GlobeV2Pin.PHASE_E.size), first.filter { it.program == isles }.map { it.instances },
            "the first frame on screen: the 32 exploration islands, then Seeker, Solana and Divine")
        assertEquals(GlobeRig.SMALL, rig.renderer.albedoSize, "the 1024² cube did not hold it")
        assertTrue(rig.renderer.phaseE.fields.all { it?.ready == true }, "every selection field is up")
        assertEquals(0L, rig.core.stats.liveFirstDraws, "every pair it drew was rehearsed behind the loading state")
        assertEquals(0L, rig.core.stats.orderViolations, "the whole-field uploads ran before the first world frame")
        assertTrue(rig.events.parts.isEmpty() && rig.events.unavailable.isEmpty())
    }

    /**
     * The bound of that hold (rewritten 2026-10-06 from "the islands arrive after the first frame"): a chain group that
     * still downloads, or a throttled device, never keeps the player on the loading screen. Past ISLAND_HOLD_MS the globe
     * shows without the islands, and they arrive as they did before: fields in strips from rested frames, the pair
     * rehearsed on an idle frame before their first live draw.
     */
    @Test fun `islands that outlast the hold arrive after the first frame, fields in strips, rehearsed before their first live draw`() {
        val pool = HeldExecutor()
        val rig = GlobeRig(withIdle = true, decode = pool, content = { GlobeRig.assets(it, phaseE = GlobeRig.phaseE(on = true)) })
        rig.renderer.start()
        repeat(3) { pool.runNext() } // stages + plan, then the first stage's two tasks; the islands never decode in time
        val holdFrames = (GlobeV2Renderer.ISLAND_HOLD_MS / 16.0).toInt()
        repeat(holdFrames - 10) { rig.frame() }
        assertFalse(rig.renderer.ready, "held for the islands until the bound")
        rig.untilReady(40)
        assertTrue(rig.renderer.islandWaitMs >= GlobeV2Renderer.ISLAND_HOLD_MS, "it waited the whole bound: ${rig.renderer.islandWaitMs} ms")
        assertFalse(rig.renderer.phaseE.enabled, "not before its content"); assertFalse(rig.renderer.islandsShown)
        pool.runAll()
        repeat(240) { rig.frame() } // about 4 s at rest: art resident, 2.4 MB of fields in strips, the pair rehearsed
        assertTrue(rig.renderer.phaseE.enabled, "live: ${rig.renderer.lateFailure}")
        assertTrue(rig.renderer.camera.phaseE, "the camera may come closer over the art (main.js minAltAt)")
        assertEquals(GlobeV2Pin.PHASE_E.map { it.id }, rig.renderer.phaseE.islands.map { it.id })
        // every field went up from the GL thread in whole rows, never more than COLD_UPLOAD_BYTES at once after the first frame
        for ((i, t) in rig.renderer.phaseE.fields.withIndex()) {
            val tex = rig.world.group.textures[t!!.name]!!
            assertEquals(GlobeRig.PE_SIZES[i][0], tex.width); assertEquals(GlobeRig.PE_SIZES[i][1], tex.height)
            assertEquals(GlobeRig.PE_SIZES[i][1], tex.subImages.sumOf { it[5] }, "every row of field $i, once")
            for (s in tex.subImages) assertTrue(s[4] * s[5] * 4 <= gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GpuSafe.COLD_UPLOAD_BYTES, "a ${s[4]}x${s[5]} strip")
        }
        assertTrue(rig.world.group.textures[rig.renderer.phaseE.fields[0]!!.name]!!.subImages.size >= 2, "the 300² field needed more than one strip")
        assertEquals(0L, rig.core.stats.orderViolations)
        rig.world.draws.clear(); rig.frame()
        val drawn = isleDraws(rig)
        assertEquals(listOf(32, GlobeV2Pin.PHASE_E.size), drawn.map { it.instances }, "the 32 exploration islands, then the three Phase E islands")
        assertEquals(0L, rig.core.stats.liveFirstDraws, "no (program, state) pair is drawn for the first time on screen")
        assertTrue(rig.events.parts.isEmpty() && rig.events.unavailable.isEmpty())
    }

    @Test fun `with the flag and no exploration islands the Phase E draw is rehearsed on its own before ready`() {
        val rig = GlobeRig(direct = true, content = { a -> GlobeRig.assets(a, phaseE = GlobeRig.phaseE(on = true)).let { GlobeAssets(it.first, it.albedoHigh, null, it.phaseE) } })
        rig.renderer.start(); rig.untilReady(20)
        assertTrue(rig.renderer.phaseE.enabled, "a GL-thread-only uploader loads the islands before the first frame")
        rig.world.draws.clear(); rig.frame()
        assertEquals(listOf(GlobeV2Pin.PHASE_E.size), isleDraws(rig).map { it.instances })
        assertEquals(0L, rig.core.stats.liveFirstDraws, "its pair was rehearsed behind the loading state")
        assertEquals(0L, rig.core.stats.orderViolations)
    }

    @Test fun `a Phase E part that cannot load is reported, and the globe keeps running without the islands`() {
        val rig = GlobeRig(content = { GlobeRig.assets(it, phaseE = GlobeRig.phaseE(on = true, fail = true)) })
        rig.renderer.start(); rig.untilReady()
        repeat(60) { rig.frame() }
        assertEquals(listOf(GlobeV2Renderer.PART_PHASE_E), rig.events.parts)
        assertTrue(rig.renderer.ready && rig.events.unavailable.isEmpty())
        assertFalse(rig.renderer.phaseE.enabled); assertFalse(rig.renderer.camera.phaseE)
    }

    @Test fun `a tap on each Phase E island selects it like a realm, reports it by selected only, and outlines it from its own field`() {
        val rig = GlobeRig(content = { GlobeRig.assets(it, phaseE = GlobeRig.phaseE(on = true)) })
        rig.renderer.start(); rig.untilReady()
        repeat(30) { rig.frame() }
        assertTrue(rig.renderer.phaseE.enabled)
        val cam = rig.renderer.camera; val xy = DoubleArray(2)
        for ((i, spec) in GlobeV2Pin.PHASE_E.withIndex()) {
            rig.renderer.home(rig.now); repeat(120) { rig.frame() }
            V.dirOf(cam.t, spec.lon, spec.lat); cam.z = cam.zOf(0.9); cam.zT = cam.z
            rig.frame()
            // a point inside the D-165 tap ellipse, off its centre (a quarter of rx east)
            assertTrue(cam.projectDir(V.dirOf(spec.lon + spec.rx * 0.25 / kotlin.math.cos(spec.lat * V.RAD), spec.lat), 0.0, xy))
            val picks = rig.events.picks.size
            tap(rig, xy[0], xy[1])
            assertEquals(spec.id, rig.renderer.selectedIsland); assertEquals(-1, rig.renderer.selectedRealm)
            assertEquals(spec.id, rig.events.selections.last(), "selected(null, ${spec.id}) drives the island panel")
            assertEquals(picks, rig.events.picks.size, "no picked() for an island: a host mapping only realms would deselect it")
            assertTrue(cam.flying, "the selection frames the island")
            repeat(90) { rig.frame() }
            val sel = rig.gl.vec4.getValue("uSel"); val isle = rig.gl.vec4.getValue("uSelIsle")
            assertEquals(2f, sel[0], "island mode of the shared selection look (rim, keyline, glow, shimmer, draw-on)")
            assertTrue(sel[1] > 0.99f, "faded in")
            assertEquals(GlobeRig.PE_HU[i].toFloat(), isle[0]); assertEquals(GlobeRig.PE_HV[i].toFloat(), isle[1])
            val col = rig.gl.vec4.getValue("uSelCol")
            assertEquals((spec.accent shr 16 and 255) / 255f, col[0], 1e-6f); assertEquals((spec.accent and 255) / 255f, col[2], 1e-6f)
        }
        // off the sphere: deselect, and the outline fades out (a realm then takes realm mode again)
        tap(rig, 2.0, 2.0)
        assertEquals(null, rig.events.selections.last()); assertEquals(null, rig.renderer.selectedIsland)
        repeat(60) { rig.frame() }
        assertEquals(0f, rig.gl.vec4.getValue("uSel")[0])
        rig.renderer.selectRealm(3, rig.now, fly = false)
        repeat(30) { rig.frame() }
        assertEquals(1f, rig.gl.vec4.getValue("uSel")[0])
        assertEquals(1f, rig.gl.vec4.getValue("uSelIsle")[0], "a realm does not read the island window")
    }

    @Test fun `a context loss drops the Phase E islands until they reload, then they are live again`() {
        val rig = GlobeRig(strictCore = false, content = { GlobeRig.assets(it, phaseE = GlobeRig.phaseE(on = true)) })
        rig.renderer.start(); rig.untilReady(); repeat(30) { rig.frame() }
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("divine-isle")), rig.now)
        assertEquals("divine-isle", rig.renderer.selectedIsland)
        rig.context = 2L; rig.frame()
        assertFalse(rig.renderer.phaseE.enabled); assertFalse(rig.renderer.camera.phaseE)
        rig.untilReady(20); repeat(30) { rig.frame() }
        assertTrue(rig.renderer.phaseE.enabled, "back from the verified content")
        assertTrue(rig.renderer.phaseE.fields.all { it?.ready == true })
    }

    @Test fun `a steady frame with a Phase E island selected allocates nothing`() {
        val bean = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        Assume.assumeTrue(bean.isThreadAllocatedMemorySupported)
        bean.isThreadAllocatedMemoryEnabled = true
        val near = NearSource()
        val rig = GlobeRig(withIdle = true, content = { GlobeRig.assets(it, phaseE = GlobeRig.phaseE(on = true), phaseENear = near) })
        rig.renderer.start(); rig.untilReady()
        repeat(60) { rig.frame() }
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("solana-island")), rig.now)
        repeat(400) { rig.frame() }
        assertEquals(2f, rig.gl.vec4.getValue("uSel")[0])
        assertEquals(1, rig.renderer.phaseE.nearIsland, "the near slot holds the framed island while the frames are measured")
        assertTrue(rig.renderer.phaseE.nearActive)
        rig.world.record = false
        var allocated = -1L; var windows = 0
        while (allocated != 0L && windows < 20) {
            val before = bean.currentThreadAllocatedBytes
            repeat(600) { rig.frame() }
            allocated = bean.currentThreadAllocatedBytes - before; windows++
        }
        assertEquals(0L, allocated, "every one of $windows windows of 600 steady frames with an island outlined allocated (last: $allocated bytes)")
    }

    // ---- the near slots (plan §5.8 "+1 island art slot", two since 2026-09-27): the web's close-range density where the
    // camera is, built while the camera heads there, and kept for the return trip (owner 2026-09-27: Seeker, Solana and
    // Divine "take long time to load ... it should be loading smoothly just like rest of globe") ----

    /** Near-slot textures (NEAR_SIZE² with mips, one layer) the GLOBE pool holds now, resident or still filling. */
    private fun nearBytes(): Long { var b = 0L; var s = GlobeRig.NEAR_SIZE; while (s >= 1) { b += s.toLong() * s * 4; s /= 2 }; return b }

    /** Phase E live and every late part resident, the camera home: the GLOBE pool's bytes before any near art. */
    private fun liveRig(near: NearSource, decode: HeldExecutor? = null): GlobeRig {
        val rig = if (decode == null) GlobeRig(content = { GlobeRig.assets(it, phaseE = GlobeRig.phaseE(on = true), phaseENear = near) })
            else GlobeRig(decode = decode, content = { GlobeRig.assets(it, phaseE = GlobeRig.phaseE(on = true), phaseENear = near) })
        rig.renderer.start()
        decode?.runAll() // every stage decodes before the first frame: the islands hold the reveal (owner 2026-10-06)
        rig.untilReady(20)
        repeat(240) { rig.frame() } // at rest: every late part resident, the camera home
        assertTrue(rig.renderer.phaseE.enabled, "live: ${rig.renderer.lateFailure}")
        return rig
    }

    @Test fun `the island the camera heads for is drawn from its own NEAR art in its own box, two stay resident, a third replaces the least recently shown`() {
        val near = NearSource()
        val rig = liveRig(near)
        assertTrue(near.asked.isEmpty(), "the home view is far above every island: no near art is built")
        val farTex = rig.world.group.textures.indexOfFirst { it != null && it.width == 16 && it.layers == GlobeV2Pin.PHASE_E.size }
        assertTrue(farTex > 0, "the far layers are one 16² array of three")
        val base = rig.core.stats.poolBytes[Gl3Pool.GLOBE.ordinal]
        var most = 0L
        fun frames(n: Int) = repeat(n) { rig.frame(); most = maxOf(most, rig.core.stats.poolBytes[Gl3Pool.GLOBE.ordinal] - base) }
        // framed as a selection frames it (floor 0.2): a slot fills with that island at NEAR², off the GL thread
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("solana-island")), rig.now)
        frames(240)
        assertEquals(listOf(1), near.asked.toList(), "one build, for the framed island")
        assertEquals(1, rig.renderer.phaseE.nearIsland); assertTrue(rig.renderer.phaseE.nearActive)
        assertTrue(rig.uploads.filled.any { it[0] == GlobeRig.NEAR_SIZE && it[1] == 1 }, "a one-layer NEAR² texture, filled by the worker")
        rig.gl.instanced.clear(); rig.world.draws.clear(); rig.frame()
        val pe = phaseEDraws(rig)
        val solana = rig.renderer.phaseE.near!!
        assertEquals(2, pe.size, "the far draw, then the near draw: ${pe.map { it.toList() }}")
        assertEquals(listOf(2, farTex, (3 + 1 * 2) * 32, 16), pe[0].toList().take(4), "the two others from their far layers (records 5, 6: all but Solana)")
        assertEquals(listOf(1, solana.name, (9 + 1) * 32, GlobeRig.NEAR_SIZE), pe[1].toList().take(4), "Solana alone from the near texture, uIsleGrid at its size")
        assertEquals(0L, rig.core.stats.liveFirstDraws, "the near draw is the rehearsed (program, state) pair")
        assertEquals(0L, rig.core.stats.orderViolations)
        // another island: built and shown, and Solana's art stays resident for the way back (two slots)
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("divine-isle")), rig.now)
        frames(240)
        assertEquals(listOf(1, 2), near.asked.toList())
        assertEquals(2, rig.renderer.phaseE.nearIsland)
        assertEquals(gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture.READY, solana.state, "Solana's near art is kept, not freed")
        val divine = rig.renderer.phaseE.near!!
        // back to Solana: shown from its slot, never built again
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("solana-island")), rig.now)
        frames(240)
        assertEquals(listOf(1, 2), near.asked.toList(), "Solana -> Divine -> Solana builds twice, not three times")
        assertTrue(rig.renderer.phaseE.near === solana && rig.renderer.phaseE.nearIsland == 1)
        // a third island: it takes the slot of the one shown least recently (Divine), never the one on screen
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("seeker-island")), rig.now)
        frames(240)
        assertEquals(listOf(1, 2, 0), near.asked.toList())
        assertEquals(0, rig.renderer.phaseE.nearIsland)
        assertEquals(gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture.FREED, divine.state, "Divine's art made room")
        assertEquals(gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture.READY, solana.state)
        assertTrue(most <= PhaseEIslandLayer.NEAR_SLOTS * nearBytes(), "never more than NEAR_SLOTS near textures in the GLOBE pool at once (the 140 MB budget): ${most / nearBytes().toDouble()} of them")
        // flying out keeps the slots and asks for nothing
        rig.renderer.home(rig.now); frames(120)
        assertEquals(0, rig.renderer.phaseE.nearIsland); assertEquals(listOf(1, 2, 0), near.asked.toList())
        assertFalse(rig.renderer.lateWork, "nothing pending: the idle cadence can reach 0 fps")
        assertTrue(rig.events.parts.isEmpty())
        assertEquals(listOf("solana-island" to false, "divine-isle" to false, "solana-island" to true, "seeker-island" to false), rig.events.nearArts,
            "each display reported for the host's [world-perf] line, a return trip as resident")
    }

    @Test fun `the near art is built on the decode pool, never in a GL frame, and starts when the selection's flight starts`() {
        val pool = HeldExecutor()
        val near = NearSource()
        val rig = liveRig(near, pool)
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("seeker-island")), rig.now)
        repeat(2) { rig.frame() }
        assertTrue(rig.renderer.camera.flying, "the selection's flight has only begun")
        assertEquals(1, pool.tasks.size, "the build is queued on the decode pool as the flight starts (the approach), not when it lands")
        assertTrue(near.asked.isEmpty(), "and no GL frame ran it")
        repeat(10) { rig.frame() }
        assertEquals(1, pool.tasks.size, "one build at a time: the frames never queue it twice")
        assertTrue(pool.runNext())
        assertEquals(listOf(0), near.asked.toList())
        var n = 0
        while (!rig.renderer.phaseE.nearActive && n < 240) { rig.frame(); n++ }
        assertEquals(0, rig.renderer.phaseE.nearIsland)
        assertEquals(listOf(0), near.asked.toList())
    }

    /** The + / − tools set the zoom target and the camera eases to it (as [GlobeV2Renderer.zoomBy]); a real two-finger
     *  pinch writes zT = z on every move instead, which the pinch test below drives through the touch path. */
    @Test fun `the zoom tool aiming low over an island starts its build while the zoom is still easing in`() {
        val near = NearSource()
        val rig = liveRig(near)
        val cam = rig.renderer.camera; val spec = GlobeV2Pin.PHASE_E[1]
        V.dirOf(cam.t, spec.lon, spec.lat); cam.z = cam.zOf(2.0); cam.zT = cam.zOf(0.4)
        rig.frame()
        assertTrue(cam.altOf(cam.z) > PhaseEIslandLayer.NEAR_ALT, "the camera itself is still high")
        assertEquals(listOf(1), near.asked.toList(), "the aim (the zoom target) is below NEAR_ALT over Solana: built now")
    }

    @Test fun `leaving an island cancels its build, which uploads nothing and refuses nothing, and the next build waits for it to stop`() {
        val pool = HeldExecutor()
        val near = NearSource()
        val rig = liveRig(near, pool)
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("seeker-island")), rig.now)
        repeat(2) { rig.frame() }
        assertEquals(1, pool.tasks.size)
        // while Seeker's build runs, the camera leaves for Solana (a GL frame between two of the build's checks)
        var waited = -1
        near.onBuild = {
            rig.renderer.home(rig.now); repeat(2) { rig.frame() }
            rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("solana-island")), rig.now); repeat(4) { rig.frame() }
            waited = pool.tasks.size
        }
        assertTrue(pool.runNext())
        near.onBuild = null
        assertEquals(0, waited, "Solana's build waits while Seeker's is still out: one build at a time")
        assertEquals(listOf(0), near.cancelled.toList(), "Seeker's build saw its cancel check and returned nothing")
        val nearUploads = { rig.uploads.filled.count { it[0] == GlobeRig.NEAR_SIZE } }
        assertEquals(0, nearUploads(), "a cancelled build uploads nothing")
        repeat(2) { rig.frame() }
        assertEquals(1, pool.tasks.size, "Seeker's build reported: now Solana's is queued")
        repeat(240) { rig.frame(); pool.runAll() }
        assertEquals(1, rig.renderer.phaseE.nearIsland); assertEquals(1, nearUploads())
        assertTrue(rig.events.parts.isEmpty(), "a cancel is not a failure")
        // a build cancelled before it started never reads the art
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("divine-isle")), rig.now); repeat(2) { rig.frame() }
        rig.renderer.home(rig.now); repeat(2) { rig.frame() }
        assertTrue(pool.runNext())
        assertEquals(listOf(0, 1), near.asked.toList(), "Divine's build never started: the camera had left")
        // Seeker was not refused: going there builds it
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("seeker-island")), rig.now)
        repeat(240) { rig.frame(); pool.runAll() }
        assertEquals(0, rig.renderer.phaseE.nearIsland)
        assertEquals(listOf(0, 1, 0), near.asked.toList())
    }

    @Test fun `a dive frees the spare near slot and keeps the displayed one`() {
        val near = NearSource()
        val rig = liveRig(near)
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("solana-island")), rig.now); repeat(240) { rig.frame() }
        val solana = rig.renderer.phaseE.near!!
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("divine-isle")), rig.now); repeat(240) { rig.frame() }
        val divine = rig.renderer.phaseE.near!!
        assertEquals(gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture.READY, solana.state)
        rig.renderer.sleep() // the realm map took over (diveResult ok)
        assertEquals(gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture.FREED, solana.state, "the realm map never pays for the globe's spare slot")
        assertEquals(gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture.READY, divine.state)
        assertEquals(2, rig.renderer.phaseE.nearIsland)
    }

    /** The Phase E island specs by id, and the texture a near build made for each (in build order). */
    private fun island(id: String) = GlobeV2Pin.PHASE_E.indexOfFirst { it.id == id }
    private fun nearTextures(rig: GlobeRig) = rig.uploads.created.filter { it.width == GlobeRig.NEAR_SIZE }
    private fun visit(rig: GlobeRig, id: String, pool: HeldExecutor? = null) {
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island(id)), rig.now)
        repeat(240) { rig.frame(); pool?.runAll() }
        assertEquals(island(id), rig.renderer.phaseE.nearIsland, "$id shown after its visit")
    }
    /** Art widths from the view centre to island [i] (main.js islandArt.bind's ranking). */
    private fun widths(rig: GlobeRig, i: Int): Double {
        val s = GlobeV2Pin.PHASE_E[i]; val c = DoubleArray(3); V.norm(c, rig.renderer.camera.t)
        return kotlin.math.acos(V.clamp(V.dot(c, V.dirOf(s.lon, s.lat)), -1.0, 1.0)) / V.RAD / s.wDeg
    }
    private fun restAt(rig: GlobeRig, dir: DoubleArray, alt: Double) {
        val cam = rig.renderer.camera
        cam.stopMotion(); V.copy(cam.t, dir); cam.z = cam.zOf(alt); cam.zT = cam.z
        repeat(2) { rig.frame() }
    }
    private val READY = gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture.READY
    private val FREED = gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture.FREED

    /**
     * Review 2026-09-27 (MAJOR 1): the near build followed every flight's target, and Solana Reach's frame centre lies
     * within NEAR_REACH of Seeker Island, so selecting Solana Reach (its panel prefetches the map) or diving into it
     * started Seeker's 22 MB close-up on the same world-load pool as the realm's own loads, the ones the owner waits
     * for. A realm aim (its selection, its Enter-map dive, the dive's wait) starts no island build and cancels a running one.
     */
    @Test fun `a realm's selection flight and its Enter-map dive start no island build and cancel a running one`() {
        val pool = HeldExecutor()
        val near = NearSource()
        val rig = liveRig(near, pool)
        val (geo, geoms) = GlobeRig.geography()
        val reach = GlobeV2Pin.REALMS.indexOfFirst { it.id == "seeker-reach" }
        val seeker = GlobeV2Pin.PHASE_E[island("seeker-island")]
        val centre = geoms[reach].c
        val d = kotlin.math.acos(V.clamp(V.dot(centre, V.dirOf(seeker.lon, seeker.lat)), -1.0, 1.0)) / V.RAD / seeker.wDeg
        assertTrue(d < PhaseEIslandLayer.NEAR_REACH, "Solana Reach's frame centre is $d Seeker art widths away: the case the review found")
        for (s in GlobeV2Pin.PHASE_E) assertEquals(null, rig.renderer.realmIds.getOrNull(geo.regionAt(s.lon, s.lat)), "${s.id} lies in no realm, so no realm aim covers an island itself")
        val cam = rig.renderer.camera
        restAt(rig, V.dirOf(seeker.lon, seeker.lat), 0.8)
        assertEquals(1, pool.tasks.size, "resting near Seeker Island builds its close-up")
        // the realm panel: its selection flight frames Solana Reach, and the player zooms in on the realm
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Realm("seeker-reach")), rig.now)
        repeat(2) { rig.frame() }
        assertTrue(cam.flying)
        repeat(240) { rig.frame() }
        assertFalse(cam.flying)
        rig.renderer.zoomBy(cam.zOf(0.7) - cam.z) // the + tool, the realm still selected
        repeat(120) { rig.frame() }
        assertTrue(cam.altOf(cam.z) < PhaseEIslandLayer.NEAR_ALT && widths(rig, island("seeker-island")) < PhaseEIslandLayer.NEAR_REACH,
            "at rest over the selected realm, low and near enough that Seeker's close-up would be wanted: alt ${cam.altOf(cam.z)}, ${widths(rig, island("seeker-island"))} widths")
        assertEquals(1, pool.tasks.size, "no build for the realm's flight, its zoom or its rest")
        pool.runAll()
        assertTrue(near.asked.isEmpty(), "the running Seeker build was cancelled before it read anything: ${near.asked}")
        repeat(4) { rig.frame() }
        assertTrue(pool.tasks.isEmpty(), "and none after it")
        // Enter map, straight from the HUD: a running build is cancelled; nothing builds in the dive's flight or its wait
        rig.renderer.deselect()
        restAt(rig, V.dirOf(seeker.lon, seeker.lat), 0.8)
        assertEquals(1, pool.tasks.size)
        rig.renderer.divable = setOf("seeker-reach")
        rig.renderer.apply(WorldIntent.Dive("seeker-reach"), rig.now)
        var n = 0
        while (rig.events.dives.isEmpty() && n < 240) { rig.frame(); n++ }
        assertEquals(listOf("seeker-reach"), rig.events.dives)
        repeat(60) { rig.frame() } // the host's DIVE_WAIT: the globe still runs, at rest low over the realm
        assertTrue(cam.altOf(cam.z) < PhaseEIslandLayer.NEAR_ALT && widths(rig, island("seeker-island")) < PhaseEIslandLayer.NEAR_REACH)
        assertEquals(1, pool.tasks.size, "no build for the dive")
        pool.runAll()
        assertTrue(near.asked.isEmpty(), "the running build was cancelled by the dive: ${near.asked}")
        repeat(4) { rig.frame() }
        assertTrue(pool.tasks.isEmpty())
        // back from the map with nothing selected: the leave flies to the realm's frame (alt 0.9, near Seeker) and starts
        // no build; once the camera rests there, near an island, it may
        rig.renderer.diveResult(true, "seeker-reach", rig.now)
        rig.renderer.leave("seeker-reach", V.lon(centre), V.lat(centre), rig.now)
        repeat(2) { rig.frame() }
        assertTrue(cam.flying && cam.altOf(cam.flightZ) < PhaseEIslandLayer.NEAR_ALT, "the leave's flight aims low over the realm")
        assertTrue(pool.tasks.isEmpty(), "no build for the leave's flight")
        n = 0
        while (cam.flying && n < 240) { rig.frame(); n++ }
        repeat(2) { rig.frame() }
        assertEquals(1, pool.tasks.size, "a camera at rest near Seeker Island, nothing selected: its build starts")
        assertTrue(rig.events.parts.isEmpty(), "a cancel is not a failure")
    }

    /**
     * Review 2026-09-27 (MAJOR 2): the resample's helper lanes are the host's world-isle threads, whose uncaught handler
     * fails the whole world to the legacy globe. A lane that throws (an OutOfMemoryError in its band loop) must cost only
     * that island's close-up: the error reaches the build on its own thread, where the renderer's catch refuses the
     * island and the far layer keeps drawing.
     */
    @Test fun `a resample lane that throws costs only that island's close-up, never the lane's thread or the world`() {
        val lane = DyingLane(OutOfMemoryError("Failed to allocate a 16777232 byte allocation"))
        val size = GlobeRig.NEAR_SIZE
        val rgba = ByteArray(40 * 40 * 4) { if (it % 4 == 3) -1 else 90 }
        val near = GlobeNearArt { i, cancelled ->
            val out = PhaseEIslandLayer.resample(GlobeV2Pin.PHASE_E[i], rgba, 40, 40, size, lane.executor, 2) { cancelled() || lane.check() }
                ?: return@GlobeNearArt null
            GlobeNearBuilt(GlobeTextureData(size, size, gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format.RGBA8,
                gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling.LINEAR_MIPMAP_LINEAR, gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap.CLAMP,
                arrayOf(GlobeContent.mipChain(out, size, size, 4))))
        }
        val rig = GlobeRig(content = { GlobeRig.assets(it, phaseE = GlobeRig.phaseE(on = true), phaseENear = near) })
        rig.renderer.start(); rig.untilReady(); repeat(30) { rig.frame() }
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("seeker-island")), rig.now)
        repeat(240) { rig.frame() }
        lane.join()
        assertTrue(lane.uncaught.isEmpty(), "nothing escaped the lane's thread (the host's world-isle handler drops the world): ${lane.uncaught}")
        assertEquals(listOf(GlobeV2Renderer.PART_PHASE_E_NEAR), rig.events.parts, "the island's close-up failed, reported once")
        assertTrue(rig.renderer.ready && rig.renderer.phaseE.enabled && rig.renderer.failure == null && rig.events.unavailable.isEmpty(), "the world stays up")
        assertEquals(-1, rig.renderer.phaseE.nearIsland)
        rig.gl.instanced.clear(); rig.frame()
        assertEquals(listOf(GlobeV2Pin.PHASE_E.size), phaseEDraws(rig).map { it[0] }, "all three still drawn from their far layers")
    }

    /**
     * Review 2026-09-27 (minor 6): the spare close-up was freed only at sleep(), after the fade, so the approach prefetch,
     * the dive's wait and its fade-in ran the realm's loads beside two island slots. The dive's start frees it (the
     * displayed one stays: the globe is still on screen), cancels a running build (nothing is uploaded) and frees a
     * texture still filling; the approach prefetch's firing does the same, and no island build follows it.
     */
    @Test fun `a dive's start frees the spare close-up, cancels a running build and frees a filling upload`() {
        val (_, geoms) = GlobeRig.geography()
        val centre = geoms[GlobeV2Pin.REALMS.indexOfFirst { it.id == "seeker-reach" }].c
        // a running build when a zoom-in dive starts
        run {
            val pool = HeldExecutor(); val near = NearSource(); val rig = liveRig(near, pool)
            visit(rig, "solana-island", pool); visit(rig, "divine-isle", pool)
            rig.renderer.deselect(); rig.renderer.divable = setOf("seeker-reach")
            restAt(rig, centre, 0.9)
            assertEquals(1, pool.tasks.size, "at rest over the realm (not yet its approach), near Seeker: Seeker's build is out")
            val shown = rig.renderer.phaseE.near!!
            val spare = nearTextures(rig).single { it !== shown }
            rig.renderer.camera.zT = rig.renderer.camera.zOf(0.2) // the zoom tool, down past the dive altitude
            var n = 0
            while (rig.events.dives.isEmpty() && n < 240) { rig.frame(); n++ }
            assertEquals(listOf("seeker-reach"), rig.events.dives)
            assertFalse(rig.renderer.asleep, "the dive has started, the realm map has not taken over")
            assertEquals(FREED, spare.state, "the spare close-up is freed at the dive's start, not after the fade")
            assertEquals(READY, shown.state, "the displayed one stays while the globe is on screen")
            pool.runAll(); repeat(4) { rig.frame() }
            assertTrue(near.asked.size == 2, "Seeker's build was cancelled before it read anything: ${near.asked}")
            assertEquals(2, nearTextures(rig).size, "nothing uploaded")
        }
        // a texture still filling when the dive starts
        run {
            val pool = HeldExecutor(); val near = NearSource(); val rig = liveRig(near, pool)
            rig.renderer.divable = setOf("seeker-reach")
            restAt(rig, centre, 0.9)
            rig.uploads.hold = true // the host adopts no upload yet
            assertTrue(pool.runNext()); repeat(2) { rig.frame() }
            val filling = nearTextures(rig).single()
            assertEquals(gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture.PENDING, filling.state)
            rig.renderer.camera.zT = rig.renderer.camera.zOf(0.2)
            var n = 0
            while (rig.events.dives.isEmpty() && n < 240) { rig.frame(); n++ }
            assertEquals(listOf("seeker-reach"), rig.events.dives)
            assertEquals(FREED, filling.state, "the filling close-up is freed at the dive's start")
            rig.uploads.hold = false; repeat(4) { rig.frame() }
            assertEquals(-1, rig.renderer.phaseE.nearIsland)
        }
        // the approach prefetch fires (a rest low over the realm): the spare goes, the build is cancelled, none follows
        run {
            val pool = HeldExecutor(); val near = NearSource(); val rig = liveRig(near, pool)
            visit(rig, "solana-island", pool); visit(rig, "divine-isle", pool)
            rig.renderer.deselect(); rig.renderer.divable = setOf("seeker-reach")
            restAt(rig, centre, 0.5)
            assertEquals(1, pool.tasks.size, "Seeker's build is out before the approach answers")
            val shown = rig.renderer.phaseE.near!!
            val spare = nearTextures(rig).single { it !== shown }
            var n = 0
            while (rig.events.approaches.isEmpty() && n < 120) { rig.frame(); n++ }
            assertEquals(listOf("seeker-reach"), rig.events.approaches)
            assertEquals(FREED, spare.state, "the spare goes when the realm's prefetch starts")
            assertEquals(READY, shown.state)
            pool.runAll(); repeat(60) { rig.frame(); pool.runAll() }
            assertEquals(2, near.asked.size, "the build was cancelled, and none follows while the camera stays over the realm: ${near.asked}")
            assertTrue(pool.tasks.isEmpty())
        }
    }

    /**
     * Review 2026-09-27 (minor 3): a filling close-up kept its whole build (22.4 MB of pixels on the device) until the
     * texture was resident, only for three timing numbers, while the host held its uploads through the flight. Once its
     * texture is filling, the build is the uploader's alone; the times still reach the report.
     */
    @Test fun `a filling close-up keeps its build's times, never the build itself`() {
        val near = NearSource(); val rig = liveRig(near)
        rig.uploads.hold = true // the host adopts no upload in a flight
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("solana-island")), rig.now)
        repeat(10) { rig.frame() }
        val filling = nearTextures(rig).single()
        assertEquals(gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture.PENDING, filling.state)
        val build = near.built.single()
        var n = 0
        while (build.get() != null && n < 50) { System.gc(); Thread.sleep(10); n++ }
        assertEquals(null, build.get(), "nothing holds the build while its texture fills")
        rig.uploads.hold = false
        repeat(240) { rig.frame() }
        assertEquals(island("solana-island"), rig.renderer.phaseE.nearIsland)
        assertEquals(listOf("solana-island" to false), rig.events.nearArts, "reported as a fresh build")
        assertTrue(rig.events.nearWaits.single()[2] > 0.0, "with its time from the request")
    }

    /**
     * Review 2026-09-27 (minor 7): the slot for a new close-up was freed when its pixels arrived, mid-flight, before its
     * texture could be adopted (the host adopts uploads only outside flights and fades), so a change of mind in that
     * flight lost a resident island. The rule now: a free slot is taken at once; with both held, the build waits until
     * the camera is not flying and still aims at its island, then frees the least recently used slot that is not
     * displayed. A change of mind before then drops the waiting build and keeps both residents.
     */
    @Test fun `a finished build takes a held slot only once the camera has stopped and still aims at its island`() {
        val pool = HeldExecutor(); val near = NearSource(); val rig = liveRig(near, pool)
        val cam = rig.renderer.camera
        visit(rig, "solana-island", pool); visit(rig, "divine-isle", pool)
        val (solana, divine) = nearTextures(rig)
        // Seeker: its pixels arrive mid-flight with both slots held: they wait; nothing is reserved or freed
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("seeker-island")), rig.now)
        repeat(2) { rig.frame() }
        assertTrue(pool.runNext())
        repeat(10) { rig.frame() }
        assertTrue(cam.flying)
        assertTrue(rig.renderer.lateWork, "the waiting build keeps the frames coming")
        assertEquals(2, nearTextures(rig).size, "no texture reserved in the flight")
        assertEquals(READY, solana.state); assertEquals(READY, divine.state)
        // a change of mind mid-flight: back to Solana. Seeker's waiting build is dropped; both residents stay
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("solana-island")), rig.now)
        repeat(240) { rig.frame(); pool.runAll() }
        assertEquals(listOf(1, 2, 0), near.asked.toList(), "Solana shown from its slot, never rebuilt")
        assertTrue(rig.renderer.phaseE.near === solana && rig.renderer.phaseE.nearIsland == 1)
        assertEquals(READY, divine.state, "Divine survived the change of mind")
        assertEquals(2, nearTextures(rig).size); assertFalse(rig.renderer.lateWork, "nothing left waiting")
        // Seeker all the way: the victim is taken once the flight ends, the least recently used slot not displayed
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("seeker-island")), rig.now)
        repeat(2) { rig.frame() }
        assertTrue(pool.runNext())
        while (cam.flying) { rig.frame(); assertEquals(READY, divine.state, "nothing is evicted in the flight") }
        repeat(240) { rig.frame() }
        assertEquals(0, rig.renderer.phaseE.nearIsland)
        assertEquals(FREED, divine.state, "Divine, used least recently, made room"); assertEquals(READY, solana.state)
        // at rest the aim decides: a build still out for Divine while the zoom tool heads down over resident Solana never
        // takes Solana's (or Seeker's) slot, and is dropped once the camera settles on Solana
        val seekerTex = rig.renderer.phaseE.near!!
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("divine-isle")), rig.now)
        repeat(2) { rig.frame() }
        assertEquals(1, pool.tasks.size)
        val s = GlobeV2Pin.PHASE_E[island("solana-island")]
        cam.stopMotion(); V.dirOf(cam.t, s.lon, s.lat); cam.z = cam.zOf(1.5); cam.zT = cam.zOf(0.4)
        rig.frame()
        assertTrue(pool.runNext())
        var n = 0
        while (kotlin.math.abs(cam.zT - cam.z) > 1e-4 && n < 240) {
            rig.frame(); n++
            assertEquals(READY, solana.state, "the aimed island's slot is never taken"); assertEquals(READY, seekerTex.state, "nor Seeker's: the camera is not going to Divine")
        }
        repeat(60) { rig.frame() }
        assertEquals(1, rig.renderer.phaseE.nearIsland)
        assertEquals(READY, solana.state); assertEquals(READY, seekerTex.state)
        assertEquals(3, nearTextures(rig).size, "Divine's pixels were dropped, never uploaded")
        assertFalse(rig.renderer.lateWork)
    }

    /**
     * Review 2026-09-27 (minor 8): the displayed close-up switched to a flight's destination on the flight's first frame,
     * so the island being left dropped to its far layer while still on screen. The view centre decides (main.js
     * islandArt.bind): the destination shows only once the view centre is nearer it than any other resident island.
     */
    @Test fun `the island being left keeps its close-up until the view centre is nearer the destination`() {
        val near = NearSource(); val rig = liveRig(near)
        val cam = rig.renderer.camera
        visit(rig, "solana-island"); visit(rig, "divine-isle")
        val divine = island("divine-isle"); val solana = island("solana-island")
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("solana-island")), rig.now)
        rig.frame()
        assertTrue(cam.flying)
        assertEquals(divine, rig.renderer.phaseE.nearIsland, "the flight's first frame still shows Divine, the island on screen")
        var leftShown = 0; var n = 0
        while (cam.flying && n < 240) {
            rig.frame(); n++
            if (rig.renderer.phaseE.nearIsland == divine) leftShown++
            else {
                assertEquals(solana, rig.renderer.phaseE.nearIsland)
                assertTrue(widths(rig, solana) < widths(rig, divine) && widths(rig, solana) < PhaseEIslandLayer.NEAR_REACH &&
                    cam.altOf(cam.z) < PhaseEIslandLayer.NEAR_ALT, "Solana shows only with the view centre nearer it, below NEAR_ALT")
            }
        }
        assertTrue(leftShown > 0, "Divine stayed displayed into the flight")
        repeat(10) { rig.frame() }
        assertEquals(solana, rig.renderer.phaseE.nearIsland)
        assertEquals(listOf("solana-island" to false, "divine-isle" to false, "solana-island" to true), rig.events.nearArts)
    }

    /**
     * Review 2026-09-27 (minor 9): a real two-finger pinch writes zT = z on every move ([GlobeGestures.move]), so the
     * zoom target never leads the camera and the build started only once the camera itself was below NEAR_ALT. Its aim
     * follows the pinch's trend: the build is queued while the fingers still spread and the camera is still above it.
     */
    @Test fun `a real two-finger pinch down over an island queues its build while the fingers still spread`() {
        val pool = HeldExecutor(); val near = NearSource(); val rig = liveRig(near, pool)
        val cam = rig.renderer.camera
        val s = GlobeV2Pin.PHASE_E[island("solana-island")]
        restAt(rig, V.dirOf(s.lon, s.lat), 2.0)
        assertTrue(pool.tasks.isEmpty(), "high above the island: nothing")
        val xy = DoubleArray(2)
        assertTrue(cam.projectDir(V.dirOf(s.lon, s.lat), 0.0, xy))
        val x = xy[0]; val y = xy[1]; var d = 60.0
        rig.renderer.touchDown(0, (x - d).toFloat(), y.toFloat(), rig.now); rig.renderer.touchDown(1, (x + d).toFloat(), y.toFloat(), rig.now)
        rig.frame()
        var queuedAt = Double.NaN; var n = 0
        while (cam.altOf(cam.z) > 0.6 && n < 120) {
            d *= 1.06
            rig.renderer.touchDragged(0, (x - d).toFloat(), y.toFloat(), rig.now); rig.renderer.touchDragged(1, (x + d).toFloat(), y.toFloat(), rig.now)
            rig.frame(); n++
            assertEquals(cam.z, cam.zT, "a real pinch: the zoom target is the camera's own")
            if (queuedAt.isNaN() && pool.tasks.isNotEmpty()) queuedAt = cam.altOf(cam.z)
        }
        assertTrue(cam.altOf(cam.z) <= 0.6, "the pinch went down to ${cam.altOf(cam.z)}")
        assertEquals(1, pool.tasks.size, "queued before the fingers lift, once")
        assertTrue(queuedAt > PhaseEIslandLayer.NEAR_ALT, "queued while the camera was still above NEAR_ALT, at $queuedAt: the pinch's trend leads it")
        rig.renderer.touchUp(0, (x - d).toFloat(), y.toFloat(), rig.now); rig.renderer.touchUp(1, (x + d).toFloat(), y.toFloat(), rig.now)
        assertTrue(pool.runNext())
        assertEquals(listOf(island("solana-island")), near.asked.toList())
    }

    /**
     * Review 2026-09-27 (minor 10): the [world-perf] near line gave the build's times but not the wait the player saw.
     * Each display now carries the blur (ms the camera had been at the island on its far layer; 0 when the close-up was
     * there first) and whether the build finished during the flight.
     */
    @Test fun `each close-up display reports the blur the player waited through and whether its build finished in flight`() {
        // built at the selection's start (inline decode): done in the flight, shown by the time the camera got there
        run {
            val near = NearSource(); val rig = liveRig(near)
            visit(rig, "solana-island")
            val w = rig.events.nearWaits.single()
            assertEquals(0.0, w[0], "no blur"); assertEquals(1.0, w[1], "finished during the flight")
        }
        // a build held until the camera has rested at Seeker for 30 frames: that is its blur, and it finished after the flight
        run {
            val pool = HeldExecutor(); val near = NearSource(); val rig = liveRig(near, pool)
            val cam = rig.renderer.camera
            rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("seeker-island")), rig.now)
            var n = 0
            while (cam.flying && n < 240) { rig.frame(); n++ }
            val arrived = rig.now
            repeat(30) { rig.frame() }
            assertTrue(pool.runNext())
            n = 0
            while (!rig.renderer.phaseE.nearActive && n < 60) { rig.frame(); n++ }
            val shownAt = rig.now
            val w = rig.events.nearWaits.single()
            assertEquals(0.0, w[1], "finished after the flight")
            assertEquals(shownAt - arrived, w[0], 16.0 + 1e-9, "blur from the arrival to the display: ${w[0]} ms")
            assertTrue(w[0] >= 30 * 16.0, "at least the 30 frames it rested there")
            assertTrue(w[2] >= w[0], "the total covers it")
        }
    }

    @Test fun `a near art that cannot be made leaves the island on its far layer, reported once, and a GL-thread-only uploader never builds one`() {
        val oom = NearSource(OutOfMemoryError("Failed to allocate a 16777232 byte allocation"))
        val rig = GlobeRig(content = { GlobeRig.assets(it, phaseE = GlobeRig.phaseE(on = true), phaseENear = oom) })
        rig.renderer.start(); rig.untilReady(); repeat(30) { rig.frame() }
        rig.renderer.apply(WorldIntent.Select(WorldTarget.Island("seeker-island")), rig.now)
        repeat(240) { rig.frame() }
        assertEquals(listOf(0), oom.asked.toList(), "tried once, never again this load")
        assertEquals(listOf(GlobeV2Renderer.PART_PHASE_E_NEAR), rig.events.parts)
        assertEquals(-1, rig.renderer.phaseE.nearIsland)
        assertTrue(rig.renderer.phaseE.enabled && rig.renderer.ready, "the islands and the globe keep running")
        rig.gl.instanced.clear(); rig.frame()
        assertEquals(listOf(GlobeV2Pin.PHASE_E.size), phaseEDraws(rig).map { it[0] }, "all three from their far layers")
        // no worker: the near art could only be uploaded from the GL thread after the first frame, which is refused
        val near = NearSource()
        val direct = GlobeRig(direct = true, content = { a -> GlobeRig.assets(a, phaseE = GlobeRig.phaseE(on = true), phaseENear = near).let { GlobeAssets(it.first, it.albedoHigh, null, it.phaseE, it.phaseENear) } })
        direct.renderer.start(); direct.untilReady(20)
        direct.renderer.apply(WorldIntent.Select(WorldTarget.Island("seeker-island")), direct.now)
        repeat(120) { direct.frame() }
        assertTrue(near.asked.isEmpty()); assertEquals(-1, direct.renderer.phaseE.nearIsland)
    }

    @Test fun `the live Phase E islands publish label anchors after the realms', and none while the layer is off`() {
        for (on in listOf(true, false)) {
            val rig = GlobeRig(content = { GlobeRig.assets(it, phaseE = GlobeRig.phaseE(on = on)) })
            rig.renderer.start(); rig.untilReady(); repeat(30) { rig.frame() }
            assertEquals(on, rig.renderer.phaseE.enabled)
            val cam = rig.renderer.camera
            for ((i, spec) in GlobeV2Pin.PHASE_E.withIndex()) {
                V.dirOf(cam.t, spec.lon, spec.lat); cam.z = cam.zOf(0.9); cam.zT = cam.z
                repeat(2) { rig.frame() }
                val f = rig.frames.latest()
                val ids = (0 until f.anchorCount).map { f.anchorIds[it] }
                assertTrue(ids.all { it < GlobeV2Pin.REALMS.size + GlobeV2Pin.PHASE_E.size }, "ids are destination indices: $ids")
                assertEquals(on, PhaseEIslandLayer.ANCHOR_BASE + i in ids, "${spec.id} (layer ${if (on) "on" else "off"}): anchors $ids")
                if (on) {
                    val k = ids.indexOf(PhaseEIslandLayer.ANCHOR_BASE + i); val xy = DoubleArray(2)
                    assertTrue(cam.projectDir(V.dirOf(spec.lon, spec.lat), GlobeV2Pin.LABEL_LIFT, xy))
                    assertEquals(rig.input.bufferToViewX(xy[0].toFloat()), f.anchorXY[k * 2], 0.5f, "at the island, lifted like a realm's label")
                    assertTrue(ids.withIndex().all { (n, id) -> id < PhaseEIslandLayer.ANCHOR_BASE || ids.drop(n).all { it >= PhaseEIslandLayer.ANCHOR_BASE } }, "realms first: $ids")
                }
            }
        }
    }

    @Test fun `a steady frame allocates nothing`() {
        val bean = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        Assume.assumeTrue(bean.isThreadAllocatedMemorySupported)
        bean.isThreadAllocatedMemoryEnabled = true
        val rig = GlobeRig(withIdle = true); rig.renderer.start(); rig.untilReady()
        rig.renderer.selectRealm(2, rig.now, fly = false)
        repeat(400) { rig.frame() }
        rig.world.record = false
        var allocated = -1L; var windows = 0
        while (allocated != 0L && windows < 20) {
            val before = bean.currentThreadAllocatedBytes
            repeat(600) { rig.frame() }
            allocated = bean.currentThreadAllocatedBytes - before; windows++
        }
        assertEquals(0L, allocated, "every one of $windows windows of 600 steady globe frames allocated (last: $allocated bytes)")
    }

    /** The Phase E draws of the last frames: the islands program's instanced draws other than the 32 exploration islands. */
    private fun phaseEDraws(rig: GlobeRig): List<IntArray> {
        val isles = rig.world.group.programs.indexOfFirst { it?.fs?.contains("uIsleArt") == true }
        return rig.gl.instanced.filter { it[4] == isles && it[0] != 32 }
    }

    private fun tap(rig: GlobeRig, x: Double, y: Double) {
        rig.renderer.touchDown(0, x.toFloat(), y.toFloat(), rig.now)
        rig.frame(20.0)
        rig.renderer.touchUp(0, x.toFloat(), y.toFloat(), rig.now)
        rig.frame(20.0)
    }
}
