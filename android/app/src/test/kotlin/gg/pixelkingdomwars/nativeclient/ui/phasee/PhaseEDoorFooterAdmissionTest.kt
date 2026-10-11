package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Supporting behavioral checks of the existing registry and action adapter only.
 * These do not invoke BuildingSheet or prove Compose recomposition, and may already
 * pass on the pre-fix source. The source-contract class carries the B3 RED checks.
 */
class PhaseEDoorFooterAdmissionTest {
    private fun base(): BaseSnapshot = BaseSnapshot.from(Json.parseToJsonElement("""{
        "baseId":"home","player":{"keepLevel":5},
        "buildings":[{"id":"selected","type":"workshop","level":1,"tx":1,"ty":1,"underConstruction":false}]
    }""").jsonObject)

    @Test fun `history registration alone supplies no selected building footer actions`() {
        val registry = PhaseEActivityRegistry()
        registry.registerDoor(PhaseEActivity.WORKSHOP, Any(), { false },
            { fail("Reading footer admission must never launch new work") },
            { fail("Reading footer admission must never open history") })
        assertEquals(listOf(PhaseEActivity.WORKSHOP), registry.registered)
        assertEquals(listOf(PhaseEActivity.WORKSHOP), registry.available)
        assertTrue(registry.launchable.isEmpty())
        val base = base()
        assertTrue(PhaseEBuildingActions.actions(base, "selected", base.baseId, registry.launchable.toSet()).isEmpty())
        assertFalse(registry.expanded)
    }

    @Test fun `guard withdrawal and disposal remove footer actions without replacing the registry`() {
        val registry = PhaseEActivityRegistry()
        var admitted = true
        registry.registerDoor(PhaseEActivity.WORKSHOP, Any(), { admitted },
            { fail("Reading footer admission must not launch the owner") }, null)
        val base = base()
        assertEquals(listOf(PhaseEActivity.WORKSHOP),
            PhaseEBuildingActions.actions(base, "selected", base.baseId, registry.launchable.toSet()))

        admitted = false
        assertTrue(PhaseEBuildingActions.actions(base, "selected", base.baseId, registry.launchable.toSet()).isEmpty())
        admitted = true
        assertEquals(listOf(PhaseEActivity.WORKSHOP),
            PhaseEBuildingActions.actions(base, "selected", base.baseId, registry.launchable.toSet()))

        registry.dispose()
        assertTrue(PhaseEBuildingActions.actions(base, "selected", base.baseId, registry.launchable.toSet()).isEmpty())
    }
}
