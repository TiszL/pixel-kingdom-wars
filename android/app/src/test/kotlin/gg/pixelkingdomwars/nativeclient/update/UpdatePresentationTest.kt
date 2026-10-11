package gg.pixelkingdomwars.nativeclient.update

import gg.pixelkingdomwars.nativeclient.update.UpdatePresentation.Banner
import gg.pixelkingdomwars.nativeclient.update.UpdatePresentation.FullScreen
import gg.pixelkingdomwars.nativeclient.update.UpdatePresentation.None
import gg.pixelkingdomwars.nativeclient.update.UpdateAction.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Owner 2026-09-25: a required update gets its own loading-style screen. WHY the table matters: a mandatory update
 * pauses every order, so it must never hide behind a small banner the player can scroll past or overlook; an optional
 * one must never take the screen from a player who may keep playing. Compose only renders this answer, so every
 * state x flag pair is pinned here. */
class UpdatePresentationTest {
    private val bytes = "the signed apk".toByteArray()
    private val prompt = SystemPrompt { }

    /** One of every [UpdateState], carrying an offer whose own flag agrees with the repository's. */
    private fun states(mandatory: Boolean): List<UpdateState> {
        val offer = offer(bytes, mandatory = mandatory)
        return listOf(UpdateState.Idle, UpdateState.Offered(offer, mandatory, offer.sizeBytes), UpdateState.WaitingForBattle(offer),
            UpdateState.NeedsMeteredConsent(offer), UpdateState.Downloading(offer, 7, offer.sizeBytes), UpdateState.Verifying(offer),
            UpdateState.ReadyToInstall(offer), UpdateState.AwaitingUserAction(offer, prompt), UpdateState.AwaitingPermission(offer, prompt),
            UpdateState.Installing(offer), UpdateState.Installed(offer), UpdateState.Declined(offer),
            UpdateState.Failed(offer, UpdateFailureKind.NETWORK, retryable = true), UpdateState.Failed(offer, UpdateFailureKind.SIGNER, retryable = false))
    }

    /** The intent table (required, optional). No else branch: a new state does not compile until it is classified. */
    private fun expected(state: UpdateState): Pair<UpdatePresentation, UpdatePresentation> = when (state) {
        // Nothing to offer, the player declined an optional file, or the install already happened: no update chrome.
        UpdateState.Idle, is UpdateState.Declined, is UpdateState.Installed -> None to None
        // Every step from the offer to the system installer, failures included: the player still has to act or wait.
        is UpdateState.Offered, is UpdateState.WaitingForBattle, is UpdateState.NeedsMeteredConsent, is UpdateState.Downloading,
        is UpdateState.Verifying, is UpdateState.ReadyToInstall, is UpdateState.AwaitingUserAction, is UpdateState.AwaitingPermission,
        is UpdateState.Installing, is UpdateState.Failed -> FullScreen to Banner
    }

    @Test fun `every update state resolves to one presentation for a required and an optional offer`() {
        for (mandatory in listOf(true, false)) {
            val states = states(mandatory)
            // All thirteen variants; Failed is sampled twice, retryable and not.
            assertEquals(13, states.map { it::class }.distinct().size)
            for (state in states) {
                val (required, optional) = expected(state)
                assertEquals("$state, mandatory=$mandatory", if (mandatory) required else optional, updatePresentation(state, mandatory))
            }
        }
    }

    @Test fun `a required update never shows as a banner and an optional one never takes the screen`() {
        for (state in states(true)) assertEquals("$state", false, updatePresentation(state, true) == Banner)
        for (state in states(false)) assertEquals("$state", false, updatePresentation(state, false) == FullScreen)
    }

    @Test fun `the repository's current flag decides, not the copy inside a state already in progress`() {
        // The server may flip a published file to mandatory mid-download: orders pause at once, so the screen follows.
        val optional = offer(bytes, mandatory = false)
        assertEquals(FullScreen, updatePresentation(UpdateState.Downloading(optional, 7, optional.sizeBytes), mandatory = true))
        // Once the server withdraws the requirement, orders resume and the player may keep playing beside a banner.
        val required = offer(bytes, mandatory = true)
        assertEquals(Banner, updatePresentation(UpdateState.ReadyToInstall(required), mandatory = false))
    }

    /** The dialog's buttons per state (required, optional offer). No else branch: a new state must be given its buttons. */
    private fun expectedDialog(state: UpdateState, mandatory: Boolean): List<UpdateAction> = when (state) {
        // The banner draws nothing for these, so there is no dialog.
        UpdateState.Idle, is UpdateState.Declined, is UpdateState.Installed -> emptyList()
        // Only an optional offer can be declined; a required one can only be put away until later.
        is UpdateState.Offered -> listOf(DOWNLOAD, if (mandatory) LATER else NOT_NOW)
        is UpdateState.WaitingForBattle -> listOf(DOWNLOAD, LATER)
        is UpdateState.NeedsMeteredConsent -> listOf(DOWNLOAD_ANYWAY, LATER)
        is UpdateState.Downloading -> listOf(CANCEL, LATER)
        // Nothing to press while the file is checked or handed to Android: one LATER closes the dialog, the work carries on.
        is UpdateState.Verifying, is UpdateState.Installing -> listOf(LATER)
        is UpdateState.ReadyToInstall -> listOf(INSTALL, LATER)
        is UpdateState.AwaitingUserAction -> listOf(OPEN_INSTALLER, LATER)
        is UpdateState.AwaitingPermission -> listOf(OPEN_SETTINGS, LATER)
        is UpdateState.Failed -> if (state.retryable) listOf(TRY_AGAIN, LATER) else listOf(LATER)
    }

    @Test fun `every update dialog shows one way to put it away and never the same button twice`() {
        // Emulator acceptance: the Verifying and "Handing the update to Android…" dialogs drew LATER twice, because the
        // forward slot and the dismiss slot both fell back to it. Two identical buttons read as a broken dialog.
        for (mandatory in listOf(true, false)) for (state in states(mandatory)) {
            val actions = updateDialogActions(state, mandatory)
            assertEquals("$state, mandatory=$mandatory", expectedDialog(state, mandatory), actions)
            assertEquals("$state", actions.distinct(), actions)
            if (actions.isNotEmpty()) assertEquals("$state", 1, actions.count { it == LATER || it == NOT_NOW })
        }
    }

    @Test fun `the required-update screen draws only the forward action and never a way to postpone`() {
        // A required update pauses every order; its screen has no dismiss control, so the only button it may draw is the
        // dialog's forward action, and verifying or installing leaves the player nothing to press but nothing broken.
        for (state in states(true)) {
            val forward = updateForwardAction(state)
            assertEquals("$state", expectedDialog(state, true).filterNot { it == LATER || it == NOT_NOW }.singleOrNull(), forward)
            assertFalse("$state", forward == LATER || forward == NOT_NOW)
        }
    }

    @Test fun `install copy never promises a restart and tells the player to open the game again`() {
        // After PackageInstaller finishes, Android returns to the launcher; the app is not relaunched. Promising "the game
        // restarts afterwards" leaves the player staring at the home screen, waiting.
        for (mandatory in listOf(true, false)) for (state in states(mandatory)) {
            val message = state.offer?.let { updateStateMessage(state, it) } ?: continue
            assertFalse(message, message.contains("restart", ignoreCase = true))
        }
        val offer = offer(bytes)
        for (state in listOf(UpdateState.ReadyToInstall(offer), UpdateState.AwaitingUserAction(offer, prompt))) {
            val message = requireNotNull(updateStateMessage(state, offer))
            assertTrue(message, message.contains("Android asks you to confirm") || message.contains("Confirm the install"))
            assertTrue(message, message.contains("open Pixel Kingdom Wars again; your progress is kept on the server"))
        }
    }
}
