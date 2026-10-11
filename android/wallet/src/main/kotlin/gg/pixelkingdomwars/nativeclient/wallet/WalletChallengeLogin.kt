package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.JsonObject

/** Reuses canonical wallet challenges for any explicitly selected existing signer.
 * The returned full/pending-login response still belongs to GameModel's session flow. */
class WalletChallengeLogin internal constructor(
    private val challenge: suspend (String) -> JsonObject,
    private val verify: suspend (JsonObject) -> JsonObject
) {
    constructor(api: GameApi, session: SessionToken): this(
        { wallet -> api.get("/auth/challenge",mapOf("wallet" to wallet),session=session) },
        { body -> api.post("/auth/verify",body,session=session) }
    )

    suspend fun signIn(signer: WalletSigner, requireCurrentIdentity: () -> Unit): JsonObject {
        val wallet=signer.address
        val context=currentCoroutineContext()
        fun checkIdentity() {
            context.ensureActive()
            requireCurrentIdentity()
            check(signer.address==wallet) { "The selected wallet changed during sign-in" }
        }
        checkIdentity()
        val response=challenge(wallet)
        checkIdentity()
        val message=requireNotNull(response.string("message")?.takeIf { it.isNotEmpty() }) { "Missing server challenge" }
        val nonce=requireNotNull(response.string("nonce")?.takeIf { it.isNotBlank() }) { "Missing server nonce" }
        val signature=signer.signMessage(message.toByteArray(Charsets.UTF_8))
        checkIdentity()
        require(signature.size==64) { "The wallet returned an invalid signature" }
        // A lost response never causes a second verification or signing request here.
        val result=verify(jsonBody("wallet" to wallet,"signature" to base58(signature),"nonce" to nonce,"client" to "solana-mobile"))
        checkIdentity()
        check(result.string("wallet")==wallet) { "The server returned a different wallet identity" }
        return result
    }
}
