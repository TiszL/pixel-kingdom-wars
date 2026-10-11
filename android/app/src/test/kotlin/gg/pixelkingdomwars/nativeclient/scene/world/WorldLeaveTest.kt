package gg.pixelkingdomwars.nativeclient.scene.world

import gg.pixelkingdomwars.nativeclient.scene.POSTCARD_MAX_AGE_MS
import gg.pixelkingdomwars.nativeclient.scene.PostcardKey
import gg.pixelkingdomwars.nativeclient.scene.WORLD_ACCOUNT
import gg.pixelkingdomwars.nativeclient.scene.WORLD_BASE
import gg.pixelkingdomwars.nativeclient.scene.worldPostcardAdmitted
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Field report 2026-10-06 (Seeker, 880a7e7a, phone/v880-back-0.png): MAP → hardware Back showed one BLACK frame with the
 * world's realm labels (FROSTVEIL, CROWNLANDS, …) and the world HUD still drawn over it, then Home. The world's GL surface
 * was already gone while its Compose layers were still on screen, and nothing lay under the surface but the window's
 * #100E14. Under each scene surface there is now a picture — the globe's last frame (else its sky) under the world, the
 * kingdom's postcard under Home — which the surface punches through while it is up and which shows in exactly that frame.
 */
class WorldLeaveTest {
    private val main = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient")
    private fun read(path: String) = File(main, path).readText()

    @Test fun `leaving the world never shows a frame without a picture`() {
        // The picture sits in the world HUD itself, beneath the engine: it outlives the surface whichever leaves first.
        val hud = read("ui/world/WorldHudScreen.kt")
        val backing = hud.indexOf("gg.pixelkingdomwars.nativeclient.scene.world.WorldBacking(art?.let { \"world-engine-\${it.name}\" })")
        val engine = hud.indexOf("if (art != null) key(art) { engine.Content(art, bridge, Modifier.fillMaxSize()) }")
        assertTrue("beneath the GL surface (drawn first), in the composition that also draws the labels and the HUD", backing in 0 until engine)
        val surface = read("scene/world/WorldEngineSurface.kt")
        assertTrue("its tag is the surface's own", surface.contains("val tag = \"world-engine-\${art.name}\""))
        val fn = surface.substring(surface.indexOf("@Composable internal fun WorldBacking("))
        assertTrue("the globe's own sky under everything, never the dark window", fn.contains(".background(gg.pixelkingdomwars.nativeclient.ui.world.WORLD_SKY)"))
        assertTrue("and the globe's last frame over it", fn.contains("ScenePostcards.world.shown"))
        assertFalse(fn.contains("Palette.backdrop") || fn.contains("HudStyle.bg"))
    }

    @Test fun `the globe's last frame is taken once it is ready and kept fresh while the map is up`() {
        val surface = read("scene/world/WorldEngineSurface.kt")
        assertTrue(surface.contains("snapshotFlow { bridge.ready }.first { it }"))
        assertTrue(surface.contains("gg.pixelkingdomwars.nativeclient.scene.ScenePostcards.captureWorld(fragment, tag)"))
        val postcards = read("scene/ScenePostcards.kt")
        val capture = postcards.substring(postcards.indexOf("fun captureWorld("), postcards.indexOf("fun trim(level: Int)"))
        assertTrue("half size: ~3 MB, it is shown for a frame", capture.contains("Bitmap.createBitmap(maxOf(1, key.width / 2), maxOf(1, key.height / 2)"))
        assertTrue("off the GL thread and off Main", capture.contains("}, background)"))
        assertTrue("sign-out drops it", postcards.contains("slot.forget(account); world.forget(null)"))
        assertTrue("memory pressure drops it", postcards.contains("if (action != PostcardTrim.KEEP) world.trim()"))
    }

    @Test fun `a globe picture stands only for the same content at the same size`() {
        val now = 1_000_000L
        val key = PostcardKey(WORLD_ACCOUNT, "world-engine-overview-abc", WORLD_BASE, 1200, 2670)
        assertTrue(worldPostcardAdmitted(key, now - 5_000, "world-engine-overview-abc", 1200, 2670, now))
        assertFalse("another world content", worldPostcardAdmitted(key, now, "world-engine-overview-def", 1200, 2670, now))
        assertFalse("rotated", worldPostcardAdmitted(key, now, "world-engine-overview-abc", 2670, 1200, now))
        assertFalse("too old", worldPostcardAdmitted(key, now - POSTCARD_MAX_AGE_MS - 1, "world-engine-overview-abc", 1200, 2670, now))
        assertFalse("a kingdom postcard is never the globe",
            worldPostcardAdmitted(key.copy(account = "acct-a", baseId = "base-1"), now, "world-engine-overview-abc", 1200, 2670, now))
    }

    @Test fun `Home lands on its postcard in the frame the world leaves, with the same picture beneath its surface`() {
        val kingdom = read("ui/kingdom/KingdomScreen.kt")
        val backing = kingdom.indexOf("PostcardBacking(shownPostcard)")
        assertTrue("beneath Home's GL surface", backing >= 0 && backing < kingdom.indexOf("SceneSurface(assets, mapped,"))
        assertTrue("and the cover shows it in Home's first composition",
            kingdom.contains("ScenePresentationLayer(live, shownPostcard, coverFailed, coverRetry"))
    }
}
