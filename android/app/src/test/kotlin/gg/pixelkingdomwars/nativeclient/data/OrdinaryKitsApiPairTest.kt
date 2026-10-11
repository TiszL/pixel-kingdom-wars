package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Consumes preserved real API bytes. Historical proof recovery deliberately has no current-base authority. */
class OrdinaryKitsApiPairTest {
    @Test fun `actual completed kit receipts restore app custody after restart while current account is unavailable`() = runBlocking<Unit> {
        val pair = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/ordinary-kits-http-pair.json")).readText()).jsonObject
        val current = OrdinaryCraftingView.from(pair.getValue("view").jsonObject)
        for (raw in pair.getValue("receipts").jsonArray.map { it.jsonObject }) {
            val receipt = Json.decodeFromJsonElement<OrdinaryCraftingReceipt>(raw.getValue("receipt"))
            val command = OrdinaryCraftingCommand(receipt.request, receipt.recipe)
            val holder = testHolder(); val old = signedIn(holder)
            val session = AccountSession(current.wallet, old.origin, old.token).also { holder.replace(it) }
            val identity = OrdinaryCraftingIdentity(session.origin, "devnet", current.wallet)
            val journal = OrdinaryCraftingJournal(1, identity, 2, OrdinaryCraftingOperation(command, 2, null, null), emptyList())
            val disk = MemoryStore(Json.encodeToString(OrdinaryCraftingJournal.serializer(), journal))
            val store = OrdinaryCraftingStore(disk, identity); var gets = 0
            val api = object : ApiClient by FakeApiClient() {
                override suspend fun getOrdinaryCrafting(path: String, query: Map<String, String>, guard: () -> Unit,
                    evidence: ((JsonObject) -> Unit)?): JsonObject {
                    assertEquals(command.receiptPath, path); assertTrue(query.isEmpty()); guard(); gets++
                    return raw.also(requireNotNull(evidence))
                }
                override suspend fun postOrdinaryCrafting(path: String, body: JsonObject, guard: () -> Unit,
                    evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject = error("Never resend")
            }
            val repo = OrdinaryCraftingRepository(session, holder, api, store, { null }, { 0L }, { null },
                { error("Historical receipt cannot require current account") }, { error("No current inventory publication") }, { false })
            repo.reviewSaved()
            assertEquals(1, gets); assertNull(repo.state.value.review); assertNotNull(store.read().operation!!.proof!!.completion)
            assertEquals(command, OrdinaryCraftingStore(disk, identity).read().operation!!.command)
            assertEquals(receipt, repo.state.value.journal.operation!!.proof!!.receipt)
        }
    }
}
