package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.network.SecretStorageException
import kotlinx.serialization.json.*

internal class MemoryStore(var value: String? = null) : SecretStore {
    var unreadable = false
    var rejectWrite = false
    var writes = 0
    var clears = 0
    override fun read(): String? { if (unreadable) throw SecretStorageException(); return value }
    override fun write(value: String) { if (rejectWrite) throw SecretStorageException(); this.value = value; writes++ }
    override fun clear() { clears++; value = null }
}

/** A scripted transport: every call is recorded; replies come from the supplied handlers. */
internal class ScriptedTransport(
    var onGet: suspend (String, Map<String, String>) -> JsonObject = { path, _ -> error("Unexpected GET $path") },
    var onPost: suspend (String, JsonObject) -> JsonObject = { path, _ -> error("Unexpected POST $path") },
) : OpTransport {
    val gets = mutableListOf<Pair<String, Map<String, String>>>()
    val posts = mutableListOf<Pair<String, JsonObject>>()
    override suspend fun get(path: String, query: Map<String, String>): JsonObject { gets += path to query; return onGet(path, query) }
    override suspend fun post(path: String, body: JsonObject): JsonObject { posts += path to body; return onPost(path, body) }
}

internal const val WALLET = "original-wallet"
internal const val BASE = "00000000-0000-4000-8000-000000000001"

internal fun trainingBody(key: String = "original-receipt", baseId: String? = BASE, cost: String = "9007199254740993"): JsonObject = buildJsonObject {
    baseId?.let { put("baseId", it) }
    put("idempotencyKey", key)
    put("composition", buildJsonArray { add(buildJsonObject { put("troop", "highlander"); put("count", 1) }) })
    put("confirmedCostShards", cost)
}
internal fun trainingIntent(body: JsonObject = trainingBody(), quote: JsonObject = buildJsonObject { put("costShards", "9007199254740993") }): PendingIntent =
    PendingIntent(IntentKind.TRAINING_BATCH, WALLET, (body["baseId"] as? JsonPrimitive)?.content, (body["idempotencyKey"] as JsonPrimitive).content,
        TrainingBatchSpec.PATH, body, "Train army", quote)

internal fun trainingReceipt(body: JsonObject = trainingBody(), status: String = "accepted"): JsonObject = buildJsonObject {
    put("version", 1); put("idempotencyKey", body.getValue("idempotencyKey")); put("status", status)
    when (status) {
        "closed" -> put("closedAt", "2026-09-06T12:00:00.000Z")
        "accepted" -> {
            put("baseId", body["baseId"] ?: JsonNull); put("acceptedAt", "2026-09-06T12:00:00.000Z")
            put("request", JsonObject(body.filterKeys { it in setOf("composition", "confirmedCostShards") }))
            put("result", buildJsonObject {
                put("costShards", body.getValue("confirmedCostShards")); put("replayed", true)
                put("queue", buildJsonArray { add(buildJsonObject {
                    put("id", "00000000-0000-4000-8000-000000000002"); put("troop", "highlander"); put("finishesAt", "2026-09-06T12:01:00.000Z")
                }) })
            })
        }
    }
}

internal fun placementBody(key: String = "receipt/key with spaces", baseId: String? = "a0000000-0000-4000-8000-000000000001"): JsonObject = buildJsonObject {
    baseId?.let { put("baseId", it) }; put("idempotencyKey", key); put("type", "mine"); put("tx", 11); put("ty", 8)
}
internal fun placementIntent(body: JsonObject = placementBody(), path: String = ConstructionSpec.PLACE): PendingIntent =
    PendingIntent(IntentKind.CONSTRUCTION, WALLET, (body["baseId"] as? JsonPrimitive)?.content, (body["idempotencyKey"] as JsonPrimitive).content, path, body, "Build mine")
internal fun placementAccepted(body: JsonObject = placementBody()): JsonObject = buildJsonObject {
    put("version", 1); put("status", "accepted"); put("request", body); put("baseId", body["baseId"] ?: JsonNull)
    put("receiptId", "00000000-0000-4000-8000-000000000002"); put("acceptedAt", "2026-09-07T00:00:00.123Z")
    put("funding", buildJsonObject { put("currency", "SHARDS"); put("amount", "9007199254740993") })
}
internal fun placementUnknown(body: JsonObject = placementBody()): JsonObject = buildJsonObject {
    put("version", 1); put("status", "unknown"); put("idempotencyKey", body.getValue("idempotencyKey"))
}

internal const val QUEUE = "22222222-2222-4222-8222-222222222222"
internal const val CANCEL_BASE = "11111111-1111-4111-8111-111111111111"
internal fun cancelIntent(baseId: String? = CANCEL_BASE, key: String = "cancel-original-key"): PendingIntent =
    TrainingCancelSpec.intent(WALLET, baseId, QUEUE, key, "highlander", "90071992547409931234567890123456")
internal fun cancelResult(intent: PendingIntent = cancelIntent(), replayed: Boolean = true): JsonObject = buildJsonObject {
    put("id", QUEUE); put("troop", "highlander"); put("refundShards", TrainingCancelSpec.refundShards(intent))
    put("cancelledAt", "2026-09-07T10:00:00.000Z"); put("replayed", replayed)
}
internal fun cancelReceipt(intent: PendingIntent = cancelIntent(), status: String = "accepted"): JsonObject = buildJsonObject {
    put("version", 1); put("status", status); put("queueId", QUEUE); put("idempotencyKey", intent.idempotencyKey)
    put("baseId", intent.baseId?.let(::JsonPrimitive) ?: JsonNull)
    if (status == "accepted") put("result", cancelResult(intent))
}
