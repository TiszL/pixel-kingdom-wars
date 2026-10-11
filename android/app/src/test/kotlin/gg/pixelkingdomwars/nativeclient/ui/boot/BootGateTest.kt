package gg.pixelkingdomwars.nativeclient.ui.boot

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** SPEC §3.4 boot card and §3.7 update gate over the existing boot decisions. WHY these pins matter: the boot meter is a
 * sweep with nothing measured, so a percent on the designed card would be a number the game invented (D-193 rule 3);
 * every boot destination must land on exactly one surface so a launch never shows a blank frame; and a content failure
 * has no designed frame, so it must keep the D-193 strip with TRY AGAIN, the only way off a failed launch. */
class BootGateTest {
    private val gate = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/boot/BootGate.kt").readText()

    @Test fun `the boot card never shows a fabricated percent`() {
        val ui = bootLoadingUi(VERSION_LABEL_PREFIX + "0.6.6")
        assertNull("no measured progress, so no percent", ui.percent)
        assertNull("an empty track, never a fake fill", ui.progress)
        assertFalse("the card only fades when the world is ready, never on its own", ui.ready)
        // The words are the strip's own loading step and the D-192 version label: one wording, never a second one.
        assertEquals(bootStripContent(null, false).title, ui.step)
        assertEquals("PIXEL KINGDOM WARS v0.6.6", ui.version)
        // Tips are the web's non-numeric sentences, in order; no game number lives on the boot screen.
        assertEquals(BOOT_TIPS.map { it.text }, ui.tips)
        assertTrue(ui.tips.isNotEmpty() && ui.tips.none { tip -> tip.any { it.isDigit() } })
    }

    @Test fun `every boot destination draws exactly one surface`() {
        for (destination in BootDestination.values()) {
            // No else branch: a new destination does not compile until it is given its surface.
            val expected = when (destination) {
                BootDestination.UPDATE_REQUIRED -> BootSurface.UPDATE_REQUIRED
                BootDestination.UPDATE_AVAILABLE -> BootSurface.UPDATE_OPTIONAL
                BootDestination.CONTENT_FAILED -> BootSurface.CONTENT_FAILED
                // The route leaves for these on the next frame; until then the launch is still loading, not blank.
                BootDestination.LOADING, BootDestination.PREVIEW, BootDestination.TITLE, BootDestination.TOTP,
                BootDestination.ALPHA, BootDestination.HOME -> BootSurface.LOADING
            }
            assertEquals("$destination", expected, bootSurface(destination))
        }
    }

    @Test fun `a content failure keeps the D-193 strip with TRY AGAIN`() {
        assertEquals(BootSurface.CONTENT_FAILED, bootSurface(BootDestination.CONTENT_FAILED))
        // BootLoading has no action or failure slot: the failed launch keeps exactly the strip the route drew before.
        assertTrue("CONTENT_FAILED draws the strip with its TRY AGAIN",
            "BootScreen(bootLoadingStrip(contentError, retrying = bootBusy, onRetryBoot), rememberBootTip())" in gate)
        val failed = bootStripContent("network down", retrying = false)
        assertEquals("Couldn't open your kingdom", failed.title)
        assertTrue("the reason says what to do", failed.reason && failed.line != null)
        // While the retry runs the strip sweeps again instead of repeating the failure.
        assertFalse(bootStripContent("network down", retrying = true).reason)
    }

    @Test fun `the boot gate decides with the existing update helpers and only the optional gate takes Back`() {
        // The gate's rules live in the update helpers (bootRetryOffered, checkAgain, later); BootGate only maps them.
        assertTrue("bootRetryOffered(state, graph.bootUpdates.failedThisLaunch(failures))" in gate)
        assertTrue("graph.bootUpdates.checkAgain(content.error != null && !content.ready, onRetryBoot)" in gate)
        assertTrue("LATER opens the game", "onLater = { graph.bootUpdates.later() }" in gate)
        assertTrue("Back puts only the optional gate away",
            "BackHandlerAt(BackPriority.CONFIRM, enabled = gate?.kind == GateKind.UPDATE_OPTIONAL) { graph.bootUpdates.later() }" in gate)
        // UPDATE NOW on the boot route is the strips' updateNow: download if needed, then Android's installer.
        assertTrue("onDownload = { updates.updateNow(it) }, onInstall = { updates.updateNow() }" in gate)
        // The leader confirms the logo against D-193 at mount; the conflict must stay visible in the source.
        assertTrue("D-193" in gate && "LEADER CONFIRMS AT MOUNT" in gate)
    }
}
