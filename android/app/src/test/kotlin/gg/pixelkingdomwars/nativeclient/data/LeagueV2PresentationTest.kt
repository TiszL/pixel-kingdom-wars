package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.ui.community.leagueProgress
import gg.pixelkingdomwars.nativeclient.ui.community.leagueThresholds
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class LeagueV2PresentationTest {
    private val tiers = listOf("bronze", "silver", "gold", "platinum", "diamond", "solana", "seeker")
    private val tierJson = """["bronze","silver","gold","platinum","diamond","solana","seeker"]"""
    private fun json(raw: String) = Json.parseToJsonElement(raw).jsonObject
    private fun catalogue(
        thresholds: String = "[0,100,300,800,2000,5000,10000]",
        identities: String = tierJson,
    ) = json("""{"constants":{"PHASE_E_LEAGUE_TIERS":{"tiers":$identities,"thresholds":$thresholds}}}""")

    @Test fun `N-4 v2 catalogue exposes all seven identities and supplied thresholds`() {
        assertEquals(tiers, leagueTiersV2(catalogue()))
        assertEquals(listOf(0L, 100L, 300L, 800L, 2000L, 5000L, 10000L), leagueThresholdsV2(catalogue()))
        val progress = requireNotNull(leagueProgressV2(catalogue(), "diamond", 3500))
        assertEquals(.5f, progress.fraction, 0f)
        assertEquals("solana", progress.nextTier)
        assertEquals(1500L, progress.remaining)
    }

    @Test fun `progress follows a changed supplied catalogue without copied game thresholds`() {
        val supplied = catalogue("[0,11,35,80,140,300,700]")
        val progress = requireNotNull(leagueProgressV2(supplied, "diamond", 220))
        assertEquals(.5f, progress.fraction, 0f)
        assertEquals("solana", progress.nextTier)
        assertEquals(80L, progress.remaining)
    }

    @Test fun `tier boundaries follow the server identity and clamp the displayed fraction`() {
        val supplied = catalogue("[0,10,20,30,40,50,60]")
        for ((index, tier) in tiers.dropLast(1).withIndex()) {
            val boundary = requireNotNull(leagueProgressV2(supplied, tier, index * 10))
            assertEquals(0f, boundary.fraction, 0f)
            assertEquals(tiers[index + 1], boundary.nextTier)
            assertEquals(10L, boundary.remaining)
        }
        val below = requireNotNull(leagueProgressV2(supplied, "diamond", 0))
        assertEquals(0f, below.fraction, 0f)
        assertEquals(50L, below.remaining)
        val above = requireNotNull(leagueProgressV2(supplied, "diamond", 70))
        assertEquals(1f, above.fraction, 0f)
        assertEquals(0L, above.remaining)
        assertEquals("solana", above.nextTier) // Never locally promote the server identity.
    }

    @Test fun `highest supplied tier is complete without a fabricated next threshold`() {
        val progress = requireNotNull(leagueProgressV2(catalogue(), "seeker", 12000))
        assertEquals(1f, progress.fraction, 0f)
        assertNull(progress.nextTier)
        assertNull(progress.remaining)
    }

    @Test fun `missing or malformed optional catalogue cannot fabricate v2 progress`() {
        val invalid: List<JsonObject?> = listOf(null, json("{}"), json("""{"constants":null}"""),
            json("""{"constants":[]}"""), json("""{"constants":{}}"""),
            json("""{"constants":{"PHASE_E_LEAGUE_TIERS":null}}"""),
            json("""{"constants":{"PHASE_E_LEAGUE_TIERS":[]}}"""),
            json("""{"constants":{"PHASE_E_LEAGUE_TIERS":{}}}"""))
        for (source in invalid) {
            assertNull(leagueTiersV2(source))
            assertNull(leagueThresholdsV2(source))
            assertNull(leagueProgressV2(source, "diamond", 3500))
        }
    }

    @Test fun `v2 identity table rejects missing extra reordered duplicate and unknown tiers`() {
        val invalid = listOf(
            "null", "{}", "[]", tierJson.replace(",\"seeker\"", ""),
            tierJson.replace("]", ",\"mythic\"]"),
            tierJson.replace("\"bronze\",\"silver\"", "\"silver\",\"bronze\""),
            tierJson.replace("\"seeker\"", "\"solana\""),
            tierJson.replace("\"solana\"", "\"sol\""),
            tierJson.replace("\"diamond\"", "\"DIAMOND\""),
            tierJson.replace("\"diamond\"", "null"),
            tierJson.replace("\"diamond\"", "3"),
        )
        for (identities in invalid) {
            val source = catalogue(identities = identities)
            assertNull(identities, leagueTiersV2(source))
            assertNull(identities, leagueThresholdsV2(source))
            assertNull(identities, leagueProgressV2(source, "diamond", 3500))
        }
    }

    @Test fun `N-5 v2 thresholds reject six eight duplicate and decreasing entries`() {
        for (thresholds in listOf(
            "[0,100,300,800,2000,5000]", "[0,100,300,800,2000,5000,10000,20000]",
            "[0,100,300,800,800,5000,10000]", "[0,100,300,800,700,5000,10000]",
        )) {
            val source = catalogue(thresholds)
            assertNull(thresholds, leagueThresholdsV2(source))
            assertNull(thresholds, leagueProgressV2(source, "diamond", 3500))
        }
    }

    @Test fun `threshold values must be nonnegative integer JSON numbers within Long`() {
        for (thresholds in listOf(
            "null", "{}", "[]", "[-1,100,300,800,2000,5000,10000]",
            "[0,100,300,800,2000,5000,\"10000\"]", "[0,100,300,800,2000,5000,10000.5]",
            "[0,100,300,800,2000,5000,null]", "[0,100,300,800,2000,5000,true]",
            "[0,100,300,800,2000,5000,9223372036854775808]",
        )) {
            val source = catalogue(thresholds)
            assertNull(thresholds, leagueThresholdsV2(source))
            assertNull(thresholds, leagueProgressV2(source, "diamond", 3500))
        }
    }

    @Test fun `thresholds require increasing values but do not invent a gap policy`() {
        val source = catalogue("[2,3,4,5,6,7,8]")
        assertEquals(listOf(2L, 3L, 4L, 5L, 6L, 7L, 8L), leagueThresholdsV2(source))
        val progress = requireNotNull(leagueProgressV2(source, "bronze", 0))
        assertEquals(0f, progress.fraction, 0f)
        assertEquals(3L, progress.remaining)
    }

    @Test fun `large supplied thresholds retain exact remaining count without overflow`() {
        val source = catalogue("[0,1,2,3,4,5,9223372036854775807]")
        val progress = requireNotNull(leagueProgressV2(source, "solana", 6))
        assertEquals(Long.MAX_VALUE - 6, progress.remaining)
        assertTrue(progress.fraction.isFinite())
        assertTrue(progress.fraction > 0f && progress.fraction < 1f)
    }

    @Test fun `unknown server tier and invalid trophy value leave progression unavailable`() {
        for (tier in listOf("mythic", "sol", "DIAMOND", "", " diamond")) {
            assertNull(tier, leagueProgressV2(catalogue(), tier, 3500))
        }
        assertNull(leagueProgressV2(catalogue(), "diamond", -1))
    }

    @Test fun `N-6 legacy four-tier helpers remain isolated from optional v2 catalogue`() {
        val legacy = json("""{"constants":{"LEAGUES":{"thresholds":[0,100,300,900]}}}""")
        assertEquals(listOf(0L, 100L, 300L, 900L), leagueThresholds(legacy))
        assertEquals(.5f, requireNotNull(leagueProgress(legacy, "silver", 200)).fraction, 0f)
        assertNull(leagueTiersV2(legacy))
        assertNull(leagueProgressV2(legacy, "silver", 200))
        val sevenLegacy = json("""{"constants":{"LEAGUES":{"thresholds":[0,100,300,800,2000,5000,10000]}}}""")
        assertNull(leagueThresholds(sevenLegacy))
        assertNull(leagueThresholds(catalogue()))
    }
}
