package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.renderer.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PreparedBaseSceneTest {
    private val original = buildJsonObject { put("baseId", "same-base"); put("features", buildJsonObject {
        put("phaseEArt", buildJsonObject { put("version", 1); put("enabled", true) })
    }) }
    private val body = RenderBuilding("original-building", "original-frame", 1f, 2f, 2f, 2f, type = "workshop")
    private val berth = body.copy(id = "original-berth", type = "berth", tileX = 5f)
    private val positive = BaseScene(listOf(body, berth), 30, 30, 64f, baseId = "same-base", services = RenderServiceFacts(true,
        listOf(RenderBerthPresentation(berth.id, RenderStarterInstallation("starter", RenderStarterPresence.AWAY))),
        listOf(RenderServiceActivity(body.id, RenderServiceState.WORKING))))
    private val accepted = PreparedBaseSceneResult(positive, rawSource = original)

    @Test fun `the exact successfully prepared response retains its owned facts`() {
        assertSame(accepted, accepted.forSource(original))
        assertSame(positive, accepted.forSource(original).scene)
    }
    @Test fun `pending response revocation strips facts synchronously while preserving geometry`() {
        val revoked = buildJsonObject { put("baseId", "same-base"); put("features", buildJsonObject {
            put("phaseEArt", buildJsonObject { put("version", 1); put("enabled", false) })
        }) }
        val pending = accepted.forSource(revoked)
        assertFalse(pending.failed)
        assertEquals(RenderServiceFacts(), pending.scene!!.services)
        assertEquals(positive.copy(services = RenderServiceFacts()), pending.scene)
        assertEquals(true, positive.services.phaseEArtEnabled)
    }
    @Test fun `unrelated mapper failure cannot restore retained permission or graft fresh facts onto old geometry`() {
        val failingResponse = JsonObject(original + buildJsonObject {
            put("features", buildJsonObject { put("phaseEArt", buildJsonObject { put("version", 1); put("enabled", false) }) })
            put("buildings", buildJsonArray { add(buildJsonObject { put("id", "new-building"); put("type", "unsupported-content") }) })
        })
        val failed = accepted.copy(failed = true).forSource(failingResponse)
        assertTrue(failed.failed)
        assertEquals(positive.buildings, failed.scene!!.buildings)
        assertEquals(RenderServiceFacts(), failed.scene.services)
        assertSame(original, failed.rawSource)
    }
    @Test fun `equal full immutable data keeps matching facts while absent permission closes them`() {
        val equalResponse = JsonObject(original.toMap())
        assertNotSame(original, equalResponse)
        assertSame(accepted, accepted.forSource(equalResponse))
        assertEquals(RenderServiceFacts(), accepted.forSource(JsonObject(original - "features")).scene!!.services)
    }
    @Test fun `only a successful matching replacement publishes that replacements service facts`() {
        val current = JsonObject(original + ("serverNow" to JsonPrimitive("2026-09-23T00:00:00.000Z")))
        val nextScene = positive.copy(services = RenderServiceFacts(false, emptyList(), emptyList()))
        val ready = PreparedBaseSceneResult(nextScene, rawSource = current)
        assertSame(nextScene, ready.forSource(current).scene)
        assertEquals(RenderServiceFacts(), ready.forSource(original).scene!!.services)
        assertNull(PreparedBaseSceneResult().forSource(current).scene)
    }

    @Test fun `preparation diagnostic preserves a safe exception class and fixed message`() {
        assertEquals("base scene preparation failed: IllegalArgumentException: Failed requirement.",
            baseSceneFailureDiagnostic(IllegalArgumentException("Failed requirement.")))
        assertEquals("base scene preparation failed: IllegalStateException: Missing terrain contract",
            baseSceneFailureDiagnostic(IllegalStateException("Missing terrain contract")))
        assertEquals("base scene preparation failed: IllegalStateException: <no message>",
            baseSceneFailureDiagnostic(IllegalStateException()))
    }
    @Test fun `preparation diagnostic never includes account body secret or multiline exception details`() {
        val message = "base=private-base wallet=private-wallet Cookie=private-cookie\nBearer private-token"
        val note = baseSceneFailureDiagnostic(IllegalArgumentException(message))
        assertEquals("base scene preparation failed: IllegalArgumentException: <redacted>", note)
        for (secret in listOf("private-base", "private-wallet", "private-cookie", "private-token", "\n"))
            assertFalse(note.contains(secret))
        assertEquals("base scene preparation failed: IllegalArgumentException: <redacted>",
            baseSceneFailureDiagnostic(IllegalArgumentException("Failed requirement. " + message)))
    }
}
