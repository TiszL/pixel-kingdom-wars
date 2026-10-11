package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.GameCurrency
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ops.*
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The reviewed currency is authority: neither old KEEP affordability nor a fresh fallback may change it. */
class HeroCurrencyRepositoryTest {
    private class Fixture {
        val wire = FakeApiClient()
        val holder = testHolder()
        val session = signedIn(holder)
        val store = PendingIntentStore(MemoryStore())
        val observer = ReceiptObserver(store)
        var selected: String? = BASE_ID
        var generation = 0L
        var keys = 0
        var level = 1
        var recoveryUntil: String? = null
        var cost = "2500"
        var gems = "9000"
        var keep = "0"
        var gemsEnabled = true
        var nativeExact = true
        var balancesExact = true
        var receipts = true
        var actionsAllowed = true
        var beforeEnqueue: () -> Unit = {}
        var homeReads = 0
        var accountReads = 0
        var hydrate: suspend () -> Unit = {}
        var afterAccount: suspend () -> Unit = {}
        var afterReceipt: () -> Unit = {}
        val commands = mutableListOf<Triple<String, JsonObject, GameCurrency>>()
        var postExact: suspend (String, JsonObject, GameCurrency) -> JsonObject = { path, _, _ ->
            if (path.endsWith("/upgrade")) level++ else recoveryUntil = null
            json("""{"hero":"vex","level":$level,"spentKeep":"$cost","duplicate":false,"recoveryUntil":null}""")
        }
        val api = object : ApiClient by wire {
            override suspend fun postMoneyCommand(path: String, body: JsonObject, currency: GameCurrency?, refusal: (gg.pixelkingdomwars.nativeclient.network.ApiException) -> Unit, requireCurrent: () -> Unit): JsonObject {
                beforeEnqueue(); requireCurrent()
                commands += Triple(path, body, requireNotNull(currency))
                return postExact(path, body, requireNotNull(currency))
            }
        }
        val repository = LiveArmyRepository(session, holder, api, store, observer, { selected }, { null }, { BaseState() },
            { homeReads++; hydrate() }, newKey = { "hero-exact-${++keys}" },
            refreshAccount = { accountReads++; afterAccount() }, baseGeneration = { generation }, heroActionsAllowed = { actionsAllowed })

        init {
            wire.onGet("/native/capabilities") {
                json("""{"economy":{"gameCurrency":{"version":1,"exactSpendCurrency":${if (nativeExact) 1 else 2}}}}""")
            }
            wire.onGet("/balances") { query ->
                assertEquals("Money must be checked for the selected kingdom", selected, query["baseId"])
                balances()
            }
            wire.onGet("/heroes") { query -> assertEquals(selected, query["baseId"]); heroes() }
            for (kind in listOf(IntentKind.HERO_UPGRADE, IntentKind.HERO_RECOVERY)) {
                val path = if (kind == IntentKind.HERO_UPGRADE) "/heroes/vex/upgrade/receipt" else "/heroes/vex/recovery/speedup/receipt"
                wire.onGet(path) { query ->
                    val saved = requireNotNull(store.get(kind, WALLET))
                    assertEquals(saved.baseId, query["baseId"])
                    assertEquals(saved.idempotencyKey, query["idempotencyKey"])
                    receipt(saved).also { afterReceipt() }
                }
            }
        }

        fun balances() = json("""{"keep":"$keep","gems":"$gems","shards":"0","keepRate":1,"features":{
            "gameCurrency":{"version":1,"exactSpendCurrency":${if (balancesExact) 1 else 2}},
            "gems":{"version":${if (gemsEnabled) 1 else 0},"receipts":1}}}""")

        // Legacy affordable remains false deliberately: Gems can pay even when custodial KEEP cannot.
        fun heroes() = json("""{"features":{"heroConsent":{"version":1},"heroReceipts":{"version":${if (receipts) 1 else 2}}},
            "heroes":[{"hero":"vex","name":"Vex","title":"The Shardborn","altar":"heroaltar","unlockKeepLevel":5,
            "recruitCostKeep":"3000","recruitItemId":"item_hero_vex","recruited":true,"level":$level,"tier":1,
            "tierName":"Shardborn","hp":1400,"dps":95,"recoveryUntil":${recoveryUntil?.let { "\"$it\"" } ?: "null"},
            "available":${recoveryUntil == null},"gear":null,"recoveryFinishNow":${recoveryUntil?.let {
                "{\"remainingSec\":40,\"costKeep\":\"$cost\",\"affordable\":false}"
            } ?: "null"},"maxLevel":20,"next":{"level":${level + 1},"tier":1,"tierName":"Shardborn","hp":1500,"dps":101,
            "costKeep":"$cost"},"affordable":false}],"keepBalance":"$keep","keepLevel":5}""")

        fun saved(kind: String = IntentKind.HERO_UPGRADE) = store.get(kind, WALLET)
        fun switchAwayAndBack() { selected = OTHER_BASE; generation++; selected = BASE_ID; generation++ }
    }

    @Test fun `fresh Gems review ignores legacy KEEP affordability and saves exact terms before sending`() = runBlocking<Unit> {
        val f = Fixture()
        f.repository.reviewHeroUpgrade("vex")
        val review = requireNotNull(f.repository.state.value.heroReview)
        assertEquals("GEMS", review.intent.expectedCurrency)
        assertEquals(BASE_ID, review.intent.baseId)
        assertEquals(json("""{"expectedLevel":1,"maxCostKeep":"2500"}"""), review.intent.body["consent"])
        assertFalse(f.repository.state.value.heroes!!.heroes.single().affordable)
        assertNull("A review alone never creates a payable journal entry", f.saved())
        f.postExact = { _, body, currency ->
            val durable = requireNotNull(f.saved())
            assertTrue("The attempted marker precedes the wire", durable.attempted)
            assertEquals(review.intent.body, body); assertEquals(body, durable.body)
            assertEquals(GameCurrency.GEMS, currency); assertEquals("GEMS", durable.expectedCurrency)
            f.level = 2
            json("""{"hero":"vex","level":2,"spentKeep":"2500","duplicate":false}""")
        }
        f.hydrate = {
            val document = requireNotNull(f.saved()?.receipt)
            assertEquals("Proof must survive a crash during balance hydration", ReceiptDocument.SOURCE_RECEIPT, ReceiptDocument.source(document))
        }
        f.repository.confirmHeroSpend()
        assertEquals(1, f.commands.size); assertTrue(f.wire.posts.isEmpty())
        assertNull(f.saved()); assertNull(f.repository.state.value.heroReview)
        assertEquals(2, f.repository.state.value.heroes!!.heroes.single().level)
        assertTrue(f.homeReads > 0); assertTrue(f.accountReads >= 2)
    }

    @Test fun `KEEP is reviewed only when it alone covers the price and a combined balance cannot pay`() = runBlocking<Unit> {
        val f = Fixture(); f.gems = "2499"; f.keep = "2500"
        f.repository.reviewHeroUpgrade("vex")
        assertEquals("KEEP", f.repository.state.value.heroReview!!.intent.expectedCurrency)
        f.repository.dismissHeroReview(); f.keep = "1"
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.reviewHeroUpgrade("vex") } }
        assertNull(f.repository.state.value.heroReview); assertNull(f.saved()); assertTrue(f.commands.isEmpty())
    }

    @Test fun `unsupported native balances or Hero receipt contracts forbid creating a spend`() = runBlocking<Unit> {
        for (missing in 0..2) {
            val f = Fixture()
            when (missing) { 0 -> f.nativeExact = false; 1 -> f.balancesExact = false; else -> f.receipts = false }
            assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.reviewHeroUpgrade("vex") } }
            assertNull(f.repository.state.value.heroReview); assertNull(f.saved()); assertTrue(f.commands.isEmpty())
        }
    }

    @Test fun `Gems draining or pausing after review never silently selects plentiful KEEP`() = runBlocking<Unit> {
        for (paused in listOf(false, true)) {
            val f = Fixture(); f.keep = "9000"
            f.repository.reviewHeroUpgrade("vex")
            assertEquals("GEMS", f.repository.state.value.heroReview!!.intent.expectedCurrency)
            if (paused) f.gemsEnabled = false else f.gems = "2499"
            assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.confirmHeroSpend() } }
            assertTrue(f.commands.isEmpty()); assertTrue(f.wire.posts.isEmpty()); assertNull(f.saved())
        }
    }

    @Test fun `a round trip to another base invalidates the review even when the selected id matches`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.reviewHeroUpgrade("vex"); f.switchAwayAndBack()
        assertThrows(Exception::class.java) { runBlocking { f.repository.confirmHeroSpend() } }
        assertTrue(f.commands.isEmpty()); assertNull(f.saved())
    }

    @Test fun `an account refresh which changes base generation cannot publish a late review`() = runBlocking<Unit> {
        val f = Fixture(); f.afterAccount = { f.switchAwayAndBack() }
        assertThrows(Exception::class.java) { runBlocking { f.repository.reviewHeroUpgrade("vex") } }
        assertNull(f.repository.state.value.heroReview); assertTrue(f.commands.isEmpty()); assertNull(f.saved())
    }

    @Test fun `a superseded session cannot confirm an earlier wallet review`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.reviewHeroUpgrade("vex"); f.holder.replace(null)
        assertThrows(SessionSupersededException::class.java) { runBlocking { f.repository.confirmHeroSpend() } }
        assertTrue(f.commands.isEmpty()); assertNull(f.saved())
    }

    @Test fun `fresh level or higher price changes require another review before POST`() = runBlocking<Unit> {
        for (levelChanged in listOf(false, true)) {
            val f = Fixture(); f.repository.reviewHeroUpgrade("vex")
            if (levelChanged) f.level++ else f.cost = "2501"
            assertThrows(Exception::class.java) { runBlocking { f.repository.confirmHeroSpend() } }
            assertTrue(f.commands.isEmpty()); assertNull(f.saved())
        }
    }

    @Test fun `recovery pins the original episode and ceiling while accepting a lower real charge`() = runBlocking<Unit> {
        val f = Fixture(); f.recoveryUntil = UNTIL; f.cost = "7"
        f.repository.reviewHeroRecovery("vex")
        val reviewed = requireNotNull(f.repository.state.value.heroReview)
        assertEquals(IntentKind.HERO_RECOVERY, reviewed.intent.kind)
        assertEquals(json("""{"recoveryUntil":"$UNTIL","maxCostKeep":"7"}"""), reviewed.intent.body["consent"])
        f.cost = "5"
        f.wire.onGet("/heroes/vex/recovery/speedup/receipt") {
            receipt(requireNotNull(f.saved(IntentKind.HERO_RECOVERY)), amount = "5")
        }
        f.repository.confirmHeroSpend()
        assertEquals(reviewed.intent.body, f.commands.single().second)
        assertEquals(GameCurrency.GEMS, f.commands.single().third)
        assertNull(f.saved(IntentKind.HERO_RECOVERY)); assertNull(f.repository.state.value.heroes!!.heroes.single().recoveryUntil)

        val later = Fixture(); later.recoveryUntil = UNTIL; later.cost = "7"
        later.repository.reviewHeroRecovery("vex"); later.recoveryUntil = "2026-09-23T10:00:00.000Z"
        assertThrows(Exception::class.java) { runBlocking { later.repository.confirmHeroSpend() } }
        assertTrue(later.commands.isEmpty()); assertNull(later.saved(IntentKind.HERO_RECOVERY))
    }

    @Test fun `a lost POST reply blocks every replacement Hero review without erasing original terms`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.reviewHeroUpgrade("vex")
        val original = requireNotNull(f.repository.state.value.heroReview).intent
        f.postExact = { _, _, _ -> throw IOException("lost reply") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.confirmHeroSpend() } }
        val pending = requireNotNull(f.saved())
        assertEquals(original.body, pending.body); assertEquals("GEMS", pending.expectedCurrency); assertTrue(pending.attempted)
        f.gemsEnabled = false; f.keep = "9000"
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.reviewHeroUpgrade("vex") } }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.reviewHeroRecovery("vex") } }
        assertEquals(pending, f.saved()); assertEquals(1, f.commands.size)
    }

    @Test fun `an explicit first attempt currency refusal retires only its proven no debit command`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.reviewHeroUpgrade("vex")
        f.postExact = { _, _, _ -> throw ApiException(409, "CURRENCY_CONSENT_CHANGED", "Currency changed before debit", details = json("""{"expectedCurrency":"GEMS"}""")) }
        assertThrows(ApiException::class.java) { runBlocking { f.repository.confirmHeroSpend() } }
        assertNull(f.saved()); assertEquals(1, f.commands.size)
        f.repository.reviewHeroUpgrade("vex")
        assertNotNull(f.repository.state.value.heroReview)
    }

    @Test fun `successful POST followed by unavailable receipt stays pending rather than enabling another payment`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.reviewHeroUpgrade("vex")
        f.wire.onGet("/heroes/vex/upgrade/receipt") { throw ApiException(404, null, "receipt route unavailable") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.confirmHeroSpend() } }
        val saved = requireNotNull(f.saved())
        assertTrue(saved.attempted); assertNull(saved.receipt); assertEquals("GEMS", saved.expectedCurrency)
        assertTrue(f.observer.blocks(IntentKind.HERO_UPGRADE)); assertEquals(1, f.commands.size)
    }

    @Test fun `a funding currency mismatch never proves the exact command`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.reviewHeroUpgrade("vex")
        f.wire.onGet("/heroes/vex/upgrade/receipt") { receipt(requireNotNull(f.saved()), currency = "KEEP") }
        assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.repository.confirmHeroSpend() } }
        assertEquals("GEMS", f.saved()!!.expectedCurrency); assertNull(f.saved()!!.receipt)
        assertEquals("Unproven funding cannot publish the newly purchased roster", 1, f.repository.state.value.heroes!!.heroes.single().level)
        assertEquals(0, f.homeReads)
    }

    @Test fun `failed hydration retains accepted evidence and recovery remains GET only after Gems pause`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.reviewHeroUpgrade("vex")
        f.hydrate = { throw IOException("balance refresh offline") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.confirmHeroSpend() } }
        val saved = requireNotNull(f.saved())
        assertEquals(ReceiptDocument.SOURCE_RECEIPT, ReceiptDocument.source(requireNotNull(saved.receipt)))
        f.gemsEnabled = false; f.nativeExact = false; f.actionsAllowed = false; f.hydrate = {}
        f.wire.onGet("/heroes/vex/upgrade/receipt") { error("Persisted proof must not be requested again") }
        assertTrue(f.observer.check(IntentKind.HERO_UPGRADE, WALLET) is Receipt.Accepted)
        assertNull(f.saved()); assertEquals(1, f.commands.size); assertTrue(f.wire.posts.isEmpty())
    }

    @Test fun `late accepted proof is durable but cannot replace the roster after base or session changes`() = runBlocking<Unit> {
        for (sessionChanged in listOf(false, true)) {
            val f = Fixture(); f.repository.reviewHeroUpgrade("vex")
            f.afterReceipt = { if (sessionChanged) f.holder.replace(null) else f.switchAwayAndBack() }
            assertThrows(Exception::class.java) { runBlocking { f.repository.confirmHeroSpend() } }
            assertNotNull("Acceptance remains recoverable after losing UI authority", f.saved()?.receipt)
            assertEquals(1, f.repository.state.value.heroes!!.heroes.single().level)
            assertEquals(0, f.homeReads); assertEquals(1, f.commands.size)
        }
    }

    @Test fun `base generation changing during acceptance account refresh cannot retire proof or publish a new roster`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.reviewHeroUpgrade("vex")
        f.afterAccount = { if (f.saved()?.receipt != null) f.switchAwayAndBack() }
        assertThrows(Exception::class.java) { runBlocking { f.repository.confirmHeroSpend() } }
        assertNotNull("A scope change during hydration must retain already saved acceptance", f.saved()?.receipt)
        assertEquals("The old review cannot publish into the reselected kingdom", 1, f.repository.state.value.heroes!!.heroes.single().level)
        assertEquals(0, f.homeReads); assertEquals(1, f.commands.size)
    }

    @Test fun `dismissing a review while fresh terms arrive prevents both late publication and any debit`() = runBlocking<Unit> {
        val f = Fixture(); f.afterAccount = { f.repository.dismissHeroReview() }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.reviewHeroUpgrade("vex") } }
        assertNull(f.repository.state.value.heroReview); assertNull(f.saved()); assertTrue(f.commands.isEmpty())
    }

    @Test fun `background base roundtrip and gate closure after dispatcher admission cannot enqueue a paid command`() = runBlocking<Unit> {
        for (change in listOf("background", "base", "gate", "session")) {
            val f = Fixture(); f.repository.reviewHeroUpgrade("vex")
            val original = f.repository.state.value.heroReview!!.intent
            f.beforeEnqueue = {
                when (change) {
                    "background" -> f.repository.dismissHeroReview()
                    "base" -> f.switchAwayAndBack()
                    "gate" -> f.actionsAllowed = false
                    else -> f.holder.replace(null)
                }
            }
            assertThrows(Exception::class.java) { runBlocking { f.repository.confirmHeroSpend() } }
            assertTrue("No transport after $change", f.commands.isEmpty())
            assertEquals("A marked attempt stays recoverable after $change", original.nextAttempt(), f.saved())
        }
    }

    @Test fun `a live update or interlock closing during fresh terms dismisses review and sends nothing`() = runBlocking<Unit> {
        val review = Fixture(); review.afterAccount = { review.actionsAllowed = false }
        assertThrows(IllegalStateException::class.java) { runBlocking { review.repository.reviewHeroUpgrade("vex") } }
        assertNull(review.repository.state.value.heroReview); assertNull(review.saved()); assertTrue(review.commands.isEmpty())
        val confirm = Fixture(); confirm.repository.reviewHeroUpgrade("vex")
        confirm.afterAccount = { confirm.actionsAllowed = false }
        assertThrows(IllegalStateException::class.java) { runBlocking { confirm.repository.confirmHeroSpend() } }
        assertNull(confirm.repository.state.value.heroReview); assertNull(confirm.saved()); assertTrue(confirm.commands.isEmpty())
    }

    @Test fun `legacy saved KEEP recovery still observes its original receipt with Gems and new capability paused`() = runBlocking<Unit> {
        val f = Fixture(); f.gemsEnabled = false; f.nativeExact = false
        val old = HeroRecoverySpec.intent(WALLET, BASE_ID, "vex", "legacy-recovery-key", "7", UNTIL).copy(attempted = true)
        f.store.create(old)
        f.wire.onGet("/heroes/vex/recovery/speedup/receipt") { receipt(old, amount = "5") }
        assertTrue(f.observer.check(IntentKind.HERO_RECOVERY, WALLET) is Receipt.Accepted)
        assertNull(f.saved(IntentKind.HERO_RECOVERY)); assertTrue(f.commands.isEmpty()); assertTrue(f.wire.posts.isEmpty())
        assertFalse("Recovery must not depend on new-purchase availability", f.wire.gets.any { it.first == "/native/capabilities" })
    }

    companion object {
        private const val OTHER_BASE = "22222222-2222-4222-8222-222222222222"
        private const val UNTIL = "2026-09-22T10:00:00.000Z"
        private fun receipt(intent: PendingIntent, currency: String = intent.expectedCurrency ?: "KEEP", amount: String? = null): JsonObject {
            val consent = intent.body.getValue("consent").jsonObject
            return buildJsonObject {
                put("version", 1); put("status", "accepted"); put("wallet", intent.wallet); put("baseId", intent.baseId)
                put("receiptId", BASE_ID); put("acceptedAt", "2026-09-21T10:00:00.000Z")
                put("request", buildJsonObject {
                    put("hero", "vex"); put("idempotencyKey", intent.idempotencyKey); put("baseId", intent.baseId)
                    consent.forEach { (key, value) -> put(key, value) }
                })
                put("funding", buildJsonObject { put("currency", currency); put("amount", amount ?: consent.string("maxCostKeep")) })
                put("result", buildJsonObject {
                    if (intent.kind == IntentKind.HERO_UPGRADE) {
                        val level = consent.getValue("expectedLevel").jsonPrimitive.int
                        put("fromLevel", level); put("toLevel", level + 1)
                    } else put("recoveryUntil", consent.getValue("recoveryUntil"))
                })
            }
        }
    }
}
