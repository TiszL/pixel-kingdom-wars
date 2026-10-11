package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.data.DivineFragmentFixtures
import gg.pixelkingdomwars.nativeclient.data.DivineFragmentJournal
import gg.pixelkingdomwars.nativeclient.data.DivineFragmentState
import gg.pixelkingdomwars.nativeclient.data.DivineJournal
import gg.pixelkingdomwars.nativeclient.data.DivineSavedEvent
import gg.pixelkingdomwars.nativeclient.data.DivineTrialFixtures
import gg.pixelkingdomwars.nativeclient.data.DivineTrialState
import gg.pixelkingdomwars.nativeclient.divine.dobj
import gg.pixelkingdomwars.nativeclient.divinefragments.fo
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.TRIALS_STANDINGS
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.TRIALS_THIS_WEEK
import java.io.File
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The designed Divine sheets are the home over the original owners: a saved trial, attempt result, prize or delivery is
 * never hidden behind them, they draw no clock-derived or invented label, and their primaries act only when the owners'
 * own fences allow (the in-place decisions are pinned in DivineInPlaceTest). */
class DivineSheetAdaptersTest {
    private fun trial(attempts: List<JsonObject> = emptyList(), participant: Boolean = true, prize: JsonObject? = null): DivineTrialState {
        val f = DivineTrialFixtures
        val saved = DivineSavedEvent(f.rules.raw, f.event, if (participant) f.participant(attempts = attempts, prize = prize) else null)
        return DivineTrialState(DivineJournal(identity = f.identity(), events = listOf(saved)), selectedId = saved.id)
    }
    private fun completed(n: Int) = DivineTrialFixtures.change(DivineTrialFixtures.complete, "id",
        JsonPrimitive("00000000-0000-4000-8000-${(100 + n).toString().padStart(12, '0')}"))
    private fun awardPage(): JsonObject {
        val f = DivineFragmentFixtures
        return f.page(listOf(buildJsonObject { put("award", f.award); put("delivery", JsonNull) }))
    }
    private fun saved(sent: Boolean): DivineFragmentState {
        val f = DivineFragmentFixtures
        return DivineFragmentState(journal = DivineFragmentJournal(identity = f.identity(), commands = listOf(f.command().copy(sent = sent))),
            awards = awardPage())
    }
    private fun source(path: String): String {
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path"
        return listOf(File(relative), File("app/$relative")).first { it.isFile }.readText()
    }

    @Test fun `a retained trial recovery always forces the original screen`() {
        // A committed attempt's result is unknown; only the original screen can check it, so the sheet must step aside.
        val display = divineTrialsDisplay(trial(listOf(DivineTrialFixtures.committed)))
        assertFalse(display.recovery.isEmpty())
        assertTrue(divineTrialsOriginalRequired(display, review = false))
        // Even if drawn, the designed primary could not send a second try.
        assertEquals(CommandState.DISABLED, divineTrialsUi(display, false).primary.state)
    }

    @Test fun `a planned attempt is planned on the designed home and a fresh trial keeps it too`() {
        val planned = divineTrialsDisplay(trial(listOf(DivineTrialFixtures.admitted)))
        assertNotNull(planned.planAttemptId)
        // Rewritten for owner 2026-10-06 'every detail of the new interface': an admitted attempt is planned in place on the
        // designed sheet (PLAN & FIGHT opens the original DivineTrialBattle there), so it no longer forces the original screen.
        assertFalse(divineTrialsOriginalRequired(planned, review = false))
        assertEquals("Its try is already used, so planning it stays open", CommandState.ENABLED, divineTrialsUi(planned, false).primary.state)
        val fresh = divineTrialsDisplay(trial())
        assertFalse("Nothing saved: the designed sheet is the home", divineTrialsOriginalRequired(fresh, review = false))
        assertTrue("A tap that asks for the original always gets it", divineTrialsOriginalRequired(fresh, review = true))
    }

    @Test fun `an unclaimed sponsor prize forces the original screen where it is claimed`() {
        val waiting = trial(prize = buildJsonObject { put("claim", JsonNull) })
        assertTrue(divineTrialPrizeWaiting(waiting))
        assertTrue(divineTrialsOriginalRequired(divineTrialsDisplay(waiting), divineTrialPrizeWaiting(waiting)))
        val claimed = trial(prize = buildJsonObject { put("claim", buildJsonObject { put("claimedAt", "2035-01-15T00:00:00.000Z") }) })
        assertFalse(divineTrialPrizeWaiting(claimed))
        assertFalse(divineTrialPrizeWaiting(trial()))
        assertFalse(divineTrialPrizeWaiting(null))
    }

    @Test fun `the trials sheet shows no clock derived or invented week countdown standings or prize copy`() {
        val display = divineTrialsDisplay(trial(listOf(DivineTrialFixtures.complete)))
        assertNotNull("The event has an end time, and the sheet still does not count down from the device clock", display.playEndsAt)
        val ui = divineTrialsUi(display, false)
        assertEquals(UNKNOWN, ui.week)
        assertNull(ui.endsIn)
        assertNull(ui.lastWeek)
        assertNull(ui.standings)
        assertEquals(UNKNOWN, ui.prizeLine)
        // The cutoff and its title come from the retained rules, not the design's placeholder.
        val sites = DivineTrialFixtures.rules.policy.getValue("divineSites").jsonPrimitive.int
        assertEquals(sites, ui.cutoff)
        assertEquals("WHAT THE TOP $sites WIN", ui.prizeTitle)
        assertFalse(ui.footnote.contains("Monday"))
    }

    @Test fun `standings are a locked tab because no standings feed exists`() {
        val ui = divineTrialsUi(divineTrialsDisplay(trial()), false)
        assertEquals(TRIALS_THIS_WEEK, ui.tab)
        assertTrue(ui.tabs.single { it.id == TRIALS_STANDINGS }.locked)
        assertFalse(ui.tabs.single { it.id == TRIALS_THIS_WEEK }.locked)
        assertTrue(TRIAL_STANDINGS_CLOSED.isNotBlank())
    }

    @Test fun `BEST appears only with a replay id`() {
        val best = divineTrialsUi(divineTrialsDisplay(trial(listOf(DivineTrialFixtures.complete))), false)
        assertEquals("BEST", best.replay?.caption)
        assertEquals(CommandState.ENABLED, best.replay?.state)
        assertNull(divineTrialsUi(divineTrialsDisplay(trial()), false).replay)
        assertNull(divineTrialsUi(divineTrialsDisplay(trial(listOf(DivineTrialFixtures.committed))), false).replay)
    }

    @Test fun `PLAN and FIGHT opens the original flow unless no try remains and then says why`() {
        val open = divineTrialsUi(divineTrialsDisplay(trial()), false).primary
        assertEquals(CommandState.ENABLED, open.state); assertNull(open.reason)
        // Unknown participation is not "no tries": the original screen refreshes it, so the door opens.
        assertEquals(CommandState.ENABLED, divineTrialsUi(divineTrialsDisplay(trial(participant = false)), false).primary.state)
        val allowance = DivineTrialFixtures.rules.policy.getValue("attemptsPerWallet").jsonPrimitive.int
        val spent = divineTrialsDisplay(trial(List(allowance) { completed(it) }))
        assertEquals(0, spent.triesLeft)
        val refused = divineTrialsUi(spent, false).primary
        assertEquals(CommandState.DISABLED, refused.state)
        assertEquals(spent.primary.reason, refused.reason)
    }

    @Test fun `no chosen trial says so instead of drawing an empty army`() {
        val none = divineTrialsDisplay(DivineTrialState())
        assertNull(none.eventId)
        assertNotNull(divineTrialsUi(none, false).emptyLine)
        assertNull("While the journal loads, the skeleton is shown instead", divineTrialsUi(none, true).emptyLine)
        assertNull(divineTrialsUi(divineTrialsDisplay(trial()), false).emptyLine)
    }

    @Test fun `every troop of the fixed army gets a portrait so the minis are never blank wells`() {
        val state = trial()
        val portraits = divineTrialPortraits(state, null)
        assertEquals(DivineTrialFixtures.rules.policy.dobj("army").keys, portraits.keys)
        assertTrue(portraits.values.all { it.isNotBlank() })
        assertTrue(divineTrialsDisplay(state, portraits).army.all { it.portrait.isNotBlank() })
        assertTrue(divineTrialPortraits(DivineTrialState(), null).isEmpty())
    }

    @Test fun `a saved fragment request always forces the original screen`() {
        val f = DivineFragmentFixtures
        for (sent in listOf(false, true)) {
            val display = divineFragmentsDisplay(saved(sent), f.base, true)
            assertFalse(display.recovery.isEmpty())
            assertTrue(divineFragmentsOriginalRequired(display, review = false))
        }
        val clean = divineFragmentsDisplay(DivineFragmentState(awards = awardPage(), available = true), f.base, true)
        assertFalse(divineFragmentsOriginalRequired(clean, review = false))
        assertTrue(divineFragmentsOriginalRequired(clean, review = true))
    }

    @Test fun `feature off with saved commands still forces the original so recovery stays visible`() {
        val f = DivineFragmentFixtures
        // The sheet's feature-off body returns before its recovery rows; only the original may draw this state.
        val display = divineFragmentsDisplay(saved(true), f.base, false)
        assertFalse(display.featureOff)
        assertTrue(divineFragmentsOriginalRequired(display, review = false))
        val nothing = divineFragmentsDisplay(DivineFragmentState(), f.base, false)
        assertTrue(nothing.featureOff)
        assertFalse(divineFragmentsOriginalRequired(nothing, review = false))
        assertTrue(divineFragmentsUi(nothing, UNKNOWN, false, false, f.base).featureOff)
        assertFalse("A read in flight is not proof the feature is off", divineFragmentsUi(nothing, UNKNOWN, true, false, f.base).featureOff)
    }

    @Test fun `no wallet wide waiting total is ever shown`() {
        val f = DivineFragmentFixtures
        val state = DivineFragmentState(awards = awardPage(), claims = f.page(listOf(f.raw.fo("entitlement"))), available = true)
        val display = divineFragmentsDisplay(state, f.base, true)
        assertEquals(2, display.waiting.size)
        val ui = divineFragmentsUi(display, UNKNOWN, false, true, f.base)
        assertNull(ui.waitingLine)
        assertEquals("DELIVER", ui.primary.caption)
        assertEquals(display.waiting.map { it.ui }, ui.waiting)
    }

    @Test fun `DELIVER opens the original review only with deliveries open and a kingdom chosen`() {
        val f = DivineFragmentFixtures
        val state = DivineFragmentState(awards = awardPage(), available = true)
        val ready = divineFragmentsUi(divineFragmentsDisplay(state, f.base, true), UNKNOWN, false, true, f.base).primary
        assertEquals(CommandState.ENABLED, ready.state); assertNull(ready.reason)
        val noKingdom = divineFragmentsDisplay(state, null, true)
        val refused = divineFragmentsUi(noKingdom, UNKNOWN, false, true, null)
        assertEquals(CommandState.DISABLED, refused.primary.state)
        assertEquals(noKingdom.primary.reason, refused.primary.reason)
        assertEquals("No kingdom selected", refused.destination.sub)
        val off = divineFragmentsDisplay(state.copy(available = false), f.base, false)
        assertEquals(CommandState.DISABLED, divineFragmentsUi(off, UNKNOWN, false, false, f.base).primary.state)
    }

    @Test fun `a routine refresh keeps the rows already shown`() {
        val f = DivineFragmentFixtures
        val shown = divineFragmentsUi(divineFragmentsDisplay(DivineFragmentState(awards = awardPage(), available = true), f.base, true),
            UNKNOWN, false, true, f.base)
        val rereading = divineFragmentsUi(divineFragmentsDisplay(DivineFragmentState(available = true, busy = true), f.base, true),
            UNKNOWN, true, true, f.base)
        assertTrue(rereading.waiting.isEmpty())
        assertSame(shown, divineRoutineUi(shown, rereading, loading = true))
        assertSame(rereading, divineRoutineUi(shown, rereading, loading = false))
        assertSame("The very first read has nothing to keep", rereading, divineRoutineUi(null, rereading, loading = true))
    }

    @Test fun `PLAN and FIGHT names the try it will use or the admitted one it plans`() {
        // The frame's "try 2 of 3": the player must see which try a tap uses before it is used.
        assertEquals("try 1 of 3", divineTrialsUi(divineTrialsDisplay(trial()), false).primary.sub)
        assertEquals("try 2 of 3", divineTrialsUi(divineTrialsDisplay(trial(listOf(completed(0)))), false).primary.sub)
        // An admitted attempt is the try being planned, not a new one.
        assertEquals("try 1 of 3", divineTrialsUi(divineTrialsDisplay(trial(listOf(DivineTrialFixtures.admitted))), false).primary.sub)
        val allowance = DivineTrialFixtures.rules.policy.getValue("attemptsPerWallet").jsonPrimitive.int
        assertNull("No try left: no try is named", divineTrialsUi(divineTrialsDisplay(trial(List(allowance) { completed(it) })), false).primary.sub)
        assertNull("Unknown participation names no try", divineTrialsUi(divineTrialsDisplay(trial(participant = false)), false).primary.sub)
    }

    @Test fun `DELIVER is off with the SPEC reason when nothing is waiting but never while a read runs`() {
        val f = DivineFragmentFixtures
        val empty = divineFragmentsDisplay(DivineFragmentState(awards = f.page(emptyList()), claims = f.page(emptyList()), available = true), f.base, true)
        val off = divineFragmentsUi(empty, UNKNOWN, false, true, f.base).primary
        assertEquals(CommandState.DISABLED, off.state)
        assertEquals(DIVINE_FRAGMENTS_NOTHING_WAITING, off.reason)
        // Empty because the pages are still being read is not "nothing waiting".
        assertFalse(divineFragmentsUi(empty, UNKNOWN, true, true, f.base).primary.reason == DIVINE_FRAGMENTS_NOTHING_WAITING)
    }

    @Test fun `a kingdom name is drawn only when the host knows it`() {
        val f = DivineFragmentFixtures
        val display = divineFragmentsDisplay(DivineFragmentState(awards = awardPage(), available = true), f.base, true)
        val named = divineFragmentsUi(display, "Ironhold", false, true, f.base)
        assertEquals("into Ironhold's stores", named.primary.sub)
        assertEquals("Ironhold", named.destination.name)
        // No name source: no "into …'s stores", and INTO says where the kingdom is chosen instead of a placeholder name.
        val unnamed = divineFragmentsUi(display, UNKNOWN, false, true, f.base)
        assertNull(unnamed.primary.sub)
        assertEquals("Your selected kingdom", unnamed.destination.name)
        assertEquals("Choose another in Your Bases", unnamed.destination.sub)
    }

    @Test fun `the registrations draw the designed home and hand the original the same arguments`() {
        val trials = source("ui/phasee/DivineTrialRegistration.kt")
        assertTrue(trials.contains("DivineTrialsHome(model,account.selectedBaseId,allowed,foreground&&!ordinary,content,"))
        assertFalse(trials.contains("DivineTrialScreen("))
        val fragments = source("ui/phasee/DivineFragmentRegistration.kt")
        assertTrue(fragments.contains("DivineFragmentsHome(model,account.selectedBaseId,"))
        assertFalse(fragments.contains("DivineFragmentScreen("))
        // The original screens stay the review owner behind the designed bodies.
        val bodies = source("ui/phasee/DivineDesignedBodies.kt")
        assertTrue(bodies.contains("DivineTrialScreen(model, selectedBase, allowed, foreground, content, identity)"))
        assertTrue(bodies.contains("DivineFragmentScreen(model, selectedBase, allowed)"))
    }
}
