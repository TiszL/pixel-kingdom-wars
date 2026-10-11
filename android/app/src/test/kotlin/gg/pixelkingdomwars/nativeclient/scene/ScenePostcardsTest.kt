package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.ui.kingdom.ScenePicture
import gg.pixelkingdomwars.nativeclient.ui.kingdom.homeHudShown
import gg.pixelkingdomwars.nativeclient.ui.kingdom.scenePicture
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Scene-transitions spec §4 step 5 (owner 2026-10-06: the kingdom on screen at once, "professional"): a postcard is the
 * last frame of a clean Home, kept in memory (one) and on disk (half-size WebP + header) so even a COLD start opens on the
 * player's own base. These pin what it may show, what it must keep (the camera, for a swap without a jump), when it is
 * taken (settled, and as the surface leaves — Android 14+ PixelCopy may not finish in time on the second alone) and that
 * signing out removes it.
 */
class ScenePostcardsTest {
    private val now = 2_000_000_000L
    private val key = PostcardKey("acct-a", "native-kingdom-bundled-abc", "base-1", 1200, 2670)

    @Test fun `cold start with a stored postcard shows it before any scene`() {
        // Startup decoded the stored postcard off Main; Home has no base payload yet, only the account's selected base.
        val slot = PostcardSlot<String>()
        assertTrue(slot.restore(Postcard(key, "from-disk", PostcardCamera(10f, 20f, 1.25f, true), now - 60_000)))
        val stored = slot.shown!!
        val payloadBase: String? = null // no /base answer yet
        val coverBase = payloadBase ?: "base-1" // KingdomScreen: base?.baseId ?: state.selectedBaseId
        assertTrue(postcardAdmitted(stored.key, stored.savedAtMs, "acct-a", "native-kingdom-bundled-abc", coverBase, 1200, 2670, now))
        val picture = scenePicture(live = false, postcard = true)
        assertEquals("the player's own base, not the wallpaper", ScenePicture.POSTCARD, picture)
        assertTrue("and the HUD stands over it", homeHudShown(picture))
        val kingdom = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/kingdom/KingdomScreen.kt").readText()
        assertTrue("before /base answers, the selected base decides", kingdom.contains("base?.baseId ?: state.selectedBaseId, constraints.maxWidth, constraints.maxHeight"))
    }

    @Test fun `a disk postcard never replaces one this process copied`() {
        val slot = PostcardSlot<String>()
        assertTrue(slot.complete(slot.begin(), Postcard(key, "copied", null, now)))
        assertFalse(slot.restore(Postcard(key, "from-disk", null, now - 1)))
        assertEquals("copied", slot.shown!!.image)
        val pending = PostcardSlot<String>(); pending.begin()
        assertFalse("nor races a copy already requested", pending.restore(Postcard(key, "from-disk", null, now)))
    }

    @Test fun `sign-out clears that account's postcard and a late copy cannot bring it back`() {
        val slot = PostcardSlot<String>()
        val inFlight = slot.begin()
        assertTrue(slot.complete(slot.begin(), Postcard(key, "a", null, now)))
        slot.forget("acct-b")
        assertEquals("another account's sign-out leaves it", "a", slot.shown!!.image)
        slot.forget("acct-a")
        assertNull(slot.shown)
        assertFalse("a copy requested before the sign-out is dropped", slot.complete(inFlight, Postcard(key, "late", null, now)))
        assertNull(slot.shown)
        val all = PostcardSlot<String>(); all.complete(all.begin(), Postcard(key, "x", null, now)); all.forget(null)
        assertNull(all.shown)
        val app = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
        assertTrue(app.contains("postcardWallet?.let(gg.pixelkingdomwars.nativeclient.scene.ScenePostcards::forget)"))
    }

    @Test fun `the stored header keeps key, camera and time, and anything else is refused`() {
        val camera = PostcardCamera(1234.5f, 987.25f, 0.75f, true)
        val header = decodePostcardHeader(encodePostcardHeader(key, camera, now))!!
        assertEquals(key, header.key); assertEquals(camera, header.camera); assertEquals(now, header.savedAtMs)
        val fit = decodePostcardHeader(encodePostcardHeader(key, null, now))!!
        assertNull("a postcard without a drawn camera hands nothing over", fit.camera)
        assertNull(decodePostcardHeader("not json"))
        assertNull("an unknown version is ignored", decodePostcardHeader(encodePostcardHeader(key, null, now).replace("\"v\":1", "\"v\":2")))
        assertNull(decodePostcardHeader(encodePostcardHeader(key.copy(width = 0), null, now)))
    }

    @Test fun `only a clean Home is a postcard`() {
        assertTrue(postcardClean(editing = false, placing = false, selected = false, carrying = false, buildMenu = false))
        assertFalse("layout editor", postcardClean(true, false, false, false, false))
        assertFalse("placement ghost", postcardClean(false, true, false, false, false))
        assertFalse("selection outline", postcardClean(false, false, true, false, false))
        assertFalse("carried building", postcardClean(false, false, false, true, false))
        assertFalse("BUILD tray", postcardClean(false, false, false, false, true))
    }

    @Test fun `copies are taken after the camera settles and as the surface leaves, never on Main's or GL's critical path`() {
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/SceneHost.kt").readText()
        assertTrue("settled: 1.5 s after the last camera change, on a clean resumed Home",
            host.contains("kotlinx.coroutines.delay(POSTCARD_SETTLE_MS)") &&
                host.contains("if (latestClean && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) ScenePostcards.capture(fragment, fragmentTag, proactive = true)"))
        assertEquals(1_500L, POSTCARD_SETTLE_MS)
        assertEquals("at most once per 10 s", 10_000L, POSTCARD_PROACTIVE_EVERY_MS)
        val postcards = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/ScenePostcards.kt").readText()
        assertTrue("the copy lands on the postcard thread", postcards.contains("}, background)"))
        assertTrue("a dirty Home is never copied", postcards.contains("!fragment.postcardClean"))
        assertTrue("disk: half size", postcards.contains("Bitmap.createScaledBitmap(bitmap, maxOf(1, key.width / 2), maxOf(1, key.height / 2), false)"))
        assertTrue("disk: WebP", postcards.contains("Bitmap.CompressFormat.WEBP_LOSSY"))
        assertTrue("a wallet never names a folder", postcards.contains("MessageDigest.getInstance(\"SHA-256\")"))
    }

    @Test fun `memory pressure drops the in-memory postcard and only the half-size disk copy may come back`() {
        // ~13 MB full-size bitmap: in the background the app should not hold it (spec §4 step 5 "trimmed on onTrimMemory").
        assertEquals(PostcardTrim.KEEP, postcardTrim(android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE))
        assertEquals(PostcardTrim.HALF, postcardTrim(android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW))
        assertEquals(PostcardTrim.HALF, postcardTrim(android.content.ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN))
        assertEquals(PostcardTrim.DROP, postcardTrim(android.content.ComponentCallbacks2.TRIM_MEMORY_BACKGROUND))
        assertEquals(PostcardTrim.DROP, postcardTrim(android.content.ComponentCallbacks2.TRIM_MEMORY_COMPLETE))
        val slot = PostcardSlot<String>()
        assertTrue(slot.complete(slot.begin(), Postcard(key, "full-size", null, now)))
        slot.trim()
        assertNull("the full-size copy is gone", slot.shown)
        assertTrue("the half-size disk copy may fill the slot again", slot.restore(Postcard(key, "half-size", null, now)))
        val racing = PostcardSlot<String>(); val inFlight = racing.begin(); racing.trim()
        assertTrue("a copy in flight still lands, as the newest", racing.complete(inFlight, Postcard(key, "fresh", null, now)))
        val activity = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/MainActivity.kt").readText()
        assertTrue(activity.contains("gg.pixelkingdomwars.nativeclient.scene.ScenePostcards.trim(level)"))
    }

    @Test fun `startup decodes the stored postcard off Main`() {
        val activity = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/MainActivity.kt").readText()
        assertTrue(activity.contains("lifecycleScope.launch(Dispatchers.IO) { gg.pixelkingdomwars.nativeclient.scene.ScenePostcards.prewarm() }"))
        assertTrue(activity.contains("ScenePostcards.install(noBackupFilesDir)"))
    }
}
