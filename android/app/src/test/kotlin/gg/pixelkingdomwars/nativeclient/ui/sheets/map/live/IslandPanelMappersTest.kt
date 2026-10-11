package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.ClanMember
import gg.pixelkingdomwars.nativeclient.model.ClanMembership
import gg.pixelkingdomwars.nativeclient.model.MyClan
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEActivity
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.AuctionPhase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The World tab's Seeker, Solana and Divine sheets replace the "ISLAND · COMING SOON" panel. No auction, licence or island
 * scene repository exists on this client, so these sheets must be honest: every count comes from the catalogue or reads
 * "…", nothing is priced that the World tab cannot price, and every door either opens an existing owner or says why not.
 */
class IslandPanelMappersTest {
    /** A catalogue whose Seeker numbers are deliberately not the design mock's 100 / 20 / 7 days. */
    private val seekerCatalogue = json("""{"constants":{
        "PHASE_E_POLICY":{"basisPoints":10000,"seekerIsland":{"totalSpots":37,"kingSpots":9,"realmCount":8,
            "paidContractsPerSpotDayMax":10,"permitDurationSec":259200,"permitPriceLamports":50000000,
            "contractSellerBps":8000,"contractDevBps":2000}},
        "PHASE_E_SEEKER_SALE":{"version":1,"quoteTtlSec":60},
        "PHASE_E_SEEKER_AUCTION":{"regularRealmCount":7},
        "PHASE_E_MINING_PUBLICATION":{"daySec":86400}}}""")
    private val lodge = Building("b-lodge", "lodge", 2, 10, 12)
    private val berth = Building("b-berth", "berth", 1, 14, 12)
    private val keep = Building("b-keep", "keep", 3, 20, 20)
    private fun inClan() = ClanMembership(MyClan("12345678-1234-4678-9abc-def012345678", "Iron Wardens", "IRN", "open", WALLET, null,
        listOf(ClanMember(WALLET, "2030-01-01T00:00:00Z", "Mira", 7, 1200, false))))

    @Test fun `seeker is server off and its ENTER ISLAND is locked with a reason that a tap shows`() {
        // Why: there is no auction repository, so the panel must never look live, and a locked primary that toasted nothing
        // would be a door that does nothing.
        val ui = seekerPanelUi(seekerCatalogue)
        assertEquals("seeker-island", ui.panel.islandId)
        assertEquals(AuctionPhase.SERVER_OFF, ui.phase)
        assertEquals(UNKNOWN, ui.mySpots); assertEquals(UNKNOWN, ui.myBids); assertTrue(ui.alerts.isEmpty())
        assertFalse(ui.error); assertFalse(ui.testData)
        val enter = ui.panel.primary
        assertEquals("ENTER ISLAND", enter.caption)
        assertEquals("the SeekerPanel routes a non-enabled primary to onPrimaryRefused", CommandState.LOCKED, commandDrawState(enter))
        assertEquals("Seeker Island opens later on this server", enter.reason)
        val said = mutableListOf<String>(); var closed = 0
        val on = seekerPanelActions({ said += it }, { closed++ })
        on.onPrimaryRefused(enter); on.onClose()
        assertEquals(listOf("Seeker Island opens later on this server"), said); assertEquals(1, closed)
    }

    @Test fun `seeker spot counts and permit term come from the catalogue and read unknown without one`() {
        // Why: a game number lives only in the catalogue; a hardcoded "100 spots, 20 of them King" or "7 days" would lie
        // the day the server changes them.
        val ui = seekerPanelUi(seekerCatalogue)
        assertEquals("37 spots, 9 of them King.", ui.catalogueLine)
        assertEquals("the D-070 duration words of permitDurationSec", "Win a trading spot to sell realm permits for 3d.", ui.panel.stateLine)
        for (text in listOf(ui.catalogueLine, ui.panel.stateLine)) assertFalse(text, Regex("100|20 of|7 days").containsMatchIn(text))
        val none = seekerPanelUi(null)
        assertEquals(UNKNOWN, none.catalogueLine)
        assertEquals("no invented term without the catalogue", "Win a trading spot to sell realm permits.", none.panel.stateLine)
        assertEquals("an incomplete policy is unknown, never a partial guess", UNKNOWN, seekerPanelUi(json("""{"constants":{}}""")).catalogueLine)
    }

    @Test fun `solana price is unavailable rather than a number and no queue or family is invented`() {
        // Why: the World tab has no crafting price owner; a number here would be a price the player never gets quoted.
        val ui = publicWorkshopUi(listOf(keep, lodge))
        assertEquals(Currency.SOL, ui.price.currency)
        assertEquals(PriceStatus.UNAVAILABLE, ui.price.status); assertNull(ui.price.amount)
        assertTrue(ui.families.isEmpty())
        assertEquals("Public queue is not shown on this server yet", ui.queueLine)
        assertEquals("CRAFT stays a door (it hands over to the vehicle owner's craft page)", CommandState.ENABLED, ui.state)
    }

    @Test fun `unknown buildings never claim no Lodge while a read kingdom without one does`() {
        // Why: telling a player with a Lodge to build one, only because the Home read has not landed, sends them away.
        assertFalse(publicWorkshopUi(null).noLodge)
        assertTrue(publicWorkshopUi(emptyList()).noLodge)
        assertTrue(publicWorkshopUi(listOf(keep, berth)).noLodge)
        assertFalse(publicWorkshopUi(listOf(keep, lodge)).noLodge)
    }

    @Test fun `CRAFT opens the vehicle owner's craft page, never the base screen, and explains when there is none`() {
        // Rewritten for the owner's 2026-10-06 report: CRAFT VEHICLE used to select the Berth (else the Lodge), which switched
        // to the Kingdom tab and left the player on the base screen with nothing crafted. Why the new rule: map SPEC §4.1 has
        // CRAFT open the one fleet-command vehicle owner's crafting (the same craft page every Solana craft door opens), so
        // the World tab still never runs a second crafting owner, never selects a building, and a tap is never silent.
        val focused = mutableListOf<String>(); var built = 0; val said = mutableListOf<String>(); var crafted = 0
        fun on(buildings: List<Building>?, craft: (() -> Unit)? = { crafted++ }) =
            publicWorkshopActions(buildings, craft, { focused += it }, { built++ }, { said += it }, {})
        on(listOf(keep, lodge, berth)).onCraft(null)
        on(listOf(keep, lodge)).onCraft(null)
        on(null).onCraft(null)
        on(listOf(keep, lodge, berth)).onCraft(gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily.CARGO_CUTTER)
        assertEquals("every CRAFT tap opens the craft page, whatever the kingdom read says", 4, crafted)
        assertTrue("no building is selected: the base screen is never the answer", focused.isEmpty())
        assertEquals(0, built); assertTrue(said.isEmpty())
        // No vehicle owner in this session: the same sentence as the Home doors, never a silent tap or a building hop.
        on(listOf(keep, lodge, berth), craft = null).onCraft(null)
        assertEquals(listOf(VEHICLE_CRAFT_UNAVAILABLE), said); assertTrue(focused.isEmpty()); assertEquals(4, crafted)
        // GO TO LODGE (drawn only when the kingdom has none): the build menu offers it; a built Lodge is selected
        on(listOf(keep)).onGoLodge()
        assertEquals(1, built)
        on(listOf(keep, lodge)).onGoLodge()
        assertEquals("b-lodge", focused.last())
    }

    @Test fun `divine doors lock with Opens later when the catalogue has no trials`() {
        // Why: the server feature being off must read as off on both the WEST door and the SOLO TRIALS primary, each with
        // the reason a tap shows.
        val off = divinePanelUi(437, 1234, false, null)
        assertTrue(off.solo.locked); assertEquals("Opens later on this server", off.solo.reason)
        assertEquals(CommandState.LOCKED, commandDrawState(off.primary)); assertEquals("Opens later on this server", off.primary.reason)
        assertEquals("SOLO TRIALS", off.primary.caption)
        val on = divinePanelUi(437, 1234, true, null)
        assertFalse(on.solo.locked); assertNull(on.solo.reason)
        assertEquals(CommandState.ENABLED, commandDrawState(on.primary)); assertNull(on.primary.reason)
        // the counts are the catalogue's, grouped; unknown counts and the fragment total read "…", never 0
        assertEquals("437 solo areas", on.solo.sub); assertEquals("1,234 clan areas", on.clan.sub)
        val unknown = divinePanelUi(null, null, true, null)
        assertEquals(UNKNOWN, unknown.solo.sub); assertEquals(UNKNOWN, unknown.clan.sub); assertEquals(UNKNOWN, unknown.fragments)
        assertFalse("no catalogue configures no trials", divineTrialsConfigured(null))
        assertFalse(divineTrialsConfigured(json("""{"constants":{}}""")))
    }

    @Test fun `the Clan Citadels door locks with the Clan Hall reason only when membership says no clan`() {
        // Why: an unread membership is not "no clan"; locking then would send a clan member to the Clan Hall. The tournament
        // owner behind the open door shows the real state.
        val unread = divinePanelUi(500, 50, true, null).clan
        assertFalse(unread.locked); assertNull(unread.reason)
        val none = divinePanelUi(500, 50, true, ClanMembership(null))
        assertTrue(none.clan.locked); assertEquals("Citadels: join a clan at the Clan Hall", none.clan.reason)
        assertTrue("the reason line is the GO to the Clan Hall", none.clanHallLink)
        val member = divinePanelUi(500, 50, true, inClan()).clan
        assertFalse(member.locked); assertNull(member.reason)
    }

    @Test fun `every Divine door opens its existing owner and the Clan Hall line opens the Clan Hall`() {
        // Why: the Divine owners live in the Bases route; the World tab only navigates there, never a second owner.
        val opened = mutableListOf<PhaseEActivity>(); var hall = 0; var closed = 0; val said = mutableListOf<String>()
        val on = divinePanelActions({ opened += it }, { hall++ }, { said += it }, { closed++ })
        on.onSolo(); on.onFragments(); on.onClan(); on.onClanHall(); on.onExplain("Opens later on this server"); on.onClose()
        assertEquals(listOf(PhaseEActivity.DIVINE_TRIALS, PhaseEActivity.FRAGMENTS, PhaseEActivity.TOURNAMENTS), opened)
        assertEquals(1, hall); assertEquals(1, closed); assertEquals(listOf("Opens later on this server"), said)
    }

    @Test fun `a routine refresh that reads nothing keeps the value already shown`() {
        // Why: a count that flickers to "…" on every poll reads as lost data; only a new value replaces a shown one.
        val kept = IslandLastKnown<Int>()
        assertNull("nothing shown yet stays unknown", kept.keep(null))
        assertEquals(500, kept.keep(500))
        assertEquals(500, kept.keep(null))
        assertEquals(480, kept.keep(480))
    }
}
