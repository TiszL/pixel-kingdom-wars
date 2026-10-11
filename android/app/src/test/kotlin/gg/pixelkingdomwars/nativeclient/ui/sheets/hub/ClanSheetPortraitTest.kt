package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import gg.pixelkingdomwars.nativeclient.data.ClansState
import gg.pixelkingdomwars.nativeclient.model.ClanMember
import gg.pixelkingdomwars.nativeclient.model.ClanMembership
import gg.pixelkingdomwars.nativeclient.model.MyClan
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.CLAN_CARD_NAME_MAX_LINES
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.clanLiveUi
import java.io.File
import org.junit.Assert.*
import org.junit.Test

/**
 * Owner 2026-10-06 (Seeker build 880a7e7a): "why it's cut off". The game is portrait only now (ManifestWiringTest), so the
 * Clan card is checked in portrait on the Seeker: 1200 px at density 3.0, 400 dp wide (WorldMapSheetsTest). Each case pins
 * a cut found in the audit, measured with the bundled VT323 face's own advance and the kit's own type sizes, so a longer
 * sentence, a smaller line budget or a narrower column fails here instead of on the phone.
 */
class ClanSheetPortraitTest {
    private val seekerDp = 400f
    // HubCard (HubFrame.kt): the wood plate's 6 dp side padding, then the parchment's 8 dp side padding.
    private val headerDp = seekerDp - 2 * 6f
    private val bodyDp = headerDp - 2 * 8f
    // packages/shared/src/constants.ts CLANS.nameMaxLen / tagMaxLen: the longest name and tag the server accepts.
    private val longestName = "THE IRON WARDENS OF DAWN"
    private val longestTag = "[ABCDE]"

    /** VT323 is monospaced: every glyph advances hhea.advanceWidthMax / head.unitsPerEm em (0.4 in the bundled file). */
    private val advanceEm: Float by lazy {
        val font = File("src/main/res/font/pkw_vt323.ttf").readBytes()
        fun u16(at: Int) = ((font[at].toInt() and 0xFF) shl 8) or (font[at + 1].toInt() and 0xFF)
        fun table(tag: String): Int {
            for (i in 0 until u16(4)) { val r = 12 + 16 * i; if (String(font, r, 4, Charsets.US_ASCII) == tag) return (u16(r + 8) shl 16) or u16(r + 10) }
            fail("the font has no $tag table"); return -1
        }
        u16(table("hhea") + 10).toFloat() / u16(table("head") + 18)
    }
    private fun width(text: String, sp: Float) = text.length * advanceEm * sp

    /** Lines a Text needs at font scale 1: whole words per line, a word longer than a line broken by glyphs. */
    private fun lines(text: String, sp: Float, widthDp: Float): Int {
        val perLine = (widthDp / (advanceEm * sp)).toInt()
        assertTrue("a line must hold at least one glyph", perLine > 0)
        var lines = 1
        var used = 0
        for (word in text.split(' ')) {
            var w = word.length
            val need = if (used == 0) w else used + 1 + w
            if (need <= perLine) { used = need; continue }
            if (used > 0) { lines++; used = 0 }
            while (w > perLine) { w -= perLine; lines++ }
            used = w
        }
        return lines
    }

    private val wallet = "11111111111111111111111111111111"
    private fun member(name: String) = ClansState(supported = true, membership = ClanMembership(MyClan("00000000-0000-0000-0000-000000000001",
        name, "ABCDE", "invite", wallet, "aB3_x-9Q", listOf(ClanMember(wallet, "2026-10-01T00:00:00Z", "Rowan", 12, 1500, true)))))

    @Test fun `the live chest note wraps inside its card instead of ending in an ellipsis`() {
        // The live mapper never observes the weekly chest, so every member reads this sentence on the CLAN tab. One line cut it
        // at "...the reset time are…" on the Seeker.
        val ui = clanLiveUi(member("Iron Wardens"), wallet, true, true, "deed", null, "CLAN", LoadState.Ready)
        assertNull(ui.chest)
        // The cream card's 4 dp padding each side, then the text's own 8 dp each side (ClanSheet ClanBody).
        val textDp = bodyDp - 2 * 4f - 2 * 8f
        val needed = lines(ui.chestUnavailable, PkwTokens.Type.body.fontSize.value, textDp)
        assertTrue("one line would cut the sentence", needed > 1)
        assertTrue("$needed lines needed, ${CLAN_CHEST_NOTE_MAX_LINES} allowed", needed <= CLAN_CHEST_NOTE_MAX_LINES)
    }

    @Test fun `the longest clan name wraps in the header instead of being cut`() {
        val title = PkwTokens.Type.title.fontSize.value
        val column = headerDp - CLAN_HEADER_TEXT_START_DP - CLAN_HEADER_TEXT_END_DP
        assertTrue("one title line cannot hold a 24-letter name", width(longestName, title) > column)
        // The live header has no chest timer, so a live name always gets its two lines.
        val ui = clanLiveUi(member(longestName), wallet, true, true, "deed", null, "CLAN", LoadState.Ready)
        assertNull(ui.chestEndsIn)
        val allowed = clanHeaderNameMaxLines(chestTimer = ui.chestEndsIn != null)
        assertTrue(lines(longestName, title, column) <= allowed)
        assertTrue("a name with no spaces breaks by glyphs and still fits", lines("IRONWARDENSOFTHEDAWNXYZ1", title, column) <= allowed)
        // Two name lines, the "[TAG] · n/20 members" line and the tags row (22 dp, or a caption line + 2) stay inside the
        // 136 dp header, above its 3 dp ink rule: top 12, gaps 3 (ClanHeader).
        val tag = maxOf(22f, PkwTokens.Type.caption.lineHeight.value + 2f)
        val column2 = 12f + 2 * PkwTokens.Type.title.lineHeight.value + 3f + PkwTokens.Type.body.lineHeight.value + 3f + tag
        assertTrue("$column2 dp in the header", column2 <= PkwTokens.Dims.sheetHeaderH.value - 3f)
        assertTrue("the members line still fits one line",
            width("$longestTag · 20/20 members", PkwTokens.Type.body.fontSize.value) <= column)
    }

    @Test fun `with the chest timer the name keeps one line so the tags never reach the chip`() {
        // LivingHeader draws the TimerChip 11 dp above the header's bottom; a one-line name keeps the tags row above it.
        assertEquals(1, clanHeaderNameMaxLines(chestTimer = true))
        val tag = maxOf(22f, PkwTokens.Type.caption.lineHeight.value + 2f)
        val column1 = 12f + PkwTokens.Type.title.lineHeight.value + 3f + PkwTokens.Type.body.lineHeight.value + 3f + tag
        val chipTop = PkwTokens.Dims.sheetHeaderH.value - 11f - PkwTokens.Dims.timerChipH.value
        assertTrue("$column1 dp ends above the chip at $chipTop dp", column1 <= chipTop)
    }

    @Test fun `a long clan name in the finder wraps on its card instead of losing its end`() {
        // ClanCard: CardRow padding 8 + 12, the 56 dp banner well, the 76 dp JOIN, two 8 dp gaps, then the tag and its 6 dp gap.
        val nameDp = bodyDp - (8f + 12f) - 56f - 76f - 2 * 8f - width(longestTag, PkwTokens.Type.small.fontSize.value) - 6f
        val label = PkwTokens.Type.label.fontSize.value
        assertTrue("one label line cannot hold a 24-letter name", width(longestName, label) > nameDp)
        assertTrue(lines(longestName, label, nameDp) <= CLAN_CARD_NAME_MAX_LINES)
    }
}
