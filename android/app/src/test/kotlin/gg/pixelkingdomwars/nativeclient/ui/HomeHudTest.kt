package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.BalanceFeatures
import gg.pixelkingdomwars.nativeclient.model.GemsFeature
import gg.pixelkingdomwars.nativeclient.ui.home.homeGameCurrency
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.MineStatus
import gg.pixelkingdomwars.nativeclient.model.Mining
import gg.pixelkingdomwars.nativeclient.ui.home.hudMineFraction
import gg.pixelkingdomwars.nativeclient.ui.home.hudShield
import gg.pixelkingdomwars.nativeclient.ui.home.hudSol
import gg.pixelkingdomwars.nativeclient.ui.home.hudAttention
import gg.pixelkingdomwars.nativeclient.ui.home.homeMenuLabel
import gg.pixelkingdomwars.nativeclient.ui.more.MoreDestination
import gg.pixelkingdomwars.nativeclient.model.MailStatus
import gg.pixelkingdomwars.nativeclient.model.DailyCache
import gg.pixelkingdomwars.nativeclient.model.Quest
import gg.pixelkingdomwars.nativeclient.model.QuestBoard
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class HomeHudTest {
    @Test fun `Gems HUD requires supported capability and distinguishes missing balance from zero`() {
        val old = Balances(keep = "12", shards = "2")
        assertEquals("KEEP", homeGameCurrency(old).label); assertEquals("12", homeGameCurrency(old).value)
        val gems = old.copy(features = BalanceFeatures(GemsFeature(1, 1)))
        assertEquals("GEMS", homeGameCurrency(gems).label); assertEquals("…", homeGameCurrency(gems).value)
        assertEquals("0", homeGameCurrency(gems.copy(gems = "0")).value)
        assertEquals("KEEP", homeGameCurrency(gems.copy(features = BalanceFeatures(GemsFeature(1, 2)))).label)
    }
    @Test fun `unknown wallet balance must never look like zero SOL`() {
        assertEquals("…", hudSol(null))
        assertEquals("…", hudSol("invalid"))
        assertEquals("0.000", hudSol("0"))
        assertEquals("1.235", hudSol("1.23456"))
        assertEquals("100.1", hudSol("100.05"))
    }
    @Test fun `mine storage appears only with an authoritative positive capacity`() {
        assertNull(hudMineFraction(BaseState()))
        assertNull(hudMineFraction(BaseState(mine = MineStatus(mining = Mining(accrued = "50", storageCap = "0")))))
        assertEquals(0.5f, hudMineFraction(BaseState(mine = MineStatus(mining = Mining(accrued = "50", storageCap = "100")))))
        assertEquals(1f, hudMineFraction(BaseState(mine = MineStatus(mining = Mining(accrued = "101", storageCap = "100")))))
    }
    @Test fun `warzone suppression stays visible and server milliseconds outrank rounded hours`() {
        assertEquals("…", hudShield(BaseState()))
        assertEquals("…", hudShield(base("")))
        assertEquals("—", hudShield(base(",\"shield\":null")))
        assertEquals("SUPP · 1M 1S", hudShield(base(",\"shield\":{\"remainingMs\":60001,\"hoursLeft\":1,\"suppressedByWarzone\":true}")))
        assertEquals("2H", hudShield(base(",\"shield\":{\"hoursLeft\":2}")))
    }
    @Test fun `collapsed menu preserves pending reward chat raid cache and quest attention`() {
        val home = BaseState(mine = MineStatus(cache = DailyCache(claimable = true)),
            quests = QuestBoard(quests = listOf(Quest(completed = true), Quest(completed = true, claimed = true), Quest())))
        assertEquals(12, hudAttention(home, MailStatus(10, 2, 3), raids = 1, chat = 4))
        assertEquals("MAIL · 2 UNREAD · 3 REWARDS", homeMenuLabel(MoreDestination.MAIL, home, MailStatus(10, 2, 3), null, 4, 2))
        assertEquals("CHAT · 4 UNREAD · 2 MENTIONS", homeMenuLabel(MoreDestination.CHAT, home, null, null, 4, 2))
    }
    @Test fun `unloaded mail counts do not claim a settled empty inbox`() {
        assertEquals("MAIL · … UNREAD · … REWARDS", homeMenuLabel(MoreDestination.MAIL, BaseState(), null, null, 0, 0))
    }
    private fun base(extra: String) = BaseState(base = BaseSnapshot.from(Json.parseToJsonElement("{\"player\":{\"keepLevel\":1}$extra}").jsonObject))
}
