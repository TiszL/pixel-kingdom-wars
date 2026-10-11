package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import gg.pixelkingdomwars.nativeclient.data.PlaytestBounds
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.PlaytestCampaign
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The event rules open in place over the Event card (event.png header INFO, SPEC R2.2). WHY these cases matter: every
 * number in a rule must be the catalogue's or the server's (a guessed cap or bonus would mislead play that the server then
 * does not count), the surface never shows money amounts or whitelist wording (SPEC R2.2 finance and wording rule), and a
 * saved request is only pointed to, never resolved here, because its owner is the campaign page.
 */
class EventRulesPanelTest {
    private val stamp = "2026-09-12T00:00:00.000Z"
    private val founding = "founding-kingdoms"
    private val rewarded = "rewarded-playtest"
    private val bounds = PlaytestBounds(founding, rewarded, "Founding", "Rewarded", 14, 30000, 3, 25, 2, mapOf("feedback" to 40, "gameplay" to 60))

    private fun campaign(id: String = founding, checkpoint: String = "null", prizes: String = "[]", spots: String = "null") =
        PlaytestCampaign.from(json("""{"id":"$id","kind":"${if (id == founding) "founding" else "rewarded"}","name":"Founding Kingdoms",
        "phase":"running","startAt":"$stamp","endAt":"2026-09-26T00:00:00.000Z","registrationOpen":true,"revision":1,
        "reconciledAt":null,"snapshotAt":null,"checkpoint":$checkpoint,"spots":$spots,"stale":false,"measurementSince":null,
        "participant":null,"standings":[],"founders":[],"winners":[],"prizes":$prizes,"ownSubmissions":[]}"""))

    private val verified = """{"count":212,"target":300,"frozen":false,"available":true,
        "verification":{"status":"verified","lastSuccessAt":"$stamp","lastAttemptAt":"$stamp"}}"""
    private val prizes = """[{"id":"ladder","title":"Gameplay ladder","amountUsd":250,"category":"gameplay","metric":"points"}]"""
    private val spots = """{"reserved":40,"ranked":60,"total":100}"""

    @Test fun `no catalogue rules means no panel so no rule is drawn from a guessed number`() {
        assertNull(eventRulesUi(campaign(), null, pendingRequest = false))
        assertNull(eventRulesUi(null, null, pendingRequest = true))
    }

    @Test fun `founding rules carry the server checkpoint and the campaign page wording`() {
        val ui = eventRulesUi(campaign(checkpoint = verified), bounds, pendingRequest = false)!!
        assertEquals("RULES", ui.title)
        assertEquals(listOf(
            "Campaign points start fresh. Lifetime tester points keep growing separately.",
            "Automatic participation",
            "Checkpoint 212 / 300",
            "Verified original minters keep their guaranteed spots after selling. Other ranked spots require deed eligibility at close. The server determines eligibility and awards.",
        ), ui.lines)
    }

    @Test fun `an unverified checkpoint says the server retries and never shows a made up count`() {
        val unavailable = """{"count":null,"target":300,"frozen":false,"available":false,
            "verification":{"status":"unavailable","lastSuccessAt":null,"lastAttemptAt":"$stamp"}}"""
        val lines = eventRulesUi(campaign(checkpoint = unavailable), bounds, pendingRequest = false)!!.lines
        assertTrue(lines.contains("Checkpoint verification is unavailable. The server will retry verification."))
        assertFalse(lines.any { it.startsWith("Checkpoint ") && it.contains(" / ") })
        // A frozen checkpoint says so; the count and target are the server's.
        val frozen = verified.replace("\"frozen\":false", "\"frozen\":true")
        assertTrue(eventRulesUi(campaign(checkpoint = frozen), bounds, false)!!.lines.contains("Checkpoint 212 / 300 · held until launch"))
        // Before the first read there is no checkpoint line at all rather than a guessed state.
        assertFalse(eventRulesUi(null, bounds, false)!!.lines.any { it.startsWith("Checkpoint") })
    }

    @Test fun `rewarded rules take the bonus days points revenge cap and video weights from the catalogue`() {
        val lines = eventRulesUi(campaign(rewarded), bounds, pendingRequest = false)!!.lines
        assertTrue(lines.contains("Only activity after launch and your participation counts. Play on 3 distinct UTC days to earn 25 lifetime points once."))
        assertTrue(lines.any { it.startsWith("Revenge counts up to 2 wins per opposing wallet per UTC day.") })
        assertEquals("feedback: 40% · gameplay: 60%", lines.last())
        // Changing the catalogue changes the rule: the numbers are read, not written into the panel.
        val other = bounds.copy(bonusDays = 5, bonusPoints = 70, revengeWinsPerOpponentDay = 4, videoWeights = emptyMap())
        val changed = eventRulesUi(campaign(rewarded), other, false)!!.lines
        assertTrue(changed.contains("Only activity after launch and your participation counts. Play on 5 distinct UTC days to earn 70 lifetime points once."))
        assertTrue(changed.any { it.startsWith("Revenge counts up to 4 wins per opposing wallet per UTC day.") })
        assertFalse("an empty weight table draws no blank line", changed.any { it.isBlank() })
        // The founding-only lines never leak into the rewarded rules.
        assertFalse(lines.contains("Automatic participation"))
    }

    @Test fun `no rule line shows a money amount or whitelist wording`() {
        // The server sends USD prize amounts and spot counts; SPEC R2.2 keeps both off the surface.
        listOf(campaign(checkpoint = verified, prizes = prizes, spots = spots), campaign(rewarded, prizes = prizes, spots = spots), null).forEach { shown ->
            val lines = eventRulesUi(shown, bounds, pendingRequest = true)!!.lines
            assertTrue(lines.isNotEmpty())
            assertFalse(lines.toString(), lines.any { '$' in it })
            assertFalse(lines.toString(), lines.any { it.contains("whitelist", ignoreCase = true) })
            assertFalse(lines.toString(), lines.any { it.contains("250") })
        }
    }

    @Test fun `the saved request row shows only while a request waits and the rules stay readable`() {
        val waiting = eventRulesUi(campaign(), bounds, pendingRequest = true)!!
        assertEquals("A saved event request needs checking.", waiting.savedRequest)
        assertNull(eventRulesUi(campaign(), bounds, pendingRequest = false)!!.savedRequest)
        assertEquals(eventRulesUi(campaign(), bounds, false)!!.lines, waiting.lines)
    }

    @Test fun `the header INFO opens the rules in place and the campaign page keeps only saved request recovery`() {
        // event.png: INFO is the rules over the card. A hop to the old campaign page would put the retired screen back on
        // the player path; OPEN on a saved request is the one road there because that page owns the request.
        val hub = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/community/EventHub.kt").readText()
        assertFalse(hub.contains("onRules = { act(onCampaign) }"))
        assertTrue(hub.contains("onRules = ::openRules"))
        assertTrue(hub.contains("EventRulesPanel(rules, onClose = { rulesOpen = false }"))
        assertTrue(hub.contains("onSavedRequest = { rulesOpen = false; act(onCampaign) }"))
        assertTrue(hub.contains("BackHandlerAt(BackPriority.SHEET, enabled = rulesShown) { rulesOpen = false }"))
    }
}
