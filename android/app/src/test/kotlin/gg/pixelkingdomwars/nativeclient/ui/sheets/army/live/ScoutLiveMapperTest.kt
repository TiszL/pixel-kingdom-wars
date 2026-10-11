package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.CampaignPreview
import gg.pixelkingdomwars.nativeclient.data.TargetScout
import gg.pixelkingdomwars.nativeclient.model.PresentationHead
import gg.pixelkingdomwars.nativeclient.model.ScoutReport
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.SCOUT_NO_WALLS
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ScoutSource
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.scoutInfoLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.scoutLootVisible
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.scoutShelf
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.scoutShieldTag
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.scoutShowsLoot
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/** Scout presentation borrows the exact preview; it cannot invent rewards or admit an old target. */
class ScoutLiveMapperTest {
    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private val catalogue = obj("""{"constants":{"DEFENSES":{"archertower":{},"cannon":{},"powdermine":{"oneUse":true}}}}""")
    private fun target(fields: String = "") = TargetScout("wallet", "target-base", ScoutReport.from(obj("""
        {"name":"Ironjaw","keepLevel":11,"previewSec":37$fields}
    """)))
    private fun mapped(preview: TargetScout = target(), current: TargetScout? = preview, busy: Boolean = false,
        loading: Boolean = false, left: Int? = 37, cat: JsonObject? = catalogue) =
        scoutLiveUi(preview, current, cat, busy, loading, left)

    @Test fun `target identity and exact decimal trophies come from this response`() {
        val ui = mapped(target(", \"trophies\":\"900719925474099312345\""))
        assertEquals("Ironjaw", ui.target.name)
        assertEquals("Lv 11", ui.target.level)
        assertEquals("900,719,925,474,099,312,345", ui.target.trophies)
        assertEquals(CommandState.ENABLED, ui.attack.state)
    }

    @Test fun `the report parser's legacy zero default is not an observed trophy balance`() {
        val preview = target()
        assertEquals("0", preview.report.trophies)
        assertEquals(UNKNOWN, mapped(preview).target.trophies)
        assertEquals("0", mapped(target(""", "trophies":0""")).target.trophies)
        assertEquals(UNKNOWN, mapped(target(""", "trophies":1.5""")).target.trophies)
    }

    @Test fun `unexposed loot shield stakes crest and clan stay unknown`() {
        val ui = mapped(target().copy(attackUnavailable = "Shield active"))
        assertNull(ui.lootable)
        assertNull(ui.trophiesWin)
        assertNull(ui.trophiesLose)
        assertNull(ui.shielded)
        assertNull(ui.target.crest)
        assertNull(ui.target.clan)
        assertNull(ui.attack.price)
        assertEquals("Shield active", ui.attack.reason)
    }

    @Test fun `only catalogue defences in the response count and traps never acquire labels`() {
        val ui = mapped(target(""", "buildings":[
            {"id":"a","type":"archertower","level":4},
            {"id":"b","type":"cannon","level":6},
            {"id":"trap","type":"powdermine","level":4},
            {"id":"forge","type":"goldforge","level":2},
            {"id":"wall1","type":"wall","level":3},
            {"id":"wall2","type":"wall","level":5}]
        """))
        assertEquals(2, ui.defences)
        assertEquals("LV 3–5", ui.wallLevel)
        assertTrue(ui.tags.isEmpty())
        assertFalse(ui.showHint)
        assertNull(ui.skip)
    }

    @Test fun `absent malformed layout or absent defence catalogue is not zero defences`() {
        assertNull(mapped().defences)
        assertNull(mapped(target(""", "buildings":[null]""")).defences)
        assertNull(mapped(target(""", "buildings":[{}]""")).defences)
        assertNull(mapped(target(""", "buildings":[]"""), cat = null).defences)
        assertEquals(0, mapped(target(""", "buildings":[]""")).defences)
        assertNull(mapped(target(""", "buildings":[{"type":"wall","level":0}]""")).wallLevel)
    }

    @Test fun `campaign uses its own snapshot and never gains a loot plate or skip`() {
        val preview = CampaignPreview(7, PresentationHead.from(obj("""{"stage":7,"name":"Rampart",
            "snapshot":{"keepLevel":4,"buildings":[{"type":"cannon","level":3},{"type":"wall","level":2}]}}
        """)), previewSec = 37)
        val ui = scoutLiveUi(preview, preview, catalogue, false, false, 20)
        assertEquals("STAGE 7 · Rampart", ui.target.name)
        assertEquals("Lv 4", ui.target.level)
        assertEquals(ScoutSource.CAMPAIGN, ui.source)
        assertFalse(scoutShowsLoot(ui.source))
        assertEquals(1, ui.defences)
        assertEquals("LV 2", ui.wallLevel)
        assertNull(ui.skip)
    }

    @Test fun `equal but replaced preview cannot retain attack permission`() {
        val preview = target()
        assertEquals(preview, preview.copy())
        assertEquals(CommandState.DISABLED, mapped(preview, preview.copy()).attack.state)
        assertEquals(CommandState.DISABLED, mapped(preview, null).attack.state)
        assertFalse(scoutLiveCanAttack(preview, preview.copy(), false, false, 37))
    }

    @Test fun `busy loading blocked and elapsed previews preserve the existing attack gate`() {
        val preview = target()
        assertEquals(CommandState.BUSY, mapped(preview, busy = true).attack.state)
        assertEquals(CommandState.BUSY, mapped(preview, loading = true).attack.state)
        assertEquals(CommandState.DISABLED, mapped(preview, left = 0).attack.state)
        assertEquals(CommandState.DISABLED, mapped(preview, left = null).attack.state)
        val blocked = preview.copy(attackUnavailable = "Target unavailable")
        assertFalse(scoutLiveCanAttack(blocked, blocked, false, false, 37))
        assertFalse(scoutLiveCanAttack(preview, preview, true, false, 37))
        assertFalse(scoutLiveCanAttack(preview, preview, false, true, 37))
        assertFalse(scoutLiveCanAttack(preview, preview, false, false, 0))
        assertTrue(scoutLiveCanAttack(preview, preview, false, false, 1))
    }

    @Test fun `a scout without loot facts draws no loot plate, no stakes and no shield tag rather than a dash that never fills`() {
        val ui = mapped()
        assertFalse(scoutLootVisible(ui))
        assertNull(scoutShieldTag(ui.shielded))
        // The day the server states a loot fact the plate comes back; a campaign scout never has one.
        assertTrue(scoutLootVisible(ui.copy(lootable = "18,200")))
        assertFalse(scoutLootVisible(ui.copy(lootable = "18,200", source = ScoutSource.CAMPAIGN)))
        assertEquals("NO SHIELD", scoutShieldTag(false))
        assertEquals("SHIELDED", scoutShieldTag(true))
    }

    @Test fun `the shelf is HOME then ATTACK with no SKIP, so no dead next-base button is drawn`() {
        val ui = mapped()
        val shelf = scoutShelf(ui.home, ui.skip, ui.attack, ui.source)
        assertEquals(listOf("HOME", "ATTACK"), shelf.map { it.caption })
        assertEquals("attack", ui.attack.icon)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.Verb.RED, ui.attack.verb)
    }

    @Test fun `a layout with no walls says so instead of an unknown wall level`() {
        val none = mapped(target(""", "buildings":[{"id":"a","type":"archertower","level":4}]"""))
        assertEquals(SCOUT_NO_WALLS, none.wallLevel)
        assertEquals("1 defence · no walls", scoutInfoLine(none.defences, none.wallLevel))
        assertEquals("0 defences · no walls", mapped(target(""", "buildings":[]""")).let { scoutInfoLine(it.defences, it.wallLevel) })
        // An absent layout is still unknown, never "no walls".
        assertEquals("$UNKNOWN defences · walls $UNKNOWN", scoutInfoLine(mapped().defences, mapped().wallLevel))
        assertEquals("2 defences · walls LV 3–5", scoutInfoLine(2, "LV 3–5"))
    }

    @Test fun `an untimed campaign keeps its original attack and home exits`() {
        val preview = CampaignPreview(1, PresentationHead.from(obj("""{"snapshot":{"keepLevel":1}}""")))
        val ui = scoutLiveUi(preview, preview, null, false, false, null)
        assertEquals(CommandState.ENABLED, ui.attack.state)
        assertEquals(CommandState.ENABLED, ui.home.state)
        assertEquals("HOME", ui.home.caption)
        assertNull(ui.skip)
    }
}
