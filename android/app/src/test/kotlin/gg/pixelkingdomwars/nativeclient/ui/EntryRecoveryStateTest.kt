package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.FakeBattleRepository
import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.data.EntryRecovery
import gg.pixelkingdomwars.nativeclient.ui.nav.EntryRecoveryState
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class EntryRecoveryStateTest {
    @Test fun `offline entry stays unknown until an explicit read recovers the pending march`() = runBlocking {
        val battle = FakeBattleRepository()
        val recovery = EntryRecoveryState()
        battle.failWith = IOException("offline")
        assertNull(recovery.check(BASE_ID) { battle.recoverOnEntry() })
        assertFalse(recovery.recovered)
        assertEquals("offline", recovery.error)
        assertFalse(recovery.checking)
        assertEquals("Failure must not trigger a retry or a mutation", listOf("entry"), battle.calls)
        battle.failWith = null
        battle.entry = EntryRecovery.BATTLE
        assertEquals(EntryRecovery.BATTLE, recovery.check(BASE_ID) { battle.recoverOnEntry() })
        assertTrue(recovery.recovered)
        assertNull(recovery.error)
        assertNull(recovery.check(BASE_ID) { battle.recoverOnEntry() })
        assertEquals("Only the explicit recovery check runs again", listOf("entry", "entry"), battle.calls)
    }
    @Test fun `only a successful no-march response completes empty entry recovery`() = runBlocking {
        val recovery = EntryRecoveryState()
        assertEquals(EntryRecovery.NONE, recovery.check(BASE_ID) { EntryRecovery.NONE })
        assertTrue(recovery.recovered)
    }
    @Test fun `cancelled entry cannot become a completed or failed recovery`() = runBlocking {
        val recovery = EntryRecoveryState()
        assertThrows(CancellationException::class.java) { runBlocking { recovery.check(BASE_ID) { throw CancellationException() } } }
        assertFalse(recovery.recovered)
        assertFalse(recovery.checking)
        assertNull(recovery.error)
    }
    @Test fun `switching deeds requires a fresh pending-march read in the same account session`() = runBlocking {
        val recovery = EntryRecoveryState()
        assertEquals(EntryRecovery.NONE, recovery.check(BASE_ID) { EntryRecovery.NONE })
        assertEquals(EntryRecovery.BATTLE, recovery.check("c0ffee00-1af2-41b4-9a65-638428c388a3") { EntryRecovery.BATTLE })
        assertTrue(recovery.recovered)
        assertEquals("Returning to a deed rechecks because its pending march may have changed", EntryRecovery.HISTORY,
            recovery.check(BASE_ID) { EntryRecovery.HISTORY })
    }
}
