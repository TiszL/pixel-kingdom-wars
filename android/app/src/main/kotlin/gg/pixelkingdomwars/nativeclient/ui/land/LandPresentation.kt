package gg.pixelkingdomwars.nativeclient.ui.land

import gg.pixelkingdomwars.nativeclient.model.LandDeposit
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.wallet.LandFundingEstimate
import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode

/** Pure presentation rules of the land screen (web `ui/land/FundingChip.tsx`, `StageRail.tsx`): no Compose, so
 * the JVM tests pin them. Every number here is a wallet balance or a server-frozen price — never a game constant. */

/** Web `shortWallet`: the first four and last four characters of an address. Short inputs are shown whole. */
fun shortWallet(address: String): String = if (address.length <= 11) address else "${address.take(4)}…${address.takeLast(4)}"

/** A server SOL amount (`WalletFunds.sol`, decimal text) as exact lamports; null for absent, malformed or negative text. */
fun solToLamports(sol: String?): BigInteger? = sol?.toBigDecimalOrNull()?.takeIf { it.signum() >= 0 }
    ?.movePointRight(9)?.setScale(0, RoundingMode.DOWN)?.toBigIntegerExact()

/** Lamports as SOL text with the trailing zeros trimmed (`0.200000000` → `0.2`), never below the integer part. */
fun solTextTrimmed(lamports: BigInteger): String {
    val text = BigDecimal(lamports).movePointLeft(9).toPlainString()
    return if ('.' in text) text.trimEnd('0').trimEnd('.') else text
}

enum class FundingSource { RPC, SERVER, NONE }

/** What the FUNDING chip answers: how much SOL the wallet holds (and who last read it), how much the frozen
 * deed needs, and whether that figure already includes the network fee and account rent. */
data class FundingView(val balanceLamports: BigInteger?, val source: FundingSource, val requiredLamports: BigInteger?, val feeKnown: Boolean) {
    /** null while either side is unknown; the PAY button never trusts a null as "funded". */
    val funded: Boolean? get() = if (balanceLamports == null || requiredLamports == null) null else balanceLamports >= requiredLamports
    val balanceText: String get() = balanceLamports?.let { "${solText(it, 4)} SOL" } ?: "BALANCE UNAVAILABLE"
    /** Web: `NEEDS n SOL INCLUDING FEES` once the estimate priced the payment, `+ FEES` while only the frozen price is known. */
    val needText: String? get() = if (funded != false || requiredLamports == null) null
        else "NEEDS ${solTextTrimmed(requiredLamports)} SOL${if (feeKnown) " INCLUDING FEES" else " + FEES"}"
}

/** Web `fundingBalance`: the client's own RPC read (the funding estimate, refreshed while this screen is open) leads
 * whenever it answered, because a fresh wallet must SEE funds arrive; the server's `/wallet/balances` read covers a
 * wallet the RPC has not priced yet (no reservation, blocked endpoint) so the row is never blank. */
fun fundingView(estimate: LandFundingEstimate?, wallet: WalletFunds?, reservation: LandDeposit?): FundingView {
    val server = solToLamports(wallet?.sol)
    val balance = estimate?.balanceLamports ?: server
    val source = when { estimate != null -> FundingSource.RPC; server != null -> FundingSource.SERVER; else -> FundingSource.NONE }
    val required = estimate?.requiredLamports ?: reservation?.amountLamports?.toBigIntegerOrNull()
    return FundingView(balance, source, required, estimate != null)
}

/** The stage rail reads as progress: gold for what is done, bright gold for where the player is, faint for what is next. */
enum class RailState { DONE, ACTIVE, NEXT }
fun railState(stage: LandStage, id: LandStage): RailState = when {
    id.ordinal < stage.ordinal -> RailState.DONE
    id == stage -> RailState.ACTIVE
    else -> RailState.NEXT
}

/** Web `LAND_STAGES` labels, in order. */
val LAND_STAGE_LABELS: List<Pair<LandStage, String>> = listOf(
    LandStage.PICK to "PICK", LandStage.RESERVE to "RESERVE / FUND", LandStage.PAY to "APPROVE PAYMENT",
    LandStage.CONFIRMED to "PAYMENT CONFIRMED", LandStage.MINTING to "DEED MINTING", LandStage.DEED to "DEED READY",
)

/** The gate line above the actions. A refusal (402 LAND_NOT_OWNED) is a gate, not an error: it names what was refused when known. */
fun landGateMessage(reason: String, additionalDeed: Boolean, refused: String? = null): String = when {
    reason == "refused" -> "LAND REQUIRED — ${refused?.let { "$it needs" } ?: "That one needs"} land you do not own yet."
    additionalDeed -> "Found another keep on a second parcel."
    else -> "YOUR LAND — Your keep stands on unclaimed ground."
}

/** Web `ParcelCard` status kicker for a reserved parcel: payment credit and the minted deed are separate facts. */
fun parcelStatusLabel(paymentCredited: Boolean, deedReady: Boolean): String = when {
    deedReady -> "LAND DEED READY"
    paymentCredited -> "PAYMENT CONFIRMED · DEED MINTING"
    else -> "RESERVED FOR YOU"
}

/** Tile grid glyph: the one-word availability read from the viewport markers or the metered parcel inspection. */
fun tileGlyph(occupied: Boolean, availability: String?): String = when {
    occupied || availability == "occupied" -> "settled"
    availability == "held" -> "held"
    availability == "reserved" -> "reserved"
    availability == "available" -> "free"
    else -> ""
}
