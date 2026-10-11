package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.kit.drawChunky
import gg.pixelkingdomwars.nativeclient.ui.kit.moneyLook
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.SpotSheetUi
import gg.pixelkingdomwars.nativeclient.ui.model.SpotState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/*
 * Design component: the Seeker spot sheet (design/final/map/SPEC.md §3.4-§3.7; seeker-spot.png, seeker-outbid.png,
 * seeker-mine.png, seeker-testdata.png): header (sprite 32, "SPOT 7", History when you have bids here, close), the head
 * row (72 dp well with the sprite, KING / state / countdown tags, up to 8 realm crests and the crest line), then by
 * state: TOP BID / YOUR BID cards, the outbid held-escrow row with WITHDRAW, the BidStepper (− value + and the gold BID /
 * RAISE TO with its money sequence and the SHORT need-more pill), READY TO CLAIM tiles with CLAIM, BUY REALM PERMIT, or
 * nothing (expired / server off). The bid and withdraw seals are raised by the OverlayHost from `bidSealUi` /
 * `withdrawSealUi`; the won celebration from `spotWonCelebration`.
 *
 * Money rule: every amount here is a string from the data lane (the stepper value, its min line, its "holds n" / "adds n"
 * sub-line, the held escrow, the claim tiles); this sheet never computes an amount and never shows a program id or an
 * address. A failure line says "Nothing was spent" only when the refusal is authoritative ([moneyNote]).
 */

/** The BidStepper (SPEC §3.4): − / value / + and the primary; every string is the data lane's. */
@Immutable data class BidStepperUi(
    /** The draft bid ("170"). */
    val value: String,
    /** "min 170". */
    val minLine: String,
    /** "BID 130" / "RAISE TO 170". */
    val label: String,
    /** "holds 130 SKR" / "adds 50 SKR" (the data lane picks by its `raiseMode`, SPEC §3.5 escrow caveat). */
    val sub: String,
    /** False at the minimum (− disabled). */
    val canDecrease: Boolean,
    /** False at a server maximum. */
    val canIncrease: Boolean = true,
    /** Above your SKR: the red CostPill ("Need 40 more SKR", status SHORT); the tap opens Need-more. */
    val short: PriceUi? = null,
)

/** One READY TO CLAIM tile (SPEC §3.7): icon + amount ("…" unless the server said; "0" only from the server). */
@Immutable data class ClaimTileUi(val icon: String, val amount: String, val description: String)

/** The operating spot's claim block (SPEC §3.7 Mine). */
@Immutable data class SpotClaimUi(
    /** Up to 4 tiles. */
    val tiles: List<ClaimTileUi>,
    /** "Island pool share and permit sales since your last claim. Permits sold today: 4 of 10." */
    val line: String,
    /** The tiles are an estimate: "Estimated share · not yet yours". */
    val estimate: Boolean = false,
    /** Nothing to claim: the reason the primary is off ("Nothing to claim yet · next pool share at 00:00 UTC"). */
    val nothingLine: String? = null,
    /** The primary's sub-line ("island pool + permit sales"). */
    val sub: String = "island pool + permit sales",
    /** Where the money sequence stands. */
    val money: MoneyStage = MoneyStage.READY,
)

/** A money action that did not complete: [authoritative] only when the server / wallet answered no. */
@Immutable data class MoneyFailureUi(val action: String, val authoritative: Boolean, val serverReason: String? = null)

/** Everything the spot sheet draws: the §7.2 [SpotSheetUi] plus the SPEC §3.4 extension fields. */
@Immutable data class SeekerSpotUi(
    /** spotNo, kingClass, state, crests (unused: see [crestsUi]), highBid, yourBid, countdown, commands, testData. */
    val spot: SpotSheetUi,
    /** Null while loading. */
    val phase: AuctionPhase?,
    /** The sprite look. */
    val look: SpotLook,
    /** Up to 8 realm crests (King: all 8; regular: 4) from `realmSalesRealmNames`. */
    val crestsUi: List<CrestUi> = emptyList(),
    /** "Sells permits for all 8 realms". */
    val crestLine: String = "",
    /** Cards and primary show "…" / CHECKING. */
    val loading: Boolean = false,
    /** The top bidder as a kingdom (never a wallet string). */
    val highBidder: KingdomRefUi? = null,
    /** OUTBID: your escrow still held ("120"). */
    val held: PriceUi? = null,
    /** "Your earlier bid, not lost". */
    val heldLine: String = "Your earlier bid, not lost",
    /** WITHDRAW's money stage; null hides it (not outbid, already refunded, or not the caller's). */
    val withdraw: MoneyStage? = null,
    /** The stepper; null hides it. */
    val stepper: BidStepperUi? = null,
    /** The bid primary's money stage. */
    val bidMoney: MoneyStage = MoneyStage.READY,
    /** NOT_OPEN: the locked primary's label ("OPENS SUN 00:00"). */
    val opensLine: String? = null,
    /** KING (yours): the term left ("5d 20h"). */
    val term: String? = null,
    val claim: SpotClaimUi? = null,
    /** BUY REALM PERMIT for an operating spot of another kingdom (registry row 83); null when not offered. */
    val permit: CommandUi? = null,
    /** You have bids here: the stone History button. */
    val history: Boolean = false,
    /** The last money action that did not complete. */
    val failure: MoneyFailureUi? = null,
)

/** Spot sheet callbacks (SPEC §3.4). */
@Immutable data class SeekerSpotActions(
    /** −1 / +1 by the server's `minIncrement` (the data lane moves the draft). */
    val onStep: (Int) -> Unit = {},
    /** BID / RAISE: raise the bid Seal (`bidSealUi`). */
    val onBid: () -> Unit = {},
    /** The SHORT pill or a SHORT primary: Need-more ("SKR comes from your wallet" + Profile › WALLET). */
    val onNeedMore: () -> Unit = {},
    /** WITHDRAW: raise the withdraw Seal (`withdrawSealUi`). */
    val onWithdraw: () -> Unit = {},
    val onClaim: () -> Unit = {},
    val onBuyPermit: () -> Unit = {},
    val onHistory: () -> Unit = {},
    /** A tap on a locked / disabled primary: show its reason (toast), never silent. */
    val onExplain: (String) -> Unit = {},
    val onClose: () -> Unit = {},
)

/**
 * The Seeker spot sheet (SPEC §3.4-§3.7).
 *
 * Pointer rule: a HALF sheet with no scrim (the island stays pannable above it); only the painted frame, the stepper,
 * WITHDRAW and the primary take touches. The Seal it leads to carries its own 55 % scrim, only while shown.
 */
@Composable fun SeekerSpotSheet(ui: SeekerSpotUi, on: SeekerSpotActions, modifier: Modifier = Modifier) {
    val s = ui.spot
    val layout = spotLayout(s.state, ui.phase, ui.loading, ui.permit != null)
    MapSheetFrame("SPOT ${s.spotNo}", siteArt(IslandKind.SEEKER, ui.look), on.onClose, modifier, history = ui.history, onHistory = on.onHistory,
        footer = { SpotFooter(ui, layout, on) }) {
        HeadRow(ui)
        if (layout.offLine) ParchLine("Auctions are not open on this server yet", center = true)
        if (layout.bidCards) BidCards(ui)
        if (layout.heldRow) HeldRow(ui, on)
        if (layout.claimTiles) ui.claim?.let { ClaimBlock(it) }
    }
}

/** The head row: 72 dp well with the sprite at 64, the tags, the crests and the crest line. */
@Composable private fun HeadRow(ui: SeekerSpotUi) {
    val s = ui.spot
    val tags = spotHeadTags(s.kingClass, s.state, s.countdown, ui.term, s.testData, ui.phase)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ArtWell(72.dp, MapColors.seekerWell) { MapIcon(siteArt(IslandKind.SEEKER, ui.look), 64.dp) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) { tags.forEach { Tag(it.text, it.verb) } }
            if (ui.crestsUi.isNotEmpty()) CrestRow(ui.crestsUi)
            if (ui.crestLine.isNotBlank()) ParchLine(ui.crestLine, secondary = true, maxLines = 2)
        }
    }
}

/** TOP BID / YOUR BID (SPEC §3.4): two CreamCards 58; the leader is a face + kingdom name. */
@Composable private fun BidCards(ui: SeekerSpotUi) {
    val s = ui.spot
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        BidCard("TOP BID", if (ui.loading) UNKNOWN else s.highBid?.let(::priceText), ui.highBidder.takeIf { s.highBid != null && !ui.loading },
            Modifier.weight(1f), none = "No bids yet")
        BidCard("YOUR BID", if (ui.loading) UNKNOWN else s.yourBid?.let(::priceText), null, Modifier.weight(1f), none = "none yet")
    }
}

@Composable private fun BidCard(label: String, amount: String?, leader: KingdomRefUi?, modifier: Modifier, none: String) {
    val said = listOfNotNull(label, amount?.let { "$it SKR" } ?: none, leader?.let { bidderName(it.name) }).joinToString(", ")
    Plate(PlateKind.CREAM, modifier.heightIn(min = 58.dp).clearAndSetSemantics { contentDescription = said }, blocksScene = false) {
        Column(Modifier.padding(horizontal = 4.dp)) {
            PkwText(label, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
            if (amount == null) PkwText(none, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch2)
            else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                PkwIcon("skr", 24.dp)
                PkwText(amount, PkwTokens.Type.primary, color = PkwTokens.Colors.textOnParch)
            }
            leader?.let { KingdomRef(it) }
        }
    }
}

/** The outbid held-escrow row (SPEC §3.5): `#FFF3C8`, SKR 24, "120 SKR held for you" / "Your earlier bid, not lost",
 *  and the stone WITHDRAW 104 × 46 with its money stages. */
@Composable private fun HeldRow(ui: SeekerSpotUi, on: SeekerSpotActions) {
    val held = ui.held ?: return
    MapRow(tint = PkwTokens.Colors.selectedTint) {
        PkwIcon("skr", 24.dp)
        RowText("${priceText(held)} SKR held for you", ui.heldLine)
        ui.withdraw?.let { stage ->
            val look = moneyLook(stage, "WITHDRAW")
            when (stage) {
                MoneyStage.READY -> SecondaryButton("WITHDRAW", on.onWithdraw, Modifier.width(104.dp).heightIn(min = 46.dp),
                    contentDescription = "Withdraw ${priceText(held)} SKR to your wallet")
                MoneyStage.FAILED -> SecondaryButton(look.text, on.onWithdraw, Modifier.width(104.dp).heightIn(min = 46.dp), verb = Verb.RED,
                    contentDescription = "Retry the withdraw")
                else -> SecondaryButton(look.text, {}, Modifier.width(104.dp).heightIn(min = 46.dp), enabled = false)
            }
        }
    }
}

/** READY TO CLAIM (SPEC §3.7): up to 4 CreamCard tiles 72 tall, the line, and the estimate note. */
@Composable private fun ClaimBlock(claim: SpotClaimUi) {
    MapSectionHeader("READY TO CLAIM")
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        claim.tiles.take(4).forEach { t ->
            Plate(PlateKind.CREAM, Modifier.weight(1f).heightIn(min = 72.dp).clearAndSetSemantics { contentDescription = t.description }, blocksScene = false) {
                Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    PkwIcon(t.icon, 32.dp)
                    PkwText(t.amount.ifBlank { UNKNOWN }, PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                }
            }
        }
    }
    ParchLine(if (claim.estimate) "Estimated share · not yet yours" else claim.line, secondary = true)
}

/** The pinned footer: the stepper row, the locked / checking / claim / permit primary, the money note and the footnote. */
@Composable private fun SpotFooter(ui: SeekerSpotUi, layout: SpotLayout, on: SeekerSpotActions) {
    when (layout.primary) {
        SpotPrimary.NONE -> Unit
        SpotPrimary.CHECKING -> PrimaryButton("CHECKING", {}, Modifier.fillMaxWidth(), verb = Verb.STONE, state = CommandState.BUSY)
        SpotPrimary.LOCKED_OPENS -> {
            val reason = "Bidding opens later"
            PrimaryButton(ui.opensLine ?: "OPENS LATER", { on.onExplain(reason) }, Modifier.fillMaxWidth(), state = CommandState.LOCKED)
        }
        SpotPrimary.BID -> ui.stepper?.let { BidStepperRow(it, ui.bidMoney, on) }
        SpotPrimary.CLAIM -> ui.claim?.let { claim ->
            when {
                claim.nothingLine != null -> PrimaryButton("CLAIM", { on.onExplain(claim.nothingLine) }, Modifier.fillMaxWidth(),
                    state = CommandState.DISABLED, reason = claim.nothingLine)
                claim.money == MoneyStage.READY -> PrimaryButton("CLAIM", on.onClaim, Modifier.fillMaxWidth(), sub = claim.sub,
                    badge = BadgeUi("!", BadgeTone.READY, "Rewards ready to claim"))
                else -> MoneyButton(claim.money, "CLAIM", on.onClaim)
            }
        }
        SpotPrimary.PERMIT -> ui.permit?.let { p ->
            val state = commandDrawState(p)
            PrimaryButton(p.caption, {
                when (state) {
                    CommandState.ENABLED -> on.onBuyPermit()
                    // SHORT opens Need-more (design correction 7 / commandRoute), never the reason line.
                    CommandState.SHORT -> on.onNeedMore()
                    else -> on.onExplain(p.reason ?: p.caption)
                }
            },
                Modifier.fillMaxWidth(), sub = p.sub, state = state, reason = p.reason, price = p.price,
                onPrice = if (p.price?.status == PriceStatus.SHORT) on.onNeedMore else null)
        }
    }
    ui.failure?.let { f ->
        moneyNote(true, f.action, f.authoritative, f.serverReason)?.let { line ->
            PkwText(line, PkwTokens.Type.small, Modifier.fillMaxWidth(), textAlign = TextAlign.Center, maxLines = 2,
                color = if (f.authoritative) PkwTokens.Colors.shortText else PkwTokens.Colors.textOnParch2)
        }
    }
    if (layout.footnote) ParchLine(SEEKER_BID_HELD_LINE, secondary = true, center = true)
}

/**
 * The BidStepper row (SPEC §3.4): stone − 48 × 60 · cream value 76 × 60 (PS 14 value, VT 18 "min n") · stone + 48 × 60 ·
 * the gold primary (flex × 60, label + "holds n SKR"). A long press on − / + repeats every 120 ms after 400 ms; − is off
 * at the minimum. SHORT: a red CostPill rides the primary and both open Need-more. After READY the primary runs the
 * money sequence (Check wallet → Sending → SENT, or RETRY).
 */
@Composable private fun BidStepperRow(st: BidStepperUi, money: MoneyStage, on: SeekerSpotActions) {
    val busy = money != MoneyStage.READY && money != MoneyStage.FAILED
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        StepperButton("shape:minus", "Lower the bid", st.canDecrease && !busy) { on.onStep(-1) }
        Plate(PlateKind.CREAM, Modifier.size(76.dp, 60.dp).clearAndSetSemantics { contentDescription = "Bid ${st.value}, ${st.minLine}" }, blocksScene = false) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                PkwText(st.value.ifBlank { UNKNOWN }, PkwTokens.Type.primary, color = PkwTokens.Colors.textOnParch)
                PkwText(st.minLine, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
            }
        }
        StepperButton("shape:plus", "Raise the bid", st.canIncrease && !busy) { on.onStep(1) }
        val short = st.short
        when {
            short != null && money == MoneyStage.READY -> PrimaryButton(st.label, on.onNeedMore, Modifier.weight(1f), sub = st.sub,
                state = CommandState.SHORT, price = short.copy(status = PriceStatus.SHORT), onPrice = on.onNeedMore)
            money == MoneyStage.READY -> PrimaryButton(st.label, on.onBid, Modifier.weight(1f), sub = st.sub)
            else -> MoneyButton(money, st.label, on.onBid, Modifier.weight(1f))
        }
    }
}

/** A stone 48 × 60 stepper square: tap = one step; held = repeat every 120 ms after 400 ms (SPEC §3.4). */
@Composable private fun StepperButton(glyph: String, description: String, enabled: Boolean, onStep: () -> Unit) {
    val step by rememberUpdatedState(onStep)
    val scope = rememberCoroutineScope()
    val reduced = LocalReducedMotion.current
    var pressed by remember { mutableStateOf(false) }
    val press by animateFloatAsState(if (pressed) 1f else 0f,
        tween(if (reduced) 0 else if (pressed) PkwTokens.Motion.PRESS else PkwTokens.Motion.RELEASE,
            easing = if (pressed) PkwTokens.Motion.Linear else PkwTokens.Motion.Pop), label = "stepPress")
    val input = if (!enabled) Modifier else Modifier.pointerInput(Unit) {
        detectTapGestures(onPress = {
            pressed = true
            step()
            val repeat = scope.launch { delay(STEP_REPEAT_AFTER_MS); while (true) { step(); delay(STEP_REPEAT_EVERY_MS) } }
            try { tryAwaitRelease() } finally { repeat.cancel(); pressed = false }
        })
    }
    Box(Modifier.size(48.dp, 60.dp).sceneInputRegion()
        .clearAndSetSemantics {
            contentDescription = description; role = Role.Button
            if (!enabled) disabled()
            this.onClick(label = null, action = { if (enabled) step(); enabled })
        }
        .then(input)
        .drawBehind { drawChunky(PkwTokens.ramp(if (enabled) Verb.STONE else Verb.OFF), press) }, contentAlignment = Alignment.Center) {
        PkwIcon(glyph, 24.dp, Modifier.padding(bottom = 3.dp), tint = PkwTokens.Colors.label)
    }
}

/** SPEC §3.4: a long press repeats after 400 ms, every 120 ms. */
const val STEP_REPEAT_AFTER_MS = 400L
const val STEP_REPEAT_EVERY_MS = 120L

// ---- Previews ----

private fun skr(amount: String?, status: PriceStatus = PriceStatus.OK) = PriceUi(Currency.SKR, amount, status)

private val previewCrests4 = listOf(CrestUi("cinderfall", "Cinderfall"), CrestUi("elderwood", "Elderwood"), CrestUi("glasswake", "Glasswake"),
    CrestUi("thornwake", "Thornwake"))
private val previewCrests8 = previewCrests4 + listOf(CrestUi("frostveil", "Frostveil"), CrestUi("crownlands", "Crownlands"),
    CrestUi("seeker-reach", "Solana Reach"), CrestUi("ashmarch", "Ashmarch"))

private fun previewSpot(state: SpotState, king: Boolean = true, high: String? = "120", yours: String? = null, testData: Boolean = false) =
    SpotSheetUi(7, king, state, emptyList(), high?.let { skr(it) }, yours?.let { skr(it) }, "14h 10m", emptyList(), testData)

@Composable private fun SheetHost(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(MapColors.stage).padding(horizontal = 4.dp), contentAlignment = Alignment.BottomCenter) { content() }
}

@Preview(name = "First bid (seeker-spot)", widthDp = 412, heightDp = 915)
@Composable private fun SpotFirstBidPreview() {
    SheetHost {
        SeekerSpotSheet(SeekerSpotUi(previewSpot(SpotState.LIVE), AuctionPhase.OPEN, SpotLook.AVAILABLE, previewCrests8, "Sells permits for all 8 realms",
            highBidder = KingdomRefUi("Kinmar", "ui_portrait_keep_t3"),
            stepper = BidStepperUi("130", "min 130", "BID 130", "holds 130 SKR", canDecrease = false)), SeekerSpotActions())
    }
}

@Preview(name = "Outbid: held row, WITHDRAW, RAISE TO (seeker-outbid)", widthDp = 412, heightDp = 915)
@Composable private fun SpotOutbidPreview() {
    SheetHost {
        SeekerSpotSheet(SeekerSpotUi(previewSpot(SpotState.OUTBID, king = false, high = "160", yours = "120").copy(spotNo = 42), AuctionPhase.OPEN,
            SpotLook.OCCUPIED, previewCrests4, "Sells permits for 4 realms", held = skr("120"), withdraw = MoneyStage.READY,
            stepper = BidStepperUi("170", "min 170", "RAISE TO 170", "adds 50 SKR", canDecrease = false), history = true), SeekerSpotActions())
    }
}

@Preview(name = "Short of SKR + uncertain bid result", widthDp = 412, heightDp = 915)
@Composable private fun SpotShortPreview() {
    SheetHost {
        SeekerSpotSheet(SeekerSpotUi(previewSpot(SpotState.LIVE), AuctionPhase.OPEN, SpotLook.AVAILABLE, previewCrests8, "Sells permits for all 8 realms",
            highBidder = KingdomRefUi(null, null),
            stepper = BidStepperUi("280", "min 130", "BID 280", "holds 280 SKR", canDecrease = true, short = skr("Need 40 more SKR", PriceStatus.SHORT)),
            failure = MoneyFailureUi("bid", authoritative = false)), SeekerSpotActions())
    }
}

@Preview(name = "Mine, operating: READY TO CLAIM (seeker-mine)", widthDp = 412, heightDp = 915)
@Composable private fun SpotMinePreview() {
    SheetHost {
        SeekerSpotSheet(SeekerSpotUi(previewSpot(SpotState.KING), AuctionPhase.OPERATING, SpotLook.ACTIVE, previewCrests8, "Sells permits for all 8 realms",
            term = "5d 20h", history = true, claim = SpotClaimUi(listOf(ClaimTileUi("shards", "1,840", "1,840 Shards"),
                ClaimTileUi("ui:exp", "12", "12 ingots"), ClaimTileUi("ui:climate-kit", "8", "8 kits"), ClaimTileUi("sol", "0.02", "0.02 SOL")),
                "Island pool share and permit sales since your last claim. Permits sold today: 4 of 10.")), SeekerSpotActions())
    }
}

@Preview(name = "Test data, loading", widthDp = 412, heightDp = 915)
@Composable private fun SpotTestDataPreview() {
    SheetHost {
        SeekerSpotSheet(SeekerSpotUi(previewSpot(SpotState.LIVE, testData = true), null, SpotLook.AVAILABLE, previewCrests4, "Sells permits for 4 realms",
            loading = true), SeekerSpotActions())
    }
}

@Preview(name = "Server off / not open yet / expired", widthDp = 412, heightDp = 915)
@Composable private fun SpotOffPreview() {
    SheetHost {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SeekerSpotSheet(SeekerSpotUi(previewSpot(SpotState.NOT_OPEN), AuctionPhase.SERVER_OFF, SpotLook.AVAILABLE), SeekerSpotActions())
            SeekerSpotSheet(SeekerSpotUi(previewSpot(SpotState.NOT_OPEN, high = null), AuctionPhase.OPENS_AT, SpotLook.AVAILABLE,
                opensLine = "OPENS SUN 00:00"), SeekerSpotActions())
            SeekerSpotSheet(SeekerSpotUi(previewSpot(SpotState.CLOSED), AuctionPhase.OPERATING, SpotLook.EXPIRED), SeekerSpotActions())
        }
    }
}
