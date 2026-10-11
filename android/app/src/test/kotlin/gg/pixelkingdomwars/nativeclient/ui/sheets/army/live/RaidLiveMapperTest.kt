package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.BattleDomainState
import gg.pixelkingdomwars.nativeclient.data.BattleHistoryState
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.BattleOpponent
import gg.pixelkingdomwars.nativeclient.model.BattleRecord
import gg.pixelkingdomwars.nativeclient.model.CampaignState
import gg.pixelkingdomwars.nativeclient.ui.attack.CampaignArtwork
import gg.pixelkingdomwars.nativeclient.ui.attack.CampaignChapterArt
import gg.pixelkingdomwars.nativeclient.ui.attack.CampaignRegionArt
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.RAID_TAB_CAMPAIGN
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.RAID_TAB_MATCH
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.StageNodeState
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The live Raid chooser keeps the current chooser's gate: PvP stays off when the pack cannot state the entry ante, a
 * landless keep leads with CAMPAIGN, and the campaign never offers a stage past the server's frontier. */
class RaidLiveMapperTest {
    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private val now = Instant.parse("2030-01-01T00:00:00Z").toEpochMilli()
    private val constants = obj("""{"RAID_ENERGY":{"perRaid":1},"PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL":[100,250,400],
        "CAMPAIGN":{"firstThreeStarShardsByKeep":[500,800]}}""")
    private fun home(free: Int = 3) = BaseState(base = BaseSnapshot.from(obj("""{"baseId":"b1","player":{"keepLevel":2,"trophies":"1284","league":"gold"},
        "energy":{"used":${5 - free},"free":$free,"max":5},"armyStatus":{"readyTroopCount":4,"readyPts":42,"campCapacityPts":50}}""")))
    private val campaign = CampaignState.from(obj("""{"baseId":"b1","stages":[
        {"stage":1,"act":1,"name":"Ford","bestStars":3,"unlocked":true,"keepLevel":1,"firstThreeStarClaimed":true},
        {"stage":2,"act":1,"name":"Mill","bestStars":1,"unlocked":true,"keepLevel":1},
        {"stage":3,"act":1,"name":"Gate","bestStars":0,"unlocked":true,"keepLevel":2,"recommendedArmyPoints":40,"profile":"mini_boss"},
        {"stage":4,"act":1,"name":"Keep","bestStars":0,"unlocked":false,"keepLevel":2}]}"""))
    private fun battle() = BattleDomainState(campaign = campaign)

    @Test fun `without the entry-cost table PvP stays off and says so, exactly like the current chooser`() {
        val ui = raidLiveUi(RAID_TAB_MATCH, battle(), home(), "b1", landOwned = true, onboarding = false, constants = null,
            nowMs = now, selectedStage = null, busy = false, actionsAllowed = true)
        val footer = requireNotNull(ui.footer)
        assertEquals(CommandState.DISABLED, footer.primary.state)
        assertEquals("PVP ENTRY COST UNKNOWN", footer.primary.reason)
        assertTrue(footer.price.isEmpty())
    }

    @Test fun `MATCH shows the energy and Shards ante from the catalogue, no energy turns the energy pill SHORT`() {
        val ui = raidLiveUi(RAID_TAB_MATCH, battle(), home(free = 0), "b1", true, false, constants, now, null, busy = false, actionsAllowed = true)
        val footer = requireNotNull(ui.footer)
        assertEquals(CommandState.ENABLED, footer.primary.state)
        assertEquals(listOf("1", "250"), footer.price.map { it.amount })
        assertEquals(PriceStatus.SHORT, footer.price[0].status)
        assertEquals("1,284", ui.match?.trophies)
        assertEquals(42, ui.army.ready)
    }

    @Test fun `a landless keep opens on CAMPAIGN and its map row is look-only`() {
        assertEquals(RAID_TAB_CAMPAIGN, raidDefaultTab(landOwned = false, onboarding = false))
        assertEquals(RAID_TAB_MATCH, raidDefaultTab(landOwned = true, onboarding = false))
        val ui = raidLiveUi(RAID_TAB_MATCH, battle(), home(), "b1", false, false, constants, now, null, false, true)
        assertEquals("WORLD MAP — LOOK ONLY", ui.worldMap.caption)
    }

    @Test fun `the campaign selects the server frontier and the road never opens a locked stage`() {
        val ui = raidLiveUi(RAID_TAB_CAMPAIGN, battle(), home(), "b1", true, false, constants, now, null, false, true)
        val camp = requireNotNull(ui.campaign)
        assertEquals(3, camp.selected.stage)
        assertEquals(listOf(StageNodeState.CLEARED, StageNodeState.CLEARED, StageNodeState.NEXT, StageNodeState.LOCKED), camp.road.map { it.state })
        assertEquals("800", camp.selected.reward?.amount)
        assertEquals("about 40 pts", camp.selected.bringNote)
        assertTrue(camp.selected.boss)
        assertEquals(CommandState.ENABLED, ui.footer?.primary?.state)
        val locked = raidLiveUi(RAID_TAB_CAMPAIGN, battle(), home(), "b1", true, false, constants, now, 4, false, true)
        assertEquals(CommandState.LOCKED, locked.footer?.primary?.state)
        assertEquals("REPLAY", raidLiveUi(RAID_TAB_CAMPAIGN, battle(), home(), "b1", true, false, constants, now, 1, false, true).footer?.primary?.caption)
    }

    @Test fun `another base's campaign or an unread home reads unknown, never zero`() {
        val ui = raidLiveUi(RAID_TAB_CAMPAIGN, battle(), null, "b2", true, false, constants, now, null, false, true)
        assertNull(ui.campaign)
        assertNull(ui.energy.now)
        assertEquals(UNKNOWN, ui.match?.trophies)
        assertEquals(CommandState.DISABLED, ui.footer?.primary?.state)
    }

    private fun energyConstants(energy: String) = JsonObject(constants + ("RAID_ENERGY" to obj(energy)))

    private fun matchFooter(energy: String, free: Int?, keepLevel: Int? = 2, busy: Boolean = false, actionsAllowed: Boolean = true) =
        raidFooter(RAID_TAB_MATCH, energyConstants(energy), keepLevel, free, null, emptyList(), busy, actionsAllowed)

    @Test fun `positive energy below the catalogue entry cost is SHORT without changing the primary route`() {
        val footer = matchFooter("""{"perRaid":2}""", free = 1)
        val price = footer.price.first { it.icon == "energy" }
        assertEquals("2", price.amount)
        assertEquals(PriceStatus.SHORT, price.status)
        assertEquals("2 energy. Not enough energy.", price.description)
        assertEquals(matchFooter("""{"perRaid":2}""", free = 2).primary, footer.primary)
        assertEquals(gg.pixelkingdomwars.nativeclient.ui.sheets.army.TapRoute.RUN,
            gg.pixelkingdomwars.nativeclient.ui.sheets.army.commandTap(footer.primary))
    }

    @Test fun `energy equal to the catalogue entry cost is affordable`() {
        val price = matchFooter("""{"perRaid":2}""", free = 2).price.first { it.icon == "energy" }
        assertEquals(PriceStatus.OK, price.status)
        assertEquals("2", price.amount)
        assertEquals("2 energy", price.description)
    }

    @Test fun `energy above a numeric string entry cost is affordable without rewriting its amount`() {
        val price = matchFooter("""{"perRaid":"2"}""", free = 3).price.first { it.icon == "energy" }
        assertEquals(PriceStatus.OK, price.status)
        assertEquals("2", price.amount)
    }

    @Test fun `entry cost larger than an integer balance remains exact and SHORT`() {
        val price = matchFooter("""{"perRaid":"2147483648"}""", free = Int.MAX_VALUE).price.first { it.icon == "energy" }
        assertEquals(PriceStatus.SHORT, price.status)
        assertEquals("2147483648", price.amount)
        assertEquals("2147483648 energy. Not enough energy.", price.description)
    }

    @Test fun `missing entry cost preserves the existing absent prices and closed primary`() {
        listOf("{}", """{"perRaid":null}""").forEach { energy ->
            val footer = matchFooter(energy, free = 3)
            assertTrue(footer.price.isEmpty())
            assertEquals(CommandState.DISABLED, footer.primary.state)
            assertEquals("PVP ENTRY COST UNKNOWN", footer.primary.reason)
        }
    }

    @Test fun `present invalid or nonpositive energy costs read unavailable without inventing a free offer`() {
        listOf("\"bad\"", "1.5", "-1", "0", "\"+2\"", "\"02\"", "\" 2 \"", "\"\"", "true").forEach { cost ->
            val footer = matchFooter("""{"perRaid":$cost}""", free = 3)
            val price = footer.price.first { it.icon == "energy" }
            assertEquals("cost=$cost", PriceStatus.UNAVAILABLE, price.status)
            assertEquals("Energy cost unavailable.", price.description)
            assertEquals(CommandState.ENABLED, footer.primary.state)
        }
    }

    @Test fun `unknown available energy is CHECKING with the known cost retained and no affordability claim`() {
        val footer = matchFooter("""{"perRaid":2}""", free = null)
        val price = footer.price.first { it.icon == "energy" }
        assertEquals(PriceStatus.CHECKING, price.status)
        assertEquals("2", price.amount)
        assertEquals("2 energy. Checking available energy.", price.description)
        assertEquals(CommandState.ENABLED, footer.primary.state)
    }

    @Test fun `a negative energy balance is treated as unknown rather than a valid shortfall`() {
        val price = matchFooter("""{"perRaid":2}""", free = -1).price.first { it.icon == "energy" }
        assertEquals(PriceStatus.CHECKING, price.status)
        assertEquals("2 energy. Checking available energy.", price.description)
    }

    @Test fun `unknown Keep keeps its existing primary policy and unknown Shards price`() {
        val footer = matchFooter("""{"perRaid":2}""", free = 1, keepLevel = null)
        assertEquals(CommandState.ENABLED, footer.primary.state)
        assertEquals(PriceStatus.SHORT, footer.price.first { it.icon == "energy" }.status)
        assertEquals(PriceStatus.CHECKING, footer.price.first { it.currency == gg.pixelkingdomwars.nativeclient.ui.model.Currency.SHARDS }.status)
    }

    @Test fun `a SHORT energy pill hands its own PriceUi to Need-more so the Home door can route it to SUPPLIES`() {
        // The Home mount routes by the pill (icon "energy" -> Build shop SUPPLIES, else Gold Forge). A pill tap that
        // posted a toast, or passed a different price, would strand the player with no way to get more.
        val footer = matchFooter("""{"perRaid":2}""", free = 1)
        val short = footer.price.first { it.status == PriceStatus.SHORT }
        var asked: PriceUi? = null
        requireNotNull(gg.pixelkingdomwars.nativeclient.ui.sheets.army.needMoreTap(short) { asked = it }).invoke()
        assertSame(short, asked)
        assertEquals("energy", asked?.icon)
        // An affordable pill is a label, not a door: no Need-more for something the player can pay.
        assertNull(gg.pixelkingdomwars.nativeclient.ui.sheets.army.needMoreTap(footer.price.first { it.currency == Currency.SHARDS }) { asked = null })
    }

    @Test fun `a Shards balance below the catalogue ante turns only the Shards pill SHORT and its tap reaches Need-more`() {
        val poor = raidLiveUi(RAID_TAB_MATCH, battle(), home().copy(balances = Balances(shards = "249", keep = "0")), "b1", true, false,
            constants, now, null, busy = false, actionsAllowed = true)
        val shards = requireNotNull(poor.footer).price.first { it.currency == Currency.SHARDS }
        assertEquals(PriceStatus.SHORT, shards.status)
        assertEquals("250", shards.amount)
        assertNull("A Shards pill carries no energy icon, so the door picks the Gold Forge", shards.icon)
        var asked: PriceUi? = null
        requireNotNull(gg.pixelkingdomwars.nativeclient.ui.sheets.army.needMoreTap(shards) { asked = it }).invoke()
        assertSame(shards, asked)
        // Equal to the ante is affordable; an unread balance keeps today's pill (the server stays the gate).
        val exact = raidLiveUi(RAID_TAB_MATCH, battle(), home().copy(balances = Balances(shards = "250", keep = "0")), "b1", true, false,
            constants, now, null, busy = false, actionsAllowed = true)
        assertEquals(PriceStatus.OK, requireNotNull(exact.footer).price.first { it.currency == Currency.SHARDS }.status)
        assertEquals(PriceStatus.OK, requireNotNull(raidLiveUi(RAID_TAB_MATCH, battle(), home(), "b1", true, false, constants, now, null,
            busy = false, actionsAllowed = true).footer).price.first { it.currency == Currency.SHARDS }.status)
        // Shards do not change the primary's route: FIND A MATCH stays the server's decision.
        assertEquals(CommandState.ENABLED, requireNotNull(poor.footer).primary.state)
    }

    @Test fun `FIND A MATCH carries the attack icon in every state, as raid png draws it`() {
        listOf(matchFooter("""{"perRaid":2}""", free = 3), matchFooter("""{"perRaid":2}""", free = 3, busy = true),
            matchFooter("""{"perRaid":2}""", free = 3, actionsAllowed = false), matchFooter("{}", free = 3)).forEach {
            assertEquals("attack", it.primary.icon)
        }
    }

    @Test fun `the campaign act title carries the region and the sheet is titled CAMPAIGN on its tab`() {
        val art = CampaignArtwork(listOf(CampaignChapterArt(1, "frostveil", "Beyond the White Gate", "The winter roads are still open.",
            "Lore.", "THE WHITE GATE", (1..10).map { "Snow stage $it" })),
            mapOf("frostveil" to CampaignRegionArt("Frostveil", "#ffffff", listOf(0, 0, 10, 10), listOf(listOf(5, 5)), "snow")))
        val perAct = JsonObject(constants + ("CAMPAIGN" to obj("""{"stagesPerAct":10,"firstThreeStarShardsByKeep":[500,800]}""")))
        val ui = raidLiveUi(RAID_TAB_CAMPAIGN, battle(), home(), "b1", true, false, perAct, now, null, false, true, campaignArt = art)
        val camp = requireNotNull(ui.campaign)
        assertEquals("ACT 1 · FROSTVEIL", camp.act.title)
        assertEquals("Beyond the White Gate", camp.act.chapter)
        assertEquals("Snow stage 3", camp.selected.name)
        assertEquals("CAMPAIGN", ui.header.title)
        assertEquals("ATTACK", raidLiveUi(RAID_TAB_MATCH, battle(), home(), "b1", true, false, perAct, now, null, false, true, campaignArt = art).header.title)
        // Without the presentation the header is the server's act alone (the default every current caller gets).
        assertEquals("ACT 1", requireNotNull(raidLiveUi(RAID_TAB_CAMPAIGN, battle(), home(), "b1", true, false, perAct, now, null, false, true).campaign).act.title)
    }

    @Test fun `a landowner reads the designed MATCH and WORLD MAP sentences, a landless keep keeps the native copy`() {
        val owner = raidLiveUi(RAID_TAB_MATCH, battle(), home(), "b1", true, false, constants, now, null, false, true)
        assertEquals("We pick a base near your trophies. The fastest fight.", owner.match?.note)
        assertEquals("Choose any base on the globe. Scout first.", owner.worldMap.sub)
        val landless = raidLiveUi(RAID_TAB_MATCH, battle(), home(), "b1", false, false, constants, now, null, false, true)
        assertTrue(landless.match?.note.orEmpty().startsWith("Auto-match another landless keep"))
        assertTrue(landless.worldMap.sub.orEmpty().startsWith("Look at a region you own no parcel in."))
    }

    @Test fun `the energy chip never shows a refill time the server did not send`() {
        val ui = raidLiveUi(RAID_TAB_MATCH, battle(), home(free = 3), "b1", true, false, constants, now, null, false, true)
        assertNull(ui.energy.nextInSec)
        assertNull(gg.pixelkingdomwars.nativeclient.ui.sheets.army.energyChipLine(ui.energy))
        assertEquals("full", gg.pixelkingdomwars.nativeclient.ui.sheets.army.energyChipLine(ui.energy.copy(now = 5)))
        assertEquals("+1 in 38m", gg.pixelkingdomwars.nativeclient.ui.sheets.army.energyChipLine(ui.energy.copy(nextInSec = 2_280)))
    }

    @Test fun `RECENT RAIDS draws the two newest attacks in sentence case and omits the unsent trophy change`() {
        val history = BattleHistoryState(baseId = "b1", deed = listOf(
            BattleRecord("r1", baseId = "b1", role = "attacker", mode = "pvp", result = "victory", stars = 2, settledAmount = "8200",
                settledCurrency = "SHARDS", opponent = BattleOpponent("o1", "w1", "Ironjaw"), createdAt = "2029-12-31T22:00:00Z"),
            BattleRecord("r2", baseId = "b1", role = "attacker", mode = "pvp", result = "defeat", stars = 0, settledAmount = "0",
                settledCurrency = "SHARDS", opponent = BattleOpponent("o2", "w2", "Saltmere"), createdAt = "2029-12-31T00:00:00Z"),
            BattleRecord("r3", baseId = "b1", role = "attacker", mode = "pvp", result = "victory", stars = 1, lootRedacted = true,
                opponent = BattleOpponent("o3", "w3", "Grimhold"), createdAt = "2029-12-30T00:00:00Z")))
        val ui = raidLiveUi(RAID_TAB_MATCH, BattleDomainState(campaign = campaign, history = history), home(), "b1", true, false, constants, now, null, false, true)
        assertEquals(listOf("Ironjaw", "Saltmere"), ui.recent.map { it.opponent })
        assertEquals("+8,200 Shards", ui.recent[0].lootLabel)
        assertEquals("2h ago", ui.recent[0].ago)
        assertEquals("defeat", ui.recent[1].lootLabel)
        assertNull(gg.pixelkingdomwars.nativeclient.ui.sheets.army.shownDelta(ui.recent[0].trophyDelta))
        assertEquals("LOOT REDACTED", attackLootLabel(history.deed[2]))
    }

    @Test fun `energy status does not replace busy or raid-interlock primary states`() {
        val busy = matchFooter("""{"perRaid":2}""", free = 1, busy = true)
        val blocked = matchFooter("""{"perRaid":2}""", free = 1, actionsAllowed = false)
        assertEquals(CommandState.BUSY, busy.primary.state)
        assertEquals(CommandState.DISABLED, blocked.primary.state)
        assertEquals(matchFooter("""{"perRaid":2}""", free = 3, actionsAllowed = false).primary, blocked.primary)
        assertEquals(PriceStatus.SHORT, busy.price.first { it.icon == "energy" }.status)
        assertEquals(PriceStatus.SHORT, blocked.price.first { it.icon == "energy" }.status)
    }
}
