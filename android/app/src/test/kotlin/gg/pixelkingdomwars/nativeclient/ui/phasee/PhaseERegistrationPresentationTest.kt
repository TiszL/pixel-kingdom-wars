package gg.pixelkingdomwars.nativeclient.ui.phasee

import org.junit.Assert.*
import org.junit.Test

class PhaseERegistrationPresentationTest {
    private val actor = PhaseERegistrationActor("wallet-a", "https://realm.example")

    @Test fun `restored history selects only the receipt body`() {
        val restored = phaseERegistrationPresentation(actor, actor, true, true)
        assertEquals(PhaseERegistrationBody.RECEIPTS, restored.body)
        assertTrue(restored.show)
        assertTrue(restored.historyOnly)
    }

    @Test fun `wallet mismatch closes restored history and forgets its entry`() {
        val restored = phaseERegistrationPresentation(actor, actor.copy(wallet = "wallet-b"),
            true, true, VehicleEntryPoint.LODGE)
        assertEquals(PhaseERegistrationPresentation(), restored)
        assertEquals(PhaseERegistrationBody.CLOSED, restored.body)
    }

    @Test fun `origin mismatch closes even for the same wallet`() {
        val restored = phaseERegistrationPresentation(actor, actor.copy(origin = "https://other.example"),
            true, false, VehicleEntryPoint.SOLANA_PUBLIC)
        assertEquals(PhaseERegistrationPresentation(), restored)
    }

    @Test fun `missing actor stamp cannot restore an old open flag`() {
        assertEquals(PhaseERegistrationBody.CLOSED,
            phaseERegistrationPresentation(PhaseERegistrationActor("", ""), actor, true, true).body)
    }

    @Test fun `blank current actor is not an identity even when stamps match`() {
        val missing = PhaseERegistrationActor("", "")
        assertEquals(PhaseERegistrationBody.CLOSED,
            phaseERegistrationPresentation(missing, missing, true, true).body)
    }

    @Test fun `a closed saved sheet cannot retain an active mode or entry`() {
        assertEquals(PhaseERegistrationPresentation(),
            phaseERegistrationPresentation(actor, actor, false, true, VehicleEntryPoint.LODGE))
    }

    @Test fun `ordinary opening clears receipt mode and explicit entry`() {
        val history = PhaseERegistrationPresentation(true, true, VehicleEntryPoint.SOLANA_PUBLIC)
        val opened = history.openLive()
        assertEquals(PhaseERegistrationBody.LIVE, opened.body)
        assertFalse(opened.historyOnly)
        assertNull(opened.entryPoint)
        assertEquals("fleet", opened.initialPage)
    }

    @Test fun `close clears receipt mode and explicit entry`() {
        assertEquals(PhaseERegistrationPresentation(),
            PhaseERegistrationPresentation(true, true, VehicleEntryPoint.LODGE).close())
        assertEquals(PhaseERegistrationPresentation(),
            PhaseERegistrationPresentation(true, false, VehicleEntryPoint.SOLANA_PUBLIC).close())
    }

    @Test fun `ordinary receipt opening clears a previous explicit entry`() {
        val opened = PhaseERegistrationPresentation(true, false, VehicleEntryPoint.LODGE).openHistory()
        assertEquals(PhaseERegistrationBody.RECEIPTS, opened.body)
        assertNull(opened.entryPoint)
    }

    @Test fun `explicit receipt entry survives same actor restoration without a live body`() {
        val opened = PhaseERegistrationPresentation().openHistory(VehicleEntryPoint.LODGE)
        val restored = phaseERegistrationPresentation(actor, actor, opened.show, opened.historyOnly, opened.entryPoint)
        assertEquals(PhaseERegistrationBody.RECEIPTS, restored.body)
        assertEquals(VehicleEntryPoint.LODGE, restored.entryPoint)
    }

    @Test fun `each explicit live entry maps to its existing page`() {
        for ((entry, page) in listOf(VehicleEntryPoint.BERTH to "fleet",
            VehicleEntryPoint.LODGE to "fleet", VehicleEntryPoint.SOLANA_PUBLIC to "craft")) {
            val opened = PhaseERegistrationPresentation(true, true).openEntry(entry)
            assertEquals(PhaseERegistrationBody.LIVE, opened.body)
            assertEquals(entry, opened.entryPoint)
            assertEquals(page, opened.initialPage)
        }
    }

    @Test fun `same actor restores the explicit craft page`() {
        val restored = phaseERegistrationPresentation(actor, actor, true, false, VehicleEntryPoint.SOLANA_PUBLIC)
        assertEquals("craft", restored.initialPage)
        assertEquals(PhaseERegistrationBody.LIVE, restored.body)
    }

    @Test fun `public string seam accepts only exact known entry names`() {
        assertEquals(VehicleEntryPoint.BERTH, phaseEVehicleEntry("BERTH"))
        assertEquals(VehicleEntryPoint.LODGE, phaseEVehicleEntry("LODGE"))
        assertEquals(VehicleEntryPoint.SOLANA_PUBLIC, phaseEVehicleEntry("SOLANA_PUBLIC"))
        listOf("", "fleet", "berth.vehicles", "lodge", "UNKNOWN").forEach { assertNull(phaseEVehicleEntry(it)) }
    }
}
