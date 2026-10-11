package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Land checkout reservation through the one money mechanism: persist the exact fantasy address
 * before `POST /deposits`, accept only a complete frozen reservation, and resolve a 409 that names
 * the wallet's existing reservation without a second POST. */
class LandReservationSpecTest {
    private val depositId = "0f3a3a4e-2b1f-4a1e-9c3b-4d0d5e6f7a8b"
    private val baseId = "b86b557b-bb8f-488b-8b18-035600ba0e4a"
    private fun reservation(tile: Int = 14742, kind: String = "entry", status: String? = null): JsonObject = buildJsonObject {
        put("id", depositId); put("reference", "5Mx9V8mMkkdVDrMjAZGkYgutxSmxUdTPR846Q1okAgro"); put("kind", kind); put("amountLamports", 200000000)
        put("serverNow", "2026-09-11T10:00:00.000Z"); put("payableUntil", "2026-09-11T10:25:00.000Z"); put("retryAt", "2026-09-11T10:30:00.000Z")
        put("baseId", baseId); status?.let { put("status", it) }
        put("landAddress", buildJsonObject { put("kind", "fantasy"); put("worldId", "fantasy-v1"); put("tileId", tile) })
        put("fantasyLocation", buildJsonObject { put("worldId", "fantasy-v1"); put("tileId", tile); put("realmId", "frostveil"); put("allocation", "ordinary"); put("lon", -172.75); put("lat", 80.25) })
    }
    private fun intent(tile: Int? = 14742) = LandReservationSpec.intent(WALLET, "entry", tile, "land-key-0001")
    private fun fixture() = Triple(PendingIntentStore(MemoryStore()), ScriptedTransport(), mutableListOf<LandReservationAcceptance>())

    @Test fun `the body is the web's exact fantasy address and the intent carries no base`() {
        val body = intent().body
        assertEquals(json("""{"kind":"entry","idempotencyKey":"land-key-0001","landAddress":{"kind":"fantasy","worldId":"fantasy-v1","tileId":14742}}"""), body)
        assertEquals(json("""{"kind":"deed","idempotencyKey":"k-random-01","landAddress":{"kind":"fantasy","worldId":"fantasy-v1"}}"""), LandReservationSpec.body("deed", null, "k-random-01"))
        assertNull(intent().baseId); assertEquals(IntentKind.LAND_RESERVATION, intent().kind)
        assertThrows(IllegalArgumentException::class.java) { LandReservationSpec.body("builder", null, "k-random-01") }
        assertThrows(IllegalArgumentException::class.java) { LandReservationSpec.body("entry", -1, "k-random-01") }
    }
    @Test fun `the exact address is durable before the POST and a complete reservation is accepted`() = runBlocking {
        val (store, transport, hydrated) = fixture(); val memory = store
        transport.onPost = { path, body ->
            assertEquals("/deposits", path); assertEquals(intent().body, body)
            assertEquals(intent().nextAttempt(), memory.get(IntentKind.LAND_RESERVATION, WALLET))
            reservation()
        }
        val accepted = MoneyOp(LandReservationSpec, store, transport).submit(intent()) { hydrated += it.value }
        assertEquals(depositId, accepted.value.depositId); assertEquals("200000000", accepted.value.deposit.amountLamports)
        assertEquals("fantasy-v1:14742", accepted.value.deposit.reservationIdentity); assertFalse(accepted.value.recoveredFromRejection)
        assertEquals(1, hydrated.size); assertNull(store.get(IntentKind.LAND_RESERVATION, WALLET))
    }
    @Test fun `incomplete reservations and a different tile are refused and kept for recovery`() = runBlocking {
        val bad = listOf(
            JsonObject(reservation() - "reference"), JsonObject(reservation() - "baseId"), JsonObject(reservation() + ("amountLamports" to JsonPrimitive(0))),
            JsonObject(reservation() + ("landAddress" to buildJsonObject { put("kind", "legacy-earth"); put("earthCell", 5) })),
            reservation(tile = 99), reservation(kind = "deed"), reservation(status = "expired"),
            JsonObject(reservation() + ("fantasyLocation" to buildJsonObject { put("tileId", 1); put("realmId", "x") })),
        )
        for (reply in bad) {
            val (store, transport, _) = fixture(); transport.onPost = { _, _ -> reply }
            assertThrows(ApiCompatibilityException::class.java) { runBlocking { MoneyOp(LandReservationSpec, store, transport).submit(intent()) {} } }
            assertEquals("A malformed acknowledgement keeps the attempted intent", intent().nextAttempt(), store.get(IntentKind.LAND_RESERVATION, WALLET))
        }
    }
    @Test fun `already paid and a recovered terminal row are accepted as the server's answer`() = runBlocking {
        for (reply in listOf(buildJsonObject { put("alreadyPaid", true); put("kind", "entry") }, reservation(status = "credited"), reservation(status = "failed"))) {
            val (store, transport, hydrated) = fixture(); transport.onPost = { _, _ -> reply }
            val accepted = MoneyOp(LandReservationSpec, store, transport).submit(intent()) { hydrated += it.value }
            assertEquals(reply["alreadyPaid"] == JsonPrimitive(true), accepted.value.alreadyPaid)
            assertEquals(1, hydrated.size); assertNull(store.get(IntentKind.LAND_RESERVATION, WALLET))
        }
        val (store, transport, _) = fixture(); transport.onPost = { _, _ -> buildJsonObject { put("alreadyPaid", true); put("kind", "entry") } }
        assertThrows("A deed purchase can never be already paid", ApiCompatibilityException::class.java) {
            runBlocking { MoneyOp(LandReservationSpec, store, transport).submit(LandReservationSpec.intent(WALLET, "deed", null, "land-key-0002")) {} }
        }
        Unit
    }
    @Test fun `a 409 naming the wallet's existing reservation resolves the intent without another POST`() = runBlocking {
        for (code in listOf("RESERVATION_MISMATCH", "PAYMENT_WINDOW_CLOSING")) {
            val (store, transport, hydrated) = fixture()
            val details = buildJsonObject { put("depositId", depositId); put("serverNow", "2026-09-11T10:00:00.000Z"); put("payableUntil", "2026-09-11T10:25:00.000Z"); put("retryAt", "2026-09-11T10:30:00.000Z")
                put("landAddress", buildJsonObject { put("kind", "fantasy"); put("worldId", "fantasy-v1"); put("tileId", 777) }) }
            transport.onPost = { _, _ -> throw ApiException(409, code, "already reserves another tile", details) }
            val accepted = MoneyOp(LandReservationSpec, store, transport).submit(intent()) { hydrated += it.value }
            assertTrue(accepted.value.recoveredFromRejection); assertEquals(depositId, accepted.value.depositId)
            assertEquals("The code travels with the resolution: the caller's copy is chosen by it, not by which fields came", code, accepted.value.rejectionCode)
            assertEquals(777, accepted.value.deposit.landAddress!!.tileId); assertEquals("2026-09-11T10:30:00.000Z", accepted.value.deposit.retryAt)
            assertEquals(1, transport.posts.size); assertEquals(listOf(accepted.value), hydrated)
            assertNull("Hydrated resolution retires the intent", store.get(IntentKind.LAND_RESERVATION, WALLET))
        }
    }
    @Test fun `a resolving 409 whose hydration fails keeps the proof and restores it without any request`() = runBlocking {
        val (store, transport, hydrated) = fixture()
        val details = buildJsonObject { put("depositId", depositId) }
        transport.onPost = { _, _ -> throw ApiException(409, "RESERVATION_MISMATCH", "mismatch", details) }
        val op = MoneyOp(LandReservationSpec, store, transport)
        assertThrows(IOException::class.java) { runBlocking { op.submit(intent()) { throw IOException("deposit read failed") } } }
        val proven = requireNotNull(store.get(IntentKind.LAND_RESERVATION, WALLET))
        assertEquals(ReceiptDocument.SOURCE_REJECTION, ReceiptDocument.source(requireNotNull(proven.receipt)))
        val observed = op.observe(WALLET) { hydrated += it.value } as Receipt.Accepted
        assertEquals(depositId, observed.value.depositId); assertTrue(observed.value.recoveredFromRejection)
        assertEquals("The persisted rejection document restores its code", "RESERVATION_MISMATCH", observed.value.rejectionCode)
        assertEquals(1, transport.posts.size); assertTrue(transport.gets.isEmpty()); assertNull(store.get(IntentKind.LAND_RESERVATION, WALLET))
    }
    @Test fun `ordinary refusals and a 409 without a deposit id stay ordinary rejections`() = runBlocking {
        for ((status, code, details) in listOf(
            Triple(409, "RESERVATION_MISMATCH", buildJsonObject { put("depositId", "not-a-uuid") }),
            Triple(409, "ENTRY_REQUIRED", buildJsonObject { put("depositId", depositId) }),
            Triple(422, "INVALID_LAND_ADDRESS", buildJsonObject {}), Triple(426, "WORLD_UPDATE_REQUIRED", buildJsonObject { put("depositId", depositId) }),
            Triple(503, "FANTASY_WORLD_NOT_READY", buildJsonObject {}), Triple(503, "MAINTENANCE", buildJsonObject {}), Triple(500, null, buildJsonObject {}),
        )) {
            val (store, transport, hydrated) = fixture(); transport.onPost = { _, _ -> throw ApiException(status, code, "refused", details) }
            val error = assertThrows(ApiException::class.java) { runBlocking { MoneyOp(LandReservationSpec, store, transport).submit(intent()) { hydrated += it.value } } }
            assertEquals(code, error.code); assertTrue(hydrated.isEmpty())
            // The pre-write refusals of deposits.ts (world not ready, purchases paused, stale client) prove nothing was reserved.
            if (isDefinitiveRejection(status) || LandReservationSpec.disprovesAcceptance(error)) assertNull("first-attempt refusal clears ($code)", store.get(IntentKind.LAND_RESERVATION, WALLET))
            else assertNotNull("server failure keeps the intent ($code)", store.get(IntentKind.LAND_RESERVATION, WALLET))
        }
    }
    @Test fun `a pre-write refusal retires even a retried intent, an ordinary refusal of a retry does not`() = runBlocking {
        for ((status, code, retires) in listOf(Triple(503, "FANTASY_WORLD_NOT_READY", true), Triple(409, "LAND_PURCHASES_PAUSED", true), Triple(426, "WORLD_UPDATE_REQUIRED", true), Triple(409, "ENTRY_REQUIRED", false), Triple(503, "MAINTENANCE", false))) {
            val (store, transport, _) = fixture(); transport.onPost = { _, _ -> throw IOException("lost") }
            val op = MoneyOp(LandReservationSpec, store, transport)
            assertThrows(IOException::class.java) { runBlocking { op.submit(intent()) {} } }
            transport.onPost = { _, _ -> throw ApiException(status, code, "refused") }
            assertThrows(ApiException::class.java) { runBlocking { op.retry(WALLET) {} } }
            assertEquals("$code retires=$retires", retires, store.get(IntentKind.LAND_RESERVATION, WALLET) == null)
        }
    }
    @Test fun `a lost reply has no receipt route and recovers only by explicit retry of the same body`() = runBlocking {
        val (store, transport, hydrated) = fixture(); transport.onPost = { _, _ -> throw IOException("lost") }
        val op = MoneyOp(LandReservationSpec, store, transport)
        assertThrows(IOException::class.java) { runBlocking { op.submit(intent()) {} } }
        assertEquals(Receipt.Unsupported, op.observe(WALLET) {}); assertTrue(transport.gets.isEmpty())
        val observer = ReceiptObserver(store); observer.refresh(WALLET)
        val interrupted = observer.interrupted.value.single()
        assertTrue(interrupted.retryable); assertFalse(interrupted.closable)
        transport.onPost = { _, body -> assertEquals(intent().body, body); reservation() }
        val retried = op.retry(WALLET) { hydrated += it.value }
        assertEquals(depositId, retried.value.depositId); assertEquals(2, transport.posts.size); assertNull(store.get(IntentKind.LAND_RESERVATION, WALLET))
    }
    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
}
