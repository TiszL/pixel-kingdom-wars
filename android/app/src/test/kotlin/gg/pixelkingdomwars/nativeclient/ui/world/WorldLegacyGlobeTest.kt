package gg.pixelkingdomwars.nativeclient.ui.world

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Every build type carries the world bundle since N5, and the World tab still falls back to the legacy globe whenever
 * the GL30 engine is refused (no GLES 3.0, the server's `worldV2` switch off, a crash record) or fails. The
 * GL30 HUD drops the globe's keep markers (D-164.1, plan §3.6), but the legacy path must stay the N0 globe: without its
 * markers and the Nearby keeps list, a release player would lose the only on-globe way to see and open other keeps.
 */
class WorldLegacyGlobeTest {
    private val screen = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldScreen.kt").readText()
    private val hud = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()

    /** Everything WorldScreen renders after the GL30 branch has returned: the legacy globe. */
    private val legacy: String get() {
        val branch = screen.indexOf("if (worldEngine != null && !engineUnavailable) {")
        assertTrue("WorldScreen chooses the GL30 HUD only for an admitted engine", branch >= 0)
        val end = screen.indexOf("        return\n    }", branch)
        assertTrue("the GL30 branch returns before the legacy globe", end > branch)
        return screen.substring(end)
    }

    @Test fun `the legacy globe keeps its keep markers and their Nearby keeps list`() {
        val body = legacy
        assertTrue("markers are planned from the globe state", "worldMarkers(current, model, density)" in body)
        assertTrue("each marker group is a tappable keep button", "markers.forEach { group ->" in body && "WorldButton(onClick = {" in body)
        assertTrue("a group of several keeps opens the list", "cluster = group.members" in body)
        assertTrue("the list is the N0 dialog", "AlertDialog(onDismissRequest = { cluster = emptyList() }, title = { Text(\"NEARBY KEEPS\") }" in body)
        assertTrue("Back closes the list before the globe layers", "BackHandlerAt(BackPriority.GLOBE_LIST, cluster.isNotEmpty()) { cluster = emptyList() }" in body)
    }

    @Test fun `the markers still group by projected distance and skip the far side`() {
        val planner = screen.substring(screen.indexOf("internal fun worldMarkers("))
        val fn = planner.substring(0, planner.indexOf("\n}\n") + 2)
        assertTrue("projected with the legacy globe camera", "GlobeGeometry.project(marker.lon,marker.lat,state.view,state.viewport)" in fn)
        assertTrue("behind the limb or off the edge is not drawn", "if(p.z<=.15 ||" in fn)
        assertEquals("one grouping pass over the projected markers", 1, Regex("""groups\.firstOrNull\{""").findAll(fn).count())
    }

    @Test fun `only the GL30 HUD drops the markers`() {
        assertFalse("the GL30 globe shows no bases (plan §3.6)", "worldMarkers(" in hud)
        assertFalse("no Nearby keeps list on the GL30 globe", "NEARBY KEEPS" in hud)
    }
}
