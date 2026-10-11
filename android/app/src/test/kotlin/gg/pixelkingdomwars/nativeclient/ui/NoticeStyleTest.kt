package gg.pixelkingdomwars.nativeclient.ui

import org.junit.Assert.*
import org.junit.Test

/** Owner 2026-09-17: no more bare black boxes. A gate (WARN) is gold on ink so it never reads as a failure;
 * a real failure (ERROR) is a blood-ruled stone plate; a confirmation (INFO) is the quiet stone plate.
 * Every kind's text must contrast its own fill, and only WARN may borrow the ink background. */
class NoticeStyleTest {
    @Test fun `each kind maps to its own rule colour and only WARN sits on ink`() {
        assertEquals(NoticeStyle(Palette.stone, Palette.borderLt, Palette.text), noticeStyle(NoticeKind.INFO))
        assertEquals(NoticeStyle(Palette.ink, Palette.gold, Palette.gold), noticeStyle(NoticeKind.WARN))
        assertEquals(NoticeStyle(Palette.stone, Palette.blood, Palette.text), noticeStyle(NoticeKind.ERROR))
        assertEquals("Three kinds, three distinct rules", 3, NoticeKind.entries.map { noticeStyle(it).rule }.toSet().size)
        NoticeKind.entries.forEach { kind -> val s = noticeStyle(kind); assertNotEquals("$kind text must contrast its fill", s.fill, s.text) }
        assertNotEquals("ERROR is not a blood-filled box any more", Palette.blood, noticeStyle(NoticeKind.ERROR).fill)
    }
    @Test fun `the boolean overload keeps error meaning ERROR and everything else INFO`() {
        assertEquals(noticeStyle(NoticeKind.ERROR), noticeStyle(if (true) NoticeKind.ERROR else NoticeKind.INFO))
        assertEquals(noticeStyle(NoticeKind.INFO), noticeStyle(if (false) NoticeKind.ERROR else NoticeKind.INFO))
    }
}
