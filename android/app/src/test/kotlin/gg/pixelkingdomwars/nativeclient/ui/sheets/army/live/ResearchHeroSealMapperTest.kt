package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.baseJson
import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.ReviewedHeroSpend
import gg.pixelkingdomwars.nativeclient.data.ReviewedResearchSpend
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.GameCurrency
import gg.pixelkingdomwars.nativeclient.model.ResearchSpeedupIntent
import gg.pixelkingdomwars.nativeclient.ops.HeroRecoverySpec
import gg.pixelkingdomwars.nativeclient.ops.HeroUpgradeSpec
import gg.pixelkingdomwars.nativeclient.ops.InterruptedIntent
import gg.pixelkingdomwars.nativeclient.ops.PendingIntent
import gg.pixelkingdomwars.nativeclient.ops.ResearchSpec
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterUiState
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ForgeAction
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.gemSpendPrimaryLook
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class ResearchHeroSealMapperTest {
    private val now = Instant.parse("2030-01-01T11:30:00Z").toEpochMilli()
    private val deadline = "2030-01-01T12:00:00Z"
    private val terms = ResearchSpeedupIntent("highlander", BASE_ID, "original-research-key", GameCurrency.GEMS, 1, 2, deadline, null, "37")
    /** The Home read of the reviewed kingdom, owned by the reviewed wallet: the only read whose Gems the Seals may show. */
    private val currentBase = BaseSnapshot.from(baseJson())
    private fun research(currency: GameCurrency = GameCurrency.GEMS, gems: String? = "100", saved: Boolean = false): ArmyUiState {
        val original = ResearchSpec.intent(WALLET, terms.copy(expectedCurrency = currency))
        return ArmyUiState(domain = ArmyDomainState(researchReview = ReviewedResearchSpend(if (saved) original.nextAttempt() else original, 4, 9)),
            home = BaseState(base = currentBase, balances = Balances("9", "900", gems)), wallet = WALLET, baseId = BASE_ID)
    }
    private fun upgrade(currency: String = "GEMS") = HeroUpgradeSpec.intent(WALLET, BASE_ID, "theodor", "original-theodor-key", 5, "260", currency)
    private fun recovery(currency: String = "GEMS") = HeroRecoverySpec.intent(WALLET, BASE_ID, "theodor", "original-recovery-key", "18", deadline, currency)
    private fun hero(intent: PendingIntent = upgrade(), gems: String? = "400") = RosterUiState(
        domain = ArmyDomainState(heroReview = ReviewedHeroSpend(intent, 4), heroesBaseId = BASE_ID),
        home = BaseState(base = currentBase, balances = Balances("9", "900", gems)), selectedHero = "vex")
    private fun researchUi(source: ArmyUiState = research(), busy: Boolean = false, allowed: Boolean = true, time: Long = now) =
        requireNotNull(researchGemSpendUi(source, 4, allowed, busy, time, now))
    private fun heroUi(source: RosterUiState = hero(), busy: Boolean = false, time: Long = now) =
        requireNotNull(heroGemSpendUi(source, busy, time, now))

    @Test fun `research shows original maximum identity deadline and currency without predicting after balance`() {
        val ui = researchUi()
        assertEquals("Up to 37", ui.price.amount)
        assertEquals(PriceStatus.OK, ui.price.status)
        assertNull(ui.after)
        assertEquals("30m", ui.timeLeft)
        // Rewritten 2026-10-06 (owner 17:24, "a black developer interface"): this pinned the kingdom id, the ISO deadline and
        // the episode words on the Seal. The reviewed kingdom and completion are still shown, in player words; the frozen
        // id, deadline and episode stay in the request ResearchSpec compares (see the frozen-request test below).
        assertTrue(ui.consentDetails!!.lines().contains("Your kingdom"))
        assertTrue(ui.consentDetails!!.lines().contains("Research completes in 30m"))
        assertEquals(ForgeAction.CONFIRM, gemSpendPrimaryLook(ui).action)
    }

    @Test fun `research and hero Seals never print a kingdom id or a server instant and leave the frozen request unchanged`() {
        val r = research(); val rBody = r.domain.researchReview!!.intent.body.toString()
        val h = hero(recovery()); val hBody = h.domain.heroReview!!.intent.body.toString()
        for ((label, ui) in listOf("research" to researchUi(r), "research saved" to researchUi(research(saved = true)),
            "research paused" to researchUi(allowed = false), "upgrade" to heroUi(), "recovery" to heroUi(h))) {
            gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.RawSealText.assertPlayerWords(label, gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.RawSealText.ui(ui))
        }
        assertEquals(rBody, r.domain.researchReview!!.intent.body.toString())
        assertTrue(rBody.contains(BASE_ID)); assertTrue(rBody.contains(deadline))
        assertEquals(ResearchSpec.intent(WALLET, terms).body, r.domain.researchReview!!.intent.body)
        assertEquals(hBody, h.domain.heroReview!!.intent.body.toString()); assertEquals(deadline, HeroRecoverySpec.recoveryUntil(h.domain.heroReview!!.intent))
    }

    @Test fun `research KEEP no review malformed identity and changed wallet base or generation yield no Gems Seal`() {
        assertNull(researchGemSpendUi(research(GameCurrency.KEEP), 4, true, false, now, now))
        assertNull(researchGemSpendUi(research().copy(domain = ArmyDomainState()), 4, true, false, now, now))
        for (source in listOf(research().copy(wallet = "different"), research().copy(baseId = null), research().copy(baseId = "different")))
            assertNull(researchGemSpendUi(source, 4, true, false, now, now))
        assertNull(researchGemSpendUi(research(), 5, true, false, now, now))
        val original = research().domain.researchReview!!
        val changed = research().copy(domain = ArmyDomainState(researchReview = original.copy(intent = original.intent.copy(expectedCurrency = "KEEP"))))
        assertNull(researchGemSpendUi(changed, 4, true, false, now, now))
    }

    @Test fun `saved research preserves same intent key and visible recovery wording`() {
        val source = research(saved = true)
        val original = source.domain.researchReview!!.intent
        val ui = researchUi(source)
        assertTrue(ui.consentDetails!!.contains("same saved payment and key"))
        assertSame(original, source.domain.researchReview!!.intent)
        assertEquals("original-research-key", original.idempotencyKey)
    }

    @Test fun `local clock cannot reprice original research or invent natural completion as free payment`() {
        val before = researchUi()
        val later = researchUi(time = Instant.parse("2030-01-01T12:01:00Z").toEpochMilli())
        assertEquals(before.price, later.price)
        assertEquals(before.quotedAtMs, later.quotedAtMs)
        assertNotEquals(PriceStatus.SERVER_ZERO, later.price.status)
    }

    @Test fun `balance display never adds a new maximum affordability or top up gate`() {
        for (gems in listOf(null, "bad", "1", "100")) {
            val ui = researchUi(research(gems = gems))
            assertEquals(ForgeAction.CONFIRM, gemSpendPrimaryLook(ui).action)
            assertNull(ui.short)
            assertNull(ui.after)
        }
        assertEquals("…", researchUi(research(gems = "01")).have)
        assertEquals("123,456,789,012,345,678,901", researchUi(research(gems = "123456789012345678901")).have)
    }

    @Test fun `Gems on hand show only for a Home read of the reviewed kingdom and wallet`() {
        // The Seal prints "You have N Gems" beside a real maximum; another kingdom's or account's balance there would
        // misstate what this payment draws on, so an unproven read stays unknown while the confirm gates stay as they were.
        assertEquals("100", researchUi().have)
        assertEquals("400", heroUi().have)
        val otherOwner = currentBase.copy(player = currentBase.player.copy(wallet = "different"))
        for (base in listOf(null, otherOwner, BaseSnapshot.from(baseJson("11111111-2222-4333-8444-555555555555")))) {
            val ui = researchUi(research().let { it.copy(home = it.home.copy(base = base)) })
            assertEquals("…", ui.have)
            assertEquals(ForgeAction.CONFIRM, gemSpendPrimaryLook(ui).action)
        }
        // A Home read of another kingdom already closes the hero Seal; an unread or foreign-owned read keeps it, unnumbered.
        for (base in listOf(null, otherOwner))
            assertEquals("…", heroUi(hero().let { it.copy(home = it.home.copy(base = base)) }).have)
    }

    @Test fun `research original orders and allowed gates remain disabled and busy is sending`() {
        assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(researchUi(allowed = false)).action)
        assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(researchUi(research().copy(ordersAllowed = false))).action)
        assertEquals(MoneyStage.SENDING, researchUi(busy = true).stage)
        assertNull(researchUi(busy = true).price.description)
    }

    @Test fun `instant Theodor upgrade follows reviewed hero and level without timer or invented duration`() {
        val ui = heroUi()
        assertEquals("THEODOR", ui.subjectName)
        assertEquals("Lv 4 → 5", ui.subjectLine)
        assertEquals("UPGRADE", ui.confirmLabel)
        assertFalse(ui.showTiming)
        assertNull(ui.timeLeft)
        assertNull(ui.progress)
        assertNull(ui.after)
        assertEquals("Up to 260", ui.price.amount)
        assertTrue(ui.consentDetails!!.contains("cannot switch to KEEP"))
    }

    @Test fun `hero recovery pins original injury and upper bound while local rest time advances`() {
        val source = hero(recovery())
        val before = heroUi(source)
        val later = heroUi(source, time = now + 60_000)
        assertTrue(before.showTiming)
        assertEquals("30m", before.timeLeft)
        assertEquals("29m", later.timeLeft)
        assertEquals(before.price, later.price)
        assertNull(before.progress)
        // Rewritten 2026-10-06 (owner 17:24): the original injury end is shown as time left, not as its ISO instant.
        assertTrue(before.consentDetails!!.lines().contains("The injury ends in 30m"))
        assertTrue(later.consentDetails!!.lines().contains("The injury ends in 29m"))
    }

    @Test fun `hero KEEP missing review changed base malformed intent and unknown currency cannot become Gems consent`() {
        assertNull(heroGemSpendUi(hero(upgrade("KEEP")), false, now, now))
        assertNull(heroGemSpendUi(hero(upgrade().copy(expectedCurrency = null)), false, now, now))
        assertNull(heroGemSpendUi(hero().copy(domain = ArmyDomainState()), false, now, now))
        assertNull(heroGemSpendUi(hero().copy(domain = hero().domain.copy(heroesBaseId = "different")), false, now, now))
        assertNull(heroGemSpendUi(hero(upgrade().copy(path = "/wrong")), false, now, now))
    }

    @Test fun `hero original saved payment orders and busy gates remain enforced`() {
        assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(heroUi(hero().copy(ordersAllowed = false))).action)
        val pending = hero().copy(interrupted = listOf(InterruptedIntent(recovery().nextAttempt())))
        assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(heroUi(pending)).action)
        assertEquals(MoneyStage.SENDING, heroUi(busy = true).stage)
    }
}
