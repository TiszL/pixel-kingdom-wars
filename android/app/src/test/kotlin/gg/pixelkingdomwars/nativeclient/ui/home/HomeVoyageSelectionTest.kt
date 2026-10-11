package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.NamePlateUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyageFx
import org.junit.Assert.*
import org.junit.Test

/**
 * The selected Lodge and Berth on Home (voyage SPEC §1 `lodge-selected.png`, §10 entry). Why it matters: the plate is
 * the player's only at-a-glance trip status, so it must never claim "No boat yet" or "All docked" before both the
 * starter and the crafted fleet are known; COLLECT must only replace EXPLORE when a collect owner can actually take the
 * tap (a renamed button that still opens a sheet is a lie); and a building job owns the primary, so the voyage rules
 * must never steal FINISH from a player who is paying to finish an upgrade.
 */
class HomeVoyageSelectionTest {
    private val fx = VoyageFx
    private val lodge = Building("lodge-1", "lodge", 4, 0, 0)
    private val berth = Building("berth-1", "berth", 5, 4, 0)
    private val blankPlate = NamePlateUi("EXPLORATION LODGE", "LV 4", null, null)
    private val fleet = arrayOf(fx.row("inst-cut", "cargo_cutter", 2, 7), fx.row("inst-bal", "survey_balloon", 1, 9))

    private fun back(id: String) =
        fx.expedition(id, "inst-cut", "glasswake-1", "2030-01-01T15:00:00.000Z", "2030-01-01T18:00:00.000Z", net = "40")
    private fun sailing(id: String, installationId: String, returns: String) =
        fx.expedition(id, installationId, "glasswake-1", "2030-01-01T18:00:00.000Z", returns)

    /** A kingdom whose starter boat is docked and whose crafted fleet is known, with [records] in its journal. */
    private fun kingdom(vararg records: VehicleRecord) = fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet(),
        vehicles = fx.vehicles(fx.fleet(*fleet), pending = records.toList()))

    private fun command(id: String, caption: String, primary: Boolean = false, state: CommandState = CommandState.ENABLED,
        verb: Verb = Verb.STONE) = CommandUi(FeatureId(id), "ui:lodge-menu", caption, null, primary, state,
        if (state == CommandState.ENABLED) null else "Upgrading", null, verb)

    private val info = command("building.info", "INFO", verb = Verb.BLUE)
    private val passport = command("lodge.passport", "PASSPORT")
    private fun lodgeBar(explore: CommandUi = command("lodge.expedition", "EXPLORE", primary = true), vararg tail: CommandUi) =
        CommandBarUi("lodge-1", listOf(info, passport, command("building.upgrade", "UPGRADE", verb = Verb.GREEN), explore) + tail)
    private fun berthBar(vararg commands: CommandUi) = CommandBarUi("berth-1", listOf(info) + commands)
    private fun CommandBarUi.byId(id: String): CommandUi = commands.single { it.id == FeatureId(id) }

    @Test fun `lodge plate says how many are at sea and when the next one is back`() {
        val atSea = requireNotNull(voyageSelectionUi(kingdom(sailing("e3", "inst-cut", "2030-01-01T21:00:00.000Z"),
            sailing("e4", "inst-bal", "2030-01-01T19:32:00.000Z")), collectAvailable = false))
        assertEquals("SPEC 1: the soonest return", "2 at sea · back 1h 12m", voyageNamePlate(blankPlate, lodge, atSea).stateLine)
        val ready = requireNotNull(voyageSelectionUi(kingdom(back("e1")), collectAvailable = false))
        assertEquals("Ready · 1 back", voyageNamePlate(blankPlate, lodge, ready).stateLine)
        val docked = requireNotNull(voyageSelectionUi(kingdom(), collectAvailable = false))
        assertEquals("All docked", voyageNamePlate(blankPlate, lodge, docked).stateLine)
        val none = requireNotNull(voyageSelectionUi(fx.inputs(starter = fx.starter(fx.starterView(installation = null)),
            starterFleet = fx.starterFleet(installation = null), vehicles = fx.vehicles(fx.fleet())), collectAvailable = false))
        assertEquals("both sides known and empty", "No boat yet", voyageNamePlate(blankPlate, lodge, none).stateLine)
        val berthPlate = NamePlateUi("BERTH", "LV 5", null, null)
        assertEquals("the trip line belongs to the Lodge only", berthPlate, voyageNamePlate(berthPlate, berth, atSea))
    }

    @Test fun `no boat yet is said only when both the starter and the crafted fleet are known`() {
        // The starter side says "no starter boat", but the crafted fleet has not been read: a crafted boat may exist.
        val half = requireNotNull(voyageSelectionUi(fx.inputs(starter = fx.starter(fx.starterView(installation = null)),
            starterFleet = fx.starterFleet(installation = null)), collectAvailable = false))
        assertFalse(half.complete)
        assertEquals(false, half.starterInstalled)
        assertNull("an unknown fleet never reads as No boat yet", voyageNamePlate(blankPlate, lodge, half).stateLine)
    }

    @Test fun `a running job line keeps priority over the trip line`() {
        val selection = requireNotNull(voyageSelectionUi(kingdom(back("e1")), collectAvailable = true))
        val upgrading = blankPlate.copy(stateLine = "Upgrading · 2h", progress = 0.5f)
        assertEquals("DS 3.3 building states outrank the trip line", upgrading, voyageNamePlate(upgrading, lodge, selection))
    }

    @Test fun `explore becomes collect only when a collect owner is mounted`() {
        val withoutOwner = voyageCommandBar(lodgeBar(), lodge, voyageSelectionUi(kingdom(back("e1")), collectAvailable = false))
        val explore = withoutOwner.byId("lodge.expedition")
        assertEquals("no owner to take the tap: it stays EXPLORE and opens the Lodge", "EXPLORE", explore.caption)
        assertEquals(BadgeUi("!", BadgeTone.READY, "A trip is back"), explore.badge)
        val withOwner = voyageCommandBar(lodgeBar(), lodge, voyageSelectionUi(kingdom(back("e1")), collectAvailable = true))
        val collect = withOwner.byId("lodge.expedition")
        assertEquals("COLLECT", collect.caption)
        assertEquals("ui:ready-status", collect.icon)
        assertTrue("the primary designation is untouched", collect.primary)
        assertEquals(CommandState.ENABLED, collect.state)
        val off = voyageCommandBar(lodgeBar(command("lodge.expedition", "EXPLORE", primary = true, state = CommandState.DISABLED)),
            lodge, voyageSelectionUi(kingdom(back("e1")), collectAvailable = true))
        assertEquals("a disabled EXPLORE never becomes a working COLLECT", "EXPLORE", off.byId("lodge.expedition").caption)
        assertEquals(CommandState.DISABLED, off.byId("lodge.expedition").state)
        val atSea = voyageCommandBar(lodgeBar(), lodge, voyageSelectionUi(kingdom(sailing("e3", "inst-cut", "2030-01-01T21:00:00.000Z"),
            sailing("e4", "inst-bal", "2030-01-01T19:32:00.000Z")), collectAvailable = true))
        assertEquals("nothing back: EXPLORE with the red count at sea", "EXPLORE", atSea.byId("lodge.expedition").caption)
        assertEquals(BadgeUi("2", BadgeTone.COUNT, "2 at sea"), atSea.byId("lodge.expedition").badge)
    }

    @Test fun `an active finish keeps its primary on the Lodge and the Berth`() {
        val finish = command("building.finish", "FINISH", primary = true)
        val lodgeJob = voyageCommandBar(lodgeBar(command("lodge.expedition", "EXPLORE"), finish), lodge,
            voyageSelectionUi(kingdom(back("e1")), collectAvailable = true))
        assertEquals("FINISH stays the one primary", listOf(FeatureId("building.finish")), lodgeJob.commands.filter { it.primary }.map { it.id })
        assertEquals("the trip still collects as a secondary", "COLLECT", lodgeJob.byId("lodge.expedition").caption)
        val starterless = voyageSelectionUi(fx.inputs(starter = fx.starter(fx.starterView(installation = null)),
            starterFleet = fx.starterFleet(installation = null), vehicles = fx.vehicles(fx.fleet())), collectAvailable = true)
        val berthJob = voyageCommandBar(berthBar(command("berth.fleet", "FLEET", state = CommandState.DISABLED), finish), berth, starterless)
        assertEquals(listOf(FeatureId("building.finish")), berthJob.commands.filter { it.primary }.map { it.id })
        assertEquals("the waiting starter is still flagged", BadgeTone.READY, berthJob.byId("berth.fleet").badge?.tone)
        assertEquals(CommandState.DISABLED, berthJob.byId("berth.fleet").state)
    }

    @Test fun `berth fleet becomes the gold primary and flags an uninstalled starter`() {
        val bar = berthBar(command("berth.fleet", "FLEET"), command("building.upgrade", "UPGRADE", primary = true, verb = Verb.GREEN))
        val starterless = voyageSelectionUi(fx.inputs(starter = fx.starter(fx.starterView(installation = null)),
            starterFleet = fx.starterFleet(installation = null), vehicles = fx.vehicles(fx.fleet())), collectAvailable = true)
        val waiting = voyageCommandBar(bar, berth, starterless)
        val fleetCommand = waiting.commands.last()
        assertEquals("FLEET is the primary, last for the right thumb", FeatureId("berth.fleet"), fleetCommand.id)
        assertTrue(fleetCommand.primary)
        assertEquals("a primary left at STONE draws gold", Verb.STONE, fleetCommand.verb)
        assertEquals(BadgeUi("!", BadgeTone.READY, "Starter Boat waiting"), fleetCommand.badge)
        val upgrade = waiting.byId("building.upgrade")
        assertFalse("UPGRADE steps back, as on the Lodge", upgrade.primary)
        assertEquals(Verb.GREEN, upgrade.verb)
        assertEquals(1, waiting.commands.count { it.primary })
        val installed = voyageCommandBar(bar, berth, voyageSelectionUi(kingdom(), collectAvailable = true))
        assertTrue(installed.byId("berth.fleet").primary)
        assertNull("an installed starter needs no flag", installed.byId("berth.fleet").badge)
        val mine = Building("mine-1", "mine", 3, 8, 0)
        val mineBar = CommandBarUi("mine-1", listOf(info, command("building.upgrade", "UPGRADE", primary = true, verb = Verb.GREEN)))
        assertEquals("the voyage rules never touch another building's primary", mineBar, voyageCommandBar(mineBar, mine, starterless))
    }

    @Test fun `collect tap is recognised only on the swapped command`() {
        val swapped = voyageCommandBar(lodgeBar(), lodge, voyageSelectionUi(kingdom(back("e1")), collectAvailable = true))
        assertTrue(voyageCommandCollects(FeatureId("lodge.expedition"), swapped))
        val unswapped = voyageCommandBar(lodgeBar(), lodge, voyageSelectionUi(kingdom(back("e1")), collectAvailable = false))
        assertFalse("EXPLORE keeps opening the Lodge", voyageCommandCollects(FeatureId("lodge.expedition"), unswapped))
        assertFalse("other commands keep their own route", voyageCommandCollects(FeatureId("building.upgrade"), swapped))
        assertFalse(voyageCommandCollects(FeatureId("lodge.expedition"), null))
        val offCollect = lodgeBar(command("lodge.expedition", "COLLECT", primary = true, state = CommandState.BUSY))
        assertFalse("a busy COLLECT is never sent twice", voyageCommandCollects(FeatureId("lodge.expedition"), offCollect))
    }

    @Test fun `unknown snapshot leaves the plate and the bar untouched`() {
        assertNull("no starter view and no fleet snapshot: nothing is known", voyageSelectionUi(fx.inputs(), collectAvailable = true))
        assertEquals(blankPlate, voyageNamePlate(blankPlate, lodge, null))
        val bar = lodgeBar()
        assertEquals(bar, voyageCommandBar(bar, lodge, null))
        assertEquals("a bar for another building is never decorated", bar,
            voyageCommandBar(bar, lodge.copy(id = "lodge-2"), voyageSelectionUi(kingdom(back("e1")), collectAvailable = true)))
        // The FLEET primary is the design's, not data; with nothing known it carries no "!".
        val berthResult = voyageCommandBar(berthBar(command("berth.fleet", "FLEET"),
            command("building.upgrade", "UPGRADE", primary = true, verb = Verb.GREEN)), berth, null)
        assertNull(berthResult.byId("berth.fleet").badge)
    }
}
