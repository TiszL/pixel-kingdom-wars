package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * D-NEXT (N5): `GET /native/capabilities` carries the server's kill switch for the GL30 world, `worldV2: { enabled }`
 * (backend PR #143, default on, always sent). If the new world breaks on players' phones, the owner turns it off for
 * every native client without a release; the switch must therefore decode on every build that reads it, and a bad value
 * must never cost the response the fields that gate orders and content.
 */
class NativeCapabilitiesWorldV2Test {
    private fun json(value: String) = Json.parseToJsonElement(value).jsonObject
    private val base = """"protocolVersion":1,"simVersion":17,"minimumVersionCode":3,"contentManifestUrl":"https://play.pixelkingdomwars.com/native-content/manifest.json","presentation":{"enabled":true}"""

    /** The candidate backend's bodies (branch native-world-v2-switch, e3561d9d + 67f5051c): `GET /native/capabilities`
     * injected into `buildApp(TEST_CONFIG)` and into the same app with `NATIVE_WORLD_V2_ENABLED=false`, exactly as its
     * `native-world-v2.test.ts` builds them. Generated once (2026-09-26), never edited by hand. */
    private fun backend(name: String): JsonObject =
        json(requireNotNull(javaClass.getResourceAsStream("/native-capabilities/world-v2-$name.json")) { name }.use { it.readBytes().toString(Charsets.UTF_8) })

    /** Frozen copy of the code 25 (0.5.8, source c5651ea) wire model with its exact field set. Do not edit: it stands in for
     * the decoder already shipped on real Seekers, which the additive key must stay invisible to. */
    @Serializable private data class Code25NativeCapabilities(
        val protocolVersion: Int,
        val simVersion: Long,
        val minimumVersionCode: Long = 0,
        val contentManifestUrl: String? = null,
        val presentation: PresentationCapability? = null,
    )
    /** Code 25's `ApiJson` (c5651ea `Decoding.kt`), frozen for the same reason. */
    private val code25Json = Json { ignoreUnknownKeys = true; coerceInputValues = false; explicitNulls = false }

    @Test fun `code 25 decodes the backend's body identically with the switch on and off`() {
        // Code 25 is on real Seekers and must never notice the switch: if its view differed, or the key broke its decode,
        // turning the new world off would also stop code 25's content and minimum-build checks (K-132 class risk).
        val on = backend("on"); val off = backend("off")
        assertEquals("the fixtures are the switch's two states", json("""{"enabled":true}"""), on["worldV2"])
        assertEquals(json("""{"enabled":false}"""), off["worldV2"])
        val viewOn = code25Json.decodeFromJsonElement(Code25NativeCapabilities.serializer(), on)
        val viewOff = code25Json.decodeFromJsonElement(Code25NativeCapabilities.serializer(), off)
        assertEquals(viewOn, viewOff)
        assertEquals(Code25NativeCapabilities(1, 17, 0, null, PresentationCapability(false)), viewOn)
        // the switch is purely additive: nothing but worldV2 differs between the two bodies
        assertEquals(JsonObject(on - "worldV2"), JsonObject(off - "worldV2"))
    }

    @Test fun `this build reads the backend's switch in both states`() {
        assertEquals(WorldV2Capability(true), NativeCapabilities.from(backend("on")).worldV2)
        assertEquals("off is the incident lever: it must reach the client as off", WorldV2Capability(false), NativeCapabilities.from(backend("off")).worldV2)
    }

    @Test fun `an absent switch is no value, so the client keeps what it last read`() {
        // Older servers and route fixtures omit the key: absent must never read as off (or as a fresh on over a cached off).
        assertNull(NativeCapabilities.from(json("{$base}")).worldV2)
        assertEquals("an empty object is the server's default: on", WorldV2Capability(true), NativeCapabilities.from(json("{$base,\"worldV2\":{}}")).worldV2)
        assertEquals(WorldV2Capability(false), NativeCapabilities.from(json("{$base,\"worldV2\":{\"enabled\":false}}")).worldV2)
    }

    @Test fun `a malformed switch is dropped without costing the rest of the capabilities`() {
        // minimumVersionCode and the content manifest gate orders and art; a broken switch must not take them down.
        listOf("null", "false", "7", "\"off\"", "[]", """{"enabled":"no"}""", """{"enabled":null}""", """{"enabled":0}""").forEach { bad ->
            val decoded = NativeCapabilities.from(json("{$base,\"worldV2\":$bad}"))
            assertNull(bad, decoded.worldV2)
            assertEquals(bad, 3L, decoded.minimumVersionCode)
            assertEquals(bad, "https://play.pixelkingdomwars.com/native-content/manifest.json", decoded.contentManifestUrl)
            assertEquals(bad, PresentationCapability(true), decoded.presentation)
        }
    }
}
