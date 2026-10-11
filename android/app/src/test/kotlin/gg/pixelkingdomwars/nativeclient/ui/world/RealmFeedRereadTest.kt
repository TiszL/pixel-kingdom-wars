package gg.pixelkingdomwars.nativeclient.ui.world

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * SHARDKEEP K-211, found by the web lane's D-191 review: the web realm map built its kingdoms from the viewport query's
 * data, which is empty while a re-read (a pan, a re-poll) is in flight, so for that interval the list was your own tiles
 * alone. Under D-191 that is visible: every rival blinks out, the Unshielded chip goes (no read carries the bit), and
 * under Unshielded your own kingdom hides too. The native feed never had it: a re-read replaces the list only once the
 * whole new read has landed, and a failed read leaves the last good list (and its shield bits) in place. This keeps it so.
 */
class RealmFeedRereadTest {
    private val model = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldViewModel.kt").readText()
    private val realmWindow = model.substring(model.indexOf("fun realmWindow("), model.indexOf("fun focus("))

    @Test fun `D-191 - a realm re-read keeps the last settled kingdoms until the new read lands, a failed one keeps them`() {
        val split = realmWindow.indexOf("realmRead=worldScope?.launch")
        val start = realmWindow.substring(0, split); val read = realmWindow.substring(split)
        // only a closed map empties the list; a new window cancels the old read and leaves the list as it was
        assertTrue("if (window == null) { realmRead?.cancel();realmWindowKey=null;_state.update { it.copy(realmMarkers=emptyList()," in start)
        assertEquals("the list is emptied in one place only: the map closing", 1, Regex("realmMarkers=").findAll(start).count())
        // the read merges every rectangle first and publishes once, whole; the shield capability never goes back to false
        assertTrue("val merged=linkedMapOf<Int,FantasyMarker>()" in read)
        assertEquals("one publish per completed read", 1, Regex("realmMarkers=").findAll(read).count())
        assertTrue("publish(base){it.copy(realmMarkers=merged.values.toList(),realmMatched=matched,realmTruncated=truncated,shieldFed=it.shieldFed||fed)}" in read)
        assertTrue("the read runs inside the guard", "read(base) {" in read)
        // a failed read (the guard) publishes its error and nothing else: the last good kingdoms stay
        val guard = model.substring(model.indexOf("private suspend fun read("), model.indexOf("/** Called within repeatOnLifecycle"))
        assertTrue("catch (error: Exception) { publish(base) { it.copy(error=error.message ?: \"World read interrupted. Please retry.\",loading=false) } }" in guard)
        // the realm HUD's kingdoms come from that list alone (an error hides nothing)
        val hud = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()
        assertTrue("realmHudBases(ui.realmId, current?.realmMarkers.orEmpty(), owned, { model.tile(it)?.realmId }, columns, ownShield, shieldNow)" in hud)
    }
}
