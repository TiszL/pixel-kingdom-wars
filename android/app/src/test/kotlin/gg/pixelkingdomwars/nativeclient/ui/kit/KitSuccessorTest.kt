package gg.pixelkingdomwars.nativeclient.ui.kit

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The kit successor's pure rules (MS-M receipt 744b8482; design ruling 092decf3 and 5ed31eb8; design correction 7).
 * Why they matter: balances arrive as canonical decimal or base-unit strings larger than a Long, so a readout must never
 * round up, invent a zero, or overflow; a price the server is still checking must stay a door, not a dead button; only an
 * authoritative refusal may tell a player nothing was spent; and a registry shape must never silently draw nothing.
 */
class KitSuccessorTest {

    // ---- Decimal-safe compact amounts ----

    @Test fun `a compact amount matches the whole-number readout rules exactly`() {
        val samples = listOf(0L, 9L, 120L, 999L, 1_000L, 2_000L, 2_599L, 9_999L, 40_943L, 48_999L, 99_999L, 100_000L, 123_499L,
            999_999L, 1_000_000L, 1_299_999L, 9_999_999L, 123_456_789L, 999_999_999L, 12_345_678_901L)
        samples.forEach {
            assertEquals("readout $it", readoutValue(it), compactAmount(it.toString()))
            assertEquals("tile $it", tileCount(it), compactAmount(it.toString(), maxGlyphs = 4))
        }
    }

    @Test fun `unknown or malformed amounts are the ellipsis and never zero`() {
        listOf(null, "", "   ", ".", "1,000", "1e9", "12abc", "--1", "0x10").forEach { assertEquals("$it", UNKNOWN, compactAmount(it)) }
        assertEquals(UNKNOWN, compactAmount("100", decimals = -1))
        assertEquals(UNKNOWN, exactAmount(null))
        assertEquals("0", compactAmount("0"))
        assertEquals("0", compactAmount("0000", decimals = 9))
    }

    @Test fun `base units shift by their decimals without floating point`() {
        assertEquals("312.5", compactAmount("312500000", decimals = 6))
        assertEquals("312.5", compactAmount("312.5"))
        assertEquals("1.5", compactAmount("15", decimals = 1))
        assertEquals("0.15", compactAmount("1.5", decimals = 1))
        assertEquals("12.34", compactAmount("12.3499"))
        assertEquals("1,234", compactAmount("1234.99"))
        assertEquals("0.5", compactAmount("500000000", decimals = 9))
        assertEquals("0.12", compactAmount("0.129"))
    }

    // A dust balance is real money: it must not read as zero, and must not round up to a cent it is not.
    @Test fun `tiny non-zero amounts read as under a hundredth`() {
        assertEquals("<0.01", compactAmount("1", decimals = 9))
        assertEquals("<0.01", compactAmount("0.009999"))
        assertEquals("0.01", compactAmount("0.01"))
        assertEquals("-<0.01", compactAmount("-0.001"))
    }

    @Test fun `amounts far beyond a Long abbreviate by string arithmetic and round down`() {
        assertEquals("98.7T", compactAmount("98765432109876"))
        assertEquals("1T", compactAmount("1000000000000"))
        val huge = "9".repeat(30)
        assertTrue(compactAmount(huge).endsWith("T"))
        assertTrue(compactAmount(huge).startsWith("9".repeat(18)))
        assertEquals("123.4M", compactAmount("123456789000000000000", decimals = 12))
        assertEquals("-1.2M", compactAmount("-1299999"))
    }

    @Test fun `exact amounts keep every digit grouped`() {
        assertEquals("1,234,567.000001", exactAmount("1234567000001", decimals = 6))
        assertEquals("40,943", exactAmount("40943"))
        assertEquals("0.000000001", exactAmount("1", decimals = 9))
        assertEquals("0", exactAmount("0.000"))
        assertEquals("123,456,789,012,345,678,901", exactAmount("123456789012345678901"))
    }

    // ---- Sheet geometry ----

    @Test fun `full sheets sit at 60 dp and 14 dp above the gesture inset while tall sheets keep 104 dp`() {
        assertEquals(60 to 14 + 24, sheetEdgesDp(SheetSize.FULL, gestureInsetDp = 24))
        assertEquals(104 to 24, sheetEdgesDp(SheetSize.TALL, gestureInsetDp = 24))
        assertEquals(60 to 14, sheetEdgesDp(SheetSize.FULL, gestureInsetDp = -5))
        assertNull(sheetEdgesDp(SheetSize.HALF, gestureInsetDp = 24))
        assertEquals(204, SheetGeometry.GOLD_FORGE_HEADER_DP)
        assertEquals(136, SheetGeometry.HEADER_DP)
    }

    // ---- Command states (design correction 7) ----

    private fun cmd(state: CommandState, price: PriceStatus? = null, primary: Boolean = false) = CommandUi(FeatureId("x.y"), "i", "X",
        price?.let { PriceUi(Currency.SHARDS, if (it == PriceStatus.OK || it == PriceStatus.SHORT) "10" else null, it) }, primary, state, "why", null)

    @Test fun `a checking price stays enabled navigation into the review sheet`() {
        assertEquals(CommandState.ENABLED, commandDrawState(cmd(CommandState.ENABLED, PriceStatus.CHECKING)))
        assertEquals(CommandRoute.OPEN, commandRoute(cmd(CommandState.ENABLED, PriceStatus.CHECKING)))
    }

    @Test fun `an unavailable price is disabled with its reason and a short price opens need-more`() {
        assertEquals(CommandState.DISABLED, commandDrawState(cmd(CommandState.ENABLED, PriceStatus.UNAVAILABLE)))
        assertEquals(CommandRoute.EXPLAIN, commandRoute(cmd(CommandState.ENABLED, PriceStatus.UNAVAILABLE)))
        assertEquals(CommandRoute.NEED_MORE, commandRoute(cmd(CommandState.ENABLED, PriceStatus.SHORT)))
        assertEquals(CommandRoute.NEED_MORE, commandRoute(cmd(CommandState.SHORT, PriceStatus.OK)))
        assertEquals(CommandRoute.OPEN, commandRoute(cmd(CommandState.ENABLED, PriceStatus.OK)))
    }

    // "primary" is a visual designation, not an authority: a locked primary explains itself and never runs.
    @Test fun `a locked primary keeps its designation but only explains and busy never calls back`() {
        val locked = cmd(CommandState.LOCKED, PriceStatus.OK, primary = true)
        assertEquals(CommandState.LOCKED, commandDrawState(locked))
        assertEquals(CommandRoute.EXPLAIN, commandRoute(locked))
        assertEquals(locked, orderCommands(listOf(cmd(CommandState.ENABLED), locked), max = 4).last())
        assertEquals(CommandRoute.IGNORE, commandRoute(cmd(CommandState.BUSY, PriceStatus.CHECKING)))
    }

    @Test fun `the portrait bar keeps four commands with INFO first and the primary last`() {
        fun c(id: String, primary: Boolean = false) = CommandUi(FeatureId(id), "i", id, null, primary, CommandState.ENABLED, null, null)
        val five = listOf(c("info"), c("a"), c("b"), c("c"), c("p", primary = true))
        val portrait = orderCommands(five, PkwTokens.Budget.MAX_COMMANDS_PORTRAIT)
        assertEquals(listOf("info", "a", "b", "p"), portrait.map { it.id.value })
        assertEquals(4, PkwTokens.Budget.MAX_COMMANDS_PORTRAIT)
    }

    // ---- Copy: only an authoritative refusal may say nothing was spent ----

    @Test fun `an uncertain outcome never says nothing was spent`() {
        val uncertain = outcomeLine("upgrade", authoritative = false)
        assertFalse(uncertain.contains("Nothing was spent"))
        assertTrue(uncertain.contains("Checking"))
        assertEquals("Not enough Shards. Nothing was spent.", outcomeLine("upgrade", authoritative = true, serverReason = "Not enough Shards."))
        assertTrue(outcomeLine("upgrade", authoritative = true).endsWith("Nothing was spent."))
    }

    // ---- Glyphs ----

    @Test fun `registry shapes resolve and an unknown shape draws the visible question mark`() {
        listOf("chest", "hammer", "axe", "anchor", "mail", "chat").forEach { assertEquals(it, glyphKey("shape:$it")) }
        assertEquals("mail", glyphKey("shape:envelope"))
        assertEquals("chat", glyphKey("speech"))
        assertEquals("up", glyphKey("shape:chevron-up"))
        assertEquals("unknown", glyphKey("shape:dragon"))
        assertTrue(KIT_GLYPHS.getValue("unknown").any { it.contains('#') })
        GLYPH_ALIASES.values.forEach { assertTrue(it, KIT_GLYPHS.containsKey(it)) }
        GLYPH_ALIASES.keys.forEach { assertFalse("an alias must not shadow a real glyph: $it", KIT_GLYPHS.containsKey(it)) }
    }

    // ---- Celebration ----

    // The design frame wins over the VEIL plate the ribbon was built on: a dark veil-hi band read as a seam across the gold.
    @Test fun `the celebration ribbon's top band is gold-hi, not the veil's dark band`() {
        assertEquals(PkwTokens.Colors.gold.hi, RIBBON_BAND)
        assertFalse(RIBBON_BAND == PkwTokens.Colors.veilHi)
    }
}
