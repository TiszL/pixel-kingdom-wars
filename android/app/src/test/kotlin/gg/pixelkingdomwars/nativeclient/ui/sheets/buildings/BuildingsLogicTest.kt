package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The buildings cluster's rules (design/final/buildings/SPEC.md §2-§4, DESIGN CORRECTION 7). Why they matter: these
 * surfaces spend Shards and builders. A button that sends at an unknown price, sends twice after a lost answer, or tells
 * the player "nothing was spent" when the order may have landed costs real money and trust; a tray that hides why a
 * building cannot be built sends the player hunting through menus.
 */
class BuildingsLogicTest {
    private fun shards(amount: String?, status: PriceStatus = PriceStatus.OK) = PriceUi(Currency.SHARDS, amount, status)
    private val priced = shards("40,000")

    // ---- UPGRADE sheet ----

    @Test fun `upgrade sends only at a server price the player can pay`() {
        assertTrue(upgradePrimaryLook(UpgradeState.READY, priced, null).sends)
        assertTrue("a server zero is a real price", upgradePrimaryLook(UpgradeState.READY, shards("0", PriceStatus.SERVER_ZERO), null).sends)
        assertFalse("OK without an amount is still unknown", upgradePrimaryLook(UpgradeState.READY, shards(null), null).sends)
        assertEquals(UpgradePrimaryKind.WAIT_PRICE, upgradePrimaryLook(UpgradeState.READY, shards(null, PriceStatus.CHECKING), null).kind)
        assertEquals(UpgradePrimaryKind.WAIT_PRICE, upgradePrimaryLook(UpgradeState.CHECKING, priced, null).kind)
        val unavailable = upgradePrimaryLook(UpgradeState.READY, shards(null, PriceStatus.UNAVAILABLE), null)
        assertEquals(UpgradePrimaryKind.OFF, unavailable.kind)
        assertFalse(unavailable.sends)
        assertTrue("an off button always says why", !unavailable.reason.isNullOrBlank())
    }

    @Test fun `short and no-builder route to the place that fixes them, never to a spend`() {
        val short = upgradePrimaryLook(UpgradeState.SHORT, shards("40,000", PriceStatus.SHORT), null)
        assertEquals(UpgradePrimaryKind.NEED_MORE, short.kind); assertFalse(short.sends)
        assertEquals("a SHORT price on a READY sheet is still short", UpgradePrimaryKind.NEED_MORE,
            upgradePrimaryLook(UpgradeState.READY, shards("40,000", PriceStatus.SHORT), null).kind)
        val builder = upgradePrimaryLook(UpgradeState.NO_BUILDER, priced, null)
        assertEquals(UpgradePrimaryKind.NEED_BUILDER, builder.kind); assertFalse(builder.sends)
    }

    @Test fun `a refused upgrade may be retried but a lost answer may not be re-sent`() {
        assertTrue("ERROR returns to READY (the server said no, nothing moved)", upgradePrimaryLook(UpgradeState.ERROR, priced, null).sends)
        val verifying = upgradePrimaryLook(UpgradeState.VERIFYING, priced, "Checking whether the upgrade went through.")
        assertEquals(UpgradePrimaryKind.VERIFYING, verifying.kind)
        assertFalse("the first order may have landed: never send twice", verifying.sends)
        assertFalse(upgradePrimaryLook(UpgradeState.BUSY, priced, null).sends)
    }

    @Test fun `max level and a read-only base are off with a reason`() {
        val max = upgradePrimaryLook(UpgradeState.MAX, priced, null)
        assertEquals(UpgradePrimaryKind.OFF, max.kind); assertFalse(max.sends); assertTrue(!max.reason.isNullOrBlank())
        assertEquals("the herald's words win", "Viewing another kingdom",
            upgradePrimaryLook(UpgradeState.READ_ONLY, priced, "Viewing another kingdom").reason)
    }

    @Test fun `only an authoritative refusal may say nothing was spent`() {
        assertEquals("The upgrade didn't start. Nothing was spent.", failureLine("upgrade", authoritative = true))
        assertEquals("Someone built there first. Nothing was spent.", failureLine("placement", true, "Someone built there first."))
        val uncertain = failureLine("upgrade", authoritative = false, serverReason = "timeout")
        assertFalse("a timeout must not claim nothing was spent", uncertain.contains("Nothing was spent"))
        assertTrue(uncertain.contains("Checking"))
    }

    @Test fun `stat rows fold after four into a plus-n-more row`() {
        val rows = (1..6).toList()
        assertEquals(FoldedRows(listOf(1, 2, 3, 4), 2), foldRows(rows, expanded = false))
        assertEquals(FoldedRows(rows, 0), foldRows(rows, expanded = true))
        assertEquals(FoldedRows(listOf(1, 2, 3), 0), foldRows(listOf(1, 2, 3), expanded = false))
    }

    // ---- BUILD tray ----

    private fun card(type: String, state: BuildCardState, price: PriceUi? = priced, isNew: Boolean = false) =
        BuildCardUi(type, type.uppercase(), "", "ui:$type-t1-idle", "0/1", Verb.BLUE, state, price, "2h", null, isNew, null)

    @Test fun `a card tap goes to placement only when the building can be placed`() {
        assertEquals(CardTap.PLACE, cardTap(BuildCardState.AVAILABLE))
        assertEquals("an unknown price still opens placement; PLACE waits", CardTap.PLACE, cardTap(BuildCardState.CHECKING))
        assertEquals("short never enters placement", CardTap.NEED_MORE, cardTap(BuildCardState.SHORT))
        assertEquals(CardTap.SHOW_REQUIRED, cardTap(BuildCardState.REQUIRES))
        assertEquals(CardTap.EXPLAIN_LOCKED, cardTap(BuildCardState.LOCKED))
        assertEquals(CardTap.EXPLAIN_MAX, cardTap(BuildCardState.MAX))
        assertEquals(CardTap.EXPLAIN_UNAVAILABLE, cardTap(BuildCardState.UNAVAILABLE))
    }

    @Test fun `a card's pill never shows an amount it does not know and is red when short`() {
        assertEquals(PriceStatus.SHORT, cardPrice(card("lodge", BuildCardState.SHORT))?.status)
        val checking = cardPrice(card("mine", BuildCardState.CHECKING, shards("1,200")))
        assertEquals(PriceStatus.CHECKING, checking?.status)
        assertEquals("…", priceText(checking!!))
        assertNull("a locked card shows its lock bar, not a price", cardPrice(card("market", BuildCardState.LOCKED)))
        assertNull(cardPrice(card("berth", BuildCardState.REQUIRES)))
        assertEquals(priced, cardPrice(card("workshop", BuildCardState.AVAILABLE)))
    }

    @Test fun `empty sections hide and a section with something new comes first`() {
        val economy = BuildSectionUi("economy", "ECONOMY", "shards", "1", listOf(card("mine", BuildCardState.AVAILABLE)))
        val army = BuildSectionUi("army", "ARMY", "army", "0", emptyList())
        val realm = BuildSectionUi("realm", "REALM TRADE", "ui:workshop-menu", "1", listOf(card("workshop", BuildCardState.AVAILABLE, isNew = true)))
        val clan = BuildSectionUi("clan", "CLAN", "shield", "1", listOf(card("castle", BuildCardState.LOCKED)))
        assertEquals(listOf("realm", "economy", "clan"), traySections(listOf(economy, army, realm, clan)).map { it.id })
        assertEquals("without NEW the mapper's order is kept", listOf("economy", "clan"), traySections(listOf(economy, clan)).map { it.id })
    }

    // ---- Placement ----

    @Test fun `PLACE sends only from a free spot at a payable price`() {
        val valid = placeLook(PlacementState.VALID, priced, null)
        assertEquals(PlaceTap.PLACE, valid.tap); assertEquals(Verb.GREEN, valid.verb)
        val blocked = placeLook(PlacementState.BLOCKED, priced, null)
        assertEquals(PlaceTap.NONE, blocked.tap); assertEquals(Verb.OFF, blocked.verb); assertEquals("Spot is blocked", blocked.reason)
        assertTrue("the player can still drag it clear", blocked.draggable)
        val waiting = placeLook(PlacementState.VALID, shards(null, PriceStatus.CHECKING), null)
        assertEquals(PlaceTap.NONE, waiting.tap); assertTrue(waiting.dots)
        assertEquals(PlaceTap.NONE, placeLook(PlacementState.VALID, shards(null, PriceStatus.UNAVAILABLE), null).tap)
    }

    @Test fun `short and no-builder placement route to their fix instead of sending`() {
        assertEquals(PlaceTap.NEED_MORE, placeLook(PlacementState.SHORT, shards("40,000", PriceStatus.SHORT), null).tap)
        val builder = placeLook(PlacementState.NO_BUILDER, priced, null)
        assertEquals(PlaceTap.BUILDERS, builder.tap); assertEquals("No free builder", builder.reason)
    }

    @Test fun `no-builder placement plate gives the whole row to when a builder frees up`() {
        // Owner screenshot 3 (2026-10-06): the plate read "1m · free …", the one fact that unblocks PLACE cut off. SPEC §4.3:
        // in NO_BUILDER the plate turns "free in 2h 14m"; the build time is not what the player can act on until then.
        assertFalse(placementPlateShowsTime(PlacementState.NO_BUILDER))
        for (state in PlacementState.values().filter { it != PlacementState.NO_BUILDER })
            assertTrue(state.name, placementPlateShowsTime(state))
    }

    @Test fun `a sent or uncertain placement locks the ghost and cannot be sent again`() {
        val sending = placeLook(PlacementState.SENDING, priced, null)
        assertEquals(PlaceTap.NONE, sending.tap); assertFalse(sending.draggable)
        val verifying = placeLook(PlacementState.VERIFYING, priced, null)
        assertEquals(PlaceTap.NONE, verifying.tap); assertFalse(verifying.draggable); assertTrue(!verifying.reason.isNullOrBlank())
        assertEquals("a refusal returns to VALID", PlaceTap.PLACE, placeLook(PlacementState.ERROR, priced, null).tap)
    }

    @Test fun `the hint explains blocked tiles and the mapper may override it`() {
        assertEquals("Red tiles are taken. Drag it clear.", placementHint(PlacementState.BLOCKED, null))
        assertEquals("Drag to move · PLACE when green", placementHint(PlacementState.VALID, null))
        assertEquals("Move it", placementHint(PlacementState.BLOCKED, "Move it"))
    }

    @Test fun `a drag snaps to the nearest whole tile`() {
        assertEquals(0 to 0, tileStep(14f, -14f, 30f))
        assertEquals(1 to -1, tileStep(16f, -16f, 30f))
        assertEquals(3 to 2, tileStep(95f, 61f, 30f))
        assertEquals("no tile size, no movement", 0 to 0, tileStep(95f, 61f, 0f))
    }

    // ---- World markers ----

    @Test fun `at most three markers, nearest the screen centre first`() {
        fun marker(id: String, x: Float, y: Float) = BuildingMarkerUi(id, PxRect(x - 10f, y - 10f, x + 10f, y + 10f), MarkerKind.READY, "shards", null, null, id)
        val all = listOf(marker("far", 0f, 0f), marker("near", 210f, 410f), marker("mid", 300f, 500f), marker("centre", 200f, 400f), marker("edge", 400f, 800f))
        assertEquals(listOf("centre", "near", "mid"), visibleMarkers(all, 200f, 400f).map { it.buildingId })
        assertTrue(visibleMarkers(all, 200f, 400f, max = 0).isEmpty())
    }
}
