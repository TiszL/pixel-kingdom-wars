package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import gg.pixelkingdomwars.nativeclient.ui.home.HomeTab
import org.junit.Assert.*
import org.junit.Test

class ArmyHomeMountTest {
    @Test fun `Army group requests retain Kingdom and their exact initial surface`() {
        val entries = listOf(HomeRequest.Army to "army", HomeRequest.Training to "army",
            HomeRequest.RaidChooser to "raid", HomeRequest.Campaign to "campaign")
        entries.forEach { (request, surface) ->
            assertEquals(HomeTab.KINGDOM, request.homeTab)
            assertEquals(surface, armyHomeRequest(request)?.sheet)
        }
    }

    @Test fun `training is consumed only by the mounted Army composer`() {
        val requests = HomeRequests()
        requests.request(HomeRequest.Training)
        requests.request(HomeRequest.RaidChooser)
        val training = requireNotNull(armyHomeRequest(requests.pending.value))
        assertFalse(training.consumeAtMount)
        assertEquals(HomeRequest.Training, requests.pending.value)
        requests.consume(HomeRequest.Training)
        assertEquals("raid", armyHomeRequest(requests.pending.value)?.sheet)
        assertTrue(requireNotNull(armyHomeRequest(requests.pending.value)).consumeAtMount)
    }

    @Test fun `raid campaign and army handoffs do not drop a later queued door`() {
        val requests = HomeRequests()
        listOf(HomeRequest.Army, HomeRequest.Campaign, HomeRequest.RaidChooser, HomeRequest.BuildMenu)
            .forEach(requests::request)
        listOf("army", "campaign", "raid").forEach { expected ->
            val request = requireNotNull(requests.pending.value)
            assertEquals(expected, armyHomeRequest(request)?.sheet)
            assertTrue(requireNotNull(armyHomeRequest(request)).consumeAtMount)
            requests.consume(request)
        }
        assertEquals(HomeRequest.BuildMenu, requests.pending.value)
        assertNull(armyHomeRequest(requests.pending.value))
    }

    @Test fun `unrelated Home and World doors remain with their existing owners`() {
        assertNull(armyHomeRequest(null))
        assertNull(armyHomeRequest(HomeRequest.BuildMenu))
        assertNull(armyHomeRequest(HomeRequest.FocusBuilding("barracks-1")))
        assertNull(armyHomeRequest(HomeRequest.Tab(HomeTab.WORLD)))
    }
    @Test fun `Army overlay preserves the exact current resource rows and hides ordinary HUD zones`() {
        for (balance in listOf(null, "0", "1431")) {
            val original = gg.pixelkingdomwars.nativeclient.ui.home.homeHudState(
                gg.pixelkingdomwars.nativeclient.data.BaseState(balances = balance?.let {
                    gg.pixelkingdomwars.nativeclient.model.Balances(shards = it, keep = "200") }),
                null, 0, true, 3, 0, selectionOpen = false, toolsOpen = true)
            val sheet = armyHomeHud(original, true)
            assertSame(original.resources, sheet.resources)
            assertFalse(sheet.deckVisible)
            assertFalse(sheet.toolsOpen)
            assertNull(sheet.herald)
            assertNull(sheet.context)
            assertSame(original, armyHomeHud(original, false))
        }
    }
}
