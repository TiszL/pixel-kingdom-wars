package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kingdom.HomeSolSurface
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.STORES_DOOR_CLOSED
import gg.pixelkingdomwars.nativeclient.ui.kingdom.StoresGoTarget
import gg.pixelkingdomwars.nativeclient.ui.kingdom.homeSolSurface
import gg.pixelkingdomwars.nativeclient.ui.kingdom.kingdomReviewBlocked
import gg.pixelkingdomwars.nativeclient.ui.kingdom.storesGoTarget
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.StoresDoors
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The home-buildings mount (night UI, 2026-10-06): which body each door of the selected-building bar, Keep STORES, the
 * Builders / EXPAND / SOL-step money surfaces and the Home budget open now. Why it matters: the designed sheets were
 * built but unreachable, and the old screens (the purchase screen for HIRE / EXPAND / the SOL step, the old sheet for
 * REARM and hero upgrades, HeroBuildMenu, the guidance strip and the notice column) stayed on the player path. A door that
 * falls back to the old screen, or a money surface driven twice, is a regression even when every pure mapper passes.
 * Composables do not run on the JVM: the pure routing rules are tested directly and the mount is pinned by its text.
 */
class HomeBuildingsMountTest {
    private fun source(path: String) = listOf(File("src/main/kotlin/gg/pixelkingdomwars/nativeclient", path),
        File("app/src/main/kotlin/gg/pixelkingdomwars/nativeclient", path)).first { it.isFile }.readText()
    private val loaded = KingdomUiState(home = BaseState(base = BaseSnapshot.from(Json.parseToJsonElement(
        """{"baseId":"base-1","player":{"keepLevel":5},"buildings":[],"jobs":[]}""").jsonObject)))

    // WHY: every GO on the designed STORES sheet must land on a body; the registry doors (Workshop, Harvester, Market) go
    // through the Home dispatcher, which either opens the typed sheet or the mount says why in words.
    @Test fun `every Keep STORES GO lands on its own body and none is silent`() {
        assertEquals(StoresGoTarget.HERO_GEAR, storesGoTarget(StoresDoors.HERO_GEAR))
        assertEquals(StoresGoTarget.TRAIN, storesGoTarget(StoresDoors.TRAIN))
        assertEquals(StoresGoTarget.HERO_BUILD, storesGoTarget(StoresDoors.HERO_BUILD))
        for (door in listOf(StoresDoors.HARVEST, StoresDoors.WORKSHOP, StoresDoors.EQUIPMENT, StoresDoors.MARKET, FeatureId("unknown.door")))
            assertEquals(door.value, StoresGoTarget.REGISTRY, storesGoTarget(door))
        val screen = source("ui/kingdom/KingdomScreen.kt")
        assertTrue(screen.contains("StoresGoTarget.REGISTRY -> if (homeRouteDispatcher?.handleFeatureDoor(id) != true) Toasts.post(STORES_DOOR_CLOSED)"))
        assertTrue(STORES_DOOR_CLOSED.isNotBlank())
    }

    // WHY: Builders, EXPAND and the SOL-step sheet share ONE purchase owner; two composed at once would run two foreground
    // loops and one dismiss would clear the other's price check under a raised Seal.
    @Test fun `only one Home surface drives the SOL purchase owner at a time`() {
        assertNull(homeSolSurface(paidUpgradeOpen = false, expandOpen = false, buildersOpen = false))
        assertEquals(HomeSolSurface.BUILDERS, homeSolSurface(paidUpgradeOpen = false, expandOpen = false, buildersOpen = true))
        assertEquals(HomeSolSurface.EXPAND, homeSolSurface(paidUpgradeOpen = false, expandOpen = true, buildersOpen = true))
        assertEquals(HomeSolSurface.PAID_UPGRADE, homeSolSurface(paidUpgradeOpen = true, expandOpen = true, buildersOpen = true))
        val screen = source("ui/kingdom/KingdomScreen.kt")
        assertTrue(screen.contains("purchase = solPurchase.takeIf { solSurface == HomeSolSurface.BUILDERS }"))
        assertTrue(screen.contains("purchase = solPurchase.takeIf { solSurface == HomeSolSurface.EXPAND && !gg.pixelkingdomwars.nativeclient.BuildConfig.NATIVE_CANDIDATE }"))
        assertTrue(screen.contains("if (solSurface == HomeSolSurface.PAID_UPGRADE) state.selectedBuilding?.let { b ->"))
    }

    // WHY: C3 must not land a sheet or navigation on top of a money consent raised in place on Home.
    @Test fun `a SOL consent raised on Home blocks route admission like any private review`() {
        assertFalse(kingdomReviewBlocked(loaded, confirmation = false, heroReview = false, livePlacement = false))
        assertTrue(kingdomReviewBlocked(loaded, confirmation = false, heroReview = false, livePlacement = false, solConsent = true))
        assertTrue(source("ui/kingdom/KingdomScreen.kt").contains("solConsent = paidUpgradeOpen || solPurchase?.consentOpen == true"))
    }

    // WHY: the designed bar is only as good as what the mount feeds it: without extras and sent the plate has no type
    // line and COLLECT / REARM have no busy dots; without the routes STORES, EXPAND, GEAR, CLAN and REARM fall back.
    @Test fun `the selected-building bar gets its facts and every new door its owner`() {
        val screen = source("ui/kingdom/KingdomScreen.kt")
        assertTrue(screen.contains("buildingCommandBar(state, b, it, busy, now, phaseECommands, extras = extras, sent = barSent)"))
        assertTrue(screen.contains("buildingNamePlate(b, it, now, state, extras)"))
        assertTrue(screen.contains("collect = { barSent = BuildingCommandIds.COLLECT; model.collectMine() }"))
        assertTrue(screen.contains("rearm = { state.selectedBuilding?.let { barSent = BuildingCommandIds.REARM; model.repairTrap(it.id) } }"))
        assertTrue(screen.contains("stores = { if (keepStores != null) { storesOpen = true } else Toasts.post("))
        assertTrue(screen.contains("expand = { if (state.deedActionsAllowed) { buildersOpen = false; model.clearSelection(); model.openExpand() }"))
        assertTrue(screen.contains("gear = onOpenHeroGear, heroUpgrade = onOpenHeroes,"))
        assertTrue(screen.contains("rearmShort = { state.selectedBuilding?.let { trap ->"))
        assertTrue(screen.contains("clan = onOpenClan)"))
        // The surfaces those doors open are composed in place: Keep STORES, the bar's Need-more and the SOL-step Seal.
        assertTrue(screen.contains("keepStores?.invoke({ storesOpen = false }, storesGo, Modifier.zIndex(PkwTokens.Z.SHEET))"))
        assertTrue(screen.contains("LiveShardsNeedMoreHost(ui, readMineFact(state), model::selectBuilding,"))
        assertTrue(screen.contains("LivePaidUpgradeSeal(solPurchase, base?.baseId, b.id,"))
        val app = source("ui/nav/PkwApp.kt")
        assertTrue(app.contains("LiveKeepStoresHost(armyLiveRoster, homeCrafting, equipment = null,"))
        assertTrue(app.contains("researchBarFact(armyHomeState.domain, content.catalogue, now, account.selectedBaseId)"))
        assertTrue(app.contains("workshopBarFact(drawerCrafting, account.selectedBaseId, now)"))
        assertTrue(app.contains("handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId(\"clan.open\"))"))
        // STORES is a TALL sheet: the HUD trims to its BUILD form while it is drawn, as for the BUILD tray.
        assertTrue(app.contains("onKeepStoresShown = { keepStoresShown = it }"))
        assertTrue(app.contains("buildOpen = kingdomAudio.local.buildMenu && !kingdomAudio.local.heroesOnly || keepStoresShown,"))
    }

    // WHY: HIRE, EXPAND and the SOL step pay through the EXISTING owner and sender; the old purchase screen is reachable
    // only through DETAILS (recovery) or as the fallback when no owner is mounted.
    @Test fun `money surfaces run on the existing purchase owner with the old screen only for recovery`() {
        val app = source("ui/nav/PkwApp.kt")
        assertTrue(app.contains("graphViewModel(session) { gg.pixelkingdomwars.nativeclient.ui.kingdom.BasePurchaseViewModel(session.basePurchases) }"))
        assertTrue(app.contains("runCatching { graph.basePurchaseWallet(session, wallet) }.getOrNull()"))
        assertTrue(app.contains("HomeSolPurchase(homePurchaseModel, it)"))
        assertTrue(app.contains("solPurchase = homeSolPurchase,"))
        val screen = source("ui/kingdom/KingdomScreen.kt")
        assertTrue(screen.contains("onPurchaseDetails = { base.baseId?.let { buildersOpen = false; onBasePurchase(\"builder\", it, null) } })"))
        assertTrue(screen.contains("onPurchaseDetails = { base?.baseId?.let { model.closeSheet(); onBasePurchase(\"expansion\", it, null) } })"))
        assertTrue(screen.contains("onPaidUpgrade = { buildingSheet = null; buildersOpen = false; paidUpgradeOpen = true }"))
        // The SOL step now reaches the designed UPGRADE sheet; only KEEP / item priced upgrades keep the old BuildingSheet.
        assertTrue(screen.contains("buildingSheet == BuildingSheetMode.FULL && liveUpgradeSheetUi(it) != null"))
        assertTrue(screen.contains("onHeroes = { buildingSheet = null; onOpenHeroes() }"))
        assertTrue(screen.contains("onRearm = { state.selectedBuilding?.let { buildingSheet = null; barSent = BuildingCommandIds.REARM; model.repairTrap(it.id) } }"))
    }

    // WHY: hero recruitment now lives on the tray's HEROES tab; HeroBuildMenu and the legacy dialog must not be the path.
    @Test fun `hero recruitment opens the tray HEROES tab and its PLACE opens the recruitment review`() {
        val screen = source("ui/kingdom/KingdomScreen.kt")
        assertFalse(screen.contains("HeroBuildMenu("))
        assertTrue(screen.contains("val liveTray = if (!editing && local.buildMenu)\n"))
        assertTrue(screen.contains("initialTab = requestedBuildTab.takeUnless { local.heroesOnly } ?: gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveTrayTabs.HEROES,"))
        assertTrue(screen.contains("heroes = heroState, onHeroRefresh = { model.refreshHeroRecruitment() }"))
        assertTrue(screen.contains("onHeroPick = { type -> model.audio?.tap(); model.startPlacement(type) }"))
        assertTrue(screen.contains("onReviewHero = { model.reviewHeroPlacement() }"))
        assertTrue(screen.contains("heroes = heroState)\n"))
        // TRAPS is a tray tab of its own: the Supplies route and the Home request both reach it.
        assertTrue(screen.contains("it == gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveTrayTabs.TRAPS"))
        assertTrue(source("ui/nav/PkwApp.kt").contains("\"BUILDINGS\", \"DEFENCES\", \"TRAPS\" -> suppliesHome(HomeRequest.BuildCategory(id))"))
    }

    // WHY: home-budget.png keeps Home's permanent chrome small: routine lines are toasts, the guide is a kit card, the
    // objective is the transient chip, and the world shows READY bubbles. Old Notice lines would eat the budget again.
    @Test fun `the Home budget draws toasts the guide card the chip and the ready bubbles instead of the old column`() {
        val screen = source("ui/kingdom/KingdomScreen.kt")
        val status = screen.substringAfter("val statusContent: @Composable () -> Unit = {").substringBefore("BoxWithConstraints(")
        assertFalse(status.contains("Notice("))
        assertFalse(status.contains("LinearProgressIndicator("))
        assertTrue(status.contains("InterruptedBanner(")); assertTrue(status.contains("BuilderFinishPending("))
        assertTrue(screen.contains("KingdomStatusToasts(notice, state.home.error, state.home.message, state.updateNotice, timingNotice,"))
        assertEquals("KingdomGuidance is no longer called, only declared", 1, Regex("KingdomGuidance\\(").findAll(screen).count())
        assertTrue(screen.contains("HomeGuideCard(tutorial, state.catalogue, busy, model::tutorialAction, onOpenQuests)"))
        assertTrue(screen.contains("LiveReadyMarkerLayer(liveReadyMarkers(state), mapped, assets, render, baseCamera, hidden = worldMarkersHidden,"))
        val scaffold = source("ui/home/HomeScaffold.kt")
        assertTrue(scaffold.contains("rememberTransientContext(homeContextCandidate(home, objective))"))
        assertTrue(scaffold.contains("homeHudWithContext(homeHudWithBuildNew(ui, buildNewTypes), transientContext)"))
        assertTrue(scaffold.contains("materials = drawerMaterials) else null,"))
        // Every id the chip can carry has its own branch in openHudFeature, so a chip tap is never a dead door.
        for (id in listOf("hud.quests", "hud.dailyCache", "mine.collect", "hud.builders")) assertTrue(id, scaffold.contains("\"$id\" ->"))
        val app = source("ui/nav/PkwApp.kt")
        assertTrue(app.contains("objective = gg.pixelkingdomwars.nativeclient.ui.home.homeGuideObjective(home.tutorial, content.catalogue)"))
        assertTrue(app.contains("drawerMaterials = gg.pixelkingdomwars.nativeclient.ui.hud.drawerMaterialGroups(drawerCrafting, session.session.wallet, account.selectedBaseId)"))
        assertTrue(app.contains("buildNewTypes = homeBuildNewTypes,"))
    }
}
