package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.phasee.islandShareTime
import gg.pixelkingdomwars.nativeclient.ui.phasee.miningClaimsControls
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ClaimPhase
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** Existing public claim vectors. This suite is authored first; only Cedar3 executes it. */
class GoldForgeClaimOwnerTest {
    private val fixture = MiningClaimsWalletFixture()
    private val preparation = fixture.preparation
    private val identity = StarterIdentity("https://fixture.test", "devnet", preparation.wallet)
    private fun operation() = MiningClaimsOperation(MiningClaimPrepareRequest(preparation.idempotencyKey), fixture.policy,
        prepareAttempted = true, preparation = preparation)
    private fun state(operation: MiningClaimsOperation? = null) = MiningClaimsState(loaded = true,
        journal = MiningClaimsJournal(1, identity, 1, operation, emptyList()), status = status())
    private fun status() = MiningClaimStatusView(MiningClaimFeatures(MiningClaimFeature(1, 1)), preparation.wallet,
        "shardkeep-economy", preparation.identity.programId, preparation.identity.keepMint, "ready", null,
        preparation.rootSequence, "80000000000", "40000000000", "40000000000", 9, 200, "7200", "7200",
        false, false, true, false, preparation.serverNow)
    private fun paid() = MiningClaimView(1, preparation.wallet, preparation.claimId, "settled", "finalized",
        fixture.signed.signature, "20000000000", listOf(MiningClaimLanding(0, "combined", fixture.signed.signature,
            "finalized", "20000000000", preparation.serverNow, preparation.serverNow)), preparation.serverNow, false)

    @Test fun `initial owner read is checking with no invented amount or action`() {
        val ui = goldForgeClaimOwnerUi(MiningClaimsState(), true, false)
        assertEquals(ClaimPhase.LOADING, ui.claim?.phase)
        assertEquals("…", ui.claim?.ready)
        assertEquals(GoldForgeClaimIntent.NONE, ui.primary)
        assertNull(ui.receipt)
    }

    @Test fun `first read failure keeps unknown amount and read retry separate from a claim result`() {
        val ui = goldForgeClaimOwnerUi(MiningClaimsState(error = "Timed out"), true, false)
        assertEquals(ClaimPhase.ERROR, ui.claim?.phase)
        assertEquals("…", ui.claim?.ready)
        assertNull(ui.claim?.failure)
        assertNull(ui.receipt)
    }

    @Test fun `ready amount comes from current allocation not cumulative preparation`() {
        val ui = goldForgeClaimOwnerUi(state(), true, false)
        assertEquals("40", ui.claim?.ready)
        assertEquals(ClaimPhase.READY, ui.claim?.phase)
        assertEquals(GoldForgeClaimIntent.PREPARE, ui.primary)
        assertTrue(ui.claim!!.actionsAllowed)
        assertNull(ui.claim!!.readyDays)
    }

    @Test fun `current allocation uses its own precision independently from saved original`() {
        val ui = goldForgeClaimOwnerUi(state(operation()).copy(status = status().copy(decimals = 4)), true, false)
        assertEquals("4000000", ui.claim?.ready)
    }

    @Test fun `another wallet status never supplies the displayed allocation`() {
        val ui = goldForgeClaimOwnerUi(state().copy(status = status().copy(wallet = "another-wallet")), true, false)
        assertNull(ui.claim)
        assertNotNull(ui.notice)
        assertEquals(GoldForgeClaimIntent.NONE, ui.primary)
    }

    @Test fun `failed refresh discards the displayed amount but retains original recovery`() {
        val ui = goldForgeClaimOwnerUi(state(operation()).copy(error = "Lost the server"), false, false)
        assertEquals("…", ui.claim?.ready)
        assertEquals(GoldForgeClaimIntent.CHECK, ui.primary)
        assertNull(ui.claim?.failure)
        assertNull(ui.receipt)
    }

    @Test fun `no allocation is an empty tray notice without a fabricated completed collection`() {
        val ui = goldForgeClaimOwnerUi(state().copy(status = status().copy(state = "no_allocation",
            claimableBaseUnits = "0", preparationAllowed = false)), true, false)
        assertNull(ui.claim)
        assertEquals("The tray is empty. No KEEP is ready to collect.", ui.notice)
        assertEquals(GoldForgeClaimIntent.NONE, ui.primary)
        assertNull(ui.receipt)
    }

    @Test fun `delayed claim uses the project date formatter and remains locked`() {
        val ui = goldForgeClaimOwnerUi(state().copy(status = status().copy(state = "delayed", preparationAllowed = false)), true, false)
        assertEquals(ClaimPhase.LOCKED, ui.claim?.phase)
        assertEquals(islandShareTime(Instant.ofEpochSecond(7200).toString()), ui.claim?.lock?.date)
        assertEquals(GoldForgeClaimIntent.NONE, ui.primary)
    }

    @Test fun `paused revoked and unavailable snapshots cannot enable new claims`() {
        for (statusName in listOf("paused", "revoked", "unavailable")) {
            val ui = goldForgeClaimOwnerUi(state().copy(status = status().copy(state = statusName,
                preparationAllowed = false)), true, false)
            assertEquals(GoldForgeClaimIntent.NONE, ui.primary)
            assertNull(ui.claim)
            assertNotNull(ui.notice)
        }
    }

    @Test fun `configuration admission running and owner busy gates keep preparation closed`() {
        assertEquals(GoldForgeClaimIntent.NONE, goldForgeClaimOwnerUi(state(), false, false).primary)
        assertEquals(GoldForgeClaimIntent.NONE, goldForgeClaimOwnerUi(state(), true, true).primary)
        assertEquals(GoldForgeClaimIntent.NONE, goldForgeClaimOwnerUi(state().copy(busy = true), true, false).primary)
    }

    @Test fun `saved unsigned original opens fresh review and never prepares a second claim`() {
        val ui = goldForgeClaimOwnerUi(state(operation()), true, false)
        assertTrue(ui.claim!!.canResumeSaved)
        assertEquals(GoldForgeClaimIntent.REVIEW, ui.primary)
    }

    @Test fun `saved claim recovery remains readable with new action admission closed`() {
        val ui = goldForgeClaimOwnerUi(state(operation()), false, false)
        assertEquals(GoldForgeClaimIntent.CHECK, ui.primary)
        assertTrue(ui.claim!!.canResumeSaved)
    }

    @Test fun `approval submission uncertainty and retained receipt do not prove success`() {
        val op = operation()
        for (original in listOf(op, op.copy(signingStarted = true), op.copy(signingStarted = true, signed = fixture.saved),
            op.copy(signingStarted = true, signed = fixture.saved, submitAttempted = true),
            op.copy(claim = paid().copy(state = "retained", landing = "pending", settledBaseUnits = null)))) {
            val ui = goldForgeClaimOwnerUi(state(original), true, false)
            assertNull(ui.receipt)
            assertNotEquals(MoneyStage.SENT, ui.claim?.stage)
        }
    }

    @Test fun `only original finalized paid receipt yields celebration using original precision`() {
        val ui = goldForgeClaimOwnerUi(state(operation().copy(claim = paid())).copy(status = status().copy(decimals = 4)), true, false)
        assertEquals("+20 KEEP", ui.receipt?.ribbon)
        assertEquals(preparation.claimId, ui.receipt?.receiptId)
        assertEquals(ClaimPhase.COLLECTED, ui.claim?.phase)
        assertEquals(MoneyStage.SENT, ui.claim?.stage)
    }

    @Test fun `another wallet another claim held custody and nonfinalized outcome never celebrate`() {
        val op = operation().copy(claim = paid())
        for (original in listOf(op.copy(claim = paid().copy(wallet = "other-wallet")),
            op.copy(claim = paid().copy(claimId = "other-claim")), op.copy(ordered = MiningOrderedCustody(held = true)),
            op.copy(claim = paid().copy(landing = "pending")))) {
            assertNull(goldForgeClaimOwnerUi(state(original), true, false).receipt)
        }
    }

    @Test fun `history alone never starts a new receipt celebration`() {
        val historical = state().copy(journal = state().journal!!.copy(archives = listOf(operation().copy(claim = paid()))))
        assertNull(goldForgeClaimOwnerUi(historical, true, false).receipt)
    }

    @Test fun `wallet seal requires exact current reviewed object and unchanged control admission`() {
        val reviewed = state(operation()).copy(review = preparation)
        val controls = miningClaimsControls(reviewed, true)
        assertTrue(goldForgeClaimSealAdmitted(preparation, preparation, controls))
        assertFalse(goldForgeClaimSealAdmitted(preparation, preparation.copy(), controls))
        assertFalse(goldForgeClaimSealAdmitted(null, preparation, controls))
        assertFalse(goldForgeClaimSealAdmitted(preparation, preparation, miningClaimsControls(reviewed, false)))
        assertFalse(goldForgeClaimSealAdmitted(preparation, preparation, miningClaimsControls(reviewed, true, true)))
    }

    @Test fun `wallet details use only the captured current owner suffix`() {
        val details = goldForgeClaimWalletDetails(state(), identity)
        assertEquals(identity.wallet.takeLast(4), details?.last4)
        assertNull(details?.walletLabel)
        assertNull(goldForgeClaimWalletDetails(MiningClaimsState(), identity))
        assertNull(goldForgeClaimWalletDetails(state(), null))
    }

    @Test fun `wallet details disappear when account or origin changes`() {
        val journal = state().journal!!
        assertNull(goldForgeClaimWalletDetails(state().copy(journal = journal.copy(
            identity = identity.copy(wallet = "another-wallet"))), identity))
        assertNull(goldForgeClaimWalletDetails(state().copy(journal = journal.copy(
            identity = identity.copy(origin = "https://other.fixture.test"))), identity))
    }

    @Test fun `wallet details mount the designed half sheet in a modal input boundary`() {
        val screen = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/phasee/MiningClaimsScreen.kt").readText()
        assertTrue(screen.contains("WalletDetailsSheet("))
        assertTrue(screen.contains("goldForgeClaimWalletDetails(model.state.value, walletDetailsIdentity)"))
        assertTrue(screen.contains("Dialog(onDismissRequest = closeWalletDetails"))
        assertTrue(screen.contains("DialogProperties(usePlatformDefaultWidth = false)"))
        assertTrue(screen.contains("ModalScrim(0f, closeWalletDetails)"))
        assertTrue(screen.contains("BackHandlerAt(BackPriority.CONFIRM, showWalletDetails)"))
        assertTrue(screen.contains("onPastCollections ="))
        assertTrue(screen.contains("onChangeWallet ="))
        assertFalse(screen.contains("if (showWalletDetails) AlertDialog"))
    }

    @Test fun `claim navigation prefers explicit callbacks then the existing host navigation`() {
        val root = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/"
        val screen = java.io.File(root + "ui/phasee/MiningClaimsScreen.kt").readText()
        val owner = java.io.File(root + "ui/goldforge/GoldForgeClaimOwner.kt").readText()
        assertTrue(owner.contains("data class GoldForgeClaimNavigation("))
        assertTrue(owner.contains("staticCompositionLocalOf<GoldForgeClaimNavigation?> { null }"))
        assertTrue(screen.contains("val navigation = LocalGoldForgeClaimNavigation.current"))
        assertTrue(screen.contains("val goSmelt = onGoSmelt ?: navigation?.onGoSmelt"))
        assertTrue(screen.contains("val goSeeker = onGoSeeker ?: navigation?.onGoSeeker"))
        assertTrue(screen.contains("val changeWallet = onChangeWallet ?: navigation?.onChangeWallet"))
        assertTrue(screen.contains("goSmelt?.invoke()"))
        assertTrue(screen.contains("goSeeker?.invoke()"))
        assertTrue(screen.contains("changeWallet?.invoke()"))
        assertFalse(owner.contains("miningClaimsClient("))
    }
}
