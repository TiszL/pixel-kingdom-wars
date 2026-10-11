package gg.pixelkingdomwars.nativeclient.model

import java.math.BigInteger
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val chatJson = Json { ignoreUnknownKeys = true }
fun chatDecimal(value: String, zero: Boolean = false): BigInteger {
    require(value.matches(Regex(if (zero) "0|[1-9][0-9]*" else "[1-9][0-9]*")))
    return value.toBigInteger()
}
@Serializable data class ChatAuthor(val name: String, val avatarUrl: String?, val seekerVerified: Boolean)
@Serializable data class ChatMention(val start: Int, val end: Int)
@Serializable data class ChatMessage(val id: String, val clientMessageId: String, val text: String, val createdAt: String,
    val author: ChatAuthor, val canBlock: Boolean, val mentions: List<ChatMention> = emptyList(), val mentioned: Boolean = false) {
    init {
        chatDecimal(id); require(UUID.fromString(clientMessageId).toString() == clientMessageId.lowercase()); Instant.parse(createdAt)
        var previous = 0
        // Kotlin indices are UTF-16, exactly as the canonical mention contract. Never parse @names.
        for (span in mentions) {
            require(span.start >= previous && span.end > span.start && span.end <= text.length)
            require(span.start == 0 || !Character.isLowSurrogate(text[span.start]))
            require(span.end == text.length || !Character.isLowSurrogate(text[span.end]))
            previous = span.end
        }
    }
    companion object { fun from(raw: JsonObject): ChatMessage = chatJson.decodeFromJsonElement(raw) }
}
@Serializable data class ChatStatus(val enabled: Boolean, val canSend: Boolean, val sendBlockedReason: String?, val mutedUntil: String?,
    val latestEventId: String, val pollOpenMs: Long, val pollClosedMs: Long) {
    init {
        chatDecimal(latestEventId, true); require(pollOpenMs > 0 && pollClosedMs >= pollOpenMs); mutedUntil?.let { Instant.parse(it) }
        require(sendBlockedReason == null || sendBlockedReason in setOf("USERNAME_REQUIRED", "DEED_REQUIRED", "MUTED", "DISABLED"))
        require(canSend == (sendBlockedReason == null) && (!canSend || enabled)); require(enabled || sendBlockedReason == "DISABLED")
    }
    companion object { fun from(raw: JsonObject): ChatStatus = chatJson.decodeFromJsonElement(raw) }
}
@Serializable data class ChatMessagePage(val messages: List<ChatMessage>, val nextBefore: String?) {
    init { nextBefore?.let { chatDecimal(it) }; require(messages.map { it.id }.distinct().size == messages.size); require(nextBefore == null || messages.lastOrNull()?.id == nextBefore) }
    companion object { fun from(raw: JsonObject): ChatMessagePage = chatJson.decodeFromJsonElement(raw) }
}
@Serializable data class ChatEvent(val id: String, val type: String, val createdAt: String, val messageId: String, val message: ChatMessage? = null) {
    init { chatDecimal(id); chatDecimal(messageId); Instant.parse(createdAt)
        require(type == "message" && message?.id == messageId || type == "redaction" && message == null) }
}
@Serializable data class ChatEvents(val events: List<ChatEvent>, val nextAfter: String) {
    init { chatDecimal(nextAfter, true); require(events.zipWithNext().all { (a, b) -> chatDecimal(a.id) < chatDecimal(b.id) })
        require(events.all { chatDecimal(it.id) <= chatDecimal(nextAfter, true) }) }
    companion object { fun from(raw: JsonObject): ChatEvents = chatJson.decodeFromJsonElement(raw) }
}
@Serializable data class ChatBlock(val id: String, val createdAt: String, val author: ChatAuthor) {
    init { chatDecimal(id); Instant.parse(createdAt) }
}
/** GET /chat/messages/:id/author, version 1 (source packages/shared/src/chatAuthorCard.ts). The server sends a closed
 * allowlist through a strict schema, so this parser is strict about what it READS — the version literal, every
 * listed key present, exact JSON types, integer ranges — and ignores a key it does not know: a later additive
 * field must not blank every card, while a different shape arrives as a new `version` and is rejected whole.
 * [name] is the name the message was sent under; everything else is the author's current state. No wallet, base
 * id or place exists on this wire. [maxBases] is BASE_OWNERSHIP.maxActive from the verified catalogue (never a
 * Kotlin copy); without it only the sign is checked. */
data class ChatAuthorClan(val name: String, val tag: String)
data class ChatAuthorCard(val name: String, val avatarUrl: String?, val seekerVerified: Boolean, val bases: Int,
    val highestKeepLevel: Int?, val trophies: Int, val clan: ChatAuthorClan?) {
    companion object {
        const val VERSION = 1
        private val integer = Regex("0|[1-9][0-9]*")
        private fun JsonObject.literal(key: String, nullable: Boolean = false): JsonPrimitive? = when (val value = requireNotNull(get(key)) { "$key is missing" }) {
            is JsonNull -> { require(nullable) { "$key is null" }; null }
            is JsonPrimitive -> value
            else -> throw IllegalArgumentException("$key is not a literal")
        }
        private fun JsonObject.text(key: String, nullable: Boolean = false): String? = literal(key, nullable)?.also { require(it.isString) { "$key is not a string" } }?.content
        private fun JsonObject.whole(key: String, nullable: Boolean = false): Int? = literal(key, nullable)?.let {
            require(!it.isString && it.content.matches(integer)) { "$key is not a non-negative integer" }; requireNotNull(it.content.toIntOrNull()) { "$key is out of range" }
        }
        fun from(raw: JsonObject, maxBases: Int?): ChatAuthorCard {
            require(raw.whole("version") == VERSION) { "Unknown author card version" }
            val flag = requireNotNull(raw.literal("seekerVerified")).also { require(!it.isString && it.booleanOrNull != null) { "seekerVerified is not a boolean" } }
            val clan = when (val value = requireNotNull(raw["clan"]) { "clan is missing" }) {
                is JsonNull -> null
                is JsonObject -> ChatAuthorClan(requireNotNull(value.text("name")), requireNotNull(value.text("tag")))
                else -> throw IllegalArgumentException("clan is not an object")
            }
            val bases = requireNotNull(raw.whole("bases")); require(maxBases == null || bases <= maxBases) { "bases is out of range" }
            val keep = raw.whole("highestKeepLevel", nullable = true); require(keep == null || keep >= 1) { "highestKeepLevel is out of range" }
            return ChatAuthorCard(requireNotNull(raw.text("name")), raw.text("avatarUrl", nullable = true), flag.boolean, bases, keep, requireNotNull(raw.whole("trophies")), clan)
        }
    }
}
@Serializable data class ChatBlocks(val blocks: List<ChatBlock>, val nextBefore: String?) {
    init { nextBefore?.let { chatDecimal(it) }; require(blocks.map { it.id }.distinct().size == blocks.size); require(nextBefore == null || blocks.lastOrNull()?.id == nextBefore) }
    companion object { fun from(raw: JsonObject): ChatBlocks = chatJson.decodeFromJsonElement(raw) }
}
