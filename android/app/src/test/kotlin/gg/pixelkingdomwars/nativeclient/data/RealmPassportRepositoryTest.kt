package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic wire vectors verify refusal and lifecycle; actual API pairing is a separate root gate. */
internal object PassportTestWire {
    const val first = "00000000-0000-4000-8000-000000000001"
    const val second = "00000000-0000-4000-8000-000000000002"
    const val pageLast = "00000000-0000-4000-8000-000000000020"
    const val afterPage = "00000000-0000-4000-8000-000000000021"
    fun expeditionId(n: Int) = "00000000-0000-4000-8000-" + n.toString().padStart(12, '0')
    fun fullExpeditions() = (1..20).map { expedition(expeditionId(it)) }
    fun fullInclusions(start: String = "1") = (0..19).map { inclusion((start.toBigInteger() + it.toBigInteger()).toString()) }
    fun envelope(data: JsonElement, unavailable: String? = null, wallet: String = WALLET) = buildJsonObject {
        put("version", 1); put("wallet", wallet); put("serverNow", "2026-09-30T12:00:00.000Z"); put("projection", "history-only")
        put("state", if (unavailable == null) "available" else "unavailable"); put("data", data)
        unavailable?.let { put("reason", it) }
    }
    fun expedition(id: String = first, kind: String = "starter") = json("""{"kind":"$kind","expeditionId":"$id","returnId":"$second","originalBaseId":"$BASE_ID","realmId":"crownlands","routeId":"route-original","routeVersion":${if (kind == "starter") "1" else "null"},"policyVersion":${if (kind == "advanced") "2" else "null"},"departedAt":"2026-09-28T10:00:00.000Z","scheduledReturnAt":"2026-09-29T10:00:00.000Z","returnedAt":"2026-09-30T10:00:00.000Z"}""")
    fun expeditions(kind: String = "starter", rows: List<JsonObject> = listOf(expedition(kind = kind)), next: String? = null) = envelope(buildJsonObject {
        put("kind", kind); put("rows", JsonArray(rows)); put("nextCursor", next?.let(::JsonPrimitive) ?: JsonNull)
    })
    fun inclusion(sequence: String = "7") = json("""{"sequence":"$sequence","day":"20726","root":"${"a".repeat(64)}","sourceHash":"${"b".repeat(64)}","publicationSignature":"${"3".repeat(88)}","publicationSlot":123,"genesisHash":"$WALLET","programId":"$WALLET","configAddress":"$WALLET","keepMint":"$WALLET","reserveOwner":"$WALLET","totalCumulativeBaseUnits":"10000000000","leaf":{"wallet":"$WALLET","sequence":"$sequence","cumulativeKeepBaseUnits":"7000000000","cumulativeRenown":"2","cumulativeDays":"3"},"proof":[{"hash":"${"c".repeat(64)}","sumBaseUnits":"3000000000","isLeft":false}]}""")
    fun inclusions(rows: List<JsonObject> = listOf(inclusion()), next: String? = null) = envelope(buildJsonObject {
        put("rows", JsonArray(rows)); put("nextCursor", next?.let(::JsonPrimitive) ?: JsonNull)
    })
    fun current(attested: Boolean = true) = envelope(json("""{"observedSlot":123,"chainUnixTimestamp":"1790769600","publicationSequence":"7","published":{"cumulativeRenown":"2","cumulativeDays":"3"},"attested":${if (attested) """{"renownTotal":"1","daysAttested":"2","lastSequence":"6"}""" else "null"}}"""))
    fun unavailable(reason: String = "SOURCE_UNAVAILABLE") = envelope(JsonNull, reason)
    fun changed(value: JsonObject, key: String, replacement: JsonElement) = JsonObject(value + (key to replacement))
    fun dataChanged(value: JsonObject, key: String, replacement: JsonElement) = changed(value, "data", changed(value.getValue("data").jsonObject, key, replacement))
}

class RealmPassportRepositoryTest {
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val repo = RealmPassportRepository(session, holder, api)
        init {
            api.onGet("/realm-passport/expeditions") { PassportTestWire.expeditions(it.getValue("kind")) }
            api.onGet("/realm-passport/mining/inclusions") { PassportTestWire.inclusions() }
            api.onGet("/realm-passport/mining/current") { PassportTestWire.current() }
        }
    }
    private fun refuses(block: () -> Unit) { try { block(); fail("Unverified Passport data must be refused") } catch (_: IllegalArgumentException) {} catch (_: IllegalStateException) {} }
    @Test fun `history reads only authenticated account routes with no wallet or deed selector and no mutations`() = runBlocking {
        val f = Fixture(); f.repo.expeditions("starter"); f.repo.inclusions(); f.repo.current()
        assertEquals(listOf(mapOf("kind" to "starter"), emptyMap(), emptyMap()), f.api.gets.map { it.second })
        assertEquals(BASE_ID, f.repo.state.value.expeditions.observation!!.data!!.rows.single().originalBaseId)
        assertTrue(f.api.posts.isEmpty() && f.api.puts.isEmpty() && f.api.deletes.isEmpty() && f.api.patches.isEmpty())
    }
    @Test fun `next page uses server cursor exclusively and refresh returns to first page without accumulating invented totals`() = runBlocking {
        val f = Fixture()
        f.api.onGet("/realm-passport/expeditions") { query -> if (query["cursor"] == null) PassportTestWire.expeditions(rows = PassportTestWire.fullExpeditions(), next = PassportTestWire.pageLast)
            else PassportTestWire.expeditions(rows = listOf(PassportTestWire.expedition(PassportTestWire.afterPage))) }
        f.repo.expeditions("starter"); f.repo.expeditions("starter", next = true)
        assertEquals(PassportTestWire.pageLast, f.api.gets.last().second["cursor"])
        assertEquals(listOf(PassportTestWire.afterPage), f.repo.state.value.expeditions.observation!!.data!!.rows.map { it.expeditionId })
        f.repo.expeditions("starter"); assertFalse(f.api.gets.last().second.containsKey("cursor"))
    }
    @Test fun `inclusion paging keeps decimal precision and carried leaf cumulative totals unchanged`() = runBlocking {
        val f = Fixture()
        f.api.onGet("/realm-passport/mining/inclusions") { query -> if (query["cursor"] == null) PassportTestWire.inclusions(PassportTestWire.fullInclusions("9007199254740974"), "9007199254740993")
            else PassportTestWire.inclusions(listOf(PassportTestWire.inclusion("9007199254740994"))) }
        f.repo.inclusions(); val prior = f.repo.state.value.inclusions.observation!!.data!!.rows.last().leaf
        f.repo.inclusions(next = true)
        assertEquals("9007199254740993", f.api.gets.last().second["cursor"])
        val next = f.repo.state.value.inclusions.observation!!.data!!.rows.single().leaf
        assertEquals(prior.cumulativeDays, next.cumulativeDays); assertEquals(prior.cumulativeRenown, next.cumulativeRenown)
    }
    @Test fun `empty history is available while missing attestation stays null and published totals remain separate`() = runBlocking {
        val f = Fixture(); f.api.onGet("/realm-passport/expeditions") { PassportTestWire.expeditions(rows = emptyList()) }
        f.api.onGet("/realm-passport/mining/current") { PassportTestWire.current(false) }
        f.repo.expeditions("starter"); f.repo.current()
        assertTrue(f.repo.state.value.expeditions.observation!!.data!!.rows.isEmpty())
        val current = f.repo.state.value.current.observation!!.data!!
        assertNull(current.attested); assertEquals("2", current.published.cumulativeRenown)
    }
    @Test fun `current outage removes old current facts without deleting immutable history`() = runBlocking {
        val f = Fixture(); f.repo.inclusions(); f.repo.current()
        val history = f.repo.state.value.inclusions
        f.api.onGet("/realm-passport/mining/current") { throw java.io.IOException("offline") }
        f.repo.current()
        assertEquals(history, f.repo.state.value.inclusions); assertNull(f.repo.state.value.current.observation); assertNotNull(f.repo.state.value.current.error)
    }
    @Test fun `configured unavailable never becomes an empty history or zero participation`() = runBlocking {
        val f = Fixture(); f.api.onGet("/realm-passport/mining/current") { PassportTestWire.unavailable("NOT_CONFIGURED") }
        f.repo.current(); assertNull(f.repo.state.value.current.observation!!.data)
        assertEquals("NOT_CONFIGURED", f.repo.state.value.current.observation!!.unavailableReason)
    }
    @Test fun `foreign account envelopes and leaves are refused before publishing`() = runBlocking {
        val f = Fixture(); f.api.onGet("/realm-passport/expeditions") { PassportTestWire.changed(PassportTestWire.expeditions(), "wallet", JsonPrimitive("foreign")) }
        f.repo.expeditions("starter"); assertNull(f.repo.state.value.expeditions.observation); assertNotNull(f.repo.state.value.expeditions.error)
        val row = PassportTestWire.inclusion()
        val foreign = PassportTestWire.changed(row, "leaf", PassportTestWire.changed(row.getValue("leaf").jsonObject, "wallet", JsonPrimitive("foreign")))
        refuses { RealmPassportWire.inclusions(PassportTestWire.inclusions(listOf(foreign)), WALLET, null) }
    }
    @Test fun `stale screen replies cannot publish after close even if transport finishes normally`() = runBlocking {
        val f = Fixture(); f.api.onGet("/realm-passport/mining/current") { f.repo.dismiss(); PassportTestWire.current() }
        try { f.repo.current(); fail("Closed screen must cancel") } catch (_: CancellationException) {}
        assertNull(f.repo.state.value.current.observation); assertFalse(f.repo.state.value.current.busy)
    }
    @Test fun `session replacement refuses old response and cannot send another request`() = runBlocking {
        val f = Fixture(); f.api.onGet("/realm-passport/mining/current") { signedIn(f.holder); PassportTestWire.current() }
        try { f.repo.current(); fail("Old session must cancel") } catch (_: CancellationException) {}
        assertNull(f.repo.state.value.current.observation)
        try { f.repo.inclusions(); fail("Old session must cancel") } catch (_: CancellationException) {}
        assertEquals(1, f.api.gets.size)
    }
    @Test fun `cancelled in flight request releases loading and cannot update state`() = runBlocking {
        val f = Fixture(); val started = CompletableDeferred<Unit>()
        f.api.onGet("/realm-passport/mining/current") { started.complete(Unit); awaitCancellation() }
        val job = launch { f.repo.current() }; started.await(); job.cancelAndJoin()
        assertFalse(f.repo.state.value.current.busy); assertNull(f.repo.state.value.current.observation)
    }
    @Test fun `duplicate tap admits one request and absent next cursor sends nothing`() = runBlocking {
        val f = Fixture(); val start = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
        f.api.onGet("/realm-passport/mining/current") { start.complete(Unit); finish.await(); PassportTestWire.current() }
        val job = launch { f.repo.current() }; start.await(); f.repo.current(); finish.complete(Unit); job.join()
        f.repo.inclusions(next = true); assertEquals(1, f.api.gets.size)
    }
    @Test fun `malformed history fails whole page without silently dropping rows`() {
        val source = PassportTestWire.expedition()
        listOf(PassportTestWire.changed(source, "kind", JsonPrimitive("advanced")),
            PassportTestWire.changed(source, "policyVersion", JsonPrimitive(0)),
            PassportTestWire.changed(source, "returnedAt", JsonPrimitive("2026-09-28T09:00:00Z")),
            PassportTestWire.changed(source, "newReward", JsonPrimitive(20))).forEach { row ->
            refuses { RealmPassportWire.expeditions(PassportTestWire.expeditions(rows = listOf(row)), WALLET, "starter", null) }
        }
        refuses { RealmPassportWire.expeditions(PassportTestWire.expeditions(rows = listOf(source, source)), WALLET, "starter", null) }
        refuses { RealmPassportWire.expeditions(PassportTestWire.expeditions(next = PassportTestWire.second), WALLET, "starter", null) }
    }
    @Test fun `unavailable envelopes carrying data or authority changes are rejected`() {
        refuses { RealmPassportWire.current(PassportTestWire.changed(PassportTestWire.current(), "projection", JsonPrimitive("eligible")), WALLET) }
        refuses { RealmPassportWire.current(PassportTestWire.changed(PassportTestWire.unavailable(), "data", PassportTestWire.current().getValue("data")), WALLET) }
        refuses { RealmPassportWire.current(PassportTestWire.changed(PassportTestWire.current(), "preparationAllowed", JsonPrimitive(true)), WALLET) }
    }
    @Test fun `bad inclusion bindings decimal spelling and proof data are refused`() {
        val original = PassportTestWire.inclusion()
        listOf(PassportTestWire.changed(original, "sequence", JsonPrimitive("8")),
            PassportTestWire.changed(original, "day", JsonPrimitive("020726")),
            PassportTestWire.changed(original, "publicationSlot", JsonPrimitive(9_007_199_254_740_992L)),
            PassportTestWire.changed(original, "proof", JsonArray(listOf(json("""{"hash":"bad","sumBaseUnits":"0","isLeft":true}"""))))).forEach { row ->
            refuses { RealmPassportWire.inclusions(PassportTestWire.inclusions(listOf(row)), WALLET, null) }
        }
    }
    @Test fun `wrong next cursor and backwards sequence cannot repeat an inclusion`() {
        refuses { RealmPassportWire.inclusions(PassportTestWire.inclusions(next = "8"), WALLET, null) }
        refuses { RealmPassportWire.inclusions(PassportTestWire.inclusions(), WALLET, "7") }
        refuses { RealmPassportWire.inclusions(PassportTestWire.inclusions(listOf(PassportTestWire.inclusion("8"), PassportTestWire.inclusion("7"))), WALLET, null) }
    }
    @Test fun `failed next page retains its last verified page and retry reuses same cursor`() = runBlocking {
        val f = Fixture(); f.api.onGet("/realm-passport/mining/inclusions") { query -> if (query["cursor"] == null) PassportTestWire.inclusions(PassportTestWire.fullInclusions(), next = "20") else throw java.io.IOException("offline") }
        f.repo.inclusions(); f.repo.inclusions(next = true); f.repo.inclusions(next = true)
        assertEquals("20", f.repo.state.value.inclusions.observation!!.data!!.rows.last().sequence)
        assertNotNull(f.repo.state.value.inclusions.error); assertEquals(listOf(null, "20", "20"), f.api.gets.map { it.second["cursor"] })
    }
    @Test fun `original route versions stay nullable by trip kind instead of inventing a second version`() {
        val starter = RealmPassportWire.expeditions(PassportTestWire.expeditions(), WALLET, "starter", null).data!!.rows.single()
        val advanced = RealmPassportWire.expeditions(PassportTestWire.expeditions("advanced"), WALLET, "advanced", null).data!!.rows.single()
        assertEquals(1, starter.routeVersion); assertNull(starter.policyVersion)
        assertNull(advanced.routeVersion); assertEquals(2, advanced.policyVersion)
        val forged = PassportTestWire.changed(PassportTestWire.expedition(), "policyVersion", JsonPrimitive(1))
        refuses { RealmPassportWire.expeditions(PassportTestWire.expeditions(rows = listOf(forged)), WALLET, "starter", null) }
        val missing = PassportTestWire.changed(PassportTestWire.expedition("00000000-0000-4000-8000-000000000001", "advanced"), "policyVersion", JsonNull)
        refuses { RealmPassportWire.expeditions(PassportTestWire.expeditions("advanced", listOf(missing)), WALLET, "advanced", null) }
    }
    @Test fun `transport page and proof bounds refuse oversized pages and partial next cursors`() {
        refuses { RealmPassportWire.expeditions(PassportTestWire.expeditions(rows = (1..21).map { PassportTestWire.expedition(PassportTestWire.expeditionId(it)) }), WALLET, "starter", null) }
        refuses { RealmPassportWire.inclusions(PassportTestWire.inclusions(next = "7"), WALLET, null) }
        val row = PassportTestWire.inclusion(); val proof = row.getValue("proof").jsonArray.single()
        refuses { RealmPassportWire.inclusions(PassportTestWire.inclusions(listOf(PassportTestWire.changed(row, "proof", JsonArray(List(17) { proof })))), WALLET, null) }
    }
    @Test fun `visited realms route grammar canonical time and nonzero trip duration follow shared source contract`() {
        val row = PassportTestWire.expedition()
        listOf("realmId" to "unknown-realm", "routeId" to "Route with spaces", "returnedAt" to "2026-09-30T10:00:00Z", "scheduledReturnAt" to "2026-09-28T10:00:00.000Z").forEach { (field, value) ->
            refuses { RealmPassportWire.expeditions(PassportTestWire.expeditions(rows = listOf(PassportTestWire.changed(row, field, JsonPrimitive(value)))), WALLET, "starter", null) }
        }
    }
    @Test fun `one inclusion page cannot combine different configured source identities`() {
        val other = PassportTestWire.changed(PassportTestWire.inclusion("8"), "programId", JsonPrimitive("11111111111111111111111111111111"))
        refuses { RealmPassportWire.inclusions(PassportTestWire.inclusions(listOf(PassportTestWire.inclusion(), other)), WALLET, null) }
        refuses { RealmPassportWire.inclusions(PassportTestWire.inclusions(listOf(PassportTestWire.changed(PassportTestWire.inclusion(), "day", JsonPrimitive("0")))), WALLET, null) }
    }
    @Test fun `attested facts cannot exceed current published cumulative facts`() {
        val row = PassportTestWire.current()
        val attested = row.getValue("data").jsonObject.getValue("attested").jsonObject
        listOf("renownTotal" to "3", "daysAttested" to "4", "lastSequence" to "8").forEach { (field, value) ->
            refuses { RealmPassportWire.current(PassportTestWire.dataChanged(row, "attested", PassportTestWire.changed(attested, field, JsonPrimitive(value))), WALLET) }
        }
    }

    @Test fun `changed mining identity between pages preserves prior history and requires refresh from start`() = runBlocking {
        for (field in listOf("genesisHash", "programId", "configAddress")) {
            val f = Fixture()
            f.api.onGet("/realm-passport/mining/inclusions") { query ->
                if (query["cursor"] == null) PassportTestWire.inclusions(PassportTestWire.fullInclusions(), "20")
                else PassportTestWire.inclusions(listOf(PassportTestWire.changed(PassportTestWire.inclusion("21"), field, JsonPrimitive("11111111111111111111111111111111"))))
            }
            f.repo.inclusions(); val original = f.repo.state.value.inclusions.observation
            f.repo.inclusions(next = true)
            assertEquals(original, f.repo.state.value.inclusions.observation)
            assertTrue(f.repo.state.value.inclusions.error!!.contains("from the start"))
            f.repo.inclusions(); assertFalse(f.api.gets.last().second.containsKey("cursor")); assertNull(f.repo.state.value.inclusions.error)
        }
    }

    @Test fun `quoted numeric slots and original versions cannot bypass the shared JSON grammar`() {
        refuses { RealmPassportWire.current(PassportTestWire.dataChanged(PassportTestWire.current(), "observedSlot", JsonPrimitive("123")), WALLET) }
        val inclusion = PassportTestWire.changed(PassportTestWire.inclusion(), "publicationSlot", JsonPrimitive("123"))
        refuses { RealmPassportWire.inclusions(PassportTestWire.inclusions(listOf(inclusion)), WALLET, null) }
        for ((kind, version) in listOf("starter" to "routeVersion", "advanced" to "policyVersion")) {
            val row = PassportTestWire.changed(PassportTestWire.expedition(kind = kind), version, JsonPrimitive("1"))
            refuses { RealmPassportWire.expeditions(PassportTestWire.expeditions(kind, listOf(row)), WALLET, kind, null) }
        }
    }
    @Test fun `quoted proof Boolean is refused without changing valid Boolean proof direction`() {
        val row = PassportTestWire.inclusion(); val node = row.getValue("proof").jsonArray.single().jsonObject
        assertFalse(RealmPassportWire.inclusions(PassportTestWire.inclusions(), WALLET, null).data!!.rows.single().proof.single().isLeft)
        for (invalid in listOf(JsonPrimitive("false"), JsonPrimitive("true"), JsonPrimitive(0), JsonNull)) {
            val changed = PassportTestWire.changed(row, "proof", JsonArray(listOf(PassportTestWire.changed(node, "isLeft", invalid))))
            refuses { RealmPassportWire.inclusions(PassportTestWire.inclusions(listOf(changed)), WALLET, null) }
        }
    }
    @Test fun `unquoted decimal amounts cannot be silently converted to display strings`() {
        val current = PassportTestWire.current()
        for (field in listOf("chainUnixTimestamp", "publicationSequence")) {
            refuses { RealmPassportWire.current(PassportTestWire.dataChanged(current, field, JsonPrimitive(7)), WALLET) }
        }
        for (section in listOf("published", "attested")) {
            val values = current.getValue("data").jsonObject.getValue(section).jsonObject
            for (field in values.keys) refuses { RealmPassportWire.current(PassportTestWire.dataChanged(current, section, PassportTestWire.changed(values, field, JsonPrimitive(1))), WALLET) }
        }
        val row = PassportTestWire.inclusion()
        for (field in listOf("sequence", "day", "totalCumulativeBaseUnits")) {
            refuses { RealmPassportWire.inclusions(PassportTestWire.inclusions(listOf(PassportTestWire.changed(row, field, JsonPrimitive(7)))), WALLET, null) }
        }
        val leaf = row.getValue("leaf").jsonObject
        for (field in listOf("sequence", "cumulativeKeepBaseUnits", "cumulativeRenown", "cumulativeDays")) {
            val invalid = PassportTestWire.changed(row, "leaf", PassportTestWire.changed(leaf, field, JsonPrimitive(1)))
            refuses { RealmPassportWire.inclusions(PassportTestWire.inclusions(listOf(invalid)), WALLET, null) }
        }
    }

    @Test fun `disabled provider hides discovery while configured unavailable source stays discoverable without caching rows`() = runBlocking {
        val f = Fixture()
        f.api.onGet("/realm-passport/expeditions") { throw gg.pixelkingdomwars.nativeclient.network.ApiException(503, "NOT_CONFIGURED", "disabled") }
        f.repo.discover(); assertFalse(f.repo.state.value.discoverable)
        f.api.onGet("/realm-passport/expeditions") { PassportTestWire.unavailable() }
        f.repo.discover(); assertTrue(f.repo.state.value.discoverable)
        assertNull(f.repo.state.value.expeditions.observation)
        assertNull(f.repo.state.value.inclusions.observation); assertNull(f.repo.state.value.current.observation)
    }
    @Test fun `bounded discovery avoids repeated probes until background clears it and fences late replies`() = runBlocking {
        val f = Fixture(); f.repo.discover(); f.repo.discover(); assertEquals(1, f.api.gets.size)
        f.repo.dismiss(); assertFalse(f.repo.state.value.discoverable)
        f.api.onGet("/realm-passport/expeditions") { f.repo.dismiss(); PassportTestWire.expeditions() }
        try { f.repo.discover(); fail("Closed discovery must cancel") } catch (_: CancellationException) {}
        assertFalse(f.repo.state.value.discoverable); assertNull(f.repo.state.value.expeditions.observation)
    }
    @Test fun `closing clears every private observation while preserving only session discovery`() = runBlocking {
        val f = Fixture(); f.repo.discover(); f.repo.expeditions("starter"); f.repo.inclusions(); f.repo.current()
        f.repo.dismiss(clearDiscovery = false)
        assertEquals(RealmPassportState(discoverable = true), f.repo.state.value)
        f.repo.dismiss(); assertEquals(RealmPassportState(), f.repo.state.value)
    }
    @Test fun `foreign or malformed discovery cannot expose the Passport entry`() = runBlocking {
        val f = Fixture()
        f.api.onGet("/realm-passport/expeditions") { PassportTestWire.changed(PassportTestWire.expeditions(), "wallet", JsonPrimitive("foreign")) }
        f.repo.discover(); assertFalse(f.repo.state.value.discoverable)
        f.api.onGet("/realm-passport/expeditions") { PassportTestWire.changed(PassportTestWire.expeditions(), "preparationAllowed", JsonPrimitive(true)) }
        f.repo.discover(); assertFalse(f.repo.state.value.discoverable)
    }

}
