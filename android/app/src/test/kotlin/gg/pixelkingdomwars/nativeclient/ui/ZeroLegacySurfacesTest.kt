package gg.pixelkingdomwars.nativeclient.ui

import androidx.compose.ui.graphics.Color
import gg.pixelkingdomwars.nativeclient.ui.chrome.ParchmentInk
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import kotlin.math.pow

/**
 * Owner 2026-10-06 (OWNER-FEEDBACK-0450Z): "I should not see any even 1 of old screens". The second old-screen sweep moved
 * every remaining pre-rehaul owner body onto the designed page (`ui/chrome/DesignedSurface.kt` DesignedPage): the bodies
 * keep their consent wording, owners and recovery sequencing, and only the surface changes. These cases pin WHY: no
 * navigation door may reach the old dark page or a platform dialog, the light text those bodies used must be swapped for
 * ink that reads on parchment, and the restyle must not move or reword a money step.
 */
class ZeroLegacySurfacesTest {
    private val root = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient")
    private val sources: Map<String, String> by lazy {
        root.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .associate { it.relativeTo(root).invariantSeparatorsPath to it.readText() }
    }
    private fun source(path: String) = sources.getValue(path)

    /** WCAG relative-luminance contrast of two opaque sRGB colours. */
    private fun contrast(a: Color, b: Color): Double {
        fun channel(c: Float): Double = if (c <= 0.03928f) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
        fun luminance(c: Color) = 0.2126 * channel(c.red) + 0.7152 * channel(c.green) + 0.0722 * channel(c.blue)
        val (hi, lo) = listOf(luminance(a), luminance(b)).sortedDescending()
        return (hi + 0.05) / (lo + 0.05)
    }

    // WHY: GamePage / GamePageHeader are the old dark page and its header bar; one of them behind any door is "an old
    // screen". Only the chrome definition and the two retired owners (which nothing opens) may still contain them.
    @Test fun `no navigation door can reach the old dark page`() {
        val retired = mapOf("ui/phasee/VehicleScreen.kt" to "VehicleScreen(", "ui/community/CommunityScreen.kt" to "CommunityScreen(")
        val offenders = sources.filter { (path, text) ->
            path != "ui/chrome/ScreenChrome.kt" && path !in retired && ("GamePage(" in text || "GamePageHeader(" in text)
        }.keys
        assertEquals("these files still draw the old dark page", emptySet<String>(), offenders)
        for ((file, call) in retired) {
            val opener = Regex("""(?<![\w.])${Regex.escape(call)}""")
            val callers = sources.filter { (path, text) -> path != file && opener.containsMatchIn(text) }.keys
            assertEquals("$call is retired, so nothing may open it", emptySet<String>(), callers)
        }
    }

    // WHY: material3's AlertDialog draws the platform dialog (the old look); the chrome AlertDialog is the wood-framed
    // designed dialog. Every dialog call must resolve to the chrome one, and no platform toast may cover the dock.
    @Test fun `every dialog resolves to the designed dialog and no platform toast is posted`() {
        val chromeDialog = "import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog\n"
        val chromeAll = "import gg.pixelkingdomwars.nativeclient.ui.chrome.*\n"
        val undesigned = sources.filter { (path, text) ->
            !path.startsWith("ui/chrome/") && "AlertDialog(" in text && chromeDialog !in text && chromeAll !in text
        }.keys
        assertEquals("these dialogs would resolve to the platform dialog", emptySet<String>(), undesigned)
        assertEquals(emptySet<String>(), sources.filter { (_, t) -> "import androidx.compose.material3.AlertDialog" in t || "BasicAlertDialog(" in t }.keys)
        assertEquals(emptySet<String>(), sources.filter { (_, t) -> "android.widget.Toast" in t || "Toast.makeText(" in t }.keys)
        assertTrue("the chrome dialog draws the designed panel", "DesignedDialogPanel(" in source("ui/chrome/Controls.kt"))
    }

    // WHY: the converted bodies still name the old light colours; on parchment those read between 1.0:1 and 3.4:1. Each
    // one must be swapped for the design's ink, and that ink must clear the 4.5:1 body-text floor on every light fill a
    // body sits on (the parchment, the cream card, the selected tint).
    @Test fun `parchment ink stays readable where the old light text would not`() {
        val fills = listOf(PkwTokens.Colors.parchment, PkwTokens.Colors.cream, PkwTokens.Colors.selectedTint)
        assertEquals(setOf("text", "muted", "textFaint", "goldHi", "gold", "danger", "success"), ParchmentInk.byLegacyName.keys)
        for ((name, pair) in ParchmentInk.byLegacyName) {
            val (legacy, ink) = pair
            assertTrue("the old $name colour fails on parchment, which is why it is swapped", contrast(legacy, PkwTokens.Colors.parchment) < 4.5)
            fills.forEach { fill -> assertTrue("$name ink must read on $fill", contrast(ink, fill) >= 4.5) }
        }
        NoticeKind.entries.forEach { kind ->
            val style = parchmentNoticeStyle(kind)
            assertTrue("a $kind notice on parchment must read", contrast(style.text, style.fill) >= 4.5)
        }
        val ink = source("ui/chrome/DesignedSurface.kt")
        for (name in listOf("text", "muted", "goldHi", "gold", "danger", "success"))
            assertTrue("SurfaceInk.$name swaps to the parchment ink", "ParchmentInk.$name)" in ink)
    }

    // WHY: the old bodies are drawn with the chrome primitives; the designed page only works if it hides the world behind
    // it (owner: no dark overlap at the camera, full screen) and the primitives draw the kit material on its parchment.
    @Test fun `the designed page covers the world and the chrome primitives follow its surface`() {
        val page = source("ui/chrome/DesignedSurface.kt")
        assertTrue(page.indexOf("FullScreenSheetBackdrop()") in 0 until page.indexOf("SheetFrame(SheetFrameUi(title"))
        assertTrue("LocalSurfaceTone provides SurfaceTone.PARCHMENT" in page)
        val controls = source("ui/chrome/Controls.kt")
        assertTrue("if (onDesignedSurface()) { DesignedChromeButton(" in controls)
        assertTrue("cards and panels turn cream", controls.split("if (onParchment()) { CreamCard(modifier, content); return }").size == 3)
        assertTrue("if (onParchment()) {" in source("ui/chrome/PixelArt.kt"))
    }

    // WHY: each door the owner can still tap lands on the designed page (the second sweep's list), never a bare column.
    @Test fun `the swept doors mount the designed page`() {
        val doors = mapOf(
            "ui/economy/StarterExpeditionScreen.kt" to "DesignedPage(\"STARTER EXPEDITIONS\"",
            "ui/phasee/PaidStarterExpeditionScreen.kt" to "DesignedPage(\"PAID REALM EXPEDITIONS\"",
            "ui/phasee/KeepEquipmentMarketScreen.kt" to "DesignedPage(\"KEEP MARKET\"",
            "ui/economy/HarvesterScreen.kt" to "DesignedPage(\"HARVESTERS\"",
            "ui/economy/StarterFleetScreen.kt" to "DesignedPage(\"STARTER FLEET\"",
            "ui/economy/EconomyScreen.kt" to "DesignedPage(when (page)",
            "ui/army/ResearchScreen.kt" to "DesignedPage(\"ALCHEMY LAB\"",
            "ui/roster/RosterScreens.kt" to "DesignedPage(\"INVENTORY\"",
            "ui/economy/MarketScreen.kt" to "DesignedPage(\"MARKET\"",
            "ui/kingdom/KingdomScreen.kt" to "DesignedPage(\"BUILDER PAYMENT\"",
            "ui/community/PlaytestCampaignScreen.kt" to "DesignedPage(\"PLAYTEST CAMPAIGNS\"",
        )
        for ((path, mount) in doors) assertTrue("$path mounts the designed page", mount in source(path))
        val roster = source("ui/roster/RosterScreens.kt")
        assertTrue("DesignedPage(\"HEROES\"" in roster && "DesignedPage(\"CODEX\"" in roster)
        assertTrue("the hero KEEP confirm is the designed dialog", "import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog\n" in roster)
    }

    // WHY: a restyle must not reword consent or move a money step: the KEEP market's pinned primary is the same owner
    // calls with the same sentences, now in the designed footer.
    @Test fun `the KEEP market payment continuation keeps its owners and wording`() {
        val market = source("ui/phasee/KeepEquipmentMarketScreen.kt")
        for (line in listOf("\"approve\"->model.approve(rentAccepted)", "\"send\"->model.send()", "\"review\"->model.reviewPayment()",
            "Signs the exact payment shown above. Sending is a separate step.", "Sends only the saved signed payment.",
            "Confirm to reserve these units. You will review wallet payment next. An unresolved reservation remains saved."))
            assertTrue(line, line in market)
        for (forbidden in listOf("signTransaction", "sendTransaction")) assertFalse(forbidden in market)
    }
}
