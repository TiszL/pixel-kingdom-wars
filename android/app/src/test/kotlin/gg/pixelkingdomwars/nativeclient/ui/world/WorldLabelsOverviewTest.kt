package gg.pixelkingdomwars.nativeclient.ui.world

import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

/**
 * D-177 (amends D-173), "overview first": Enter map lands at the globe's own scale and the player zooms in themselves.
 * The owner, 2026-09-26, after code 29.1 on the Seeker: the first landing need not show names when not zoomed in; on the
 * web "when you go deeper and deeper then come details". So below `uiDots` the landing is the web's photo-1 look
 * (ui.js `counters`): small dark counters, one per cluster, carrying only the KINGDOM COUNT (a lone kingdom is a 1, a
 * cluster holding yours is the gold one); no names, no levels, and no empty-realm line (the web has none). Every
 * on-screen kingdom is counted exactly once and nothing lands on a control. Names come past `uiDots` (tag mode).
 *
 * Rewritten from da1b7ee's "the overview names its kingdoms" tests (native names beside the counters and an empty-realm
 * line): the owner withdrew that divergence. The five tests keep their subjects under the new rule; none was deleted.
 */
class WorldLabelsOverviewTest {
    private val cols = 178; private val rowsN = 120; private val x0 = 300; private val y0 = 100 // a Crownlands-sized realm
    private val lone = RealmHudBase(1, x0 + cols / 2, y0 + rowsN / 2, "Lonely Keep", 7, mine = false)

    private fun portrait(d: Float = 3f, cardH: Float = 0f): Triple<Float, Float, RealmHudPlan> {
        val (w, h) = SeekerRows.portrait(d)
        return Triple(w, h, RealmHudPlan.plan(RealmHudPlan.Input(w, h, SeekerRows.PORTRAIT_INSETS, HudType.of(d, false, h), realmCols = cols, realmRows = rowsN,
            title = "Crownlands", subtitle = "12,958 deeds · 1,204 kingdoms", cardH = cardH)))
    }
    /** `RealmCamera.sMin`: the whole-realm fit, in dp per deed. */
    private fun fit(w: Float, h: Float) = minOf(w.toDouble() / cols, h.toDouble() / rowsN) * 0.97

    /** The lone base at the screen centre; your cluster ~100 dp up-left of it, a rival cluster ~100 dp down-left. */
    private fun realm(s: Double): List<RealmHudBase> {
        val off = Math.round(100 / s).toInt()
        val yours = (0 until 6).map { i -> RealmHudBase(100 + i, lone.x - off + i % 2, lone.y - off + i / 2, "Keep$i", 3 + i, mine = i == 4) }
        val rival = (0 until 4).map { i -> RealmHudBase(200 + i, lone.x - off + i % 2, lone.y + off + i / 2, if (i == 2) "Ironhold" else "Hut$i", if (i == 2) 18 else 2 + i, mine = false) }
        return listOf(lone) + yours + rival
    }
    private fun hit(a: DoubleArray, b: DoubleArray) = a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

    /** The rules every landing frame keeps: counts only, every on-screen kingdom counted once, nothing on a control. */
    private fun assertLanding(what: String, res: WorldLabels.RealmLabels, plan: RealmHudPlan) {
        assertTrue("$what: counts only below uiDots, no names: ${res.labels.filterNot { it is WorldLabels.CounterLabel }}",
            res.labels.all { it is WorldLabels.CounterLabel })
        val counters = res.labels.filterIsInstance<WorldLabels.CounterLabel>()
        assertEquals("$what: the drawn counts sum to the kingdoms on screen", res.onScreen - res.hidden, counters.sumOf { it.n })
        assertEquals("$what: the counters account for every kingdom on screen", res.onScreen, res.counters.sumOf { it.n } + res.hidden)
        assertTrue("$what: at most ${RealmHudModel.MAX_COUNTERS} counters (${counters.size})", counters.size <= RealmHudModel.MAX_COUNTERS)
        val chrome = plan.chrome()
        for (i in res.labels.indices) {
            val l = counters[i]; val x = res.xs[i].toDouble(); val y = res.ys[i].toDouble()
            val r = doubleArrayOf(x, y, x + RealmHudModel.counterW(l.n), y + RealmHudModel.COUNTER_H + 7) // + the pin tail
            for (c in chrome) assertFalse("$what: $l at ${r.toList()} touches a control at ${c.toList()}", hit(r, c))
        }
    }

    @Test fun `the landing shows kingdom counts not names - a lone kingdom is a 1 and your cluster is the gold count`() {
        val (w, h, plan) = portrait()
        val t = HudType.of(3f, false, h)
        // the whole-realm fit (~2.2 dp per deed on the Seeker) and the continuity landing (d ≈ 22 at dpr 2: s ≈ 11)
        for (s in listOf(fit(w, h), 11.0)) {
            val bases = realm(s)
            val view = WorldLabels.RealmView(lone.x + 0.5, lone.y + 0.5, s, s * 3, w.toDouble(), h.toDouble())
            val res = WorldLabels.realm(bases, null, false, view, 720, plan.chrome(), plan.safeBox.ltrb(), t)
            val what = "s=$s"
            assertEquals("$what: every base is on screen", bases.size, res.onScreen)
            assertEquals("$what: none hidden", 0, res.hidden)
            assertLanding(what, res, plan)
            val counts = res.labels.filterIsInstance<WorldLabels.CounterLabel>().map { it.n to it.mine }.sortedBy { it.first }
            assertEquals("$what: the lone kingdom is a plain 1, the rival cluster a 4, yours the gold 6: $counts",
                listOf(1 to false, 4 to false, 6 to true), counts)
        }
    }

    @Test fun `a selected kingdom with its card open is still just counted on the landing`() {
        val (w, h, plan) = portrait(cardH = 260f)
        val t = HudType.of(3f, false, h)
        val s = 11.0
        val view = WorldLabels.RealmView(lone.x + 0.5, lone.y + 0.5, s, s * 3, w.toDouble(), h.toDouble())
        val res = WorldLabels.realm(realm(s), lone, true, view, 720, plan.chrome(), plan.safeBox.ltrb(), t)
        assertLanding("card open", res, plan)
        assertTrue("the selected lone kingdom keeps its 1 (the card names it, the map does not)",
            res.labels.any { it is WorldLabels.CounterLabel && it.n == 1 && !it.mine })
    }

    @Test fun `a dense realm keeps every count, draws no name, and never covers a control on any Seeker row`() {
        val rnd = Random(20260926)
        val hubs = List(24) { rnd.nextDouble() * cols to rnd.nextDouble() * rowsN }
        val used = HashSet<Int>(); val bases = ArrayList<RealmHudBase>()
        while (bases.size < 2500) {
            val (hx, hy) = hubs[rnd.nextInt(hubs.size)]; val sp = 1 + rnd.nextDouble() * 12
            val x = (hx + (rnd.nextDouble() + rnd.nextDouble() - 1) * sp).toInt(); val y = (hy + (rnd.nextDouble() + rnd.nextDouble() - 1) * sp).toInt()
            if (x < 0 || y < 0 || x >= cols || y >= rowsN || !used.add(y * cols + x)) continue
            bases += RealmHudBase(bases.size, x0 + x, y0 + y, "Keeper${bases.size}", 1 + rnd.nextInt(20), mine = bases.size % 400 == 0)
        }
        // plus a scatter of lone kingdoms, which the landing shows as 1s
        repeat(40) { val x = rnd.nextInt(cols); val y = rnd.nextInt(rowsN); if (used.add(y * cols + x)) bases += RealmHudBase(bases.size, x0 + x, y0 + y, "Lone${bases.size}", 1 + rnd.nextInt(20), false) }
        var counted = 0
        for (d in SeekerRows.DENSITIES) for (landscape in listOf(false, true)) {
            val (w, h) = if (landscape) SeekerRows.landscape(d) else SeekerRows.portrait(d)
            val t = HudType.of(d, landscape, h)
            val plan = RealmHudPlan.plan(RealmHudPlan.Input(w, h, if (landscape) SeekerRows.LANDSCAPE_INSETS else SeekerRows.PORTRAIT_INSETS, t,
                realmCols = cols, realmRows = rowsN, title = "Crownlands", subtitle = "12,958 deeds · 1,204 kingdoms"))
            for (s in listOf(fit(w, h), 4.0, 11.0, 23.9)) for (k in 0 until 3) {
                val view = WorldLabels.RealmView(x0 + cols * (0.3 + 0.2 * k), y0 + rowsN * (0.35 + 0.15 * k), s, s * d, w.toDouble(), h.toDouble())
                val res = WorldLabels.realm(bases, null, false, view, 720, plan.chrome(), plan.safeBox.ltrb(), t)
                assertLanding("${if (landscape) "landscape" else "portrait"}@$d s=$s k=$k", res, plan)
                counted += res.labels.size
            }
        }
        assertTrue("counters were placed (not a vacuous pass): $counted", counted > 100)
    }

    @Test fun `names come only as the player zooms in past uiDots`() {
        // The web's two modes meet at uiDots (24 dp per deed): just below it the same kingdoms are counts, from it on they
        // are name tags (at most sixteen), so the details arrive "deeper and deeper", never on the landing.
        val (w, h, plan) = portrait()
        val t = HudType.of(3f, false, h)
        val bases = (0 until 30).map { RealmHudBase(it, lone.x - 6 + it % 6 * 2, lone.y - 5 + it / 6 * 2, "Keep$it", 1 + it % 20, mine = it == 7) }
        fun at(s: Double) = WorldLabels.realm(bases, null, false, WorldLabels.RealmView(lone.x + 0.5, lone.y + 0.5, s, s * 3, w.toDouble(), h.toDouble()),
            720, plan.chrome(), plan.safeBox.ltrb(), t)
        val below = at(HudBands.UI_DOTS_S - 0.01)
        assertLanding("just below uiDots", below, plan)
        val tags = at(HudBands.UI_DOTS_S).labels
        assertTrue("from uiDots on the kingdoms are named: $tags", tags.isNotEmpty() && tags.all { it is WorldLabels.TagLabel })
        assertTrue("at most ${RealmHudModel.MAX_TAGS} names", tags.size <= RealmHudModel.MAX_TAGS)
        assertTrue("your kingdom is among the names first", tags.any { it is WorldLabels.TagLabel && it.base.mine })
    }

    @Test fun `an empty realm draws nothing over the map, as the web`() {
        // The web's landing has no empty-realm line; da1b7ee's "No kingdoms here yet" is withdrawn with the names.
        val (w, h, plan) = portrait()
        val t = HudType.of(3f, false, h)
        for (s in listOf(fit(w, h), 11.0, 30.0)) {
            val res = WorldLabels.realm(emptyList(), null, false, WorldLabels.RealmView(lone.x + 0.5, lone.y + 0.5, s, s * 3, w.toDouble(), h.toDouble()),
                720, plan.chrome(), plan.safeBox.ltrb(), t)
            assertTrue("s=$s: no label at all: ${res.labels}", res.labels.isEmpty())
            assertEquals(0, res.onScreen); assertEquals(0, res.hidden)
        }
    }
}
