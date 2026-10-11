package gg.pixelkingdomwars.nativeclient.starter

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Planned historical DTO exported from actual SDK/Anchor access bytes and
 * the canonical coastal preview. No current access or finality is inferred. */
class StarterPaidExpeditionTest {
    private val fixture = starterJson.parseToJsonElement(requireNotNull(javaClass.getResource("/starter-paid-expedition.json")).readText()).jsonObject
    private val original get() = fixture.getValue("envelope").jsonObject
    private val receipt get() = original.getValue("receipt").jsonObject
    private val identity get() = StarterIdentity("https://game.test", "devnet", original.getValue("wallet").jsonPrimitive.content)
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private fun command(raw: JsonObject = original): StarterExpeditionCommand {
        val r = raw.getValue("receipt").jsonObject
        val request = starterJson.decodeFromJsonElement<StarterExpeditionRequest>(r.getValue("request"))
        val at = r.getValue("departedAt").jsonPrimitive.content
        return StarterExpeditionCommand(request, starterJson.decodeFromJsonElement(r.getValue("route")),
            StarterFleetInstallation(request.installationId, request.baseId, id(5), "starter", id(6), at, at))
    }
    private fun parse(raw: JsonObject = original) = StarterExpeditionProof.from(raw, identity, command(raw))
    private fun rejects(run: () -> Unit) { assertTrue(runCatching(run).isFailure) }
    private fun change(raw: JsonObject, path: String, value: JsonElement?): JsonObject {
        val keys = path.split('.')
        fun edit(at: JsonElement, i: Int): JsonElement {
            val objectValue = at.jsonObject; val key = keys[i]
            if (i == keys.lastIndex) return JsonObject(if (value == null) objectValue - key else objectValue + (key to value))
            return JsonObject(objectValue + (key to edit(objectValue.getValue(key), i + 1)))
        }
        return edit(raw, 0).jsonObject
    }
    private fun view(flight: StarterExpeditionFlight): StarterExpeditionView {
        val c = command()
        val routes = starterRouteIds.map { routeId ->
            val common = routeId.startsWith("common_")
            val realm = if (common) routeId.removePrefix("common_").replace('_', '-') else "crownlands"
            c.route.copy(routeCatalogueVersion = 2, rewardTableVersion = 2, routeId = routeId, realmId = realm,
                resourceId = starterResourceRealms.entries.single { it.value == realm }.key,
                access = if (common) StarterExpeditionAccess("starter_common", 1) else null)
        }
        return StarterExpeditionView("11111111111111111111111111111112", c.request.baseId, flight.departedAt,
            StarterExpeditionFeatures(StarterExpeditionFeature(1, 1)), true,
            StarterExpeditionHome("free_assignment", 1, "crownlands"), routes, c.installation, flight, flight.departedAt,
            starterResourceRealms.keys.map { OrdinaryRawStock(it, "0", "0", "0") })
    }
    @Test fun `actual paid history round trips after expiry without current access or provider`() {
        val proof = parse(); assertEquals("paid_frostveil", proof.receipt!!.route.routeId)
        val raw = starterJson.encodeToJsonElement(proof).jsonObject
        assertEquals(original, raw)
        val returned = change(change(original, "serverNow", JsonPrimitive("2035-01-01T00:00:00.000Z")), "return",
            buildJsonObject { put("returnId", id(7)); put("returnedAt", "2035-01-01T00:00:00.000Z") })
        assertEquals(proof.receipt, parse(returned).receipt)
    }
    @Test fun `paid history is never a stripped HOME route or a malformed common marker`() {
        for (raw in listOf(change(original, "receipt.route.access", null), change(original, "receipt.route.access", JsonNull),
            change(original, "receipt.route.access.observation", null), change(original, "receipt.route.access.observation", JsonNull),
            change(original, "receipt.route.access.kind", JsonPrimitive("starter_common")),
            change(original, "receipt.route.access.policyVersion", JsonPrimitive(2)),
            change(original, "receipt.route.routeCatalogueVersion", JsonPrimitive(2)),
            change(original, "receipt.route.rewardTableVersion", JsonPrimitive(3)))) rejects { parse(raw) }
    }
    @Test fun `paid receipt binds wallet destination and exclusive coverage to its original departure`() {
        val base = "receipt.route.access.observation"
        for ((path, value) in listOf(
            "$base.wallet" to JsonPrimitive("11111111111111111111111111111112"), "$base.realm" to JsonPrimitive(1),
            "$base.expiresAt" to JsonPrimitive("864000"), "$base.expiresAt" to JsonPrimitive("863999"),
            "$base.finality.observedAt" to JsonPrimitive("1970-01-11T00:00:00.001Z"),
            "$base.finality.chainUnixTimestamp" to JsonPrimitive("864001"),
            "$base.finality.commitment" to JsonPrimitive("confirmed"), "$base.finality.contextSlot" to JsonPrimitive("89"),
            "receipt.route.realmId" to JsonPrimitive("elderwood"), "receipt.route.resourceId" to JsonPrimitive("heartwood_logs")
        )) rejects { parse(change(original, path, value)) }
        // Coverage is required only at departure, not for the full journey.
        parse(change(original, "$base.expiresAt", JsonPrimitive("864001")))
    }
    @Test fun `source accounts have exact bounded order and cannot substitute deployment configuration or access`() {
        val path = "receipt.route.access.observation.source.accounts"
        val accounts = fixture.getValue("observation").jsonObject.getValue("source").jsonObject.getValue("accounts").jsonArray
        val wrong = "11111111111111111111111111111112"
        for (rows in listOf(accounts.dropLast(1), accounts + accounts.last(), accounts.reversed(), List(10000) { accounts.first() }))
            rejects { parse(change(original, path, JsonArray(rows))) }
        for ((index, field, value) in listOf(Triple(0, "address", JsonPrimitive(wrong)), Triple(1, "dataSha256", JsonPrimitive("ab".repeat(32))),
            Triple(2, "address", JsonPrimitive(wrong)), Triple(3, "address", JsonPrimitive(wrong)), Triple(4, "address", JsonPrimitive(wrong)),
            Triple(0, "executable", JsonPrimitive(false)), Triple(3, "exists", JsonPrimitive(false)), Triple(3, "owner", JsonPrimitive(wrong)))) {
            val changed = accounts.mapIndexed { i, row -> if (i == index) JsonObject(row.jsonObject + (field to value)) else row }
            rejects { parse(change(original, path, JsonArray(changed))) }
        }
        rejects { parse(change(original, "receipt.route.access.observation.source.trust", JsonPrimitive("unreviewed"))) }
    }
    @Test fun `scalar and tree bounds reject coercion excessive data and unknown authority fields`() {
        val base = "receipt.route.access.observation"
        for ((path, value) in listOf("$base.realm" to JsonPrimitive("0"), "$base.version" to JsonPrimitive("1"),
            "$base.expiresAt" to JsonPrimitive(1468800), "$base.expiresAt" to JsonPrimitive("01"),
            "$base.expiresAt" to JsonPrimitive("9223372036854775808"), "$base.wallet" to JsonPrimitive("1".repeat(100000)),
            "$base.finality.contextSlot" to JsonPrimitive("18446744073709551616"),
            "$base.source.reviewedDeploymentSlot" to JsonPrimitive(9007199254740992L),
            "$base.paymentAuthorized" to JsonPrimitive(true))) rejects { parse(change(original, path, value)) }
    }
    @Test fun `base transfer changes flight viewer without rewriting original buyer or adding a paid discovery route`() {
        val proof = parse(); val current = view(proof.receipt!!.flight()); current.validate()
        assertNotEquals(identity.wallet, current.wallet); assertEquals(11, current.routes.size)
        val parsed = StarterExpeditionView.from(starterJson.encodeToJsonElement(current).jsonObject)
        assertEquals(proof.receipt!!.flight(), parsed.flight)
        rejects { current.copy(routes = current.routes + command().route).validate() }
        rejects { command().admit(identity, current.copy(wallet = identity.wallet, flight = null)) }
        rejects { parse(change(original, "receipt.wallet", JsonPrimitive(current.wallet))) }
    }
    @Test fun `owned decoding cannot mutate paid source accounts through a cast`() {
        val proof = parse(); val before = starterJson.encodeToJsonElement(proof)
        val source = proof.receipt!!.route.access!!
        // Decode ownership is tested via reflection so the fixture compiles
        // before the new observation DTO exists (fixture-first red).
        val observation = source.javaClass.getMethod("getObservation").invoke(source)
        val evidence = observation.javaClass.getMethod("getSource").invoke(observation)
        @Suppress("UNCHECKED_CAST") val accounts = evidence.javaClass.getMethod("getAccounts").invoke(evidence) as MutableList<Any>
        rejects { accounts.clear() }; assertEquals(before, starterJson.encodeToJsonElement(proof))
    }
}
