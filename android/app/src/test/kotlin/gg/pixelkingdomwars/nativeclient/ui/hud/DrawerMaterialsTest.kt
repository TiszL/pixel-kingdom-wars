package gg.pixelkingdomwars.nativeclient.ui.hud

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingState
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingFeature
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingFeatures
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingIdentity
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingJournal
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingView
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryProtectedStock
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.home.homeResourceDrawer
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceGroupLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The drawer's HARVESTERS / WORKSHOP strips: one kingdom's own server stock, never another's, never a guessed zero.
 *  Synthetic server values, not copied tuning. */
class DrawerMaterialsTest {
    private val wallet = "11111111111111111111111111111112"
    private val base = "00000000-0000-4000-8000-000000000001"
    private val identity = OrdinaryCraftingIdentity("https://example.invalid", "devnet", wallet)

    private fun view(viewWallet: String = wallet, viewBase: String = base, quartz: String = "14") = OrdinaryCraftingView(viewWallet, viewBase,
        OrdinaryCraftingFeatures(OrdinaryCraftingFeature(1, 1)), true, 2, 9, emptyList(),
        listOf(OrdinaryRawStock("frost_quartz", quartz, "0", quartz), OrdinaryRawStock("storm_ore", "0", "0", "0"),
            OrdinaryRawStock("heartwood_logs", "2500", "0", "2500")),
        listOf(OrdinaryProtectedStock("embercore", "1", "0"), OrdinaryProtectedStock("expedition_kit", "2", "0")),
        emptyList(), "2026-10-04T07:00:00.000Z", catalogueVersion = 2, shardsAvailable = "0")

    private fun state(v: OrdinaryCraftingView? = view()) =
        OrdinaryCraftingState(OrdinaryCraftingJournal(1, identity, 0, null, emptyList()), v, advertised = true)

    @Test fun `only the current wallet and base view becomes drawer strips`() {
        val groups = drawerMaterialGroups(state(), wallet, base)
        assertEquals(listOf("harvesters", "workshop"), groups.map { it.id })
        assertTrue(groups.all { it.layout == ResourceGroupLayout.TILE_STRIP })
        // Another kingdom, another wallet, no view, or an unknown scope: no strip at all, never that kingdom's counts.
        assertTrue(drawerMaterialGroups(state(view(viewBase = "00000000-0000-4000-8000-000000000009")), wallet, base).isEmpty())
        assertTrue(drawerMaterialGroups(state(view(viewWallet = "22222222222222222222222222222223")), wallet, base).isEmpty())
        assertTrue(drawerMaterialGroups(state(null), wallet, base).isEmpty())
        assertTrue(drawerMaterialGroups(null, wallet, base).isEmpty())
        assertTrue(drawerMaterialGroups(state(), null, base).isEmpty())
        assertTrue(drawerMaterialGroups(state(), wallet, null).isEmpty())
    }

    @Test fun `a known zero is tinted empty and an unknown count is not`() {
        val raw = drawerMaterialGroups(state(view(quartz = "not-a-count")), wallet, base).first().rows
        val storm = raw.single { it.id == "storm_ore" }
        assertEquals("0", storm.value)
        assertTrue(storm.empty)
        val quartz = raw.single { it.id == "frost_quartz" }
        assertTrue("an unknown count is blank, which the drawer draws as …", quartz.value.isBlank())
        assertFalse("unknown is never the empty tint", quartz.empty)
        assertEquals("2.5K", raw.single { it.id == "heartwood_logs" }.value)
    }

    @Test fun `each strip and each tile GO opens the building that makes it`() {
        val groups = drawerMaterialGroups(state(), wallet, base)
        assertEquals(FeatureId("harvester.harvest"), groups[0].go)
        assertEquals(FeatureId("workshop.craft"), groups[1].go)
        assertTrue(groups[0].rows.all { it.earnedAtFeature == FeatureId("harvester.harvest") })
        assertTrue(groups[1].rows.all { it.earnedAtFeature == FeatureId("workshop.craft") })
        assertEquals("ui:workshop-menu", groups[1].rows.single().goIcon)
        assertEquals(listOf("embercore"), groups[1].rows.map { it.id })
        assertNull("no row-level action is invented", groups.flatMap { it.rows }.firstOrNull { it.action != null })
    }

    @Test fun `Home appends the strips after EVERY DAY and keeps EVERY DAY unchanged`() {
        val home = BaseState()
        val plain = homeResourceDrawer(home, null)
        val withStrips = homeResourceDrawer(home, "embercore", materials = drawerMaterialGroups(state(), wallet, base))
        assertEquals(plain.groups.single(), withStrips.groups.first())
        assertEquals(listOf("everyday", "harvesters", "workshop"), withStrips.groups.map { it.id })
        assertEquals(DRAWER_MATERIALS_FOOTNOTE, withStrips.footnote)
        assertNull("no legend without a strip to explain", plain.footnote)
        assertEquals("embercore", drawerFocus(withStrips)?.id)
        // SKR has no auction system yet: its row carries no BID.
        assertNull(withStrips.groups.first().rows.single { it.id == "skr" }.action)
    }
}
