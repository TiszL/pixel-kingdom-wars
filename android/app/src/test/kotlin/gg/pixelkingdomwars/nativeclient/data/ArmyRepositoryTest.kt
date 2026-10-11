package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.model.TroopCount
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ops.*
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Training schedule v2 (D-114) and the free first FINISH ALL (D-121) as the shell wires them. */
class ArmyRepositoryTest {
    private class Fixture {
        val api = FakeApiClient()
        val holder = testHolder()
        val session = signedIn(holder)
        val intents = PendingIntentStore(MemoryStore())
        val observer = ReceiptObserver(intents)
        var keys = 0
        var selectedBaseId: String? = BASE_ID
        var accountRefreshes = 0
        val home = MutableHome()
        var catalogue: JsonObject? = null
        val repository = LiveArmyRepository(session, holder, api, intents, observer, { selectedBaseId }, { catalogue }, { home.state }, { home.hydrations++ }, newKey = { "key-${++keys}-0000" }, refreshAccount = { accountRefreshes++ })
        val draft = ArmyTrainingDraft(WALLET, BASE_ID, linkedMapOf("bowman" to "2"))
        init { api.onGet("/army") { armyJson() } }
        class MutableHome { var state = BaseState(); var hydrations = 0 }
    }
    private val presetCatalogue = json("""{"display":{"research":{"troops":["highlander","bowman"]}},"constants":{"TROOPS":{"highlander":{"pts":2},"bowman":{"pts":1}},"TRAINING_PRESETS":{"slots":3,"nameMaxLength":32,"maxCompositionUnits":1000}}}""")
    private fun heroesJson(level: Int = 1, recovering: String? = null, finishCost: String? = null) = json("""{"features":{"heroConsent":{"version":1},"heroReceipts":{"version":1}},"heroes":[{"hero":"vex","name":"Vex","title":"The Shardborn","altar":"heroaltar","unlockKeepLevel":5,"recruitCostKeep":"3000","recruitItemId":"item_hero_vex",
        "recruited":true,"level":$level,"tier":1,"tierName":"Shardborn","hp":1400,"dps":95,"recoveryUntil":${recovering?.let { "\"$it\"" } ?: "null"},"available":${recovering == null},"gear":null,
        "recoveryFinishNow":${finishCost?.let { "{\"remainingSec\":40,\"costKeep\":\"$it\",\"affordable\":true}" } ?: "null"},"maxLevel":20,
        "next":{"level":${level + 1},"tier":1,"tierName":"Shardborn","hp":1500,"dps":101,"costKeep":"2500"},"affordable":true}],"keepBalance":"9000","keepLevel":5}""")
    private fun itemsJson(qty: Int = 1, version: Int = 0, equipped: String? = null) = json("""{"catalogRevision":2,"heroGearCombatEnabled":true,
        "catalog":[{"id":"keg_of_haste","name":"KEG OF HASTE","kind":"consumable","costKeep":60,"asset":"a","desc":"Instantly finish a build.","rarity":"common","weight":1,"acquisition":{"type":"shop"},"maxOwned":null,"effect":{"type":"finish_job","maxRemainingSec":1800}},
            {"id":"wardens_helm","name":"WARDEN'S HELM","kind":"gear","slot":"helm","costKeep":0,"asset":"h","desc":"A crown.","rarity":"rare","weight":4,"acquisition":{"type":"drop"},"maxOwned":2,"modifiers":[{"stat":"hero_hp_bps","value":600}]}],
        "owned":[{"itemId":"keg_of_haste","qty":$qty},{"itemId":"wardens_helm","qty":1}],"discovery":[],"capacity":{"used":5,"max":160,"overflow":false},
        "heroLoadouts":[{"hero":"vex","recruited":true,"level":1,"recoveryUntil":null,"available":true,"version":$version,"equipment":{${equipped?.let { "\"helm\":\"$it\"" } ?: ""}},"modifiers":{"hero_hp_bps":0},
            "setBonus":{"id":"warden","pieces":0,"required":9,"active":false},"baseStats":{"hp":1400,"basicDamage":95,"skillDamageSeed":95},"effectiveStats":{"hp":1400,"basicDamage":95,"skillDamageSeed":95}}],"deeds":[]}""")

    @Test fun `quote first then confirm sends the server consent verbatim with the confirmed cost`() = runBlocking {
        val f = Fixture(); val quote = quoteJson()
        f.api.onPost("/army/training/quote") { body -> assertEquals(json("""{"baseId":"$BASE_ID","composition":[{"troop":"bowman","count":2}]}"""), body); quote }
        f.repository.quote(f.draft)
        val reviewed = requireNotNull(f.repository.state.value.reviewed)
        assertEquals(quote["consent"], reviewed.body["consent"]); assertEquals("20", reviewed.body.string("confirmedCostShards"))
        assertEquals(18000L, reviewed.schedule!!.durationMs)
        f.api.onPost(TrainingBatchSpec.PATH) { body ->
            assertEquals(quote["consent"], body["consent"]); assertEquals("20", body.string("confirmedCostShards")); assertEquals("key-1-0000", body.string("idempotencyKey"))
            assertEquals(quote["queueable"], body["composition"])
            buildJsonObject { put("costShards", "20"); put("replayed", false); put("queue", buildJsonArray {}) }
        }
        f.repository.confirmTraining()
        assertNull(f.repository.state.value.reviewed); assertEquals("Training accepted · 20 SHARDS", f.repository.state.value.message)
        assertEquals("Home and Army were re-read before publishing", 1, f.home.hydrations); assertTrue(f.api.gets.count { it.first == "/army" } >= 2)
        assertNull(f.intents.get(IntentKind.TRAINING_BATCH, WALLET))
    }
    @Test fun `a changed quote re-presents the server replacement without a purchase`() = runBlocking {
        val f = Fixture(); f.api.onPost("/army/training/quote") { quoteJson() }
        f.repository.quote(f.draft)
        f.api.onPost(TrainingBatchSpec.PATH) { throw ApiException(409, "TRAINING_QUOTE_CHANGED", "Changed", details = buildJsonObject { put("quote", quoteJson(cost = "22")) }) }
        assertThrows(ApiException::class.java) { runBlocking { f.repository.confirmTraining() } }
        val reviewed = requireNotNull(f.repository.state.value.reviewed)
        assertEquals("22", reviewed.quote.costShards); assertEquals("22", reviewed.body.string("confirmedCostShards")); assertEquals("key-2-0000", reviewed.body.string("idempotencyKey"))
        assertNull("The rejected key was retired", f.intents.get(IntentKind.TRAINING_BATCH, WALLET))
        assertEquals(1, f.api.posts.count { it.first == TrainingBatchSpec.PATH })
    }
    @Test fun `a missing consent rejection re-quotes and a closed batch clears the review`() = runBlocking {
        val f = Fixture(); var quotes = 0
        f.api.onPost("/army/training/quote") { quotes++; quoteJson() }
        f.repository.quote(f.draft)
        f.api.onPost(TrainingBatchSpec.PATH) { throw ApiException(409, "TRAINING_CONSENT_REQUIRED", "Consent") }
        assertThrows(ApiException::class.java) { runBlocking { f.repository.confirmTraining() } }
        assertEquals(2, quotes); assertNotNull(f.repository.state.value.reviewed)
        f.api.onPost(TrainingBatchSpec.PATH) { throw ApiException(409, "TRAINING_BATCH_CLOSED", "Closed") }
        assertThrows(ApiException::class.java) { runBlocking { f.repository.confirmTraining() } }
        assertNull(f.repository.state.value.reviewed); assertTrue(f.repository.state.value.message!!.contains("closed"))
    }
    @Test fun `a lost batch reply blocks a new quote until the receipt is observed`() = runBlocking {
        val f = Fixture(); f.api.onPost("/army/training/quote") { quoteJson() }
        f.repository.quote(f.draft)
        f.api.onPost(TrainingBatchSpec.PATH) { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.confirmTraining() } }
        assertTrue(f.observer.blocks(IntentKind.TRAINING_BATCH))
        f.repository.dismissQuote()
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.quote(f.draft) } }
        f.api.onGet(TrainingBatchSpec.RECEIPT) { query ->
            buildJsonObject { put("version", 1); put("idempotencyKey", query.getValue("idempotencyKey")); put("status", "closed"); put("closedAt", "2026-09-11T00:00:00.000Z") }
        }
        assertEquals(Receipt.Closed("2026-09-11T00:00:00.000Z"), f.observer.check(IntentKind.TRAINING_BATCH, WALLET))
        assertFalse(f.observer.blocks(IntentKind.TRAINING_BATCH))
    }
    @Test fun `queued cancellation binds the exact row and refund then hydrates before publishing`() = runBlocking<Unit> {
        val f = Fixture(); val queueId = "22222222-2222-4222-8222-222222222222"
        val queued = """[{"id":"$queueId","troop":"bowman","startedAt":"2026-09-11T00:00:00Z","finishesAt":"2026-09-11T00:00:09Z","scheduleVersion":2,"canCancel":true,"refundShards":"10"}]"""
        f.api.onGet("/army") { armyJson(queue = queued) }
        f.repository.refreshArmy()
        val choice = requireNotNull(TrainingCancellationChoice.of(WALLET, BASE_ID, f.repository.state.value.army, f.repository.state.value.army!!.queue.single()))
        f.api.onPost("/army/train/$queueId/cancel") { body ->
            assertEquals(json("""{"idempotencyKey":"key-1-0000","baseId":"$BASE_ID"}"""), body)
            json("""{"id":"$queueId","troop":"bowman","refundShards":"10","cancelledAt":"2026-09-11T00:00:05.000Z","replayed":false}""")
        }
        f.repository.cancelQueued(choice)
        assertTrue(f.repository.state.value.message!!.contains("10 SHARDS")); assertEquals(1, f.home.hydrations)
        assertNull(f.intents.get(IntentKind.TRAINING_CANCEL, WALLET))
        f.api.onPost("/army/train/$queueId/cancel") { json("""{"id":"$queueId","troop":"bowman","refundShards":"9","cancelledAt":"2026-09-11T00:00:05.000Z","replayed":false}""") }
        assertThrows("A refund that differs from the consented amount is refused", Exception::class.java) { runBlocking { f.repository.cancelQueued(choice) } }
    }
    @Test fun `free finish keeps original consent and later paid finish requires exact currency review`() = runBlocking {
        val f = Fixture(); val queue = """[{"id":"22222222-2222-4222-8222-222222222222","startedAt":"2026-09-11T00:00:00Z","finishesAt":"2026-09-11T00:00:09Z"}]"""
        f.api.onGet("/army") { armyJson(queue = """[{"id":"22222222-2222-4222-8222-222222222222","troop":"bowman"}]""", finishAllQueue = queue, maxCostKeep = "3",
            freeOffer = """{"offer":"first_troops","consent":{"version":2,"queue":$queue,"maxCostKeep":"0"}}""") }
        f.repository.refreshArmy()
        f.api.onPost(TrainingFinishSpec.PATH) { body ->
            assertEquals("first_troops", body.string("freeOffer")); assertEquals("0", body["consent"]!!.jsonObject.string("maxCostKeep"))
            assertEquals(1, body["consent"]!!.jsonObject["queue"]!!.jsonArray.size); assertEquals(BASE_ID, body.string("baseId"))
            f.api.onGet("/army") { armyJson(finishAllQueue = "[]") }
            json("""{"cost":"0","completed":[{"troop":"bowman","count":1}]}""")
        }
        f.repository.finishAll(free = true)
        assertEquals("Your first troops are ready.", f.repository.state.value.message)
        f.api.onGet("/army") { armyJson(queue = """[{"id":"22222222-2222-4222-8222-222222222222","troop":"bowman"}]""", finishAllQueue = queue, maxCostKeep = "3") }
        f.repository.refreshArmy()
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.finishAll(free = false) } }
        assertEquals("Only the separately consented free offer was sent", 1, f.api.posts.size)
        assertNull(f.intents.get(IntentKind.TRAINING_FINISH, WALLET))
    }
    @Test fun `a changed finish price refreshes the army and keeps the intent retired`() = runBlocking {
        val f = Fixture(); val queue = """[{"id":"22222222-2222-4222-8222-222222222222","startedAt":"2026-09-11T00:00:00Z","finishesAt":"2026-09-11T00:00:09Z"}]"""
        f.api.onGet("/army") { armyJson(finishAllQueue = queue, maxCostKeep = "3", freeOffer = """{"offer":"first_troops","consent":{"version":2,"queue":$queue,"maxCostKeep":"0"}}""") }
        f.repository.refreshArmy()
        f.api.onPost(TrainingFinishSpec.PATH) { throw ApiException(409, "TRAINING_FINISH_QUOTE_CHANGED", "Changed") }
        assertThrows(ApiException::class.java) { runBlocking { f.repository.finishAll(free = true) } }
        assertNull(f.intents.get(IntentKind.TRAINING_FINISH, WALLET)); assertTrue(f.repository.state.value.message!!.contains("price changed"))
    }

    // --- Saved armies, the previous attack and the FINISH ALL ceiling (armyPresets.ts, trainingPresets.tsx, army.tsx) ----
    @Test fun `saved armies are validated against the catalogue rules and written by slot without moving money`() = runBlocking<Unit> {
        val f = Fixture(); f.catalogue = presetCatalogue
        f.api.onGet("/army/presets") { json("""{"presets":[{"slot":2,"name":"RAID","composition":[{"troop":"bowman","count":5}]}]}""") }
        f.repository.refreshPresets()
        assertEquals(listOf(2), f.repository.state.value.presets!!.map { it.slot })
        f.api.onPut("/army/presets/1") { body -> assertEquals(json("""{"name":"ARMY 1","composition":[{"troop":"highlander","count":2},{"troop":"bowman","count":3}]}"""), body); json("""{"slot":1,"name":"ARMY 1","composition":[{"troop":"highlander","count":2},{"troop":"bowman","count":3}]}""") }
        f.repository.savePreset(1, "  ARMY 1 ", listOf(TroopCount("highlander", 2), TroopCount("bowman", 3)))
        assertEquals(listOf(1, 2), f.repository.state.value.presets!!.map { it.slot })
        assertThrows("The server's 422 rules are enforced before any request leaves", IllegalArgumentException::class.java) { runBlocking { f.repository.savePreset(1, "X", listOf(TroopCount("bowman", 0))) } }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repository.savePreset(4, "X", listOf(TroopCount("bowman", 1))) } }
        assertEquals("Refused plans never reach the wire", 1, f.api.puts.size)
        f.api.onDelete("/army/presets/2") { json("""{"deleted":true}""") }
        f.repository.deletePreset(2)
        assertEquals(listOf(1), f.repository.state.value.presets!!.map { it.slot }); assertTrue(f.api.posts.isEmpty()); assertNull(f.intents.get(IntentKind.TRAINING_BATCH, WALLET))
        f.catalogue = null
        assertThrows("No TRAINING_PRESETS in the pack: saved armies fail closed", IllegalArgumentException::class.java) { runBlocking { f.repository.savePreset(1, "X", listOf(TroopCount("bowman", 1))) } }
    }
    @Test fun `a plan may name troops this base cannot train yet and the previous attack is re-quoted or explained`() = runBlocking {
        val f = Fixture(); var quoted: JsonObject? = null
        f.api.onPost("/army/training/quote") { body -> quoted = body; quoteJson() }
        f.repository.quote(ArmyTrainingDraft.ofPlan(WALLET, BASE_ID, listOf(TroopCount("dragon", 2), TroopCount("bowman", 1))))
        assertEquals("The server quotes the remainder; the client does not filter a plan", json("""{"baseId":"$BASE_ID","composition":[{"troop":"dragon","count":2},{"troop":"bowman","count":1}]}"""), quoted)
        assertNotNull(f.repository.state.value.reviewed)
        f.repository.dismissQuote()
        f.api.onGet("/army/previous") { json("""{"raidId":null,"composition":[],"message":"Your previous attack used heroes only; no troops need retraining."}""") }
        f.repository.quotePrevious()
        assertNull(f.repository.state.value.reviewed); assertTrue(f.repository.state.value.message!!.contains("heroes only"))
        f.api.onGet("/army/previous") { json("""{"raidId":"r","composition":[{"troop":"bowman","count":2}],"message":null}""") }
        f.repository.quotePrevious()
        assertEquals(json("""{"baseId":"$BASE_ID","composition":[{"troop":"bowman","count":2}]}"""), quoted); assertTrue(f.repository.state.value.reviewed!!.draft.plan)
    }
    @Test fun `legacy displayed prices cannot bypass the required exact currency review`() = runBlocking<Unit> {
        val f = Fixture(); val queue = """[{"id":"22222222-2222-4222-8222-222222222222","startedAt":"2026-09-11T00:00:00Z","finishesAt":"2026-09-11T00:00:09Z"}]"""
        f.api.onGet("/army") { armyJson(finishAllQueue = queue, maxCostKeep = "5") }
        f.repository.refreshArmy()
        for (displayed in listOf("3", "9", "3.5"))
            assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.finishAll(free = false, displayedCostKeep = displayed) } }
        assertTrue("Only a server-reviewed whole currency may authorize payment", f.api.posts.isEmpty())
        assertEquals(0, f.keys); assertNull(f.intents.get(IntentKind.TRAINING_FINISH, WALLET))
    }

    // --- Heroes (heroes.ts): the roster row the button printed is the only price the client ever sends ---------
    @Test fun `a hero upgrade posts one namespaced key and re-reads balances and the roster before publishing`() = runBlocking {
        val f = Fixture(); f.api.onGet("/heroes") { heroesJson(level = 1) }
        f.repository.refreshHeroes()
        assertThrows("A stale label never buys a different level or price", IllegalArgumentException::class.java) { runBlocking { f.repository.upgradeHero("vex", 3, "2500") } }
        f.api.onPost("/heroes/vex/upgrade") { body ->
            assertEquals(json("""{"idempotencyKey":"key-1-0000","baseId":"$BASE_ID","consent":{"expectedLevel":1,"maxCostKeep":"2500"}}"""), body)
            f.api.onGet("/heroes") { heroesJson(level = 2) }
            json("""{"hero":"vex","level":2,"tier":1,"tierName":"Shardborn","hp":1500,"dps":101,"spentKeep":"2500","duplicate":false}""")
        }
        f.repository.upgradeHero("vex", 2, "2500")
        assertEquals("VEX → L2 · SHARDBORN", f.repository.state.value.message); assertEquals(2, f.repository.state.value.heroes!!.heroes.single().level)
        assertEquals("Home balances were re-read before the result was published", 1, f.home.hydrations); assertNull(f.intents.get(IntentKind.HERO_UPGRADE, WALLET))
        assertEquals(1, f.api.posts.count { it.first == "/heroes/vex/upgrade" })
    }
    @Test fun `a hero recovery finish uses the server's recoveryFinishNow price and the pinned episode`() = runBlocking {
        val f = Fixture(); val until = "2026-09-11T10:00:00.000Z"
        f.api.onGet("/heroes") { heroesJson(recovering = until, finishCost = "7") }
        f.repository.refreshHeroes()
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repository.recoverHero("vex", "6", until) } }
        f.api.onPost("/heroes/vex/recovery/speedup") { body ->
            assertEquals("key-1-0000", body.string("idempotencyKey"))
            assertEquals(json("""{"recoveryUntil":"$until","maxCostKeep":"7"}"""), body["consent"])
            f.api.onGet("/heroes") { heroesJson() }
            json("""{"hero":"vex","spentKeep":"7","duplicate":false,"recoveryUntil":null}""")
        }
        f.repository.recoverHero("vex", "7", until)
        assertEquals("VEX RECOVERED", f.repository.state.value.message); assertTrue(f.repository.state.value.heroes!!.heroes.single().available)
        assertNull(f.intents.get(IntentKind.HERO_RECOVERY, WALLET))
    }

    @Test fun `missing or unknown consent generation blocks paid hero orders before any journal or POST`() = runBlocking {
        val until = "2026-09-12T10:00:00.000Z"
        for (feature in listOf(null, JsonNull, json("""{"heroConsent":{"version":2}}"""), json("""{"heroConsent":{"version":"1"}}"""))) {
            val f = Fixture()
            val roster = heroesJson(recovering = until, finishCost = "7")
            f.api.onGet("/heroes") { JsonObject(roster.filterKeys { it != "features" } + (feature?.let { mapOf("features" to it) } ?: emptyMap())) }
            f.repository.refreshHeroes()
            assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.upgradeHero("vex", 2, "2500") } }
            assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.recoverHero("vex", "7", until) } }
            assertTrue(f.api.posts.isEmpty()); assertNull(f.intents.get(IntentKind.HERO_UPGRADE, WALLET)); assertNull(f.intents.get(IntentKind.HERO_RECOVERY, WALLET))
        }
    }

    @Test fun `base switches drop stale roster and bag reads and refuse orders from the previous base`() = runBlocking {
        val f = Fixture(); val otherBase = "22222222-2222-4222-8222-222222222222"
        f.api.onGet("/heroes") { heroesJson() }; f.api.onGet("/items") { itemsJson() }
        f.repository.refreshHeroes(); f.repository.refreshInventory()
        f.selectedBaseId = otherBase
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.upgradeHero("vex", 2, "2500") } }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.buyItem("keg_of_haste") } }
        assertTrue("A prior base's consent never leaves the device", f.api.posts.isEmpty())
        f.api.onGet("/heroes") { f.selectedBaseId = BASE_ID; heroesJson(level = 2) }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.refreshHeroes() } }
        assertEquals("Late responses cannot replace the current base's roster", 1, f.repository.state.value.heroes!!.heroes.single().level)
        f.api.onGet("/items") { f.selectedBaseId = otherBase; itemsJson(qty = 2) }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.refreshInventory() } }
        assertEquals(1, f.repository.state.value.inventory!!.quantity("keg_of_haste"))
    }

    @Test fun `a proven hero purchase cannot retire against another base after the POST returns`() = runBlocking {
        val f = Fixture(); val otherBase = "22222222-2222-4222-8222-222222222222"
        f.api.onGet("/heroes") { heroesJson() }; f.repository.refreshHeroes()
        f.api.onPost("/heroes/vex/upgrade") {
            f.selectedBaseId = otherBase
            json("""{"hero":"vex","level":2,"spentKeep":"2500","duplicate":false}""")
        }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.upgradeHero("vex", 2, "2500") } }
        assertNotNull("The original receipt survives a changed selection", f.intents.get(IntentKind.HERO_UPGRADE, WALLET)?.receipt)
        assertEquals("No balances from the wrong base can stand in for the purchase", 0, f.home.hydrations)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.observer.check(IntentKind.HERO_UPGRADE, WALLET) } }
        assertTrue(f.observer.blocks(IntentKind.HERO_UPGRADE))
        f.selectedBaseId = BASE_ID
        f.api.onGet("/heroes") { query -> assertEquals(BASE_ID, query["baseId"]); heroesJson(level = 2) }
        assertTrue(f.observer.check(IntentKind.HERO_UPGRADE, WALLET) is Receipt.Accepted)
        assertNull(f.intents.get(IntentKind.HERO_UPGRADE, WALLET))
        assertEquals("Recovery observes the saved acknowledgement without another purchase", 1, f.api.posts.size)
    }

    private fun historicalHeroReceipt(intent: PendingIntent) = json("""{"version":1,"status":"accepted","wallet":"$WALLET","baseId":"$BASE_ID",
        "request":{"hero":"vex","idempotencyKey":"${intent.idempotencyKey}","baseId":"$BASE_ID","expectedLevel":1,"maxCostKeep":"2500"},
        "receiptId":"$BASE_ID","acceptedAt":"2026-09-12T10:00:00Z","funding":{"currency":"KEEP","amount":"2500"},"result":{"fromLevel":1,"toLevel":2}}""")

    @Test fun `historical GET proof retires after a deed switch without claiming the current hero was upgraded`() = runBlocking {
        val f = Fixture(); val otherBase = "22222222-2222-4222-8222-222222222222"
        val intent = HeroUpgradeSpec.intent(WALLET, BASE_ID, "vex", "historical-level-key", 2, "2500").copy(attempted = true)
        f.intents.create(intent); f.selectedBaseId = otherBase
        f.api.onGet("/heroes/vex/upgrade/receipt") { query -> assertEquals(BASE_ID, query["baseId"]); historicalHeroReceipt(intent) }
        f.api.onGet("/heroes") { query -> assertEquals(otherBase, query["baseId"]); heroesJson(level = 1) }
        assertTrue(f.observer.check(IntentKind.HERO_UPGRADE, WALLET) is Receipt.Accepted)
        assertNull(f.intents.get(IntentKind.HERO_UPGRADE, WALLET)); assertEquals(1, f.accountRefreshes)
        assertEquals(1, f.repository.state.value.heroes!!.heroes.single().level)
        assertEquals(otherBase, f.repository.state.value.heroesBaseId)
        assertEquals("Earlier hero payment confirmed for kingdom $BASE_ID.", f.repository.state.value.message)
        assertTrue(f.api.posts.isEmpty())
    }

    @Test fun `historical receipt provenance survives lost hydration and process restart after sale`() = runBlocking {
        val f = Fixture(); val otherBase = "22222222-2222-4222-8222-222222222222"
        val intent = HeroUpgradeSpec.intent(WALLET, BASE_ID, "vex", "historical-lost-key", 2, "2500").copy(attempted = true)
        f.intents.create(intent); f.selectedBaseId = otherBase
        f.api.onGet("/heroes/vex/upgrade/receipt") { historicalHeroReceipt(intent) }
        f.api.onGet("/heroes") { throw IOException("offline hydration") }
        assertThrows(IOException::class.java) { runBlocking { f.observer.check(IntentKind.HERO_UPGRADE, WALLET) } }
        val saved = requireNotNull(f.intents.get(IntentKind.HERO_UPGRADE, WALLET))
        assertEquals(ReceiptDocument.SOURCE_RECEIPT, ReceiptDocument.source(requireNotNull(saved.receipt)))
        val resumed = Fixture(); resumed.intents.create(saved); resumed.selectedBaseId = null
        resumed.api.onGet("/balances") { query -> assertTrue(query.isEmpty()); throw ApiException(409, "BASE_ID_REQUIRED", "baseId required") }
        assertTrue(resumed.observer.check(IntentKind.HERO_UPGRADE, WALLET) is Receipt.Accepted)
        assertEquals(1, resumed.accountRefreshes); assertNull(resumed.intents.get(IntentKind.HERO_UPGRADE, WALLET))
        assertNull(resumed.repository.state.value.heroes); assertNull(resumed.repository.state.value.heroesBaseId)
        assertTrue(resumed.repository.state.value.message!!.contains("Earlier hero payment confirmed for kingdom $BASE_ID"))
        assertEquals(listOf("/balances"), resumed.api.gets.map { it.first }); assertTrue(resumed.api.posts.isEmpty())
    }

    @Test fun `historical hydration still refuses a changed identity or late selected-base response`() = runBlocking {
        for (identityChanges in listOf(false, true)) {
            val f = Fixture()
            val intent = HeroUpgradeSpec.intent(WALLET, BASE_ID, "vex", "historical-race-key", 2, "2500").copy(attempted = true)
            f.intents.create(intent.copy(receipt = ReceiptDocument.fromReceiptRoute(historicalHeroReceipt(intent))))
            f.api.onGet("/heroes") {
                if (identityChanges) f.holder.replace(null) else f.selectedBaseId = "22222222-2222-4222-8222-222222222222"
                heroesJson(level = 1)
            }
            assertThrows(if (identityChanges) gg.pixelkingdomwars.nativeclient.network.SessionSupersededException::class.java else IllegalStateException::class.java) { runBlocking { f.observer.check(IntentKind.HERO_UPGRADE, WALLET) } }
            assertNotNull(f.intents.get(IntentKind.HERO_UPGRADE, WALLET)); assertNull(f.repository.state.value.heroes)
            assertTrue(f.api.posts.isEmpty())
        }
    }

    @Test fun `a saved item receipt waits for its original base before hydrating the bag`() = runBlocking {
        val f = Fixture(); val otherBase = "22222222-2222-4222-8222-222222222222"
        val intent = ItemBuySpec.intent(WALLET, BASE_ID, "keg_of_haste", "saved-item-key", "60", "Keg of Haste")
        assertTrue(f.intents.create(intent.copy(attempted = true, receipt = ReceiptDocument.fromPost(json("""{"itemId":"keg_of_haste","costKeep":60,"duplicate":false}""")))))
        f.observer.refresh(WALLET); f.selectedBaseId = otherBase
        assertThrows(IllegalStateException::class.java) { runBlocking { f.observer.check(IntentKind.ITEM_BUY, WALLET) } }
        assertNotNull(f.intents.get(IntentKind.ITEM_BUY, WALLET)); assertTrue(f.api.gets.isEmpty()); assertEquals(0, f.home.hydrations)
        f.selectedBaseId = BASE_ID
        f.api.onGet("/items") { query -> assertEquals(BASE_ID, query["baseId"]); itemsJson(qty = 2) }
        assertTrue(f.observer.check(IntentKind.ITEM_BUY, WALLET) is Receipt.Accepted)
        assertNull(f.intents.get(IntentKind.ITEM_BUY, WALLET)); assertEquals(2, f.repository.state.value.inventory!!.quantity("keg_of_haste"))
        assertTrue("Receipt observation cannot resend the purchase", f.api.posts.isEmpty())
    }

    // --- Items (items.ts) ---------------------------------------------------------------------------------------
    @Test fun `a shop purchase is a money operation that re-reads balances and the bag before publishing`() = runBlocking {
        val f = Fixture(); f.api.onGet("/items") { itemsJson(qty = 1) }
        f.repository.refreshInventory()
        assertThrows("Forge drops are never sold", IllegalArgumentException::class.java) { runBlocking { f.repository.buyItem("wardens_helm") } }
        f.api.onPost(ItemBuySpec.PATH) { body ->
            assertEquals(json("""{"itemId":"keg_of_haste","idempotencyKey":"key-1-0000","baseId":"$BASE_ID"}"""), body)
            f.api.onGet("/items") { itemsJson(qty = 2) }
            json("""{"itemId":"keg_of_haste","costKeep":60,"duplicate":false}""")
        }
        f.repository.buyItem("keg_of_haste")
        assertEquals("ITEM ADDED TO INVENTORY", f.repository.state.value.message); assertEquals(2, f.repository.state.value.inventory!!.quantity("keg_of_haste"))
        assertEquals(1, f.home.hydrations); assertNull(f.intents.get(IntentKind.ITEM_BUY, WALLET))
    }
    @Test fun `a consented shop purchase freezes the price and currency the player saw and its lost reply reads back by key`() = runBlocking {
        // Owner review 2026-10-06 (B1), night/server 231e6cff9: where the server records consented purchases, the order carries
        // the price on the button and the currency the server will charge, so a lost reply is resolved by the purchase's own
        // receipt (here: accepted, hydrated) instead of a replay that can be refused before the key lookup.
        val f = Fixture(); val receipts = json("""{"itemPurchase":{"version":1,"receipts":1}}""")
        f.api.onGet("/items") { JsonObject(itemsJson(qty = 1) + ("features" to receipts)) }
        f.repository.refreshInventory()
        f.api.onGet("/balances") { query -> assertEquals(BASE_ID, query["baseId"])
            json("""{"shards":"3520","keep":"900","keepRate":1,"features":{"gameCurrency":{"version":1,"exactSpendCurrency":1}}}""") }
        val consent = """{"version":1,"catalogRevision":2,"quantity":1,"maxCostKeep":"60"}"""
        f.api.onPost(ItemBuySpec.PATH) { body ->
            assertEquals(json("""{"itemId":"keg_of_haste","idempotencyKey":"key-1-0000","baseId":"$BASE_ID","consent":$consent}"""), body)
            throw IOException("reply lost")
        }
        assertThrows(IOException::class.java) { runBlocking { f.repository.buyItem("keg_of_haste") } }
        assertEquals("KEEP", f.intents.get(IntentKind.ITEM_BUY, WALLET)?.expectedCurrency)
        f.api.onGet(ItemBuySpec.RECEIPT) { query ->
            assertEquals(mapOf("itemId" to "keg_of_haste", "idempotencyKey" to "key-1-0000", "baseId" to BASE_ID), query)
            json("""{"version":1,"status":"accepted","wallet":"$WALLET","request":{"itemId":"keg_of_haste","baseId":"$BASE_ID","idempotencyKey":"key-1-0000",
                "expectedCurrency":"KEEP","consent":$consent},"receiptId":"00000000-0000-4000-8000-000000000009","acceptedAt":"2026-10-06T12:00:00.000Z",
                "funding":{"currency":"KEEP","amount":"60"},"result":{"itemId":"keg_of_haste","quantity":1}}""")
        }
        f.api.onGet("/items") { JsonObject(itemsJson(qty = 2) + ("features" to receipts)) }
        assertTrue(f.observer.check(IntentKind.ITEM_BUY, WALLET) is Receipt.Accepted)
        assertNull(f.intents.get(IntentKind.ITEM_BUY, WALLET)); assertEquals(2, f.repository.state.value.inventory!!.quantity("keg_of_haste"))
        assertEquals("the purchase was never resent", 1, f.api.posts.size)
    }
    @Test fun `a lost item-use reply blocks another use until the server replays the key as a duplicate`() = runBlocking {
        val f = Fixture(); f.api.onGet("/items") { itemsJson(qty = 1) }
        f.repository.refreshInventory()
        f.api.onPost(ItemUseSpec.PATH) { throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.useItem("keg_of_haste") } }
        assertTrue(f.observer.blocks(IntentKind.ITEM_USE))
        assertThrows("The saved unknown use blocks a second unit", IllegalStateException::class.java) { runBlocking { f.repository.useItem("keg_of_haste") } }
        assertEquals(1, f.api.posts.count { it.first == ItemUseSpec.PATH })
        f.api.onPost(ItemUseSpec.PATH) { body -> assertEquals("key-1-0000", body.string("idempotencyKey")); f.api.onGet("/items") { itemsJson(qty = 0) }; throw ApiException(409, null, "duplicate use request — refresh your inventory") }
        val resolved = f.observer.retry(IntentKind.ITEM_USE, WALLET) as Receipt.Accepted
        assertTrue((resolved.value as ItemUseAcceptance).replayed); assertFalse(f.observer.blocks(IntentKind.ITEM_USE))
        assertEquals("The bag was re-read before the intent was retired", 0, f.repository.state.value.inventory!!.quantity("keg_of_haste"))
        assertEquals("The same key was re-sent, never a fresh one", 2, f.api.posts.count { it.first == ItemUseSpec.PATH && it.second.string("idempotencyKey") == "key-1-0000" })
    }
    @Test fun `equipment writes echo the loadout version and a stale version refreshes the inventory`() = runBlocking {
        val f = Fixture(); f.api.onGet("/items") { itemsJson(version = 3) }
        f.repository.refreshInventory()
        f.api.onPut("/heroes/vex/equipment/helm") { body ->
            assertEquals(json("""{"itemId":"wardens_helm","expectedVersion":3,"baseId":"$BASE_ID"}"""), body)
            f.api.onGet("/items") { itemsJson(version = 4, equipped = "wardens_helm") }
            json("""{"hero":"vex","slot":"helm","itemId":"wardens_helm","version":4}""")
        }
        f.repository.equip("vex", "helm", "wardens_helm", 3)
        assertEquals("wardens_helm", f.repository.state.value.inventory!!.loadout("vex")!!.equipment["helm"]); assertEquals(1, f.repository.state.value.inventory!!.equippedCount("wardens_helm"))
        assertThrows("The client never resends a version it knows is stale", IllegalArgumentException::class.java) { runBlocking { f.repository.equip("vex", "helm", null, 3) } }
        f.api.onPut("/heroes/vex/equipment/helm") { f.api.onGet("/items") { itemsJson(version = 5) }; throw ApiException(409, null, "loadout changed — expected version 4, current 5") }
        assertThrows(ApiException::class.java) { runBlocking { f.repository.equip("vex", "helm", null, 4) } }
        assertEquals(5, f.repository.state.value.inventory!!.loadout("vex")!!.version); assertTrue(f.repository.state.value.message!!.contains("Refreshed"))
        assertTrue("Equipment moves no money: nothing is journaled", f.intents.all(WALLET).isEmpty())
    }
}
