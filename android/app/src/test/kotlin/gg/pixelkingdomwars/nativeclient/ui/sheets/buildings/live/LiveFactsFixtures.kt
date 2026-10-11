package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

/** One archer tower at LV 4 on a base with a Mine, Shards known, a free builder: every field as the reader would fill it. */
internal fun towerFacts(
    level: Int = 4,
    maxLevel: Int = 10,
    canShowUpgrade: Boolean = true,
    enabled: Boolean = true,
    upgradeCost: String? = "521",
    upgradeCostRaw: String? = "521",
    upgradePriced: Boolean = true,
    upgradeTime: String? = "1h 30m",
    paidStep: Boolean = false,
    paidOfferReady: Boolean = false,
    job: JobFact? = null,
    repair: RepairFact? = null,
    shardsBalance: String? = "40943",
    freeBuilders: Int? = 1,
    totalBuilders: Int? = 2,
    nextBuilderFreeIn: String? = null,
    type: String = "archertower",
    category: BuildingCategory = BuildingCategory.DEFENCE,
    wallRow: Boolean = false,
    readOnly: Boolean = false,
    constructionBlocked: Boolean = false,
    busy: Boolean = false,
    heroReady: Boolean? = null,
    mine: MineFact = MineFact("mine-1", "8,400"),
    stats: List<StatFact> = listOf(StatFact("HP", "360", "430"), StatFact("DMG", "34", "41"), StatFact("RNG", "7", null)),
) = BuildingFacts(
    buildingId = "tower-1", type = type, name = "ARCHER TOWER", level = level, maxLevel = maxLevel,
    artNow = "ui_portrait_archertower_t1", artNext = "ui_portrait_archertower_t2", role = "Shoots the nearest attacker.",
    category = category, stats = stats, canShowUpgrade = canShowUpgrade, enabled = enabled, upgradeCost = upgradeCost,
    upgradeCostRaw = upgradeCostRaw, upgradePriced = upgradePriced, upgradeTime = upgradeTime, paidStep = paidStep,
    paidOfferReady = paidOfferReady, job = job, repair = repair, shardsBalance = shardsBalance, freeBuilders = freeBuilders,
    totalBuilders = totalBuilders, nextBuilderFreeIn = nextBuilderFreeIn, heroReady = heroReady, wallRow = wallRow,
    blockedReason = when {
        readOnly -> "Orders are paused here"
        constructionBlocked -> "Check the saved payment first"
        busy -> "Working…"
        else -> "Not available now"
    },
    readOnly = readOnly, constructionBlocked = constructionBlocked, busy = busy, mine = mine,
)

internal fun upgradeJob(freeFinish: Boolean = false, canReview: Boolean = true, refund: String? = "260") =
    JobFact("job-1", "upgrade", "1h 12m", freeFinish, canReview, refund)
