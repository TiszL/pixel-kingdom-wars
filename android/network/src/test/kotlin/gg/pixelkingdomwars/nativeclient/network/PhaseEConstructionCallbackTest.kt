package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CancellationException

/** Callback boundary only. IW1 owns the existing real-row ConstructionAvailabilityTest successor. */
class PhaseEConstructionCallbackTest {
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private val base = json("""{"features":{"phaseEBuildings":{"version":1,"enabledTypes":["workshop"]}}}""")
    private val catalogue = json("""{"constants":{"PHASE_E_BUILDINGS":{"types":["workshop"]},
        "BUILD_COSTS":{"workshop":{"costShards":13,"buildSec":17,"requiresKeepLevel":3}},
        "STRUCTURES":{"workshop":{"hp":19,"maxLevel":20,"footprint":[2,2]}},
        "BUILD_COUNT_CAP_BY_KEEP":{"workshop":[0,0,1]}}}""")
    private val entry = json("""{"type":"workshop","level":1,"phaseE":{"facility":"workshop","tier":1},"footprintWidth":2,"footprintHeight":2}""")
    private val render = JsonObject(mapOf("entries" to JsonArray(listOf(entry))))
    @Test fun `Phase E requires an explicit capability while legacy admission is unchanged`() {
        assertTrue(phaseEConstructionChoices(base, catalogue, render).isEmpty())
        assertTrue(constructionStartAvailable(null, null, null, "cannon"))
        assertTrue(constructionStartAvailable(null, null, null, "keep", 2))
        assertFalse(constructionStartAvailable(base, catalogue, render, "futuretype", art = PhaseEConstructionArt { true }))
    }
    @Test fun `the callback receives exact inputs and the selected building identity`() {
        var observed: PhaseEConstructionArtRequest? = null
        assertTrue(constructionStartAvailable(base, catalogue, render, "workshop", art = PhaseEConstructionArt { observed = it; true }, buildingId = "selected"))
        assertSame(base, observed!!.base); assertSame(catalogue, observed!!.catalogue); assertSame(render, observed!!.renderCatalogue)
        assertSame(entry, observed!!.entry); assertEquals("workshop", observed!!.type); assertEquals(1, observed!!.level)
        assertEquals("selected", observed!!.buildingId)
    }
    @Test fun `flag and economy refusal happen before any art callback`() {
        var calls = 0; val art = PhaseEConstructionArt { calls++; true }
        assertTrue(phaseEConstructionChoices(JsonObject(emptyMap()), catalogue, render, art = art).isEmpty())
        assertTrue(phaseEConstructionChoices(base, json("""{"constants":{}}"""), render, art = art).isEmpty())
        assertEquals(0, calls)
    }
    @Test fun `ambiguous missing or wrong footprint rows cannot reach the callback`() {
        var calls = 0; val art = PhaseEConstructionArt { calls++; true }
        for (rows in listOf(listOf(entry, entry), emptyList(), listOf(JsonObject(entry + ("footprintWidth" to JsonPrimitive(1))))))
            assertTrue(phaseEConstructionChoices(base, catalogue, JsonObject(mapOf("entries" to JsonArray(rows))), art = art).isEmpty())
        assertEquals(0, calls)
    }
    @Test fun `a supplied boolean cannot admit a legacy frame as a Phase E fallback`() {
        var calls = 0; val art = PhaseEConstructionArt { calls++; true }
        for (row in listOf(JsonObject(entry - "phaseE"), JsonObject(entry + ("frameKey" to JsonPrimitive("fake"))),
            JsonObject(entry + ("atlasPath" to JsonPrimitive("fake"))), JsonObject(entry + ("motion" to JsonNull))))
            assertTrue(phaseEConstructionChoices(base, catalogue, JsonObject(mapOf("entries" to JsonArray(listOf(row)))), art = art).isEmpty())
        assertEquals(0, calls)
    }
    @Test fun `ordinary admission refusal is contained but cancellation still propagates`() {
        assertTrue(phaseEConstructionChoices(base, catalogue, render, art = PhaseEConstructionArt { throw IllegalArgumentException("private") }).isEmpty())
        try { phaseEConstructionChoices(base, catalogue, render, art = PhaseEConstructionArt { throw CancellationException() }); fail("Cancellation must propagate") }
        catch (_: CancellationException) { }
    }
}
