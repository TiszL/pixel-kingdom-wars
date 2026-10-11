package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class GemsCompatibilityTest {
    private val capability = GemsCapability(true, listOf("ledger-keep"), null, 1, 1, 1, 1000)
    private fun raw(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun balances(gems: String, keep: String) = Balances("0", keep, gems, GemsRate(1, 1), BalanceFeatures(GemsFeature(1, 1)))
    @Test fun `old balances and capability snapshots stay readable without opting into Gems`() {
        val old = Balances.from(raw("""{"shards":"9","keep":"8","future":true}"""))
        assertNull(old.gems); assertNull(old.features)
        assertNull(NativeCapabilities.from(raw("""{"protocolVersion":1,"simVersion":17}""")).economy)
        assertThrows(IllegalArgumentException::class.java) { GameCurrencyConsent.gemsFirst("1", old, capability) }
    }
    @Test fun `a present legacy or unknown feature envelope preserves balances without advertising Gems`() {
        listOf("{}", """{"conversionReceipts":{"version":1},"forgeContributionReceipts":{"version":1}}""",
            """{"futureFeature":{"enabled":true}}""").forEach { features ->
            val old = Balances.from(raw("""{"shards":"9","keep":"8","features":$features}"""))
            assertEquals(Balances("9", "8", features = BalanceFeatures()), old)
            assertNull(old.features!!.gems)
            assertThrows(IllegalArgumentException::class.java) { GameCurrencyConsent.gemsFirst("1", old, capability) }
        }
    }
    @Test fun `additive economy preserves exact balances and server owned rates and workshop version`() {
        val balance = Balances.from(raw("""{"shards":"9","keep":"8","gems":"9007199254740993","gemsRate":{"gemsPerKeep":1,"shardsPerGem":1},"features":{"gems":{"version":1,"receipts":1},"olderFeature":{} }}"""))
        assertEquals("9007199254740993", balance.gems); assertTrue(balance.features!!.gems!!.supported)
        val capabilities = NativeCapabilities.from(raw("""{"protocolVersion":1,"simVersion":17,"economy":{"gems":{"enabled":true,"sources":["ledger-keep"],"destinationAta":null,"gemsPerKeep":1,"shardsPerGem":1,"minConvertKeep":1,"maxConvertKeepPerTx":1000},"workshop":{"enabled":false,"recipeVersion":1}}}"""))
        assertTrue(capabilities.economy!!.gems!!.enabled); assertFalse(capabilities.economy!!.workshop!!.enabled)
    }
    @Test fun `whole price funding disclosure never combines balances and always names fallback`() {
        val gems = GameCurrencyConsent.gemsFirst("10", balances("10", "20"), capability)
        assertEquals(GameCurrency.GEMS, gems.expected); assertEquals(GameCurrency.KEEP, gems.fallback)
        assertEquals(GameCurrency.KEEP, GameCurrencyConsent.gemsFirst("10", balances("9", "10"), capability).expected)
        assertNull(GameCurrencyConsent.gemsFirst("10", balances("9", "9"), capability).expected)
        assertThrows(IllegalArgumentException::class.java) { GameCurrencyConsent.gemsFirst("10", balances("10", "10"), capability.copy(enabled = false)) }
    }
    @Test fun `malformed money and unsupported features never negotiate Gems`() {
        listOf("-1", "01", "1.1", "1e2").forEach { invalid -> assertThrows(IllegalArgumentException::class.java) { Balances.from(raw("""{"shards":"0","keep":"0","gems":"$invalid"}""")) } }
        assertThrows(IllegalArgumentException::class.java) { GameCurrencyConsent.gemsFirst("1", balances("10", "10").copy(features = BalanceFeatures(GemsFeature(2, 1))), capability) }
        assertThrows(IllegalArgumentException::class.java) { GemsRate(0, 1) }
        assertThrows(IllegalArgumentException::class.java) { capability.copy(minConvertKeep = 1001) }
    }
    @Test fun `exact consent is additive and absence never implies server quote enforcement`() {
        assertNull(GemsFeature(1, 1).exactConsent); assertNull(capability.exactConsent)
        val snapshot = GemsOverview.from(raw("""{"features":{"gems":{"version":1,"receipts":1,"exactConsent":1}},"gems":"0","tasks":[],"sources":[],"minConvertKeep":1,"maxConvertKeepPerTx":10,"gemsPerKeep":1,"shardsPerGem":1,"serverNow":"2026-09-21T00:00:00Z"}"""))
        assertEquals(1, snapshot.features.gems!!.exactConsent)
    }
}
