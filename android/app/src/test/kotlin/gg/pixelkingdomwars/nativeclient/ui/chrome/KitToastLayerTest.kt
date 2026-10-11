package gg.pixelkingdomwars.nativeclient.ui.chrome

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.ToastKind
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** Hub SPEC §3.2: every refusal and notice posted to [Toasts] shows as the designed kit toast. The app-wide layer sits
 * above every screen with no navigation of its own, so it must never draw a GO or a Report it cannot open (it draws one
 * only while the app has bound that door, [ToastDoors]), and it keeps the queue's clock (owner 2026-09-17: no message may
 * be stuck on screen). */
class KitToastLayerTest {
    @Test fun `an error line is the blood error toast and an info line is not`() {
        val queue = ToastQueue()
        val error = queue.post("Wallet didn't answer. Nothing was sent.", error = true, now = 0)
        val info = queue.post("NAME UPDATED", now = 1)
        assertEquals(ToastKind.ERROR, kitToastUi(error).kind); assertEquals(ToastKind.INFO, kitToastUi(info).kind)
        assertEquals("Wallet didn't answer. Nothing was sent.", kitToastUi(error).message)
    }
    // Rewritten 2026-10-06 (hub slice A, toasts.png): this case pinned "no GO and no Report ever" while the layer had
    // nowhere to send them. The app root now binds Report (Feedback, prefilled) and the Home route binds GO, so the rule
    // is: no door while unbound; Report only on an error and only while bound; GO only when the line names a place and
    // only while GO is bound. A drawn door that cannot open is still forbidden, which the unbound half keeps pinning.
    @Test fun `a toast draws a door only while the app has bound one that can open it`() {
        val queue = ToastQueue()
        val error = queue.post("Report failed", error = true, now = 0)
        val info = queue.post("Expedition back at the Lodge", now = 1, go = FeatureId("lodge.underway"))
        val unbound = kitToastUi(error)
        assertNull(unbound.go); assertNull(unbound.goLabel); assertFalse("no Report while nothing can open Feedback", unbound.report)
        assertNull("no GO while nothing can open its place", kitToastUi(info).go); assertNull(kitToastUi(info).goLabel)
        assertTrue("an error offers Report once Feedback is reachable", kitToastUi(error, reportBound = true).report)
        assertFalse("an info line never offers Report", kitToastUi(info, reportBound = true, goBound = true).report)
        val go = kitToastUi(info, goBound = true)
        assertEquals("GO opens the place the line was posted with", FeatureId("lodge.underway"), go.go); assertEquals("GO", go.goLabel)
        val placeless = kitToastUi(error, reportBound = true, goBound = true)
        assertNull("a line without a place draws no GO even while GO is bound", placeless.go); assertNull(placeless.goLabel)
    }
    @Test fun `the layer's doors open the bound door and retire the toast instead of doing nothing`() {
        val layer = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/chrome/KitToastLayer.kt").readText()
        assertTrue("Report goes through the bound door", layer.contains("ToastDoors.report(it.message)"))
        assertTrue("GO goes through the bound door", layer.contains("ToastDoors::go"))
        assertTrue("the layer draws doors from the bound state", layer.contains("kitToastUi(item, reportBound, goBound)"))
        assertFalse("a dead GO is a forbidden door", layer.contains("onGo = {}"))
        assertFalse("a dead Report is a forbidden door", layer.contains("onReport = {}"))
    }
    @Test fun `at most three show and the newest is at the bottom`() {
        val queue = ToastQueue(maxVisible = 5)
        (1..5).forEach { queue.post("T$it", now = it.toLong()) }
        val shown = kitToastLayerItems(queue.items.value).map { kitToastUi(it) }
        assertEquals("the kit budget, oldest dropped, newest last", listOf("T3", "T4", "T5"), shown.map { it.message })
        assertEquals("one identity per queued toast, so a tap retires the right one", 3, shown.map { it.key }.toSet().size)
    }
    @Test fun `the toast keeps the queue's clock`() {
        assertEquals(1_234L, kitToastUi(ToastQueue().post("x", now = 1_234)).postedAtMs)
    }
    @Test fun `the app-wide host in MainActivity is the designed layer`() {
        val main = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/MainActivity.kt").readText()
        assertTrue(main.contains("ui.chrome.KitToastLayer()"))
        assertFalse("the old bar-plate host is retired from the user path", main.contains("ui.chrome.ToastHost()"))
    }
}
