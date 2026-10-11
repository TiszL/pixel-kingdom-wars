package gg.pixelkingdomwars.nativeclient.ui.boot

import gg.pixelkingdomwars.nativeclient.ui.world.HudInsets
import gg.pixelkingdomwars.nativeclient.ui.world.HudRect
import gg.pixelkingdomwars.nativeclient.ui.world.HudType
import gg.pixelkingdomwars.nativeclient.ui.world.SeekerRows
import org.junit.Assert.*
import org.junit.Test

/**
 * SHARDKEEP D-193 (owner 2026-09-28, relaying a teammate): "minimize the opening kingdom bar and place it on the bottom
 * of the screen, this way players can enjoy the view of the graphics while the game loads". The strip is one slim plate
 * at the bottom, above the safe area, never a centred card; the version label is the screen's bottom-left corner
 * outside it; the box is the same for every state so nothing moves once it is on screen (the 2026-09-27 flicker rule);
 * and the title and line 2 keep their width beside the widest buttons a state can draw (review 2026-09-28: on a
 * portrait phone two buttons left a reason eight glyphs a line). The planner is pure, so these are the same rects
 * Compose places, on the viewports the decision names and on every Seeker row.
 */
class LoadingStripPlanTest {
    private data class Row(val name: String, val w: Float, val h: Float, val safe: HudInsets)
    private val label = "PIXEL KINGDOM WARS v0.6.6"
    private val portraitPhone = Row("portrait phone 390x844", 390f, 844f, HudInsets(top = 24f, bottom = 48f))
    private val landscapePhone = Row("landscape phone 844x390", 844f, 390f, HudInsets(top = 24f, left = 48f, right = 48f))
    private val desktop = Row("desktop 1280x800", 1280f, 800f, HudInsets())
    private val smallPhone = Row("small phone 320x640", 320f, 640f, HudInsets(top = 24f, bottom = 48f))
    private val seekerRows = SeekerRows.DENSITIES.flatMap { d ->
        val (pw, ph) = SeekerRows.portrait(d); val (lw, lh) = SeekerRows.landscape(d)
        listOf(Row("seeker portrait@$d", pw, ph, SeekerRows.PORTRAIT_INSETS), Row("seeker landscape@$d", lw, lh, SeekerRows.LANDSCAPE_INSETS))
    }
    private val rows = listOf(portraitPhone, landscapePhone, desktop, smallPhone) + seekerRows
    private fun plan(r: Row, fontScale: Float = 1f) = LoadingStripPlan.of(r.w, r.h, r.safe, label, fontScale)

    @Test fun `the strip is one bottom plate above the safe area, centred, at most 560 wide, never over the centre`() {
        for (r in rows) {
            val p = plan(r); val s = p.strip
            val screen = HudRect(0f, 0f, r.w, r.h)
            assertTrue("${r.name}: on screen $s", screen.contains(s))
            val gap = if (p.wide && !p.compact) LoadingStripPlan.BOTTOM_GAP_DESKTOP else LoadingStripPlan.BOTTOM_GAP_PHONE
            // The strip's baseline is the bottom gap above the safe inset where the label sits beside it; elsewhere the
            // label holds the corner and the strip sits its plate and 4 dp higher.
            val baseline = r.h - r.safe.bottom - gap - if (p.labelBeside) 0f else LoadingStripPlan.LABEL_H + LoadingStripPlan.LABEL_GAP
            assertEquals("${r.name}: ${gap.toInt()} dp above the bottom safe inset${if (p.labelBeside) "" else " and the label"}", baseline, s.bottom, 0.01f)
            val span = r.w - r.safe.left - r.safe.right - 2 * LoadingStripPlan.GUTTER
            assertEquals("${r.name}: min(span − gutters, 560)", minOf(span, LoadingStripPlan.MAX_WIDTH), s.w, 0.01f)
            assertEquals("${r.name}: centred in the safe span", (r.safe.left + LoadingStripPlan.GUTTER + r.w - r.safe.right - LoadingStripPlan.GUTTER) / 2f, s.x + s.w / 2f, 0.01f)
            assertTrue("${r.name}: the wallpaper's centre stays clear (strip top ${s.y} of ${r.h})", s.y > r.h * 0.6f)
        }
    }

    @Test fun `fixed heights per viewport class, and the box never depends on the state`() {
        // The follow-up removes the empty portrait actions row while retaining two 48 dp touch targets beside text.
        // Rewritten 2026-10-06 (owner: "improve visually"): one 8 dp padding on every layout (was 6 / 8 / 10) inside the kit
        // plate, and a 6 dp pixel-stepped meter (was a 4 dp line): landscape 64 → 70, desktop 84 → 82; the portrait rows
        // keep their 96 dp (two touch targets). Every rule below is unchanged.
        assertEquals(96f, plan(portraitPhone).strip.h, 0.01f)
        assertEquals(70f, plan(landscapePhone).strip.h, 0.01f)
        assertEquals(82f, plan(desktop).strip.h, 0.01f)
        assertEquals(96f, plan(smallPhone).strip.h, 0.01f)
        for (r in rows) assertEquals("${r.name}: one padding everywhere", LoadingStripPlan.PADDING, plan(r).padding, 0f)
        assertTrue(plan(landscapePhone).compact && plan(landscapePhone).wide)
        assertFalse(plan(portraitPhone).compact); assertFalse(plan(portraitPhone).wide)
        assertTrue(plan(smallPhone).compact); assertFalse(plan(smallPhone).wide)
        assertFalse(plan(desktop).compact); assertTrue(plan(desktop).wide)
        for (r in rows) {
            val p = plan(r)
            assertEquals("${r.name}: the same box under another version string", p.strip, LoadingStripPlan.of(r.w, r.h, r.safe, "PIXEL KINGDOM WARS v10.20.30-debug").strip)
            val content = p.strip.h - 2 * p.padding
            assertTrue("${r.name}: a 48 dp button fits ${if (p.wide) "beside the column" else "in the action stack"}",
                (if (p.wide) content else p.strip.h / 2f) >= LoadingStripPlan.TAP - 0.01f)
            assertEquals("${r.name}: the box is its reserved lines and nothing else",
                maxOf(if (p.wide) 0f else 96f, 2 * p.padding + p.titleLine + 2 * p.meterGap + LoadingStripPlan.METER + p.lineSlot), p.strip.h, 0.01f)
            assertEquals("${r.name}: line 2 holds two tip lines, on every layout", 2 * p.tipLine, p.lineSlot, 0.01f)
            assertEquals("${r.name}: the column is the strip less padding, sprite and gap", p.strip.w - 2 * p.padding - p.sprite - p.gap, p.column, 0.01f)
        }
    }

    @Test fun `the title and line 2 keep their width beside the widest buttons of every boot state`() {
        // Every title the strip draws with the widest button pair its state can show (bootCardActions, updateForwardAction,
        // bootRetryOffered, BootLoading); widths from the planner's own VT323 model (HudType.textWidth: 0.4 em + spacing,
        // 9.76 dp a glyph measured on the 2026-09-28 portrait capture) and the chrome's padding. On wide layouts the pair
        // sits beside the column and takes its width plus the gap; on narrow ones the pair is stacked beside it.
        val states = listOf(
            "Opening your kingdom…" to emptyList(),
            "Couldn't open your kingdom" to listOf("TRYING AGAIN…" to false),
            "Update 0.6.6 · 251 MB" to listOf("DOWNLOAD ANYWAY" to false, "LATER" to true),
            "Update required" to listOf("DOWNLOAD ANYWAY" to false, "CHECK AGAIN" to true))
        for (r in rows) {
            val p = plan(r)
            for ((title, buttons) in states) {
                val pair = buttons.map { (label, ghost) -> LoadingStripPlan.buttonWidth(label, ghost) }.sum() + (buttons.size - 1).coerceAtLeast(0) * LoadingStripPlan.ACTIONS_GAP
                val text = if (buttons.isEmpty()) p.column else p.column - (if (p.wide) pair else NARROW_ACTION_WIDTH) - p.gap
                assertTrue("${r.name}: '$title' (${HudType.textWidth(title.length, p.titleSp, 1f)} dp) fits its line ($text dp) beside $buttons",
                    HudType.textWidth(title.length, p.titleSp, 1f) <= text * p.titleLines + HudRect.EPS)
                assertTrue("${r.name}: line 2 keeps readable reason text ($text dp) beside $buttons", text >= HudType.textWidth(if (p.wide) 28 else 18, p.tipSp) - HudRect.EPS)
                if (!p.wide) assertTrue("${r.name}: two touch targets fit the action stack", buttons.size * LoadingStripPlan.TAP <= p.strip.h)
            }
        }
        // Why the optional title is not the decision's "Update 0.6.6 available · 251 MB": at 22 sp it is wider than a portrait
        // phone's column and than a desktop's column beside UPDATE NOW + LATER, and a title that loses its size to an ellipsis
        // is worse than one without "available".
        val long = "Update 0.6.6 available · 251 MB"
        val pair = LoadingStripPlan.buttonWidth("UPDATE NOW", false) + LoadingStripPlan.buttonWidth("LATER", true) + LoadingStripPlan.ACTIONS_GAP
        assertTrue(HudType.textWidth(long.length, plan(desktop).titleSp, 1f) > plan(desktop).column - pair - plan(desktop).gap)
    }

    @Test fun `the version label is the bottom-left corner outside the strip, beside it only where a desktop has room`() {
        for (r in rows) {
            val p = plan(r); val l = p.label
            assertTrue("${r.name}: label on screen $l", HudRect(0f, 0f, r.w, r.h).contains(l))
            assertFalse("${r.name}: the label never touches the strip", l.intersects(p.strip))
            val gap = if (p.wide && !p.compact) LoadingStripPlan.BOTTOM_GAP_DESKTOP else LoadingStripPlan.BOTTOM_GAP_PHONE
            assertEquals("${r.name}: the left gutter", r.safe.left + LoadingStripPlan.GUTTER, l.x, 0.01f)
            assertEquals("${r.name}: the bottom gap above the safe inset", r.h - r.safe.bottom - gap, l.bottom, 0.01f)
            if (p.labelBeside) {
                assertEquals("${r.name}: on the strip's baseline", p.strip.bottom, l.bottom, 0.01f)
                assertTrue("${r.name}: clear of the strip", l.right + LoadingStripPlan.ACTIONS_GAP <= p.strip.x + 0.01f)
            } else assertEquals("${r.name}: just under the strip", p.strip.bottom + LoadingStripPlan.LABEL_GAP, l.y, 0.01f)
        }
        assertTrue("desktop has room left of the centred strip", plan(desktop).labelBeside)
        // D-193 rule 2 allows "beside" on desktop only; a phone's strip takes the width or its row is compact, and every
        // Seeker row is one or the other (the handoff once claimed the Seeker landscape rows sat beside: they do not).
        assertFalse("a phone's strip takes the width; the label holds the corner under it", plan(portraitPhone).labelBeside)
        assertFalse("a landscape phone's row is compact", plan(landscapePhone).labelBeside)
        for (r in seekerRows) assertFalse("${r.name}: the corner, under the strip", plan(r).labelBeside)
    }

    @Test fun `a larger font scale grows the reserved lines but keeps the strip anchored at the bottom`() {
        // The lines are sp: the box grows once with the system font scale, then stays; the bottom gap is dp and never moves.
        for (r in rows) {
            val a = plan(r); val b = plan(r, 1.3f)
            assertEquals("${r.name}: the label keeps the corner", a.label.bottom, b.label.bottom, 0.01f)
            assertEquals("${r.name}: same width and x", a.strip.x to a.strip.w, b.strip.x to b.strip.w)
            assertTrue("${r.name}: taller", b.strip.h > a.strip.h)
            assertTrue("${r.name}: still clear of the centre", b.strip.y > r.h * 0.5f)
        }
        assertEquals("beside the strip the bottom is fixed", plan(desktop).strip.bottom, plan(desktop, 1.3f).strip.bottom, 0.01f)
    }
}
