package gg.pixelkingdomwars.nativeclient

import java.security.MessageDigest

/** Pure test-only predicate shared by androidTest and JVM tests, never a main source set.
 * The host separately binds owner consent and the exact serial. This build proof
 * is runtime MODEL|PRODUCT|FINGERPRINT, not a serial or a wallet authorization. */
internal object LocalUiDeviceAdmission {
    fun permits(
        debug: Boolean,
        hardware: String,
        expectedPhysicalDevice: String,
        model: String,
        product: String,
        fingerprint: String,
    ): Boolean {
        if (!debug) return false
        if (hardware == "ranchu") return true
        if (!expectedPhysicalDevice.matches(Regex("[a-f0-9]{64}"))) return false
        val fields = listOf(model, product, fingerprint)
        // Preserve exact field bytes; separators/control characters must not let
        // distinct field tuples produce the same delimited proof input.
        if (fields.any { it.isBlank() || it.any { character -> character in "|\r\n\u0000" } }) return false
        val actual = MessageDigest.getInstance("SHA-256")
            .digest(fields.joinToString("|").toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
        return MessageDigest.isEqual(
            expectedPhysicalDevice.toByteArray(Charsets.US_ASCII), actual.toByteArray(Charsets.US_ASCII))
    }
}
