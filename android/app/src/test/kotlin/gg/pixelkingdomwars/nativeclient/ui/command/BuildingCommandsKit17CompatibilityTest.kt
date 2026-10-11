package gg.pixelkingdomwars.nativeclient.ui.command

import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.features.BuildingGateState
import gg.pixelkingdomwars.nativeclient.ui.features.BuildingSelection
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureRegistry
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureSelection
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureSurface
import gg.pixelkingdomwars.nativeclient.ui.features.Gate
import gg.pixelkingdomwars.nativeclient.ui.features.GateContext
import gg.pixelkingdomwars.nativeclient.ui.features.GateFact
import gg.pixelkingdomwars.nativeclient.ui.features.HostKind
import gg.pixelkingdomwars.nativeclient.ui.kit.CommandRoute
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.kit.commandRoute
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Calls the real Opus 17c184db kit helpers on real MS-B mapper output. No routing or mutation is executed. */
class BuildingCommandsKit17CompatibilityTest {
    private val registry = FeatureRegistry.canonical()
    private val priceStates = listOf<PriceStatus?>(null) + PriceStatus.entries
    private val noJob = GateFact.Denied("No construction job")

    @Test fun admittedPricesRetainExactQuotesAndUseActualKitRoutes() {
        val b = building("vault")
        for (status in priceStates) {
            val quote = price(status)
            val command = buildingCommands(b, context(b), registry,
                presentation(b, mapOf("building.upgrade" to BuildingCommandEntry(icon = "shape:up", price = quote))))
                .command("building.upgrade")
            val state = when (status) {
                PriceStatus.SHORT -> CommandState.SHORT
                PriceStatus.UNAVAILABLE -> CommandState.DISABLED
                else -> CommandState.ENABLED
            }
            val route = when (status) {
                PriceStatus.SHORT -> CommandRoute.NEED_MORE
                PriceStatus.UNAVAILABLE -> CommandRoute.EXPLAIN
                else -> CommandRoute.OPEN
            }
            assertEquals(status.toString(), quote, command.price)
            assertEquals(state, command.state)
            assertEquals(state, commandDrawState(command))
            assertEquals(route, commandRoute(command))
            assertTrue(command.primary)
            if (status == PriceStatus.UNAVAILABLE) assertEquals("Price unavailable", command.reason)
        }
    }

    @Test fun unknownOrDeniedServerGateExplainsDespiteCheckingShortOrBusyPresentation() {
        val b = building("harvester")
        for (gate in listOf(GateFact.Unknown, GateFact.Denied("Harvesting paused"))) {
            for (status in priceStates) {
                val command = buildingCommands(b, context(b, server = mapOf("phaseE.harvesters" to gate)), registry,
                    presentation(b, mapOf("harvester.harvest" to BuildingCommandEntry(
                        icon = "ui:harvester-menu", price = price(status), busy = true, readyToCollect = true))))
                    .command("harvester.harvest")
                assertEquals(CommandState.LOCKED, command.state)
                assertEquals(CommandState.LOCKED, commandDrawState(command))
                assertEquals(CommandRoute.EXPLAIN, commandRoute(command))
                assertTrue(command.primary)
                assertTrue(!command.reason.isNullOrBlank())
            }
        }
    }

    @Test fun orderRestrictionsRemainAheadOfPricesWhileInfoStaysFreeNavigation() {
        val b = building("vault")
        for (orders in listOf(GateFact.Unknown, GateFact.Denied("Read-only kingdom"))) {
            for (status in priceStates) {
                val bar = buildingCommands(b, context(b), registry, presentation(b, mapOf(
                    "building.upgrade" to BuildingCommandEntry(icon = "shape:up", price = price(status), busy = true),
                    "building.info" to BuildingCommandEntry(price = price(status), busy = true),
                ), orders))
                val upgrade = bar.command("building.upgrade")
                val expected = if (orders == GateFact.Unknown) CommandState.LOCKED else CommandState.DISABLED
                assertEquals(expected, commandDrawState(upgrade))
                assertEquals(CommandRoute.EXPLAIN, commandRoute(upgrade))
                assertTrue(!upgrade.reason.isNullOrBlank())
                if (orders is GateFact.Denied) assertTrue(bar.commands.none { it.primary })
                val info = bar.command("building.info")
                assertNull(info.price)
                assertEquals(CommandState.ENABLED, commandDrawState(info))
                assertEquals(CommandRoute.OPEN, commandRoute(info))
            }
        }
    }

    @Test fun unavailableRetainsMsBPrecedenceOverBusyAndOtherBusyPricesAreIgnored() {
        val b = building("vault")
        for (status in priceStates) {
            val command = buildingCommands(b, context(b), registry, presentation(b,
                mapOf("building.upgrade" to BuildingCommandEntry(icon = "shape:up", price = price(status), busy = true))))
                .command("building.upgrade")
            val expectedState = if (status == PriceStatus.UNAVAILABLE) CommandState.DISABLED else CommandState.BUSY
            val expectedRoute = if (status == PriceStatus.UNAVAILABLE) CommandRoute.EXPLAIN else CommandRoute.IGNORE
            assertEquals(expectedState, command.state)
            assertEquals(expectedState, commandDrawState(command))
            assertEquals(expectedRoute, commandRoute(command))
            assertEquals(price(status), command.price)
            if (status == PriceStatus.UNAVAILABLE) assertEquals("Price unavailable", command.reason)
        }
    }

    @Test fun upgradingRestrictionExplainsBeforePriceOrBusyAndKeepsFinishPrimary() {
        val b = building("barracks")
        for (status in priceStates) {
            val bar = buildingCommands(b, context(b, job = GateFact.Allowed), registry,
                presentation(b, mapOf("barracks.train" to BuildingCommandEntry(price = price(status), busy = true))))
            val train = bar.command("barracks.train")
            assertEquals(CommandState.DISABLED, commandDrawState(train))
            assertEquals("Upgrading", train.reason)
            assertEquals(CommandRoute.EXPLAIN, commandRoute(train))
            assertEquals("building.finish", bar.commands.single { it.primary }.id.value)
        }
    }

    @Test fun primaryConflictCannotBecomeOpenThroughKitPriceNormalization() {
        val b = building("barracks")
        val conflict = FeatureRegistry.of(registry.rows.map {
            if (it.id == id("building.upgrade")) it.copy(primaryGate = Gate.Open) else it
        })
        for (status in listOf(PriceStatus.CHECKING, PriceStatus.SHORT)) {
            val bar = buildingCommands(b, context(b), conflict, presentation(b, mapOf(
                "building.upgrade" to BuildingCommandEntry(icon = "shape:up", price = price(status)),
                "barracks.train" to BuildingCommandEntry(price = price(status)),
            )))
            assertTrue(bar.commands.none { it.primary })
            for (commandId in listOf("building.upgrade", "barracks.train")) {
                val command = bar.command(commandId)
                assertEquals(CommandState.LOCKED, commandDrawState(command))
                assertEquals(CommandRoute.EXPLAIN, commandRoute(command))
            }
        }
    }

    @Test fun sharedPortraitBudgetKeepsInfoFirstAndTheSingleCanonicalPrimaryLast() {
        val b = building("keep")
        val ids = listOf("building.info", "keep.stores", "keep.expand", "barracks.train", "camp.army", "forge.research")
        val crowded = FeatureRegistry.of(ids.mapIndexed { index, value -> registry[id(value)]!!.copy(
            hostKind = HostKind.BUILDING, hostId = "keep", surface = FeatureSurface.COMMAND,
            gate = Gate.Open, primary = index == ids.lastIndex, primaryGate = Gate.Open, order = index,
        ) })
        val bar = buildingCommands(b, context(b), crowded, presentation(b))
        assertEquals(PkwTokens.Budget.MAX_COMMANDS_PORTRAIT, bar.commands.size)
        assertEquals(listOf("building.info", "keep.stores", "keep.expand", "forge.research"), bar.commands.map { it.id.value })
        assertEquals("forge.research", bar.commands.single { it.primary }.id.value)
        assertTrue(bar.commands.last().primary)
        assertFalse(bar.commands.first().primary)
        assertEquals(CommandRoute.OPEN, commandRoute(bar.commands.first()))
        assertEquals(ids, crowded.rows.map { it.id.value })
    }

    private fun building(type: String) = Building("selected-$type", type, 1, 4, 5)
    private fun id(value: String) = FeatureId(value)
    private fun selection(b: Building) = BuildingSelection("current-base", b.id, b.type)
    private fun context(b: Building, job: GateFact = noJob, server: Map<String, GateFact> = emptyMap()) = GateContext(
        baseId = "current-base", buildings = mapOf(b.type to BuildingGateState(1, true)),
        serverFeatures = server,
        ownerFacts = mapOf("building.jobRunning" to job, "building.useActionAvailable" to
            if (b.type == "vault") GateFact.Denied("No type action") else GateFact.Allowed,
            "building.upgradeAvailable" to if (job == GateFact.Allowed) GateFact.Denied("Already upgrading") else GateFact.Allowed),
        selection = FeatureSelection(building = selection(b)),
    )
    private fun presentation(b: Building, entries: Map<String, BuildingCommandEntry> = emptyMap(),
        orders: GateFact = GateFact.Allowed) = BuildingCommandPresentation(selection(b), orders,
        entries = mapOf(id("building.upgrade") to BuildingCommandEntry(icon = "shape:up")) + entries.mapKeys { id(it.key) })
    private fun price(status: PriceStatus?): PriceUi? = status?.let {
        PriceUi(Currency.SHARDS, when (it) {
            PriceStatus.CHECKING, PriceStatus.UNAVAILABLE -> null
            PriceStatus.SERVER_ZERO -> "0"
            else -> "7"
        }, it)
    }
    private fun CommandBarUi.command(value: String) = commands.single { it.id == id(value) }
}
