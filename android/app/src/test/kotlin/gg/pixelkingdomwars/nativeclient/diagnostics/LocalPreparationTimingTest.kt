package gg.pixelkingdomwars.nativeclient.diagnostics

import gg.pixelkingdomwars.nativeclient.network.BattlePreparationOutcome
import gg.pixelkingdomwars.nativeclient.network.BattlePreparationStage
import gg.pixelkingdomwars.nativeclient.network.BattlePreparationTiming
import gg.pixelkingdomwars.nativeclient.renderer.LocalPreparationOutcome
import gg.pixelkingdomwars.nativeclient.renderer.LocalPreparationStage
import gg.pixelkingdomwars.nativeclient.renderer.LocalPreparationTrace
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class LocalPreparationTimingTest {
    private var time = 10L
    private var allowed = true
    private val owner = Any()
    private val revision = "a".repeat(64)
    private val build = "0.5.0:16:dev"
    private val core = LocalPreparationTiming { time }.also { it.reset(1) }
    private fun begin(owner: Any = this.owner, permission: () -> Boolean = { allowed }) =
        requireNotNull(core.begin(1, owner, 1000, build, permission))
    private fun assembled(attempt: BattlePreparationTiming, revision: String = this.revision) {
        BattlePreparationStage.entries.forEach { time += 10; attempt.stage(it) }
        attempt.assembled(revision)
    }
    private fun mapper(attempt: BattlePreparationTiming, owner: Any = this.owner, revision: String = this.revision) =
        requireNotNull(core.mapping(1, owner, attempt.ordinal, revision))
    private fun renderer(mapper: LocalPreparationTrace, generation: Long = 7): LocalPreparationTrace {
        mapper.stage(LocalPreparationStage.MAPPER_STARTED)
        mapper.stage(LocalPreparationStage.MAPPER_COMPLETED)
        return requireNotNull(mapper.renderer(generation))
    }
    private fun records() = requireNotNull(core.sample(1)).records

    @Test fun `reset fences old callbacks and saved acknowledgements without retiring a fresh opt in`() {
        val old = begin(); assembled(old)
        val oldRenderer = renderer(mapper(old))
        val oldBatch = requireNotNull(core.sample(1))
        core.reset(2)
        old.stage(BattlePreparationStage.BODY_READ)
        oldRenderer.stage(LocalPreparationStage.RENDERER_STARTED)
        oldRenderer.finish(LocalPreparationOutcome.FAILED)
        core.saved(oldBatch)
        assertNull(core.sample(1)); assertNull(core.sample(2)); assertFalse(core.hasWork(2))
        assertNull(core.begin(1, owner, 1000, build) { true })
        val fresh = requireNotNull(core.begin(2, owner, 2000, build) { true })
        core.saved(oldBatch)
        val freshBatch = requireNotNull(core.sample(2))
        assertEquals(listOf(fresh.ordinal), freshBatch.records.map { it.ordinal })
        assertEquals(setOf("started"), freshBatch.records.single().stagesMs.keys)
        core.saved(freshBatch)
        assertFalse(core.hasWork(2)); assertNull(core.sample(2))
    }

    @Test fun `revoked consent prevents admission and terminates existing evidence without late stages`() {
        val attempt = begin(); assembled(attempt)
        val trace = renderer(mapper(attempt))
        val before = records().single().stagesMs
        allowed = false; time += 100
        assertNull(core.begin(1, owner, 1000, build) { allowed })
        trace.stage(LocalPreparationStage.RENDERER_STARTED)
        trace.finish(LocalPreparationOutcome.FAILED)
        val cancelled = records().single()
        assertEquals("cancelled", cancelled.outcome); assertEquals(before, cancelled.stagesMs)
        // Re-enabling cannot revive an attempt whose scope was revoked.
        allowed = true; trace.stage(LocalPreparationStage.RENDERER_STARTED)
        assertEquals(cancelled, records().single())
        assertNull(core.mapping(1, owner, attempt.ordinal, revision))
    }

    @Test fun `matching revision cannot cross owner identity ordinal or consent generation`() {
        data class Owner(val privateName: String)
        val firstOwner = Owner("same-account-and-base")
        val equalReplacement = Owner("same-account-and-base")
        val attempt = begin(firstOwner); assembled(attempt)
        assertEquals(firstOwner, equalReplacement); assertNotSame(firstOwner, equalReplacement)
        assertNull(core.mapping(1, equalReplacement, attempt.ordinal, revision))
        assertNull(core.mapping(1, firstOwner, attempt.ordinal + 1, revision))
        assertNull(core.mapping(1, firstOwner, attempt.ordinal, "b".repeat(64)))
        assertNull(core.mapping(2, firstOwner, attempt.ordinal, revision))
        assertNotNull(core.mapping(1, firstOwner, attempt.ordinal, revision))
    }

    @Test fun `retained scene reuse closes only its exact new assembled attempt without fabricated mapping stages`() {
        val retained = begin(); assembled(retained)
        val rendering = renderer(mapper(retained))
        val fresh = begin(); assembled(fresh)
        core.reuse(1, Any(), fresh.ordinal, revision)
        core.reuse(2, owner, fresh.ordinal, revision)
        core.reuse(1, owner, fresh.ordinal, "b".repeat(64))
        core.reuse(1, owner, fresh.ordinal + 1, revision)
        assertTrue(records().all { it.outcome == "pending" })
        core.reuse(1, owner, retained.ordinal, revision)
        assertEquals("pending", records().first().outcome)
        core.reuse(1, owner, fresh.ordinal, revision)
        val reused = records().last()
        assertEquals("unchanged", reused.outcome)
        assertTrue("assembly_complete" in reused.stagesMs && "ended" in reused.stagesMs)
        assertFalse(reused.stagesMs.keys.any { it.startsWith("mapper") || it.startsWith("renderer") })
        assertNull(core.mapping(1, owner, fresh.ordinal, revision))
        fresh.finish(BattlePreparationOutcome.FAILED)
        rendering.stage(LocalPreparationStage.RENDERER_STARTED)
        assertEquals(reused, records().last())
        assertTrue("renderer_started" in records().first().stagesMs)
    }

    @Test fun `reuse does not close incomplete revoked or retired attempts`() {
        val incomplete = begin(); incomplete.assembled(revision)
        core.reuse(1, owner, incomplete.ordinal, revision)
        assertEquals("pending", records().single().outcome)
        assembled(incomplete); allowed = false
        core.reuse(1, owner, incomplete.ordinal, revision)
        assertEquals("cancelled", records().single().outcome)
        allowed = true; core.reuse(1, owner, incomplete.ordinal, revision)
        assertEquals("cancelled", records().single().outcome)
    }

    @Test fun `closing one owner cancels its pending work immediately without ending another owner`() {
        val closing = begin(); assembled(closing); val outgoing = renderer(mapper(closing))
        val otherOwner = Any()
        val other = begin(otherOwner); assembled(other); val surviving = renderer(mapper(other, otherOwner))
        core.close(owner)
        val afterClose = records()
        assertEquals("cancelled", afterClose.single { it.ordinal == closing.ordinal }.outcome)
        assertEquals("pending", afterClose.single { it.ordinal == other.ordinal }.outcome)
        assertNull(core.mapping(1, owner, closing.ordinal, revision))
        outgoing.stage(LocalPreparationStage.RENDERER_STARTED)
        outgoing.finish(LocalPreparationOutcome.FAILED)
        surviving.stage(LocalPreparationStage.RENDERER_STARTED)
        assertEquals(afterClose.first(), records().first())
        assertTrue("renderer_started" in records().last().stagesMs)
    }

    @Test fun `invalid or replaced revision cannot bind an unrelated assembly`() {
        val attempt = begin(); assembled(attempt, "private-unvalidated-revision")
        assertNull(core.mapping(1, owner, attempt.ordinal, "private-unvalidated-revision"))
        attempt.assembled(revision); attempt.assembled("b".repeat(64))
        assertNull(core.mapping(1, owner, attempt.ordinal, "b".repeat(64)))
        assertNotNull(core.mapping(1, owner, attempt.ordinal, revision))
    }

    @Test fun `first draw requires all measured stage pairs and retains the first timestamps`() {
        val attempt = begin(); attempt.assembled(revision)
        attempt.stage(BattlePreparationStage.ASSEMBLY_COMPLETE)
        assertNull(core.mapping(1, owner, attempt.ordinal, revision))
        assertEquals(mapOf("started" to 0L), records().single().stagesMs)
        assembled(attempt)
        time = 70; val mapping = mapper(attempt)
        assertNull(mapping.renderer(7))
        mapping.stage(LocalPreparationStage.MAPPER_COMPLETED)
        assertFalse("mapper_completed" in records().single().stagesMs)
        time = 75; mapping.stage(LocalPreparationStage.MAPPER_STARTED)
        time = 80; mapping.stage(LocalPreparationStage.MAPPER_COMPLETED)
        time = 90; val rendering = requireNotNull(mapping.renderer(7))
        rendering.stage(LocalPreparationStage.RENDERER_COMPLETED)
        rendering.stage(LocalPreparationStage.GL_ACTIVATED)
        rendering.stage(LocalPreparationStage.FIRST_DRAW)
        assertEquals("pending", records().single().outcome)
        assertFalse("first_draw" in records().single().stagesMs)
        time = 100; rendering.stage(LocalPreparationStage.RENDERER_STARTED)
        time = 120; rendering.stage(LocalPreparationStage.RENDERER_COMPLETED)
        time = 130; rendering.stage(LocalPreparationStage.GL_ACTIVATED)
        time = 150; rendering.stage(LocalPreparationStage.FIRST_DRAW)
        val drawn = records().single()
        assertEquals("drawn", drawn.outcome)
        assertEquals(mapOf("started" to 0L, "call_enqueued" to 10L, "response_headers" to 20L,
            "body_read" to 30L, "json_parsed" to 40L, "assembly_complete" to 50L,
            "mapper_queued" to 60L, "mapper_started" to 65L, "mapper_completed" to 70L, "renderer_queued" to 80L,
            "renderer_started" to 90L, "renderer_completed" to 110L, "gl_activated" to 120L,
            "first_draw" to 140L), drawn.stagesMs)
        time = 200; rendering.stage(LocalPreparationStage.FIRST_DRAW)
        rendering.finish(LocalPreparationOutcome.SUPERSEDED); attempt.finish(BattlePreparationOutcome.FAILED)
        assertEquals(drawn, records().single())
    }

    @Test fun `renderer ownership rejects late mapper callbacks and cannot be reassigned`() {
        val attempt = begin(); assembled(attempt)
        val mapping = mapper(attempt); val rendering = renderer(mapping)
        assertNull(mapping.renderer(8)); assertNull(rendering.renderer(8))
        val before = records().single()
        mapping.stage(LocalPreparationStage.RENDERER_STARTED)
        mapping.finish(LocalPreparationOutcome.CANCELLED)
        assertEquals(before, records().single())
        rendering.stage(LocalPreparationStage.RENDERER_STARTED)
        assertTrue("renderer_started" in records().single().stagesMs)
    }

    @Test fun `cancelled and failed preparations cannot graft a retry onto their earlier timings`() {
        listOf(LocalPreparationOutcome.CANCELLED, LocalPreparationOutcome.FAILED).forEach { outcome ->
            val first = begin(); assembled(first); val firstMapping = mapper(first)
            time += 20; firstMapping.finish(outcome)
            val stopped = records().last()
            val retry = begin(); assembled(retry); val retryRenderer = renderer(mapper(retry))
            assertNotEquals(first.ordinal, retry.ordinal)
            assertNull(core.mapping(1, owner, first.ordinal, revision))
            firstMapping.stage(LocalPreparationStage.MAPPER_COMPLETED)
            assertNull(firstMapping.renderer(8))
            first.stage(BattlePreparationStage.ASSEMBLY_COMPLETE)
            retryRenderer.stage(LocalPreparationStage.RENDERER_STARTED)
            val rows = records()
            assertEquals(stopped, rows.single { it.ordinal == first.ordinal })
            assertEquals(outcome.name.lowercase(), stopped.outcome)
            assertTrue("renderer_started" in rows.single { it.ordinal == retry.ordinal }.stagesMs)
        }
    }

    @Test fun `network terminal attempts and delayed outgoing renderers cannot certify another attempt`() {
        BattlePreparationOutcome.entries.forEach { outcome ->
            val attempt = begin(); assembled(attempt); attempt.finish(outcome)
            assertNull(core.mapping(1, owner, attempt.ordinal, revision))
            assertEquals(outcome.name.lowercase(), records().last().outcome)
        }
        val first = begin(); assembled(first); val outgoing = renderer(mapper(first))
        outgoing.finish(LocalPreparationOutcome.SUPERSEDED)
        val replacement = begin(); assembled(replacement); renderer(mapper(replacement), 8)
        val before = records()
        outgoing.stage(LocalPreparationStage.RENDERER_STARTED)
        outgoing.stage(LocalPreparationStage.RENDERER_COMPLETED)
        outgoing.stage(LocalPreparationStage.GL_ACTIVATED)
        outgoing.stage(LocalPreparationStage.FIRST_DRAW)
        assertEquals(before, records())
        assertEquals("pending", records().last().outcome)
    }

    @Test fun `fixed ring evicts oldest attempts and stale handles cannot edit a reused slot`() {
        val old = begin(); assembled(old); val oldRenderer = renderer(mapper(old))
        val retainedOrdinals = mutableListOf<Long>()
        repeat(LocalPreparationTiming.LIMIT + 5) { retainedOrdinals += begin().ordinal }
        val batch = requireNotNull(core.sample(1))
        assertEquals(retainedOrdinals.takeLast(LocalPreparationTiming.LIMIT), batch.records.map { it.ordinal })
        core.saved(batch); assertFalse(core.hasWork(1))
        old.stage(BattlePreparationStage.BODY_READ)
        oldRenderer.stage(LocalPreparationStage.RENDERER_STARTED)
        oldRenderer.finish(LocalPreparationOutcome.CANCELLED)
        assertNull(core.mapping(1, owner, old.ordinal, revision))
        assertFalse(core.hasWork(1)); assertNull(core.sample(1))
    }

    @Test fun `backwards and expired clocks cannot manufacture preparation durations`() {
        val attempt = begin(); time = 0; attempt.stage(BattlePreparationStage.CALL_ENQUEUED)
        assertEquals(mapOf("started" to 0L), records().single().stagesMs)
        time = 10 + LocalPreparationTiming.MAX_MS + 1
        attempt.stage(BattlePreparationStage.CALL_ENQUEUED)
        val expired = records().single()
        assertEquals("expired", expired.outcome)
        assertEquals(mapOf("started" to 0L), expired.stagesMs)
        attempt.finish(BattlePreparationOutcome.FAILED)
        assertEquals(expired, records().single())
    }

    @Test fun `a clock moving backwards within an attempt cannot create negative stage pair durations`() {
        val attempt = begin()
        time = 100; attempt.stage(BattlePreparationStage.CALL_ENQUEUED)
        time = 90; attempt.stage(BattlePreparationStage.RESPONSE_HEADERS)
        assertFalse("response_headers" in records().single().stagesMs)
        time = 120; attempt.stage(BattlePreparationStage.RESPONSE_HEADERS)
        assertEquals(90L, records().single().stagesMs["call_enqueued"])
        assertEquals(110L, records().single().stagesMs["response_headers"])
    }

    @Test fun `simultaneous mapper admission cannot return two owners for one assembly`() {
        val permission = RacingPermission()
        val attempt = begin(permission = permission::allowed); assembled(attempt)
        permission.arm()
        val accepted = race { core.mapping(1, owner, attempt.ordinal, revision) }
        assertEquals("A failed CAS must not leak its speculative admission", 1, accepted.size)
    }

    @Test fun `simultaneous renderer generations cannot both own the same mapped scene`() {
        val permission = RacingPermission()
        val attempt = begin(permission = permission::allowed); assembled(attempt)
        val mapping = mapper(attempt); mapping.stage(LocalPreparationStage.MAPPER_STARTED)
        mapping.stage(LocalPreparationStage.MAPPER_COMPLETED)
        permission.arm()
        val generations = AtomicInteger()
        val accepted = race { mapping.renderer(generations.incrementAndGet().toLong()) }
        assertEquals("Only the successful renderer binding may receive a trace", 1, accepted.size)
    }

    @Test fun `serialized timings exclude owner revision request identity and arbitrary text`() {
        val privateOwner = object { override fun toString() = "wallet://PRIVATE-ACCOUNT/PRIVATE-RAID" }
        val privateRevision = "d".repeat(64)
        val attempt = begin(privateOwner); assembled(attempt, privateRevision)
        renderer(mapper(attempt, privateOwner, privateRevision))
        val row = records().single()
        val serialized = Json.encodeToString(row)
        val fields = Json.parseToJsonElement(serialized).jsonObject
        assertEquals(setOf("at", "ordinal", "stagesMs", "outcome", "build"), fields.keys)
        assertFalse(serialized.contains(privateOwner.toString()))
        assertFalse(serialized.contains(privateRevision))
        assertFalse(serialized.contains("PRIVATE-")); assertFalse(serialized.contains("wallet://"))
        assertTrue(row.stagesMs.keys.all { it in LocalPreparationTiming.STAGES })
        assertEquals(build, row.build)
    }

    @Test fun `retained bundle rejects private fields and invalid metrics before serialization`() {
        val attempt = begin(); assembled(attempt); renderer(mapper(attempt))
        val row = records().single()
        val rejected = listOf(
            row.copy(ordinal = 101, stagesMs = mapOf("https://PRIVATE-ORIGIN/PRIVATE-RAID" to 1)),
            row.copy(ordinal = 102, outcome = "PRIVATE-EXCEPTION"),
            row.copy(ordinal = 103, build = "PRIVATE-BUILD-WALLET"),
            row.copy(ordinal = 104, stagesMs = mapOf("body_read" to -1)),
            row.copy(ordinal = 105, stagesMs = mapOf("body_read" to LocalPreparationTiming.MAX_MS + 1)),
            row.copy(ordinal = 106, at = 1001),
            row.copy(ordinal = 107, at = 1000 - REPORT_RETENTION_MS - 1),
        )
        val kept = LocalReportBundle(preparations = listOf(row) + rejected + row).retained(1000)
        assertEquals(listOf(row), kept.preparations)
        val serialized = Json.encodeToString(kept)
        assertFalse(serialized.contains("PRIVATE-")); assertFalse(serialized.contains("https://"))
        assertEquals(kept, Json.decodeFromString<LocalReportBundle>(serialized))
        val many = List(LocalPreparationTiming.LIMIT + 10) { row.copy(ordinal = (it + 1).toLong()) }
        assertEquals(many.takeLast(LocalPreparationTiming.LIMIT), LocalReportBundle(preparations = many).retained(1000).preparations)
    }

    /** Both callers have read the same entry before either attempts compare-and-set. */
    private class RacingPermission {
        private var barrier: CyclicBarrier? = null
        private val reads = AtomicInteger()
        fun arm() { barrier = CyclicBarrier(2) }
        fun allowed(): Boolean {
            barrier?.let { if (reads.getAndIncrement() < 2) it.await(2, TimeUnit.SECONDS) }
            return true
        }
    }
    private fun <T : Any> race(work: () -> T?): List<T> {
        val accepted = Collections.synchronizedList(mutableListOf<T>())
        val failures = Collections.synchronizedList(mutableListOf<Throwable>())
        val workers = List(2) { Thread { try { work()?.let { accepted += it } } catch (error: Throwable) { failures += error } } }
        workers.forEach { it.start() }
        workers.forEach { it.join(3000); assertFalse("Diagnostic callback must not block", it.isAlive) }
        if (failures.isNotEmpty()) throw AssertionError("Concurrent diagnostic call failed", failures.first())
        return accepted.toList()
    }
}
