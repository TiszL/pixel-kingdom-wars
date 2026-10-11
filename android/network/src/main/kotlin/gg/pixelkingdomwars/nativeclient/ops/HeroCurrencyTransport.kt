package gg.pixelkingdomwars.nativeclient.ops

import java.io.IOException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject

/** POST fields cannot prove which balance paid. Exact commands require original ledger GET evidence. */
class HeroCurrencyTransport(private val reads: OpTransport,
    private val postExact: suspend (PendingIntent, (ApiException) -> Unit) -> Unit) : OpTransport {
    override suspend fun get(path: String, query: Map<String, String>) = reads.get(path, query)
    override suspend fun post(path: String, body: JsonObject) = reads.post(path, body)
    override suspend fun post(intent: PendingIntent): JsonObject = postObserved(intent) {}
    override suspend fun postObserved(intent: PendingIntent, refusal: (ApiException) -> Unit): JsonObject {
        if (intent.expectedCurrency == null) return reads.post(intent)
        val spec = when (intent.kind) {
            IntentKind.HERO_UPGRADE -> HeroUpgradeSpec
            IntentKind.HERO_RECOVERY -> HeroRecoverySpec
            else -> error("This is not a Hero currency command.")
        }
        spec.validateSend(intent)
        postExact(intent, refusal)
        // Nothing after a successful POST, including a GET 4xx, disproves an earlier commit.
        return try {
            val request = requireNotNull(spec.receiptRequest(intent)); reads.get(request.path, request.query)
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { throw IOException("Hero command sent. Check the saved original receipt.", e) }
    }
}
