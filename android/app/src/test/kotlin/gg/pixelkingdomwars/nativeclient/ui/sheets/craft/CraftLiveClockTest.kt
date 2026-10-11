package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import gg.pixelkingdomwars.nativeclient.ui.economy.paymentRecordVerb
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The craft bench's living clock (c-gap-craft): it must tick, but it may never run ahead of the server, because a
 *  countdown that reached zero early would tell the player a batch is done before the server delivered it. */
class CraftLiveClockTest {
    @Test fun `the bench clock advances from the server snapshot by the monotonic time since it was drawn`() {
        // Snapshot 12:00:00.000 drawn at monotonic 5000; 90 s later the bench reads 12:01:30, so 3:48 left becomes 2:18.
        val snapshot = 1_700_000_000_000L
        assertEquals(snapshot + 90_000L, snapshotServerNow(snapshot, 5_000L, 95_000L))
        assertEquals("2:18", countdownText(secondsLeft(snapshot + 228_000L, snapshotServerNow(snapshot, 5_000L, 95_000L)!!)))
    }

    @Test fun `a clock without a server snapshot stays unknown instead of guessing from the device clock`() {
        assertNull(snapshotServerNow(null, 5_000L, 95_000L))
    }

    @Test fun `a monotonic step backwards never moves the bench before its own snapshot`() {
        // Running behind is safe (the countdown reads longer); running ahead could claim a batch is due early.
        assertEquals(1_000L, snapshotServerNow(1_000L, 9_000L, 8_000L))
    }

    @Test fun `a due job is read again after it is due and then backs off`() {
        // Not before it is due: a job with 30 s left waits those 30 s plus the first 1.5 s grace.
        assertEquals(31_500L, dueRefreshDelayMs(30_000L, 0))
        // While the server still reports it running, each further read waits twice as long, capped at 12 s.
        assertEquals(1_500L, dueRefreshDelayMs(-5_000L, 0))
        assertEquals(3_000L, dueRefreshDelayMs(0L, 1))
        assertEquals(6_000L, dueRefreshDelayMs(0L, 2))
        assertEquals(12_000L, dueRefreshDelayMs(0L, 3))
        assertEquals(12_000L, dueRefreshDelayMs(0L, 9))
        assertEquals(4, DUE_REFRESH_ATTEMPTS)
    }

    @Test fun `receipt pills keep the design colour grammar on the records page`() {
        // Gold is the player's open job, blue information, green finished, red trouble: a declined request must never
        // look finished, and an accepted one must never look like it still needs the player.
        assertEquals(Verb.GOLD, paymentRecordVerb(PaymentTone.OPEN))
        assertEquals(Verb.BLUE, paymentRecordVerb(PaymentTone.SENT))
        assertEquals(Verb.GREEN, paymentRecordVerb(PaymentTone.DONE))
        assertEquals(Verb.RED, paymentRecordVerb(PaymentTone.TROUBLE))
        assertEquals(Verb.STONE, paymentRecordVerb(PaymentTone.CLOSED))
    }
}
