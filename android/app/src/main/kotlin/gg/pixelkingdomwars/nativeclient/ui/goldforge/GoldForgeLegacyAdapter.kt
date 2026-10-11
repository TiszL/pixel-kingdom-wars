package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.data.EconomyState
import gg.pixelkingdomwars.nativeclient.model.WithdrawalRecord
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.LEGACY_CHECKING_LINE
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.LegacyV2Ui
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.LegacyWithdrawalUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.WithdrawalState
import gg.pixelkingdomwars.nativeclient.wallet.KeepDepositPayment
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.UUID

/** Read-only Legacy projection. The host owns current session/base/generation witnesses and all navigation.
 * Retained history stays discoverable after a failed read, with every unproved row labelled CHECKING.
 * No wallet balance, conversion promise, return permission or money owner is supplied by this adapter.
 *
 * [balanceCurrent] / [withdrawalsCurrent] are the host's witnesses that these exact objects came from its last good read,
 * so a routine refresh (`state.loading`) keeps them on screen under the 2 dp loading line (SPEC E1.1 loading: last good
 * values). [failedAt] is non-null only when the host's latest LEGACY or balance read failed: the "HH:mm" of its last good
 * read. The witnessed saved amount then stays, labelled "as of HH:mm" (SPEC E1.1 error); without it a failed balance read
 * withholds the amount. A failed history read always turns rows CHECKING (a status it cannot confirm now). `saved` stays the
 * raw validated server decimal; the tab draws it grouped through `legacySavedText` / `exactAmount`.
 */
internal fun goldForgeLegacyUi(
    state: EconomyState,
    baseId: String?,
    current: Boolean,
    balanceCurrent: Boolean,
    withdrawalsCurrent: Boolean,
    failedAt: String? = null,
): LegacyV2Ui? {
    if (!current) return null
    // A malformed clock is ignored: no "as of" label and no retained amount over a failed read.
    val asOf = failedAt?.trim()?.takeIf(LEGACY_CLOCK::matches)
    val saved = state.balances?.keep?.takeIf {
        balanceCurrent && state.baseId == baseId && (state.errors["/balances"] == null || asOf != null) &&
            LEGACY_AMOUNT.matches(it)
    }
    val tracked = state.withdrawals.orEmpty()
    if (saved?.toBigDecimal()?.signum() != 1 && tracked.isEmpty()) return null
    val historyCurrent = withdrawalsCurrent && state.errors["/withdrawals"] == null
    val duplicateIds = tracked.groupingBy { it.id }.eachCount().filterValues { it > 1 }.keys
    return LegacyV2Ui(
        saved = saved,
        cutoverAt = null,
        rate = "",
        withdrawals = tracked.map { legacyWithdrawal(it, historyCurrent && it.id !in duplicateIds) },
        refreshedAgo = null,
        live = false,
        loading = state.loading,
        asOf = asOf,
        conversionPlanCurrent = false,
    )
}

/** A SENT row's one line (legacy.png / SPEC E1.1): "In your wallet since 12 Sep", the completion day in the device [zone]. */
internal fun legacySentLine(completed: Instant, zone: ZoneId = ZoneId.systemDefault()): String =
    "In your wallet since ${LEGACY_DAY.format(completed.atZone(zone))}"

private fun legacyWithdrawal(row: WithdrawalRecord, current: Boolean): LegacyWithdrawalUi {
    val gross = row.gross.takeIf(LEGACY_AMOUNT::matches)
    val fee = row.fee.takeIf(LEGACY_AMOUNT::matches)
    val net = row.net.takeIf(LEGACY_AMOUNT::matches)
    val created = legacyInstant(row.createdAt)
    val unbonds = row.unbondsAt?.let(::legacyInstant)
    val complete = row.completedAt?.let(::legacyInstant)
    val factsValid = current && runCatching { UUID.fromString(row.id).toString() == row.id }.getOrDefault(false) &&
        KeepDepositPayment.validAddress(row.destination) && gross != null && fee != null && net != null &&
        gross.toBigDecimal().signum() > 0 && gross.toBigDecimal().subtract(fee.toBigDecimal()).compareTo(net.toBigDecimal()) == 0 &&
        created != null && (row.unbondsAt == null || (unbonds != null && unbonds >= created))
    val sent = factsValid && row.status == "sent" && row.signature?.let(KeepDepositPayment::validSignature) == true &&
        complete != null && created != null && complete >= created
    val unlocking = factsValid && row.status == "unbonding" && unbonds != null
    return LegacyWithdrawalUi(
        id = row.id,
        amount = gross ?: UNKNOWN,
        state = when {
            sent -> WithdrawalState.SENT
            unlocking -> WithdrawalState.UNLOCKING
            else -> WithdrawalState.CHECKING
        },
        line = when {
            // Proven by the signature and completion checks above; the day is when it completed, never a forecast.
            sent -> legacySentLine(requireNotNull(complete))
            // unbondsAt is not an arrival time, so no "In your wallet in …" countdown is derived from it.
            unlocking -> "Withdrawal is unlocking."
            else -> LEGACY_CHECKING_LINE
        },
        canReturn = false,
        proof = row.id.takeIf { sent },
    )
}

private fun legacyInstant(value: String): Instant? = runCatching { Instant.parse(value) }.getOrNull()
private val LEGACY_AMOUNT = Regex("(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?")
private val LEGACY_CLOCK = Regex("(?:[01][0-9]|2[0-3]):[0-5][0-9]")
private val LEGACY_DAY: DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)
