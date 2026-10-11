package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.ReviewedTrainingFinishSpend
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.ArmyState
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.GameCurrency
import gg.pixelkingdomwars.nativeclient.model.PaidTrainingFinishIntent
import gg.pixelkingdomwars.nativeclient.model.QueueConsentRow
import gg.pixelkingdomwars.nativeclient.ops.TrainingFinishSpec
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ForgeAction
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.gemSpendPrimaryLook
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class TrainingFinishSealMapperTest {
    private val terms = PaidTrainingFinishIntent(BASE_ID, "original-training-key", GameCurrency.GEMS,
        listOf(
            QueueConsentRow("22222222-2222-4222-8222-222222222222", "2030-01-01T11:00:00.000Z", "2030-01-01T12:00:00.000Z"),
            QueueConsentRow("33333333-3333-4333-8333-333333333333", "2030-01-01T12:00:00.000Z", "2030-01-01T13:00:00.000Z")), "37")
    private val now = Instant.parse("2030-01-01T11:30:00Z").toEpochMilli()
    private fun state(currency: GameCurrency = GameCurrency.GEMS, gems: String? = "100", saved: Boolean = false): ArmyUiState {
        val original = TrainingFinishSpec.intent(WALLET, terms.copy(expectedCurrency = currency))
        return ArmyUiState(
            domain = ArmyDomainState(trainingFinishReview = ReviewedTrainingFinishSpend(
                if (saved) original.nextAttempt() else original, 7, 2)),
            home = BaseState(base = BaseSnapshot.from(json("""{"baseId":"$BASE_ID","player":{"keepLevel":1}}""")),
                balances = Balances("5", "900", gems)),
            wallet = WALLET, baseId = BASE_ID)
    }
    private fun ui(state: ArmyUiState = state(), busy: Boolean = false, allowed: Boolean = true, clock: Long = now) =
        requireNotNull(trainingFinishGemSpendUi(state, 7, busy, allowed, clock, armedAtMs = now))

    @Test fun `original Gems upper bound is explicit and after balance is never invented`() {
        val ui = ui()
        assertEquals(Currency.GEMS, ui.price.currency)
        assertEquals("Up to 37", ui.price.amount)
        assertEquals(PriceStatus.OK, ui.price.status)
        assertNull(ui.after)
        assertEquals(ForgeAction.CONFIRM, gemSpendPrimaryLook(ui).action)
        assertTrue(requireNotNull(ui.price.description).contains("may decrease"))
    }

    @Test fun `KEEP and absent review leave the Gems Seal unmounted`() {
        assertNull(trainingFinishGemSpendUi(state(GameCurrency.KEEP), 7, false, true, now, now))
        assertNull(trainingFinishGemSpendUi(state().copy(domain = ArmyDomainState()), 7, false, true, now, now))
    }

    @Test fun `wallet base and selection generation retain the original identity gates`() {
        val original = state()
        for (changed in listOf(original.copy(wallet = "other"), original.copy(wallet = null),
            original.copy(baseId = null), original.copy(baseId = terms.queue.first().id))) {
            assertNull(trainingFinishGemSpendUi(changed, 7, false, true, now, now))
        }
        assertNull(trainingFinishGemSpendUi(original, 8, false, true, now, now))
    }

    @Test fun `stripped exact currency marker cannot render payable consent`() {
        val state = state()
        val original = state.domain.trainingFinishReview!!
        val stripped = original.copy(intent = original.intent.copy(expectedCurrency = null))
        assertNull(trainingFinishGemSpendUi(state.copy(domain = state.domain.copy(trainingFinishReview = stripped)),
            7, false, true, now, now))
    }

    // Rewritten 2026-10-06 (owner Seeker screenshot 17:24, "a black developer interface"): this pinned the kingdom id and every
    // frozen row's ISO instants on the Seal. The rule it guarded stays: the Seal describes the WHOLE reviewed queue, not the
    // current army. Now in player words: the troop count of the frozen queue and when its last troop finishes.
    @Test fun `whole reviewed queue remains original when current army has changed`() {
        val original = state()
        val changed = original.copy(domain = original.domain.copy(army = ArmyState.from(json("""{"queue":[]}"""))))
        val ui = ui(changed)
        assertEquals("2 troops", ui.subjectLine)
        assertEquals("Up to 37", ui.price.amount)
        val visible = requireNotNull(ui.consentDetails).lines()
        assertEquals("Your kingdom", visible.first())
        assertTrue(visible.contains("2 troops · finishes in 1h 30m"))
        // The price's consent names the same whole queue, clock-free (see the tail-timer test).
        assertTrue(requireNotNull(ui.price.description).contains("Your kingdom 2 troops Finish this reviewed queue"))
        assertSame(original.domain.trainingFinishReview, changed.domain.trainingFinishReview)
    }

    // Owner 2026-10-06 17:24: no id and no server instant reaches the Seal in any state it can be drawn in.
    @Test fun `no kingdom id row id or ISO instant reaches any Seal string`() {
        val named = state().let { it.copy(home = it.home.copy(base = BaseSnapshot.from(
            json("""{"baseId":"$BASE_ID","player":{"keepLevel":1,"name":"Stormhold"}}""")))) }
        for ((label, ui) in listOf("fresh" to ui(), "saved" to ui(state(saved = true)), "busy" to ui(busy = true),
            "paused" to ui(allowed = false), "named" to ui(named), "after the tail" to ui(clock = Instant.parse("2030-01-01T13:01:00Z").toEpochMilli()))) {
            gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.RawSealText.assertPlayerWords(label, gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.RawSealText.ui(ui))
        }
        assertEquals("Kingdom · Stormhold", ui(named).consentDetails!!.lines().first())
        assertTrue(ui(clock = Instant.parse("2030-01-01T13:01:00Z").toEpochMilli()).consentDetails!!.contains("2 troops · finishes now"))
        // The KEEP dialog reads the same lines.
        gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.RawSealText.assertPlayerWords("KEEP dialog",
            trainingFinishConsentLines(terms, true, named.home.base, now, "the shown currency"))
    }

    // The words changed, the consent did not: the saved request still carries every frozen row id and instant, byte for byte,
    // and drawing the Seal neither rebuilds nor alters it (K155: what is sent is what was reviewed).
    @Test fun `the frozen request body still compares unchanged after the Seal is drawn`() {
        val state = state(); val intent = state.domain.trainingFinishReview!!.intent; val before = intent.body.toString()
        ui(state); ui(state, busy = true); trainingFinishConsentLines(terms, false, state.home.base, now, "Gems")
        assertEquals(before, state.domain.trainingFinishReview!!.intent.body.toString())
        assertEquals(TrainingFinishSpec.intent(WALLET, terms).body, intent.body)
        terms.queue.forEach { row -> listOf(row.id, row.startedAt, row.finishesAt).forEach { assertTrue(it, before.contains(it)) } }
        assertEquals(terms, gg.pixelkingdomwars.nativeclient.ui.army.trainingFinishReviewTerms(state))
    }

    @Test fun `saved review labels reuse and retains the same intent and idempotency key`() {
        val state = state(saved = true)
        val intent = state.domain.trainingFinishReview!!.intent
        val ui = ui(state)
        assertEquals("2 troops · saved", ui.subjectLine)
        assertTrue(requireNotNull(ui.price.description).contains("same saved payment and key"))
        assertTrue(requireNotNull(ui.consentDetails).contains("same saved payment and key"))
        assertSame(intent, state.domain.trainingFinishReview!!.intent)
        assertEquals("original-training-key", intent.idempotencyKey)
    }

    @Test fun `busy and both existing order gates prohibit confirmation`() {
        val busy = ui(busy = true)
        assertEquals(MoneyStage.SENDING, busy.stage)
        assertNull(busy.price.description)
        assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(busy).action)
        for (denied in listOf(ui(allowed = false), ui(state().copy(ordersAllowed = false)))) {
            assertEquals(PriceStatus.UNAVAILABLE, denied.price.status)
            assertNull(denied.price.description)
            assertTrue(requireNotNull(denied.unavailableReason).contains("37 Gems"))
            assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(denied).action)
        }
    }

    @Test fun `unknown Gems remain unknown without borrowing KEEP or changing owner admission`() {
        for (gems in listOf(null, "", "-1", "1.5", "01", "broken", "1".repeat(33))) {
            val ui = ui(state(gems = gems))
            assertEquals("…", ui.have)
            assertNull(ui.short)
            assertEquals(PriceStatus.OK, ui.price.status)
            assertEquals(ForgeAction.CONFIRM, gemSpendPrimaryLook(ui).action)
        }
    }

    @Test fun `a balance below original maximum cannot block a naturally cheaper saved payment`() {
        for (gems in listOf("0", "30")) {
            val ui = ui(state(gems = gems, saved = true))
            assertEquals(gems, ui.have)
            assertNull(ui.short)
            assertEquals("Up to 37", ui.price.amount)
            assertEquals(ForgeAction.CONFIRM, gemSpendPrimaryLook(ui).action)
        }
    }

    @Test fun `unbound Home balance does not cross into the reviewed kingdom`() {
        val original = state()
        for (base in listOf(null, original.home.base!!.copy(baseId = terms.queue.first().id))) {
            assertEquals("…", ui(original.copy(home = original.home.copy(base = base))).have)
        }
    }

    @Test fun `large whole Gems balances remain exact strings`() {
        assertEquals("123,456,789,012,345,678,901", ui(state(gems = "123456789012345678901")).have)
    }

    @Test fun `tail timer is display only and never makes original consent FREE`() {
        val before = ui()
        val after = ui(clock = Instant.parse("2030-01-01T13:01:00Z").toEpochMilli())
        assertEquals("1h 30m", before.timeLeft)
        assertEquals("0s", after.timeLeft)
        assertNull(before.progress)
        assertEquals(before.price, after.price)
        assertEquals(now, after.quotedAtMs)
        assertEquals(now, after.armedAtMs)
        assertNotEquals(PriceStatus.SERVER_ZERO, after.price.status)
    }

    @Test fun `a whole queue does not invent a specific troop portrait or level`() {
        assertEquals("TRAINING", ui().subjectName)
        assertEquals("shape:unknown", ui().subjectArt)
        assertFalse(ui().subjectLine.contains("Lv"))
    }

    @Test fun `original visible consent survives busy and paused presentation`() {
        val original = requireNotNull(ui().consentDetails)
        assertTrue(original.contains("may decrease"))
        assertEquals(original, ui(busy = true).consentDetails)
        assertEquals(original, ui(allowed = false).consentDetails)
    }
}
