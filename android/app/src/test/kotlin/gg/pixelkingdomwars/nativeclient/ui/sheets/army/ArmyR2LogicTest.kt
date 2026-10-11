package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The army cluster's round 2 rules (design/final/army/SPEC.md R2.1-R2.3, E1.1). Why they matter: a REVENGE spends a raid
 * and drops the shield, so it must have ONE name everywhere, must never be offered twice while a search is out, must keep
 * a RETRY when the answer was lost, and must say why when it is off; the scout must not offer SKIP where there is no next
 * base; and the skill track must match the game's real rule (tiers by hero level, no skill points), or players will look
 * for a purchase that does not exist.
 */
class ArmyR2LogicTest {

    // ---- Defence rows ----

    @Test fun `one answer verb everywhere, ATTACK BACK draws the same red REVENGE`() {
        assertEquals(RevengeLook(RevengeKind.REVENGE, "REVENGE", null), revengeLook(RevengeState.AVAILABLE, RowActionState.IDLE, "Ironjaw"))
        assertEquals(RevengeLook(RevengeKind.REVENGE, "REVENGE", null), revengeLook(RevengeState.ATTACK_BACK, RowActionState.IDLE, "Grimhold"))
    }

    @Test fun `a pressed REVENGE waits, a lost one keeps RETRY, a gated one says why`() {
        val busy = revengeLook(RevengeState.AVAILABLE, RowActionState.BUSY, "Ironjaw")
        assertEquals(RevengeKind.BUSY, busy.kind); assertEquals("Finding Ironjaw", busy.label)
        val lost = revengeLook(RevengeState.AVAILABLE, RowActionState.CHECKING, "Ironjaw")
        assertEquals(RevengeKind.RETRY, lost.kind); assertEquals("Being checked", lost.note)
        val gated = revengeLook(RevengeState.AVAILABLE, RowActionState.IDLE, "Ironjaw", gate = "Energy 0 · next in 38m")
        assertEquals(RevengeKind.OFF, gated.kind); assertEquals("Energy 0 · next in 38m", gated.note)
        assertEquals("a busy row stays busy even when energy runs out", RevengeKind.BUSY,
            revengeLook(RevengeState.AVAILABLE, RowActionState.BUSY, "Ironjaw", gate = "Energy 0").kind)
    }

    @Test fun `answered rows show REPLAY only and a gone target shows the server's words`() {
        assertEquals(RevengeKind.ANSWERED, revengeLook(RevengeState.ANSWERED, RowActionState.CHECKING, "Vexmoor").kind)
        val gone = revengeLook(RevengeState.UNAVAILABLE, RowActionState.IDLE, "Ironjaw", unavailableNote = "SHIELDED · try in 2h")
        assertEquals(RevengeKind.GONE, gone.kind); assertEquals("SHIELDED · try in 2h", gone.note)
    }

    @Test fun `the window line and the tab badge never invent a count`() {
        assertEquals("4 raids", raidCountLine(4)); assertEquals("1 raid", raidCountLine(1)); assertEquals(UNKNOWN, raidCountLine(null))
        assertNull("no badge for nothing new", unseenBadge(0))
        assertEquals("2", unseenBadge(2)?.text)
        assertEquals("LOST" to Verb.RED, outcomeTag(Outcome.LOST)); assertEquals("HELD" to Verb.GREEN, outcomeTag(Outcome.HELD))
    }

    // ---- Scout ----

    private fun cmd(id: String, primary: Boolean = false) = CommandUi(FeatureId(id), "", id.uppercase(), null, primary, CommandState.ENABLED, null, null)

    @Test fun `SKIP only exists on a matched base, and ATTACK is always last`() {
        val home = cmd("home"); val skip = cmd("skip"); val attack = cmd("attack", primary = true)
        assertEquals(listOf(home, skip, attack), scoutShelf(home, skip, attack, ScoutSource.MATCH))
        assertEquals("from the map HOME returns to the map", listOf(home, attack), scoutShelf(home, skip, attack, ScoutSource.MAP))
        assertEquals(listOf(home, attack), scoutShelf(home, skip, attack, ScoutSource.CAMPAIGN))
        assertEquals(listOf(home, attack), scoutShelf(home, null, attack, ScoutSource.MATCH))
        assertFalse("a campaign stage has no loot plate", scoutShowsLoot(ScoutSource.CAMPAIGN))
        assertTrue(scoutShowsLoot(ScoutSource.MAP))
    }

    // ---- Skill tiers ----

    @Test fun `skill tiers follow the hero level in steps of five, capped at T4`() {
        assertEquals(1, heroTier(1)); assertEquals(1, heroTier(5)); assertEquals(2, heroTier(6)); assertEquals(2, heroTier(9))
        assertEquals(3, heroTier(11)); assertEquals(4, heroTier(20)); assertEquals("past 20 stays T4", 4, heroTier(30))
        assertEquals(1, heroTier(0))
    }

    @Test fun `the tier track marks reached tiers done, the current one gold, later ones flat`() {
        val cells = tierCells(9)
        assertEquals(listOf("T1", "T2", "T3", "T4"), cells.map { it.label })
        assertEquals(listOf("Lv 1-5", "Lv 6-10", "Lv 11-15", "Lv 16-20"), cells.map { it.levels })
        assertEquals(listOf(TierState.DONE, TierState.CURRENT, TierState.FUTURE, TierState.FUTURE), cells.map { it.state })
        assertTrue("at max level every tier is done", tierCells(20, maxed = true).all { it.state == TierState.DONE })
    }

    @Test fun `skills autocast, so the copy never implies a button`() {
        assertEquals("2 of 5 · Vex uses them on his own", skillsCountLine(2, 5, "Vex"))
        assertEquals("once a battle", cooldownLine(true, "every 12s"))
        assertEquals("every 12s", cooldownLine(false, "every 12s"))
        assertEquals("", cooldownLine(false, null))
    }

    @Test fun `the revenge footer only states the shield rule when the server confirms it`() {
        assertEquals("Each answer costs one raid.", revengeFooterLine(false))
        assertEquals("Each answer costs one raid. Your shield drops when you attack.", revengeFooterLine(true))
    }
}
