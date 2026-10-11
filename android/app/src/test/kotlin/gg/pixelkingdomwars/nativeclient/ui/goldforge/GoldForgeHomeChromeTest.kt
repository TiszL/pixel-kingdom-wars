package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteIdentity
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.HeroStatusKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.HeroStatusUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.heroStatusLine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Home-mounted Gold Forge chrome: the error toast rule (error.png), the LEGACY hero (legacy.png) and the copy. */
class GoldForgeHomeChromeTest {
    private val identity = HomeRouteIdentity(Any(), "00000000-0000-4000-8000-000000000001", 3)
    private fun data(loading: Boolean, failures: Map<String, String> = emptyMap()) =
        GoldForgeHomeData(identity, "11111111111111111111111111111112", loading = loading, failures = failures)

    // error.png: the toast belongs to a finished read pass that lost the server. A pass still reading (every routine
    // refresh) or a clean pass shows nothing, so a refresh never flashes an error over values that are still shown.
    @Test fun `the alert shows only after a finished read pass with a failed read`() {
        assertNull(goldForgeHomeAlert(data(loading = false)))
        assertNull(goldForgeHomeAlert(data(loading = true)))
        for (read in listOf("WALLET", "LEGACY", "GEMS", "buy", "SMELT", "CLAIM")) {
            val failed = mapOf(read to "The forge could not refresh. Try again.")
            assertEquals(read, GOLD_FORGE_OFFLINE, goldForgeHomeAlert(data(loading = false, failures = failed)))
            assertNull(read, goldForgeHomeAlert(data(loading = true, failures = failed)))
        }
        assertEquals(GOLD_FORGE_OFFLINE, goldForgeHomeAlert(data(loading = false,
            failures = mapOf("GEMS" to "Gems failed", "CLAIM" to "Claim failed"))))
    }

    // The client never retries by itself, so the toast asks the player to try again (SPEC E1.1) instead of the frame's
    // "Retrying…"; a read failure is not a money result, so it never says "Nothing was sent" (correction 7).
    @Test fun `the alert copy asks for a retry and never promises one`() {
        assertEquals("The forge can't reach the server. Try again.", GOLD_FORGE_OFFLINE)
        assertFalse(GOLD_FORGE_OFFLINE.contains("Retrying", ignoreCase = true))
        assertFalse(GOLD_FORGE_OFFLINE.contains("Nothing was", ignoreCase = true))
    }

    // legacy.png: the LEGACY chip says "Furnace lit" only. Every other status is passed through untouched, so a lost
    // server or a building in progress still reads honestly on that tab.
    @Test fun `the LEGACY hero drops the coin timer and keeps every other status`() {
        val bare = goldForgeLegacyHero(HeroStatusUi(HeroStatusKind.FORGING, time = "6h 20m"))
        assertTrue(bare.bare); assertEquals(HeroStatusKind.FORGING, bare.kind)
        val line = heroStatusLine(bare)
        assertEquals("Furnace lit", line.text); assertNull(line.emphasis); assertEquals(Verb.GOLD, line.dot)
        assertEquals(bare, goldForgeLegacyHero(bare))
        listOf(HeroStatusUi(HeroStatusKind.RECONNECTING), HeroStatusUi(HeroStatusKind.AT_REST, reason = "upgrading"),
            HeroStatusUi(HeroStatusKind.UNDER_CONSTRUCTION, time = "1h 12m")).forEach { hero ->
            assertEquals(hero, goldForgeLegacyHero(hero)); assertFalse(goldForgeLegacyHero(hero).bare)
        }
    }

    // Public wording: the closed CLAIM line says plainly that collecting is not open. It names no date, number, income
    // or "free", because none of those is known or allowed here.
    @Test fun `the closed claim line promises nothing`() {
        assertEquals("Collecting coins to your wallet is not open yet.", GOLD_FORGE_CLAIM_CLOSED)
        assertFalse(GOLD_FORGE_CLAIM_CLOSED.any(Char::isDigit))
        listOf("free", "earn", "income", "Phase E", "soon").forEach {
            assertFalse(it, GOLD_FORGE_CLAIM_CLOSED.contains(it, ignoreCase = true))
        }
    }
}
