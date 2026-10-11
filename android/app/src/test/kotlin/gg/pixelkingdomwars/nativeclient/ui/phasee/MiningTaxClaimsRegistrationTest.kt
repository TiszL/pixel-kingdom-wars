package gg.pixelkingdomwars.nativeclient.ui.phasee

import org.junit.Assert.*
import org.junit.Test

class MiningTaxClaimsRegistrationTest {
    @Test fun `flag off empty storage hides entry without opening a journal`() {
        var probes = 0; assertFalse(miningTaxClaimsEntryDiscovered(false) { probes++; false }); assertEquals(1, probes)
    }
    @Test fun `present corrupt or inaccessible storage exposes recovery without claiming payment`() {
        assertTrue(miningTaxClaimsEntryDiscovered(false) { true })
        assertTrue(miningTaxClaimsEntryDiscovered(false) { error("Metadata unavailable") })
    }
    @Test fun `explicit capability exposes entry without requiring storage discovery`() {
        assertTrue(miningTaxClaimsEntryDiscovered(true) { error("Must not inspect storage") })
    }
}
