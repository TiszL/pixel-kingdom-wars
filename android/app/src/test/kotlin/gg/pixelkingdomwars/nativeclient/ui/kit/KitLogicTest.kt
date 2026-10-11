package gg.pixelkingdomwars.nativeclient.ui.kit

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.ToastKind
import gg.pixelkingdomwars.nativeclient.ui.model.ToastUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure rules behind the UI kit (design/final DESIGN-SYSTEM.md, TOKENS.json). */
class KitLogicTest {
    // Money honesty (M48, DESIGN-SYSTEM §9): a price the server has not given must never read as free.
    @Test fun `an unknown or unpriced cost never renders as zero or free`() {
        assertEquals("…", priceText(PriceUi(Currency.SHARDS, null, PriceStatus.OK)))
        assertEquals("…", priceText(PriceUi(Currency.SHARDS, "", PriceStatus.SHORT)))
        assertEquals("…", priceText(PriceUi(Currency.GEMS, "500", PriceStatus.CHECKING)))
        assertEquals("unavailable", priceText(PriceUi(Currency.SOL, "0.1", PriceStatus.UNAVAILABLE)))
        assertEquals("52,400", priceText(PriceUi(Currency.SHARDS, "52,400", PriceStatus.SHORT)))
    }

    @Test fun `only a server zero may draw a zero price`() {
        assertEquals("0", priceText(PriceUi(Currency.GEMS, null, PriceStatus.SERVER_ZERO)))
        assertEquals("0", priceText(PriceUi(Currency.GEMS, "0", PriceStatus.SERVER_ZERO)))
        assertTrue(priceDescription(PriceUi(Currency.SHARDS, "10", PriceStatus.SHORT)).contains("not enough"))
    }

    // The HUD readout rule: at most 6 glyphs so four rows fit 108 dp, and never more than the player has.
    @Test fun `readout values fit six glyphs and round down`() {
        assertEquals("…", readoutValue(null))
        assertEquals("0", readoutValue(0))
        assertEquals("40,943", readoutValue(40_943))
        assertEquals("99,999", readoutValue(99_999))
        assertEquals("123.4K", readoutValue(123_499))
        assertEquals("999.9K", readoutValue(999_999))
        assertEquals("1.2M", readoutValue(1_299_999))
        assertEquals("1M", readoutValue(1_000_000))
        listOf(0L, 9L, 99_999L, 100_000L, 999_999L, 123_456_789L, 999_999_999L, 12_345_678_901L).forEach {
            assertTrue("$it -> ${readoutValue(it)}", readoutValue(it).length <= 6)
        }
    }

    @Test fun `drawer tile counts fit four glyphs and round down`() {
        assertEquals("…", tileCount(null))
        assertEquals("120", tileCount(120))
        assertEquals("2K", tileCount(2_000))
        assertEquals("2.5K", tileCount(2_599))
        assertEquals("48K", tileCount(48_999))
        assertEquals("1.2M", tileCount(1_299_999))
        listOf(0L, 999L, 9_999L, 999_999L, 9_999_999L, 999_999_999L).forEach { assertTrue("$it", tileCount(it).length <= 4) }
    }

    @Test fun `badge counts hide at zero and cap at 99 plus`() {
        assertNull(badgeCount(0))
        assertNull(badgeCount(-3))
        assertEquals("7", badgeCount(7))
        assertEquals("99", badgeCount(99))
        assertEquals("99+", badgeCount(100))
    }

    // Count-up only animates honest whole numbers; a decimal or unknown never shows a made-up intermediate.
    @Test fun `count up interpolates grouped integers and snaps everything else`() {
        assertEquals("40,743", countUpText("40,743", "40,943", 0f))
        assertEquals("40,843", countUpText("40,743", "40,943", 0.5f))
        assertEquals("40,943", countUpText("40,743", "40,943", 1f))
        assertEquals("150", countUpText("100", "200", 0.5f))
        assertEquals("312.5", countUpText("300.0", "312.5", 0.5f))
        assertEquals("40,943", countUpText("…", "40,943", 0.5f))
        assertEquals("…", countUpText("40,943", "…", 0.5f))
    }

    // Toasts (DESIGN-SYSTEM §6): the same key merges instead of stacking, at most three, each lives four seconds.
    @Test fun `toasts merge by key cap at three and expire after the hold`() {
        fun toast(key: String) = ToastUi(key, "m-$key", null, ToastKind.INFO, null, null, false, 0L)
        var queue = ToastQueue.post(emptyList(), toast("a"), 1_000)
        queue = ToastQueue.post(queue, toast("b"), 1_100)
        queue = ToastQueue.post(queue, toast("a").copy(message = "again"), 2_000)
        assertEquals(listOf("a", "b"), queue.map { it.key })
        assertEquals("again", queue[0].message)
        assertEquals(1, queue[0].revision)
        assertEquals(2_000L, queue[0].postedAtMs)
        queue = ToastQueue.post(queue, toast("c"), 2_100)
        queue = ToastQueue.post(queue, toast("d"), 2_200)
        assertEquals(listOf("b", "c", "d"), queue.map { it.key })
        assertEquals(5_100L, ToastQueue.nextExpiry(queue))
        assertEquals(listOf("c", "d"), ToastQueue.expire(queue, 5_100).map { it.key })
        assertNull(ToastQueue.nextExpiry(emptyList()))
    }

    // The seal arms for 450 ms so a double tap on the opening button cannot also confirm a spend.
    @Test fun `a seal refuses taps until it has armed`() {
        assertFalse(sealAccepts(nowMs = 10_000, armedAtMs = 10_000))
        assertFalse(sealAccepts(nowMs = 10_449, armedAtMs = 10_000))
        assertTrue(sealAccepts(nowMs = 10_450, armedAtMs = 10_000))
        assertEquals(0f, sealArmFraction(9_000, 10_000), 0f)
        assertEquals(0.5f, sealArmFraction(10_225, 10_000), 0.001f)
        assertEquals(1f, sealArmFraction(20_000, 10_000), 0f)
    }

    // The money sequence must not accept a second tap while the wallet or the server is busy (no double spend).
    @Test fun `money button only accepts taps when ready or failed`() {
        assertEquals(listOf(true, false, false, false, true), MoneyStage.entries.map { moneyLook(it, "CLAIM").accepts })
        assertEquals(Verb.GOLD, moneyLook(MoneyStage.READY, "CLAIM").verb)
        assertEquals("CLAIM", moneyLook(MoneyStage.READY, "CLAIM").text)
        assertEquals(Verb.MOSS, moneyLook(MoneyStage.SENT, "CLAIM").verb)
        assertTrue(moneyLook(MoneyStage.SENDING, "CLAIM").dots)
        assertEquals("RETRY", moneyLook(MoneyStage.FAILED, "CLAIM").text)
    }

    // The primary sits last under the right thumb (DESIGN-SYSTEM §3), one per bar, five commands at most.
    @Test fun `the primary command is always last and alone`() {
        fun cmd(id: String, primary: Boolean = false) =
            CommandUi(FeatureId(id), "i", id.uppercase(), null, primary, CommandState.ENABLED, null, null)
        val ordered = orderCommands(listOf(cmd("info"), cmd("forge", primary = true), cmd("upgrade")))
        assertEquals(listOf("info", "upgrade", "forge"), ordered.map { it.id.value })
        val twoPrimaries = orderCommands(listOf(cmd("a", true), cmd("b", true), cmd("c")))
        assertEquals(1, twoPrimaries.count { it.primary })
        assertEquals("a", twoPrimaries.last().id.value)
        val crowded = orderCommands((1..7).map { cmd("c$it") } + cmd("p", true))
        assertEquals(5, crowded.size)
        assertEquals("p", crowded.last().id.value)
    }

    // Stepped corners: the outline must stay inside its box and stay symmetric, or plates would bleed or look lopsided.
    @Test fun `stepped corner polygons stay inside the box and mirror`() {
        val w = 108f; val h = 26f
        val points = steppedPolygon(w, h, CornerProfiles.M)
        assertEquals(CornerProfiles.M.size * 4, points.size)
        for (i in points.indices step 2) {
            assertTrue(points[i] in 0f..w); assertTrue(points[i + 1] in 0f..h)
        }
        assertEquals(0f, points[0], 0f); assertEquals(8f, points[1], 0f)
        val tiny = steppedPolygon(6f, 6f, CornerProfiles.M)
        for (i in tiny.indices step 2) { assertTrue(tiny[i] in 0f..6f); assertTrue(tiny[i + 1] in 0f..6f) }
        assertEquals(8, steppedPolygon(10f, 10f, CornerProfiles.NONE).size)
    }

    // Pixel art never draws at a fractional scale; the Seeker's 2.625 density rounds to the nearest whole scale.
    @Test fun `art scale is a whole number nearest the target`() {
        assertEquals(3, integerArtScale(63f, 24))
        assertEquals(2, integerArtScale(48f, 24))
        assertEquals(1, integerArtScale(10f, 64))
        assertEquals(1, integerArtScale(84f, 64))
        assertEquals(3, integerArtScale(168f, 64))
    }

    @Test fun `half sheets keep the kingdom touchable and modal sheets dim it`() {
        assertEquals(0f, sheetScrimAlpha(SheetSize.HALF), 0f)
        assertEquals(0.40f, sheetScrimAlpha(SheetSize.TALL), 0f)
        assertEquals(0.60f, sheetScrimAlpha(SheetSize.FULL), 0f)
    }

    @Test fun `every drawn glyph is a twelve by twelve grid of known cells`() {
        assertTrue(KIT_GLYPHS.containsKey("unknown"))
        KIT_GLYPHS.forEach { (name, rows) ->
            assertEquals(name, GLYPH_CELLS, rows.size)
            rows.forEach { row -> assertEquals(name, GLYPH_CELLS, row.length); assertTrue(name, row.all { it in ".#hx" }) }
        }
    }

    @Test fun `every currency has an icon and an item price uses its own art`() {
        Currency.entries.filter { it != Currency.ITEM }.forEach { assertFalse(currencyIcon(it).startsWith("shape:")) }
        assertEquals("ui:renown", currencyIcon(Currency.ITEM, "ui:renown"))
    }
}
