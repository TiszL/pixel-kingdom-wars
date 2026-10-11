package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceAccent
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi

/**
 * Preview data for the Gold Forge cluster (the mock values of the design/final/goldforge PNGs). Every number here is a
 * placeholder: in the app all values come from the server, already formatted. Not used outside @Preview functions.
 */
internal object GoldForgeSamples {
    val stepsChoosing = listOf(StepUi("Basket", "fill it now", StepState.NOW), StepUi("Raid", "win today", StepState.TODO),
        StepUi("Coins", "midnight", StepState.TODO))
    val stepsHeld = listOf(StepUi("Basket", "held", StepState.DONE), StepUi("Raid", "win today", StepState.NOW),
        StepUi("Coins", "midnight", StepState.TODO))
    val raidDays = RaidDaysUi(listOf(true, true, false, true, true, false, false), todayIndex = 6, bonus = "+8%")

    private val ingot = SmeltTileUi("forge_ingot", "gf:forge_ingot", "x6", 2, "300", "Workshop", "Gold Ingot")
    private val shards = SmeltTileUi("shards", "shards", "40.9K", 0, "1", "Harvesters", "Shards")
    private val crownsteel = SmeltTileUi("crownsteel", "craft:inv_crownsteel", "x14", 5, "200", "Workshop", "Crownsteel")
    private val ore = SmeltTileUi("storm_ore", "craft:inv_storm_ore", "x38", 0, "40", "Harvesters", "Storm Ore", canAdd = false)
    private val frost = SmeltTileUi("frostglass", "craft:inv_frostglass", "x3", 0, "180", "Workshop", "Frostglass")
    val tiles = listOf(ingot, shards, crownsteel, ore, frost)

    val smeltChoosing = SmeltUi("2 Oct", "free", "0", "5,000", "1,800", 0.36f, 0f, stepsChoosing, raidDays, tiles, crownsteel,
        null, null, smeltPrimaryCommand(SmeltState.CHOOSING, 7), null, SmeltState.CHOOSING)
    val smeltLoading = smeltChoosing.copy(committed = "…", cap = "…", basketValue = "…", tiles = emptyList(), selected = null,
        raidDays = null, primary = smeltPrimaryCommand(SmeltState.LOADING, 0), state = SmeltState.LOADING)
    val smeltHeld = smeltChoosing.copy(committed = "1,800", committedFill = 0.36f, basketFill = 0f, steps = stepsHeld,
        held = listOf(ingot.copy(chosen = 2), crownsteel), selected = null, estimate = "42",
        primary = smeltPrimaryCommand(SmeltState.HELD, 0), state = SmeltState.HELD)
    val smeltSeal = SmeltSealUi("7 items", "1,800", listOf("gf:forge_ingot", "craft:inv_crownsteel"), consent = true, armedAtMs = 0L)

    val claimReady = ClaimUi("1,240", 3, "42", "Seeker wallet", "8f2K", null, MoneyStage.READY, "6h 20m", canResumeSaved = false)
    val claimLocked = claimReady.copy(ready = "…", readyDays = null, lock = ClaimLockUi("Wed 14 Oct", "after the first island auction"),
        phase = ClaimPhase.LOCKED)

    val gems = GemsUi("1 KEEP = 1 GEM", "500", "500", "2,480", "1,980", listOf("100", "500", "1,000", "MAX"), "500", "1", "2,480",
        null, null, MoneyStage.READY, pendingRecovery = false, toShardsAvailable = true, swapOffered = false)

    val gemSpend = GemSpendUi(GemSpendKind.FINISH, "FINISH NOW?", "craft:workshop_t2_construction", "WORKSHOP", "Lv 2 › 3", 0.58f,
        "2h 14m", PriceUi(Currency.GEMS, "120", PriceStatus.OK), "1,250", "1,130", null, quotedAtMs = 0L, stage = MoneyStage.READY)

    val stack = listOf(
        ResourceChipUi(FeatureId("hud.gems"), "gem", "1,250", null, false, null, name = "Gems", accent = ResourceAccent.GEMS),
        ResourceChipUi(FeatureId("hud.keep"), "keep", "2,480", null, false, null, name = "KEEP", accent = ResourceAccent.KEEP),
    )

    val sheet = GoldForgeSheetUi("LV 3", HeroStatusUi(HeroStatusKind.FORGING, time = "6h 20m"), sceneWorking = true,
        tabs = goldForgeTabs(claimReady = false, gemsWaiting = 0, legacy = false), selectedTab = GoldForgeTabs.SMELT, stack = stack,
        smelt = smeltChoosing, claim = claimReady, gems = gems, history = true)
}
