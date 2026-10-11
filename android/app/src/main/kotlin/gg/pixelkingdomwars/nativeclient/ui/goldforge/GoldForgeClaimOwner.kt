package gg.pixelkingdomwars.nativeclient.ui.goldforge

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.material3.LocalContentColor
import gg.pixelkingdomwars.nativeclient.ui.chrome.LocalSurfaceTone
import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceTone
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.MiningClaimsState
import gg.pixelkingdomwars.nativeclient.mining.MiningClaimPreparationView
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.kit.*
import gg.pixelkingdomwars.nativeclient.ui.model.*
import gg.pixelkingdomwars.nativeclient.ui.phasee.MiningClaimsControls
import gg.pixelkingdomwars.nativeclient.ui.phasee.islandShareTime
import gg.pixelkingdomwars.nativeclient.ui.phasee.miningClaimsControls
import gg.pixelkingdomwars.nativeclient.ui.phasee.miningClaimsKeepAmount
import gg.pixelkingdomwars.nativeclient.ui.phasee.miningClaimsPaidKeep
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.*
import java.time.Instant

/** Navigation-only doors supplied by the existing route host; no claim client or payment admission lives here. */
data class GoldForgeClaimNavigation(
    val onGoSmelt: () -> Unit,
    val onGoSeeker: () -> Unit,
    val onChangeWallet: () -> Unit,
)

val LocalGoldForgeClaimNavigation = staticCompositionLocalOf<GoldForgeClaimNavigation?> { null }

/** Intent selection is display only. The existing MiningClaimsViewModel remains the sole action owner. */
internal enum class GoldForgeClaimIntent { NONE, PREPARE, REVIEW, CHECK }

internal data class GoldForgeClaimOwnerUi(
    val claim: ClaimUi?,
    val notice: String?,
    val primary: GoldForgeClaimIntent,
    val receipt: CelebrationUi?,
)

/** A changed review object invalidates fee consent even if its visible terms compare equal. */
internal fun goldForgeClaimSealAdmitted(current: MiningClaimPreparationView?, consented: MiningClaimPreparationView?,
    controls: MiningClaimsControls): Boolean = current != null && current === consented && controls.sign

/** The details overlay belongs to the wallet captured when its door was tapped, including origin and cluster. */
internal fun goldForgeClaimWalletDetails(state: MiningClaimsState, expected: StarterIdentity?): WalletDetailsUi? {
    if (!state.loaded || expected == null || state.journal?.identity != expected) return null
    return WalletDetailsUi(walletLabel = null, last4 = expected.wallet.takeLast(4))
}

/** Current allocation and the original paid receipt are deliberately separate projections. */
internal fun goldForgeClaimOwnerUi(state: MiningClaimsState, actionsAllowed: Boolean, running: Boolean): GoldForgeClaimOwnerUi {
    val controls = miningClaimsControls(state, actionsAllowed, running)
    val operation = state.journal?.operation
    val status = state.status?.takeIf { state.loaded && !state.busy && state.error == null &&
        it.wallet == state.journal?.identity?.wallet }
    val claim = operation?.claim
    val receiptAmount = operation?.takeIf {
        val wallet = state.journal?.identity?.wallet
        val prepared = it.preparation
        wallet != null && prepared != null && claim != null && prepared.wallet == wallet && claim.wallet == wallet &&
            claim.claimId == prepared.claimId
    }?.let(::miningClaimsPaidKeep)?.takeIf(::isPositiveAmount)
    val receipt = receiptAmount?.let { CelebrationUi(requireNotNull(claim).claimId, "keep", "+$it KEEP", "In your wallet now") }
    val primary = when {
        controls.begin && status?.state == "ready" -> GoldForgeClaimIntent.PREPARE
        operation != null && receipt == null && controls.review -> GoldForgeClaimIntent.REVIEW
        operation != null && receipt == null && controls.check -> GoldForgeClaimIntent.CHECK
        else -> GoldForgeClaimIntent.NONE
    }
    val notice = when {
        operation != null -> null
        status?.state == "no_allocation" -> "The tray is empty. No KEEP is ready to collect."
        status?.state == "paused" -> "New claims are paused. Saved claims and receipts remain available."
        status?.state == "revoked" -> "This allocation was withdrawn. Check saved claims for their original outcomes."
        status?.state == "unavailable" -> "Claims are unavailable on this server. Saved claims and receipts remain available."
        state.loaded && !state.busy && state.error == null && status == null -> "The current allocation is unavailable. Check again when the server is ready."
        else -> null
    }
    if (notice != null) return GoldForgeClaimOwnerUi(null, notice, primary, receipt)
    val phase = when {
        receipt != null || status?.state == "claimed" && operation == null -> ClaimPhase.COLLECTED
        operation != null -> ClaimPhase.READY
        state.error != null -> ClaimPhase.ERROR
        !state.loaded || state.busy || running -> ClaimPhase.LOADING
        status?.state == "delayed" -> ClaimPhase.LOCKED
        else -> ClaimPhase.READY
    }
    val ready = when {
        receipt != null || phase == ClaimPhase.COLLECTED -> "0"
        else -> miningClaimsKeepAmount(status?.claimableBaseUnits, status?.decimals) ?: UNKNOWN
    }
    val lock = status?.takeIf { it.state == "delayed" }?.let {
        val date = it.claimableAfterUnixTimestamp?.toLongOrNull()?.let { seconds ->
            runCatching { islandShareTime(Instant.ofEpochSecond(seconds).toString()) }.getOrNull()
        } ?: UNKNOWN
        ClaimLockUi(date, "The server has not opened this claim window yet.")
    }
    return GoldForgeClaimOwnerUi(ClaimUi(ready, readyDays = null, estimate = null, walletLabel = null,
        walletLast4 = state.journal?.identity?.wallet?.takeLast(4), lock = lock,
        stage = if (receipt != null) MoneyStage.SENT else MoneyStage.READY, nextCoinsIn = null,
        canResumeSaved = operation != null && receipt == null, phase = phase,
        actionsAllowed = primary != GoldForgeClaimIntent.NONE), null, primary, receipt)
}

/** The designed face replaces the old allocation page, while its recovery content stays owned by the caller. */
@Composable internal fun GoldForgeClaimOwner(ui: GoldForgeClaimOwnerUi, on: ClaimActions, onClose: () -> Unit,
    onHistory: () -> Unit, historyAvailable: Boolean, canCheck: Boolean, onCheck: () -> Unit, modifier: Modifier = Modifier,
    recovery: @Composable ColumnScope.() -> Unit) {
    SheetFrame(SheetFrameUi("GOLD FORGE", null, SheetSize.FULL,
        goldForgeTabs(ui.claim?.let { it.phase == ClaimPhase.READY && isPositiveAmount(it.ready) } == true, 0, false)
            .filter { it.id == GoldForgeTabs.CLAIM }, GoldForgeTabs.CLAIM, history = historyAvailable),
        onClose, modifier, onHistory = onHistory, footer = {
            ui.claim?.let { ClaimFooter(it, on) }
            SecondaryButton("CHECK SAVED RECEIPTS", onCheck, Modifier.fillMaxWidth(), enabled = canCheck)
        }) {
        ui.claim?.let { ClaimBody(it, on) }
        ui.notice?.let { message ->
            DarkWell(Modifier.fillMaxWidth().heightIn(min = 194.dp), rays = 0f) {
                Column(Modifier.align(Alignment.Center).padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    PkwIcon("keep", 48.dp)
                    PkwText(message, PkwTokens.Type.body, color = PkwTokens.Colors.text, maxLines = Int.MAX_VALUE)
                }
            }
        }
        // The caller's recovery rows use the chrome primitives; on this parchment they draw the kit cream / ink faces.
        CompositionLocalProvider(LocalSurfaceTone provides SurfaceTone.PARCHMENT, LocalContentColor provides PkwTokens.Colors.textOnParch) { recovery() }
    }
}
