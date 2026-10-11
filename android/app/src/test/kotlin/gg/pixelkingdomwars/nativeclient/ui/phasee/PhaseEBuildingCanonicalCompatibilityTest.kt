package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.ui.features.*
import org.junit.Assert.*
import org.junit.Test

/** Additive compatibility cases; uses the actual inherited registry and Opus FeatureId. */
class PhaseEBuildingCanonicalCompatibilityTest {
    @Test fun `aggregate doors are never flattened into an arbitrary legacy leaf`() {
        for (id in listOf("workshop.craft", "market.trade", "lodge.expedition", "berth.fleet")) {
            assertNull(id, existingPhaseEDoor(FeatureId(id)))
        }
        assertEquals(PhaseEActivity.HARVESTERS, existingPhaseEDoor(FeatureId("harvester.harvest")))
    }

    @Test fun `Berth SERVICE remains an exact typed tab distinct from FLEET`() {
        val context = GateContext(
            baseId = "home", buildings = mapOf("berth" to BuildingGateState(1, true)),
            serverFeatures = mapOf("phaseE.vehicles" to GateFact.Allowed),
            ownerFacts = mapOf("building.jobRunning" to GateFact.Denied("No running job")),
            selection = FeatureSelection(building = BuildingSelection("home", "berth-1", "berth")),
        )
        val registry = FeatureRegistry.canonical()
        assertEquals(FeatureResolution.Navigate(Destination.Berth("SERVICE")),
            registry.resolve(FeatureId("berth.service"), context))
        assertEquals(FeatureResolution.Navigate(Destination.Berth("FLEET")),
            registry.resolve(FeatureId("berth.fleet"), context))
        assertNull(existingPhaseEDoor(FeatureId("berth.service")))
    }

    @Test fun `legacy callers still retain their advertised individual owner actions`() {
        val advertised = setOf(PhaseEActivity.INGOT_WORKSHOP, PhaseEActivity.REFINING,
            PhaseEActivity.WORKSHOP, PhaseEActivity.COSMETICS)
        val base = gg.pixelkingdomwars.nativeclient.model.BaseSnapshot.from(
            kotlinx.serialization.json.Json.parseToJsonElement("""{
                "baseId":"home","player":{"keepLevel":5},
                "buildings":[{"id":"w","type":"workshop","level":1,"tx":1,"ty":1}]
            }""") as kotlinx.serialization.json.JsonObject)
        assertEquals(advertised.toList(), PhaseEBuildingActions.actions(base, "w", "home", advertised))
        assertTrue(PhaseEBuildingActions.actions(base, "w", "home", emptySet()).isEmpty())
    }
}
