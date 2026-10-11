package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.*
import gg.pixelkingdomwars.nativeclient.ui.title.*
import gg.pixelkingdomwars.nativeclient.wallet.SocialProvider
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class TitleHubMountTest {
    private val signedOut = AccountState(phase = AccountPhase.SIGNED_OUT)

    @Test fun `signed out choices use available owners without inventing a paired wallet`() {
        val ui = liveTitleUi(signedOut, SocialUiState(), false, true, true, "actual version")
        assertEquals("actual version", ui.version)
        assertNull(ui.lastWalletLabel); assertTrue(ui.showAnotherWallet)
        assertTrue(ui.walletAdapterAvailable)
        assertEquals(listOf("google", "x", "email"), ui.socialProviders.map { it.id })
        assertTrue(ui.socialProviders.all { it.enabled && !it.busy })
        assertNull(ui.busy); assertNull(ui.socialUnavailable)
    }

    @Test fun `missing adapter or social configuration preserves honest unavailable choices`() {
        val offline = liveTitleUi(signedOut, SocialUiState(), false, false, true, "build")
        assertFalse(offline.walletAdapterAvailable); assertFalse(offline.showAnotherWallet)
        assertNotNull(offline.walletUnavailable); assertNotNull(offline.socialUnavailable)
        assertTrue(offline.socialProviders.isEmpty())
        val noSocial = liveTitleUi(signedOut, SocialUiState(), false, true, false, "build")
        assertTrue(noSocial.walletAdapterAvailable); assertNotNull(noSocial.socialUnavailable)
    }

    @Test fun `social and wallet busy states disable all alternative submissions`() {
        val social = liveTitleUi(signedOut.copy(busy = true), SocialUiState(inFlight = SocialProvider.GOOGLE, browser = true),
            true, true, true, "build")
        assertEquals(TitleBusy.SOCIAL, social.busy)
        assertEquals(listOf("google"), social.socialProviders.filter { it.busy }.map { it.id })
        assertTrue(social.socialProviders.none { it.enabled })
        val wallet = liveTitleUi(signedOut, SocialUiState(), true, true, true, "build", walletConnecting = true)
        assertEquals(TitleBusy.WALLET_CHECK, wallet.busy)
        assertTrue(wallet.socialProviders.none { it.enabled })
    }

    @Test fun `callbacks refuse a changed phase or busy owner and provider ids are explicit`() {
        assertTrue(titleEntryAllowed(signedOut, false))
        assertFalse(titleEntryAllowed(signedOut.copy(busy = true), false))
        assertFalse(titleEntryAllowed(signedOut, true))
        for (phase in AccountPhase.entries.filter { it != AccountPhase.SIGNED_OUT })
            assertFalse(titleEntryAllowed(AccountState(phase = phase), false))
        assertEquals(SocialProvider.EMAIL, titleProvider("email"))
        assertNull(titleProvider("unknown"))
    }

    @Test fun `TOTP accepts six ascii digits only while its pending owner is idle`() {
        val pending = AccountState(phase = AccountPhase.TOTP, pendingWallet = "wallet")
        assertTrue(titleTotpReady(pending, false, "123456"))
        assertFalse(titleTotpReady(pending, true, "123456"))
        assertFalse(titleTotpReady(pending.copy(busy = true), false, "123456"))
        assertFalse(titleTotpReady(signedOut, false, "123456"))
        for (code in listOf("12345", "1234567", "12345a", "１２３４５６")) assertFalse(titleTotpReady(pending, false, code))
    }

    @Test fun `title error and signed in transition preserve authoritative state`() {
        assertEquals("owner error", liveTitleUi(signedOut.copy(error = "owner error"), SocialUiState(), false, true, true, "build").error)
        assertEquals("notice", liveTitleUi(signedOut.copy(error = "owner error"), SocialUiState(), false, true, true, "build", error = "notice").error)
        assertTrue(liveTitleUi(AccountState(phase = AccountPhase.SIGNED_IN), SocialUiState(), false, true, true, "build").leaving)
    }

    @Test fun `Seeker admission retains interrupted proof recovery and server refusal`() {
        val state = SeekerState(pending = "link", error = "Read failed", notice = "Not admitted")
        val ui = liveAdmissionTitleUi(state, "actual")
        assertEquals(TitleStage.ADMISSION, ui.stage)
        assertEquals("Read failed", ui.error)
        assertTrue(ui.admission!!.line.contains("signed request will not be repeated"))
        assertFalse(ui.leaving)
        assertEquals("Not admitted", liveAdmissionTitleUi(state.copy(pending = null), "actual").admission!!.line)
    }

    @Test fun `Seeker proof requires current loaded unlinked status and every original bound`() {
        val unlinked = SeekerIdentityStatus(false, null, null, null, null, null, false, 0, false)
        val ready = SeekerState(status = unlinked, loaded = true)
        assertTrue(admissionLinkAvailable(ready, true, true))
        assertFalse(admissionLinkAvailable(ready.copy(status = null), true, true))
        assertFalse(admissionLinkAvailable(ready.copy(loaded = false), true, true))
        assertFalse(admissionLinkAvailable(ready.copy(pending = "link"), true, true))
        assertFalse(admissionLinkAvailable(ready.copy(busy = true), true, true))
        assertFalse(admissionLinkAvailable(ready, false, true))
        assertFalse(admissionLinkAvailable(ready, true, false))
    }

    @Test fun `player routes mount designed title providers and admission while recovery owners remain`() {
        val root = "src/main/kotlin/gg/pixelkingdomwars/nativeclient"
        val title = File("$root/ui/title/TitleScreens.kt").readText()
        val admission = File("$root/ui/profile/AdmissionSeekerScreen.kt").readText()
        assertTrue(title.contains("DesignedTitleScreen(")); assertTrue(title.contains("SignInProvidersSheet("))
        assertFalse(title.contains("MINE · BUILD · RAID"))
        assertTrue("Required updater stays above provider windows", title.contains("if (!updateBlocked) SocialOptions"))
        for (owner in listOf("NativeUpdateBanner(", "NativeUpdateScreen()", "PrivyMfaDialog(", "model.sendEmailCode(email)",
            "model.verifyEmailCode(code)", "model::submitPrivyMfa", "model::cancelPrivyMfa", "onRecovery()", "model.cancelSignIn(wallet)"))
            assertTrue(owner, title.contains(owner))
        assertTrue(admission.contains("DesignedTitleScreen("))
        for (owner in listOf("repository.refresh()", "repository.link(requireNotNull(wallet), name)", "repository.interaction.close()", "job?.cancel()"))
            assertTrue(owner, admission.contains(owner))
    }
}
