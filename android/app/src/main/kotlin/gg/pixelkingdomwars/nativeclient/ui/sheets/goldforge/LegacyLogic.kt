package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * The pure rules of the Gold Forge LEGACY tab, round 2 (design/final/goldforge/SPEC.md "E1.1 Gold Forge LEGACY tab",
 * legacy.png): the saved-KEEP well, the three "what happens" steps, the summary card over the withdrawals still on their
 * way and each withdrawal row's tag and action. No Compose. JVM-tested in `LegacyLogicTest`.
 *
 * Honest-state rules (D-009 "money moved is money honoured", design correction 7): unknown amounts are "…", never 0
 * unless the server says 0; the summary says "being checked" whenever any row is CHECKING and never "failed" or "Nothing
 * was spent"; only a server refusal (REFUSED) changes a row's story. Copy: "withdraw/withdrawal" may appear on this tab
 * only; never "custody", "custodial", "escrow", "transaction" or "cutover" on screen.
 */

/** The well's state (SPEC E1.1 states table). */
enum class LegacyWellState {
    /** "SAVED IN THE FORGE · 1,820 · from before the update · yours, kept safe". */
    SAVED,
    /** Saved 0 with withdrawals left: "Nothing saved here". */
    NOTHING_SAVED,
    /** After the update: "Turned into 1,820 Gems on 14 Oct" + green DONE. */
    CONVERTED,
}

/** The well's state for [ui]. An unknown saved amount stays SAVED with "…" (never "Nothing saved"). */
fun legacyWellState(ui: LegacyV2Ui): LegacyWellState = when {
    ui.convertedLine != null -> LegacyWellState.CONVERTED
    isServerZero(ui.saved) -> LegacyWellState.NOTHING_SAVED
    else -> LegacyWellState.SAVED
}

/** True only for a server zero ("0", "0.00"); "…" / null / blank are unknown, not zero. */
fun isServerZero(amount: String?): Boolean {
    val t = amount?.trim() ?: return false
    if (t.isEmpty() || t == UNKNOWN) return false
    return t.all { it == '0' || it == '.' || it == ',' } && t.any { it == '0' }
}

/** The saved figure as drawn (legacy.png "1,820"): a raw server decimal goes through the kit's [exactAmount] (every digit,
 *  grouped, no rounding); an already formatted figure ("1,820") is drawn as given; null / blank is "…". */
fun legacySavedText(saved: String?): String {
    val t = saved?.trim()?.takeIf { it.isNotEmpty() } ?: return UNKNOWN
    return if (LEGACY_RAW_DECIMAL.matches(t)) exactAmount(t) else t
}

private val LEGACY_RAW_DECIMAL = Regex("[0-9]+(?:\\.[0-9]+)?")

/** The figure's caption: "yours, kept safe", or "as of 14:20" while the forge cannot reach the server (last good value). */
fun legacySavedCaption(asOf: String?): String = asOf?.let { "as of $it" } ?: "yours, kept safe"

/**
 * The three steps (SPEC: 1 Saved here now [gold rim] · 2 Gems on update day · 3 1,820 Gems to spend), as the cluster's
 * [StepUi] so the committed `StepRow` draws them. After the update every step is done. No date and no "cutover" on screen.
 */
fun legacySteps(ui: LegacyV2Ui): List<StepUi> {
    val done = ui.convertedLine != null
    return listOf(
        StepUi("Saved here", "now", if (done) StepState.DONE else StepState.NOW),
        StepUi("Gems on", "update day", if (done) StepState.DONE else StepState.TODO),
        StepUi("${legacySavedText(ui.saved)} Gems", "to spend", if (done) StepState.DONE else StepState.TODO),
    )
}

/** "Each KEEP becomes a Gem. The date comes to your Mail first." (the date only when the server has set one). */
fun legacyRateNote(rate: String, cutoverAt: String?): String {
    val r = rate.trim().trimEnd('.')
    return if (cutoverAt.isNullOrBlank()) "$r. The date comes to your Mail first." else "$r on $cutoverAt. Your Mail has the details."
}

/** The summary card's counts. */
data class LegacySummary(val onTheWay: Int, val arrived: Int, val checking: Int)

/** On the way = UNLOCKING + CHECKING + REFUSED (a refused return still pays out); arrived = SENT; RETURNED is back in the forge. */
fun legacySummary(withdrawals: List<LegacyWithdrawalUi>): LegacySummary = LegacySummary(
    onTheWay = withdrawals.count { it.state == WithdrawalState.UNLOCKING || it.state == WithdrawalState.CHECKING || it.state == WithdrawalState.REFUSED },
    arrived = withdrawals.count { it.state == WithdrawalState.SENT },
    checking = withdrawals.count { it.state == WithdrawalState.CHECKING },
)

/** The card's title: "2 on the way · 1 arrived" (a zero part is left out; "Nothing on the way" when both are 0). */
fun legacySummaryTitle(s: LegacySummary): String {
    val parts = listOfNotNull(s.onTheWay.takeIf { it > 0 }?.let { "$it on the way" }, s.arrived.takeIf { it > 0 }?.let { "$it arrived" })
    return if (parts.isEmpty()) "Nothing on the way" else parts.joinToString(" · ")
}

/** The card's line: "Next in 2d 4h · 1 being checked"; never "failed", never "Nothing was spent". "Next in" only with a
 *  server arrival time (the live adapter has none, so it reads "1 being checked"). Null when empty. */
fun legacySummaryLine(s: LegacySummary, nextIn: String?): String? =
    listOfNotNull(nextIn?.takeIf { it.isNotBlank() }?.let { "Next in $it" }, s.checking.takeIf { it > 0 }?.let { "$it being checked" })
        .joinToString(" · ").ifEmpty { null }

/** What a withdrawal row's action is. */
enum class WithdrawalAction {
    /** Stone BACK TO FORGE (UNLOCKING, only when the server says a refund is safe) → ConfirmDialog. */
    BACK_TO_FORGE,
    /** Stone CHECK AGAIN (CHECKING): re-reads the original request, never sends it again. */
    CHECK_AGAIN,
    /** A chevron to the proof (SENT with a history id). */
    PROOF,
    NONE,
}

/** One row's look: tag, tag verb, whether the row is tinted (CHECKING), its action, and its line. */
data class WithdrawalLook(val tag: String, val verb: Verb, val tinted: Boolean, val action: WithdrawalAction, val line: String)

/**
 * A CHECKING row's line: the SPEC's opening "Being checked" with a tail the client can prove (the original record is kept).
 * Not the SPEC's "stays saved": nothing tells the client the KEEP stayed saved while the status is unconfirmed.
 */
const val LEGACY_CHECKING_LINE = "Being checked · original record kept"

/**
 * A withdrawal row (SPEC E1.1): UNLOCKING stone "In your wallet in 2d 4h" (+ BACK TO FORGE only when [LegacyWithdrawalUi.canReturn]);
 * CHECKING stone, #FFF3C8 row, [LEGACY_CHECKING_LINE] + CHECK AGAIN; SENT moss "In your wallet since 12 Sep" +
 * proof; RETURNED moss; REFUSED stone NOT RETURNED "The payout had already started. It reaches your wallet." While a BACK
 * TO FORGE is in flight ([LegacyWithdrawalUi.busy]) the action is NONE (the row draws dots "Bringing back"). While the
 * forge is frozen every action is off ([frozen]).
 */
fun withdrawalLook(w: LegacyWithdrawalUi, frozen: Boolean = false): WithdrawalLook {
    val action = when {
        frozen || w.busy -> WithdrawalAction.NONE
        w.state == WithdrawalState.UNLOCKING && w.canReturn -> WithdrawalAction.BACK_TO_FORGE
        w.state == WithdrawalState.CHECKING -> WithdrawalAction.CHECK_AGAIN
        w.state == WithdrawalState.SENT && w.proof != null -> WithdrawalAction.PROOF
        else -> WithdrawalAction.NONE
    }
    return when (w.state) {
        WithdrawalState.UNLOCKING -> WithdrawalLook("UNLOCKING", Verb.STONE, false, action, w.line)
        WithdrawalState.CHECKING -> WithdrawalLook("CHECKING", Verb.STONE, true, action, w.line.ifBlank { LEGACY_CHECKING_LINE })
        WithdrawalState.SENT -> WithdrawalLook("SENT", Verb.MOSS, false, action, w.line)
        WithdrawalState.RETURNED -> WithdrawalLook("RETURNED", Verb.MOSS, false, action, w.line)
        WithdrawalState.REFUSED -> WithdrawalLook("NOT RETURNED", Verb.STONE, false, action,
            w.line.ifBlank { "The payout had already started. It reaches your wallet." })
    }
}

/** The BACK TO FORGE ConfirmDialog line: "Bring 200 KEEP back to the forge? The forge checks this one again first. No
 *  wallet step." (not a money Seal: nothing leaves the wallet). */
fun returnConfirmLine(amount: String): String =
    "Bring ${legacySavedText(amount)} KEEP back to the forge? The forge checks this one again first. No wallet step."

/** Words this tab must never show (SPEC E1.1 Copy); used by the tests over every line the logic builds. */
val LEGACY_FORBIDDEN_WORDS: List<String> = listOf("custody", "custodial", "escrow", "transaction", "cutover", "failed", "Nothing was spent")
