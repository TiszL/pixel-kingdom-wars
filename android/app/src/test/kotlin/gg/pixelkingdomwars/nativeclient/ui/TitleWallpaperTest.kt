package gg.pixelkingdomwars.nativeclient.ui

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Owner 2026-09-27: "we forgot to upgrade wallet connection screen on android native app with new wallpaper". The
 * code-26 cycle gave Boot (and the required-update screen) the owner's bright loading wallpaper (2026-09-25: bright,
 * exactly our game, a portrait and a landscape painting, the card readable over it) but the wallet-connection Title kept
 * the old dark night painting, so a player went from the new art straight back to the old one at the moment they
 * connect. These screens are Compose-only and the module has no Compose test runtime, so the wiring is checked in
 * source the way `RealmLeaveOrderTest` checks the world host; the art pair itself is checked in its PNG headers.
 */
class TitleWallpaperTest {
    private val root = "src/main/kotlin/gg/pixelkingdomwars/nativeclient"
    private val titleFile = File("$root/ui/title/TitleScreens.kt").readText()
    private val designedFile = File("$root/ui/sheets/account/TitleScreen.kt").readText()
    private val title = designedFile.substring(designedFile.indexOf("@Composable fun TitleScreen("), designedFile.indexOf("/** The plain ground"))
    private val boot = File("$root/ui/boot/BootScreen.kt").readText()
    private val update = File("$root/update/UpdateScreen.kt").readText()
    private val art = File("$root/ui/chrome/PixelArt.kt").readText()

    @Test fun `the wallet-connection screen draws the boot wallpaper, never the old title painting`() {
        assertTrue("Title paints the shared loading wallpaper", "LoadingBackdrop(portrait = !landscape, modifier = Modifier.fillMaxSize(), brightness = .9f)" in title)
        assertFalse("no fallback to the old night painting anywhere on the sign-in screens", "TitleBackdrop" in titleFile)
        // Boot picks portrait when width <= height; Title's `!landscape` must be exactly that rule, or a square-ish
        // window would show one painting on Boot and the other on Title.
        assertTrue("LoadingBackdrop(maxWidth <= maxHeight, Modifier.fillMaxSize(), brightness = .9f)" in boot)
        assertTrue("val landscape = maxWidth > maxHeight" in title)
    }

    @Test fun `boot, required update and sign-in paint one wallpaper at one brightness over one gradient`() {
        val call = Regex("""LoadingBackdrop\(.*?brightness = ([.\d]+f)\)""")
        val gradient = "Brush.verticalGradient(listOf(Palette.surface, Palette.backdrop))"
        for ((name, source) in listOf("boot" to boot, "update" to update, "title" to title)) {
            val calls = call.findAll(source).map { it.groupValues[1] }.toList()
            assertEquals("$name draws the wallpaper once, at boot's .9 brightness", listOf(".9f"), calls)
            // The decode runs off the first frame; until it lands the screen shows boot's gradient, not what lies beneath.
            assertTrue("$name paints boot's gradient under the wallpaper", gradient in source)
        }
    }

    @Test fun `the wallpaper is the portrait and landscape art pair, cover-cropped`() {
        assertTrue("CoverBackdrop(if (portrait) R.drawable.pkw_web_loading_portrait else R.drawable.pkw_web_loading_landscape, modifier, brightness)" in art)
        // Cover: the larger scale fills both axes and crops the overflow; the smaller one would letterbox the art.
        assertTrue("val scale = maxOf(size.width / bitmap.width, size.height / bitmap.height)" in art)
        val (pw, ph) = pngSize("src/main/res/drawable-nodpi/pkw_web_loading_portrait.png")
        val (lw, lh) = pngSize("src/main/res/drawable-nodpi/pkw_web_loading_landscape.png")
        assertEquals("portrait is 540x1200, half the Seeker's panel", 540 to 1200, pw to ph)
        assertEquals("landscape is 1200x540, half the Seeker's panel", 1200 to 540, lw to lh)
    }

    @Test fun `designed sign in copy stays readable on parchment and outlined footer`() {
        assertTrue("The player route mounts the designed title", "DesignedTitleScreen(" in titleFile)
        assertTrue("Card copy has a parchment surface", "Plate(PlateKind.PARCHMENT" in title)
        assertTrue("Footer remains outlined over the bright wallpaper", "outline = 1.dp" in title)
        assertTrue("The old unframed title strapline is retired", "MINE · BUILD · RAID" !in titleFile)
        assertTrue("Updater keeps its readable surface", "NativeUpdateBanner(" in titleFile)
        assertTrue("Local mode stays visible", "Copy.LOCAL_SERVER" in titleFile)
    }

    private fun pngSize(path: String): Pair<Int, Int> {
        val bytes = File(path).readBytes()
        fun int(at: Int) = (bytes[at].toInt() and 0xff shl 24) or (bytes[at + 1].toInt() and 0xff shl 16) or (bytes[at + 2].toInt() and 0xff shl 8) or (bytes[at + 3].toInt() and 0xff)
        assertEquals("IHDR", String(bytes, 12, 4, Charsets.US_ASCII))
        return int(16) to int(20)
    }
}
