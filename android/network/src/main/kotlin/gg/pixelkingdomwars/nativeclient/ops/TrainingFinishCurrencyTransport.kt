package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiException
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject

/** Paid exact consent follows POST with original ledger proof; free and legacy transport stay intact. */
class TrainingFinishCurrencyTransport(private val reads: OpTransport,
    private val postExact: suspend (PendingIntent, (ApiException) -> Unit) -> Unit) : OpTransport {
    override suspend fun get(path: String, query: Map<String, String>) = reads.get(path, query)
    override suspend fun post(path: String, body: JsonObject) = reads.post(path, body)
    override suspend fun post(intent: PendingIntent): JsonObject = postObserved(intent) {}
    override suspend fun postObserved(intent: PendingIntent, refusal: (ApiException) -> Unit): JsonObject {
        TrainingFinishSpec.validateSend(intent)
        if (intent.expectedCurrency == null) return reads.post(intent)
        postExact(intent, refusal)
        return try { val request = TrainingFinishSpec.receiptRequest(intent); reads.get(request.path, request.query) }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { throw IOException("Training finish sent. Check the saved original receipt.", error) }
    }
}
