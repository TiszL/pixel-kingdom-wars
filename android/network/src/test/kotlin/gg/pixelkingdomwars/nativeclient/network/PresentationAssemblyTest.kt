package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PresentationAssemblyTest {
    private val raid = "11111111-1111-4111-8111-111111111111"
    private val priorRevision = "a".repeat(64)
    private val revision = "b".repeat(64)
    private val generation = "c".repeat(32)
    private fun event(tick: Int, kind: String = "pos") = buildJsonObject { put("t", tick); put("e", kind) }
    private fun metadata(terminal: Boolean = false, totalCommands: Int = 0) = buildJsonObject {
        put("source", if (terminal) "archive" else "live"); put("status", if (terminal) "resolved" else "pending_orders")
        put("simVersion", 14); put("raidProtocolVersion", 2); put("clock", buildJsonObject { put("rate", 1) })
        put("lastSequence", totalCommands - 1); put("snapshot", buildJsonObject { put("base", "frozen") })
        put("armySnapshot", buildJsonObject {}); put("commands", JsonArray(emptyList())); put("result", JsonNull)
    }
    private fun parent() = JsonObject(metadata() + mapOf("raidId" to JsonPrimitive(raid), "protocolVersion" to JsonPrimitive(1),
        "revision" to JsonPrimitive(priorRevision), "replaceFromTick" to JsonPrimitive(0),
        "events" to JsonArray(listOf(event(0, "deploy"), event(2, "old-prediction"), event(4, "old-tail")))))
    private fun page(offset: Int = 0, total: Int = 2, batch: List<JsonObject> = listOf(event(0)), cursor: String? = "page-two",
                     parentRevision: String? = null, boundary: Int = 0, terminal: Boolean = false,
                     commandOffset: Int = 0, totalCommands: Int = 0, commands: List<JsonObject> = emptyList()) = buildJsonObject {
        put("protocolVersion", 2); put("raidId", raid); put("revision", revision); put("generation", generation)
        put("parentRevision", parentRevision?.let(::JsonPrimitive) ?: JsonNull); put("replaceFromTick", boundary)
        put("eventOffset", offset); put("totalEvents", total); put("events", JsonArray(batch))
        put("commandOffset", commandOffset); put("totalCommands", totalCommands); put("commands", JsonArray(commands))
        put("nextCursor", cursor?.let(::JsonPrimitive) ?: JsonNull)
        put("state", if (offset == 0 && commandOffset == 0) metadata(terminal, totalCommands) else JsonNull)
    }
    private fun assembly(parent: JsonObject? = null, maximum: Int = 50) = PresentationAssembly(raid, 14, parent, maximum, 262_144, 10)
    private fun command(sequence: Int) = buildJsonObject {
        put("sequence", sequence); put("clientCommandId", "receipt-$sequence"); put("kind", "deploy")
        put("payload", buildJsonObject { put("opaque", sequence) }); put("serverOffsetMs", sequence)
        put("acceptedAt", "2026-09-01T00:00:00.000Z")
    }
    private fun capabilities(protocol: Int = 2) = buildJsonObject { put("presentation", buildJsonObject {
        put("enabled", true); put("protocolVersions", JsonArray(listOf(JsonPrimitive(protocol)))); put("maxWaitMs", 15_000)
        put("maxEvents", 50_000); put("maxCommands", 10); put("maxPageBytes", 262_144)
    }) }

    @Test fun `a partly downloaded revision cannot enter rendering`() {
        val assembly = assembly()
        assertEquals("page-two", assembly.accept(page()))
        assertThrows(IllegalStateException::class.java) { assembly.complete() }
        assertNull(assembly.accept(page(offset = 1, batch = listOf(event(2)), cursor = null)))
        val complete = assembly.complete()
        assertEquals(listOf(0, 2), complete.objects("events").map { it.battleInt("t") })
        assertEquals(1, complete.battleInt("protocolVersion"))
        assertEquals(2, complete.battleInt("transportProtocolVersion"))
        assertEquals(0, complete.battleInt("replaceFromTick"))
    }

    @Test fun `command-only pages remain private until the complete journal and event suffix arrive`() {
        val assembly = assembly(parent())
        assembly.accept(page(total = 1, batch = emptyList(), totalCommands = 2, commands = listOf(command(0)), parentRevision = priorRevision, boundary = 2))
        assertThrows(IllegalStateException::class.java) { assembly.complete() }
        assembly.accept(page(total = 1, batch = listOf(event(2, "accepted")), cursor = null, totalCommands = 2,
            commandOffset = 1, commands = listOf(command(1)), parentRevision = priorRevision, boundary = 2))
        val complete = assembly.complete()
        assertEquals(listOf(command(0), command(1)), complete.objects("commands"))
        assertEquals(listOf("deploy", "accepted"), complete.objects("events").map { it.string("e") })
        assertEquals(parent()["snapshot"], complete["snapshot"])
    }

    @Test fun `an empty event delta still downloads every command receipt`() {
        val assembly = assembly()
        assembly.accept(page(total = 0, batch = emptyList(), totalCommands = 2, commands = listOf(command(0))))
        assembly.accept(page(total = 0, batch = emptyList(), cursor = null, totalCommands = 2, commandOffset = 1, commands = listOf(command(1))))
        assertEquals(2, assembly.complete().objects("commands").size)
    }

    @Test fun `canonical accepted whitespace identities remain opaque during replay`() {
        val receipt = JsonObject(command(0) + ("clientCommandId" to JsonPrimitive(" \t ")))
        val assembly = assembly()
        assembly.accept(page(total = 0, batch = emptyList(), cursor = null, totalCommands = 1, commands = listOf(receipt)))
        assertEquals(receipt, assembly.complete().objects("commands").single())
    }

    @Test fun `command page offsets totals and cursor progress cannot omit or duplicate a receipt`() {
        for ((key, value) in listOf("commandOffset" to JsonPrimitive(0), "totalCommands" to JsonPrimitive(3),
                "nextCursor" to JsonPrimitive("page-two"))) {
            val assembly = assembly()
            assembly.accept(page(total = 0, batch = emptyList(), totalCommands = 2, commands = listOf(command(0))))
            val next = page(total = 0, batch = emptyList(), totalCommands = 2, commandOffset = 1, commands = listOf(command(1)), cursor = null)
            assertThrows(IllegalArgumentException::class.java) { assembly.accept(JsonObject(next + (key to value))) }
        }
        assertThrows(IllegalArgumentException::class.java) { assembly().accept(page(total = 0, batch = emptyList(), cursor = null, totalCommands = 2, commands = listOf(command(0)))) }
        assertThrows(IllegalArgumentException::class.java) { assembly().accept(page(total = 1, batch = listOf(event(0)), totalCommands = 2, commands = listOf(command(0)))) }
        assertThrows(IllegalArgumentException::class.java) { assembly().accept(page(totalCommands = 11, batch = emptyList())) }
    }

    @Test fun `malformed duplicate and out of sequence commands fail instead of becoming partial acknowledgements`() {
        for (commands in listOf(listOf(command(1)), listOf(JsonNull),
                listOf(JsonObject(command(0) + ("sequence" to JsonPrimitive("0")))),
                listOf(JsonObject(command(0) + ("acceptedAt" to JsonPrimitive("invalid")))),
                listOf(command(0), JsonObject(command(1) + ("clientCommandId" to JsonPrimitive("receipt-0")))))) {
            val page = page(total = 0, batch = emptyList(), cursor = null, totalCommands = commands.size)
            assertThrows(IllegalArgumentException::class.java) { assembly().accept(JsonObject(page + ("commands" to JsonArray(commands)))) }
        }
    }

    @Test fun `slow continuation preserves first page receipt without rewriting the canonical clock`() = runBlocking {
        var now = 123L
        var pages = 0
        val first = page(total = 0, batch = emptyList(), terminal = true, totalCommands = 2, commands = listOf(command(0)))
        val api = BattlePresentation({ path, _ ->
            if (path == "/native/capabilities") capabilities() else if (pages++ == 0) first else {
                now += 9_000_000_000L
                page(total = 0, batch = emptyList(), cursor = null, totalCommands = 2, commandOffset = 1, commands = listOf(command(1)))
            }
        }, 14, {}, { now })
        val complete = api.observe(raid).toList().single()
        assertEquals(123L, complete["_clientFirstPageReceivedAtNanos"]!!.jsonPrimitive.long)
        assertEquals(first["state"]!!.jsonObject["clock"], complete["clock"])
    }

    @Test fun `late receipt replaces its entire changed tick while preserving the proven earlier history`() {
        val assembly = assembly(parent())
        assembly.accept(page(total = 2, batch = listOf(event(2, "accepted-deploy"), event(3, "new-tail")), cursor = null,
            parentRevision = priorRevision, boundary = 2))
        assertEquals(listOf("deploy", "accepted-deploy", "new-tail"), assembly.complete().objects("events").map { it.string("e") })
    }

    @Test fun `clock-only revisions preserve all events without replaying a fake suffix`() {
        val assembly = assembly(parent())
        val first = page(total = 0, batch = emptyList(), cursor = null, parentRevision = priorRevision, boundary = 5)
        val state = JsonObject(metadata() + ("clock" to buildJsonObject { put("rate", 2) }))
        assembly.accept(JsonObject(first + ("state" to state)))
        val complete = assembly.complete()
        assertEquals(parent()["events"], complete["events"])
        assertEquals(2, complete["clock"]!!.jsonObject.battleInt("rate"))
    }

    @Test fun `unproven parent or changed frozen base requires a complete refresh`() {
        assertThrows(PresentationParentMismatch::class.java) { assembly().accept(page(parentRevision = priorRevision)) }
        val state = JsonObject(metadata() + ("snapshot" to buildJsonObject { put("base", "another") }))
        assertThrows(PresentationParentMismatch::class.java) { assembly(parent()).accept(JsonObject(page(parentRevision = priorRevision) + ("state" to state))) }
        assertThrows(IllegalArgumentException::class.java) { assembly().accept(page(boundary = 2, batch = listOf(event(2)))) }
    }

    @Test fun `mixed generation missing offset and cross raid pages are rejected`() {
        for ((key, value) in listOf("generation" to JsonPrimitive("d".repeat(32)), "revision" to JsonPrimitive("e".repeat(64)),
                "eventOffset" to JsonPrimitive(2), "raidId" to JsonPrimitive("another-raid"), "totalEvents" to JsonPrimitive(3))) {
            val assembly = assembly(); assembly.accept(page())
            val next = JsonObject(page(offset = 1, batch = listOf(event(2)), cursor = null) + (key to value))
            assertThrows(IllegalArgumentException::class.java) { assembly.accept(next) }
        }
    }

    @Test fun `duplicate cursor empty progress and early ending cannot spin or publish incomplete combat`() {
        val assembly = assembly(); assembly.accept(page(total = 3))
        assertThrows(IllegalArgumentException::class.java) { assembly.accept(page(offset = 1, total = 3, batch = listOf(event(2)))) }
        assertThrows(IllegalArgumentException::class.java) { assembly().accept(page(batch = emptyList())) }
        assertThrows(IllegalArgumentException::class.java) { assembly().accept(page(cursor = null)) }
    }

    @Test fun `malformed or reordered events cannot disappear through lenient object filtering`() {
        assertThrows(IllegalArgumentException::class.java) { assembly().accept(JsonObject(page() + ("events" to JsonArray(listOf(JsonNull))))) }
        assertThrows(IllegalArgumentException::class.java) { assembly().accept(page(batch = listOf(event(3), event(1)), cursor = null)) }
        val numberAsText = JsonObject(event(0) + ("t" to JsonPrimitive("0")))
        assertThrows(IllegalArgumentException::class.java) { assembly().accept(page(batch = listOf(numberAsText))) }
        val missingKind = JsonObject(page() + ("events" to JsonArray(listOf(buildJsonObject { put("t", 0) }))))
        assertThrows(IllegalArgumentException::class.java) { assembly().accept(missingKind) }
    }

    @Test fun `advertised event and byte bounds apply before a generation is accepted`() {
        assertThrows(IllegalArgumentException::class.java) { assembly(maximum = 1).accept(page()) }
        assertThrows(IllegalArgumentException::class.java) { PresentationAssembly(raid, 14, null, 50, 32, 10).accept(page()) }
        val assembly = assembly(parent(), maximum = 3)
        assembly.accept(page(total = 2, batch = listOf(event(5), event(6)), cursor = null, parentRevision = priorRevision, boundary = 5))
        assertThrows(IllegalArgumentException::class.java) { assembly.complete() }
    }

    @Test fun `an expired cursor restarts from fully applied revision and never emits the incomplete suffix`() = runBlocking {
        val requests = mutableListOf<Map<String, String>>()
        val emitted = mutableListOf<JsonObject>()
        var step = 0
        val api = BattlePresentation({ path, query ->
            if (path == "/native/capabilities") capabilities() else {
                requests += query
                when (step++) {
                    0 -> JsonObject(page(total = 1, batch = listOf(event(0)), cursor = null) + ("revision" to JsonPrimitive(priorRevision)))
                    1 -> page(batch = listOf(event(2)), parentRevision = priorRevision, boundary = 2)
                    2 -> throw ApiException(410, "NATIVE_PAGE_EXPIRED", "expired")
                    else -> page(total = 1, batch = listOf(event(0, "terminal")), cursor = null, terminal = true)
                }
            }
        }, 14, {})
        api.observe(raid).toList(emitted)
        assertEquals(2, emitted.size)
        assertEquals(priorRevision, requests[1]["afterRevision"])
        assertEquals(mapOf("protocolVersion" to "2", "cursor" to "page-two"), requests[2])
        assertEquals(priorRevision, requests[3]["afterRevision"])
        assertEquals("terminal", emitted.last().objects("events").single().string("e"))
    }

    @Test fun `revocation between pages aborts immediately without publishing state or retrying authorization`() = runBlocking {
        var pages = 0
        val emitted = mutableListOf<JsonObject>()
        val api = BattlePresentation({ path, _ ->
            if (path == "/native/capabilities") capabilities() else if (pages++ == 0) page()
            else throw ApiException(403, "REVOKED", "revoked")
        }, 14, { fail("Authorization must not retry") })
        try { api.observe(raid).toList(emitted); fail("Expected revocation") } catch (error: ApiException) { assertEquals(403, error.status) }
        assertEquals(2, pages)
        assertTrue(emitted.isEmpty())
    }

    @Test fun `expired command continuation discards its receipts before restarting the generation`() = runBlocking {
        var pages = 0
        val requests = mutableListOf<Map<String, String>>()
        val api = BattlePresentation({ path, query ->
            if (path == "/native/capabilities") capabilities() else {
                requests += query
                when (pages++) {
                    0 -> page(total = 0, batch = emptyList(), totalCommands = 2, commands = listOf(command(0)))
                    1 -> throw ApiException(410, "NATIVE_PAGE_EXPIRED", "expired")
                    else -> page(total = 0, batch = emptyList(), cursor = null, terminal = true)
                }
            }
        }, 14, {})
        val complete = api.observe(raid).toList().single()
        assertTrue(complete.objects("commands").isEmpty())
        assertEquals(mapOf("protocolVersion" to "2", "cursor" to "page-two"), requests[1])
        assertFalse(requests[2].containsKey("cursor"))
        assertFalse(requests[2].containsKey("afterRevision"))
    }

    @Test fun `v1 servers remain compatible and overload honors Retry After without mutation retries`() = runBlocking {
        var requests = 0
        val pauses = mutableListOf<Long>()
        val api = BattlePresentation({ path, query ->
            if (path == "/native/capabilities") capabilities(1) else {
                assertFalse(query.containsKey("protocolVersion"))
                if (requests++ == 0) throw ApiException(503, "NATIVE_PRESENTATION_BUSY", "busy", retryAfterSeconds = 2)
                JsonObject(parent() + ("status" to JsonPrimitive("resolved")))
            }
        }, 14, { pauses += it })
        assertEquals(1, api.observe(raid).toList().size)
        assertEquals(listOf(2_000L), pauses)
        assertEquals(2, requests)
    }

    @Test fun `cancellation cancels observation rather than becoming an offline retry`() = runBlocking {
        var requests = 0
        val api = BattlePresentation({ _, _ -> requests++; throw CancellationException("backgrounded") }, 14, { fail("Cancellation must not retry") })
        try { api.observe(raid).toList(); fail("Expected cancellation") } catch (_: CancellationException) { }
        assertEquals(1, requests)
    }
}
