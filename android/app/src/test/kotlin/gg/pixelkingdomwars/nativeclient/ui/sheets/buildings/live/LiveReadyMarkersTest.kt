package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseJob
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.MineStatus
import gg.pixelkingdomwars.nativeclient.model.Mining
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.renderer.BaseCameraView
import gg.pixelkingdomwars.nativeclient.renderer.BaseScene
import gg.pixelkingdomwars.nativeclient.renderer.RenderBuilding
import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.sheetBuildingPortrait
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildingMarkerUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.MarkerKind
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
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

    // Owner report 2026-10-11 (Seeker, code 34): beige cards with a torn-sail icon were taken for Phase E boats. They were the
    // spent-trap notices wearing `ui:exhausted-status`. The bubble must say what the tap is for and look like the trap.
    @Test fun `a spent trap's bubble reads as a trap to rearm and no other marker carries that caption`() {
        val markers = liveReadyMarkers(state())
        val notice = markers.single { it.kind == MarkerKind.NOTICE }
        assertEquals("REARM", notice.caption)
        assertNull("the Mine's READY bubble has no caption", markers.single { it.kind == MarkerKind.READY }.caption)
        assertEquals("before the catalogue arrives: the REARM command's own fallback glyph", "shape:hammer", notice.icon)
        val catalogue = buildJsonObject { putJsonObject("constants") { putJsonObject("ART_V2") { put("tiers", "4"); put("levelsPerTier", "5") } } }
        val drawn = liveReadyMarkers(state().copy(catalogue = catalogue)).single { it.kind == MarkerKind.NOTICE }
        assertEquals("the REARM command's own icon: the trap's tier art", sheetBuildingPortrait(catalogue, "powdermine", 1), drawn.icon)
        assertNotEquals("never the voyage's torn sail", "ui:exhausted-status", drawn.icon)

        // The caption survives to the drawn bubble; a notice that is not a spent trap carries none.
        val scene = BaseScene(listOf(RenderBuilding("trap-1", "trap", 4f, 4f, 1f, 1f, type = "powdermine")), 16, 16, 64f, baseId = "b1")
        val ui = readyMarkersUi(listOf(drawn), scene, emptyMap(), BaseCameraView("b1", 320f, 320f, 1f, 640, 640), hidden = false)
        assertEquals(listOf("REARM"), ui.markers.map { it.caption })
        assertNull(BuildingMarkerUi("market-1", PxRect(0f, 0f, 1f, 1f), MarkerKind.NOTICE, "ui:market-menu", null, null, "Market: 1 sale to collect").caption)
    }

    @Test fun `no marker is ever drawn over a base that is not the player's selected Home`() {
        assertTrue("another base is selected", liveReadyMarkers(state(selectedBaseId = "b2")).isEmpty())
        assertTrue("the signed-in wallet does not own it", liveReadyMarkers(state(owner = "Someone222")).isEmpty())
        assertTrue(liveReadyMarkers(KingdomUiState()).isEmpty())
        assertEquals("the same base id in other letter case is the same base", 2, liveReadyMarkers(state(selectedBaseId = "B1")).size)
    }
}
