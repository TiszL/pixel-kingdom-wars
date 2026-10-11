package gg.pixelkingdomwars.nativeclient.ui.world

import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

/**
 * GLOBE-NATIVE-PLAN §3.6 / §9 N2 gate: "0 tag/control intersections on every Seeker row, portrait and landscape". The
 * web prototype had 8 at 390×844. Every Seeker density (2.625, 2.75, 3.0) × orientation × HUD state (card, level panel,
 * search, minimap folded/pinned, whole realm) is laid out by the same planner Compose places controls with, then the
 * FAR counters and the name tags are placed over thousands of synthetic kingdoms: none may touch a control, controls
 * must not overlap each other, and every control is a ≥ 44 dp target inside the screen.
 */
class RealmHudPlanTest {
    private data class Row(val name: String, val w: Float, val h: Float, val safe: HudInsets, val type: HudType)
    private val rows = SeekerRows.DENSITIES.flatMap { d ->
        val (pw, ph) = SeekerRows.portrait(d); val (lw, lh) = SeekerRows.landscape(d)
        listOf(Row("portrait@$d", pw, ph, SeekerRows.PORTRAIT_INSETS, HudType.of(d, false, ph)),
            Row("landscape@$d", lw, lh, SeekerRows.LANDSCAPE_INSETS, HudType.of(d, true, lh)))
    }
    private val states = listOf(
        RealmHudPlan.Input(0f, 0f, HudInsets(), HudType.of(3f, false, 800f)),
        RealmHudPlan.Input(0f, 0f, HudInsets(), HudType.of(3f, false, 800f), cardH = 10_000f),
        RealmHudPlan.Input(0f, 0f, HudInsets(), HudType.of(3f, false, 800f), cardH = 180f, miniPin = true),
        RealmHudPlan.Input(0f, 0f, HudInsets(), HudType.of(3f, false, 800f), levelOpen = true, levelLong = "Level 12–20", levelShort = "Lv 12–20"),
        RealmHudPlan.Input(0f, 0f, HudInsets(), HudType.of(3f, false, 800f), searchOpen = true, resultRows = 8),
        RealmHudPlan.Input(0f, 0f, HudInsets(), HudType.of(3f, false, 800f), searchOpen = true, resultRows = -1),
        RealmHudPlan.Input(0f, 0f, HudInsets(), HudType.of(3f, false, 800f), miniOpen = false),
        RealmHudPlan.Input(0f, 0f, HudInsets(), HudType.of(3f, false, 800f), wholeRealm = true, cardH = 300f),
        RealmHudPlan.Input(0f, 0f, HudInsets(), HudType.of(3f, false, 800f), chips = HudChips.ALL, scaleBarW = 100, scaleLabel = "1,000 deeds"),
        // N4: the WARZONE chip (F16) and its panel, choose mode's "Next open deed ▶" with and without a card, and the band
        // readiness cue in the scale pill (the longest label it can carry).
        RealmHudPlan.Input(0f, 0f, HudInsets(), HudType.of(3f, false, 800f), warzone = true),
        RealmHudPlan.Input(0f, 0f, HudInsets(), HudType.of(3f, false, 800f), warzone = true, warzoneOpen = true, cardH = 260f),
        RealmHudPlan.Input(0f, 0f, HudInsets(), HudType.of(3f, false, 800f), warzone = true, searchOpen = true, resultRows = 8),
        RealmHudPlan.Input(0f, 0f, HudInsets(), HudType.of(3f, false, 800f), choose = true),
        RealmHudPlan.Input(0f, 0f, HudInsets(), HudType.of(3f, false, 800f), choose = true, miniOpen = false, scaleBarW = 100, scaleLabel = "1,000 deeds · detail 99%"),
        RealmHudPlan.Input(0f, 0f, HudInsets(), HudType.of(3f, false, 800f), choose = true, cardH = 10_000f, warzone = true),
    )
    private fun plans(): List<Triple<String, Row, RealmHudPlan>> = rows.flatMap { r -> states.mapIndexed { i, s ->
        Triple("${r.name} state $i", r, RealmHudPlan.plan(s.copy(width = r.w, height = r.h, safe = r.safe, type = r.type, realmCols = 181, realmRows = 132,
            title = "Crownlands", subtitle = "12,958 deeds · 1,204 kingdoms · 1,204 shown")))
    } }

    @Test fun `every control is a 44 dp target inside the screen, and only the popovers overlap`() {
        for ((name, row, plan) in plans()) {
            val screen = HudRect(0f, 0f, row.w, row.h)
            for (c in plan.controls) {
                assertTrue("$name ${c.id} off screen: ${c.rect}", screen.contains(c.rect))
                if (c.id !in setOf("title", "scale", "card", "results", "level", "minimap", "warzonePanel") && !c.id.startsWith("chip:"))
                    assertTrue("$name ${c.id} is below 44 dp: ${c.rect}", c.rect.w >= 44f && c.rect.h >= 44f)
            }
            val solid = plan.controls.filterNot { it.overlay }
            for (i in solid.indices) for (j in i + 1 until solid.size)
                assertFalse("$name: ${solid[i].id} overlaps ${solid[j].id}", solid[i].rect.intersects(solid[j].rect))
        }
    }

    @Test fun `controls respect the safe area and the card never covers the tools`() {
        for (r in rows) for (s in states) {
            val plan = RealmHudPlan.plan(s.copy(width = r.w, height = r.h, safe = r.safe, type = r.type, realmCols = 181, realmRows = 132))
            for (c in plan.controls) {
                if (c.id == "card" && plan.portrait) { assertEquals("${r.name}: the sheet is flush with the bottom", r.h, c.rect.bottom, 0.01f); continue }
                assertTrue("${r.name} ${c.id} ${c.rect} leaves the safe area", c.rect.x >= r.safe.left - 0.01f && c.rect.y >= r.safe.top - 0.01f &&
                    c.rect.right <= r.w - r.safe.right + 0.01f && c.rect.bottom <= r.h - r.safe.bottom + 0.01f)
            }
            plan.rect("card")?.let { card -> for (id in listOf("zoomIn", "zoomOut", "myBase", "nav", "nextOpen", "scale", "warzone")) plan.rect(id)?.let { assertFalse("${r.name} card covers $id", card.intersects(it)) } }
        }
    }

    @Test fun `zero tag and counter intersections with any control on every Seeker row`() {
        val rnd = Random(20260925)
        val cols = 181; val rowsN = 132
        // A dense realm: ~3,300 kingdoms in clusters (the web ui.test realm shape), a few of them yours.
        val hubs = List(20) { rnd.nextDouble() * cols to rnd.nextDouble() * rowsN }
        val used = HashSet<Int>(); val bases = ArrayList<RealmHudBase>()
        while (bases.size < 3300) {
            val (hx, hy) = hubs[rnd.nextInt(hubs.size)]; val sp = 1 + rnd.nextDouble() * 9
            val x = (hx + (rnd.nextDouble() + rnd.nextDouble() - 1) * sp).toInt(); val y = (hy + (rnd.nextDouble() + rnd.nextDouble() - 1) * sp).toInt()
            if (x < 0 || y < 0 || x >= cols || y >= rowsN || !used.add(y * cols + x)) continue
            bases += RealmHudBase(bases.size, x, y, "Keeper${bases.size}", 1 + rnd.nextInt(20), mine = bases.size % 500 == 0)
        }
        var checked = 0; var hidden = 0
        for ((name, row, plan) in plans()) {
            val controls = plan.controls.map { it.rect }
            for (s in listOf(2.0, 4.0, 8.0, 16.0, 23.9, 30.0, 60.0, 120.0, 400.0)) for (k in 0 until 3) {
                val view = WorldLabels.RealmView(cols * (0.3 + 0.2 * k), rowsN * (0.35 + 0.15 * k), s, s * 2, row.w.toDouble(), row.h.toDouble())
                val sel = bases[(k * 977) % bases.size]
                val res = WorldLabels.realm(bases, sel.takeIf { k == 1 }, cardOpen = plan.rect("card") != null, view, 720, plan.chrome(), plan.safeBox.ltrb(), HudType.of(3f, false, 800f))
                for ((i, label) in res.labels.withIndex()) {
                    val (w, h) = when (label) {
                        is WorldLabels.CounterLabel -> RealmHudModel.counterW(label.n).toFloat() to 28f + 7f // + the pin tail
                        is WorldLabels.TagLabel -> RealmHudModel.tagW(label.name, label.level, label.big, 16.0, 18.0).toFloat() + 6f to if (label.big) 36f else 24f // as drawn (D-NEXT compact tags)
                    }
                    val r = HudRect(res.xs[i] - (if (label is WorldLabels.TagLabel) 3f else 0f), res.ys[i], w, h)
                    for (c in controls) assertFalse("$name s=$s: $label at $r covers a control at $c", r.intersects(c))
                    checked++
                }
                if (s < HudBands.UI_DOTS_S) {
                    assertEquals("$name s=$s: counters account for every base on screen", res.onScreen, res.counters.sumOf { it.n } + res.hidden)
                    // Kingdoms may hide only under a portrait sheet, or under the warzone status the player opened on purpose
                    // (N4, F16: beside a landscape card it leaves no free map to push counters into); hidden bases stay counted
                    // above. Every other layout, the level panel included, must hide none.
                    val popover = plan.rect("warzonePanel") != null
                    if ((plan.rect("card") == null || !plan.portrait) && !popover) assertEquals("$name s=$s: only a portrait sheet can hide kingdoms", 0, res.hidden)
                    hidden += res.hidden
                }
            }
        }
        assertTrue("the gate placed labels (not a vacuous pass): $checked", checked > 2000)
    }

    @Test fun `portrait folds the minimap under an open card, and its toggle pins it back`() {
        val (w, h) = SeekerRows.portrait(2.75f)
        val base = RealmHudPlan.Input(w, h, SeekerRows.PORTRAIT_INSETS, HudType.of(2.75f, false, h), realmCols = 181, realmRows = 132)
        assertNotNull(RealmHudPlan.plan(base).rect("minimap"))
        assertNull(RealmHudPlan.plan(base.copy(cardH = 200f)).rect("minimap"))
        assertNotNull(RealmHudPlan.plan(base.copy(cardH = 200f, miniPin = true)).rect("minimap"))
        assertNull("the whole realm on screen: no minimap and no toggle", RealmHudPlan.plan(base.copy(wholeRealm = true)).rect("minimapToggle"))
        // The frame takes the realm's aspect inside 132×132 (a square frame letterboxed Frostveil).
        val m = requireNotNull(RealmHudPlan.plan(base).rect("minimap"))
        assertEquals(132f, m.w); assertEquals(96f, m.h)
        assertEquals("the sheet stops at 42 % of the height", 0.42f * h, RealmHudPlan.plan(base.copy(cardH = 10_000f)).rect("card")!!.h, 0.01f)
    }

    @Test fun `the WARZONE chip rides the top bar only while a warzone is active, and its panel drops like the level panel`() {
        // F16: the realm map keeps the warzone one tap away while one runs (GLOBE-NATIVE-PLAN §3.6), and never otherwise:
        // an idle chip would take the title's room for nothing.
        for (r in rows) {
            val base = RealmHudPlan.Input(r.w, r.h, r.safe, r.type, realmCols = 181, realmRows = 132, title = "Crownlands", subtitle = "12,958 deeds · 1,204 kingdoms")
            assertNull(r.name, RealmHudPlan.plan(base).rect("warzone"))
            val on = RealmHudPlan.plan(base.copy(warzone = true))
            val chip = requireNotNull(on.rect("warzone")) { r.name }
            val title = on.rect("title")!!; val search = on.rect("search")!!
            assertTrue("${r.name}: chip between the title and search", chip.x >= title.right && chip.right <= search.x)
            assertEquals("${r.name}: the chip shares the top row", title.y + title.h / 2f, chip.y + chip.h / 2f, 0.5f)
            assertNull("${r.name}: the panel only on demand", on.rect("warzonePanel"))
            val open = RealmHudPlan.plan(base.copy(warzone = true, warzoneOpen = true))
            assertEquals(open.rect("warzonePanel")!!.y, RealmHudPlan.plan(base.copy(levelOpen = true)).rect("level")!!.y)
            assertNull("${r.name}: no warzone, no panel even if it was open", RealmHudPlan.plan(base.copy(warzoneOpen = true)).rect("warzonePanel"))
        }
    }

    @Test fun `choose mode puts Next open deed in the nav slot until a card opens, then the card carries it`() {
        // GLOBE-PRODUCTION-PLAN §1.3 step 3: the button must be on screen in choose mode, and must never fight the card.
        for (r in rows) {
            val base = RealmHudPlan.Input(r.w, r.h, r.safe, r.type, realmCols = 181, realmRows = 132, choose = true)
            val free = RealmHudPlan.plan(base)
            assertNull(r.name, free.rect("nav")); val next = requireNotNull(free.rect("nextOpen")) { r.name }
            assertTrue("${r.name}: a 48 dp target wide enough for its label: $next", next.h >= 48f && next.w >= RealmHudPlan.nextOpenW(r.type))
            val carded = RealmHudPlan.plan(base.copy(cardH = 240f))
            assertNull("${r.name}: with a card up the card's action bar has it", carded.rect("nextOpen")); assertNotNull(carded.rect("nav"))
            assertNull("${r.name}: outside choose mode the slot is ◀ ▶", RealmHudPlan.plan(base.copy(choose = false)).rect("nextOpen"))
        }
    }

    @Test fun `landscape puts the card beside the tool column and the nav in the free map area`() {
        val (w, h) = SeekerRows.landscape(2.625f)
        val plan = RealmHudPlan.plan(RealmHudPlan.Input(w, h, SeekerRows.LANDSCAPE_INSETS, HudType.of(2.625f, true, h), realmCols = 181, realmRows = 132, cardH = 280f))
        assertFalse(plan.portrait)
        val card = plan.rect("card")!!; val tools = plan.rect("myBase")!!; val nav = plan.rect("nav")!!
        assertEquals(330f, card.w)
        assertTrue(card.right <= tools.x - 10f)
        assertTrue(nav.right <= card.x)
        assertEquals("focus offset centres the plot in the free area", ((330f + plan.cardR) / 2f).toInt().toFloat(), plan.focusOffset(true).first, 1f)
    }
}
