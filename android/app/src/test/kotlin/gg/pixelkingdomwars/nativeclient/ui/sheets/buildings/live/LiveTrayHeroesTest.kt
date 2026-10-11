package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.HeroAltarOffer
import gg.pixelkingdomwars.nativeclient.data.HeroRecruitmentState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.HeroAltarDefinition
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomLocal
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.PlacementDraft
import gg.pixelkingdomwars.nativeclient.ui.kingdom.priceLabel
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.HERO_RECRUIT_BUSY
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.HERO_RECRUIT_UNSUPPORTED
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PlaceTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PlacementState
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.TRAY_POWDER_ICON
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.buildCardReasonLabel
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.placeLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.traySections
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The BUILD tray's TRAPS and HEROES tabs, the NEW badge, and hero placement on the designed band (night 2026-10-06,
 * slice D). Why it matters: traps share one cap and must read as their own family; hero altars must be recruited from the
 * tray in place instead of the old menu, but their consent stays the HeroAltarConfirm review (contract first, else up to
 * the reviewed KEEP), so a tray tap or PLACE must never be a spend; NEW must point at a building the player can now
 * build, never at one already built or not offered.
 */
class LiveTrayHeroesTest {
    private fun card(type: String, group: TrayGroup, requiredKeep: Int? = null, owned: Int = 0, trap: Boolean = false,
        atCap: Boolean = false, admitted: Boolean = true) = TrayCardFact(
        type = type, name = type.uppercase(), purpose = "purpose of $type", art = "ui_portrait_${type}_t1", currency = "SHARDS",
        amount = "1,500", amountRaw = "1500", time = "2h", requiredKeep = requiredKeep, owned = owned, max = 2,
        familyOwned = if (trap) 1 else null, atCap = atCap, trap = trap, group = group, constructionAdmitted = admitted)

    private val facts = TrayFacts(keepLevel = 4, freeBuilders = 1, totalBuilders = 2, shardsBalance = "40943", busy = false, cards = listOf(
        card("mine", TrayGroup.ECONOMY),
        card("cannon", TrayGroup.DEFENCE),
        card("spiketrap", TrayGroup.TRAP, trap = true),
        card("pitfall", TrayGroup.TRAP, trap = true, requiredKeep = 6),
        card("wall", TrayGroup.WALL),
    ))

    private val vex = HeroAltarDefinition("vex", "heroaltar", "Vex", "hero-contract-vex", "2500", 5, 3600, 4)

    private fun base(keep: Int = 6, buildings: List<Building> = emptyList()) = BaseSnapshot("b1", null,
        PlayerSummary(keepLevel = keep, builders = 2), null, null, null, buildings, emptyList(), emptyList(), 1,
        buildJsonObject { putJsonArray("buildings") { } })

    private fun heroes(supported: Boolean = true, enabled: Boolean = true, busy: Boolean = false, keep: Int = 6,
        buildings: List<Building> = emptyList(), contracts: Int = 0) =
        HeroRecruitmentState(supported = supported, enabled = enabled, busy = busy,
            offers = listOf(HeroAltarOffer(vex, contracts, recruited = false)), base = base(keep, buildings))

    @Test fun `six tabs in the designed order and TRAPS holds the traps only`() {
        val traps = liveBuildTrayUi(facts, LiveTrayTabs.TRAPS)
        assertEquals(listOf("BUILDINGS", "DEFENCES", "TRAPS", "HEROES", "SUPPLIES", "LAYOUTS"), traps.tabs.map { it.id })
        assertEquals(TRAY_POWDER_ICON, traps.tabs.single { it.id == LiveTrayTabs.TRAPS }.icon)
        assertEquals(LiveTrayTabs.TRAPS, traps.selectedTab)
        assertEquals(listOf("TRAPS"), traps.sections.map { it.title })
        assertEquals(listOf("spiketrap", "pitfall"), traps.sections.flatMap { it.cards }.map { it.type })
        assertEquals("traps keep their shared cap count", "1/2", traps.sections.single().cards.first().count)
        val defences = liveBuildTrayUi(facts, LiveTrayTabs.DEFENCES).sections.flatMap { it.cards }.map { it.type }
        assertEquals(listOf("cannon", "wall"), defences)
        assertEquals(TrayGroup.TRAP.let(::trayTabOf), LiveTrayTabs.TRAPS)
    }

    @Test fun `HEROES draws the recruitment offers as cards and a pick starts placement for that hero`() {
        val h = heroes()
        val tray = liveHeroTray(h)
        val card = tray.cards.single()
        assertEquals("heroaltar", card.type)
        assertEquals(BuildCardState.AVAILABLE, card.state)
        assertEquals("the price is the offer's own words", h.offers.single().priceLabel(), card.purpose)
        assertTrue(card.priceInPurpose)
        assertNull("no single amount is put on a pill", card.price)
        assertEquals("hero_vex_portrait", card.art)
        assertEquals("1h", card.time)
        val ui = liveBuildTrayUi(facts, LiveTrayTabs.HEROES, heroes = tray)
        assertEquals(LiveTrayTabs.HEROES, ui.selectedTab)
        assertEquals(listOf(card), ui.sections.single().cards)
        val picks = mutableListOf<String>()
        dispatchHeroCard(card, busy = false, onHeroPick = { picks += it }, onGoToBuilding = { fail("not a gated card") }) { fail("no explanation: $it") }
        assertEquals(listOf("heroaltar"), picks)
        assertEquals("without the recruitment state HEROES stays the old door", LiveTrayTabs.BUILDINGS,
            liveBuildTrayUi(facts, LiveTrayTabs.HEROES).selectedTab)
    }

    @Test fun `a hero card that cannot be recruited says why and never starts placement`() {
        val said = mutableListOf<String>()
        fun tap(c: BuildCardUi, busy: Boolean = false) =
            dispatchHeroCard(c, busy, onHeroPick = { fail("no placement: $it") }, onGoToBuilding = { said += "go ${it.type}" }) { said += it }

        val off = liveHeroTray(heroes(supported = false)).cards.single()
        assertEquals(BuildCardState.UNAVAILABLE, off.state)
        assertEquals(HERO_RECRUIT_UNSUPPORTED, off.reason)
        assertEquals("the lock bar keeps it short", "Unavailable", buildCardReasonLabel(off))
        tap(off)
        val inFlight = liveHeroTray(heroes(busy = true)).cards.single()
        assertEquals(HERO_RECRUIT_BUSY, inFlight.reason)
        val locked = liveHeroTray(heroes(keep = 4)).cards.single()
        assertEquals(BuildCardState.LOCKED, locked.state)
        assertEquals("Unlocks at Keep 5", locked.reason)
        tap(locked)
        val placed = liveHeroTray(heroes(buildings = listOf(Building("a1", "heroaltar", 1, 0, 0)))).cards.single()
        assertEquals(BuildCardState.MAX, placed.state)
        assertEquals("one per kingdom", placed.reason)
        tap(placed)
        tap(liveHeroTray(heroes()).cards.single(), busy = true)
        assertEquals(listOf(HERO_RECRUIT_UNSUPPORTED, "go heroaltar", "go heroaltar", "Working…"), said)
    }

    @Test fun `an empty HEROES tab says why instead of drawing an empty grid`() {
        val waiting = liveHeroTray(HeroRecruitmentState(supported = true, enabled = true))
        assertTrue(waiting.cards.isEmpty())
        assertEquals("Loading heroes…", liveBuildTrayUi(facts, LiveTrayTabs.HEROES, heroes = waiting).emptyLine)
        assertEquals(HERO_RECRUIT_UNSUPPORTED, liveHeroTray(HeroRecruitmentState()).emptyLine)
        assertNull("cards present: no empty line", liveBuildTrayUi(facts, LiveTrayTabs.HEROES, heroes = liveHeroTray(heroes())).emptyLine)
    }

    @Test fun `NEW marks only a type the current Keep just unlocked that nobody built`() {
        val f = facts.copy(cards = listOf(
            card("workshop", TrayGroup.REALM, requiredKeep = 4),
            card("lodge", TrayGroup.REALM, requiredKeep = 4, owned = 1),
            card("market", TrayGroup.REALM, requiredKeep = 3),
            card("harvester", TrayGroup.REALM, requiredKeep = 4, admitted = false),
            card("berth", TrayGroup.REALM, requiredKeep = 4, atCap = true),
            card("vault", TrayGroup.ECONOMY, requiredKeep = 4),
            card("cannon", TrayGroup.DEFENCE, requiredKeep = 4),
        ))
        val new = newlyUnlockedBuildTypes(f)
        assertEquals(setOf("workshop", "vault", "cannon"), new)
        assertTrue("an unknown Keep level claims nothing new", newlyUnlockedBuildTypes(f.copy(keepLevel = null)).isEmpty())
        val ui = liveBuildTrayUi(f, LiveTrayTabs.BUILDINGS, newTypes = new)
        val cards = ui.sections.flatMap { it.cards }.associateBy { it.type }
        assertTrue(cards.getValue("workshop").isNew)
        assertFalse(cards.getValue("lodge").isNew); assertFalse(cards.getValue("market").isNew)
        assertFalse(cards.getValue("harvester").isNew); assertFalse(cards.getValue("berth").isNew)
        assertEquals("the DEFENCES tab carries the gold NEW badge", BadgeTone.REWARD, ui.tabs.single { it.id == LiveTrayTabs.DEFENCES }.badge?.tone)
        assertNull("the open tab carries none", ui.tabs.single { it.id == LiveTrayTabs.BUILDINGS }.badge)
        assertEquals(LiveTrayTabs.BUILDINGS, newlyUnlockedTab(f))
        assertTrue("without the set nothing is NEW", liveBuildTrayUi(f, LiveTrayTabs.BUILDINGS).sections.flatMap { it.cards }.none { it.isNew })
        val onlyEconomy = liveBuildTrayUi(f, LiveTrayTabs.BUILDINGS, newTypes = setOf("vault"))
        assertEquals("a section with a NEW card sorts first", "ECONOMY", traySections(onlyEconomy.sections).first().title)
    }

    @Test fun `placement admits a hero offer and its PLACE only opens the recruitment review`() {
        val f = PlacementFacts(type = "heroaltar", name = "VEX · ALTAR", art = "hero_vex_portrait", footprint = 2, tile = 3 to 4,
            currency = null, amount = null, amountRaw = null, time = "1h", shardsBalance = "40943", freeBuilders = 1, totalBuilders = 2,
            nextBuilderFreeIn = null, available = true, readOnly = false, constructionBlocked = false, busy = false, heroOffer = true,
            heroPrice = "Up to 2,500 KEEP, or 1 hero contract if available", heroMaxKeep = "2,500")
        val ui = requireNotNull(livePlacementUi(f))
        assertEquals(PlacementState.VALID, ui.state)
        assertEquals(f.heroPrice, ui.priceLine)
        assertEquals(PlaceTap.PLACE, placeLook(ui.state, ui.price, ui.reason).tap)
        val calls = mutableListOf<String>()
        dispatchPlace(ui, hero = true, onPlace = { calls += "place" }, onReviewHero = { calls += "review" }) { calls += "explain $it" }
        assertEquals("PLACE opens HeroAltarConfirm, never the Shards order", listOf("review"), calls)

        assertNull("without the offer's words the legacy dialog keeps it", livePlacementUi(f.copy(heroPrice = null)))
        val blocked = requireNotNull(livePlacementUi(f.copy(heroBlocked = HERO_RECRUIT_BUSY)))
        assertEquals(PlacementState.BLOCKED, blocked.state)
        calls.clear()
        dispatchPlace(blocked, hero = true, onPlace = { calls += "place" }, onReviewHero = { calls += "review" }) { calls += it }
        assertEquals(listOf(HERO_RECRUIT_BUSY), calls)
        assertEquals("no builder routes to Builders", PlacementState.NO_BUILDER, livePlacementUi(f.copy(freeBuilders = 0))?.state)
        assertEquals("walls keep drag-to-paint", null, livePlacementUi(f.copy(type = "wall", heroOffer = false)))
    }

    @Test fun `the placement reader carries the hero offer's words only for a hero draft`() {
        val state = KingdomUiState(home = BaseState(base = BaseSnapshot("b1", null, PlayerSummary(keepLevel = 6, builders = 2),
            null, null, null, emptyList(), emptyList(), emptyList(), 1,
            buildJsonObject { putJsonArray("buildings") { addJsonObject { put("id", "c1"); put("type", "cannon"); put("level", 1) } } })),
            local = KingdomLocal(placement = PlacementDraft("heroaltar", 2 to 3)))
        val h = heroes()
        val f = requireNotNull(readPlacementFacts(state, busy = false, now = 0L, heroOffer = true, heroes = h))
        assertEquals(h.offers.single().priceLabel(), f.heroPrice)
        assertEquals("2,500", f.heroMaxKeep)
        assertEquals("1h", f.time)
        assertNull(f.heroBlocked)
        assertNull("no recruitment state: no hero words", readPlacementFacts(state, busy = false, now = 0L, heroOffer = true)?.heroPrice)
        assertEquals(HERO_RECRUIT_UNSUPPORTED, readPlacementFacts(state, false, 0L, true, heroes(supported = false))?.heroBlocked)
    }

    @Test fun `a shards placement still sends its own order`() {
        val f = PlacementFacts(type = "barracks", name = "BARRACKS", art = "", footprint = 3, tile = 4 to 7, currency = "SHARDS",
            amount = "1,500", amountRaw = "1500", time = "2h", shardsBalance = "40943", freeBuilders = 1, totalBuilders = 2,
            nextBuilderFreeIn = null, available = true, readOnly = false, constructionBlocked = false, busy = false, heroOffer = false)
        val calls = mutableListOf<String>()
        dispatchPlace(livePlacementUi(f), hero = false, onPlace = { calls += "place" }, onReviewHero = { calls += "review" }) { calls += it }
        assertEquals(listOf("place"), calls)
        assertEquals("Drag to move · PLACE when green", livePlacementUi(f)?.hint)
        assertEquals("Red tiles are taken. Drag it clear.", livePlacementUi(f.copy(spaceReason = "Spot is blocked"))?.hint)
    }
}
