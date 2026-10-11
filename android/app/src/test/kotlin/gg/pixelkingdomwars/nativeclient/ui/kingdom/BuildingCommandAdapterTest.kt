package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.ui.command.BuildingCommandPresentation
import gg.pixelkingdomwars.nativeclient.ui.features.BuildingSelection
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.GateFact
import gg.pixelkingdomwars.nativeclient.ui.kit.CommandRoute
import gg.pixelkingdomwars.nativeclient.ui.kit.commandRoute
import gg.pixelkingdomwars.nativeclient.ui.kit.orderCommands
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

/** b47d0a95: the producer only presents and forwards. C3 owns all fresh admission and legacy handoffs. */
class BuildingCommandAdapterTest {
    private val doors = linkedMapOf("harvester" to "harvester.harvest", "lodge" to "lodge.expedition", "berth" to "berth.fleet")
    private fun building(type: String) = Building("actual-$type-instance", type, 1, 0, 0)
    private fun selection(b: Building) = BuildingSelection("actual-base", b.id, b.type)
    private fun command(id: String, primary: Boolean = false, state: CommandState = CommandState.ENABLED) =
        CommandUi(FeatureId(id), "shape:info", "OWNER LABEL", null, primary, state,
            if (state == CommandState.LOCKED || state == CommandState.DISABLED) "Owner reason" else null, null)
    private fun state(b: Building) = KingdomUiState(
        home = BaseState(base = BaseSnapshot("actual-base", null, PlayerSummary(keepLevel = 1), null, null, null,
            listOf(b), emptyList(), emptyList(), 0, JsonObject(emptyMap()))),
        local = KingdomLocal(selectedBuildingId = b.id),
    )
    private fun gates(upgrade: Boolean = false) = BuildingGates(null, 1, 2, null, null, null, null,
        null, true, upgrade, null)
    private class FakeDispatcher(var projected: CommandBarUi?) : PhaseEBuildingCommands {
        val projections = mutableListOf<Pair<Building, BuildingCommandPresentation>>()
        val opened = mutableListOf<Pair<FeatureId, BuildingSelection>>()
        override fun buildingCommandBar(building: Building, presentation: BuildingCommandPresentation): CommandBarUi? {
            projections += building to presentation
            return projected
        }
        override fun openBuildingDoor(id: FeatureId, selection: BuildingSelection) { opened += id to selection }
    }
    private fun routes(info: () -> Unit = {}, review: () -> Unit = {}) = BuildingCommandRoutes(
        info, review, {}, {}, {}, {}, {}, {}, {}, {}, {})

    @Test fun `present host gives Harvester its registry command in the actual adapter`() {
        assertDoorPresent("harvester")
    }

    @Test fun `present host gives Lodge its registry command in the actual adapter`() {
        assertDoorPresent("lodge")
    }

    @Test fun `present host gives Berth its registry command in the actual adapter`() {
        assertDoorPresent("berth")
    }

    private fun assertDoorPresent(type: String) {
        val b = building(type)
        val row = command(doors.getValue(type), primary = true)
        val host = FakeDispatcher(CommandBarUi(b.id, listOf(row)))
        val bar = buildingCommandBar(state(b), b, gates(), false, 0L, host)
        assertEquals(listOf(BuildingCommandIds.INFO, row.id), bar.commands.map { it.id })
        assertEquals(row, bar.commands.last())
        assertSame(b, host.projections.single().first)
        assertEquals(selection(b), host.projections.single().second.selection)
    }

    @Test fun `absent dispatcher adds no Phase E door for any of the three types`() {
        for (type in doors.keys) {
            val b = building(type)
            assertEquals(listOf(BuildingCommandIds.INFO), buildingCommandBar(state(b), b, gates(), false, 0L).commands.map { it.id })
        }
    }

    @Test fun `null or mismatched owner projection cannot add a command`() {
        val b = building("berth")
        val host = FakeDispatcher(null)
        assertEquals(1, buildingCommandBar(state(b), b, gates(), false, 0L, host).commands.size)
        host.projected = CommandBarUi("other-instance", listOf(command("berth.fleet")))
        assertEquals(1, buildingCommandBar(state(b), b, gates(), false, 0L, host).commands.size)
    }

    @Test fun `ordinary types stay unassigned while Market queries exactly its canonical TRADE owner`() {
        // fc7a61fa mounts Market: retain the old keep/cannon negatives and require the new canonical projection.
        for (type in listOf("keep", "cannon")) {
            val b = building(type)
            val host = FakeDispatcher(CommandBarUi(b.id, listOf(command("berth.fleet"))))
            buildingCommandBar(state(b), b, gates(), false, 0L, host)
            assertTrue(type, host.projections.isEmpty())
        }
        val market = building("market")
        val trade = command("market.trade")
        val host = FakeDispatcher(CommandBarUi(market.id, listOf(trade)))
        val bar = buildingCommandBar(state(market), market, gates(), false, 0L, host)
        assertEquals(listOf(BuildingCommandIds.INFO, trade.id), bar.commands.map { it.id })
        assertEquals(setOf(trade.id), host.projections.single().second.entries.keys)
        assertEquals(selection(market), host.projections.single().second.selection)
    }

    @Test fun `presentation supplies existing resolver icons and navigation classification without inventing facts`() {
        val icons = mapOf("harvester" to "ui:harvester-menu", "lodge" to "ui:lodge-menu", "berth" to "shape:anchor")
        for ((type, id) in doors) {
            val b = building(type)
            val host = FakeDispatcher(CommandBarUi(b.id, listOf(command(id))))
            buildingCommandBar(state(b), b, gates(), false, 0L, host)
            val presentation = host.projections.single().second
            assertEquals(selection(b), presentation.selection)
            assertEquals(GateFact.Unknown, presentation.ordersAllowed)
            assertEquals(GateFact.Unknown, presentation.atMaxLevel)
            assertEquals(if (type == "lodge") setOf(FeatureId(id), FeatureId("lodge.passport")) else setOf(FeatureId(id)), presentation.entries.keys)
            if (type == "lodge") {
                val passport = presentation.entries.getValue(FeatureId("lodge.passport"))
                assertEquals("ui:realm-passport", passport.icon); assertFalse(passport.spending); assertNull(passport.price)
                assertEquals(GateFact.Allowed, passport.usableWhileUpgrading)
            }
            val entry = presentation.entries.getValue(FeatureId(id))
            assertEquals(icons.getValue(type), entry.icon)
            assertFalse(entry.spending)
            assertNull(entry.price)
            assertEquals(if (type == "lodge") GateFact.Allowed else GateFact.Unknown, entry.usableWhileUpgrading)
        }
    }

    @Test fun `Lodge merge preserves payloads and designates Explore after Upgrade with no duplicate common commands`() {
        val b = building("lodge")
        val info = command("building.info")
        val upgrade = command("building.upgrade", primary = true)
        val finish = command("building.finish")
        val original = CommandBarUi(b.id, listOf(info, finish, upgrade), "Existing hint")
        val host = FakeDispatcher(CommandBarUi(b.id, listOf(info, upgrade, finish,
            command("lodge.expedition", primary = true), command("lodge.expedition"), command("harvester.harvest"))))
        val merged = mergePhaseEBuildingCommands(original, b, selection(b), host)
        assertEquals(listOf(info, finish, upgrade.copy(primary = false)), merged.commands.filter { it.id != FeatureId("lodge.expedition") })
        assertEquals(listOf("building.info", "building.finish", "building.upgrade", "lodge.expedition"), merged.commands.map { it.id.value })
        assertEquals(listOf(command("lodge.expedition", primary = true)), merged.commands.filter { it.primary })
        assertEquals("Existing hint", merged.hint)
        assertEquals(merged.commands, orderCommands(merged.commands, 4))

        val workshop = building("workshop")
        val workshopOriginal = original.copy(buildingId = workshop.id)
        val workshopHost = FakeDispatcher(CommandBarUi(workshop.id, listOf(info, upgrade, finish,
            command("workshop.craft", primary = true), command("workshop.craft"), command("harvester.harvest"))))
        val workshopMerged = mergePhaseEBuildingCommands(workshopOriginal, workshop, selection(workshop), workshopHost)
        // Rewritten for craft SPEC §2.0 (workshop-selected.png): CRAFT is now the bar's one gold primary, appended last,
        // while UPGRADE keeps its payload as a green secondary. It no longer pins CRAFT as a secondary before UPGRADE.
        assertEquals(listOf(info, finish, upgrade.copy(primary = false)), workshopMerged.commands.filter { it.id != FeatureId("workshop.craft") })
        assertEquals(listOf("building.info", "building.finish", "building.upgrade", "workshop.craft"), workshopMerged.commands.map { it.id.value })
        assertEquals(listOf(command("workshop.craft", primary = true)), workshopMerged.commands.filter { it.primary })
        assertEquals("Existing hint", workshopMerged.hint)
        assertEquals(workshopMerged.commands, orderCommands(workshopMerged.commands, 4))
    }

    @Test fun `already present feature command is not replaced or duplicated`() {
        val b = building("berth")
        val original = CommandBarUi(b.id, listOf(command("building.info"), command("berth.fleet")))
        val host = FakeDispatcher(CommandBarUi(b.id, listOf(command("berth.fleet", primary = true))))
        assertEquals(original, mergePhaseEBuildingCommands(original, b, selection(b), host))
    }

    @Test fun `owner locked state reason and label survive merge without a local unlock`() {
        val b = building("harvester")
        val row = command("harvester.harvest", primary = true, state = CommandState.LOCKED)
        val host = FakeDispatcher(CommandBarUi(b.id, listOf(row)))
        val bar = buildingCommandBar(state(b), b, gates(), false, 0L, host)
        assertEquals(row, bar.commands.last())
        assertEquals(CommandRoute.EXPLAIN, commandRoute(bar.commands.last()))
    }

    @Test fun `tap forwards exact canonical id and real rendered instance for all three doors`() {
        for ((type, id) in doors) {
            val b = building(type)
            val host = FakeDispatcher(CommandBarUi(b.id, listOf(command(id))))
            val bar = buildingCommandBar(state(b), b, gates(), false, 0L, host)
            val selected = selection(b)
            routeBuildingCommand(FeatureId(id), bar, routes(), host, selected)
            assertEquals(listOf(FeatureId(id) to selected), host.opened)
            assertSame(selected, host.opened.single().second)
        }
    }

    @Test fun `locked and disabled door taps reach C3 fallback decision instead of stopping at local explanation`() {
        val b = building("harvester")
        for (status in listOf(CommandState.LOCKED, CommandState.DISABLED)) {
            val host = FakeDispatcher(CommandBarUi(b.id, listOf(command("harvester.harvest", state = status))))
            val bar = buildingCommandBar(state(b), b, gates(), false, 0L, host)
            routeBuildingCommand(FeatureId("harvester.harvest"), bar, routes(), host, selection(b))
            assertEquals(listOf(FeatureId("harvester.harvest") to selection(b)), host.opened)
        }
    }

    @Test fun `busy doors do not forward a synthetic tap`() {
        val b = building("berth")
        val host = FakeDispatcher(CommandBarUi(b.id, listOf(command("berth.fleet", state = CommandState.BUSY))))
        routeBuildingCommand(FeatureId("berth.fleet"), host.projected, routes(), host, selection(b))
        assertTrue(host.opened.isEmpty())
    }

    @Test fun `a door absent from the rendered bar cannot be invoked`() {
        val b = building("berth")
        val host = FakeDispatcher(CommandBarUi(b.id, listOf(command("building.info"))))
        routeBuildingCommand(FeatureId("berth.fleet"), host.projected, routes(), host, selection(b))
        routeBuildingCommand(FeatureId("berth.fleet"), null, routes(), host, selection(b))
        assertTrue(host.opened.isEmpty())
    }

    @Test fun `mismatched bar instance or feature host never borrows another selection`() {
        val b = building("berth")
        val host = FakeDispatcher(CommandBarUi(b.id, listOf(command("berth.fleet"), command("lodge.expedition"))))
        routeBuildingCommand(FeatureId("berth.fleet"), host.projected, routes(), host, selection(b).copy(buildingId = "another-berth"))
        routeBuildingCommand(FeatureId("lodge.expedition"), host.projected, routes(), host, selection(b))
        routeBuildingCommand(FeatureId("berth.fleet"), host.projected, routes(), host, null)
        assertTrue(host.opened.isEmpty())
    }

    @Test fun `retained tap passes its rendered selection unchanged for C3 stale identity refusal`() {
        val b = building("lodge")
        val host = FakeDispatcher(CommandBarUi(b.id, listOf(command("lodge.expedition"))))
        val rendered = selection(b).copy(baseId = "old-base")
        routeBuildingCommand(FeatureId("lodge.expedition"), host.projected, routes(), host, rendered)
        assertEquals(rendered, host.opened.single().second)
        // The producer must not substitute a new base/instance for the user's old rendered target.
    }

    @Test fun `ordinary callbacks retain their route gates when Phase E is mounted`() {
        val b = building("berth")
        val host = FakeDispatcher(null)
        var info = 0
        var review = 0
        val callbacks = routes(info = { info++ }, review = { review++ })
        val bar = CommandBarUi(b.id, listOf(command("building.info"), command("building.upgrade", state = CommandState.DISABLED)))
        routeBuildingCommand(BuildingCommandIds.INFO, bar, callbacks, host, selection(b))
        routeBuildingCommand(BuildingCommandIds.UPGRADE, bar, callbacks, host, selection(b))
        assertEquals(1, info)
        assertEquals(0, review)
        assertTrue(host.opened.isEmpty())
    }

    @Test fun `door owner facts decorate the projected door without changing its admission`() {
        // commands-5: a ready Harvester reads COLLECT with its "+24" and green "!", but only from its owner's fact; the
        // registry still decides whether the door exists and how it routes (the tap goes to C3 exactly as before).
        val b = building("harvester")
        val ready = BarDoorFact(stateLine = "Ready · 24 Ember Nodules", badge = gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi("!",
            gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone.READY, "Ready to collect"), value = "+24", readyToCollect = true)
        val host = FakeDispatcher(CommandBarUi(b.id, listOf(command("harvester.harvest", primary = true))))
        buildingCommandBar(state(b), b, gates(), false, 0L, host, BuildingBarExtras(harvester = ready))
        val entry = host.projections.single().second.entries.getValue(FeatureId("harvester.harvest"))
        assertTrue(entry.readyToCollect); assertEquals("+24", entry.value); assertEquals(ready.badge, entry.badge)
        assertFalse(entry.spending); assertEquals("ui:harvester-menu", entry.icon)
        val plain = FakeDispatcher(CommandBarUi(b.id, listOf(command("harvester.harvest", primary = true))))
        buildingCommandBar(state(b), b, gates(), false, 0L, plain)
        val none = plain.projections.single().second.entries.getValue(FeatureId("harvester.harvest"))
        assertFalse(none.readyToCollect); assertNull(none.value); assertNull(none.badge)
    }

    @Test fun `render selection rejects absent or blank identifiers without inventing a base`() {
        val b = building("berth")
        assertEquals(selection(b), phaseEBuildingSelection("actual-base", b))
        assertNull(phaseEBuildingSelection(null, b))
        assertNull(phaseEBuildingSelection(" ", b))
        assertNull(phaseEBuildingSelection("actual-base", b.copy(id = "")))
        assertNull(phaseEBuildingSelection("actual-base", b.copy(type = "")))
    }
}
