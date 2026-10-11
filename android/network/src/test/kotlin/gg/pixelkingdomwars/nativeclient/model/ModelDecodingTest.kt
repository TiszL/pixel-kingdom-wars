package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Typed models decode the production shapes captured from the local main-based backend; unknown
 * fields are ignored and every money or count value keeps its exact decimal text. */
class ModelDecodingTest {
    private fun json(value: String) = Json.parseToJsonElement(value).jsonObject

    @Test fun `army state carries training schedule v2 and the free finish fields`() {
        val army = ArmyState.from(json("""{"counts":{"highlander":10},"levels":{"highlander":1},"research":[],"queue":[{"id":"q1","troop":"highlander","startedAt":"2026-09-11T00:00:00Z","finishesAt":"2026-09-11T00:00:12Z","scheduleVersion":2,"canCancel":true,"refundShards":"9007199254740993"}],
            "rosterPts":20,"queuedPts":0,"campCapacityPts":20,"barracksQueuePts":10,"eliteUnlocks":{"gloamfang":false},
            "finishAllQuote":{"version":2,"queue":[{"id":"q1","startedAt":"2026-09-11T00:00:00Z","finishesAt":"2026-09-11T00:00:12Z"}],"maxCostKeep":"3"},
            "features":{"trainingScheduling":{"version":2,"mode":"sequential","lanes":1,"consentRequired":true},"researchConsent":{"version":1},"darkAttackerRoster":{"enabled":false}},
            "freeFinishAllOffer":{"offer":"first_troops","consent":{"version":2,"queue":[],"maxCostKeep":"0"}},"freeFinishAllReceipt":null,"freeFinishAllReviewRequired":false,"futureField":1}"""))
        assertEquals(10, army.counts["highlander"]); assertEquals(2, army.queue.single().scheduleVersion)
        assertEquals("9007199254740993", army.queue.single().refundShards)
        assertEquals("3", army.finishAllQuote!!.maxCostKeep); assertEquals("q1", army.finishAllQuote!!.queue.single().id)
        assertEquals("first_troops", army.freeFinishAllOffer!!.offer); assertEquals("0", army.freeFinishAllOffer!!.consent.maxCostKeep)
        assertTrue(army.trainingScheduling!!.consentRequired); assertEquals("sequential", army.trainingScheduling!!.mode)
        assertFalse(army.freeFinishAllReviewRequired)
    }
    @Test fun `a training quote forwards consent verbatim and types the sequential window`() {
        val quote = TrainingQuote.from(json("""{"requested":[{"troop":"bowman","count":2}],"queueable":[{"troop":"bowman","count":1}],"remaining":[{"troop":"bowman","count":1,"reason":"full"}],
            "costShards":"9007199254740993","consent":{"version":2,"queue":[],"unitDurations":[{"troop":"bowman","durationMs":9000}]},
            "schedule":{"version":2,"mode":"sequential","serverNow":"2026-09-11T00:00:00.000Z","startsAt":"2026-09-11T00:00:00.000Z","finishesAt":"2026-09-11T00:00:09.000Z","waitMs":0,"durationMs":9000}}"""))
        assertEquals("9007199254740993", quote.costShards); assertEquals(9000L, quote.schedule!!.durationMs)
        assertEquals(json("""{"version":2,"queue":[],"unitDurations":[{"troop":"bowman","durationMs":9000}]}"""), quote.consent)
        assertEquals(listOf(TroopCount("bowman", 1)), quote.queueable); assertEquals("full", quote.remaining.single().reason)
    }
    @Test fun `base snapshot parses the visual context and keeps the raw tree for the scene mapper`() {
        val raw = json("""{"baseId":"b1","visualContext":{"version":1,"realmId":"crownlands","artVersion":2},"player":{"keepLevel":1,"builders":1},"energy":{"used":0,"free":6,"max":6},
            "claim":{"min":8,"max":22},"buildings":[{"id":"k","type":"keep","level":1,"tx":14,"ty":14,"underConstruction":false}],"jobs":[{"id":"j","kind":"build","buildingId":"k","startedAt":"2026-09-11T00:00:00Z","finishesAt":"2026-09-11T00:01:00Z","finishCostKeep":"0","canCancel":true,"refundShards":"10"}],"freeBuilders":0}""")
        val base = BaseSnapshot.from(raw)
        assertEquals(VisualContext(1, "crownlands", 2), base.visualContext); assertEquals("visualContext(version=1, realm=crownlands, art=v2)", base.visualContext!!.describe())
        assertEquals("0", base.jobs.single().finishCostKeep); assertEquals(8, base.claim!!.min); assertSame(raw, base.raw)
        assertNull(BaseSnapshot.from(JsonObject(raw - "visualContext")).visualContext)
        assertThrows(IllegalArgumentException::class.java) { VisualContext.of(json("""{"visualContext":{"version":1}}""")) }
        assertEquals(VisualContext(1, "crownlands", 2, 1), VisualContext.of(json("""{"visualContext":{"version":1,"realmId":"crownlands","artVersion":2,"groundRevision":1}}""")))
        assertEquals(99, VisualContext.of(json("""{"visualContext":{"version":1,"realmId":"crownlands","artVersion":2,"groundRevision":99}}"""))!!.groundRevision)
        assertNull("A string revision must not select new ground artwork", VisualContext.of(json("""{"visualContext":{"version":1,"realmId":"crownlands","artVersion":2,"groundRevision":"1"}}"""))!!.groundRevision)
    }
    @Test fun `numbers the server sends for money and counts stay exact decimal strings`() {
        val quests = QuestBoard.from(json("""{"day":3,"quests":[{"id":"q","scope":"daily","templateCode":"win_2_star","target":1,"rewardShards":20,"rewardKeep":20,"progress":0,"completed":false,"claimed":false}],"allThreeBonus":25}"""))
        assertEquals("The production board keys its day by calendar date; the key is carried as sent", "2026-09-11", QuestBoard.from(json("""{"day":"2026-09-11","quests":[]}""")).day)
        assertEquals("3", quests.day)
        assertEquals("20", quests.quests.single().rewardShards); assertEquals("25", quests.allThreeBonus); assertEquals("1", quests.quests.single().target)
        val balances = Balances.from(json("""{"shards":"9007199254740993","keep":"0","keepRate":1}"""))
        assertEquals("9007199254740993", balances.shards)
        assertThrows(Exception::class.java) { Balances.from(json("""{"shards":null,"keep":"0"}""")) }
        val mine = MineStatus.from(json("""{"mining":{"accrued":123456789012345678,"storageCap":0,"ratePerHour":0,"mineCount":0,"maxMines":2},"cache":{"claimable":false,"cacheShards":100,"nextClaimAt":"2026-09-12T00:00:00.000Z"}}"""))
        assertEquals("123456789012345678", mine.mining!!.accrued); assertEquals("100", mine.cache!!.cacheShards)
    }
    @Test fun `directory identity and playtest access decode their production shapes`() {
        val directory = BaseDirectory.from(json("""{"enabled":true,"worldId":"fantasy-v1","maxActive":5,"nextLandPurchaseKind":"entry","bases":[{"id":"b1","status":"active","keepLevel":1,"slot":1},{"id":"b2","status":"inactive","keepLevel":2,"slot":null}]}"""))
        assertTrue(directory.fantasy); assertEquals(listOf("b1"), directory.bases.filter { it.selectable }.map { it.id })
        assertFalse(BaseDirectory.from(json("""{"worldId":"legacy-earth","bases":[]}""")).fantasy)
        val me = Identity.from(json("""{"wallet":"W","name":"","keepLevel":1,"entryPaid":false,"seeker":{"linked":false}}"""))
        assertEquals("Your kingdom", me.displayName); assertFalse(me.seeker!!.verified); assertEquals(false, me.entryPaid)
        assertThrows(Exception::class.java) { Identity.from(json("""{"name":"x"}""")) }
        assertTrue(PlaytestAccess.from(json("""{"open":true,"playUrl":"https://play"}""")).open)
        assertEquals(0L, NativeCapabilities.from(json("""{"protocolVersion":1,"simVersion":14,"minimumVersionCode":0,"presentation":{"enabled":true}}""")).minimumVersionCode)
        assertThrows(Exception::class.java) { NativeCapabilities.from(json("""{"protocolVersion":1,"simVersion":14,"minimumVersionCode":-1}""")) }
    }
    @Test fun `campaign heroes items and battle history decode with optional fields absent`() {
        val campaign = CampaignState.from(json("""{"baseId":"b","stages":[{"stage":1,"name":"DRIFTWOOD CAMP","bestStars":3,"unlocked":true,"recommendedArmyPoints":20}]}"""))
        assertEquals(1, campaign.stages.single().stage); assertNull(campaign.stages.single().tactic)
        val heroes = HeroRoster.from(json("""{"heroes":[{"hero":"vex","name":"Vex","recruited":false,"unlockKeepLevel":5,"hp":1400,"dps":95,"next":{"level":2,"costKeep":"2500"}}]}"""))
        assertEquals("1400", heroes.heroes.single().hp); assertEquals("2500", heroes.heroes.single().next!!.costKeep)
        val items = Inventory.from(json("""{"catalog":[{"id":"keg_of_haste","name":"KEG OF HASTE","costKeep":60}],"owned":[{"itemId":"keg_of_haste","qty":2}],"capacity":{"used":1,"max":160},"deeds":[]}"""))
        assertEquals("2", items.owned.single().qty); assertEquals("60", items.catalog.single().costKeep)
        val history = BattleHistory.from(json("""{"battles":[{"raidId":"r","mode":"campaign","result":"defeat","stars":0,"destructionPct":44,"lootDeltaShards":"0"}],"nextCursor":null}"""))
        assertEquals("44", history.battles.single().destructionPct)
        val tutorial = TutorialState.from(json("""{"step":0,"completedAt":null,"guideSkipped":false,"onboarding":{"questId":"q","templateCode":"first_camp","target":1,"rewardShards":15,"progress":1,"completed":true,"claimed":false}}"""))
        assertFalse(tutorial.completed); assertEquals("q", tutorial.onboarding!!.questIdentity)
    }
    @Test fun `layouts wall row quotes and the daily cache decode their production shapes`() {
        val layouts = Layouts.from(json("""{"baseId":"b","geometryVersion":1,"claim":{"min":8,"max":22,"size":14},"active":{"slot":"HOME","etag":"sha256:a"},
            "farmUnlock":{"locked":true,"costShards":500},"slots":[{"slot":"HOME","locked":false,"etag":"sha256:h","positions":[{"buildingId":"k","tx":10,"ty":11}],"compatibility":"ready","unplacedBuildingIds":[],"removedBuildingIds":[]},
            {"slot":"FARM","locked":true,"etag":"sha256:f","positions":[],"compatibility":"empty","unplacedBuildingIds":["k"],"removedBuildingIds":[]}]}"""))
        assertEquals("500", layouts.farmUnlock.costShards); assertEquals(11, layouts.slot("HOME")!!.positions.single().ty); assertTrue(layouts.slot("FARM")!!.locked); assertNull(layouts.slot("X"))
        val saved = LayoutSaveResult.from(json("""{"baseId":"b","slot":"HOME","geometryVersion":1,"slotEtag":"sha256:1","activeEtag":"sha256:2","activeSlot":null,"moved":3,"unchanged":12,"replayed":false}"""))
        assertEquals(3, saved.moved); assertNull(saved.activeSlot)
        val quote = WallRowQuote.from(json("""{"baseId":null,"selectedWallId":"w","quoteId":"${"0".repeat(64)}","keepLevel":2,"walls":[{"id":"w","tx":1,"ty":1,"level":1,"targetLevel":2,"costShards":48,"excluded":null},
            {"id":"x","tx":2,"ty":1,"level":2,"targetLevel":null,"costShards":0,"excluded":"keep_level"}],"totalCostShards":48,"balanceShards":"3520","canAfford":true}"""))
        assertNull(quote.baseId); assertEquals("48", quote.totalCostShards); assertEquals(listOf("w"), quote.eligible.map { it.id }); assertEquals("keep_level", quote.walls[1].excluded)
        assertThrows(IllegalArgumentException::class.java) { WallRowQuote.from(JsonObject(quote.raw + ("quoteId" to JsonPrimitive("short")))) }
        val status = MineStatus.from(json("""{"mining":{"quotaPerDay":500,"accrued":120,"storageCap":500,"ratePerHour":20,"mineCount":1,"maxMines":2},"cache":{"streakDays":2,"currentDay":2,"cacheShards":200,"claimable":true,"nextClaimAt":"2026-09-12T00:00:00.000Z"}}"""))
        assertEquals(2, status.cache!!.currentDay); assertEquals("200", status.cache!!.cacheShards)
        assertEquals("200", DailyCacheClaim.from(json("""{"amount":"200","streakDays":3,"everCompletedWeek1":false}""")).amount)
    }
}
