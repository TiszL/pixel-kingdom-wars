package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.data.GemsBuyState
import gg.pixelkingdomwars.nativeclient.data.KeepDepositBounds
import gg.pixelkingdomwars.nativeclient.data.SavedGemsBuy
import gg.pixelkingdomwars.nativeclient.model.GemsBuyReceipt
import gg.pixelkingdomwars.nativeclient.model.GemsCapability
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.economy.GemsBuyReview
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemsPhase
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemsSealUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.MoneyFailure
import java.math.BigDecimal
import java.math.BigInteger

internal data class GoldForgeGemsCelebration(val key: String, val amount: String, val fundedKeep: String)

/** Display and callback admission only. GemsBuyViewModel remains the sole purchase owner. */
internal data class GoldForgeGemsOwnerUi(
    val gems: GemsUi,
    val amountInput: String,
    val canReview: Boolean,
    val canPay: Boolean,
    val canReviewSaved: Boolean,
    val canCheck: Boolean,
    val canAbandon: Boolean,
    val canFinish: Boolean,
    val needsBalanceRefresh: Boolean,
    val celebration: GoldForgeGemsCelebration?,
    val explanation: String?,
    /** A saved purchase the designed face cannot act on (another wallet's, an unhydrated credit, or an unpaid original that
     *  can no longer be reviewed): only the ORIGINAL PURCHASE recovery plate offers its controls. */
    val recoveryOnly: Boolean = false,
)

private const val UNKNOWN_GEMS = "…"
private val GEMS_WHOLE = Regex("[0-9]{1,32}")
private val GEMS_BALANCE = Regex("[0-9]{1,32}(\\.[0-9]{1,19})?")

/** The MAX chip's raw value: the binding resolves it from wallet KEEP when tapped ([goldForgeGemsMax]). */
internal const val GOLD_FORGE_GEMS_MAX = "MAX"

/** SPEC §5a QuickChips presets. They are amount suggestions only; every price and bound comes from the server. */
private val GEMS_QUICK_PRESETS = listOf(100L, 500L, 1000L)

/** The quick chips as (label, raw): the presets that fall inside the server's admitted interval, then MAX (always). */
internal fun goldForgeGemsQuickChips(cap: GemsCapability): List<Pair<String, String>> =
    GEMS_QUICK_PRESETS.filter { it in cap.minConvertKeep..cap.maxConvertKeepPerTx }
        .map { exactAmount(it.toString()) to it.toString() } + (GOLD_FORGE_GEMS_MAX to GOLD_FORGE_GEMS_MAX)

/** The raw amount a chip label stands for, or null for a label the current capability does not offer. */
internal fun goldForgeGemsQuickRaw(label: String, cap: GemsCapability): String? =
    goldForgeGemsQuickChips(cap).firstOrNull { it.first == label }?.second

private fun WalletFunds?.walletKeep(): BigDecimal? = this?.tokens?.entries?.filter { it.key.equals("KEEP", ignoreCase = true) }
    ?.singleOrNull()?.value?.takeIf(GEMS_BALANCE::matches)?.toBigDecimalOrNull()

/** MAX = min(whole wallet KEEP, server max); null while wallet KEEP is unknown or ambiguous, so it is never guessed. */
internal fun goldForgeGemsMax(funds: WalletFunds?, cap: GemsCapability): String? =
    funds.walletKeep()?.toBigInteger()?.min(BigInteger.valueOf(cap.maxConvertKeepPerTx))?.toString()

/** A shortfall's starting amount: the whole KEEP that buys at least [gems] at the server rate, inside the server bounds. */
internal fun goldForgeGemsPrefill(gems: String?, cap: GemsCapability): String? {
    val need = gems?.takeIf(GEMS_WHOLE::matches)?.toBigIntegerOrNull() ?: return null
    val rate = BigInteger.valueOf(cap.gemsPerKeep)
    return need.add(rate).subtract(BigInteger.ONE).divide(rate)
        .coerceIn(BigInteger.valueOf(cap.minConvertKeep), BigInteger.valueOf(cap.maxConvertKeepPerTx)).toString()
}

/** The Seal's fee line, only from a reviewed quote: the pay callback ties consent to exactly this estimate. */
internal fun goldForgeGemsFeeLine(review: GemsBuyReview?): String? = review?.feeLamports?.takeIf(GEMS_WHOLE::matches)
    ?.let { "Estimated network fee: ${marketSol(it)} SOL. Your wallet shows its final fee." }

private fun SavedGemsBuy.belongsTo(wallet: String): Boolean = draft.wallet == wallet &&
    (quote == null || quote.wallet == wallet && quote.idempotencyKey == draft.idempotencyKey && quote.keepIn == draft.keepIn)

private fun SavedGemsBuy.hasPaymentEvidence(): Boolean = attempted || signature != null ||
    observed?.paymentSignature != null || observed?.txSignature != null || observed?.amount != null ||
    observed?.status in setOf("finalized", "credited", "failed")

private fun GemsBuyState.originalReceipt(wallet: String): GemsBuyReceipt? {
    val original = saved?.takeIf { it.belongsTo(wallet) } ?: return null
    val quote = original.quote ?: return null
    val deposit = original.observed?.takeIf { it.originalIntent == quote && it.status == "credited" } ?: return null
    val receipt = deposit.receipt ?: return null
    // Pure schema validation, including original identity and amounts; a signature alone is never success.
    if (runCatching { quote.validate(); deposit.validate(); receipt.validate(quote) }.isFailure) return null
    return receipt
}

/** Store evidence is present in the owner's initial state, even while its balance hydration is pending. */
internal fun goldForgeGemsReceiptAtEntry(state: GemsBuyState, wallet: String): String? = state.originalReceipt(wallet)?.receiptId

/** Structural quote equality accepts a decoded journal; fee consent itself requires object identity. */
internal fun goldForgeGemsCanConfirm(presented: GemsBuyReview?, current: GemsBuyReview?, state: GemsBuyState,
    wallet: String, paying: Boolean, running: Boolean): Boolean {
    val saved = state.saved ?: return false
    return presented != null && presented === current && !paying && !running && state.canPay &&
        saved.belongsTo(wallet) && !saved.hasPaymentEvidence() && saved.observed?.receipt == null &&
        saved.observed?.originalIntent == saved.quote && presented.quote == saved.quote &&
        runCatching { presented.quote.validate() }.isSuccess && GEMS_WHOLE.matches(presented.feeLamports)
}

/** Amount buttons use the server's admitted interval; arithmetic cannot overflow Long. */
internal fun goldForgeGemsStep(amount: String, delta: Int, cap: GemsCapability): String {
    val minimum = BigInteger.valueOf(cap.minConvertKeep)
    val maximum = BigInteger.valueOf(cap.maxConvertKeepPerTx)
    val current = amount.takeIf(GEMS_WHOLE::matches)?.toBigIntegerOrNull() ?: minimum
    return current.add(BigInteger.valueOf(delta.toLong())).coerceIn(minimum, maximum).toString()
}

/** [amount] is the raw input (blank = the default: the [shortfallGems] prefill, else the server minimum). Display strings
 *  are formatted here; [GoldForgeGemsOwnerUi.amountInput] stays raw for the owner calls. */
internal fun goldForgeGemsOwner(state: GemsBuyState, review: GemsBuyReview?, wallet: String, funds: WalletFunds?,
    amount: String, bounds: KeepDepositBounds?, running: Boolean = false, paying: Boolean = false,
    error: String? = null, sealArmedAtMs: Long? = null, shortfallGems: String? = null,
    shortfallFor: String? = null): GoldForgeGemsOwnerUi {
    val saved = state.saved
    val owned = saved?.belongsTo(wallet) == true
    val quote = saved?.quote?.takeIf { owned }
    val busy = running || state.busy || paying
    val cap = state.capability?.takeIf { state.available && it.enabled && "wallet-keep" in it.sources && it.destinationAta != null }
    val input = if (saved != null) saved.draft.keepIn.toString()
        else amount.ifBlank { cap?.let { goldForgeGemsPrefill(shortfallGems, it) ?: it.minConvertKeep.toString() }.orEmpty() }
    val pay = input.takeIf(GEMS_WHOLE::matches)?.toBigIntegerOrNull()
    val inBounds = pay != null && cap != null && bounds != null &&
        pay >= BigInteger.valueOf(cap.minConvertKeep) && pay <= BigInteger.valueOf(cap.maxConvertKeepPerTx) &&
        runCatching { bounds.amount(input) }.isSuccess
    val walletKeep = funds.walletKeep()
    val short = saved == null && pay != null && walletKeep != null && pay.toBigDecimal() > walletKeep
    val receipt = state.originalReceipt(wallet)
    val credited = receipt != null && state.hydrated
    val paymentEvidence = saved?.hasPaymentEvidence() == true
    val canReview = saved == null && !busy && inBounds && !short
    val canPay = goldForgeGemsCanConfirm(review, review, state, wallet, paying, running)
    val canCheck = owned && !busy
    val canReviewSaved = owned && !busy && !paymentEvidence && saved != null &&
        saved.observed?.receipt == null && saved.observed?.status !in setOf("expired", "failed", "credited", "finalized")
    val canAbandon = owned && !busy && !paymentEvidence && saved?.observed?.receipt == null
    val canFinish = owned && !busy && credited
    val pending = owned && paymentEvidence && receipt == null
    val stage = when {
        paying && saved?.signature == null && saved?.observed?.txSignature == null && saved?.observed?.paymentSignature == null -> MoneyStage.CHECK_WALLET
        paying -> MoneyStage.SENDING
        credited -> MoneyStage.SENT
        pending -> MoneyStage.FAILED
        else -> MoneyStage.READY
    }
    val phase = when {
        receipt != null && !state.hydrated -> GemsPhase.LOADING
        // A running owner check shows "Checking", never a gated primary; the wallet handoff keeps its stage face.
        busy && !paying -> GemsPhase.LOADING
        saved != null -> GemsPhase.READY
        error != null || cap == null -> GemsPhase.ERROR
        else -> GemsPhase.READY
    }
    val payText = receipt?.funding?.amount ?: quote?.keepIn?.toString() ?: pay?.toString() ?: UNKNOWN_GEMS
    val gemsText = receipt?.result?.amount ?: quote?.gemsOut?.toString() ?: if (cap != null && pay != null) pay.multiply(BigInteger.valueOf(cap.gemsPerKeep)).toString() else UNKNOWN_GEMS
    val walletText = walletKeep?.plain() ?: UNKNOWN_GEMS
    // Once a payment has been attempted, today's balance must not be debited a second time for a preview.
    val after = if (paymentEvidence || receipt != null) UNKNOWN_GEMS
        else if (pay != null && walletKeep != null && pay.toBigDecimal() <= walletKeep) walletKeep.subtract(pay.toBigDecimal()).plain() else UNKNOWN_GEMS
    val seal = sealArmedAtMs?.takeIf { canPay || paying && owned && review?.quote == quote }
        ?.let { GemsSealUi(exactAmount(gemsText), exactAmount(payText), it, feeLine = goldForgeGemsFeeLine(review)) }
    // The tag is the server rate (SPEC §5a "1 KEEP = 1 GEM"); a saved quote stands in only while the capability is unread.
    val rate = cap?.let { "1 KEEP = ${exactAmount(it.gemsPerKeep.toString())} ${if (it.gemsPerKeep == 1L) "GEM" else "GEMS"}" }
        ?: quote?.let { "${exactAmount(it.keepIn.toString())} KEEP = ${exactAmount(it.gemsOut.toString())} GEMS" } ?: UNKNOWN_GEMS
    val chips = if (saved == null && cap != null) goldForgeGemsQuickChips(cap) else emptyList()
    val shortLine = shortfallGems?.takeIf { saved == null && GEMS_WHOLE.matches(it) }?.let { exactAmount(it) }
    val explanation = when {
        saved != null && !owned -> "This saved purchase belongs to its original wallet. Switch back to recover it."
        receipt != null && !state.hydrated -> "The original credit is confirmed. Refresh its balances before finishing."
        pending -> "The payment may have been sent. Check this original purchase; expiry alone does not prove nonpayment."
        saved != null && saved.observed?.receipt != null && receipt == null -> "The saved receipt could not be matched to this purchase. Keep the original and check again."
        saved != null -> "Closing preserves this original purchase. Recovery never creates a replacement payment."
        cap == null -> error ?: "Purchase availability has not been confirmed. Refresh status to try again."
        bounds == null -> "Current wallet payment controls are still loading."
        !inBounds -> "Choose a whole amount from ${exactAmount(cap.minConvertKeep.toString())} to ${exactAmount(cap.maxConvertKeepPerTx.toString())} KEEP."
        short -> "Your wallet has ${exactAmount(walletText)} KEEP."
        else -> null
    }
    val recoveryOnly = saved != null && !busy && (!owned || receipt != null && !state.hydrated ||
        !paymentEvidence && saved.observed?.receipt == null && !canReviewSaved && !canPay)
    return GoldForgeGemsOwnerUi(GemsUi(rate, exactAmount(gemsText), exactAmount(payText), exactAmount(walletText), exactAmount(after),
        chips.map { it.first }, chips.firstOrNull { it.second == input }?.first,
        cap?.let { exactAmount(it.minConvertKeep.toString()) } ?: UNKNOWN_GEMS,
        cap?.let { exactAmount(it.maxConvertKeepPerTx.toString()) } ?: UNKNOWN_GEMS,
        shortLine, shortfallFor?.takeIf { shortLine != null }, stage,
        pendingRecovery = owned && !paymentEvidence && receipt == null,
        toShardsAvailable = false, swapOffered = false, phase = phase,
        failure = if (pending) MoneyFailure.UNCERTAIN else null, walletShort = short, seal = seal,
        actionsAllowed = canReview || canPay || canReviewSaved || canCheck || canFinish || paying ||
            (saved == null && !busy && phase == GemsPhase.ERROR),
        primaryReason = explanation),
        input, canReview, canPay, canReviewSaved, canCheck, canAbandon, canFinish, receipt != null && !state.hydrated,
        receipt?.takeIf { credited }?.let { GoldForgeGemsCelebration(it.receiptId, it.result.amount, it.funding.amount) }, explanation,
        recoveryOnly)
}

private fun BigDecimal.plain(): String = stripTrailingZeros().toPlainString()
