package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.data.ArmyTrainingDraft
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.ReviewedQuote
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.ArmyState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.HeroRoster
import gg.pixelkingdomwars.nativeclient.model.TrainingPreset
import gg.pixelkingdomwars.nativeclient.model.TrainingQuote
import gg.pixelkingdomwars.nativeclient.model.TroopCount
import gg.pixelkingdomwars.nativeclient.network.TrainingScheduling
import gg.pixelkingdomwars.nativeclient.quoteJson
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import gg.pixelkingdomwars.nativeclient.ui.army.CapacityReason
import gg.pixelkingdomwars.nativeclient.ui.army.PresetDraft
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroState
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

/**
 * S1 "Barracks in place": LOAD, SAVE, TRAIN's review and the paid FINISH now happen on the Army sheet. These pin why
 * that is safe: LOAD only fills the local draft and never past the room the composer itself allows; SAVE writes only
 * what the server's saved-army rules accept; the TRAIN review shows the server quote, never the draft estimate; and the
 * host calls the existing owners instead of hopping to the legacy ArmyScreen.
 */
class ArmyBarracksInPlaceTest {
    private val now = Instant.parse("2030-01-01T00:00:30Z").toEpochMilli()
    /** [maxUnits] null leaves `TRAINING_PRESETS` out of the pack (saved armies then fail closed). */
    private fun catalogue(maxUnits: Int? = 40): JsonObject {
        val presets = if (maxUnits == null) "" else ",\"TRAINING_PRESETS\":{\"slots\":3,\"nameMaxLength\":24,\"maxCompositionUnits\":$maxUnits}"
        return json("""{"constants":{
            "TROOPS":{"highlander":{"pts":2,"costKeep":12,"trainSec":12},
                      "bowman":{"pts":1,"costKeep":10,"trainSec":9},
                      "mage":{"pts":3,"costKeep":40,"trainSec":30,"requiresKeepLevel":9},
                      "skeleton":{"pts":1,"costKeep":1,"trainSec":1,"spawnOnly":true}}$presets},
            "display":{"research":{"troops":["highlander","bowman","mage"]}}}""")
    }
    private val base = BaseSnapshot.from(json("""{"baseId":"b1","player":{"keepLevel":3},"buildings":[]}"""))

    private fun army(roster: Int = 10, capacity: Int = 20, queueCap: Int = 20, counts: String = """{"highlander":5}""") =
        ArmyState.from(json("""{"counts":$counts,"levels":{"highlander":3,"bowman":1},"queue":[],"rosterPts":$roster,"queuedPts":0,
            "campCapacityPts":$capacity,"barracksQueuePts":$queueCap}"""))

    private fun state(army: ArmyState?, presets: List<TrainingPreset>? = null, maxUnits: Int? = 40) = ArmyUiState(
        domain = ArmyDomainState(army = army, armyBaseId = "b1", armyBaseGeneration = 0L, presets = presets),
        home = BaseState(base = base), wallet = "w1", baseId = "b1", catalogue = catalogue(maxUnits))

    private fun preset(slot: Int, vararg rows: Pair<String, Int>) = TrainingPreset(slot, "Saved $slot", rows.map { TroopCount(it.first, it.second) })

    /** A reviewed quote whose DRAFT asked for 5 Bowmen, whatever the server quoted. */
    private fun reviewed(quote: JsonObject) = ReviewedQuote(ArmyTrainingDraft(WALLET, BASE_ID, mapOf("bowman" to "5")),
        TrainingQuote.from(quote), json("{}"), TrainingScheduling.SEQUENTIAL)

    // --- LOAD -----------------------------------------------------------------------------------------------------------

    @Test fun `LOAD fills only the room the composer allows and counts every saved troop that did not fit`() {
        // Camp room 10 pts (20 - 10 ready), queue room 20: four Highlanders take 8, the locked Mage cannot be drafted at all,
        // and only two Bowmen fit the last 2 pts. LOAD never overfills, so the TRAIN quote never starts from an impossible draft.
        val st = state(army(), listOf(preset(1, "highlander" to 4, "mage" to 2, "bowman" to 5)))
        val fill = requireNotNull(savedArmyFill(st, 0L, 1))
        assertEquals(listOf("highlander" to 4, "bowman" to 2), fill.quantities.toList())
        assertEquals("2 Mages and 3 Bowmen did not fit", 5, fill.dropped)
        val filled = st.copy(quantities = fill.quantities.mapValues { it.value.toString() })
        assertEquals("The filled draft uses the camp room exactly", 0, filled.room?.campFreePts)
        assertEquals("The composer itself would refuse one more troop", CapacityReason.ARMY, filled.capacityReason("bowman"))
    }

    @Test fun `LOAD also respects the queue room and the saved-army unit limit`() {
        val queueBound = state(army(roster = 0, capacity = 50, queueCap = 6), listOf(preset(1, "highlander" to 4, "bowman" to 5)))
        val byQueue = requireNotNull(savedArmyFill(queueBound, 0L, 1))
        assertEquals(mapOf("highlander" to 3), byQueue.quantities)
        assertEquals(6, byQueue.dropped)
        val unitBound = state(army(roster = 0, capacity = 50, queueCap = 50), listOf(preset(1, "highlander" to 4, "bowman" to 5)), maxUnits = 5)
        val byUnits = requireNotNull(savedArmyFill(unitBound, 0L, 1))
        assertEquals(mapOf("highlander" to 4, "bowman" to 1), byUnits.quantities)
        assertEquals(4, byUnits.dropped)
    }

    @Test fun `LOAD reads nothing from another base, another selection generation or a missing slot`() {
        // A saved army must never be trimmed against a camp the player is no longer looking at.
        val st = state(army(), listOf(preset(1, "highlander" to 1)))
        assertNotNull(savedArmyFill(st, 0L, 1))
        assertNull(savedArmyFill(st, 1L, 1))
        assertNull(savedArmyFill(st.copy(baseId = "b2"), 0L, 1))
        assertNull(savedArmyFill(st, 0L, 2))
        assertNull(savedArmyFill(state(army()), 0L, 1))
    }

    // --- SAVE -----------------------------------------------------------------------------------------------------------

    @Test fun `SAVE takes the ready camp in TRAIN order within the saved-army rules, and nothing from an empty camp`() {
        // The server refuses a plan with untrainable troops or too many units; SAVE must send only what it accepts.
        val camp = army(counts = """{"bowman":3,"skeleton":2,"highlander":5}""")
        assertEquals(listOf(TroopCount("highlander", 5), TroopCount("bowman", 3)), currentArmyPresetComposition(state(camp), 0L))
        assertEquals(listOf(TroopCount("highlander", 5), TroopCount("bowman", 1)), currentArmyPresetComposition(state(camp, maxUnits = 6), 0L))
        assertNull("No rules in the pack: saved armies fail closed", currentArmyPresetComposition(state(camp, maxUnits = null), 0L))
        assertNull(currentArmyPresetComposition(state(army(counts = "{}")), 0L))
        assertNull(currentArmyPresetComposition(state(army(counts = """{"highlander":0}""")), 0L))
        assertNull(currentArmyPresetComposition(state(camp), 3L))
    }

    @Test fun `only the slot the host is saving shows the dots, never a leftover legacy editor draft`() {
        val st = state(army(), listOf(preset(1, "highlander" to 2)))
        val saving = armyLiveUi(st, 0L, now, busy = true, savingSlot = 3).saved
        assertEquals(listOf(3), saving.filter { it.busy }.map { it.slot })
        assertTrue(saving.first { it.slot == 3 }.empty)
        val editorDraft = st.copy(presetDraft = PresetDraft(2, "ARMY 2", emptyList(), existing = false))
        assertTrue(armyLiveUi(editorDraft, 0L, now, busy = true).saved.none { it.busy })
        assertTrue(armyLiveUi(st, 0L, now, busy = false, savingSlot = 3).saved.none { it.busy })
    }

    // --- TRAIN review ---------------------------------------------------------------------------------------------------

    @Test fun `the TRAIN review shows the server quote, not the draft, and the remainder only when the server trimmed`() {
        // The draft asked for 5 Bowmen; the server quoted 2 for 20 Shards. The player consents to the server's numbers.
        val whole = trainReviewConfirmUi(reviewed(quoteJson("20")))
        assertEquals("REVIEW TRAINING", whole.title)
        assertEquals("ADD TO QUEUE · 2 TROOPS · 20 SHARDS", whole.line)
        assertEquals("All ready in 18s", whole.subLine)
        assertEquals("ADD TO QUEUE", whole.confirmLabel)
        assertEquals(Verb.GOLD, whole.tone)

        val trimmed = trainReviewConfirmUi(reviewed(json("""{"requested":[{"troop":"bowman","count":5}],"queueable":[{"troop":"bowman","count":2}],
            "remaining":[{"troop":"bowman","count":3,"reason":"camp"}],"costShards":"1900","completionSec":18}""")))
        assertTrue(trimmed.line.startsWith("ADD TO QUEUE · 2 TROOPS · 1,900 SHARDS"))
        assertTrue(trimmed.line.contains("The remainder will not train automatically."))
        assertEquals("Preview it again when you have room or SHARDS.", trimmed.subLine)
        assertFalse(whole.line.contains("remainder"))
    }

    @Test fun `a quote with nothing queueable says so and its primary only closes`() {
        val none = trainReviewConfirmUi(reviewed(json("""{"requested":[{"troop":"bowman","count":5}],"queueable":[],
            "remaining":[{"troop":"bowman","count":5,"reason":"camp"}],"costShards":"0"}""")))
        assertEquals(NOTHING_TO_QUEUE, none.line)
        assertEquals("CLOSE", none.confirmLabel)
        assertEquals(Verb.STONE, none.tone)
        assertNull("An unknown completion time is never shown as a time", trainReviewConfirmUi(reviewed(json(
            """{"requested":[],"queueable":[{"troop":"bowman","count":1}],"remaining":[],"costShards":"10"}"""))).subLine)
    }

    // --- Footer, FINISH, hero rows (train.png / army.png) ---------------------------------------------------------------

    @Test fun `TRAIN footer is the draft pill plus one points line, and an empty draft lets the primary span the footer`() {
        val st = state(army(roster = 10, capacity = 50)).copy(quantities = mapOf("highlander" to "2", "bowman" to "1"))
        val ui = trainLiveUi(st, 0L, now, busy = false, actionsAllowed = true)
        assertEquals(listOf("+5 pts · 33s"), ui.footer.info)
        assertEquals("34", ui.footer.price.single().amount)
        assertEquals("joins the queue", ui.footer.primary.sub)
        val empty = trainLiveUi(state(army(roster = 10, capacity = 50)), 0L, now, busy = false, actionsAllowed = true)
        assertTrue(empty.footer.info.isEmpty() && empty.footer.price.isEmpty())
        assertEquals("Tap troops to add them", empty.footer.primary.reason)
    }

    @Test fun `a ready hero reads its home and a resting meter is never drawn from invented progress`() {
        val roster = HeroRoster.from(json("""{"heroes":[
            {"hero":"vex","name":"Vex","recruited":true,"level":4,"available":true},
            {"hero":"theodor","name":"Theodor","recruited":true,"level":2,"available":false,"recoveryUntil":"2030-01-01T00:10:30Z"}]}"""))
        val st = state(army()).let { it.copy(domain = it.domain.copy(heroes = roster)) }
        val heroes = armyLiveUi(st, 0L, now, busy = false).heroes
        val vex = heroes.first { it.hero == "vex" }
        assertEquals(HeroState.READY, vex.state)
        assertEquals("Hero Altar", vex.line)
        val theo = heroes.first { it.hero == "theodor" }
        assertEquals(HeroState.RESTING, theo.state)
        assertNull("The roster has no recovery start time", theo.progress)
    }

    @Test fun `an empty camp points to the Barracks in the design words and ATTACK keeps its icon`() {
        val ui = armyLiveUi(state(army(roster = 0, counts = "{}")), 0L, now, busy = false)
        assertEquals("Train them at the Barracks", ui.emptyCamp?.reason)
        assertEquals(CommandState.DISABLED, ui.footer.primary.state)
        assertEquals("attack", ui.footer.primary.icon)
        assertTrue(armyLiveUi(state(army()), 0L, now, busy = false).header.chip?.emphasisGreen == true)
    }

    // --- Host wiring (source contract; Compose execution is the device run's gate) --------------------------------------

    private fun hosts() = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/army/live/ArmyLiveHosts.kt").readText()
    private fun armyHost() = hosts().substringAfter("@Composable internal fun ArmyLiveHost").substringBefore("// Research")

    // Owner 2026-10-11 (Seeker, code 33): Army -> GO TO BARRACKS -> a troop tap with no Shards closed the sheet and opened
    // the Gold Forge. A troop tap only edits the local draft, so a short balance is a message on this sheet, never a hop.
    @Test fun `a short-Shards troop tap stays on the Barracks with a message and never routes to Need-more`() {
        val host = armyHost()
        val add = host.substringAfter("onAdd = { troop ->").substringBefore("onRemove =")
        val short = host.substringAfter("onShort = { troop ->").substringBefore("onQueueChip =")
        for ((name, tap) in listOf("onAdd" to add, "onShort" to short)) {
            assertFalse("$name must not navigate to the Gold Forge", tap.contains("onNeedMore"))
            assertFalse("$name must not navigate to the Gold Forge", tap.contains("trainShortPrice"))
            assertTrue("$name explains the shortfall on the sheet", tap.contains("trainShortMessage(current, baseGeneration, troop)?.let { toasts.post(\"short\", it, error = true) }"))
        }
    }

    @Test fun `TRAIN confirms in the designed dialog and a paid FINISH asks the existing owner for its review on the sheet`() {
        val host = armyHost()
        assertFalse("The Material review is off this sheet", host.contains("ReviewTrainingDialog("))
        assertTrue(host.contains("TrainReviewConfirm(state.domain.reviewed, busy || state.trainingBlocked, model::confirmTraining, model::dismissQuote"))
        val finish = host.substringAfter("onFinish = {").substringBefore("onLocked = {")
        assertTrue(finish.contains("model.finishAll(free = true)"))
        assertTrue(finish.contains("model.reviewTrainingFinish()"))
        assertFalse("No hop to the legacy ArmyScreen to pay", finish.contains("legacyOpen = true"))
        assertFalse(finish.contains("HomeRequest.Training"))
        assertFalse("Paying is only the mounted consent's job", host.contains("model.confirmTrainingFinish("))
        assertTrue(host.contains("TrainingFinishCurrencyConfirm(state, busy, actionsAllowed, baseGeneration, model)"))
        assertTrue(host.contains("enabled = state.domain.trainingFinishReview != null) { model.dismissTrainingFinishReview() }"))
    }

    @Test fun `LOAD and SAVE stay on the sheet and only the history icons still open the legacy screen`() {
        val host = armyHost()
        val load = host.substringAfter("onLoadSaved = {").substringBefore("onSaveSlot = {")
        assertFalse("LOAD spends nothing: no quote", load.contains("previewPreset"))
        assertTrue(load.contains("savedArmyFill(") && load.contains("tab = ARMY_TAB_TRAIN"))
        // c-gap-army (2026-10-06): SAVE now ends where a saved army's manage door (onManageSaved) begins. That door marks its
        // slot with editPreset on purpose (ArmyGroupMountTest pins it); SAVE's own code (comments aside) still never does.
        val save = host.substringAfter("onSaveSlot = {").substringBefore("onManageSaved = {")
            .lines().filterNot { it.trimStart().startsWith("//") }.joinToString("\n")
        assertFalse(save.contains("legacyOpen")); assertFalse(save.contains("editPreset"))
        assertTrue(save.contains("model.saveCurrentArmy("))
        // Decision 4 of the night plan kept saved-army edit / delete and payment recovery on the legacy screen. Rewritten with
        // c-gap-army (2026-10-06): both moved onto the sheets, and the legacy screen is only the history fallback of a
        // standalone route that passes no designed history door (Home passes the Battle log).
        // armyHost() reads the Barracks/Army slice of the host file: two standalone-route fallbacks live there.
        assertEquals(2, Regex("legacyOpen = true").findAll(host).count())
        assertEquals(2, Regex("onHistory = \\{ if \\(onHistoryDoor != null\\) onHistoryDoor\\(\\) else legacyOpen = true \\}").findAll(host).count())
    }

    @Test fun `SKILLS without a usable skill read stays on the Heroes sheet`() {
        val heroes = hosts().substringAfter("@Composable internal fun HeroesLiveHost").substringBefore("// Raid chooser")
        assertFalse(heroes.contains("legacy { tab = HERO_TAB_HERO }"))
        assertTrue(heroes.contains("Skill details are loading."))
    }
}
