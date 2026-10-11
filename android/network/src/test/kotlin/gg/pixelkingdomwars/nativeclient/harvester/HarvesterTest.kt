package gg.pixelkingdomwars.nativeclient.harvester

import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionHome
import gg.pixelkingdomwars.nativeclient.starter.starterResourceRealms
import java.io.IOException
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic server terms deliberately differ from gameplay tuning. This suite
 * validates protocol and durable consent; it establishes no earning or chain authority. */
class HarvesterTest {
    private val identity = HarvesterIdentity("https://game.test", "devnet", "11111111111111111111111111111111")
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val at = "2026-09-22T12:00:00.000Z"
    private val format = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
    private fun after(seconds: Long) = format.format(Instant.parse(at).plusSeconds(seconds))
    private val policy = HarvesterPolicy(1, 1, "99", "7", 17, 255, 1, 100, 30)
    private val facility = HarvesterFacility(id(1), id(3), id(4), after(-1))
    private fun view() = HarvesterView(identity.wallet, id(1), at, HarvesterFeatures(HarvesterFeature(1, 1)), true,
        StarterExpeditionHome("free_policy_preview", 1, "crownlands"), listOf(facility), null, null, policy,
        starterResourceRealms.keys.map { OrdinaryRawStock(it, "9", "1", "10") })
    private fun command() = HarvesterCommand.review(identity, view(), id(2), facility.harvesterId)
    private fun source() = HarvesterSource(id(2), id(1), id(3), policy.policyVersion, "crownlands", "crown_iron_ore",
        at, after(policy.maxLeaseSec), id(4), facility.harvesterCompletedAt,
        HarvesterTerm(id(6), "ab".repeat(32), after(-60), after(3_600)), policy)
    private fun event(ordinal: Int, gross: String = "0", net: String = "0", pool: String = "0", before: String = "0", carry: String = "0") =
        HarvesterEvent(id(2), ordinal, ordinal.toString(), "crown_iron_ore", policy.policyVersion,
            after(ordinal * policy.cadenceSec), after(ordinal * policy.cadenceSec + 1), "2026-09-22T00:00:00.000Z",
            gross, net, pool, policy.taxPolicyVersion, policy.taxBasisPoints, policy.islandPoolBps, before, carry)
    // Supplied server allocations, including the original fractional carry; no client reward generator.
    private fun firstEvent() = event(1, "7", "5", "2", "0", "10")
    private fun secondEvent() = event(2, "7", "5", "2", "10", "20")
    private fun settlement(events: List<HarvesterEvent> = emptyList()) = HarvesterSettlement(events, null, null)
    private fun proof(accepted: Boolean = false, observed: HarvesterSettlement = settlement()) = HarvesterProof(identity.wallet, id(2),
        after(policy.maxLeaseSec + 30), if (accepted) "accepted" else "unknown",
        if (accepted) HarvesterReceipt(identity.wallet, command().request, source()) else null, if (accepted) observed else null)
    private fun closed(): HarvesterSettlement {
        val cutoff = after(policy.cadenceSec * 2 + 1)
        return HarvesterSettlement(listOf(firstEvent(), secondEvent()), HarvesterClosure(id(2), "custody_change", cutoff, 2),
            HarvesterCustodyStop(id(2), cutoff, after(policy.cadenceSec * 2), "cd".repeat(32)))
    }
    private inline fun <reified T> raw(value: T) = harvesterJson.encodeToJsonElement(value).jsonObject
    private fun rejects(action: () -> Unit) { assertTrue(runCatching(action).isFailure) }
    private class Memory : SecretStore {
        var bytes: String? = null; var fail = false
        override fun read() = bytes
        override fun write(value: String) { if (fail) throw IOException("disk full"); bytes = value }
        override fun clear() { error("Original bytes must survive") }
    }
    private inner class Port : HarvesterPort {
        var gets = 0; var posts = 0; var current = proof(); var beforePost: () -> Unit = {}
        var getAnswer: ((JsonObject) -> Unit) -> JsonObject = { retain -> raw(current).also(retain) }
        var answer: ((JsonObject) -> Unit, (ApiException) -> Unit) -> JsonObject = { retain, _ -> raw(proof(true)).also(retain) }
        override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
            guard(); assertEquals(command().receiptPath, path); gets++; return getAnswer(retain)
        }
        override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
            beforePost(); guard(); assertEquals("/harvesters/sources", path); assertEquals(command().request.body(), body); posts++; return answer(retain, refusal)
        }
    }

    @Test fun `strict current JSON requires complete scalar and raw inventory shape`() {
        HarvesterView.from(raw(view()))
        rejects { HarvesterView.from(JsonObject(raw(view()) + ("acceptingSelections" to JsonPrimitive("true")))) }
        rejects { HarvesterView.from(JsonObject(raw(view()) - "features")) }
        rejects { HarvesterView.from(JsonObject(raw(view()) + ("owner" to JsonPrimitive(identity.wallet)))) }
        val badPolicy = JsonObject(raw(policy) + ("cadenceSec" to JsonPrimitive("17")))
        rejects { HarvesterView.from(JsonObject(raw(view()) + ("policy" to badPolicy))) }
        rejects { view().copy(rawStock = view().rawStock.dropLast(1)).validate() }
        rejects { view().copy(rawStock = view().rawStock.map { it.copy(total = "9") }).validate() }
        rejects { view().copy(facilities = listOf(facility, facility)).validate() }
        rejects { view().copy(facilities = listOf(facility.copy(harvesterCompletedAt = after(1)))).validate() }
    }
    @Test fun `request persists explicit nullable expected head and rejects malformed ids and scalar replacements`() {
        assertEquals(JsonNull, command().request.body()["expectedSourceId"])
        rejects { command().copy(request = command().request.copy(expectedSourceId = command().key)).validate() }
        rejects { command().copy(request = command().request.copy(baseId = "ABCDEF00-0000-4000-8000-000000000003")).validate() }
        rejects { command().copy(request = command().request.copy(policyVersion = 0)).validate() }
        val memory = Memory(); val store = HarvesterStore(memory, identity); store.begin(store.read(), command())
        val journal = harvesterJson.parseToJsonElement(memory.bytes!!).jsonObject
        val operation = journal.getValue("operation").jsonObject; val savedCommand = operation.getValue("command").jsonObject
        for (change in listOf(JsonObject(raw(command().request) - "expectedSourceId"),
            JsonObject(raw(command().request) + ("expectedSourceId" to JsonPrimitive(1))),
            JsonObject(raw(command().request) + ("policyVersion" to JsonPrimitive("1"))))) {
            memory.bytes = JsonObject(journal + ("operation" to JsonObject(operation + ("command" to JsonObject(savedCommand + ("request" to change)))))).toString()
            val before = memory.bytes; rejects { store.read() }; assertEquals(before, memory.bytes)
        }
    }
    @Test fun `current review binds completed facility whole policy realm wallet and selected head`() {
        val c = command()
        val otherHead = source().summary().copy(sourceId = id(8), baseId = id(9), admittedAt = after(-100), leaseExpiresAt = after(-1))
        for (changed in listOf(view().copy(acceptingSelections = false), view().copy(home = null), view().copy(facilities = emptyList()),
            view().copy(facilities = listOf(facility.copy(completedBuildJobId = id(10)))),
            view().copy(policy = policy.copy(grossPerWalletUtcDay = "100")), view().copy(walletSource = otherHead))) rejects { c.admit(identity, changed) }
        rejects { c.admit(identity.copy(wallet = "11111111111111111111111111111112"), view()) }
        val retained = view().copy(walletSource = otherHead); retained.validate()
        val renewal = HarvesterCommand.review(identity, retained, id(11), facility.harvesterId)
        assertEquals(otherHead.sourceId, renewal.request.expectedSourceId) // Expired is still a selected original head.
        assertEquals(otherHead, renewal.replacedSource)
        rejects { renewal.admit(identity, retained.copy(walletSource = null)) }
        rejects { renewal.admit(identity, retained.copy(walletSource = otherHead.copy(harvesterId = id(12)))) }
    }
    @Test fun `current selected base source must be exactly the wallet head for that base`() {
        val head = source().summary().copy(sourceId = id(8), admittedAt = after(-100), leaseExpiresAt = after(-1))
        view().copy(source = head, walletSource = head).validate()
        rejects { view().copy(source = null, walletSource = head).validate() }
        rejects { view().copy(source = head, walletSource = head.copy(baseId = id(9))).validate() }
        view().copy(source = null, walletSource = head.copy(baseId = id(9))).validate()
    }
    @Test fun `original proof binds actor key facility policy term and exact interval without current custody`() {
        HarvesterProof.from(raw(proof(true)), identity, command())
        val original = proof(true).originalReceipt!!
        for (changed in listOf(original.copy(request = command().request.copy(expectedSourceId = id(7))),
            original.copy(source = source().copy(completedBuildJobId = id(7))), original.copy(source = source().copy(leaseExpiresAt = after(policy.maxLeaseSec - 1))),
            original.copy(source = source().copy(resourceId = "heartwood_logs")), original.copy(source = source().copy(harvesterCompletedAt = after(1))),
            original.copy(source = source().copy(term = source().term.copy(startsAt = after(1))))))
            rejects { proof(true).copy(originalReceipt = changed).validate(identity, command()) }
        rejects { proof(true).copy(wallet = "11111111111111111111111111111112").validate(identity, command()) }
        rejects { proof(true).copy(idempotencyKey = id(9)).validate(identity, command()) }
        rejects { proof().copy(settlement = settlement()).validate(identity, command()) }
        rejects { proof(true).copy(settlement = null).validate(identity, command()) }
        val leaked = JsonObject(raw(original) + ("custodyWallet" to JsonPrimitive(identity.wallet)))
        rejects { HarvesterProof.from(JsonObject(raw(proof(true)) + ("originalReceipt" to leaked)), identity, command()) }
    }
    @Test fun `quantities retain int64 precision and strict JSON string representation`() {
        policy.copy(grossPerWalletUtcDay = Long.MAX_VALUE.toString()).validate()
        for (bad in listOf("01", "-1", "1.0", "1e2", "9223372036854775808")) rejects { policy.copy(grossPerWalletUtcDay = bad).validate() }
        rejects { policy.copy(cadenceSec = Long.MAX_VALUE).validate() }
        val bad = JsonObject(raw(firstEvent()) + ("grossQuantity" to JsonPrimitive(7)))
        val observation = JsonObject(raw(settlement(listOf(firstEvent()))) + ("events" to JsonArray(listOf(bad))))
        rejects { HarvesterProof.from(JsonObject(raw(proof(true)) + ("settlement" to observation)), identity, command()) }
    }
    @Test fun `events require original cadence conservation carry frontier UTC day and server settlement time`() {
        val first = firstEvent(); val second = secondEvent(); proof(true, settlement(listOf(first, second))).validate(identity, command())
        for (bad in listOf(first.copy(netQuantity = "6"), first.copy(carryAfter = "11"), first.copy(earnedAt = after(18)),
            first.copy(utcDay = at), first.copy(settledAt = after(16)), first.copy(sourceId = id(9)),
            first.copy(resourceId = "heartwood_logs"), first.copy(taxBasisPoints = 101), first.copy(walletSequence = "0")))
            rejects { proof(true, settlement(listOf(bad))).validate(identity, command()) }
        rejects { proof(true, settlement(listOf(second))).validate(identity, command()) }
        rejects { proof(true, settlement(listOf(first, second.copy(walletSequence = first.walletSequence)))).validate(identity, command()) }
        rejects { proof(true, settlement(listOf(first, second.copy(carryBefore = "20", carryAfter = "30")))).validate(identity, command()) }
        rejects { proof(true, settlement(listOf(first))).copy(serverNow = first.earnedAt).validate(identity, command()) }
    }
    @Test fun `bounded zero earning events still advance the original complete frontier without inventing stock`() {
        val complete = List((policy.maxLeaseSec / policy.cadenceSec).toInt()) { event(it + 1) }
        val closed = HarvesterSettlement(complete, HarvesterClosure(id(2), "lease_expired", after(policy.maxLeaseSec), complete.size), null)
        proof(true, closed).validate(identity, command())
        rejects { proof(true, settlement(complete + event(complete.size + 1))).validate(identity, command()) }
        rejects { proof(true, closed.copy(events = complete.dropLast(1))).validate(identity, command()) }
        assertTrue(view().rawStock.all { it.available == "9" }) // Historical gross is never a current balance.
    }
    @Test fun `closure and custody stop require exact source cutoff and all earned units`() {
        proof(true, closed()).validate(identity, command())
        val observation = closed(); val closure = observation.closure!!; val stop = observation.custodyStop!!
        for (bad in listOf(observation.copy(closure = closure.copy(processedOrdinal = 1)), observation.copy(closure = closure.copy(reason = "lease_expired")),
            observation.copy(closure = closure.copy(sourceId = id(8))), observation.copy(closure = closure.copy(cutoffAt = after(51))),
            observation.copy(custodyStop = stop.copy(checkedAt = after(36))), observation.copy(custodyStop = stop.copy(auditHash = "invalid")),
            observation.copy(custodyStop = stop.copy(cutoffAt = firstEvent().earnedAt))))
            rejects { proof(true, bad).validate(identity, command()) }
        val zero = HarvesterSettlement(emptyList(), HarvesterClosure(id(2), "replacement", after(1), 0), null)
        proof(true, zero).validate(identity, command())
    }
    @Test fun `durable intent precedes every request and foreground recovery is GET only`() = runBlocking {
        val memory = Memory(); val store = HarvesterStore(memory, identity); val port = Port(); val transport = HarvesterTransport(store, port)
        val saved = transport.begin(command(), view()) {}; assertNotNull(memory.bytes); assertEquals(0, port.gets); assertEquals(0, port.posts)
        transport.check {}; transport.check {}; assertEquals(saved, store.read()); assertEquals(2, port.gets); assertEquals(0, port.posts)
        transport.confirm(saved, ::view) {}; assertEquals(1, port.posts); assertNotNull(store.read().operation!!.proof)
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }; assertEquals(1, port.posts)
    }
    @Test fun `accepted original is recovered before paused or unavailable current admission`() = runBlocking {
        val store = HarvesterStore(Memory(), identity); val port = Port(); val transport = HarvesterTransport(store, port)
        val saved = transport.begin(command(), view()) {}; port.current = proof(true)
        transport.confirm(saved, { error("Historical acceptance cannot require current custody or flags") }) {}
        assertNotNull(store.read().operation!!.proof); assertEquals(0, port.posts)
    }
    @Test fun `observations append without changing original receipt and out of order replies preserve durable bytes`() = runBlocking {
        val memory = Memory(); val store = HarvesterStore(memory, identity); val port = Port(); val transport = HarvesterTransport(store, port)
        transport.begin(command(), view()) {}; port.current = proof(true, settlement(listOf(firstEvent()))); transport.check {}
        val receipt = store.read().operation!!.proof!!.originalReceipt
        port.current = proof(true, closed()); transport.check {}; val saved = memory.bytes
        assertEquals(receipt, store.read().operation!!.proof!!.originalReceipt)
        for (older in listOf(proof(), proof(true), proof(true, settlement(listOf(firstEvent()))),
            proof(true, closed().copy(closure = null)), proof(true, closed().copy(custodyStop = null)))) {
            port.current = older; rejects { runBlocking { transport.check {} } }; assertEquals(saved, memory.bytes)
        }
        assertEquals(0, port.posts)
    }
    @Test fun `valid changed observations cannot rewrite already retained event closure stop or original term`() = runBlocking {
        val memory = Memory(); val store = HarvesterStore(memory, identity); store.begin(store.read(), command()); store.accept(command(), proof(true, closed()))
        val saved = memory.bytes; val observation = closed()
        val changes = listOf(
            proof(true, observation.copy(events = observation.events.map { it.copy(walletSequence = (it.walletSequence.toInt() + 10).toString()) })),
            proof(true, observation.copy(closure = observation.closure!!.copy(cutoffAt = after(36)), custodyStop = observation.custodyStop!!.copy(cutoffAt = after(36)))),
            proof(true, observation.copy(custodyStop = observation.custodyStop!!.copy(auditHash = "ef".repeat(32)))),
            proof(true, observation).copy(originalReceipt = proof(true).originalReceipt!!.copy(source = source().copy(term = source().term.copy(termHash = "ef".repeat(32)))))
        )
        for (changed in changes) { changed.validate(identity, command()); rejects { store.accept(command(), changed) }; assertEquals(saved, memory.bytes) }
    }
    @Test fun `owned accepted POST callback survives cancellation and cannot be cleared by later refusal`() = runBlocking {
        val store = HarvesterStore(Memory(), identity); val port = Port(); val transport = HarvesterTransport(store, port)
        val saved = transport.begin(command(), view()) {}
        port.answer = { retain, refusal -> retain(raw(proof(true))); refusal(ApiException(503, "HARVESTERS_DISABLED", "paused")); throw CancellationException("retired account") }
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }
        assertEquals(proof(true), store.read().operation!!.proof); assertNull(store.read().operation!!.refusal)
    }
    @Test fun `owned GET observation persists before a retired caller can publish anything`() = runBlocking {
        val store = HarvesterStore(Memory(), identity); val port = Port(); val transport = HarvesterTransport(store, port)
        transport.begin(command(), view()) {}; var active = true
        port.getAnswer = { retain -> raw(proof(true, closed())).also { retain(it); active = false } }
        rejects { runBlocking { transport.check { check(active) } } }
        assertEquals(closed(), store.read().operation!!.proof!!.settlement); assertEquals(0, port.posts)
    }
    @Test fun `ambiguous first POST permits only fresh unknown and explicit retry while old refusals stay powerless`() = runBlocking {
        val store = HarvesterStore(Memory(), identity); val port = Port(); val transport = HarvesterTransport(store, port)
        val saved = transport.begin(command(), view()) {}; port.answer = { _, _ -> throw IOException("acknowledgement lost") }
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }; val first = store.read()
        transport.check {}; assertEquals(1, port.posts)
        port.answer = { _, refusal -> refusal(ApiException(409, "HARVESTER_SOURCE_CHANGED", "changed")); throw ApiException(409, "HARVESTER_SOURCE_CHANGED", "changed") }
        rejects { runBlocking { transport.confirm(first, ::view) {} } }; val second = store.read()
        assertTrue(second.operation!!.attemptRevision!! > first.operation!!.attemptRevision!!); assertNull(second.operation!!.refusal)
        store.refuse(first, HarvesterRefusal(409, "HARVESTER_SOURCE_CHANGED")); assertEquals(second, store.read())
        // Rewritten 2026-10-06 (dead-end audit): the uncertain original now closes after its fresh `unknown` receipt (owner:
        // no saved request may block play forever), but only as "unknown": the stale refusal still cannot make it declined.
        val closed = transport.archiveUnsentOrRefused(second) {}.archives.single()
        assertEquals("unknown", closed.reason); assertNull(closed.operation.refusal); assertEquals(2, port.posts)
    }
    @Test fun `first owned refusal survives cancellation and fresh positive recovery takes precedence`() = runBlocking {
        val store = HarvesterStore(Memory(), identity); val port = Port(); val transport = HarvesterTransport(store, port)
        val saved = transport.begin(command(), view()) {}
        port.answer = { _, refusal -> refusal(ApiException(409, "HARVESTER_FACILITY_UNAVAILABLE", "facility")); throw CancellationException() }
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }; assertNotNull(store.read().operation!!.refusal)
        port.current = proof(true); transport.check {}; assertNotNull(store.read().operation!!.proof)
        assertNotNull(store.read().operation!!.refusal); assertEquals(1, port.posts)
    }
    @Test fun `refused and unattempted commands archive only with fresh matching unknown proof`() = runBlocking {
        for (attempted in listOf(false, true)) {
            val store = HarvesterStore(Memory(), identity); val port = Port(); val transport = HarvesterTransport(store, port)
            val saved = transport.begin(command(), view()) {}
            if (attempted) {
                port.answer = { _, _ -> throw ApiException(503, "HARVESTERS_DISABLED", "paused") }
                rejects { runBlocking { transport.confirm(saved, ::view) {} } }
            }
            transport.archiveUnsentOrRefused(store.read()) {}; val archive = store.read().archives.single()
            assertEquals(if (attempted) "refused" else "unattempted", archive.reason); assertEquals("unknown", archive.evidence!!.status)
            assertNull(store.read().operation); rejects { store.begin(store.read(), command()) }
        }
    }
    @Test fun `accepted archive recovers append only history by GET and failed current hydration retains operation`() = runBlocking {
        val store = HarvesterStore(Memory(), identity); val port = Port(); val transport = HarvesterTransport(store, port)
        val saved = transport.begin(command(), view()) {}; transport.confirm(saved, ::view) {}; port.current = proof(true)
        rejects { runBlocking { transport.finish(store.read(), {}, { error("Current base transferred") }) } }; assertNotNull(store.read().operation)
        transport.finish(store.read(), {}, {}); assertNull(store.read().operation)
        port.current = proof(true, closed()); transport.checkArchived(command().key) {}
        assertEquals(closed(), store.read().archives.single().operation.proof!!.settlement); assertEquals(1, port.posts)
        port.current = proof(true); rejects { runBlocking { transport.checkArchived(command().key) {} } }
        assertEquals(closed(), store.read().archives.single().operation.proof!!.settlement)
    }
    @Test fun `actual enqueue repeats reviewed facility head policy and current-session checks`() = runBlocking {
        for (changed in listOf(view().copy(acceptingSelections = false), view().copy(policy = policy.copy(grossPerWalletUtcDay = "100")),
            view().copy(facilities = listOf(facility.copy(completedBuildJobId = id(9)))),
            view().copy(walletSource = source().summary().copy(sourceId = id(8), baseId = id(9))))) {
            val store = HarvesterStore(Memory(), identity); val port = Port(); val transport = HarvesterTransport(store, port)
            val saved = transport.begin(command(), view()) {}; var current = view(); port.beforePost = { current = changed }
            rejects { runBlocking { transport.confirm(saved, { current }) {} } }
            assertEquals(0, port.posts); assertNotNull(store.read().operation!!.attemptRevision); assertNull(store.read().operation!!.proof)
        }
    }
    @Test fun `session retirement at actual enqueue preserves the unsent attempted original`() = runBlocking {
        val store = HarvesterStore(Memory(), identity); val port = Port(); val transport = HarvesterTransport(store, port)
        val saved = transport.begin(command(), view()) {}; var active = true; port.beforePost = { active = false }
        rejects { runBlocking { transport.confirm(saved, ::view) { check(active) } } }
        assertEquals(0, port.posts); assertNotNull(store.read().operation!!.attemptRevision); assertNull(store.read().operation!!.refusal)
        // Rewritten 2026-10-06 (dead-end audit): an attempted original the server answers `unknown` for now closes on
        // explicit request, as "unknown" and still without a POST, instead of blocking new selections forever.
        assertEquals("unknown", transport.archiveUnsentOrRefused(store.read()) {}.archives.single().reason); assertEquals(0, port.posts)
    }
    @Test fun `wrong origin account cluster or corrupted journal cannot erase original encrypted bytes`() = runBlocking {
        val memory = Memory(); val store = HarvesterStore(memory, identity); store.begin(store.read(), command()); val original = memory.bytes
        for (other in listOf(identity.copy(origin = "https://other.test"), identity.copy(cluster = "mainnet-beta"), identity.copy(wallet = "11111111111111111111111111111112"))) {
            rejects { HarvesterStore(memory, other).read() }; assertEquals(original, memory.bytes)
        }
        for (origin in listOf("https://game.test/", "https://GAME.test", "https://game.test?key=value", "https://user:secret@game.test"))
            rejects { identity.copy(origin = origin).validate() }
        memory.bytes = "{broken"; rejects { store.read() }; assertEquals("{broken", memory.bytes)
    }
    @Test fun `failed durable intent sends nothing and failed proof persistence leaves recoverable uncertainty`() = runBlocking {
        val memory = Memory(); val store = HarvesterStore(memory, identity); val port = Port(); val transport = HarvesterTransport(store, port)
        memory.fail = true; rejects { runBlocking { transport.begin(command(), view()) {} } }; assertNull(memory.bytes)
        assertEquals(0, port.gets); assertEquals(0, port.posts)
        memory.fail = false; val saved = transport.begin(command(), view()) {}
        port.answer = { retain, _ -> memory.fail = true; raw(proof(true)).also(retain) }
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }
        memory.fail = false; assertNotNull(store.read().operation!!.attemptRevision); assertNull(store.read().operation!!.proof)
        port.current = proof(true, closed()); transport.check {}; assertEquals(closed(), store.read().operation!!.proof!!.settlement); assertEquals(1, port.posts)
    }
    @Test fun `only exact recognized first refusal pairs are definitive`() {
        assertTrue(harvesterRefusalDefinitive(409, "HARVESTER_SOURCE_CHANGED"))
        assertTrue(harvesterRefusalDefinitive(409, "HARVESTER_SETTLEMENT_PENDING"))
        assertFalse(harvesterRefusalDefinitive(500, "HARVESTER_SOURCE_CHANGED"))
        assertFalse(harvesterRefusalDefinitive(409, "IDEMPOTENCY_BODY_MISMATCH"))
        assertFalse(harvesterRefusalDefinitive(503, null))
    }
    @Test fun `draft and refused archives recover positive history by GET while preserving the newer operation`() = runBlocking {
        for (refused in listOf(false, true)) {
            val memory = Memory(); val store = HarvesterStore(memory, identity); val port = Port(); val transport = HarvesterTransport(store, port)
            transport.begin(command(), view()) {}
            val attempt = if (refused) store.attempt(store.read()) else null
            attempt?.let { store.refuse(it, HarvesterRefusal(503, "HARVESTERS_DISABLED")) }
            val original = transport.archiveUnsentOrRefused(store.read()) {}.archives.single()
            val newer = store.begin(store.read(), command().copy(request = command().request.copy(idempotencyKey = id(9)))).operation
            port.current = proof(true); transport.checkArchived(command().key) {}
            assertEquals(original.copy(operation = original.operation.copy(proof = proof(true))), store.read().archives.single())
            assertEquals(newer, store.read().operation); assertEquals(store.read(), HarvesterStore(memory, identity).read())
            port.current = proof(true, settlement(listOf(firstEvent()))); transport.checkArchived(command().key) {}
            assertEquals(listOf(firstEvent()), store.read().archives.single().operation.proof!!.settlement!!.events)
            port.current = proof(true, closed().copy(closure = null)); transport.checkArchived(command().key) {}
            assertNotNull(store.read().archives.single().operation.proof!!.settlement!!.custodyStop)
            assertNull(store.read().archives.single().operation.proof!!.settlement!!.closure)
            port.current = proof(true, closed()); transport.checkArchived(command().key) {}
            val completed = store.read()
            assertEquals(original.copy(operation = original.operation.copy(proof = proof(true, closed()))), completed.archives.single())
            attempt?.let { store.refuse(it, HarvesterRefusal(503, "HARVESTERS_DISABLED")) }
            assertEquals(completed, store.read())

            for (older in listOf(proof(), proof(true))) {
                port.current = older; rejects { runBlocking { transport.checkArchived(command().key) {} } }; assertEquals(completed, store.read())
            }
            for (changed in listOf(proof(true, closed().copy(closure = null)), proof(true, closed().copy(custodyStop = null)),
                proof(true, closed().copy(events = closed().events.map { it.copy(walletSequence = (it.walletSequence.toInt() + 10).toString()) })),
                proof(true, closed().copy(custodyStop = closed().custodyStop!!.copy(auditHash = "ef".repeat(32)))))) {
                rejects { store.accept(command(), changed) }; assertEquals(completed, store.read())
            }
            assertEquals(newer, store.read().operation); assertEquals(0, port.posts)
        }
    }
    @Test fun `accepted operations cannot initially be archived under a draft or refusal reason`() = runBlocking {
        for (refused in listOf(false, true)) {
            val memory = Memory(); val store = HarvesterStore(memory, identity); store.begin(store.read(), command())
            if (refused) store.refuse(store.attempt(store.read()), HarvesterRefusal(503, "HARVESTERS_DISABLED"))
            store.accept(command(), proof(true)); val saved = memory.bytes
            rejects { store.archive(store.read(), if (refused) "refused" else "unattempted", proof()) }
            assertEquals(saved, memory.bytes); assertNotNull(store.read().operation)
        }
    }
    @Test fun `owned archived GET proof persists before cancellation or a retired caller guard`() = runBlocking {
        for (cancel in listOf(false, true)) {
            val store = HarvesterStore(Memory(), identity); val port = Port(); val transport = HarvesterTransport(store, port)
            transport.begin(command(), view()) {}; transport.archiveUnsentOrRefused(store.read()) {}
            val original = store.read().archives.single()
            val newer = store.begin(store.read(), command().copy(request = command().request.copy(idempotencyKey = id(9)))).operation
            var active = true
            port.getAnswer = { retain -> raw(proof(true)).also { retain(it); active = false; if (cancel) throw CancellationException("owned historical response") } }
            rejects { runBlocking { transport.checkArchived(command().key) { check(active) } } }
            assertEquals(original.copy(operation = original.operation.copy(proof = proof(true))), store.read().archives.single())
            assertEquals(newer, store.read().operation); assertEquals(0, port.posts)
        }
    }
    @Test fun `negative mismatched and unpersisted archived replies cannot rewrite history`() = runBlocking {
        val memory = Memory(); val store = HarvesterStore(memory, identity); val port = Port(); val transport = HarvesterTransport(store, port)
        transport.begin(command(), view()) {}; transport.archiveUnsentOrRefused(store.read()) {}
        val original = memory.bytes; transport.checkArchived(command().key) {}; assertEquals(original, memory.bytes)
        for (bad in listOf(JsonObject(emptyMap()), raw(proof(true).copy(idempotencyKey = id(8))),
            raw(proof(true).copy(wallet = "11111111111111111111111111111112")))) {
            port.getAnswer = { retain -> bad.also(retain) }
            rejects { runBlocking { transport.checkArchived(command().key) {} } }; assertEquals(original, memory.bytes)
        }
        port.getAnswer = { retain -> raw(proof(true)).also(retain) }; memory.fail = true
        rejects { runBlocking { transport.checkArchived(command().key) {} } }; assertEquals(original, memory.bytes)
        memory.fail = false; transport.checkArchived(command().key) {}; assertNotNull(store.read().archives.single().operation.proof)
        assertEquals(0, port.posts)
    }

    @Test fun `late owned acceptance recovers its refused archive without touching a newer intent or honoring stale refusal`() = runBlocking {
        val store = HarvesterStore(Memory(), identity); val port = Port(); val transport = HarvesterTransport(store, port)
        val initial = transport.begin(command(), view()) {}
        lateinit var lateAccept: (JsonObject) -> Unit; lateinit var lateRefuse: (ApiException) -> Unit
        val error = ApiException(503, "HARVESTERS_DISABLED", "paused")
        port.answer = { retain, refusal -> lateAccept = retain; lateRefuse = refusal; refusal(error); throw CancellationException("retired caller") }
        rejects { runBlocking { transport.confirm(initial, ::view) {} } }; assertNotNull(store.read().operation!!.refusal)
        val archive = transport.archiveUnsentOrRefused(store.read()) {}.archives.single()
        val newer = store.begin(store.read(), command().copy(request = command().request.copy(idempotencyKey = id(9)))).operation
        lateAccept(raw(proof(true, closed()))); val retained = store.read(); lateRefuse(error)
        assertEquals(retained, store.read()); assertEquals(newer, retained.operation)
        assertEquals(archive.copy(operation = archive.operation.copy(proof = proof(true, closed()))), retained.archives.single())
        assertEquals(1, port.posts)
    }

}
