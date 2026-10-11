package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.network.*
import java.time.Instant
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.*

enum class RecentAuthPurpose(val wire: String, val needsIntent: Boolean) {
    FACTOR_CHANGE("factor_change", false), KEY_EXPORT("key_export", false),
    WITHDRAWAL("withdrawal", true), TOTP_RECOVERY("totp_recovery", true)
}

/** Intentionally neither serializable nor a data class: grants and proofs live only in action memory. */
class RecentWalletProof internal constructor(val grant: String, val expiresAt: Instant,
                                            private val challengeToken: String, private val signature: String) {
    fun withdrawalAuthorization(): JsonObject = jsonBody("challengeToken" to challengeToken, "signature" to signature)
    override fun toString() = "RecentWalletProof(redacted)"
}

/** Mirrors the web's recent-auth proof without changing login cookies or automatically retrying either POST. */
class WalletRecentAuth internal constructor(
    private val challenge: suspend (JsonObject) -> JsonObject,
    private val verify: suspend (JsonObject) -> JsonObject,
    private val now: () -> Instant = { Instant.now() }
) {
    constructor(api: GameApi, session: SessionToken): this(
        { body -> api.post("/auth/reauth/challenge", body, session) },
        { body -> api.post("/auth/reauth/verify", body, session) }
    )

    suspend fun prove(purpose: RecentAuthPurpose, signer: WalletSigner, expectedWallet: String,
                      intent: JsonObject? = null, requireCurrentIdentity: () -> Unit): RecentWalletProof {
        require(purpose.needsIntent == (intent != null)) { "Missing or unexpected confirmation intent" }
        val context = currentCoroutineContext()
        fun guard() {
            context.ensureActive()
            requireCurrentIdentity()
            check(signer.address == expectedWallet) { "Confirm with the wallet that owns this account" }
        }
        fun fresh(raw: String?): Instant = requireNotNull(raw?.let { runCatching { Instant.parse(it) }.getOrNull() }
            ?.takeIf { it.isAfter(now()) }) { "Wallet confirmation expired. Please try again." }
        guard()
        val asked = challenge(buildJsonObject {
            put("purpose", purpose.wire)
            intent?.let { put("intent", it) }
        })
        guard()
        val token = requireNotNull(asked.string("challengeToken")?.takeIf { it.isNotBlank() }) { "Missing server challenge" }
        val message = requireNotNull(asked.string("message")?.takeIf { it.isNotEmpty() }) { "Missing server challenge" }
        val challengeExpiry = fresh(asked.string("expiresAt"))
        val signatureBytes = signer.signMessage(message.toByteArray(Charsets.UTF_8))
        guard()
        require(signatureBytes.size == 64) { "The wallet returned an invalid signature" }
        require(challengeExpiry.isAfter(now())) { "Wallet confirmation expired. Please try again." }
        val signature = base58(signatureBytes)
        val verified = verify(jsonBody("challengeToken" to token, "signature" to signature))
        guard()
        check(verified.string("purpose") == purpose.wire) { "The wallet confirmed a different action" }
        val expiry = fresh(verified.string("expiresAt"))
        val grant = requireNotNull(verified.string("grant")?.takeIf { value -> value.isNotBlank() && value.all { it.code in 33..126 } }) {
            "Missing recent authentication grant"
        }
        return RecentWalletProof(grant, expiry, token, signature)
    }
}
