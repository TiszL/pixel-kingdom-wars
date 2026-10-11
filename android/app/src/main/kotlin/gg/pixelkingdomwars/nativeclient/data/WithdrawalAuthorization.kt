package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.wallet.RecentWalletProof
import kotlinx.serialization.json.*
import java.time.Instant

/** Ephemeral action memory only; never Serializable, a data class, or part of a PendingIntent. */
class WithdrawalAuthorization(private val grant: String, private val authorization: JsonObject, private val expiresAt: Instant) {
    constructor(proof: RecentWalletProof) : this(proof.grant, proof.withdrawalAuthorization(), proof.expiresAt)
    override fun toString() = "WithdrawalAuthorization(redacted)"
    suspend fun post(api: ApiClient, body: JsonObject, code: String): JsonObject {
        if (!expiresAt.isAfter(Instant.now())) throw ApiException(422, "WITHDRAWAL_AUTH_EXPIRED", "Wallet confirmation expired. Review the withdrawal again.")
        require(grant.isNotBlank() && authorization.keys == setOf("challengeToken", "signature"))
        return api.postWithRecentAuth("/withdrawals", JsonObject(body + buildJsonObject {
            put("authorization", authorization)
            if (body["instant"] == JsonPrimitive(true)) { put("method", "totp"); put("code", code) }
        }), grant)
    }
}
