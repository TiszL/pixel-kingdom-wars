package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*

/** The confirmation buys only the explicitly quoted subset, never the unfulfilled request. */
fun trainingConfirmation(quote: JsonObject, baseId: String?, idempotencyKey: String,
                         scheduling: TrainingScheduling = TrainingScheduling.LEGACY): JsonObject {
    val queueable = requireNotNull(quote["queueable"] as? JsonArray)
    val cost = requireNotNull(quote.string("costShards"))
    require(cost.matches(Regex("0|[1-9][0-9]*"))) { "Invalid training price" }
    require(idempotencyKey.isNotBlank())
    val schedule=trainingQuoteSchedule(quote)
    when(scheduling) {
        TrainingScheduling.LEGACY -> require(schedule==null) { "Training changed. Review a new quote before continuing." }
        TrainingScheduling.SEQUENTIAL -> requireNotNull(schedule) { "The server did not provide the required training schedule" }
        TrainingScheduling.UNSUPPORTED -> throw ApiCompatibilityException("/army/training/quote")
    }
    return buildJsonObject {
        baseId?.let { put("baseId",it) }
        put("composition",queueable)
        put("confirmedCostShards",cost)
        put("idempotencyKey",idempotencyKey)
        schedule?.let { put("consent",it.consent) }
    }
}
