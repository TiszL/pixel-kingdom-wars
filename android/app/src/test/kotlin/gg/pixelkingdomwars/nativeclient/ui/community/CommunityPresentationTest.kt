package gg.pixelkingdomwars.nativeclient.ui.community

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class CommunityPresentationTest {
    private fun catalogue(rules: String) = Json.parseToJsonElement("""{"constants":{"LEAGUES":$rules}}""").jsonObject
    private val rules = catalogue("""{"thresholds":[0,100,300,900],"weeklyCacheShardsByKeepLevel":[101,202],"cacheTierMultBps":{"bronze":10000,"silver":15000,"gold":20000,"sol":30000}}""")
    @Test fun `progress uses supplied thresholds and never invents thresholds for missing content`() {
        val progress = requireNotNull(leagueProgress(rules, "silver", 200))
        assertEquals(.5f, progress.fraction)
        assertEquals("gold", progress.nextTier)
        assertEquals(100L, progress.remaining)
        assertEquals(1f, leagueProgress(rules, "sol", 1000)?.fraction)
        assertNull(leagueProgress(rules, "sol", 1000)?.remaining)
        assertNull(leagueProgress(null, "silver", 200))
        assertNull(leagueProgress(rules, "unknown", 200))
    }
    @Test fun `malformed threshold tables cannot present a plausible league progress bar`() {
        assertNull(leagueThresholds(catalogue("""{"thresholds":[0,100,90,900]}""")))
        assertNull(leagueThresholds(catalogue("""{"thresholds":[0,100]}""")))
        assertNull(leagueThresholds(catalogue("""{"thresholds":[-1,100,300,900]}""")))
    }
    @Test fun `cache floors exact catalogue basis points and uses current Keep without unknown-level fallback`() {
        assertEquals("151", leagueCache(rules, "silver", 1))
        assertEquals("303", leagueCache(rules, "silver", 2))
        assertEquals("303", leagueCache(rules, "silver", 99)) // Source clamps a known higher Keep to the last reward table row.
        assertNull(leagueCache(rules, "silver", null))
        assertNull(leagueCache(rules, "silver", 0))
        assertNull(leagueCache(rules, "unknown", 1))
        assertNull(leagueCache(null, "silver", 1))
    }
    @Test fun `cache multiplication stays exact beyond Long rather than overflowing an award preview`() {
        val large = catalogue("""{"weeklyCacheShardsByKeepLevel":["9223372036854775807"],"cacheTierMultBps":{"gold":20000}}""")
        assertEquals("18446744073709551614", leagueCache(large, "gold", 1))
    }
    @Test fun `deadline counts only to supplied close time rounds a remaining fraction up and never goes negative`() {
        val now = Instant.parse("2026-09-13T10:00:00Z").toEpochMilli()
        assertEquals(1L, leagueRemaining("2026-09-13T10:00:00.001Z", now))
        assertEquals(0L, leagueRemaining("2026-09-13T10:00:00Z", now))
        assertEquals(0L, leagueRemaining("2026-09-12T10:00:00Z", now))
        assertNull(leagueRemaining("unknown", now))
    }
    @Test fun `missing dates remain unknown and catalogue item names are preferred over readable ids`() {
        assertEquals("—", communityDate(null))
        assertEquals("—", communityDate("invalid", ZoneId.of("UTC")))
        val items = Json.parseToJsonElement("""{"constants":{"LEGACY_ITEMS":{"speed_build":{"name":"Builder Hourglass"}}}}""").jsonObject
        assertEquals("Builder Hourglass", communityItemName(items, "speed_build"))
        assertEquals("UNKNOWN ITEM", communityItemName(items, "unknown_item"))
    }
}
