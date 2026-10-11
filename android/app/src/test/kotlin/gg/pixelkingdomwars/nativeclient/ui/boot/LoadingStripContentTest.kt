package gg.pixelkingdomwars.nativeclient.ui.boot

import gg.pixelkingdomwars.nativeclient.model.NativeUpdateOffer
import gg.pixelkingdomwars.nativeclient.update.BOOT_REQUIRED_NOTE
import gg.pixelkingdomwars.nativeclient.update.STORE_FALLBACK
import gg.pixelkingdomwars.nativeclient.update.SystemPrompt
import gg.pixelkingdomwars.nativeclient.update.UpdateFailureKind
import gg.pixelkingdomwars.nativeclient.update.UpdateState
import gg.pixelkingdomwars.nativeclient.update.failureCopy
import gg.pixelkingdomwars.nativeclient.update.transferHeldFraction
import gg.pixelkingdomwars.nativeclient.update.updateStateMessage
import gg.pixelkingdomwars.nativeclient.update.updateStripContent
import org.junit.Assert.*
import org.junit.Test

/**
 * SHARDKEEP D-193 (4): one strip for every boot state, in the same box. What each state puts in it is a pure mapping,
 * so the words and the meter are pinned here without Compose; the buttons are decided by the update helpers the boot
 * gate's tests already cover (bootCardActions, updateForwardAction, bootRetryOffered), and the strip only draws them.
 * Rule 3 of the decision is the meter's honesty: a measured percent only when bytes are measured, never decreasing
 * within a transfer, never back to the sweep mid-download — and never the last transfer's percent on the next one.
 */
class LoadingStripContentTest {
    private val offer = NativeUpdateOffer(32, "0.6.6", "abc", "/native/releases/32-x.apk", "https://play.pixelkingdomwars.com/native/releases/32-x.apk",
        "x", 251L * 1024 * 1024, "y", "2026-09-28T00:00:00Z", "published", "stable")
    private val prompt = SystemPrompt { }

    @Test fun `the loading and failed states share the box, and a retry hides the reason while it runs`() {
        val loading = bootStripContent(null, false)
        assertEquals(LoadingStripContent("Opening your kingdom…", StripMeter.Sweep, null, reason = false), loading)
        val failed = bootStripContent("Bundle damaged", false)
        assertEquals("the failure is the title and a reason on line 2 (read aloud at once); the bundle's own error stays out of the player's line",
            LoadingStripContent("Couldn't open your kingdom", StripMeter.Still, "Please try again in a moment.", reason = true), failed)
        assertEquals("while TRY AGAIN runs the strip is the loading strip again", loading, bootStripContent("Bundle damaged", true))
    }

    @Test fun `a measured percent never decreases and never falls back to the sweep mid-download`() {
        var held = 0f
        held = heldFraction(held, 30, 100); assertEquals(.3f, held, 1e-6f)
        held = heldFraction(held, 20, 100); assertEquals("a lower byte count (a resumed range, a re-read) keeps the shown percent", .3f, held, 1e-6f)
        held = heldFraction(held, 0, 0); assertEquals("an unknown total keeps what was shown", .3f, held, 1e-6f)
        held = heldFraction(held, 200, 100); assertEquals("never past full", 1f, held, 1e-6f)
        assertEquals(StripMeter.Measured(.3f), updateStripContent(UpdateState.Downloading(offer, 30, 100), offer, false, false, .3f).meter)
        assertEquals("mid-download with a lost total the meter holds its percent", StripMeter.Measured(.3f),
            updateStripContent(UpdateState.Downloading(offer, 0, 0), offer, false, false, .3f).meter)
        assertEquals("a download that never measured sweeps, never a guessed number", StripMeter.Sweep,
            updateStripContent(UpdateState.Downloading(offer, 0, 0), offer, false, false, 0f).meter)
        assertEquals("Downloading · 30%", updateStripContent(UpdateState.Downloading(offer, 30, 100), offer, false, false, .3f).line)
        assertEquals("the percent shown is the held one", "Downloading · 30%", updateStripContent(UpdateState.Downloading(offer, 20, 100), offer, false, false, .3f).line)
    }

    @Test fun `the held percent is the transfer's own, never the last one's`() {
        // Review 2026-09-28: after a complete download the verifier deletes a HASH mismatch and TRY AGAIN restarts at
        // Downloading(0, total); a held 1.0 read "Downloading · 100%" for the whole second transfer — a number not
        // measured for it. CANCEL (Offered) and a deleted-file failure reset the same way; the states that still hold the
        // whole file (verifying, ready, waiting on Android) keep the full meter.
        var held = 0f
        held = transferHeldFraction(held, UpdateState.Downloading(offer, 100, 100)); assertEquals(1f, held, 1e-6f)
        held = transferHeldFraction(held, UpdateState.Verifying(offer)); assertEquals("every byte is in: kept", 1f, held, 1e-6f)
        held = transferHeldFraction(held, UpdateState.Failed(offer, UpdateFailureKind.HASH, true)); assertEquals("the file is gone: reset", 0f, held, 1e-6f)
        held = transferHeldFraction(held, UpdateState.Downloading(offer, 0, offer.sizeBytes))
        val restarted = updateStripContent(UpdateState.Downloading(offer, 0, offer.sizeBytes), offer, required = true, retryOffered = false, held = held)
        assertEquals("the second transfer starts at its own measured 0%", StripMeter.Measured(0f), restarted.meter)
        assertEquals("Downloading · 0%", restarted.line)
        held = transferHeldFraction(held, UpdateState.Downloading(offer, offer.sizeBytes / 2, offer.sizeBytes)); assertEquals(.5f, held, 1e-6f)
        for (kept in listOf(UpdateState.ReadyToInstall(offer), UpdateState.AwaitingUserAction(offer, prompt), UpdateState.AwaitingPermission(offer, prompt), UpdateState.Installing(offer)))
            assertEquals("$kept keeps the transfer's percent", .5f, transferHeldFraction(.5f, kept), 1e-6f)
        for (over in listOf(UpdateState.Offered(offer, false, offer.sizeBytes), UpdateState.NeedsMeteredConsent(offer), UpdateState.WaitingForBattle(offer),
            UpdateState.Failed(offer, UpdateFailureKind.NETWORK, true), UpdateState.Declined(offer), UpdateState.Installed(offer), UpdateState.Idle))
            assertEquals("$over is no transfer: reset", 0f, transferHeldFraction(.5f, over), 1e-6f)
    }

    @Test fun `every update state has its title, meter and line, and the copy is the dialog's`() {
        val states = listOf(UpdateState.Offered(offer, false, offer.sizeBytes), UpdateState.WaitingForBattle(offer), UpdateState.NeedsMeteredConsent(offer),
            UpdateState.Downloading(offer, 50, 100), UpdateState.Verifying(offer), UpdateState.ReadyToInstall(offer), UpdateState.AwaitingUserAction(offer, prompt),
            UpdateState.AwaitingPermission(offer, prompt), UpdateState.Installing(offer), UpdateState.Failed(offer, UpdateFailureKind.NETWORK, true),
            UpdateState.Failed(offer, UpdateFailureKind.SIGNER, false), UpdateState.Failed(offer, UpdateFailureKind.INSTALL, true, "STATUS_FAILURE_BLOCKED"))
        for (state in states) {
            val optional = updateStripContent(state, offer, required = false, retryOffered = false, held = .5f)
            val required = updateStripContent(state, offer, required = true, retryOffered = false, held = .5f)
            // The optional title is the version and the size without "available": LoadingStripPlanTest shows why.
            assertEquals("$state", "Update 0.6.6 · 251 MB", optional.title)
            assertEquals("$state", "Update required", required.title)
            assertEquals("$state: the meter does not depend on the kind of offer", optional.meter, required.meter)
            val meter = when (state) {
                is UpdateState.Downloading -> StripMeter.Measured(.5f)
                is UpdateState.Verifying, is UpdateState.ReadyToInstall, is UpdateState.AwaitingUserAction, is UpdateState.AwaitingPermission -> StripMeter.Measured(1f)
                is UpdateState.Installing -> StripMeter.Sweep
                else -> StripMeter.Still
            }
            assertEquals("$state: every byte in is full, Android's install is the sweep, nothing moving is still", meter, optional.meter)
            val line = when (state) {
                is UpdateState.Downloading -> "Downloading · 50%"
                is UpdateState.Failed -> if (state.detail != null) "${failureCopy(state.kind)} ${state.detail}" else failureCopy(state.kind)
                else -> updateStateMessage(state, offer)
            }
            if (state is UpdateState.Offered) {
                assertNull("an optional offer merely on offer keeps the tip", optional.line)
                assertFalse(optional.reason)
                assertEquals("a required one says why the game will not open", BOOT_REQUIRED_NOTE, required.line)
                assertTrue("and that is read aloud", required.reason)
            } else {
                assertEquals("$state", line, optional.line); assertEquals("$state", line, required.line)
                // Progress and transient status are not read aloud on every tick (the meter carries progress); a prompt, a consent or a failure is.
                val transient = state is UpdateState.Downloading || state is UpdateState.Verifying || state is UpdateState.Installing
                assertEquals("$state: reason = ${!transient}", !transient, optional.reason); assertEquals("$state", !transient, required.reason)
            }
            val retry = updateStripContent(state, offer, required = true, retryOffered = true, held = .5f)
            assertEquals("$state: CHECK AGAIN comes with the dApp Store line after the state's own words", "${required.line?.let { "$it " } ?: ""}$STORE_FALLBACK", retry.line)
        }
    }
}
