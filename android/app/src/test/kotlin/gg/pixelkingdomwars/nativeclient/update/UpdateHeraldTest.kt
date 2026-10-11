package gg.pixelkingdomwars.nativeclient.update

import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.GateKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Owner 2026-10-06: "I should not see any even 1 of old screens". The optional update on Home and Title was the old dark
 * notice + text button + AlertDialog; it is now the designed herald line and the designed optional gate (hub SPEC §3.1,
 * §3.7). WHY these pins matter: the gate must stay dismissible (an optional offer never takes the game from a player who
 * may keep playing), must never invent release notes, and must show busy dots instead of a dead UPDATE while the file
 * moves on its own.
 */
class UpdateHeraldTest {
    private val bytes = "the signed apk".toByteArray()

    @Test fun `an optional offer opens the dismissible gate with the dialog's own sentence and the size line`() {
        val offer = offer(bytes)
        val ui = bannerUpdateGateUi(UpdateState.Offered(offer, false, offer.sizeBytes))
        assertNotNull(ui); ui!!
        assertEquals(GateKind.UPDATE_OPTIONAL, ui.kind)
        assertEquals("A NEW VERSION IS READY", ui.title)
        assertTrue("the body is the dialog's own words", ui.body.startsWith(megabytes(offer.sizeBytes)))
        assertTrue("no invented WHAT'S NEW", ui.notes.isEmpty())
        assertEquals(gateSizeLine(UpdateState.Offered(offer, false, offer.sizeBytes), offer), ui.sizeLine)
        assertFalse(ui.updating)
    }

    @Test fun `while the file downloads UPDATE shows busy dots and the herald reads the progress`() {
        val offer = offer(bytes)
        val downloading = UpdateState.Downloading(offer, 7, offer.sizeBytes)
        assertTrue(bannerUpdateGateUi(downloading)!!.updating)
        assertEquals(updateStateMessage(downloading, offer), updateHeraldLine(downloading, offer))
    }

    @Test fun `the herald names the version and size, and a required offer says required`() {
        val optional = offer(bytes)
        assertEquals("Update ${optional.versionName} available · ${megabytes(optional.sizeBytes)}",
            updateHeraldLine(UpdateState.Offered(optional, false, optional.sizeBytes), optional))
        val required = offer(bytes, mandatory = true)
        assertEquals("Update ${required.versionName} required · ${megabytes(required.sizeBytes)}",
            updateHeraldLine(UpdateState.Offered(required, true, required.sizeBytes), required))
        assertEquals("UPDATE TO KEEP PLAYING", bannerUpdateGateUi(UpdateState.Offered(required, true, required.sizeBytes))!!.title)
    }

    @Test fun `LATER declines an offer not yet started and only closes once the update is moving`() {
        val offer = offer(bytes)
        // The gate's LATER is the dialog's second button: NOT NOW (decline) before anything moved, LATER (close) after.
        assertEquals(UpdateAction.NOT_NOW, updateDialogActions(UpdateState.Offered(offer, false, offer.sizeBytes), false).getOrNull(1))
        assertEquals(UpdateAction.LATER, updateDialogActions(UpdateState.Downloading(offer, 7, offer.sizeBytes), false).getOrNull(1))
    }

    @Test fun `no offer draws no gate`() {
        assertNull(bannerUpdateGateUi(UpdateState.Idle))
    }
}
