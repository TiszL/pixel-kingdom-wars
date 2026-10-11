package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.ReviewedBuilderFinishSpend
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ops.ConstructionSpec
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.model.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ForgeAction
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.gemSpendPrimaryLook
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class BuilderFinishSealTest {
    private val terms = BuilderJobSpeedupIntent("22222222-2222-4222-8222-222222222222", BASE_ID,
        "original-builder-key", GameCurrency.GEMS, BuilderJobSpeedupConsent("upgrade",
            "33333333-3333-4333-8333-333333333333", null,
            "2030-01-01T11:00:00.000Z", "2030-01-01T12:00:00.000Z", "37"))
    private val now = Instant.parse("2030-01-01T11:30:00Z").toEpochMilli()
    private fun state(currency: GameCurrency = GameCurrency.GEMS, gems: String? = "100", saved: Boolean = false): KingdomUiState {
        val original = ConstructionSpec.builderIntent(WALLET, terms.copy(expectedCurrency = currency))
        return KingdomUiState(home = BaseState(balances = Balances("5", "900", gems),
            builderFinishReview = ReviewedBuilderFinishSpend(if (saved) original.nextAttempt() else original, 2, 1)),
            wallet = WALLET, selectedBaseId = BASE_ID, baseGeneration = 2)
    }
    private fun ui(state: KingdomUiState = state(), busy: Boolean = false, clock: Long = now) =
        requireNotNull(gemSpendUi(state, busy, clock, armedAtMs = now))

    @Test fun `Gems consent shows the original maximum and never claims an exact remaining balance`() {
        val ui = ui()
        assertEquals(Currency.GEMS, ui.price.currency)
        assertEquals("Up to 37", ui.price.amount)
        assertEquals(PriceStatus.OK, ui.price.status)
        assertTrue(requireNotNull(ui.price.description).contains("may decrease"))
        assertNull(ui.after)
        assertEquals(ForgeAction.CONFIRM, gemSpendPrimaryLook(ui).action)
    }

    @Test fun `KEEP stays with its original dialog and no review yields no Seal`() {
        assertNull(gemSpendUi(state(GameCurrency.KEEP), false, now, now))
        assertNull(gemSpendUi(state().copy(home = BaseState()), false, now, now))
    }

    @Test fun `wallet base and generation changes cannot lend consent to another context`() {
        val original = state()
        for (changed in listOf(original.copy(wallet = "other"), original.copy(selectedBaseId = null),
            original.copy(selectedBaseId = terms.jobId), original.copy(baseGeneration = 3))) {
            assertNull(gemSpendUi(changed, false, now, now))
        }
    }

    @Test fun `saved review names the same payment and does not mutate the original intent`() {
        val original = state(saved = true)
        val intent = original.home.builderFinishReview!!.intent
        assertEquals("Same saved payment", ui(original).subjectLine)
        assertEquals("Up to 37", ui(original).price.amount)
        assertSame(intent, original.home.builderFinishReview!!.intent)
        assertEquals("original-builder-key", intent.idempotencyKey)
    }

    @Test fun `unknown or malformed Gems never borrow the KEEP balance or enable confirmation`() {
        for (gems in listOf(null, "", "-1", "1.5", "01", "broken")) {
            val ui = ui(state(gems = gems))
            assertEquals("…", ui.have)
            assertEquals(PriceStatus.UNAVAILABLE, ui.price.status)
            assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(ui).action)
        }
    }

    @Test fun `short Gems show the shortfall but cannot offer an unmounted GET GEMS door`() {
        val ui = ui(state(gems = "30"))
        assertEquals("30", ui.have)
        assertEquals("7", ui.short)
        assertEquals(PriceStatus.UNAVAILABLE, ui.price.status)
        assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(ui).action)
    }

    @Test fun `large whole balances stay exact strings`() {
        assertEquals("123,456,789,012,345,678,901", ui(state(gems = "123456789012345678901")).have)
    }

    @Test fun `busy or denied orders cannot expose a confirm action`() {
        assertEquals(MoneyStage.SENDING, ui(busy = true).stage)
        assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(ui(busy = true)).action)
        for (denied in listOf(state().copy(ordersAllowed = false), state().copy(deedActionsAllowed = false))) {
            assertEquals(PriceStatus.UNAVAILABLE, ui(denied).price.status)
            assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(ui(denied)).action)
        }
    }

    @Test fun `display clock advances progress without requoting or inventing free completion`() {
        val before = ui()
        val after = ui(clock = Instant.parse("2030-01-01T12:01:00Z").toEpochMilli())
        assertEquals(0.5f, requireNotNull(before.progress), 0f)
        assertEquals(1f, requireNotNull(after.progress), 0f)
        assertEquals(before.price, after.price)
        assertEquals(before.quotedAtMs, after.quotedAtMs)
        assertNotEquals(PriceStatus.SERVER_ZERO, after.price.status)
    }
    // Rewritten 2026-10-06 (owner: no old building icons). The Seal's icon path (GfIcon → CraftIcon → PkwIcon) now draws
    // every building art the shared rule owns, so the Phase E stills, the Keep strip and the pack tier sprites reach the
    // well; the reason the old case gave ("cannot render Phase E ui portraits") no longer holds. What must still hold:
    // a blank or unresolvable name never leaves an empty well.
    @Test fun `Seal well draws every shared building art and an unknown glyph for anything it cannot draw`() {
        for (art in listOf(null, "", "  ", "ui:not-a-building-art")) {
            assertEquals("shape:unknown", gemSpendSubjectArt(art))
        }
        for (art in listOf("ui:workshop-t1-idle", "ui:harv-crownlands-t1-idle", "ui:berth-starter-intact", "ui:keep-l7-idle",
            "pack:barracks-t2", "ui_portrait_keep_t1")) {
            assertEquals(art, gemSpendSubjectArt(art))
        }
    }
    @Test fun `disabled Seal never announces payable consent and keeps its maximum in the refusal reason`() {
        for (state in listOf(state(gems = "30"), state(gems = null), state().copy(ordersAllowed = false))) {
            val ui = ui(state)
            assertNull(ui.price.description)
            assertTrue(requireNotNull(ui.unavailableReason).contains("37 Gems"))
            assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(ui).action)
        }
        assertNull(ui(busy = true).price.description)
        assertEquals("Up to 37", ui(busy = true).price.amount)
    }
    // Owner 2026-10-06 17:24 ("a black developer interface"): the KEEP builder confirm printed "Kingdom <id>", "job <id>" and
    // the two frozen ISO instants. It now names the kingdom and the building and says the time left; the Gems Seal never
    // printed them. The saved request keeps every frozen id and instant for the repository's comparison.
    @Test fun `the builder confirm and Seal speak player words while the frozen request keeps the job identity`() {
        val home = BaseSnapshot.from(gg.pixelkingdomwars.nativeclient.json(gg.pixelkingdomwars.nativeclient.baseJson().toString()
            .replace("\"name\":\"\"", "\"name\":\"Stormhold\"").replace("eee0575f-6df7-4672-91ea-33f497d2e1d6", terms.consent.buildingId!!)))
        val named = state(GameCurrency.KEEP).let { it.copy(home = it.home.copy(base = home)) }
        val keepTerms = terms.copy(expectedCurrency = GameCurrency.KEEP)
        assertEquals("Kingdom · Stormhold\n${gg.pixelkingdomwars.nativeclient.network.trayLabel("keep")} · upgrade", builderFinishSubjectLine(named, keepTerms))
        assertEquals("Your kingdom\nUpgrade", builderFinishSubjectLine(state(GameCurrency.KEEP), keepTerms))
        gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.RawSealText.assertPlayerWords("builder", listOf(
            builderFinishSubjectLine(named, keepTerms), builderFinishSubjectLine(state(), terms),
            gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.sealTimeFromNow(terms.consent.finishesAt, now)) +
            gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.RawSealText.ui(ui()) +
            gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.RawSealText.ui(ui(state(saved = true))))
        val original = named.home.builderFinishReview!!.intent; val before = original.body.toString()
        builderFinishSubjectLine(named, keepTerms)
        assertEquals(before, named.home.builderFinishReview!!.intent.body.toString())
        assertEquals(keepTerms, ConstructionSpec.builderTerms(original))
    }
}
