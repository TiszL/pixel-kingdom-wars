package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.MineStatus
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** A daily cache claim is money: one POST, definitive refusals paid nothing, a lost reply is reconciled
 * by re-reading the server's claimed-today verdict and never resent. */
class DailyCacheClaimsTest {
    private fun status(claimable: Boolean) = Json.parseToJsonElement("""{"mining":{"accrued":0,"storageCap":500,"ratePerHour":20,"mineCount":1,"maxMines":2},
        "cache":{"streakDays":2,"currentDay":2,"cacheShards":200,"claimable":$claimable,"nextClaimAt":"2026-09-12T00:00:00.000Z"}}""").jsonObject
    @Test fun `an accepted claim returns the server amount and streak`() = runBlocking {
        val claim = claimDailyCache(MineStatus.from(status(true)), { error("no read") }) { Json.parseToJsonElement("""{"amount":"200","streakDays":3,"everCompletedWeek1":false}""").jsonObject }
        assertEquals("200", claim!!.amount); assertEquals(3, claim.streakDays)
    }
    @Test fun `a definitive refusal is thrown without a reconciling read`() = runBlocking {
        var reads = 0
        val error = runCatching { claimDailyCache(MineStatus.from(status(true)), { reads++; status(true) }) { throw ApiException(422, null, "already claimed today") } }.exceptionOrNull()
        assertEquals("already claimed today", error!!.message); assertEquals(0, reads)
    }
    @Test fun `a lost reply is reconciled by the claimed-today verdict and never resent`() = runBlocking {
        var posts = 0; var reads = 0
        val claim = claimDailyCache(MineStatus.from(status(true)), { reads++; status(false) }) { posts++; throw IOException("lost") }
        assertNull("Paid, amount unknown", claim); assertEquals(1, posts); assertEquals(1, reads)
        val stillClaimable = runCatching { claimDailyCache(MineStatus.from(status(true)), { status(true) }) { throw IOException("lost") } }.exceptionOrNull()
        assertTrue("A cache still claimable after a lost reply was not paid", stillClaimable is IOException)
        val unknownBefore = runCatching { claimDailyCache(null, { status(false) }) { throw IOException("lost") } }.exceptionOrNull()
        assertTrue("Without a before-state the verdict cannot be attributed to this claim", unknownBefore is IOException)
    }
    @Test fun `a revoked session during the reconciling read reaches the account boundary`() = runBlocking {
        val error = runCatching { claimDailyCache(MineStatus.from(status(true)), { throw ApiException(401, null, "expired") }) { throw IOException("lost") } }.exceptionOrNull()
        assertEquals(401, (error as ApiException).status)
    }
}
