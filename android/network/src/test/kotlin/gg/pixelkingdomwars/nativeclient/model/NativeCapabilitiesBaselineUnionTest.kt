package gg.pixelkingdomwars.nativeclient.model

import gg.pixelkingdomwars.nativeclient.generated.NativeCapabilitiesDto
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The source union must keep economy/art parsing and released world/update fields together.
 * These are decoding checks only: no content pack or APK offer is admitted by decoding it. */
class NativeCapabilitiesBaselineUnionTest {
    /** Existing unedited buildApp capture from the released world-switch contract. Its omitted
     * phaseEArt matches primary b1d9971a9 native/contracts.ts and native/routes.ts. */
    private fun backend(): JsonObject = Json.parseToJsonElement(requireNotNull(
        javaClass.getResourceAsStream("/native-capabilities/world-v2-on.json")
    ).use { it.readBytes().toString(Charsets.UTF_8) }).jsonObject

    private val legacyArt = buildJsonObject { put("version", 1); put("enabled", true) }
    // Synthetic advisory offer, following the existing update decoder fixture. No install evidence.
    private val offer = buildJsonObject {
        put("latestVersionCode", 26); put("versionName", "0.5.9"); put("sourceCommit", "c".repeat(40))
        put("apkPath", "/native/releases/26-${"a".repeat(64)}.apk")
        put("apkUrl", "https://play.pixelkingdomwars.com/native/releases/26-${"a".repeat(64)}.apk")
        put("sha256", "a".repeat(64)); put("sizeBytes", 225576834); put("signerSha256", "b".repeat(64))
        put("publishedAt", "2026-09-25T10:00:00.000Z"); put("storeStatus", "pending")
        put("channel", "tester"); put("mandatory", false); put("notesUrl", JsonNull)
    }

    @Test fun `normal captured omission remains readable in generated and handwritten models`() {
        val raw = backend()
        assertFalse(raw.containsKey("phaseEArt"))
        val generated = raw.decode<NativeCapabilitiesDto>()
        val view = NativeCapabilities.from(raw)
        assertNull(generated.phaseEArt); assertNull(view.phaseEArt)
        assertEquals(raw["economy"], generated.economy)
        assertNotNull(view.economy)
        assertEquals(raw["worldV2"], generated.worldV2)
        assertEquals(WorldV2Capability(true), view.worldV2)
    }

    @Test fun `legacy art and economy coexist with world and an advisory update without replacing either`() {
        val original = backend()
        val raw = JsonObject(original + mapOf("phaseEArt" to legacyArt, "update" to offer))
        val generated = raw.decode<NativeCapabilitiesDto>()
        val view = NativeCapabilities.from(raw)
        assertEquals(legacyArt, generated.phaseEArt); assertEquals(offer, generated.update)
        assertEquals(original["economy"], generated.economy)
        assertEquals(NativeCapabilities.from(original).economy, view.economy)
        assertEquals(PhaseEArtCapability(1, true), view.phaseEArt)
        assertEquals(WorldV2Capability(true), view.worldV2)
        assertEquals(26L, requireNotNull(view.update).latestVersionCode)
        assertEquals(NativeCapabilities.from(original).simVersion, view.simVersion)
    }

    @Test fun `malformed optional world or update cannot erase preserved economy and legacy art`() {
        val original = backend()
        val expected = NativeCapabilities.from(original)
        for ((field, bad) in listOf("worldV2" to JsonPrimitive(7),
            "worldV2" to buildJsonObject { put("enabled", "invalid") },
            "update" to JsonPrimitive(7), "update" to JsonObject(offer + ("sizeBytes" to JsonPrimitive("many"))))) {
            val raw = JsonObject(original + mapOf("phaseEArt" to legacyArt, "update" to offer, field to bad))
            val view = NativeCapabilities.from(raw)
            if (field == "worldV2") { assertNull(view.worldV2); assertNotNull(view.update) }
            else { assertNull(view.update); assertEquals(WorldV2Capability(true), view.worldV2) }
            assertEquals(expected.economy, view.economy)
            assertEquals(expected.minimumVersionCode, view.minimumVersionCode)
            assertEquals(expected.contentManifestUrl, view.contentManifestUrl)
            assertEquals(PhaseEArtCapability(1, true), view.phaseEArt)
        }
    }
}
