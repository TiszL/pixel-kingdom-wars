package gg.pixelkingdomwars.nativeclient.ordinarycrafting

import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic server recipes deliberately differ from gameplay tuning. These are transport/store proofs,
 * not API adapter, authenticated paired-server, art or device acceptance. */
class OrdinaryCraftingTest {
    private val identity = OrdinaryCraftingIdentity("https://game.test", "devnet", "11111111111111111111111111111111")
    private val base = "00000000-0000-4000-8000-000000000001"
    private val key = "00000000-0000-4000-8000-000000000002"
    private val other = "00000000-0000-4000-8000-000000000003"
    private val start = "2026-09-22T12:00:00.000Z"
    private val recipes = listOf("frostglass" to "frost_quartz", "heartwood_beams" to "heartwood_logs",
        "sunstone_blocks" to "sunstone_rubble", "crownsteel" to "crown_iron_ore", "prismstone_lens" to "rough_prism",
        "stormalloy" to "storm_ore", "thornsilk" to "thorn_fibre", "embercore" to "ember_nodules").map { (output, input) ->
        OrdinaryCraftingRecipe(1, "refine_$output", 1, 17, listOf(OrdinaryCraftingInput("raw", input, "13")), OrdinaryCraftingOutput(output, "3"))
    } + OrdinaryCraftingRecipe(1, "craft_navigation_kit", 1, 23, listOf(OrdinaryCraftingInput("crafting", "prismstone_lens", "2"),
        OrdinaryCraftingInput("crafting", "frostglass", "4")), OrdinaryCraftingOutput("navigation_kit", "1"))
    private fun view() = OrdinaryCraftingView(identity.wallet, base, OrdinaryCraftingFeatures(OrdinaryCraftingFeature(1, 1)), true, 1, 9,
        recipes, rawResourceIds.map { OrdinaryRawStock(it, "100", "5", "105") },
        craftingItemIds.map { OrdinaryProtectedStock(it, "100", "0") }, emptyList(), start)
    private fun command(key: String = this.key) = OrdinaryCraftingCommand.review(identity, view(), key, "refine_frostglass", 2)
    private fun proof(command: OrdinaryCraftingCommand = command(), accepted: Boolean = false, completed: Boolean = false): OrdinaryCraftingProof {
        val ready = java.time.Instant.parse(start).plusSeconds(command.recipe.durationSec).toString().replace("Z", ".000Z")
        val receipt = if (accepted) OrdinaryCraftingReceipt(command.key, command.recipe, start, ready, identity.wallet, command.request) else null
        return OrdinaryCraftingProof(identity.wallet, command.key, if (completed) ready else start,
            if (accepted) "accepted" else "unknown", receipt, if (completed) OrdinaryCraftingCompletion(ready) else null)
    }
    private fun raw(proof: OrdinaryCraftingProof) = ordinaryJson.encodeToJsonElement(OrdinaryCraftingProof.serializer(), proof).jsonObject
    private fun raw(view: OrdinaryCraftingView) = ordinaryJson.encodeToJsonElement(OrdinaryCraftingView.serializer(), view).jsonObject
    private fun rejects(block: () -> Unit) { assertThrows(Exception::class.java) { block() } }
    private class Memory : SecretStore {
        var bytes: String? = null; var fail = false
        override fun read() = bytes
        override fun write(value: String) { if (fail) throw IOException("disk full"); bytes = value }
        override fun clear() { error("Original records must never be cleared") }
    }
    private inner class Fixture {
        val memory = Memory(); val store = OrdinaryCraftingStore(memory, identity); val command = command()
        var gets = 0; var posts = 0; var accepted = false; var completed = false
        var read: suspend (() -> Unit, (JsonObject) -> Unit) -> JsonObject = { guard, retain ->
            guard(); raw(proof(command, accepted, completed)).also(retain)
        }
        var send: suspend (() -> Unit, (JsonObject) -> Unit, (ApiException) -> Unit) -> JsonObject = { guard, retain, _ ->
            guard(); accepted = true; raw(proof(command, true)).also(retain)
        }
        val port = object : OrdinaryCraftingPort {
            override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
                gets++; assertEquals(command.receiptPath, path); return read(guard, retain)
            }
            override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
                assertEquals("/ordinary-crafting/jobs", path); assertEquals(command.request.body(), body)
                val saved = store.read(); assertEquals(command, saved.operation!!.command); assertEquals(saved.revision, saved.operation.attemptRevision)
                posts++; return send(guard, retain, refusal)
            }
        }
        val transport = OrdinaryCraftingTransport(store, port)
        suspend fun begin() = transport.begin(command, view()) {}
        suspend fun confirm(expected: OrdinaryCraftingJournal = store.read()) = transport.confirm(expected, ::view) {}
    }

    @Test fun `current recipes and exact batch review are entirely server sourced`() {
        OrdinaryCraftingView.from(raw(view()))
        val command = command(); assertEquals("26", command.recipe.inputs.single().quantity); assertEquals("6", command.recipe.output.quantity); assertEquals(34L, command.recipe.durationSec)
        assertEquals(setOf("idempotencyKey", "baseId", "recipeId", "recipeVersion", "quantity"), command.request.body().keys)
        assertFalse(command.request.body().containsKey("price"))
        val navigation = OrdinaryCraftingCommand.review(identity, view(), other, "craft_navigation_kit", 3)
        assertEquals(listOf("6", "12"), navigation.recipe.inputs.map { it.quantity }); assertEquals(69L, navigation.recipe.durationSec)
    }

    @Test fun `strict current feature and scalar types refuse old unknown or malformed views`() {
        val original = raw(view())
        for (invalid in listOf(JsonObject(original - "features"), JsonObject(original + ("futureTerms" to JsonPrimitive(true))),
            JsonObject(original + ("acceptingJobs" to JsonPrimitive("true"))), JsonObject(original + ("recipeVersion" to JsonPrimitive("7"))),
            JsonObject(original + ("maxBatch" to JsonPrimitive(Int.MAX_VALUE.toLong() + 1))), JsonObject(original + ("serverNow" to JsonPrimitive(1))))) rejects { OrdinaryCraftingView.from(invalid) }
        rejects { view().copy(features = OrdinaryCraftingFeatures(OrdinaryCraftingFeature(2, 1))).validate() }
        rejects { view().copy(features = OrdinaryCraftingFeatures(OrdinaryCraftingFeature(1, 2))).validate() }
    }

    @Test fun `stock values stay canonical signed int64 and reservations remain in raw totals`() {
        OrdinaryRawStock("frost_quartz", (Long.MAX_VALUE - 1).toString(), "1", Long.MAX_VALUE.toString()).validate()
        OrdinaryProtectedStock("frostglass", (Long.MAX_VALUE - 1).toString(), "1").validate()
        for (value in listOf("01", "-1", "1.0", "1e2", "9223372036854775808")) rejects { OrdinaryProtectedStock("frostglass", value, "0").validate() }
        rejects { OrdinaryRawStock("frost_quartz", "1", "2", "1").validate() }
        rejects { OrdinaryProtectedStock("frostglass", Long.MAX_VALUE.toString(), "1").validate() }
        val stock = raw(view()).getValue("rawStock").jsonArray
        val numeric = JsonObject(stock.first().jsonObject + ("available" to JsonPrimitive(100)))
        rejects { OrdinaryCraftingView.from(JsonObject(raw(view()) + ("rawStock" to JsonArray(listOf(numeric) + stock.drop(1))))) }
    }

    @Test fun `identity complete inventory and pending output must describe one settled snapshot`() {
        val c = command(); val p = proof(c, true); val pending = OrdinaryCraftingPendingJob(c.key, c.recipe, start, p.receipt!!.readyAt)
        val stocks = view().craftingStock.map { if (it.itemId == c.recipe.output.itemId) it.copy(pendingOutput = c.recipe.output.quantity) else it }
        val current = view().copy(craftingStock = stocks, pendingJobs = listOf(pending)); current.validate()
        rejects { current.copy(pendingJobs = emptyList()).validate() }; rejects { current.copy(pendingJobs = listOf(pending, pending)).validate() }
        rejects { current.copy(serverNow = pending.readyAt).validate() }; rejects { current.copy(rawStock = current.rawStock.drop(1)).validate() }
        rejects { current.copy(craftingStock = stocks.drop(1) + stocks.last()).validate() }
        rejects { current.copy(recipes = recipes.drop(1) + recipes.last()).validate() }
        rejects { current.copy(baseId = "00000000-0000-0000-8000-000000000001").validate() }
        rejects { current.copy(serverNow = start.replace(".000", "")).validate() }
    }

    @Test fun `review rejects paused changed unaffordable and overflowing batches without Kotlin tuning`() {
        val c = command()
        rejects { c.admit(identity, view().copy(acceptingJobs = false)) }; rejects { c.admit(identity, view().copy(baseId = other)) }
        rejects { c.admit(identity, view().copy(maxBatch = 1)) }
        rejects { c.admit(identity, view().copy(recipes = recipes.map { if (it.recipeId == c.request.recipeId) it.copy(durationSec = 18) else it })) }
        rejects { c.admit(identity, view().copy(rawStock = view().rawStock.map { it.copy(available = "0", total = it.reserved) })) }
        rejects { recipes.first().copy(output = OrdinaryCraftingOutput("frostglass", Long.MAX_VALUE.toString())).batch(2) }
        rejects { recipes.first().copy(durationSec = 9_007_199_254_740_991L).batch(2) }
        rejects { c.admit(identity, view().copy(craftingStock = view().craftingStock.map { it.copy(available = Long.MAX_VALUE.toString()) })) }
    }

    @Test fun `receipt binds full original body actor reviewed recipe and deadline`() {
        val c = command(); val p = proof(c, true); p.validate(identity, c); val original = requireNotNull(p.receipt)
        for (invalid in listOf(p.copy(wallet = "other"), p.copy(idempotencyKey = other), p.copy(receipt = original.copy(request = c.request.copy(baseId = other))),
            p.copy(receipt = original.copy(recipe = c.recipe.copy(durationSec = 35))), p.copy(receipt = original.copy(readyAt = start)),
            p.copy(receipt = original.copy(jobId = other)))) rejects { invalid.validate(identity, c) }
        rejects { OrdinaryCraftingProof.from(JsonObject(raw(p) + ("status" to JsonPrimitive(true))), identity, c) }
        val receipt = raw(p).getValue("receipt").jsonObject; val request = receipt.getValue("request").jsonObject
        rejects { OrdinaryCraftingProof.from(JsonObject(raw(p) + ("receipt" to JsonObject(receipt + ("request" to JsonObject(request + ("quantity" to JsonPrimitive("2"))))))), identity, c) }
    }

    @Test fun `unknown proof cannot contain receipt or completion and completion cannot precede readiness`() {
        val c = command(); val unknown = proof(c); unknown.validate(identity, c)
        rejects { unknown.copy(receipt = proof(c, true).receipt).validate(identity, c) }
        rejects { unknown.copy(completion = OrdinaryCraftingCompletion(start)).validate(identity, c) }
        rejects { proof(c, true).copy(completion = OrdinaryCraftingCompletion(start)).validate(identity, c) }
        rejects { OrdinaryCraftingProof.from(JsonObject(raw(unknown) - "completion"), identity, c) }
    }

    @Test fun `persist full original before any network and a distinct attempt revision before the single POST`() = runBlocking<Unit> {
        val f = Fixture(); val original = f.begin(); assertEquals(0, f.gets); assertEquals(0, f.posts)
        assertEquals(f.command, OrdinaryCraftingStore(f.memory, identity).read().operation!!.command)
        val accepted = f.confirm(original); assertEquals(1, f.posts); assertEquals(1, f.gets)
        assertNotNull(accepted.operation!!.proof); assertTrue(accepted.operation.attemptRevision!! > original.revision)
        f.confirm(accepted); assertEquals("Confirming an accepted original only recovers", 1, f.posts)
    }

    @Test fun `lost acknowledgement restarts with GET only and keeps the original recipe while live starts are paused`() = runBlocking<Unit> {
        val f = Fixture(); val original = f.begin(); f.send = { _, _, _ -> f.accepted = true; throw IOException("lost acknowledgement") }
        rejects { runBlocking { f.confirm(original) } }
        val restart = OrdinaryCraftingTransport(OrdinaryCraftingStore(f.memory, identity), f.port)
        val saved = restart.check {}; assertNotNull(saved.operation!!.proof); assertEquals(1, f.posts)
        restart.confirm(saved, { error("Historical recovery must not read current policy") }) {}
        assertEquals(1, f.posts); assertEquals(f.command, saved.operation.command)
    }

    @Test fun `an explicit unknown retry keeps exactly the saved body and requires current review`() = runBlocking<Unit> {
        val f = Fixture(); val original = f.begin(); f.send = { _, _, _ -> throw IOException("lost") }
        rejects { runBlocking { f.confirm(original) } }; val firstAttempt = f.store.read().operation!!.attemptRevision
        rejects { runBlocking { f.transport.confirm(f.store.read(), { view().copy(acceptingJobs = false) }) {} } }
        assertEquals(1, f.posts)
        rejects { runBlocking { f.confirm() } }
        assertEquals(2, f.posts); assertTrue(f.store.read().operation!!.attemptRevision!! > firstAttempt!!)
        assertEquals(f.command, f.store.read().operation!!.command)
        // Rewritten 2026-10-06 (dead-end audit): the uncertain original now closes after its fresh `unknown` receipt (owner:
        // no saved request may block play forever), only as "unknown" and without another POST.
        assertEquals("unknown", f.transport.archiveUnsentOrRefused(f.store.read()) {}.archives.single().reason); assertEquals(2, f.posts)
    }

    @Test fun `actual enqueue rechecks the review after IO and retains the uncertain original attempt`() = runBlocking<Unit> {
        val f = Fixture(); val original = f.begin(); var current = view(); var enqueued = false
        f.send = { guard, _, _ -> current = current.copy(acceptingJobs = false); guard(); enqueued = true; error("must not enqueue") }
        rejects { runBlocking { f.transport.confirm(original, { current }) {} } }
        assertFalse(enqueued); assertNotNull(f.store.read().operation!!.attemptRevision); assertNull(f.store.read().operation!!.proof)
    }

    @Test fun `owned POST proof survives cancellation or changed session before the caller receives success`() = runBlocking<Unit> {
        for (cancel in listOf(true, false)) {
            val f = Fixture(); val original = f.begin(); var current = true
            f.send = { _, retain, _ -> retain(raw(proof(f.command, true))); current = false; if (cancel) throw CancellationException("cancelled owned response") else throw IllegalStateException("session changed") }
            rejects { runBlocking { f.transport.confirm(original, ::view) { check(current) } } }
            assertNotNull(OrdinaryCraftingStore(f.memory, identity).read().operation!!.proof); assertEquals(1, f.posts)
        }
    }

    @Test fun `owned GET proof survives cancellation and malformed or partial bodies never become acceptance`() = runBlocking<Unit> {
        val f = Fixture(); f.begin()
        f.read = { _, retain -> retain(raw(proof(f.command, true))); throw CancellationException("cancelled owned GET") }
        rejects { runBlocking { f.transport.check {} } }; assertNotNull(f.store.read().operation!!.proof); assertEquals(0, f.posts)
        val malformed = Fixture(); malformed.begin(); malformed.read = { _, retain -> retain(JsonObject(emptyMap())); error("unreachable") }
        rejects { runBlocking { malformed.transport.check {} } }; assertNull(malformed.store.read().operation!!.proof)
        malformed.read = { _, _ -> throw IOException("truncated body") }
        rejects { runBlocking { malformed.transport.check {} } }; assertNull(malformed.store.read().operation!!.proof)
    }

    @Test fun `late first refusal cannot mark a newer ambiguous retry or erase later acceptance`() = runBlocking<Unit> {
        for (accept in listOf(false, true)) {
            val f = Fixture(); f.begin(); var late: ((ApiException) -> Unit)? = null
            f.send = { _, _, refusal -> late = refusal; throw CancellationException("first response not delivered") }
            rejects { runBlocking { f.confirm() } }; val first = f.store.read().operation!!.attemptRevision
            f.send = { guard, retain, _ -> guard(); if (accept) { f.accepted = true; raw(proof(f.command, true)).also(retain) } else throw IOException("second ambiguous") }
            if (accept) f.confirm() else rejects { runBlocking { f.confirm() } }
            val saved = f.store.read(); assertTrue(saved.operation!!.attemptRevision!! > first!!)
            requireNotNull(late)(ApiException(422, "INSUFFICIENT_RAW_STOCK", "first refusal"))
            assertEquals(saved, f.store.read()); assertNull(f.store.read().operation!!.refusal); assertEquals(accept, saved.operation.proof != null)
        }
    }

    @Test fun `first definitive refusal survives cancellation and needs explicit unknown recovery to archive`() = runBlocking<Unit> {
        val f = Fixture(); val original = f.begin()
        f.send = { _, _, refusal -> refusal(ApiException(400, "ORDINARY_RECIPE_INVALID", "invalid")); throw CancellationException("cancelled refusal") }
        rejects { runBlocking { f.confirm(original) } }; assertEquals(OrdinaryCraftingRefusal(400, "ORDINARY_RECIPE_INVALID"), f.store.read().operation!!.refusal)
        val archived = f.transport.archiveUnsentOrRefused(f.store.read()) {}
        assertEquals("refused", archived.archives.single().reason); assertEquals("unknown", archived.archives.single().evidence!!.status)
        rejects { f.store.begin(archived, f.command) }
    }

    @Test fun `retry refusals generic failures and receipt GET errors cannot disprove an earlier attempt`() = runBlocking<Unit> {
        for (error in listOf(ApiException(409, "IDEMPOTENCY_BODY_MISMATCH", "x"), ApiException(401, "INSUFFICIENT_RAW_STOCK", "x"), ApiException(422, null, "x"))) {
            val f = Fixture(); val original = f.begin(); f.send = { _, _, _ -> throw error }
            rejects { runBlocking { f.confirm(original) } }; assertNull(f.store.read().operation!!.refusal)
        }
        val f = Fixture(); f.begin(); f.send = { _, _, _ -> throw IOException("lost") }; rejects { runBlocking { f.confirm() } }
        f.send = { _, _, refusal -> val error = ApiException(422, "INSUFFICIENT_RAW_STOCK", "retry refusal"); refusal(error); throw error }
        rejects { runBlocking { f.confirm() } }; assertNull(f.store.read().operation!!.refusal)
        f.read = { _, _ -> throw ApiException(422, "INSUFFICIENT_RAW_STOCK", "GET failure") }
        rejects { runBlocking { f.transport.check {} } }; assertNull(f.store.read().operation!!.refusal)
    }

    @Test fun `completion only advances while original receipt remains equal across restart and archive recovery`() = runBlocking<Unit> {
        val f = Fixture(); val accepted = f.confirm(f.begin()); val frozen = accepted.operation!!.proof!!.receipt
        val archived = f.transport.finish(accepted, {}, {})
        assertNull(archived.operation); assertEquals(frozen, archived.archives.single().operation.proof!!.receipt)
        f.completed = true
        val updated = f.transport.checkArchived(key) {}; val completed = updated.archives.single().operation.proof!!
        assertEquals(frozen, completed.receipt); assertNotNull(completed.completion)
        val restarted = OrdinaryCraftingStore(f.memory, identity).read(); assertEquals(updated, restarted)
        f.completed = false
        rejects { runBlocking { f.transport.checkArchived(key) {} } }; assertEquals(updated, f.store.read())
        f.completed = true; val changed = proof(f.command, true, true).let { p -> p.copy(serverNow = "2026-09-22T12:01:00.000Z", completion = OrdinaryCraftingCompletion("2026-09-22T12:01:00.000Z")) }
        f.read = { _, retain -> raw(changed).also(retain) }
        rejects { runBlocking { f.transport.checkArchived(key) {} } }; assertEquals(updated, f.store.read())
    }

    @Test fun `accepted proof survives failed current hydration and cannot be downgraded to unknown`() = runBlocking<Unit> {
        val f = Fixture(); val accepted = f.confirm(f.begin())
        rejects { runBlocking { f.transport.finish(accepted, {}, { throw IOException("current inventory unavailable") }) } }
        assertNotNull(f.store.read().operation!!.proof)
        f.accepted = false; rejects { runBlocking { f.transport.check {} } }; assertNotNull(f.store.read().operation!!.proof)
    }

    @Test fun `explicit abandonment requires fresh unknown and preserves original command instead of deleting it`() = runBlocking<Unit> {
        val f = Fixture(); val draft = f.begin(); val archived = f.transport.archiveUnsentOrRefused(draft) {}
        assertEquals("unattempted", archived.archives.single().reason); assertEquals(f.command, archived.archives.single().operation.command)
        rejects { f.store.begin(archived, f.command) }; assertEquals(0, f.posts)
    }

    @Test fun `corruption unsupported storage identity and failed durability cannot submit a mutation`() = runBlocking<Unit> {
        for (bytes in listOf("broken", "{}", "{\"version\":2}")) {
            val f = Fixture(); f.memory.bytes = bytes; rejects { runBlocking { f.begin() } }; assertEquals(bytes, f.memory.bytes); assertEquals(0, f.posts)
        }
        val f = Fixture(); val original = f.begin(); val bytes = f.memory.bytes
        rejects { OrdinaryCraftingStore(f.memory, identity.copy(cluster = "mainnet-beta")).read() }
        rejects { OrdinaryCraftingStore(f.memory, identity.copy(origin = "https://other.test")).read() }
        f.memory.fail = true; rejects { runBlocking { f.confirm(original) } }; assertEquals(0, f.posts); assertEquals(bytes, f.memory.bytes)
        val empty = Fixture(); empty.memory.fail = true; rejects { runBlocking { empty.begin() } }; assertEquals(0, empty.gets); assertEquals(0, empty.posts)
    }
    @Test fun `draft and refused archives recover completion by GET without rewriting history or the newer operation`() = runBlocking<Unit> {
        for (refused in listOf(false, true)) {
            val f = Fixture(); f.begin()
            val attempt = if (refused) f.store.attempt(f.store.read()) else null
            attempt?.let { f.store.refuse(it, OrdinaryCraftingRefusal(503, "PHASE_E_DISABLED")) }
            val original = f.transport.archiveUnsentOrRefused(f.store.read()) {}.archives.single()
            val newer = f.store.begin(f.store.read(), command(other)).operation
            f.accepted = true; f.transport.checkArchived(key) {}
            val accepted = f.store.read().archives.single()
            assertEquals(original.copy(operation = original.operation.copy(proof = proof(f.command, true))), accepted)
            assertEquals(newer, f.store.read().operation); assertEquals(0, f.posts)
            assertEquals(f.store.read(), OrdinaryCraftingStore(f.memory, identity).read())
            f.completed = true; f.transport.checkArchived(key) {}
            val completed = f.store.read(); assertNotNull(completed.archives.single().operation.proof!!.completion)
            assertEquals(original.copy(operation = original.operation.copy(proof = proof(f.command, true, true))), completed.archives.single())
            attempt?.let { f.store.refuse(it, OrdinaryCraftingRefusal(503, "PHASE_E_DISABLED")) }
            assertEquals(completed, f.store.read())
            for (older in listOf(proof(f.command), proof(f.command, true))) {
                f.read = { _, retain -> raw(older).also(retain) }
                rejects { runBlocking { f.transport.checkArchived(key) {} } }; assertEquals(completed, f.store.read())
            }
            val changed = proof(f.command, true, true).copy(completion = OrdinaryCraftingCompletion("2026-09-22T12:00:35.000Z"), serverNow = "2026-09-22T12:00:35.000Z")
            rejects { f.store.accept(f.command, changed) }; assertEquals(completed, f.store.read()); assertEquals(0, f.posts)
        }
    }
    @Test fun `accepted operations cannot initially be archived as drafts or refusals`() = runBlocking<Unit> {
        for (refused in listOf(false, true)) {
            val f = Fixture(); f.begin()
            if (refused) f.store.refuse(f.store.attempt(f.store.read()), OrdinaryCraftingRefusal(503, "PHASE_E_DISABLED"))
            f.store.accept(f.command, proof(f.command, true)); val saved = f.memory.bytes
            rejects { f.store.archive(f.store.read(), if (refused) "refused" else "unattempted", proof(f.command)) }
            assertEquals(saved, f.memory.bytes); assertNotNull(f.store.read().operation)
        }
    }
    @Test fun `owned archived GET acceptance survives cancellation and retired-session guards`() = runBlocking<Unit> {
        for (cancel in listOf(false, true)) {
            val f = Fixture(); f.begin(); f.transport.archiveUnsentOrRefused(f.store.read()) {}
            val original = f.store.read().archives.single(); val newer = f.store.begin(f.store.read(), command(other)).operation
            var active = true
            f.read = { _, retain -> raw(proof(f.command, true)).also { retain(it); active = false; if (cancel) throw CancellationException("owned historical response") } }
            rejects { runBlocking { f.transport.checkArchived(key) { check(active) } } }
            assertEquals(original.copy(operation = original.operation.copy(proof = proof(f.command, true))), f.store.read().archives.single())
            assertEquals(newer, f.store.read().operation); assertEquals(0, f.posts)
        }
    }
    @Test fun `unknown mismatched and unpersisted archived replies leave the original bytes recoverable`() = runBlocking<Unit> {
        val f = Fixture(); f.begin(); f.transport.archiveUnsentOrRefused(f.store.read()) {}
        val original = f.memory.bytes; f.transport.checkArchived(key) {}; assertEquals(original, f.memory.bytes)
        for (bad in listOf(JsonObject(emptyMap()), raw(proof(f.command, true).copy(idempotencyKey = other)),
            raw(proof(f.command, true).copy(wallet = "11111111111111111111111111111112")),
            raw(proof(f.command, true).let { it.copy(receipt = it.receipt!!.copy(request = f.command.request.copy(baseId = other))) }))) {
            f.read = { _, retain -> bad.also(retain) }
            rejects { runBlocking { f.transport.checkArchived(key) {} } }; assertEquals(original, f.memory.bytes)
        }
        f.read = { _, retain -> raw(proof(f.command, true)).also(retain) }; f.memory.fail = true
        rejects { runBlocking { f.transport.checkArchived(key) {} } }; assertEquals(original, f.memory.bytes)
        f.memory.fail = false; f.transport.checkArchived(key) {}; assertNotNull(f.store.read().archives.single().operation.proof)
        assertEquals(0, f.posts)
    }

    @Test fun `late owned acceptance targets its archived refused original and stale refusal leaves newer intent alone`() = runBlocking<Unit> {
        val f = Fixture(); f.begin()
        lateinit var lateAccept: (JsonObject) -> Unit; lateinit var lateRefuse: (ApiException) -> Unit
        val error = ApiException(503, "PHASE_E_DISABLED", "paused")
        f.send = { _, retain, refusal -> lateAccept = retain; lateRefuse = refusal; refusal(error); throw CancellationException("retired caller") }
        rejects { runBlocking { f.confirm() } }; assertNotNull(f.store.read().operation!!.refusal)
        val archive = f.transport.archiveUnsentOrRefused(f.store.read()) {}.archives.single()
        val newer = f.store.begin(f.store.read(), command(other)).operation
        lateAccept(raw(proof(f.command, true, true))); val retained = f.store.read(); lateRefuse(error)
        assertEquals(retained, f.store.read()); assertEquals(newer, retained.operation)
        assertEquals(archive.copy(operation = archive.operation.copy(proof = proof(f.command, true, true))), retained.archives.single())
        assertEquals(1, f.posts)
    }

    private fun expanded() = view().copy(recipeVersion = 2, catalogueVersion = 2, shardsAvailable = "100",
        recipes = recipes.map { it.copy(recipeVersion = 2) } + listOf(
            OrdinaryCraftingRecipe(2, "craft_climate_kit", 1, 29, listOf(OrdinaryCraftingInput("crafting", "sunstone_blocks", "3"), OrdinaryCraftingInput("crafting", "embercore", "4")), OrdinaryCraftingOutput("climate_kit", "1")),
            OrdinaryCraftingRecipe(2, "craft_expedition_kit", 1, 31, listOf(OrdinaryCraftingInput("crafting", "heartwood_beams", "2"), OrdinaryCraftingInput("crafting", "thornsilk", "3"), OrdinaryCraftingInput("shards", "shards", "7")), OrdinaryCraftingOutput("expedition_kit", "1"))),
        craftingStock = craftingItemIdsV2.map { OrdinaryProtectedStock(it, "100", "0") })
    @Test fun `kit catalogue requires explicit version SHARDS snapshot and exactly eleven rows`() {
        OrdinaryCraftingView.from(raw(expanded())); assertEquals(9, view().recipes.size)
        for (v in listOf(expanded().copy(catalogueVersion = null), expanded().copy(shardsAvailable = null),
            expanded().copy(recipeVersion = 1), expanded().copy(craftingStock = view().craftingStock),
            view().copy(recipes = expanded().recipes))) rejects { v.validate() }
        rejects { OrdinaryCraftingView.from(JsonObject(raw(view()) + ("catalogueVersion" to JsonNull))) }
        rejects { OrdinaryCraftingView.from(JsonObject(raw(expanded()) - "shardsAvailable")) }
    }
    @Test fun `expedition ingredient consent freezes server SHARDS amount and refuses last input shortfall`() {
        val v = expanded(); val c = OrdinaryCraftingCommand.review(identity, v, key, "craft_expedition_kit", 3)
        assertEquals(listOf("6", "9", "21"), c.recipe.inputs.map { it.quantity }); assertEquals(93L, c.recipe.durationSec)
        assertEquals("shards", c.recipe.inputs.last().kind)
        rejects { c.admit(identity, v.copy(shardsAvailable = "20")) }
        rejects { c.copy(recipe = c.recipe.copy(inputs = c.recipe.inputs.dropLast(1))).validate() }
        rejects { c.recipe.copy(recipeVersion = 1).validate() }
        rejects { c.recipe.copy(inputs = c.recipe.inputs.reversed()).validate() }
        val mem = Memory(); val store = OrdinaryCraftingStore(mem, identity); store.begin(store.read(), c)
        assertEquals(c, OrdinaryCraftingStore(mem, identity).read().operation!!.command)
        store.accept(c, proof(c, true, true)); assertEquals(c, store.read().operation!!.command)
    }
    @Test fun `new current catalogue carries legacy pending original but old catalogue cannot hide new job`() {
        val c = command(); val job = OrdinaryCraftingPendingJob(key, c.recipe, start, proof(c, true).receipt!!.readyAt)
        val v = expanded().copy(pendingJobs = listOf(job), craftingStock = expanded().craftingStock.map { if (it.itemId == c.recipe.output.itemId) it.copy(pendingOutput = c.recipe.output.quantity) else it })
        v.validate(); assertEquals(1, v.pendingJobs.single().recipe.recipeVersion)
        val newJob = job.copy(recipe = job.recipe.copy(recipeVersion = 2))
        rejects { view().copy(pendingJobs = listOf(newJob), craftingStock = v.craftingStock.filter { it.itemId in craftingItemIds }).validate() }
    }

    @Test fun `atomic SHARDS shortage is definitive only for first attempt and never clears uncertain retry`() = runBlocking<Unit> {
        val failure = ApiException(422, "ledger.insufficient_funds", "Insufficient SHARDS")
        val first = Fixture(); first.begin(); first.send = { _, _, refusal -> refusal(failure); throw failure }
        rejects { runBlocking { first.confirm() } }; assertEquals("ledger.insufficient_funds", first.store.read().operation!!.refusal!!.code)
        first.transport.archiveUnsentOrRefused(first.store.read()) {}; assertEquals("refused", first.store.read().archives.single().reason)
        val retry = Fixture(); retry.begin(); retry.send = { _, _, _ -> throw IOException("Unknown earlier acceptance") }
        rejects { runBlocking { retry.confirm() } }; retry.send = { _, _, refusal -> refusal(failure); throw failure }
        rejects { runBlocking { retry.confirm() } }; assertNull(retry.store.read().operation!!.refusal)
        assertEquals(2, retry.posts); assertEquals(retry.command, retry.store.read().operation!!.command)
    }

}
