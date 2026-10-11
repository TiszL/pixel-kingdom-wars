package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.model.GameCurrency
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import gg.pixelkingdomwars.nativeclient.ui.army.trainingFinishReviewTerms
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemSpendUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.sealKingdomLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.sealTimeFromNow
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.sealTroops
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.PaidTrainingFinishIntent
import java.time.Instant
import kotlin.math.ceil

/** Presents the existing exact-currency review. The repository alone refreshes the queue and checks coverage
 * on confirmation, then submits or retries the original intent. This is an upper bound, never a new quote:
 * a saved queue can finish naturally and cost less than its original maximum. Comparing the displayed balance
 * with that maximum would incorrectly block such reviews. Preserve the original confirmation gates instead.
 * [armedAtMs] is the local review-opening time, not a claimed server quote timestamp. */
internal fun trainingFinishGemSpendUi(state: ArmyUiState, generation: Long, busy: Boolean, allowed: Boolean,
    now: Long, armedAtMs: Long): GemSpendUi? {
    val reviewed = state.domain.trainingFinishReview ?: return null
    val terms = trainingFinishReviewTerms(state)?.takeIf { it.expectedCurrency == GameCurrency.GEMS } ?: return null
    if (reviewed.intent.wallet != state.wallet || state.baseId == null || terms.baseId != state.baseId ||
        reviewed.generation != generation) return null

    val have = state.home.takeIf { it.base?.baseId == terms.baseId }?.balances?.gems
        ?.takeIf { it.length <= 32 && it.matches(Regex("0|[1-9][0-9]*")) }
    val unavailable = if (!allowed || !state.ordersAllowed) "Game orders are paused. Maximum: ${terms.maxCostKeep} Gems" else null
    val consentLines = trainingFinishConsentLines(terms, reviewed.intent.attempted, state.home.base, now, "Gems")
    // The price's consent words are clock-free (the tail timer is display only, never part of the price).
    val consent = "Pay up to ${terms.maxCostKeep} Gems. " +
        trainingFinishConsentLines(terms, reviewed.intent.attempted, state.home.base, null, "Gems").joinToString(" ")
    val finishesAt = terms.queue.maxOf { Instant.parse(it.finishesAt).toEpochMilli() }
    val remainingSeconds = ceil((finishesAt.toDouble() - now) / 1000).toLong().coerceAtLeast(0)
    return GemSpendUi(
        kind = GemSpendKind.FINISH,
        title = "FINISH ALL TRAINING?",
        // Original consent identifies queue rows, not one troop or level; do not borrow a current-row portrait.
        subjectArt = "shape:unknown",
        subjectName = "TRAINING",
        subjectLine = sealTroops(terms.queue.size) + if (reviewed.intent.attempted) " · saved" else "",
        // Several lanes can contribute to a whole queue. Its tail is known, its aggregate done share is not.
        progress = null,
        timeLeft = fmtDur(remainingSeconds),
        price = PriceUi(Currency.GEMS, "Up to ${fmtN(terms.maxCostKeep)}",
            if (unavailable == null) PriceStatus.OK else PriceStatus.UNAVAILABLE,
            description = consent.takeIf { unavailable == null && !busy }),
        have = have?.let(::fmtN) ?: "…",
        after = null,
        short = null,
        quotedAtMs = armedAtMs,
        armedAtMs = armedAtMs,
        stage = if (busy) MoneyStage.SENDING else MoneyStage.READY,
        unavailableReason = unavailable,
        consentDetails = consentLines.joinToString("\n"),
    )
}

/** The finish-all consent in player words (owner 2026-10-06 17:24, SealWords.kt): the kingdom's name, how many troops the
 * frozen queue holds and when its last one finishes, the charge rule. Each frozen row is one troop; the rows themselves, their
 * ids and instants stay in the saved request the repository compares and sends, never on the Seal. Shared by the Gems Seal
 * and the KEEP dialog ([currency] names the payment as each already did). A null [nowMs] leaves the time out (the price). */
internal fun trainingFinishConsentLines(terms: PaidTrainingFinishIntent, attempted: Boolean, home: BaseSnapshot?, nowMs: Long?,
    currency: String): List<String> = buildList {
    add(sealKingdomLine(home, terms.baseId))
    val last = terms.queue.maxByOrNull { runCatching { Instant.parse(it.finishesAt).toEpochMilli() }.getOrDefault(Long.MIN_VALUE) }
    add(sealTroops(terms.queue.size) + (nowMs?.let { sealTimeFromNow(last?.finishesAt, it) }?.let { " · finishes $it" } ?: ""))
    add("Finish this reviewed queue in $currency. The charge may decrease as troops finish naturally.")
    if (attempted) add("Retry the same saved payment and key. No replacement order will be created.")
}
