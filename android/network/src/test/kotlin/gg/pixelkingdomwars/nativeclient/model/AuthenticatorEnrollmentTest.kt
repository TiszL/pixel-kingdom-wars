package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class AuthenticatorEnrollmentTest {
    private val secret = "JBSWY3DPEHPK3PXP"
    private val png = java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1cAAAAASUVORK5CYII=")
    private fun response(uri: String?) = buildJsonObject { put("secret", secret); uri?.let { put("qrDataUri", it) } }
    private fun uri(bytes: ByteArray = png) = "data:image/png;base64," + java.util.Base64.getEncoder().encodeToString(bytes)

    @Test fun `server inline PNG is available only in redacted ephemeral enrollment`() {
        val setup = AuthenticatorEnrollment.from(response(uri()))
        assertArrayEquals(png, setup.qrPng)
        assertFalse(setup.toString().contains(secret))
        assertFalse(setup.toString().contains("base64"))
        val retained = setup.qrPng!!
        setup.clearQr()
        assertTrue(retained.all { it == 0.toByte() })
    }

    @Test fun `older servers and unusable QR images preserve manual setup without network fallback`() {
        listOf(null, "https://example.com/secret.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,broken", "data:image/png;base64," + "A".repeat(131_072)).forEach { value ->
            val setup = AuthenticatorEnrollment.from(response(value))
            assertEquals(secret, setup.secret); assertNull(setup.qrPng)
        }
    }

    @Test fun `oversized PNG dimensions are rejected before Android allocates pixels`() {
        val bytes = png.copyOf()
        java.nio.ByteBuffer.wrap(bytes).putInt(16, Int.MAX_VALUE)
        assertNull(AuthenticatorEnrollment.from(response(uri(bytes))).qrPng)
    }
}
