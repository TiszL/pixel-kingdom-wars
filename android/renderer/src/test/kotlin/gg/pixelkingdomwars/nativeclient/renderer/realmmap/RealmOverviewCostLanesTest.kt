package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Bands
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundCost
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.Resolve
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LaneCostFixture
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeTablesFile
import gg.pixelkingdomwars.nativeclient.renderer.world.FrameCost
import gg.pixelkingdomwars.nativeclient.renderer.world.FrameLadder
import gg.pixelkingdomwars.nativeclient.renderer.world.GpuCalibration
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderInputs
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderPolicy
import gg.pixelkingdomwars.nativeclient.renderer.world.PassCost
import gg.pixelkingdomwars.nativeclient.renderer.world.SeekerRows
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrameCost
import org.junit.Test
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The whole realm frame on the owner's Seeker (GLOBE-NATIVE-PLAN §1.2, §5.2, §5.4; the integrate half owed since N3): the
 * core's passes ([RealmOverviewCost]) with the N3 lanes' own lists composed in through `lanes =` — GROUND
 * ([GroundCost.passCosts]: its display pass or passes at the ladder's k and the frame's worst resolve slice, as
 * GroundLane.prepare budgets it), LIFE ([LifeCost][gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeCost]
 * over the planner at the level's cap and heaviness) and BASES (BasesCost's every-deed bound) — priced at
 * [GpuCalibration.SEEKER] on [SeekerRows.MEASURED].
 *
 * Why it matters: on the first Seeker run (2026-09-25 17:13–17:21) every MAP entry at L0 (k 1) stepped quality down within
 * 0.1–2.3 s (the hang guard in Crownlands, the ladder in Frostveil and Thornwake) while the placeholder rates priced that
 * frame at 6.4 ms. A model that cannot see the owner's slow frames tells the ladder and the gates nothing; this one is held
 * to the session, and the ladder's rules are held to it.
 */
class RealmOverviewCostLanesTest {
    private val config = RealmWebPin.CONFIG
    /** The production ladder: GPU_SAFE.groundPx[0] and LIFE_CAPS.submitted.phone from the pinned tables. */
    private val ladder = FrameLadder(LadderPolicy.PLAN, LadderInputs(config.groundPx[0], LifeTablesFile.load().constants.submittedPhone))
    private val row = SeekerRows.MEASURED
    /** As RealmOverviewCostTest: the approved minimap priced at 6 % of the screen, every base of the largest realm on it. */
    private val minimapShare = 0.06
    private val points = 15_271
    private val seeker = GpuCalibration.SEEKER

    /**
     * One live frame of [realm] at [d] on ladder [level]. The ground draws MAP below TRUE_FULL and TRUE from TRUE_START
     * (both, a fade, between); its resolve slice is GroundLane.prepare's worst: the buffer's resolve budget (pages from
     * PAGE_RESOLVE), capped by the level's maxResolves, a sub-tile before a page at L1+. [dressed]: the realm draws its
     * LIFE and BASES lists (and then its own dots); by default, when it has LIFE tables and kit dressing at the pin (all
     * eight at stage B 205b6326). [lifeVs]: LIFE passes whose vertex walk is priced at another pin's (by pass name). A
     * frame of the owner's session is modelled as that APK drew it ([session]).
     */
    private fun frame(realm: String, d: Double, level: Int, calibration: GpuCalibration = seeker, dressed: Boolean = realm in LaneCostFixture.REALMS,
                      lifeVs: Map<String, Double> = emptyMap()): FrameCost {
        val knobs = ladder.knobs[level]
        val mapOn = d < Bands.TRUE_FULL; val trueOn = d >= Bands.TRUE_START
        val pass = if (mapOn && trueOn) RealmEngineConfig.PASS_NONE else if (mapOn) RealmEngineConfig.PASS_MAP else RealmEngineConfig.PASS_TRUE
        val b = GroundCost.resolveBudget(row.bufferPx.toDouble(), d < Bands.MAP_START, Resolve.DESPECKLE_PASSES)
        var subs = b.subs; var pages = if (d >= Bands.PAGE_RESOLVE) b.pages else 0
        if (knobs.maxResolves > 0) { subs = minOf(subs, knobs.maxResolves); pages = if (subs > 0) 0 else minOf(pages, knobs.maxResolves) }
        val lanes = GroundCost.passCosts(chart = false, map = mapOn, trueOn = trueOn, subs = subs, pages = pages).toMutableList()
        if (dressed) {
            lanes += LaneCostFixture.lifePasses(realm, row, d, knobs.lifeCap, LaneCostFixture.heavy(level)).map { p ->
                lifeVs[p.name]?.let { PassCost(p.name, p.onGround, p.coverage, p.fetchesPerFragment, p.wideTexels, p.trilinear, p.aluCyclesPerFragment,
                    p.vertices, it, p.vsCyclesPerVertex, p.fixedFetches, p.extraBytes) } ?: p
            }
            lanes += LaneCostFixture.basesPasses(realm, row, d)
        }
        return RealmOverviewCost.evaluate(config, row.dpr, knobs, pass, RealmOverviewCost.Phase.LIVE, row.bufferW, row.bufferH, minimapShare, points,
            emptyList(), calibration, occupancyDots = !dressed, lanes = lanes, laneGround = true)
    }

    /** A frame of the owner's session as its APK (code 27, web pin 4de21f1a) drew it: [Seen.dressed], and LIFE's vertex
     *  walk at that pin ([SESSION_LIFE_VS]). */
    private fun session(s: Seen, d: Double, calibration: GpuCalibration = seeker): FrameCost =
        frame(s.realm, d, s.level, calibration, s.dressed, SESSION_LIFE_VS)

    private fun k(level: Int, pass: Int) = 1.0 / config.groundDiv(row.dpr, minOf(level, 2), pass)

    /** The MAP band from D-173's floor (the dive's landing) to TRUE_START. */
    private val mapDs = doubleArrayOf(48.0, 64.0, 100.0, 150.0, 200.0, 250.0, 280.0, 350.0, 500.0, 650.0, 799.0)
    private val realms = (LaneCostFixture.REALMS + THORNWAKE).distinct()

    @Test fun `the measured row is the buffer the engine logged on the owner's Seeker`() {
        assertEquals(800, row.bufferW); assertEquals(1780, row.bufferH); assertEquals(2.0, row.dpr)
        assertTrue(seeker.calibrated, "session evidence, not an estimate")
        assertTrue(!GpuCalibration.PLACEHOLDER.calibrated)
    }

    /** The fragment rate (fetches/ns, the model's other rates [seeker]'s) at which the session frame of [s] at [d] fills the
     *  60 Hz slot exactly ([session]: as its APK drew it): below it the frame misses the slot, at or above it it fits. */
    private fun breakEven(s: Seen, d: Double): Double {
        var lo = 0.01; var hi = 1000.0
        repeat(60) { val m = Math.sqrt(lo * hi); if (session(s, d, rate(m)).ms > WorldFrameCost.SLOT_MS) lo = m else hi = m }
        return hi
    }

    private fun rate(fetchesPerNs: Double) = GpuCalibration(fetchesPerNs, seeker.fragmentCyclesPerNs, seeker.vertexCyclesPerNs,
        seeker.bytesPerNs, true, seeker.vertexFetchesPerNs)

    /** The session's bracket on the fragment rate, [lo, hi), each frame as the session drew it ([session]): each step
     *  caps it below the break-even of the heaviest frame its band stretch could have shown (LIFE's and BASES' upper
     *  bounds only raise a figure, so those frames cap it too); Thornwake's held stretches (no lane bound at the session's
     *  pin) floor it at their frames' break-even. */
    private val bracket: Pair<Double, Double> by lazy {
        val hi = SESSION_OVER.minOf { o -> o.ds.maxOf { breakEven(o, it) } }
        val lo = SESSION_HELD.filter { it.realm == THORNWAKE && it.proves }.maxOf { h -> h.ds.minOf { breakEven(h, it) } }
        lo to hi
    }

    /**
     * [GpuCalibration.SEEKER]'s fragment rate is the geometric midpoint of the session's [bracket]. Each frame is modelled
     * as the session drew it ([session]): the floor comes from Thornwake's held stretches, drawn with no lane bound (at the
     * session's pin 4de21f1a Thornwake had no LIFE table and no kit dressing; stage B gives it both, which does not change
     * what the device measured), and the ceiling from Crownlands' L2 MAP steps, whose LIFE ran the pin's vertex walk
     * ([SESSION_LIFE_VS]; priced with stage B's cheaper species pick the ceiling fell from 2.295 to 2.251 for shaders the
     * device never ran). A change to the ground's or a lane's pass lists, the core's frame or the session list moves the
     * bracket and fails here until the constant is re-derived.
     */
    @Test fun `the Seeker rate is the midpoint of the bracket the session's steps and held stretches set`() {
        assertTrue(SESSION_HELD.none { it.realm == THORNWAKE && it.dressed }, "the bracket's floor frames were drawn without a lane bound")
        val (lo, hi) = bracket
        assertTrue(lo < hi, "the session's frames contradict the model: held needs ≥ $lo fetches/ns, over needs < $hi")
        assertEquals(Math.sqrt(lo * hi), seeker.fetchesPerNs, 0.01 * seeker.fetchesPerNs, "bracket [$lo, $hi)")
    }

    /**
     * The model agrees with the owner's session wherever it can: every step is modelled over the slot somewhere in its band
     * stretch (the lanes' bounds can only raise a figure, so this holds with them too), and a stretch the device held for
     * a ladder window is modelled inside it where no lane bound was drawn (Thornwake at the session's pin) and in the MAP
     * band (where the lanes are light, bounds included). The held fade and TRUE frames with LIFE's worst paths and BASES'
     * every-deed bound are not asserted (a bound over the slot says nothing about the device), nor are stretches shorter
     * than a ladder window; the report lists them. Each frame is modelled as the session drew it ([session]).
     */
    @Test fun `the calibrated model draws the session's slow frames over the slot and its steady ones inside it`() {
        for (o in SESSION_OVER) {
            val ms = o.ds.maxOf { session(o, it).ms }
            assertTrue(ms > WorldFrameCost.SLOT_MS, "${o.realm} L${o.level} stepped down on the Seeker; its stretch models at most $ms ms")
        }
        var asserted = 0
        for (h in SESSION_HELD) if (h.proves && (!h.dressed || h.ds.all { it < Bands.TRUE_START })) {
            val ms = h.ds.minOf { session(h, it).ms }
            assertTrue(ms <= WorldFrameCost.SLOT_MS, "${h.realm} L${h.level} d ${h.ds.first()} held 60 fps on the Seeker; modelled $ms ms")
            asserted++
        }
        assertTrue(asserted >= 8, "the steady stretches checked: $asserted")
    }

    /**
     * D-173 lands the dive at the MAP band and never rests below it, so the MAP band is where the owner lives. At every
     * rate the session allows, L0 draws it at full resolution (core.js fullResPass: 53 + 6 fetches fit the 64 display
     * budget) over the 60 Hz slot, as every L0 MAP entry of the session did, so the ladder has to leave L0 there. (Whether
     * the ladder or the hang guard answers first is no longer pinned: at the re-derived rate the heaviest LIFE-realm L0 MAP
     * frames model over GPU_SAFE.slowMs, the guard's line, and on Crownlands the guard did answer first.)
     *
     * Where it can rest is NOT settled, and this pins that it is not. An earlier version pinned "L1 (ground at k ½) fits
     * the slot across the band, so the ladder rests there"; that held only above ~3.0 fetches/ns, the top of its own
     * bracket, and the session contradicts it: Frostveil stepped L1 → L2 while pinching through the MAP band (17:17:16.1)
     * and Crownlands stepped under the guard's L2 floor there. Only Thornwake as the session drew it (no lane bound at the
     * pin 4de21f1a) is proven: its held L1 stretches set the bracket's floor. At that floor every realm as it now draws
     * (all eight have LIFE and BASES at stage B, Thornwake too) has L1 MAP frames over the slot, so the session cannot
     * show L1 holding 60 fps across the band where LIFE and BASES draw. The plan conflict (L0 at k ½ on dpr-2 phones, or
     * a lighter L1) is the owner's call (D-NEXT); when device evidence proves an L1 there, this test fails and is re-pinned.
     */
    @Test fun `on the Seeker L0 misses the MAP band's slot and L1 is proven to hold it only where no lane draws`() {
        assertEquals(1.0, k(0, RealmEngineConfig.PASS_MAP)); assertEquals(0.5, k(1, RealmEngineConfig.PASS_MAP))
        val (lo, hi) = bracket
        for (realm in realms) {
            for (d in mapDs) {
                val l0 = frame(realm, d, 0, rate(hi)).ms
                assertTrue(l0 > WorldFrameCost.SLOT_MS && l0 > WorldFrameCost.BUDGET_MS, "$realm d $d: L0 $l0 ms at the bracket's ceiling")
            }
            val l1 = mapDs.map { frame(realm, it, 1, rate(lo)).ms }
            assertTrue(l1.any { it > WorldFrameCost.SLOT_MS }, "$realm: every L1 MAP frame ($l1 ms) fits at the bracket's floor, so the session proves L1 rests there: re-pin")
        }
        val bare = mapDs.map { frame(THORNWAKE, it, 1, rate(lo), dressed = false).ms }
        assertTrue(bare.all { it <= WorldFrameCost.SLOT_MS }, "Thornwake as drawn, L1 $bare ms at the floor its own held stretches set")
    }

    /**
     * The plan's rule (§5.4) on the whole MAP frame: wherever the frame at one level runs over the 10 ms budget, the next
     * level cuts its 60 Hz load by at least a fifth. L0 → L1 halves the ground's scale and LIFE's cap; L1 → L2 has only the
     * ground's ½ → ⅓ (L2 keeps L1's LIFE cap and the planner refills the air share it stops), which is why it is the tight
     * step: at the pin it clears the fifth by a fraction of a point on the views with merged stands (d 100–200); L3 paces 30 fps.
     */
    @Test fun `every ladder step cuts the whole MAP frame by at least a fifth wherever it runs over the budget`() {
        val steps = IntArray(FrameLadder.LEVELS)
        for (realm in realms) for (d in mapDs) for (level in 1 until FrameLadder.LEVELS) {
            val before = frame(realm, d, level - 1); val after = frame(realm, d, level)
            if (before.ms <= WorldFrameCost.BUDGET_MS) continue
            steps[level]++
            assertTrue(after.dutyMs <= 0.8 * before.dutyMs, "$realm d $d L${level - 1}→L$level: ${before.dutyMs} → ${after.dutyMs} ms")
        }
        assertEquals(realms.size * mapDs.size, steps[1], "every L0 MAP frame runs over the budget on the Seeker")
        assertTrue(steps[2] > 0, "no L1 frame ran over the budget: the tight step was never exercised")
    }

    /** The table the handoff reads (build/reports/lane-cost/whole-frame.txt): each band's worst frame per level, and the session. */
    @Test fun `report the whole frame per band and level on the Seeker`() {
        val out = StringBuilder("Whole realm frame on $row at GpuCalibration.SEEKER (fragment ${seeker.fetchesPerNs}/ns, vertex ${seeker.vertexFetchesPerNs}/ns); LIFE worst paths and BASES every-deed bounds\n")
        val bands = listOf("MAP" to mapDs, "MAP→TRUE fade" to doubleArrayOf(800.0, 900.0, 1000.0, 1099.0), "TRUE" to doubleArrayOf(1100.0, 1400.0, 2000.0, 3136.0))
        for ((band, ds) in bands) {
            val worst = DoubleArray(FrameLadder.LEVELS); val at = arrayOfNulls<String>(FrameLadder.LEVELS)
            for (level in 0 until FrameLadder.LEVELS) for (realm in realms) for (d in ds) {
                val f = frame(realm, d, level)
                if (f.dutyMs > worst[level]) { worst[level] = f.dutyMs; at[level] = "$realm d ${d.toInt()}" }
            }
            for (level in 0 until FrameLadder.LEVELS) out.append(String.format("%-14s L%d  %6.2f ms (60 Hz duty)  %s%n", band, level, worst[level], at[level]))
        }
        val (lo, hi) = bracket
        out.append(String.format("Session bracket [%.3f, %.3f) fetches/ns, midpoint %.3f%n", lo, hi, Math.sqrt(lo * hi)))
        out.append("Session frames as drawn (device outcome, d, on screen → modelled ms, break-even fetches/ns):\n")
        for (o in SESSION_OVER) out.append(String.format("  over  %-10s L%d d %4.0f–%-4.0f          max %6.2f  %6.3f%n", o.realm, o.level,
            o.ds.first(), o.ds.last(), o.ds.maxOf { session(o, it).ms }, o.ds.maxOf { breakEven(o, it) }))
        for (h in SESSION_HELD) out.append(String.format("  held  %-10s L%d d %-5.0f %6d ms%s %6.2f  %6.3f%n", h.realm, h.level, h.ds.first(),
            h.onScreenMs, if (h.proves) "  " else " -", session(h, h.ds.first()).ms, breakEven(h, h.ds.first())))
        out.append("  (- : on screen under a ladder window, proves nothing)\n")
        val f = File("build/reports/lane-cost"); f.mkdirs(); File(f, "whole-frame.txt").writeText(out.toString())
        assertTrue(out.isNotEmpty())
    }

    /** A stretch of the owner's session (`.reports/globe-native-n3n4/seeker-1713/world-live.txt`, 2026-09-25), drawn by
     *  the code-27 APK at the web pin 4de21f1a: [realm] on ladder [level] with the camera at [ds] (the logged d, or the
     *  band where the log places a step only by its band), on screen for [onScreenMs] (from its band line to the next
     *  one; 0 for a step). [dressed] = that pin had LIFE tables and kit dressing for the realm. */
    private class Seen(val realm: String, val level: Int, val ds: DoubleArray, val onScreenMs: Int = 0) {
        val dressed = realm in SESSION_DRESSED
        /** A held stretch proves something only if it lasted a ladder window of motion intervals: a shorter one could not
         *  have stepped the ladder even if every frame of it missed the slot. */
        val proves: Boolean get() = onScreenMs >= LadderPolicy.PLAN.window * WorldFrameCost.SLOT_MS
    }

    private companion object {
        const val THORNWAKE = "thornwake"
        /** The realms with LIFE tables and kit dressing at 4de21f1a (REALMS_WITH_MAPS then: stage B added Elderwood,
         *  Thornwake and Solana Reach). The session's Thornwake frames drew GROUND and the core only. */
        val SESSION_DRESSED = setOf("crownlands", "frostveil", "sunscar", "cinderfall", "stormcairn")
        /** LIFE's worst-path vertex fetches as the session's APK ran them (web pin 4de21f1a, before ed01857 walked stage B's
         *  110 / 507 / 16): the 32-trip species scans. Its other LIFE stages (stand 502, particle 26) and every fragment walk
         *  are unchanged at stage B (life-scatter's lens fetch is charged only to Solana Reach, not in the session). */
        val SESSION_LIFE_VS = mapOf("life-scatter" to 184.0, "life-scatter puffs" to 184.0, "life-creature" to 532.0,
            "life-bird shadow" to 41.0, "life-bird" to 41.0)
        fun at(vararg d: Double) = d
        /** The MAP band on a fine geometric grid, MAP_START → TRUE_START − 1. */
        val MAP_BAND = DoubleArray(241) { Bands.MAP_START * Math.pow((Bands.TRUE_START - 1.0) / Bands.MAP_START, it / 240.0) }
        /** Every step of the session (the ladder for slow frames, or a hang-guard trip), each read the same way: the device
         *  drew frames of that realm and level over the slot somewhere in the band stretch the step fell in. The hang
         *  guard: Crownlands L0 at MAP entry, 17:14:48.8 and 17:15:17.0 (0.4 s and 0.13 s after it, d 48–52). The ladder:
         *  Crownlands L2 under the guard's floor in the MAP band, 17:14:50.2/50.7 and 17:15:19.98; Frostveil L0, 17:16:32.1
         *  (2.3 s after MAP entry); Frostveil L1 pinching out through the MAP band, 17:17:16.1 (band 2 from d 738 at
         *  17:17:13.9 to band 1 at 17:17:16.3); Thornwake L0, 17:20:19.9 (0.7 s after MAP entry). */
        val SESSION_OVER = listOf(
            Seen("crownlands", 0, at(48.0, 50.0, 52.0)), Seen("crownlands", 0, at(48.0, 50.0)),
            Seen("crownlands", 2, MAP_BAND), Seen("crownlands", 2, MAP_BAND),
            Seen("frostveil", 0, MAP_BAND), Seen("frostveil", 1, MAP_BAND.filter { it <= 738.0 }.toDoubleArray()),
            Seen(THORNWAKE, 0, MAP_BAND),
        )
        /** Stretches it held without a step, with how long each was on screen: Thornwake at L1 17:20:19.9–17:20:31.8,
         *  Frostveil at L1 17:16:34.9–17:16:43.4 and 17:16:56.3–17:17:13.9, Crownlands at L2 17:15:23.1–17:15:38.5 and Sunscar at L2 17:15:54.6–
         *  17:16:10.7. The fade-band stretches (d 800–1099) lasted 66–297 ms: listed, too short to prove anything. */
        val SESSION_HELD = listOf(
            Seen(THORNWAKE, 1, at(48.0), 1196), Seen(THORNWAKE, 1, at(805.0), 82), Seen(THORNWAKE, 1, at(1142.0), 8077),
            Seen(THORNWAKE, 1, at(1083.0), 66), Seen(THORNWAKE, 1, at(796.0), 2471),
            Seen("frostveil", 1, at(48.0), 8503), Seen("frostveil", 1, at(48.0), 501), Seen("frostveil", 1, at(51.0), 3363),
            Seen("frostveil", 1, at(808.0), 138),
            Seen("frostveil", 1, at(1103.0), 12406), Seen("frostveil", 1, at(1098.0), 297), Seen("frostveil", 1, at(1090.0), 145),
            Seen("crownlands", 2, at(824.0), 145), Seen("crownlands", 2, at(1112.0), 11895), Seen("crownlands", 2, at(1062.0), 93),
            Seen("crownlands", 2, at(782.0), 3247),
            Seen("sunscar", 2, at(49.0), 2612), Seen("sunscar", 2, at(840.0), 95), Seen("sunscar", 2, at(1122.0), 13435),
        )
    }
}
