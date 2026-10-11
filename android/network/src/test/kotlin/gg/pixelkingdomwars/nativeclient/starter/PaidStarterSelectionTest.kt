package gg.pixelkingdomwars.nativeclient.starter

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Frozen server DTO economics and actual encoded access history; no current grant. */
class PaidStarterSelectionTest {
    private val fixture = starterJson.parseToJsonElement(requireNotNull(javaClass.getResource("/starter-paid-expedition.json")).readText()).jsonObject
    private val envelope = fixture.getValue("envelope").jsonObject
    private val receipt = starterJson.decodeFromJsonElement<StarterExpeditionReceipt>(envelope.getValue("receipt"))
    private val identity = StarterIdentity("https://game.test", "devnet", receipt.wallet)
    private val paid get() = receipt.route.copy(access = StarterExpeditionAccess("paid_realm", 1))
    private val installed = StarterFleetInstallation(receipt.installationId, receipt.request.baseId, id(8), "starter", id(9), receipt.departedAt, receipt.departedAt)
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private fun selected() = buildJsonObject {
        put("wallet", receipt.wallet); put("baseId", receipt.request.baseId); put("realm", 0); put("serverNow", receipt.departedAt)
        put("authorization", "none"); put("acceptingDepartures", true); put("route", starterJson.encodeToJsonElement(paid))
        put("coverage", buildJsonObject { put("status", "covered"); put("expiresAt", receipt.route.access!!.observation!!.expiresAt); put("observedAt", receipt.departedAt) })
    }
    private fun view() = StarterExpeditionView(receipt.wallet, receipt.request.baseId, receipt.departedAt,
        StarterExpeditionFeatures(StarterExpeditionFeature(1, 1)), true, StarterExpeditionHome("free_assignment", 1, "crownlands"),
        starterRouteIds.map { routeId -> val common = routeId.startsWith("common_"); val realm = if (common) routeId.removePrefix("common_").replace('_', '-') else "crownlands"
            paid.copy(routeCatalogueVersion = 2, routeId = routeId, realmId = realm, resourceId = starterResourceRealms.entries.single { it.value == realm }.key,
                access = if (common) StarterExpeditionAccess("starter_common", 1) else null) },
        installed, null, receipt.departedAt, starterResourceRealms.keys.map { OrdinaryRawStock(it, "0", "0", "0") })
    private fun rejects(block: () -> Unit) { assertTrue(runCatching(block).isFailure) }
    private class Memory : SecretStore { var raw: String? = null; override fun read() = raw; override fun write(value: String) { raw = value }; override fun clear() { raw = null } }

    @Test fun `explicit selected view binds wire realm order and has no departure observation`() {
        assertEquals(listOf("frostveil", "elderwood", "sunscar", "crownlands", "seeker-reach", "stormcairn", "thornwake", "cinderfall"), paidStarterRealmIds)
        val v = PaidStarterExpeditionView.from(selected()); assertEquals(paid, v.route); assertNull(v.route.access!!.observation)
        validatePaidStarterSelection(receipt.request.baseId, "0")
        for (realm in listOf("00", "-1", "8", "0.0", "9999999999")) rejects { validatePaidStarterSelection(receipt.request.baseId, realm) }
        assertEquals(11, view().routes.size)
    }
    @Test fun `selected DTO rejects wrong destination unknown authority coercion and expired covered state`() {
        val raw = selected()
        for (changed in listOf(JsonObject(raw + ("realm" to JsonPrimitive(1))), JsonObject(raw + ("realm" to JsonPrimitive("0"))),
            JsonObject(raw + ("authorization" to JsonPrimitive("departure"))), JsonObject(raw + ("source" to JsonObject(emptyMap()))),
            JsonObject(raw + ("route" to starterJson.encodeToJsonElement(receipt.route))),
            JsonObject(raw + ("coverage" to buildJsonObject { put("status", "covered"); put("expiresAt", "864000"); put("observedAt", receipt.departedAt) }))))
            rejects { PaidStarterExpeditionView.from(changed) }
    }
    @Test fun `paid review requires original base facilities and coherent coastal economics from both server views`() {
        val v = PaidStarterExpeditionView.from(selected()); val current = view()
        val command = StarterExpeditionCommand.reviewPaid(identity, current, v, receipt.request.idempotencyKey)
        assertNull(command.route.access!!.observation); rejects { command.admit(identity, current) }
        for (bad in listOf(current.copy(lodgeCompletedAt = null), current.copy(installation = null), current.copy(acceptingDepartures = false)))
            rejects { command.admitPaid(identity, bad, v) }
        rejects { command.admitPaid(identity, current, v.copy(route = v.route.copy(durationSec = v.route.durationSec + 1))) }
    }
    @Test fun `accepted paid receipt preserves full observation while matching saved review without current tuning`() {
        val command = StarterExpeditionCommand.reviewPaid(identity, view(), PaidStarterExpeditionView.from(selected()), receipt.request.idempotencyKey)
        val proof = StarterExpeditionProof.from(envelope, identity, command); assertEquals(receipt, proof.receipt)
        val changed = command.copy(route = command.route.copy(grossQuantity = "103", netQuantity = "98", islandPoolQuantity = "5")); changed.validate()
        rejects { proof.validate(identity, changed) }
        rejects { StarterExpeditionProof.from(JsonObject(envelope + ("receipt" to starterJson.encodeToJsonElement(receipt.copy(route = paid)))), identity, command) }
    }
    @Test fun `paid ambiguous attempt stays one POST across fresh transport and original unknown receipts`() = runBlocking {
        val memory = Memory(); val store = StarterExpeditionStore(memory, identity); var posts = 0
        val command = StarterExpeditionCommand.reviewPaid(identity, view(), PaidStarterExpeditionView.from(selected()), receipt.request.idempotencyKey)
        val absent = starterJson.encodeToJsonElement(StarterExpeditionProof(identity.wallet, command.key, receipt.departedAt, "unknown", null, null)).jsonObject
        val port = object : StarterExpeditionPort {
            override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit) = absent.also { guard(); retain(it) }
            override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (gg.pixelkingdomwars.nativeclient.network.ApiException) -> Unit): JsonObject {
                guard(); assertNotNull(store.read().operation!!.attemptRevision); posts++; throw java.io.IOException("lost outcome")
            }
        }
        var transport = StarterExpeditionTransport(store, port); val selected = PaidStarterExpeditionView.from(selected())
        val draft = transport.beginPaid(command, view(), selected) {}; rejects { runBlocking { transport.confirmPaid(draft, { view() }, { selected }) {} } }
        val attempted = store.read(); transport = StarterExpeditionTransport(StarterExpeditionStore(memory, identity), port)
        transport.check {}; rejects { runBlocking { transport.confirmPaid(attempted, { view() }, { selected }) {} } }
        assertEquals(1, posts); assertEquals(attempted, store.read())
    }
    @Test fun `paid definitive refusal whitelist does not classify generic or wrong-status errors`() {
        for ((code, status) in listOf("EXPEDITION_ACCESS_NO_COVERAGE" to 409, "EXPEDITION_ACCESS_EXPIRED" to 409, "EXPEDITION_ACCESS_UNAVAILABLE" to 503)) {
            assertTrue(starterExpeditionRefusalDefinitive(status, code)); assertFalse(starterExpeditionRefusalDefinitive(500, code))
        }; assertFalse(starterExpeditionRefusalDefinitive(503, "INTERNAL_ERROR"))
    }
}
