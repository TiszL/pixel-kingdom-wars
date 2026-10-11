package gg.pixelkingdomwars.nativeclient.ui.world

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

/**
 * The globe HUD mix (D-166) with the F1 header set on every Seeker row: controls are ≥ 44 dp targets on screen that
 * never overlap, the realm panel is a right-side panel in landscape and a peeking bottom sheet in portrait, and place
 * labels (the web's placeLabel, golden-tested) never land on a control.
 */
class GlobeHudPlanTest {
    private val realms = listOf("Frostveil", "Elderwood", "Sunscar", "Crownlands", "Solana Reach", "Stormcairn", "Thornwake", "Cinderfall")
    private data class Row(val name: String, val w: Float, val h: Float, val safe: HudInsets, val type: HudType)
    private val rows = SeekerRows.DENSITIES.flatMap { d ->
        val (pw, ph) = SeekerRows.portrait(d); val (lw, lh) = SeekerRows.landscape(d)
        listOf(Row("portrait@$d", pw, ph, SeekerRows.PORTRAIT_INSETS, HudType.of(d, false, ph)), Row("landscape@$d", lw, lh, SeekerRows.LANDSCAPE_INSETS, HudType.of(d, true, lh)))
    }
    private val hint = "Drag to spin · pinch to zoom · tap a realm"
    private fun states(r: Row) = listOf(
        GlobeHudPlan.Input(r.w, r.h, r.safe, r.type, destinations = realms, mapped = realms.indices.toSet(), hint = hint),
        GlobeHudPlan.Input(r.w, r.h, r.safe, r.type, campaign = true, destinations = realms, hint = hint),
        GlobeHudPlan.Input(r.w, r.h, r.safe, r.type, campaign = true, destinations = realms, panelOpen = true),
        GlobeHudPlan.Input(r.w, r.h, r.safe, r.type, destinations = realms, panelOpen = true, sheetPeek = true, peekH = 170f),
        GlobeHudPlan.Input(r.w, r.h, r.safe, r.type, destinations = realms, searchOpen = true, resultRows = 8),
        GlobeHudPlan.Input(r.w, r.h, r.safe, r.type, back = false, destinations = realms, diving = true),
    )

    @Test fun `place labels match the web placeLabel on every golden case`() {
        val labels = HudReference.json.getValue("vectors").jsonObject.getValue("labels").jsonArray
        assertTrue(labels.count { it.jsonObject["out"] is JsonNull } > 0)
        for ((i, e) in labels.withIndex()) {
            val c = e.jsonObject; val s = c.getValue("s").jsonArray.map { it.jsonPrimitive.double }
            val rects = c.getValue("rects").jsonArray.map { r -> r.jsonArray.map { it.jsonPrimitive.double }.toDoubleArray() }
            val got = GlobeHudPlan.placeLabel(s[0], s[1], c.getValue("w").jsonPrimitive.double, c.getValue("h").jsonPrimitive.double, rects,
                c.getValue("W").jsonPrimitive.double, c.getValue("H").jsonPrimitive.double)
            val want = c["out"]?.takeIf { it !is JsonNull }?.jsonArray?.map { it.jsonPrimitive.double }
            if (want == null) assertNull("case $i", got) else { assertNotNull("case $i", got); assertEquals("case $i x", want[0], got!![0], 1e-9); assertEquals("case $i y", want[1], got[1], 1e-9) }
        }
    }

    @Test fun `every globe control is an on-screen 44 dp target and none overlap`() {
        for (r in rows) for ((k, s) in states(r).withIndex()) {
            val plan = GlobeHudPlan.plan(s); val screen = HudRect(0f, 0f, r.w, r.h)
            for (c in plan.controls) {
                assertTrue("${r.name}/$k ${c.id} ${c.rect} off screen", screen.contains(c.rect))
                if (c.id !in setOf("title", "hint", "panel", "results") && !c.id.startsWith("dest:"))
                    assertTrue("${r.name}/$k ${c.id} ${c.rect} is below 44 dp", c.rect.w >= 44f && c.rect.h >= 44f)
                if (c.id.startsWith("dest:")) assertEquals(44f, c.rect.h)
            }
            val solid = plan.controls.filterNot { it.overlay }
            for (i in solid.indices) for (j in i + 1 until solid.size)
                assertFalse("${r.name}/$k ${solid[i].id} overlaps ${solid[j].id}", solid[i].rect.intersects(solid[j].rect))
        }
    }

    @Test fun `the realm panel is a side panel in landscape and a peeking sheet in portrait, and tools hide under it`() {
        for (r in rows) {
            val open = GlobeHudPlan.plan(states(r)[2])
            val panel = requireNotNull(open.panel)
            if (open.landscape) {
                assertTrue("${r.name}: right side, ≤ 360 dp and ≤ 44 %", panel.w <= 360f && panel.w <= 0.44f * r.w + 0.01f && panel.right <= r.w - r.safe.right)
                assertTrue(panel.y >= open.headerBottom)
            } else {
                assertEquals("${r.name}: a 46 % sheet", 0.46f * r.h, panel.h, 0.01f); assertEquals(r.h, panel.bottom, 0.01f)
                val peek = GlobeHudPlan.plan(states(r)[3])
                assertEquals("${r.name}: peek shows only the grab header and the CTA", 170f, peek.panel!!.h, 0.01f)
            }
            assertTrue("${r.name}: the panel owns the screen side", open.controls.none { it.id.startsWith("tool:") || it.id == "hint" })
        }
        assertEquals(GlobeHudPlan.Companion.SheetAction.TOGGLE_PEEK, GlobeHudPlan.sheetDrag(3f, 120, peeked = false))
        assertEquals(GlobeHudPlan.Companion.SheetAction.PEEK, GlobeHudPlan.sheetDrag(90f, 400, peeked = false))
        assertEquals(GlobeHudPlan.Companion.SheetAction.CLOSE, GlobeHudPlan.sheetDrag(90f, 400, peeked = true))
        assertEquals(GlobeHudPlan.Companion.SheetAction.EXPAND, GlobeHudPlan.sheetDrag(-40f, 400, peeked = true))
        assertEquals(GlobeHudPlan.Companion.SheetAction.NONE, GlobeHudPlan.sheetDrag(40f, 400, peeked = false))
        assertEquals("dragging up follows at 0.3×", -30f, GlobeHudPlan.sheetFollow(-100f), 0.001f)
    }

    @Test fun `portrait docks the tools thumb-side with zoom rightmost, landscape centres a right column`() {
        val (pw, ph) = SeekerRows.portrait(3f)
        val p = GlobeHudPlan.plan(GlobeHudPlan.Input(pw, ph, SeekerRows.PORTRAIT_INSETS, HudType.of(3f, false, ph), destinations = realms))
        val order = p.controls.filter { it.id.startsWith("tool:") }.sortedBy { it.rect.x }.map { it.id }
        assertEquals(listOf("tool:MY PARCEL", "tool:NIGHT", "tool:out", "tool:in"), order)
        assertTrue(p.controls.filter { it.id.startsWith("tool:") }.all { it.rect.bottom <= ph - SeekerRows.PORTRAIT_INSETS.bottom - 12f + 0.01f })
        val (lw, lh) = SeekerRows.landscape(3f)
        val l = GlobeHudPlan.plan(GlobeHudPlan.Input(lw, lh, SeekerRows.LANDSCAPE_INSETS, HudType.of(3f, true, lh), destinations = realms))
        assertTrue(l.shortLandscape)
        val col = l.controls.filter { it.id.startsWith("tool:") }
        assertEquals(listOf("tool:in", "tool:out", "tool:MY PARCEL", "tool:NIGHT"), col.sortedBy { it.rect.y }.map { it.id })
        assertTrue(col.all { it.rect.y >= l.headerBottom })
        assertEquals("the F1 modes are a left column in short landscape", 1, l.controls.filter { it.id.startsWith("mode:") }.map { it.rect.x }.distinct().size)
    }

    @Test fun `no globe tool is WORLD because on the world scene it does nothing`() {
        // Owner, 2026-09-26: "we don't need the WORLD button on the map scene: we are already on the world scene so the
        // button does nothing" (it flew to the whole-world frame). Pinch-out and the rail already reach every realm.
        assertFalse(GlobeHudPlan.TOOLS.any { it.equals("WORLD", ignoreCase = true) })
        for (r in rows) for ((k, s) in states(r).withIndex()) {
            val tools = GlobeHudPlan.plan(s).controls.map { it.id }.filter { it.startsWith("tool:") }
            assertTrue("${r.name}/$k $tools", tools.none { it.contains("WORLD", ignoreCase = true) })
            if (tools.isNotEmpty()) assertEquals("${r.name}/$k", setOf("tool:MY PARCEL", "tool:NIGHT", "tool:out", "tool:in"), tools.toSet())
        }
        // The landscape column is sized for the tools it holds: centred between the header and the bottom, not for a
        // missing fifth control.
        val (lw, lh) = SeekerRows.landscape(3f)
        val l = GlobeHudPlan.plan(GlobeHudPlan.Input(lw, lh, SeekerRows.LANDSCAPE_INSETS, HudType.of(3f, true, lh), destinations = realms))
        val col = l.controls.filter { it.id.startsWith("tool:") }
        val top = col.minOf { it.rect.y }; val bottom = col.maxOf { it.rect.bottom }
        assertEquals("centred on the space under the header", (lh + l.headerBottom) / 2f, (top + bottom) / 2f, 0.5f)
    }

    @Test fun `zero place-label intersections with any control on every Seeker row`() {
        val rnd = Random(7)
        var placed = 0
        for (r in rows) for ((k, s) in states(r).withIndex()) {
            val plan = GlobeHudPlan.plan(s)
            val controls = plan.controls.map { it.rect } + plan.railRow
            repeat(60) {
                val count = 8; val ids = IntArray(count) { it }
                val xy = FloatArray(count * 2) { i -> if (i % 2 == 0) rnd.nextFloat() * r.w * 3f else rnd.nextFloat() * r.h * 3f } // view px at density 3
                val labels = WorldLabels.globe(ids, xy, count, 3f, realms, r.type, plan.labelRects(r.w, r.h), r.w, r.h, hideIndex = null)
                for (l in labels) {
                    val rect = HudRect(l.x, l.y, l.w, l.h)
                    for (c in controls) assertFalse("${r.name}/$k ${realms[l.id]} at $rect covers $c", rect.intersects(c))
                    placed++
                }
                for (i in labels.indices) for (j in i + 1 until labels.size)
                    assertFalse(HudRect(labels[i].x, labels[i].y, labels[i].w, labels[i].h).intersects(HudRect(labels[j].x, labels[j].y, labels[j].w, labels[j].h)))
            }
        }
        assertTrue("labels were placed: $placed", placed > 1000)
    }
}
