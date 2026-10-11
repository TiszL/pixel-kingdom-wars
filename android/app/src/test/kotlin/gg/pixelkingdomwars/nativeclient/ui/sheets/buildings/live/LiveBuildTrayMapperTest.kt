package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.CardTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.cardTap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The live BUILD tray (TrayFacts -> BuildTrayUi). Why it matters: the tray must offer exactly what the current tray
 * offered (same cards, same Keep gates, same caps, same printed prices), say WHY a card cannot be built instead of a dead
 * CHOOSE, send a short player to the Mines rather than into a placement that will be refused, and keep HEROES / LAYOUTS
 * as the doors they are today.
 */
class LiveBuildTrayMapperTest {
    private fun card(type: String, group: TrayGroup, amount: String = "1,500", raw: String = "1500", currency: String = "SHARDS",
        requiredKeep: Int? = null, owned: Int = 0, max: Int? = 2, atCap: Boolean = false, trap: Boolean = false, familyOwned: Int? = null) =
        TrayCardFact(type, type.uppercase(), "purpose of $type", "ui_portrait_${type}_t1", currency, amount, raw, "2h", requiredKeep,
            owned, max, familyOwned, atCap, trap, group)

    private val facts = TrayFacts(keepLevel = 4, freeBuilders = 1, totalBuilders = 2, shardsBalance = "40943", busy = false, cards = listOf(
        card("mine", TrayGroup.ECONOMY, amount = "250", raw = "250"),
        card("barracks", TrayGroup.ARMY),
        card("clanhall", TrayGroup.CLAN, requiredKeep = 6),
        card("vault", TrayGroup.ECONOMY, owned = 2, atCap = true),
        card("cannon", TrayGroup.DEFENCE, amount = "60,000", raw = "60000"),
        card("spiketrap", TrayGroup.TRAP, trap = true, familyOwned = 3, max = 5),
        card("wall", TrayGroup.WALL, amount = "50", raw = "50"),
    ))

    @Test fun `the BUILDINGS tab groups the current tray's cards and prints their prices as before`() {
        val ui = liveBuildTrayUi(facts, LiveTrayTabs.BUILDINGS)
        assertEquals(LiveTrayTabs.BUILDINGS, ui.selectedTab)
        assertEquals(listOf("REALM TRADE", "ECONOMY", "ARMY", "CLAN"), ui.sections.map { it.title })
        val mine = ui.sections.flatMap { it.cards }.first { it.type == "mine" }
        assertEquals(BuildCardState.AVAILABLE, mine.state)
        assertEquals("250", mine.price?.amount)
        assertEquals(Currency.SHARDS, mine.price?.currency)
        assertEquals("2h", mine.time)
        assertEquals("0/2", mine.count)
        assertEquals(Verb.BLUE, mine.countTone)
        assertEquals(CardTap.PLACE, cardTap(mine.state))
        assertEquals("1/2", ui.builders); assertTrue(ui.buildersFree)
        // Rewritten 2026-10-06 (night UI, buildings/SPEC.md §3.1 and build.png): the tray has six tabs; traps left DEFENCES
        // for a TRAPS tab of their own, right after it. This used to pin the five tabs of the interim tray.
        assertEquals(listOf("BUILDINGS", "DEFENCES", "TRAPS", "HEROES", "SUPPLIES", "LAYOUTS"), ui.tabs.map { it.id })
    }

    @Test fun `Keep gate and cap say why, in the current tray's precedence`() {
        val cards = liveBuildTrayUi(facts, LiveTrayTabs.BUILDINGS).sections.flatMap { it.cards }.associateBy { it.type }
        assertEquals(BuildCardState.LOCKED, cards.getValue("clanhall").state)
        assertEquals("Unlocks at Keep 6", cards.getValue("clanhall").reason)
        assertEquals(BuildCardState.MAX, cards.getValue("vault").state)
        assertEquals("All built", cards.getValue("vault").reason)
        assertEquals(Verb.GREEN, cards.getValue("vault").countTone)
        assertEquals("a locked card's gate wins over its cap", BuildCardState.LOCKED,
            cardState(card("x", TrayGroup.ECONOMY, requiredKeep = 9, atCap = true), facts))
    }

    @Test fun `the TRAPS tab shows traps against their shared cap and a short DEFENCES card opens Need-more`() {
        // Rewritten 2026-10-06 (night UI, buildings/SPEC.md §3.1): traps used to be a section of DEFENCES. They are their own
        // tab now; DEFENCES keeps the defences and the walls. The shared trap cap still prints on every trap card.
        val ui = liveBuildTrayUi(facts, LiveTrayTabs.DEFENCES)
        assertEquals(listOf("DEFENCES", "WALLS"), ui.sections.map { it.title })
        val traps = liveBuildTrayUi(facts, LiveTrayTabs.TRAPS)
        assertEquals(LiveTrayTabs.TRAPS, traps.selectedTab)
        assertEquals("3/5", traps.sections.flatMap { it.cards }.single { it.type == "spiketrap" }.count)
        val cards = ui.sections.flatMap { it.cards }.associateBy { it.type }
        assertTrue("a trap is not drawn on DEFENCES any more", "spiketrap" !in cards)
        assertEquals(BuildCardState.SHORT, cards.getValue("cannon").state)
        assertEquals(CardTap.NEED_MORE, cardTap(cards.getValue("cannon").state))
        val more = liveTrayNeedMore(facts, "cannon", MineFact("mine-1", "8,400"))
        assertEquals("19,057", more?.blocks?.single()?.more)
        assertEquals("60,000", more?.blocks?.single()?.need)
    }

    @Test fun `an unknown balance never makes a card short, and a KEEP price keeps its price and placement door`() {
        val unknown = facts.copy(shardsBalance = null)
        assertEquals(BuildCardState.AVAILABLE, cardState(unknown.cards.first { it.type == "cannon" }, unknown))
        assertEquals(UNKNOWN, liveBuildTrayUi(unknown, LiveTrayTabs.BUILDINGS).spend.value)
        val keepMine = card("mine", TrayGroup.ECONOMY, amount = "500", raw = "500", currency = "KEEP")
        val f = facts.copy(shardsBalance = "1", cards = listOf(keepMine))
        val drawn = liveBuildTrayUi(f, LiveTrayTabs.BUILDINGS).sections.flatMap { it.cards }.single()
        assertEquals(BuildCardState.AVAILABLE, drawn.state)
        assertEquals(Currency.KEEP, drawn.price?.currency)
        assertEquals(PriceStatus.OK, drawn.price?.status)
        assertNull("no Shards need-more for a KEEP price", liveTrayNeedMore(f, "mine", MineFact(null, null)))
    }

    @Test fun `HEROES and LAYOUTS are doors, not card tabs`() {
        assertEquals(LiveTrayTabs.BUILDINGS, liveBuildTrayUi(facts, LiveTrayTabs.HEROES).selectedTab)
        assertEquals(LiveTrayTabs.BUILDINGS, liveBuildTrayUi(facts, LiveTrayTabs.LAYOUTS).selectedTab)
    }

    @Test fun `SUPPLIES stays selected for its whole sheet and retains the sibling navigation tabs`() {
        val ui = liveBuildTrayUi(facts, LiveTrayTabs.SUPPLIES)
        assertEquals(LiveTrayTabs.SUPPLIES, ui.selectedTab)
        assertEquals(1, ui.tabs.count { it.id == LiveTrayTabs.SUPPLIES })
        assertEquals(LiveTrayTabs.BUILDINGS, liveBuildTrayUi(facts, "missing").selectedTab)
    }

    @Test fun `grouping follows the catalogue lists`() {
        assertEquals(TrayGroup.REALM, trayGroup("workshop", trap = false, defence = false, phaseE = true))
        assertEquals(TrayGroup.TRAP, trayGroup("pitfall", trap = true, defence = true, phaseE = false))
        assertEquals(TrayGroup.WALL, trayGroup("wall", trap = false, defence = true, phaseE = false))
        assertEquals(TrayGroup.DEFENCE, trayGroup("cannon", trap = false, defence = true, phaseE = false))
        assertEquals(TrayGroup.ARMY, trayGroup("camp", trap = false, defence = false, phaseE = false))
        assertEquals(TrayGroup.REALM, trayGroup("goldforge", trap = false, defence = false, phaseE = false))
    }
}
