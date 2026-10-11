package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CacheState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CacheDay
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.dailyCacheDays
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class LiveDailyCacheTest {
    private val catalogue = Json.parseToJsonElement("""{"constants":{"DAILY_CACHE":{"consistencyStreakDays":9},
        "MINING":{"CONSISTENCY_BPS":15000,"BPS_ONE":10000}}}""").jsonObject
    private val now = Instant.parse("2030-01-01T12:00:00Z").toEpochMilli()
    private fun mine(claimable: Boolean = true, day: Int = 4, next: String? = "2030-01-01T12:30:00Z", reward: String? = "1250") =
        MineStatus(cache = DailyCache(claimable = claimable, currentDay = day, nextClaimAt = next, cacheShards = reward))
    private fun ui(mine: MineStatus? = mine(), busy: Boolean = false, enabled: Boolean = true, sent: Boolean = false) =
        dailyCacheUi(catalogue, mine, busy, now, dailyCacheBlockedReason(enabled, true, false), sent)

    @Test fun `cache reward and streak length are server and catalogue values`() {
        val ui = ui()
        assertEquals("+1,250", ui.reward); assertEquals(9, ui.days); assertEquals(4, ui.day)
        assertTrue(ui.dayKnown); assertEquals(CacheState.READY, ui.state); assertTrue(dailyCacheCanClaim(ui))
    }
    @Test fun `missing cache never borrows mining or claims a completed day`() {
        val ui = ui(MineStatus(mining = Mining(accrued = "9999")))
        assertNull(ui.reward); assertFalse(ui.dayKnown)
        assertEquals(CacheState.LOADING, ui.state); assertFalse(dailyCacheCanClaim(ui))
        assertNull(ui.receiptId)
    }
    @Test fun `missing pack streak length stays unknown while an explicit claimable reward remains claimable`() {
        val ui = dailyCacheUi(null, mine(), false, now)
        assertNull(ui.days); assertEquals("+1,250", ui.reward); assertTrue(dailyCacheCanClaim(ui))
    }
    @Test fun `server next claim time is display only and clock expiry never unlocks a claim`() {
        assertEquals("30m", ui(mine(claimable = false)).nextIn)
        val expired = ui(mine(claimable = false, next = "2030-01-01T11:59:59Z"))
        assertEquals("0s", expired.nextIn); assertEquals(CacheState.CLAIMED, expired.state)
        assertFalse(dailyCacheCanClaim(expired))
        assertNull(ui(mine(next = "broken")).nextIn)
    }
    @Test fun `busy and permission denial cannot submit the displayed claim`() {
        assertEquals(CacheState.CLAIMING, ui(busy = true, sent = true).state)
        assertFalse(dailyCacheCanClaim(ui(busy = true, sent = true)))
        assertFalse(dailyCacheCanClaim(ui(busy = true)))
        val denied = ui(enabled = false)
        assertEquals(CacheState.READY, denied.state)
        assertNotNull(denied.claimBlockedReason); assertFalse(dailyCacheCanClaim(denied))
    }
    @Test fun `no state transition invents receipt animation or owner-unconfirmed bonus wording`() {
        for (mine in listOf(mine(), mine(claimable = false), mine(day = 0))) {
            val ui = ui(mine)
            assertNull(ui.receiptId); assertNull(ui.bonusLabel)
            assertFalse(ui.ruleLine.contains("1.5"))
        }
    }
    @Test fun `unknown reward and invalid streak day stay visibly unknown`() {
        val ui = ui(mine(day = 99, reward = "broken"))
        assertNull(ui.reward); assertFalse(ui.dayKnown)
        assertEquals(1, ui(mine(day = 0)).day)
    }
    @Test fun `claimable current day counts completed claims with no today tile`() {
        val days = dailyCacheDays(ui(mine(day = 4)))!!
        assertEquals(4, days.count { it == CacheDay.CLAIMED })
        assertEquals(0, days.count { it == CacheDay.TODAY })
        assertEquals(5, days.count { it == CacheDay.FUTURE })
        assertEquals(4, ui(mine(day = 4)).day)
    }
    @Test fun `zero completed claims lights no tile whether claimable or not`() {
        for (claimable in listOf(true, false)) {
            val ui = ui(mine(claimable = claimable, day = 0))
            assertEquals(List(9) { CacheDay.FUTURE }, dailyCacheDays(ui))
            assertEquals(1, ui.day)
        }
        // The legacy DTO defaults an absent currentDay to zero; do not call it a missing-day guarantee.
        val absent = Json.decodeFromString<DailyCache>("""{"claimable":true}""")
        assertEquals(0, absent.currentDay)
        assertEquals(List(9) { CacheDay.FUTURE }, dailyCacheDays(ui(MineStatus(cache = absent))))
        assertNull(dailyCacheDays(ui(mine(day = 99))))
    }
    @Test fun `busy without a claim tap keeps ready and cannot submit`() {
        val refreshing = ui(busy = true)
        assertEquals(CacheState.READY, refreshing.state)
        assertNotNull(refreshing.claimBlockedReason)
        assertFalse(dailyCacheCanClaim(refreshing))
        val completed = ui(busy = false, sent = true)
        assertEquals(CacheState.READY, completed.state)
        assertTrue(dailyCacheCanClaim(completed))
    }
    @Test fun `busy with claimable false keeps claimed status and next claim time`() {
        val refreshing = ui(mine(claimable = false), busy = true, enabled = false)
        assertEquals(CacheState.CLAIMED, refreshing.state)
        assertEquals("30m", refreshing.nextIn)
        assertNull(refreshing.claimBlockedReason)
        assertFalse(dailyCacheCanClaim(refreshing))
        assertEquals(4, dailyCacheDays(refreshing)!!.count { it == CacheDay.CLAIMED })
        assertEquals(CacheState.LOADING, ui(null, busy = true, enabled = false).state)
        assertNull(ui(null, busy = true, enabled = false).claimBlockedReason)
    }
    @Test fun `blocked claim explains the existing update raid and deed gates`() {
        assertEquals("Install the available native app update before submitting game orders. Your account is preserved.",
            dailyCacheBlockedReason(false, true, false))
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.Copy.ACTIVE_RAID_MESSAGE,
            dailyCacheBlockedReason(true, false, true))
        assertEquals("This base is read-only. Wait for your kingdom to update, or open another available kingdom.",
            dailyCacheBlockedReason(true, false, false))
        assertNull(dailyCacheBlockedReason(true, true, false))
    }
    @Test fun `composed mount preserves claim owner closes and a single external scene tap`() {
        val screen = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/kingdom/KingdomScreen.kt").readText()
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/hub/live/LiveDailyCacheHost.kt").readText()
        val sheet = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/hub/DailyCacheSheet.kt").readText()
        assertTrue(screen.contains("val dailyCacheVisible = local.sheet == KingdomSheet.DAILY_CACHE && !editing && !local.buildMenu && local.placement == null"))
        assertTrue(screen.contains("KingdomSheet.DAILY_CACHE -> if (dailyCacheVisible) key(state.selectedBaseId)"))
        val mount = screen.substringAfter("KingdomSheet.DAILY_CACHE ->").substringBefore("KingdomSheet.EXPAND ->")
        assertTrue(mount.contains("onClaim = model::claimDailyCache"))
        assertTrue(mount.contains("onClose = model::closeSheet"))
        val taps = screen.lines().single { "val latestBeforeSceneTap by" in it }
        assertTrue(taps.contains("consumeDailyCacheTap(dailyCacheVisible, onBeforeSceneTap, model::closeSheet)"))
        assertEquals(1, Regex("onBeforeSceneTap").findAll(taps).count())
        assertTrue(taps.indexOf("consumeBuildersTap") < taps.indexOf("consumeWallRowTap"))
        assertTrue(taps.indexOf("consumeWallRowTap") < taps.indexOf("consumeObstacleTap"))
        assertTrue(taps.indexOf("consumeObstacleTap") < taps.indexOf("consumeExpandTap"))
        assertTrue(taps.indexOf("consumeExpandTap") < taps.indexOf("consumeDailyCacheTap"))
        assertTrue(host.contains("onClaim: () -> Job?"))
        assertTrue(host.contains("submittedClaim = onClaim()"))
        assertTrue(host.contains("sent = submittedClaim?.isActive == true"))
        assertTrue(host.contains("submittedClaim?.join()"))
        assertTrue(host.contains("if (!busy) submittedClaim = null"))
        assertTrue(sheet.contains("ui.state == CacheState.READY && ui.claimBlockedReason != null"))
    }
    @Test fun `scene tap preserves external owner before closing the cache`() {
        var closed = 0
        assertTrue(consumeDailyCacheTap(true, { true }, { closed++ })); assertEquals(0, closed)
        assertTrue(consumeDailyCacheTap(true, { false }, { closed++ })); assertEquals(1, closed)
        assertFalse(consumeDailyCacheTap(false, { false }, { closed++ }))
    }
}
