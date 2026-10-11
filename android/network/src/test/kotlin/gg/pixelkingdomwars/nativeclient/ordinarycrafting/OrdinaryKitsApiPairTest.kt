package gg.pixelkingdomwars.nativeclient.ordinarycrafting

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Byte-for-byte normal authenticated HTTP results from real common-route earning, refining and
 * an untaxed cache SHARDS ledger. This parses/reopens native custody; it does not run Android. */
class OrdinaryKitsApiPairTest {
    private val pair = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/ordinary-kits-http-pair.json")).readText()).jsonObject
    @Test fun `actual kit outputs and SHARDS ingredient survive exact original recovery without live admission`() = runBlocking<Unit> {
        val current = OrdinaryCraftingView.from(pair.getValue("view").jsonObject)
        val legacy = OrdinaryCraftingView.from(pair.getValue("legacy").jsonObject)
        assertEquals(11, current.recipes.size); assertEquals(9, legacy.recipes.size)
        assertEquals("50", current.shardsAvailable)
        val identity = OrdinaryCraftingIdentity("https://game.test", "devnet", current.wallet)
        for (raw in pair.getValue("receipts").jsonArray.map { it.jsonObject }) {
            val receipt = ordinaryJson.decodeFromJsonElement<OrdinaryCraftingReceipt>(raw.getValue("receipt"))
            val command = OrdinaryCraftingCommand(receipt.request, receipt.recipe)
            assertEquals(command.recipe, current.recipes.single { it.recipeId == command.request.recipeId }.batch(command.request.quantity))
            class Memory : SecretStore { var bytes: String? = null; override fun read() = bytes
                override fun write(value: String) { bytes = value }; override fun clear() { error("Do not clear originals") } }
            val disk = Memory(); val store = OrdinaryCraftingStore(disk, identity)
            store.begin(store.read(), command); store.attempt(store.read())
            val cold = OrdinaryCraftingStore(disk, identity); var gets = 0
            val transport = OrdinaryCraftingTransport(cold, object : OrdinaryCraftingPort {
                override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
                    assertEquals(command.receiptPath, path); guard(); gets++; return raw.also(retain)
                }
                override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit,
                    refusal: (gg.pixelkingdomwars.nativeclient.network.ApiException) -> Unit): JsonObject = error("Recovery cannot POST")
            })
            transport.check {}; val proof = requireNotNull(cold.read().operation!!.proof)
            assertEquals(receipt, proof.receipt); assertNotNull(proof.completion); assertEquals(1, gets)
            assertEquals(command, cold.read().operation!!.command)
        }
    }
}
