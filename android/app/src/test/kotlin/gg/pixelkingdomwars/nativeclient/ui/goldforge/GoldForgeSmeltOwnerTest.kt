package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.data.MiningContributionReview
import gg.pixelkingdomwars.nativeclient.data.MiningContributionState
import gg.pixelkingdomwars.nativeclient.miningcontribution.*
import gg.pixelkingdomwars.nativeclient.ui.economy.MINING_CONTRIBUTION_CONSENT
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.SmeltState
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.StepState
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.StepUi
import java.util.Locale
import org.junit.Assert.*
import org.junit.Test

/** Tests written before the owner presentation; execution belongs to Cedar3. */
class GoldForgeSmeltOwnerTest {
    private val wallet = "11111111111111111111111111111112"
    private val base = "00000000-0000-4000-8000-000000000001"
    private val key = "00000000-0000-4000-8000-000000000002"
    private val identity = MiningContributionIdentity("https://example.invalid", "devnet", wallet)
    private val scope = GoldForgeSmeltScope(wallet, base, 7)
    private fun view() = MiningContributionView(wallet, base, 3, "2026-10-05", "2026-10-05T04:00:00.000Z",
        true, "free", "100", "20", "80", true,
        miningContributionResourceIds(3).map { MiningContributionStock(it, if (it == "forge_ingot" || it == "shards") "30" else "0", "7") },
        MiningConsistencyPolicy(7, 17, 119))
    private fun state() = MiningContributionState(MiningContributionJournal(1, identity, 0, null, emptyList()), view(), advertised = true)
    private fun command() = MiningContributionCommand.review(identity, view(), key, listOf(MiningContributionLine("forge_ingot", "3")))
    private fun operation(proof: MiningContributionProof? = null) = MiningContributionOperation(command(), null, proof, null)
    private fun proof() = command().let { command -> MiningContributionProof(wallet, key, "2026-10-05T04:00:00.000Z", "accepted",
        MiningContributionReceipt(key, "00000000-0000-4000-8000-000000000003", wallet, "2026-10-05", command.request,
            command.lines, command.totalValue, "2026-10-05T03:59:00.000Z"), null) }
    private fun mapped(s: MiningContributionState = state(), quantities: Map<String, String> = emptyMap()) =
        goldForgeSmeltOwnerUi(s, scope, quantities, null, true, false, false, 123L)

    @Test fun `current stock maps selectable tiles and exact server values`() {
        val ui = requireNotNull(mapped(mapOfState(), mapOf("forge_ingot" to "3")).body)
        assertEquals(SmeltState.CHOOSING, ui.state); assertEquals("21", ui.basketValue)
        assertEquals("100", ui.cap); assertEquals("20", ui.committed)
        assertEquals(listOf("forge_ingot", "shards"), ui.tiles.map { it.resourceId })
        assertEquals(3, ui.tiles.first().chosen); assertEquals(CommandState.ENABLED, ui.primary.state)
        assertNull(ui.raidDays); assertNull(ui.estimate)
    }
    private fun mapOfState() = state()

    @Test fun `MAX subtracts other basket value before applying server stock and cap`() {
        val result = goldForgeSmeltSelect(view(), mapOf("shards" to "2"), "forge_ingot", GoldForgeSmeltEdit.MAX)
        assertEquals("9", result?.get("forge_ingot")); assertEquals("2", result?.get("shards"))
    }
    @Test fun `over allowance tap refuses rather than silently clamping`() {
        assertNull(goldForgeSmeltSelect(view(), mapOf("forge_ingot" to "11"), "forge_ingot", GoldForgeSmeltEdit.ADD))
    }
    @Test fun `minus and remove retain unrelated basket lines`() {
        val q = mapOf("forge_ingot" to "3", "shards" to "2")
        assertEquals(mapOf("forge_ingot" to "2", "shards" to "2"), goldForgeSmeltSelect(view(), q, "forge_ingot", GoldForgeSmeltEdit.MINUS))
        assertEquals(mapOf("shards" to "2"), goldForgeSmeltSelect(view(), q, "forge_ingot", GoldForgeSmeltEdit.REMOVE))
    }
    @Test fun `unknown stock wrong wallet and wrong base cannot form a new basket`() {
        assertNull(mapped(state().copy(view = null)).body)
        assertNull(mapped(state().copy(view = view().copy(wallet = "11111111111111111111111111111113"))).body)
        assertNull(mapped(state().copy(view = view().copy(baseId = key))).body)
    }
    @Test fun `paused and development locks keep authoritative body and disabled spend`() {
        assertEquals(SmeltState.PAUSED, mapped(state().copy(view = view().copy(acceptingContributions = false))).body?.state)
        assertEquals(SmeltState.NOT_READY, mapped(state().copy(view = view().copy(developmentReady = false))).body?.state)
        val ui = goldForgeSmeltOwnerUi(state(), scope, mapOf("forge_ingot" to "1"), null, false, false, false, 0)
        assertEquals(CommandState.DISABLED, ui.body?.primary?.state)
    }
    @Test fun `saved unconfirmed and attempted baskets never become HELD`() {
        for (saved in listOf(operation(), operation().copy(attemptRevision = 1))) {
            val ui = mapped(state().copy(journal = state().journal.copy(operation = saved)))
            assertTrue(ui.held.isEmpty()); assertNull(ui.body); assertNotNull(ui.savedMessage)
        }
    }
    // Rewritten for the in-place SMELT (night S1): A4 kept an accepted receipt off the designed body (body was null). The
    // smelt-held frame now draws it, so a matching accepted original with a current view maps to the HELD body. The rule
    // that matters is unchanged: only the exact accepted proof makes a basket HELD, and no raid qualification is claimed.
    @Test fun `only matching accepted original proof establishes HELD and never qualification`() {
        val ui = mapped(state().copy(journal = state().journal.copy(operation = operation(proof()))))
        assertEquals(command().lines, ui.held); assertEquals(SmeltState.HELD, ui.body?.state)
        assertTrue(requireNotNull(ui.savedMessage).contains("qualification"))
        val bad = proof().copy(wallet = "11111111111111111111111111111113")
        val refused = mapped(state().copy(journal = state().journal.copy(operation = operation(bad))))
        assertTrue(refused.held.isEmpty()); assertNull(refused.body)
    }
    @Test fun `settled proof no longer displays reserved resources`() {
        for (outcome in listOf("returned", "consumed")) {
            val ui = mapped(state().copy(journal = state().journal.copy(operation = operation(proof().copy(
                settlement = MiningContributionSettlement(outcome, "2026-10-05T04:00:00.000Z"))))))
            assertTrue(ui.held.isEmpty()); assertTrue(requireNotNull(ui.savedMessage).contains(outcome))
        }
    }
    // Rewritten for the designed Seal (night S1): A4 put MINING_CONTRIBUTION_CONSENT in the box label beside its own new
    // "I accept these basket terms." The frame label now sits on the box and the full existing sentence is the Seal body
    // (SPEC §9 fallback), so the player still reads the exact legal text before ticking.
    @Test fun `Seal uses exact frozen review and full existing consent`() {
        val review = MiningContributionReview(command(), view(), 3, 7)
        val state = state().copy(review = review, journal = state().journal.copy(operation = operation()))
        val ui = goldForgeSmeltOwnerUi(state, scope, emptyMap(), null, true, false, true, 123)
        assertEquals("3 items", ui.seal?.items); assertEquals("21", ui.seal?.worth)
        assertEquals(MINING_CONTRIBUTION_CONSENT, ui.seal?.consentBody); assertTrue(ui.seal?.consent == true)
    }
    @Test fun `event guards reject ABA wallet base lifecycle pause busy and withdrawn admission`() {
        assertTrue(goldForgeSmeltActionCurrent(scope, scope, state(), true, false, true))
        for (changed in listOf(scope.copy(generation = 9), scope.copy(wallet = "other"), scope.copy(baseId = key)))
            assertFalse(goldForgeSmeltActionCurrent(scope, changed, state(), true, false, true))
        assertFalse(goldForgeSmeltActionCurrent(scope, scope, state(), false, false, true))
        assertFalse(goldForgeSmeltActionCurrent(scope, scope, state(), true, true, true))
        assertFalse(goldForgeSmeltActionCurrent(scope, scope, state(), true, false, false))
        assertFalse(goldForgeSmeltActionCurrent(scope, scope, state().copy(busy = true), true, false, true))
    }
    @Test fun `confirmation requires identical current review and matching generation`() {
        val review = MiningContributionReview(command(), view(), 3, 7)
        val s = state().copy(review = review)
        assertTrue(goldForgeSmeltActionCurrent(scope, scope, s, true, false, true, review))
        assertFalse(goldForgeSmeltActionCurrent(scope, scope, s, true, false, true, review.copy()))
        assertFalse(goldForgeSmeltActionCurrent(scope, scope, s.copy(review = review.copy(generation = 8)), true, false, true, review))
    }
    @Test fun `large quantities remain exact with explicit non tile rows`() {
        val huge = "9007199254740993"
        val v = view().copy(pool = "deed", dailyCapValue = null, remainingValue = null,
            resources = view().resources.map { if (it.resourceId == "forge_ingot") it.copy(available = huge) else it })
        val ui = mapped(state().copy(view = v), mapOf("forge_ingot" to huge))
        assertEquals(huge, ui.largeBasket.single().quantity)
        // Rewritten for the frame's grouped numbers (night S1): A4 showed the raw string. Every digit is still shown.
        assertEquals("63,050,394,783,186,951", ui.body?.basketValue)
        assertEquals(0, ui.body?.tiles?.first()?.chosen)
    }
    @Test fun `closed or busy owner cannot expose a confirmable Seal`() {
        val review = MiningContributionReview(command(), view(), 3, 7)
        val s = state().copy(review = review, journal = state().journal.copy(operation = operation()))
        assertNull(goldForgeSmeltOwnerUi(s, scope, emptyMap(), null, false, false, true, 123).seal)
        assertNull(goldForgeSmeltOwnerUi(s, scope.copy(generation = 8), emptyMap(), null, true, false, true, 123).seal)
        assertTrue(goldForgeSmeltOwnerUi(s.copy(busy = true), scope, emptyMap(), null, true, true, true, 123, sending = true).seal?.sending == true)
    }
    @Test fun `a busy read or review preparation is not labelled as a sending contribution`() {
        val review = MiningContributionReview(command(), view(), 3, 7)
        val s = state().copy(review = review, busy = true, journal = state().journal.copy(operation = operation()))
        assertNull(goldForgeSmeltOwnerUi(s, scope, emptyMap(), null, true, true, false, 123).seal)
    }
    @Test fun `consent belongs to the exact frozen review object`() {
        val review = MiningContributionReview(command(), view(), 3, 7)
        assertTrue(goldForgeSmeltConsentCurrent(review, review, true))
        assertFalse(goldForgeSmeltConsentCurrent(review.copy(), review, true))
        assertFalse(goldForgeSmeltConsentCurrent(review, review, false))
        assertFalse(goldForgeSmeltConsentCurrent(null, null, true))
    }
    @Test fun `replacement owner with equal wallet and base retires outgoing callbacks`() {
        val first = scope.copy(owner = Any())
        assertFalse(goldForgeSmeltActionCurrent(first, first.copy(owner = Any()), state(), true, false, true))
    }
    @Test fun `stock disappearing leaves exact removable basket rows`() {
        val v = view().copy(resources = view().resources.map { if (it.resourceId == "forge_ingot") it.copy(available = "0") else it })
        val ui = mapped(state().copy(view = v), mapOf("forge_ingot" to "3"))
        assertEquals(listOf(MiningContributionLine("forge_ingot", "3")), ui.largeBasket)
        assertEquals(CommandState.DISABLED, ui.body?.primary?.state)
        assertEquals(emptyMap<String, String>(), goldForgeSmeltSelect(v, mapOf("forge_ingot" to "3"), "forge_ingot", GoldForgeSmeltEdit.REMOVE))
    }
    @Test fun `sending review consumes back without dismissing its owner`() {
        val review = MiningContributionReview(command(), view(), 3, 7)
        assertFalse(goldForgeSmeltMayDismiss(review, review))
        assertTrue(goldForgeSmeltMayDismiss(review, null))
    }
    @Test fun `resource removed by a server policy change remains removable`() {
        val olderPolicy = view().copy(policyVersion = 2, resources = view().resources.filter { it.resourceId in miningContributionResourceIds(2) })
        assertEquals(emptyMap<String, String>(), goldForgeSmeltSelect(olderPolicy, mapOf("climate_kit" to "1"), "climate_kit", GoldForgeSmeltEdit.REMOVE))
    }

    // ---- Night S1: the designed SMELT faces (smelt.png, smelt-seal.png, smelt-held.png) ----

    private fun held() = state().copy(journal = state().journal.copy(operation = operation(proof())))
    private fun settled(outcome: String) = state().copy(journal = state().journal.copy(operation = operation(proof().copy(
        settlement = MiningContributionSettlement(outcome, "2026-10-05T04:00:00.000Z")))))

    /** The player must see the basket they committed and the one thing left to do (win a raid), all from the receipt. */
    @Test fun `accepted unsettled receipt draws the designed held face`() {
        val ui = requireNotNull(mapped(held()).body)
        assertEquals(SmeltState.HELD, ui.state)
        assertEquals(listOf(StepUi("Basket", "held", StepState.DONE), StepUi("Raid", "win today", StepState.NOW),
            StepUi("Coins", "midnight", StepState.TODO)), ui.steps)
        val tile = requireNotNull(ui.held).single()
        assertEquals("forge_ingot", tile.resourceId); assertEquals(3, tile.chosen); assertEquals("x3", tile.have)
        assertEquals("FIND A RAID", ui.primary.caption); assertEquals(Verb.RED, ui.primary.verb)
        assertEquals(CommandState.ENABLED, ui.primary.state)
        // The server sends no estimate and no counted raid days: the cards fall back to their no-data lines.
        assertNull(ui.estimate); assertNull(ui.raidDays)
    }

    /** No receipt field proves a raid was won, so the face must never tell the player their basket counts. */
    @Test fun `the held face never claims a won raid`() {
        for (busy in listOf(false, true)) for (running in listOf(false, true)) for (allowed in listOf(false, true)) {
            val body = goldForgeSmeltOwnerUi(held().copy(busy = busy), scope, emptyMap(), null, allowed, running, false, 0).body
            assertNotEquals(SmeltState.QUALIFIED, body?.state)
        }
    }

    /** Without today's view the held face would show stale load numbers; the exact receipt goes to its recovery controls. */
    @Test fun `held receipt without a current view stays with its recovery controls`() {
        val ui = mapped(held().copy(view = null))
        assertNull(ui.body); assertEquals(command().lines, ui.held)
    }

    /** A settled basket must be acknowledged (filed) before a new one: the callout says what happened and nothing is addable. */
    @Test fun `a consumed settlement offers the melted callout and closes the tiles until filed`() {
        val ui = requireNotNull(mapped(settled("consumed")).body)
        assertEquals(true, ui.result?.melted); assertEquals("Yesterday's basket melted into KEEP", ui.result?.line)
        assertEquals(SmeltState.PAUSED, ui.state); assertTrue(ui.tiles.isNotEmpty()); assertTrue(ui.tiles.none { it.canAdd })
        assertEquals(CommandState.DISABLED, ui.primary.state)
        assertEquals("Tap the result above to file it, then choose a new basket.", ui.primary.reason)
    }

    /** A returned basket must never read as melted into KEEP. */
    @Test fun `a returned settlement says the basket came back`() {
        val ui = requireNotNull(mapped(settled("returned")).body)
        assertEquals(false, ui.result?.melted); assertEquals("Yesterday's basket came back", ui.result?.line)
        assertTrue(ui.tiles.none { it.canAdd })
    }

    /** The legal sentence and the risk line are existing repository wording and must reach the Seal verbatim. */
    @Test fun `the Seal shows the frame label over the full existing consent and risk sentences`() {
        val review = MiningContributionReview(command(), view(), 3, 7)
        val s = state().copy(review = review, journal = state().journal.copy(operation = operation()))
        val seal = requireNotNull(goldForgeSmeltOwnerUi(s, scope, emptyMap(), null, true, false, false, 123).seal)
        assertEquals("Yes, melt it if it mints coins", seal.consentText)
        assertEquals(MINING_CONTRIBUTION_CONSENT, seal.consentBody)
        assertEquals("Rewards depend on qualification and your share of the daily pool. KEEP is not guaranteed.", seal.riskLine)
        assertEquals(MINING_CONTRIBUTION_RISK, seal.riskLine)
    }

    /** The frame groups numbers ("1,800 of 5,000"); the bar must still be filled from the server's exact values. */
    @Test fun `values display grouped while the fills use the raw server numbers`() {
        val v = view().copy(dailyCapValue = "5000", committedValue = "1800", remainingValue = "3200",
            resources = view().resources.map { if (it.resourceId == "forge_ingot") it.copy(unitValue = "1800") else it })
        val ui = requireNotNull(mapped(state().copy(view = v), mapOf("forge_ingot" to "1")).body)
        assertEquals("1,800", ui.committed); assertEquals("5,000", ui.cap); assertEquals("1,800", ui.basketValue)
        assertEquals(0.36f, ui.committedFill, 0.0001f); assertEquals(0.36f, ui.basketFill, 0.0001f)
        assertEquals("1,800", ui.tiles.first { it.resourceId == "forge_ingot" }.unitValue)
        assertEquals("1 item", ui.primary.sub)
    }

    /** The header shows the server's UTC day the way the frame does ("2 Oct"), never a device date. */
    @Test fun `the mining day reads as the frame shows it`() {
        assertEquals("2 Oct", goldForgeSmeltDay("2026-10-02", Locale.ENGLISH))
        val ui = goldForgeSmeltOwnerUi(state(), scope, emptyMap(), null, true, false, false, 0, locale = Locale.ENGLISH)
        assertEquals("5 Oct", ui.body?.day)
        assertEquals("not-a-day", goldForgeSmeltDay("not-a-day", Locale.ENGLISH))
    }

    /** Tiles show stock the way the frame does and never round a count up past what the server holds. */
    @Test fun `tile counts read as the frame shows them`() {
        val v = view().copy(resources = view().resources.map { when (it.resourceId) {
            "forge_ingot" -> it.copy(available = "6"); "shards" -> it.copy(available = "40943"); "crownsteel" -> it.copy(available = "14")
            else -> it
        } })
        assertEquals(listOf("x6", "40.9K", "x14"), requireNotNull(mapped(state().copy(view = v)).body).tiles.map { it.have })
        assertEquals("x38", goldForgeSmeltHave("storm_ore", "38"))
        assertEquals("x12K", goldForgeSmeltHave("crownsteel", "12345"))
        assertEquals("999", goldForgeSmeltHave("shards", "999"))
    }

    /** The choosing face uses the frame's step words, not A4's "qualify today" / "settlement". */
    @Test fun `the choosing steps use the frame words`() {
        assertEquals(listOf(StepUi("Basket", "fill it now", StepState.NOW), StepUi("Raid", "win today", StepState.TODO),
            StepUi("Coins", "midnight", StepState.TODO)), requireNotNull(mapped().body).steps)
    }

    /** When stock runs out under a chosen line, its tile stays so the designed take-back can still remove it in place. */
    @Test fun `a chosen line keeps its tile after its stock runs out`() {
        val v = view().copy(resources = view().resources.map { if (it.resourceId == "forge_ingot") it.copy(available = "0") else it })
        val tile = requireNotNull(mapped(state().copy(view = v), mapOf("forge_ingot" to "3")).body).tiles.first { it.resourceId == "forge_ingot" }
        assertEquals(3, tile.chosen); assertEquals("x0", tile.have); assertFalse(tile.canAdd)
        assertTrue(requireNotNull(mapped(state().copy(view = v)).body).tiles.none { it.resourceId == "forge_ingot" })
    }
}
