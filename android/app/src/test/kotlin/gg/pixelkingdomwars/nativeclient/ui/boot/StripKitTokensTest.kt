package gg.pixelkingdomwars.nativeclient.ui.boot

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Owner 2026-10-06: "improve visually too". The strip must read as a finished kit component (DESIGN-SYSTEM §5/§6, TOKENS):
 * the CHARCOAL plate with its bevel and a 1 dp inner shadow, one 8 dp padding, the portrait in its own pixel frame, the kit
 * title style in the strip's accent with a 0.5 s title cross-fade, a pixel-stepped meter on the kit track, the tip in muted
 * ink, a slight vignette behind it on the wallpaper, and the gesture inset kept clear. Colours come from the kit, never a
 * literal, so a token change reaches the strip.
 */
class StripKitTokensTest {
    private val strip = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/boot/LoadingStrip.kt").readText()
    private fun region(from: String, to: String) = strip.substring(strip.indexOf(from), strip.indexOf(to, strip.indexOf(from)))

    @Test fun `the strip's frame and meter use kit tokens, no hardcoded colours`() {
        val component = region("@Composable internal fun LoadingStrip(", "/** A strip button:")
        for (literal in listOf("Color(0x", "Color.Black", "Color.White", "Palette.", "Brush."))
            assertFalse("the strip draws no $literal", component.contains(literal))
        assertTrue("the kit plate", component.contains("drawPlate(PlateKind.CHARCOAL)"))
        assertTrue("the portrait's own pixel frame", component.contains("drawPlate(PlateKind.VEIL)"))
        for (token in listOf("PkwTokens.Colors.ink", "PkwTokens.Colors.track", "PkwTokens.Colors.gold.face", "PkwTokens.Colors.muted", "PkwTokens.Type.title"))
            assertTrue("uses $token", component.contains(token))
        assertTrue("the accent defaults to the kit's gold", strip.contains("internal val LocalStripAccent = staticCompositionLocalOf { PkwTokens.Colors.gold.hi }"))
    }

    @Test fun `one padding, a half-second title cross-fade, a slight vignette and the gesture inset`() {
        assertEquals(8f, LoadingStripPlan.PADDING, 0f)
        assertEquals(500, TITLE_CROSSFADE_MS)
        assertTrue("no title animation under reduced motion", strip.contains("Crossfade(content.title, animationSpec = if (reduced) snap() else tween(TITLE_CROSSFADE_MS)"))
        assertTrue("slight: under half-opaque at the very bottom", VIGNETTE_MAX_ALPHA < .5f && VIGNETTE_HEIGHT <= .35f)
        assertEquals("the gesture area wins when it is taller than the nav bar", 64f, stripBottomInset(48f, 64f), 0f)
        assertEquals(48f, stripBottomInset(48f, 0f), 0f)
        assertTrue(strip.contains("WindowInsets.systemGestures.asPaddingValues()"))
        val root = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient")
        val boot = File(root, "ui/boot/BootScreen.kt").readText()
        assertTrue("boot keeps the gesture area clear", boot.contains("LoadingStripPlan.of(maxWidth.value, maxHeight.value, stripInsets(), versionLabel"))
        assertTrue("boot draws the vignette over the wallpaper", boot.indexOf("StripVignette()") > boot.indexOf("LoadingBackdrop("))
        val scene = File(root, "ui/kingdom/ScenePresentation.kt").readText()
        assertTrue("every scene strip too", scene.contains("gg.pixelkingdomwars.nativeclient.ui.boot.stripInsets()"))
        assertTrue("and the Home wallpaper cover's vignette", scene.contains("gg.pixelkingdomwars.nativeclient.ui.boot.StripVignette()"))
        assertTrue("a Compose preview of the strip", strip.contains("@Composable private fun LoadingStripPreview()"))
    }
}
