package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeCapture
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticWakeVisual
import gg.pixelkingdomwars.nativeclient.fleetjourney.FleetJourneyEvent
import java.util.UUID
import java.io.File
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticProof
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Authored for Q9b; run only at the separately approved Q1 Gradle gate. No Android logging. */
class JourneyEvidenceLogTest {
    private val wallet = "2".repeat(32)
    private val base = "00000000-0000-4000-8000-000000000010"
    private val id = "00000000-0000-4000-8000-000000000001"
    private val at = "2026-10-02T03:00:00.000Z"
    private fun fields() = JourneyEvidenceLog.Fields(wallet, base, id, id, id,
        wake = "a".repeat(64), wakeBinding = "b".repeat(64), wakeState = "available",
        departedAt = at, returnsAt = at, serverNow = at, kind = "departure", publication = "pending")
    @Test fun `fixed grammar field order and points are exact`() {
        for ((i, point) in listOf("departure_submitted", "departure_settled", "return_requested", "return_settled").withIndex()) {
            val line = JourneyEvidenceLog.format(point, fields(), (i + 1).toLong())
            assertEquals("journey $point wallet=$wallet base=$base installation=$id berth=$id expedition=$id craft=unavailable " +
                "wake=${"a".repeat(64)} wakeBinding=${"b".repeat(64)} wakeState=available departedAt=$at returnsAt=$at " +
                "returnedAt=unavailable serverNow=$at kind=departure publication=pending seq=${i + 1}", line)
        }
        assertNull(JourneyEvidenceLog.format("invented", fields(), 1))
        assertNull(JourneyEvidenceLog.format("departure_submitted", fields(), 0))
    }
    @Test fun `missing malformed and secret shaped values never echo`() {
        val canary = UUID.randomUUID().toString()
        for (bad in listOf("Cookie: session=$canary", "Bearer $canary", "eyJ.$canary.token", "x\n$canary", " x ", "=", "2026-02-31T00:00:00Z")) {
            val all = JourneyEvidenceLog.Fields(bad,bad,bad,bad,bad,bad,bad,bad,bad,bad,bad,bad,bad,bad,bad)
            val line = requireNotNull(JourneyEvidenceLog.format("departure_submitted", all, 1))
            if (bad != "=") assertFalse(line.contains(bad))
            assertTrue(line.contains("wallet=unavailable base=unavailable"))
            assertFalse(line.contains(canary))
            assertTrue(line.endsWith("publication=unavailable seq=1"))
        }
        val empty = requireNotNull(JourneyEvidenceLog.format("return_requested", JourneyEvidenceLog.Fields(), 2))
        assertFalse(empty.contains(wallet)); assertTrue(empty.contains("wallet=unavailable base=unavailable"))
    }
    @Test fun `invalid calendar time substitutes unavailable and renderer rejection is explicit`() {
        val line = requireNotNull(JourneyEvidenceLog.format("return_settled", fields().copy(
            returnedAt="2026-13-01T00:00:00Z", publication="rejected"), 9))
        assertTrue(line.contains("returnedAt=unavailable")); assertTrue(line.contains("publication=rejected"))
    }
    @Test fun `canonical JSON sorts recursively without whitespace and hashes whole capture`() {
        val value = Json.parseToJsonElement("{\"z\":{\"b\":2,\"a\":1},\"a\":[null,\"x y\"]}")
        assertEquals("{\"a\":[null,\"x y\"],\"z\":{\"a\":1,\"b\":2}}", JourneyEvidenceLog.canonical(value))
        assertEquals("831c13c099f7d5f61268147d91d2697d8a4578d2ba570ab237d4c0f0bda78c7b",
            JourneyEvidenceLog.wakeHash(BoundCosmeticWakeCapture("legacy", null)))
        val hashes = listOf(BoundCosmeticWakeCapture("legacy", null), BoundCosmeticWakeCapture("unavailable", null),
            BoundCosmeticWakeCapture("available", BoundCosmeticWakeVisual(1, null))).map(JourneyEvidenceLog::wakeHash)
        assertEquals(3, hashes.toSet().size)
    }
    @Test fun `context retention binds the full tuple and refuses ambiguous wallets`() {
        val event = FleetJourneyEvent.from(journeyEvent("departure"))
        val context = fields().copy(base=event.baseId, installation=event.installationId, berth=event.berthId,
            expedition=event.expeditionId, wake=JourneyEvidenceLog.wakeHash(event.wake))
        val cache = JourneyEvidenceLog.Contexts()
        cache.remember(context)
        assertEquals(context.wallet, cache.find(event)?.wallet)
        assertNull(cache.find(event, "3".repeat(32)))
        assertNull(cache.find(event.copy(installationId=base)))
        cache.remember(context.copy(wallet="3".repeat(32)))
        assertNull(cache.find(event))
        assertEquals(wallet,cache.find(event,wallet)?.wallet)
        assertNull(JourneyEvidenceLog.Contexts().find(event))
    }
    @Test fun `debug context eviction and conflicting original clocks cannot invent provenance`() {
        val event = FleetJourneyEvent.from(journeyEvent("departure"))
        val context = fields().copy(base=event.baseId, installation=event.installationId, berth=event.berthId,
            expedition=event.expeditionId,wake=JourneyEvidenceLog.wakeHash(event.wake))
        val cache=JourneyEvidenceLog.Contexts(1);cache.remember(context)
        cache.remember(context.copy(returnsAt="2026-10-03T03:00:00.000Z"));assertNull(cache.find(event))
        cache.remember(context);cache.remember(context.copy(expedition=base));assertNull(cache.find(event))
    }

    private fun craftProof(): BoundCosmeticProof {
        val relative = "network/src/test/resources/boundcosmetics/wake-workshop-primary-pair.json"
        val file = listOf(File(relative), File("../$relative")).first { it.isFile }
        val original = Json.parseToJsonElement(file.readText()).jsonObject.getValue("completed").jsonObject.getValue("original").jsonObject
        return BoundCosmeticProof.from(original)
    }
    private fun craftEvent(proof: BoundCosmeticProof): FleetJourneyEvent = FleetJourneyEvent.from(journeyEvent("departure")).copy(
        at = requireNotNull(proof.completion).completedAt,
        wake = BoundCosmeticWakeCapture("available", BoundCosmeticWakeVisual(1, requireNotNull(proof.receipt).appearance)))
    @Test fun `completed Aurora original supplies the real job not blueprint or installation`() {
        val proof=craftProof(); val event=craftEvent(proof); val job=requireNotNull(proof.receipt).jobId
        assertEquals(job,JourneyEvidenceLog.craftJob(proof.wallet,event,proof))
        assertNotEquals(proof.receipt!!.blueprint.jobId,job)
        assertNotEquals(event.installationId,job)
        assertTrue(requireNotNull(JourneyEvidenceLog.format("departure_submitted",fields().copy(craft=job),1)).contains("craft=$job "))
    }
    @Test fun `same binding hash cannot hide a different frozen appearance`() {
        val proof=craftProof(); val event=craftEvent(proof); val appearance=requireNotNull(event.wake.visual?.wake)
        val changed=appearance.copy(sourceIndexSha256=if(appearance.sourceIndexSha256=="a".repeat(64)) "b".repeat(64) else "a".repeat(64))
        assertEquals(appearance.bindingSha256,changed.bindingSha256)
        assertEquals("unavailable",JourneyEvidenceLog.craftJob(proof.wallet,event.copy(wake=BoundCosmeticWakeCapture("available",BoundCosmeticWakeVisual(1,changed))),proof))
    }
    @Test fun `incomplete future wrong wallet and wrong output crafts are refused`() {
        val proof=craftProof(); val event=craftEvent(proof)
        assertEquals("unavailable",JourneyEvidenceLog.craftJob(proof.wallet,event,proof.copy(completion=null)))
        assertEquals("unavailable",JourneyEvidenceLog.craftJob(proof.wallet,event.copy(at=Instant.parse(event.at).minusMillis(1).toString()),proof))
        assertEquals("unavailable",JourneyEvidenceLog.craftJob("3".repeat(32),event,proof))
        assertEquals("unavailable",JourneyEvidenceLog.craftJob(proof.wallet,event,proof.copy(receipt=proof.receipt!!.copy(appearance=proof.receipt!!.appearance.copy(outputId="artisan_market_awning_t1")))))
        assertEquals("unavailable",JourneyEvidenceLog.craftJob(proof.wallet,event,proof.copy(idempotencyKey=UUID.randomUUID().toString())))
        assertEquals("unavailable",JourneyEvidenceLog.craftJob(proof.wallet,event,null))
        assertEquals("unavailable",JourneyEvidenceLog.craftJob(proof.wallet,event.copy(wake=BoundCosmeticWakeCapture("legacy",null)),proof))
    }
    @Test fun `craft context follows only its exact original tuple and refuses changed jobs`() {
        val proof=craftProof(); val event=craftEvent(proof); val job=JourneyEvidenceLog.craftJob(proof.wallet,event,proof)
        val f=fields().copy(wallet=proof.wallet,base=event.baseId,installation=event.installationId,berth=event.berthId,
            expedition=event.expeditionId,craft=job,wake=JourneyEvidenceLog.wakeHash(event.wake))
        val contexts=JourneyEvidenceLog.Contexts();contexts.remember(f)
        assertEquals(job,contexts.find(event)?.craft)
        assertEquals(job,contexts.find(event.copy(kind="return",returnId=id))?.craft)
        contexts.remember(f.copy(craft=UUID.randomUUID().toString()));assertNull(contexts.find(event))
    }
}
