package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class BattlePreparationTimingTest {
    private val raid = "11111111-1111-4111-8111-111111111111"
    private val revision = "b".repeat(64)
    private class Observation(override val ordinal: Long) : BattlePreparationTiming {
        val stages = mutableListOf<BattlePreparationStage>()
        val outcomes = mutableListOf<BattlePreparationOutcome>()
        val revisions = mutableListOf<String>()
        override fun stage(stage: BattlePreparationStage) { stages += stage }
        override fun assembled(revision: String) { revisions += revision }
        override fun finish(outcome: BattlePreparationOutcome) { outcomes += outcome }
    }
    private fun capabilities(protocol: Int = 1) = buildJsonObject { put("presentation", buildJsonObject {
        put("enabled", true); put("protocolVersions", JsonArray(listOf(JsonPrimitive(protocol)))); put("maxWaitMs", 0)
        put("maxEvents", 50_000); put("maxCommands", 10); put("maxPageBytes", 262_144)
    }) }
    private fun complete() = buildJsonObject {
        put("raidId", raid); put("protocolVersion", 1); put("simVersion", 15); put("replaceFromTick", 0)
        put("revision", revision); put("source", "archive"); put("status", "resolved")
        put("events", JsonArray(emptyList()))
    }
    private fun transported(timing: BattlePreparationTiming?) {
        listOf(BattlePreparationStage.CALL_ENQUEUED, BattlePreparationStage.RESPONSE_HEADERS,
            BattlePreparationStage.BODY_READ, BattlePreparationStage.JSON_PARSED).forEach { timing.observe(it) }
    }

    @Test fun `HTTP retries receive separate ordinals and cannot join a failed first page to successful assembly`() = runBlocking {
        val observations = mutableListOf<Observation>()
        val waits = mutableListOf<Long>()
        var reads = 0
        val presentation = BattlePresentation(
            get = { path, _ -> assertEquals("/native/capabilities", path); capabilities() },
            simVersion = 15, pause = { waits += it },
            beginPreparation = { Observation((observations.size + 1).toLong()).also { observations += it } },
            observedGet = { _, _, timing ->
                timing.observe(BattlePreparationStage.CALL_ENQUEUED)
                if (reads++ == 0) throw IOException("Interrupted first page")
                transported(timing); complete()
            },
        )
        val result = presentation.observe(raid).toList().single()
        assertEquals(2, observations.size); assertEquals(listOf(250L), waits)
        assertEquals(listOf(BattlePreparationOutcome.FAILED), observations.first().outcomes)
        assertTrue(observations.first().revisions.isEmpty())
        assertFalse(BattlePreparationStage.ASSEMBLY_COMPLETE in observations.first().stages)
        assertEquals(listOf(revision), observations.last().revisions)
        assertEquals(BattlePreparationStage.ASSEMBLY_COMPLETE, observations.last().stages.last())
        assertEquals(observations.last().ordinal, result.getValue("_clientPreparationOrdinal").jsonPrimitive.long)
        assertEquals(complete().getValue("events"), result.getValue("events"))
    }

    @Test fun `unchanged reads close their own observation without emitting a fabricated revision`() = runBlocking {
        val observations = mutableListOf<Observation>()
        var reads = 0
        val presentation = BattlePresentation(
            get = { _, _ -> capabilities() }, simVersion = 15, pause = {},
            beginPreparation = { Observation((observations.size + 1).toLong()).also { observations += it } },
            observedGet = { _, _, timing -> transported(timing); if (reads++ == 0) JsonObject(emptyMap()) else complete() },
        )
        val result = presentation.observe(raid).toList().single()
        assertEquals(2, observations.size)
        assertEquals(listOf(BattlePreparationOutcome.UNCHANGED), observations.first().outcomes)
        assertTrue(observations.first().revisions.isEmpty())
        assertFalse(BattlePreparationStage.ASSEMBLY_COMPLETE in observations.first().stages)
        assertEquals(2L, result.getValue("_clientPreparationOrdinal").jsonPrimitive.long)
    }

    @Test fun `background cancellation ends the interrupted attempt without retry or assembly`() = runBlocking {
        val observation = Observation(1)
        var reads = 0
        val presentation = BattlePresentation(
            get = { _, _ -> capabilities() }, simVersion = 15, pause = { fail("Cancellation cannot retry") },
            beginPreparation = { observation },
            observedGet = { _, _, timing ->
                reads++; timing.observe(BattlePreparationStage.CALL_ENQUEUED)
                throw CancellationException("Backgrounded")
            },
        )
        assertTrue(runCatching { presentation.observe(raid).toList() }.exceptionOrNull() is CancellationException)
        assertEquals(1, reads); assertEquals(listOf(BattlePreparationOutcome.CANCELLED), observation.outcomes)
        assertTrue(observation.revisions.isEmpty())
        assertEquals(listOf(BattlePreparationStage.CALL_ENQUEUED), observation.stages)
    }

    @Test fun `throwing optional callbacks cannot alter battle data or prevent delivery`() = runBlocking {
        val broken = object : BattlePreparationTiming {
            override val ordinal: Long get() = throw AssertionError("Optional ordinal failed")
            override fun stage(stage: BattlePreparationStage) { throw AssertionError("Optional stage failed") }
            override fun assembled(revision: String) { throw CancellationException("Optional association failed") }
            override fun finish(outcome: BattlePreparationOutcome) { throw AssertionError("Optional outcome failed") }
        }
        for (factory in listOf<() -> BattlePreparationTiming?>({ throw AssertionError("Optional factory failed") }, { broken })) {
            var reads = 0
            val presentation = BattlePresentation(
                get = { _, _ -> capabilities() }, simVersion = 15, pause = {}, beginPreparation = factory,
                observedGet = { _, _, timing -> transported(timing); if (reads++ == 0) JsonObject(emptyMap()) else complete() },
            )
            val result = presentation.observe(raid).toList().single()
            assertEquals(complete(), JsonObject(result.filterKeys { !it.startsWith("_client") }))
            assertFalse(result.containsKey("_clientPreparationOrdinal"))
        }
    }

    @Test fun `continuation pages complete one assembly without overwriting first page timing`() = runBlocking {
        val observation = Observation(3)
        var firstReads = 0
        var continuationReads = 0
        var now = 123L
        fun page(offset: Int) = buildJsonObject {
            put("protocolVersion", 2); put("raidId", raid); put("revision", revision); put("generation", "c".repeat(32))
            put("parentRevision", JsonNull); put("replaceFromTick", 0)
            put("eventOffset", offset); put("totalEvents", 2)
            put("events", JsonArray(listOf(buildJsonObject { put("t", offset); put("e", "pos") })))
            put("commandOffset", 0); put("totalCommands", 0); put("commands", JsonArray(emptyList()))
            put("nextCursor", if (offset == 0) JsonPrimitive("page-two") else JsonNull)
            put("state", if (offset == 0) buildJsonObject {
                put("source", "archive"); put("status", "resolved"); put("simVersion", 15); put("raidProtocolVersion", 2)
                put("clock", buildJsonObject { put("rate", 1) }); put("lastSequence", -1)
                put("commands", JsonArray(emptyList()))
                put("snapshot", buildJsonObject {}); put("armySnapshot", buildJsonObject {}); put("result", JsonNull)
            } else JsonNull)
        }
        val presentation = BattlePresentation(
            get = { path, query ->
                if (path == "/native/capabilities") capabilities(2) else {
                    assertEquals("page-two", query["cursor"]); continuationReads++; now += 9_000_000_000L; page(1)
                }
            },
            simVersion = 15, pause = {}, monotonicNanos = { now }, beginPreparation = { observation },
            observedGet = { _, query, timing -> assertFalse(query.containsKey("cursor")); firstReads++; transported(timing); page(0) },
        )
        val result = presentation.observe(raid).toList().single()
        assertEquals(1, firstReads); assertEquals(1, continuationReads)
        assertEquals(BattlePreparationStage.entries.toList(), observation.stages)
        assertEquals(listOf(revision), observation.revisions)
        assertEquals(2, result.getValue("events").jsonArray.size)
        assertEquals(123L, result.getValue("_clientFirstPageReceivedAtNanos").jsonPrimitive.long)
        assertEquals(3L, result.getValue("_clientPreparationOrdinal").jsonPrimitive.long)
    }
}
