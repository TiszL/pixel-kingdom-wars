package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.data.HarvesterState
import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingState
import gg.pixelkingdomwars.nativeclient.data.WorkshopState
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterCommand
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterEvent
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterFacility
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterFeature
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterFeatures
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterIdentity
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterJournal
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterOperation
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterPolicy
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterProof
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterReceipt
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterRequest
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterSettlement
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterSource
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterSummary
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterTerm
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterView
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingFeature
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingFeatures
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingIdentity
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingInput
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingJournal
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingOutput
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingPendingJob
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingRecipe
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingView
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionHome
import gg.pixelkingdomwars.nativeclient.ui.command.BuildingCommandPresentation
import gg.pixelkingdomwars.nativeclient.ui.command.buildingCommands
import gg.pixelkingdomwars.nativeclient.ui.features.BuildingGateState
import gg.pixelkingdomwars.nativeclient.ui.features.BuildingSelection
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureRegistry
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureSelection
import gg.pixelkingdomwars.nativeclient.ui.features.GateContext
import gg.pixelkingdomwars.nativeclient.ui.features.GateFact
import gg.pixelkingdomwars.nativeclient.ui.home.HomeEconomyRouteHost
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteDispatcher
import gg.pixelkingdomwars.nativeclient.ui.kit.orderCommands
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.READY_BADGE
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopAllowance
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopBatch
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopDaily
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopFeature
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopFeatures
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopHolding
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopIdentity
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopInventory
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopJob
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopJournal
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopLegacyHolding
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * craft SPEC §2.0 (`workshop-selected.png`) with TRADE★ / HARVEST★: a selected Workshop, Market or Harvester puts the
 * building's own job under the right thumb as the one gold primary, UPGRADE stays a green secondary with its price, and the
 * door's badge comes only from the owners' current observations (never a guess for another base or wallet). The door still
 * only navigates through C3; nothing here spends, collects or marks a haul seen.
 */
class CraftBuildingCommandsTest {
    private companion object {
        val DOORS = linkedMapOf("workshop" to "workshop.craft", "market" to "market.trade", "harvester" to "harvester.harvest")
        val CAPTIONS = mapOf("workshop" to "CRAFT", "market" to "TRADE", "harvester" to "HARVEST")
        const val OTHER_BASE = "00000000-0000-4000-8000-000000000009"
        const val OTHER_WALLET = "11111111111111111111111111111112"
        const val NOW = "2026-10-04T07:00:00.000Z"
    }

    private fun building(type: String, underConstruction: Boolean = false) =
        Building("actual-$type-instance", type, 2, 0, 0, underConstruction = underConstruction)
    private fun selection(b: Building) = BuildingSelection(BASE_ID, b.id, b.type)
    private fun info() = CommandUi(BuildingCommandIds.INFO, "shape:info", "INFO", null, false, CommandState.ENABLED, null, null, Verb.BLUE)
    private fun upgrade() = CommandUi(BuildingCommandIds.UPGRADE, "shape:up", "UPGRADE",
        PriceUi(Currency.SHARDS, "18,000", PriceStatus.OK), true, CommandState.ENABLED, null, null, Verb.GREEN, "4h")
    private fun finish() = CommandUi(BuildingCommandIds.FINISH, "timer", "FINISH", null, true, CommandState.ENABLED, null, null,
        Verb.STONE, "3:48")
    private fun merge(type: String, facts: CraftCommandFacts? = null, commands: List<CommandUi> = listOf(info(), upgrade()),
        host: ProjectingHost = ProjectingHost(facts)): CommandBarUi {
        val b = building(type)
        return mergePhaseEBuildingCommands(CommandBarUi(b.id, commands, "Existing hint"), b, selection(b), host)
    }

    /** The real registry projection (canonical rows, the presentation the merge hands over) behind a selected building. */
    private class ProjectingHost(private val facts: CraftCommandFacts?) : PhaseEBuildingCommands {
        val asked = mutableListOf<String>()
        val presentations = mutableListOf<BuildingCommandPresentation>()
        val opened = mutableListOf<Pair<FeatureId, BuildingSelection>>()
        override fun buildingCommandBar(building: Building, presentation: BuildingCommandPresentation): CommandBarUi {
            presentations += presentation
            return buildingCommands(building, GateContext(baseId = BASE_ID,
                buildings = mapOf(building.type to BuildingGateState(building.level, true)),
                serverFeatures = mapOf("phaseE.harvesters" to GateFact.Allowed),
                selection = FeatureSelection(building = BuildingSelection(BASE_ID, building.id, building.type))),
                FeatureRegistry.canonical(), presentation)
        }
        override fun openBuildingDoor(id: FeatureId, selection: BuildingSelection) { opened += id to selection }
        override fun craftFacts(type: String): CraftCommandFacts? { asked += type; return facts }
    }

    /** A fixed owner projection, for the types whose own rule must not change. */
    private class FixedHost(private val projected: CommandBarUi, private val facts: CraftCommandFacts?) : PhaseEBuildingCommands {
        val asked = mutableListOf<String>()
        val presentations = mutableListOf<BuildingCommandPresentation>()
        override fun buildingCommandBar(building: Building, presentation: BuildingCommandPresentation): CommandBarUi {
            presentations += presentation
            return projected
        }
        override fun openBuildingDoor(id: FeatureId, selection: BuildingSelection) {}
        override fun craftFacts(type: String): CraftCommandFacts? { asked += type; return facts }
    }

    @Test fun `Workshop Market and Harvester show their own job as the last and only gold primary`() {
        for ((type, id) in DOORS) {
            val merged = merge(type)
            assertEquals(type, listOf(BuildingCommandIds.INFO, BuildingCommandIds.UPGRADE, FeatureId(id)), merged.commands.map { it.id })
            assertEquals(type, listOf(FeatureId(id)), merged.commands.filter { it.primary }.map { it.id })
            val door = merged.commands.last()
            assertEquals(type, CAPTIONS.getValue(type), door.caption)
            // The kit CommandMedallion draws a STONE primary gold; any other verb would repaint the building's own job.
            assertEquals(type, Verb.STONE, door.verb)
            assertEquals(type, CommandState.ENABLED, door.state)
            // Already in kit order (INFO, secondaries, primary last), so the bar never reshuffles under the thumb.
            assertEquals(type, merged.commands, orderCommands(merged.commands, 4))
        }
    }

    @Test fun `UPGRADE keeps its green verb price pill and time as a secondary`() {
        // The player must still see what the next level costs; only the designation moves to the craft verb.
        for (type in DOORS.keys) {
            val merged = merge(type)
            assertEquals(type, upgrade().copy(primary = false), merged.commands.single { it.id == BuildingCommandIds.UPGRADE })
            assertEquals(type, info(), merged.commands.first())
            assertEquals(type, "Existing hint", merged.hint)
        }
    }

    @Test fun `an active FINISH keeps the primary and the craft door waits before it as a secondary`() {
        // Never manufacture a new primary during a building job: the owner's FINISH stays under the thumb.
        for ((type, id) in DOORS) {
            val merged = merge(type, commands = listOf(info(), finish()))
            assertEquals(type, listOf(BuildingCommandIds.INFO, FeatureId(id), BuildingCommandIds.FINISH), merged.commands.map { it.id })
            assertEquals(type, listOf(finish()), merged.commands.filter { it.primary })
            assertEquals(type, merged.commands, orderCommands(merged.commands, 4))
        }
    }

    @Test fun `an unfinished craft building keeps its original bar because no door is projected`() {
        // A door that cannot act must not appear, and UPGRADE or FINISH must not lose its designation to nothing.
        for (type in DOORS.keys) {
            val b = building(type, underConstruction = true)
            val original = CommandBarUi(b.id, listOf(info(), finish()))
            assertEquals(type, original, mergePhaseEBuildingCommands(original, b, selection(b), ProjectingHost(CraftCommandFacts(1, true))))
        }
    }

    @Test fun `Lodge and Berth keep their own rules and are never asked for craft facts`() {
        val lodge = building("lodge")
        val explore = CommandUi(FeatureId("lodge.expedition"), "ui:lodge-menu", "EXPLORE", null, true, CommandState.ENABLED, null, null)
        val lodgeHost = FixedHost(CommandBarUi(lodge.id, listOf(explore)), CraftCommandFacts(2, true))
        val lodgeMerged = mergePhaseEBuildingCommands(CommandBarUi(lodge.id, listOf(info(), upgrade())), lodge, selection(lodge), lodgeHost)
        assertEquals(listOf(info(), upgrade().copy(primary = false), explore), lodgeMerged.commands)
        assertTrue(lodgeHost.asked.isEmpty())
        val lodgeEntry = lodgeHost.presentations.single().entries.getValue(FeatureId("lodge.expedition"))
        assertNull(lodgeEntry.badge); assertFalse(lodgeEntry.readyToCollect); assertEquals("ui:lodge-menu", lodgeEntry.icon)

        val berth = building("berth")
        val fleet = CommandUi(FeatureId("berth.fleet"), "shape:anchor", "FLEET", null, false, CommandState.ENABLED, null, null)
        val berthHost = FixedHost(CommandBarUi(berth.id, listOf(fleet)), CraftCommandFacts(2, true))
        val berthMerged = mergePhaseEBuildingCommands(CommandBarUi(berth.id, listOf(info(), upgrade())), berth, selection(berth), berthHost)
        assertEquals(listOf(info(), fleet, upgrade()), berthMerged.commands)
        assertTrue(berthHost.asked.isEmpty())
    }

    @Test fun `unknown facts show no badge and keep the designed caption and icon`() {
        // No observation is not zero: an empty corner is honest, a "0" or a stale "!" would not be.
        val host = ProjectingHost(null)
        val door = merge("workshop", host = host).commands.last()
        assertNull(door.badge); assertEquals("CRAFT", door.caption); assertEquals("ui:workshop-menu", door.icon)
        assertEquals(listOf("workshop"), host.asked)
    }

    @Test fun `running jobs show a red count on the craft door`() {
        val door = merge("workshop", CraftCommandFacts(2, false)).commands.last()
        assertEquals("2", door.badge?.text)
        assertEquals(BadgeTone.COUNT, door.badge?.tone)
        assertEquals("2 jobs running", door.badge?.description)
        assertEquals("CRAFT", door.caption); assertTrue(door.primary)
        // Nothing running is no badge, never a red zero.
        assertNull(merge("workshop", CraftCommandFacts(0, false)).commands.last().badge)
    }

    @Test fun `ready output shows the green ready badge and the COLLECT caption without becoming a spend`() {
        val host = ProjectingHost(CraftCommandFacts(1, true))
        val door = merge("workshop", host = host).commands.last()
        // Ready wins over the running count: the player's next tap is to collect.
        assertEquals(READY_BADGE, door.badge)
        assertEquals("COLLECT", door.caption)
        assertEquals("ui:ready-status", door.icon)
        assertTrue(door.primary); assertNull(door.price)
        val entry = host.presentations.single().entries.getValue(FeatureId("workshop.craft"))
        assertTrue(entry.readyToCollect); assertFalse(entry.spending)

        // An unseen Harvester haul uses the same grammar; SPEC 2.0 names the ready-status icon for the Workshop only.
        val haul = merge("harvester", CraftCommandFacts(null, true)).commands.last()
        assertEquals(READY_BADGE, haul.badge); assertEquals("COLLECT", haul.caption); assertEquals("ui:harvester-menu", haul.icon)
    }

    @Test fun `tapping the gold door opens its owner while UPGRADE still opens its review`() {
        for ((type, id) in DOORS) {
            val b = building(type)
            val host = ProjectingHost(CraftCommandFacts(1, true))
            var reviews = 0
            val routes = BuildingCommandRoutes({}, { reviews++ }, {}, {}, {}, {}, {}, {}, {}, {}, {})
            val merged = mergePhaseEBuildingCommands(CommandBarUi(b.id, listOf(info(), upgrade())), b, selection(b), host)
            routeBuildingCommand(merged.commands.single { it.primary }.id, merged, routes, host, selection(b))
            // COLLECT on the bar is navigation to the owner sheet; the owner does the collecting.
            assertEquals(type, listOf(FeatureId(id) to selection(b)), host.opened)
            assertEquals(type, 0, reviews)
            routeBuildingCommand(BuildingCommandIds.UPGRADE, merged, routes, host, selection(b))
            assertEquals(type, 1, reviews)
        }
    }

    @Test fun `craftBuildingCommands asks its provider only for the three craft buildings`() {
        val asked = mutableListOf<String>()
        val facts = CraftCommandFacts(2, false)
        val dispatcher = HomeRouteDispatcher(HomeRequests(), FeatureRegistry.canonical(), { null },
            HomeEconomyRouteHost({ false }, { false }, {}, {}))
        val commands = craftBuildingCommands(dispatcher) { type -> asked += type; facts }
        for (type in DOORS.keys) assertSame(type, facts, commands.craftFacts(type))
        for (type in listOf("lodge", "berth", "keep")) assertNull(type, commands.craftFacts(type))
        assertEquals(DOORS.keys.toList(), asked)
        // The one-argument producer stays badge-free, and the door wiring is still the dispatcher's own.
        assertNull(phaseEBuildingCommands(dispatcher).craftFacts("workshop"))
        assertNull(commands.buildingCommandBar(building("workshop")))
    }

    // ---------------------------------------------------------------------------------------------------- Workshop facts

    private fun ingotJob(id: String, ready: Boolean, collectedAt: String? = null) = WorkshopJob(id, 1, "17", 1, 1,
        "2026-10-04T00:00:00.000Z", "2026-10-04T00:01:01.000Z", ready, collectedAt)
    private fun ingots(jobs: List<WorkshopJob>, baseId: String = BASE_ID) = WorkshopState(
        WorkshopJournal(1, WorkshopIdentity("https://example.invalid", "devnet", WALLET), 0, null, emptyList()),
        WorkshopView(WorkshopFeatures(WorkshopFeature(1, 1, 1)), true, 1, 1, 17, WorkshopBatch(3, 9), 61,
            WorkshopInventory(baseId, 1, 1),
            WorkshopAllowance(1, "free_wallet", "2026-10-04T00:00:00.000Z", "2026-10-05T00:00:00.000Z", 2,
                WorkshopDaily(6, 2, 4), WorkshopHolding(3, 2, 0, 0, 14, 9)), 6, 1,
            WorkshopLegacyHolding(1, 0, 0, 1, 14), 2, jobs, NOW), advertised = true)
    private val recipe = OrdinaryCraftingRecipe(1, "refine_frostglass", 1, 17,
        listOf(OrdinaryCraftingInput("raw", "frost_quartz", "13")), OrdinaryCraftingOutput("frostglass", "3"))
    private fun refining(pending: Int, wallet: String = WALLET, baseId: String = BASE_ID) = OrdinaryCraftingState(
        OrdinaryCraftingJournal(1, OrdinaryCraftingIdentity("https://example.invalid", "devnet", WALLET), 0, null, emptyList()),
        OrdinaryCraftingView(wallet, baseId, OrdinaryCraftingFeatures(OrdinaryCraftingFeature(1, 1)), true, 1, 7,
            listOf(recipe), emptyList(), emptyList(),
            List(pending) { OrdinaryCraftingPendingJob("refine-$it", recipe, NOW, "2026-10-04T07:00:17.000Z") }, NOW),
        advertised = true)

    @Test fun `Workshop facts count casting batches and refining jobs and flag an uncollected ready batch`() {
        val state = ingots(listOf(ingotJob("cast", ready = false), ingotJob("done", ready = true),
            ingotJob("taken", ready = true, collectedAt = NOW)))
        assertEquals(CraftCommandFacts(running = 3, ready = true), workshopCommandFacts(state, refining(2), WALLET, BASE_ID))
        // A collected batch is history: neither running nor waiting, so it cannot keep a stale "!".
        assertEquals(CraftCommandFacts(0, false),
            workshopCommandFacts(ingots(listOf(ingotJob("taken", true, NOW))), refining(0), WALLET, BASE_ID))
    }

    @Test fun `Workshop facts are null for a missing view or another base or wallet rather than a guess`() {
        val state = ingots(listOf(ingotJob("done", ready = true)))
        val refine = refining(1)
        assertNull(workshopCommandFacts(null, refine, WALLET, BASE_ID))
        assertNull(workshopCommandFacts(state, null, WALLET, BASE_ID))
        assertNull(workshopCommandFacts(state.copy(view = null), refine, WALLET, BASE_ID))
        assertNull(workshopCommandFacts(state, refine.copy(view = null), WALLET, BASE_ID))
        assertNull(workshopCommandFacts(state, refine, WALLET, OTHER_BASE))
        assertNull(workshopCommandFacts(state, refine, WALLET, null))
        assertNull(workshopCommandFacts(ingots(emptyList(), baseId = OTHER_BASE), refine, WALLET, BASE_ID))
        assertNull(workshopCommandFacts(state, refining(1, baseId = OTHER_BASE), WALLET, BASE_ID))
        assertNull(workshopCommandFacts(state, refining(1, wallet = OTHER_WALLET), WALLET, BASE_ID))
        assertNull(workshopCommandFacts(state, refine, OTHER_WALLET, BASE_ID))
    }

    // ---------------------------------------------------------------------------------------------------- Harvester facts

    private val harvesterId = "12345678-1234-4678-9abc-def012345602"
    private val sourceId = "12345678-1234-4678-9abc-def012345603"
    private val policy = HarvesterPolicy(1, 1, "48", "12", 21_600, 86_400, 1, 10_000, 500)
    private val admitted = "2030-01-01T00:00:00.000Z"
    private val lease = "2030-01-02T00:00:00.000Z"
    private val facility = HarvesterFacility(BASE_ID, harvesterId, "12345678-1234-4678-9abc-def012345604", "2029-12-31T00:00:00.000Z")
    private val summary = HarvesterSummary(sourceId, BASE_ID, harvesterId, 1, "crownlands", "crown_iron_ore", admitted, lease)
    private fun haul(ordinal: Int, sequence: String, earnedAt: String) =
        HarvesterEvent(sourceId, ordinal, sequence, "crown_iron_ore", 1, earnedAt, earnedAt.replace(":00.000Z", ":05.000Z"),
            earnedAt.substring(0, 10) + "T00:00:00.000Z", "12", "11", "1", 1, 10_000, 500, "0", "0")
    private fun harvester(events: List<HarvesterEvent>): HarvesterState {
        val command = HarvesterCommand(HarvesterRequest(sourceId, BASE_ID, harvesterId, null, 1), facility, "crownlands", policy, null)
        val operation = HarvesterOperation(command, 1,
            HarvesterProof(WALLET, sourceId, "2030-01-01T13:00:00.000Z", "accepted",
                HarvesterReceipt(WALLET, command.request, HarvesterSource(sourceId, BASE_ID, harvesterId, 1, "crownlands",
                    "crown_iron_ore", admitted, lease, facility.completedBuildJobId, facility.harvesterCompletedAt,
                    HarvesterTerm("12345678-1234-4678-9abc-def012345605", "0".repeat(64), "2029-12-01T00:00:00.000Z",
                        "2030-02-01T00:00:00.000Z"), policy)),
                HarvesterSettlement(events, null, null)),
            null)
        val view = HarvesterView(WALLET, BASE_ID, "2030-01-01T13:00:00.000Z", HarvesterFeatures(HarvesterFeature(1, 1)), true,
            StarterExpeditionHome("free_assignment", 1, "crownlands"), listOf(facility), summary, summary, policy,
            listOf(OrdinaryRawStock("crown_iron_ore", "48", "0", "48")))
        return HarvesterState(HarvesterJournal(1, HarvesterIdentity("https://example.invalid", "devnet", WALLET), 3, operation,
            emptyList()), view, advertised = true)
    }
    private val twoHauls = listOf(haul(1, "4", "2030-01-01T06:00:00.000Z"), haul(2, "5", "2030-01-01T12:00:00.000Z"))

    @Test fun `Harvester facts are ready only for a delivered haul newer than the seen marker`() {
        val state = harvester(twoHauls)
        assertEquals(CraftCommandFacts(null, true), harvesterCommandFacts(state, WALLET, BASE_ID, "4"))
        // Already acknowledged in the sheet: the "!" must clear rather than nag about an old haul.
        assertEquals(CraftCommandFacts(null, false), harvesterCommandFacts(state, WALLET, BASE_ID, "5"))
        // Without a marker nothing counts as unseen (the sheet seeds it on first observation), so no invented arrival.
        assertEquals(CraftCommandFacts(null, false), harvesterCommandFacts(state, WALLET, BASE_ID, null))
    }

    @Test fun `Harvester facts are null for another base or wallet or a missing view`() {
        val state = harvester(twoHauls)
        assertNull(harvesterCommandFacts(state, WALLET, OTHER_BASE, "4"))
        assertNull(harvesterCommandFacts(state, OTHER_WALLET, BASE_ID, "4"))
        assertNull(harvesterCommandFacts(state, WALLET, null, "4"))
        assertNull(harvesterCommandFacts(state.copy(view = null), WALLET, BASE_ID, "4"))
        assertNull(harvesterCommandFacts(null, WALLET, BASE_ID, "4"))
    }
}
