package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.ArmyTrainingDraft
import gg.pixelkingdomwars.nativeclient.data.ReviewedQuote
import gg.pixelkingdomwars.nativeclient.model.TrainingQuote
import gg.pixelkingdomwars.nativeclient.network.BaseOrderPrice
import gg.pixelkingdomwars.nativeclient.network.TrainingScheduling
import gg.pixelkingdomwars.nativeclient.network.buildingPrice
import gg.pixelkingdomwars.nativeclient.network.buildingUpgradePrice
import gg.pixelkingdomwars.nativeclient.network.trainingConfirmation
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertNull
import org.junit.Test

/** Synthetic prices test provenance/precision, not game constants. No mutation or Seal is created by a price. */
class MoneyMapperCommonTest {
    @Test fun `retained catalogue price alone is not a current cost`() {
        unavailable(buildUpgradeMoneyPrice(BaseOrderPrice("SHARDS", "1234", null)))
    }

    @Test fun `missing current catalogue row never looks free`() {
        assertNull(buildUpgradeMoneyPrice(null, priceCurrent = true, balanceShards = "9999", balanceCurrent = true))
    }

    @Test fun `known shards cost and admitted sufficient balance show exact price`() {
        val price = building("1234", "1234")
        assertEquals(Currency.SHARDS, price.currency)
        assertEquals("1,234", price.amount)
        assertEquals(PriceStatus.OK, price.status)
    }

    @Test fun `short shards balance does not become payable`() {
        assertEquals(PriceStatus.SHORT, building("1234", "1233").status)
    }

    @Test fun `known price with missing balance waits for affordability`() {
        assertEquals(PriceStatus.CHECKING, building("1234", null).status)
    }

    @Test fun `retained balance requires separate owner admission`() {
        assertEquals(PriceStatus.CHECKING,
            buildUpgradeMoneyPrice(BaseOrderPrice("SHARDS", "1234", null), true, "9999")?.status)
    }

    @Test fun `invalid balances cannot prove sufficient funds`() {
        listOf("-1", "1.0", "+9999", " 9999", "9e3", "", "00").forEach {
            assertEquals(it, PriceStatus.CHECKING, building("1", it).status)
        }
    }

    @Test fun `catalogue zero is not a server zero quote`() {
        unavailable(building("0", "9999"))
    }

    @Test fun `malformed or fractional shards prices are unavailable`() {
        listOf("-1", "1.0", "+1", " 1", "1e3", "", "01").forEach { unavailable(building(it, "9999")) }
    }

    @Test fun `wallet and paid-step currencies remain with their existing reviews`() {
        listOf("KEEP", "SOL", "GEMS", "SKR", "ITEM", "shards", "").forEach {
            // No guessed SHARDS icon for a different or unknown currency; keep the owning money review.
            for (priceCurrent in listOf(false, true)) for (balanceCurrent in listOf(false, true)) {
                assertNull(buildUpgradeMoneyPrice(BaseOrderPrice(it, "1234", null), priceCurrent, "9999", balanceCurrent))
            }
        }
    }

    @Test fun `hero altar and siege stool null prices retain their item or KEEP review route`() {
        val catalogue = Json.parseToJsonElement("""{"constants":{"BUILD_COSTS":{"heroaltar":{},"siegestool":{}}}}""").jsonObject
        listOf("heroaltar", "siegestool").forEach {
            val price = buildingPrice(catalogue, buildJsonObject {}, it)
            assertNull(price)
            assertNull(buildUpgradeMoneyPrice(price, true, "9999", true))
        }
    }

    @Test fun `positive SOL upgrade null price retains its existing combined review route`() {
        val catalogue = Json.parseToJsonElement("""{"constants":{"UPGRADE_COSTS":{"keep":["123"]}},"display":{"upgradeSolLamports":{"keep":{"2":"1"}}}}""").jsonObject
        val building = buildJsonObject { put("type", "keep"); put("level", 1) }
        val price = buildingUpgradePrice(catalogue, building)
        assertNull(price)
        assertNull(buildUpgradeMoneyPrice(price, true, "9999", true))
    }

    @Test fun `large exact shards prices do not pass through long or floating point`() {
        val price = building("999999999999999999999999999999", "999999999999999999999999999998")
        assertEquals("999,999,999,999,999,999,999,999,999,999", price.amount)
        assertEquals(PriceStatus.SHORT, price.status)
    }

    @Test fun `retained training review is closed by default`() {
        unavailable(trainingMoneyPrice(review(), WALLET, BASE))
    }

    @Test fun `missing training review stays unavailable`() {
        unavailable(trainingMoneyPrice(null, WALLET, BASE, reviewCurrent = true))
    }

    @Test fun `training review must belong to the current account and base`() {
        unavailable(trainingMoneyPrice(review(), "other-wallet", BASE, true))
        unavailable(trainingMoneyPrice(review(), WALLET, "other-base", true))
        unavailable(trainingMoneyPrice(review(), null, BASE, true))
        unavailable(trainingMoneyPrice(review(), WALLET, null, true))
    }

    @Test fun `training uses the quoted subset cost not requested quantity arithmetic`() {
        // Two queued out of three requested; the total is divisible by neither count.
        val price = trainingMoneyPrice(review(cost = "1235", balance = "1235", queueCount = 2), WALLET, BASE, true)
        assertEquals("1,235", price.amount)
        assertEquals(PriceStatus.OK, price.status)
    }

    @Test fun `training shortfall uses the same server quote balance`() {
        assertEquals(PriceStatus.SHORT, trainingMoneyPrice(review(balance = "1233"), WALLET, BASE, true).status)
    }

    @Test fun `missing or invalid training balance never claims affordability`() {
        listOf(null, "-1", "NaN").forEach {
            assertEquals(PriceStatus.CHECKING, trainingMoneyPrice(review(balance = it), WALLET, BASE, true).status)
        }
    }

    @Test fun `only a valid current server quoted zero can show zero`() {
        val price = trainingMoneyPrice(review(cost = "0", balance = null), WALLET, BASE, true)
        assertEquals("0", price.amount)
        assertEquals(PriceStatus.SERVER_ZERO, price.status)
    }

    @Test fun `valid server zero remains zero with an observed non-null balance`() {
        val price = trainingMoneyPrice(review(cost = "0", balance = "0"), WALLET, BASE, true)
        assertEquals("0", price.amount)
        assertEquals(PriceStatus.SERVER_ZERO, price.status)
    }

    @Test fun `server zero cannot bypass blank null or numeric original keys`() {
        val original = review(cost = "0", balance = "0")
        listOf(JsonPrimitive(""), JsonPrimitive(" "), JsonNull, JsonPrimitive(123)).forEach { key ->
            unavailable(trainingMoneyPrice(original.copy(body = JsonObject(original.body + ("idempotencyKey" to key))),
                WALLET, BASE, true))
        }
    }

    @Test fun `typed training price cannot diverge from the frozen raw quote`() {
        val original = review()
        unavailable(trainingMoneyPrice(original.copy(quote = original.quote.copy(costShards = "0")), WALLET, BASE, true))
    }

    @Test fun `typed training balance cannot diverge from its server quote`() {
        val original = review(balance = "0")
        unavailable(trainingMoneyPrice(original.copy(quote = original.quote.copy(availableShards = "9999")), WALLET, BASE, true))
    }

    @Test fun `changed saved consent is never displayed as the reviewed cost`() {
        val original = review()
        val changed = JsonObject(original.body + ("confirmedCostShards" to JsonPrimitive("0")))
        unavailable(trainingMoneyPrice(original.copy(body = changed), WALLET, BASE, true))
    }

    @Test fun `missing idempotency key cannot stand in for an admitted review`() {
        val original = review()
        unavailable(trainingMoneyPrice(original.copy(body = JsonObject(original.body - "idempotencyKey")), WALLET, BASE, true))
    }

    @Test fun `unsupported or changed scheduling cannot be presented as ready`() {
        val original = review()
        unavailable(trainingMoneyPrice(original.copy(scheduling = TrainingScheduling.UNSUPPORTED), WALLET, BASE, true))
        unavailable(trainingMoneyPrice(original.copy(scheduling = TrainingScheduling.SEQUENTIAL), WALLET, BASE, true))
    }

    @Test fun `empty server queue never implies a free training action`() {
        unavailable(trainingMoneyPrice(review(cost = "0", queueable = false), WALLET, BASE, true))
    }

    @Test fun `positive cost cannot admit empty or nonpositive queued rows`() {
        unavailable(trainingMoneyPrice(review(queueable = false), WALLET, BASE, true))
        listOf(0, -1).forEach { unavailable(trainingMoneyPrice(review(queueCount = it), WALLET, BASE, true)) }
    }

    @Test fun `price projection preserves the original review and saved body`() {
        val original = review()
        val snapshot = original.copy()
        val quoteIdentity = original.quote
        val bodyIdentity = original.body
        val before = original.body.toString()
        val first = trainingMoneyPrice(original, WALLET, BASE, true)
        val second = trainingMoneyPrice(original, WALLET, BASE, true)
        assertEquals(first, second)
        assertEquals(snapshot, original)
        assertSame(quoteIdentity, original.quote)
        assertSame(bodyIdentity, original.body)
        assertEquals(before, original.body.toString())
        assertEquals(original.body, trainingConfirmation(original.quote.raw, BASE, "synthetic-intent", original.scheduling))
    }

    private fun building(amount: String, balance: String?): PriceUi =
        requireNotNull(buildUpgradeMoneyPrice(BaseOrderPrice("SHARDS", amount, null), true, balance, true))

    private fun unavailable(price: PriceUi?) {
        assertNotNull(price)
        assertEquals(PriceStatus.UNAVAILABLE, price?.status)
        assertNull(price?.amount)
    }

    private fun review(cost: String = "1234", balance: String? = "1234", queueable: Boolean = true, queueCount: Int = 1): ReviewedQuote {
        val raw = buildJsonObject {
            putJsonArray("requested") { add(buildJsonObject { put("troop", "bowman"); put("count", 3) }) }
            putJsonArray("queueable") {
                if (queueable) add(buildJsonObject { put("troop", "bowman"); put("count", queueCount) })
            }
            putJsonArray("remaining") {}
            put("costShards", cost)
            balance?.let { put("availableShards", it) }
        }
        return ReviewedQuote(ArmyTrainingDraft(WALLET, BASE, mapOf("bowman" to "3")), TrainingQuote.from(raw),
            trainingConfirmation(raw, BASE, "synthetic-intent", TrainingScheduling.LEGACY), TrainingScheduling.LEGACY)
    }

    private companion object {
        const val WALLET = "synthetic-wallet"
        const val BASE = "synthetic-base"
    }
}
