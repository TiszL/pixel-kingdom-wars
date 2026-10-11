package gg.pixelkingdomwars.nativeclient.ui.goldforge

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** Source wiring contracts for the complete group; payment behavior remains tested at its existing owners. */
class GoldForgeFullGroupMountTest {
    private fun source(path: String) = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()

    @Test fun `each action door reaches its existing owner screen`() {
        val app = source("ui/nav/PkwApp.kt").replace(Regex("\\s+"), "")
        assertTrue(app.contains("\"SMELT\"->handoff{navController.navigate(MiningContributionRoute)"))
        assertTrue(app.contains("\"GEMS\"->handoff{navController.navigate(GemsBuyRoute)"))
        assertTrue(app.contains("\"CLAIM\"->handoff{navController.navigate(BasesRoute(notice="))
        assertTrue(app.contains("\"LEGACY\"->handoff{navController.navigate(GoldForgeLegacyControlsRoute)"))
    }

    // Rewritten for the in-place GEMS tab: GET GEMS now first hands the GEMS tab the shortfall (so it opens prefilled with
    // what the finish still needs, speedup-short.png) and then queues the same dispatcher door. It still never confirms or
    // resumes the builder: the finish Seal is dismissed before this callback runs.
    @Test fun `builder topup opens Gems without confirming or automatically resuming the builder`() {
        val app = source("ui/nav/PkwApp.kt").replace(Regex("\\s+"), "")
        val topUp = app.substringAfter("onGetGems={short->").substringBefore("onOpenHeroes=")
        val door = "routeDispatcher?.handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId(\"goldforge.gems\"))"
        assertTrue(topUp.contains("gemsShortfall.offer("))
        assertTrue(topUp.contains(door))
        assertTrue(topUp.indexOf("gemsShortfall.offer(") < topUp.indexOf(door))
        assertFalse(topUp.contains("confirmBuilderFinish")); assertFalse(topUp.contains("reviewBuilderFinish"))
        val kingdom = source("ui/kingdom/KingdomScreen.kt").replace(Regex("\\s+"), "")
        assertTrue(kingdom.contains("BuilderFinishCurrencyConfirm(state,busy,model,preparedScene?.scene,onGetGems)"))
    }

    @Test fun `wallet RPC failure does not discard a successful separate legacy balance read`() {
        val mount = source("ui/goldforge/GoldForgeHomeMount.kt")
        val wallet = mount.substringAfter("observe(\"WALLET\")").substringBefore("observe(\"LEGACY\")")
        assertTrue(wallet.indexOf("legacyBalanceRead = state.balances") >= 0)
        assertTrue(wallet.indexOf("legacyBalanceRead = state.balances") < wallet.indexOf("check(state.errors[\"/wallet/balances\"]"))
    }

    @Test fun `legacy proof selection opens existing recovery instead of reopening the same list`() {
        val mount = source("ui/goldforge/GoldForgeHomeMount.kt").replace(Regex("\\s+"), "")
        assertTrue(mount.contains("if(id==null)legacyHistory=trueelseonOpenOwner(\"LEGACY\")"))
        assertTrue(mount.contains("it.id==gg.pixelkingdomwars.nativeclient.ui.hud.HudIds.GEMS"))
    }

    @Test fun `designed owner faces replace the old primary pages while keeping original viewmodels`() {
        assertTrue(source("ui/economy/MiningContributionScreen.kt").contains("GoldForgeSmeltOwner("))
        assertTrue(source("ui/economy/GemsBuyScreen.kt").contains("GemsBody(gems, on)"))
        assertTrue(source("ui/phasee/MiningClaimsScreen.kt").contains("GoldForgeClaimOwner("))
        assertFalse(source("ui/economy/MiningContributionScreen.kt").contains("GamePage(\"KEEP MINING\""))
        assertFalse(source("ui/economy/GemsBuyScreen.kt").contains("GamePageHeader(\"GET GEMS\""))
    }
    @Test fun `HUD fallback retains the exact requested forge feature`() {
        val scaffold = source("ui/home/HomeScaffold.kt").replace(Regex("\\s+"), "")
        assertTrue(scaffold.contains("onForge:(FeatureId)->Unit"))
        assertTrue(scaffold.contains("menuActions.run{onForge(id)}"))
        val app = source("ui/nav/PkwApp.kt").replace(Regex("\\s+"), "")
        assertTrue(app.contains("onForge={id->routeDispatcher?.handleFeatureDoor(id)}"))
    }

    @Test fun `Profile and shortages queue the dispatcher door with the current identity`() {
        val app = source("ui/nav/PkwApp.kt").replace(Regex("\\s+"), "")
        assertFalse(app.contains("navController.navigate(ForgeRoute)"))
        assertTrue(app.contains("\"goldforge.open\"->openGoldForgeHome(graph,s,navController,link.feature)"))
        assertTrue(app.contains("graph.sessionGraph.value!==session||identity==null"))
        assertTrue(app.contains("HomeRequest.Open(id,identity,"))
        assertTrue(app.contains("if(!navController.popBackStack<HomeRoute>(inclusive=false))navController.navigate(HomeRoute)"))
        assertTrue(app.contains("if(price.currency==gg.pixelkingdomwars.nativeclient.ui.model.Currency.GEMS)\"goldforge.gems\"else\"goldforge.open\""))
        assertTrue(app.contains("\"goldforge.open\"->handoff{routeDispatcher?.handleFeatureDoor(link.feature)}"))
    }

    @Test fun `registered claim owner receives navigation without changing registration custody`() {
        val app = source("ui/nav/PkwApp.kt").replace(Regex("\\s+"), "")
        assertTrue(app.contains("LocalGoldForgeClaimNavigationprovides"))
        assertTrue(app.contains("GoldForgeClaimNavigation("))
        assertTrue(app.contains("onGoSmelt={claimNavigation{"))
        assertTrue(app.contains("navController.navigate(GoldForgeWalletControlsRoute)"))
        assertTrue(app.contains("ProfileHubDestination(graph,s,wallet,navController,gg.pixelkingdomwars.nativeclient.ui.profile.ProfileTab.WALLET)"))
    }

}
