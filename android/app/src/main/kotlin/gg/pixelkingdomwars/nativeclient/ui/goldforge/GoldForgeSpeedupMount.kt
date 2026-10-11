package gg.pixelkingdomwars.nativeclient.ui.goldforge

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import gg.pixelkingdomwars.nativeclient.data.ReviewedBuilderFinishSpend
import gg.pixelkingdomwars.nativeclient.model.GameCurrency
import gg.pixelkingdomwars.nativeclient.renderer.BaseScene
import gg.pixelkingdomwars.nativeclient.ui.displayClock
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.builderFinishReviewTerms
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.gemSpendUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ForgeAction
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendSeal
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.gemSpendPrimaryLook

/** Extend the accepted maximum-consent mapper only when a real Gems destination is bound.
 * Nothing here creates a quote, infers FREE, or replaces the repository's exact-currency check. */
internal fun goldForgeSpeedupUi(state: KingdomUiState, busy: Boolean, now: Long, armedAtMs: Long,
    scene: BaseScene? = null, topUpAvailable: Boolean = false): GemSpendUi? {
    val ui = gemSpendUi(state, busy, now, armedAtMs, scene) ?: return null
    if (state.home.loading || state.home.error != null) return ui.copy(
        price = ui.price.copy(status = PriceStatus.UNAVAILABLE, description = null),
        unavailableReason = "Current Gems balance unavailable. Review the builder job again.")
    val currentUnattemptedShort = topUpAvailable && !busy && state.ordersAllowed && state.deedActionsAllowed &&
        state.home.builderFinishReview?.intent?.attempted == false && goldForgeSpeedupShortfall(state) != null
    return if (currentUnattemptedShort) ui.copy(
        price = ui.price.copy(status = PriceStatus.SHORT, description = null), unavailableReason = null)
    else ui
}

/** The amount needed to cover the original maximum, not an exact final charge. Never parse a formatted label. */
private fun goldForgeSpeedupShortfall(state: KingdomUiState): String? {
    val terms = builderFinishReviewTerms(state)?.takeIf { it.expectedCurrency == GameCurrency.GEMS } ?: return null
    val maximum = terms.consent.maxCostKeep.toBigIntegerOrNull()?.takeIf { it.signum() > 0 } ?: return null
    val have = state.home.balances?.gems?.takeIf { it.length <= 32 && it.matches(Regex("0|[1-9][0-9]*")) }
        ?.toBigIntegerOrNull() ?: return null
    return (maximum - have).takeIf { it.signum() > 0 }?.toString()
}

/** One painted review may dispatch at most one explicit click; the existing owner still owns every command. */
internal class GoldForgeSpeedupClickGuard(private val review: ReviewedBuilderFinishSpend?) {
    private var dispatched = false
    fun current(state: KingdomUiState, busy: Boolean): Boolean = !dispatched && !busy && review != null &&
        state.home.builderFinishReview === review && builderFinishReviewTerms(state)?.expectedCurrency == GameCurrency.GEMS
    fun take(state: KingdomUiState, busy: Boolean): Boolean {
        if (!current(state, busy)) return false
        dispatched = true
        return true
    }
}

/** Exact-review callback adapter. Top-up is navigation only and retires the review before opening another sheet. */
internal fun goldForgeSpeedupActions(
    review: ReviewedBuilderFinishSpend?, current: () -> KingdomUiState, busy: () -> Boolean,
    onConfirm: () -> Unit, onBack: () -> Unit, onGetGems: ((String) -> Unit)?,
    guard: GoldForgeSpeedupClickGuard = GoldForgeSpeedupClickGuard(review),
): GemSpendActions = GemSpendActions(
    onConfirm = {
        val state = current()
        if (guard.current(state, busy())) {
            val ui = goldForgeSpeedupUi(state, false, 0L, 0L, topUpAvailable = onGetGems != null)
            if (ui != null && gemSpendPrimaryLook(ui).action == ForgeAction.CONFIRM && guard.take(state, busy())) onConfirm()
        }
    },
    onBack = {
        val state = current()
        if (guard.take(state, busy())) onBack()
    },
    onGetGems = { shownShort ->
        val state = current()
        if (onGetGems != null && guard.current(state, busy())) {
            val ui = goldForgeSpeedupUi(state, false, 0L, 0L, topUpAvailable = true)
            val rawShort = goldForgeSpeedupShortfall(state)
            if (ui != null && rawShort != null && ui.short == shownShort &&
                gemSpendPrimaryLook(ui).action == ForgeAction.GET_GEMS && guard.take(state, busy())) {
                onBack()
                onGetGems(rawShort)
            }
        }
    },
)

/** Compose keys compare structurally; a separately published equal review must still get its own click guard. */
private class SpeedupReviewReference(private val value: ReviewedBuilderFinishSpend?) {
    override fun equals(other: Any?): Boolean = other is SpeedupReviewReference && value === other.value
    override fun hashCode(): Int = System.identityHashCode(value)
}

/** The designed finish/short Seals, driven by the existing reviewed builder state and callbacks.
 * Keep the Seal composed through null so its own exit animation retains the input blocker. */
@Composable internal fun GoldForgeSpeedupMount(
    state: KingdomUiState, busy: Boolean, current: () -> KingdomUiState, currentBusy: () -> Boolean,
    onConfirm: () -> Unit, onBack: () -> Unit, scene: BaseScene? = null,
    onGetGems: ((String) -> Unit)? = null, modifier: Modifier = Modifier,
) {
    val review = state.home.builderFinishReview
    val guard = remember(SpeedupReviewReference(review)) { GoldForgeSpeedupClickGuard(review) }
    val armedAtMs = remember(guard) { System.currentTimeMillis() }
    val ui = goldForgeSpeedupUi(state, busy, displayClock(), armedAtMs, scene, onGetGems != null)
    val actions = goldForgeSpeedupActions(review, current, currentBusy, onConfirm, onBack, onGetGems, guard)
    GemSpendSeal(ui, actions, modifier)
}
