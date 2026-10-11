package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** M45 §1 adds an optional `update` object to `GET /native/capabilities`. Code 25 (0.5.8) is installed on real
 * Seekers and decodes this response on every launch; the additive key must never break it (K-132 class risk). */
class NativeCapabilitiesUpdateTest {
    private fun json(value: String) = Json.parseToJsonElement(value).jsonObject
    private val sha = "a".repeat(64); private val signer = "b".repeat(64)
    private val offer = """{"latestVersionCode":26,"versionName":"0.5.9","sourceCommit":"${"c".repeat(40)}","apkPath":"/native/releases/26-$sha.apk",
        "apkUrl":"https://play.pixelkingdomwars.com/native/releases/26-$sha.apk","sha256":"$sha","sizeBytes":225576834,"signerSha256":"$signer",
        "publishedAt":"2026-09-25T10:00:00.000Z","storeStatus":"pending","channel":"tester","mandatory":false,"notesUrl":null}"""
    private val base = """"protocolVersion":1,"simVersion":16,"minimumVersionCode":0,"contentManifestUrl":"https://play.pixelkingdomwars.com/native-content/manifest.json","presentation":{"enabled":true}"""

    /** Frozen copy of the code 25 (source c5651ea) wire model with its exact 0.5.8 field set. Do not edit: it stands in
     * for the decoder already shipped on devices, which is what the server's additive key must stay compatible with. */
    @Serializable private data class Code25NativeCapabilities(
        val protocolVersion: Int,
        val simVersion: Long,
        val minimumVersionCode: Long = 0,
        val contentManifestUrl: String? = null,
        val presentation: PresentationCapability? = null,
    )

    @Test fun `the shipped code 25 decoder ignores the update key and keeps every existing field`() {
        // If this fails, a capabilities response carrying an offer would stop code 25 checking content and minimum builds.
        val decoded = json("{$base,\"update\":$offer}").decode<Code25NativeCapabilities>()
        assertEquals(Code25NativeCapabilities(1, 16, 0, "https://play.pixelkingdomwars.com/native-content/manifest.json", PresentationCapability(true)), decoded)
    }
    @Test fun `capabilities decode with and without the optional offer`() {
        // The key is absent (never null) when the channel is off; absence must mean "no offer", not a decode failure.
        assertNull(NativeCapabilities.from(json("{$base}")).update)
        val update = requireNotNull(NativeCapabilities.from(json("{$base,\"update\":$offer}")).update)
        assertEquals(26L, update.latestVersionCode); assertEquals("0.5.9", update.versionName)
        assertEquals("/native/releases/26-$sha.apk", update.apkPath); assertEquals(sha, update.sha256)
        assertEquals(225576834L, update.sizeBytes); assertEquals(signer, update.signerSha256)
        assertEquals("tester", update.channel); assertFalse(update.mandatory); assertNull(update.notesUrl)
    }
    @Test fun `a malformed offer is dropped without costing the rest of the capabilities`() {
        // minimumVersionCode and the content manifest gate orders and art; a broken offer must not take them down.
        listOf("null", "7", """{"latestVersionCode":26}""", offer.replace("225576834", "\"many\"")).forEach { bad ->
            val decoded = NativeCapabilities.from(json("{$base,\"minimumVersionCode\":3,\"update\":$bad}".replace("\"minimumVersionCode\":0,", "")))
            assertNull(bad, decoded.update); assertEquals(3L, decoded.minimumVersionCode)
            assertEquals("https://play.pixelkingdomwars.com/native-content/manifest.json", decoded.contentManifestUrl)
        }
    }
}
