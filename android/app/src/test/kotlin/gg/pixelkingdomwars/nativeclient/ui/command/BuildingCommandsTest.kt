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
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Labelled5ed31eb8 successor to immutable72e881d0; no UiModels/FeatureId copies. */
class BuildingCommandsTest {
    private val registry = FeatureRegistry.canonical()
    private val noJob = GateFact.Denied("No building construction or upgrade is running")
    private val upgradePrice = PriceUi(Currency.SHARDS, "123", PriceStatus.OK)
    private val finishPrice = PriceUi(Currency.GEMS, "7", PriceStatus.OK)

    @Test fun barracksUsesCurrentOwnerIdsInfoFirstAndSinglePrimaryLast() {
        val b = building("barracks")
        val bar = buildingCommands(b, context(b), registry, presentation(b))
        assertEquals(b.id, bar.buildingId)
        assertEquals(listOf("building.info", "building.upgrade", "barracks.train"), bar.ids())
        assertEquals("barracks.train", bar.primaryId())
        assertEquals(upgradePrice, bar.command("building.upgrade").price)
        assertNull(bar.command("barracks.train").price)
    }

    @Test fun missingOrWrongSelectedBuildingBaseOrTypeProducesNoCommands() {
        val b = building("barracks")
        val selections = listOf<BuildingSelection?>(
            null, selected(b).copy(buildingId = "different-building"),
            selected(b).copy(baseId = "different-base"), selected(b).copy(type = "forge"),
        )
        selections.forEach { selection ->
            val bar = buildingCommands(b, context(b, selection = selection), registry, presentation(b))
            assertEquals(b.id, bar.buildingId)
            assertTrue("Wrong selection must not navigate: $selection", bar.commands.isEmpty())
        }
    }

    @Test fun stalePresentationCannotSupplyPricesBadgesIconsOrPermission() {
        val b = building("workshop")
        val ready = BadgeUi("1", BadgeTone.READY, "One craft is ready")
        val p = BuildingCommandPresentation(
            selection = selected(b).copy(baseId = "old-base"), ordersAllowed = GateFact.Allowed,
            entries = mapOf(fid("workshop.craft") to BuildingCommandEntry(
                icon = "ui:workshop-menu", price = upgradePrice, badge = ready, readyToCollect = true)),
        )
        val bar = buildingCommands(b, context(b), registry, p)
        assertFalse(bar.ids().contains("workshop.craft"))
        assertTrue(bar.commands.all { it.price == null && it.badge == null })
        assertTrue(bar.commands.filter { it.id != fid("building.info") }
            .all { it.state != CommandState.ENABLED && !it.primary })
    }

    @Test fun threeArgumentDefaultDoesNotAssumeReadOnlyOrIconAdmission() {
        val b = building("workshop")
        val bar = buildingCommands(b, context(b), registry)
        assertEquals(CommandState.ENABLED, bar.command("building.info").state)
        assertFalse(bar.ids().contains("workshop.craft"))
        assertFalse(bar.ids().contains("building.upgrade")) // unresolved shape contract
        assertTrue(bar.commands.none { it.primary })
    }

    @Test fun selectedConstructionDoesNotBorrowAnotherCompletedBuildingOfSameType() {
        val b = building("workshop", level = 0, constructing = true)
        val bar = buildingCommands(b, context(b, complete = true, job = GateFact.Allowed), registry,
            presentation(b, mapOf("workshop.craft" to BuildingCommandEntry(icon = "ui:workshop-menu"))))
        assertEquals(listOf("building.info", "building.finish"), bar.ids())
        assertEquals("building.finish", bar.primaryId())
        assertEquals(finishPrice, bar.command("building.finish").price)
    }

    @Test fun zeroLevelSelectedBuildingCannotBorrowTypeWideCompletion() {
        val b = building("barracks", level = 0)
        val bar = buildingCommands(b, context(b, complete = true), registry, presentation(b))
        assertTrue(bar.commands.filter { it.id == fid("barracks.train") }
            .all { it.state == CommandState.LOCKED && !it.primary })
        assertTrue(bar.commands.none { it.id == fid("building.upgrade") && it.state == CommandState.ENABLED })
    }

    @Test fun constructionWithoutKnownFinishableJobDoesNotInventFinish() {
        val b = building("workshop", level = 0, constructing = true)
        val bar = buildingCommands(b, context(b, complete = false, job = GateFact.Unknown), registry,
            presentation(b))
        assertEquals(listOf("building.info"), bar.ids())
        assertNull(bar.primaryId())
    }

    @Test fun upgradingShowsFinishAndDisablesTypeDoorByDefault() {
        val b = building("barracks")
        val bar = buildingCommands(b, context(b, job = GateFact.Allowed,
            upgrade = GateFact.Denied("Already upgrading")), registry, presentation(b))
        assertEquals(listOf("building.info", "barracks.train", "building.finish"), bar.ids())
        assertEquals(CommandState.DISABLED, bar.command("barracks.train").state)
        assertEquals("Upgrading", bar.command("barracks.train").reason)
        assertEquals("building.finish", bar.primaryId())
    }

    @Test fun explicitOwnerObservationCanKeepTypeDoorUsableWhileUpgrading() {
        val b = building("barracks")
        val bar = buildingCommands(b, context(b, job = GateFact.Allowed,
            upgrade = GateFact.Denied("Already upgrading")), registry,
            presentation(b, mapOf("barracks.train" to BuildingCommandEntry(
                spending = false, usableWhileUpgrading = GateFact.Allowed))))
        assertEquals(CommandState.ENABLED, bar.command("barracks.train").state)
        assertFalse(bar.command("barracks.train").primary)
        assertEquals("building.finish", bar.primaryId())
    }

    @Test fun activityQueueBadgeDoesNotBecomeConstructionFinishOrHideUpgrade() {
        val b = building("barracks")
        val queue = BadgeUi("3", BadgeTone.COUNT, "Three troops in the training queue")
        val bar = buildingCommands(b, context(b, job = noJob), registry,
            presentation(b, mapOf("barracks.train" to BuildingCommandEntry(badge = queue, spending = false))))
        assertEquals(queue, bar.command("barracks.train").badge)
        assertFalse(bar.ids().contains("building.finish"))
        assertTrue(bar.ids().contains("building.upgrade"))
        assertEquals("barracks.train", bar.primaryId())
    }

    @Test fun readyCaptionsKeepTheFourExistingOwnerIdsAndTargets() {
        val rows = listOf(
            Triple("workshop", "workshop.craft", "ui:workshop-menu"),
            Triple("lodge", "lodge.expedition", "ui:lodge-menu"),
            Triple("market", "market.trade", "ui:market-menu"),
            Triple("harvester", "harvester.harvest", "ui:harvester-menu"),
        )
        rows.forEach { (type, id, icon) ->
            val b = building(type)
            val ctx = context(b, server = mapOf("phaseE.harvesters" to GateFact.Allowed))
            val targetBefore = registry[fid(id)]!!.target
            val bar = buildingCommands(b, ctx, registry, presentation(b,
                mapOf(id to BuildingCommandEntry(icon = icon, readyToCollect = true, spending = false))))
            assertEquals("COLLECT", bar.command(id).caption)
            assertEquals(id, bar.primaryId())
            assertEquals(targetBefore, registry[fid(id)]!!.target)
            assertTrue(bar.ids().all { registry[fid(it)] != null })
        }
    }

    @Test fun readyBadgeAndIconCannotOverrideUnknownOrDeniedServerGate() {
        val b = building("harvester")
        listOf(GateFact.Unknown, GateFact.Denied("Harvesting is off")).forEach { fact ->
            val bar = buildingCommands(b, context(b, server = mapOf("phaseE.harvesters" to fact)), registry,
                presentation(b, mapOf("harvester.harvest" to BuildingCommandEntry(
                    icon = "ui:harvester-menu", readyToCollect = true, busy = true, price = upgradePrice))))
            assertEquals(CommandState.LOCKED, bar.command("harvester.harvest").state)
            assertTrue("Locked is a visual primary, never permission", bar.command("harvester.harvest").primary)
            assertTrue(!bar.command("harvester.harvest").reason.isNullOrBlank())
        }
    }

    @Test fun spentTrapKeepsRearmOwnerAndDoesNotResurrectOwnerDeniedUpgrade() {
        val b = building("spiketrap").copy(trapSpentAt = "2030-01-01T00:00:00Z")
        val bar = buildingCommands(b, context(b, upgrade = GateFact.Denied("Rearm first"),
            extraOwner = mapOf("trap.spent" to GateFact.Allowed)), registry,
            presentation(b, mapOf("trap.rearm" to BuildingCommandEntry(price = upgradePrice))))
        assertEquals(listOf("building.info", "trap.rearm"), bar.ids())
        assertEquals("trap.rearm", bar.primaryId())
    }

    @Test fun readOnlyDisablesSpendingPreservesInfoAndRemovesAllPrimaryMarks() {
        val b = building("keep")
        val reason = "This kingdom is read-only"
        val bar = buildingCommands(b, context(b, use = GateFact.Denied("No primary type action")), registry,
            presentation(b, mapOf("keep.stores" to BuildingCommandEntry(spending = false)),
                orders = GateFact.Denied(reason)))
        assertEquals(CommandState.ENABLED, bar.command("building.info").state)
        assertEquals(CommandState.ENABLED, bar.command("keep.stores").state)
        assertEquals(CommandState.DISABLED, bar.command("building.upgrade").state)
        assertEquals(reason, bar.command("building.upgrade").reason)
        assertTrue(bar.commands.none { it.primary })
    }

    @Test fun unknownOrderPermissionCannotOpenSpendingCommand() {
        val b = building("vault")
        val bar = buildingCommands(b, context(b, use = GateFact.Denied("No type action")), registry,
            presentation(b, orders = GateFact.Unknown))
        assertEquals(CommandState.LOCKED, bar.command("building.upgrade").state)
        assertTrue(!bar.command("building.upgrade").reason.isNullOrBlank())
        assertEquals("building.upgrade", bar.primaryId()) // LOCKED designation is visual only.
    }

    @Test fun shortQuotePreservesExactPriceAndUsesShortState() {
        val b = building("vault")
        val price = PriceUi(Currency.SHARDS, "123", PriceStatus.SHORT, description = "123 Shards required")
        val bar = buildingCommands(b, context(b, use = GateFact.Denied("No type action")), registry,
            presentation(b, mapOf("building.upgrade" to BuildingCommandEntry(icon = "shape:up", price = price))))
        assertEquals(price, bar.command("building.upgrade").price)
        assertEquals(CommandState.SHORT, bar.command("building.upgrade").state)
    }

    @Test fun checkingCanNavigateWhileUnavailableIsDisabledAndNeitherBecomesFree() {
        val b = building("vault")
        listOf(PriceStatus.CHECKING, PriceStatus.UNAVAILABLE).forEach { status ->
            val price = PriceUi(Currency.SHARDS, null, status)
            val bar = buildingCommands(b, context(b, use = GateFact.Denied("No type action")), registry,
                presentation(b, mapOf("building.upgrade" to BuildingCommandEntry(icon = "shape:up", price = price))))
            assertEquals(price, bar.command("building.upgrade").price)
            val expected = if (status == PriceStatus.CHECKING) CommandState.ENABLED else CommandState.DISABLED
            assertEquals(expected, bar.command("building.upgrade").state)
            if (status == PriceStatus.UNAVAILABLE) assertTrue(!bar.command("building.upgrade").reason.isNullOrBlank())
            assertEquals("building.upgrade", bar.primaryId()) // Designation does not grant quote/spend authority.
        }
    }

    @Test fun explicitServerZeroIsPreservedWithoutChangingCurrency() {
        val b = building("vault", constructing = true)
        val zero = PriceUi(Currency.GEMS, "0", PriceStatus.SERVER_ZERO)
        val bar = buildingCommands(b, context(b, job = GateFact.Allowed), registry,
            presentation(b, mapOf("building.finish" to BuildingCommandEntry(price = zero))))
        assertEquals(zero, bar.command("building.finish").price)
        assertEquals(CommandState.ENABLED, bar.command("building.finish").state)
    }

    @Test fun busyIsPresentationOnlyAndKeepsTheExistingCommandId() {
        val b = building("barracks")
        val bar = buildingCommands(b, context(b), registry,
            presentation(b, mapOf("barracks.train" to BuildingCommandEntry(spending = false, busy = true))))
        assertEquals(CommandState.BUSY, bar.command("barracks.train").state)
        assertEquals(fid("barracks.train"), bar.command("barracks.train").id)
        assertFalse(bar.ids().any { it.contains("cancel", ignoreCase = true) })
    }

    @Test fun absentIconAdmissionDoesNotUseTheSourceKeyOrInventAnAlias() {
        val b = building("workshop")
        val bar = buildingCommands(b, context(b), registry, presentation(b))
        assertFalse(bar.ids().contains("workshop.craft"))
        val admitted = buildingCommands(b, context(b), registry, presentation(b,
            mapOf("workshop.craft" to BuildingCommandEntry(icon = "ui:workshop-menu", spending = false))))
        assertEquals("ui:workshop-menu", admitted.command("workshop.craft").icon)
        assertNull(registry[fid("workshop.craft")]!!.icon.key)
    }

    @Test fun keepFallbackDoesNotCreateMarketOrPromoteHistoryTabsAndSections() {
        val b = building("keep")
        val bar = buildingCommands(b, context(b, use = GateFact.Denied("No type action")), registry,
            presentation(b, mapOf("market.trade" to BuildingCommandEntry(icon = "ui:market-menu"))))
        assertFalse(bar.ids().contains("market.trade"))
        assertTrue(bar.commands.all { registry[it.id]!!.surface == FeatureSurface.COMMAND })
        assertTrue(bar.ids().none { it.contains("history", ignoreCase = true) })
    }

    @Test fun maxedKeepUsesExistingStoresAndMaxedVaultUsesInfo() {
        listOf("keep" to "keep.stores", "vault" to "building.info").forEach { (type, primary) ->
            val b = building(type)
            val bar = buildingCommands(b, context(b, use = GateFact.Denied("No type action"),
                upgrade = GateFact.Denied("At maximum level")), registry,
                presentation(b, mapOf("keep.stores" to BuildingCommandEntry(spending = false)), max = GateFact.Allowed))
            assertFalse(bar.ids().contains("building.upgrade"))
            assertEquals(primary, bar.primaryId())
        }
    }

    @Test fun missingUpgradeIsNotEvidenceThatBuildingIsAtMaximum() {
        val b = building("vault")
        val bar = buildingCommands(b, context(b, use = GateFact.Denied("No type action"),
            upgrade = GateFact.Denied("Quote unavailable")), registry,
            presentation(b, max = GateFact.Unknown))
        assertNull(bar.primaryId())
        assertEquals(listOf("building.info"), bar.ids())
    }

    @Test fun registryPrimaryConflictRemainsLockedAndDoesNotChooseAWinner() {
        val b = building("barracks")
        val conflicting = FeatureRegistry.of(registry.rows.map {
            if (it.id == fid("building.upgrade")) it.copy(primaryGate = Gate.Open) else it
        })
        val bar = buildingCommands(b, context(b), conflicting, presentation(b))
        assertEquals(CommandState.LOCKED, bar.command("barracks.train").state)
        assertEquals(CommandState.LOCKED, bar.command("building.upgrade").state)
        assertTrue(bar.commands.none { it.primary })
    }

    @Test fun portraitFourCapPreservesInfoAndPrimaryAndUsesRegistryOrderForSecondaries() {
        val b = building("keep")
        val ids = listOf("building.info", "keep.stores", "keep.expand", "barracks.train", "camp.army", "forge.research")
        // A metadata-only fixture with existing IDs tests the budget independently of today's host count.
        val crowded = FeatureRegistry.of(ids.mapIndexed { index, id -> registry[fid(id)]!!.copy(
            hostKind = HostKind.BUILDING, hostId = "keep", surface = FeatureSurface.COMMAND,
            gate = Gate.Open, primary = index == ids.lastIndex, primaryGate = Gate.Open, order = index,
        ) })
        val bar = buildingCommands(b, context(b), crowded, presentation(b))
        assertEquals(listOf("building.info", "keep.stores", "keep.expand", "forge.research"), bar.ids())
        assertEquals(4, bar.commands.size)
        assertEquals("forge.research", bar.primaryId())
        assertEquals(ids, crowded.rows.map { it.id.value }) // Overflow remains registry metadata, not deleted.
    }

    @Test fun checkingPriceCannotOverrideServerGateOrReadOnlyOrders() {
        val b = building("harvester")
        val checking = PriceUi(Currency.SHARDS, null, PriceStatus.CHECKING)
        val locked = buildingCommands(b, context(b), registry, presentation(b,
            mapOf("harvester.harvest" to BuildingCommandEntry(icon = "ui:harvester-menu", price = checking))))
        assertEquals(CommandState.LOCKED, locked.command("harvester.harvest").state)
        assertTrue(locked.command("harvester.harvest").primary)

        val vault = building("vault")
        val readOnly = buildingCommands(vault, context(vault, use = GateFact.Denied("No type action")), registry,
            presentation(vault, mapOf("building.upgrade" to BuildingCommandEntry(icon = "shape:up", price = checking)),
                orders = GateFact.Denied("This kingdom is read-only")))
        assertEquals(CommandState.DISABLED, readOnly.command("building.upgrade").state)
        assertTrue(readOnly.commands.none { it.primary })
    }

    @Test fun conflictingLockedAndOpenDesignationsHaveNoVisualPrimary() {
        val b = building("harvester")
        val conflicting = FeatureRegistry.of(registry.rows.map {
            if (it.id == fid("building.upgrade")) it.copy(primaryGate = Gate.Open) else it
        })
        val bar = buildingCommands(b, context(b), conflicting, presentation(b,
            mapOf("harvester.harvest" to BuildingCommandEntry(icon = "ui:harvester-menu"))))
        assertEquals(CommandState.LOCKED, bar.command("harvester.harvest").state)
        assertTrue(bar.commands.none { it.primary })
    }

    @Test fun admittedFormattedValueOrTimerUsesSubAndSecondIconUsesExistingField() {
        val b = building("lodge")
        val p = presentation(b, mapOf("lodge.expedition" to BuildingCommandEntry(
            icon = "ui:lodge-menu", spending = false, sub = "2h 10m", iconSecondary = "ui:ready-status")))
        val bar = buildingCommands(b, context(b), registry, p)
        assertEquals("EXPLORE", bar.command("lodge.expedition").caption)
        assertEquals("2h 10m", bar.command("lodge.expedition").sub)
        assertEquals("ui:ready-status", bar.command("lodge.expedition").iconSecondary)
    }

    @Test fun stalePresentationCannotLeakSubOrSecondaryIcon() {
        val b = building("barracks")
        val p = BuildingCommandPresentation(
            selection = selected(b).copy(buildingId = "old-building"), ordersAllowed = GateFact.Allowed,
            entries = mapOf(fid("barracks.train") to BuildingCommandEntry(
                spending = false, sub = "Old timer", iconSecondary = "ui:ready-status")),
        )
        val bar = buildingCommands(b, context(b), registry, p)
        assertNull(bar.command("barracks.train").sub)
        assertNull(bar.command("barracks.train").iconSecondary)
        assertEquals(CommandState.LOCKED, bar.command("barracks.train").state)
    }

    @Test fun presentationDetachesItsEntriesAndMappingDoesNotChangeTheCatalogue() {
        val b = building("workshop")
        val mutable = mutableMapOf(fid("workshop.craft") to BuildingCommandEntry(icon = "ui:workshop-menu", spending = false))
        val p = BuildingCommandPresentation(selected(b), GateFact.Allowed, entries = mutable)
        mutable.clear()
        val before = registry.rows.toList()
        val bar = buildingCommands(b, context(b), registry, p)
        assertTrue(bar.ids().contains("workshop.craft"))
        assertEquals(110, registry.rows.size)
        assertEquals(before, registry.rows)
        assertNotNull(p.entries[fid("workshop.craft")])
    }

    private fun building(type: String, level: Int = 1, constructing: Boolean = false) =
        Building("selected-$type", type, level, 4, 5, underConstruction = constructing)

    private fun selected(b: Building) = BuildingSelection("base-current", b.id, b.type)

    private fun context(
        b: Building,
        selection: BuildingSelection? = selected(b),
        complete: Boolean = b.level > 0 && !b.underConstruction,
        job: GateFact = noJob,
        use: GateFact = GateFact.Allowed,
        upgrade: GateFact = GateFact.Allowed,
        server: Map<String, GateFact> = emptyMap(),
        extraOwner: Map<String, GateFact> = emptyMap(),
    ) = GateContext(
        baseId = "base-current",
        buildings = mapOf(b.type to BuildingGateState(if (complete) maxOf(1, b.level) else b.level, complete)),
        serverFeatures = server,
        ownerFacts = mapOf("building.jobRunning" to job, "building.useActionAvailable" to use,
            "building.upgradeAvailable" to upgrade) + extraOwner,
        selection = FeatureSelection(building = selection),
    )

    private fun presentation(
        b: Building,
        entries: Map<String, BuildingCommandEntry> = emptyMap(),
        orders: GateFact = GateFact.Allowed,
        max: GateFact = GateFact.Unknown,
    ) = BuildingCommandPresentation(
        selection = selected(b), ordersAllowed = orders, atMaxLevel = max,
        entries = mapOf(
            fid("building.upgrade") to BuildingCommandEntry(icon = "shape:up", price = upgradePrice),
            fid("building.finish") to BuildingCommandEntry(price = finishPrice),
        ) + entries.mapKeys { fid(it.key) },
    )

    private fun fid(value: String) = FeatureId(value)
    private fun CommandBarUi.ids() = commands.map { it.id.value }
    private fun CommandBarUi.command(value: String) = commands.single { it.id == fid(value) }
    private fun CommandBarUi.primaryId(): String? {
        assertTrue("Only one primary may be projected", commands.count { it.primary } <= 1)
        return commands.singleOrNull { it.primary }?.id?.value
    }
}
