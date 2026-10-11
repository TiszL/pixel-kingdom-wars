package gg.pixelkingdomwars.nativeclient.network

/** Optional local observations. Implementations must be bounded and non-blocking;
 * none of these milestones determines admission, persistence or recovery. */
enum class BattleCommandStage {
    ORIGINAL_ID_BOUND, INTENT_DURABLE, ATTEMPT_DURABLE, POST_BEGIN, RESPONSE, RECEIPT_DURABLE, FIRST_CANONICAL_BODY_SUBMITTED,
    TRANSPORT_ADMITTED, TRANSPORT_IO_STARTED, CALL_ENQUEUED, REQUEST_HEADERS_SENT, REQUEST_BODY_SENT,
    RESPONSE_HEADERS_RECEIVED, RESPONSE_CALLBACK, RESPONSE_BODY_READ, RESPONSE_JSON_PARSED, TRANSPORT_RESUMED
}

interface BattleInputTiming {
    /** Bind the input to its one admitted ID and record ORIGINAL_ID_BOUND. */
    fun admitted(id: String)
}

interface BattleCommandTiming {
    fun preparation(): BattlePreparationTiming? = null
    fun input(): BattleInputTiming?
    fun stage(id: String, stage: BattleCommandStage)
    /** Capture an anonymous, consent-fenced observer for this original input's first transport attempt.
     * Disabled observers and restored commands return null without creating a request tag. */
    fun transport(id: String): BattleCommandTransportTiming? = null
}

fun interface BattleCommandTransportTiming {
    /** Implementations must not retain request/response data or block the transport thread. */
    fun stage(stage: BattleCommandStage)
}

internal fun BattleCommandTransportTiming?.observe(stage: BattleCommandStage) { runCatching { this?.stage(stage) } }
