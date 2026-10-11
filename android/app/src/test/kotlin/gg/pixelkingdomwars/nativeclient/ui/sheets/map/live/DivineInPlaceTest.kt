package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.data.DivineFragmentCommand
import gg.pixelkingdomwars.nativeclient.data.DivineFragmentFixtures
import gg.pixelkingdomwars.nativeclient.data.DivineFragmentJournal
import gg.pixelkingdomwars.nativeclient.data.DivineFragmentState
import gg.pixelkingdomwars.nativeclient.data.DivineJournal
import gg.pixelkingdomwars.nativeclient.data.DivineSavedEvent
import gg.pixelkingdomwars.nativeclient.data.DivineTrialFixtures
import gg.pixelkingdomwars.nativeclient.data.DivineTrialState
import gg.pixelkingdomwars.nativeclient.divinefragments.fo
import gg.pixelkingdomwars.nativeclient.divinefragments.ft
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.phasee.fragmentSourceSummary
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.DELIVER_CHECK_FIRST
import java.io.File
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** SOLO TRIALS and CRYSTAL FRAGMENTS act in place (owner 2026-10-06). These decisions pick what one tap asks the original
 *  owner for: a delivered earning is never offered again, a try is never spent where the planner should only open, the
 *  Seal says exactly what the original review dialog said, and nothing is requested while a saved request waits. */
class DivineInPlaceTest {
    private val f = DivineFragmentFixtures
    private val t = DivineTrialFixtures

    private fun row(award: JsonObject, delivered: Boolean) = buildJsonObject {
        put("award", award)
        put("delivery", if (delivered) buildJsonObject { put("quantity", award.ft("net")) } else JsonNull)
    }
    private fun award(n: Int) = JsonObject(f.award + ("eventId" to JsonPrimitive(f.id(n))))
    private fun fragments(awards: List<JsonObject>? = emptyList(), claims: List<JsonObject>? = emptyList(),
        commands: List<DivineFragmentCommand> = emptyList()) =
        DivineFragmentState(journal = DivineFragmentJournal(identity = f.identity(), commands = commands),
            awards = awards?.let { f.page(it) }, claims = claims?.let { f.page(it) }, available = true)
    private val entitlement get() = f.raw.fo("entitlement")

    private fun trial(attempts: List<JsonObject> = emptyList(), entry: Boolean = true, participant: Boolean = true,
        closed: Boolean = false): DivineTrialState {
        val event = if (closed) JsonObject(t.event + ("terminal" to buildJsonObject {})) else t.event
        val saved = DivineSavedEvent(t.rules.raw, event, if (participant) t.participant(e = if (entry) t.entry else null, attempts = attempts) else null)
        return DivineTrialState(DivineJournal(identity = t.identity(), events = listOf(saved)), selectedId = saved.id)
    }
    private fun completed(n: Int) = t.change(t.complete, "id", JsonPrimitive("00000000-0000-4000-8000-${(100 + n).toString().padStart(12, '0')}"))
    private fun source(path: String): String {
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path"
        return listOf(File(relative), File("app/$relative")).first { it.isFile }.readText()
    }

    // ---- DELIVER ----

    @Test fun `DELIVER targets the first undelivered earning and never one that already has a delivery`() {
        // A delivered row sits first on the page; DELIVER must skip it, or the player would be asked to resend an earning.
        val state = fragments(listOf(row(award(9), delivered = true), row(f.award, delivered = false)))
        assertEquals(f.award.ft("eventId"), divineDeliverTarget(state))
        assertNull("Everything delivered: nothing to review", divineDeliverTarget(fragments(listOf(row(f.award, delivered = true)))))
        assertNull("An unread page is not a list of earnings", divineDeliverTarget(fragments(awards = null)))
        assertNull(divineDeliverTarget(null))
    }

    @Test fun `an earning whose receipt this device already holds is not offered again from a stale page`() {
        // The awards page can predate a delivery this same owner already confirmed.
        val done = f.command().let { it.copy(receipt = f.receipt(it)) }
        assertNull(divineDeliverTarget(fragments(listOf(row(f.award, delivered = false)), commands = listOf(done))))
    }

    @Test fun `a Seeker share is reviewed only after every earning and only as the owner's own page row`() {
        val both = fragments(listOf(row(f.award, delivered = false)), listOf(entitlement))
        assertEquals(FragmentDeliverStep.Deliver(f.award.ft("eventId")), divineFragmentDeliverStep(both, f.base, allowed = true))
        // The owner admits a share only if this exact row is on its claims page, so the target is that row.
        val shares = fragments(listOf(row(f.award, delivered = true)), listOf(entitlement))
        assertEquals(entitlement, divineShareTarget(shares))
        assertEquals(FragmentDeliverStep.Claim(entitlement), divineFragmentDeliverStep(shares, f.base, allowed = true))
        // A server zero is shown nowhere as READY and is never reviewed.
        val zero = fragments(claims = listOf(JsonObject(entitlement + ("claimable" to JsonPrimitive("0")))))
        assertNull(divineShareTarget(zero))
        assertEquals(FragmentDeliverStep.Explain(DIVINE_FRAGMENTS_NOTHING_WAITING), divineFragmentDeliverStep(zero, f.base, allowed = true))
    }

    @Test fun `DELIVER asks nothing of the owner while a request is saved, actions are off or no kingdom is chosen`() {
        val ready = fragments(listOf(row(f.award, delivered = false)))
        // A saved request is checked before another one: never a second request beside it.
        val saved = fragments(listOf(row(f.award, delivered = false)), commands = listOf(f.command()))
        assertEquals(FragmentDeliverStep.Explain(DELIVER_CHECK_FIRST), divineFragmentDeliverStep(saved, f.base, allowed = true))
        val paused = divineFragmentDeliverStep(ready, f.base, allowed = false)
        assertTrue(paused is FragmentDeliverStep.Explain)
        val noKingdom = divineFragmentDeliverStep(ready, null, allowed = true)
        assertTrue(noKingdom is FragmentDeliverStep.Explain)
        assertNotEquals("Each refusal says its own reason", paused, noKingdom)
        // Pages still unread: the reason must not claim that nothing is waiting.
        val unread = divineFragmentDeliverStep(fragments(awards = null, claims = null), f.base, allowed = true)
        assertTrue(unread is FragmentDeliverStep.Explain)
        assertNotEquals(FragmentDeliverStep.Explain(DIVINE_FRAGMENTS_NOTHING_WAITING), unread)
    }

    // ---- The Seal ----

    @Test fun `the delivery Seal carries the original review dialog wording verbatim`() {
        val c = f.command()
        val seal = divineFragmentSealUi(c, null, 0L, busy = false, canConfirm = true)
        assertEquals("DELIVER CRYSTAL FRAGMENTS", seal.title)
        assertEquals(listOf("Deliver ${f.award.ft("net")} fragments from this original earning."), seal.lines)
        assertEquals(fragmentSourceSummary(f.award), seal.secondary)
        assertEquals(listOf("Destination kingdom: ${c.base}", "Stored fragments stay with this kingdom if its ownership changes."), seal.finePrint)
        assertEquals("DELIVER FRAGMENTS", seal.confirmLabel)
        // The pay token is the fragments this request moves, from the saved consent, never a client number.
        assertEquals(Currency.ITEM, seal.pay.currency)
        assertEquals(f.award.ft("net"), seal.pay.amount)
        assertEquals(PriceStatus.OK, seal.pay.status)
        assertEquals(UNKNOWN, seal.gets?.text)
        // The consent wording exists in the original dialog; if it is ever reworded there, this Seal must follow.
        val original = source("ui/phasee/DivineFragmentScreen.kt")
        listOf("\"DELIVER CRYSTAL FRAGMENTS\"", "fragments from this original earning.", "\"Stored fragments stay with this kingdom if its ownership changes.\"",
            "\"DELIVER FRAGMENTS\"", "\"CLAIM FRAGMENT SHARE\"",
            "\"Claim the amount currently due to this original Seeker spot. The server computes the cumulative share.\"")
            .forEach { assertTrue("The original dialog says $it", original.contains(it)) }
    }

    @Test fun `the share Seal shows no client amount because only the server computes the share`() {
        val seal = divineFragmentSealUi(f.command("claim"), "Ironhold", 0L, busy = false, canConfirm = true)
        assertEquals("CLAIM FRAGMENT SHARE", seal.title)
        assertEquals(listOf("Claim the amount currently due to this original Seeker spot. The server computes the cumulative share."), seal.lines)
        assertNull(seal.secondary)
        assertEquals("CLAIM FRAGMENT SHARE", seal.confirmLabel)
        assertNull(seal.pay.amount)
        assertEquals(PriceStatus.CHECKING, seal.pay.status)
        // A known kingdom name replaces the saved id in the destination line.
        assertEquals("Destination kingdom: Ironhold", seal.finePrint.first())
        assertEquals("IRONHOLD", seal.gets?.text)
    }

    @Test fun `the Seal never arms while the owner is sending or the review cannot be confirmed`() {
        val c = f.command()
        val ready = divineFragmentSealUi(c, null, 7L, busy = false, canConfirm = true)
        assertTrue(ready.canArm); assertEquals(MoneyStage.READY, ready.stage); assertNull(ready.waitLine); assertEquals(7L, ready.armedAtMs)
        val sending = divineFragmentSealUi(c, null, 7L, busy = true, canConfirm = true)
        assertFalse("A second tap while sending must not confirm again", sending.canArm)
        assertEquals(MoneyStage.SENDING, sending.stage)
        val refused = divineFragmentSealUi(c, null, 7L, busy = false, canConfirm = false)
        assertFalse(refused.canArm)
        // A primary that cannot arm says why instead of ignoring taps silently.
        assertNotNull(refused.waitLine)
    }

    // ---- PLAN & FIGHT ----

    @Test fun `no chosen trial or participation opens discovery in the original screen`() {
        assertEquals(TrialPlanStep.DISCOVER, divineTrialPlanStep(DivineTrialState(), t.base, allowed = true))
        assertEquals(TrialPlanStep.DISCOVER, divineTrialPlanStep(null, t.base, allowed = true))
        assertEquals(TrialPlanStep.DISCOVER, divineTrialPlanStep(trial(participant = false), t.base, allowed = true))
    }

    @Test fun `entry comes first and only while the event is open`() {
        assertEquals(TrialPlanStep.ENTER, divineTrialPlanStep(trial(entry = false), t.base, allowed = true))
        // Final results close entry: a tap explains instead of sending a request the server refuses.
        assertEquals(TrialPlanStep.EXPLAIN, divineTrialPlanStep(trial(entry = false, closed = true), t.base, allowed = true))
    }

    @Test fun `a try is used only when none is admitted and tries remain`() {
        assertEquals(TrialPlanStep.ADMIT, divineTrialPlanStep(trial(), t.base, allowed = true))
        assertEquals(TrialPlanStep.ADMIT, divineTrialPlanStep(trial(listOf(completed(0))), t.base, allowed = true))
        // An admitted attempt with tries still left is only planned: the tap must never spend a second try.
        assertEquals(TrialPlanStep.PLAN, divineTrialPlanStep(trial(listOf(t.admitted)), t.base, allowed = true))
        val allowance = t.rules.bound("attemptsPerWallet")
        assertEquals("Every try used", TrialPlanStep.EXPLAIN, divineTrialPlanStep(trial(List(allowance) { completed(it) }), t.base, allowed = true))
        // A committed attempt's result is unknown; no new try until it is checked.
        assertEquals(TrialPlanStep.EXPLAIN, divineTrialPlanStep(trial(listOf(t.committed)), t.base, allowed = true))
    }

    @Test fun `nothing is requested while trial actions are paused or no kingdom is chosen and the reason says which`() {
        for (state in listOf(trial(), trial(entry = false), trial(listOf(t.admitted)))) {
            assertEquals(TrialPlanStep.EXPLAIN, divineTrialPlanStep(state, t.base, allowed = false))
            assertEquals(TrialPlanStep.EXPLAIN, divineTrialPlanStep(state, null, allowed = true))
        }
        val paused = divineTrialPlanReason(trial(), t.base, allowed = false)
        val noKingdom = divineTrialPlanReason(trial(), null, allowed = true)
        assertTrue(paused.contains("paused"))
        assertTrue(noKingdom.contains("kingdom"))
        // Otherwise the event's own reason (final results, no tries) is shown.
        val spent = trial(List(t.rules.bound("attemptsPerWallet")) { completed(it) })
        assertEquals(divineTrialsDisplay(spent).primary.reason, divineTrialPlanReason(spent, t.base, allowed = true))
    }

    @Test fun `the designed homes act only through the existing owners`() {
        // Money and order paths stay in the owners: the homes call them and draw the original battle surface.
        val bodies = source("ui/phasee/DivineDesignedBodies.kt")
        listOf("model.delivery(", "model.claim(", "model.confirm(", "model.enter(", "model.admit(", "model.submit(", "DivineTrialBattle(", "FinePrintSeal(")
            .forEach { assertTrue("The homes call $it", bodies.contains(it)) }
        listOf("transport", ".request(", "postMoneyCommand").forEach { assertFalse("No request code in the homes: $it", bodies.contains(it)) }
    }
}
