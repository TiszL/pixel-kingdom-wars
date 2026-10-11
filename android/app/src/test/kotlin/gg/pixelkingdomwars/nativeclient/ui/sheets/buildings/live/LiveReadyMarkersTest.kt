package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseJob
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.MineStatus
import gg.pixelkingdomwars.nativeclient.model.Mining
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.MarkerKind
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Home world's ready bubbles (DESIGN-SYSTEM §6 WorldBubble; buildings/SPEC §1.2 "Ready bubbles collect in 1 tap
 * without selecting"). Why it matters: a READY bubble collects on one tap, so it may only appear when the server's Mine
 * buffer says Shards are waiting, never on an unread or empty buffer; a spent trap must point the player at REARM; and no
 * bubble may ever be drawn over a base that is not the player's own selected Home, where a tap would act on the wrong deed.
 */
class LiveReadyMarkersTest {
    private val wallet = "Wallet111"
    private val mine = Building("mine-1", "mine", 2, 10, 10)
    private val trap = Building("trap-1", "powdermine", 1, 4, 4, trapSpentAt = "2026-10-05T10:00:00Z")
    private val armedTrap = Building("trap-2", "powdermine", 1, 6, 4)

    private fun state(
        buildings: List<Building> = listOf(mine, trap, armedTrap),
        accrued: String? = "8400",
        mineRead: Boolean = true,
        jobs: List<BaseJob> = emptyList(),
        selectedBaseId: String? = "b1",
        owner: String? = wallet,
        signedIn: String? = wallet,
    ) = KingdomUiState(
        home = BaseState(
            base = BaseSnapshot("b1", null, PlayerSummary(wallet = owner, keepLevel = 4, builders = 2), null, null, null,
                buildings, emptyList(), jobs, 1, buildJsonObject {}),
            mine = if (mineRead) MineStatus(mining = accrued?.let { Mining(accrued = it) }) else null,
        ),
        wallet = signedIn, selectedBaseId = selectedBaseId,
    )

    @Test fun `the Mine bubble appears only while the server says Shards are waiting`() {
        val ready = liveReadyMarkers(state()).single { it.kind == MarkerKind.READY }
        assertEquals("mine-1", ready.buildingId)
        assertEquals("shards", ready.icon)
        assertEquals("+8,400", ready.text)
        assertTrue(ready.description.contains("8,400 Shards"))
        assertTrue("empty buffer", liveReadyMarkers(state(accrued = "0")).none { it.kind == MarkerKind.READY })
        assertTrue("mine/status not read", liveReadyMarkers(state(mineRead = false)).none { it.kind == MarkerKind.READY })
        assertTrue("mining block absent", liveReadyMarkers(state(accrued = null)).none { it.kind == MarkerKind.READY })
        assertTrue("no Mine to anchor on", liveReadyMarkers(state(buildings = listOf(trap))).none { it.kind == MarkerKind.READY })
    }

    @Test fun `a Mine with a running job carries its timer, not a second marker`() {
        val upgrading = BaseJob("job-1", "upgrade", buildingId = "mine-1")
        assertTrue(liveReadyMarkers(state(jobs = listOf(upgrading))).none { it.buildingId == "mine-1" })
    }

    @Test fun `a spent trap asks to be rearmed and an armed one says nothing`() {
        val notices = liveReadyMarkers(state()).filter { it.kind == MarkerKind.NOTICE }
        assertEquals(listOf("trap-1"), notices.map { it.buildingId })
        assertNull("a notice opens the trap; it carries no amount", notices.single().text)
        assertEquals("Powder Mine: spent, rearm it", notices.single().description)
        val repairing = BaseJob("job-2", "repair", buildingId = "trap-1")
        assertTrue("a rearm already running shows its timer", liveReadyMarkers(state(jobs = listOf(repairing))).none { it.kind == MarkerKind.NOTICE })
    }

    @Test fun `no marker is ever drawn over a base that is not the player's selected Home`() {
        assertTrue("another base is selected", liveReadyMarkers(state(selectedBaseId = "b2")).isEmpty())
        assertTrue("the signed-in wallet does not own it", liveReadyMarkers(state(owner = "Someone222")).isEmpty())
        assertTrue(liveReadyMarkers(KingdomUiState()).isEmpty())
        assertEquals("the same base id in other letter case is the same base", 2, liveReadyMarkers(state(selectedBaseId = "B1")).size)
    }
}
