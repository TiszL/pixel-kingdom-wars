package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileState
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure rules of the Workshop and Harvester sheets (design/final/craft/SPEC.md). */
class CraftLogicTest {
    private val now = 1_000_000_000L

    private val items = mapOf(
        "frost_quartz" to CraftItemUi("frost_quartz", "Frost Quartz", craftItemIcon("frost_quartz"), "Frostveil harvester"),
        "frostglass" to CraftItemUi("frostglass", "Frostglass", craftItemIcon("frostglass"), "Refine here", "refine_frostglass"),
        "heartwood_beams" to CraftItemUi("heartwood_beams", "Heartwood Beams", craftItemIcon("heartwood_beams"), "Refine here, from logs", "refine_beams"),
        "thornsilk" to CraftItemUi("thornsilk", "Thornsilk", craftItemIcon("thornsilk"), "Refine here, from fibre", "refine_thornsilk"),
        "expedition_kit" to CraftItemUi("expedition_kit", "Expedition Kit", craftItemIcon("expedition_kit"), "Craft here", pluralName = "Expedition Kits"),
    )
    private val frostglass = RecipeUi("refine_frostglass", "1", RecipeGroup.REFINE, "frostglass", 1,
        listOf(RecipeInputUi(InputKind.RAW, "frost_quartz", 4)), 90, "For kits.", null)
    private val expedition = RecipeUi("kit_expedition", "1", RecipeGroup.KIT, "expedition_kit", 1,
        listOf(RecipeInputUi(InputKind.CRAFTING, "heartwood_beams", 2), RecipeInputUi(InputKind.CRAFTING, "thornsilk", 1),
            RecipeInputUi(InputKind.SHARDS, "shards", 600)), 240, "Packs a longer trip.", null)
    private val embercore = RecipeUi("refine_embercore", "1", RecipeGroup.REFINE, "embercore", 1,
        listOf(RecipeInputUi(InputKind.RAW, "ember_nodules", 4)), 150, "Builds engines.", LockReasonUi("Unlocks at Workshop 3", "Workshop 3"))
    private val refine = WorkshopRefineUi(listOf(frostglass, expedition, embercore),
        mapOf("frost_quartz" to StockUi(36), "frostglass" to StockUi(14), "heartwood_beams" to StockUi(0), "thornsilk" to StockUi(2)),
        maxBatch = 10, acceptingJobs = true, pendingJobs = emptyList(), actionsAllowed = true, selectedRecipeId = "refine_frostglass",
        quantity = 6, savedOperation = null, hydration = CraftHydration.Ready, items = items, shards = 40_943)

    // Money honesty (DESIGN-SYSTEM §9): a count the server has not given is "…", never 0 and never "enough".
    @Test fun `unknown counts render as an ellipsis and are neither OK nor short`() {
        assertEquals("…", groupDigits(null))
        val line = ingredientLines(frostglass.inputs, 6, refine.stock, items, countsKnown = false).single()
        assertEquals("…/24", line.count)
        assertFalse(line.ok)
        assertFalse(line.short)
        val tiles = recipeTiles(refine.copy(hydration = CraftHydration.Loading), RecipeGroup.REFINE)
        assertTrue(tiles.all { it.tile.count == "…" })
    }

    @Test fun `durations read the way the mockups print them`() {
        assertEquals("9m 00s", craftDuration(540))
        assertEquals("1m 30s", craftDuration(90))
        assertEquals("1h 00m", craftDuration(3_600))
        assertEquals("…", craftDuration(null))
        assertEquals("3:48", timeLeft(228))
        assertEquals("2h 10m", timeLeft(7_800))
        assertEquals("6h 00m", timeLeft(21_600))
        assertEquals("1d 2h", timeLeft(93_600))
        assertEquals("6h", shortDuration(21_600))
        assertEquals("1h 30m", shortDuration(5_400))
    }

    // SPEC §2.3: only the server says a job is done; the clock rounds up so it never reads 0 early.
    @Test fun `a countdown never claims done before the server does`() {
        assertEquals(1L, secondsLeft(now + 1, now))
        assertEquals(0L, secondsLeft(now - 5_000, now))
        assertEquals(CHECKING_TEXT, countdownText(secondsLeft(now - 5_000, now)))
        assertEquals("…", countdownText(null))
        assertEquals(0L, secondsLeft(now + 10_000, now, serverOffsetMs = 10_000))
    }

    @Test fun `job progress follows the server clock and steps per minute under reduced motion`() {
        assertEquals(0.5f, jobProgress(0, 1_000, null, 500)!!, 0.0001f)
        assertEquals(0.5f, jobProgress(null, 120_000, 120, 90_000, stepMs = 60_000)!!, 0.0001f)
        assertNull(jobProgress(null, 1_000, null, 500))
    }

    @Test fun `steppers clamp to the server limits`() {
        assertEquals(10, stepQuantity(10, 1, 1, 10))
        assertEquals(1, stepQuantity(1, -1, 1, 10))
        assertEquals(1, clampQuantity(5, 1, 0))
        assertEquals(3L, ingotCastMax(8, 3, 22))
        assertEquals(0L, ingotCastMax(8, 0, 22))
        assertNull(ingotCastMax(8, null, 22))
    }

    // SPEC §2.1: a Shards input is never a row; it is the cost pill, and only a known, lower balance makes it SHORT.
    @Test fun `shards inputs become the cost pill and are short only on a known lower balance`() {
        val lines = ingredientLines(expedition.inputs, 2, refine.stock, items)
        assertEquals(listOf("heartwood_beams", "thornsilk"), lines.map { it.itemId })
        assertEquals(1_200L, shardsCost(expedition.inputs, 2))
        assertEquals(PriceStatus.SHORT, shardsPrice(1_200, 1_000)!!.status)
        assertEquals(PriceStatus.CHECKING, shardsPrice(1_200, null)!!.status) // 5f9b5138: unknown is never sufficient.
        assertNull(shardsPrice(shardsCost(frostglass.inputs, 2), 0))
    }

    // SPEC §2.2: a missing ingredient turns the primary off with a reason; it never starts, and GO selects the recipe here.
    @Test fun `a missing ingredient blocks the start and points to where it is made`() {
        val short = refine.copy(selectedRecipeId = "kit_expedition", quantity = 2)
        val primary = refinePrimary(short, now)!!
        assertEquals(CommandState.DISABLED, primary.state)
        assertEquals(PrimaryAction.SHAKE, primary.action)
        assertEquals("CRAFT 2", primary.label)
        assertEquals("Need 4 more Heartwood Beams. Tap GO.", primary.reason)
        assertEquals("1,200", primary.price!!.amount)
        val beams = refineLines(short).first { it.short }
        assertEquals("refine_beams", beams.goRecipeId)
        val tiles = recipeTiles(short, RecipeGroup.KIT)
        assertEquals(ItemTileState.SELECTED, tiles.single { it.tile.id == "kit_expedition" }.tile.state)
    }

    @Test fun `a ready recipe starts with its time and the selected tile gets the rim`() {
        val primary = refinePrimary(refine, now)!!
        assertEquals("REFINE 6", primary.label)
        assertEquals("takes 9m 00s", primary.sub)
        assertEquals(PrimaryAction.START, primary.action)
        assertEquals(ItemTileState.SELECTED, recipeTiles(refine, RecipeGroup.REFINE).first().tile.state)
        assertEquals("x14", recipeTiles(refine, RecipeGroup.REFINE).first().tile.count)
    }

    @Test fun `a full bench is busy with its countdown and a free queue slot starts again`() {
        val working = refine.copy(pendingJobs = listOf(BenchJobUi("j1", "refine_frostglass", 6, now + 228_000)))
        val busy = refinePrimary(working, now)!!
        assertEquals(CommandState.BUSY, busy.state)
        assertEquals("Bench busy · 3:48", busy.label)
        assertEquals(PrimaryAction.START, refinePrimary(working.copy(benchCapacity = 2), now)!!.action)
        assertEquals("1 of 1 slot", slotLine(1, 1))
        assertEquals("1 of 2 slots", slotLine(1, 2))
    }

    @Test fun `pauses, locks, loading and errors each explain themselves`() {
        assertEquals("Orders are paused on this base", refinePrimary(refine.copy(actionsAllowed = false), now)!!.reason)
        assertEquals("New refining is paused", refinePrimary(refine.copy(acceptingJobs = false), now)!!.reason)
        val locked = refinePrimary(refine.copy(selectedRecipeId = "refine_embercore"), now)!!
        assertEquals(CommandState.LOCKED, locked.state)
        assertEquals("Workshop 3", locked.label)
        val loading = refinePrimary(refine.copy(hydration = CraftHydration.Loading), now)!!
        assertEquals(CommandState.BUSY, loading.state)
        assertEquals("Checking stock", loading.label)
        assertEquals(PrimaryAction.RETRY, refinePrimary(refine.copy(hydration = CraftHydration.Error("x")), now)!!.action)
        assertNull(refinePrimary(refine.copy(recipes = emptyList()), now))
    }

    // Design correction 7: an uncertain result is "being checked" and keeps the recovery; only a refusal says nothing was spent.
    @Test fun `an uncertain request is being checked and never claims nothing was spent`() {
        val checking = refinePrimary(refine.copy(submit = SubmitUi(SubmitStage.CHECKING), savedOperation = SavedOpUi("op")), now)!!
        assertEquals(CommandState.BUSY, checking.state)
        assertEquals("Being checked", checking.label)
        val notice = submitNotice(SubmitUi(SubmitStage.CHECKING))!!
        assertFalse(notice.contains("Nothing was spent"))
        assertTrue(submitNotice(SubmitUi(SubmitStage.REFUSED))!!.contains("Nothing was spent"))
        assertNull(submitNotice(SubmitUi(SubmitStage.SENDING)))
        val saved = refinePrimary(refine.copy(savedOperation = SavedOpUi("op")), now)!!
        assertEquals(CommandState.DISABLED, saved.state)
    }

    private val ingots = WorkshopIngotsUi(IngotInventoryUi(8, 0),
        IngotAllowanceUi(IngotDailyUi(12, 20, 8), IngotHoldingUi(8, 0, 30, 22), now + 22_800_000),
        shardsPerIngot = 2_000, batch = IngotBatchUi(8), job = null, shards = 40_943, actionsAllowed = true, saved = null, quantity = 4,
        secondsPerIngot = 30)

    // SPEC §2.5: Forge Ingots use a real collect; the moss COLLECTED (after the receipt) cannot be tapped twice.
    @Test fun `ingots collect through the receipt sequence and cannot collect twice`() {
        val ready = ingotsPrimary(ingots.copy(job = IngotJobUi("j", 4, now - 1, IngotJobState.READY)), now)
        assertEquals("COLLECT 4", ready.label)
        assertEquals(PrimaryAction.COLLECT, ready.action)
        assertEquals(READY_BADGE, ready.badge)
        val collected = ingotsPrimary(ingots.copy(job = IngotJobUi("j", 4, now - 1, IngotJobState.READY), collect = CollectStage.COLLECTED), now)
        assertEquals(Verb.MOSS, collected.verb)
        assertEquals(PrimaryAction.NONE, collected.action)
        assertEquals(PrimaryAction.COLLECT, ingotsPrimary(ingots.copy(collect = CollectStage.FAILED), now).action)
    }

    @Test fun `ingot casting respects today's cap, the holding room and the Shards balance`() {
        val cast = ingotsPrimary(ingots, now)
        assertEquals("CAST 4", cast.label)
        assertEquals("8,000", cast.price!!.amount)
        assertEquals("takes 2m 00s", cast.sub)
        val capped = ingotsPrimary(ingots.copy(allowance = ingots.allowance.copy(daily = IngotDailyUi(20, 20, 0))), now)
        assertEquals("Today's 20 are cast. Resets in 6h 20m.", capped.reason)
        val full = ingotsPrimary(ingots.copy(allowance = ingots.allowance.copy(holding = IngotHoldingUi(30, 0, 30, 0))), now)
        assertEquals("Holding room is full. Smelt some at the Gold Forge.", full.reason)
        assertEquals(PrimaryAction.NEED_MORE, ingotsPrimary(ingots.copy(shards = 100), now).action)
        // A price still being checked is navigation into the review, not a refusal (design correction 7).
        val checking = ingotsPrimary(ingots.copy(shardsPerIngot = null), now)
        assertEquals(PriceStatus.CHECKING, checking.price!!.status)
        assertEquals(PrimaryAction.START, checking.action)
        assertEquals(3, ingotQuantity(ingots.copy(quantity = 9, allowance = ingots.allowance.copy(daily = IngotDailyUi(17, 20, 3)))))
    }

    private val style = WorkshopStyleUi(
        awning = AwningUi(listOf(
            AwningTierUi(1, "a1", 1, emptyList(), 3_600, owned = true, craftable = false),
            AwningTierUi(2, "a2", 2, emptyList(), 3_600, owned = true, craftable = false),
            AwningTierUi(3, "a3", 3, emptyList(), 3_600, owned = false, craftable = true),
            AwningTierUi(4, "a4", 4, emptyList(), 3_600, owned = false, craftable = false),
        ), appliedTier = 1, previewVerified = true),
        wake = WakeUi(owned = true, shown = false, recipe = null), marketLevel = 2, job = null, saved = null)

    // SPEC §2.7: an owned look is free to show or hide (green confirm / stone), never a gold job.
    @Test fun `awning tiers craft, show, hide or lock by ownership and Market level`() {
        assertEquals(3, defaultAwningTier(style.awning))
        assertEquals("CRAFT AWNING III", stylePrimary(style, now)!!.label)
        assertEquals("ON" to Verb.GREEN, awningTag(style.awning.tiers[0], 1))
        assertEquals("MKT 4" to Verb.STONE, awningTag(style.awning.tiers[3], 1))
        val show = stylePrimary(style.copy(selectedTier = 2), now)!!
        assertEquals(PrimaryAction.SHOW, show.action)
        assertEquals(Verb.GREEN, show.verb)
        assertEquals(PrimaryAction.HIDE, stylePrimary(style.copy(selectedTier = 1), now)!!.action)
        assertEquals(CommandState.LOCKED, stylePrimary(style.copy(selectedTier = 2, marketLevel = 1), now)!!.state)
        assertEquals("Preview unavailable. Crafting is held.",
            stylePrimary(style.copy(awning = style.awning.copy(previewVerified = false)), now)!!.reason)
        assertNull(stylePrimary(style.copy(wakeSelected = true), now))
    }

    private val harvest = HarvesterYieldUi("crownlands", "crownlands", "crown_iron_ore", 2, 2, HarvesterPolicyUi(12, 21_600),
        HarvesterIntervalUi(IntervalState.RUNNING, now - 1_000, now + 7_800_000), HarvesterArrivedUi(0, null), 36, StockUi(48),
        "+4 per haul at Lv 3", PriceUi(Currency.SHARDS, "24,000", PriceStatus.OK), actionsAllowed = true, saved = null)

    // SPEC 0.2: hauls are delivered by the server; COLLECT is a client-only acknowledgement, so it works on a read-only base.
    @Test fun `an arrived haul is acknowledged client-side even on a read-only base`() {
        val arrived = harvest.copy(arrived = HarvesterArrivedUi(12, "now"), actionsAllowed = false, interval = harvest.interval.copy(nextHaulAtMs = now + 21_600_000))
        val primary = harvesterPrimary(arrived)!!
        assertEquals("COLLECT 12", primary.label)
        assertEquals(PrimaryAction.COLLECT, primary.action)
        assertEquals("Next haul in 6h 00m.", harvesterNote(arrived, now))
        assertEquals("12 ore arrived", harvesterLive(arrived, now, null)!!.text)
    }

    @Test fun `harvester upgrade follows its price and hides at max level`() {
        assertEquals(PrimaryAction.UPGRADE, harvesterPrimary(harvest)!!.action)
        assertEquals(Verb.GREEN, harvesterPrimary(harvest)!!.verb)
        assertEquals(PrimaryAction.NEED_MORE, harvesterPrimary(harvest.copy(upgradeCost = PriceUi(Currency.SHARDS, "24,000", PriceStatus.SHORT)))!!.action)
        assertEquals(PrimaryAction.UPGRADE, harvesterPrimary(harvest.copy(upgradeCost = PriceUi(Currency.SHARDS, null, PriceStatus.CHECKING)))!!.action)
        assertEquals(CommandState.DISABLED, harvesterPrimary(harvest.copy(upgradeCost = PriceUi(Currency.SHARDS, null, PriceStatus.UNAVAILABLE)))!!.state)
        assertNull(harvesterPrimary(harvest.copy(upgradeCost = null, nextLevelDelta = null)))
        assertEquals(CommandState.LOCKED, harvesterPrimary(harvest.copy(complete = false))!!.state)
        assertEquals("START AGAIN", harvesterPrimary(harvest.copy(interval = HarvesterIntervalUi(IntervalState.ENDED, null, null)))!!.label)
        assertEquals("Next haul", harvesterLive(harvest, now, null)!!.text)
        assertEquals("2h 10m", harvesterLive(harvest, now, null)!!.accent)
    }

    @Test fun `default tabs follow the SPEC priority and only offer available tabs`() {
        val all = listOf(WorkshopTab.REFINE, WorkshopTab.INGOTS, WorkshopTab.EQUIPMENT, WorkshopTab.COSMETICS)
        assertEquals(WorkshopTab.INGOTS, workshopDefaultTab(true, WorkshopTab.EQUIPMENT, WorkshopTab.COSMETICS, all))
        assertEquals(WorkshopTab.EQUIPMENT, workshopDefaultTab(false, WorkshopTab.EQUIPMENT, WorkshopTab.COSMETICS, all))
        assertEquals(WorkshopTab.COSMETICS, workshopDefaultTab(false, null, WorkshopTab.COSMETICS, all))
        assertEquals(WorkshopTab.REFINE, workshopDefaultTab(true, null, null, listOf(WorkshopTab.REFINE)))
        assertEquals(MarketTab.ORDERS, marketDefaultTab(true, listOf(MarketTab.BUY, MarketTab.ORDERS)))
        assertEquals(MarketTab.BUY, marketDefaultTab(false, listOf(MarketTab.BUY, MarketTab.ORDERS)))
    }

    // SPEC 0.1: four tabs fit only with ≤ 6-glyph labels; the registry ids stay unchanged.
    @Test fun `stacked tab labels fit and keep the registry ids`() {
        val workshop = workshopTabs(ingotsReady = true)
        assertEquals(listOf("REFINE", "INGOTS", "EQUIPMENT", "COSMETICS"), workshop.map { it.id })
        assertTrue((workshop + marketTabs()).all { it.label.length <= 6 })
        assertNotNull(workshop.single { it.id == WorkshopTab.INGOTS }.badge)
        assertEquals(listOf("BUY", "SELL", "MY ORDERS", "COLLECTION"), marketTabs().map { it.id })
    }

    // SPEC §4.1 mismatch: art comes from the server's art key, never from guessing; unknown items never borrow art.
    @Test fun `art names come from exact keys and unknown items get the question glyph`() {
        assertEquals("crown_iron_ore", catalogueKey("CrownIronOre"))
        assertEquals("crown_iron_ore", catalogueKey("crown-iron-ore"))
        assertEquals("craft:inv_prismstone_lens", craftItemIcon("PrismstoneLens"))
        assertEquals("ui:navigation-kit", craftItemIcon("navigation_kit"))
        assertEquals("shape:unknown", craftItemIcon("mystery_ore"))
        assertNull(harvesterSprite("solana-reach", 2, HarvesterSprite.IDLE))
        assertEquals("craft:harv_seeker_reach_t4_ready", harvesterSprite("seeker-reach", 9, HarvesterSprite.READY))
        assertEquals("craft:workshop_t1_working", workshopSprite(null, BenchSprite.WORKING))
    }

    @Test fun `atlas frames land on the authored grid`() {
        assertEquals(116 to 116, atlasFrameOrigin(CraftAtlases.workshopWorking(2), 4))
        assertEquals(2 to 2, atlasFrameOrigin(CraftAtlases.workshopWorking(2), 9))
        assertEquals(512 to 0, atlasFrameOrigin(CraftAtlases.ingotReady, 8))
        assertEquals(3, loopFrame(500, 6, 8))
    }
}
