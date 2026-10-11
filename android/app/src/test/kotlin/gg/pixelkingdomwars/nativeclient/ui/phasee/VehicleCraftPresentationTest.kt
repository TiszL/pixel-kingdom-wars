package gg.pixelkingdomwars.nativeclient.ui.phasee

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class VehicleCraftPresentationTest {
    @Test fun `pending win does not advertise a usable minted NFT`() {
        assertEquals("WON · NFT MINT PENDING",vehicleCraftStatus("won_unminted"))
        assertEquals("NFT MINT CONFIRMED",vehicleCraftStatus("minted"))
        assertEquals("MATERIALS HELD",vehicleCraftStatus("held"))
        assertEquals("UNSUCCESSFUL · MATERIALS CONSUMED",vehicleCraftStatus("paid_loss"))
        assertThrows(Exception::class.java){vehicleCraftStatus("cancelled")}
    }
    @Test fun `historical attestation never claims the finalized issuance source`() {
        fun item(kind:String)=buildJsonObject{put("provenance",buildJsonObject{put("kind",kind)})}
        assertTrue(vehicleCandidateSource(item("owner_attested")).contains("does not prove"))
        assertTrue(vehicleCandidateSource(item("finalized_issuance")).contains("Current ownership is checked separately"))
        assertThrows(Exception::class.java){vehicleCandidateSource(item("trusted"))}
    }
}
