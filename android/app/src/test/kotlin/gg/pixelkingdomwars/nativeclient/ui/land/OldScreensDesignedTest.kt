package gg.pixelkingdomwars.nativeclient.ui.land

import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.data.BaseClaimState
import gg.pixelkingdomwars.nativeclient.model.BaseCapabilities
import gg.pixelkingdomwars.nativeclient.model.BaseClaimCandidate
import gg.pixelkingdomwars.nativeclient.model.BaseClaimOffer
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.model.BaseSummary
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.more.BasesUiState
import gg.pixelkingdomwars.nativeclient.ui.more.basesActivateHold
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.plainSentences
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Owner 2026-10-06 (screenshot 2, "UI unfinished"): the land, claim and account pages that were still the old dark
 * `GamePage` bodies are the designed cards now. These cases pin WHY each rule matters: a claim page must never say
 * "unavailable" before the server answered or blank an answer during a re-check; a door must say why it cannot act; the
 * swept pages must not fall back to the old chrome; and the money / claim owners must still be the ones called.
 */
class OldScreensDesignedTest {
    private val root = "src/main/kotlin/gg/pixelkingdomwars/nativeclient"
    private fun source(path: String) = File("$root/$path").readText()
    private val wallet = "So1anaWa11et1111111111111111111111111111111"
    private val offer = BaseClaimOffer(wallet, true, BaseClaimCandidate("00000000-0000-4000-8000-000000000001", wallet), "ok")
    private val none = BaseClaimOffer(wallet, false, null, "none")

    // WHY: the owner's screenshot showed "Deed claims are unavailable" — a page must not claim that while the read runs,
    // and a re-check must keep showing the deed the player was looking at (the repository clears its copy per read).
    @Test fun `a running claim check keeps the last answered offer and a settled read shows the live one`() {
        assertEquals(offer, baseClaimShownOffer(BaseClaimState(busy = true, loaded = true, offer = null), offer))
        assertNull("nothing answered yet: the page shows the skeleton, not a reason", baseClaimShownOffer(BaseClaimState(busy = true, loaded = true), null))
        assertEquals("a settled read is the truth, even when it changed", none, baseClaimShownOffer(BaseClaimState(busy = false, loaded = true, offer = none), offer))
        assertNull(baseClaimShownOffer(BaseClaimState(busy = false, loaded = true, offer = null), offer))
    }

    @Test fun `each server reason keeps its own sentence and a silent service reads as unavailable`() {
        assertEquals("No unclaimed deed was found.", baseClaimReasonLine("none"))
        assertEquals("This deed cannot be transferred.", baseClaimReasonLine("not_transferable"))
        assertEquals("Deed claims are unavailable. Check again later.", baseClaimReasonLine("unavailable"))
        assertEquals("Deed claims are unavailable. Check again later.", baseClaimReasonLine(null))
        assertTrue("the lead still says no SOL is requested", BASE_CLAIM_INTRO.contains("No SOL payment is requested."))
    }

    @Test fun `a confirm names the exact deed in short form and keeps short ids whole`() {
        assertEquals("000000…0001", shortClaimId("00000000-0000-4000-8000-000000000001"))
        assertEquals("abc", shortClaimId("abc"))
    }

    // WHY: ACTIVATE DEED is a door: when it cannot act, the tap must say why (busy, read-only server, or no slot chosen).
    @Test fun `activate deed explains every hold and opens only when the server allows it`() {
        fun directory(mutations: Boolean, maxActive: Int, active: Int) = BaseDirectory(enabled = true, maxActive = maxActive,
            capabilities = BaseCapabilities(baseScopedReads = true, baseScopedMutations = mutations),
            bases = (1..active).map { BaseSummary("a$it", status = "active", slot = it) } + BaseSummary("spare", status = "inactive"))
        val open = BasesUiState(AccountState(directory = directory(true, 2, 1)))
        assertNull(basesActivateHold(open, busy = false))
        assertEquals("A base request is finishing. Please wait.", basesActivateHold(open, busy = true))
        assertEquals(plainSentences(Copy.BASES_READONLY), basesActivateHold(BasesUiState(AccountState(directory = directory(false, 2, 1))), busy = false))
        val full = BasesUiState(AccountState(directory = directory(true, 1, 1)))
        assertEquals("Choose the active slot this deed replaces first.", basesActivateHold(full, busy = false))
        assertNull("choosing the slot to replace opens it", basesActivateHold(full.copy(replaceBaseId = "a1"), busy = false))
    }

    // WHY: the designed notes are sentences, but currency and brand names must never lose their capitals.
    @Test fun `old capital sentences read as sentences and keep currency and brand words`() {
        assertEquals("All active slots are occupied. An additional deed stays inactive until you replace an active slot.",
            plainSentences(Copy.SLOTS_FULL))
        assertEquals("Spend 5 KEEP or 1 SOL. Seeker and Genesis tiles stay reserved.",
            plainSentences("SPEND 5 KEEP OR 1 SOL. SEEKER AND GENESIS TILES STAY RESERVED."))
        assertEquals("Already mixed Case stays.", plainSentences("Already mixed Case stays."))
    }

    // WHY: the owner saw the old dark pages on the player path; none of the swept bodies may draw the old chrome again.
    @Test fun `swept land claim and account pages draw the designed card and not the old page`() {
        for (path in listOf("ui/land/BaseClaimScreen.kt", "ui/more/BasesScreen.kt", "ui/economy/FaucetScreen.kt", "ui/profile/ProfileScreen.kt",
            "ui/profile/SeekerScreen.kt", "ui/security/SecurityScreen.kt")) {
            val text = source(path)
            assertTrue("$path mounts the designed card", text.contains("RouteCardPage("))
            assertFalse("$path no longer draws the old page", text.contains("GamePage("))
            assertFalse("$path no longer opens the old dialog", text.contains("AlertDialog("))
        }
        for (path in listOf("ui/security/SecurityDestination.kt", "ui/security/WalletAuthenticatorSection.kt", "ui/land/LandGateScreen.kt")) {
            val text = source(path)
            assertFalse("$path no longer opens the old dialog", text.contains("AlertDialog("))
            assertFalse("$path no longer uses the old chrome controls", text.contains("ui.chrome.OutlinedTextField") || text.contains("ui.chrome.Button"))
        }
    }

    // WHY: a restyle must not move money or claim work to a new owner; the same calls run behind the designed doors.
    @Test fun `the designed pages still call their existing owners`() {
        val claim = source("ui/land/BaseClaimScreen.kt")
        for (owner in listOf("repository.refresh()", "repository.review()", "repository.confirm(review)", "repository.cancel()",
            "repository.retry()", "repository.finish()", "repository.dismiss()"))
            assertTrue(owner, claim.contains(owner))
        val bases = source("ui/more/BasesScreen.kt")
        for (owner in listOf("model.open(base.id)", "model.activate(base.id)", "model.setReplace(", "onBuyDeed(kind)", "claim()"))
            assertTrue(owner, bases.contains(owner))
        val faucet = source("ui/economy/FaucetScreen.kt")
        for (owner in listOf("repository.claim()", "repository.refresh()", "repository.foreground(false)")) assertTrue(owner, faucet.contains(owner))
        val mfa = source("ui/security/SecurityDestination.kt")
        assertTrue("the MFA step keeps its own window over money hosts", mfa.contains("Dialog(cancel, properties = DialogProperties("))
        assertTrue(mfa.contains("submit(value)") && mfa.contains("secret = true"))
        val security = source("ui/security/SecurityScreen.kt")
        assertTrue("one-time codes stay masked", security.contains("RouteTextInput(value, onChange, label, enabled = enabled, secret = true)"))
        assertTrue("the screen keeps FLAG_SECURE", security.contains("FLAG_SECURE"))
    }

    // WHY: screenshot 1 — the old "NO LAND YET" plate covered the dock and open sheets; the land herald is the one door.
    @Test fun `home draws the land herald and not the old no land plate`() {
        val scaffold = source("ui/home/HomeScaffold.kt")
        assertFalse(scaffold.contains("Copy.NO_LAND_PROMPT"))
        assertTrue(scaffold.contains("homeLandHeraldUi(homeLandOwned, null)"))
        val banner = source("ui/Theme.kt").substringAfter("@Composable fun InterruptedBanner(").substringBefore("/** A once-per-second wall clock")
        // Merged with night/fix-oldscreens-phasee, which redesigned the same banner as the kit herald (HeraldPlate, the
        // herald / toast family this branch meant) with a fold-only dismiss; one design is kept, the old bar stays gone.
        assertTrue("the interrupted request is the kit herald plate", banner.contains("HeraldPlate("))
        assertFalse(banner.contains("PixelPlate("))
        for (door in listOf("onCheck(item.kind)", "onClose(item.kind)", "onRetry(item.kind)")) assertTrue(door, banner.contains(door))
        assertFalse(banner.contains("OutlinedButton("))
    }
}
