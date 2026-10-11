package gg.pixelkingdomwars.nativeclient.network

import org.junit.Assert.*
import org.junit.Test

/** D-070: one duration vocabulary everywhere (`packages/shared/src/duration.ts`); fmtN is the web's thousands grouping. */
class FormattingTest {
    @Test fun `fmtDur shows the two most significant units and seconds only under an hour`() {
        assertEquals("6d 2h", fmtDur(6 * 86_400L + 2 * 3_600 + 36 * 60)); assertEquals("6d", fmtDur(6 * 86_400L + 59))
        assertEquals("2h 36m", fmtDur(2 * 3_600L + 36 * 60 + 5)); assertEquals("2h", fmtDur(2 * 3_600L))
        assertEquals("36m 5s", fmtDur(36 * 60L + 5)); assertEquals("36m", fmtDur(36 * 60L)); assertEquals("45s", fmtDur(45)); assertEquals("0s", fmtDur(-3))
    }
    @Test fun `fmtClock is hh mm ss under a day and words above it`() {
        assertEquals("00:00:09", fmtClock(9)); assertEquals("23:59:59", fmtClock(86_399)); assertEquals("1d", fmtClock(86_400)); assertEquals("00:00:00", fmtClock(-1))
    }
    @Test fun `fmtN groups thousands on exact decimal strings and never rounds a balance`() {
        assertEquals("9,007,199,254,740,993", fmtN("9007199254740993")); assertEquals("150", fmtN("150")); assertEquals("0", fmtN("0")); assertEquals("0", fmtN("000"))
        assertEquals("-1,500", fmtN("-1500")); assertEquals("3", fmtN("3.9")); assertEquals("0", fmtN("abc")); assertEquals("1,000", fmtN(1000L))
    }
}
