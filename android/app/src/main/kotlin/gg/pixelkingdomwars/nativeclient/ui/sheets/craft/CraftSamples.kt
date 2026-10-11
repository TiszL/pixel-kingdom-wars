package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi

/*
 * Design component: none. Preview-only sample data for the craft cluster, matching the craft mockup PNGs. Every number
 * here is a placeholder (craft/SPEC.md: "Every number in the mockups is a placeholder"); real values come from the
 * mappers. Not referenced by production code.
 */
internal object CraftSamples {
    /** The fixed preview clock (server time = device time: offset 0). */
    const val NOW = 1_790_000_000_000L

    private fun item(id: String, name: String, source: String, here: String? = null, plural: String = name, usedFor: String? = null) =
        CraftItemUi(id, name, craftItemIcon(id), source, here, plural, usedFor)

    val items: Map<String, CraftItemUi> = listOf(
        item("frost_quartz", "Frost Quartz", "Frostveil harvester"),
        item("frostglass", "Frostglass", "Refine here, from quartz", "refine_frostglass", usedFor = "For tools and kits."),
        item("crown_iron_ore", "Crown Iron Ore", "Crownlands harvester"),
        item("crownsteel", "Crownsteel", "Refine here, from iron ore", "refine_crownsteel", usedFor = "For tools and kits."),
        item("rough_prism", "Rough Prism", "Seeker Reach harvester"),
        item("prismstone_lens", "Prismstone Lens", "Refine here, from prism", "refine_prismstone", plural = "Prismstone Lenses"),
        item("ember_nodules", "Ember Nodules", "Cinderfall harvester"),
        item("embercore", "Embercore", "Refine here, from nodules", "refine_embercore"),
        item("heartwood_logs", "Heartwood Logs", "Elderwood harvester"),
        item("heartwood_beams", "Heartwood Beams", "Refine here, from logs", "refine_beams"),
        item("thorn_fibre", "Thorn Fibre", "Thornwake harvester"),
        item("thornsilk", "Thornsilk", "Refine here, from fibre", "refine_thornsilk"),
        item("stormalloy", "Stormalloy", "Refine here, from storm ore"),
        item("sunstone_blocks", "Sunstone Blocks", "Refine here, from rubble"),
        item("navigation_kit", "Navigation Kit", "Craft here", plural = "Navigation Kits"),
        item("climate_kit", "Climate Kit", "Craft here", plural = "Climate Kits"),
        item("expedition_kit", "Expedition Kit", "Craft here", plural = "Expedition Kits"),
        item("crystal_fragments", "Fragments", "Divine Isle"),
        item("route_compass", "Route Compass", "Craft here", plural = "Route Compasses"),
        item("survey_lens", "Survey Lens", "Craft here", plural = "Survey Lenses"),
        item("land_deed", "Land Deed", "Owned on-chain"),
    ).associateBy { it.itemId }

    private fun refineRecipe(id: String, out: String, input: String, perUnit: Long, sec: Long, usedFor: String, locked: LockReasonUi? = null) =
        RecipeUi(id, "1", RecipeGroup.REFINE, out, 1, listOf(RecipeInputUi(InputKind.RAW, input, perUnit)), sec, usedFor, locked)

    private fun kit(id: String, out: String, a: String, b: String, sec: Long, usedFor: String) =
        RecipeUi(id, "1", RecipeGroup.KIT, out, 1, listOf(RecipeInputUi(InputKind.CRAFTING, a, 2), RecipeInputUi(InputKind.CRAFTING, b, 1),
            RecipeInputUi(InputKind.SHARDS, "shards", 600)), sec, usedFor, null)

    private val recipes = listOf(
        refineRecipe("refine_frostglass", "frostglass", "frost_quartz", 4, 90, "For Survey Lens and Navigation Kit."),
        refineRecipe("refine_crownsteel", "crownsteel", "crown_iron_ore", 4, 90, "For Route Compass and Expedition Kit."),
        refineRecipe("refine_prismstone", "prismstone_lens", "rough_prism", 4, 120, "For Route Compass and Navigation Kit."),
        refineRecipe("refine_embercore", "embercore", "ember_nodules", 4, 150, "Builds Ember Engines.", LockReasonUi("Unlocks at Workshop 3", "Workshop 3")),
        refineRecipe("refine_beams", "heartwood_beams", "heartwood_logs", 4, 90, "For Expedition Kit."),
        refineRecipe("refine_thornsilk", "thornsilk", "thorn_fibre", 3, 90, "For Climate Kit and awnings."),
        kit("kit_navigation", "navigation_kit", "frostglass", "prismstone_lens", 180, "Plots a safer route at the Lodge."),
        kit("kit_climate", "climate_kit", "thornsilk", "frostglass", 180, "Keeps the crew warm on cold trips."),
        kit("kit_expedition", "expedition_kit", "heartwood_beams", "thornsilk", 240, "Packs a longer trip at the Lodge."),
    )

    private val stock: Map<String, StockUi> = mapOf(
        "frostglass" to 14L, "crownsteel" to 3L, "prismstone_lens" to 8L, "embercore" to 1L, "heartwood_beams" to 0L, "thornsilk" to 2L,
        "navigation_kit" to 2L, "climate_kit" to 0L, "expedition_kit" to 1L, "frost_quartz" to 36L, "crown_iron_ore" to 48L,
        "rough_prism" to 9L, "ember_nodules" to 4L, "heartwood_logs" to 6L, "thorn_fibre" to 12L,
    ).mapValues { StockUi(it.value) }

    /** workshop-refine.png: Frostglass × 6, Frost Quartz 36/24. */
    val refine = WorkshopRefineUi(recipes, stock, maxBatch = 10, acceptingJobs = true, pendingJobs = emptyList(), actionsAllowed = true,
        selectedRecipeId = "refine_frostglass", quantity = 6, savedOperation = null, hydration = CraftHydration.Ready, items = items, shards = 40_943)

    /** workshop-short.png: Expedition Kit × 2, Heartwood Beams 0/4. */
    val refineShort = refine.copy(selectedRecipeId = "kit_expedition", quantity = 2)

    /** workshop-working.png: 6 Frostglass, 3:48 left. */
    val refineWorking = refine.copy(pendingJobs = listOf(BenchJobUi("job-1", "refine_frostglass", 6, NOW + 228_000L, "14:32")))

    /** workshop-done.png. */
    val batchDone = CraftCelebrationUi("job-0", "BATCH DONE", craftItemIcon("frostglass"), "+6 FROSTGLASS", "In your stores. The bench is free.")

    val refineReview = CraftReviewUi("REFINE 6 FROSTGLASS", "No refunds. Nothing is spent until you tap START.")

    /** workshop-ingots.png: 12/20 today, 8/30 holding, CAST 4 for 8,000 Shards. */
    val ingots = WorkshopIngotsUi(IngotInventoryUi(8, 0),
        IngotAllowanceUi(IngotDailyUi(12, 20, 8), IngotHoldingUi(8, 0, 30, 22), NOW + 22_800_000L),
        shardsPerIngot = 2_000, batch = IngotBatchUi(8), job = null, shards = 40_943, actionsAllowed = true, saved = null, quantity = 4,
        secondsPerIngot = 30)

    /** workshop-ready.png: 4 ingots cooled. */
    val ingotsReady = ingots.copy(job = IngotJobUi("job-i", 4, NOW - 1_000L, IngotJobState.READY))

    /** workshop-tools.png. */
    val tools = WorkshopToolsUi(
        recipes = listOf(
            ToolRecipeUi("craft_route_compass", "route_compass", "Route Compass", "COMPASS", "Faster return, a bit less cargo.",
                craftItemIcon("route_compass"), listOf(RecipeInputUi(InputKind.CRAFTING, "prismstone_lens", 2), RecipeInputUi(InputKind.CRAFTING, "crownsteel", 4)), 1_800),
            ToolRecipeUi("craft_survey_lens", "survey_lens", "Survey Lens", "LENS", "Swap some cargo for a second material.",
                craftItemIcon("survey_lens"), listOf(RecipeInputUi(InputKind.CRAFTING, "frostglass", 4), RecipeInputUi(InputKind.CRAFTING, "heartwood_beams", 2)), 1_800),
        ),
        owned = mapOf("route_compass" to 1L, "survey_lens" to 0L),
        travelling = listOf(TravellingToolUi("route_compass", NOW + 7_800_000L, "inst-1")),
        job = null, acceptingJobs = true, saved = null, selectedRecipeId = "craft_route_compass",
        stock = stock + ("crownsteel" to StockUi(5)), items = items, shards = 40_943)

    /** workshop-style.png: tier I on, II owned, III craftable (selected), IV needs Market 4. Thornsilk is illustrative. */
    val style = WorkshopStyleUi(
        awning = AwningUi(listOf(
            AwningTierUi(1, "awning_t1", 1, emptyList(), 3_600, owned = true, craftable = false),
            AwningTierUi(2, "awning_t2", 2, emptyList(), 3_600, owned = true, craftable = false),
            AwningTierUi(3, "awning_t3", 3, listOf(RecipeInputUi(InputKind.CRAFTING, "thornsilk", 6)), 3_600, owned = false, craftable = true),
            AwningTierUi(4, "awning_t4", 4, listOf(RecipeInputUi(InputKind.CRAFTING, "thornsilk", 10)), 3_600, owned = false, craftable = false,
                lockReason = LockReasonUi("Needs a level 4 Market.", "Market 4")),
        ), appliedTier = 1, previewVerified = true),
        wake = WakeUi(owned = true, shown = false, recipe = null),
        marketLevel = 3, job = null, saved = null, selectedTier = 3, stock = stock + ("thornsilk" to StockUi(6)), items = items, shards = 40_943)

    private val shardsRow = ResourceChipUi(FeatureId("hud.shards"), "shards", "40,943", 0.62f, false, null, name = "Shards", accent = ResourceAccent.SHARDS)
    private val keepRow = ResourceChipUi(FeatureId("hud.keep"), "keep", "312.5", null, false, null, name = "KEEP", accent = ResourceAccent.KEEP)

    /** A Workshop sheet on the tab whose state is given (REFINE when none is). */
    fun workshop(refine: WorkshopRefineUi? = null, working: Boolean = false, ingots: WorkshopIngotsUi? = null, ingotsReady: Boolean = false,
        tools: WorkshopToolsUi? = null, style: WorkshopStyleUi? = null): WorkshopSheetUi {
        val tab = when {
            ingots != null -> WorkshopTab.INGOTS
            tools != null -> WorkshopTab.EQUIPMENT
            style != null -> WorkshopTab.COSMETICS
            else -> WorkshopTab.REFINE
        }
        val bench = when { working -> BenchSprite.WORKING; ingotsReady -> BenchSprite.READY; else -> BenchSprite.IDLE }
        return WorkshopSheetUi(
            frame = CraftFrameUi("WORKSHOP", "LV 2", null, history = true, tabs = workshopTabs(ingotsReady = ingotsReady), selectedTab = tab),
            header = workshopHeader(2, bench), refine = refine, ingots = ingots, tools = tools, style = style, spend = shardsRow)
    }

    private fun offer(id: String, itemId: String, qty: Long, tenths: Long, seller: String = "Ashford", mine: Boolean = false) =
        MarketOfferUi(id, itemId, qty, tenths * 100_000_000L, 9, Currency.KEEP, "base-$seller", seller, 1, mine)

    /** market-buy.png. */
    val buy = MarketBuyUi(
        category = "materials",
        offers = listOf(
            offer("o-1", "frostglass", 20, 18), offer("o-2", "crownsteel", 12, 24), offer("o-3", "embercore", 6, 31),
            offer("o-4", "heartwood_beams", 40, 9), offer("o-5", "prismstone_lens", 8, 26), offer("o-6", "thornsilk", 15, 12),
            offer("o-7", "stormalloy", 10, 29), offer("o-8", "sunstone_blocks", 30, 11),
        ),
        nextCursor = "page-2", selectedOfferId = "o-1", quantity = 10, held = mapOf("frostglass" to 14L),
        wallet = MarketWalletUi(true, keep = "312.5", keepBaseUnits = 312_500_000_000L), deliveryBaseId = "base-home",
        paymentsAvailable = true, feeBps = 500,
        categories = listOf(MarketCategoryUi("materials", "MATERIALS"), MarketCategoryUi("tools", "TOOLS"),
            MarketCategoryUi("fragments", "FRAGMENTS"), MarketCategoryUi("deeds", "DEEDS", "sol")),
        items = items, totalLots = 48)

    /** market-sell.png: 10 Frostglass at 1.9, fee 5 %. */
    val sell = MarketSellUi(
        sellable = listOf(SellableUi("crownsteel", 3, 0), SellableUi("frostglass", 14, 0), SellableUi("prismstone_lens", 8, 0),
            SellableUi("crystal_fragments", 5, 0), SellableUi("route_compass", 1, 0)),
        selectedItemId = "frostglass", qty = 10, unitPrice = 1_900_000_000L, tick = 100_000_000L, lowestOffer = 1_800_000_000L,
        feeBps = 500, slots = MarketSlotsUi(3, 5), listingAllowed = true, items = items)

    /** market-orders.png. */
    val orders = MarketOrdersUi(
        sold = listOf(SoldOrderUi("s-1", "crownsteel", 6, "14.4", Currency.KEEP, "2h ago")),
        open = listOf(
            OpenOrderUi("l-1", "frostglass", 10, 4, "1.9", Currency.KEEP, OpenOrderState.OPEN, "base-home"),
            OpenOrderUi("l-2", "crystal_fragments", 5, 0, "4.0", Currency.KEEP, OpenOrderState.OPEN, "base-home"),
            OpenOrderUi("l-3", "land_deed", 1, 0, "2.5", Currency.SOL, OpenOrderState.PAYING, "base-home"),
        ),
        slots = MarketSlotsUi(3, 5), items = items)

    val owned = MarketOwnedUi(listOf(OwnedAssetUi("deed-142", "itm_deed_earth", "LAND DEED #142", "5% ROYALTY", sellable = true)))

    /** A Market sheet on the tab whose state is given (BUY when none is). */
    fun market(buy: MarketBuyUi? = null, sell: MarketSellUi? = null, orders: MarketOrdersUi? = null, owned: MarketOwnedUi? = null,
        sold: Boolean = false): MarketSheetUi {
        val tab = when {
            sell != null -> MarketTab.SELL
            orders != null -> MarketTab.ORDERS
            owned != null -> MarketTab.OWNED
            else -> MarketTab.BUY
        }
        val live = if (sold) CraftLiveUi("ui:ready-status", "1 lot sold", ready = true) else CraftLiveUi("ui:queue-status", "2 lots listed")
        return MarketSheetUi(CraftFrameUi("MARKET", "LV 2", live, history = true, tabs = marketTabs(sold), selectedTab = tab),
            marketHeader(2, null), buy, sell, orders, owned, spend = keepRow)
    }

    /** harvester-yield.png: Crown Iron Ore, next haul in 2h 10m, UPGRADE 24,000. */
    val harvester = HarvesterSheetUi(
        frame = CraftFrameUi("HARVESTER", "LV 2", null, history = false, tabs = harvesterTabs(), selectedTab = HarvesterTab.YIELD, stackedTabs = false),
        header = CraftHeaderUi(harvesterSprite("crownlands", 2, HarvesterSprite.IDLE)),
        harvest = HarvesterYieldUi(realmId = "crownlands", artKey = "crownlands", resourceId = "crown_iron_ore", level = 2, tier = 2,
            policy = HarvesterPolicyUi(12, 21_600), interval = HarvesterIntervalUi(IntervalState.RUNNING, NOW - 13_800_000L, NOW + 7_800_000L),
            arrived = HarvesterArrivedUi(0, null), todayArrived = 36, stock = StockUi(48), nextLevelDelta = "+4 per haul at Lv 3",
            upgradeCost = PriceUi(Currency.SHARDS, "24,000", PriceStatus.OK), actionsAllowed = true, saved = null,
            realmName = "Crownlands", resourceName = "Crown Iron Ore",
            refineDoor = DoorRowUi("refine_crownsteel", craftItemIcon("crownsteel"), "Crownsteel", "Refine it at the Workshop",
                "Go to the Workshop to refine Crownsteel"),
            sellDoor = DoorRowUi("crown_iron_ore", "ui:market-menu", "Spare ore", "Sell it at the Market", "Go to the Market to sell spare ore")),
        history = HarvesterHistoryUi(listOf(
            HarvestRecordUi("h-3", "Today 08:00", "+12", "Ashford"),
            HarvestRecordUi("h-2", "Today 02:00", "+12", "Ashford"),
            HarvestRecordUi("h-1", "Yesterday 20:00", "+12", "Ashford"),
        )),
        spend = shardsRow)

    /** harvester-arrived.png: 12 ore arrived, next haul in 6h 00m. */
    val harvesterArrived = harvester.copy(
        header = CraftHeaderUi(harvesterSprite("crownlands", 2, HarvesterSprite.READY)),
        harvest = harvester.harvest.copy(arrived = HarvesterArrivedUi(12, "just now"),
            interval = harvester.harvest.interval.copy(nextHaulAtMs = NOW + 21_600_000L)))
}
