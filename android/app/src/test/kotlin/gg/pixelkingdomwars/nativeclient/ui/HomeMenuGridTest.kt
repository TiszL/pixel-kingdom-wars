package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.ArmyStatus
import gg.pixelkingdomwars.nativeclient.model.DailyCache
import gg.pixelkingdomwars.nativeclient.model.Energy
import gg.pixelkingdomwars.nativeclient.model.MailStatus
import gg.pixelkingdomwars.nativeclient.model.Quest
import gg.pixelkingdomwars.nativeclient.model.QuestBoard
import gg.pixelkingdomwars.nativeclient.ui.home.HOME_MENU_ACTIONABLE
import gg.pixelkingdomwars.nativeclient.ui.home.HOME_MENU_FOLDED
import gg.pixelkingdomwars.nativeclient.ui.home.homeArmyValue
import gg.pixelkingdomwars.nativeclient.ui.home.homeCacheValue
import gg.pixelkingdomwars.nativeclient.ui.home.homeEnergyValue
import gg.pixelkingdomwars.nativeclient.ui.home.homeMenuDestinations
import gg.pixelkingdomwars.nativeclient.ui.home.homeMenuLabel
import gg.pixelkingdomwars.nativeclient.ui.home.homeMenuValue
import gg.pixelkingdomwars.nativeclient.ui.home.hudBarPlan
import gg.pixelkingdomwars.nativeclient.ui.home.menuArt
import gg.pixelkingdomwars.nativeclient.ui.home.menuColumns
import gg.pixelkingdomwars.nativeclient.ui.home.menuLabel
import gg.pixelkingdomwars.nativeclient.ui.home.showBaseSwitch
import gg.pixelkingdomwars.nativeclient.ui.more.MoreDestination
import org.junit.Assert.*
import org.junit.Test

/** The player menu is a grid of value + label cells (web HudOverflowPanel), and the bar's SOL chip is a
 * width decision. These pin the pure halves so the owner's "SOL balance hidden" and "menu looks awful"
 * complaints cannot silently return. */
class HomeMenuGridTest {
    @Test fun `SOL joins the bar on a 412dp phone but a 360dp phone keeps it in the menu`() {
        // 360dp − 16dp gutters = 344: the floor only. 412dp − 16dp = 396: three chips beside MENU.
        assertFalse(hudBarPlan(344).sol)
        assertTrue(hudBarPlan(396).sol)
        assertTrue(hudBarPlan(380).sol)
        assertFalse(hudBarPlan(379).sol)
        // The shield readout stays a wide-bar promotion; the menu always carries RAID LOG.
        assertFalse(hudBarPlan(396).shield)
        assertTrue(hudBarPlan(560).shield)
    }
    @Test fun `the grid widens to three columns only once the panel is wide enough`() {
        assertEquals(2, menuColumns(344))
        assertEquals(2, menuColumns(480))
        assertEquals(2, menuColumns(559))
        assertEquals(3, menuColumns(560))
        assertEquals(3, menuColumns(640))
    }
    /** Owner 2026-09-17: "double YOUR BASES and YOUR LAND on the menu, leave one (YOUR LAND)" and one profile surface.
     * BASES and ACCOUNT are folded (SWITCH BASE row on the LAND page / profile ACCOUNT tab; the hub's ACCOUNT tab), never
     * lost: every other destination still has exactly one grid cell, and CHAT keeps its cell beside the dock button. */
    @Test fun `LAND is the single land entry and ACCOUNT is folded into the profile hub, everything else keeps one cell`() {
        val grid = homeMenuDestinations()
        assertEquals(MoreDestination.entries.toSet() - HOME_MENU_FOLDED, grid.toSet() + HOME_MENU_ACTIONABLE)
        assertEquals("no duplicates", grid.size, grid.toSet().size)
        assertEquals(setOf(MoreDestination.BASES, MoreDestination.ACCOUNT), HOME_MENU_FOLDED)
        assertTrue(MoreDestination.LAND in grid); assertTrue(MoreDestination.CHAT in grid)
        assertFalse(MoreDestination.BASES in grid); assertFalse(MoreDestination.ACCOUNT in grid)
        assertTrue(HOME_MENU_ACTIONABLE.none { it in grid })
        // The base chooser still earns its row only when there is a choice to make (web selectorEnabled + BASES · SELECT).
        assertTrue(showBaseSwitch(baseCount = 2, selectorAvailable = false, selectedBaseId = "a"))
        assertTrue(showBaseSwitch(baseCount = 1, selectorAvailable = true, selectedBaseId = null))
        assertFalse(showBaseSwitch(baseCount = 1, selectorAvailable = true, selectedBaseId = "a"))
        assertFalse(showBaseSwitch(baseCount = 1, selectorAvailable = false, selectedBaseId = null))
    }
    @Test fun `cell values stay terse and never claim an unloaded count is zero`() {
        val home = BaseState(quests = QuestBoard(quests = listOf(Quest(scope = "daily", completed = true), Quest(scope = "daily"), Quest(scope = "weekly", completed = true))))
        assertEquals("1/2", homeMenuValue(MoreDestination.QUESTS, home, null, null, 0, 0))
        assertNull(homeMenuValue(MoreDestination.QUESTS, BaseState(), null, null, 0, 0))
        assertEquals("12 UNREAD ◆3", homeMenuValue(MoreDestination.MAIL, home, MailStatus(20, 12, 3), null, 0, 0))
        assertEquals("0 UNREAD", homeMenuValue(MoreDestination.MAIL, home, MailStatus(0, 0, 0), null, 0, 0))
        assertEquals("…", homeMenuValue(MoreDestination.MAIL, home, null, null, 0, 0))
        assertEquals("4 UNREAD · @2", homeMenuValue(MoreDestination.CHAT, home, null, null, 4, 2))
        assertEquals("4 UNREAD", homeMenuValue(MoreDestination.CHAT, home, null, null, 4, 0))
        assertNull(homeMenuValue(MoreDestination.SETTINGS, home, null, null, 0, 0))
        // The spoken sentence keeps the full words the visible cell splits away.
        assertEquals("MAIL · 12 UNREAD · 3 REWARDS", homeMenuLabel(MoreDestination.MAIL, home, MailStatus(20, 12, 3), null, 0, 0))
    }
    @Test fun `a claimable cache says CLAIM and a settled one shows its lit day`() {
        assertEquals("…", homeCacheValue(null))
        assertEquals("CLAIM!", homeCacheValue(DailyCache(claimable = true, currentDay = 3)))
        assertEquals("D3", homeCacheValue(DailyCache(claimable = false, currentDay = 3)))
        assertEquals("D0", homeCacheValue(DailyCache()))
    }
    @Test fun `army and energy readouts come from server state or read as unknown`() {
        assertEquals("…", homeArmyValue(null))
        assertEquals("10 READY · 2 TRAINING", homeArmyValue(ArmyStatus(readyTroopCount = 10, trainingTroopCount = 2)))
        assertEquals("…", homeEnergyValue(null))
        assertEquals("4/6", homeEnergyValue(Energy(used = 2, free = 4, max = 6)))
        assertEquals("—/6", homeEnergyValue(Energy(used = 2, free = null, max = 6)))
    }
    @Test fun `menu labels keep the web wording and every destination has art`() {
        // Web menu.tsx: the `exchange` route's screen is titled KEEP WALLET; the troop research building is the Alchemy Lab (id forge).
        assertEquals("KEEP WALLET", menuLabel(MoreDestination.ECONOMY))
        assertEquals("ALCHEMY LAB", menuLabel(MoreDestination.RESEARCH))
        assertEquals("FOUNDING KINGDOMS", menuLabel(MoreDestination.TESTER))
        assertEquals("ABOUT / SUPPORT", menuLabel(MoreDestination.ABOUT))
        assertEquals("YOUR LAND", menuLabel(MoreDestination.LAND))
        MoreDestination.entries.forEach { assertTrue(it.name, menuArt(it).isNotBlank()) }
    }
}

class HudFitValueTest {
    @org.junit.Test fun `picks the largest size that fits and never wraps`() {
        // 18sp fits a short value; a seven-digit KEEP balance on a narrow chip steps down; nothing fits → smallest, still one line.
        org.junit.Assert.assertEquals(18, gg.pixelkingdomwars.nativeclient.ui.home.fitValueSize(gg.pixelkingdomwars.nativeclient.ui.home.HUD_VALUE_SIZES) { true })
        org.junit.Assert.assertEquals(14, gg.pixelkingdomwars.nativeclient.ui.home.fitValueSize(gg.pixelkingdomwars.nativeclient.ui.home.HUD_VALUE_SIZES) { it <= 14 })
        org.junit.Assert.assertEquals(12, gg.pixelkingdomwars.nativeclient.ui.home.fitValueSize(gg.pixelkingdomwars.nativeclient.ui.home.HUD_VALUE_SIZES) { false })
    }
}
