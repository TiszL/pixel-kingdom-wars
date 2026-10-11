package gg.pixelkingdomwars.nativeclient.boundcosmetics

import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.identity
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.proof
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.command
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.edit
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticFixtures.rejects
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import java.io.IOException
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BoundCosmeticStoreTest {
    private class Memory : SecretStore {
        var bytes: String? = null; var writes = 0; var failRead = false; var failWrite = false
        override fun read(): String? { if (failRead) throw IOException("locked"); return bytes }
        override fun write(value: String) { if (failWrite) throw IOException("disk full"); writes++; bytes = value }
        override fun clear() = error("Saved originals must never be cleared")
    }
    @Test fun `original command is durable before attempt and survives a lost reply and reopening`() {
        val memory = Memory(); val store = BoundCosmeticStore(memory, identity); val c = command()
        val draft = store.begin(store.read(), c); assertFalse(draft.operation!!.attempted); assertEquals(c, BoundCosmeticStore(memory, identity).read().operation!!.command)
        val attempted = store.attempt(draft); assertTrue(attempted.operation!!.attempted)
        val reopened = BoundCosmeticStore(memory, identity); assertEquals(attempted, reopened.read())
        assertEquals(proof(), reopened.accept(c, proof()).operation!!.proof)
    }
    @Test fun `unknown attempted outcome cannot archive disappear or gain another key`() {
        val memory = Memory(); val store = BoundCosmeticStore(memory, identity); val attempted = store.attempt(store.begin(store.read(), command()))
        val bytes = memory.bytes; rejects { store.archive(attempted) }
        rejects { store.begin(attempted, command().copy(request = command().request.copy(idempotencyKey = "00000000-0000-4000-8000-000000000019"))) }
        rejects { store.accept(command(), proof().copy(status = "unknown", receipt = null, completion = null)) }
        assertEquals(bytes, memory.bytes); assertEquals(attempted, store.read())
    }
    @Test fun `explicit further attempt keeps exact original terms and stale revision fails`() {
        val memory = Memory(); val store = BoundCosmeticStore(memory, identity); val draft = store.begin(store.read(), command())
        val first = store.attempt(draft); val second = store.attempt(first)
        assertEquals(first.operation, second.operation); assertEquals(first.revision + 1, second.revision)
        rejects { store.attempt(first) }; rejects { store.archive(draft) }; assertEquals(second, store.read())
    }
    @Test fun `accepted original can recover completion in archives without current base or provider`() {
        val store = BoundCosmeticStore(Memory(), identity); val c = command(); store.begin(store.read(), c)
        val pending = proof().copy(completion = null); val accepted = store.accept(c, pending)
        assertTrue(accepted.operation!!.attempted); val archive = store.archive(accepted); assertNull(archive.operation)
        val completed = store.accept(c, proof()); assertEquals(proof(), completed.archives.single().proof)
        assertNull(completed.operation)
    }
    @Test fun `late acceptance after unused draft archival is retained under the same original`() {
        val store = BoundCosmeticStore(Memory(), identity); val c = command(); val archived = store.archive(store.begin(store.read(), c))
        assertFalse(archived.archives.single().attempted)
        val result = store.accept(c, proof()); assertTrue(result.archives.single().attempted); assertEquals(c, result.archives.single().command)
        rejects { store.begin(result, c) }
    }
    @Test fun `receipt and completion never change disappear or cross original identity`() {
        val memory = Memory(); val store = BoundCosmeticStore(memory, identity); val c = command(); store.begin(store.read(), c); val accepted = store.accept(c, proof()); val bytes = memory.bytes
        rejects { store.accept(c, proof().copy(completion = null)) }
        rejects { store.accept(c, proof().copy(receipt = proof().receipt!!.copy(blueprint = proof().receipt!!.blueprint.copy(jobId = "00000000-0000-4000-8000-000000000020")))) }
        rejects { store.accept(c.copy(recipe = c.recipe.copy(durationSec = 1)), proof()) }
        rejects { store.accept(c, proof().copy(wallet = "11111111111111111111111111111111")) }
        assertEquals(bytes, memory.bytes); assertEquals(accepted, store.read())
    }
    @Test fun `corrupt foreign and unreadable encrypted journals remain untouched`() {
        val memory = Memory(); val store = BoundCosmeticStore(memory, identity); store.begin(store.read(), command()); val good = memory.bytes!!
        val raw = cosmeticJson.parseToJsonElement(good).jsonObject
        for (bad in listOf("not json", edit(raw, "revision", JsonPrimitive("1")).toString(), edit(raw, "revision", JsonPrimitive(-1)).toString(), edit(raw, "extra", JsonNull).toString())) {
            memory.bytes = bad; val writes = memory.writes; rejects { store.read() }; assertEquals(bad, memory.bytes); assertEquals(writes, memory.writes)
        }
        memory.bytes = good; rejects { BoundCosmeticStore(memory, identity.copy(origin = "https://other.test")).read() }
        rejects { BoundCosmeticStore(memory, identity.copy(cluster = "mainnet-beta")).read() }
        memory.failRead = true; rejects { store.read() }; assertEquals(good, memory.bytes)
    }
    @Test fun `failed durable write never advances a draft or attempt`() {
        val memory = Memory(); val store = BoundCosmeticStore(memory, identity); memory.failWrite = true
        rejects { store.begin(store.read(), command()) }; assertNull(memory.bytes)
        memory.failWrite = false; val draft = store.begin(store.read(), command()); val bytes = memory.bytes
        memory.failWrite = true; rejects { store.attempt(draft) }; assertEquals(bytes, memory.bytes); assertEquals(draft, store.read())
    }
    @Test fun `duplicate keys attempted archives and synthetic accepted without attempt fail closed`() {
        val memory = Memory(); val store = BoundCosmeticStore(memory, identity); val draft = store.begin(store.read(), command())
        val op = draft.operation!!
        fun corrupted(journal: BoundCosmeticJournal) { memory.bytes = cosmeticJson.encodeToString(BoundCosmeticJournal.serializer(), journal); rejects { store.read() } }
        corrupted(draft.copy(archives = listOf(op)))
        corrupted(draft.copy(operation = null, archives = listOf(op.copy(attempted = true))))
        corrupted(draft.copy(operation = op.copy(proof = proof())))
    }
    @Test fun `store snapshots own serialized terms and revision overflow cannot mutate evidence`() {
        val memory = Memory(); val store = BoundCosmeticStore(memory, identity); val source = command(); val inputs = source.recipe.inputs.toMutableList()
        val c = source.copy(recipe = source.recipe.copy(inputs = inputs)); val draft = store.begin(store.read(), c)
        inputs.clear(); assertEquals(source, store.read().operation!!.command); assertEquals(source, draft.operation!!.command)
        memory.bytes = cosmeticJson.encodeToString(BoundCosmeticJournal.serializer(), draft.copy(revision = Long.MAX_VALUE)); val bytes = memory.bytes
        rejects { store.attempt(store.read()) }; assertEquals(bytes, memory.bytes)
    }
}
