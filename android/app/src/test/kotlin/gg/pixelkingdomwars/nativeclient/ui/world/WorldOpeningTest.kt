package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.compose.ui.graphics.Color
import gg.pixelkingdomwars.nativeclient.data.WorldContentPhase
import gg.pixelkingdomwars.nativeclient.data.WorldContentProgress
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeV2Renderer
import gg.pixelkingdomwars.nativeclient.ui.boot.StripMeter
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Owner 2026-10-06: "black screen is low quality indication … loading indicator is like not well implemented". Opening MAP
 * showed a centred plate ("Opening the world…" LoadingOverlay on the legacy globe, a charcoal "Shaping the realms…" plate on
 * the GL30 globe) over the #100E14 shell. Scene-transitions spec §3 "World open": the globe's own sky and the line — here
 * the D-193 strip after 400 ms, measured in verified files while the world downloads, with the reason and RETRY on a failure.
 */
class WorldOpeningTest {
    @Test fun `the stage is the globe's own sky, never the dark shell`() {
        assertEquals(Color(GlobeV2Renderer.SKY_R, GlobeV2Renderer.SKY_G, GlobeV2Renderer.SKY_B), WORLD_SKY)
        assertNotEquals(Color(0xFF100E14), WORLD_SKY)
    }

    @Test fun `the strip is measured only by verified files, says why on a failure, and sweeps otherwise`() {
        val failed = worldOpeningStrip(failed = true, download = null)
        assertEquals(StripMeter.Still, failed.meter); assertTrue(failed.reason); assertEquals("Couldn't open the world", failed.title)
        var last = -1f
        for (verified in 0..40 step 5) {
            val strip = worldOpeningStrip(false, WorldContentProgress(WorldContentPhase.DOWNLOADING, verified, 40))
            val fraction = (strip.meter as StripMeter.Measured).fraction
            assertTrue("a measured meter never moves backwards", fraction >= last); last = fraction
            assertEquals("Downloading · ${verified * 100 / 40}%", strip.line)
        }
        assertEquals("finished files fill it, nothing else", 1f, last, 0f)
        assertEquals("nothing measured: the one-way sweep", StripMeter.Sweep, worldOpeningStrip(false, null).meter)
        assertEquals("the web's own words", "Shaping the realms…", worldOpeningStrip(false, null).title)
    }

    @Test fun `no world opening draws a centred plate or the dark shell, and none shows an indicator before 400 ms`() {
        val main = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world")
        val legacy = File(main, "WorldScreen.kt").readText()
        val hud = File(main, "WorldHudScreen.kt").readText()
        for ((name, source) in listOf("legacy" to legacy, "gl30" to hud)) {
            assertFalse("$name: no LoadingOverlay", source.contains("LoadingOverlay("))
            assertTrue("$name: the 400 ms rule", source.contains("rememberIndicatorStage("))
            assertTrue("$name: the bottom strip", source.contains("SceneStrip("))
        }
        val loading = hud.substring(hud.indexOf("@Composable private fun WorldHudLoading("), hud.indexOf("@Composable private fun GlobeLayer("))
        assertFalse("no charcoal plate in the middle", loading.contains("Plate(PlateKind.CHARCOAL"))
        assertTrue("the veil is the sky", hud.contains(".background(WORLD_SKY))"))
        assertFalse(hud.contains("graphicsLayer { alpha = veil }.background(HudStyle.bg)"))
        assertTrue("the legacy opening stands on the sky too", legacy.contains("Box(Modifier.fillMaxSize().background(WORLD_SKY).blockSceneInput())"))
    }
}
