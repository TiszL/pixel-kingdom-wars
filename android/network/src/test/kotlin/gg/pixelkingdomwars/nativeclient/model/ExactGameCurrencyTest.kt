package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ExactGameCurrencyTest {
    private fun balances(gems: String = "10", keep: String = "10", enabled: Boolean = true, exact: Boolean = true) = buildJsonObject {
        put("gems", gems); put("keep", keep)
        put("features", buildJsonObject {
            if (exact) put("gameCurrency", buildJsonObject { put("version", 1); put("exactSpendCurrency", 1) })
            if (enabled) put("gems", buildJsonObject { put("version", 1); put("receipts", 1) })
        })
    }
    @Test fun `whole-price selection prefers Gems but never sums two partial balances`() {
        assertEquals(GameCurrency.GEMS, ExactGameCurrency.choose("10", balances()))
        assertEquals(GameCurrency.KEEP, ExactGameCurrency.choose("10", balances(gems = "9")))
        assertThrows(IllegalStateException::class.java) { ExactGameCurrency.choose("10", balances("9", "9")) }
    }
    @Test fun `paused Gems still permits exact KEEP but cannot silently change reviewed Gems`() {
        val paused = balances(enabled = false)
        assertEquals(GameCurrency.KEEP, ExactGameCurrency.choose("10", paused))
        ExactGameCurrency.requireCovered(GameCurrency.KEEP, "10", paused)
        assertThrows(IllegalStateException::class.java) { ExactGameCurrency.requireCovered(GameCurrency.GEMS, "10", paused) }
        assertThrows(IllegalStateException::class.java) { ExactGameCurrency.requireCovered(GameCurrency.GEMS, "10", balances(gems = "9")) }
    }
    @Test fun `old or malformed capabilities and imprecise values cannot authorize new spend`() {
        assertThrows(IllegalStateException::class.java) { ExactGameCurrency.choose("10", balances(exact = false)) }
        for (value in listOf("0", "01", "1.5", "-1", "9223372036854775808"))
            assertThrows(IllegalArgumentException::class.java) { ExactGameCurrency.choose(value, balances()) }
        assertThrows(IllegalArgumentException::class.java) { ExactGameCurrency.choose("10", balances(gems = "1e2")) }
    }
}
