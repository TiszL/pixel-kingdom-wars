package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import org.junit.Assert.*
import org.junit.Test

/** Canonical doors dispatch through the same session registry. All cases are authored, UNRUN. */
class PhaseECanonicalRegistryTest {
    @Test fun `canonical Workshop and Market doors reach their existing owners`() {
        val registry = PhaseEActivityRegistry(); val opened = mutableListOf<PhaseEActivity>()
        for (activity in listOf(PhaseEActivity.WORKSHOP, PhaseEActivity.INGOT_WORKSHOP,
            PhaseEActivity.REFINING, PhaseEActivity.COSMETICS, PhaseEActivity.KEEP_MARKET))
            registry.registerDoor(activity, Any(), { true }, { opened += activity }, null)
        for (id in listOf("workshop.equipment", "workshop.ingots", "workshop.refine", "workshop.cosmetics", "market.keepMarket"))
            assertTrue(registry.launchFeature(FeatureId(id)))
        assertEquals(listOf(PhaseEActivity.WORKSHOP, PhaseEActivity.INGOT_WORKSHOP,
            PhaseEActivity.REFINING, PhaseEActivity.COSMETICS, PhaseEActivity.KEEP_MARKET), opened)
    }
    @Test fun `three vehicle entries carry distinct section requests through one owner`() {
        val registry = PhaseEActivityRegistry(); val owner = Any(); val opened = mutableListOf<VehicleEntryPoint>()
        for (point in VehicleEntryPoint.entries)
            registry.registerFeatureDoor(point.featureId, owner, { true }, { opened += point })
        for (id in listOf("berth.vehicles", "lodge.dispatch", "island.solana.public")) assertTrue(registry.launchFeature(FeatureId(id)))
        assertEquals(listOf(VehicleEntryPoint.BERTH, VehicleEntryPoint.LODGE, VehicleEntryPoint.SOLANA_PUBLIC), opened)
        assertEquals("fleet", VehicleEntryPoint.BERTH.page)
        assertEquals("fleet", VehicleEntryPoint.LODGE.page)
        assertEquals("craft", VehicleEntryPoint.SOLANA_PUBLIC.page)
    }
    @Test fun `an unbound island rewards hub never chooses an arbitrary legacy claim owner`() {
        val registry = PhaseEActivityRegistry()
        for (activity in listOf(PhaseEActivity.MINING_TAX, PhaseEActivity.SHARDS, PhaseEActivity.RESOURCES))
            registry.registerDoor(activity, Any(), { true }, { fail("A hub needs its owning island callback") }, null)
        assertFalse(registry.launchFeature(FeatureId("island.seeker.rewards")))
        assertFalse(registry.launchFeature(FeatureId("unknown.feature")))
    }
    @Test fun `feature guard failure does not fall through to another owner or old primary`() {
        val registry = PhaseEActivityRegistry(); val id = FeatureId("workshop.equipment"); var current = false; var opened = 0
        registry.registerDoor(PhaseEActivity.WORKSHOP, Any(), { true }, { fail("No fallback after explicit refusal") }, null)
        registry.registerFeatureDoor(id, Any(), { current }, { opened++ })
        assertFalse(registry.launchFeature(id)); assertEquals(0, opened)
        current = true; assertTrue(registry.launchFeature(id)); assertEquals(1, opened)
        registry.dispose(); assertFalse(registry.launchFeature(id)); assertEquals(1, opened)
    }
    @Test fun `retired feature registration cannot remove the current replacement`() {
        val registry = PhaseEActivityRegistry(); val id = FeatureId("lodge.dispatch"); val old = Any(); val current = Any(); var count = 0
        registry.registerFeatureDoor(id, old, { true }, { fail("Retired callback") })
        registry.registerFeatureDoor(id, current, { true }, { count++ })
        registry.unregisterFeature(id, old)
        assertTrue(registry.launchFeature(id)); assertEquals(1, count)
        registry.unregisterFeature(id, current); assertFalse(registry.launchFeature(id))
    }
    @Test fun `feature callback is closed before dispatch and cannot recursively dispatch another feature`() {
        val registry = PhaseEActivityRegistry(); val id = FeatureId("lodge.dispatch"); var count = 0
        registry.register(PhaseEActivity.WORKSHOP, Any()) {}
        registry.open()
        registry.registerFeatureDoor(id, Any(), { true }, {
            assertFalse(registry.expanded); count++
            assertFalse(registry.launchFeature(id)); assertFalse(registry.launch(PhaseEActivity.WORKSHOP))
        })
        assertTrue(registry.launchFeature(id)); assertEquals(1, count)
    }
}
