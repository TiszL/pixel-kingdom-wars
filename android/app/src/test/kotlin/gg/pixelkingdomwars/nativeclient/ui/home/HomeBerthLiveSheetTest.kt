package gg.pixelkingdomwars.nativeclient.ui.home

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/**
 * The Berth host body (S3, night 2026-10-06), read from source because it is a Compose host over live owners. Why it
 * matters: this body sits one tap from a wallet NFT burn. Its doors must reach the owners that already do the work (the
 * Solana Island craft page, the existing Vehicle controls, the saved starter outcome) and it must never grow its own
 * install or service money call.
 */
class HomeBerthLiveSheetTest {
    private val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeBerthLiveSheet.kt").readText()

    @Test fun `berth craft link opens Solana Island on the globe`() {
        // Rewritten for the owner's 2026-10-06 report ("craft vehicle goes to my base screen instead of showing Solana
        // Island"): the GO reads "Public Workshop, Solana Island", so it opens the globe there (WorldEntry.SolanaIsland,
        // whose sheet's CRAFT VEHICLE opens the craft page); a closed vehicle server still explains itself through the same
        // gate as every other vehicle door, rather than sending the player to an island where crafting cannot open.
        assertTrue(source.contains("BerthLiveDoor.SOLANA_WORKSHOP -> if (canRead()) homeVoyageVehicleControls(unavailable, " +
            "openSolanaIsland, explain)"))
        assertFalse(source.contains("VehicleEntryPoint.SOLANA_PUBLIC"))
        assertFalse(source.contains("Open Solana Island to craft a vehicle."))
        // Crafted install and service open the existing Vehicle controls at the Berth, behind the same gate.
        assertTrue(source.contains("openCraftedControls = { if (canRead()) homeVoyageVehicleControls(unavailable, " +
            "{ openVehicles(VehicleEntryPoint.BERTH, false) }, explain) }"))
    }

    @Test fun `berth body adds no install or service money call`() {
        for (call in listOf(".reserve(", ".approve(", ".upload(", ".deliver(", ".service(", ".dispatch(", ".collect(", ".command("))
            assertFalse("no $call from the Berth body", source.contains(call))
        for (seal in listOf("VoyageSealV2", "BerthInstallSealV2", "BerthServiceSealV2", "SensitiveMfaDialog", "vehicle?.voyage"))
            assertFalse("no $seal mounted from the Berth body", source.contains(seal))
        // The only owner reads are the wallet asset list (a GET) and the existing free starter review.
        assertTrue(source.contains("owners.vehicle?.assets?.invoke(cursor)"))
        assertTrue(source.contains("starterReview?.open()"))
    }

    @Test fun `berth history still prefers the saved starter outcome before receipts`() {
        val history = source.substringAfter("BerthLiveDoor.HISTORY ->").substringBefore("BerthLiveDoor.LODGE_SEND")
        assertTrue(history.trimStart().startsWith("if (starterReview?.openSavedOutcome(onLegacy) != true) {"))
        assertTrue(history.contains("if (owners.vehicle != null) onHistory() else explain(\"Vehicle receipts are unavailable for this session.\")"))
        // A missing vehicle owner explains itself; it never falls through to the legacy screen.
        assertFalse(source.contains("else onLegacy()"))
    }
}
