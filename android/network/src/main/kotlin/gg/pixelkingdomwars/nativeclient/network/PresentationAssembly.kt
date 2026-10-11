package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import java.io.IOException
import java.time.Instant

// Technical memory ceilings. The server advertises its canonical maxEvents;
// these are allocation limits, never alternative game or simulator rules.
internal const val CLIENT_EVENT_CEILING = 100_000
internal const val CLIENT_COMMAND_CEILING = 10_000
internal const val CLIENT_PAGE_BYTE_CEILING = 1_048_576
internal val PRESENTATION_REVISION = Regex("[0-9a-f]{64}")
private val GENERATION = Regex("[0-9a-f]{32}")
private const val CLIENT_GENERATION_BYTE_CEILING = 32L * 1024 * 1024
internal class PresentationParentMismatch : IOException("The battle snapshot needs a complete refresh")

internal fun JsonObject.battleInt(key: String) = requireNotNull((get(key) as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull) { "Missing or invalid battle $key" }
internal fun JsonObject.battleString(key: String) = requireNotNull((get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content) { "Missing or invalid battle $key" }
private fun JsonObject.nullableString(key: String): String? {
    require(containsKey(key)) { "Missing battle $key" }
    return if (get(key) == JsonNull) null else battleString(key)
}
internal fun presentationEvents(value: JsonObject): List<JsonObject> {
    val events = requireNotNull(value["events"] as? JsonArray) { "Missing battle events" }
    require(events.size <= CLIENT_EVENT_CEILING) { "Battle exceeds client event capacity" }
    return events.map { requireNotNull(it as? JsonObject) { "Malformed battle event" } }.also { events ->
        var previous = -1
        for (event in events) {
            val tick = event.battleInt("t")
            require(tick >= 0 && tick >= previous && event.battleString("e").isNotBlank()) { "Battle events are not in canonical order" }
            previous = tick
        }
    }
}

/** One immutable page generation. A partial suffix never reaches the renderer. */
internal class PresentationAssembly(
    private val raidId: String,
    private val simVersion: Int,
    private val parent: JsonObject?,
    private val maxEvents: Int,
    private val maxPageBytes: Int,
    private val maxCommands: Int,
) {
    private var first: JsonObject? = null
    private var state: JsonObject? = null
    private val events = ArrayList<JsonObject>()
    private val commands = ArrayList<JsonObject>()
    private val commandIds = HashSet<String>()
    private val cursors = HashSet<String>()
    private var finished = false
    private var receivedBytes = 0L

    fun accept(page: JsonObject): String? {
        require(!finished) { "Battle page arrived after the generation completed" }
        val pageBytes = page.toString().toByteArray(Charsets.UTF_8).size
        require(pageBytes <= maxPageBytes) { "Battle page exceeds advertised capacity" }
        require(receivedBytes + pageBytes <= CLIENT_GENERATION_BYTE_CEILING) { "Battle generation exceeds client byte capacity" }
        require(page.battleInt("protocolVersion") == 2 && page.battleString("raidId") == raidId)
        require(page.battleString("revision").matches(PRESENTATION_REVISION) && page.battleString("generation").matches(GENERATION))
        val total = page.battleInt("totalEvents").also { require(it in 0..maxEvents) }
        val totalCommands = page.battleInt("totalCommands").also { require(it in 0..maxCommands) }
        val boundary = page.battleInt("replaceFromTick").also { require(it >= 0) }
        val parentRevision = page.nullableString("parentRevision")
        require(parentRevision == null || parentRevision.matches(PRESENTATION_REVISION))
        require(page.battleInt("eventOffset") == events.size) { "Battle event page is missing or duplicated" }
        require(page.battleInt("commandOffset") == commands.size) { "Battle command page is missing or duplicated" }
        if (first == null) {
            if (parentRevision == null) require(boundary == 0) { "A complete battle reset must begin at tick zero" }
            else if (parent?.string("revision") != parentRevision) throw PresentationParentMismatch()
            val metadata = requireNotNull(page["state"] as? JsonObject) { "First battle page needs frozen state" }
            require(metadata.battleInt("simVersion") == simVersion) { "Update the native app for this simulation version" }
            require(metadata["snapshot"] is JsonObject && metadata["armySnapshot"] is JsonObject)
            require(metadata.battleString("source") in setOf("live", "archive") && metadata.battleString("status").isNotBlank())
            require(metadata["commands"] == JsonArray(emptyList()) && metadata.battleInt("lastSequence") == totalCommands - 1) { "Battle journal header is inconsistent" }
            if (parentRevision != null && (metadata["snapshot"] != parent?.get("snapshot") ||
                    metadata["armySnapshot"] != parent?.get("armySnapshot") || metadata["simVersion"] != parent?.get("simVersion") ||
                    // Optional original fleet facts are part of the frozen base,
                    // including the distinction between legacy absence and null.
                    metadata["servicePresentation"] != parent?.get("servicePresentation") ||
                    metadata["advancedServicePresentation"] != parent?.get("advancedServicePresentation"))) throw PresentationParentMismatch()
            state = metadata
            first = page
        } else {
            for (key in listOf("revision", "generation", "parentRevision", "replaceFromTick", "totalEvents", "totalCommands")) require(page[key] == first?.get(key)) { "Battle pages mixed different generations" }
            require(page.containsKey("state") && page["state"] == JsonNull) { "Continuation page cannot replace frozen state" }
        }
        val commandBatch = requireNotNull(page["commands"] as? JsonArray) { "Missing battle command page" }
            .map { requireNotNull(it as? JsonObject) { "Malformed battle command" } }
        require(commands.size.toLong() + commandBatch.size <= totalCommands)
        for ((index, command) in commandBatch.withIndex()) {
            require(command.battleInt("sequence") == commands.size + index) { "Battle commands are not contiguous" }
            require(command.battleString("clientCommandId").let { it.isNotEmpty() && commandIds.add(it) }) { "Duplicate or empty battle command identity" }
            require(command.battleString("kind") in setOf("deploy", "hero", "rally", "buff", "start", "speed", "retreat"))
            require(command["payload"] is JsonObject && command.battleInt("serverOffsetMs") >= 0)
            require(runCatching { Instant.parse(command.battleString("acceptedAt")) }.isSuccess) { "Invalid battle command receipt time" }
        }
        val batch = presentationEvents(page)
        require(batch.isEmpty() || commands.size + commandBatch.size == totalCommands) { "Battle events preceded their complete command journal" }
        require(batch.all { it.battleInt("t") >= boundary }) { "Replacement event predates the proven boundary" }
        require(events.size.toLong() + batch.size <= total)
        if (events.isNotEmpty() && batch.isNotEmpty()) require(events.last().battleInt("t") <= batch.first().battleInt("t"))
        val cursor = page.nullableString("nextCursor")
        if (cursor != null) {
            require(cursor.isNotBlank() && cursor.length <= 4_096 && cursors.add(cursor)) { "Battle cursor did not advance" }
            require((batch.isNotEmpty() || commandBatch.isNotEmpty()) &&
                (events.size + batch.size < total || commands.size + commandBatch.size < totalCommands)) { "Continuation page made no progress" }
        } else require(events.size + batch.size == total && commands.size + commandBatch.size == totalCommands) { "Battle generation ended before all commands and events arrived" }
        commands.addAll(commandBatch)
        events.addAll(batch)
        receivedBytes += pageBytes
        finished = cursor == null
        return cursor
    }

    fun complete(): JsonObject {
        check(finished) { "Incomplete battle generations cannot enter the renderer" }
        val header = checkNotNull(first)
        val boundary = header.battleInt("replaceFromTick")
        val prefix = if (header.nullableString("parentRevision") == null) emptyList() else presentationEvents(checkNotNull(parent)).takeWhile { it.battleInt("t") < boundary }
        require(prefix.size.toLong() + events.size <= maxEvents) { "Combined battle timeline exceeds capacity" }
        require(prefix.sumOf { it.toString().toByteArray(Charsets.UTF_8).size.toLong() } + receivedBytes <= CLIENT_GENERATION_BYTE_CEILING) { "Combined battle timeline exceeds byte capacity" }
        return JsonObject(checkNotNull(state) + mapOf("protocolVersion" to JsonPrimitive(1),
            "transportProtocolVersion" to JsonPrimitive(2), "raidId" to JsonPrimitive(raidId), "revision" to header.getValue("revision"),
            "replaceFromTick" to JsonPrimitive(0), "commands" to JsonArray(commands), "events" to JsonArray(prefix + events))).also { validatePresentation(it, raidId, simVersion) }
    }
}
