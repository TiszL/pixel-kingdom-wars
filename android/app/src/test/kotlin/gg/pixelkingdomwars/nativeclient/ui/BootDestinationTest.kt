package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.data.AccountPhase
import gg.pixelkingdomwars.nativeclient.data.LaunchMode
import gg.pixelkingdomwars.nativeclient.ui.boot.BootDestination
import gg.pixelkingdomwars.nativeclient.ui.boot.bootDestination
import gg.pixelkingdomwars.nativeclient.ui.boot.launchBoot
import gg.pixelkingdomwars.nativeclient.update.BootUpdate
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** Restoration never flashes the title, while interactive sign-in retains the route that owns
 * its coroutine. Nothing restored is presented until content has concluded. */
class BootDestinationTest {
    private fun at(phase: AccountPhase, ready: Boolean = true, error: String? = null, busy: Boolean = false, mode: LaunchMode = LaunchMode.ACCOUNT) =
        bootDestination(mode, ready, error, phase, busy)

    @Test fun `restoration without identity never presents the title`() {
        for (busy in listOf(false, true)) assertEquals(BootDestination.LOADING, at(AccountPhase.RESTORING, busy = busy))
    }
    @Test fun `wallet and social approval keep the title route that owns the running sign in`() {
        assertEquals(BootDestination.TITLE, at(AccountPhase.SIGNED_OUT, busy = true))
        assertEquals("Content preparation still prevents interactive entry", BootDestination.LOADING,
            at(AccountPhase.SIGNED_OUT, ready = false, busy = true))
    }
    @Test fun `settled signed out and failed restoration leave the title reachable`() {
        assertEquals(BootDestination.TITLE, at(AccountPhase.SIGNED_OUT))
        assertEquals(BootDestination.TITLE, at(AccountPhase.SIGNED_OUT, error = null))
    }
    @Test fun `an enrolled authenticator challenge keeps precedence while verifying`() {
        for (busy in listOf(false, true)) assertEquals(BootDestination.TOTP, at(AccountPhase.TOTP, busy = busy))
    }
    @Test fun `authenticated pre admission keeps gameplay closed even while busy`() {
        for (busy in listOf(false, true)) assertEquals(BootDestination.ALPHA, at(AccountPhase.ALPHA, busy = busy))
    }
    @Test fun `a restored account stays on the branded loading state until its content is ready`() {
        assertEquals(BootDestination.LOADING, at(AccountPhase.SIGNED_IN, ready = false))
        assertEquals(BootDestination.HOME, at(AccountPhase.SIGNED_IN))
        assertEquals("Home stays visible during a later base refresh", BootDestination.HOME, at(AccountPhase.SIGNED_IN, busy = true))
    }
    @Test fun `offline preview never falls into account loading or sign in`() {
        for (phase in AccountPhase.entries) assertEquals(BootDestination.PREVIEW, at(phase, mode = LaunchMode.OFFLINE_BASE))
        assertEquals(BootDestination.LOADING, at(AccountPhase.SIGNED_OUT, ready = false, mode = LaunchMode.OFFLINE_BATTLE))
    }
    @Test fun `a content failure offers its retry instead of a spinner or a sign in`() {
        assertEquals(BootDestination.CONTENT_FAILED, at(AccountPhase.SIGNED_IN, ready = false, error = "Bundle damaged"))
        assertEquals("Ready content with a stale error is still usable", BootDestination.HOME, at(AccountPhase.SIGNED_IN, ready = true, error = "old"))
    }
    @Test fun `the launch's update gate outranks every route, and the launch waits for it`() {
        // Owner 2026-09-27: the newer build is found on the loading screen, before the game opens. A route decided before
        // the check concludes would open a build the server may already have retired; a content failure shown first would
        // offer only a retry where the update is the way out.
        for (phase in AccountPhase.entries) for (ready in listOf(true, false)) for (error in listOf(null, "Bundle damaged")) {
            val at = { update: BootUpdate -> bootDestination(LaunchMode.ACCOUNT, ready, error, phase, false, update) }
            assertEquals("$phase ready=$ready error=$error", BootDestination.UPDATE_REQUIRED, at(BootUpdate.REQUIRED))
            assertEquals("$phase ready=$ready error=$error", BootDestination.LOADING, at(BootUpdate.CHECKING))
            assertEquals("$phase ready=$ready error=$error", BootDestination.UPDATE_AVAILABLE, at(BootUpdate.OPTIONAL))
            assertEquals("no update: exactly today's route", bootDestination(LaunchMode.ACCOUNT, ready, error, phase, false), at(BootUpdate.NONE))
        }
    }
    @Test fun `the update check starts before content admission and restore, and a content failure cannot skip it`() = runBlocking {
        // The old launch asked for updates only after content and restore had succeeded: a build whose content no longer
        // opens never asked at all. The check must be under way before either starts.
        val order = mutableListOf<String>()
        launchBoot(false, { order += "update" }, { order += "restore" }, { order += "content" })
        assertEquals("update", order.first()); assertEquals(setOf("restore", "content"), order.drop(1).toSet())
        val failed = mutableListOf<String>()
        assertTrue(runCatching { launchBoot(false, { failed += "update" }, {}, { error("Bundle damaged") }) }.isFailure)
        assertEquals(listOf("update"), failed)
        val preview = mutableListOf<String>()
        launchBoot(true, { preview += "update" }, { preview += "restore" }, { preview += "content" })
        assertEquals("an offline preview neither checks nor restores", listOf("content"), preview)
    }
    @Test fun `release launches never enter a preview mode`() {
        for (extra in listOf("base", "battle", null)) assertFalse(LaunchMode.fromLaunch(false, extra).offline)
        assertEquals(LaunchMode.OFFLINE_BATTLE, LaunchMode.fromLaunch(true, "battle"))
    }
}
