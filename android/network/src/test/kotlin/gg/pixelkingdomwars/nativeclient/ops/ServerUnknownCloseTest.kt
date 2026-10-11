package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.WallRowQuote
import gg.pixelkingdomwars.nativeclient.network.ApiException
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * Owner 2026-10-06 (Seeker 08:30Z): a saved construction the server had no record of blocked every BUILD, and the herald
 * promised a close it never offered. Owner review the same day set the three rules every way out must keep:
 * - a player is never charged twice: a saved key is only ever replaced by a new order once nothing can still commit it;
 * - a real charge is never hidden: CLOSE archives on this device (never deletes) and every Home resume re-reads the
 *   archive, an effect that shows the order happened is an acceptance, never "no record";
 * - no saved request blocks a door forever: after a check, once its last attempt is [SAVED_REQUEST_MIN_AGE_MS] old, a
 *   request the server answers `unknown` for stops refusing new orders (it stays shown with RETRY CHECK).
 * CLOSE itself is offered only on the server's `absent` answer for exactly that key ({version:1,status:"absent",
 * idempotencyKey}), never on `unknown` ("no matching evidence"). Nothing is ever POSTed by a close.
 */
class ServerUnknownCloseTest {
    private class Fixture {
        var now = START
        var hydrated = 0
        val store = PendingIntentStore(MemoryStore())
        val transport = ScriptedTransport()
        val op = MoneyOp(ConstructionSpec, store, transport, clock = { now })
        val observer = ReceiptObserver(store, clock = { now }).apply { register(op) { hydrated += 1 } }
        fun saved() = store.get(IntentKind.CONSTRUCTION, WALLET)
        /** A request this device sent at [now], with the dispatch time a real send records. */
        fun sent(intent: PendingIntent): PendingIntent {
            val sent = intent.copy(attempted = true, attemptRevision = 1); check(store.create(sent)); store.recordAttempt(sent, now); return sent
        }
        fun settle() { now += SAVED_REQUEST_MIN_AGE_MS }
    }

    @Test fun `a construction the server has no record of is archived by CLOSE once its last attempt is old enough`() = runBlocking {
        val f = Fixture(); val saved = f.sent(placementIntent())
        f.transport.onGet = { path, query ->
            assertEquals(ConstructionSpec.RECEIPT, path); assertEquals(saved.idempotencyKey, query["idempotencyKey"]); absent(saved.idempotencyKey)
        }
        f.observer.refresh(WALLET)
        assertTrue(f.observer.blocks(IntentKind.CONSTRUCTION))
        assertFalse("CLOSE is never offered before the server has answered for this key", f.observer.interrupted.value.single().closable)
        assertEquals(Receipt.Absent, f.observer.check(IntentKind.CONSTRUCTION, WALLET))
        // The lost POST may still be running on the server (no request timeout; its receipt commits with its effect).
        assertTrue("a fresh absent answer keeps BUILD shut", f.observer.blocks(IntentKind.CONSTRUCTION))
        assertFalse("and offers no CLOSE yet", f.observer.interrupted.value.single().closable)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.op.close(WALLET, confirmed = true) {} } }
        assertEquals("a close before the minimum age keeps it", saved, f.saved()); assertTrue(f.store.kept(WALLET).isEmpty())
        f.settle(); f.observer.refresh(WALLET)
        assertFalse("an answer read while the POST could be in flight settles nothing", f.observer.interrupted.value.single().closable)
        assertEquals(Receipt.Absent, f.observer.check(IntentKind.CONSTRUCTION, WALLET))
        val herald = f.observer.interrupted.value.single()
        assertTrue("the herald now offers CLOSE", herald.closable); assertTrue("RETRY CHECK stays offered", herald.retryable)
        assertFalse("and the request no longer blocks BUILD", herald.blocking)
        val reads = f.transport.gets.size
        assertTrue(f.observer.close(IntentKind.CONSTRUCTION, WALLET) is Receipt.Closed)
        assertNull(f.saved()); assertTrue("an archived request is hidden", f.observer.interrupted.value.isEmpty())
        assertEquals("archived on this device, never deleted", listOf(KeptIntent(saved, closed = true)), f.store.kept(WALLET))
        assertFalse(f.observer.blocks(IntentKind.CONSTRUCTION))
        assertTrue("closing never sends anything", f.transport.posts.isEmpty())
        assertEquals("the close re-reads the receipt before archiving", reads + 1, f.transport.gets.size)
        assertEquals(0, f.hydrated)
    }

    @Test fun `an unknown answer keeps the request shown and stops blocking BUILD only after the minimum age`() = runBlocking {
        val f = Fixture(); val saved = f.sent(placementIntent())
        f.transport.onGet = { _, _ -> placementUnknown() }
        assertEquals(Receipt.Unknown, f.observer.check(IntentKind.CONSTRUCTION, WALLET))
        assertTrue(f.observer.blocks(IntentKind.CONSTRUCTION)); assertFalse(f.observer.interrupted.value.single().closable)
        f.settle(); f.observer.refresh(WALLET)
        assertTrue("only a read taken after the minimum age unblocks", f.observer.blocks(IntentKind.CONSTRUCTION))
        assertEquals(Receipt.Unknown, f.observer.check(IntentKind.CONSTRUCTION, WALLET))
        val herald = f.observer.interrupted.value.single()
        assertEquals(saved, herald.intent); assertFalse("it no longer blocks BUILD", herald.blocking)
        assertFalse("unknown is no matching evidence, not absence: never CLOSE", herald.closable); assertTrue(herald.retryable)
        assertEquals("a close re-reads and keeps it", Receipt.Unknown, f.observer.close(IntentKind.CONSTRUCTION, WALLET)); assertEquals(saved, f.saved())
        // A new BUILD parks it: kept on this device, shown in the herald, never resent and never blocking.
        val next = placementIntent(placementBody(key = "second-build-key"))
        f.transport.onPost = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.op.submit(next) {} } }
        assertEquals(listOf(saved), f.store.parked(WALLET))
        f.observer.refresh(WALLET)
        val parked = f.observer.interrupted.value.single { it.kept }
        assertEquals(saved, parked.intent); assertFalse(parked.blocking); assertFalse(parked.closable); assertFalse(parked.retryable)
        assertEquals("the new order is the active one", "second-build-key", f.observer.interrupted.value.single { !it.kept }.intent.idempotencyKey)
        assertEquals("only the new key was posted", listOf("second-build-key"),
            f.transport.posts.map { it.second.getValue("idempotencyKey").jsonPrimitive.content })
    }

    @Test fun `a purchase whose reply was lost keeps its key when the retry is refused before the server looks it up`() = runBlocking {
        // Owner review 2026-10-06 (B1), the double-charge sequence. BUY commits, the reply is lost, TRY AGAIN is refused by
        // something the server checks BEFORE it looks the key up: the per-IP limiter (429), the session (401), base and
        // acquisition gates (403/404/409/422). None of them proves the original never committed. Rewritten from "an item
        // purchase stops blocking only after the server refuses its explicit retry", which let that refusal admit a new
        // purchase with a NEW key: a second debit, and the first receipt never shown.
        var now = START
        val store = PendingIntentStore(MemoryStore()); val transport = ScriptedTransport()
        val op = MoneyOp(ItemBuySpec, store, transport, clock = { now })
        val observer = ReceiptObserver(store, clock = { now }); observer.register(op) {}
        val first = ItemBuySpec.intent(WALLET, BASE, "keg_of_haste", "item-key-0001", "60", "Keg")
        transport.onPost = { _, _ -> throw IOException("committed, reply lost") }
        assertThrows(IOException::class.java) { runBlocking { op.submit(first) {} } }
        for (status in listOf(401, 403, 404, 409, 422, 429)) {
            transport.onPost = { _, _ -> throw ApiException(status, null, "refused before the key lookup") }
            assertThrows(ApiException::class.java) { runBlocking { op.retry(WALLET) {} } }
            now += SAVED_REQUEST_MIN_AGE_MS
            assertEquals(Receipt.Unsupported, observer.check(IntentKind.ITEM_BUY, WALLET))
            assertTrue("a $status refusal keeps the purchase blocking", observer.blocks(IntentKind.ITEM_BUY))
            assertFalse(store.facts(requireNotNull(store.get(IntentKind.ITEM_BUY, WALLET))).retryRefused)
        }
        val second = ItemBuySpec.intent(WALLET, BASE, "keg_of_haste", "item-key-0002", "60", "Keg")
        assertThrows(IllegalStateException::class.java) { runBlocking { op.submit(second) {} } }
        assertEquals("the original stays saved with its own key", "item-key-0001", store.get(IntentKind.ITEM_BUY, WALLET)?.idempotencyKey)
        assertEquals("no new key ever left the device", setOf("item-key-0001"),
            transport.posts.map { it.second.getValue("idempotencyKey").jsonPrimitive.content }.toSet())
        assertTrue(store.parked(WALLET).isEmpty())
    }

    @Test fun `an upgrade that committed and finished surfaces as accepted never as absent`() = runBlocking {
        // Owner review 2026-10-06 (B2), the hidden-charge sequence. A committed upgrade's job finishes lazily on GET /base and
        // leaves the building one level up with no job. Read as "no record" that would hide a real charge; read against the
        // level frozen when the order was sent, it is the acceptance and is hydrated.
        val committed = Fixture(); committed.sent(legacyUpgrade(fromLevel = 2))
        committed.transport.onGet = { path, _ -> assertEquals("/base", path); base(upgrading = false, level = 3) }
        assertTrue(committed.observer.check(IntentKind.CONSTRUCTION, WALLET) is Receipt.Accepted)
        assertEquals(1, committed.hydrated); assertNull(committed.saved()); assertTrue(committed.store.kept(WALLET).isEmpty())
        // Still running: the same acceptance.
        val running = Fixture(); running.sent(legacyUpgrade(fromLevel = 2)); running.transport.onGet = { _, _ -> base(upgrading = true) }
        assertTrue(running.observer.check(IntentKind.CONSTRUCTION, WALLET) is Receipt.Accepted); assertEquals(1, running.hydrated)
        // Still at the frozen level with no job: the order left no effect. Absent, archived by CLOSE once settled.
        val untouched = Fixture(); val unapplied = untouched.sent(legacyUpgrade(fromLevel = 2))
        untouched.transport.onGet = { _, _ -> base(upgrading = false, level = 2) }
        assertEquals(Receipt.Absent, untouched.observer.check(IntentKind.CONSTRUCTION, WALLET))
        untouched.settle(); assertTrue(untouched.observer.close(IntentKind.CONSTRUCTION, WALLET) is Receipt.Closed)
        assertEquals(listOf(KeptIntent(unapplied, closed = true)), untouched.store.kept(WALLET))
        // Sent by an older build without a frozen level: nothing tells absence from a finished upgrade. Never closed and never
        // forgotten; once checked and settled it stops blocking BUILD and stays shown.
        val unfrozen = Fixture(); val legacy = unfrozen.sent(legacyUpgrade(fromLevel = null))
        unfrozen.transport.onGet = { _, _ -> base(upgrading = false, level = 3) }
        assertEquals(Receipt.Unsupported, unfrozen.observer.check(IntentKind.CONSTRUCTION, WALLET))
        unfrozen.settle(); assertEquals(Receipt.Unsupported, unfrozen.observer.check(IntentKind.CONSTRUCTION, WALLET))
        val shown = unfrozen.observer.interrupted.value.single()
        assertEquals(legacy, shown.intent); assertFalse(shown.closable); assertFalse(shown.blocking)
        assertEquals(Receipt.Unsupported, unfrozen.observer.close(IntentKind.CONSTRUCTION, WALLET)); assertEquals(legacy, unfrozen.saved())
        for (f in listOf(committed, running, untouched, unfrozen)) assertTrue(f.transport.posts.isEmpty())
    }

    @Test fun `a request archived on an absent answer that the server commits later surfaces on the next resume`() = runBlocking {
        // Owner review 2026-10-06 (M2), the late-commit sequence: GET absent, CLOSE archives, the lost POST commits later. The
        // next Home resume re-reads the archive, hydrates the acceptance and releases the record: the charge is shown.
        val f = Fixture(); val saved = f.sent(placementIntent())
        f.transport.onGet = { _, _ -> absent(saved.idempotencyKey) }
        assertEquals(Receipt.Absent, f.observer.check(IntentKind.CONSTRUCTION, WALLET)); f.settle()
        assertTrue(f.observer.close(IntentKind.CONSTRUCTION, WALLET) is Receipt.Closed)
        assertEquals("still no record on the next resume: it stays archived", listOf(saved to Receipt.Absent), f.observer.recheckKept(WALLET))
        assertEquals(1, f.store.kept(WALLET).size)
        f.transport.onGet = { _, _ -> placementAccepted() }
        val late = f.observer.recheckKept(WALLET)
        assertEquals(saved, late.single().first); assertTrue(late.single().second is Receipt.Accepted)
        assertEquals("the late charge is hydrated", 1, f.hydrated); assertTrue("and released from the archive", f.store.kept(WALLET).isEmpty())
        assertTrue(f.transport.posts.isEmpty())
    }

    @Test fun `an absent answer the server took too soon after the send reads as not confirmed`() = runBlocking {
        // night/server 2026-10-06: absentAsOf is stamped under the player's row lock. A request still in transit, in auth or in
        // land admission has not reached that lock, so an absence taken less than the minimum age after the send is not
        // final: it reads as `unknown` (shown, no CLOSE). A shape with any other key is not this contract and never closes.
        val f = Fixture(); val saved = f.sent(placementIntent())
        fun stamped(asOfMs: Long) = buildJsonObject {
            put("version", 1); put("status", "absent"); put("idempotencyKey", saved.idempotencyKey)
            put("absentAsOf", java.time.Instant.ofEpochMilli(asOfMs).toString())
        }
        f.settle()
        f.transport.onGet = { _, _ -> stamped(START + SAVED_REQUEST_MIN_AGE_MS - 1) }
        assertEquals(Receipt.Unknown, f.observer.check(IntentKind.CONSTRUCTION, WALLET))
        assertFalse(f.observer.interrupted.value.single().closable)
        f.transport.onGet = { _, _ -> stamped(START + SAVED_REQUEST_MIN_AGE_MS) }
        assertEquals(Receipt.Absent, f.observer.check(IntentKind.CONSTRUCTION, WALLET))
        assertTrue(f.observer.interrupted.value.single().closable)
        f.transport.onGet = { _, _ -> JsonObject(stamped(START + SAVED_REQUEST_MIN_AGE_MS) + ("extra" to JsonPrimitive(true))) }
        assertEquals(Receipt.Unsupported, f.op.observe(WALLET) {})
        f.transport.onGet = { _, _ -> JsonObject(stamped(START) + ("absentAsOf" to JsonPrimitive("yesterday"))) }
        assertEquals(Receipt.Unsupported, f.op.observe(WALLET) {})
        assertEquals(saved, f.saved()); assertTrue(f.transport.posts.isEmpty())
    }

    @Test fun `a spec that throws while describing a request keeps it blocking and never offers CLOSE`() {
        // Owner review 2026-10-06 (M3): only a declared null route reads as "cannot verify"; a failure fails closed.
        val throwing = object : MoneyOpSpec<CancellationAcceptance> by TrainingCancelSpec {
            override fun unblocksAfterCheck(intent: PendingIntent, answer: Receipt<*>): Boolean = error("broken spec")
            override fun forgetsOnServerAbsent(intent: PendingIntent): Boolean = error("broken spec")
        }
        val saved = cancelIntent().copy(attempted = true, attemptRevision = 1)
        val absentFacts = SavedRequestFacts(attemptedAtMs = 0, answer = SavedRequestFacts.ABSENT, answeredAtMs = SAVED_REQUEST_MIN_AGE_MS)
        assertFalse(supersedable(throwing, saved, absentFacts, SAVED_REQUEST_MIN_AGE_MS))
        assertFalse(closableRequest(throwing, saved, absentFacts, SAVED_REQUEST_MIN_AGE_MS))
        assertTrue("the same facts unblock with a sound spec", supersedable(TrainingCancelSpec, saved, absentFacts, SAVED_REQUEST_MIN_AGE_MS))
        assertTrue("and offer CLOSE", closableRequest(TrainingCancelSpec, saved, absentFacts, SAVED_REQUEST_MIN_AGE_MS))
        assertFalse("never on an answer read before the minimum age", closableRequest(TrainingCancelSpec, saved,
            absentFacts.copy(answeredAtMs = SAVED_REQUEST_MIN_AGE_MS - 1), SAVED_REQUEST_MIN_AGE_MS))
        // Rewritten 2026-10-06 (owner field result, Seeker build 880a7e7a): this pinned that a request with no recorded send
        // time never unblocks. Such a request was sent by an older build, before this one was installed: it counts as sent
        // long ago, so it is settled by its first answer, and still never without one.
        assertTrue("a request an older build sent is settled by its first answer",
            supersedable(TrainingCancelSpec, saved, absentFacts.copy(attemptedAtMs = null), SAVED_REQUEST_MIN_AGE_MS))
        assertFalse("never before any answer", supersedable(TrainingCancelSpec, saved,
            SavedRequestFacts(answer = null, answeredAtMs = null), SAVED_REQUEST_MIN_AGE_MS))
    }

    @Test fun `a saved request written by an older build without timing facts stops blocking after one settled check`() = runBlocking {
        // Owner field result 2026-10-06 (Seeker build 880a7e7a, QA answering unknown): "Build goldforge" was sent hours earlier by
        // an older build, so its journal holds the intent but no facts. The Home resume check answered `unknown`, yet BUILD
        // stayed shut because that first answer stamped the send time as "now". Replayed on the real decode path: the bytes
        // an older build wrote, a fresh store, the observer and the construction owner.
        val legacy = placementIntent().copy(attempted = true, attemptRevision = 1)
        val disk = MemoryStore(buildJsonObject {
            put("schemaVersion", PendingIntentStore.SCHEMA_VERSION); put("intents", buildJsonArray { add(Json.encodeToJsonElement(legacy)) })
        }.toString())
        var now = START
        val store = PendingIntentStore(disk); val transport = ScriptedTransport()
        val op = MoneyOp(ConstructionSpec, store, transport, clock = { now })
        val observer = ReceiptObserver(store, clock = { now }).apply { register(op) {} }
        assertEquals(legacy, store.get(IntentKind.CONSTRUCTION, WALLET)); assertNull("no timing facts", store.facts(legacy).attemptedAtMs)
        observer.refresh(WALLET)
        assertTrue("before any answer it still blocks", observer.blocks(IntentKind.CONSTRUCTION))
        transport.onGet = { _, _ -> placementUnknown() }
        assertEquals(Receipt.Unknown, observer.check(IntentKind.CONSTRUCTION, WALLET))
        val herald = observer.interrupted.value.single()
        assertFalse("one settled check frees BUILD", herald.blocking); assertFalse(observer.blocks(IntentKind.CONSTRUCTION))
        // Rewritten the same day (owner: "get me rid of interrupted request build goldforge"): an `unknown` a day after its
        // last send offers CLOSE (archived, re-read on every resume), and an older build's send counts as long ago.
        assertEquals(legacy, herald.intent); assertTrue("an older build's unknown offers CLOSE", herald.closable); assertTrue(herald.retryable)
        assertEquals("the answer time is recorded, the send time is not invented", SavedRequestFacts(answer = SavedRequestFacts.UNKNOWN,
            answeredAtMs = START), store.facts(legacy))
        // The answer survives a restart: a fresh store over the same bytes still lets BUILD through.
        val restarted = ReceiptObserver(PendingIntentStore(disk), clock = { now }).apply { register(MoneyOp(ConstructionSpec, PendingIntentStore(disk), transport, clock = { now })) {} }
        restarted.refresh(WALLET); assertFalse(restarted.blocks(IntentKind.CONSTRUCTION))
        // An `absent` answer for it (absentAsOf hours after the older build sent it) is final at once and offers CLOSE.
        transport.onGet = { _, _ -> buildJsonObject {
            put("version", 1); put("status", "absent"); put("idempotencyKey", legacy.idempotencyKey); put("absentAsOf", java.time.Instant.ofEpochMilli(now).toString())
        } }
        assertEquals(Receipt.Absent, observer.check(IntentKind.CONSTRUCTION, WALLET))
        assertTrue(observer.interrupted.value.single().closable)
        assertTrue(observer.close(IntentKind.CONSTRUCTION, WALLET) is Receipt.Closed)
        assertEquals(listOf(KeptIntent(legacy, closed = true)), store.kept(WALLET)); assertTrue(transport.posts.isEmpty())
    }

    @Test fun `two saved placements of one kind are each shown and each closes on its own key`() = runBlocking {
        // Owner field result 2026-10-06 (QA base 5d8f4121): two saved goldforge placements (fe158ad1… and e8137315…), no ledger
        // row for either. The first stopped blocking after a settled check, so a second BUILD parked it and was itself lost.
        val f = Fixture(); val first = f.sent(placementIntent())
        val secondBody = placementBody(key = "second-build-key")
        f.transport.onGet = { _, query -> if (query["idempotencyKey"] == first.idempotencyKey) placementUnknown() else placementUnknown(secondBody) }
        f.settle(); assertEquals(Receipt.Unknown, f.observer.check(IntentKind.CONSTRUCTION, WALLET))
        f.transport.onPost = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.op.submit(placementIntent(secondBody)) {} } }
        val second = requireNotNull(f.saved()); assertEquals("second-build-key", second.idempotencyKey)
        // Both are shown: the parked first (RETRY CHECK, never blocking) and the active second (fresh, so it blocks for now).
        f.transport.onGet = { _, query -> if (query["idempotencyKey"] == first.idempotencyKey) absent(first.idempotencyKey) else placementUnknown(secondBody) }
        assertEquals(Receipt.Unknown, f.observer.check(IntentKind.CONSTRUCTION, WALLET))
        val shown = f.observer.interrupted.value
        assertEquals(listOf(second.idempotencyKey, first.idempotencyKey), shown.map { it.intent.idempotencyKey })
        val parked = shown.single { it.kept }; val active = shown.single { !it.kept }
        assertTrue("the server has no record of the first: its own CLOSE", parked.closable); assertFalse(parked.blocking)
        assertFalse("the second was just sent: no CLOSE yet", active.closable); assertTrue(active.blocking)
        // CLOSE archives the first only; the active second is left alone.
        assertTrue(f.observer.close(IntentKind.CONSTRUCTION, WALLET) is Receipt.Closed)
        assertEquals(listOf(KeptIntent(first, closed = true)), f.store.kept(WALLET)); assertEquals(second, f.saved())
        assertEquals(listOf(second.idempotencyKey), f.observer.interrupted.value.map { it.intent.idempotencyKey })
        // The second settles on its own key: a settled unknown frees BUILD; a day later it offers its own CLOSE.
        f.settle(); assertEquals(Receipt.Unknown, f.observer.check(IntentKind.CONSTRUCTION, WALLET))
        assertFalse(f.observer.blocks(IntentKind.CONSTRUCTION)); assertFalse(f.observer.interrupted.value.single().closable)
        f.now += STALE_REQUEST_MS; assertEquals(Receipt.Unknown, f.observer.check(IntentKind.CONSTRUCTION, WALLET))
        assertTrue("an unknown a day old has an explicit way out", f.observer.interrupted.value.single().closable)
        assertTrue(f.observer.close(IntentKind.CONSTRUCTION, WALLET) is Receipt.Closed)
        assertNull(f.saved()); assertTrue("both archived, none shown", f.observer.interrupted.value.isEmpty())
        assertEquals(setOf(first.idempotencyKey, second.idempotencyKey), f.store.kept(WALLET).filter { it.closed }.map { it.intent.idempotencyKey }.toSet())
        assertEquals("only the second order was ever posted", listOf("second-build-key"),
            f.transport.posts.map { it.second.getValue("idempotencyKey").jsonPrimitive.content })
        // Archived is not forgotten: a late acceptance of either still surfaces on the next resume.
        f.transport.onGet = { _, query -> if (query["idempotencyKey"] == first.idempotencyKey) placementAccepted() else placementUnknown(secondBody) }
        assertTrue(f.observer.recheckKept(WALLET).any { it.first == first && it.second is Receipt.Accepted })
        assertEquals(1, f.hydrated)
    }

    @Test fun `a refused TRY AGAIN never restarts the minimum age and an ambiguous one does`() = runBlocking {
        // Owner field result 2026-10-06: TRY AGAIN on a request the server had already answered for reset its send time, so BUILD
        // stayed shut five more minutes after every tap. A refused retry is not in flight; only a retry whose outcome is
        // unknown (timeout, lost reply) may still commit and restarts the wait.
        val f = Fixture(); val saved = f.sent(placementIntent()); f.transport.onGet = { _, _ -> placementUnknown() }
        f.settle(); assertEquals(Receipt.Unknown, f.observer.check(IntentKind.CONSTRUCTION, WALLET))
        assertFalse(f.observer.blocks(IntentKind.CONSTRUCTION))
        val before = f.store.facts(saved)
        f.transport.onPost = { _, _ -> throw ApiException(409, "BUILD_TILE_OCCUPIED", "That tile is taken") }
        assertThrows(ApiException::class.java) { runBlocking { f.op.retry(WALLET) {} } }
        f.observer.refresh(WALLET)
        assertFalse("a refused retry leaves BUILD open", f.observer.blocks(IntentKind.CONSTRUCTION)); assertEquals(before, f.store.facts(saved))
        f.transport.onPost = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.op.retry(WALLET) {} } }
        f.observer.refresh(WALLET)
        assertTrue("a retry that may still commit restarts the wait", f.observer.blocks(IntentKind.CONSTRUCTION))
        assertEquals("only the two explicit retries were sent", 2, f.transport.posts.size)
    }

    @Test fun `an operation that did not opt in keeps a key the server has no record of`() = runBlocking {
        // Rewritten 2026-10-06 (dead-end audit, then owner review M1): the cancellation refund used here now opts in and the
        // way out is an `absent` answer. The rule this pins is unchanged: archiving is an explicit per-operation decision, so
        // a spec that declares nothing keeps the key.
        var now = START
        val store = PendingIntentStore(MemoryStore()); val transport = ScriptedTransport()
        val undeclared = object : MoneyOpSpec<CancellationAcceptance> by TrainingCancelSpec {
            override val savedRequestExit: SavedRequestExit get() = SavedRequestExit.UNDECLARED
            override fun forgetsOnServerAbsent(intent: PendingIntent) = false
        }
        val op = MoneyOp(undeclared, store, transport, clock = { now })
        val saved = cancelIntent().copy(attempted = true, attemptRevision = 1); store.create(saved); store.recordAttempt(saved, now)
        transport.onGet = { _, _ -> absent(saved.idempotencyKey) }
        now += SAVED_REQUEST_MIN_AGE_MS
        assertEquals(Receipt.Absent, op.close(WALLET, confirmed = true) {})
        assertEquals(saved, store.get(IntentKind.TRAINING_CANCEL, WALLET)); assertTrue(store.kept(WALLET).isEmpty()); assertTrue(transport.posts.isEmpty())
        assertFalse(InterruptedIntent(saved, Receipt.Unknown).closable)
        assertFalse("an unobserved construction is not closable", InterruptedIntent(placementIntent().copy(attempted = true)).closable)
        assertFalse("an unsupported answer is not closable", InterruptedIntent(placementIntent().copy(attempted = true), Receipt.Unsupported).closable)
    }

    @Test fun `a never sent request is closable at once and its close honours an acceptance a read finds`() = runBlocking {
        // Rewritten 2026-10-06 (owner review, red wall batch test): this pinned that a never-sent request was forgotten with
        // no read at all. The close now reads first where a read exists, so an acceptance it finds is hydrated, never
        // dropped; anything else removes the record (the attempted flag is durable before any byte leaves).
        val f = Fixture(); f.store.create(placementIntent())
        f.observer.refresh(WALLET)
        assertTrue(f.observer.interrupted.value.single().closable)
        f.transport.onGet = { _, _ -> placementUnknown() }
        assertTrue(f.observer.close(IntentKind.CONSTRUCTION, WALLET) is Receipt.Closed)
        assertNull(f.saved()); assertTrue(f.store.kept(WALLET).isEmpty()); assertTrue(f.transport.posts.isEmpty())
        val found = Fixture(); found.store.create(placementIntent()); found.transport.onGet = { _, _ -> placementAccepted() }
        assertTrue(found.observer.close(IntentKind.CONSTRUCTION, WALLET) is Receipt.Accepted)
        assertEquals(1, found.hydrated); assertNull(found.saved())
        // A read that fails cannot keep a request the server never received.
        val offline = Fixture(); offline.store.create(placementIntent()); offline.transport.onGet = { _, _ -> throw IOException("offline") }
        assertTrue(offline.observer.close(IntentKind.CONSTRUCTION, WALLET) is Receipt.Closed); assertNull(offline.saved())
        for (each in listOf(f, found, offline)) assertTrue(each.transport.posts.isEmpty())
    }

    @Test fun `a legacy finish whose job still runs reads as absent and one whose job is gone is never closed`() = runBlocking {
        // Rewritten 2026-10-06 (owner review M1): the GET /base absence proof now reads as absent, not unknown. A finish or
        // cancel whose job is gone may have been applied: never CLOSE. Either way it stops blocking BUILD once settled.
        for ((jobRunning, expected) in listOf(true to Receipt.Absent, false to Receipt.Unsupported)) {
            val job = Fixture()
            val finish = job.sent(placementIntent(buildJsonObject { put("idempotencyKey", "finish-key-1") }, "/base/jobs/$JOB/speedup"))
            job.transport.onGet = { _, _ -> base(upgrading = jobRunning) }
            assertEquals("job running $jobRunning", expected, job.op.observe(WALLET) {})
            assertEquals(finish, job.saved())
            job.settle(); assertEquals(expected, job.observer.check(IntentKind.CONSTRUCTION, WALLET))
            val shown = job.observer.interrupted.value.single()
            assertEquals("CLOSE only while the job still runs", jobRunning, shown.closable)
            assertFalse("it no longer blocks BUILD", shown.blocking)
            assertTrue(job.transport.posts.isEmpty())
        }
    }

    @Test fun `a wall row and a layout unlock the server never committed are archived by CLOSE`() = runBlocking {
        var now = START
        val store = PendingIntentStore(MemoryStore()); val transport = ScriptedTransport(); val observer = ReceiptObserver(store, clock = { now })
        val wallOp = MoneyOp(WallRowSpec, store, transport, clock = { now }); observer.register(wallOp) {}
        // GET /base: every eligible wall still at its quoted level proves the row purchase was never committed.
        val row = WallRowSpec.intent(WALLET, BASE, WallRowQuote.from(wallQuote()), "wall-row-key-1").copy(attempted = true, attemptRevision = 1)
        store.create(row); store.recordAttempt(row, now)
        transport.onGet = { path, query -> assertEquals("/base", path); assertEquals(BASE, query["baseId"]); wallBase(level = 1) }
        assertEquals(Receipt.Absent, observer.check(IntentKind.WALL_ROW, WALLET))
        now += SAVED_REQUEST_MIN_AGE_MS
        assertTrue(observer.close(IntentKind.WALL_ROW, WALLET) is Receipt.Closed); assertNull(store.get(IntentKind.WALL_ROW, WALLET))
        // A wall already at its target level may be this purchase: never closed.
        val upgraded = WallRowSpec.intent(WALLET, BASE, WallRowQuote.from(wallQuote()), "wall-row-key-2").copy(attempted = true, attemptRevision = 1)
        store.create(upgraded); store.recordAttempt(upgraded, now - SAVED_REQUEST_MIN_AGE_MS); transport.onGet = { _, _ -> wallBase(level = 2) }
        assertEquals(Receipt.Unsupported, observer.close(IntentKind.WALL_ROW, WALLET)); assertEquals(upgraded, store.get(IntentKind.WALL_ROW, WALLET))
        // GET /base/layouts: a still locked FARM slot proves the unlock (charge and unlock commit together) never landed.
        val unlockOp = MoneyOp(LayoutUnlockSpec, store, transport, clock = { now }); observer.register(unlockOp) {}
        val unlock = LayoutUnlockSpec.intent(WALLET, BASE, "unlock-key-1").copy(attempted = true, attemptRevision = 1)
        store.create(unlock); store.recordAttempt(unlock, now - SAVED_REQUEST_MIN_AGE_MS)
        transport.onGet = { path, _ -> assertEquals("/base/layouts", path)
            buildJsonObject { put("baseId", BASE); put("farmUnlock", buildJsonObject { put("locked", true); put("costShards", "500") }) } }
        assertTrue(observer.close(IntentKind.LAYOUT_UNLOCK, WALLET) is Receipt.Closed); assertNull(store.get(IntentKind.LAYOUT_UNLOCK, WALLET))
        assertEquals("both are archived, not deleted", 2, store.kept(WALLET).count { it.closed })
        assertTrue(transport.posts.isEmpty())
    }

    @Test fun `cancellation hero and economy requests close only on an absent answer and stop blocking on unknown`() = runBlocking {
        // Rewritten 2026-10-06 (owner review M1): this pinned CLOSE on `unknown`. Unknown now keeps the request shown with
        // RETRY CHECK and, once settled, no longer blocking; only `absent` for the exact key archives it.
        fun unknown(key: String) = buildJsonObject { put("version", 1); put("status", "unknown"); put("idempotencyKey", key) }
        val cases: List<Triple<MoneyOpSpec<*>, PendingIntent, JsonObject>> = listOf(
            Triple(TrainingCancelSpec, cancelIntent(), cancelReceipt(status = "unknown")),
            Triple(HeroUpgradeSpec, HeroUpgradeSpec.intent(WALLET, BASE, "vex", "hero-upgrade-key", level = 2, costKeep = "2500"), unknown("hero-upgrade-key")),
            Triple(HeroRecoverySpec, HeroRecoverySpec.intent(WALLET, BASE, "theodor", "hero-recovery-key", costKeep = "7",
                recoveryUntil = "2026-09-11T10:00:00.000Z"), unknown("hero-recovery-key")),
            Triple(KeepConversionSpec, KeepConversionSpec.intent(WALLET, BASE, "economy-key", "10"), unknown("economy-key")),
        )
        for ((spec, intent, unknownAnswer) in cases) {
            var now = START
            val store = PendingIntentStore(MemoryStore()); val transport = ScriptedTransport(onGet = { _, _ -> unknownAnswer })
            @Suppress("UNCHECKED_CAST") val op = MoneyOp(spec as MoneyOpSpec<Any>, store, transport, clock = { now })
            val observer = ReceiptObserver(store, clock = { now }); observer.register(op) {}
            val saved = intent.copy(attempted = true, attemptRevision = 1); store.create(saved); store.recordAttempt(saved, now)
            observer.refresh(WALLET)
            assertTrue("${spec.kind} blocks while unresolved", observer.blocks(spec.kind))
            assertEquals(Receipt.Unknown, observer.check(spec.kind, WALLET))
            now += SAVED_REQUEST_MIN_AGE_MS; assertEquals(Receipt.Unknown, observer.check(spec.kind, WALLET))
            val shown = observer.interrupted.value.single()
            assertFalse("${spec.kind} offers no CLOSE on unknown", shown.closable); assertFalse("${spec.kind} stops blocking", shown.blocking)
            assertEquals(Receipt.Unknown, observer.close(spec.kind, WALLET)); assertEquals(saved, store.get(spec.kind, WALLET))
            transport.onGet = { _, _ -> absent(saved.idempotencyKey) }
            assertEquals(Receipt.Absent, observer.check(spec.kind, WALLET))
            assertTrue("${spec.kind} offers CLOSE on absent", observer.interrupted.value.single().closable)
            assertTrue("${spec.kind} closes", observer.close(spec.kind, WALLET) is Receipt.Closed)
            assertNull(store.get(spec.kind, WALLET)); assertEquals(listOf(KeptIntent(saved, closed = true)), store.kept(WALLET))
            assertFalse(observer.blocks(spec.kind)); assertTrue(transport.posts.isEmpty())
        }
    }

    @Test fun `a journal holding a kind this build does not know keeps it verbatim`() {
        // Owner review 2026-10-06 (m2): a later build's (or a retired) kind must neither break this journal nor be lost by it.
        val foreign = buildJsonObject { put("kind", "retired-kind"); put("wallet", WALLET); put("idempotencyKey", "foreign-key-1") }
        val memory = MemoryStore(buildJsonObject {
            put("schemaVersion", PendingIntentStore.SCHEMA_VERSION); put("intents", buildJsonArray { add(foreign) })
        }.toString())
        val store = PendingIntentStore(memory)
        assertTrue(store.all(WALLET).isEmpty())
        val saved = placementIntent(); assertTrue(store.create(saved)); store.recordAttempt(saved, START)
        val written = Json.parseToJsonElement(requireNotNull(memory.value)).jsonObject
        assertTrue("the foreign record is written back unchanged", foreign in written.getValue("intents").jsonArray)
        assertEquals(saved, PendingIntentStore(MemoryStore(memory.value)).get(IntentKind.CONSTRUCTION, WALLET))
        assertEquals("the facts survive a restart", START, PendingIntentStore(MemoryStore(memory.value)).facts(saved).attemptedAtMs)
    }

    private companion object {
        const val START = 1_000_000_000L
        const val BUILDING = "00000000-0000-4000-8000-000000000002"
        const val JOB = "00000000-0000-4000-8000-000000000003"
        fun absent(key: String) = buildJsonObject { put("version", 1); put("status", "absent"); put("idempotencyKey", key) }
        fun legacyUpgrade(fromLevel: Int?): PendingIntent =
            placementIntent(buildJsonObject { put("idempotencyKey", "upgrade-key-1") }, "/base/buildings/$BUILDING/upgrade")
                .copy(quote = fromLevel?.let { ConstructionSpec.upgradeQuote(BUILDING, it) })
        fun base(upgrading: Boolean, level: Int = 2) = buildJsonObject {
            put("baseId", "a0000000-0000-4000-8000-000000000001")
            put("player", buildJsonObject { put("keepLevel", 3) })
            put("buildings", buildJsonArray { add(buildJsonObject { put("id", BUILDING); put("type", "mine"); put("level", level); put("tx", 11); put("ty", 8); put("underConstruction", upgrading) }) })
            put("jobs", buildJsonArray { if (upgrading) add(buildJsonObject { put("id", JOB); put("kind", "upgrade"); put("buildingId", BUILDING) }) })
        }
        const val WALL = "00000000-0000-4000-8000-000000000004"
        fun wallQuote() = buildJsonObject {
            put("baseId", BASE); put("selectedWallId", WALL); put("quoteId", "a".repeat(64)); put("keepLevel", 3)
            put("walls", buildJsonArray { add(buildJsonObject { put("id", WALL); put("tx", 4); put("ty", 4); put("level", 1); put("targetLevel", 2); put("costShards", "40") }) })
            put("totalCostShards", "40"); put("balanceShards", "500"); put("canAfford", true)
        }
        fun wallBase(level: Int) = buildJsonObject {
            put("baseId", BASE); put("player", buildJsonObject { put("keepLevel", 3) })
            put("buildings", buildJsonArray { add(buildJsonObject { put("id", WALL); put("type", "wall"); put("level", level); put("tx", 4); put("ty", 4) }) })
        }
    }
}
