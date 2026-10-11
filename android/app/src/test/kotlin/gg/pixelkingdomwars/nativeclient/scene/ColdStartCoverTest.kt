package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.diagnostics.FRAME_WINDOW_MS
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Field measurement 2026-10-06 (Seeker, candidate 05a72df2, cold start, phone left in landscape):
 *   FRAME_CAPTURE disk restored ms=28 → VEIL_SHOWN kind=veil … SUMMARY first_pixels=veil snapshot=miss … FRAMES window=home-swap
 *   n=6 p50=29.1 p95=47.7 gt16=6.
 * The restored postcard was refused without a reason (it was portrait; the phone landscape), a cover could choose before a
 * restore landed, and every frame after the swap missed 16 ms. These pin: the refusal says why; a restore in flight is
 * awaited briefly; and the swap frames carry no first composition, no full-size postcard work and no copy.
 */
class ColdStartCoverTest {
    private val now = 3_000_000_000L
    private val key = PostcardKey("acct-a", "native-kingdom-bundled-abc", "base-1", 1200, 2670)
    private fun miss(account: String? = "acct-a", tag: String? = "native-kingdom-bundled-abc", base: String? = "base-1",
        w: Int = 1200, h: Int = 2670, savedAt: Long = now - 1) = postcardMiss(key, savedAt, account, tag, base, w, h, now)

    @Test fun `a refused postcard says why in fixed words`() {
        assertNull(miss())
        assertEquals("the field case: taken in portrait, shown in landscape", "size", miss(w = 2670, h = 1200))
        assertEquals("account", miss(account = "acct-b"))
        assertEquals("content", miss(tag = "native-kingdom-bundled-def"))
        assertEquals("base", miss(base = "base-2"))
        assertEquals("age", miss(savedAt = now - POSTCARD_MAX_AGE_MS - 1))
        assertEquals("none", postcardMiss(null, now, "acct-a", "t", "b", 1, 1, now))
        assertEquals("admission is exactly 'no miss'", miss() == null, postcardAdmitted(key, now - 1, "acct-a", "native-kingdom-bundled-abc", "base-1", 1200, 2670, now))
        val kingdom = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/kingdom/KingdomScreen.kt").readText()
        assertTrue("the reason reaches PKWLoad once per postcard and reason", kingdom.contains("\"miss reason=\$it\""))
    }

    @Test fun `a cover waits briefly for a disk restore still in flight, then settles`() {
        assertEquals(50L, RESTORE_WAIT_MS)
        val postcards = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/ScenePostcards.kt").readText()
        val prewarm = postcards.substring(postcards.indexOf("fun prewarm() {"), postcards.indexOf("fun capture("))
        assertTrue("the restore announces itself first", prewarm.indexOf("restoring = true") in 0 until prewarm.indexOf("readText()"))
        assertTrue("and clears when its postcard is in the slot", prewarm.contains("val kept = slot.restore(postcard)\n                restoring = false"))
        assertTrue("or when there is nothing to restore", prewarm.contains("finally { if (!posted) restoring = false }"))
        val layer = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/kingdom/ScenePresentation.kt").readText()
        assertTrue(layer.contains("var holding by remember { mutableStateOf(postcard == null && gg.pixelkingdomwars.nativeclient.scene.ScenePostcards.restoring) }"))
        assertTrue("bounded", layer.contains("kotlinx.coroutines.withTimeoutOrNull(gg.pixelkingdomwars.nativeclient.scene.RESTORE_WAIT_MS)"))
        assertTrue("the hold is the plain wallpaper boot just drew (no strip, no indicator)",
            layer.contains("if (postcard == null && holding) BoxWithConstraints("))
    }

    @Test fun `the swap frames carry no first composition, no full-size postcard and no copy`() {
        assertEquals("half the surface per side: a quarter of the pixels to allocate, upload and draw", 600, postcardWidth(1200))
        assertEquals(1335, postcardWidth(2670))
        assertTrue("the first settled copy lands after the swap and its frame window",
            POSTCARD_FIRST_SETTLE_MS >= FRAME_WINDOW_MS + 300)
        val postcards = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/ScenePostcards.kt").readText()
        assertTrue("settled copies allocate and copy on the postcard thread", postcards.contains("if (proactive) background.post(copy) else copy()"))
        assertTrue(postcards.contains("Bitmap.createBitmap(postcardWidth(key.width), postcardWidth(key.height), Bitmap.Config.ARGB_8888)"))
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/SceneHost.kt").readText()
        assertTrue(host.indexOf("kotlinx.coroutines.delay(POSTCARD_FIRST_SETTLE_MS)") in 0 until host.indexOf("kotlinx.coroutines.delay(POSTCARD_SETTLE_MS)"))
        val scaffold = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeScaffold.kt").readText()
        assertTrue("the hidden HUD is measured but not placed", scaffold.contains("layout(placeable.width, placeable.height) { if (placed) placeable.place(0, 0) }"))
    }
}
