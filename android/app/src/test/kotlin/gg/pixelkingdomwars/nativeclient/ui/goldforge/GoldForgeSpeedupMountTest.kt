package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.ReviewedBuilderFinishSpend
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.BuilderJobSpeedupConsent
import gg.pixelkingdomwars.nativeclient.model.BuilderJobSpeedupIntent
import gg.pixelkingdomwars.nativeclient.model.GameCurrency
import gg.pixelkingdomwars.nativeclient.ops.ConstructionSpec
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ForgeAction
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.gemSpendPrimaryLook
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** Frame 70/71 integration contracts; written before the wrapper. Cedar3 alone executes. */
class GoldForgeSpeedupMountTest {
    private val terms = BuilderJobSpeedupIntent("22222222-2222-4222-8222-222222222222", BASE_ID,
        "original-builder-key", GameCurrency.GEMS, BuilderJobSpeedupConsent("upgrade",
            "33333333-3333-4333-8333-333333333333", null,
            "2030-01-01T11:00:00.000Z", "2030-01-01T12:00:00.000Z", "37"))
    private val now = Instant.parse("2030-01-01T11:30:00Z").toEpochMilli()
    private fun state(gems: String? = "100", currency: GameCurrency = GameCurrency.GEMS, saved: Boolean = false,
        maximum: String = "37"): KingdomUiState {
        val original = ConstructionSpec.builderIntent(WALLET, terms.copy(expectedCurrency = currency,
            consent = terms.consent.copy(maxCostKeep = maximum)))
        return KingdomUiState(home = BaseState(balances = Balances("5", "900", gems),
            builderFinishReview = ReviewedBuilderFinishSpend(if (saved) original.nextAttempt() else original, 2, 1)),
            wallet = WALLET, selectedBaseId = BASE_ID, baseGeneration = 2)
    }
    private fun ui(value: KingdomUiState = state(), busy: Boolean = false, topUp: Boolean = true, clock: Long = now) =
        requireNotNull(goldForgeSpeedupUi(value, busy, clock, now, topUpAvailable = topUp))

    @Test fun `normal finish retains original maximum consent and never manufactures a live quote or after balance`() {
        val first = ui()
        val later = ui(clock = now + 3_600_000)
        assertEquals("Up to 37", first.price.amount)
        assertEquals(PriceStatus.OK, first.price.status)
        assertTrue(requireNotNull(first.price.description).contains("may decrease"))
        assertEquals(first.price, later.price)
        assertEquals(now, later.quotedAtMs)
        assertNotEquals(PriceStatus.SERVER_ZERO, later.price.status)
        assertNull(first.after); assertNull(later.after)
        assertEquals(ForgeAction.CONFIRM, gemSpendPrimaryLook(first).action)
    }

    @Test fun `KEEP and absent review never become a Gems Seal`() {
        assertNull(goldForgeSpeedupUi(state(currency = GameCurrency.KEEP), false, now, now, topUpAvailable = true))
        assertNull(goldForgeSpeedupUi(state().copy(home = BaseState()), false, now, now, topUpAvailable = true))
    }

    @Test fun `known shortage offers the designed GET GEMS only when its destination exists`() {
        val short = ui(state("30"))
        assertEquals("7", short.short)
        assertEquals("Up to 37", short.price.amount)
        assertEquals(PriceStatus.SHORT, short.price.status)
        assertEquals(ForgeAction.GET_GEMS, gemSpendPrimaryLook(short).action)
        assertNull(short.after)
        val absent = ui(state("30"), topUp = false)
        assertEquals(PriceStatus.UNAVAILABLE, absent.price.status)
        assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(absent).action)
    }

    @Test fun `loading failed balances order holds and unknown amounts cannot offer top up or payment`() {
        val short = state("30")
        for (value in listOf(short.copy(ordersAllowed = false), short.copy(deedActionsAllowed = false),
            short.copy(home = short.home.copy(loading = true)), short.copy(home = short.home.copy(error = "offline")),
            state(null), state("not-an-amount"))) {
            val result = ui(value)
            assertEquals(PriceStatus.UNAVAILABLE, result.price.status)
            assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(result).action)
            assertNull(result.price.description)
        }
        assertEquals(MoneyStage.SENDING, ui(short, busy = true).stage)
        assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(ui(short, busy = true)).action)
    }

    @Test fun `a saved payment with a short balance stays on its original recovery path`() {
        val value = state("30", saved = true)
        val result = ui(value)
        assertEquals("Same saved payment", result.subjectLine)
        assertEquals(PriceStatus.UNAVAILABLE, result.price.status)
        assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(result).action)
        assertTrue(value.home.builderFinishReview!!.intent.attempted)
    }

    @Test fun `matching admitted consent forwards one explicit confirm to the existing owner`() {
        val value = state(); val calls = mutableListOf<String>()
        val original = value.home.builderFinishReview!!.intent
        val actions = goldForgeSpeedupActions(value.home.builderFinishReview, { value }, { false },
            { calls += "confirm" }, { calls += "back" }, { calls += "gems:$it" })
        actions.onConfirm(); actions.onConfirm(); actions.onBack(); actions.onGetGems("7")
        assertEquals(listOf("confirm"), calls)
        assertSame(original, value.home.builderFinishReview!!.intent)
        assertEquals("original-builder-key", original.idempotencyKey)
    }

    @Test fun `changed wallet base generation or equal replacement review cannot reuse painted callbacks`() {
        val original = state()
        for (changed in listOf(original.copy(wallet = "other"), original.copy(selectedBaseId = null),
            original.copy(selectedBaseId = terms.jobId), original.copy(baseGeneration = 3),
            original.copy(home = original.home.copy(builderFinishReview = original.home.builderFinishReview!!.copy())))) {
            val calls = mutableListOf<String>()
            val actions = goldForgeSpeedupActions(original.home.builderFinishReview, { changed }, { false },
                { calls += "confirm" }, { calls += "back" }, { calls += "gems:$it" })
            actions.onConfirm(); actions.onBack(); actions.onGetGems("7")
            assertTrue(calls.isEmpty())
        }
    }

    @Test fun `admission changes before a confirm tap refuse without spending or dismissing`() {
        val original = state()
        for (changed in listOf(original.copy(ordersAllowed = false), original.copy(deedActionsAllowed = false),
            original.copy(home = original.home.copy(loading = true)), original.copy(home = original.home.copy(error = "offline")),
            original.copy(home = original.home.copy(balances = Balances("5", "900", "30"))))) {
            var calls = 0
            val actions = goldForgeSpeedupActions(original.home.builderFinishReview, { changed }, { false },
                { calls++ }, { calls++ }, { calls++ })
            actions.onConfirm()
            assertEquals(0, calls)
        }
        var busy = false; var calls = 0
        val actions = goldForgeSpeedupActions(original.home.builderFinishReview, { original }, { busy }, { calls++ }, {}, {})
        busy = true; actions.onConfirm(); assertEquals(0, calls)
    }

    @Test fun `shortfall navigation dismisses the exact review then opens Gems without auto spending`() {
        var value = state("30"); val captured = value.home.builderFinishReview
        val calls = mutableListOf<String>()
        val actions = goldForgeSpeedupActions(captured, { value }, { false }, { calls += "confirm" }, {
            calls += "back"; value = value.copy(home = value.home.copy(builderFinishReview = null))
        }, { calls += "gems:$it" })
        actions.onGetGems("7"); actions.onGetGems("7"); actions.onConfirm()
        assertEquals(listOf("back", "gems:7"), calls)
        assertNull(value.home.builderFinishReview)
        assertFalse(captured!!.intent.attempted)
    }

    @Test fun `formatted large shortfall becomes the exact raw navigation amount`() {
        val value = state("1", maximum = "9007199254740993")
        val calls = mutableListOf<String>()
        val actions = goldForgeSpeedupActions(value.home.builderFinishReview, { value }, { false }, {}, {}, { calls += it })
        actions.onGetGems(requireNotNull(ui(value).short))
        assertEquals(listOf("9007199254740992"), calls)
    }

    @Test fun `stale displayed shortfall or a now sufficient balance never dismisses into another purchase`() {
        var value = state("30"); val captured = value.home.builderFinishReview; var calls = 0
        val actions = goldForgeSpeedupActions(captured, { value }, { false }, { calls++ }, { calls++ }, { calls++ })
        actions.onGetGems("8"); assertEquals(0, calls)
        value = value.copy(home = value.home.copy(balances = Balances("5", "900", "100")))
        actions.onGetGems("7"); assertEquals(0, calls)
    }

    @Test fun `saved review and missing destination cannot discard recovery to open Gems`() {
        for (saved in listOf(false, true)) {
            val value = state("30", saved = saved); var calls = 0
            val actions = goldForgeSpeedupActions(value.home.builderFinishReview, { value }, { false },
                { calls++ }, { calls++ }, if (saved) ({ _: String -> calls++ }) else null)
            actions.onGetGems("7"); assertEquals(0, calls)
        }
    }

    @Test fun `back dismisses only its current idle review and never confirms`() {
        val value = state(); val calls = mutableListOf<String>(); var busy = true
        val actions = goldForgeSpeedupActions(value.home.builderFinishReview, { value }, { busy },
            { calls += "confirm" }, { calls += "back" }, null)
        actions.onBack(); assertTrue(calls.isEmpty())
        busy = false; actions.onBack(); actions.onBack()
        assertEquals(listOf("back"), calls)
    }

    @Test fun `Kingdom integration keeps the existing model callbacks and the KEEP fallback`() {
        val source = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/kingdom/KingdomScreen.kt").readText()
        val body = source.substringAfter("private fun BuilderFinishCurrencyConfirm(").substringBefore("/** Receipt-only entry")
        assertTrue(body.contains("GoldForgeSpeedupMount("))
        assertTrue(body.contains("model.state.value")); assertTrue(body.contains("model.busy.value"))
        assertTrue(body.contains("model.confirmBuilderFinish()")); assertTrue(body.contains("model::dismissBuilderFinishReview"))
        assertTrue(body.contains("onGetGems = onGetGems"))
        assertTrue(body.contains("if (terms.expectedCurrency == gg.pixelkingdomwars.nativeclient.model.GameCurrency.GEMS) return"))
        // 2026-10-06: the KEEP fallback keeps its consent wording but draws the designed KingdomConfirmDialog instead of the
        // Material AlertDialog (no legacy surface on the player path).
        assertTrue(body.contains("KingdomConfirmDialog(")); assertFalse(body.contains("AlertDialog(")); assertTrue(body.contains("terms.consent.maxCostKeep"))
        assertFalse(body.contains("reviewBuilderFinish(")); assertFalse(body.contains("finishJob("))
    }
}
