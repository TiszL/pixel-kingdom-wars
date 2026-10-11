package gg.pixelkingdomwars.nativeclient.starter

import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Owner 2026-10-06 (dead-end audit): no saved request may block play forever on this device. One journal holds free
 * and paid starter departures. A paid departure is never sent twice, so an attempted one whose by-key receipt answered
 * `unknown` could never clear before (archiving needed a refusal); a free one stuck the same way once its route or base
 * stopped admitting it. StarterExpeditionRepository.reviewDeparture and reviewPaidDeparture refuse while any operation is
 * saved. Fixtures are copied from StarterExpeditionTest (free) and PaidStarterSelectionTest (paid); no device claim. */
class StarterExpeditionUnknownCloseTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private fun rejects(action: () -> Unit) { assertTrue(runCatching(action).isFailure) }
    private class Memory : SecretStore {
        var bytes: String? = null
        override fun read() = bytes
        override fun write(value: String) { bytes = value }
        override fun clear() { error("Must preserve saved bytes") }
    }
    /** The by-key receipt answers `unknown` until [accepted] (then [acceptance]); every POST loses its acknowledgement. */
    private class Port(val receiptPath: String, val unknown: JsonObject, val acceptance: JsonObject) : StarterExpeditionPort {
        var gets = 0; var posts = 0; var accepted = false
        override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
            guard(); assertEquals(receiptPath, path); gets++
            return (if (accepted) acceptance else unknown).also(retain)
        }
        override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
            guard(); posts++; throw IOException("acknowledgement lost")
        }
    }

    // Paid departure (PaidStarterSelectionTest fixture).
    private val fixture = starterJson.parseToJsonElement(requireNotNull(javaClass.getResource("/starter-paid-expedition.json")).readText()).jsonObject
    private val envelope = fixture.getValue("envelope").jsonObject
    private val receipt = starterJson.decodeFromJsonElement<StarterExpeditionReceipt>(envelope.getValue("receipt"))
    private val paidIdentity = StarterIdentity("https://game.test", "devnet", receipt.wallet)
    private val paid get() = receipt.route.copy(access = StarterExpeditionAccess("paid_realm", 1))
    private val paidInstalled = StarterFleetInstallation(receipt.installationId, receipt.request.baseId, id(8), "starter", id(9), receipt.departedAt, receipt.departedAt)
    private fun selected() = PaidStarterExpeditionView.from(buildJsonObject {
        put("wallet", receipt.wallet); put("baseId", receipt.request.baseId); put("realm", 0); put("serverNow", receipt.departedAt)
        put("authorization", "none"); put("acceptingDepartures", true); put("route", starterJson.encodeToJsonElement(paid))
        put("coverage", buildJsonObject { put("status", "covered"); put("expiresAt", receipt.route.access!!.observation!!.expiresAt); put("observedAt", receipt.departedAt) })
    })
    private fun paidView() = StarterExpeditionView(receipt.wallet, receipt.request.baseId, receipt.departedAt,
        StarterExpeditionFeatures(StarterExpeditionFeature(1, 1)), true, StarterExpeditionHome("free_assignment", 1, "crownlands"),
        starterRouteIds.map { routeId -> val common = routeId.startsWith("common_"); val realm = if (common) routeId.removePrefix("common_").replace('_', '-') else "crownlands"
            paid.copy(routeCatalogueVersion = 2, routeId = routeId, realmId = realm, resourceId = starterResourceRealms.entries.single { it.value == realm }.key,
                access = if (common) StarterExpeditionAccess("starter_common", 1) else null) },
        paidInstalled, null, receipt.departedAt, starterResourceRealms.keys.map { OrdinaryRawStock(it, "0", "0", "0") })
    private fun paidCommand(key: String = receipt.request.idempotencyKey) = StarterExpeditionCommand.reviewPaid(paidIdentity, paidView(), selected(), key)
    private fun paidPort() = Port(paidCommand().receiptPath, starterJson.encodeToJsonElement(StarterExpeditionProof.serializer(),
        StarterExpeditionProof(receipt.wallet, receipt.request.idempotencyKey, receipt.departedAt, "unknown", null, null)).jsonObject, envelope)

    // Free departure (StarterExpeditionTest fixture).
    private val identity = StarterIdentity("https://game.test", "devnet", "11111111111111111111111111111111")
    private val at = "2026-09-22T12:00:00.000Z"
    private val installed = StarterFleetInstallation(id(5), id(1), id(3), "starter", id(4), at, at)
    private fun route(id: String): StarterExpeditionRoute {
        val common = id.startsWith("common_")
        val realm = if (common) id.removePrefix("common_").replace('_', '-') else "crownlands"
        return StarterExpeditionRoute(2, 2, id, realm, starterResourceRealms.entries.single { it.value == realm }.key,
            "starter", 17, "101", "77", "24", if (common) StarterExpeditionAccess("starter_common", 1) else null)
    }
    private fun view() = StarterExpeditionView(identity.wallet, id(1), at, StarterExpeditionFeatures(StarterExpeditionFeature(1, 1)), true,
        StarterExpeditionHome("free_policy_preview", 1, "crownlands"), starterRouteIds.map(::route), installed, null, at,
        starterResourceRealms.keys.map { OrdinaryRawStock(it, "9", "1", "10") })
    private fun command(key: String = id(2)) = StarterExpeditionCommand.review(identity, view(), key, "coastal_survey")
    private fun unknown() = StarterExpeditionProof(identity.wallet, id(2), at, "unknown", null, null)
    private fun freePort() = Port(command().receiptPath, starterJson.encodeToJsonElement(StarterExpeditionProof.serializer(), unknown()).jsonObject, JsonObject(emptyMap()))

    @Test fun `a paid departure the server does not know cannot block departures forever`() = runBlocking<Unit> {
        val memory = Memory(); val store = StarterExpeditionStore(memory, paidIdentity); val port = paidPort()
        val transport = StarterExpeditionTransport(store, port)
        val draft = transport.beginPaid(paidCommand(), paidView(), selected()) {}
        rejects { runBlocking { transport.confirmPaid(draft, { paidView() }, { selected() }) {} } }
        val attempted = store.read(); assertNotNull(attempted.operation!!.attemptRevision); assertNull(attempted.operation!!.refusal)
        // A paid departure is never sent twice: its same-key retry is refused before any POST.
        rejects { runBlocking { transport.confirmPaid(attempted, { paidView() }, { selected() }) {} } }
        assertEquals(1, port.posts); assertEquals(attempted, store.read())
        val gets = port.gets
        val closed = transport.archiveUnsentOrRefused(store.read()) {}
        assertEquals(gets + 1, port.gets); assertEquals(1, port.posts)
        val archive = closed.archives.single(); assertEquals("unknown", archive.reason); assertEquals("unknown", archive.evidence!!.status)
        assertEquals(attempted.operation, archive.operation)
        // reviewPaidDeparture and reviewDeparture check `store.read().operation == null`: the door opens again on this device.
        assertNull(store.read().operation); assertEquals(closed, StarterExpeditionStore(memory, paidIdentity).read())
        transport.beginPaid(paidCommand(id(31)), paidView(), selected()) {}
        assertEquals(id(31), store.read().operation!!.command.key); assertEquals(1, port.posts)
    }
    @Test fun `a free departure whose route no longer admits it closes the same way without a POST`() = runBlocking<Unit> {
        val store = StarterExpeditionStore(Memory(), identity); val port = freePort(); val transport = StarterExpeditionTransport(store, port)
        val saved = transport.begin(command(), view()) {}
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }
        val attempted = store.read(); assertNotNull(attempted.operation!!.attemptRevision)
        rejects { runBlocking { transport.confirm(attempted, { view().copy(acceptingDepartures = false) }) {} } }
        assertEquals(1, port.posts); assertEquals(attempted, store.read())
        assertEquals("unknown", transport.archiveUnsentOrRefused(store.read()) {}.archives.single().reason)
        assertNull(store.read().operation); transport.begin(command(id(9)), view()) {}; assertEquals(1, port.posts)
    }
    @Test fun `close never forgets an accepted paid departure and a late acceptance stays recoverable`() = runBlocking<Unit> {
        val store = StarterExpeditionStore(Memory(), paidIdentity); val port = paidPort(); val transport = StarterExpeditionTransport(store, port)
        val draft = transport.beginPaid(paidCommand(), paidView(), selected()) {}
        rejects { runBlocking { transport.confirmPaid(draft, { paidView() }, { selected() }) {} } }
        port.accepted = true
        rejects { runBlocking { transport.archiveUnsentOrRefused(store.read()) {} } }
        assertEquals(receipt.request, store.read().operation!!.proof!!.receipt!!.request)
        assertTrue(store.read().archives.isEmpty()); assertEquals(1, port.posts)

        val other = StarterExpeditionStore(Memory(), paidIdentity); val late = paidPort(); val again = StarterExpeditionTransport(other, late)
        val saved = again.beginPaid(paidCommand(), paidView(), selected()) {}
        rejects { runBlocking { again.confirmPaid(saved, { paidView() }, { selected() }) {} } }
        again.archiveUnsentOrRefused(other.read()) {}
        late.accepted = true; again.checkArchived(receipt.request.idempotencyKey) {}
        val archive = other.read().archives.single()
        assertEquals("unknown", archive.reason); assertEquals(receipt.request, archive.operation.proof!!.receipt!!.request); assertEquals(1, late.posts)
    }
    @Test fun `the unknown archive reason is valid only for an attempted unrefused departure`() = runBlocking<Unit> {
        val memory = Memory(); val store = StarterExpeditionStore(memory, identity); store.begin(store.read(), command())
        rejects { store.archive(store.read(), "unknown", unknown()) }
        store.refuse(store.attempt(store.read()), StarterExpeditionRefusal(503, "STARTER_EXPEDITIONS_DISABLED")); val refused = memory.bytes
        rejects { store.archive(store.read(), "unknown", unknown()) }
        assertEquals(refused, memory.bytes); assertNotNull(store.read().operation)
    }
}
