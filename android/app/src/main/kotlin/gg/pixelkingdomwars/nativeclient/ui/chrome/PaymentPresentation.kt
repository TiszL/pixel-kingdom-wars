package gg.pixelkingdomwars.nativeclient.ui.chrome

import gg.pixelkingdomwars.nativeclient.network.fmtDur
import java.time.Instant

/* The pure presentation rules shared by every SOL / KEEP payment plate (market purchase, base purchase, KEEP
 * deposit, land entry): what the status pill says, how the payment window reads, and which actions a state
 * offers. No Compose here, so the JVM tests pin them. Nothing here decides money: every `enabled` flag is
 * handed in from the repository's own gates (`canPay`, `canFinish`, `busy`) and only echoed. */

/** Pill tone: OPEN = unpaid and payable, SENT = wallet approved and settling, DONE = settled, TROUBLE = declined or
 * unknown, CLOSED = the server closed it (expired, cancelled, superseded). */
enum class PaymentTone { OPEN, SENT, DONE, TROUBLE, CLOSED }
data class PaymentPill(val label: String, val tone: PaymentTone)

/* Pills (owner 2026-09-18, "simple, as in most games"): the happy path reads NOT PAID -> CONFIRMING -> DONE. The
 * server's own words (reserved, committed, superseded) stay out of the player's way. `uncertain` = [paymentUncertain]:
 * a payment nobody can prove was sent is CHECKING, never CONFIRMING. */
private fun openPill(attempted: Boolean, uncertain: Boolean) = when {
    uncertain -> PaymentPill("CHECKING", PaymentTone.TROUBLE)
    attempted -> PaymentPill("CONFIRMING", PaymentTone.SENT)
    else -> PaymentPill("NOT PAID", PaymentTone.OPEN)
}

/** The wallet was opened for this payment, no signature was ever recorded, and the PAY tap is over: the wallet reply
 * was lost or unreadable, so nothing proves a transfer was signed or sent (today's Seeker failure lands here). */
fun paymentUncertain(attempted: Boolean, signed: Boolean, paying: Boolean): Boolean = attempted && !signed && !paying

/** Market reservation receipt state (`MarketReservationReceipt.state`) plus whether a wallet payment was attempted. */
fun marketPaymentPill(receiptState: String, attempted: Boolean, uncertain: Boolean = false): PaymentPill = when (receiptState) {
    "settled" -> PaymentPill("DONE", PaymentTone.DONE)
    "cancelled", "superseded" -> PaymentPill("ENDED", PaymentTone.CLOSED)
    else -> openPill(attempted, uncertain)
}

/** Base purchase (`BasePurchaseState.status`, null while the quote reply is unknown) plus the attempted flag. */
fun basePurchasePill(status: String?, attempted: Boolean, uncertain: Boolean = false): PaymentPill = when (status) {
    null -> PaymentPill("CHECKING", PaymentTone.TROUBLE)
    "credited" -> PaymentPill("DONE", PaymentTone.DONE)
    "failed" -> PaymentPill("FAILED", PaymentTone.TROUBLE)
    "expired" -> PaymentPill("ENDED", PaymentTone.CLOSED)
    else -> openPill(attempted, uncertain)
}

/** KEEP deposit (`KeepDepositReceipt.status`, null before any receipt) plus the attempted flag. */
fun keepDepositPill(status: String?, attempted: Boolean, uncertain: Boolean = false): PaymentPill = when (status) {
    "credited" -> PaymentPill("DONE", PaymentTone.DONE)
    "failed" -> PaymentPill("FAILED", PaymentTone.TROUBLE)
    "expired" -> PaymentPill("ENDED", PaymentTone.CLOSED)
    else -> openPill(attempted, uncertain)
}

/** The human payment window from whole seconds left: `m:ss` under an hour (the owner's "pay within 4:12"),
 * the shared fmtDur words from an hour up, and the closed line at zero. Display only — the server's
 * `payableUntil` and the repository's `quoteFresh` gate still decide whether PAY is offered. */
fun payWithinText(remainingSec: Long): String = when {
    remainingSec <= 0 -> "PAYMENT WINDOW CLOSED"
    remainingSec < 3_600 -> "PAY WITHIN ${remainingSec / 60}:${(remainingSec % 60).toString().padStart(2, '0')}"
    else -> "PAY WITHIN ${fmtDur(remainingSec)}"
}

/** [payWithinText] against a server ISO deadline and the device clock (the raw ISO stamp asked the player to do
 * this arithmetic). Null when the deadline cannot be read, so nothing is invented for it. */
fun payWithinLabel(payableUntil: String?, nowMs: Long): String? {
    val until = payableUntil?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: return null
    return payWithinText(maxOf(0L, (until - nowMs + 999) / 1_000))
}

/** The happy path goes straight from the price tap to the wallet, so the window is only worth a line once it is
 * about to close (or has closed) on an unpaid plate. Same text and rounding as [payWithinLabel]. */
const val PAY_WINDOW_URGENT_SEC = 60L
fun payWindowUrgent(payableUntil: String?, nowMs: Long): String? {
    val until = payableUntil?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: return null
    val remaining = maxOf(0L, (until - nowMs + 999) / 1_000)
    return if (remaining <= PAY_WINDOW_URGENT_SEC) payWithinText(remaining) else null
}

/** What the one status line under the amount says while a payment is in flight. `paying` is the screen's own
 * "the PAY tap is still running" flag; `signed` is the durable signature. Null = nothing in flight.
 * "WE FINISH IT" is promised only for a recorded signature: that is a transfer the server can find and credit. With no
 * signature ([paymentUncertain]) nothing may have been sent at all, so the line says what is true: it is being
 * checked and must not be paid twice. */
fun paymentProgressLine(exists: Boolean, attempted: Boolean, signed: Boolean, paying: Boolean): String? = when {
    !exists -> if (paying) "GETTING YOUR PRICE…" else null
    !attempted -> if (paying) "OPENING WALLET…" else null
    signed -> "CONFIRMING… SAFE TO LEAVE — WE FINISH IT WHEN YOU COME BACK."
    paying -> "CONFIRM IN YOUR WALLET…"
    else -> "WE COULD NOT TELL IF YOUR WALLET SENT THIS — CHECKING. DO NOT PAY AGAIN."
}

/** A PAY tap's failure sentence, pinned to the purchase it belongs to (`mark` = that purchase's identity and server
 * status). It cannot live in a repository's `state.error`: every repository action clears that, and the confirm loops
 * act within one poll, which wiped the wallet's own reason seconds after it appeared. */
data class PayFailure<M>(val message: String, val mark: M) {
    /** The sentence while the same purchase is still in the same status; null once it moved on or was replaced. */
    fun shownFor(current: M?): String? = message.takeIf { mark == current }
}

/** The line on an unpaid, never-attempted base quote that cannot be paid right now. `available` = the server offers
 * this purchase (`supported && enabled`); when it does, the only other cause is the closed price window. The server
 * keeps the unpaid quote until `retryAt` and a saved quote blocks the next purchase, so the line says when buying
 * works again instead of promising that the plate clears itself. Past `retryAt` the explicit VERIFY is what lets the
 * server end an unpaid quote (it never does so from a GET). */
fun unpaidQuoteBlockedLine(available: Boolean, retryAt: String?, nowMs: Long): String {
    if (!available) return "THIS PRICE CANNOT BE PAID RIGHT NOW — NOTHING WAS CHARGED. CHECK NOW LOOKS AGAIN."
    val until = retryAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    val remaining = until?.let { maxOf(0L, (it - nowMs + 999) / 1_000) } ?: 0L
    return if (remaining > 0) "PRICE HOLD ENDED — NOTHING WAS CHARGED. YOU CAN BUY AGAIN IN ${remaining / 60}:${(remaining % 60).toString().padStart(2, '0')} — WE KEEP CHECKING."
        else "PRICE HOLD ENDED — NOTHING WAS CHARGED. TAP VERIFY PAYMENT TO CLOSE IT, THEN BUY AGAIN."
}

/** One technical identifier under the collapsed DETAILS disclosure; tapping a row copies its value. */
data class PaymentDetail(val label: String, val value: String)

/** Exactly one PRIMARY (the gold plate) per plan; SECONDARY is the stone plate, GHOST the text button. */
enum class PaymentActionRole { PRIMARY, SECONDARY, GHOST }
data class PaymentAction(val id: String, val label: String, val role: PaymentActionRole, val enabled: Boolean = true)

/** Action ids the plates dispatch on. Shared across surfaces so one `when` reads the same everywhere. */
object PaymentActions {
    const val PAY = "pay"; const val CHECK = "check"; const val VERIFY = "verify"; const val FINISH = "finish"
    const val CLOSE = "close"; const val LEAVE = "leave"; const val RETRY_QUOTE = "retry-quote"; const val CANCEL_UNQUOTED = "cancel-unquoted"
    const val REVIEW = "review"; const val BACK = "back"
}

/** What a payment plate offers. `actions` is the happy path (at most one gold plate); `detailActions` are the manual
 * recovery controls, shown only inside the opened DETAILS disclosure because recovery runs by itself. */
data class PaymentPlan(val actions: List<PaymentAction>, val detailActions: List<PaymentAction> = emptyList()) {
    val all: List<PaymentAction> get() = actions + detailActions
}

private fun retryLabel(paying: Boolean, amount: String, unit: String) = if (paying) "OPENING WALLET…" else "RETRY · $amount $unit"

/** Base purchase (energy, builder, expansion, mine, shield). An unpaid quote is only ever seen after a declined or
 * interrupted first tap, so its gold plate is RETRY. Once a payment was attempted there is NO gold plate: the screen
 * confirms by itself and CHECK / VERIFY live under DETAILS. A credited or server-ended unpaid quote closes itself; the
 * OK plate is the one-tap fallback behind the repository's own canFinish gate.
 * `payable` = the repository's durable part of canPay (`quoteFresh && supported && enabled`, not `busy`). An unpaid quote
 * that is not payable cannot be closed locally (the store refuses a pending quote) and blocks every base purchase, so
 * a dead RETRY is never its only plate: CHECK NOW and VERIFY PAYMENT come out of DETAILS and become the actions. */
fun basePurchasePlan(status: String?, attempted: Boolean, canPay: Boolean, canFinish: Boolean, busy: Boolean,
    supported: Boolean, enabled: Boolean, amountSol: String, paying: Boolean = false, payable: Boolean = true): PaymentPlan = when (status) {
    null -> PaymentPlan(listOf(
        PaymentAction(PaymentActions.CHECK, "CHECK AGAIN", PaymentActionRole.PRIMARY, !busy),
        PaymentAction(PaymentActions.RETRY_QUOTE, "RETRY", PaymentActionRole.SECONDARY, !busy && supported && enabled),
        PaymentAction(PaymentActions.CANCEL_UNQUOTED, "CANCEL", PaymentActionRole.GHOST, !busy)))
    "credited" -> PaymentPlan(listOf(PaymentAction(PaymentActions.FINISH, "OK", PaymentActionRole.PRIMARY, canFinish && !busy)),
        listOf(PaymentAction(PaymentActions.CHECK, "REFRESH", PaymentActionRole.SECONDARY, !busy)))
    "expired", "failed" -> PaymentPlan(
        if (!attempted) listOf(PaymentAction(PaymentActions.CLOSE, "OK", PaymentActionRole.PRIMARY, canFinish && !busy)) else emptyList(),
        listOf(PaymentAction(PaymentActions.CHECK, "CHECK NOW", PaymentActionRole.SECONDARY, !busy),
            PaymentAction(PaymentActions.VERIFY, "VERIFY PAYMENT", PaymentActionRole.SECONDARY, !busy)))
    else -> if (!attempted && !payable && !paying) PaymentPlan(listOf(
            PaymentAction(PaymentActions.CHECK, "CHECK NOW", PaymentActionRole.PRIMARY, !busy),
            PaymentAction(PaymentActions.VERIFY, "VERIFY PAYMENT", PaymentActionRole.SECONDARY, !busy)))
        else PaymentPlan(
        if (attempted) emptyList() else listOf(PaymentAction(PaymentActions.PAY, retryLabel(paying, amountSol, "SOL"), PaymentActionRole.PRIMARY, canPay)),
        listOf(PaymentAction(PaymentActions.CHECK, "CHECK NOW", PaymentActionRole.SECONDARY, !busy),
            PaymentAction(PaymentActions.VERIFY, "VERIFY PAYMENT", PaymentActionRole.SECONDARY, !busy)))
}

/** Market purchase: `leaveAllowed` is the repository's own guard (no MARKET_RESERVE intent still pending);
 * CANCEL never appears once a payment was attempted, because leaving would hide a possibly-paid reservation. */
fun marketPaymentPlan(receiptState: String, attempted: Boolean, canPay: Boolean, senderConnected: Boolean, boundsKnown: Boolean,
    busy: Boolean, hydrated: Boolean, leaveAllowed: Boolean, amountSol: String, paying: Boolean = false): PaymentPlan = when (receiptState) {
    "settled" -> PaymentPlan(listOf(PaymentAction(PaymentActions.FINISH, "OK", PaymentActionRole.PRIMARY, !busy && hydrated)),
        listOf(PaymentAction(PaymentActions.CHECK, "REFRESH", PaymentActionRole.SECONDARY, !busy && boundsKnown)))
    "cancelled", "superseded" -> PaymentPlan(
        if (!attempted) listOf(PaymentAction(PaymentActions.LEAVE, "OK", PaymentActionRole.PRIMARY, !busy && leaveAllowed)) else emptyList(),
        listOf(PaymentAction(PaymentActions.CHECK, "CHECK NOW", PaymentActionRole.SECONDARY, !busy && boundsKnown)))
    else -> PaymentPlan(
        if (attempted) emptyList() else listOf(
            PaymentAction(PaymentActions.PAY, retryLabel(paying, amountSol, "SOL"), PaymentActionRole.PRIMARY, canPay && senderConnected && boundsKnown),
            PaymentAction(PaymentActions.LEAVE, "CANCEL", PaymentActionRole.GHOST, !busy && leaveAllowed)),
        listOf(PaymentAction(PaymentActions.CHECK, "CHECK NOW", PaymentActionRole.SECONDARY, !busy && boundsKnown)))
}

/** KEEP deposit: CANCEL / OK (both `repository.close()`) only while unpaid; a paid deposit confirms by itself. */
fun keepDepositPlan(status: String?, attempted: Boolean, canPay: Boolean, boundsKnown: Boolean, busy: Boolean,
    hydrated: Boolean, amountKeep: String, paying: Boolean = false): PaymentPlan = when (status) {
    "credited" -> PaymentPlan(listOf(PaymentAction(PaymentActions.FINISH, "OK", PaymentActionRole.PRIMARY, !busy && hydrated)),
        listOf(PaymentAction(PaymentActions.CHECK, "REFRESH", PaymentActionRole.SECONDARY, !busy && boundsKnown)))
    "failed", "expired" -> PaymentPlan(
        if (!attempted) listOf(PaymentAction(PaymentActions.CLOSE, "OK", PaymentActionRole.PRIMARY, !busy)) else emptyList(),
        listOf(PaymentAction(PaymentActions.CHECK, "CHECK NOW", PaymentActionRole.SECONDARY, !busy && boundsKnown)))
    else -> PaymentPlan(
        if (attempted) emptyList() else listOf(
            PaymentAction(PaymentActions.PAY, retryLabel(paying, amountKeep, "KEEP"), PaymentActionRole.PRIMARY, canPay && boundsKnown),
            PaymentAction(PaymentActions.CLOSE, "CANCEL", PaymentActionRole.GHOST, !busy)),
        listOf(PaymentAction(PaymentActions.CHECK, "CHECK NOW", PaymentActionRole.SECONDARY, !busy && boundsKnown)))
}
