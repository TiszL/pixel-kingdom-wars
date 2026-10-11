package gg.pixelkingdomwars.nativeclient.update

import gg.pixelkingdomwars.nativeclient.ui.nav.Gate
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.GateKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubMotion
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.gateDismissible
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** SPEC §3.7 gates over the existing update decisions. WHY these pins matter: K-210 (2026-09-27) left a store install
 * with no way forward, and a required update that only draws a dead UPDATE button strands a build that can no longer
 * open the game. The designed gate has ONE UPDATE button, so every update state must give that button a real job (the
 * strip's own forward action), honest busy dots while the update moves by itself, or CHECK AGAIN with the dApp Store
 * line; a required gate must never be put away, and the API's 426 and maintenance gates must never trap a player who can
 * still browse. GateCard is Compose-only, so the mapping it draws is pinned here. */
class UpdateGateTest {
    private val bytes = "the signed apk".toByteArray()
    private val prompt = SystemPrompt { }

    /** One of every [UpdateState] with an offer; Failed is sampled retryable, unretryable and as an install failure. */
    private fun states(mandatory: Boolean = true): List<UpdateState> {
        val offer = offer(bytes, mandatory = mandatory)
        return listOf(UpdateState.Offered(offer, mandatory, offer.sizeBytes), UpdateState.WaitingForBattle(offer),
            UpdateState.NeedsMeteredConsent(offer), UpdateState.Downloading(offer, 7, offer.sizeBytes), UpdateState.Verifying(offer),
            UpdateState.ReadyToInstall(offer), UpdateState.AwaitingUserAction(offer, prompt), UpdateState.AwaitingPermission(offer, prompt),
            UpdateState.Installing(offer), UpdateState.Installed(offer), UpdateState.Declined(offer),
            UpdateState.Failed(offer, UpdateFailureKind.NETWORK, retryable = true),
            UpdateState.Failed(offer, UpdateFailureKind.INSTALL, retryable = true),
            UpdateState.Failed(offer, UpdateFailureKind.SIGNER, retryable = false))
    }

    /** JUnit's assertNotNull returns nothing: this fails loud and hands the gate back. */
    private fun <T : Any> shown(value: T?): T { assertNotNull("expected a gate", value); return value!! }

    /** The intent table. No else branch: a new state does not compile until UPDATE is given a job for it. */
    private fun expected(state: UpdateState): GateUpdateTap? = when (state) {
        UpdateState.Idle -> null
        is UpdateState.Offered, is UpdateState.WaitingForBattle -> GateUpdateTap.Forward(UpdateAction.DOWNLOAD)
        is UpdateState.NeedsMeteredConsent -> GateUpdateTap.Forward(UpdateAction.DOWNLOAD_ANYWAY)
        // Bytes moving, the file being checked, Android installing: the player waits; a second tap must not restart it.
        is UpdateState.Downloading, is UpdateState.Verifying, is UpdateState.Installing -> GateUpdateTap.Busy
        is UpdateState.ReadyToInstall -> GateUpdateTap.Forward(UpdateAction.INSTALL)
        is UpdateState.AwaitingUserAction -> GateUpdateTap.Forward(UpdateAction.OPEN_INSTALLER)
        is UpdateState.AwaitingPermission -> GateUpdateTap.Forward(UpdateAction.OPEN_SETTINGS)
        is UpdateState.Failed -> if (state.retryable) GateUpdateTap.Forward(UpdateAction.TRY_AGAIN) else GateUpdateTap.CheckAgain
        // Nothing left for the update to do on this device: UPDATE checks again (K-210: never a dead button).
        is UpdateState.Installed, is UpdateState.Declined -> GateUpdateTap.CheckAgain
    }

    /** Records which of the strip button's callbacks UPDATE ran. */
    private class Recorder {
        val calls = mutableListOf<String>()
        val gate = UpdateGateCalls(onDownload = { calls += "download:$it" }, onInstall = { calls += "install" },
            onCancel = { calls += "cancel" }, onConfirm = { calls += "confirm" }, onOpenSettings = { calls += "settings" },
            onCheckAgain = { calls += "check" })
    }

    @Test fun `every update state gives UPDATE a forward action, busy dots or CHECK AGAIN`() {
        for (state in states()) {
            val tap = gateUpdateTap(state)
            assertNotNull("$state must give the one UPDATE button a job", tap)
            assertEquals("$state", expected(state), tap)
            val ui = shown(updateGateUi(state, required = true, retryOffered = bootRetryOffered(state, false)))
            // Busy dots are the only state in which UPDATE takes no tap, and only while the update moves by itself.
            assertEquals("$state", tap == GateUpdateTap.Busy, ui.updating)
        }
        assertNull("no offer, no gate: the boot screen keeps loading", gateUpdateTap(UpdateState.Idle))
        assertNull(updateGateUi(UpdateState.Idle, required = true, retryOffered = true))
    }

    @Test fun `UPDATE runs exactly the callback the strip button ran for the same state`() {
        val offer = offer(bytes, mandatory = true)
        val table = listOf(
            UpdateState.Offered(offer, true, offer.sizeBytes) to listOf("download:false"),
            UpdateState.WaitingForBattle(offer) to listOf("download:false"),
            UpdateState.NeedsMeteredConsent(offer) to listOf("download:true"),
            UpdateState.ReadyToInstall(offer) to listOf("install"),
            UpdateState.AwaitingUserAction(offer, prompt) to listOf("confirm"),
            UpdateState.AwaitingPermission(offer, prompt) to listOf("settings"),
            // UpdateActionButton's TRY AGAIN: an install failure installs again, any other retryable failure downloads.
            UpdateState.Failed(offer, UpdateFailureKind.NETWORK, retryable = true) to listOf("download:false"),
            UpdateState.Failed(offer, UpdateFailureKind.INSTALL, retryable = true) to listOf("install"),
            UpdateState.Failed(offer, UpdateFailureKind.SIGNER, retryable = false) to listOf("check"),
            UpdateState.Installed(offer) to listOf("check"),
        )
        for ((state, calls) in table) {
            val recorder = Recorder()
            assertTrue("$state acts", runGateUpdate(state, recorder.gate))
            assertEquals("$state", calls, recorder.calls)
        }
        for (state in listOf(UpdateState.Downloading(offer, 7, offer.sizeBytes), UpdateState.Verifying(offer), UpdateState.Installing(offer), UpdateState.Idle)) {
            val recorder = Recorder()
            // False lets the gate say why ("still working") instead of silently doing nothing; it never cancels a download.
            assertFalse("$state", runGateUpdate(state, recorder.gate))
            assertEquals("$state", emptyList<String>(), recorder.calls)
        }
    }

    @Test fun `the required gate never offers LATER and the optional one does`() {
        for (state in states()) {
            val required = shown(updateGateUi(state, required = true, retryOffered = false))
            assertEquals(GateKind.UPDATE_REQUIRED, required.kind)
            assertFalse("$state: a required update cannot be put away (LATER or Back)", gateDismissible(required.kind))
            assertEquals("UPDATE TO KEEP PLAYING", required.title)
            val inGame = shown(inGameUpdateGateUi(state, canCheckAgain = true))
            assertFalse("$state: Title and Home cannot put a required update away either", gateDismissible(inGame.kind))
        }
        for (state in states(mandatory = false)) {
            val optional = shown(updateGateUi(state, required = false, retryOffered = false))
            assertEquals(GateKind.UPDATE_OPTIONAL, optional.kind)
            assertTrue("$state: LATER opens the game", gateDismissible(optional.kind))
            assertEquals("A NEW VERSION IS READY", optional.title)
        }
    }

    @Test fun `an update with no way forward says CHECK AGAIN and names the dApp Store`() {
        val offer = offer(bytes, mandatory = true)
        val stuck = UpdateState.Failed(offer, UpdateFailureKind.SIGNER, retryable = false)
        val boot = shown(updateGateUi(stuck, required = true, retryOffered = bootRetryOffered(stuck, false))).body
        assertTrue(boot, GATE_CHECK_LINE in boot)
        assertTrue("the store is always the way off a stuck build", STORE_FALLBACK in boot)
        // Title and Home without a wired check: no promise that UPDATE checks, but the store line still shows the way on.
        val inGame = shown(inGameUpdateGateUi(stuck, canCheckAgain = false)).body
        assertFalse(inGame, GATE_CHECK_LINE in inGame)
        assertTrue(inGame, STORE_FALLBACK in inGame)
        // A launch that already failed keeps the store line even while UPDATE can try again (bootRetryOffered's rule).
        val retry = UpdateState.Failed(offer, UpdateFailureKind.NETWORK, retryable = true)
        assertTrue(STORE_FALLBACK in shown(updateGateUi(retry, required = true, retryOffered = true)).body)
        assertFalse("a healthy offer does not talk about the store", STORE_FALLBACK in
            shown(updateGateUi(UpdateState.Offered(offer, true, offer.sizeBytes), required = true, retryOffered = false)).body)
    }

    @Test fun `the boot gate keeps the boot note and the in-game gate keeps the orders-paused note`() {
        val offer = offer(bytes, mandatory = true)
        val offered = UpdateState.Offered(offer, true, offer.sizeBytes)
        // One wording per place (owner 2026-09-25 and 2026-09-27): the boot build cannot open the game at all, while an
        // in-game required update only pauses orders. Mixing them would tell a playing kingdom it cannot open.
        val boot = shown(updateGateUi(offered, required = true, retryOffered = false)).body
        assertTrue(boot, BOOT_REQUIRED_NOTE in boot)
        val inGame = shown(inGameUpdateGateUi(offered, canCheckAgain = false)).body
        assertTrue(inGame, MANDATORY_UPDATE_NOTE in inGame)
        assertFalse(inGame, BOOT_REQUIRED_NOTE in inGame)
    }

    @Test fun `the size shows only when the server sent one and no release notes are invented`() {
        val sized = offer(bytes, mandatory = true, size = 251L * 1024 * 1024)
        assertEquals("0.5.9 · 251 MB", gateSizeLine(UpdateState.Offered(sized, true, sized.sizeBytes), sized))
        val unsized = offer(bytes, mandatory = true, size = 0)
        assertEquals("never a fake 0 MB", "0.5.9", gateSizeLine(UpdateState.Offered(unsized, true, 0), unsized))
        // NativeUpdateOffer carries no release notes, so WHAT'S NEW stays hidden on every state.
        for (state in states()) assertEquals("$state", emptyList<Any>(), shown(updateGateUi(state, true, false)).notes)
    }

    @Test fun `a 426 gate without an offer can still be put away to keep browsing`() {
        val noOffer = shown(serverGateUi(Gate.Update("The server moved on"), hasOffer = false, nextCheckIn = null))
        assertEquals(GateKind.UPDATE_OPTIONAL, noOffer.kind)
        assertTrue("LATER is the old dialog's Continue browsing, so the gate is never a dead end", gateDismissible(noOffer.kind))
        assertTrue(noOffer.body, NO_OFFER_YET in noOffer.body)
        assertTrue("the server's words are kept, as a sentence", noOffer.body.startsWith("The server moved on."))
        val withOffer = shown(serverGateUi(Gate.Update("Update required."), hasOffer = true, nextCheckIn = null))
        assertTrue(gateDismissible(withOffer.kind))
        assertTrue(withOffer.body, ORDERS_LOCKED in withOffer.body && ACCOUNT_KEPT in withOffer.body)
        assertFalse(withOffer.body, NO_OFFER_YET in withOffer.body)
    }

    @Test fun `maintenance without an ETA says Back soon and counts down to an automatic check`() {
        val ui = shown(serverGateUi(Gate.Maintenance("  "), hasOffer = false, nextCheckIn = "0:30"))
        assertEquals(GateKind.MAINTENANCE, ui.kind)
        assertEquals(MAINTENANCE_TITLE, ui.title)
        assertEquals("blank server words fall back to the owner's line", MAINTENANCE_FALLBACK, ui.body)
        // The event carries no ETA: never an invented time. GateCard says "Back soon." for a null ETA.
        assertNull(ui.etaLine)
        val card = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/hub/GateCard.kt").readText()
        assertTrue("GateCard reads a null ETA as Back soon", "if (eta == null) append(\" Back soon.\")" in card)
        assertEquals("0:30", ui.nextCheckIn)
        assertFalse("maintenance has no LATER: the player cannot act on a realm that is down", gateDismissible(ui.kind))
        assertEquals("Back at 14:00 UTC.", shown(serverGateUi(Gate.Maintenance("Back at 14:00 UTC"), false, null)).body)
        // One tick per second; the check fires when the count runs out and the count starts again.
        assertEquals(29 to false, maintenanceTick(30))
        assertEquals(HubMotion.MAINTENANCE_CHECK_SECONDS to true, maintenanceTick(1))
        var remaining = HubMotion.MAINTENANCE_CHECK_SECONDS
        var checks = 0
        repeat(HubMotion.MAINTENANCE_CHECK_SECONDS * 2) { val (next, due) = maintenanceTick(remaining); remaining = next; if (due) checks++ }
        assertEquals("one automatic check every MAINTENANCE_CHECK_SECONDS", 2, checks)
    }

    @Test fun `the other routing gates are not drawn as update or maintenance cards`() {
        // Alpha, Funds and Info keep their own dialogs; a GateCard for them would hide the sign-out or the funds reason.
        assertNull(serverGateUi(Gate.Alpha, hasOffer = true, nextCheckIn = null))
        assertNull(serverGateUi(Gate.Funds("INSUFFICIENT_SHARDS", "Not enough shards"), hasOffer = true, nextCheckIn = null))
        assertNull(serverGateUi(Gate.Info("Try again"), hasOffer = true, nextCheckIn = null))
    }
}
