package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.model.WallRowQuote
import gg.pixelkingdomwars.nativeclient.model.WallRowWall
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PAID_STEP_SUB
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.PRICE_UNAVAILABLE
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.UpgradePrimaryKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.UpgradeState
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.upgradePrimaryLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.InfoLoad
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.InfoPrimaryKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.InfoTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.infoPrimaryTap
import java.io.File
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The designed building sheets act in place (night 2026-10-06, slice D). Why it matters: every INFO / UPGRADE door must
 * reach the action the player asked for on the designed sheet, but a money step may only ever open its own consent (the
 * SOL Seal, the HeroAltarConfirm review, the old KEEP confirmation), never the Shards order beside it; a door that does
 * nothing, or a number the catalogue never stated, is a trust bug.
 */
class LiveSheetsDesignTest {
    private val calls = mutableListOf<String>()
    private val routes = LiveBuildingRoutes(
        onClose = { calls += "close" }, onReview = { calls += "review" }, onUpgrade = { calls += "upgrade" },
        onFinish = { calls += "finish" }, onCancelJob = { calls += "cancel" }, onToggleRow = { calls += "row" },
        onBuilders = { calls += "builders" }, onGoToMine = { calls += "mine $it" }, onOpenBuild = { calls += "build" },
        onPaidUpgrade = { calls += "paid" }, onHeroes = { calls += "heroes" }, onRearm = { calls += "rearm" },
        onExpand = { calls += "expand" },
    )

    private fun solStep(sol: String? = "0.5", offer: Boolean = true) =
        towerFacts(paidStep = true, paidOfferReady = offer).copy(paidSol = sol, paidTime = "4h")

    @Test fun `a SOL step is admitted on the designed sheet with its SOL chip and only opens the Seal`() {
        val f = solStep()
        // H1 stays: the Shards review still declines the SOL step, so the money mapper never prices it.
        assertNull(liveUpgradeUi(f))
        val ui = requireNotNull(livePaidUpgradeUi(f))
        assertEquals(PriceUi(Currency.SOL, "0.5", PriceStatus.OK), ui.solPrice)
        assertEquals(PriceUi(Currency.SHARDS, "521", PriceStatus.OK), ui.price)
        assertEquals("4h", ui.time)
        assertEquals(UpgradeState.READY, ui.state)
        assertEquals(UpgradePrimaryKind.UPGRADE, upgradePrimaryLook(ui.state, ui.price, ui.reason).kind)
        dispatchUpgradeSheetPrimary(ui, { calls += "upgrade" }, { calls += "paid" })
        assertEquals("the SOL step opens the Seal, never the Shards order", listOf("paid"), calls)
        // The combined entry the mount asks for FULL admits it without touching the owner (unavailable costs).
        val envelope = LiveBuildingSheetFacts(f, LiveBuildingCosts.unavailable())
        assertEquals(PriceStatus.OK, liveUpgradeSheetUi(envelope)?.solPrice?.status)
        val host = source("ui/sheets/buildings/live/LiveSheetHosts.kt")
        assertTrue(host.contains("dispatchUpgradeSheetPrimary(ui, { sent = true; routes.onUpgrade() }, routes.onPaidUpgrade)"))
        assertTrue(host.contains("val ui = liveUpgradeSheetUi(review, sent) ?: return"))
    }

    @Test fun `a Shards upgrade still sends its own order and never the Seal`() {
        val ui = requireNotNull(liveUpgradeUi(towerFacts()))
        assertNull(ui.solPrice)
        dispatchUpgradeSheetPrimary(ui, { calls += "upgrade" }, { calls += "paid" })
        assertEquals(listOf("upgrade"), calls)
    }

    @Test fun `a SOL step without an amount or a paid offer is off with a reason and cannot open the Seal`() {
        for (f in listOf(solStep(sol = null), solStep(offer = false))) {
            val ui = requireNotNull(livePaidUpgradeUi(f))
            assertEquals(UpgradeState.READ_ONLY, ui.state)
            assertEquals(PRICE_UNAVAILABLE, ui.reason)
            assertFalse(upgradePrimaryLook(ui.state, ui.price, ui.reason).sends)
        }
        assertEquals(PriceStatus.UNAVAILABLE, livePaidUpgradeUi(solStep(sol = null))?.solPrice?.status)
        assertNull("an unknown SOL amount is never drawn as a number", livePaidUpgradeUi(solStep(sol = null))?.solPrice?.amount)
        val paused = requireNotNull(livePaidUpgradeUi(towerFacts(paidStep = true, paidOfferReady = true, enabled = false, readOnly = true)
            .copy(paidSol = "0.5")))
        assertEquals(UpgradeState.READ_ONLY, paused.state)
        assertEquals("Orders are paused here", paused.reason)
    }

    @Test fun `hero and spent trap INFO primaries route to Heroes and to an in place rearm`() {
        val altar = towerFacts(type = "heroaltar", category = BuildingCategory.HERO, level = 1, maxLevel = 1, canShowUpgrade = false)
        val info = liveBuildingInfoUi(altar)
        assertEquals(InfoPrimaryKind.UPGRADE, info.primary.kind)
        assertEquals("MANAGE HERO", info.primary.label)
        assertEquals("a max level altar still opens Heroes", CommandState.ENABLED, info.primary.state)
        assertEquals(InfoTap.UPGRADE, infoPrimaryTap(InfoLoad.READY, info.primary.kind, info.primary.state, info.primary.price))
        assertNull("hero upgrades are priced on the Heroes sheet, not here", info.price)
        dispatchInfoUpgrade(altar, routes) { calls += "rearm short" }
        assertEquals(listOf("heroes"), calls)

        calls.clear()
        val trap = towerFacts(type = "spiketrap", category = BuildingCategory.TRAP, repair = RepairFact("1,250", "2h", "1250"))
        dispatchInfoUpgrade(trap, routes) { calls += "rearm short" }
        assertEquals("a spent trap rearms in place, not through the old review", listOf("rearm"), calls)

        calls.clear()
        val short = trap.copy(shardsBalance = "100")
        dispatchInfoUpgrade(short, routes) { calls += "rearm short" }
        assertEquals("short of Shards opens Need-more instead of a refused order", listOf("rearm short"), calls)
        assertEquals("1,150", liveRearmNeedMore(short)?.blocks?.single()?.more)
        assertNull("an unknown balance never claims a shortfall", liveRearmNeedMore(trap.copy(shardsBalance = null)))

        calls.clear()
        dispatchInfoUpgrade(solStep(), routes) { calls += "rearm short" }
        dispatchInfoUpgrade(towerFacts(), routes) { calls += "rearm short" }
        assertEquals(listOf("paid", "review"), calls)
    }

    @Test fun `the Keep offers EXPAND as its fifth action and the wall keeps ROW`() {
        val keep = towerFacts(type = "keep", category = BuildingCategory.KEEP)
        assertEquals(InfoExtraKind.EXPAND, liveInfoExtraKind(keep))
        assertEquals("Expand land", liveBuildingInfoUi(keep).extra?.label)
        dispatchInfoExtra(keep, routes)
        dispatchInfoExtra(towerFacts(type = "wall", category = BuildingCategory.WALL), routes)
        assertEquals(listOf("expand", "row"), calls)
        assertEquals("a refundable cancel still wins the one slot", InfoExtraKind.CANCEL_JOB,
            liveInfoExtraKind(keep.copy(job = upgradeJob(refund = "260"))))
    }

    @Test fun `a KEEP or item priced upgrade stays on the old review and a KEEP build keeps its dialog`() {
        // Hero altars are recruited with KEEP or a contract: no designed UPGRADE sheet may stand in for that consent.
        for (type in HERO_BUILDING_TYPES) {
            val hero = towerFacts(type = type, category = BuildingCategory.HERO)
            assertNull(type, liveUpgradeSheetUi(LiveBuildingSheetFacts(hero, LiveBuildingCosts.unavailable())))
            assertNull(type, livePaidUpgradeUi(hero.copy(paidStep = true, paidOfferReady = true, paidSol = "1")))
        }
        assertNull("not a SOL step, no paid projection", livePaidUpgradeUi(towerFacts()))
        val keepMine = PlacementFacts(type = "mine", name = "MINE", art = "", footprint = 2, tile = 1 to 1, currency = "KEEP",
            amount = "500", amountRaw = "500", time = "1h", shardsBalance = "9000", freeBuilders = 1, totalBuilders = 2,
            nextBuilderFreeIn = null, available = true, readOnly = false, constructionBlocked = false, busy = false, heroOffer = false)
        assertNull("the second Mine (KEEP) keeps the legacy dialog's words as its consent", livePlacementUi(keepMine))
    }

    @Test fun `INFO shows a SOL step without an amount and says the Seal reviews it`() {
        val ui = liveBuildingInfoUi(solStep())
        assertNull(ui.price)
        assertEquals(PAID_STEP_SUB, ui.primary.sub)
        assertFalse(ui.toString().contains("0.5"))
    }

    @Test fun `the Gems need-more door only navigates to the Gold Forge`() {
        val more = requireNotNull(liveGemsNeedMore("Builder finish", "10", "38"))
        assertEquals(LiveDoors.GEMS, more.best.destination)
        assertEquals("28", more.blocks.single().more)
        assertEquals("have 10 · need 38", gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.haveNeedLine(more.blocks.single().have, more.blocks.single().need))
        assertTrue("no block door: the one door is the Gold Forge", more.blocks.single().doors.isEmpty())
        assertNull("a Gems door never selects a Mine", needMoreDoorTarget(LiveDoors.GEMS, MineFact("mine-1", "8,400")))
        assertNull("enough Gems: no sheet", liveGemsNeedMore("Builder finish", "38", "38"))
        assertNull("unknown balance: no sheet", liveGemsNeedMore("Builder finish", null, "38"))
        assertFalse("never a conversion here", more.toString().contains("TO SHARDS"))
    }

    @Test fun `a wall toggle explains that leaving a wall out is not open and the quote never offers it`() {
        val explained = mutableListOf<String>()
        val toggle = wallRowToggle { explained += it }
        toggle("wall-3")
        assertEquals(listOf(WALL_ROW_TOGGLE_CLOSED), explained)
        val quote = WallRowQuote("base", "a", "f".repeat(64), 9, listOf(WallRowWall("a", 1, 1, 2, 3, "11"), WallRowWall("b", 2, 1, 2, 3, "11")),
            "22", "100", true, JsonObject(emptyMap()))
        val ui = liveWallRowReview(quote, null, false, true, false, null, "1/2 free")
        assertFalse(requireNotNull(ui.selectionHint).contains("Tap a wall"))
        val host = source("ui/sheets/buildings/live/LiveWallRowHost.kt")
        assertTrue(host.contains("onToggleWall = wallRowToggle { Toasts.post(it) }"))
        assertFalse("a toggle that does nothing is gone", host.contains("onToggleWall = {}"))
    }

    @Test fun `the wall row shows hitpoints each only where the catalogue states both tiers`() {
        val catalogue = buildJsonObject {
            putJsonObject("constants") {
                putJsonObject("STRUCTURES") { putJsonObject("wall") { put("maxTier", 5); putJsonArray("hpByTier") { add(700); add(900); add(1150) } } }
                putJsonObject("DEFENSE_LEVELING") { put("maxLevel", 10); put("statMultPerLevel", 1.1) }
            }
        }
        val quote = WallRowQuote("base", "a", "f".repeat(64), 9, listOf(WallRowWall("a", 1, 1, 2, 3, "11")), "11", "100", true, JsonObject(emptyMap()))
        val row = liveWallRowReview(quote, catalogue, false, true, false, null, "1/2 free").rows.single { it.label == "Hitpoints each" }
        assertEquals("900", row.old); assertEquals("1,150", row.new)
        assertTrue("no catalogue, no invented row",
            liveWallRowReview(quote, null, false, true, false, null, "1/2 free").rows.none { it.label == "Hitpoints each" })
    }

    @Test fun `capability rows come only from the catalogue's own yes or no`() {
        assertEquals(listOf(CapabilityFact(CapabilityKeys.AIR, true)), readCapabilities(catalogue(buildJsonObject { put("targetsAir", true) }), "cannon"))
        assertEquals(listOf(CapabilityFact(CapabilityKeys.AIR, true), CapabilityFact(CapabilityKeys.GROUND, false)),
            readCapabilities(catalogue(buildJsonObject { put("targetsAir", true); put("targetsGround", false) }), "cannon"))
        assertTrue("a missing key is no row, never a guessed NO", readCapabilities(catalogue(buildJsonObject { put("hp", 360) }), "cannon").isEmpty())
        assertTrue("a quoted string is not a catalogue boolean", readCapabilities(catalogue(buildJsonObject { put("targetsAir", "true") }), "cannon").isEmpty())
        assertTrue("a type without a DEFENSES row has none", readCapabilities(catalogue(buildJsonObject { put("targetsAir", true) }), "mine").isEmpty())

        val f = requireNotNull(readBuildingFacts(state(buildJsonObject { put("hp", 360); put("targetsAir", false) }), cannon, false, 0L))
        val stat = liveBuildingInfoUi(f).stats.single { it.label == "Hits flying troops" }
        assertEquals(false, stat.yesNo)
        assertTrue(liveBuildingInfoUi(towerFacts()).stats.none { it.yesNo != null })
    }

    @Test fun `the Keep upgrade lists what its next level unlocks, other buildings list none`() {
        val keep = towerFacts(type = "keep", category = BuildingCategory.KEEP).copy(unlocks = listOf("NEW BUILDING — MARKET"))
        val rows = requireNotNull(liveUpgradeUi(keep)).rows
        assertEquals("NEW BUILDING — MARKET", rows.last().label)
        assertTrue(rows.last().unlock)
        assertTrue(requireNotNull(liveUpgradeUi(towerFacts())).rows.none { it.unlock })
    }

    @Test fun `INFO range reads in tiles with the table's number`() {
        assertEquals("7 tiles", infoStat(StatFact("RNG", "7", null)).now)
        assertEquals("360", infoStat(StatFact("HP", "360", "430")).now)
    }

    @Test fun `the bar's Need-more host closes on Back and its doors only navigate`() {
        val host = source("ui/sheets/buildings/live/LiveBarNeedMoreHost.kt")
        assertTrue(host.contains("BackHandlerAt(BackPriority.SHEET) { onClose() }"))
        assertTrue(host.contains("NeedMoreSheet(ui, needMoreActions(mine, onGoToMine, onOpenBuild, onClose), placed)"))
        val more = requireNotNull(liveShardsNeedMore("Spike Trap rearm", "100", "1,250", "1250", MineFact("mine-1", "8,400")))
        val doors = mutableListOf<String>()
        needMoreActions(MineFact("mine-1", "8,400"), { doors += "mine $it" }, { doors += "build" }, { doors += "close" }).onDoor(more.best.destination)
        assertEquals(listOf("close", "mine mine-1"), doors)
    }

    private val cannon = Building("c1", "cannon", 1, 0, 0)

    private fun catalogue(defense: JsonObject): JsonObject = buildJsonObject {
        putJsonObject("constants") {
            putJsonObject("UPGRADE_COSTS") { putJsonArray("cannon") { add("521"); add("900") } }
            putJsonObject("UPGRADE_TIMES_SEC") { putJsonArray("cannon") { add(5400); add(7200) } }
            putJsonObject("DEFENSES") { put("cannon", defense) }
            putJsonObject("DEFENSE_LEVELING") { put("maxLevel", 10); put("statMultPerLevel", 1.1) }
        }
        putJsonObject("display") { putJsonObject("upgradeSolLamports") { putJsonObject("cannon") {} } }
    }

    private fun state(defense: JsonObject) = KingdomUiState(
        home = BaseState(
            base = BaseSnapshot("b1", null, PlayerSummary(keepLevel = 3, builders = 2), null, null, null, listOf(cannon), emptyList(), emptyList(), 1,
                buildJsonObject { putJsonArray("buildings") { addJsonObject { put("id", "c1"); put("type", "cannon"); put("level", 1) } } }),
            balances = Balances(shards = "341", keep = "0"),
        ),
        catalogue = catalogue(defense),
    )

    private fun source(path: String): String {
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path"
        return listOf(File(relative), File("app/$relative")).first { it.isFile }.readText()
    }
}
