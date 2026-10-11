package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionSourcedRoundView
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionSpot
import gg.pixelkingdomwars.nativeclient.starter.paidStarterRealmIds
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CelebrationUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.SealUi
import gg.pixelkingdomwars.nativeclient.ui.model.SpotSheetUi
import gg.pixelkingdomwars.nativeclient.ui.model.SpotState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.AlertKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.AuctionPhase
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.BidStepperUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.CrestUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.KingdomRefUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SeekerPanelUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SeekerSpotUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SpotAlertUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SpotLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.bidSealUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.spotWonCelebration
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.withdrawSealUi
import java.math.BigInteger
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.json.JsonObject

/*
 * The Seeker auction's round views (`/seeker/auctions/current` and `/round/:round`, already validated by the network
 * module's SeekerAuctionProtocol) drawn as the designed panel, spot sheet, BidStepper, seals and won celebration
 * (design/final/map/SPEC.md §3.1, §3.4-§3.7; plan onchain-client-reach.md §5.4 S-D). Pure: no network, wallet or clock
 * reads. Time is the caller's estimate of CHAIN time ([seekerChainNowSec]); amounts are exact raw base units in
 * BigInteger and become decimal text with the round's `config.decimals` (never floating point).
 *
 * Logged decision (plan §2.4): the server has no `minIncrement`. The program admits `new_total >= opening` and
 * `new_total > high` (escrow.rs bid_increment), so the stepper minimum is max(opening bid, top bid + 1 raw) rounded UP to
 * a whole token, and one step is one whole token (10^decimals raw). Both come from server values; no Kotlin constant.
 * A raise tops up the escrow already held (the program charges new total − own bid), so a raise says "adds".
 */

private const val CHAIN = "chain"
private const val FIXTURE = "fixture"
private const val KING = "king"
private val U64_MAX = BigInteger("18446744073709551615")
private val RAW_AMOUNT = Regex("0|[1-9][0-9]*")
private val AUCTION_CLOCK: DateTimeFormatter = DateTimeFormatter.ofPattern("EEE HH:mm", Locale.US).withZone(ZoneOffset.UTC)

/** The spot number players see ("SPOT 1"): the protocol index + 1, as every other Seeker surface on this client draws it. */
internal fun seekerSpotNo(spot: Int): Int = spot + 1

/** The protocol index of a drawn spot number (search, an alert's GO), or null when the round has no such spot. */
internal fun seekerSpotIndex(spotNo: Int, view: SeekerAuctionSourcedRoundView): Int? =
    (spotNo - 1).takeIf { index -> view.spots.any { it.spot == index } }

/** Chain seconds now: the read's finalized chain clock plus the MONOTONIC time since that read, never the device's wall
 *  clock (a phone set to the wrong time must not open or close bidding on screen). */
internal fun seekerChainNowSec(view: SeekerAuctionSourcedRoundView, elapsedMs: Long): Long =
    view.chainUnixTime.toLong() + elapsedMs.coerceAtLeast(0L) / 1000L

/** The round before [current], or null for round 0. The host reads it for MY SPOTS, won spots and held escrow. */
internal fun seekerPreviousRound(current: SeekerAuctionSourcedRoundView): String? =
    current.round.toBigIntegerOrNull()?.takeIf { it.signum() > 0 }?.minus(BigInteger.ONE)?.toString()

/** A raw amount as exact decimal text at [decimals]: grouped whole part, trailing fraction zeros dropped ("1,234.5").
 *  Null for anything that is not a canonical u64 string, so a malformed amount reads "…", never a number. */
internal fun seekerSkrText(raw: String, decimals: Int): String? {
    if (raw.length > 20 || !raw.matches(RAW_AMOUNT) || decimals !in 0..255) return null
    val parts = raw.toBigInteger().divideAndRemainder(BigInteger.TEN.pow(decimals))
    val whole = "%,d".format(Locale.US, parts[0])
    if (parts[1].signum() == 0) return whole
    return whole + "." + parts[1].toString().padStart(decimals, '0').trimEnd('0')
}

/** Bidding is admitted for the whole round: this is the bidding round, admission is not paused and all spots are open
 *  (`auctionRoutes.ts` bidIntent; the bid route refuses anything else). */
private fun admitting(v: SeekerAuctionSourcedRoundView): Boolean =
    v.round == v.biddingRound && !v.admissionPaused && v.openedCount == v.spots.size

private fun row(v: SeekerAuctionSourcedRoundView, spot: Int): SeekerAuctionSpot? = v.spots.firstOrNull { it.spot == spot }

/** Whether the program would admit a bid on [spot] at [nowSec]: the network port's `bidWindowOpen` rule (chain source, the
 *  bidding round, not paused, every spot open, this one open and unsettled) evaluated at the estimated chain time instead
 *  of the read time. It only decides whether BID is offered; the server re-checks everything at prepare. */
internal fun seekerBidOpen(view: SeekerAuctionSourcedRoundView, spot: Int, nowSec: Long): Boolean {
    val r = row(view, spot) ?: return false
    return runCatching {
        view.source == CHAIN && admitting(view) && r.opened && !r.settled &&
            nowSec >= view.auctionStart.toLong() && nowSec < view.auctionEnd.toLong()
    }.getOrDefault(false)
}

/**
 * Where the auction stands on the round's calendar (SPEC §3.1): OPENS_AT before round 0's window; OPEN inside the window
 * while bidding is admitted (inside it but paused or not fully opened reads OPENS_AT, time unknown); OPERATING once the
 * window ended, and before a later round's window (the previous term is then operating). Never SERVER_OFF: a view exists.
 */
internal fun seekerAuctionPhase(view: SeekerAuctionSourcedRoundView, nowSec: Long): AuctionPhase {
    val start = view.auctionStart.toLong()
    val end = view.auctionEnd.toLong()
    return when {
        nowSec >= end -> AuctionPhase.OPERATING
        nowSec >= start -> if (admitting(view)) AuctionPhase.OPEN else AuctionPhase.OPENS_AT
        view.round != "0" -> AuctionPhase.OPERATING
        else -> AuctionPhase.OPENS_AT
    }
}

/** The state card's time: OPEN = left in the window; otherwise until the next window opens (this round's, or the next
 *  round's once this one ended). Null inside the window while bidding is not admitted: when it resumes is unknown. */
private fun phaseTime(v: SeekerAuctionSourcedRoundView, phase: AuctionPhase, nowSec: Long): String? {
    val start = v.auctionStart.toLong()
    val end = v.auctionEnd.toLong()
    return when {
        phase == AuctionPhase.SERVER_OFF -> null
        phase == AuctionPhase.OPEN -> fmtDur(end - nowSec)
        nowSec < start -> fmtDur(start - nowSec)
        nowSec >= end -> fmtDur(start + v.config.termSec.toLong() - nowSec)
        else -> null
    }
}

/** The 12 dp meter: the share of the bidding window gone (SPEC §3.1 uses the round's `auctionSec`, never "24 h"). */
private fun phaseProgress(v: SeekerAuctionSourcedRoundView, phase: AuctionPhase, nowSec: Long): Float? {
    if (phase != AuctionPhase.OPEN) return null
    val window = v.config.auctionSec.toLong()
    if (window <= 0L) return null
    return ((nowSec - v.auctionStart.toLong()).toFloat() / window.toFloat()).coerceIn(0f, 1f)
}

/** [previous] only when it is truly the round before [current] for the same wallet and auction config. */
private fun matchingPrevious(current: SeekerAuctionSourcedRoundView, previous: SeekerAuctionSourcedRoundView?): SeekerAuctionSourcedRoundView? =
    previous?.takeIf { it.round == seekerPreviousRound(current) && it.wallet == current.wallet && it.config == current.config }

/** A settled spot whose top bidder is this wallet: the program has moved the escrow to the prize account; it is won. */
private fun won(v: SeekerAuctionSourcedRoundView, r: SeekerAuctionSpot): Boolean = r.settled && r.highBidder == v.wallet

/** ENTER ISLAND, enabled whatever the auction's state: the island is a place (SPEC §3.1). */
private fun seekerEnter(): CommandUi = CommandUi(FeatureId("island.seeker.enter"), "ui:seeker-navigation", "ENTER ISLAND", null, true,
    CommandState.ENABLED, null, null, verb = Verb.GOLD, sub = "bid from the trading spots")

/** "Outbid on Spot 42 / 120 SKR held for you": the held amount is the spot sheet's held row amount (CRITIC C11). */
private fun outbidAlert(v: SeekerAuctionSourcedRoundView, r: SeekerAuctionSpot): SpotAlertUi {
    val no = seekerSpotNo(r.spot)
    return SpotAlertUi(no, AlertKind.OUTBID, "Outbid on Spot $no", "${seekerSkrText(r.yourBidRaw, v.config.decimals) ?: UNKNOWN} SKR held for you")
}

/**
 * The Seeker panel (SPEC §3.1) from the bidding round [current] and the round before it [previous] (null while unread;
 * ignored unless it is that round). [current] null = loading ("…"), or the error line when [error]. [error] with a view
 * keeps that view's values (a routine refresh never blanks shown data). MY SPOTS = settled wins still operating; MY BIDS =
 * unsettled spots holding your escrow; alerts = outbid rows with your held escrow. Both read "…" when round > 0 and the
 * previous round is unread. A view this mapper cannot read draws the error line, never a crash.
 */
internal fun seekerAuctionPanelUi(catalogue: JsonObject?, current: SeekerAuctionSourcedRoundView?,
    previous: SeekerAuctionSourcedRoundView?, nowSec: Long, error: Boolean = false): SeekerPanelUi {
    val base = seekerPanelUi(catalogue)
    val waiting = base.copy(panel = base.panel.copy(primary = seekerEnter()), phase = null, error = error)
    if (current == null) return waiting
    return runCatching {
        val prev = matchingPrevious(current, previous)
        val previousUnread = current.round != "0" && prev == null
        val views = listOfNotNull(current, prev)
        val phase = seekerAuctionPhase(current, nowSec)
        waiting.copy(
            catalogueLine = base.catalogueLine.takeIf { it != UNKNOWN }
                ?: "${current.spots.size} spots, ${current.spots.count { it.spotClass == KING }} of them King.",
            phase = phase,
            phaseTime = phaseTime(current, phase, nowSec),
            phaseProgress = phaseProgress(current, phase, nowSec),
            mySpots = if (previousUnread) UNKNOWN else views.sumOf { v ->
                v.spots.count { won(v, it) && nowSec < v.operatingEnd.toLong() } }.toString(),
            myBids = if (previousUnread) UNKNOWN else views.sumOf { v -> v.spots.count { it.yourBidRaw != "0" && !it.settled } }.toString(),
            alerts = views.flatMap { v -> v.spots.filter { it.refundable }.map { outbidAlert(v, it) } }.distinctBy { it.spotNo },
            testData = views.any { it.source == FIXTURE })
    }.getOrElse { waiting.copy(error = true) }
}

/** Which round the spot sheet for [spot] shows: the bidding round, unless only the previous round holds this wallet's
 *  stake there (its win, its lead awaiting settlement or its held escrow). Null while [current] is unread. */
internal fun seekerSpotView(current: SeekerAuctionSourcedRoundView?, previous: SeekerAuctionSourcedRoundView?,
    spot: Int): SeekerAuctionSourcedRoundView? {
    if (current == null) return null
    val prev = matchingPrevious(current, previous)
    fun stake(v: SeekerAuctionSourcedRoundView) = row(v, spot)?.let { it.yourBidRaw != "0" || it.highBidder == v.wallet } == true
    return if (!stake(current) && prev != null && stake(prev)) prev else current
}

/** A spot's state (SPEC §3.4-§3.7). Held escrow always reads OUTBID so WITHDRAW stays reachable in every phase; a lead
 *  reads YOU_LEAD until settlement (never KING before the program settles it); a settled win is KING while it operates. */
private fun spotState(v: SeekerAuctionSourcedRoundView, r: SeekerAuctionSpot, nowSec: Long): SpotState {
    val ended = nowSec >= v.auctionEnd.toLong()
    val mine = r.highBidder == v.wallet
    return when {
        !r.opened -> if (ended) SpotState.CLOSED else SpotState.NOT_OPEN
        r.refundable -> SpotState.OUTBID
        mine && r.settled -> if (nowSec < v.operatingEnd.toLong()) SpotState.KING else SpotState.CLOSED
        mine -> SpotState.YOU_LEAD
        ended || r.settled -> SpotState.CLOSED
        nowSec < v.auctionStart.toLong() || !admitting(v) -> SpotState.NOT_OPEN
        else -> SpotState.LIVE
    }
}

/** The sprite look (SPEC §3.3 table): available = no bid; occupied = a bid leads, or won and waiting for settlement;
 *  active = operating this term; expired = unsold or term over. */
private fun spotLook(v: SeekerAuctionSourcedRoundView, r: SeekerAuctionSpot, state: SpotState, nowSec: Long): SpotLook = when (state) {
    SpotState.KING -> SpotLook.ACTIVE
    SpotState.YOU_LEAD, SpotState.OUTBID -> SpotLook.OCCUPIED
    SpotState.NOT_OPEN, SpotState.LIVE, SpotState.LICENCE_LATER -> if (r.highBidder != null) SpotLook.OCCUPIED else SpotLook.AVAILABLE
    SpotState.CLOSED -> when {
        r.highBidder == null || nowSec >= v.operatingEnd.toLong() -> SpotLook.EXPIRED
        r.settled -> SpotLook.ACTIVE
        else -> SpotLook.OCCUPIED
    }
}

/** An SKR amount as a price; null for a zero (no bid), "…" (CHECKING) for an amount that cannot be read. */
private fun skrPrice(raw: String, decimals: Int): PriceUi? {
    if (raw == "0") return null
    val text = seekerSkrText(raw, decimals) ?: return PriceUi(Currency.SKR, null, PriceStatus.CHECKING)
    return PriceUi(Currency.SKR, text, PriceStatus.OK, description = "$text SKR")
}

/** The realm crests of a spot's realm mask, in the realm wire order (`paidStarterRealmIds`, the permit mapping); [realmNames]
 *  are the catalogue labels by wire index (`realmSalesRealmNames`), the id when a label is missing. */
private fun crestsOf(r: SeekerAuctionSpot, realmNames: Map<Long, String>): List<CrestUi> =
    paidStarterRealmIds.mapIndexedNotNull { index, id ->
        if (((r.realmMask shr index) and 1) == 1) CrestUi(id, realmNames[index.toLong()] ?: id) else null
    }

private fun auctionClock(epochSec: Long): String = AUCTION_CLOCK.format(Instant.ofEpochSecond(epochSec))

/**
 * The spot sheet (SPEC §3.4-§3.7) for protocol index [spot] of [view] (choose the round with [seekerSpotView]); null when
 * the round has no such spot or the view cannot be read. [draftRaw] is the host's draft total in raw units (null = the
 * minimum). The leader is "you" or "a Seeker player", never a wallet. The stepper appears only where the program would
 * admit the bid ([seekerBidDraft]); money stages stay READY here (the host copies its own stage in).
 */
internal fun seekerSpotUi(view: SeekerAuctionSourcedRoundView, spot: Int, nowSec: Long, draftRaw: String? = null,
    realmNames: Map<Long, String> = emptyMap()): SeekerSpotUi? {
    val r = row(view, spot) ?: return null
    return runCatching {
        val decimals = view.config.decimals
        val state = spotState(view, r, nowSec)
        val live = state == SpotState.LIVE || state == SpotState.YOU_LEAD || state == SpotState.OUTBID
        val start = view.auctionStart.toLong()
        val realms = Integer.bitCount(r.realmMask)
        SeekerSpotUi(
            spot = SpotSheetUi(seekerSpotNo(r.spot), r.spotClass == KING, state, emptyList(), skrPrice(r.highBidRaw, decimals),
                skrPrice(r.yourBidRaw, decimals), if (live) fmtDur(view.auctionEnd.toLong() - nowSec) else null, emptyList(),
                view.source == FIXTURE),
            phase = seekerAuctionPhase(view, nowSec),
            look = spotLook(view, r, state, nowSec),
            crestsUi = crestsOf(r, realmNames),
            crestLine = if (r.spotClass == KING) "Sells permits for all $realms realms" else "Sells permits for $realms realms",
            highBidder = r.highBidder?.let { KingdomRefUi(if (it == view.wallet) "you" else null, null) },
            held = if (r.refundable) skrPrice(r.yourBidRaw, decimals) else null,
            withdraw = if (r.refundable && view.source == CHAIN) MoneyStage.READY else null,
            stepper = if (live) seekerBidDraft(view, r.spot, nowSec, draftRaw)?.let { seekerBidStepperUi(view, it) } else null,
            opensLine = if (state == SpotState.NOT_OPEN && nowSec < start) "OPENS ${auctionClock(start).uppercase(Locale.US)} UTC" else null,
            term = if (state == SpotState.KING) fmtDur(view.operatingEnd.toLong() - nowSec) else null)
    }.getOrNull()
}

/**
 * One BID / RAISE draft in exact raw base units: [newTotalRaw] is the `newTotalRaw` of the prepare request; [incrementRaw]
 * is what leaves the wallet (new total − the escrow already held: the program tops up); [raise] when escrow is already
 * held here; [shortRaw] is how much the wallet lacks for the increment (null when it covers it).
 */
internal data class SeekerBidDraft(val round: String, val spot: Int, val newTotalRaw: String, val minRaw: String,
    val incrementRaw: String, val raise: Boolean, val shortRaw: String?)

private fun stepRaw(v: SeekerAuctionSourcedRoundView): BigInteger = BigInteger.TEN.pow(v.config.decimals)

/** max(opening bid, top bid + 1 raw) rounded UP to a whole token; null when no valid u64 total remains. */
private fun minimumRaw(v: SeekerAuctionSourcedRoundView, r: SeekerAuctionSpot): BigInteger? {
    val step = stepRaw(v)
    val floor = maxOf(v.config.openingBidRaw.toBigInteger(), r.highBidRaw.toBigInteger() + BigInteger.ONE)
    return ((floor + step - BigInteger.ONE) / step * step).takeIf { it <= U64_MAX }
}

/** A host draft clamped into [min, u64 max]; the minimum when absent or not a canonical raw amount. */
private fun clampDraft(draftRaw: String?, min: BigInteger): BigInteger =
    draftRaw?.takeIf { it.length <= 20 && it.matches(RAW_AMOUNT) }?.toBigInteger()?.coerceIn(min, U64_MAX) ?: min

/** The draft for a bid on [spot], or null where the program would refuse any bid ([seekerBidOpen]) or the view cannot be
 *  read. A draft below a newer minimum snaps up to it. The only source of the prepare amount and the seal amount. */
internal fun seekerBidDraft(view: SeekerAuctionSourcedRoundView, spot: Int, nowSec: Long, draftRaw: String?): SeekerBidDraft? {
    if (!seekerBidOpen(view, spot, nowSec)) return null
    val r = row(view, spot) ?: return null
    return runCatching {
        minimumRaw(view, r)?.let { min ->
            val total = clampDraft(draftRaw, min)
            val own = r.yourBidRaw.toBigInteger()
            val increment = total - own
            val balance = view.walletSkrRaw?.toBigInteger() ?: BigInteger.ZERO // no token account = nothing to spend
            SeekerBidDraft(view.round, spot, total.toString(), min.toString(), increment.toString(), own.signum() > 0,
                (increment - balance).takeIf { it.signum() > 0 }?.toString())
        }
    }.getOrNull()
}

/** The next draft after a − / + tap ([delta] steps of one whole token): never under the minimum, never past u64 max (a
 *  step that would overflow keeps the draft). Null when the spot is missing, has no valid total, or cannot be read. */
internal fun seekerStepBid(view: SeekerAuctionSourcedRoundView, spot: Int, draftRaw: String?, delta: Int): String? {
    val r = row(view, spot) ?: return null
    return runCatching {
        minimumRaw(view, r)?.let { min ->
            val base = clampDraft(draftRaw, min)
            val next = base + stepRaw(view) * delta.toBigInteger()
            when {
                next < min -> min
                next > U64_MAX -> base
                else -> next
            }.toString()
        }
    }.getOrNull()
}

/** The BidStepper (SPEC §3.4, §3.5): "BID n" / "holds n SKR" for a first bid, "RAISE TO n" / "adds n SKR" on top of held
 *  escrow, "min n", − off at the minimum, + off at u64 max, and the red "Need n more SKR" pill when the wallet is short. */
internal fun seekerBidStepperUi(view: SeekerAuctionSourcedRoundView, draft: SeekerBidDraft): BidStepperUi {
    val decimals = view.config.decimals
    fun text(raw: String) = seekerSkrText(raw, decimals) ?: UNKNOWN
    val value = text(draft.newTotalRaw)
    val total = draft.newTotalRaw.toBigInteger()
    return BidStepperUi(
        value = value,
        minLine = "min ${text(draft.minRaw)}",
        label = if (draft.raise) "RAISE TO $value" else "BID $value",
        sub = if (draft.raise) "adds ${text(draft.incrementRaw)} SKR" else "holds $value SKR",
        canDecrease = total > draft.minRaw.toBigInteger(),
        canIncrease = total + stepRaw(view) <= U64_MAX,
        short = draft.shortRaw?.let { missing ->
            val need = "Need ${text(missing)} more SKR"
            PriceUi(Currency.SKR, need, PriceStatus.SHORT, description = need)
        })
}

/** The bid Seal (SPEC §3.6) for [draft]: its pay token is the increment, the SKR that actually leaves the wallet now. The
 *  wording is `bidSealUi`'s, unchanged. */
internal fun seekerBidSeal(view: SeekerAuctionSourcedRoundView, draft: SeekerBidDraft, armedAtMs: Long): SealUi {
    val paid = seekerSkrText(draft.incrementRaw, view.config.decimals) ?: UNKNOWN
    return bidSealUi(seekerSpotNo(draft.spot), PriceUi(Currency.SKR, paid, PriceStatus.OK, description = "$paid SKR"), draft.raise,
        armedAtMs, view.source == FIXTURE)
}

/** The withdraw Seal (SPEC §3.5) for the escrow held on [spot]; null when nothing is refundable there (or on fixture data,
 *  whose escrow is not real). */
internal fun seekerWithdrawSeal(view: SeekerAuctionSourcedRoundView, spot: Int, armedAtMs: Long): SealUi? {
    val r = row(view, spot)?.takeIf { it.refundable && view.source == CHAIN } ?: return null
    val held = seekerSkrText(r.yourBidRaw, view.config.decimals) ?: return null
    return withdrawSealUi(seekerSpotNo(spot), PriceUi(Currency.SKR, held, PriceStatus.OK, description = "$held SKR"), armedAtMs)
}

/**
 * "SPOT n IS YOURS" (SPEC §3.7) for every spot of [view] the program has SETTLED to this wallet, from a finalized chain read
 * (fixture data never celebrates; an unsettled lead is not yet a win). The receipt id is the settlement's identity (config,
 * round, spot), stable across reads, so the host shows each one once. Line: "7d from Sun 00:00 UTC" (term, operating start).
 */
internal fun seekerWonCelebrations(view: SeekerAuctionSourcedRoundView): List<CelebrationUi> {
    if (view.source != CHAIN) return emptyList()
    val wins = view.spots.filter { won(view, it) }
    if (wins.isEmpty()) return emptyList()
    val line = runCatching { "${fmtDur(view.config.termSec.toLong())} from ${auctionClock(view.operatingStart.toLong())} UTC" }
        .getOrNull() ?: return emptyList()
    return wins.map { spotWonCelebration("seeker-won:${view.config.address}:${view.round}:${it.spot}", seekerSpotNo(it.spot), line) }
}
