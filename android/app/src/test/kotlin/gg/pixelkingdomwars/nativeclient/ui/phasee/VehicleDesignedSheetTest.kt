package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/**
 * Owner 2026-10-06, screenshot 1: the old dark "VEHICLES & EXPEDITIONS" page and the old "Interrupted request" bar opened
 * over Home. These pin WHY they were replaced and what must not change while they look designed: the player path draws
 * only the kit sheet and herald, every money step is still the existing owner's call under the same gates, and the parsing
 * that feeds the sheet never throws into composition or shows another kingdom's fleet.
 */
class VehicleDesignedSheetTest {
    private fun source(path: String) = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject

    @Test fun `the vehicle owner mounts the designed sheet and never the old dark page`() {
        val registration = source("ui/phasee/VehicleRegistration.kt")
        assertTrue(registration.contains("VehicleDesignedSheet(model, allowed, configured, account.selectedBaseId, berths, close, policy, initialPage = presentation.initialPage)"))
        assertFalse(Regex("\\bVehicleScreen\\(").containsMatchIn(registration))
        assertFalse(registration.contains("GamePage(\"VEHICLES & EXPEDITIONS\""))
    }

    @Test fun `every money step on the designed sheet is the existing model call under the same gates`() {
        val sheet = source("ui/phasee/VehicleDesignedSheet.kt")
        for (call in listOf("model.reserve(base, dock, pick.id)", "model.service(base, target.id, pick.id, serviceOp)", "model.command(\"prepare\")",
            "model.review()", "model.approve()", "model.upload()", "model.deliver()", "model.command(\"recover\")", "model.archive()", "model.retry(r.id)"))
            assertTrue(call, sheet.contains(call))
        assertTrue(sheet.contains("val controls = vehicleControls(state, allowed, configured, running)"))
        // No new signing or submission owner is built here; the wallet only answers its own MFA dialog.
        for (forbidden in listOf("VehicleRepository(", "VehicleWallet(", "signTransaction", "sendTransaction", "GamePage("))
            assertFalse(forbidden, sheet.contains(forbidden))
    }

    @Test fun `the Berth opens on its three tabs and the Public Workshop entry has none`() {
        assertEquals(listOf("fleet", "install", "service"), vehicleSheetTabs(craftEntry = false).map { it.id })
        assertTrue(vehicleSheetTabs(craftEntry = true).isEmpty())
        assertEquals("craft", vehicleSheetStartPage("craft"))
        assertEquals("fleet", vehicleSheetStartPage("anything else"))
    }

    @Test fun `fleet rows are read only for the selected kingdom and a malformed read is never drawn as an empty fleet`() {
        val fleet = json("""{"baseId":"b1","acceptingNewActions":true,"vehicles":[{"installationId":"i1","family":"cargo_cutter","tier":2,"remainingUses":3,"berthId":"x1","away":false,"pendingService":false}]}""")
        val rows = requireNotNull(vehicleInstalledRows(fleet, "b1"))
        assertEquals(listOf("i1"), rows.map { it.id })
        assertTrue(rows.single().available)
        assertNull("another kingdom's fleet is never shown as this one", vehicleInstalledRows(fleet, "b2"))
        assertNull(vehicleInstalledRows(json("""{"baseId":"b1","acceptingNewActions":"yes","vehicles":[]}"""), "b1"))
        assertNull(vehicleInstalledRows(null, "b1"))
    }

    @Test fun `owned wallet assets keep their identity and an unreadable page reads as unknown`() {
        val page = json("""{"items":[{"identity":{"assetId":"a1","family":"survey_balloon","tier":2,"collection":"c1"},"provenance":{"kind":"finalized_issuance"}}],"nextCursor":null}""")
        val owned = requireNotNull(vehicleOwnedAssets(page))
        assertEquals("a1", owned.single().id)
        assertEquals(2L, owned.single().tier)
        assertEquals("Survey Balloon", vehicleFamilyLabel(owned.single().family))
        assertNull(vehicleOwnedAssets(json("""{"items":[{"identity":{"assetId":"a1"}}]}""")))
        assertNull(vehicleOwnedAssets(null))
    }

    @Test fun `a held original says so first and a missing response invents no facts`() {
        val held = VehicleRecord(id = "r1", kind = "installation", key = "k1", request = json("{}"), policy = json("{}"), held = true)
        val lines = vehicleOriginalLines(held, "b1", null)
        assertEquals(listOf("An original response needs verification. Keep this request and check its outcome."), lines.map { it.text })
    }

    @Test fun `the interrupted request is the designed herald with retry and dismiss over the same owner callbacks`() {
        val banner = source("ui/Theme.kt").substringAfter("@Composable fun InterruptedBanner(").substringBefore("/** A once-per-second wall clock")
        assertTrue(banner.contains("HeraldPlate("))
        assertFalse(banner.contains("PixelPlate("))
        for (callback in listOf("{ onCheck(item.kind) }", "{ onRetry(item.kind) }", "{ onClose(item.kind) }")) assertTrue(callback, banner.contains(callback))
        // DISMISS only folds the line; the saved request stays with its owner and one tap shows its actions again.
        assertTrue(banner.contains("IconSquare(\"shape:close\", Verb.STONE, { folded = true }, \"Dismiss\")"))
        assertTrue(banner.contains("{ folded = false }"))
    }

    @Test fun `an open fleet form hides the Home dock and land ticker instead of drawing over its controls`() {
        assertTrue(source("ui/nav/PkwApp.kt").contains("hideHudChrome = goldForgeRows != null || fleet?.destination() != null,"))
        // Merged with night/fix-oldscreens-land-notices: the old NO LAND plate (the land ticker this guard hid) is gone from
        // Home entirely, so it can never draw over a fleet form; the land door is the HUD herald, and the HUD and header
        // still take the same hide flag.
        val scaffold = source("ui/home/HomeScaffold.kt")
        assertFalse(scaffold.contains("Copy.NO_LAND_PROMPT"))
        assertTrue(scaffold.contains("hooks.authoritativeResources, hooks.hideHudChrome)"))
        // The sheet-layout merge added the full-screen-sheet guard to the same condition (2026-10-06).
        assertTrue(scaffold.contains("!hooks.hideHudChrome && !armySheetOpen && !fullScreenSheets.active)"))
    }

    @Test fun `receipt history and storage fallbacks draw the designed sheet`() {
        assertTrue(source("ui/phasee/PhaseEReceiptHistoryScreen.kt").contains("PhaseEReceiptHistoryBody(title, rows, busy, error, onRefresh, onCheck, onBack)"))
        assertFalse(source("ui/phasee/PhaseEReceiptHistoryScreen.kt").contains("GamePage("))
        for (name in listOf("EquipmentRegistration", "KeepEquipmentMarketRegistration", "PaidStarterExpeditionRegistration", "VehicleRegistration"))
            assertTrue(name, source("ui/phasee/$name.kt").contains("PhaseEDesignedNotice("))
    }
}
