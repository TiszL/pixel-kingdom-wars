package gg.pixelkingdomwars.nativeclient.ui.hud

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.ChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.DeckButtonUi
import gg.pixelkingdomwars.nativeclient.ui.model.EdgeButtonUi
import gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi
import gg.pixelkingdomwars.nativeclient.ui.model.ProfileMedallionUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The HUD half of the kit successor (design ruling 092decf3 items 1 and 6). Why: a resource readout must open the ONE
 * canonical drawer row (`hud.resources`) focused on what was tapped, so the registry, not the HUD, routes; and a "+n"
 * count is useless unless it is a path to the features it hides, while the first edge button keeps its own door.
 */
class HudSuccessorTest {
    private fun badge(text: String) = BadgeUi(text, BadgeTone.COUNT, "$text new")
    private fun edge(id: String) = EdgeButtonUi(FeatureId("hud.$id"), id, id.uppercase(), badge("1"), glow = false)
    private val hub = FeatureId("hud.profile")
    private val home = HomeHudUi(
        profile = ProfileMedallionUi(FeatureId("hud.profile"), "12", null, "Profile"),
        builders = ChipUi(FeatureId("hud.builders"), "builder", "1/2", "Builders"),
        shield = ChipUi(FeatureId("hud.shield"), "shield", "4h", "Shield"),
        resources = listOf(ResourceChipUi(FeatureId("hud.shards"), "shards", "1", null, false, null)),
        rightEdge = listOf(edge("quests")),
        leftEdge = listOf(edge("mail"), edge("chat")),
        herald = null,
        deck = listOf(
            DeckButtonUi(FeatureId("hud.attack"), "attack", "ATTACK", true, null, null, verb = Verb.RED),
            DeckButtonUi(FeatureId("hud.build"), "shape:hammer", "BUILD", true, null, null, verb = Verb.GREEN),
        ),
        deckVisible = true,
        rightEdgeOverflow = hub,
    )

    @Test fun `folded edge buttons get a door to the hub notices and the first button keeps its own id`() {
        val crowded = home.copy(rightEdge = listOf(edge("quests"), edge("dailyCache"), edge("event")))
        val plan = homeHudPlan(crowded)
        assertTrue(plan.rightEdgeFolded > 0)
        assertEquals(hub, edgeOverflowTarget(plan, crowded))
        assertEquals("hud.quests", plan.rightEdge.first().id.value)
    }

    @Test fun `no overflow door without folded buttons, without a hub row, or while a building is selected`() {
        assertNull(edgeOverflowTarget(homeHudPlan(home), home))
        val crowded = home.copy(rightEdge = listOf(edge("quests"), edge("dailyCache"), edge("event")))
        assertNull(edgeOverflowTarget(homeHudPlan(crowded.copy(rightEdgeOverflow = null)), crowded.copy(rightEdgeOverflow = null)))
        val selected = crowded.copy(deckVisible = false)
        assertNull(edgeOverflowTarget(homeHudPlan(selected), selected))
    }

    @Test fun `a readout tap opens the drawer with its focus and an old caller still gets a drawer`() {
        val seen = mutableListOf<FeatureId>()
        val legacy = HomeHudActions(openFeature = {}, openDrawer = { seen += it }, focusResource = {}, closeDrawer = {})
        legacy.openDrawerAt(FeatureId("hud.skr"))
        legacy.openDrawerAt(null)
        assertEquals(listOf(FeatureId("hud.skr"), HudIds.RESOURCES), seen)
        val focused = mutableListOf<FeatureId?>()
        val current = legacy.copy(openDrawerAt = { focused += it })
        current.openDrawerAt(HudIds.GEMS)
        assertEquals(listOf<FeatureId?>(HudIds.GEMS), focused)
        assertEquals(2, seen.size)
    }

    @Test fun `the HUD names the canonical registry rows`() {
        assertEquals("hud.resources", HudIds.RESOURCES.value)
        assertEquals("hud.dailyCache", HudIds.DAILY_CACHE.value)
        assertEquals("hud.mail", HudIds.MAIL.value)
        assertEquals("hud.build", HudIds.BUILD.value)
    }
}
