package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEActivity
import gg.pixelkingdomwars.nativeclient.ui.phasee.phaseEActivityNamed
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Map group mount (owner 2026-10-06, "every detail of the new interface"): which body opens for each door of the World map
 * and of its Bases activities. The Divine and Seeker share homes now act in place through their existing owners, so the
 * old screens must stay behind History and recovery only; REALM'S CUT keeps its wallet owner; the search drawer shows its
 * own search's state; and no map surface opens a Realm Permit purchase while that work is stopped (A9). The decisions
 * behind each tap are tested where they live (DivineInPlaceTest, IslandRewardsInPlaceTest, WorldSearchRecentTest).
 */
class MapGroupMountTest {
    private fun source(path: String): String {
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path"
        return listOf(File(relative), File("app/$relative")).first { it.isFile }.readText()
    }
    private fun sourceDir(path: String): List<File> {
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path"
        return listOf(File(relative), File("app/$relative")).first { it.isDirectory }.walkTopDown().filter { it.extension == "kt" }.toList()
    }
    private val oldScreens = listOf("DivineTrialScreen(", "DivineFragmentScreen(", "SeekerResourceClaimsScreen(",
        "SeekerShardsClaimsScreen(", "MiningTaxClaimsScreen(")

    // WHY: the World map's Divine doors and Bases › Activities reach these owners through their registrations; a registration
    // that drew an old screen itself would put the player back on the pre-rehaul page for every action.
    @Test fun `each Bases activity of the map group mounts its designed home and no registration draws an old screen`() {
        val homes = listOf("ui/phasee/DivineTrialRegistration.kt" to "DivineTrialsHome(",
            "ui/phasee/DivineFragmentRegistration.kt" to "DivineFragmentsHome(",
            "ui/phasee/SeekerResourceClaimsRegistration.kt" to "SeekerResourceRewardsHome(",
            "ui/phasee/SeekerShardsClaimsRegistration.kt" to "SeekerShardsRewardsHome(",
            "ui/phasee/MiningTaxClaimsRegistration.kt" to "MiningTaxRewardsHome(")
        for ((file, home) in homes) {
            val text = source(file)
            assertTrue("$file mounts $home", text.contains(home))
            oldScreens.forEach { assertFalse("$file never draws $it itself", text.contains(it)) }
        }
        // Each old screen is drawn from exactly one place: its designed home, behind that home's own switch.
        val bodies = source("ui/phasee/DivineDesignedBodies.kt") + source("ui/phasee/IslandRewardsHome.kt")
        oldScreens.forEach { assertEquals(it, 1, bodies.split(it).size - 1) }
    }

    // WHY: the World tab never opens a second Divine owner (it would race the registration's lifetime fence); it hands the
    // activity's name to Bases, which launches the registration that draws the designed home.
    @Test fun `the Divine panel doors open the designed Trials and Fragments homes through the Bases launch`() {
        val opened = mutableListOf<PhaseEActivity>()
        val on = divinePanelActions({ opened += it }, {}, {}, {})
        on.onSolo(); on.onFragments()
        assertEquals(listOf(PhaseEActivity.DIVINE_TRIALS, PhaseEActivity.FRAGMENTS), opened)
        opened.forEach { assertEquals("BasesRoute(launch) resolves back to $it", it, phaseEActivityNamed(it.name)) }
    }

    // WHY: PLAN & FIGHT, BEST and DELIVER are the frames' main actions; each must run on the designed home through the
    // existing owner (no hop to the old page), and an open delivery review must be confirmed on the Seal, not force the old
    // dialog. History, RETRY and recovery rows still open the original screen, which keeps those jobs.
    @Test fun `PLAN and FIGHT, BEST and DELIVER act on the designed homes while History and recovery keep the originals`() {
        val bodies = source("ui/phasee/DivineDesignedBodies.kt")
        listOf("onPlan = plan", "onWatchBest = watchBest", "onDeliver = deliver",
            "is FragmentDeliverStep.Deliver -> model.delivery(step.eventId)", "is FragmentDeliverStep.Claim -> model.claim(step.row)",
            "FinePrintSeal(seal, onConfirm = { model.state.value.review?.let { model.confirm(it) } }, onBack = sealBack)",
            "DivineTrialBattle(attempt").forEach { assertTrue(it, bodies.contains(it)) }
        assertTrue("an open review no longer forces the old dialog", bodies.contains("divineFragmentsOriginalRequired(display, original)"))
        listOf("onHistory = open", "onRecover = { open() }").forEach { assertEquals(it, 2, bodies.split(it).size - 1) }
    }

    // WHY: the frame names the destination kingdom; a name from another kingdom's snapshot (or on a review saved for another
    // kingdom) would tell the player the fragments go somewhere they do not.
    @Test fun `CRYSTAL FRAGMENTS names only the selected kingdom from that kingdom's own snapshot`() {
        val registration = source("ui/phasee/DivineFragmentRegistration.kt")
        assertTrue(registration.contains("it.baseId==account.selectedBaseId"))
        assertTrue(registration.contains("close,kingdomName)"))
        assertTrue(source("ui/phasee/DivineDesignedBodies.kt").contains("kingdomName.takeIf { c.base == selectedBase }"))
    }

    // WHY: MATERIALS and SHARDS are server orders with no wallet, so they claim on the designed sheet; REALMS CUT moves KEEP to
    // the wallet (prepare, sign, submit, MFA, recovery), which only MiningTaxClaimsScreen performs, so it must not gain an
    // in-place claim. History's BACK returns to the designed sheet instead of leaving the activity.
    @Test fun `MATERIALS and SHARDS claim on the designed sheet while REALMS CUT keeps its wallet owner`() {
        val home = source("ui/phasee/IslandRewardsHome.kt")
        val resource = home.substringAfter("internal fun SeekerResourceRewardsHome(").substringBefore("internal fun SeekerShardsRewardsHome(")
        val shards = home.substringAfter("internal fun SeekerShardsRewardsHome(").substringBefore("internal fun MiningTaxRewardsHome(")
        // MiningTaxRewardsHome alone (it ends where the shared body's KDoc starts)
        val tax = home.substringAfter("internal fun MiningTaxRewardsHome(").substringBefore("\n/**")
        for ((tab, body) in listOf("MATERIALS" to resource, "SHARDS" to shards)) {
            listOf("onClaim = {", "model.review(row)", "seal = review?.let", "onSealConfirm = { state.review?.let { model.confirm(it) } }",
                "ClaimsScreen(model, selectedBase, allowed) { original = false }").forEach { assertTrue("$tab: $it", body.contains(it)) }
        }
        assertTrue(tax.contains("MiningTaxClaimsScreen(model, allowed, policy)"))
        assertFalse("REALMS CUT has no in-place claim", tax.contains("onClaim ="))
        assertTrue(tax.contains("IslandRewardsHomeBody(fresh, busy, onSibling, onBack, onRetry = { model.refresh() }) { original = true }"))
        assertTrue("without an in-place claim the primary opens the original owner", home.contains("onClaim = onClaim ?: onOriginal"))
    }

    // WHY: SPEC §2.4 draws dots while a search runs, a failure line with RETRY, and RECENT for an empty query; a failed search
    // must never become the map's error (which blanks the map), and the globe and realm map share one RECENT list.
    @Test fun `the World search drawer shows its own search state with RETRY and one RECENT list for both maps`() {
        val screen = source("ui/world/WorldHudScreen.kt")
        assertEquals(1, screen.split("remember { WorldSearchRecent() }").size - 1)
        assertEquals("GlobeLayer and RealmLayer get the same list", 2, screen.split("searchRecent) { ui = it }").size - 1)
        listOf("MapSearchUi(query, busy, sections, error = error)", "onRetry = onRetry", "{ model.search(query) }",
            "SearchSectionUi(\"RECENT\", it)").forEach { assertTrue(it, screen.contains(it)) }
        val search = source("ui/world/WorldViewModel.kt").substringAfter("fun search(term: String)").substringBefore("suspend fun deedPreview(")
        assertTrue(search.contains("searchError="))
        assertFalse("a failed search never sets the map's error", search.contains("copy(error=") || search.contains("read(base)"))
    }

    // WHY: archipelago-panel #89 draws the island's real route card; the World tab reuses Home's route-art source rather than
    // a second decoder.
    @Test fun `the archipelago sheet provides the route art from Home's source`() {
        assertTrue(source("ui/world/WorldArchipelagoSheet.kt")
            .contains("CompositionLocalProvider(LocalVoyageArt provides rememberHomeVoyageArt(model.appGraph, model.sessionGraph)"))
    }

    // WHY: the permit sheet needs a spot, seller and quota the client cannot read, and every new purchase is paused on this
    // build; a door to it from the map would open a purchase the player cannot complete. The old Bases screen stays the path.
    @Test fun `no World or map surface opens a Realm Permit purchase while A9 is stopped`() {
        val files = sourceDir("ui/world") + sourceDir("ui/sheets/map")
        assertTrue(files.isNotEmpty())
        files.forEach { file ->
            val text = file.readText()
            assertFalse(file.name, text.contains("PhaseEActivity.REALM_PERMITS") || text.contains("RealmSalesScreen("))
        }
    }
}
