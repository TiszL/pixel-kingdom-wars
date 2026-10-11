package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.BattleHistoryState
import gg.pixelkingdomwars.nativeclient.model.BattleOpponent
import gg.pixelkingdomwars.nativeclient.model.BattleRecord
import gg.pixelkingdomwars.nativeclient.model.PendingMarch
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.RevengeState
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class BattleLogLiveMapperTest {
    private val now = Instant.parse("2030-01-02T00:00:00Z").toEpochMilli()
    private val constants = Json.parseToJsonElement("""{"RAID_RULES":{"revengeLockHours":24},"RAID_ENERGY":{"perRaid":2}}""").jsonObject
    private fun row(id: String = "raid", access: String = "deed") = BattleRecord(id, baseId = "base", role = "defender", mode = "pvp",
        result = "defeat", stars = 2, destructionPct = "64", settledAmount = "-9007199254740993", settledCurrency = "SHARDS",
        opponent = BattleOpponent("enemy-base", "enemy-wallet", "Ironjaw"), createdAt = "2030-01-01T12:00:00Z", replayAccess = access)

    @Test fun `defence mapping retains exact settled values and does not invent missing profile fields`() {
        val mapped = defenceLiveRow(row(), constants, now)
        assertEquals("-9,007,199,254,740,993", mapped.lootLost)
        assertEquals(UNKNOWN, mapped.trophyDelta)
        assertEquals("shield", mapped.portrait)
        assertNull(mapped.clanTag)
        assertTrue(mapped.army.isEmpty())
        assertFalse(mapped.unseen)
        assertEquals(RevengeState.AVAILABLE, mapped.revenge)
    }

    @Test fun `revenge eligibility remains the existing target and catalogue rule`() {
        assertEquals(RevengeState.UNAVAILABLE, defenceLiveRow(row().copy(mode = "campaign"), constants, now).revenge)
        assertEquals(RevengeState.UNAVAILABLE, defenceLiveRow(row().copy(opponent = null), constants, now).revenge)
        assertEquals(RevengeState.UNAVAILABLE, defenceLiveRow(row(), null, now).revenge)
        assertEquals(RevengeState.ATTACK_BACK, defenceLiveRow(row().copy(createdAt = "2029-12-20T00:00:00Z"), constants, now).revenge)
    }

    @Test fun `redaction and absent scores stay unknown instead of becoming a held defence`() {
        val mapped = defenceLiveRow(row().copy(settledAmount = null, stars = null, result = null, destructionPct = null), constants, now)
        assertTrue(mapped.lootRedacted)
        assertNull(mapped.lootLost)
        assertFalse(mapped.outcomeKnown)
        assertFalse(mapped.starsKnown)
        assertEquals(UNKNOWN, mapped.destructionLabel)
    }

    @Test fun `replay keys preserve both deed and prior participation authority`() {
        val deed = row()
        val prior = row(access = "participant").copy(baseId = "sold-base")
        val history = BattleHistoryState(baseId = "base", deed = listOf(deed), participant = listOf(prior))
        assertNotEquals(battleLogRowId(deed), battleLogRowId(prior))
        assertSame(prior, battleLogRecord(history, battleLogRowId(prior)))
        assertEquals("/battles/participated/raid/replay", battleLogRecord(history, battleLogRowId(prior))?.replayPath)
        assertNull(battleLogRecord(history, "unknown"))
    }

    @Test fun `a changed selected base clears rows pending marches and cursors before mapping`() {
        val history = BattleHistoryState(baseId = "base", deed = listOf(row()), deedCursor = "older", pending = listOf(PendingMarch("march")))
        val current = currentBattleHistory(history, "other")
        assertTrue(current.loading)
        assertTrue(current.deed.isEmpty())
        assertTrue(current.pending.isEmpty())
        assertNull(current.deedCursor)
        assertSame(history, currentBattleHistory(history, "base"))
    }

    @Test fun `shield absence and suppression cannot claim an active shield`() {
        assertEquals(UNKNOWN, battleLogShield(null).stateLabel)
        assertEquals("none now", battleLogShield(Json.parseToJsonElement("""{"shield":null}""").jsonObject).stateLabel)
        val suppressed = battleLogShield(Json.parseToJsonElement("""{"shield":{"remainingMs":60000,"suppressedByWarzone":true}}""").jsonObject)
        assertFalse(suppressed.active)
        assertEquals("suppressed", suppressed.stateLabel)
    }

    @Test fun `an unsent trophy change stays unknown in the data and is omitted by the rows, never drawn as a number`() {
        // defenceLiveRow keeps UNKNOWN (above); the rows read it through shownDelta so no "…" sits there forever.
        assertNull(gg.pixelkingdomwars.nativeclient.ui.sheets.army.shownDelta(defenceLiveRow(row(), constants, now).trophyDelta))
        assertNull(gg.pixelkingdomwars.nativeclient.ui.sheets.army.shownDelta(attackLiveRow(row().copy(role = "attacker"), now).trophyDelta))
        assertEquals("-12", gg.pixelkingdomwars.nativeclient.ui.sheets.army.shownDelta("-12"))
    }

    @Test fun `an active shield states only what a shield is, never the unconfirmed attacking-ends-it rule`() {
        val active = battleLogShield(Json.parseToJsonElement("""{"shield":{"remainingMs":15000000}}""").jsonObject)
        assertTrue(active.active)
        assertEquals("No one can raid you while it lasts.", active.line)
        assertFalse(active.line.contains("Attacking"))
    }

    @Test fun `the DEFENCE empty state draws GO TO WALLS only when the host has that door`() {
        val empty = BattleHistoryState(baseId = "base")
        val withDoor = defenceEmptyState(empty, landless = false, wallsDoor = true, landDoor = false)
        assertEquals("No raids on you yet.", withDoor.headline)
        assertEquals("Your walls are waiting.", withDoor.reason)
        assertEquals("GO TO WALLS", withDoor.goLabel)
        assertEquals(LOG_GO_WALLS, withDoor.go)
        // No door, no button: a GO that could do nothing is never drawn.
        val noDoor = defenceEmptyState(empty, landless = false, wallsDoor = false, landDoor = true)
        assertNull(noDoor.goLabel)
        assertNull(noDoor.go)
    }

    @Test fun `a landless keep sees the locked state with its own GO, ahead of the no-deed copy`() {
        val noDeed = BattleHistoryState(stable = true, deedSelected = false)
        val locked = defenceEmptyState(noDeed, landless = true, wallsDoor = true, landDoor = true)
        assertEquals("Claim land to be raided and to raid back", locked.headline)
        assertEquals(LOG_GO_LAND, locked.go)
        assertNull(defenceEmptyState(noDeed, landless = true, wallsDoor = false, landDoor = false).go)
        assertEquals("No deed selected.", defenceEmptyState(noDeed, landless = false, wallsDoor = true, landDoor = true).headline)
        // The live mapper defaults to the old behaviour for callers that pass nothing new.
        assertNull(battleLogLiveUi(gg.pixelkingdomwars.nativeclient.ui.sheets.army.LOG_TAB_DEFENCE, BattleHistoryState(baseId = "base"), null,
            constants, now, busy = false, actionsAllowed = true).empty?.go)
    }

    @Test fun `REVENGE says your walls held only when no raid on this deed is loaded`() {
        assertEquals("Your walls held.", raidRevengeLiveUi(BattleHistoryState(baseId = "base"), null, constants, now, false, true).empty?.reason)
        // A raid that cannot be answered (campaign, no player target) did happen: "held" would be untrue.
        val unanswerable = BattleHistoryState(baseId = "base", deed = listOf(row().copy(mode = "campaign")))
        val ui = raidRevengeLiveUi(unanswerable, null, constants, now, false, true)
        assertTrue(ui.rows.isEmpty())
        assertEquals("No answerable defences in the loaded history.", ui.empty?.reason)
        assertEquals("No one to answer.", ui.empty?.headline)
    }

    @Test fun `own raids keep a non-Shards currency as sent and redaction verbatim`() {
        val keep = row().copy(role = "attacker", result = "victory", settledAmount = "40", settledCurrency = "KEEP")
        assertEquals("+40 KEEP", attackLootLabel(keep))
        assertEquals("LOOT REDACTED", attackLootLabel(keep.copy(lootRedacted = true)))
        // A won raid that settled nothing is not a "defeat".
        assertEquals("0 Shards", attackLootLabel(keep.copy(settledAmount = "0", settledCurrency = "SHARDS")))
    }

    @Test fun `revenge energy gates use the catalogue amount and never claim shield loss`() {
        val history = BattleHistoryState(deed = listOf(row()))
        val ui = raidRevengeLiveUi(history, null, constants, now, busy = false, actionsAllowed = true)
        assertEquals("Energy is still loading.", ui.gate)
        assertEquals("2", ui.energyPrice?.amount)
        assertFalse(ui.shieldDropsOnAttack)
    }
}
