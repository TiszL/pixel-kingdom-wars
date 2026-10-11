package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import gg.pixelkingdomwars.nativeclient.ui.home.homeLodgeUnavailablePermit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The paid SEND Seal the Lodge raises while no Home owner sells realm permits (send-paid.png UNAVAILABLE, SPEC E1.2). Why it
 * matters: this is a money Seal. While nothing was quoted it must not claim a check is running, invent a permit length or
 * show a realm cut, and BUY & SEND must stay off, so the player is never led to think SOL is about to move.
 */
class VoyagePermitHonestTest {
    private val emberwake = RouteUi("emberwake-2", "emberwake", 1, "Emberwake 2", "cinderfall", "Cinderfall", "ember_nodules", 2,
        Access.PAID_REALM, null)

    @Test fun `an unavailable permit seal claims no duration check and shows no realm cut`() {
        val permit = homeLodgeUnavailablePermit(emberwake, VehicleFamily.CARGO_CUTTER, 5_000L)
        assertNull("no length was quoted", permit.days)
        assertTrue("no split was quoted", permit.splitLine.isBlank())
        val seal = permitSealV2(permit)
        assertEquals("PERMIT FOR CINDERFALL", seal.title)
        assertEquals("the island side names the permit, never an invented length", "PERMIT", seal.gets?.text)
        assertEquals("Cinderfall", seal.gets?.caption)
        assertTrue("no line says a duration is being checked when nothing checks it", seal.lines.isEmpty())
        assertNull("no realm cut box without a server split", seal.cut)
        assertEquals(SealV2Primary.UNAVAILABLE, sealV2Primary(seal))
        assertFalse("an unavailable price is never armed", seal.quoteReady)
        assertNull("BUY & SEND carries no amount it does not have", seal.confirmSub)
        assertEquals("Permit purchases are not available from the Lodge yet. Your vehicle stays at the Berth.", seal.unavailable?.line)
        assertEquals("No payment or departure has been requested.", seal.note)
        assertEquals("Cutter", permit.vehicleName)
        assertEquals(5_000L, seal.armedAtMs)
    }
}
