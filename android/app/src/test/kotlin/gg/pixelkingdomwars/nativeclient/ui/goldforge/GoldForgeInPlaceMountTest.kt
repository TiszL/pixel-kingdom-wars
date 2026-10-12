package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.home.HomeNavigationResult
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteIdentity
import gg.pixelkingdomwars.nativeclient.ui.home.HomeSheetRouteHost
import gg.pixelkingdomwars.nativeclient.ui.home.HomeTab
import gg.pixelkingdomwars.nativeclient.ui.home.mountedHomeSheetFrame
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry
import java.io.File
import org.junit.Assert.*
import org.junit.Test

/**
 * The Gold Forge acts in place on Home: SMELT and GEMS run through bindings over the existing view models, and every
 * other forge door lands on a designed sheet. These pins keep the money path on the designed screen (no hop to the old
 * owner screens, which stay reachable only as recovery), keep a Seal from being closed under the player, and keep a
 * routine refresh from blanking what is shown. Payment behaviour itself stays tested at its existing owners.
 */
class GoldForgeInPlaceMountTest {
    private fun source(path: String) = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()
    private val app by lazy { source("ui/nav/PkwApp.kt") }
    private val mount by lazy { source("ui/goldforge/GoldForgeHomeMount.kt") }
    private val identity = HomeRouteIdentity(Any(), "base-1", 3)

    // WHY: a Seal composed inside the sheet would be clipped by it and could close with it; only the Home overlay layer
    // lets the 55 % scrim cover the viewport while the resource stack stays above it.
    @Test fun `both bindings exist only while the forge is the top sheet and their Seals compose after SheetHost`() {
        assertTrue(app.contains("val forgeOpen = stack.top?.destination is Destination.GoldForge"))
        val hooks = app.substringAfter("val forgeOpen = ").substringBefore("DisposableEffect(localRouteHost, identity, tab)")
        assertTrue(hooks.contains("if (!forgeOpen) null else forgeContribution?.let"))
        assertTrue(hooks.contains("rememberGoldForgeSmeltBinding("))
        assertTrue(hooks.contains("if (!forgeOpen || forgeSender == null) null else"))
        assertTrue(hooks.contains("rememberGoldForgeGemsBinding("))
        val overlay = app.substringAfter("overlay = {").substringBefore("eventButton =")
        val host = overlay.indexOf("SheetHost(sheet,")
        assertTrue(host >= 0)
        assertTrue(overlay.indexOf("forgeSmelt?.overlay?.invoke()") > host)
        assertTrue(overlay.indexOf("forgeGems?.overlay?.invoke()") > host)
        assertTrue(overlay.indexOf("GoldForgeStackGain(forgeGems?.gain, 0,") > host)
        assertTrue(app.contains("smeltBinding = forgeSmelt, gemsBinding = forgeGems,"))
    }

    // WHY: closing the sheet or opening another door under a consent Seal or a wallet payment would strand the review.
    @Test fun `an open forge Seal holds the sheet and every other door until it closes`() {
        // Updated 2026-10-11 (owner report, Seeker code 34): bodyReviewBlocked is now built from named terms so a deferred
        // door can log which one held. The pin follows the new shape; the rule is unchanged: the forge Seal is one of the terms.
        val terms = app.substringAfter("val bodyReviewTerms = rememberUpdatedState(").substringBefore("val bodyReviewBlocked")
        assertTrue(terms.contains("\"goldForge.review\" to { goldForgeReviewOpen.value }"))
        assertTrue(app.contains("val bodyReviewBlocked = rememberUpdatedState<() -> Boolean> { bodyReviewTerms.value.any { (_, held) -> held() } }"))
        assertTrue(app.contains("SideEffect { goldForgeReviewOpen.value = forgeSmelt?.reviewOpen == true || forgeGems?.reviewOpen == true }"))
        var sealOpen = true
        val reasons = mutableListOf<String>()
        val opened = mutableListOf<Destination>()
        val lease = Any()
        val host = HomeSheetRouteHost({ identity }, { false }, { reasons += it }, bodyReviewBlocked = { sealOpen })
        host.attach(identity, {}, { false }, owner = lease, openBody = { opened += it }).reportBlocked(false)
        var popped = false
        assertFalse(host.canUseReadControl(lease))
        assertFalse(host.closeOwnedSheet(lease, {}) { popped = true })
        assertFalse(popped)
        assertEquals("Finish the current review before closing this sheet.", reasons.last())
        assertEquals(HomeNavigationResult.DEFERRED, host.navigateResult(Destination.Feedback, HomeTab.KINGDOM))
        assertTrue(opened.isEmpty())
        sealOpen = false
        assertTrue(host.canUseReadControl(lease))
        assertTrue(host.closeOwnedSheet(lease, {}) { popped = true })
        assertTrue(popped)
    }

    // WHY: the designed tabs now perform smelting and buying; a second live path through the old screens would let the
    // player act outside the designed consent. The old routes stay only as recovery when a binding cannot be built.
    @Test fun `the old Smelt and Gems owner screens are reached only as recovery`() {
        val controls = app.substringAfter("onOpenControls = { selected ->").substringBefore("SheetHost(sheet,")
        assertTrue(controls.contains("\"SMELT\" -> handoff { navController.navigate(MiningContributionRoute)"))
        assertTrue(controls.contains("\"GEMS\" -> handoff { navController.navigate(GemsBuyRoute)"))
        val elsewhere = app.replace(controls, "")
        assertFalse(elsewhere.contains("navigate(GemsBuyRoute)"))
        assertTrue(app.contains("onWalletPurchase = { openGoldForgeHome(graph, s, navController, " +
            "gg.pixelkingdomwars.nativeclient.ui.features.FeatureId(\"goldforge.gems\")) }"))
        // The only other door to the old Smelt route is the filed-receipts history, which has no designed face yet.
        val helper = app.substringAfter("private fun openMiningContribution(").substringBefore("@Composable private fun ProfileHubDestination(")
        assertTrue(helper.contains("journal.archives.isNotEmpty() }.getOrDefault(true)"))
        assertTrue(helper.contains("navigate(MiningContributionRoute)"))
        assertTrue(helper.contains("FeatureId(\"goldforge.smelt\")"))
        assertEquals(1, Regex("navigate\\(MiningContributionRoute\\)").findAll(elsewhere).count())
        assertEquals(3, Regex("\\{ openMiningContribution\\(graph, s, navController\\) \\}").findAll(app).count())
        // A tab that acts in place shows no door to its old owner screen.
        assertTrue(mount.contains("sheetUi.selectedTab == GoldForgeTabs.SMELT && smeltBinding != null -> null"))
        assertTrue(mount.contains("sheetUi.selectedTab == GoldForgeTabs.GEMS && gemsBinding != null -> null"))
    }

    // WHY: SPEC Motion "the body never blanks": a refresh that reset the reads flashed CLAIM and LEGACY to unknown.
    @Test fun `a routine refresh keeps what the forge already shows`() {
        val refresh = mount.substringAfter("val refresh: suspend () -> Boolean = refresh@ {").substringBefore("LaunchedEffect(gate, lifecycle)")
        assertFalse(refresh.contains("GoldForgeHomeData("))
        assertTrue(refresh.contains("reads = reads.copy(loading = true, failures = emptyMap())"))
        for (reset in listOf("previewKeep = null", "legacyBalanceRead = null", "legacyWithdrawalsRead = null"))
            assertFalse(reset, refresh.contains(reset))
        // A binding's Seal or payment also holds the read pass, so a refresh never runs under a review.
        assertTrue(refresh.contains("|| bindingReview)"))
        assertTrue(mount.contains("legacyBalanceRead == economy.balances"))
        assertTrue(mount.contains("legacyWithdrawalsRead == economy.withdrawals"))
    }

    // WHY: no claim can be signed from this client yet; the sheet must not build a second claim journal owner.
    @Test fun `the forge still constructs no claim owner and its CLAIM doors explain`() {
        assertFalse(mount.contains("MiningClaimsClient("))
        assertFalse(mount.contains("MiningClaimsRegistration("))
        assertTrue(mount.contains("onGoSeeker = { explanation = gg.pixelkingdomwars.nativeclient.ui.phasee.PHASE_E_NOT_OPEN_LINE }"))
        assertTrue(mount.contains("onDestinationDetails = { onOpenOwner(\"WALLET\") }, onExplainLock = claimExplanation"))
        assertTrue(mount.contains("explanation = claim?.closedReason ?: claim?.lock?.let"))
    }

    // WHY: every forge door must land on a designed sheet (or say why not); a door that does nothing is a defect.
    @Test fun `each forge door opens its designed sheet in place`() {
        val owners = app.substringAfter("onOpenOwner = { owner ->").substringBefore("is Destination.Leagues ->")
        assertTrue(owners.contains("\"HISTORY\" -> openHub(Destination.WalletHistory(home = \"goldforge\"))"))
        assertTrue(owners.contains("\"WALLET\" -> openHub(Destination.Profile(tab = \"WALLET\"))"))
        assertTrue(owners.contains("\"LEGACY\" -> handoff { navController.navigate(GoldForgeLegacyControlsRoute)"))
        assertFalse(owners.contains("GoldForgeControlsRoute)"))
        assertTrue(owners.contains("else -> localRouteHost.locked("))
        val links = app.substringAfter("\"goldforge.gems\" -> ").substringBefore("else -> localRouteHost.locked(")
        assertTrue(links.contains("openHub(Destination.GoldForge(tab = \"GEMS\"))"))
        assertTrue(app.contains("localRouteHost.navigateResult(Destination.Feedback, HomeTab.KINGDOM)"))
        val opened = mutableListOf<Destination>()
        val host = HomeSheetRouteHost({ identity }, { false }, { fail("An admitted forge door was refused: $it") })
        host.attach(identity, {}, { false }, openBody = { opened += it }).reportBlocked(false)
        val doors: List<Destination> = listOf(Destination.WalletHistory(home = "goldforge"), Destination.Profile(tab = "WALLET"),
            Destination.Feedback, Destination.GoldForge(tab = "GEMS"))
        for (door in doors) {
            assertNotNull("$door", mountedHomeSheetFrame(SheetEntry(door)))
            assertEquals("$door", HomeNavigationResult.DISPATCHED, host.navigateResult(door, HomeTab.KINGDOM))
        }
        assertEquals(doors, opened)
    }

    // WHY: error.png keeps the toast until the player closes it, and a later failure must show it again.
    @Test fun `the error toast replaces the notice zone and comes back after a recovered read`() {
        val overlay = app.substringAfter("overlay = {").substringBefore("SheetHost(sheet,")
        val toast = overlay.indexOf("GoldForgeHomeAlert(forgeAlert,")
        assertTrue(toast >= 0)
        assertTrue(toast < overlay.indexOf("else gg.pixelkingdomwars.nativeclient.ui.goldforge.GoldForgeHomeNotice(goldForgeNotice,"))
        assertTrue(app.contains("onAlert = { alert -> if (alert == null) goldForgeAlertClosed = false; goldForgeAlert = alert }"))
        assertTrue(mount.contains("alertReport(goldForgeHomeAlert(data))"))
        assertTrue(mount.contains("onDispose { gate.close(); report(null); notice(null); door(null); alert(null) }"))
    }

    // WHY: a GET GEMS shortfall belongs to the kingdom whose builder asked for it; another kingdom must not inherit it.
    @Test fun `a builder shortfall reaches only the GEMS tab of the same kingdom`() {
        assertTrue(app.contains("shortfall = gemsShortfall.pending?.takeIf { it.identity == identity },"))
        val box = GoldForgeGemsShortfallBox()
        box.offer(GoldForgeGemsShortfall(identity, "40", "Workshop finish", "building-1"))
        assertEquals("40", box.pending?.takeIf { it.identity == identity }?.gems)
        assertNull(box.pending?.takeIf { it.identity == identity.copy(baseSelectionGeneration = 4) })
        box.clear()
        assertNull(box.pending)
    }
}
