package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.clanHubTab
import kotlinx.coroutines.CancellationException
import org.junit.Assert.*
import org.junit.Test

class ClanHubTest {
    @Test fun `equal owner values require the identical session object`() {
        val session = Any()
        val expected = ClanHubOwner(session, "deed", 3)
        assertTrue(clanHubOwnerCurrent(expected, ClanHubOwner(session, "deed", 3)))
        assertFalse(clanHubOwnerCurrent(expected, ClanHubOwner(Any(), "deed", 3)))
        assertFalse(clanHubOwnerCurrent(expected, null))
    }
    @Test fun `returning to the same deed after a switch invalidates old callbacks`() {
        val session = Any()
        assertFalse(clanHubOwnerCurrent(ClanHubOwner(session, "deed", 3), ClanHubOwner(session, "deed", 5)))
        assertFalse(clanHubOwnerCurrent(ClanHubOwner(session, "deed", 3), ClanHubOwner(session, "other", 3)))
    }
    @Test fun `stale action explains without invoking its owner`() {
        val expected = ClanHubOwner(Any(), "deed", 3)
        val reasons = mutableListOf<String>()
        var calls = 0
        val gate = ClanHubGate(expected, { null }, { false }, { null }, reasons::add)
        assertFalse(gate.run { calls++ })
        assertEquals(0, calls)
        assertEquals(1, reasons.size)
    }
    @Test fun `busy and held actions each explain without invoking owner`() {
        val expected = ClanHubOwner(Any(), "deed", 3)
        var calls = 0
        val reasons = mutableListOf<String>()
        assertFalse(ClanHubGate(expected, { expected }, { true }, { null }, reasons::add).run { calls++ })
        assertFalse(ClanHubGate(expected, { expected }, { false }, { "Game orders are paused" }, reasons::add).run { calls++ })
        assertEquals(0, calls)
        assertEquals(2, reasons.size)
    }
    @Test fun `current action invokes existing owner exactly once`() {
        val expected = ClanHubOwner(Any(), "deed", 3)
        var calls = 0
        val gate = ClanHubGate(expected, { expected }, { false }, { null }) { fail(it) }
        assertTrue(gate.run { calls++ })
        assertEquals(1, calls)
        gate.requireCurrent()
    }
    @Test fun `queued callback throws cancellation when original owner changed`() {
        val expected = ClanHubOwner(Any(), "deed", 3)
        val gate = ClanHubGate(expected, { null }, { false }, { null }) {}
        try { gate.requireCurrent(); fail("Expected cancellation") } catch (_: CancellationException) { }
    }

    // Why: a clanless player must land on the finder and keep the finder tab they chose (FIND, CREATE, INVITES); a member
    // tab restored from before leaving a clan must not strand them on a body that has nothing to show.
    @Test fun `clanless tabs normalise to the finder and keep the chosen finder tab`() {
        assertEquals("FIND", clanHubTab(null, hasClan = false))
        assertEquals("FIND", clanHubTab("FIND", hasClan = false))
        assertEquals("CREATE", clanHubTab("CREATE", hasClan = false))
        assertEquals("INVITES", clanHubTab("INVITES", hasClan = false))
        assertEquals("FIND", clanHubTab("CLAN", hasClan = false))
        assertEquals("FIND", clanHubTab("TOURNAMENT", hasClan = false))
    }
    // Why: the registry door says TOURNAMENT while the designed tab is TOURNEY; a member never lands on a finder tab.
    @Test fun `member tabs normalise the tournament alias and never open finder tabs`() {
        assertEquals("TOURNEY", clanHubTab("TOURNAMENT", hasClan = true))
        assertEquals("TOURNEY", clanHubTab("TOURNEY", hasClan = true))
        assertEquals("CLAN", clanHubTab(null, hasClan = true))
        assertEquals("CLAN", clanHubTab("CREATE", hasClan = true))
        assertEquals("CLAN", clanHubTab("INVITES", hasClan = true))
        assertEquals("CHARTER", clanHubTab("CHARTER", hasClan = true))
    }
}
