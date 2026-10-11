package gg.pixelkingdomwars.nativeclient.model

import java.time.Instant
import java.util.UUID
import kotlinx.serialization.json.*

/** Full account-only /2fa/status contract. Missing or mistyped flags never mean “no factor”. */
data class AccountSecurityStatus(
    val totpEnabled: Boolean, val emailVerified: Boolean, val email: String?, val pendingEmail: String?,
    val totpReady: Boolean, val totpReadyAt: String?, val instantEligible: Boolean,
    val instantWithdrawalsEnabled: Boolean, val reenrollmentRequired: Boolean,
    val loginTotpRequired: Boolean, val recoveryEnabled: Boolean, val recovery: AuthenticatorRecovery,
) {
    val replacementRequired get() = reenrollmentRequired || recovery.reenrollmentRequired
    val factorsLocked get() = recovery.phase == RecoveryPhase.EMAIL_PENDING || recovery.phase == RecoveryPhase.HOLDING
    companion object {
        fun from(raw: JsonObject) = AccountSecurityStatus(
            raw.securityFlag("totpEnabled"), raw.securityFlag("emailVerified"), raw.securityText("email"), raw.securityText("pendingEmail"),
            raw.securityFlag("totpReady"), raw.securityTime("totpReadyAt"), raw.securityFlag("instantEligible"),
            raw.securityFlag("instantWithdrawalsEnabled"), raw.securityFlag("reenrollmentRequired"),
            raw.securityFlag("loginTotpRequired"), raw.securityFlag("recoveryEnabled"),
            AuthenticatorRecovery.from(requireNotNull(raw["recovery"] as? JsonObject)),
        )
    }
}

enum class RecoveryPhase(val wire: String) {
    EMAIL_PENDING("email_pending"), HOLDING("holding"), CANCELLED("cancelled"), COMPLETED("completed"), EXPIRED("expired")
}
data class RecoveryRefundReceipt(val cancelledWithdrawals: Int, val inFlightWithdrawals: Int, val refundedKeep: String)
data class AuthenticatorRecovery(val id: String?, val phase: RecoveryPhase?, val readyAt: String?, val expiresAt: String?,
                                 val reenrollmentRequired: Boolean, val receipt: RecoveryRefundReceipt?) {
    companion object {
        fun from(raw: JsonObject): AuthenticatorRecovery {
            val id = raw.securityText("recoveryId")?.also { require(UUID.fromString(it).toString() == it.lowercase()) }
            val phase = raw.securityText("status")?.let { name -> requireNotNull(RecoveryPhase.entries.find { it.wire == name }) }
            require((id == null) == (phase == null))
            val ready = raw.securityTime("readyAt"); val expires = raw.securityTime("expiresAt")
            require(phase != RecoveryPhase.HOLDING || (ready != null && expires != null))
            require(phase != RecoveryPhase.EMAIL_PENDING || expires != null)
            val receipt = raw["receipt"].takeUnless { it == null || it == JsonNull }?.let { element ->
                val value = element as JsonObject
                fun count(key: String) = requireNotNull((value[key] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull).also { require(it >= 0) }
                val amount = requireNotNull(value.securityText("refundedKeep")).also { require(it.matches(Regex("0|[1-9][0-9]*"))) }
                RecoveryRefundReceipt(count("cancelledWithdrawals"), count("inFlightWithdrawals"), amount)
            }
            return AuthenticatorRecovery(id, phase, ready, expires, raw.securityFlag("reenrollmentRequired"), receipt)
        }
    }
}

/** Never serializable and never included verbatim in state/error logging. No disk/clipboard export. */
class AuthenticatorEnrollment(val secret: String, val qrPng: ByteArray? = null) {
    override fun toString() = "AuthenticatorEnrollment(redacted)"
    fun clearQr() { qrPng?.fill(0) }
    companion object {
        fun from(raw: JsonObject) = AuthenticatorEnrollment(requireNotNull(raw.securityText("secret"))
            .also { require(it.isNotBlank() && it.all { c -> c in 'A'..'Z' || c in '2'..'7' || c == '=' }) },
            (raw["qrDataUri"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.let(::qrPng))

        /** The server's inline PNG only; never fetch a URL, decode SVG or retain setup material on disk. */
        private fun qrPng(uri: String): ByteArray? = runCatching {
            require(uri.length <= 131_072 && uri.startsWith("data:image/png;base64,"))
            val bytes = java.util.Base64.getDecoder().decode(uri.substringAfter(','))
            val signature = byteArrayOf(137.toByte(),80,78,71,13,10,26,10)
            require(bytes.size >= 33 && bytes.copyOfRange(0,8).contentEquals(signature))
            val header = java.nio.ByteBuffer.wrap(bytes)
            require(header.getInt(8) == 13 && header.getInt(12) == 0x49484452)
            require(header.getInt(16) in 1..1024 && header.getInt(20) in 1..1024)
            bytes
        }.getOrNull()
    }
}

private fun JsonObject.securityFlag(key: String): Boolean =
    requireNotNull((get(key) as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull) { "Missing security status" }
private fun JsonObject.securityText(key: String): String? = when (val value = get(key)) {
    JsonNull -> null
    is JsonPrimitive -> { require(value.isString); value.content }
    else -> error("Missing security status")
}
private fun JsonObject.securityTime(key: String): String? = securityText(key)?.also { Instant.parse(it) }
