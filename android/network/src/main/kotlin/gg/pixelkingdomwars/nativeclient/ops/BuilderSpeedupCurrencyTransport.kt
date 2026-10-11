package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiException
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject

/** Paid builder finishes need original ledger proof; ordinary construction remains unchanged. */
class BuilderSpeedupCurrencyTransport(private val reads: OpTransport,
    private val postExact: suspend (PendingIntent, (ApiException) -> Unit) -> Unit) : OpTransport {
    override suspend fun get(path: String, query: Map<String, String>) = reads.get(path, query)
    override suspend fun post(path: String, body: JsonObject) = reads.post(path, body)
    override suspend fun post(intent: PendingIntent): JsonObject = postObserved(intent) {}
    override suspend fun postObserved(intent: PendingIntent, refusal: (ApiException) -> Unit): JsonObject {
        ConstructionSpec.validateSend(intent)
        if (!ConstructionSpec.modernBuilder(intent)) return reads.post(intent)
        postExact(intent, refusal)
        return try { val request = requireNotNull(ConstructionSpec.receiptRequest(intent)); reads.get(request.path, request.query) }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { throw IOException("Builder finish sent. Check the saved original receipt.", error) }
    }
}
