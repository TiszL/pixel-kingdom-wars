package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.ui.features.BuildingSelection
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

/** Additive B3 contract cases against B2 6e42f470. Authored only; no RED/GREEN execution. */
class PhaseEBuildingDispatcherTest {
    private fun building(type: String = "workshop", id: String = "selected") =
        Building(id, type, level = 1, tx = 1, ty = 1)

    private fun base(vararg buildings: Building, id: String? = "home") = BaseSnapshot(
        baseId = id, visualContext = null, player = PlayerSummary(keepLevel = 5),
        energy = null, armyStatus = null, claim = null, buildings = buildings.toList(),
        obstacles = emptyList(), jobs = emptyList(), freeBuilders = 1, raw = JsonObject(emptyMap()),
    )

    private class Harness(initial: BuildingSelection?) {
        var selection = initial
        val features = mutableListOf<FeatureId>()
        val resources = mutableListOf<Pair<FeatureId, Destination.Resources>>()
        val dispatcher = PhaseEBuildingDispatcher(
            openFeature = { features += it },
            openResources = { id, destination -> resources += id to destination },
            currentSelection = { selection },
        )
    }

    private fun harness(b: Building) = Harness(BuildingSelection("home", b.id, b.type))
    private fun assertDoor(type: String, feature: String) {
        val b = building(type); val h = harness(b)
        h.dispatcher.openBuilding("home", b, base(b))
        assertEquals(listOf(FeatureId(feature)), h.features)
        assertTrue(h.resources.isEmpty())
    }

    @Test fun `Workshop emits the aggregate craft door`() = assertDoor("workshop", "workshop.craft")
    @Test fun `Market emits the aggregate trade door`() = assertDoor("market", "market.trade")
    @Test fun `Harvester emits the harvest door`() = assertDoor("harvester", "harvester.harvest")
    @Test fun `Lodge emits the aggregate expedition door`() = assertDoor("lodge", "lodge.expedition")
    @Test fun `Berth emits the aggregate fleet door`() = assertDoor("berth", "berth.fleet")

    @Test fun `enqueue leaves the selected building intact until the consumer decides`() {
        val b = building(); val h = harness(b); val before = h.selection
        val result: Unit = h.dispatcher.openBuilding("home", b, base(b))
        assertEquals(Unit, result)
        assertSame(before, h.selection)
        assertEquals(listOf(FeatureId("workshop.craft")), h.features)
    }

    @Test fun `missing current selection refuses enqueue`() {
        val b = building(); val h = Harness(null)
        h.dispatcher.openBuilding("home", b, base(b))
        assertTrue(h.features.isEmpty())
    }

    @Test fun `another selected building of the same type refuses a stale rendered door`() {
        val b = building(); val other = building(id = "other"); val h = harness(b)
        h.selection = BuildingSelection("home", other.id, other.type)
        h.dispatcher.openBuilding("home", b, base(b, other))
        assertTrue(h.features.isEmpty())
    }

    @Test fun `selection type mismatch refuses enqueue`() {
        val b = building(); val h = harness(b)
        h.selection = BuildingSelection("home", b.id, "market")
        h.dispatcher.openBuilding("home", b, base(b))
        assertTrue(h.features.isEmpty())
    }

    @Test fun `selection in a different base refuses enqueue even if id and type match`() {
        val b = building(); val h = harness(b)
        h.selection = BuildingSelection("away", b.id, b.type)
        h.dispatcher.openBuilding("home", b, base(b))
        assertTrue(h.features.isEmpty())
    }

    @Test fun `missing live base refuses enqueue`() {
        val b = building(); val h = harness(b)
        h.dispatcher.openBuilding("home", b, null)
        assertTrue(h.features.isEmpty())
    }

    @Test fun `changed live base refuses enqueue even if the building id was reused`() {
        val b = building(); val h = harness(b)
        h.dispatcher.openBuilding("home", b, base(b, id = "away"))
        assertTrue(h.features.isEmpty())
    }

    @Test fun `missing rendered base id never matches a missing live base id`() {
        val b = building(); val h = harness(b)
        h.dispatcher.openBuilding(null, b, base(b, id = null))
        assertTrue(h.features.isEmpty())
    }

    @Test fun `removed building refuses enqueue`() {
        val b = building(); val h = harness(b)
        h.dispatcher.openBuilding("home", b, base())
        assertTrue(h.features.isEmpty())
    }

    @Test fun `duplicate live building identities refuse enqueue`() {
        val b = building(); val h = harness(b)
        h.dispatcher.openBuilding("home", b, base(b, b.copy(tx = 2)))
        assertTrue(h.features.isEmpty())
    }

    @Test fun `replaced building type refuses enqueue`() {
        val b = building(); val h = harness(b)
        h.dispatcher.openBuilding("home", b, base(b.copy(type = "market")))
        assertTrue(h.features.isEmpty())
    }

    @Test fun `current construction state refuses a formerly completed door`() {
        val b = building(); val h = harness(b)
        h.dispatcher.openBuilding("home", b, base(b.copy(underConstruction = true)))
        assertTrue(h.features.isEmpty())
    }

    @Test fun `zero level refuses enqueue`() {
        val b = building(); val h = harness(b)
        h.dispatcher.openBuilding("home", b, base(b.copy(level = 0)))
        assertTrue(h.features.isEmpty())
    }

    @Test fun `unsupported building does not gain a Phase E door`() {
        val b = building("keep"); val h = harness(b)
        h.dispatcher.openBuilding("home", b, base(b))
        assertTrue(h.features.isEmpty())
    }

    @Test fun `selection is read afresh for each click without replacing the dispatcher`() {
        val b = building(); val h = harness(b)
        h.dispatcher.openBuilding("home", b, base(b))
        h.selection = null
        h.dispatcher.openBuilding("home", b, base(b))
        assertEquals(listOf(FeatureId("workshop.craft")), h.features)
    }

    @Test fun `resource callback preserves its exact resource address and feature id`() {
        val h = Harness(null); val id = FeatureId("hud.resources")
        val target = Destination.Resources("forge_ingot")
        h.dispatcher.openResources(id, target)
        assertEquals(listOf(id to target), h.resources)
        assertSame(target, h.resources.single().second)
        assertTrue(h.features.isEmpty())
    }

    @Test fun `resource callback preserves null focus without choosing a resource`() {
        val h = Harness(null); val id = FeatureId("hud.resources")
        h.dispatcher.openResources(id, Destination.Resources())
        assertEquals(listOf(id to Destination.Resources()), h.resources)
    }
}
