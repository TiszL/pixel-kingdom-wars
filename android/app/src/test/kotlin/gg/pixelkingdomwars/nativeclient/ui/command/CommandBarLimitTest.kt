package gg.pixelkingdomwars.nativeclient.ui.command

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Design correction 7 / design ruling 5ed31eb8 item 1: a portrait phone shows at most four commands (INFO, up to two
 * secondaries, the primary) so the bar never crowds a thumb or drops one silently; landscape has room for five.
 */
class CommandBarLimitTest {
    @Test fun `portrait bars hold four commands and landscape bars five`() {
        assertEquals(4, commandBarLimit(412f * 2.625f, 915f * 2.625f))
        assertEquals(4, commandBarLimit(360f, 360f))
        assertEquals(5, commandBarLimit(915f, 412f))
    }
}
