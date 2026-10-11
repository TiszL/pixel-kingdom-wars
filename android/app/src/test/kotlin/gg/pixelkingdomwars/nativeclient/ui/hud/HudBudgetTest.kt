package gg.pixelkingdomwars.nativeclient.ui.hud

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.ChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.DeckButtonUi
import gg.pixelkingdomwars.nativeclient.ui.model.DeckToolUi
import gg.pixelkingdomwars.nativeclient.ui.model.EdgeButtonUi
import gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi
import gg.pixelkingdomwars.nativeclient.ui.model.ProfileMedallionUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceDrawerUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceGroupUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceRowUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The owner's binding Home HUD budget (UX-ARCHITECTURE owner addenda 5 and 6, DESIGN-SYSTEM §2 rule 1): on a 412 × 915
 * phone the permanent HUD covers at most 12 % with nothing selected, and at most four readouts are permanent. The scene
 * comes first; these tests fail if a layout change, a new zone or a mapper passing too much would push the HUD over it.
 */
class HudBudgetTest {
    private fun badge(text: String) = BadgeUi(text, BadgeTone.COUNT, "$text new")
    private fun row(id: String, value: String = "1", handle: Boolean = false) =
        ResourceChipUi(FeatureId("hud.$id"), id, value, null, false, null, name = id, drawerHandle = handle)
    private fun edge(id: String, badge: BadgeUi?) = EdgeButtonUi(FeatureId("hud.$id"), id, id.uppercase(), badge, glow = false)

    /** home.png: four readouts, QUESTS with a badge, MAIL + CHAT tabs, the four-button deck. */
    private val home = HomeHudUi(
        profile = ProfileMedallionUi(FeatureId("hud.profile"), "12", null, "Profile, Keep level 12"),
        builders = ChipUi(FeatureId("hud.builders"), "builder", "1/2", "Builders 1 of 2 free"),
        shield = ChipUi(FeatureId("hud.shield"), "shield", "4h", "Shield 4 hours"),
        resources = listOf(row("shards", "40,943"), row("gems", "1,250"), row("keep", "312.5"), row("skr", "240", handle = true)),
        rightEdge = listOf(edge("quests", badge("3"))),
        leftEdge = listOf(edge("mail", badge("2")), edge("chat", badge("5"))),
        herald = null,
        deck = listOf(
            DeckButtonUi(FeatureId("hud.attack"), "attack", "ATTACK", true, null, null, verb = Verb.RED),
            DeckButtonUi(FeatureId("hud.army"), "ui_portrait_highlander_t2", "ARMY", false, null, 14 to 20, verb = Verb.CHARCOAL),
            DeckButtonUi(FeatureId("hud.map"), "map", "MAP", false, null, null, verb = Verb.BLUE),
            DeckButtonUi(FeatureId("hud.build"), "itm_hammer", "BUILD", true, null, null, verb = Verb.GREEN),
        ),
        deckVisible = true,
        trophies = ChipUi(FeatureId("hud.leagues"), "league-gold", "1,284", "Gold league, 1,284 trophies"),
    )

    @Test fun `the default Home layout stays within the owner's 12 percent budget`() {
        val covered = homeHudCoverage(home)
        assertTrue("Home HUD covers ${covered * 100}% of 412x915; the owner's limit is 12%", covered <= HOME_HUD_BUDGET)
        // The design measured this exact frame at 11.9 % (home-budget.png). A much lower figure would mean the
        // measurement silently stopped counting a zone, which would make the budget check meaningless.
        assertTrue("coverage ${covered * 100}% no longer matches the measured mock (11.9%)", covered >= 0.115f)
    }

    @Test fun `never more than four permanent readouts even when a mapper passes every resource`() {
        val everything = home.copy(resources = listOf("shards", "gems", "keep", "skr", "ore", "timber", "embercore", "renown").map { row(it) })
        val plan = homeHudPlan(everything)
        assertEquals(4, plan.permanentReadouts)
        assertEquals(listOf("shards", "gems", "keep", "skr"), plan.resources.map { it.id.value.removePrefix("hud.") })
        assertTrue(homeHudCoverage(everything) <= HOME_HUD_BUDGET)
        assertTrue(homeHudPlan(home).permanentReadouts <= 4)
    }

    @Test fun `extra badged edge buttons fold into the top one instead of breaking the budget`() {
        val busy = home.copy(rightEdge = listOf(edge("quests", badge("3")), edge("daily", badge("!")), edge("event", badge("1"))))
        val plan = homeHudPlan(busy)
        assertTrue(coveredFraction(plan) <= HOME_HUD_BUDGET)
        // The top button is never dropped, and every badged button is either shown or counted in its "+n".
        assertEquals("quests", plan.rightEdge.first().label.lowercase())
        assertEquals(3, plan.rightEdge.size + plan.rightEdgeFolded)
        assertTrue(plan.rightEdgeFolded >= 1)
    }

    @Test fun `with no left tabs a second edge button fits and is shown`() {
        val quiet = home.copy(leftEdge = emptyList(), rightEdge = listOf(edge("quests", badge("3")), edge("daily", badge("!"))))
        val plan = homeHudPlan(quiet)
        assertEquals(2, plan.rightEdge.size)
        assertEquals(0, plan.rightEdgeFolded)
        assertTrue(coveredFraction(plan) <= HOME_HUD_BUDGET)
    }

    @Test fun `a non-QUESTS edge button without a badge is not shown at all`() {
        val plan = homeHudPlan(home.copy(rightEdge = listOf(edge("mail", null), edge("daily", badge("!")))))
        assertEquals(listOf("DAILY"), plan.rightEdge.map { it.label })
        assertEquals(0, plan.rightEdgeFolded)
    }

    @Test fun `a selection hides the left cluster, edges and deck but keeps the resource stack for cost comparison`() {
        val selected = homeHudPlan(home.copy(deckVisible = false))
        assertFalse(selected.leftCluster)
        assertTrue(selected.rightEdge.isEmpty() && selected.leftEdge.isEmpty() && selected.deck.isEmpty())
        assertEquals(4, selected.resources.size)
        assertTrue(coveredFraction(selected) < homeHudCoverage(home))
    }

    @Test fun `the deck keeps ATTACK and BUILD in the corners and mirrors for left hands`() {
        val slots = deckSlots(home.deck, mirrored = false)
        assertEquals(listOf("ATTACK", "ARMY"), slots.filter { it.leftCorner }.map { it.button.label })
        assertEquals(listOf("MAP", "BUILD"), slots.filter { !it.leftCorner }.map { it.button.label })
        assertEquals(80 to 72, slots[0].width to slots[0].height)
        assertEquals(72 to 72, slots[3].width to slots[3].height)
        assertEquals(52 to 52, slots[1].width to slots[1].height)
        val mirrored = deckSlots(home.deck, mirrored = true)
        assertEquals(listOf("BUILD", "MAP"), mirrored.filter { it.leftCorner }.map { it.button.label })
        // Sizes follow the button, not the corner: ATTACK stays the 80 dp button on the right.
        assertEquals(80, mirrored.last().width)
    }

    @Test fun `overlapping boxes count once, as the design's pixel mask did`() {
        assertEquals(100L, coveredArea(listOf(HudRect(0, 0, 10, 10), HudRect(0, 0, 10, 10))))
        assertEquals(150L, coveredArea(listOf(HudRect(0, 0, 10, 10), HudRect(5, 0, 10, 10))))
        // Off-screen parts (an edge label past the right edge) are not counted.
        assertEquals(10L, coveredArea(listOf(HudRect(HudGeometry.SCREEN_W - 1, 0, 20, 10))))
    }

    @Test fun `icons are drawn only at whole-number scales of their art`() {
        assertEquals(32, hudIconDp("ui:workshop-menu", large = true))
        assertEquals(32, hudIconDp("itm_hammer", large = true))
        assertEquals(28, hudIconDp("ui_portrait_highlander_t2", large = false))
        assertEquals(36, hudIconDp("quest", large = true))
        assertEquals(24, hudIconDp("map", large = false))
        assertEquals(24, hudIconDp("shape:mail", large = false))
    }

    // The LAYOUT · EXPAND · FIT dock row and the BUILDERS button used to sit outside the HUD on Home, as permanent chrome.
    // Folded into the deck as a long-press shelf they must cost the owner's budget nothing at rest.
    private val tools = listOf(
        DeckToolUi(HudIds.TOOL_LAYOUTS, "layout", "LAYOUT", true, "Base layout"),
        DeckToolUi(HudIds.TOOL_EXPAND, "plus", "EXPAND", true, "Expand base"),
        DeckToolUi(HudIds.TOOL_FIT, "locate", "FIT", true, "Fit base to screen"),
    )

    @Test fun `folding the dock row into the deck keeps Home within the 12 percent budget`() {
        val withTools = home.copy(tools = tools)
        assertEquals("closed tools add no permanent area", homeHudCoverage(home), homeHudCoverage(withTools), 0f)
        assertTrue(homeHudCoverage(withTools) <= HOME_HUD_BUDGET)
        // Open, the shelf is transient (like the drawer): the permanent measure does not move either.
        assertEquals(homeHudCoverage(home), homeHudCoverage(withTools.copy(toolsOpen = true)), 0f)
        assertTrue(hasDeckTools(withTools))
        assertFalse("no tools, no long-press door", hasDeckTools(home))
    }

    @Test fun `the old separate dock row would have broken the budget, which is why it is folded`() {
        // KingdomScreen's row: three dock tiles of at least the 48 dp touch minimum, 4 dp apart, above the deck; plus the
        // BUILDERS tile under the status chip. Even at that minimum Home goes over 12 %.
        val plan = homeHudPlan(home)
        val deckTop = HudGeometry.SCREEN_H - HudGeometry.DECK_BOTTOM - HudGeometry.DECK_PRIMARY
        val oldRow = (0 until 3).map { HudRect(HudGeometry.GUTTER + it * 52, deckTop - 8 - 48, 48, 48) }
        val oldBuilders = HudRect(HudGeometry.GUTTER, HudGeometry.LEVEL_Y + HudGeometry.LEVEL + 8, 52, 48)
        val withOldChrome = coveredArea(homeHudRects(plan) + oldRow + oldBuilders).toFloat() / (HudGeometry.SCREEN_W * HudGeometry.SCREEN_H)
        assertTrue("the old chrome measured ${withOldChrome * 100}%", withOldChrome > HOME_HUD_BUDGET)
    }

    @Test fun `the open shelf sits over BUILD, clear of the deck, on screen, with 48 dp targets`() {
        val plan = homeHudPlan(home.copy(tools = tools, toolsOpen = true))
        assertEquals(listOf("LAYOUT", "EXPAND", "FIT"), plan.tools.map { it.label })
        assertFalse("BUILD is in the right corner", plan.toolsLeft)
        val shelf = homeHudToolRects(plan)
        val deck = homeHudRects(plan).filter { it.top >= HudGeometry.SCREEN_H - HudGeometry.DECK_BOTTOM - HudGeometry.DECK_PRIMARY }
        assertEquals(3, shelf.size)
        shelf.forEach { r ->
            assertTrue("48 dp target: $r", r.width >= 48 && r.height >= 48)
            assertTrue("on screen: $r", r.left >= HudGeometry.GUTTER && r.right <= HudGeometry.SCREEN_W - HudGeometry.GUTTER && r.top >= 0)
            deck.forEach { d -> assertEquals("overlaps the deck: $r / $d", 0L, coveredArea(listOf(r)) + coveredArea(listOf(d)) - coveredArea(listOf(r, d))) }
        }
        // Right-aligned to BUILD's gutter.
        assertEquals(HudGeometry.SCREEN_W - HudGeometry.GUTTER, shelf.last().right)
        // Mirrored deck: BUILD and the shelf move to the left corner.
        val mirrored = homeHudPlan(home.copy(tools = tools, toolsOpen = true, mirrored = true))
        assertTrue(mirrored.toolsLeft)
        assertEquals(HudGeometry.GUTTER, homeHudToolRects(mirrored).first().left)
    }

    @Test fun `the shelf never shows with a selection, while closed, or without a BUILD door`() {
        assertTrue(homeHudPlan(home.copy(tools = tools)).tools.isEmpty())
        assertTrue(homeHudPlan(home.copy(tools = tools, toolsOpen = true, deckVisible = false)).tools.isEmpty())
        val noBuild = home.copy(tools = tools, toolsOpen = true, deck = home.deck.filter { it.id != HudIds.BUILD })
        assertTrue(homeHudPlan(noBuild).tools.isEmpty())
        assertFalse(hasDeckTools(noBuild))
        assertTrue(homeHudToolRects(homeHudPlan(noBuild)).isEmpty())
    }

    // Every resource is a signpost (owner addendum 3): the drawer always opens on something it can explain.
    @Test fun `the drawer info card shows the tapped row, else the first, and never invents one`() {
        fun r(id: String) = ResourceRowUi(id, id, id, "1", "for", "earned", null)
        val drawer = ResourceDrawerUi(listOf(ResourceGroupUi("a", "", "A", "", null, listOf(r("shards"), r("skr"))),
            ResourceGroupUi("b", "", "B", "", null, listOf(r("embercore")))), focusRowId = "embercore")
        assertEquals("embercore", drawerFocus(drawer)?.id)
        assertEquals("shards", drawerFocus(drawer.copy(focusRowId = "gone"))?.id)
        assertEquals("shards", drawerFocus(drawer.copy(focusRowId = null))?.id)
        assertNull(drawerFocus(ResourceDrawerUi(emptyList(), null)))
    }
}
