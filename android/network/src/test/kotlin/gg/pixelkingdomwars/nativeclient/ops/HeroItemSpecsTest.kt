package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The hero and item money operations mirror apps/api/src/game/{heroes,items}.ts: namespaced keys the
 * server replays as `duplicate`, matching hero receipts, and roster/refusal rules that decide when a saved intent
 * may be retired. Each test names the money invariant it protects. */
class HeroUpgradeSpecTest {
    private val intent = HeroUpgradeSpec.intent(WALLET, BASE, "vex", "hero-upgrade-key", level = 2, costKeep = "2500").copy(attempted = true)
    private fun roster(level: Int, hero: String = "vex") = buildJsonObject { put("heroes", buildJsonArray { add(buildJsonObject { put("hero", hero); put("level", level); put("tierName", "Shardborn") }) }) }

    @Test fun `the intent freezes the expected level and maximum price with the original key and base`() {
        assertEquals("/heroes/vex/upgrade", intent.path)
        assertEquals(buildJsonObject { put("idempotencyKey", "hero-upgrade-key"); put("baseId", BASE)
            put("consent", buildJsonObject { put("expectedLevel", 1); put("maxCostKeep", "2500") }) }, intent.body)
        assertEquals("Upgrade VEX to level 2", intent.label)
        assertThrows(IllegalArgumentException::class.java) { HeroUpgradeSpec.intent(WALLET, BASE, "Vex Two", "k-00000000", 2, "1") }
        assertThrows(IllegalArgumentException::class.java) { HeroUpgradeSpec.intent(WALLET, BASE, "vex", "k-00000000", 1, "1") }
    }
    @Test fun `an acknowledgement binds the hero and never a charge above the printed price`() {
        val ok = HeroUpgradeSpec.acknowledge(intent, buildJsonObject { put("hero", "vex"); put("level", 2); put("tierName", "Shardborn"); put("spentKeep", "2500"); put("duplicate", false) })
        assertEquals(2, ok.level); assertEquals("2500", ok.spentKeep); assertFalse(ok.replayed)
        val replay = HeroUpgradeSpec.acknowledge(intent, buildJsonObject { put("hero", "vex"); put("level", 2); put("spentKeep", "0"); put("duplicate", true) })
        assertTrue("A replay moved no KEEP", replay.replayed); assertEquals("0", replay.spentKeep)
        assertThrows(IllegalArgumentException::class.java) { HeroUpgradeSpec.acknowledge(intent, buildJsonObject { put("hero", "theodor"); put("level", 2); put("spentKeep", "1"); put("duplicate", false) }) }
        assertThrows(IllegalArgumentException::class.java) { HeroUpgradeSpec.acknowledge(intent, buildJsonObject { put("hero", "vex"); put("level", 1); put("spentKeep", "0"); put("duplicate", false) }) }
        assertThrows(IllegalArgumentException::class.java) { HeroUpgradeSpec.acknowledge(intent, buildJsonObject { put("hero", "vex"); put("level", 2); put("spentKeep", "2501"); put("duplicate", false) }) }
    }
    @Test fun `a roster level never proves which request bought it`() {
        for (level in listOf(1, 2, 3)) assertEquals(Receipt.Unsupported, HeroUpgradeSpec.decodeReceipt(intent, roster(level)))
        assertEquals("/heroes/vex/upgrade/receipt", HeroUpgradeSpec.receiptRequest(intent).path)
        assertEquals(mapOf("idempotencyKey" to "hero-upgrade-key", "baseId" to BASE, "expectedLevel" to "1", "maxCostKeep" to "2500"), HeroUpgradeSpec.receiptRequest(intent).query)
        assertFalse("Retry could buy a later level if the original POST never committed", InterruptedIntent(intent).retryable)
    }
    @Test fun `a replay refusal cannot disprove a previously committed upgrade`() = runBlocking {
        assertFalse(HeroUpgradeSpec.disprovesAcceptance(ApiException(404, null, "base not found")))
        assertFalse("A landed max-level upgrade answers a retry with 422 before the ledger's duplicate branch", HeroUpgradeSpec.disprovesAcceptance(ApiException(422, null, "already at max level 20")))
        val store = PendingIntentStore(MemoryStore()); store.create(intent)
        val transport = ScriptedTransport(onPost = { _, _ -> throw ApiException(422, null, "already at max level 20") })
        val op = MoneyOp(HeroUpgradeSpec, store, transport)
        assertThrows(ApiException::class.java) { runBlocking { op.retry(WALLET) {} } }
        assertNotNull("The refused retry cannot disprove an earlier commit", store.get(IntentKind.HERO_UPGRADE, WALLET))
        transport.onGet = { _, _ -> roster(2) }
        assertEquals(Receipt.Unsupported, op.observe(WALLET) {})
        assertNotNull("A max level reached elsewhere is not this key's receipt", store.get(IntentKind.HERO_UPGRADE, WALLET))
    }
}

class HeroRecoverySpecTest {
    private val until = "2026-09-11T10:00:00.000Z"
    private val intent = HeroRecoverySpec.intent(WALLET, BASE, "theodor", "hero-recovery-key", costKeep = "7", recoveryUntil = until).copy(attempted = true)
    private fun roster(available: Boolean, recoveryUntil: String?) = buildJsonObject { put("heroes", buildJsonArray { add(buildJsonObject {
        put("hero", "theodor"); put("level", 1); put("available", available); put("recoveryUntil", recoveryUntil?.let(::JsonPrimitive) ?: JsonNull) }) }) }

    @Test fun `the acknowledgement requires the release and a charge within the printed price`() {
        val ok = HeroRecoverySpec.acknowledge(intent, buildJsonObject { put("hero", "theodor"); put("spentKeep", "5"); put("duplicate", false); put("recoveryUntil", JsonNull) })
        assertEquals("5", ok.spentKeep)
        assertThrows(IllegalArgumentException::class.java) { HeroRecoverySpec.acknowledge(intent, buildJsonObject { put("hero", "theodor"); put("spentKeep", "8"); put("duplicate", false); put("recoveryUntil", JsonNull) }) }
        assertThrows(IllegalArgumentException::class.java) { HeroRecoverySpec.acknowledge(intent, buildJsonObject { put("hero", "theodor"); put("spentKeep", "5"); put("duplicate", false); put("recoveryUntil", until) }) }
    }
    @Test fun `expiry or a new injury never proves this recovery payment`() {
        assertEquals(Receipt.Unsupported, HeroRecoverySpec.decodeReceipt(intent, roster(available = false, recoveryUntil = until)))
        assertEquals(Receipt.Unsupported, HeroRecoverySpec.decodeReceipt(intent, roster(available = true, recoveryUntil = null)))
        assertEquals(Receipt.Unsupported, HeroRecoverySpec.decodeReceipt(intent, roster(available = false, recoveryUntil = "2026-09-12T10:00:00.000Z")))
        assertEquals("/heroes/theodor/recovery/speedup/receipt", HeroRecoverySpec.receiptRequest(intent).path)
        assertEquals(until, HeroRecoverySpec.receiptRequest(intent).query["recoveryUntil"])
        assertFalse("Retry could pay for a different injury", InterruptedIntent(intent).retryable)
    }
    @Test fun `saved hero POST receipt hydrates without another mutation`() = runBlocking {
        val receipt = ReceiptDocument.fromPost(buildJsonObject { put("hero", "theodor"); put("spentKeep", "5"); put("duplicate", false); put("recoveryUntil", JsonNull) })
        val store = PendingIntentStore(MemoryStore()); store.create(intent.copy(receipt = receipt))
        val transport = ScriptedTransport(); var hydrated = false
        assertTrue(MoneyOp(HeroRecoverySpec, store, transport).observe(WALLET) { hydrated = true } is Receipt.Accepted)
        assertTrue(hydrated); assertTrue(transport.posts.isEmpty()); assertNull(store.get(IntentKind.HERO_RECOVERY, WALLET))
    }

}

class ItemBuySpecTest {
    private val intent = ItemBuySpec.intent(WALLET, BASE, "keg_of_haste", "item-buy-key", costKeep = "60", name = "KEG OF HASTE").copy(attempted = true)

    @Test fun `the body names the item and key and the acknowledgement reports the server charge`() {
        assertEquals(buildJsonObject { put("itemId", "keg_of_haste"); put("idempotencyKey", "item-buy-key"); put("baseId", BASE) }, intent.body)
        val ok = ItemBuySpec.acknowledge(intent, buildJsonObject { put("itemId", "keg_of_haste"); put("costKeep", 60); put("duplicate", false) })
        assertEquals("A JSON-number price keeps its exact text", "60", ok.costKeep); assertFalse(ok.replayed)
        assertThrows(IllegalArgumentException::class.java) { ItemBuySpec.acknowledge(intent, buildJsonObject { put("itemId", "powder_charge"); put("costKeep", 60); put("duplicate", false) }) }
        assertEquals(Receipt.Unsupported, ItemBuySpec.decodeReceipt(intent, buildJsonObject {})); assertNull(ItemBuySpec.receiptRequest(intent))
    }
    @Test fun `a lost purchase reply stays unresolved when a replay fails before duplicate lookup`() = runBlocking {
        val store = PendingIntentStore(MemoryStore()); val transport = ScriptedTransport(); val observer = ReceiptObserver(store)
        val op = MoneyOp(ItemBuySpec, store, transport); observer.register(op) {}
        transport.onPost = { _, _ -> throw java.io.IOException("lost") }
        assertThrows(java.io.IOException::class.java) { runBlocking { op.submit(intent.copy(attempted = false)) {} } }
        observer.refresh(WALLET)
        val saved = observer.interrupted.value.single()
        assertTrue("The same namespaced key replays as duplicate: retry is the recovery", saved.retryable); assertFalse(saved.closable)
        assertEquals(Receipt.Unsupported, op.observe(WALLET) {})
        for ((status, message) in listOf(422 to "requires one level 20 hero", 404 to "base not found", 422 to "inventory full")) {
            transport.onPost = { _, _ -> throw ApiException(status, null, message) }
            assertThrows(ApiException::class.java) { runBlocking { op.retry(WALLET) {} } }
            assertNotNull("A gate can reject before checking the committed key; another purchase must remain blocked", store.get(IntentKind.ITEM_BUY, WALLET))
        }
        assertTrue(transport.posts.all { it.second == intent.body })
    }
    @Test fun `a definitive first purchase refusal still allows a fresh reviewed purchase`() = runBlocking {
        val store = PendingIntentStore(MemoryStore())
        val transport = ScriptedTransport(onPost = { _, _ -> throw ApiException(422, null, "inventory full") })
        assertThrows(ApiException::class.java) { runBlocking { MoneyOp(ItemBuySpec, store, transport).submit(intent.copy(attempted = false)) {} } }
        assertNull(store.get(IntentKind.ITEM_BUY, WALLET))
    }
    @Test fun `a retry that the server replays as duplicate hydrates then retires without a second charge`() = runBlocking {
        val store = PendingIntentStore(MemoryStore()); store.create(intent)
        val transport = ScriptedTransport(onPost = { _, _ -> buildJsonObject { put("itemId", "keg_of_haste"); put("costKeep", "60"); put("duplicate", true) } })
        var hydrated = 0
        val accepted = MoneyOp(ItemBuySpec, store, transport).retry(WALLET) { hydrated++ }
        assertTrue(accepted.value.replayed); assertEquals(1, hydrated); assertNull(store.get(IntentKind.ITEM_BUY, WALLET))
    }
}

class ItemUseSpecTest {
    private val intent = ItemUseSpec.intent(WALLET, BASE, "keg_of_haste", "item-use-key", name = "KEG OF HASTE").copy(attempted = true)

    @Test fun `the acknowledgement binds the used item and its effect`() {
        val ok = ItemUseSpec.acknowledge(intent, buildJsonObject { put("used", "keg_of_haste"); put("left", 1); put("effect", buildJsonObject { put("finishedJobId", BASE) }) })
        assertEquals(1, ok.left); assertFalse(ok.replayed)
        assertThrows(IllegalArgumentException::class.java) { ItemUseSpec.acknowledge(intent, buildJsonObject { put("used", "finishers_seal"); put("left", 1); put("effect", buildJsonObject {}) }) }
        assertThrows(IllegalArgumentException::class.java) { ItemUseSpec.acknowledge(intent, buildJsonObject { put("used", "keg_of_haste"); put("left", -1); put("effect", buildJsonObject {}) }) }
    }
    @Test fun `the uncoded duplicate 409 is the server's own word that this use landed`() = runBlocking {
        val store = PendingIntentStore(MemoryStore()); store.create(intent)
        val transport = ScriptedTransport(onPost = { _, _ -> throw ApiException(409, null, "duplicate use request — refresh your inventory") })
        var hydrated = 0
        val resolved = MoneyOp(ItemUseSpec, store, transport).retry(WALLET) { hydrated++ }
        assertTrue(resolved.value.replayed); assertNull(resolved.value.left); assertEquals("Hydrated before the intent was retired", 1, hydrated)
        assertNull(store.get(IntentKind.ITEM_USE, WALLET))
        assertEquals(resolved.value, ItemUseSpec.restore(intent, resolved.document))
        assertNull("A coded 409 (BASE_ID_REQUIRED) is an ordinary refusal", ItemUseSpec.resolveRejection(intent, ApiException(409, "BASE_ID_REQUIRED", "baseId is required")))
        assertNull(ItemUseSpec.resolveRejection(intent, ApiException(409, null, "loadout changed")))
    }
    @Test fun `uncertain item-use retries remain saved when mutable gates refuse before duplicate lookup`() = runBlocking {
        val store = PendingIntentStore(MemoryStore()); store.create(intent)
        val transport = ScriptedTransport(); val op = MoneyOp(ItemUseSpec, store, transport)
        for (error in listOf(ApiException(404, "BASE_NOT_OWNED", "base not owned or inactive"),
                ApiException(404, null, "unknown item"), ApiException(422, null, "item is not usable"),
                ApiException(422, null, "that build is already done — refresh your base"),
                ApiException(409, "BASE_ID_REQUIRED", "baseId is required"))) {
            assertFalse(ItemUseSpec.disprovesAcceptance(error))
            transport.onPost = { _, _ -> throw error }
            assertThrows(ApiException::class.java) { runBlocking { op.retry(WALLET) {} } }
            assertNotNull("The current base/item gate cannot prove an earlier use did not commit", store.get(IntentKind.ITEM_USE, WALLET))
        }
        assertTrue(transport.posts.all { it.second == intent.body })
    }
    @Test fun `a definitive first item-use refusal permits a new reviewed use`() = runBlocking {
        for (status in listOf(404, 422)) {
            val store = PendingIntentStore(MemoryStore())
            val transport = ScriptedTransport(onPost = { _, _ -> throw ApiException(status, null, "item cannot be used") })
            assertThrows(ApiException::class.java) { runBlocking { MoneyOp(ItemUseSpec, store, transport).submit(intent.copy(attempted = false)) {} } }
            assertNull(store.get(IntentKind.ITEM_USE, WALLET))
        }
    }
}
