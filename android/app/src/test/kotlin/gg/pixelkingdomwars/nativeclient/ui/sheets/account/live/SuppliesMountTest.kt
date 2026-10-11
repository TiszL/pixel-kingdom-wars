package gg.pixelkingdomwars.nativeclient.ui.sheets.account.live

import java.io.File
import org.junit.Assert.*
import org.junit.Test

class SuppliesMountTest {
    private fun source(path: String): String {
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path"
        return listOf(File(relative), File("app/$relative")).first { it.isFile }.readText()
    }
    @Test fun `BUILD supplies uses the whole sheet slot while other tabs retain their handlers`() {
        val host = source("ui/sheets/buildings/live/LiveSheetHosts.kt")
        assertTrue(host.contains("tab == LiveTrayTabs.SUPPLIES && supplies != null"))
        assertTrue(host.contains("supplies(ui.tabs, changeTab"))
        assertTrue(host.contains("LiveTrayTabs.HEROES -> routes.onHeroes()"))
        assertTrue(host.contains("LiveTrayTabs.LAYOUTS -> routes.onLayouts()"))
    }
    @Test fun `Shop and Home mount the same supplies body and the old shop body is retired`() {
        val app = source("ui/nav/PkwApp.kt")
        assertEquals(2, Regex("SuppliesHomeBody\\(").findAll(app).count())
        assertFalse(source("ui/roster/RosterScreens.kt").contains("fun ShopScreen("))
        assertTrue(app.contains("onPurchase = { kind, baseId -> navController.navigate(BasePurchaseRoute(kind, baseId))"))
        assertTrue(app.contains("graph.account.state.value.selectedBaseId == suppliesBase"))
        assertTrue(app.contains("graph.account.state.value.baseSelectionGeneration == suppliesGeneration"))
    }
    @Test fun `KEEP buys reach the item owner only through the kit Seal and the shop draws no system dialog`() {
        val body = source("ui/sheets/account/live/SuppliesHomeBody.kt")
        // The host may pass the player's preference; without one the body must still ask (fail safe).
        assertTrue(body.contains("keepConfirm: KeepConfirmPreference? = null"))
        assertTrue(body.contains("rememberKeepSpendConfirm(suppliesKeepPreference(keepConfirm))"))
        // Tap raises the consent; CONFIRM re-checks the offer before the unchanged owner spends.
        assertTrue(body.contains("keepSpend.confirm(suppliesKeepIntent(buy)"))
        assertTrue(body.contains("val target = suppliesKeepConfirmed(buy, latest())"))
        assertTrue(body.contains("Seal(pending?.let { suppliesKeepConsentUi(it, armedAt) }"))
        assertEquals("The item owner is called from the confirmed path only", 1, Regex("model\\.buy\\(").findAll(body).count())
        // shop.png has no WALLET or CODEX door and no system dialog: REFRESH is a kit button, INFO a card in the sheet.
        assertTrue(body.contains("SecondaryButton(\"REFRESH\""))
        for (gone in listOf("AlertDialog", "TextButton", "\"WALLET\"", "\"CODEX\"", "material3")) assertFalse(gone, body.contains(gone))
        val sheet = source("ui/sheets/account/SuppliesSheet.kt")
        assertTrue(sheet.contains("ui.info?.let { SuppliesInfoCard(it, on.onCloseInfo) }"))
        assertFalse(sheet.contains("AlertDialog"))
    }
    @Test fun `returning from Supplies can restore DEFENCES rather than silently choosing buildings`() {
        assertTrue(source("ui/home/HomeRequests.kt").contains("data class BuildCategory(val tab: String)"))
        val kingdom = source("ui/kingdom/KingdomScreen.kt")
        assertTrue(kingdom.contains("is HomeRequest.BuildCategory"))
        assertTrue(kingdom.contains("initialTab = requestedBuildTab"))
    }
}
